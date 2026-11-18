import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { FrameRef, Size } from '../types.ts';
import { FRAMES_DIR, FrameWriter, type Capture } from './capture.ts';
import { sleep } from './timeline.ts';

/**
 * Chromium flags for frame-perfect capture: the page paints only on BeginFrame, and all
 * animation and scrolling runs on the main thread, on the page clock.
 */
export const FRAME_PERFECT_ARGS = [
  '--enable-begin-frame-control',
  '--run-all-compositor-stages-before-draw',
  '--disable-new-content-rendering-timeout',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--disable-checker-imaging',
  '--disable-image-animation-resync',
];

/**
 * Real-time waits of the pump, in milliseconds.
 */
const WAIT = {
  /**
   * For input sent just before a frame. Mouse input is acknowledged only after the frame.
   */
  inputSettle: 20,
  /**
   * For the acknowledgement of the previous frame's input, then a short gap, so that the
   * browser can forward follow-up events (a wheel gives a scroll gesture) before the frame.
   */
  ack: 100,
  ackGap: 5,
  /**
   * Before a stuck BeginFrame gets a small step of virtual time.
   */
  watchdog: 100,
  /**
   * For virtual time to advance at all.
   */
  advance: 30_000,
};

/**
 * Virtual time step, in ms, that releases a BeginFrame blocked by a renderer task that
 * waits on the frozen page clock (seen after wheel input).
 */
const KICK = 1;

const FREE_RUN_INTERVAL = 1000 / 60;

export interface PumpSettings {
  fps: number;
  /**
   * How far the page's wall clock starts ahead of the real clock, in ms.
   */
  clockLead: number;
  format: 'jpeg' | 'png';
  quality: number;
}

interface QueuedInput {
  send: (t: number) => unknown;
  resolve: (t: number) => void;
}

interface Waiter {
  frame: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Drives the page clock for frame-perfect capture. Before the recording, a free-running loop
 * sends frames in real time, so that the page loads and Playwright works. During the
 * recording, each step advances virtual time by one frame, sends the queued input, and
 * captures the frame. Record time is `frame * frameMs`.
 */
export class FramePump implements Capture {
  readonly frameMs: number;
  private readonly cdp: CDPSession;
  private readonly settings: PumpSettings;
  private readonly writer: FrameWriter;
  private frame = -1;
  private virtual = 0;
  private base = 0;
  private baseVirtual = 0;
  private running = false;
  private freeRunning = false;
  private loop: Promise<void> = Promise.resolve();
  private freeLoop: Promise<void> = Promise.resolve();
  private capturing = true;
  private lastImage?: string;
  private end = Infinity;
  private inputs: QueuedInput[] = [];
  private readonly unsettled = new Set<Promise<unknown>>();
  private waiters: Waiter[] = [];
  private error?: unknown;

  private constructor(cdp: CDPSession, dir: string, settings: PumpSettings) {
    this.cdp = cdp;
    this.settings = settings;
    this.frameMs = 1000 / settings.fps;
    this.writer = new FrameWriter(dir, settings.format);
  }

  static async create(
    context: BrowserContext,
    page: Page,
    dir: string,
    settings: PumpSettings,
  ): Promise<FramePump> {
    await mkdir(path.join(dir, FRAMES_DIR), { recursive: true });
    return new FramePump(await context.newCDPSession(page), dir, settings);
  }

  get frames(): FrameRef[] {
    return this.writer.frames;
  }

  get frameSize(): Size | undefined {
    return this.writer.frameSize;
  }

  /**
   * Record time in ms: the time of the last frame.
   */
  now(): number {
    return Math.max(0, this.frame) * this.frameMs;
  }

  /**
   * Sends frames in real time, without the page clock, until `start()`.
   */
  startFreeRun(): void {
    this.freeRunning = true;
    this.freeLoop = (async () => {
      while (this.freeRunning) {
        const started = performance.now();
        await this.cdp
          .send('HeadlessExperimental.beginFrame', { interval: this.frameMs })
          .catch(() => {});
        await sleep(FREE_RUN_INTERVAL - (performance.now() - started));
      }
    })();
  }

  /**
   * Pauses the page clock and starts the recording. Resolves once frame 0 is captured.
   */
  async start(): Promise<void> {
    this.freeRunning = false;
    await this.freeLoop;
    // Page time runs slower than real time: with a lead, server time stamps made during
    // the recording stay in the page's past.
    const { virtualTimeTicksBase } = await this.cdp.send('Emulation.setVirtualTimePolicy', {
      policy: 'pause',
      initialVirtualTime: (Date.now() + this.settings.clockLead) / 1000,
    });
    this.base = virtualTimeTicksBase;
    this.running = true;
    this.loop = this.run().catch((error: unknown) => this.fail(error));
    await this.waitFrame(0);
  }

  /**
   * Stops at record time `end`, after the frame in progress, and waits for the writes.
   * The page then gets no more frames.
   */
  async stop(end = Infinity): Promise<FrameRef[]> {
    this.end = end;
    this.running = false;
    this.freeRunning = false;
    await Promise.all([this.loop, this.freeLoop]);
    await this.writer.flush();
    return this.frames;
  }

  /**
   * Resolves once `ms` of page time has passed, rounded to whole frames.
   */
  wait(ms: number): Promise<void> {
    if (!(ms > 0)) {
      return this.error ? Promise.reject(this.error) : Promise.resolve();
    }
    return this.waitFrame(this.frame + Math.max(1, Math.round(ms / this.frameMs)));
  }

  /**
   * Sends input right before the next frame. `send` gets the record time of that frame.
   * Resolves with that time once the input is sent, without waiting for its acknowledgement.
   */
  input(send: (t: number) => unknown): Promise<number> {
    if (this.error) {
      return Promise.reject(this.error);
    }
    return new Promise((resolve) => this.inputs.push({ send, resolve }));
  }

  /**
   * Turns screenshots off (inside cut regions) or on. Without screenshots, page time runs
   * as fast as the page can render.
   */
  capture(on: boolean): void {
    this.capturing = on;
  }

  private waitFrame(frame: number): Promise<void> {
    if (this.error) {
      return Promise.reject(this.error);
    }
    if (this.frame >= frame) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.waiters.push({ frame, resolve, reject }));
  }

  private fail(error: unknown): void {
    this.error ??= error;
    this.running = false;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(this.error);
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      const frame = this.frame + 1;
      if (this.unsettled.size) {
        await Promise.race([Promise.all(this.unsettled), sleep(WAIT.ack)]);
        await sleep(WAIT.ackGap);
      }
      const budget = frame * this.frameMs - this.virtual;
      if (budget > 0.01) {
        await this.advance(budget);
      }
      this.frame = frame;
      const t = this.now();
      await this.sendInputs(t);
      const screenshot = this.capturing
        ? this.settings.format === 'png'
          ? { format: 'png' as const, optimizeForSpeed: true }
          : { format: 'jpeg' as const, quality: this.settings.quality, optimizeForSpeed: true }
        : undefined;
      const result = await this.beginFrame({
        frameTimeTicks: this.base + this.virtual - this.baseVirtual,
        interval: this.frameMs,
        ...(screenshot ? { screenshot } : {}),
      });
      // A screenshot always reports damage: equal bytes mean an unchanged frame, which the
      // renderer gets from the previous stored frame. No image (a new renderer starting after
      // a cross-site navigation) also keeps the previous frame.
      const image = result.screenshotData;
      if (image && image !== this.lastImage && t <= this.end) {
        this.lastImage = image;
        this.writer.add(Buffer.from(image, 'base64'), t);
      }
      this.waiters = this.waiters.filter((waiter) => {
        if (waiter.frame > this.frame) {
          return true;
        }
        waiter.resolve();
        return false;
      });
      // A failed input fails the Cast call that waits, but frames go on for error.png.
      if (this.error) {
        for (const waiter of this.waiters.splice(0)) {
          waiter.reject(this.error);
        }
      }
    }
  }

  private async sendInputs(t: number): Promise<void> {
    const inputs = this.inputs.splice(0);
    if (inputs.length === 0) {
      return;
    }
    const sent = inputs.map(({ send }) => {
      const dispatch: Promise<unknown> = Promise.resolve()
        .then(() => send(t))
        .catch((error: unknown) => {
          this.error ??= error;
        })
        .finally(() => this.unsettled.delete(dispatch));
      this.unsettled.add(dispatch);
      return dispatch;
    });
    await Promise.race([Promise.all(sent), sleep(WAIT.inputSettle)]);
    for (const input of inputs) {
      input.resolve(t);
    }
  }

  private async advance(budget: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<void>((resolve, reject) => {
      this.cdp.once('Emulation.virtualTimeBudgetExpired', () => resolve());
      timer = setTimeout(
        () => reject(new Error(`Page time did not advance within ${WAIT.advance} ms.`)),
        WAIT.advance,
      );
    });
    try {
      const { virtualTimeTicksBase } = await this.cdp.send('Emulation.setVirtualTimePolicy', {
        policy: 'advance',
        budget,
      });
      if (virtualTimeTicksBase !== this.base) {
        // A new renderer process (cross-site navigation) has its own clock.
        this.base = virtualTimeTicksBase;
        this.baseVirtual = this.virtual;
      }
      await expired;
    } finally {
      clearTimeout(timer);
    }
    this.virtual += budget;
  }

  private async beginFrame(params: {
    frameTimeTicks: number;
    interval: number;
    screenshot?: { format: 'jpeg' | 'png'; quality?: number; optimizeForSpeed: boolean };
  }): Promise<{ hasDamage: boolean; screenshotData?: string }> {
    const pending = this.cdp.send('HeadlessExperimental.beginFrame', params);
    let done = false;
    pending.then(
      () => (done = true),
      () => (done = true),
    );
    while (!done) {
      await Promise.race([pending, sleep(WAIT.watchdog)]);
      if (!done) {
        await this.advance(KICK);
      }
    }
    return pending;
  }
}
