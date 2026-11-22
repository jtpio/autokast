import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { imageSize, QUIET_MS } from '../../src/record/capture.ts';
import { record } from '../../src/record/index.ts';
import type { Session } from '../../src/types.ts';
import { serve, type TestServer } from './helpers.ts';

const PAGE = `<!doctype html><body style="margin:0;background:#fff">
<div id="box" style="width:300px;height:300px;background:rgb(255,0,0)"></div></body>`;

let server: TestServer;
let dir: string;

before(async () => {
  server = await serve({ '/': PAGE });
  dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-refresh-'));
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

async function colorAt(file: string): Promise<string> {
  const image = await loadImage(file);
  const canvas = createCanvas(1, 1);
  const context = canvas.getContext('2d');
  context.drawImage(image, 200, 200, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return r > 200 && g < 60
    ? 'red'
    : b > 200 && r < 60
      ? 'blue'
      : g > 200 && r < 60
        ? 'green'
        : 'other';
}

it('captures the final state once after each quiet period, after a cut and at the end', async () => {
  const marks: Record<string, number> = {};
  const paint = (color: string) =>
    (document.getElementById('box') as HTMLElement).style.setProperty('background', color);
  let session: Session;
  ({ session } = await record(
    { url: server.url, sessionDir: dir, pacing: { startDelay: 300, endDelay: 300 } },
    async (cast) => {
      cast.marker('blue');
      await cast.page.evaluate(paint, 'rgb(0,0,255)');
      await cast.wait(1500);
      await cast.cut(async () => {
        await cast.page.evaluate(paint, 'rgb(0,255,0)');
        await cast.wait(300);
      });
    },
  ));
  for (const event of session.events) {
    if (event.type === 'marker') {
      marks[event.label] = event.t;
    }
  }
  const frames = session.frames;
  for (const frame of frames) {
    const size = imageSize(await readFile(path.join(dir, frame.file)));
    assert.deepEqual(size, { width: 2560, height: 1440 }, frame.file);
  }

  const quiet = frames.filter((f) => f.t > marks.blue && f.t < marks.blue + 1500);
  const colors = await Promise.all(quiet.map((f) => colorAt(path.join(dir, f.file))));
  const times = quiet.map((f, i) => `${Math.round(f.t - marks.blue)} ms ${colors[i]}`).join(', ');
  assert.equal(colors.at(-1), 'blue', times);
  // The page paints the change in one frame or more, on a slow machine during more than
  // 150 ms. The forced capture is the first frame that comes a quiet time after the frame
  // before it: it can make the screencast send one more frame, and then no frame comes.
  const forced = quiet.findIndex((f, i) => i > 0 && f.t - quiet[i - 1].t >= QUIET_MS);
  assert.ok(forced > 0, `a frame after a quiet time: ${times}`);
  assert.ok(colors.slice(0, forced).includes('blue'), `the change is painted first: ${times}`);
  const refresh = quiet.slice(forced);
  assert.ok(refresh.length <= 2, `${refresh.length} frames after the quiet time: ${times}`);
  const wait = refresh[0].t - quiet[forced - 1].t;
  assert.ok(wait < QUIET_MS + 500, `the forced capture is not late: ${times}`);

  const [cut] = session.events.filter((event) => event.type === 'cut');
  const atEnd = frames.filter((f) => f.t >= cut.end - 1 && f.t <= cut.end + 100);
  assert.ok(atEnd.length >= 1, 'a frame at the end of the cut');
  assert.equal(await colorAt(path.join(dir, atEnd[0].file)), 'green');
  assert.ok(frames.at(-1)!.t > session.duration - 50, 'a frame at the end of the recording');
});
