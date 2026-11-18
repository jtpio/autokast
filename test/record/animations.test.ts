import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { chromium, type Browser, type Page } from 'playwright';
import { settleAnimations } from '../../src/record/animations.ts';
import { record } from '../../src/record/index.ts';
import { serve, type TestServer } from './helpers.ts';

const SPINNER = `<div style="width:40px;height:40px;border:4px solid #888;border-top-color:transparent;
  border-radius:50%;animation:spin 1s linear infinite"></div>
<style>@keyframes spin { to { transform: rotate(360deg); } }</style>`;

const HERO = `<!doctype html><body style="margin:0;background:#fff">
<div id="hero" style="position:absolute;left:200px;top:200px;width:400px;height:200px;
  background:rgb(255,0,0);animation:enter 0.8s ease-out both"></div>
<style>@keyframes enter { from { opacity: 0; transform: translateY(40px); } }</style>
${SPINNER}</body>`;

describe('settleAnimations', () => {
  let browser: Browser;
  let page: Page;

  before(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
  });

  after(async () => {
    await browser?.close();
  });

  async function settle(html: string, timeout = 2000): Promise<{ ms: number; left: number }> {
    await page.setContent(html);
    const started = Date.now();
    const left = await page.evaluate(settleAnimations, timeout);
    return { ms: Date.now() - started, left };
  }

  it('ignores infinite animations', async () => {
    const { ms, left } = await settle(`<!doctype html>${SPINNER}`);
    assert.equal(left, 0);
    assert.ok(ms < 300, `${ms} ms`);
  });

  it('waits for finite animations, transitions and the ones they start', async () => {
    const { ms, left } = await settle(`<!doctype html><div id="box"
      style="width:50px;height:50px;transition:width 0.4s;animation:a 0.6s"></div>
      <style>@keyframes a { from { opacity: 0 } }</style>
      <script>
        const box = document.getElementById('box');
        box.addEventListener('animationend', () => { box.style.width = '200px'; });
      </script>${SPINNER}`);
    assert.equal(left, 0);
    assert.ok(ms >= 900 && ms < 1600, `${ms} ms for a 0.6 s animation, then a 0.4 s transition`);
  });

  it('stops waiting after the time limit', async () => {
    const { ms, left } = await settle(
      '<!doctype html><div style="width:9px;height:9px;animation:a 5s"></div>' +
        '<style>@keyframes a { from { opacity: 0 } }</style>',
      500,
    );
    assert.equal(left, 1);
    assert.ok(ms >= 450 && ms < 900, `${ms} ms`);
  });
});

describe('the first frame', () => {
  let server: TestServer;
  let dir: string;

  before(async () => {
    server = await serve({ '/': HERO });
    dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-frame0-'));
  });

  after(async () => {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('shows the page after its entrance animation', async () => {
    const { session } = await record(
      { url: server.url, sessionDir: dir, pacing: { startDelay: 0, endDelay: 0 } },
      (cast) => cast.wait(100),
    );
    const image = await loadImage(path.join(dir, session.frames[0].file));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const scale = session.deviceScaleFactor;
    const [r, g, b] = context.getImageData(210 * scale, 210 * scale, 1, 1).data;
    assert.ok(r > 240 && g < 20 && b < 20, `pixel at the hero corner is ${r},${g},${b}`);
  });
});
