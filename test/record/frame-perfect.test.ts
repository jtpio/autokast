import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { record } from '../../src/record/index.ts';
import { loadSession } from '../../src/session.ts';
import type {
  MouseButtonEvent,
  Rect,
  RecordOptions,
  Session,
  TimelineEvent,
} from '../../src/types.ts';
import { serve, type TestServer } from './helpers.ts';

const FRAME = 1000 / 60;
const FRAME_PERFECT = { mode: 'frame-perfect' } as const;

const BOXES = `<style>
  .box { position: absolute; left: 0; width: 40px; height: 40px; }
  @keyframes slide { to { left: 1200px; } }
  @keyframes slideT { to { transform: translateX(1200px); } }
</style>
<div class="box" style="top:20px;background:rgb(255,0,0);animation:slide 2s linear infinite"></div>
<div class="box" style="top:100px;background:rgb(0,0,255);animation:slideT 2s linear infinite"></div>
<div class="box" id="raf" style="top:180px;background:rgb(0,160,0)"></div>
<script>
  const raf = document.getElementById('raf');
  let first;
  const tick = (time) => {
    first ??= time;
    raf.style.left = (((time - first) * 0.6) % 1200) + 'px';
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
</script>`;

const SECOND = `<!doctype html><body style="margin:0;background:#fff">${BOXES}</body>`;

function home(next: string): string {
  return `<!doctype html><body style="margin:0;background:#fff">${BOXES}
<div id="move" class="box" style="top:260px;background:rgb(255,0,255);transition:transform 1s linear"></div>
<div id="hover" style="position:absolute;left:700px;top:380px;width:200px;height:100px;background:rgb(200,200,200)"></div>
<button id="go" style="position:absolute;left:300px;top:500px;width:120px;height:40px">Go</button>
<a id="next" href="${next}" style="position:absolute;left:500px;top:500px;font-size:24px">Next site</a>
<style>#hover:hover { background: rgb(255,160,0) !important; }</style>
<script>
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('move').style.transform = 'translateX(600px)';
  });
</script></body>`;
}

const COLORS: Record<string, [number, number, number]> = {
  red: [255, 0, 0],
  blue: [0, 0, 255],
  green: [0, 160, 0],
  magenta: [255, 0, 255],
};

/**
 * Reads, for each frame, the x (device px) of the center of each colored box on its row,
 * and the color at one point. The center weights each pixel by its coverage, read from
 * the channel where the box color differs most from the white page: antialiased edges
 * then give sub-pixel positions. -1 when the box is not on its row.
 */
async function analyze(
  dir: string,
  session: Session,
  rows: Record<string, number>,
  point: { x: number; y: number },
) {
  const result: { t: number; x: Record<string, number>; at: number[] }[] = [];
  const scale = session.deviceScaleFactor;
  for (const frame of session.frames) {
    const image = await loadImage(path.join(dir, frame.file));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const x: Record<string, number> = {};
    for (const [color, y] of Object.entries(rows)) {
      const data = context.getImageData(0, y * scale, image.width, 1).data;
      const target = COLORS[color];
      const channel = target.indexOf(Math.min(...target));
      let sum = 0;
      let weight = 0;
      for (let i = 0; i < image.width; i++) {
        const coverage = (255 - data[i * 4 + channel]) / (255 - target[channel]);
        if (coverage > 0.1) {
          sum += i * Math.min(1, coverage);
          weight += Math.min(1, coverage);
        }
      }
      x[color] = weight > 10 ? sum / weight : -1;
    }
    const at = [...context.getImageData(point.x * scale, point.y * scale, 1, 1).data.slice(0, 3)];
    result.push({ t: frame.t, x, at });
  }
  return result;
}

function counts(values: number[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const value of values) {
    map[value] = (map[value] ?? 0) + 1;
  }
  return map;
}

function steps(values: number[]): number[] {
  return values.slice(1).map((value, i) => value - values[i]);
}

function ofType<T extends TimelineEvent['type']>(session: Session, type: T) {
  return session.events.filter((event) => event.type === type) as Extract<
    TimelineEvent,
    { type: T }
  >[];
}

function buttons(session: Session, type: MouseButtonEvent['type']): MouseButtonEvent[] {
  return session.events.filter((event): event is MouseButtonEvent => event.type === type);
}

/**
 * Time steps between frames, in ms rounded to 0.1.
 */
function frameSteps(list: { t: number }[]): Record<string, number> {
  return counts(steps(list.map((frame) => frame.t)).map((step) => +step.toFixed(1)));
}

function onGrid(t: number): boolean {
  return Math.abs(t / FRAME - Math.round(t / FRAME)) < 0.01;
}

describe('frame-perfect capture', () => {
  let first: TestServer;
  let second: TestServer;
  let dir: string;
  let session: Session;
  let frames: Awaited<ReturnType<typeof analyze>>;
  let hoverBox: Rect;
  const marks: Record<string, number> = {};
  const clockLead: number[] = [];

  before(async () => {
    second = await serve({ '/': SECOND }, 'localhost');
    first = await serve({ '/': home(`${second.url}/`) });
    dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-fp-'));
    ({ session } = await record(
      {
        url: first.url,
        sessionDir: dir,
        capture: FRAME_PERFECT,
        pacing: { startDelay: 100, endDelay: 100 },
      },
      async (cast) => {
        const lead = async () => (await cast.page.evaluate(() => Date.now())) - Date.now();
        clockLead.push(await lead());
        hoverBox = (await cast.page.locator('#hover').boundingBox())!;
        await cast.moveTo('#hover');
        await cast.click('#go');
        await cast.wait(1100);
        await cast.cut(() => cast.wait(600));
        await cast.speed(2, () => cast.wait(400));
        await cast.click('#next');
        await cast.page.waitForURL(`${second.url}/`);
        cast.marker('second');
        await cast.wait(600);
        clockLead.push(await lead());
      },
    ));
    for (const marker of ofType(session, 'marker')) {
      marks[marker.label] = marker.t;
    }
    const rows = { red: 40, blue: 120, green: 200, magenta: 280 };
    frames = await analyze(dir, session, rows, { x: 800, y: 470 });
  });

  after(async () => {
    await first?.close();
    await second?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('gives frames, cursor samples and input events record times on the frame grid', () => {
    assert.deepEqual(session.frameSize, { width: 2560, height: 1440 });
    assert.equal(session.frames[0].t, 0);
    assert.ok(session.frames.every((frame) => onGrid(frame.t)));
    assert.ok(session.cursor.every((sample) => onGrid(sample.t)));
    const inputs = session.events.filter((e) => e.type === 'mouseDown' || e.type === 'mouseUp');
    assert.ok(inputs.length === 4 && inputs.every((event) => onGrid(event.t)));
    assert.ok(steps(session.cursor.map((s) => s.t)).every((step) => step > 0));
  });

  it('captures every frame of continuous animation, with constant motion', () => {
    const [cut] = ofType(session, 'cut');
    const before = frames.filter((frame) => frame.t <= cut.t);
    const gaps = before
      .slice(1)
      .filter((frame, i) => Math.abs(frame.t - before[i].t - FRAME) > 0.01)
      .map((frame) => frame.t.toFixed(2));
    assert.deepEqual(gaps, [], 'every frame is stored: frames after a gap');
    for (const color of ['red', 'blue', 'green']) {
      const off = before
        .slice(1)
        .map((frame, i) => ({ t: frame.t, step: frame.x[color] - before[i].x[color] }))
        .filter(({ step }) => step > -1000 && Math.abs(step - 20) > 0.5)
        .map(({ t, step }) => `${t.toFixed(2)}: ${step.toFixed(2)}`);
      assert.deepEqual(off, [], `${color} moves 10 CSS px (20 device px) in every frame`);
    }
  });

  it('adds no dead time around a click', () => {
    const click = ofType(session, 'action').find((action) => action.call === 'click("#go")')!;
    const [down] = buttons(session, 'mouseDown');
    const move = session.cursor.filter((s) => s.t > click.t && s.t < down.t);
    const startsAfter = move[0].t - click.t;
    const pressAfter = down.t - move.at(-1)!.t;
    assert.ok(startsAfter <= 2 * FRAME + 0.1, `the move starts ${startsAfter} ms after the call`);
    assert.ok(
      pressAfter <= 60 + 2 * FRAME + 0.1,
      `the press comes ${pressAfter} ms after the move`,
    );
  });

  it('shows a 1 s transition in exactly 60 frames', () => {
    const up = buttons(session, 'mouseUp')[0];
    const after = frames.filter((frame) => frame.t >= up.t && frame.x.magenta >= 0);
    const moving = steps(after.map((frame) => frame.x.magenta)).filter((step) => step > 0.5);
    assert.equal(moving.length, 60);
    assert.deepEqual(
      moving.filter((step) => Math.abs(step - 20) > 0.5),
      [],
    );
  });

  it('shows the hover state in the frame of the first cursor sample inside', () => {
    const inside = session.cursor.find(
      (s) =>
        s.x >= hoverBox.x &&
        s.x < hoverBox.x + hoverBox.width &&
        s.y >= hoverBox.y &&
        s.y < hoverBox.y + hoverBox.height,
    )!;
    const orange = frames.find(
      (frame) => frame.at[0] > 230 && frame.at[1] > 130 && frame.at[2] < 60,
    );
    assert.ok(orange, 'a frame shows the hover color');
    assert.equal(+orange.t.toFixed(2), +inside.t.toFixed(2));
  });

  it('stores no frame inside a cut and one at its end, and every frame in a speed region', () => {
    const [cut] = ofType(session, 'cut');
    assert.ok(cut.end - cut.t >= 600);
    assert.equal(frames.filter((f) => f.t > cut.t + 0.01 && f.t < cut.end - 0.01).length, 0);
    assert.ok(
      frames.some((f) => Math.abs(f.t - cut.end) < 0.01),
      'a frame at the end of the cut',
    );
    const [speed] = ofType(session, 'speed');
    const inside = frames.filter((f) => f.t >= speed.t && f.t <= speed.end);
    assert.equal(inside.length, Math.round((speed.end - speed.t) / FRAME) + 1);
  });

  it('starts the page wall clock ahead of the real clock, also after a navigation', () => {
    const [start, end] = clockLead;
    assert.ok(Math.abs(start - 600_000) < 5000, `${start} ms ahead at the start`);
    assert.ok(end > 600_000 - 120_000 && end < start, `${end} ms ahead at the end`);
  });

  it('keeps the page clock running after a cross-site navigation', () => {
    const later = frames.filter((frame) => frame.t > marks.second + 100);
    assert.ok(later.length >= 25, `${later.length} frames on the second site`);
    assert.deepEqual(frameSteps(later), { [+FRAME.toFixed(1)]: later.length - 1 });
    const moves = steps(later.map((frame) => frame.x.red)).filter((step) => step > -1000);
    assert.deepEqual(
      moves.filter((step) => Math.abs(step - 20) > 0.5),
      [],
    );
  });
});

describe('frame-perfect failures and limits', () => {
  let server: TestServer;
  let dir: string;

  before(async () => {
    server = await serve({ '/': '<!doctype html><button id="go">Go</button>' });
    dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-fp-fail-'));
  });

  after(async () => {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes error.png and the partial session when a call fails', async () => {
    const options: RecordOptions = {
      url: server.url,
      sessionDir: dir,
      capture: FRAME_PERFECT,
      pacing: { startDelay: 0, endDelay: 0 },
    };
    await assert.rejects(
      record(options, async (cast) => {
        await cast.click('#go');
        await cast.click('#missing', { timeout: 1000 });
      }),
      /cast\.click\("#missing"\) failed at/,
    );
    await access(path.join(dir, 'error.png'));
    const partial = await loadSession(dir);
    assert.ok(partial.frames.length > 0 && partial.frames.every((frame) => onGrid(frame.t)));
    assert.equal(buttons(partial, 'mouseDown').length, 1);
  });

  it('blocks a zoom call for part of the camera move by default', async () => {
    const rect = { x: 100, y: 100, width: 300, height: 200 };
    const { session } = await record(
      {
        url: server.url,
        sessionDir: dir,
        capture: FRAME_PERFECT,
        pacing: { startDelay: 0, endDelay: 0 },
      },
      async (cast) => {
        await cast.zoomTo(rect);
        await cast.zoomTo(rect, { wait: true });
        await cast.zoomOut({ wait: false });
        await cast.zoomTo(rect, { duration: 600, wait: 100 });
        await cast.zoomOut({ duration: 300 });
      },
    );
    const blocked = ofType(session, 'action').map((action) => +(action.end - action.t).toFixed(1));
    // 35% of 900 ms is 315 ms: 19 frames. 35% of 300 ms is 105 ms: 6 frames.
    assert.deepEqual(blocked, [316.7, 900, 0, 100, 100]);
    assert.deepEqual(
      ofType(session, 'zoom').map((zoom) => zoom.duration),
      [undefined, undefined, undefined, 600, 300],
    );
  });

  it('writes cursor zooms and target zooms with levels and follow modes', async () => {
    const rect = { x: 100, y: 100, width: 300, height: 200 };
    const { session } = await record(
      {
        url: server.url,
        sessionDir: dir,
        capture: FRAME_PERFECT,
        pacing: { startDelay: 0, endDelay: 0 },
      },
      async (cast) => {
        await cast.moveTo({ x: 300, y: 200 });
        await cast.zoom('close');
        await cast.zoom(1.8, { follow: 'edge', duration: 600, wait: false });
        await cast.zoomTo(rect, { level: 'medium', follow: 'cursor' });
        await cast.zoomTo(rect, { scale: 2, level: 'close', follow: false });
        await cast.zoomOut();
      },
    );
    const zooms = ofType(session, 'zoom').map(({ t, ...zoom }) => zoom);
    const cursor = { x: 300, y: 200, width: 0, height: 0 };
    assert.deepEqual(zooms, [
      { type: 'zoom', focus: cursor, level: 'close', follow: 'cursor', anchor: 'cursor' },
      {
        type: 'zoom',
        focus: cursor,
        scale: 1.8,
        duration: 600,
        follow: 'edge',
        anchor: 'cursor',
      },
      { type: 'zoom', focus: rect, level: 'medium', follow: 'cursor' },
      { type: 'zoom', focus: rect, scale: 2, level: 'close', follow: false },
      { type: 'zoom', focus: null },
    ]);
    const actions = ofType(session, 'action').filter((action) => action.call.startsWith('zoom('));
    assert.deepEqual(
      actions.map((action) => [action.call, +(action.end - action.t).toFixed(1)]),
      [
        ['zoom("close")', 316.7],
        ['zoom(1.8)', 0],
      ],
    );
  });

  it('refuses a headed browser and other channels', async () => {
    for (const browser of [{ headless: false }, { channel: 'chrome' }]) {
      await assert.rejects(
        record({ sessionDir: dir, capture: FRAME_PERFECT, browser }, async () => {}),
        /frame-perfect" needs the headless shell of Chromium/,
      );
    }
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

type DragLog = {
  px: number;
  py: number;
  hover: boolean;
  ghost: number | null;
  released: boolean;
}[];

describe('frame-perfect drag in the Orbit demo app', () => {
  let app: ChildProcess;
  let url: string;
  let dir: string;

  before(async () => {
    const port = await freePort();
    url = `http://127.0.0.1:${port}`;
    app = spawn(process.execPath, ['examples/demo-app/serve.mjs', String(port)], {
      stdio: 'ignore',
    });
    for (let i = 0; i < 50; i++) {
      if (
        await fetch(url).then(
          (r) => r.ok,
          () => false,
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-fp-orbit-'));
  });

  after(async () => {
    app?.kill();
    await rm(dir, { recursive: true, force: true });
  });

  it('moves the drag ghost with the cursor in every frame', async () => {
    let log: DragLog = [];
    let card: Rect;
    const { session } = await record(
      {
        url,
        sessionDir: dir,
        capture: FRAME_PERFECT,
        cursor: { start: { x: 1000, y: 650 } },
        pacing: { startDelay: 100, endDelay: 100 },
      },
      async (cast) => {
        const first = cast.page.locator('[data-testid^="card-ORB"]').first();
        await first.waitFor();
        card = (await first.boundingBox())!;
        await cast.page.evaluate(() => {
          const entries: DragLog = [];
          (window as unknown as { dragLog: DragLog }).dragLog = entries;
          let px = 0;
          let py = 0;
          let released = false;
          addEventListener(
            'pointermove',
            (event) => {
              px = event.clientX;
              py = event.clientY;
            },
            true,
          );
          addEventListener('pointerup', () => (released = true), true);
          const source = document.querySelector('[data-testid^="card-ORB"]')!;
          const tick = () => {
            const ghost = document.querySelector('.drag-ghost');
            const x = ghost ? new DOMMatrix(getComputedStyle(ghost).transform).m41 : null;
            entries.push({ px, py, hover: source.matches(':hover'), ghost: x, released });
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await cast.moveTo(first);
        await cast.drag(first, cast.page.locator('.column').nth(2));
        log = await cast.page.evaluate(() => (window as unknown as { dragLog: DragLog }).dragLog);
      },
    );

    const inside = (x: number, y: number) =>
      x >= card.x && x < card.x + card.width && y >= card.y && y < card.y + card.height;
    const firstHover = log.findIndex((entry) => entry.hover);
    assert.ok(firstHover > 0, 'the card gets the hover state');
    assert.ok(inside(log[firstHover].px, log[firstHover].py), 'with the pointer inside');
    assert.ok(!inside(log[firstHover - 1].px, log[firstHover - 1].py), 'not one frame late');

    const dragging = log.filter((entry) => entry.ghost !== null && !entry.released);
    assert.ok(dragging.length > 30, `${dragging.length} frames with the ghost`);
    const [down] = buttons(session, 'mouseDown');
    const [up] = buttons(session, 'mouseUp');
    const samples = new Set(
      session.cursor.filter((s) => s.t > down.t && s.t < up.t).map((s) => s.x.toFixed(1)),
    );
    const moving = dragging.filter((entry) => samples.has(entry.px.toFixed(1)));
    assert.ok(moving.length >= dragging.length - 15, 'the ghost frames match cursor samples');
    const offsets = counts(moving.map((entry) => +(entry.px - entry.ghost!).toFixed(1)));
    assert.equal(Object.keys(offsets).length, 1, `one offset: ${JSON.stringify(offsets)}`);
  });
});
