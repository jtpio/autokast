import type { SKRSContext2D } from '@napi-rs/canvas';
import type { Rect, SpotlightEvent } from '../types.ts';
import { parseColor, rgba, type Rgba } from './color.ts';
import { smoothstep } from './easing.ts';
import type { TimedEvent } from './timeline.ts';

export interface ClickStyle {
  type: 'ripple' | 'ring' | 'none';
  /**
   * Fixed color, or null to adapt to the page under the click.
   */
  color: Rgba | null;
  /**
   * Final radius in output pixels at camera scale 1.
   */
  radius: number;
  duration: number;
}

const INK: Rgba = { r: 16, g: 18, b: 24, a: 1 };
const LIGHT: Rgba = { r: 255, g: 255, b: 255, a: 1 };

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * Click color with the most contrast against the page under the click (WCAG ratio, mean
 * of a small area). White wins near-ties, so saturated mid-tone buttons get a white ring.
 */
export function adaptiveClickColor(pageLuminance: number): Rgba {
  const white = contrast(1, pageLuminance);
  const ink = contrast(0.006, pageLuminance);
  return white >= ink * 0.75 ? LIGHT : INK;
}

export function parseClickColor(color: string | undefined): Rgba | null {
  if (!color || color === 'auto') return null;
  return parseColor(color) ?? INK;
}

/**
 * Draws one click effect at output position (x, y). `age` is in output ms; `scale` is
 * the camera scale times the resolution unit. A ripple is a thin ring that expands and
 * fades, over a very light fill that is gone by mid-life; a soft halo in the opposite
 * tone keeps the ring readable on mid-tones. A ring is a slightly heavier ring alone.
 */
export function drawClick(
  ctx: SKRSContext2D,
  style: ClickStyle,
  color: Rgba,
  x: number,
  y: number,
  age: number,
  scale: number,
): void {
  if (style.type === 'none' || age < 0 || age >= style.duration) return;
  const p = age / style.duration;
  const u = Math.max(0.5, scale);
  const grow = 1 - (1 - p) ** 3;
  const r = style.radius * scale * (0.3 + 0.7 * grow);
  const fade = (1 - p) ** 1.25 * smoothstep(0, 0.05, p);
  const halo = color === LIGHT ? INK : LIGHT;
  const ring = style.type === 'ring';
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!ring) {
    ctx.fillStyle = rgba(color, 0.14 * (1 - p) ** 4 * smoothstep(0, 0.05, p));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = (ring ? 2.8 : 2.4 - 0.8 * p) * u;
  ctx.strokeStyle = rgba(color, 0.95 * fade);
  ctx.shadowColor = rgba(halo, 0.38 * fade);
  ctx.shadowBlur = 3 * u;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r - ctx.lineWidth / 2), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

const SPOT_FADE_IN = 320;
const SPOT_FADE_OUT = 360;
const SPOT_PADDING = 10;
const SPOT_RADIUS = 12;

/**
 * Visibility of a spotlight at output time `t`, 0 to 1.
 */
export function spotlightAmount(event: TimedEvent<SpotlightEvent>, t: number): number {
  const start = event.out;
  const end = event.out + Math.max(0, event.duration);
  if (t < start || t > end + SPOT_FADE_OUT) return 0;
  return Math.min(
    smoothstep(start, start + SPOT_FADE_IN, t),
    1 - smoothstep(end, end + SPOT_FADE_OUT, t),
  );
}

/**
 * Dims the content outside the spotlight rectangle. Called with the content transform
 * set (CSS pixels to output pixels) and the content clip active. The opening eases in
 * from slightly larger, which reads as the light focusing.
 */
export function drawSpotlight(
  ctx: SKRSContext2D,
  event: TimedEvent<SpotlightEvent>,
  amount: number,
  viewport: Rect,
  unit: number,
): void {
  if (amount <= 0) return;
  const pad = (event.padding ?? SPOT_PADDING) + 14 * (1 - amount);
  const r = event.rect;
  const radius = event.radius ?? SPOT_RADIUS;
  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.x, viewport.y, viewport.width, viewport.height);
  ctx.roundRect(r.x - pad, r.y - pad, r.width + 2 * pad, r.height + 2 * pad, radius);
  ctx.fillStyle = `rgba(6, 8, 14, ${(0.58 * amount).toFixed(4)})`;
  ctx.fill('evenodd');
  ctx.beginPath();
  ctx.roundRect(r.x - pad, r.y - pad, r.width + 2 * pad, r.height + 2 * pad, radius);
  const t = ctx.getTransform();
  ctx.lineWidth = (1.2 * unit) / Math.max(1e-6, Math.hypot(t.a, t.b));
  ctx.strokeStyle = `rgba(255, 255, 255, ${(0.28 * amount).toFixed(4)})`;
  ctx.stroke();
  ctx.restore();
}
