import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULTS } from '../../src/record/defaults.ts';
import { record } from '../../src/record/index.ts';
import { moveDuration } from '../../src/record/motion.ts';
import type { ActionEvent, MouseButtonEvent, Rect, Session } from '../../src/types.ts';
import { serve, type TestServer } from './helpers.ts';

const PAGE = `<!doctype html><body style="margin:0">
<div id="above" style="position:absolute;left:300px;top:300px;width:180px;height:80px;background:#eee"></div>
<div id="bar1" class="bar" style="left:300px"></div>
<div id="bar2" class="bar" style="left:360px"></div>
<div id="bar3" class="bar" style="left:420px"></div>
<div id="handle" style="position:absolute;left:100px;top:560px;width:80px;height:80px;background:#4a7bd8;touch-action:none"></div>
<div id="zone" style="position:absolute;left:900px;top:520px;width:200px;height:160px;background:#dfd"></div>
<style>.bar { position:absolute; top:400px; width:60px; height:200px; background:#e4572e; }</style>
<script>
  window.entered = [];
  window.clicked = [];
  for (const bar of document.querySelectorAll('.bar')) {
    bar.addEventListener('mouseenter', () => entered.push(bar.id));
  }
  document.addEventListener('click', (e) => clicked.push(e.target.id || e.target.tagName));
  const handle = document.getElementById('handle');
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    const ox = e.clientX - handle.offsetLeft;
    const oy = e.clientY - handle.offsetTop;
    const move = (m) => {
      handle.style.left = m.clientX - ox + 'px';
      handle.style.top = m.clientY - oy + 'px';
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', () => handle.removeEventListener('pointermove', move), {
      once: true,
    });
  });
</script></body>`;

type PageLog = { entered: string[]; clicked: string[] };

/**
 * The cursor move inside a drag: from the first sample that leaves the press point to the
 * first sample on the release point.
 */
function dragMove(session: Session, down: MouseButtonEvent, up: MouseButtonEvent) {
  const samples = session.cursor.filter((sample) => sample.t >= down.t && sample.t <= up.t);
  const start = samples.findIndex((s) => s.x !== down.x || s.y !== down.y) - 1;
  const end = samples.findIndex((s) => s.x === up.x && s.y === up.y);
  const from = samples[start];
  const duration = samples[end].t - from.t;
  const total = Math.hypot(up.x - down.x, up.y - down.y);
  const at = samples.filter((s) => s.t <= from.t + 400).at(-1)!;
  return { duration, early: Math.hypot(at.x - down.x, at.y - down.y) / total, total };
}

describe('drag options and positions outside the target', () => {
  let server: TestServer;
  let dir: string;
  let session: Session;
  const log: { hover?: PageLog; click?: PageLog } = {};
  let handleEnd: Rect | null = null;

  before(async () => {
    server = await serve({ '/': PAGE });
    dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-pointer-'));
    const read = (): PageLog => {
      const win = window as unknown as PageLog;
      return { entered: [...win.entered], clicked: [...win.clicked] };
    };
    ({ session } = await record(
      { url: server.url, sessionDir: dir, pacing: { startDelay: 0, endDelay: 0 } },
      async (cast) => {
        await cast.hover('#bar2', { position: { x: 0.5, y: -0.625 }, hold: 50 });
        await cast.moveTo('#bar2', { position: { x: 0.5, y: 0.1 } });
        log.hover = await cast.page.evaluate(read);
        await cast.click('#bar3', { position: { x: 0.5, y: -0.25 }, afterClick: 0 });
        log.click = await cast.page.evaluate(read);
        await cast.drag('#handle', '#zone', {
          position: { x: 0.2, y: 0.2 },
          toPosition: { x: 0.8, y: 0.8 },
          duration: 300,
        });
        handleEnd = await cast.page.locator('#handle').boundingBox();
        await cast.drag('#handle', { x: 600, y: 600 }, { dragDuration: 400 });
      },
    ));
  });

  after(async () => {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('moves to a point outside the target without crossing its neighbours', () => {
    const hover = session.cursor.find((sample) => sample.x === 390 && sample.y === 275);
    assert.ok(hover, 'the cursor stops exactly above the bar');
    assert.deepEqual(log.hover!.entered, ['bar2']);
  });

  it('clicks what is at a point outside the target, without the actionability check', () => {
    assert.deepEqual(log.click!.clicked, ['above']);
    const down = session.events.find((event) => event.type === 'mouseDown') as MouseButtonEvent;
    assert.deepEqual([down.x, down.y], [450, 350]);
  });

  it('waits afterClick after the press, here 0', () => {
    const up = session.events.find((event) => event.type === 'mouseUp') as MouseButtonEvent;
    const click = session.events.find(
      (event): event is ActionEvent => event.type === 'action' && event.call.startsWith('click('),
    )!;
    assert.ok(click.end - up.t < 60, `${click.end - up.t} ms after the press`);
  });

  it('uses position for the source, toPosition for the destination', () => {
    const buttons = session.events.filter(
      (event): event is MouseButtonEvent => event.type === 'mouseDown' || event.type === 'mouseUp',
    );
    const [, , down, up] = buttons;
    assert.deepEqual([down.x, down.y], [116, 576]);
    assert.deepEqual([up.x, up.y], [1060, 648]);
    const end = handleEnd!;
    assert.ok(Math.abs(end.x + 16 - 1060) < 2 && Math.abs(end.y + 16 - 648) < 2, 'handle follows');
  });

  it('drags slower than a free move, with a gentle start', () => {
    const buttons = session.events.filter(
      (event): event is MouseButtonEvent => event.type === 'mouseDown' || event.type === 'mouseUp',
    );
    const move = dragMove(session, buttons[2], buttons[3]);
    const expected = 1.6 * moveDuration(move.total, DEFAULTS.cursor);
    assert.ok(Math.abs(move.duration - expected) < 80, `drag of ${move.duration} ms`);
    assert.ok(move.early < 0.3, `${Math.round(move.early * 100)}% of the travel in 0.4 s`);

    const explicit = dragMove(session, buttons[4], buttons[5]);
    assert.ok(Math.abs(explicit.duration - 400) < 50, `dragDuration gives ${explicit.duration}`);
  });

  it('uses duration for the approach move only', () => {
    const drag = session.events.find(
      (event): event is ActionEvent => event.type === 'action' && event.call.startsWith('drag('),
    )!;
    const down = session.events.find(
      (event): event is MouseButtonEvent => event.type === 'mouseDown' && event.t > drag.t,
    )!;
    const approach = session.cursor.filter((s) => s.t >= drag.t && s.t <= down.t);
    const arrive = approach.find((s) => s.x === down.x && s.y === down.y)!;
    const moving = approach.find((s) => s.x !== approach[0].x || s.y !== approach[0].y)!;
    const ms = arrive.t - moving.t;
    assert.ok(ms > 250 && ms < 360, `approach of ${ms} ms`);
  });
});
