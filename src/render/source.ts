import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadImage, type Image } from '@napi-rs/canvas';
import type { FrameRef } from '../types.ts';

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
