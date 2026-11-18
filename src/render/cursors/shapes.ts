import { Path2D, PathOp, StrokeCap, StrokeJoin, type SKRSContext2D } from '@napi-rs/canvas';
import type { CursorStyle } from '../../types.ts';

/**
 * A vector cursor in design units (1 unit = 1 CSS pixel at size 1; the arrow is about
 * 20 units tall). `body` is filled black over the white `outline` silhouette;
 * `details` are white marks drawn on top of the body.
 */
export interface CursorShape {
  body: Path2D;
  outline: Path2D;
  details?: Path2D;
  hotspot: { x: number; y: number };
}

type Corner = [x: number, y: number, radius: number];

const OUTLINE = 1.35;
const INK = '#101012';

/**
 * Closed polygon with a rounding radius per corner.
 */
function roundedPolygon(corners: Corner[]): Path2D {
  const p = new Path2D();
  const n = corners.length;
  const [lx, ly] = corners[n - 1];
  const [fx, fy] = corners[0];
  p.moveTo((lx + fx) / 2, (ly + fy) / 2);
  for (let i = 0; i < n; i++) {
    const [x, y, r] = corners[i];
    const [nx, ny] = corners[(i + 1) % n];
    p.arcTo(x, y, nx, ny, r);
  }
  p.closePath();
  return p;
}

function capsule(x: number, y: number, w: number, h: number): Path2D {
  const p = new Path2D();
  p.roundRect(x, y, w, h, Math.min(w, h) / 2);
  return p;
}

/**
 * Capsule of width `w` along the segment (x0, y0) to (x1, y1).
 */
function limb(x0: number, y0: number, x1: number, y1: number, w: number): Path2D {
  const line = new Path2D();
  line.moveTo(x0, y0);
  line.lineTo(x1, y1);
  return strokeOf(line, w);
}

function union(...paths: Path2D[]): Path2D {
  let result = new Path2D(paths[0]);
  for (const p of paths.slice(1)) result = result.op(p, PathOp.Union);
  return result.simplify().asWinding();
}

/**
 * Outline of a stroke as a fillable path. Path2D operations change the path in place,
 * so this works on a copy.
 */
function strokeOf(path: Path2D, width: number, cap = StrokeCap.Round): Path2D {
  return new Path2D(path).stroke({ width, cap, join: StrokeJoin.Round });
}

/**
 * Builds the white silhouette: the body grown by the outline width.
 */
function shape(
  body: Path2D,
  hotspot: { x: number; y: number },
  details?: Path2D,
  outline = union(body, strokeOf(body, OUTLINE * 2)),
): CursorShape {
  return { body, outline, details, hotspot };
}

function arrow(): CursorShape {
  const body = roundedPolygon([
    [0, 0, 0.35],
    [0, 15.9, 0.55],
    [3.75, 12.45, 0.35],
    [6.3, 18.25, 0.6],
    [8.95, 17.1, 0.6],
    [6.45, 11.45, 0.35],
    [11.55, 11.45, 0.55],
  ]);
  return shape(body, { x: 0, y: 0 });
}

function pointingHand(): CursorShape {
  const palm = roundedPolygon([
    [4.7, 11.2, 1],
    [17.2, 11.2, 1.2],
    [17.2, 16.2, 2.6],
    [15.5, 19.8, 0.8],
    [15.5, 22.2, 0.5],
    [7.1, 22.2, 0.5],
    [7.1, 20.6, 1.6],
    [4.7, 17.4, 1.6],
  ]);
  const body = union(
    capsule(4.7, 0, 3.6, 14),
    capsule(8.3, 7.2, 3.3, 7.8),
    capsule(11.6, 8.3, 3.05, 7.2),
    capsule(14.65, 9.8, 2.55, 6.2),
    palm,
    limb(6.9, 18.3, 1.95, 12.9, 3.3),
  )
    .round(0.5)
    .asWinding();
  const lines = new Path2D();
  lines.moveTo(8.4, 9.9);
  lines.lineTo(8.4, 12.2);
  lines.moveTo(11.6, 10.9);
  lines.lineTo(11.6, 12.9);
  lines.moveTo(14.65, 12.1);
  lines.lineTo(14.65, 13.5);
  return shape(body, { x: 6.5, y: 0.6 }, strokeOf(lines, 0.8));
}

function openHand(): CursorShape {
  const palm = roundedPolygon([
    [4.9, 10.4, 1],
    [16.6, 10.4, 1],
    [16.6, 15.6, 2.8],
    [15.0, 19.4, 0.8],
    [15.0, 21.8, 0.5],
    [7.1, 21.8, 0.5],
    [7.1, 19.9, 1.4],
    [4.9, 16.2, 1.5],
  ]);
  const body = union(
    capsule(4.9, 2.4, 2.9, 11),
    capsule(8.2, 0.8, 2.9, 12),
    capsule(11.5, 1.8, 2.8, 11),
    capsule(14.6, 4.4, 2.5, 9),
    palm,
    limb(6.9, 17.6, 1.7, 11.0, 3.1),
  )
    .round(0.5)
    .asWinding();
  return shape(body, { x: 10.6, y: 11.5 });
}

function closedHand(): CursorShape {
  const palm = roundedPolygon([
    [4.9, 9.6, 1.2],
    [16.6, 9.6, 1.2],
    [16.6, 15.0, 2.8],
    [15.0, 18.9, 0.8],
    [15.0, 21.0, 0.5],
    [7.1, 21.0, 0.5],
    [7.1, 19.2, 1.4],
    [4.9, 15.6, 1.5],
  ]);
  const body = union(
    capsule(4.9, 6.6, 2.95, 6),
    capsule(8.2, 5.8, 2.95, 6),
    capsule(11.5, 6.2, 2.85, 6),
    capsule(14.55, 7.4, 2.5, 5),
    palm,
    limb(6.9, 15.6, 3.6, 11.6, 3.1),
  )
    .round(0.5)
    .asWinding();
  const lines = new Path2D();
  for (const [x, y] of [
    [8.05, 7.9],
    [11.35, 7.9],
    [14.4, 8.8],
  ]) {
    lines.moveTo(x, y);
    lines.lineTo(x, y + 2.2);
  }
  return shape(body, { x: 10.6, y: 12.5 }, strokeOf(lines, 0.75));
}

function iBeam(): CursorShape {
  const line = new Path2D();
  for (const s of [-1, 1]) {
    line.moveTo(-3.3, s * 9.4);
    line.bezierCurveTo(-1.3, s * 9.4, 0, s * 8.9, 0, s * 7.3);
    line.bezierCurveTo(0, s * 8.9, 1.3, s * 9.4, 3.3, s * 9.4);
  }
  line.moveTo(0, -7.3);
  line.lineTo(0, 7.3);
  return shape(strokeOf(line, 1.45), { x: 0, y: 0 });
}

function crosshair(): CursorShape {
  const line = new Path2D();
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    line.moveTo(dx * 2.6, dy * 2.6);
    line.lineTo(dx * 9, dy * 9);
  }
  const dot = new Path2D();
  dot.arc(0, 0, 0.95, 0, Math.PI * 2);
  return shape(union(strokeOf(line, 1.3), dot), { x: 0, y: 0 });
}

/**
 * Horizontal double arrow centered on the origin, `half` units from center to tip.
 */
function doubleArrow(half: number): Path2D {
  const head = 4.6;
  const wing = 3.7;
  const shaft = 0.95;
  return roundedPolygon([
    [-half, 0, 0.45],
    [-half + head, -wing, 0.45],
    [-half + head, -shaft, 0.2],
    [half - head, -shaft, 0.2],
    [half - head, -wing, 0.45],
    [half, 0, 0.45],
    [half - head, wing, 0.45],
    [half - head, shaft, 0.2],
    [-half + head, shaft, 0.2],
    [-half + head, wing, 0.45],
  ]);
}

function rotated(path: Path2D, degrees: number): Path2D {
  const a = (degrees * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new Path2D(path).transform({ a: c, b: s, c: -s, d: c, e: 0, f: 0 });
}

function resize(degrees: number): CursorShape {
  return shape(rotated(doubleArrow(9.6), degrees), { x: 0, y: 0 });
}

function move(): CursorShape {
  const body = union(doubleArrow(10.2), rotated(doubleArrow(10.2), 90));
  return shape(body, { x: 0, y: 0 });
}

function notAllowed(): CursorShape {
  const disc = (r: number) => {
    const p = new Path2D();
    p.arc(0, 0, r, 0, Math.PI * 2);
    p.closePath();
    return p;
  };
  const ring = disc(8.15).op(disc(5.85), PathOp.Difference).asWinding();
  const bar = rotated(capsule(-7, -1.15, 14, 2.3), 45).op(disc(7), PathOp.Intersect);
  return shape(union(ring, bar), { x: 0, y: 0 }, undefined, disc(8.15 + OUTLINE));
}

const BUILDERS: Record<Exclude<CursorStyle, 'none'>, () => CursorShape> = {
  default: arrow,
  pointer: pointingHand,
  text: iBeam,
  grab: openHand,
  grabbing: closedHand,
  crosshair,
  move,
  'ew-resize': () => resize(0),
  'ns-resize': () => resize(90),
  'nwse-resize': () => resize(45),
  'nesw-resize': () => resize(-45),
  'not-allowed': notAllowed,
};

const cache = new Map<CursorStyle, CursorShape>();

/**
 * The shape for a cursor style, built once. `none` has no shape.
 */
export function cursorShape(style: CursorStyle): CursorShape | null {
  if (style === 'none') return null;
  let s = cache.get(style);
  if (!s) {
    s = (BUILDERS[style] ?? arrow)();
    cache.set(style, s);
  }
  return s;
}

/**
 * Draws a cursor with its hotspot at (x, y) in output pixels. `scale` is output
 * pixels per design unit. The drop shadow has a tight contact layer and a soft layer.
 */
export function drawCursor(
  ctx: SKRSContext2D,
  style: CursorStyle,
  x: number,
  y: number,
  scale: number,
  alpha: number,
): void {
  const s = cursorShape(style);
  if (!s || alpha <= 0.002 || scale <= 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.setTransform(scale, 0, 0, scale, x - s.hotspot.x * scale, y - s.hotspot.y * scale);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.22)';
  ctx.shadowBlur = 5 * scale;
  ctx.shadowOffsetY = 1.6 * scale;
  ctx.fill(s.outline);
  ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
  ctx.shadowBlur = 1.1 * scale;
  ctx.shadowOffsetY = 0.45 * scale;
  ctx.fill(s.outline);
  ctx.shadowColor = 'transparent';
  ctx.fillStyle = INK;
  ctx.fill(s.body);
  if (s.details) {
    ctx.fillStyle = '#ffffff';
    ctx.fill(s.details);
  }
  ctx.restore();
}
