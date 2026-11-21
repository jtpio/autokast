import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createCanvas, loadImage, type Canvas, type Image } from '@napi-rs/canvas';
import type { FrameRef, Size } from '../types.ts';

/**
 * Decodes captured frames on demand. Decoding a 2560x1440 JPEG takes about 20 ms, so
 * frames are decoded once, kept while in use, and decoded ahead in parallel.
 */
export class FrameSource {
  private readonly dir: string;
  private readonly frames: FrameRef[];
  private readonly cache = new Map<number, Promise<Image>>();

  constructor(dir: string, frames: FrameRef[]) {
    this.dir = dir;
    this.frames = frames;
  }

  get(index: number): Promise<Image | null> {
    if (index < 0 || index >= this.frames.length) return Promise.resolve(null);
    let image = this.cache.get(index);
    if (!image) {
      const file = path.resolve(this.dir, this.frames[index].file);
      image = readFile(file)
        .then((data) => loadImage(data))
        .catch((error: unknown) => {
          throw new Error(`Cannot read frame "${file}": ${(error as Error).message}`);
        });
      image.catch(() => {});
      this.cache.set(index, image);
    }
    return image;
  }

  /**
   * Keeps `current` and starts decoding `upcoming`; drops every other frame.
   */
  retain(current: number, upcoming: number[]): void {
    const keep = new Set([current, ...upcoming]);
    for (const key of this.cache.keys()) if (!keep.has(key)) this.cache.delete(key);
    for (const index of upcoming) void this.get(index);
  }
}

/**
 * The next `count` distinct source frames after output frame `from`.
 */
export function upcomingFrames(frameIndex: Int32Array, from: number, count: number): number[] {
  const result: number[] = [];
  let last = frameIndex[from];
  for (let i = from + 1; i < frameIndex.length && result.length < count; i++) {
    if (frameIndex[i] !== last) {
      last = frameIndex[i];
      result.push(last);
    }
  }
  return result;
}

/**
 * Reduced frames decoded ahead of the render loop. Each one is 4 bytes per pixel.
 */
const REST_AHEAD = 3;

/**
 * Lanczos with exact chroma handling: the colors match the frames that the canvas decodes.
 */
const REST_SCALER = 'lanczos+accurate_rnd+full_chroma_int+full_chroma_inp';

/**
 * Captured frames reduced to the rest image size by one ffmpeg process, with a Lanczos
 * filter. Only the frames in `indices` are reduced, and `get` must ask for them in
 * increasing order, as the render loop does.
 */
export class RestFrames {
  private readonly size: Size;
  private readonly order: number[];
  private readonly child: ChildProcess | null = null;
  private readonly reader: AsyncIterator<Buffer> | null = null;
  private readonly ahead: Promise<IteratorResult<Buffer>>[] = [];
  private position = 0;
  private current?: { index: number; canvas: Promise<Canvas> };
  private stderr = '';

  constructor(dir: string, frames: FrameRef[], indices: number[], size: Size, binary: string) {
    this.size = size;
    this.order = indices;
    if (indices.length === 0) return;
    const png = frames[indices[0]].file.endsWith('.png');
    const filter = `scale=${size.width}:${size.height}:flags=${REST_SCALER},format=rgba`;
    // prettier-ignore
    const args = [
      '-hide_banner', '-loglevel', 'error', '-f', png ? 'png_pipe' : 'jpeg_pipe', '-i', 'pipe:0',
      '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1',
    ];
    const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.on('error', (error) => {
      this.stderr ||= `Cannot run ffmpeg ("${binary}"): ${error.message}`;
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    child.stdin!.on('error', () => {});
    const files = indices.map((index) => path.resolve(dir, frames[index].file));
    Readable.from(
      (async function* () {
        for (const file of files) yield await readFile(file);
      })(),
    )
      .on('error', (error) => {
        this.stderr ||= error.message;
        child.stdin!.destroy();
      })
      .pipe(child.stdin!);
    this.reader = chunks(child.stdout!, size.width * size.height * 4)[Symbol.asyncIterator]();
  }

  /**
   * The reduced frame `index`, or null when it is not one of `indices`.
   */
  get(index: number): Promise<Canvas | null> {
    if (this.current?.index === index) return this.current.canvas;
    const position = this.order.indexOf(index, this.position);
    if (position < 0 || !this.reader) return Promise.resolve(null);
    const skip = position - this.position;
    this.position = position + 1;
    const canvas = this.take(skip);
    canvas.catch(() => {});
    this.current = { index, canvas };
    return canvas;
  }

  /**
   * Stops ffmpeg, also before every frame is read.
   */
  close(): void {
    this.child?.stdin?.destroy();
    this.child?.kill('SIGKILL');
  }

  private async take(skip: number): Promise<Canvas> {
    for (let i = 0; i < skip; i++) await this.next();
    const result = await this.next();
    if (result.done) {
      throw new Error(`ffmpeg could not reduce a frame:\n${this.stderr.trim() || '(no output)'}`);
    }
    const { width, height } = this.size;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    const data = ctx.createImageData(width, height);
    data.data.set(result.value);
    ctx.putImageData(data, 0, 0);
    return canvas;
  }

  private next(): Promise<IteratorResult<Buffer>> {
    while (this.ahead.length <= REST_AHEAD) this.ahead.push(this.reader!.next());
    return this.ahead.shift()!;
  }
}

/**
 * Splits a stream into buffers of `size` bytes.
 */
async function* chunks(stream: NodeJS.ReadableStream, size: number): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    parts.push(chunk);
    length += chunk.length;
    while (length >= size) {
      const all = Buffer.concat(parts, length);
      yield all.subarray(0, size);
      parts = length > size ? [all.subarray(size)] : [];
      length -= size;
    }
  }
}
