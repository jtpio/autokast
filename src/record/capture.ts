import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { FrameRef, Size } from '../types.ts';

export const FRAMES_DIR = 'frames';

/**
 * Screencast settings. `maxWidth` and `maxHeight` are in device pixels.
 */
export interface CaptureSettings {
  format: 'jpeg' | 'png';
  quality: number;
  maxWidth: number;
  maxHeight: number;
}

type ScreencastFrame = {
  data: string;
  sessionId: number;
  metadata: { timestamp?: number };
};

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Reads the pixel size from the header of a JPEG or PNG image.
 */
export function imageSize(data: Uint8Array): Size | undefined {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[0] === 0x89 && data[1] === 0x50 && data.length >= 24) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (data[0] !== 0xff || data[1] !== 0xd8) {
    return undefined;
  }
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) {
      return undefined;
    }
    const marker = data[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (SOF_MARKERS.has(marker)) {
      return { width: view.getUint16(i + 7), height: view.getUint16(i + 5) };
    }
    i += 2 + view.getUint16(i + 2);
  }
  return undefined;
}

/**
 * Captures screencast frames over CDP and writes them to `<dir>/frames/` as they arrive.
 * Frame times use the record clock whose epoch origin is given to `start()`.
 */
export class FrameCapture {
  readonly frames: FrameRef[] = [];
  frameSize?: Size;
  private readonly cdp: CDPSession;
  private readonly dir: string;
  private readonly writes = new Set<Promise<void>>();
  private extension = 'jpg';
  private origin = 0;
  private end = Infinity;
  private reachedEnd?: () => void;
  private stopped = false;
  private writeError?: unknown;

  private constructor(cdp: CDPSession, dir: string) {
    this.cdp = cdp;
    this.dir = dir;
  }

  static async create(context: BrowserContext, page: Page, dir: string): Promise<FrameCapture> {
    await mkdir(path.join(dir, FRAMES_DIR), { recursive: true });
    return new FrameCapture(await context.newCDPSession(page), dir);
  }

  /**
   * Starts the screencast. `origin` is the epoch time (ms) of record time 0.
   */
  async start(origin: number, settings: CaptureSettings): Promise<void> {
    this.origin = origin;
    this.extension = settings.format === 'png' ? 'png' : 'jpg';
    this.cdp.on('Page.screencastFrame', this.onFrame);
    await this.cdp.send('Page.startScreencast', {
      format: settings.format,
      quality: settings.quality,
      everyNthFrame: 1,
      maxWidth: settings.maxWidth,
      maxHeight: settings.maxHeight,
    });
  }

  /**
   * Stops the screencast at record time `end` and waits until every frame is on disk.
   * Frames arrive some time after they are made, more so on a loaded machine: it waits up
   * to `grace` ms for a frame made after `end`, which proves that no earlier frame is late.
   */
  async stop(end = Infinity, grace = 300): Promise<FrameRef[]> {
    this.end = end;
    if (Number.isFinite(end)) {
      await new Promise<void>((resolve) => {
        this.reachedEnd = resolve;
        setTimeout(resolve, grace);
      });
    }
    this.stopped = true;
    this.cdp.off('Page.screencastFrame', this.onFrame);
    await this.cdp.send('Page.stopScreencast').catch(() => {});
    await this.cdp.detach().catch(() => {});
    await Promise.all(this.writes);
    if (this.writeError) {
      throw new Error(`Could not write a frame to "${this.dir}": ${String(this.writeError)}`, {
        cause: this.writeError,
      });
    }
    return this.frames;
  }

  /**
   * Writes an image as the frame at record time `t`. Used when the screencast gave no frame.
   */
  async addFrame(data: Buffer, t: number): Promise<void> {
    this.save(data, t);
    await Promise.all(this.writes);
  }

  private onFrame = (frame: ScreencastFrame): void => {
    this.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (this.stopped) {
      return;
    }
    const stamp = frame.metadata.timestamp;
    const epoch = stamp === undefined ? performance.timeOrigin + performance.now() : stamp * 1000;
    const t = Math.max(0, epoch - this.origin);
    if (t > this.end && this.frames.length > 0) {
      this.reachedEnd?.();
      return;
    }
    this.save(Buffer.from(frame.data, 'base64'), t);
  };

  private save(data: Buffer, t: number): void {
    if (this.frames.length === 0) {
      t = 0;
      this.frameSize = imageSize(data);
    }
    const file = `${FRAMES_DIR}/${String(this.frames.length + 1).padStart(6, '0')}.${this.extension}`;
    this.frames.push({ t, file });
    const write = writeFile(path.join(this.dir, file), data)
      .catch((error: unknown) => {
        this.writeError ??= error;
      })
      .finally(() => this.writes.delete(write));
    this.writes.add(write);
  }
}
