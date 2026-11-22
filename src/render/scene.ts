import type {
  CaptionEvent,
  KeyEvent,
  RenderOptions,
  Session,
  SpotlightEvent,
  UrlEvent,
  ZoomEvent,
} from '../types.ts';
import { BACKGROUND_PRESETS } from './background.ts';
import {
  autoZoomEvents,
  clampCamera,
  computeCamera,
  type CameraState,
  type CameraTrack,
  type FitRegion,
} from './camera.ts';
import { addressAt } from './browser.ts';
import {
  bandAt,
  bandTrack,
  CAPTION_WIDTH,
  captionMeasure,
  planCaptions,
  splitCaption,
  type CaptionCue,
} from './captions.ts';
import {
  computeLayout,
  useRestImage,
  type CursorFrame,
  type FrameInput,
  type Layout,
} from './compositor.ts';
import { clickMarks, computeCursor, type ClickMark, type CursorTrack } from './cursor.ts';
import { resolveOptions, type ResolvedOptions } from './defaults.ts';
import { spotlightAmount } from './effects.ts';
import { keyCueVisible, planKeys, type KeyCue } from './keycaps.ts';
import { bandLayout, fillEdges, stageAt, type BandLayout } from './stage.ts';
import {
  paginate,
  planSubtitles,
  subtitleMeasure,
  subtitleVisible,
  subtitleZone,
  type SubtitleCue,
} from './subtitles.ts';
import {
  frameIndexAt,
  frameTimes,
  sessionTimeMap,
  timedEvents,
  type TimedEvent,
  type TimeMap,
} from './timeline.ts';

/**
 * Arrow height of a size-1 cursor in CSS pixels: the follow camera keeps this much room.
 */
const CURSOR_EXTENT = 20;

/**
 * Longest line of a subtitle: a share of the output width, and a number of font sizes.
 */
const SUBTITLE_WIDTH = 0.78;
const SUBTITLE_EMS = 14;

/**
 * Everything precomputed for a render: options, layout, and per-frame camera, cursor and
 * source frame. Stateful motion (springs, interrupted transitions) is solved here in one
 * pass over all output frames.
 */
export interface Scene {
  session: Session;
  options: ResolvedOptions;
  map: TimeMap;
  layout: Layout;
  times: Float64Array;
  camera: CameraTrack;
  cursor: CursorTrack;
  clicks: ClickMark[];
  spotlights: TimedEvent<SpotlightEvent>[];
  captions: CaptionCue[];
  /**
   * Pages of the captions, for the `subtitles` caption style.
   */
  subtitles: SubtitleCue[];
  keys: KeyCue[];
  /**
   * Addresses of the page, in output time order, for the browser frame.
   */
  urls: TimedEvent<UrlEvent>[];
  /**
   * Caption band geometry when open, or null without captions.
   */
  band: BandLayout | null;
  /**
   * How far the caption band is open at each output frame, 0 to 1.
   */
  bandOpen: Float64Array;
  /**
   * Index into `session.frames` for each output frame.
   */
  frameIndex: Int32Array;
}

/**
 * Builds the scene. `extraTime` adds one output time to the frame grid (for a still
 * between two frames).
 */
export function buildScene(session: Session, options?: RenderOptions, extraTime?: number): Scene {
  const map = sessionTimeMap(session);
  const resolved = resolveOptions(session, options, BACKGROUND_PRESETS, map.duration);
  let times = frameTimes(map.duration, resolved.fps);
  if (extraTime !== undefined && !times.includes(extraTime)) {
    times = Float64Array.from([...times, extraTime].sort((a, b) => a - b));
  }
  const events = timedEvents(session.events, map);
  const cursor = computeCursor(times, session.cursor, session.events, map, resolved.cursor);
  let zooms = resolved.zoom.enabled
    ? events.filter((e): e is TimedEvent<ZoomEvent> => e.type === 'zoom')
    : [];
  if (resolved.zoom.enabled && resolved.zoom.auto && zooms.length === 0) {
    const at = (out: number) => {
      const i = Math.min(times.length - 1, Math.max(0, Math.round((out * resolved.fps) / 1000)));
      return { x: cursor.x[i], y: cursor.y[i] };
    };
    zooms = autoZoomEvents(
      events,
      at,
      session.viewport,
      resolved.zoom.auto,
      resolved.zoom.duration,
    );
  }
  const layout = computeLayout(resolved, session.viewport);
  const captions = resolved.captions.enabled
    ? events.filter(
        (e): e is TimedEvent<CaptionEvent> => e.type === 'caption' && e.text.trim() !== '',
      )
    : [];
  const subtitled = resolved.captions.style === 'subtitles';
  const band =
    captions.length && !subtitled ? bandLayout(layout, resolved.captions.position) : null;
  const measure = captionMeasure(resolved.captions.fontFamily);
  const { cues, groups } = planCaptions(subtitled ? [] : captions, (text) =>
    splitCaption(
      text,
      measure,
      (band ?? layout).window.width * CAPTION_WIDTH,
      resolved.captions.fontSize * layout.unit,
    ),
  );
  const subtitles = subtitled ? subtitleCues(resolved, captions) : [];
  const clear = subtitles.length ? clearOfSubtitles(resolved, layout) : null;
  const camera = computeCamera(
    times,
    zooms,
    { ...cursor, extent: CURSOR_EXTENT * resolved.cursor.size },
    session.viewport,
    {
      ...resolved.zoom,
      fit: (t) => clear ?? fitRegion(resolved, layout, band, bandAt(groups, t)),
      constrain: (state, t) => {
        const clamped = clampCamera(state, session.viewport);
        if (resolved.zoom.mode === 'crop' || resolved.zoom.edges === 'keep') return clamped;
        return fillEdges(layout, band, band ? bandAt(groups, t) : 0, clamped);
      },
    },
  );
  const frameIndex = new Int32Array(times.length);
  for (let i = 0; i < times.length; i++) {
    frameIndex[i] = frameIndexAt(session.frames, map.toRecord(times[i]));
  }
  const keys =
    resolved.keystrokes.show === 'none'
      ? []
      : planKeys(
          events.filter((e): e is TimedEvent<KeyEvent> => e.type === 'key'),
          resolved.keystrokes.labels,
        );
  return {
    session,
    options: resolved,
    map,
    layout,
    times,
    camera,
    cursor,
    clicks: resolved.cursor.click.type === 'none' ? [] : clickMarks(events),
    spotlights: resolved.spotlight.enabled
      ? events.filter((e): e is TimedEvent<SpotlightEvent> => e.type === 'spotlight')
      : [],
    captions: cues,
    subtitles,
    keys,
    urls: events.filter((e): e is TimedEvent<UrlEvent> => e.type === 'url'),
    band,
    bandOpen: bandTrack(times, groups),
    frameIndex,
  };
}

/**
 * Subtitle pages of the captions: lines take most of the width of a vertical video, and
 * no more than a short phrase in a wide one.
 */
function subtitleCues(
  options: ResolvedOptions,
  captions: TimedEvent<CaptionEvent>[],
): SubtitleCue[] {
  const fontSize = options.captions.fontSize * options.unit;
  const maxWidth = Math.min(SUBTITLE_WIDTH * options.size.width, SUBTITLE_EMS * fontSize);
  const measure = subtitleMeasure(options.captions.fontFamily);
  return planSubtitles(captions, (text) => paginate(text, measure, maxWidth, fontSize));
}

/**
 * Region of a zoomed shot in a video with subtitles: the part of the output (of the frame
 * box in crop mode) on the other side of the subtitles. A zoom puts its focus there, so
 * that the subtitles do not cover the subject.
 */
function clearOfSubtitles(options: ResolvedOptions, layout: Layout): FitRegion {
  const { width: W, height: H } = options.size;
  const c = layout.content;
  const crop = options.zoom.mode === 'crop';
  const zone = subtitleZone(
    options.size,
    options.captions.position,
    options.captions.fontSize * layout.unit,
  );
  let top = crop ? c.y : 0;
  let bottom = crop ? c.y + c.height : H;
  if (options.captions.position === 'top') top = Math.min(Math.max(top, zone.bottom), bottom);
  else bottom = Math.max(Math.min(bottom, zone.top), top);
  return {
    x: (crop ? c.width : W) / c.width,
    y: Math.max(bottom - top, c.height / 4) / c.height,
    dy: (c.y + c.height / 2 - (top + bottom) / 2) / layout.k,
  };
}

/**
 * Region a fit zoom fills, relative to the rest frame: the frame box in crop mode; the
 * whole output minus the open part of the caption band in camera mode.
 */
function fitRegion(
  options: ResolvedOptions,
  layout: Layout,
  band: BandLayout | null,
  open: number,
): FitRegion {
  if (options.zoom.mode === 'crop') return { x: 1, y: 1 };
  const { width: W, height: H } = options.size;
  const scale = stageAt(band, open).scale;
  let height = H;
  if (band && open > 0) {
    const edge = band.side === 'bottom' ? H - (band.window.y + band.window.height) : band.window.y;
    height -= edge * open;
  }
  return {
    x: W / (scale * layout.content.width),
    y: height / (scale * layout.content.height),
  };
}

/**
 * Output pixels per CSS pixel of the page at output frame `i`.
 */
export function contentScale(scene: Scene, i: number): number {
  const stage = stageAt(scene.band, scene.bandOpen[i]).scale;
  return scene.layout.k * stage * scene.camera.scale[i];
}

/**
 * Source frames that output frames `from` to `to` draw from the rest image, in order.
 */
export function restFrameIndices(scene: Scene, from: number, to: number): number[] {
  const width = scene.session.frameSize.width;
  const indices: number[] = [];
  for (let i = from; i < to; i++) {
    const index = scene.frameIndex[i];
    if (indices.at(-1) === index) continue;
    if (useRestImage(scene.layout, width, contentScale(scene, i))) indices.push(index);
  }
  return indices;
}

type Input = Omit<FrameInput, 'image' | 'rest'>;

const CAMERA_SAMPLES = 20;
const CURSOR_SAMPLES = 96;

/**
 * Value of a per-frame track `delta` frames away from frame i (|delta| <= 1).
 */
function at(track: ArrayLike<number>, i: number, delta: number): number {
  const j = delta < 0 ? Math.max(0, i - 1) : Math.min(track.length - 1, i + 1);
  return track[i] + (track[j] - track[i]) * Math.abs(delta);
}

/**
 * Cursor coordinate `delta` frames from frame i (|delta| <= 1) on a Catmull-Rom curve
 * through the frame positions, so sub-frame samples follow the real, curved path.
 */
function cursorAt(track: ArrayLike<number>, i: number, delta: number): number {
  const k = delta < 0 ? i - 1 : i;
  const u = delta < 0 ? 1 + delta : delta;
  const p = (j: number) => track[Math.min(track.length - 1, Math.max(0, j))];
  const [p0, p1, p2, p3] = [p(k - 1), p(k), p(k + 1), p(k + 2)];
  return (
    p1 + 0.5 * u * (p2 - p0 + u * (2 * p0 - 5 * p1 + 4 * p2 - p3 + u * (3 * (p1 - p2) + p3 - p0)))
  );
}

function cameraAt(scene: Scene, i: number, delta: number): CameraState {
  const c = scene.camera;
  return { scale: at(c.scale, i, delta), cx: at(c.cx, i, delta), cy: at(c.cy, i, delta) };
}

/**
 * Largest screen movement, in output pixels, of the visible content between two camera
 * states.
 */
function cameraTravel(
  scene: Scene,
  a: CameraState,
  b: CameraState,
  mid: CameraState,
  stageScale: number,
): number {
  const { width, height } = scene.session.viewport;
  const hw = width / (2 * mid.scale);
  const hh = height / (2 * mid.scale);
  let d = 0;
  for (const [x, y] of [
    [mid.cx - hw, mid.cy - hh],
    [mid.cx + hw, mid.cy - hh],
    [mid.cx - hw, mid.cy + hh],
    [mid.cx + hw, mid.cy + hh],
  ]) {
    const dx = (x - a.cx) * a.scale - (x - b.cx) * b.scale;
    const dy = (y - a.cy) * a.scale - (y - b.cy) * b.scale;
    d = Math.max(d, Math.hypot(dx, dy));
  }
  return d * scene.layout.k * stageScale;
}

/**
 * Sub-frame offsets (in frames) spread over the shutter, or [0] when the movement
 * is too small to blur.
 */
function shutterOffsets(travel: number, shutter: number, pixelsPerSample: number, max: number) {
  const n = Math.min(max, Math.ceil(travel / pixelsPerSample));
  if (shutter <= 0 || n < 3) return [0];
  return Array.from({ length: n }, (_, j) => (j / (n - 1) - 0.5) * shutter);
}

/**
 * Compositor inputs for output frame `i`, without the source image. More than one input
 * means camera motion blur: the compositor averages them.
 */
export function frameInputs(scene: Scene, i: number): Input[] {
  const base = frameInput(scene, i);
  const zoomBlur = Math.min(1, Math.max(0, scene.options.zoom.motionBlur));
  if (zoomBlur > 0) {
    const h = zoomBlur / 2;
    const travel = cameraTravel(
      scene,
      cameraAt(scene, i, -h),
      cameraAt(scene, i, h),
      base.camera,
      base.stage.scale,
    );
    const offsets = shutterOffsets(travel, zoomBlur, 2, CAMERA_SAMPLES);
    if (offsets.length > 1) {
      return offsets.map((delta) => ({
        ...base,
        camera: cameraAt(scene, i, delta),
        cursor: base.cursor && {
          ...base.cursor,
          x: at(scene.cursor.x, i, delta),
          y: at(scene.cursor.y, i, delta),
        },
      }));
    }
  }
  const cursorBlur = Math.min(1, Math.max(0, scene.options.cursor.motionBlur));
  if (cursorBlur > 0 && base.cursor) {
    const c = scene.cursor;
    const px = scene.layout.k * base.stage.scale * base.camera.scale;
    const point = (delta: number) => ({ x: cursorAt(c.x, i, delta), y: cursorAt(c.y, i, delta) });
    let travel = 0;
    let last = point(-cursorBlur / 2);
    for (let j = 1; j <= 8; j++) {
      const next = point(cursorBlur * (j / 8 - 0.5));
      travel += Math.hypot(next.x - last.x, next.y - last.y) * px;
      last = next;
    }
    const offsets = shutterOffsets(travel, cursorBlur, 1, CURSOR_SAMPLES);
    if (offsets.length > 1) base.cursorTrail = offsets.map(point);
  }
  return [base];
}

/**
 * Compositor input for output frame `i`, without the source image or motion blur.
 */
export function frameInput(scene: Scene, i: number): Input {
  const t = scene.times[i];
  const c = scene.cursor;
  const cursor: CursorFrame | null =
    c.opacity[i] > 0
      ? {
          x: c.x[i],
          y: c.y[i],
          style: c.style[i],
          previousStyle: c.previousStyle[i],
          styleMix: c.styleMix[i],
          press: c.press[i],
          opacity: c.opacity[i],
          angle: c.angle[i],
        }
      : null;
  const duration = scene.options.cursor.click.duration;
  const band = scene.bandOpen[i];
  return {
    t,
    band,
    stage: stageAt(scene.band, band),
    camera: { scale: scene.camera.scale[i], cx: scene.camera.cx[i], cy: scene.camera.cy[i] },
    cursor,
    clicks: scene.clicks
      .filter((m) => t >= m.out && t < m.out + duration)
      .map((mark) => ({ mark, age: t - mark.out })),
    spotlights: scene.spotlights
      .map((event) => ({ event, amount: spotlightAmount(event, t) }))
      .filter((s) => s.amount > 0),
    captions: scene.captions.filter((c) => t >= c.textIn && t <= c.textOut + 250),
    subtitles: scene.subtitles.filter((cue) => subtitleVisible(cue, t)),
    keys: scene.keys.filter((k) => keyCueVisible(k, t)),
    address:
      scene.options.frame.chrome === 'browser'
        ? addressAt(scene.urls, t, scene.options.frame)
        : undefined,
  };
}
