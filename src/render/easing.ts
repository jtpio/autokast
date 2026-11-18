import type { EasingName } from '../types.ts';

export type EasingFunction = (t: number) => number;

/**
 * The default camera curve: the integral of a skewed bell-shaped velocity t^3 (1 - t)^4.
 * It has no linear middle, a quick but soft start and a long, soft landing.
 */
function smooth(t: number): number {
  const t2 = t * t;
  const t4 = t2 * t2;
  return t4 * (70 - 224 * t + 280 * t2 - 160 * t2 * t + 35 * t4);
}

const EASINGS: Record<EasingName, EasingFunction> = {
  linear: (t) => t,
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  easeInOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  easeInOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  easeOutCubic: (t) => 1 - (1 - t) ** 3,
  easeOutQuart: (t) => 1 - (1 - t) ** 4,
  easeOutExpo: (t) => (t >= 1 ? 1 : (1 - 2 ** (-10 * t)) / (1 - 2 ** -10)),
  smooth,
};

export const EASING_NAMES = Object.keys(EASINGS) as EasingName[];

/**
 * Returns the easing function for a name. The result clamps its input to [0, 1].
 */
export function easing(name: EasingName | undefined): EasingFunction {
  const fn = (name && EASINGS[name]) || smooth;
  return (t) => (t <= 0 ? 0 : t >= 1 ? 1 : fn(t));
}

/**
 * Cubic Hermite smoothstep, clamped.
 */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
