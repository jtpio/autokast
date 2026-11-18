import type { FrameRef, Session, TimelineEvent } from '../types.ts';

interface Segment {
  recStart: number;
  recEnd: number;
  outStart: number;
  outEnd: number;
  /**
   * Playback rate; Infinity for a cut.
   */
  rate: number;
}

/**
 * Piecewise-linear map between record time and output time, built from `cut` and
 * `speed` events. Overlapping speed ranges multiply; a cut wins over a speed range.
 */
export class TimeMap {
  readonly segments: Segment[];
  /**
   * Output duration in milliseconds.
   */
  readonly duration: number;

  constructor(events: TimelineEvent[], recordDuration: number) {
    const end = Math.max(0, recordDuration);
    const ranges = events.filter((e) => e.type === 'cut' || e.type === 'speed');
    const points = new Set([0, end]);
    for (const r of ranges) {
      points.add(Math.min(Math.max(r.t, 0), end));
      points.add(Math.min(Math.max(r.end, 0), end));
    }
    const sorted = [...points].sort((a, b) => a - b);
    const segments: Segment[] = [];
    let out = 0;
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      const mid = (a + b) / 2;
      let rate = 1;
      for (const r of ranges) {
        if (mid < r.t || mid >= r.end) continue;
        if (r.type === 'cut') rate = Infinity;
        else if (r.rate > 0 && rate !== Infinity) rate *= r.rate;
      }
      const last = segments[segments.length - 1];
      if (last && last.rate === rate) {
        last.recEnd = b;
        last.outEnd = last.outStart + (b - last.recStart) / rate;
        out = last.outEnd;
        continue;
      }
      const length = rate === Infinity ? 0 : (b - a) / rate;
      segments.push({ recStart: a, recEnd: b, outStart: out, outEnd: out + length, rate });
      out += length;
    }
    if (segments.length === 0) {
      segments.push({ recStart: 0, recEnd: 0, outStart: 0, outEnd: 0, rate: 1 });
    }
    this.segments = segments;
    this.duration = out;
  }

  /**
   * Output time of a record time. A time inside a cut maps to the cut point.
   */
  toOutput(rec: number): number {
    const first = this.segments[0];
    if (rec <= first.recStart) return first.outStart - (first.recStart - rec);
    for (const s of this.segments) {
      if (rec < s.recEnd)
        return s.rate === Infinity ? s.outStart : s.outStart + (rec - s.recStart) / s.rate;
    }
    const last = this.segments[this.segments.length - 1];
    return last.outEnd + (rec - last.recEnd);
  }

  /**
   * Record time shown at an output time. At a cut point it returns the end of the cut.
   */
  toRecord(out: number): number {
    if (out <= 0) return this.segments[0].recStart + out;
    for (const s of this.segments) {
      if (s.rate !== Infinity && out < s.outEnd) return s.recStart + (out - s.outStart) * s.rate;
    }
    const last = this.segments[this.segments.length - 1];
    return last.recEnd + (out - last.outEnd);
  }

  /**
   * True when a record time lies inside a cut.
   */
  inCut(rec: number): boolean {
    return this.segments.some((s) => s.rate === Infinity && rec >= s.recStart && rec < s.recEnd);
  }

  /**
   * True when a cut lies between two record times (a < b).
   */
  cutBetween(a: number, b: number): boolean {
    return this.segments.some((s) => s.rate === Infinity && s.recStart >= a && s.recStart < b);
  }

  /**
   * Playback rate at a record time (1 outside speed ranges).
   */
  rateAt(rec: number): number {
    for (const s of this.segments) if (rec < s.recEnd) return s.rate;
    return 1;
  }
}

/**
 * A timeline event with its output time.
 */
export type TimedEvent<E extends TimelineEvent = TimelineEvent> = E & { out: number };

/**
 * Sorts the events, adds output times and drops the events inside cuts.
 * A zoom inside a cut is kept with duration 0, so it takes effect at the cut point.
 * A caption inside a cut is kept and starts at the cut point: with the frame-perfect
 * clock, a caption set just before `cast.cut` has the same time as the start of the cut.
 */
export function timedEvents(events: TimelineEvent[], map: TimeMap): TimedEvent[] {
  const result: TimedEvent[] = [];
  const sorted = [...events].sort((a, b) => a.t - b.t);
  for (const e of sorted) {
    if (e.type === 'cut' || e.type === 'speed') continue;
    if (map.inCut(e.t)) {
      if (e.type === 'zoom') result.push({ ...e, duration: 0, out: map.toOutput(e.t) });
      else if (e.type === 'caption') result.push({ ...e, out: map.toOutput(e.t) });
      continue;
    }
    result.push({ ...e, out: map.toOutput(e.t) });
  }
  return result;
}

/**
 * Index of the latest frame with `t <= time`, or 0 when the time is before the first frame.
 */
export function frameIndexAt(frames: FrameRef[], time: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  if (hi < 0 || time < frames[0].t) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid].t <= time) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Builds the time map of a session.
 */
export function sessionTimeMap(session: Session): TimeMap {
  return new TimeMap(session.events, session.duration);
}

/**
 * Times of the output frames, in output milliseconds.
 */
export function frameTimes(duration: number, fps: number): Float64Array {
  const count = Math.max(1, Math.round((duration * fps) / 1000));
  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) times[i] = (i * 1000) / fps;
  return times;
}
