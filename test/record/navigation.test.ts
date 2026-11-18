import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';
import { record } from '../../src/record/index.ts';
import type { Session } from '../../src/types.ts';
import { serve, type TestServer } from './helpers.ts';

function page(title: string, links: string): string {
  return `<!doctype html><html><body style="margin:0;font:16px sans-serif">
<h1>${title}</h1>${links}
<div style="width:80px;height:80px;background:#e4572e;border-radius:16px;
  animation:move 1s ease-in-out infinite alternate"></div>
<style>@keyframes move { to { transform: translateX(900px); } }</style>
</body></html>`;
}

let first: TestServer;
let second: TestServer;
let dir: string;

before(async () => {
  // `localhost` and `127.0.0.1` are different sites: the renderer process changes.
  second = await serve({ '/': page('Second site', '<a id="back" href="/">Back</a>') }, 'localhost');
  first = await serve({
    '/': page('Home', '<a id="same" href="/two">Same origin</a>'),
    '/two': page('Two', `<a id="cross" href="${second.url}/">Cross site</a>`),
  });
  dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-nav-'));
});

after(async () => {
  await first?.close();
  await second?.close();
  await rm(dir, { recursive: true, force: true });
});

function framesBetween(session: Session, start: number, end: number): number {
  return session.frames.filter((frame) => frame.t > start && frame.t <= end).length;
}

it('keeps capturing frames and cursor styles across navigations', async () => {
  const marks: Record<string, number> = {};
  const { session } = await record(
    {
      url: first.url,
      sessionDir: dir,
      browser: { args: ['--site-per-process'] },
      pacing: { startDelay: 200, endDelay: 200 },
    },
    async (cast) => {
      await cast.click('#same');
      await cast.page.waitForURL(`${first.url}/two`);
      cast.marker('same');
      await cast.wait(1000);
      await cast.click('#cross');
      await cast.page.waitForURL(`${second.url}/`);
      cast.marker('cross');
      await cast.wait(1000);
      await cast.hover('#back', { hold: 300 });
    },
  );
  for (const event of session.events) {
    if (event.type === 'marker') {
      marks[event.label] = event.t;
    }
  }
  // About 45 frames alone; fewer when other tests load the CPU. A stopped capture gives 0.
  const afterSame = framesBetween(session, marks.same + 200, marks.same + 1000);
  const afterCross = framesBetween(session, marks.cross + 200, marks.cross + 1000);
  assert.ok(afterSame >= 3, `${afterSame} frames after the same-origin navigation`);
  assert.ok(afterCross >= 3, `${afterCross} frames after the cross-site navigation`);
  const lastFrame = session.frames.at(-1)!;
  assert.ok(lastFrame.t > session.duration - 300, 'frames continue to the end');
  const pointerAfterCross = session.events.some(
    (event) => event.type === 'cursorStyle' && event.style === 'pointer' && event.t > marks.cross,
  );
  assert.ok(pointerAfterCross, 'the cursor probe runs on the new site');
});
