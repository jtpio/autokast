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
import { applyStage, stageAt } from '../../src/render/stage.ts';
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

test('the caption band has room for one line, and long text shows one line at a time', () => {
  const caption = (text: string) => ({ type: 'caption' as const, t: 100, duration: 9000, text });
  const scene = (text: string) => buildScene({ ...session, events: [caption(text)] });
  const long =
    'Give it a name. The camera stays on the cursor while you type, so nothing is missed.';
  const one = scene('Create a **new project**');
  const two = scene(long);
  assert.ok(Math.abs(one.band!.height - 0.125 * 1080) < 1e-9, `band ${one.band!.height}`);
  assert.equal(two.band!.height, one.band!.height);
  assert.equal(one.captions.length, 1);
  assert.equal(two.captions.length, 2);
  assert.equal(two.captions.map((cue) => cue.text).join(' '), long);
  assert.ok(two.captions[1].textIn > two.captions[0].textOut);
  assert.equal(buildScene({ ...session, events: [] }).band, null);
});

test('the browser frame adds a toolbar in the light or dark theme', async () => {
  const light = buildScene(session, { frame: { chrome: 'browser' } });
  const plain = buildScene(session);
  assert.equal(light.layout.bar, 52);
  assert.ok(light.layout.content.height < plain.layout.content.height);
  assert.equal(light.layout.window.height, light.layout.content.height + 52);
  const bar = async (chromeTheme: 'light' | 'dark') => {
    const png = await renderFrame(path.join(dir, 'session'), 0, {
      frame: { chrome: 'browser', chromeTheme },
    });
    const image = await loadImage(png);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { window } = light.layout;
    const [r, g, b] = context.getImageData(window.x + window.width - 40, window.y + 26, 1, 1).data;
    return luminance({ r, g, b, a: 1 });
  };
  assert.ok((await bar('light')) > 0.8);
  assert.ok((await bar('dark')) < 0.1);
});

test('a caption is in the middle of the band, also with the browser frame', async () => {
  for (const chrome of ['none', 'browser'] as const) {
    const options = { frame: { chrome } };
    const scene = buildScene(session, options);
    const band = scene.band!;
    const image = await loadImage(await renderFrame(path.join(dir, 'session'), 1800, options));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    // Light pixels of the text in one row, over the first part of the caption.
    const light = (y: number) => {
      const row = context.getImageData(band.window.x, y, 420, 1).data;
      let count = 0;
      for (let i = 0; i < row.length; i += 4)
        if (Math.min(row[i], row[i + 1], row[i + 2]) > 200) count++;
      return count;
    };
    const bottom = band.window.y + band.window.height;
    assert.ok(light(Math.round(band.center)) > 15, `${chrome}: text in the middle of the band`);
    assert.equal(light(Math.round(bottom + 14)), 0, `${chrome}: no text at the window edge`);
  }
});

test('the larger address field follows the frame and stays clear of the buttons', async () => {
  const typed = path.join(dir, 'typed');
  await mkdir(typed, { recursive: true });
  await symlink(path.join(dir, 'session', 'frames'), path.join(typed, 'frames'));
  const events = [
    ...session.events,
    {
      type: 'url' as const,
      t: 400,
      url: 'http://localhost:8000/notebooks/index.html',
      typing: 600,
    },
  ];
  await writeFile(path.join(typed, 'session.json'), JSON.stringify({ ...session, events }));
  const options = { frame: { chrome: 'browser' as const } };
  const scene = buildScene({ ...session, events }, options);
  // At 1200 ms the caption band is open: the window is smaller than at rest.
  const i = scene.times.findIndex((t) => t >= 1200);
  const stage = stageAt(scene.band, scene.bandOpen[i]);
  assert.ok(stage.scale < 0.97, `stage scale ${stage.scale}`);
  const image = await loadImage(await renderFrame(typed, scene.times[i], options));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const { window, bar } = scene.layout;
  const at = (x: number) => {
    const point = applyStage(stage, {
      x: window.x + x,
      y: window.y + bar / 2,
      width: 0,
      height: 0,
    });
    return [...context.getImageData(point.x, point.y, 1, 1).data.slice(0, 3)];
  };
  assert.deepEqual(at(window.width / 2 + 300), [255, 255, 255], 'the field is in the middle');
  assert.ok(at(165)[0] < 250, 'the bar shows next to the reload button');
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
