import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { render } from '../render/index.ts';
import { saveSession, SESSION_FILE } from '../session.ts';
import type {
  Cast,
  RecordedSession,
  RecordOptions,
  ScreencastDefinition,
  Session,
  SetupContext,
} from '../types.ts';
import { settleAnimations } from './animations.ts';
import { FRAMES_DIR, FrameCapture, type Capture } from './capture.ts';
import { Director } from './cast.ts';
import { CursorStyleProbe } from './cursor-style.ts';
import { mergeOptions, resolveOptions, type ResolvedOptions } from './defaults.ts';
import { FRAME_PERFECT_ARGS, FramePump, idleCallbacksOnTimers } from './frame-pump.ts';
import { FramePerfectPace, RealtimePace, type Pace } from './pace.ts';
import { Clock, Timeline } from './timeline.ts';

export const ERROR_SCREENSHOT = 'error.png';
const MAX_CAUSE_LINES = 25;
const SETTLE_TIMEOUT = 2000;

/**
 * Removes the output of a previous recording. Other files in the directory stay.
 */
async function prepareSessionDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all(
    [SESSION_FILE, ERROR_SCREENSHOT, FRAMES_DIR].map((name) =>
      rm(path.join(dir, name), { recursive: true, force: true }),
    ),
  );
}

/**
 * Page script: a press on a native `<select>` focuses it but does not open its list. The
 * browser draws the list outside the page, so the video cannot show it, and in
 * frame-perfect mode the open list stops the capture. `cast.select` chooses the options.
 */
function noSelectPopups(): void {
  addEventListener(
    'mousedown',
    (event) => {
      const target = event.composedPath()[0];
      const select = target instanceof Element ? target.closest('select') : null;
      if (select && !select.multiple && select.size <= 1) {
        event.preventDefault();
        select.focus();
      }
    },
    true,
  );
}

/**
 * Frame-perfect capture needs BeginFrame control, which only the headless shell has.
 */
function checkFramePerfect(options: ResolvedOptions): void {
  const { headless, channel, args = [] } = options.browser;
  const problem =
    headless === false
      ? 'a headed browser'
      : channel
        ? `the browser channel "${channel}"`
        : args.includes('--site-per-process')
          ? 'the --site-per-process flag'
          : undefined;
  if (problem) {
    throw new Error(
      `capture.mode "frame-perfect" needs the headless shell of Chromium (the default ` +
        `headless browser), and cannot use ${problem}. Remove that option, or use ` +
        `capture.mode "realtime".`,
    );
  }
}

function launch(options: ResolvedOptions): Promise<Browser> {
  const { contextOptions, args = [], ...launchOptions } = options.browser;
  const framePerfect = options.capture.mode === 'frame-perfect';
  return chromium.launch({
    headless: true,
    ...launchOptions,
    // Without this flag, the screencast frames have 1x resolution whatever the context scale.
    args: [
      `--force-device-scale-factor=${options.deviceScaleFactor}`,
      ...(framePerfect ? FRAME_PERFECT_ARGS : []),
      ...args,
    ],
  });
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2)} s`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Rounds every number in a JSON-like value to 0.01, to keep `session.json` small.
 */
function roundDeep<T>(value: T): T {
  if (typeof value === 'number') {
    return round(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map(roundDeep) as T;
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, roundDeep(item)]),
    ) as T;
  }
  return value;
}

function byTime<T extends { t: number }>(a: T, b: T): number {
  return a.t - b.t;
}

/**
 * Builds an actionable error: what failed, the page state, and a screenshot of the page.
 */
async function failure(
  page: Page | undefined,
  dir: string,
  headline: string,
  error: unknown,
  context: string[] = [],
): Promise<Error> {
  const cause = (error instanceof Error ? error.message : String(error)).split('\n');
  // The first line is a complete summary: the CLI repeats it at the end of its output.
  let summary = `${headline}: ${cause[0].trim().replace(/[.:]?$/, '.')}`;
  if (page) {
    const file = path.join(dir, ERROR_SCREENSHOT);
    try {
      await page.screenshot({ path: file, timeout: 5000 });
      summary += ` Screenshot: ${file}`;
    } catch (screenshotError) {
      summary += ` No screenshot: ${String(screenshotError).split('\n')[0]}`;
    }
  }
  if (cause.length > MAX_CAUSE_LINES) {
    const more = cause.length - MAX_CAUSE_LINES;
    cause.splice(MAX_CAUSE_LINES, more, `... ${more} more lines in error.cause`);
  }
  const lines = [
    summary,
    ...(page ? [`Page URL: ${page.url()}`] : []),
    ...context,
    `Cause: ${cause.join('\n')}`,
  ];
  return new Error(lines.join('\n'), { cause: error });
}

/**
 * Records a session: runs `setup` unrecorded, then captures `run`.
 */
export async function record(
  options: RecordOptions,
  run: (cast: Cast) => Promise<void>,
  setup?: (context: SetupContext) => Promise<void>,
): Promise<RecordedSession> {
  const opts = resolveOptions(options);
  const framePerfect = opts.capture.mode === 'frame-perfect';
  if (framePerfect) {
    checkFramePerfect(opts);
  }
  const dir = opts.sessionDir;
  const createdAt = new Date().toISOString();
  await prepareSessionDir(dir);
  const browser = await launch(opts);
  let pump: FramePump | undefined;
  try {
    const context = await browser.newContext({
      ...opts.browser.contextOptions,
      viewport: opts.viewport,
      deviceScaleFactor: opts.deviceScaleFactor,
      ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}),
    });
    const cursorStyle = new CursorStyleProbe();
    cursorStyle.pointer = opts.cursor.start;
    await cursorStyle.install(context);
    await context.addInitScript(noSelectPopups);
    if (framePerfect) {
      await context.addInitScript(idleCallbacksOnTimers);
    }
    const page = await context.newPage();
    if (framePerfect) {
      const { fps, clockLead, format, quality } = opts.capture;
      pump = await FramePump.create(context, page, dir, { fps, clockLead, format, quality });
      // With BeginFrame control the page paints only when it gets frames: page loads, rAF
      // and Playwright actions all wait for them.
      pump.startFreeRun();
    }

    if (opts.url) {
      try {
        await page.goto(opts.url);
      } catch (error) {
        throw await failure(page, dir, `Could not open ${opts.url} before the recording`, error);
      }
    }
    if (setup) {
      try {
        await setup({ page });
      } catch (error) {
        throw await failure(page, dir, 'The setup function failed (before the recording)', error);
      }
    }
    await page.mouse.move(opts.cursor.start.x, opts.cursor.start.y);
    await cursorStyle.refresh(page);
    // Frame 0 must not show a half-finished entrance animation or hover transition.
    await page.evaluate(settleAnimations, SETTLE_TIMEOUT).catch(() => 0);

    const frameSize = {
      width: Math.round(opts.viewport.width * opts.deviceScaleFactor),
      height: Math.round(opts.viewport.height * opts.deviceScaleFactor),
    };
    let capture: Capture;
    let pace: Pace;
    if (pump) {
      await pump.start();
      capture = pump;
      pace = new FramePerfectPace(pump);
    } else {
      const clock = new Clock();
      const screencast = await FrameCapture.create(context, page, dir);
      clock.start();
      await screencast.start(clock.origin, {
        format: opts.capture.format,
        quality: opts.capture.quality,
        maxWidth: frameSize.width,
        maxHeight: frameSize.height,
      });
      capture = screencast;
      pace = new RealtimePace(clock, () => screencast.refresh());
    }
    const timeline = new Timeline(pace);
    timeline.sample(opts.cursor.start, 0);
    timeline.push({ type: 'cursorStyle', t: 0, style: cursorStyle.style });
    cursorStyle.onChange = (style) => timeline.push({ type: 'cursorStyle', t: pace.now(), style });
    let address = page.url();
    timeline.push({ type: 'url', t: 0, url: address });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || frame.url() === address) return;
      address = frame.url();
      timeline.push({ type: 'url', t: pace.now(), url: address });
    });

    const director = new Director({ page, options: opts, timeline, pace, cursorStyle });
    let failed: Error | undefined;
    try {
      await pace.sleep(opts.pacing.startDelay);
      await run(director);
      await pace.sleep(opts.pacing.endDelay);
    } catch (error) {
      const call = director.failureOf(error);
      const headline = call
        ? `${call.call} failed at ${seconds(call.t)} (record time)`
        : `The run function failed at ${seconds(pace.now())} (record time)`;
      const context = [`Partial session up to the failure: ${dir}`];
      if (director.lastCall) {
        context.push(`Last successful call: ${director.lastCall}`);
      }
      // In frame-perfect mode the screenshot needs frames: the capture stops after it.
      failed = await failure(page, dir, headline, error, context);
    }
    const duration = pace.now();
    cursorStyle.onChange = undefined;
    try {
      await capture.stop(duration);
      if (capture.frames.length === 0 && capture instanceof FrameCapture) {
        const { format, quality } = opts.capture;
        const image = await page.screenshot(
          format === 'png' ? { type: 'png' } : { type: format, quality },
        );
        await capture.addFrame(image, 0);
      }
    } catch (error) {
      // A failed run must still save what it captured and report its own error.
      if (!failed) {
        throw error;
      }
    }
    await browser.close();

    const session: Session = {
      version: 1,
      name: opts.name,
      createdAt,
      viewport: opts.viewport,
      deviceScaleFactor: opts.deviceScaleFactor,
      captureMode: opts.capture.mode,
      frameSize: capture.frameSize ?? frameSize,
      duration: round(duration),
      frames: roundDeep(
        capture.frames.map((frame) => ({ ...frame, t: Math.min(frame.t, duration) })).sort(byTime),
      ),
      cursor: roundDeep([...timeline.cursor].sort(byTime)),
      events: roundDeep([...timeline.events].sort(byTime)),
      ...(opts.render ? { render: opts.render } : {}),
    };
    await saveSession(dir, session);
    if (failed) {
      throw failed;
    }
    return { dir, session, render: (renderOptions) => render(dir, renderOptions) };
  } finally {
    await pump?.stop().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Records a screencast definition. `overrides` replace fields of the definition; nested
 * objects such as `browser` or `cursor` merge.
 */
export async function recordScreencast(
  definition: ScreencastDefinition,
  overrides?: Partial<RecordOptions>,
): Promise<RecordedSession> {
  const { run, setup, ...options } = definition;
  return record(mergeOptions<RecordOptions>(options, overrides), run, setup);
}
