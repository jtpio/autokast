import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  BACKGROUND_PRESETS,
  outputDuration,
  render,
  renderFrame,
  toOutputTime,
} from '../../src/render/index.ts';
import { buildScene } from '../../src/render/scene.ts';
import type { Session } from '../../src/types.ts';
import { createFixture } from './fixture.ts';

let dir: string;
let session: Session;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-render-'));
  session = await createFixture(path.join(dir, 'session'), { deviceScaleFactor: 1 });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function pngSize(png: Buffer): [number, number] {
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

function probe(file: string): Record<string, string | number> {
  const json = execFileSync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-count_frames',
    '-show_entries',
    'stream=codec_name,pix_fmt,color_space,color_primaries,color_transfer,width,height,nb_read_frames',
    '-of',
    'json',
    file,
  ]).toString();
  return JSON.parse(json).streams[0];
}

test('output time helpers follow cuts and speed ranges', () => {
  assert.equal(outputDuration(session), 13800 - 800 - 800);
  assert.equal(toOutputTime(session, 3800), 3700);
  assert.equal(toOutputTime(session, 8600), 8600 - 800 - 800);
  assert.ok(BACKGROUND_PRESETS.length >= 8);
});

test('renderFrame returns a PNG of the requested size, for any aspect ratio', async () => {
  const sessionDir = path.join(dir, 'session');
  assert.deepEqual(pngSize(await renderFrame(sessionDir, 1000)), [1920, 1080]);
  for (const size of [
    { width: 640, height: 360 },
    { width: 360, height: 640 },
    { width: 400, height: 400 },
  ]) {
    const png = await renderFrame(sessionDir, 1250, { size, background: 'ink' });
    assert.deepEqual(pngSize(png), [size.width, size.height]);
  }
});

test('render writes an H.264 mp4 with BT.709 tags and the requested frames', async () => {
  const output = path.join(dir, 'out.mp4');
  let progress = 0;
  const result = await render(path.join(dir, 'session'), {
    output,
    size: { width: 640, height: 360 },
    fps: 30,
    range: { start: 500, end: 1500 },
    encode: { quality: 'draft' },
    onProgress: (done) => (progress = done),
  });
  assert.deepEqual(result, {
    output,
    duration: 1000,
    frames: 30,
    size: { width: 640, height: 360 },
    fps: 30,
  });
  assert.equal(progress, 30);
  const s = probe(output);
  assert.equal(s.codec_name, 'h264');
  assert.equal(s.pix_fmt, 'yuv420p');
  assert.equal(s.color_space, 'bt709');
  assert.equal(s.color_primaries, 'bt709');
  assert.equal(s.color_transfer, 'bt709');
  assert.equal(Number(s.nb_read_frames), 30);
});

test('render writes webm and gif', async () => {
  const options = {
    size: { width: 320, height: 180 },
    fps: 24,
    range: { end: 500 },
    encode: { quality: 'draft' as const },
  };
  const webm = path.join(dir, 'out.webm');
  await render(path.join(dir, 'session'), { ...options, output: webm });
  assert.equal(probe(webm).codec_name, 'vp9');
  const gif = path.join(dir, 'out.gif');
  const result = await render(path.join(dir, 'session'), { ...options, output: gif });
  assert.equal(probe(gif).codec_name, 'gif');
  assert.equal(result.fps, 24);
});

test('a missing ffmpeg gives a clear error', async () => {
  await assert.rejects(
    render(path.join(dir, 'session'), {
      output: path.join(dir, 'never.mp4'),
      encode: { ffmpegPath: path.join(dir, 'no-such-ffmpeg') },
    }),
    /ffmpeg not found/,
  );
});

test('auto zoom generates zooms from clicks when the script gives none', () => {
  const plain = { ...session, events: session.events.filter((e) => e.type !== 'zoom') };
  const off = buildScene(plain, { fps: 30 });
  assert.ok(off.camera.scale.every((s) => s === 1));
  const on = buildScene(plain, { fps: 30, zoom: { auto: true } });
  const max = Math.max(...on.camera.scale);
  assert.ok(Math.abs(max - 1.8) < 1e-6, `max scale ${max}`);
  assert.ok(on.camera.scale[on.camera.scale.length - 1] < 1.001);
});

test('session render options sit between the defaults and the call options', () => {
  const withDefaults = { ...session, render: { fps: 24, frame: { radius: 4, padding: 0.1 } } };
  const scene = buildScene(withDefaults, { frame: { radius: 30 } });
  assert.equal(scene.options.fps, 24);
  assert.equal(scene.options.frame.radius, 30);
  assert.equal(scene.options.frame.padding, 0.1);
  assert.equal(scene.options.frame.shadow && scene.options.frame.shadow.blur, 72);
  assert.deepEqual(buildScene(session, { background: '#123456' }).options.background, {
    type: 'solid',
    color: '#123456',
  });
});
