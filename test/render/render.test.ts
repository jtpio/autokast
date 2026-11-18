import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { luminance, parseColor } from '../../src/render/color.ts';
import { adaptiveClickColor } from '../../src/render/effects.ts';
import { buildScene } from '../../src/render/scene.ts';
import type { Session } from '../../src/types.ts';
import { createFixture } from './fixture.ts';

let dir: string;
let session: Session;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-render-'));
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

async function cornerLuminance(png: Buffer): Promise<number[]> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return [
    [1, 1],
    [image.width - 2, 1],
    [1, image.height - 2],
  ].map(([x, y]) => {
    const d = ctx.getImageData(x, y, 1, 1).data;
    return luminance({ r: d[0], g: d[1], b: d[2], a: 1 });
  });
}

test("zoom edges 'fill' covers the output with the page, 'keep' shows the backdrop", async () => {
  const corner = path.join(dir, 'corner');
  await mkdir(corner, { recursive: true });
  const base = JSON.parse(await readFile(path.join(dir, 'session', 'session.json'), 'utf8'));
  const events = base.events.filter((e: { type: string }) =>
    ['cursorStyle', 'mouseDown', 'mouseUp'].includes(e.type),
  );
  events.push({ type: 'zoom', t: 100, focus: { x: 0, y: 0, width: 40, height: 30 }, scale: 2 });
  await writeFile(path.join(corner, 'session.json'), JSON.stringify({ ...base, events }));
  await symlink(path.join(dir, 'session', 'frames'), path.join(corner, 'frames'));
  const options = { size: { width: 480, height: 270 }, cursor: { visible: false } };
  const fill = await cornerLuminance(await renderFrame(corner, 1200, options));
  assert.ok(fill[0] > 0.8, `top-left ${fill[0]}`);
  const keep = await cornerLuminance(
    await renderFrame(corner, 1200, { ...options, zoom: { edges: 'keep' } }),
  );
  assert.ok(keep[0] < 0.3, `top-left ${keep[0]}`);
  const rest = await cornerLuminance(await renderFrame(corner, 0, options));
  assert.ok(
    rest.every((l) => l < 0.3),
    'backdrop at rest',
  );
});

test('the click color has the most contrast against the page under the click', () => {
  const lum = (hex: string) => luminance(parseColor(hex)!);
  assert.equal(adaptiveClickColor(lum('#ffffff')).r, 16);
  assert.equal(adaptiveClickColor(lum('#f3f4f6')).r, 16);
  assert.equal(adaptiveClickColor(lum('#1d1d1f')).r, 255);
  assert.equal(adaptiveClickColor(lum('#2563eb')).r, 255);
});

test('a fit zoom fills the whole output in camera mode and the frame box in crop mode', () => {
  const zoom = {
    type: 'zoom' as const,
    t: 100,
    focus: { x: 400, y: 225, width: 480, height: 270 },
    padding: 0,
  };
  const fit = { ...session, events: [zoom] };
  const settled = (scene: ReturnType<typeof buildScene>) => scene.camera.scale.length - 1;
  const camera = buildScene(fit, { zoom: { maxScale: 4 } });
  const s = camera.camera.scale[settled(camera)];
  const visible = 1920 / (camera.layout.k * s);
  assert.ok(Math.abs(visible - 480) < 2, `visible page width ${visible}`);
  assert.ok(Math.abs(1080 / (camera.layout.k * s) - 270) < 2);
  assert.equal(buildScene(fit).camera.scale[settled(camera)], 3);
  const crop = buildScene(fit, { zoom: { mode: 'crop', maxScale: 4 } });
  assert.ok(Math.abs(crop.camera.scale[settled(crop)] - 1280 / 480) < 1e-9);
  const explicit = buildScene({ ...session, events: [{ ...zoom, scale: 2 }] });
  assert.equal(explicit.camera.scale[settled(explicit)], 2);
});

test('zoom levels merge over the defaults and resolve at render time', () => {
  const level = (name: string, levels?: Record<string, number>) => {
    const scene = buildScene(
      {
        ...session,
        events: [
          { type: 'zoom', t: 100, focus: { x: 600, y: 340, width: 80, height: 40 }, level: name },
        ],
      },
      { zoom: { levels, follow: 'off' } },
    );
    return scene.camera.scale[scene.camera.scale.length - 1];
  };
  assert.equal(level('medium'), 1.6);
  assert.equal(level('close', { close: 2.5 }), 2.5);
  assert.equal(level('medium', { close: 2.5 }), 1.6);
  assert.equal(level('hero', { hero: 1.9 }), 1.9);
  assert.throws(
    () => level('nope'),
    /Unknown zoom level "nope". Known levels: wide, medium, close/,
  );
});
