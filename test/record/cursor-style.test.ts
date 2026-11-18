import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { CursorStyleProbe, mapCssCursor } from '../../src/record/cursor-style.ts';
import type { CursorStyle } from '../../src/types.ts';
import { serve, type TestServer } from './helpers.ts';

describe('mapCssCursor', () => {
  it('maps CSS cursors to the styles the renderer draws', () => {
    const cases: Record<string, CursorStyle> = {
      default: 'default',
      pointer: 'pointer',
      text: 'text',
      grab: 'grab',
      grabbing: 'grabbing',
      crosshair: 'crosshair',
      move: 'move',
      none: 'none',
      'not-allowed': 'not-allowed',
      'col-resize': 'ew-resize',
      'e-resize': 'ew-resize',
      'w-resize': 'ew-resize',
      'ew-resize': 'ew-resize',
      'row-resize': 'ns-resize',
      'n-resize': 'ns-resize',
      's-resize': 'ns-resize',
      'ne-resize': 'nesw-resize',
      'sw-resize': 'nesw-resize',
      'nw-resize': 'nwse-resize',
      'se-resize': 'nwse-resize',
      'all-scroll': 'move',
      'vertical-text': 'text',
      'no-drop': 'not-allowed',
      wait: 'default',
      help: 'default',
      'zoom-in': 'default',
      auto: 'default',
      'url("hand.png") 4 4, pointer': 'pointer',
      'url(a.cur), url(b.png) 2 2, col-resize': 'ew-resize',
    };
    for (const [css, style] of Object.entries(cases)) {
      assert.equal(mapCssCursor(css), style, css);
    }
  });
});

const FRAME = `<body style="margin:0"><a id="inner" href="#" style="display:block;padding:30px">In frame</a></body>`;

const PAGE = `<!doctype html><html><body style="margin:0;font:20px/1.5 sans-serif">
<p id="para" style="position:absolute;left:20px;top:20px;width:600px;margin:0">Short line</p>
<button id="button" style="position:absolute;left:20px;top:100px;width:160px;height:40px">Button label</button>
<a id="link" href="#" style="position:absolute;left:220px;top:100px">A link</a>
<div id="editable" contenteditable style="position:absolute;left:20px;top:170px;width:300px;height:60px;padding:10px"></div>
<input id="input" style="position:absolute;left:380px;top:170px;width:200px">
<p id="noselect" style="position:absolute;left:20px;top:260px;margin:0;user-select:none">No select</p>
<div id="host" style="position:absolute;left:20px;top:320px;width:400px;height:40px"></div>
<div id="splitter" style="position:absolute;left:700px;top:20px;width:10px;height:200px;cursor:col-resize"></div>
<div id="changing" style="position:absolute;left:800px;top:20px;width:100px;height:100px;background:#ddd"></div>
<iframe id="frame" src="/frame" style="position:absolute;left:700px;top:300px;width:300px;height:150px;border:0"></iframe>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<span id="shadowText">Shadow text</span> <span id="shadowPointer" style="cursor:pointer">Go</span>';
</script>
</body></html>`;

describe('CursorStyleProbe in a page', () => {
  let server: TestServer;
  let browser: Browser;
  let page: Page;
  const probe = new CursorStyleProbe();
  const changes: CursorStyle[] = [];

  before(async () => {
    server = await serve({ '/': PAGE, '/frame': FRAME });
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    probe.onChange = (style) => changes.push(style);
    await probe.install(context);
    page = await context.newPage();
    await page.goto(server.url);
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  async function styleAt(x: number, y: number, expected: CursorStyle): Promise<void> {
    probe.pointer = { x, y };
    await page.mouse.move(x, y);
    const deadline = Date.now() + 1000;
    while (probe.style !== expected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(probe.style, expected, `style at ${x},${y}`);
  }

  async function center(selector: string, dx = 0): Promise<[number, number]> {
    const box = (await page.locator(selector).boundingBox())!;
    return [box.x + box.width / 2 + dx, box.y + box.height / 2];
  }

  it('shows text over selectable text and default beside it', async () => {
    const box = (await page.locator('#para').boundingBox())!;
    await styleAt(box.x + 20, box.y + box.height / 2, 'text');
    await styleAt(box.x + 500, box.y + box.height / 2, 'default');
  });

  it('follows the computed cursor of controls and links', async () => {
    await styleAt(...(await center('#button')), 'default');
    await styleAt(...(await center('#link')), 'pointer');
    await styleAt(...(await center('#input')), 'text');
    await styleAt(...(await center('#splitter')), 'ew-resize');
  });

  it('shows text over editable elements but not over unselectable text', async () => {
    await styleAt(...(await center('#editable')), 'text');
    await styleAt(...(await center('#noselect')), 'default');
  });

  it('pierces open shadow roots', async () => {
    await styleAt(...(await center('#host >> #shadowPointer')), 'pointer');
    await styleAt(...(await center('#host >> #shadowText')), 'text');
  });

  it('lets a child frame report its own cursor', async () => {
    await styleAt(...(await center('#frame')), 'pointer');
    await styleAt(...(await center('#para', -200)), 'default');
  });

  it('notices a change under a still pointer', async () => {
    await styleAt(...(await center('#changing')), 'default');
    await page.locator('#changing').evaluate((el) => (el.style.cursor = 'grab'));
    const deadline = Date.now() + 1000;
    while (probe.style !== 'grab' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(probe.style, 'grab');
  });

  it('reports only changes', () => {
    for (let i = 1; i < changes.length; i++) {
      assert.notEqual(changes[i], changes[i - 1]);
    }
  });
});
