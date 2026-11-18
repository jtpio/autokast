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
import { FRAMES_DIR, FrameCapture } from './capture.ts';
import { Director } from './cast.ts';
import { CursorStyleProbe } from './cursor-style.ts';
import { mergeOptions, resolveOptions, type ResolvedOptions } from './defaults.ts';
import { Clock, sleep, Timeline } from './timeline.ts';

export const ERROR_SCREENSHOT = 'error.png';

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

function launch(options: ResolvedOptions): Promise<Browser> {
  const { headless, channel, executablePath, args = [], launchOptions = {} } = options.browser;
  return chromium.launch({
    ...launchOptions,
    headless: headless ?? launchOptions.headless ?? true,
    channel: channel ?? launchOptions.channel,
    executablePath: executablePath ?? launchOptions.executablePath,
    // Without this flag, the screencast frames have 1x resolution whatever the context scale.
    args: [
      `--force-device-scale-factor=${options.deviceScaleFactor}`,
      ...(launchOptions.args ?? []),
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
  const lines = [headline];
  if (page) {
    const file = path.join(dir, ERROR_SCREENSHOT);
    try {
      await page.screenshot({ path: file, timeout: 5000 });
      lines.push(`Screenshot of the page: ${file}`);
    } catch (screenshotError) {
      lines.push(`No screenshot: ${String(screenshotError).split('\n')[0]}`);
    }
    lines.push(`Page URL: ${page.url()}`);
  }
  lines.push(...context);
  lines.push(`Cause: ${error instanceof Error ? error.message : String(error)}`);
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
  const dir = opts.sessionDir;
  const createdAt = new Date().toISOString();
  await prepareSessionDir(dir);
  const browser = await launch(opts);
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
    const page = await context.newPage();

    if (opts.url) {
      try {
        await page.goto(opts.url);
      } catch (error) {
        throw await failure(page, dir, `Could not open ${opts.url} before the recording.`, error);
      }
    }
    if (setup) {
      try {
        await setup({ page });
      } catch (error) {
        throw await failure(page, dir, 'The setup function failed (before the recording).', error);
      }
    }
    await page.mouse.move(opts.cursor.start.x, opts.cursor.start.y);
    await cursorStyle.refresh(page);

    const frameSize = {
      width: Math.round(opts.viewport.width * opts.deviceScaleFactor),
      height: Math.round(opts.viewport.height * opts.deviceScaleFactor),
    };
    const clock = new Clock();
    const timeline = new Timeline(clock);
    const capture = await FrameCapture.create(context, page, dir);
    clock.start();
    await capture.start(clock.origin, {
      format: opts.capture.format,
      quality: opts.capture.quality,
      maxWidth: frameSize.width,
      maxHeight: frameSize.height,
    });
    timeline.sample(opts.cursor.start, 0);
    timeline.push({ type: 'cursorStyle', t: 0, style: cursorStyle.style });
    cursorStyle.onChange = (style) => timeline.push({ type: 'cursorStyle', t: clock.now(), style });

    const director = new Director({ page, options: opts, timeline, cursorStyle });
    let failed: Error | undefined;
    try {
      await sleep(opts.pacing.startDelay);
      await run(director);
      await sleep(opts.pacing.endDelay);
    } catch (error) {
      const call = director.failureOf(error);
      const headline = call
        ? `${call.call} failed at ${seconds(call.t)} (record time).`
        : `The run function failed at ${seconds(clock.now())} (record time).`;
      const context = [`Partial session up to the failure: ${dir}`];
      if (director.lastCall) {
        context.push(`Last successful call: ${director.lastCall}`);
      }
      failed = await failure(page, dir, headline, error, context);
    }
    const duration = clock.now();
    cursorStyle.onChange = undefined;
    try {
      await capture.stop(duration);
      if (capture.frames.length === 0) {
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
      ...(opts.url ? { url: opts.url } : {}),
      viewport: opts.viewport,
      deviceScaleFactor: opts.deviceScaleFactor,
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
