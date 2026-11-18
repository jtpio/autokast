import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { CaptionEvent } from '../types.ts';
import { rgba, type Rgba } from './color.ts';
import { clamp, easing, smoothstep } from './easing.ts';
import type { TimedEvent } from './timeline.ts';

/**
 * Timing of the caption band and text, in output milliseconds.
 */
export const BAND_DURATION = 700;
export const MERGE_GAP = 600;
const REVEAL_DELAY = 400;
const REVEAL = 640;
const EXIT = 240;
const SWAP_GAP = 120;
const CLOSE_DELAY = 120;
const MIN_SHOW = 300;

/**
 * Time to read one line, in milliseconds: the rule of the default caption duration.
 */
const READ_BASE = 1500;
const READ_PER_CHAR = 55;

/**
 * One caption with the times its text enters and leaves.
 */
export interface CaptionCue {
  text: string;
  /**
   * True when `**` marks some of the words of the caption, but not all.
   */
  emphasis: boolean;
  start: number;
  end: number;
  textIn: number;
  textOut: number;
}

/**
 * A run of captions that keeps the band open: it opens at `open` and closes at `close`.
 */
export interface BandGroup {
  open: number;
  close: number;
}

/**
 * Plans caption cues and band groups. Captions within MERGE_GAP of each other share
 * one open band and only swap their text. `split` breaks the text of a caption into
 * lines: a caption shows one line at a time, and its lines share its duration.
 */
export function planCaptions(
  events: TimedEvent<CaptionEvent>[],
  split: (text: string) => string[] = (text) => [text],
): {
  cues: CaptionCue[];
  groups: BandGroup[];
} {
  const cues: CaptionCue[] = [];
  const groups: BandGroup[] = [];
  const sorted = events.filter((e) => e.text.trim()).sort((a, b) => a.out - b.out);
  let last: CaptionCue | null = null;
  for (const e of sorted) {
    const lines = split(e.text.trim());
    const tones = parseCaption(e.text).flatMap((word) => word.runs.map((run) => run.strong));
    const emphasis = tones.includes(true) && tones.includes(false);
    const spans = lineDurations(lines, Math.max(0, e.duration));
    let start = e.out;
    lines.forEach((text, i) => {
      const end = start + spans[i];
      let textIn: number;
      if (last && start - last.end <= MERGE_GAP) {
        last.textOut = Math.max(last.textIn + MIN_SHOW, Math.min(last.textOut, start));
        textIn = Math.max(start, last.textOut + SWAP_GAP);
      } else {
        groups.push({ open: start, close: 0 });
        textIn = start + REVEAL_DELAY;
      }
      last = { text, emphasis, start, end, textIn, textOut: Math.max(textIn + MIN_SHOW, end) };
      cues.push(last);
      groups[groups.length - 1].close = last.textOut + CLOSE_DELAY;
      start = end;
    });
  }
  return { cues, groups };
}

/**
 * Shares the duration of a caption between its lines. Each line but the last stays for
 * the time to read it, and the last line gets the rest. When the duration is too short
 * for that, all lines get less time in the same proportion.
 */
function lineDurations(lines: string[], duration: number): number[] {
  const read = lines.map((line) => READ_BASE + READ_PER_CHAR * line.replaceAll('**', '').length);
  const total = read.reduce((sum, time) => sum + time, 0);
  if (total > duration) return read.map((time) => (time * duration) / total);
  const last = read.length - 1;
  return read.map((time, i) => (i < last ? time : duration - (total - time)));
}

const bandEase = easing('smooth');

/**
 * How far the band is open at output time `t`, 0 to 1 (already eased).
 */
export function bandAt(groups: BandGroup[], t: number): number {
  let p = 0;
  for (const g of groups) {
    const open = bandEase((t - g.open) / BAND_DURATION);
    const close = 1 - bandEase((t - g.close) / BAND_DURATION);
    p = Math.max(p, Math.min(open, close));
  }
  return p;
}

export function bandTrack(times: ArrayLike<number>, groups: BandGroup[]): Float64Array {
  return Float64Array.from({ length: times.length }, (_, i) => bandAt(groups, times[i]));
}

/**
 * Line height of a caption, in font sizes.
 */
export const LINE_HEIGHT = 1.18;

/**
 * Share of the window width that a caption can take.
 */
export const CAPTION_WIDTH = 0.72;

/**
 * Shape of the reveal, in font sizes: width of the soft edge, blur of the text in it,
 * and the distance the text settles. DIM is the tone of the words outside the emphasis.
 */
const SOFT = 4.4;
const BLUR = 0.15;
const SETTLE = 0.14;
const DIM = 0.62;

/**
 * A part of a word in one tone. `x` is its offset from the start of the line.
 */
export interface CaptionRun {
  text: string;
  x: number;
  strong: boolean;
}

/**
 * One line of caption text, laid out.
 */
export interface CaptionLine {
  fontSize: number;
  text: string;
  width: number;
  runs: CaptionRun[];
}

interface ParsedWord {
  text: string;
  runs: { text: string; strong: boolean }[];
}

/**
 * Splits caption text into words. `**` starts and ends the emphasis and is not shown.
 */
export function parseCaption(text: string): ParsedWord[] {
  const words: ParsedWord[] = [];
  let strong = false;
  for (const raw of text.split(/\s+/).filter(Boolean)) {
    const runs: ParsedWord['runs'] = [];
    raw.split('**').forEach((part, i) => {
      if (i > 0) strong = !strong;
      if (part) runs.push({ text: part, strong });
    });
    if (runs.length) words.push({ text: runs.map((run) => run.text).join(''), runs });
  }
  return words;
}

const join = (words: ParsedWord[]) => words.map((word) => word.text).join(' ');

/**
 * Breaks caption text into lines no wider than `maxWidth`, each with its `**` marks: the
 * fewest lines, of about the same width. `measure(text, fontSize)` returns a width in
 * pixels. A word wider than `maxWidth` has a line of its own.
 */
export function splitCaption(
  text: string,
  measure: (text: string, fontSize: number) => number,
  maxWidth: number,
  fontSize: number,
): string[] {
  const words = parseCaption(text);
  const fill = (limit: number) => {
    const lines: ParsedWord[][] = [];
    for (const word of words) {
      const line = lines.at(-1);
      if (line && measure(join([...line, word]), fontSize) <= limit) line.push(word);
      else lines.push([word]);
    }
    return lines;
  };
  const count = fill(maxWidth).length;
  let narrow = 0;
  let wide = maxWidth;
  for (let i = 0; i < 12 && count > 1; i++) {
    const limit = (narrow + wide) / 2;
    if (fill(limit).length > count) narrow = limit;
    else wide = limit;
  }
  const marked = (word: ParsedWord) =>
    word.runs.map((run) => (run.strong ? `**${run.text}**` : run.text)).join('');
  return fill(wide).map((line) => line.map(marked).join(' '));
}

/**
 * Lays out one line of caption text. The font shrinks only when the line is wider than
 * `maxWidth`, which `splitCaption` prevents for all text but one very long word.
 */
export function layoutCaption(
  text: string,
  measure: (text: string, fontSize: number) => number,
  maxWidth: number,
  fontSize: number,
): CaptionLine {
  const words = parseCaption(text);
  const line = join(words);
  const natural = measure(line, fontSize);
  const size = natural > maxWidth ? (fontSize * maxWidth) / natural : fontSize;
  const runs: CaptionRun[] = [];
  let before = '';
  for (const word of words) {
    for (const run of word.runs) {
      runs.push({ ...run, x: before ? measure(before, size) : 0 });
      before += run.text;
    }
    before += ' ';
  }
  return { fontSize: size, text: line, width: measure(line, size), runs };
}

export interface CaptionStyle {
  family: string;
  fontSize: number;
  color: Rgba;
  unit: number;
}

const easeOutQuart = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 4;
const easeOutCubic = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;
const sweep = easing('smooth');

export function captionFont(style: Pick<CaptionStyle, 'family'>, size: number): string {
  return `500 ${size}px "${style.family}"`;
}

/**
 * Tracking for a font size: -1.5% of the size for the text.
 */
export function tracking(size: number): string {
  return `${(-0.015 * size).toFixed(3)}px`;
}

/**
 * Width of text in the caption font, for `splitCaption` and `layoutCaption`.
 */
export function captionMeasure(family: string): (text: string, size: number) => number {
  const context = createCanvas(4, 4).getContext('2d');
  return (text, size) => {
    context.font = captionFont({ family }, size);
    context.letterSpacing = tracking(size);
    return context.measureText(text).width;
  };
}

/**
 * Draws a caption line with its top-left corner at (x, top) in output pixels. The text
 * comes into focus from left to right: behind a soft edge that crosses the line it is
 * sharp, inside the edge it is blurred and faint. Words outside the emphasis have a lower
 * tone. On exit the line goes out of focus and fades with a small upward drift.
 */
export function drawCaption(
  ctx: SKRSContext2D,
  cue: CaptionCue,
  line: CaptionLine,
  style: CaptionStyle,
  x: number,
  top: number,
  t: number,
): void {
  if (t < cue.textIn || t > cue.textOut + EXIT) return;
  const size = line.fontSize;
  const soft = SOFT * size;
  const p = clamp((t - cue.textIn) / REVEAL, 0, 1);
  const exit = clamp((t - cue.textOut) / EXIT, 0, 1);
  const alpha = style.color.a * (1 - smoothstep(0, 1, exit));
  const edge = x + sweep(p) * (line.width + soft);
  const shift = (1 - easeOutQuart(p) - easeOutCubic(exit)) * SETTLE * size;
  const baseline = top + size * 0.93 + shift;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = captionFont(style, size);
  ctx.letterSpacing = tracking(size);
  // Each stop is a position across the soft edge (0 to 1) and a share of the tone.
  const draw = (blur: number, stops?: [number, number][]) => {
    ctx.filter = blur > 0.01 ? `blur(${blur.toFixed(2)}px)` : 'none';
    for (const run of line.runs) {
      const tone = alpha * (cue.emphasis && !run.strong ? DIM : 1);
      if (stops) {
        const gradient = ctx.createLinearGradient(edge - soft, 0, edge, 0);
        for (const [at, share] of stops) gradient.addColorStop(at, rgba(style.color, tone * share));
        ctx.fillStyle = gradient;
      } else {
        ctx.fillStyle = rgba(style.color, tone);
      }
      ctx.fillText(run.text, x + run.x, baseline);
    }
  };
  if (p >= 1) {
    draw(exit * exit * 2 * BLUR * size);
  } else {
    draw(0, [
      [0, 1],
      [0.35, 0],
    ]);
    draw(0.35 * BLUR * size, [
      [0, 0],
      [0.3, 0.9],
      [0.65, 0],
    ]);
    draw(BLUR * size, [
      [0.3, 0],
      [0.65, 0.7],
      [1, 0],
    ]);
  }
  ctx.restore();
}
