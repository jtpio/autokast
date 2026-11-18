import type { Point, Size } from '../types.ts';
import type { Random } from './random.ts';

/**
 * Settings that shape the duration of a cursor move.
 */
export interface MoveTiming {
  speed: number;
  minDuration: number;
  maxDuration: number;
}

/**
 * A cursor path: maps progress in [0, 1] to a point.
 */
export type CursorPath = (progress: number) => Point;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Duration of a cursor move in milliseconds (a Fitts-like log law). Zero below one pixel.
 */
export function moveDuration(distance: number, timing: MoveTiming): number {
  if (distance < 1) {
    return 0;
  }
  const base = (250 + 140 * Math.log2(1 + distance / 60)) / timing.speed;
  return clamp(base, timing.minDuration, timing.maxDuration);
}

/**
 * Position profile of a move: minimum jerk, time-warped so the peak speed comes at about 39%
 * of the move and the deceleration is longer than the acceleration, as in human reaching.
 */
export function moveEase(progress: number): number {
  const w = clamp(progress, 0, 1) ** 0.8;
  return w * w * w * (10 - 15 * w + 6 * w * w);
}

/**
 * Position profile of a drag: minimum jerk, time-warped so the start is gentle (peak speed
 * at about 56% of the move). A dragged element can then follow the cursor.
 */
export function dragEase(progress: number): number {
  const w = clamp(progress, 0, 1) ** 1.2;
  return w * w * w * (10 - 15 * w + 6 * w * w);
}

/**
 * Smooth acceleration and deceleration, for scrolling.
 */
export function easeInOutCubic(progress: number): number {
  const u = clamp(progress, 0, 1);
  return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
}

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, s: number): Point {
  const r = 1 - s;
  const a = r * r * r;
  const b = 3 * r * r * s;
  const c = 3 * r * s * s;
  const d = s * s * s;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

function inside(point: Point, bounds: Size): boolean {
  return point.x >= 0 && point.y >= 0 && point.x <= bounds.width && point.y <= bounds.height;
}

/**
 * A slightly curved path from `from` to `to`: a cubic Bezier whose control points are offset
 * perpendicular to the straight line by up to `curvature` times the distance. The bend
 * flips side when it would leave `bounds`. The path starts and ends exactly on the points.
 */
export function cursorPath(
  from: Point,
  to: Point,
  curvature: number,
  random: Random,
  bounds?: Size,
): CursorPath {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const sign = random() < 0.5 ? -1 : 1;
  const bend = curvature * distance * (0.2 + 0.4 * random());
  const k1 = bend * (0.8 + 0.4 * random());
  const k2 = bend * (0.8 + 0.4 * random());
  const f1 = 0.25 + 0.1 * random();
  const f2 = 0.65 + 0.1 * random();
  if (distance < 1) {
    return (s) => (s >= 1 ? { ...to } : { ...from });
  }
  const nx = -dy / distance;
  const ny = dx / distance;
  const controls = (side: number): [Point, Point] => [
    { x: from.x + dx * f1 + nx * k1 * side, y: from.y + dy * f1 + ny * k1 * side },
    { x: from.x + dx * f2 + nx * k2 * side, y: from.y + dy * f2 + ny * k2 * side },
  ];
  let [c1, c2] = controls(sign);
  if (bounds && !inside(bezier(from, c1, c2, to, 0.5), bounds)) {
    [c1, c2] = controls(-sign);
  }
  return (s) => {
    if (s <= 0) {
      return { ...from };
    }
    if (s >= 1) {
      return { ...to };
    }
    const p = bezier(from, c1, c2, to, s);
    return bounds ? { x: clamp(p.x, 0, bounds.width), y: clamp(p.y, 0, bounds.height) } : p;
  };
}

/**
 * Delay before typing the next character: the mean delay with random variation,
 * a bit longer after a space, punctuation or a new line.
 */
export function typingDelay(
  previous: string,
  delay: number,
  variance: number,
  random: Random,
): number {
  let ms = delay * (1 + clamp(variance, 0, 1) * (random() * 2 - 1));
  if (previous === '\n') {
    ms *= 2;
  } else if (/[.,;:!?]/.test(previous)) {
    ms *= 1.6;
  } else if (previous === ' ') {
    ms *= 1.25;
  }
  return Math.max(0, ms);
}

/**
 * Default duration of a smooth scroll over `distance` pixels.
 */
export function scrollDuration(distance: number): number {
  return clamp(300 + distance * 0.6, 400, 900);
}
