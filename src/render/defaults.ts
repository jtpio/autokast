import path from 'node:path';
import type {
  BackgroundOptions,
  EasingName,
  EncodeOptions,
  FollowMode,
  RenderOptions,
  Session,
  Size,
} from '../types.ts';
import { RENDER_PRESETS } from './presets.ts';

export interface ResolvedShadow {
  color: string;
  blur: number;
  offsetY: number;
}

export interface ResolvedAutoZoom {
  scale: number;
  hold: number;
  mergeWindow: number;
}

/**
 * Render options with every default filled in. Pixel values are for a 1080-pixel output;
 * the compositor scales them with `unit`.
 */
export interface ResolvedOptions {
  output: string;
  format: 'mp4' | 'webm' | 'gif';
  size: Size;
  fps: number;
  /**
   * Scale of pixel-valued options: the short side of the output over 1080.
   */
  unit: number;
  background: BackgroundOptions;
  frame: {
    padding: number;
    radius: number;
    shadow: ResolvedShadow | false;
    chrome: 'none' | 'window' | 'browser';
    title: string;
    chromeTheme: 'light' | 'dark';
    address: boolean | string;
    origin: string;
  };
  cursor: {
    visible: boolean;
    size: number;
    smoothing: number;
    pressScale: number;
    hideAfter: number;
    motionBlur: number;
    tilt: number;
    click: { type: 'ripple' | 'ring' | 'none'; color: string; size: number; duration: number };
  };
  zoom: {
    enabled: boolean;
    auto: ResolvedAutoZoom | false;
    mode: 'camera' | 'crop';
    edges: 'fill' | 'keep';
    maxScale: number;
    duration: number;
    easing: EasingName;
    follow: FollowMode;
    followSpeed: number;
    levels: Record<string, number>;
    motionBlur: number;
  };
  captions: {
    enabled: boolean;
    style: 'line' | 'subtitles';
    position: 'bottom' | 'top';
    fontSize: number;
    fontFamily: string;
    highlight: string[];
  };
  voice: { enabled: boolean; voiceId: string; model: string; speed: number };
  spotlight: { enabled: boolean };
  keystrokes: {
    show: 'none' | 'shortcuts' | 'all';
    position: 'bottom' | 'top';
    size: number;
    labels: 'mac' | 'pc';
  };
  encode: Required<Omit<EncodeOptions, 'ffmpegPath' | 'crf' | 'preset'>> & EncodeOptions;
  range: { start: number; end: number };
  onProgress?: (done: number, total: number) => void;
}

const DEFAULT_BACKGROUND = 'dusk';

const DEFAULT_SHADOW: ResolvedShadow = {
  color: 'rgba(8, 10, 18, 0.6)',
  blur: 72,
  offsetY: 30,
};

const DEFAULT_AUTO_ZOOM: ResolvedAutoZoom = { scale: 1.8, hold: 1500, mergeWindow: 2500 };

/**
 * Font size of each caption style, for a 1080-pixel output.
 */
const CAPTION_FONT_SIZE = { line: 40, subtitles: 64 };

const DEFAULT_HIGHLIGHT = ['#ffd84a', '#5fe08a', '#5cc8ff', '#ff8fb8'];

const DEFAULTS = {
  size: { width: 1920, height: 1080 },
  vertical: false,
  fps: 60,
  background: DEFAULT_BACKGROUND as BackgroundOptions | string,
  frame: {
    padding: 0.07,
    radius: 16,
    shadow: DEFAULT_SHADOW as ResolvedShadow | false,
    chrome: 'none',
    title: '',
    chromeTheme: 'light',
    address: true,
    origin: '',
  },
  cursor: {
    visible: true,
    size: 1.9,
    smoothing: 0.3,
    pressScale: 0.82,
    hideAfter: 0,
    motionBlur: 0.5,
    tilt: 1,
    click: { type: 'ripple', color: 'auto', size: 26, duration: 520 },
  },
  zoom: {
    enabled: true,
    auto: false as boolean | ResolvedAutoZoom,
    mode: 'camera',
    edges: 'fill',
    maxScale: 3,
    duration: 900,
    easing: 'smooth',
    follow: 'edge',
    followSpeed: 1,
    levels: { wide: 1.3, medium: 1.6, close: 2.2 } as Record<string, number>,
    motionBlur: 0,
  },
  captions: {
    enabled: true,
    style: 'line',
    position: 'bottom',
    fontSize: undefined as number | undefined,
    fontFamily: 'Inter Display',
    highlight: DEFAULT_HIGHLIGHT as string | string[],
  },
  voice: {
    enabled: false,
    voiceId: 'TX3LPaxmHKxFdv7VOQHJ',
    model: 'eleven_multilingual_v2',
    speed: 1,
  },
  spotlight: { enabled: true },
  keystrokes: {
    show: 'none',
    position: 'bottom',
    size: 1,
    labels: process.platform === 'darwin' ? 'mac' : 'pc',
  },
  encode: { quality: 'standard', pixelFormat: 'yuv420p' },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges plain objects. Arrays and other values replace; `undefined` is skipped.
 */
export function deepMerge<T>(base: T, ...layers: unknown[]): T {
  let result: unknown = base;
  for (const layer of layers) result = mergeTwo(result, layer);
  return result as T;
}

function mergeTwo(base: unknown, layer: unknown): unknown {
  if (layer === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(layer)) return layer;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    if (key === 'background' || key === 'onProgress' || key === 'range') {
      if (value !== undefined) out[key] = value;
    } else {
      out[key] = mergeTwo(base[key], value);
    }
  }
  return out;
}

/**
 * Returns one level of render options with its preset under the other options of the level.
 */
export function applyPreset(options: RenderOptions | undefined): RenderOptions | undefined {
  const name = options?.preset;
  if (name === undefined) return options;
  if (!Object.hasOwn(RENDER_PRESETS, name)) {
    const names = Object.keys(RENDER_PRESETS).join(', ');
    throw new Error(`Unknown preset "${name}". Use one of: ${names}`);
  }
  return deepMerge(RENDER_PRESETS[name], options);
}

const IMAGE_FILE = /\.(png|jpe?g|webp|avif|gif|svg)$/i;

/**
 * Turns a background string (preset name, image file or CSS color) into background options.
 */
export function normalizeBackground(
  value: BackgroundOptions | string,
  presets: readonly string[],
): BackgroundOptions {
  if (typeof value !== 'string') return value;
  if (presets.includes(value)) return { type: 'preset', name: value };
  if (IMAGE_FILE.test(value)) return { type: 'image', path: value };
  return { type: 'solid', color: value };
}

/**
 * The size with its long side vertical.
 */
function verticalSize(size: Size): Size {
  return size.width > size.height ? { width: size.height, height: size.width } : size;
}

function evenSize(size: Size, pixelFormat: string): Size {
  const round = (v: number) => Math.max(2, Math.round(v));
  const w = round(size.width);
  const h = round(size.height);
  if (!/^yuv4[12][02]/.test(pixelFormat)) return { width: w, height: h };
  return { width: w + (w % 2), height: h + (h % 2) };
}

/**
 * Resolves render options: defaults, then the session's options, then `options`. A preset
 * applies at its own level, under the other options of that level.
 */
export function resolveOptions(
  session: Session,
  options: RenderOptions | undefined,
  presets: readonly string[],
  outputDuration: number,
): ResolvedOptions {
  const merged = deepMerge(
    DEFAULTS,
    applyPreset(session.render),
    applyPreset(options),
  ) as typeof DEFAULTS & RenderOptions;
  const output = path.resolve(merged.output ?? `${session.name || 'autokast'}.mp4`);
  const ext = path.extname(output).toLowerCase();
  const format = ext === '.webm' ? 'webm' : ext === '.gif' ? 'gif' : 'mp4';
  const encode = merged.encode as ResolvedOptions['encode'];
  const size = evenSize(
    merged.vertical ? verticalSize(merged.size) : merged.size,
    encode.pixelFormat,
  );
  const captions = merged.captions;
  if (captions.style !== 'line' && captions.style !== 'subtitles') {
    throw new Error(`Unknown captions.style "${captions.style}". Use one of: line, subtitles`);
  }
  const highlight = [captions.highlight].flat().filter(Boolean);
  const fps = Math.min(240, Math.max(1, merged.fps));
  const auto = merged.zoom.auto;
  const shadow = merged.frame.shadow;
  const start = Math.max(0, merged.range?.start ?? 0);
  const end = Math.min(outputDuration, merged.range?.end ?? outputDuration);
  return {
    output,
    format,
    size,
    fps,
    unit: Math.min(size.width, size.height) / 1080,
    background: normalizeBackground(merged.background, presets),
    frame: {
      ...(merged.frame as ResolvedOptions['frame']),
      shadow: shadow === false ? false : { ...DEFAULT_SHADOW, ...(shadow as ResolvedShadow) },
    },
    cursor: merged.cursor as ResolvedOptions['cursor'],
    zoom: {
      ...(merged.zoom as ResolvedOptions['zoom']),
      auto: auto === true ? DEFAULT_AUTO_ZOOM : auto ? { ...DEFAULT_AUTO_ZOOM, ...auto } : false,
      maxScale: Math.max(1, merged.zoom.maxScale),
      followSpeed: Math.max(0.05, merged.zoom.followSpeed),
    },
    captions: {
      ...(captions as ResolvedOptions['captions']),
      fontSize: captions.fontSize ?? CAPTION_FONT_SIZE[captions.style],
      highlight: highlight.length ? highlight : DEFAULT_HIGHLIGHT,
    },
    voice: merged.voice,
    spotlight: merged.spotlight,
    keystrokes: merged.keystrokes as ResolvedOptions['keystrokes'],
    encode,
    range: { start, end: Math.max(start, end) },
    onProgress: merged.onProgress,
  };
}
