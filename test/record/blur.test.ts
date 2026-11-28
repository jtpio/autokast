import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';
import type { Frame } from 'playwright';
import { record } from '../../src/record/index.ts';
import { serve, type TestServer } from './helpers.ts';

const HOME = `<!doctype html><html><head><title>Home</title></head><body>
<p class="email">jane.doe@example.com</p><p id="public">Public</p>
<a id="next" href="/account">Account</a><iframe src="/frame"></iframe>
<script>document.head.innerHTML = '<title>Replaced</title>';</script>
</body></html>`;
const ACCOUNT = `<!doctype html><html><body><h1 data-private>Jane Doe</h1>
<button id="add" onclick="document.body.insertAdjacentHTML('beforeend',
  '<p class=&quot;email&quot;>late@example.com</p>')">Add</button></body></html>`;
const FRAME =
  '<!doctype html><html><body><p class="email" style="font-size: 10px">frame@example.com</p></body></html>';

let server: TestServer;
let dir: string;

before(async () => {
  server = await serve({ '/': HOME, '/account': ACCOUNT, '/frame': FRAME });
  dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-blur-'));
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

function filterOf(frame: Frame, selector: string): Promise<string> {
  return frame.locator(selector).evaluate((element) => getComputedStyle(element).filter);
}

const base = () => ({
  url: server.url,
  sessionDir: dir,
  pacing: { startDelay: 0, endDelay: 0 },
});

it('blurs the matching elements in each frame and after a navigation', async () => {
  const filters: Record<string, string> = {};
  await record(
    { ...base(), blur: ['.email', '[data-private]'] },
    async (cast) => {
      const { page } = cast;
      filters.late = await filterOf(page.mainFrame(), '.email');
    },
    async ({ page }) => {
      filters.home = await filterOf(page.mainFrame(), '.email');
      filters.public = await filterOf(page.mainFrame(), '#public');
      filters.frame = await filterOf(page.frames()[1], '.email');
      await page.click('#next');
      filters.account = await filterOf(page.mainFrame(), 'h1');
      await page.click('#add');
    },
  );
  // The radius is 0.4em: 6.4 pixels for the default font size, 12.8 for the heading.
  assert.equal(filters.home, 'blur(6.4px)');
  assert.equal(filters.public, 'none');
  assert.equal(filters.frame, 'blur(6px)', 'small text has the minimum radius');
  assert.equal(filters.account, 'blur(12.8px)');
  assert.equal(filters.late, 'blur(6.4px)');
});

it('blurs nothing without the option', async () => {
  let filter = '';
  await record(base(), async (cast) => {
    filter = await filterOf(cast.page.mainFrame(), '.email');
  });
  assert.equal(filter, 'none');
});

it('rejects a selector that gives no blur', async () => {
  for (const selector of ['.email >', '.email { color: red; ']) {
    await assert.rejects(
      record({ ...base(), blur: ['#public', selector] }, async () => {}),
      (error: Error) => error.message.includes(`invalid CSS selector: ${selector}`),
    );
  }
});
