import type { Rect } from '../types.ts';
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
 * Band height as a fraction of the short side of the output.
 */
const BAND = 0.17;

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
 */
export function bandLayout(layout: Layout, side: 'bottom' | 'top'): BandLayout {
  const { width: W, height: H } = layout.size;
  const pad = layout.padding;
  const height = BAND * Math.min(W, H);
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
