import assert from 'node:assert/strict';
import { access, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { imageSize } from '../../src/record/capture.ts';
import { record } from '../../src/record/index.ts';
import { loadSession } from '../../src/session.ts';
import type {
  MouseButtonEvent,
  Rect,
  RecordedSession,
  Session,
  TimelineEvent,
} from '../../src/types.ts';
import { hasFfprobe, isMonotonic, probeImageSize, serve, type TestServer } from './helpers.ts';

const items = [...Array(30).keys()].map((i) => `<div>Item ${i + 1}</div>`).join('');

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture</title>
<style>
  body { margin: 0; font: 16px/1.4 sans-serif; background: #f6f7f9; }
  #name { position: absolute; left: 60px; top: 60px; width: 280px; height: 32px; }
  #save { position: absolute; left: 370px; top: 60px; width: 120px; height: 38px; cursor: pointer; }
  #list { position: absolute; left: 60px; top: 160px; width: 280px; height: 220px;
    overflow: auto; background: #fff; border: 1px solid #ccc; }
  #list div { height: 36px; padding: 0 10px; border-bottom: 1px solid #eee; }
  #handle { position: absolute; left: 700px; top: 160px; width: 90px; height: 90px;
    background: #4a7bd8; border-radius: 12px; cursor: grab; user-select: none; touch-action: none; }
  #para { position: absolute; left: 420px; top: 420px; width: 380px; margin: 0; }
  #link { position: absolute; left: 60px; top: 440px; }
  #resize { position: absolute; left: 900px; top: 440px; width: 10px; height: 120px;
    background: #ccc; cursor: col-resize; }
  #spinner { position: absolute; right: 40px; bottom: 40px; width: 40px; height: 40px;
    border-radius: 50%; border: 4px solid #4a7bd8; border-top-color: transparent;
    animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style></head><body>
<input id="name" placeholder="Your name">
<button id="save">Save</button>
<div id="list">${items}</div>
<div id="handle"></div>
<p id="para">Double-click a word in this paragraph to select it.</p>
<a id="link" href="#details">Details</a>
<div id="resize"></div>
<div id="spinner"></div>
<script>
  window.log = [];
  const save = document.getElementById('save');
  save.addEventListener('click', () => { save.textContent = 'Saved'; log.push('click:save'); });
  const para = document.getElementById('para');
  para.addEventListener('dblclick', () => log.push('dblclick:para'));
  para.addEventListener('contextmenu', (e) => { e.preventDefault(); log.push('contextmenu:para'); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.shiftKey) log.push('shift+enter');
  });
  const handle = document.getElementById('handle');
  handle.addEventListener('pointerdown', (e) => {
    handle.setPointerCapture(e.pointerId);
    const ox = e.clientX - handle.offsetLeft;
    const oy = e.clientY - handle.offsetTop;
    handle.style.cursor = 'grabbing';
    const move = (m) => {
      handle.style.left = m.clientX - ox + 'px';
      handle.style.top = m.clientY - oy + 'px';
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', () => {
      handle.removeEventListener('pointermove', move);
      handle.style.cursor = 'grab';
      log.push('drop');
    }, { once: true });
  });
</script></body></html>`;

function inside(point: { x: number; y: number }, box: Rect): boolean {
  return (
    point.x >= box.x &&
    point.x <= box.x + box.width &&
    point.y >= box.y &&
    point.y <= box.y + box.height
  );
}

function ofType<T extends TimelineEvent['type']>(
  session: Session,
  type: T,
): Extract<TimelineEvent, { type: T }>[] {
  return session.events.filter((event) => event.type === type) as Extract<
    TimelineEvent,
    { type: T }
  >[];
}

describe('record() end to end', () => {
  let server: TestServer;
  let dir: string;
  let recorded: RecordedSession;
  let session: Session;
  const page: {
    saveBox?: Rect;
    nameBox?: Rect;
    handleStart?: Rect;
    handleEnd?: Rect;
    value?: string;
    log?: string[];
    scrollTop?: number;
    selection?: string;
    elapsed?: number;
  } = {};

  before(async () => {
    server = await serve({ '/': PAGE });
    dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-record-'));
    const started = Date.now();
    recorded = await record(
      {
        name: 'fixture',
        url: server.url,
        sessionDir: dir,
        seed: 7,
        cursor: { speed: 1.5 },
        pacing: { startDelay: 300, endDelay: 400, afterClick: 200 },
        render: { fps: 30 },
      },
      async (cast) => {
        page.saveBox = (await cast.page.locator('#save').boundingBox()) ?? undefined;
        page.nameBox = (await cast.page.locator('#name').boundingBox()) ?? undefined;
        page.handleStart = (await cast.page.locator('#handle').boundingBox()) ?? undefined;
        await cast.click('#name');
        await cast.type('Ada Lovelace', { delay: 40 });
        await cast.press('Shift+Enter');
        await cast.zoomTo('#name', { scale: 2, duration: 400, follow: 'edge' });
        await cast.click(cast.page.getByRole('button', { name: 'Save' }));
        await cast.zoomOut({ duration: 400 });
        await cast.scroll({ y: 300 }, { at: '#list' });
        await cast.drag('#handle', { x: 900, y: 300 });
        await cast.dblclick('#para', { position: { x: 0.1, y: 0.5 } });
        page.selection = await cast.page.evaluate(() => String(getSelection()));
        await cast.rightClick('#para');
        await cast.hover('#link', { hold: 200 });
        await cast.hover('#resize', { hold: 200 });
        await cast.cut(() => cast.wait(500));
        await cast.speed(2, () => cast.moveTo({ x: 100, y: 600 }));
        await cast.caption('Done', { duration: 800 });
        cast.marker('end');
        page.value = await cast.page.locator('#name').inputValue();
        page.log = await cast.page.evaluate(() => (window as unknown as { log: string[] }).log);
        page.scrollTop = await cast.page.locator('#list').evaluate((el) => el.scrollTop);
        page.handleEnd = (await cast.page.locator('#handle').boundingBox()) ?? undefined;
      },
    );
    page.elapsed = Date.now() - started;
    session = await loadSession(dir);
  });

  after(async () => {
    await server?.close();
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a session that loadSession reads', () => {
    assert.equal(session.version, 1);
    assert.equal(session.name, 'fixture');
    assert.deepEqual(ofType(session, 'url')[0], { type: 'url', t: 0, url: `${server.url}/` });
    assert.deepEqual(session.viewport, { width: 1280, height: 720 });
    assert.equal(session.deviceScaleFactor, 2);
    assert.equal(session.captureMode, 'realtime');
    assert.deepEqual(session.render, { fps: 30 });
    assert.equal(recorded.dir, dir);
    assert.equal(recorded.session.frames.length, session.frames.length);
    // About 12 s alone; longer when other tests load the CPU.
    assert.ok(session.duration > 6000 && session.duration < 30000, `duration ${session.duration}`);
  });

  it('captures frames at the device pixel size', async () => {
    assert.deepEqual(session.frameSize, { width: 2560, height: 1440 });
    assert.ok(session.frames.length > 100, `${session.frames.length} frames`);
    for (const frame of session.frames) {
      await access(path.join(dir, frame.file));
    }
    const first = path.join(dir, session.frames[0].file);
    const last = path.join(dir, session.frames.at(-1)!.file);
    if (hasFfprobe()) {
      assert.deepEqual(probeImageSize(first), { width: 2560, height: 1440 });
      assert.deepEqual(probeImageSize(last), { width: 2560, height: 1440 });
    }
    const { readFile } = await import('node:fs/promises');
    assert.deepEqual(imageSize(await readFile(last)), { width: 2560, height: 1440 });
    assert.ok((await stat(first)).size > 10_000);
  });

  it('has monotonic frame and cursor times that start at 0', () => {
    const frameTimes = session.frames.map((frame) => frame.t);
    assert.equal(frameTimes[0], 0);
    assert.ok(isMonotonic(frameTimes), 'frame times are monotonic');
    assert.ok(frameTimes.at(-1)! <= session.duration);
    const cursorTimes = session.cursor.map((sample) => sample.t);
    assert.equal(cursorTimes[0], 0);
    assert.ok(isMonotonic(cursorTimes), 'cursor times are monotonic');
    assert.ok(session.cursor.length > 300, `${session.cursor.length} cursor samples`);
    assert.ok(isMonotonic(session.events.map((event) => event.t)), 'event times are monotonic');
  });

  it('logs mouse button pairs at the clicked coordinates', () => {
    const buttons = session.events.filter(
      (event): event is MouseButtonEvent => event.type === 'mouseDown' || event.type === 'mouseUp',
    );
    // click name, click save, drag, dblclick (2 presses), right click
    assert.equal(buttons.length, 12);
    for (let i = 0; i < buttons.length; i += 2) {
      const [down, up] = [buttons[i], buttons[i + 1]];
      assert.equal(down.type, 'mouseDown');
      assert.equal(up.type, 'mouseUp');
      assert.equal(down.button, up.button);
      assert.ok(up.t > down.t);
    }
    const [nameDown, nameUp, saveDown, saveUp] = buttons;
    assert.ok(inside(nameDown, page.nameBox!), 'click on #name lands inside it');
    assert.ok(inside(saveDown, page.saveBox!), 'click on Save lands inside it');
    assert.deepEqual([saveUp.x, saveUp.y], [saveDown.x, saveDown.y]);
    assert.deepEqual([nameUp.x, nameUp.y], [nameDown.x, nameDown.y]);
    const dragUp = buttons[5];
    assert.deepEqual([dragUp.x, dragUp.y], [900, 300]);
    assert.equal(buttons[10].button, 'right');
    const last = session.cursor.at(-1)!;
    assert.deepEqual([last.x, last.y], [100, 600]);
  });

  it('really acts on the page', () => {
    assert.equal(page.value, 'Ada Lovelace');
    assert.deepEqual(page.log, [
      'shift+enter',
      'click:save',
      'drop',
      'dblclick:para',
      'contextmenu:para',
    ]);
    assert.ok(page.scrollTop! >= 250, `list scrolled to ${page.scrollTop}`);
    assert.equal(page.selection, 'Double');
    const start = page.handleStart!;
    const end = page.handleEnd!;
    const moved = Math.hypot(end.x - start.x, end.y - start.y);
    assert.ok(moved > 150, `handle moved by ${moved}`);
    assert.ok(inside({ x: 900, y: 300 }, end), 'handle follows the cursor to the drop point');
  });

  it('logs each Cast call as an action', () => {
    const actions = ofType(session, 'action');
    const calls = actions.map((action) => action.call);
    assert.equal(calls[0], 'click("#name")');
    assert.ok(calls.includes('type("Ada Lovelace")'));
    assert.ok(calls.includes(`click(getByRole('button', { name: 'Save' }))`));
    assert.ok(calls.includes('scroll({"y":300})'));
    assert.ok(calls.includes('drag("#handle", {"x":900,"y":300})'));
    assert.ok(calls.includes('marker("end")'));
    assert.equal(actions.length, 18);
    assert.ok(actions.every((action) => action.end >= action.t));
    const cut = actions.find((action) => action.call === 'cut()')!;
    const wait = actions.find((action) => action.call === 'wait(500)')!;
    assert.ok(wait.t >= cut.t && wait.end <= cut.end, 'the cut action spans the inner wait');
  });

  it('logs key, zoom, cut, speed, caption and marker events', () => {
    const keys = ofType(session, 'key');
    assert.equal(
      keys
        .filter((key) => key.kind === 'text')
        .map((key) => key.key)
        .join(''),
      'Ada Lovelace',
    );
    assert.deepEqual(
      keys.filter((key) => key.kind === 'shortcut').map((key) => key.key),
      ['Shift+Enter'],
    );
    const zooms = ofType(session, 'zoom');
    assert.equal(zooms.length, 2);
    assert.equal(zooms[0].scale, 2);
    assert.ok(zooms[0].focus && Math.abs(zooms[0].focus.x - page.nameBox!.x) < 1);
    assert.equal(zooms[0].follow, 'edge');
    assert.equal(zooms[1].focus, null);
    assert.equal('follow' in zooms[1], false);
    const [cut] = ofType(session, 'cut');
    assert.ok(cut.end - cut.t >= 490 && cut.end - cut.t < 800, `cut of ${cut.end - cut.t} ms`);
    const [speed] = ofType(session, 'speed');
    assert.equal(speed.rate, 2);
    assert.ok(speed.end > speed.t);
    assert.equal(ofType(session, 'caption')[0].text, 'Done');
    assert.equal(ofType(session, 'marker')[0].label, 'end');
  });

  it('logs the cursor styles under the pointer', () => {
    const styles = ofType(session, 'cursorStyle');
    assert.equal(styles[0].t, 0);
    const seen = new Set(styles.map((event) => event.style));
    for (const style of ['pointer', 'text', 'grab', 'grabbing', 'ew-resize', 'default']) {
      assert.ok(seen.has(style as never), `cursorStyle ${style} in ${[...seen].join(', ')}`);
    }
    for (let i = 1; i < styles.length; i++) {
      assert.notEqual(styles[i].style, styles[i - 1].style, 'only changes are logged');
    }
  });
});

const EDGE_PAGE = `<!doctype html><body style="margin:0">
<button id="go">Go</button>
<button id="jumpy" style="position:absolute;left:300px;top:300px;width:100px;height:40px">Jumpy</button>
<button id="covered" style="position:absolute;left:600px;top:300px;width:100px;height:40px">Covered</button>
<div style="position:absolute;left:580px;top:280px;width:140px;height:80px;background:rgba(0,0,0,.2)"></div>
<script>
  window.clicks = [];
  const jumpy = document.getElementById('jumpy');
  jumpy.addEventListener('mouseenter', () => { jumpy.style.left = '360px'; }, { once: true });
  jumpy.addEventListener('click', () => clicks.push('jumpy'));
</script></body>`;

describe('record() edge cases', () => {
  let server: TestServer;
  let dir: string;

  before(async () => {
    server = await serve({ '/': EDGE_PAGE });
    dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-edge-'));
  });

  after(async () => {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('names the failing call, the record time and the screenshot, and saves the session', async () => {
    const options = { url: server.url, sessionDir: dir, pacing: { startDelay: 0, endDelay: 0 } };
    await assert.rejects(
      record(options, async (cast) => {
        await cast.click('#go');
        await cast.click('#missing', { timeout: 300 });
      }),
      (error: Error) => {
        assert.match(
          error.message,
          /^cast\.click\("#missing"\) failed at \d+\.\d\d s \(record time\)/,
        );
        assert.match(error.message, /Last successful call: cast\.click\("#go"\)/);
        assert.match(error.message, /Timeout 300ms exceeded/);
        const summary = error.message.split('\n')[0];
        assert.match(summary, /^cast\.click\("#missing"\) failed at \d+\.\d\d s \(record time\): /);
        assert.ok(summary.includes('Timeout 300ms exceeded. Screenshot: '), summary);
        assert.ok(summary.endsWith(path.join(dir, 'error.png')), summary);
        assert.ok(error.message.includes(path.join(dir, 'error.png')));
        assert.ok(error.message.includes(`Partial session up to the failure: ${dir}`));
        return true;
      },
    );
    await access(path.join(dir, 'error.png'));
    const partial = await loadSession(dir);
    assert.ok(partial.frames.length > 0 && partial.cursor.length > 0);
    await access(path.join(dir, partial.frames.at(-1)!.file));
    const actions = ofType(partial, 'action');
    assert.deepEqual(
      actions.map((action) => action.call),
      ['click("#go")', 'click("#missing")'],
    );
    assert.ok(actions[1].end - actions[1].t >= 250, 'the failed call ends at the failure');
  });

  it('uses the record timeout for each call', async () => {
    const options = {
      url: server.url,
      sessionDir: dir,
      timeout: 400,
      pacing: { startDelay: 0, endDelay: 0 },
    };
    const started = Date.now();
    await assert.rejects(
      record(options, (cast) => cast.hover('#missing')),
      /Timeout 400ms exceeded/,
    );
    assert.ok(Date.now() - started < 8000);
  });

  it('follows an element that moves after the cursor arrives', async () => {
    const options = { url: server.url, sessionDir: dir, pacing: { startDelay: 0, endDelay: 0 } };
    let clicks: string[] = [];
    let box: Rect | null = null;
    const { session } = await record(options, async (cast) => {
      await cast.click('#jumpy', { position: { x: 0.2, y: 0.5 } });
      clicks = await cast.page.evaluate(() => (window as unknown as { clicks: string[] }).clicks);
      box = await cast.page.locator('#jumpy').boundingBox();
    });
    assert.deepEqual(clicks, ['jumpy']);
    const down = session.events.find((event) => event.type === 'mouseDown') as MouseButtonEvent;
    assert.ok(box && inside(down, box), 'the press lands on the moved element');
    assert.ok(down.x > 360, `pressed at x ${down.x}`);
  });

  it('checks that the element receives the click', async () => {
    const options = { url: server.url, sessionDir: dir, pacing: { startDelay: 0, endDelay: 0 } };
    await assert.rejects(
      record(options, (cast) => cast.click('#covered', { timeout: 500 })),
      /cast\.click\("#covered"\) failed[\s\S]*intercepts pointer events/,
    );
  });

  it('rejects nested cut and speed regions', async () => {
    const options = { url: server.url, sessionDir: dir, pacing: { startDelay: 0, endDelay: 0 } };
    await assert.rejects(
      record(options, (cast) => cast.cut(() => cast.speed(2, () => cast.wait(10)))),
      /cast\.speed\(\) cannot run inside cast\.cut\(\)/,
    );
  });
});
