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

const INK: Rgba = { r: 18, g: 20, b: 26, a: 1 };
const LIGHT: Rgba = { r: 255, g: 255, b: 255, a: 1 };

/**
 * Click color for the page brightness under the click: dark ink on light pages,
 * white on dark ones.
 */
export function adaptiveClickColor(pageLuminance: number): Rgba {
  return pageLuminance > 0.35 ? INK : LIGHT;
}

export function parseClickColor(color: string | undefined): Rgba | null {
  if (!color || color === 'auto') return null;
  return parseColor(color) ?? INK;
}

/**
 * Draws one click effect at output position (x, y). `age` is in output ms; `scale`
 * is the camera scale times the resolution unit. A ripple is a soft disc with a
 * slightly stronger rim that grows quickly, settles and fades; a ring is the rim only.
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
  const grow = 1 - (1 - Math.min(1, p * 1.15)) ** 4;
  const r = style.radius * scale * (0.18 + 0.82 * grow);
  const fade = (1 - p) ** 1.7 * smoothstep(0, 0.06, p);
  const strong = color === LIGHT ? 1.25 : 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (style.type === 'ripple') {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, 0.1 * fade * strong));
    g.addColorStop(0.7, rgba(color, 0.16 * fade * strong));
    g.addColorStop(1, rgba(color, 0.24 * fade * strong));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const ring = style.type === 'ring';
  ctx.strokeStyle = rgba(color, (ring ? 0.75 : 0.32) * fade * strong);
  ctx.lineWidth = (ring ? 2.4 : 1.4) * Math.max(0.5, scale);
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
