import type { SKRSContext2D } from '@napi-rs/canvas';
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
const LINE_DELAY = 110;
const EXIT = 240;
const SWAP_GAP = 120;
const CLOSE_DELAY = 120;
const MIN_SHOW = 300;

/**
 * One caption with the times its text enters and leaves.
 */
export interface CaptionCue {
  text: string;
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
 * one open band and only swap their text.
 */
export function planCaptions(events: TimedEvent<CaptionEvent>[]): {
  cues: CaptionCue[];
  groups: BandGroup[];
} {
  const cues: CaptionCue[] = [];
  const groups: BandGroup[] = [];
  const sorted = events.filter((e) => e.text.trim()).sort((a, b) => a.out - b.out);
  let last: CaptionCue | null = null;
  for (const e of sorted) {
    const start = e.out;
    const end = e.out + Math.max(0, e.duration);
    let textIn: number;
    if (last && start - last.end <= MERGE_GAP) {
      last.textOut = Math.max(last.textIn + MIN_SHOW, Math.min(last.textOut, start));
      textIn = Math.max(start, last.textOut + SWAP_GAP);
    } else {
      groups.push({ open: start, close: 0 });
      textIn = start + REVEAL_DELAY;
    }
    last = {
      text: e.text.trim(),
      start,
      end,
      textIn,
      textOut: Math.max(textIn + MIN_SHOW, end),
    };
    cues.push(last);
    groups[groups.length - 1].close = last.textOut + CLOSE_DELAY;
  }
  return { cues, groups };
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

export interface WordBox {
  text: string;
  line: number;
  x: number;
  runs: CaptionRun[];
}

/**
 * Caption text broken into at most two balanced lines.
 */
export interface CaptionLines {
  fontSize: number;
  lines: string[];
  widths: number[];
  words: WordBox[];
  width: number;
  /**
   * True when `**` marks some of the words, but not all.
   */
  emphasis: boolean;
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

/**
 * Breaks text into one line or two balanced lines no wider than `maxWidth`. When two
 * lines do not fit, the font shrinks down to `minScale`; past that, the second line ends
 * with an ellipsis. `measure(text, fontSize)` returns a width in pixels.
 */
export function layoutCaption(
  text: string,
  measure: (text: string, fontSize: number) => number,
  maxWidth: number,
  fontSize: number,
  minScale = 0.78,
): CaptionLines {
  const words = parseCaption(text);
  const tones = words.flatMap((word) => word.runs.map((run) => run.strong));
  const emphasis = tones.includes(true) && tones.includes(false);
  const join = (line: ParsedWord[]) => line.map((word) => word.text).join(' ');
  const build = (size: number, lines: ParsedWord[][]): CaptionLines => {
    const boxes: WordBox[] = [];
    lines.forEach((line, i) => {
      line.forEach((word, j) => {
        let before = j === 0 ? '' : `${join(line.slice(0, j))} `;
        const x = before ? measure(before, size) : 0;
        const runs = word.runs.map((run) => {
          const at = before ? measure(before, size) : 0;
          before += run.text;
          return { ...run, x: at };
        });
        boxes.push({ text: word.text, line: i, x, runs });
      });
    });
    const widths = lines.map((line) => measure(join(line), size));
    return {
      fontSize: size,
      lines: lines.map(join),
      widths,
      words: boxes,
      width: Math.max(...widths),
      emphasis,
    };
  };
  for (let size = fontSize; size >= fontSize * minScale - 1e-9; size *= 0.96) {
    if (measure(join(words), size) <= maxWidth) return build(size, [words]);
    let best: { k: number; worst: number; first: number } | null = null;
    for (let k = 1; k < words.length; k++) {
      const first = measure(join(words.slice(0, k)), size);
      const second = measure(join(words.slice(k)), size);
      const worst = Math.max(first, second);
      if (worst > maxWidth) continue;
      if (
        !best ||
        worst < best.worst - 0.5 ||
        (Math.abs(worst - best.worst) <= 0.5 && first > best.first)
      ) {
        best = { k, worst, first };
      }
    }
    if (best) return build(size, [words.slice(0, best.k), words.slice(best.k)]);
  }
  const size = fontSize * minScale;
  const ellipsis: ParsedWord = { text: '…', runs: [{ text: '…', strong: false }] };
  const first: ParsedWord[] = [];
  let k = 0;
  while (k < words.length && measure(join([...first, words[k]]), size) <= maxWidth)
    first.push(words[k++]);
  if (first.length === 0) first.push(words[k++]);
  const second: ParsedWord[] = [];
  while (k < words.length && measure(join([...second, words[k], ellipsis]), size) <= maxWidth)
    second.push(words[k++]);
  if (k < words.length) second.push(ellipsis);
  return build(size, second.length ? [first, second] : [first]);
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

export function captionFont(style: CaptionStyle, size: number): string {
  return `500 ${size}px "${style.family}"`;
}

/**
 * Tracking for a font size: -1.5% of the size for the text.
 */
export function tracking(size: number): string {
  return `${(-0.015 * size).toFixed(3)}px`;
}

/**
 * Height of a laid-out caption block.
 */
export function captionHeight(lines: CaptionLines): number {
  return lines.lines.length * lines.fontSize * LINE_HEIGHT;
}

/**
 * Draws a caption with its top-left corner at (x, top) in output pixels. The text comes
 * into focus from left to right: behind a soft edge that crosses each line it is sharp,
 * inside the edge it is blurred and faint. Words outside the emphasis have a lower tone.
 * On exit the block goes out of focus and fades with a small upward drift.
 */
export function drawCaption(
  ctx: SKRSContext2D,
  cue: CaptionCue,
  lines: CaptionLines,
  style: CaptionStyle,
  x: number,
  top: number,
  t: number,
): void {
  if (t < cue.textIn || t > cue.textOut + EXIT) return;
  const size = lines.fontSize;
  const soft = SOFT * size;
  const exit = clamp((t - cue.textOut) / EXIT, 0, 1);
  const alpha = style.color.a * (1 - smoothstep(0, 1, exit));
  const tone = (run: CaptionRun) => alpha * (lines.emphasis && !run.strong ? DIM : 1);
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = captionFont(style, size);
  ctx.letterSpacing = tracking(size);
  lines.lines.forEach((_, i) => {
    const p = clamp((t - cue.textIn - i * LINE_DELAY) / REVEAL, 0, 1);
    if (p <= 0) return;
    const edge = x + sweep(p) * (lines.widths[i] + soft);
    const shift = (1 - easeOutQuart(p) - easeOutCubic(exit)) * SETTLE * size;
    const baseline = top + i * size * LINE_HEIGHT + size * 0.93 + shift;
    const runs = lines.words.filter((word) => word.line === i).flatMap((word) => word.runs);
    // Each stop is a position across the soft edge (0 to 1) and a share of the tone.
    const draw = (blur: number, stops?: [number, number][]) => {
      ctx.filter = blur > 0.01 ? `blur(${blur.toFixed(2)}px)` : 'none';
      for (const run of runs) {
        const a = tone(run);
        if (stops) {
          const gradient = ctx.createLinearGradient(edge - soft, 0, edge, 0);
          for (const [at, share] of stops) gradient.addColorStop(at, rgba(style.color, a * share));
          ctx.fillStyle = gradient;
        } else {
          ctx.fillStyle = rgba(style.color, a);
        }
        ctx.fillText(run.text, x + run.x, baseline);
      }
    };
    if (p >= 1) {
      draw(exit * exit * 2 * BLUR * size);
      return;
    }
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
  });
  ctx.restore();
}
