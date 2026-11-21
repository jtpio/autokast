import { contentScale, type Scene } from './scene.ts';

/**
 * Largest enlargement of the captured frame, in output pixels per captured pixel, that
 * still looks sharp.
 */
export const SHARP_LIMIT = 1.1;

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
 * A warning when output frames `from` to `to` enlarge the captured frame so much that text
 * looks soft.
 */
export function sharpnessWarning(
  scene: Scene,
  from = 0,
  to = scene.times.length,
): string | undefined {
  const enlargement = captureEnlargement(scene, from, to);
  if (!enlargement || enlargement.ratio <= SHARP_LIMIT) return undefined;
  const { ratio, t, zoom, neededScale } = enlargement;
  const where =
    zoom > 1.001 ? `the ${zoom.toFixed(2)}x zoom at ${(t / 1000).toFixed(1)}s` : 'the video';
  const instead = zoom > 1.001 ? ', or use a smaller zoom' : ', or render a smaller video';
  const realtime =
    scene.session.captureMode === 'realtime'
      ? ' Realtime capture can drop frames at a higher scale: use capture.mode "frame-perfect".'
      : '';
  return (
    `Soft text: ${where} enlarges the captured page ${ratio.toFixed(2)}x. ` +
    `Record with deviceScaleFactor: ${neededScale}${instead}.${realtime}`
  );
}
