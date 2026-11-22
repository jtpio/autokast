import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSession } from '../session.ts';
import type { RenderOptions, RenderResult, Session } from '../types.ts';
import { BACKGROUND_PRESETS, createBackground } from './background.ts';
import { Compositor, restImageSize } from './compositor.ts';
import { resolveOptions } from './defaults.ts';
import {
  checkFfmpeg,
  encoderArgs,
  FfmpegProcess,
  ffmpegPath,
  gifArgs,
  gifSettings,
  runFfmpeg,
} from './encoder.ts';
import { RENDER_PRESETS } from './presets.ts';
import { buildScene, frameInput, frameInputs, restFrameIndices, type Scene } from './scene.ts';
import { sharpnessWarning } from './sharpness.ts';
import { FrameSource, RestFrames, upcomingFrames } from './source.ts';
import { frameIndexAt, sessionTimeMap } from './timeline.ts';
import { loadSpeech, VOICE_DIR, voiceTrack } from './voice.ts';

export { BACKGROUND_PRESETS, RENDER_PRESETS };

/**
 * Output duration of a session in milliseconds, after cuts and speed changes.
 */
export function outputDuration(session: Session): number {
  return sessionTimeMap(session).duration;
}

/**
 * Output time (ms) of a record time. A time inside a cut maps to the cut point.
 */
export function toOutputTime(session: Session, recordTime: number): number {
  return sessionTimeMap(session).toOutput(recordTime);
}

/**
 * Builds the scene. When the options ask for the voice, the scene has the speech of the
 * captions, which this function gets first. A GIF has no sound, so it gets no voice.
 */
async function buildVoicedScene(
  sessionDir: string,
  session: Session,
  options?: RenderOptions,
  extraTime?: number,
): Promise<Scene> {
  const { voice, format } = resolveOptions(
    session,
    options,
    BACKGROUND_PRESETS,
    outputDuration(session),
  );
  if (!voice.enabled || format === 'gif') return buildScene(session, options, extraTime);
  const texts = session.events.flatMap((event) => (event.type === 'caption' ? [event.text] : []));
  const speech = await loadSpeech(path.join(sessionDir, VOICE_DIR), texts, voice);
  return buildScene(session, options, extraTime, speech);
}

/**
 * Compositor and frame sources for output frames `from` to `to`.
 */
async function setup(sessionDir: string, scene: Scene, from: number, to: number) {
  const { options, layout, session } = scene;
  const background = await createBackground(options.background, options.size, options.unit);
  return {
    compositor: new Compositor(options, layout, background, scene.band),
    source: new FrameSource(sessionDir, session.frames),
    rest: new RestFrames(
      sessionDir,
      session.frames,
      restFrameIndices(scene, from, to),
      restImageSize(layout, session.frameSize),
      ffmpegPath(options),
    ),
  };
}

function nearestFrame(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

async function drawFrame(
  scene: Scene,
  compositor: Compositor,
  source: FrameSource,
  rest: RestFrames,
  i: number,
): Promise<void> {
  const index = scene.frameIndex[i];
  const [image, restImage] = await Promise.all([source.get(index), rest.get(index)]);
  source.retain(index, upcomingFrames(scene.frameIndex, i, 4));
  const inputs = frameInputs(scene, i).map((input) => ({ ...input, image, rest: restImage }));
  for (const { mark } of inputs[0].clicks) {
    if (!compositor.needsClickColor(mark)) continue;
    const frame = frameIndexAt(scene.session.frames, mark.t);
    compositor.prepareClick(mark, frame === index ? image : await source.get(frame));
  }
  for (const cue of inputs[0].keys) {
    if (!compositor.needsKeyTheme(cue)) continue;
    const j = nearestFrame(scene.times, cue.appear);
    const frame = scene.frameIndex[j];
    const behind = frame === index ? image : await source.get(frame);
    compositor.prepareKeys(cue, { ...frameInput(scene, j), image: behind });
  }
  if (inputs.length > 1) compositor.drawBlurred(inputs);
  else compositor.draw(inputs[0]);
}

/**
 * Renders a recorded session to a video file.
 */
export async function render(sessionDir: string, options?: RenderOptions): Promise<RenderResult> {
  const session = await loadSession(sessionDir);
  let scene = await buildVoicedScene(sessionDir, session, options);
  const format = scene.options.format;
  if (format === 'gif') {
    const gif = gifSettings(scene.options.size, scene.options.fps);
    if (gif.fps !== scene.options.fps) scene = buildScene(session, { ...options, fps: gif.fps });
  }
  const { options: opts, times } = scene;
  const binary = ffmpegPath(opts);
  await checkFfmpeg(binary);
  await mkdir(path.dirname(opts.output), { recursive: true });

  let first = 0;
  while (first < times.length && times[first] < opts.range.start) first++;
  let last = first;
  while (last < times.length && times[last] < opts.range.end) last++;
  const total = last - first;

  const warnings = [sharpnessWarning(scene, first, last), ...scene.voiceWarnings];
  if (format === 'gif' && opts.voice.enabled) {
    warnings.push('A GIF has no sound: the voice is not in this file.');
  }
  const audio =
    total > 0
      ? voiceTrack(scene.voice, times[first], times[first] + (total * 1000) / opts.fps)
      : null;
  const { compositor, source, rest } = await setup(sessionDir, scene, first, last);
  const temp = format === 'gif' ? await mkdtemp(path.join(os.tmpdir(), 'autokast-')) : null;
  const target = temp ? path.join(temp, 'frames.mkv') : opts.output;
  const encoder = new FfmpegProcess(
    binary,
    encoderArgs(
      temp ? 'mkv' : format === 'webm' ? 'webm' : 'mp4',
      opts.size,
      opts.fps,
      opts.encode,
      target,
      audio,
    ),
  );
  try {
    for (let i = first; i < last; i++) {
      await drawFrame(scene, compositor, source, rest, i);
      await encoder.write(compositor.canvas.data());
      opts.onProgress?.(i - first + 1, total);
    }
    await encoder.finish();
    if (temp) {
      const gif = gifSettings(opts.size, opts.fps);
      await runFfmpeg(binary, gifArgs(target, opts.output, gif.fps, gif.width));
    }
  } catch (error) {
    encoder.kill();
    throw error;
  } finally {
    rest.close();
    if (temp) await rm(temp, { recursive: true, force: true });
  }

  let size = opts.size;
  if (format === 'gif') {
    const width = gifSettings(opts.size, opts.fps).width;
    size = { width, height: Math.round((opts.size.height * width) / opts.size.width) };
  }
  return {
    output: opts.output,
    duration: (total * 1000) / opts.fps,
    frames: total,
    size,
    fps: opts.fps,
    warnings: warnings.filter((warning) => warning !== undefined),
  };
}

/**
 * Renders one still frame at an output time (milliseconds) and returns a PNG.
 */
export async function renderFrame(
  sessionDir: string,
  time: number,
  options?: RenderOptions,
): Promise<Buffer> {
  const session = await loadSession(sessionDir);
  const scene = await buildVoicedScene(sessionDir, session, options, Math.max(0, time));
  const i = scene.times.indexOf(Math.max(0, time));
  const { compositor, source, rest } = await setup(sessionDir, scene, i, i + 1);
  try {
    await drawFrame(scene, compositor, source, rest, i);
  } finally {
    rest.close();
  }
  return compositor.canvas.encode('png');
}
