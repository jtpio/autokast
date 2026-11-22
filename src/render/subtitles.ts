import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { CaptionEvent, Size } from '../types.ts';
import { parseCaption, splitCaption } from './captions.ts';
import { mixOklab, rgba, type Rgba } from './color.ts';
import { clamp, smoothstep } from './easing.ts';
import type { TimedEvent } from './timeline.ts';

/**
 * Time a word is the current word, in output milliseconds: the pace of speech.
 */
const WORD_BASE = 120;
const WORD_PER_CHAR = 48;
const WORD_MIN = 180;
const WORD_MAX = 560;

/**
 * Timing of a page: the time it stays after its last word, the length of its exit, and
 * the shortest time it shows when the next caption replaces it.
 */
const PAGE_HOLD = 520;
const EXIT = 150;
const MIN_SHOW = 300;

/**
 * Animation of a word: the time it takes to come, and how fast the highlight comes and
 * goes.
 */
const ENTER = 200;
const LIGHT_IN = 70;
const LIGHT_OUT = 220;

/**
 * Shape of the text, in font sizes.
 */
const SUBTITLE_LINE_HEIGHT = 1.14;
const MAX_LINES = 2;
const OUTLINE = 0.15;
const WORD_GAP = 0.13;
const SHADOW_BLUR = 0.28;
const SHADOW_OFFSET = 0.07;
const START_SCALE = 0.94;
const EXIT_SCALE = 0.96;

const TEXT: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const OUTLINE_COLOR: Rgba = { r: 11, g: 13, b: 20, a: 0.94 };
const SHADOW_COLOR = 'rgba(4, 6, 12, 0.5)';

/**
 * One word of a subtitle page. `x` is its center from the center of the page, and
 * `baseline` is from the top of the page. It is the current word from `at` to `until`.
 */
export interface SubtitleWord {
  text: string;
  strong: boolean;
  x: number;
  baseline: number;
  at: number;
  until: number;
}

/**
 * One page of a subtitle: a few words that show together, from `start` to `end`.
 */
export interface SubtitleCue {
  /**
   * Index of the caption of this page, which selects its highlight color.
   */
  caption: number;
  start: number;
  end: number;
  fontSize: number;
  height: number;
  words: SubtitleWord[];
}

/**
 * A page of text, laid out: a size and the places of its words.
 */
export interface SubtitlePage {
  fontSize: number;
  height: number;
  words: Pick<SubtitleWord, 'text' | 'strong' | 'x' | 'baseline'>[];
}

export interface SubtitleStyle {
  family: string;
  /**
   * Center of the text block, in output pixels.
   */
  x: number;
  y: number;
  highlights: Rgba[];
}

/**
 * Vertical center of the subtitles, as a share of the output height, by position. In a
 * vertical video they stay above the part that the interface of a video platform covers.
 */
const PLACE = {
  wide: { bottom: 0.82, top: 0.16 },
  tall: { bottom: 0.72, top: 0.2 },
};

/**
 * Space between the subtitles and the subject of a zoomed shot, in font sizes.
 */
const CLEARANCE = 0.4;

/**
 * Where the subtitles are in the output: the center of the text block, and the rows that
 * a page of two lines covers, with some space around it.
 */
export function subtitleZone(
  size: Size,
  position: 'bottom' | 'top',
  fontSize: number,
): { x: number; y: number; top: number; bottom: number } {
  const y = size.height * PLACE[size.height > size.width ? 'tall' : 'wide'][position];
  const half = (MAX_LINES * SUBTITLE_LINE_HEIGHT * fontSize) / 2 + CLEARANCE * fontSize;
  return { x: size.width / 2, y, top: y - half, bottom: y + half };
}

function subtitleFont(family: string, size: number): string {
  return `800 ${size}px "${family}"`;
}

function tracking(size: number): string {
  return `${(-0.012 * size).toFixed(3)}px`;
}

/**
 * Width of text in the subtitle font. A space is wider than in the font, because the
 * outlines of two words take a part of the space between them.
 */
export function subtitleMeasure(family: string): (text: string, size: number) => number {
  const context = createCanvas(4, 4).getContext('2d');
  return (text, size) => {
    context.font = subtitleFont(family, size);
    context.letterSpacing = tracking(size);
    const spaces = text.trim().split(' ').length - 1;
    return context.measureText(text).width + spaces * WORD_GAP * size;
  };
}

/**
 * Breaks caption text into pages of at most two centered lines no wider than `maxWidth`,
 * of about the same length. A word wider than `maxWidth` makes the text of its page
 * smaller.
 */
export function paginate(
  text: string,
  measure: (text: string, fontSize: number) => number,
  maxWidth: number,
  fontSize: number,
): SubtitlePage[] {
  const fits = (page: string) =>
    splitCaption(page, measure, maxWidth, fontSize).length <= MAX_LINES;
  let pages = [text];
  // The widest page text that fits: found from the top, so that the pages have about the
  // same length. At `maxWidth` each page is one line.
  for (let width = MAX_LINES * maxWidth; !pages.every(fits); width *= 0.94) {
    pages = splitCaption(text, measure, width, fontSize);
  }
  return pages.map((page) => layoutPage(page, measure, maxWidth, fontSize));
}

function layoutPage(
  text: string,
  measure: (text: string, fontSize: number) => number,
  maxWidth: number,
  fontSize: number,
): SubtitlePage {
  const lines = splitCaption(text, measure, maxWidth, fontSize).map(parseCaption);
  const plain = (words: { text: string }[]) => words.map((word) => word.text).join(' ');
  const widest = Math.max(...lines.map((line) => measure(plain(line), fontSize)));
  const size = widest > maxWidth ? (fontSize * maxWidth) / widest : fontSize;
  const words: SubtitlePage['words'] = [];
  lines.forEach((line, row) => {
    const width = measure(plain(line), size);
    let before = '';
    for (const word of line) {
      // The width of a space at the end of a text is not measured.
      const own = measure(word.text, size);
      const right = measure(before + word.text, size);
      words.push({
        text: word.text,
        strong: word.runs.some((run) => run.strong),
        x: right - own / 2 - width / 2,
        baseline: (row * SUBTITLE_LINE_HEIGHT + 0.86) * size,
      });
      before += `${word.text} `;
    }
  });
  return { fontSize: size, height: lines.length * SUBTITLE_LINE_HEIGHT * size, words };
}

function wordTime(text: string): number {
  return clamp(WORD_BASE + WORD_PER_CHAR * text.length, WORD_MIN, WORD_MAX);
}

/**
 * Plans the pages of the captions. The words of a page come one at a time, at the pace
 * of speech, and the last page of a caption stays until the caption ends. A caption that
 * is too short for its words plays them faster. A new caption replaces the page on
 * screen.
 */
export function planSubtitles(
  events: TimedEvent<CaptionEvent>[],
  pages: (text: string) => SubtitlePage[],
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const sorted = events.filter((e) => e.text.trim()).sort((a, b) => a.out - b.out);
  sorted.forEach((event, caption) => {
    const laid = pages(event.text.trim());
    const spoken = laid.map((page) => page.words.reduce((sum, w) => sum + wordTime(w.text), 0));
    const natural = spoken.reduce((sum, time) => sum + time + PAGE_HOLD, 0);
    const duration = Math.max(0, event.duration);
    const rate = natural > duration ? duration / natural : 1;
    let start = event.out;
    // Pages of the caption before that did not start yet give way to this caption.
    while (cues.length && cues[cues.length - 1].start >= start) cues.pop();
    laid.forEach((page, i) => {
      const last = cues.at(-1);
      if (last && last.end + EXIT > start) {
        last.end = Math.max(last.start + MIN_SHOW, Math.min(last.end, start - EXIT));
        start = Math.max(start, last.end + EXIT);
      }
      let at = start;
      const words = page.words.map((word) => {
        const until = at + wordTime(word.text) * rate;
        const timed = { ...word, at, until };
        at = until;
        return timed;
      });
      const end =
        i === laid.length - 1
          ? Math.max(at, event.out + duration)
          : start + (spoken[i] + PAGE_HOLD) * rate;
      cues.push({ caption, start, end, fontSize: page.fontSize, height: page.height, words });
      start = end + EXIT;
    });
  });
  return cues;
}

export function subtitleVisible(cue: SubtitleCue, t: number): boolean {
  return t >= cue.start && t <= cue.end + EXIT;
}

/**
 * Draws a subtitle page. Each word fades in when it is said, with a small growth and no
 * other movement, and has the highlight color while it is the current word; a word
 * between `**` keeps that color. The text has a dark outline, so that it is readable on
 * the page and on the backdrop. On exit the page shrinks a little and fades.
 */
export function drawSubtitle(
  ctx: SKRSContext2D,
  cue: SubtitleCue,
  style: SubtitleStyle,
  t: number,
): void {
  if (!subtitleVisible(cue, t)) return;
  const size = cue.fontSize;
  const exit = smoothstep(cue.end, cue.end + EXIT, t);
  const highlight = style.highlights[cue.caption % style.highlights.length];
  const top = style.y - cue.height / 2;
  const shown = cue.words
    .filter((word) => t >= word.at && word.at < cue.end)
    .map((word) => {
      const enter = 1 - (1 - clamp((t - word.at) / ENTER, 0, 1)) ** 3;
      const current =
        smoothstep(0, LIGHT_IN, t - word.at) * (1 - smoothstep(0, LIGHT_OUT, t - word.until));
      return {
        word,
        alpha: enter * (1 - exit),
        scale: (START_SCALE + (1 - START_SCALE) * enter) * (1 + (EXIT_SCALE - 1) * exit),
        y: top + word.baseline,
        color: mixOklab(TEXT, highlight, word.strong ? 1 : current),
      };
    });
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = subtitleFont(style.family, size);
  ctx.letterSpacing = tracking(size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = OUTLINE * size;
  // All the outlines come first: the outline of a word must not cover its neighbor.
  for (const pass of ['outline', 'fill'] as const) {
    for (const { word, alpha, scale, y, color } of shown) {
      // The word scales about the middle of its lowercase letters.
      const pivot = y - 0.34 * size;
      ctx.setTransform(scale, 0, 0, scale, style.x + word.x, pivot);
      ctx.globalAlpha = alpha;
      if (pass === 'outline') {
        ctx.shadowColor = SHADOW_COLOR;
        ctx.shadowBlur = SHADOW_BLUR * size;
        ctx.shadowOffsetY = SHADOW_OFFSET * size;
        ctx.strokeStyle = rgba(OUTLINE_COLOR);
        ctx.strokeText(word.text, 0, y - pivot);
      } else {
        ctx.shadowColor = 'transparent';
        ctx.fillStyle = rgba(color);
        ctx.fillText(word.text, 0, y - pivot);
      }
    }
  }
  ctx.restore();
}
