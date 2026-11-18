import path from 'node:path';
import type {
  BrowserOptions,
  CaptureOptions,
  CursorMotionOptions,
  PacingOptions,
  RecordOptions,
  RenderOptions,
  Size,
  TypingOptions,
} from '../types.ts';
import { hashString } from './random.ts';

/**
 * Default record options.
 */
export const DEFAULTS = {
  name: 'screencast',
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 2,
  capture: { format: 'jpeg', quality: 92 },
  cursor: { speed: 1, curvature: 0.2, minDuration: 250, maxDuration: 1200 },
  typing: { delay: 55, variance: 0.35 },
  pacing: {
    startDelay: 600,
    endDelay: 1200,
    beforeClick: 100,
    afterClick: 350,
    afterType: 250,
    pressDuration: 90,
  },
  scrollBehavior: 'smooth',
  timeout: 10_000,
} as const;

/**
 * Defaults of the Cast calls, in milliseconds.
 */
export const CAST_DEFAULTS = {
  hoverHold: 600,
  zoomDuration: 900,
  spotlightDuration: 2000,
  captionBase: 1500,
  captionPerChar: 55,
  dragHold: 150,
  doubleClickGap: 70,
};

/**
 * Record options with every default applied.
 */
export interface ResolvedOptions {
  name: string;
  url?: string;
  viewport: Size;
  deviceScaleFactor: number;
  colorScheme?: 'light' | 'dark';
  sessionDir: string;
  browser: BrowserOptions;
  capture: Required<CaptureOptions>;
  cursor: Required<CursorMotionOptions>;
  typing: Required<TypingOptions>;
  pacing: Required<PacingOptions>;
  scrollBehavior: 'smooth' | 'instant';
  timeout: number;
  seed: number;
  render?: RenderOptions;
}

function check(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Invalid record options: ${message}`);
  }
}

/**
 * Applies the defaults to record options and validates them.
 */
export function resolveOptions(options: RecordOptions = {}): ResolvedOptions {
  const name = options.name ?? DEFAULTS.name;
  const viewport = { ...DEFAULTS.viewport, ...options.viewport };
  const deviceScaleFactor = options.deviceScaleFactor ?? DEFAULTS.deviceScaleFactor;
  const capture = { ...DEFAULTS.capture, ...options.capture };
  const cursor = {
    start: { x: viewport.width / 2, y: viewport.height / 2 },
    ...DEFAULTS.cursor,
    ...options.cursor,
  };
  const typing = { ...DEFAULTS.typing, ...options.typing };
  const pacing = { ...DEFAULTS.pacing, ...options.pacing };
  const timeout = options.timeout ?? DEFAULTS.timeout;
  const safeName = name.replace(/[^\w.-]+/g, '-').replace(/^\.+/, '') || DEFAULTS.name;

  check(
    Number.isInteger(viewport.width) && Number.isInteger(viewport.height),
    `viewport must have integer width and height, got ${JSON.stringify(options.viewport)}`,
  );
  check(viewport.width > 0 && viewport.height > 0, 'viewport width and height must be above 0');
  check(deviceScaleFactor > 0, `deviceScaleFactor must be above 0, got ${deviceScaleFactor}`);
  check(capture.quality >= 0 && capture.quality <= 100, 'capture.quality must be 0-100');
  check(cursor.speed > 0, `cursor.speed must be above 0, got ${cursor.speed}`);
  check(cursor.minDuration <= cursor.maxDuration, 'cursor.minDuration > cursor.maxDuration');
  check(typing.delay >= 0, 'typing.delay must not be negative');
  check(timeout > 0, `timeout must be above 0 ms, got ${timeout}`);

  return {
    name,
    url: options.url,
    viewport,
    deviceScaleFactor,
    colorScheme: options.colorScheme,
    sessionDir: path.resolve(options.sessionDir ?? path.join('.autocast', safeName)),
    browser: options.browser ?? {},
    capture,
    cursor,
    typing,
    pacing,
    scrollBehavior: options.scrollBehavior ?? DEFAULTS.scrollBehavior,
    timeout,
    seed: options.seed ?? hashString(name),
    render: options.render,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep-merges `overrides` into `base`. Plain objects merge; other values replace.
 * Undefined values in `overrides` are ignored.
 */
export function mergeOptions<T extends object>(base: T, overrides?: Partial<T>): T {
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) {
      continue;
    }
    const current = result[key];
    result[key] =
      isPlainObject(current) && isPlainObject(value) ? mergeOptions(current, value) : value;
  }
  return result as T;
}
