import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CaptionEvent } from '../types.ts';
import { parseCaption } from './captions.ts';
import type { ResolvedOptions } from './defaults.ts';
import type { TimedEvent } from './timeline.ts';

/**
 * Directory of the speech clips, in the session directory. A clip is made once: a new
 * recording or render of the same text with the same voice uses it again.
 */
export const VOICE_DIR = 'voice';

export const VOICE_KEY = 'ELEVENLABS_API_KEY';

const API = 'https://api.elevenlabs.io/v1/text-to-speech';
const FORMAT = 'mp3_44100_128';
const BITRATE = 128_000;

/**
 * Timing of the voice, in output milliseconds: the time between a caption and its
 * voice, the silence between two captions, and the time a caption stays after its voice.
 */
const VOICE_LEAD = 200;
const VOICE_GAP = 250;
export const VOICE_HOLD = 400;

/**
 * A voice that starts later than this after its place gives a warning: a shorter time
 * has no effect that a viewer can see.
 */
const VOICE_LATE = 150;

/**
 * The speech of one caption. Times are milliseconds from the start of the audio, and
 * `words` has one entry for each word of the text.
 */
export interface SpeechClip {
  file: string;
  duration: number;
  words: { start: number; end: number }[];
}

/**
 * A speech clip in the video: its audio starts at the output time `at`.
 */
export interface VoiceCue {
  clip: SpeechClip;
  at: number;
  end: number;
}

interface Alignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/**
 * The text of a caption as it is said: its words, without the `**` marks.
 */
export function spokenText(text: string): string {
  return parseCaption(text)
    .map((word) => word.text)
    .join(' ');
}

/**
 * Start and end of each word of `text`, from the time of each character. When the
 * characters do not give the words of the text, each word gets a share of `duration`
 * for its length.
 */
export function wordTimes(
  text: string,
  alignment: Alignment | null | undefined,
  duration: number,
): SpeechClip['words'] {
  const expected = text.split(' ');
  const words: SpeechClip['words'] = [];
  let open = false;
  alignment?.characters.forEach((character, i) => {
    if (!character.trim()) {
      open = false;
      return;
    }
    const start = alignment.character_start_times_seconds[i] * 1000;
    const end = alignment.character_end_times_seconds[i] * 1000;
    if (open) words[words.length - 1].end = end;
    else words.push({ start, end });
    open = true;
  });
  if (words.length === expected.length) return words;
  const total = expected.reduce((sum, word) => sum + word.length + 1, 0);
  let at = 0;
  return expected.map((word) => {
    const start = at;
    at += ((word.length + 1) / total) * duration;
    return { start, end: at };
  });
}

/**
 * Asks ElevenLabs for the speech of `text`, with the time of each character.
 */
async function requestSpeech(
  text: string,
  voice: ResolvedOptions['voice'],
  key: string,
): Promise<{ audio: Buffer; alignment: Alignment | null }> {
  const body = {
    text,
    model_id: voice.model,
    ...(voice.speed === 1 ? {} : { voice_settings: { speed: voice.speed } }),
  };
  const url = `${API}/${encodeURIComponent(voice.voiceId)}/with-timestamps?output_format=${FORMAT}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const cause = error instanceof Error ? ((error.cause as Error)?.message ?? error.message) : '';
    throw new Error(`The voice needs the ElevenLabs API, and the request failed: ${cause}`);
  }
  const data = (await response.json().catch(() => null)) as {
    audio_base64?: string;
    alignment?: Alignment | null;
    detail?: { message?: string } | string;
  } | null;
  if (!response.ok || !data?.audio_base64) {
    const detail = typeof data?.detail === 'string' ? data.detail : data?.detail?.message;
    // ElevenLabs can remove a voice, also one of its default voices.
    const hint =
      response.status === 404 ? ' Set voice.voiceId to the id of a voice of your account.' : '';
    throw new Error(
      `ElevenLabs did not give the voice of "${text}" (status ${response.status})` +
        (detail ? `: ${detail}` : '.') +
        hint,
    );
  }
  return { audio: Buffer.from(data.audio_base64, 'base64'), alignment: data.alignment ?? null };
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

/**
 * Returns the speech clip of each caption text, by its spoken text. The clips that are
 * not in `dir` yet come from the ElevenLabs API, which needs the `ELEVENLABS_API_KEY`
 * environment variable.
 */
export async function loadSpeech(
  dir: string,
  texts: string[],
  voice: ResolvedOptions['voice'],
): Promise<Map<string, SpeechClip>> {
  const clips = new Map<string, SpeechClip>();
  for (const text of new Set(texts.map(spokenText).filter(Boolean))) {
    const id = createHash('sha1')
      .update(JSON.stringify([voice.voiceId, voice.model, voice.speed, text]))
      .digest('hex')
      .slice(0, 16);
    const file = path.join(dir, `${id}.mp3`);
    const meta = path.join(dir, `${id}.json`);
    const saved = await readFile(meta, 'utf8').then(JSON.parse, () => null);
    if (saved && (await exists(file))) {
      clips.set(text, { file, duration: saved.duration, words: saved.words });
      continue;
    }
    const key = process.env[VOICE_KEY];
    if (!key) {
      throw new Error(
        `The voice option needs an ElevenLabs API key: set the ${VOICE_KEY} environment variable.`,
      );
    }
    const { audio, alignment } = await requestSpeech(text, voice, key);
    const said = (alignment?.character_end_times_seconds.at(-1) ?? 0) * 1000;
    const duration = Math.max(said, (audio.length * 8000) / BITRATE);
    const words = wordTimes(text, alignment, duration);
    await mkdir(dir, { recursive: true });
    await writeFile(file, audio);
    await writeFile(meta, JSON.stringify({ text, ...voice, duration, words }));
    clips.set(text, { file, duration, words });
  }
  return clips;
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * Puts the speech of each caption in the video, for captions in time order. A voice
 * starts just after its caption, and never before the voice of the caption before it
 * ends: that caption then comes late, and the result has a warning. `cues` has one entry
 * for each caption.
 */
export function planVoice(
  captions: TimedEvent<CaptionEvent>[],
  clips: Map<string, SpeechClip>,
  duration: number,
): { cues: (VoiceCue | undefined)[]; warnings: string[] } {
  const warnings: string[] = [];
  let free = 0;
  const cues = captions.map((caption) => {
    const clip = clips.get(spokenText(caption.text));
    if (!clip) return undefined;
    const wanted = caption.out + VOICE_LEAD;
    const at = Math.max(wanted, free);
    if (at > wanted + VOICE_LATE) {
      warnings.push(
        `The voice of the caption at ${seconds(caption.out)} starts ${seconds(at - wanted)} ` +
          `late, because the voice of the caption before it is not at its end. Give that ` +
          `caption more time or fewer words.`,
      );
    }
    free = at + clip.duration + VOICE_GAP;
    return { clip, at, end: at + clip.duration };
  });
  const last = cues.findLast((cue) => cue !== undefined);
  if (last && last.end > duration + 1) {
    warnings.push(
      `The voice of the last caption ends ${seconds(last.end - duration)} after the end of ` +
        `the video. Add a wait at the end, or use fewer words.`,
    );
  }
  return { cues, warnings };
}

/**
 * The ffmpeg inputs and filter graph that mix the voice into one audio stream `[voice]`,
 * for a video that shows the output time range from `start` to `end`. The stream has the
 * length of the video. The first input of the command is the video. Returns null when
 * no voice is in the range.
 */
export function voiceTrack(
  cues: VoiceCue[],
  start: number,
  end: number,
): { inputs: string[]; filter: string } | null {
  const inside = cues.filter((cue) => cue.end > start && cue.at < end);
  if (!inside.length) return null;
  const parts = inside.map((cue, i) => {
    const offset = cue.at - start;
    const place =
      offset >= 0
        ? `adelay=${Math.round(offset)}:all=1`
        : `atrim=start=${(-offset / 1000).toFixed(3)},asetpts=PTS-STARTPTS`;
    return `[${i + 1}:a]${place}[v${i}]`;
  });
  const mix =
    inside.length > 1
      ? `${inside.map((cue, i) => `[v${i}]`).join('')}amix=inputs=${inside.length}:normalize=0:dropout_transition=0`
      : '[v0]anull';
  const format = 'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';
  const length = ((end - start) / 1000).toFixed(3);
  return {
    inputs: inside.flatMap((cue) => ['-i', cue.clip.file]),
    filter: `${parts.join(';')};${mix},${format},apad,atrim=end=${length}[voice]`,
  };
}
