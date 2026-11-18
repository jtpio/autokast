import type { CursorSample, Point, TimelineEvent } from '../types.ts';

/**
 * Epoch time in milliseconds with sub-millisecond precision. Same time base as the frame
 * timestamps of the screencast.
 */
export function epochNow(): number {
  return performance.timeOrigin + performance.now();
}

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Record time: milliseconds since the capture started.
 */
export class Clock {
  origin = 0;
  started = false;

  start(): void {
    this.origin = epochNow();
    this.started = true;
  }

  now(): number {
    return this.started ? epochNow() - this.origin : 0;
  }
}

/**
 * A source of record time in milliseconds.
 */
export interface RecordClock {
  now(): number;
}

/**
 * The cursor samples and timeline events of a recording.
 */
export class Timeline {
  readonly clock: RecordClock;
  readonly cursor: CursorSample[] = [];
  readonly events: TimelineEvent[] = [];

  constructor(clock: RecordClock) {
    this.clock = clock;
  }

  now(): number {
    return this.clock.now();
  }

  sample(point: Point, t = this.clock.now()): void {
    this.cursor.push({ t, x: point.x, y: point.y });
  }

  push(event: TimelineEvent): void {
    this.events.push(event);
  }
}
