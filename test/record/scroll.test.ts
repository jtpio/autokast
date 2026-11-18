import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { record } from '../../src/record/index.ts';
import type { Rect, RecordOptions } from '../../src/types.ts';
import { serve, type TestServer } from './helpers.ts';

const items = [...Array(40).keys()]
  .map((i) => `<div style="height:30px"><button id="item-${i + 1}">Item ${i + 1}</button></div>`)
  .join('');

const PAGE = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<div style="height:1400px"><button id="top">Top</button></div>
<div id="outer" style="height:300px;width:500px;overflow:auto;border:1px solid #888">
  <div style="height:400px">Outer head</div>
  <div id="inner" style="height:150px;width:400px;overflow:auto;border:1px solid #888">${items}</div>
  <div style="height:400px">Outer tail</div>
</div>
<div style="height:1200px"></div>
<button id="far">Far</button>
<div style="height:1000px"></div>
<div id="clip" style="height:100px;overflow:hidden;border:1px solid #888">
  <div style="height:300px"></div><button id="clipped">Clipped</button>
</div>
<div style="height:600px"></div>
<script>
  window.log = [];
  window.scrolls = { root: [], outer: [], inner: [] };
  addEventListener('scroll', (e) => {
    const el = e.target === document ? document.scrollingElement : e.target;
    const key = e.target === document ? 'root' : e.target.id;
    if (key in scrolls) scrolls[key].push(el.scrollTop);
  }, true);
  document.addEventListener('click', (e) => { if (e.target.id) log.push(e.target.id); });
</script></body></html>`;

type Scrolls = Record<'root' | 'outer' | 'inner', number[]>;

interface PageState {
  log: string[];
  scrolls: Scrolls;
}

function readState(): PageState {
  const win = window as unknown as PageState;
  const state = { log: [...win.log], scrolls: structuredClone(win.scrolls) };
  win.scrolls = { root: [], outer: [], inner: [] };
  return state;
}

/**
 * Largest single scroll step, as a fraction of the whole scroll.
 */
function largestStep(positions: number[], start: number): number {
  const all = [start, ...positions];
  const total = Math.abs(all.at(-1)! - start);
  const steps = all.slice(1).map((value, i) => Math.abs(value - all[i]));
  return Math.max(...steps) / total;
}

describe('smooth scroll into view', () => {
  let server: TestServer;
  let dir: string;

  before(async () => {
    server = await serve({ '/': PAGE });
    dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-scroll-'));
  });

  after(async () => {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  function options(extra: RecordOptions = {}): RecordOptions {
    return { url: server.url, sessionDir: dir, pacing: { startDelay: 0, endDelay: 0 }, ...extra };
  }

  it('scrolls the page, nested containers and clipped content with eased wheels', async () => {
    const states: PageState[] = [];
    let far: Rect | null = null;
    let farStart: Rect | null = null;
    const { session } = await record(options(), async (cast) => {
      await cast.click('#far');
      far = await cast.page.locator('#far').boundingBox();
      states.push(await cast.page.evaluate(readState));
      await cast.click('#item-35');
      states.push(await cast.page.evaluate(readState));
      await cast.click('#clipped');
      states.push(await cast.page.evaluate(readState));
      await cast.scrollTo('#far', { block: 'start' });
      farStart = await cast.page.locator('#far').boundingBox();
      states.push(await cast.page.evaluate(readState));
    });
    const [toFar, toItem, toClipped] = states;

    // An instant scroll is one step of 100%. About 25 steps of at most 10% when the machine
    // is idle; fewer and bigger ones when other tests load the CPU.
    assert.ok(toFar.scrolls.root.length >= 8, `${toFar.scrolls.root.length} page scroll events`);
    assert.ok(largestStep(toFar.scrolls.root, 0) < 0.4, 'the page scroll has no big jump');
    const center = far!.y + far!.height / 2;
    assert.ok(Math.abs(center - 360) < 30, `#far centered at y ${center}`);

    assert.ok(toItem.scrolls.root.length >= 5, 'the page scrolls back up');
    assert.ok(toItem.scrolls.outer.length >= 5, 'the wheel reaches the outer container');
    assert.ok(toItem.scrolls.inner.length >= 5, 'the wheel reaches the inner container');
    assert.ok(largestStep(toItem.scrolls.inner, 0) < 0.4, 'the inner scroll has no big jump');

    assert.deepEqual(toClipped.log, ['far', 'item-35', 'clipped']);
    assert.ok(Math.abs(farStart!.y - 32) < 3, `#far starts at y ${farStart!.y}`);

    const actions = session.events.filter((event) => event.type === 'action');
    assert.deepEqual(
      actions.map((event) => event.call),
      ['click("#far")', 'click("#item-35")', 'click("#clipped")', 'scrollTo("#far")'],
    );
  });

  it('jumps with the instant scroll behavior', async () => {
    let state: PageState | undefined;
    await record(options({ scrollBehavior: 'instant' }), async (cast) => {
      await cast.click('#far');
      state = await cast.page.evaluate(readState);
    });
    assert.ok(state!.scrolls.root.length <= 2, `${state!.scrolls.root.length} page scroll events`);
    assert.deepEqual(state!.log, ['far']);
  });
});
