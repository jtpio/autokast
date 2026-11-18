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
const REVEAL = 420;
const STAGGER = 35;
const KICKER_LEAD = 70;
const EXIT = 200;
const SWAP_GAP = 120;
const CLOSE_DELAY = 120;
const MIN_SHOW = 300;

/**
 * One caption with the times its text enters and leaves.
 */
export interface CaptionCue {
  text: string;
  label?: string;
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
      label: e.label?.trim() || undefined,
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

export interface WordBox {
  text: string;
  line: number;
  x: number;
}

/**
 * Caption text broken into at most two balanced lines.
 */
export interface CaptionLines {
  fontSize: number;
  lines: string[];
  words: WordBox[];
  width: number;
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
  const words = text.split(/\s+/).filter(Boolean);
  const build = (size: number, lines: string[][]): CaptionLines => {
    const boxes: WordBox[] = [];
    lines.forEach((line, i) => {
      line.forEach((word, j) => {
        const x = j === 0 ? 0 : measure(`${line.slice(0, j).join(' ')} `, size);
        boxes.push({ text: word, line: i, x });
      });
    });
    const width = Math.max(...lines.map((l) => measure(l.join(' '), size)));
    return { fontSize: size, lines: lines.map((l) => l.join(' ')), words: boxes, width };
  };
  for (let size = fontSize; size >= fontSize * minScale - 1e-9; size *= 0.96) {
    if (measure(words.join(' '), size) <= maxWidth) return build(size, [words]);
    let best: { k: number; worst: number; first: number } | null = null;
    for (let k = 1; k < words.length; k++) {
      const first = measure(words.slice(0, k).join(' '), size);
      const second = measure(words.slice(k).join(' '), size);
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
  const first: string[] = [];
  let k = 0;
  while (k < words.length && measure([...first, words[k]].join(' '), size) <= maxWidth)
    first.push(words[k++]);
  if (first.length === 0) first.push(words[k++]);
  const second: string[] = [];
  while (k < words.length && measure([...second, words[k], '…'].join(' '), size) <= maxWidth)
    second.push(words[k++]);
  if (k < words.length) second.push('…');
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

export function captionFont(style: CaptionStyle, size: number): string {
  return `600 ${size}px "${style.family}"`;
}

function kickerFont(style: CaptionStyle): string {
  const family = style.family === 'Inter Display' ? 'Inter' : style.family;
  return `500 ${13 * style.unit}px "${family}"`;
}

/**
 * Tracking for a font size: -1.5% of the size for the text.
 */
export function tracking(size: number): string {
  return `${(-0.015 * size).toFixed(3)}px`;
}

/**
 * Height of a laid-out caption block, kicker included.
 */
export function captionHeight(lines: CaptionLines, style: CaptionStyle, label?: string): number {
  const kicker = label ? 16 * style.unit + 12 * style.unit : 0;
  return kicker + lines.lines.length * lines.fontSize * 1.15;
}

/**
 * Draws a caption with its top-left corner at (x, top) in output pixels. Each word rises
 * into place through a clip at its line (masked reveal), staggered word by word; the
 * kicker leads with a short accent rule that draws itself. On exit the block fades with
 * a small upward drift.
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
  const u = style.unit;
  const exit = smoothstep(cue.textOut, cue.textOut + EXIT, t);
  const alpha = 1 - exit;
  const drift = -6 * u * easeOutCubic((t - cue.textOut) / EXIT);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, drift);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  let y = top;
  const textStart = cue.label ? cue.textIn + KICKER_LEAD : cue.textIn;

  if (cue.label) {
    const k = (t - cue.textIn) / REVEAL;
    const rule = 18 * u * easeOutQuart(k);
    const mid = y + 8 * u;
    ctx.fillStyle = rgba(style.color, 0.6 * alpha);
    ctx.fillRect(x, mid - 0.75 * u, rule, 1.5 * u);
    ctx.font = kickerFont(style);
    ctx.letterSpacing = `${(0.08 * 13 * u).toFixed(3)}px`;
    const rise = (1 - easeOutQuart((t - cue.textIn - 40) / REVEAL)) * 18 * u;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 26 * u, y - 2 * u, 2000 * u, 20 * u);
    ctx.clip();
    ctx.fillStyle = rgba(style.color, 0.6 * alpha * smoothstep(0, 0.3, k));
    ctx.fillText(cue.label.toUpperCase(), x + 28 * u, mid + 4.6 * u + rise);
    ctx.restore();
    y += 28 * u;
  }

  const size = lines.fontSize;
  const lineHeight = size * 1.15;
  ctx.font = captionFont(style, size);
  ctx.letterSpacing = tracking(size);
  const ascent = size * 0.98;
  const descent = size * 0.26;
  const clipH = ascent + descent;
  lines.words.forEach((word, j) => {
    const q = (t - textStart - j * STAGGER) / REVEAL;
    if (q <= 0) return;
    const baseline = y + word.line * lineHeight + size * 0.93;
    const rise = (1 - easeOutQuart(q)) * clipH;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + word.x - size, baseline - ascent, size * 40, clipH);
    ctx.clip();
    ctx.fillStyle = rgba(style.color, style.color.a * alpha * smoothstep(0, 0.25, q));
    ctx.fillText(word.text, x + word.x, baseline + rise);
    ctx.restore();
  });
  ctx.restore();
}
