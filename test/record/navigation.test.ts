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
  const urls = session.events.filter((event) => event.type === 'url');
  assert.deepEqual(
    urls.map((event) => event.url),
    [`${first.url}/`, `${first.url}/two`, `${second.url}/`],
  );
  assert.equal(urls[0].t, 0);
  assert.ok(urls[1].t <= marks.same && urls[2].t <= marks.cross);
});

it('goto opens a URL in a cut, and types it for the browser frame', async () => {
  const run = (chrome: 'none' | 'browser') =>
    record(
      {
        url: first.url,
        sessionDir: dir,
        render: { frame: { chrome } },
        pacing: { startDelay: 100, endDelay: 100 },
      },
      async (cast) => {
        await cast.goto('/two');
        await cast.showUrl({ duration: 300 });
        await cast.cut(() => cast.goto(`${first.url}/`));
      },
    );
  const typed = (await run('browser')).session.events;
  const urls = typed.filter((event) => event.type === 'url');
  // The typed address, then the address of the page that opened.
  assert.deepEqual(
    urls.map((event) => [event.url, Boolean(event.typing), event.show]),
    [
      [`${first.url}/`, false, undefined],
      [`${first.url}/two`, true, undefined],
      [`${first.url}/two`, false, undefined],
      [`${first.url}/two`, false, 300],
      [`${first.url}/`, false, undefined],
    ],
  );
  const two = urls[1];
  assert.ok(two.typing! > 300, `typing ${two.typing}`);
  const cuts = typed.filter((event) => event.type === 'cut');
  assert.equal(cuts.length, 2);
  assert.ok(cuts[0].t >= two.t + two.typing!, 'the page opens after the typing');
  assert.ok(urls[2].t >= cuts[0].t && urls[2].t <= cuts[0].end);
  const plain = (await run('none')).session.events;
  assert.ok(plain.every((event) => event.type !== 'url' || (!event.typing && !event.show)));
  assert.equal(plain.filter((event) => event.type === 'cut').length, 2);
});
