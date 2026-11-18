import type { FramePump } from './frame-pump.ts';
import { sleep, type Clock } from './timeline.ts';

/**
 * Sends one input to the page.
 */
export type Send = () => Promise<unknown>;

/**
 * Record time, waits and input for the Cast calls. Realtime uses the wall clock;
 * frame-perfect uses page time, which the frame pump advances one frame at a time.
 */
export interface Pace {
  /**
   * Multiplier for the default Cast timeout: Playwright waits in real time.
   */
  readonly timeoutScale: number;
  /**
   * Record time in milliseconds.
   */
  now(): number;
  /**
   * Waits for `ms` of record time.
   */
  sleep(ms: number): Promise<void>;
  /**
   * Sends one input. Resolves with the record time at which it reaches the page.
   */
  input(send: Send): Promise<number>;
  /**
   * Calls `step` with the progress (0 to 1) and the record time until the progress is 1:
   * about every `tick` ms in realtime, once per frame in frame-perfect mode. `step` returns
   * the input for that moment, with values that it computes when the input is sent.
   */
  animate(
    duration: number,
    tick: number,
    step: (progress: number, t: number) => Send | undefined,
  ): Promise<void>;
  /**
   * Turns frame capture on or off: off inside cut regions. Resolves when the next frame
   * is captured, so that the end of a cut has its frame.
   */
  capture(on: boolean): Promise<void>;
}

/**
 * Sends input one dispatch at a time and skips new ones while one is in flight.
 * Chromium acknowledges mouse input only at its next frame, so waiting for each dispatch
 * would tie the motion to the frame rate of the page.
 */
class LatestDispatch {
  /**
   * The last dispatch that started.
   */
  last?: Send;
  private busy = false;
  private pending: Promise<unknown> = Promise.resolve();

  offer(send: Send): void {
    if (this.busy) {
      return;
    }
    this.busy = true;
    this.last = send;
    this.pending = send();
    // After a failure `busy` stays true: no more dispatches, and settle() throws.
    this.pending.then(
      () => {
        this.busy = false;
      },
      () => {},
    );
  }

  /**
   * Waits for the dispatch in flight. Throws its error if it failed.
   */
  async settle(): Promise<void> {
    await this.pending;
  }
}

/**
 * Wall-clock pace: record time is real time since the capture started.
 */
export class RealtimePace implements Pace {
  readonly timeoutScale = 1;
  private readonly clock: Clock;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  now(): number {
    return this.clock.now();
  }

  sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  async input(send: Send): Promise<number> {
    const t = this.now();
    await send();
    return t;
  }

  async animate(
    duration: number,
    tick: number,
    step: (progress: number, t: number) => Send | undefined,
  ): Promise<void> {
    const dispatch = new LatestDispatch();
    let last: Send | undefined;
    const start = this.now();
    let next = start;
    for (;;) {
      const now = this.now();
      const progress = duration > 0 ? Math.min(1, (now - start) / duration) : 1;
      const send = step(progress, now);
      if (send) {
        last = send;
        dispatch.offer(send);
      }
      if (progress >= 1) {
        break;
      }
      next += tick;
      const wait = next - this.now();
      if (wait > 0) {
        await sleep(wait);
      } else {
        next = this.now();
      }
    }
    await dispatch.settle();
    // The final step may have been skipped while an earlier one was in flight.
    if (last && dispatch.last !== last) {
      await last();
    }
  }

  async capture(): Promise<void> {}
}

/**
 * Page-time pace: record time is `frame * frameMs`, and input goes out once per frame.
 */
export class FramePerfectPace implements Pace {
  readonly timeoutScale = 5;
  private readonly pump: FramePump;

  constructor(pump: FramePump) {
    this.pump = pump;
  }

  now(): number {
    return this.pump.now();
  }

  sleep(ms: number): Promise<void> {
    return this.pump.wait(ms);
  }

  input(send: Send): Promise<number> {
    return this.pump.input(send);
  }

  async animate(
    duration: number,
    tick: number,
    step: (progress: number, t: number) => Send | undefined,
  ): Promise<void> {
    const start = this.now();
    let progress = 0;
    while (progress < 1) {
      await this.pump.input((t) => {
        progress = duration > 0 ? Math.min(1, (t - start) / duration) : 1;
        return step(progress, t)?.();
      });
    }
  }

  async capture(on: boolean): Promise<void> {
    this.pump.capture(on);
    if (on) {
      await this.pump.wait(this.pump.frameMs);
    }
  }
}
