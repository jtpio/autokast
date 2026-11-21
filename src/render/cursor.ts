import type { CursorSample, CursorStyle, MouseButtonEvent, TimelineEvent } from '../types.ts';
import { clamp, smoothstep } from './easing.ts';
import { springSmooth, springStep } from './spring.ts';
import type { TimedEvent, TimeMap } from './timeline.ts';

/**
 * Durations of the cursor animations, in output milliseconds.
 */
const STYLE_FADE = 140;
const PRESS_IN = 90;
const PRESS_OUT = 160;
const PIN_RAMP = 160;
const IDLE_FADE_OUT = 320;
const IDLE_FADE_IN = 160;

export interface CursorTrack {
  /**
   * Drawn hotspot position in viewport CSS pixels.
   */
  x: Float64Array;
  y: Float64Array;
  /**
   * 1 where the recorded cursor moved since the previous frame.
   */
  moving: Uint8Array;
  opacity: Float64Array;
  style: CursorStyle[];
  previousStyle: CursorStyle[];
  /**
   * Progress of the change from `previousStyle` (0) to `style` (1).
   */
  styleMix: Float64Array;
  /**
   * Press amount: 1 fully pressed, 0 released (slightly negative during the release bounce).
   */
  press: Float64Array;
  /**
   * Lean of the cursor body around its hotspot, in radians (positive is clockwise).
   */
  angle: Float64Array;
}

export interface ClickMark {
  out: number;
  /**
   * Record time of the press, which selects the frame for the adaptive color.
   */
  t: number;
  x: number;
  y: number;
}

/**
 * Smooth, overshoot-free interpolation of cursor samples (Steffen's monotone cubic,
 * per axis, with non-uniform times). Returns a function of record time.
 */
export function cursorPath(samples: CursorSample[]): (t: number) => { x: number; y: number } {
  const pts: CursorSample[] = [];
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    if (pts.length && pts[pts.length - 1].t === s.t) pts[pts.length - 1] = s;
    else pts.push(s);
  }
  const n = pts.length;
  if (n === 0) return () => ({ x: 0, y: 0 });
  const t = pts.map((p) => p.t);
  const tangents = (v: number[]) => {
    const m = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const h0 = t[i] - t[i - 1];
      const h1 = t[i + 1] - t[i];
      const d0 = (v[i] - v[i - 1]) / h0;
      const d1 = (v[i + 1] - v[i]) / h1;
      if (d0 * d1 <= 0) continue;
      const p = (d0 * h1 + d1 * h0) / (h0 + h1);
      m[i] = Math.sign(d0) * Math.min(2 * Math.abs(d0), 2 * Math.abs(d1), Math.abs(p));
    }
    return m;
  };
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const mx = tangents(xs);
  const my = tangents(ys);
  return (time: number) => {
    if (time <= t[0]) return { x: xs[0], y: ys[0] };
    if (time >= t[n - 1]) return { x: xs[n - 1], y: ys[n - 1] };
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= time) lo = mid;
      else hi = mid;
    }
    const h = t[hi] - t[lo];
    const u = (time - t[lo]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    return {
      x: h00 * xs[lo] + h10 * h * mx[lo] + h01 * xs[hi] + h11 * h * mx[hi],
      y: h00 * ys[lo] + h10 * h * my[lo] + h01 * ys[hi] + h11 * h * my[hi],
    };
  };
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function easeOutBack(t: number): number {
  const c = 1.4;
  return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2;
}

export interface CursorTrackOptions {
  visible: boolean;
  smoothing: number;
  hideAfter: number;
  /**
   * Strength of the lean: 0 off, 1 the default look.
   */
  tilt?: number;
}

/**
 * Cursor lean: a damped spring pulls the angle toward a target set by the horizontal
 * speed of the hotspot on the page, `TILT_MAX * tanh(vx / TILT_SPEED)`. The body trails
 * behind like a weight hanging from the tip; vertical travel gives no lean, as a body
 * hanging in line with its pivot does not turn. Slightly underdamped: a soft build-up and
 * a small, quick swing back when the cursor stops.
 */
export const TILT_MAX = (13 * Math.PI) / 180;
export const TILT_SPEED = 1400;
export const TILT_OMEGA = 14;
export const TILT_DAMPING = 0.78;

/**
 * How much each cursor shape leans. Shapes that read as axes or symbols stay upright.
 */
const TILT_FACTOR: Partial<Record<CursorStyle, number>> = {
  default: 1,
  pointer: 0.85,
  grab: 0.6,
  grabbing: 0.6,
};

export function tiltFactor(style: CursorStyle): number {
  return TILT_FACTOR[style] ?? 0;
}

/**
 * Lean angle per output frame from the hotspot positions, in radians. At a break (a cut)
 * the jump is not motion, so it gives no push; the angle stays continuous.
 */
export function tiltTrack(
  times: ArrayLike<number>,
  x: ArrayLike<number>,
  breaks: ArrayLike<boolean>,
  strength: number,
): Float64Array {
  const n = times.length;
  const out = new Float64Array(n);
  if (strength <= 0) return out;
  let angle = 0;
  let spin = 0;
  for (let i = 1; i < n; i++) {
    const dt = (times[i] - times[i - 1]) / 1000;
    if (dt <= 0) {
      out[i] = angle;
      continue;
    }
    const vx = breaks[i] ? 0 : (x[i] - x[i - 1]) / dt;
    const target = strength * TILT_MAX * Math.tanh(vx / TILT_SPEED);
    const steps = Math.ceil(dt / 0.002);
    const h = dt / steps;
    for (let k = 0; k < steps; k++) {
      spin +=
        (TILT_OMEGA * TILT_OMEGA * (target - angle) - 2 * TILT_DAMPING * TILT_OMEGA * spin) * h;
      angle += spin * h;
    }
    out[i] = angle;
  }
  return out;
}

/**
 * Computes the drawn cursor for every output frame: interpolated position, zero-lag
 * spring smoothing (pinned to the recorded position while a button is down), style
 * changes, press amount and idle fade.
 */
export function computeCursor(
  times: ArrayLike<number>,
  samples: CursorSample[],
  rawEvents: TimelineEvent[],
  map: TimeMap,
  options: CursorTrackOptions,
): CursorTrack {
  const n = times.length;
  const track: CursorTrack = {
    x: new Float64Array(n),
    y: new Float64Array(n),
    moving: new Uint8Array(n),
    opacity: new Float64Array(n),
    style: new Array(n),
    previousStyle: new Array(n),
    styleMix: new Float64Array(n),
    press: new Float64Array(n),
    angle: new Float64Array(n),
  };
  const path = cursorPath(samples);
  const rec = new Float64Array(n);
  const rawX = new Float64Array(n);
  const rawY = new Float64Array(n);
  const breaks = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    rec[i] = map.toRecord(times[i]);
    const p = path(rec[i]);
    rawX[i] = p.x;
    rawY[i] = p.y;
    if (i > 0) {
      breaks[i] = map.cutBetween(rec[i - 1], rec[i] + 1e-6);
      track.moving[i] = Math.abs(p.x - rawX[i - 1]) + Math.abs(p.y - rawY[i - 1]) > 0.02 ? 1 : 0;
    }
  }

  const sorted = [...rawEvents].sort((a, b) => a.t - b.t);
  const mouse = sorted.filter((e) => e.type === 'mouseDown' || e.type === 'mouseUp');
  const styles = sorted.filter((e) => e.type === 'cursorStyle');
  const pressed = new Uint8Array(n);
  const recStyle = new Array<CursorStyle>(n);
  let mi = 0;
  let si = 0;
  let down = false;
  let current: CursorStyle = 'default';
  for (let i = 0; i < n; i++) {
    for (; mi < mouse.length && mouse[mi].t <= rec[i]; mi++) down = mouse[mi].type === 'mouseDown';
    for (; si < styles.length && styles[si].t <= rec[i]; si++) current = styles[si].style;
    pressed[i] = down ? 1 : 0;
    recStyle[i] = current;
  }

  if (options.smoothing > 0 && n > 1) {
    const omega = 1 / (0.15 * clamp(options.smoothing, 0.01, 1));
    const sx = springSmooth(times, rawX, omega, breaks);
    const sy = springSmooth(times, rawY, omega, breaks);
    const pin = pinWeights(times, pressed);
    for (let i = 0; i < n; i++) {
      track.x[i] = sx[i] + (rawX[i] - sx[i]) * pin[i];
      track.y[i] = sy[i] + (rawY[i] - sy[i]) * pin[i];
    }
  } else {
    track.x.set(rawX);
    track.y.set(rawY);
  }

  let style = recStyle[0] ?? 'default';
  let previous = style;
  let changedAt = -Infinity;
  let press = 0;
  let pressFrom = 0;
  let pressTarget = 0;
  let pressAt = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = times[i];
    const s = recStyle[i];
    if (s !== style) {
      previous = track.styleMix[i - 1] < 0.5 ? previous : style;
      style = s;
      changedAt = t;
    }
    track.style[i] = style;
    track.previousStyle[i] = previous;
    track.styleMix[i] = smoothstep(0, 1, (t - changedAt) / STYLE_FADE);

    const target = pressed[i];
    if (target !== pressTarget) {
      pressFrom = press;
      pressTarget = target;
      pressAt = t;
    }
    const k = (t - pressAt) / (pressTarget ? PRESS_IN : PRESS_OUT);
    press =
      k >= 1
        ? pressTarget
        : pressFrom + (pressTarget - pressFrom) * (pressTarget ? easeOutCubic(k) : easeOutBack(k));
    track.press[i] = press;
  }

  const lean = tiltTrack(times, track.x, breaks, options.tilt ?? 0);
  let factor = n > 0 ? tiltFactor(track.style[0]) : 0;
  let rate = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const target = tiltFactor(track.style[i]);
      [factor, rate] = springStep(factor, rate, target, 28, (times[i] - times[i - 1]) / 1000);
    }
    track.angle[i] = lean[i] * factor;
  }

  const hasCursor = options.visible && samples.length > 0;
  if (!hasCursor) return track;
  if (options.hideAfter <= 0) {
    track.opacity.fill(1);
    return track;
  }
  const active = new Uint8Array(n);
  let lastActive = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i === 0 || track.moving[i] || pressed[i]) lastActive = times[i];
    active[i] = times[i] - lastActive < options.hideAfter ? 1 : 0;
  }
  const fade = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    fade[i] = active[i]
      ? 1
      : Math.max(0, (i ? fade[i - 1] : 1) - (times[i] - times[i - 1]) / IDLE_FADE_OUT);
  }
  let ahead = 0;
  for (let i = n - 1; i >= 0; i--) {
    ahead = active[i] ? 1 : Math.max(0, ahead - (times[i + 1] - times[i]) / IDLE_FADE_IN);
    track.opacity[i] = smoothstep(0, 1, Math.max(fade[i], ahead));
  }
  return track;
}

/**
 * Weight 1 while a button is down, easing to 0 over PIN_RAMP before and after.
 */
function pinWeights(times: ArrayLike<number>, pressed: Uint8Array): Float64Array {
  const n = times.length;
  const w = new Float64Array(n);
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    if (pressed[i]) last = times[i];
    w[i] = 1 - smoothstep(0, PIN_RAMP, times[i] - last);
  }
  let nextPress = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    if (pressed[i]) nextPress = times[i];
    w[i] = Math.max(w[i], 1 - smoothstep(0, PIN_RAMP, nextPress - times[i]));
  }
  return w;
}

/**
 * Positions of the click effects: one per mouseDown outside the cuts.
 */
export function clickMarks(events: TimedEvent[]): ClickMark[] {
  return events
    .filter((e): e is TimedEvent<MouseButtonEvent> => e.type === 'mouseDown')
    .map((e) => ({ out: e.out, t: e.t, x: e.x, y: e.y }));
}
