import type { RenderOptions, Size } from '../types.ts';
import { BACKGROUND_PRESETS } from './background.ts';
import { computeLayout } from './compositor.ts';
import { resolveOptions } from './defaults.ts';
import { contentScale, type Scene } from './scene.ts';

/**
 * Largest enlargement of the captured frame, in output pixels per captured pixel, that
 * still looks sharp.
 */
export const SHARP_LIMIT = 1.1;

/**
 * The automatic capture scale stays in this range. Above 3, realtime capture drops frames
 * on a common machine.
 */
const AUTO_SCALE = { min: 2, max: 3 };

/**
 * Capture scale (`deviceScaleFactor`) for a recording: the smallest whole scale that keeps
 * the deepest named zoom level sharp at the render size, from 2 to 3.
 */
export function captureScale(viewport: Size, render?: RenderOptions): number {
  const options = resolveOptions({ name: '', render }, undefined, BACKGROUND_PRESETS, 0);
  const { levels, auto, maxScale } = options.zoom;
  const deepest = Math.min(maxScale, Math.max(1, ...Object.values(levels), auto ? auto.scale : 1));
  const need = (computeLayout(options, viewport).k * deepest) / SHARP_LIMIT;
  return Math.min(AUTO_SCALE.max, Math.max(AUTO_SCALE.min, Math.ceil(need - 1e-9)));
}

export interface Enlargement {
  /**
   * Output pixels per captured pixel, at its largest.
   */
  ratio: number;
  /**
   * Output time (ms) where the ratio first reaches its largest value.
   */
  t: number;
  /**
   * Camera scale at that time.
   */
  zoom: number;
  /**
   * The smallest whole capture scale that would keep that frame sharp.
   */
  neededScale: number;
}

/**
 * The largest enlargement of the captured frame in output frames `from` to `to`.
 */
export function captureEnlargement(
  scene: Scene,
  from = 0,
  to = scene.times.length,
): Enlargement | null {
  const { viewport, frameSize } = scene.session;
  let best = -1;
  let ks = 0;
  for (let i = from; i < to; i++) {
    const scale = contentScale(scene, i);
    if (scale > ks * (1 + 1e-6)) {
      ks = scale;
      best = i;
    }
  }
  if (best < 0) return null;
  return {
    ratio: (ks * viewport.width) / frameSize.width,
    t: scene.times[best],
    zoom: scene.camera.scale[best],
    neededScale: Math.ceil(ks / SHARP_LIMIT - 1e-9),
  };
}

/**
 * A warning when the video enlarges the captured frame so much that text looks soft.
 */
export function sharpnessWarning(enlargement: Enlargement | null): string | undefined {
  if (!enlargement || enlargement.ratio <= SHARP_LIMIT) return undefined;
  const { ratio, t, zoom, neededScale } = enlargement;
  const where =
    zoom > 1.001 ? `the ${zoom.toFixed(2)}x zoom at ${(t / 1000).toFixed(1)}s` : 'the video';
  const instead = zoom > 1.001 ? ', or use a smaller zoom' : ', or render a smaller video';
  return (
    `Soft text: ${where} enlarges the captured page ${ratio.toFixed(2)}x. ` +
    `Record with deviceScaleFactor: ${neededScale}${instead}.`
  );
}
