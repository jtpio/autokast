import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { outputDuration, renderFrame, toOutputTime } from './render/index.ts';
import { loadSession } from './session.ts';
import type { RenderOptions, Session, TimelineEvent } from './types.ts';

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

function isCut(session: Session, t: number): boolean {
  return session.events.some((event) => event.type === 'cut' && t >= event.t && t < event.end);
}

function describeEvent(event: TimelineEvent): string | undefined {
  switch (event.type) {
    case 'mouseDown':
      return `${event.button === 'left' ? 'click' : `${event.button} click`} at (${Math.round(event.x)}, ${Math.round(event.y)})`;
    case 'zoom': {
      if (!event.focus) {
        return 'zoom out';
      }
      const { x, y, width, height } = event.focus;
      const scale = event.scale ? ` scale ${event.scale}` : '';
      return `zoom to (${Math.round(x)}, ${Math.round(y)}, ${Math.round(width)}x${Math.round(height)})${scale}`;
    }
    case 'cut':
      return `cut ${seconds(event.end - event.t)}`;
    case 'speed':
      return `speed x${event.rate} for ${seconds(event.end - event.t)} of record time`;
    case 'caption':
      return `caption "${event.text}" for ${seconds(event.duration)}`;
    case 'spotlight':
      return `spotlight for ${seconds(event.duration)}`;
    case 'marker':
      return `marker "${event.label}"`;
    case 'key':
      return event.kind === 'shortcut' ? `press ${event.key}` : undefined;
    default:
      return undefined;
  }
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
    `Viewport ${viewport.width}x${viewport.height} @${session.deviceScaleFactor}x, ${frames.length} frames (${fps.toFixed(0)} fps average)`,
    'Timeline (output time):',
  ];
  let typed = '';
  let typedAt = 0;
  const flush = () => {
    if (typed) {
      lines.push(`  ${seconds(typedAt).padStart(7)}  type ${JSON.stringify(typed)}`);
      typed = '';
    }
  };
  for (const event of session.events) {
    if (event.type !== 'cut' && isCut(session, event.t)) {
      continue;
    }
    if (event.type === 'key' && event.kind === 'text') {
      if (!typed) {
        typedAt = toOutputTime(session, event.t);
      }
      typed += event.key.length === 1 ? event.key : event.key === 'Enter' ? '\n' : '';
      continue;
    }
    const text = describeEvent(event);
    if (text) {
      flush();
      lines.push(`  ${seconds(toOutputTime(session, event.t)).padStart(7)}  ${text}`);
    }
  }
  flush();
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
  const rows = Math.ceil(images.length / columns);
  const canvas = createCanvas(
    columns * tileWidth + (columns + 1) * gap,
    rows * tileHeight + (rows + 1) * gap,
  );
  const context = canvas.getContext('2d');
  context.fillStyle = '#111';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = '600 15px Inter, sans-serif';
  context.textBaseline = 'middle';
  images.forEach((image, index) => {
    const x = gap + (index % columns) * (tileWidth + gap);
    const y = gap + Math.floor(index / columns) * (tileHeight + gap);
    context.drawImage(image, x, y, tileWidth, tileHeight);
    const label = seconds(times[index]);
    const width = context.measureText(label).width + 12;
    context.fillStyle = 'rgba(0, 0, 0, 0.75)';
    context.fillRect(x, y, width, 22);
    context.fillStyle = '#fff';
    context.fillText(label, x + 6, y + 11);
  });

  await mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
  await writeFile(options.out, canvas.toBuffer('image/png'));
  return { out: options.out, tiles: images.length, every };
}
