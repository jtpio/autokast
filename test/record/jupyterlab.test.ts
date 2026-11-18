import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { record } from '../../src/record/index.ts';
import type { TypingOptions } from '../../src/types.ts';
import { CODE } from './helpers.ts';

const LAB = process.env.AUTOCAST_JUPYTERLAB_URL ?? 'http://localhost:8888';
const LAUNCHER_NOTEBOOK = '.jp-LauncherCard[data-category="Notebook"]';

let xsrf: string | undefined;

/**
 * Calls the Jupyter Server REST API with the XSRF token it needs for changes.
 */
async function api(route: string, method = 'GET'): Promise<Response> {
  if (!xsrf) {
    const page = await fetch(`${LAB}/lab`);
    const cookie = page.headers.getSetCookie().find((value) => value.startsWith('_xsrf='));
    xsrf = cookie?.split(';')[0].slice('_xsrf='.length) ?? '';
  }
  return fetch(`${LAB}${route}`, {
    method,
    headers: { 'X-XSRFToken': xsrf, cookie: `_xsrf=${xsrf}` },
  });
}

const available = await fetch(`${LAB}/api/status`).then(
  (response) => response.ok,
  () => false,
);

/**
 * In-page: the cell source from the CodeMirror state, and the text of the rendered lines.
 */
function readCell(content: Element): { source: string; lines: string } {
  type View = { view?: { state: { doc: { toString(): string } } } };
  const view = (content as unknown as { cmView?: View }).cmView?.view;
  const lines = Array.from(content.querySelectorAll('.cm-line'), (line) => line.textContent);
  return { source: view?.state.doc.toString() ?? '', lines: lines.join('\n') };
}

describe('typing in JupyterLab', { skip: available ? false : `no JupyterLab at ${LAB}` }, () => {
  const workspace = `autocast-test-${process.pid}-${Date.now()}`;
  const notebooks: string[] = [];

  after(async () => {
    const sessions = (await (await api('/api/sessions')).json()) as { id: string; path: string }[];
    for (const name of notebooks) {
      for (const session of sessions.filter((item) => item.path === name)) {
        await api(`/api/sessions/${session.id}`, 'DELETE');
      }
      await api(`/api/contents/${encodeURIComponent(name)}`, 'DELETE');
    }
    await api(`/lab/api/workspaces/${workspace}`, 'DELETE');
  });

  const speeds: [string, TypingOptions][] = [
    ['the default speed', {}],
    ['a fast speed', { delay: 5, variance: 0 }],
  ];
  for (const [label, typing] of speeds) {
    it(`gives the exact cell source at ${label}`, async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-jlab-'));
      let cell = { source: '', lines: '' };
      try {
        await record(
          {
            url: `${LAB}/lab/workspaces/${workspace}?reset`,
            sessionDir: dir,
            pacing: { startDelay: 0, endDelay: 0 },
            timeout: 30_000,
          },
          async (cast) => {
            await cast.click(LAUNCHER_NOTEBOOK);
            await cast.page.waitForURL(/\/tree\/.+\.ipynb/);
            const name = decodeURIComponent(new URL(cast.page.url()).pathname.split('/tree/')[1]);
            notebooks.push(name);
            await cast.page
              .locator('.jp-Notebook-ExecutionIndicator[data-status="idle"]')
              .waitFor({ timeout: 60_000 });
            await cast.type(CODE, { into: '.jp-Notebook .jp-Cell .cm-content', ...typing });
            cell = await cast.page.locator('.jp-Notebook .jp-Cell .cm-content').evaluate(readCell);
          },
          async ({ page }) => {
            await page.locator(LAUNCHER_NOTEBOOK).waitFor({ timeout: 60_000 });
          },
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
      assert.equal(cell.source, CODE);
      assert.equal(cell.lines, CODE);
    });
  }
});
