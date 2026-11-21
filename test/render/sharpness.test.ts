import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas';
import { describeSession } from '../../src/inspect.ts';
import { computeLayout, restImageSize, useRestImage } from '../../src/render/compositor.ts';
import { render, renderFrame } from '../../src/render/index.ts';
import { buildScene, restFrameIndices } from '../../src/render/scene.ts';
import {
  captureEnlargement,
  captureScale,
  SHARP_LIMIT,
  sharpnessWarning,
} from '../../src/render/sharpness.ts';
import { RestFrames } from '../../src/render/source.ts';
import type { Session } from '../../src/types.ts';
import { createFixture } from './fixture.ts';

let dir: string;
let sessionDir: string;
let session: Session;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-sharpness-'));
  sessionDir = path.join(dir, 'session');
  session = await createFixture(sessionDir);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function pixels(image: Image | Canvas): Uint8ClampedArray {
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, image.width, image.height).data;
}

/**
 * Mean signed and mean absolute difference of the RGB channels.
 */
function difference(a: Uint8ClampedArray, b: Uint8ClampedArray): { mean: number; abs: number } {
  assert.equal(a.length, b.length);
  let mean = 0;
  let abs = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      mean += a[i + c] - b[i + c];
      abs += Math.abs(a[i + c] - b[i + c]);
    }
  }
  const n = (a.length / 4) * 3;
  return { mean: mean / n, abs: abs / n };
}

const VIEWPORT = { width: 1280, height: 720 };

test('the capture scale keeps the deepest zoom level sharp at the render size', () => {
  assert.equal(captureScale(VIEWPORT), 3);
  assert.equal(captureScale(VIEWPORT, { size: { width: 1280, height: 720 } }), 2);
  assert.equal(captureScale(VIEWPORT, { zoom: { levels: { close: 1.6 } } }), 2);
  assert.equal(captureScale(VIEWPORT, { zoom: { levels: { close: 1.6 }, auto: true } }), 3);
  // At most 3 and at least 2: a warning at render time covers deeper zooms.
  assert.equal(captureScale(VIEWPORT, { size: { width: 3840, height: 2160 } }), 3);
  assert.equal(captureScale(VIEWPORT, { size: { width: 640, height: 360 } }), 2);
});

test('a zoom that enlarges the captured page gives a warning with the scale to record at', () => {
  const enlargement = captureEnlargement(buildScene(session))!;
  assert.ok(enlargement.ratio > SHARP_LIMIT, `ratio ${enlargement.ratio}`);
  assert.ok(Math.abs(enlargement.zoom - 2.4) < 0.01, `zoom ${enlargement.zoom}`);
  const layout = computeLayout(buildScene(session).options, session.viewport);
  const scale = (enlargement.ratio * session.frameSize.width) / session.viewport.width;
  assert.ok(Math.abs(scale - layout.k * 2.4) < 0.01);
  assert.equal(enlargement.neededScale, Math.ceil(scale / SHARP_LIMIT));
  assert.match(
    sharpnessWarning(enlargement)!,
    /2\.40x zoom at \d+\.\ds .* Record with deviceScaleFactor: 3, or use a smaller zoom\./,
  );
  assert.match(describeSession(session), /Warning: Soft text/);

  const small = captureEnlargement(buildScene(session, { size: { width: 960, height: 540 } }));
  assert.equal(sharpnessWarning(small), undefined);
});

test('render returns the sharpness warning for the rendered range', async () => {
  const options = { output: path.join(dir, 'zoom.mp4'), fps: 10 };
  const zoomed = { start: 8000, end: 11000 };
  const small = await render(sessionDir, {
    ...options,
    size: { width: 640, height: 360 },
    range: zoomed,
  });
  assert.deepEqual(small.warnings, []);
  const before = await render(sessionDir, { ...options, range: { start: 0, end: 500 } });
  assert.deepEqual(before.warnings, []);
  const full = await render(sessionDir, { ...options, range: zoomed });
  assert.equal(full.warnings.length, 1);
  assert.match(full.warnings[0], /deviceScaleFactor: 3/);
});

test('the rest view draws the Lanczos reduction, aligned with the captured frame', async () => {
  const scene = buildScene(session);
  const indices = restFrameIndices(scene, 0, scene.times.length);
  assert.ok(indices.length > 0);
  assert.ok(indices.every((index, i) => i === 0 || index > indices[i - 1]));
  assert.ok(useRestImage(scene.layout, session.frameSize.width, scene.layout.k));
  // Deep in the 2.4x zoom the captured frame is enlarged: the rest image does not apply.
  assert.ok(!useRestImage(scene.layout, session.frameSize.width, scene.layout.k * 2.4));

  const lanczos = await loadImage(await renderFrame(sessionDir, 300));
  const missing = path.join(dir, 'no-such-ffmpeg');
  const bilinear = await loadImage(
    await renderFrame(sessionDir, 300, { encode: { ffmpegPath: missing } }),
  );
  const { mean, abs } = difference(pixels(lanczos), pixels(bilinear));
  // Different filters, same place: a shift of one pixel gives a much larger difference.
  assert.ok(abs > 0, 'the rest view uses the rest image');
  assert.ok(abs < 1.5, `mean absolute difference ${abs}`);
  assert.ok(Math.abs(mean) < 0.2, `mean difference ${mean}`);
});

test('rest frames come from ffmpeg in order, with the colors of the decoded frames', async () => {
  const scene = buildScene(session);
  const size = restImageSize(scene.layout, session.frameSize);
  assert.deepEqual(size, { width: scene.layout.content.width, height: 927 });
  const rest = new RestFrames(sessionDir, session.frames, [0, 2, 5], size, 'ffmpeg');
  try {
    assert.equal(await rest.get(1), null);
    const first = (await rest.get(0))!;
    assert.equal(first, await rest.get(0));
    assert.deepEqual([first.width, first.height], [size.width, size.height]);
    // Frame 2 is skipped: the next frame comes from the same process.
    const fifth = (await rest.get(5))!;
    assert.equal(await rest.get(2), null);

    const frame = await loadImage(path.join(sessionDir, session.frames[5].file));
    const reference = createCanvas(size.width, size.height);
    reference.getContext('2d').drawImage(frame, 0, 0, size.width, size.height);
    const { mean, abs } = difference(pixels(fifth), pixels(reference));
    assert.ok(abs < 1.5, `mean absolute difference ${abs}`);
    assert.ok(Math.abs(mean) < 0.2, `mean difference ${mean}`);
  } finally {
    rest.close();
  }

  const missing = new RestFrames(sessionDir, session.frames, [0], size, path.join(dir, 'none'));
  assert.equal(await missing.get(0), null);
});
