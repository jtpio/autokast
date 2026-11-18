import type { Rect } from '../types.ts';
import type { CameraState } from './camera.ts';
import type { Layout } from './compositor.ts';

/**
 * Similarity that moves the rest layout: output = scale * rest + (x, y).
 */
export interface StageTransform {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY: StageTransform = { scale: 1, x: 0, y: 0 };

/**
 * Band height as a fraction of the short side of the output, for captions of one line
 * and for captions of two lines.
 */
const BAND = [0.125, 0.17];

/**
 * Where things go when the caption band is fully open.
 */
export interface BandLayout {
  side: 'bottom' | 'top';
  height: number;
  /**
   * Rest window with the band open.
   */
  window: Rect;
  stage: StageTransform;
  /**
   * Vertical center of the caption text block.
   */
  center: number;
}

/**
 * The band takes the place of the padding on its side and grows it to BAND of the short
 * side; the window (chrome and shadow included) scales down uniformly to fit the rest.
 * `lines` is the line count of the tallest caption: the band is only as high as it needs.
 */
export function bandLayout(layout: Layout, side: 'bottom' | 'top', lines = 2): BandLayout {
  const { width: W, height: H } = layout.size;
  const pad = layout.padding;
  const height = BAND[lines > 1 ? 1 : 0] * Math.min(W, H);
  const w0 = layout.window;
  const availW = W - 2 * pad;
  const availH = H - height - pad;
  const scale = Math.min(1, availW / w0.width, availH / w0.height);
  const width = w0.width * scale;
  const h = w0.height * scale;
  const top = side === 'bottom' ? pad : height;
  const window = { x: (W - width) / 2, y: top + (availH - h) / 2, width, height: h };
  return {
    side,
    height,
    window,
    stage: { scale, x: window.x - scale * w0.x, y: window.y - scale * w0.y },
    center: side === 'bottom' ? window.y + window.height + height / 2 : window.y - height / 2,
  };
}

/**
 * Stage transform with the band open by `p` (0 to 1).
 */
export function stageAt(band: BandLayout | null, p: number): StageTransform {
  if (!band || p <= 0) return IDENTITY;
  const s = band.stage;
  return { scale: 1 + (s.scale - 1) * p, x: s.x * p, y: s.y * p };
}

export function applyStage(s: StageTransform, r: Rect): Rect {
  return {
    x: s.scale * r.x + s.x,
    y: s.scale * r.y + s.y,
    width: s.scale * r.width,
    height: s.scale * r.height,
  };
}

/**
 * Camera scale by which edges 'fill' has moved every page edge past the output edge.
 */
export const FILL_SCALE = 1.35;

/**
 * The plain affine map from a camera state to output pixels: page point p lands at
 * (ex + p.x * ks, ey + p.y * ks). No per-frame correction.
 */
export function contentMap(
  layout: Layout,
  stage: StageTransform,
  camera: CameraState,
): { ks: number; ex: number; ey: number } {
  const c = layout.content;
  const ks = layout.k * stage.scale * camera.scale;
  return {
    ks,
    ex: stage.x + stage.scale * (c.x + c.width / 2) - camera.cx * ks,
    ey: stage.y + stage.scale * (c.y + c.height / 2) - camera.cy * ks,
  };
}

/**
 * Edges 'fill' for one camera state. The gap allowed between the page and each output edge
 * blends from the rest gap at scale 1 to a small bleed past the edge by FILL_SCALE (the
 * bleed hides the scaled corner radius); the center moves by the smallest amount that
 * respects it. On the caption band side the edge is the band. Applied to end states and
 * held states only, so a transition between them stays one pivot zoom.
 */
export function fillEdges(
  layout: Layout,
  band: BandLayout | null,
  open: number,
  camera: CameraState,
): CameraState {
  const v = Math.min(1, Math.max(0, (camera.scale - 1) / (FILL_SCALE - 1)));
  const w = v * v * v * (v * (6 * v - 15) + 10);
  if (w <= 0) return camera;
  const stage = stageAt(band, open);
  const { width: W, height: H } = layout.size;
  const c = layout.content;
  const { ks, ex, ey } = contentMap(layout, stage, camera);
  const bleed = 0.32 * layout.radius * stage.scale * camera.scale + 2 * layout.unit;
  const top = band && band.side === 'top' ? band.window.y * open : 0;
  const bottom =
    band && band.side === 'bottom' ? H + (band.window.y + band.window.height - H) * open : H;
  const rest = applyStage(stage, c);
  const gap = (restGap: number) => restGap + (-bleed - restGap) * w;
  const shift = (lo: number, hi: number) =>
    lo <= hi ? Math.min(Math.max(0, lo), hi) : (lo + hi) / 2;
  const right = ex + layout.viewport.width * ks;
  const lower = ey + layout.viewport.height * ks;
  const dx = shift(W - gap(W - rest.x - rest.width) - right, gap(rest.x) - ex);
  const dy = shift(
    bottom - gap(bottom - rest.y - rest.height) - lower,
    top + gap(rest.y - top) - ey,
  );
  return { scale: camera.scale, cx: camera.cx - dx / ks, cy: camera.cy - dy / ks };
}
