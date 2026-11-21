import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { outputDuration, renderFrame, toOutputTime } from './render/index.ts';
import { buildScene } from './render/scene.ts';
import { sharpnessWarning } from './render/sharpness.ts';
import { loadSession } from './session.ts';
import type { RenderOptions, Session } from './types.ts';

const exec = promisify(execFile);
const MAX_TILES = 64;

export interface ContactSheetOptions {
  out: string;
  /**
   * Time between tiles in milliseconds. Default: fits 16 tiles.
   */
  every?: number;
  from?: number;
  to?: number;
  columns?: number;
  tileWidth?: number;
  render?: RenderOptions;
}

export interface ContactSheetResult {
  out: string;
  tiles: number;
  every: number;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Returns a text summary of a session: sizes, capture rate and the timeline in output time.
 */
export function describeSession(session: Session, options?: RenderOptions): string {
  const { viewport, frames, duration } = session;
  const output = outputDuration(session);
  const fps = duration > 0 ? (frames.length / duration) * 1000 : 0;
  const lines = [
    `Session "${session.name}": ${seconds(duration)} recorded, ${seconds(output)} output`,
    `Viewport ${viewport.width}x${viewport.height} @${session.deviceScaleFactor}x, ${frames.length} frames (${fps.toFixed(0)} per second; a frame that does not change is stored once)`,
  ];
  const warning = sharpnessWarning(buildScene(session, options));
  if (warning) lines.push(`Warning: ${warning}`);
  lines.push('Timeline (output time):');
  const at = (t: number) => seconds(toOutputTime(session, t)).padStart(7);
  for (const event of session.events) {
    if (event.type === 'action' && !/^(cut|speed)\(/.test(event.call)) {
      const length = toOutputTime(session, event.end) - toOutputTime(session, event.t);
      lines.push(`  ${at(event.t)}  ${event.call}  (${seconds(length)})`);
    } else if (event.type === 'cut') {
      lines.push(`  ${at(event.t)}  cut ${seconds(event.end - event.t)}`);
    } else if (event.type === 'speed') {
      const length = seconds(event.end - event.t);
      lines.push(`  ${at(event.t)}  speed x${event.rate} for ${length} of record time`);
    } else if (event.type === 'url' && !event.typing && !event.show) {
      lines.push(`  ${at(event.t)}  address ${event.url}`);
    }
  }
  if (options?.range) {
    lines.push(
      `Range: ${seconds(options.range.start ?? 0)} to ${seconds(options.range.end ?? output)}`,
    );
  }
  return lines.join('\n');
}

async function videoDuration(file: string): Promise<number> {
  const { stdout } = await exec('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file,
  ]);
  return Number(stdout.trim()) * 1000;
}

async function videoFrame(file: string, time: number, width: number): Promise<Buffer> {
  const { stdout } = await exec(
    'ffmpeg',
    [
      '-v',
      'error',
      '-ss',
      (time / 1000).toFixed(3),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `scale=${width}:-2`,
      '-f',
      'image2pipe',
      '-c:v',
      'png',
      '-',
    ],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}

/**
 * Writes a grid of stills with time labels, from a session directory or a video file.
 */
export async function contactSheet(
  source: string,
  options: ContactSheetOptions,
): Promise<ContactSheetResult> {
  const isVideo = /\.(mp4|webm|gif|mov|mkv)$/i.test(source);
  const tileWidth = options.tileWidth ?? 480;
  const columns = options.columns ?? 4;
  let duration: number;
  let grab: (time: number) => Promise<Buffer>;
  if (isVideo) {
    duration = await videoDuration(source);
    grab = (time) => videoFrame(source, time, tileWidth);
  } else {
    const session = await loadSession(source);
    duration = outputDuration(session);
    const size = options.render?.size ?? session.render?.size ?? { width: 1920, height: 1080 };
    const tileSize = {
      width: tileWidth,
      height: Math.round((tileWidth * size.height) / size.width / 2) * 2,
    };
    grab = (time) => renderFrame(source, time, { ...options.render, size: tileSize });
  }

  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(duration, options.to ?? duration);
  const every = options.every ?? Math.max(500, Math.ceil((to - from) / 16 / 500) * 500);
  const times: number[] = [];
  for (let time = from; time < to && times.length < MAX_TILES; time += every) {
    times.push(time);
  }
  if (times.length === 0) {
    throw new Error(`Nothing to show between ${seconds(from)} and ${seconds(to)}.`);
  }

  const images = [];
  for (const time of times) {
    images.push(await loadImage(await grab(time)));
  }
  const tileHeight = Math.round((tileWidth * images[0].height) / images[0].width);
  const gap = 8;
  const label = 24;
  const rows = Math.ceil(images.length / columns);
  const canvas = createCanvas(
    columns * tileWidth + (columns + 1) * gap,
    rows * (tileHeight + label) + (rows + 1) * gap,
  );
  const context = canvas.getContext('2d');
  context.fillStyle = '#111';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '600 15px Inter, sans-serif';
  context.textBaseline = 'middle';
  context.fillStyle = '#fff';
  images.forEach((image, index) => {
    const x = gap + (index % columns) * (tileWidth + gap);
    const y = gap + Math.floor(index / columns) * (tileHeight + label + gap);
    context.fillText(seconds(times[index]), x + 2, y + label / 2);
    context.drawImage(image, x, y + label, tileWidth, tileHeight);
  });

  await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await writeFile(options.out, canvas.toBuffer('image/png'));
  return { out: options.out, tiles: images.length, every };
}
