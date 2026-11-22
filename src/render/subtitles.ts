import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { CaptionEvent, Size } from '../types.ts';
import { markedWord, parseCaption, splitCaption } from './captions.ts';
import { mixOklab, rgba, type Rgba } from './color.ts';
import { clamp, smoothstep } from './easing.ts';
import type { TimedEvent } from './timeline.ts';
import { VOICE_HOLD, type VoiceCue } from './voice.ts';

/**
 * Time a word is the current word, in output milliseconds: the pace of speech.
 */
const WORD_BASE = 120;
const WORD_PER_CHAR = 48;
const WORD_MIN = 180;
const WORD_MAX = 560;

/**
 * Timing of a page: the time it takes to come, which is also the time before its first
 * word is the current word, the time it stays after its last word, the length of its
 * exit, and the shortest time it shows when the next caption replaces it.
 */
const ENTER = 200;
const PAGE_HOLD = 520;
const EXIT = 150;
const MIN_SHOW = 300;

/**
 * How fast the highlight of a word comes and goes.
 */
const LIGHT_IN = 90;
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
 * Fewest words of a part of a sentence that can be a page of its own.
 */
const MIN_PHRASE = 3;

/**
 * Splits caption text into the parts that a speaker says in one go: a part ends at the
 * end of a sentence, or at a comma, a semicolon or a colon after some words. Each word
 * keeps its `**` marks.
 */
function phrases(text: string): string[] {
  const parts: string[][] = [[]];
  for (const word of parseCaption(text)) {
    const part = parts[parts.length - 1];
    part.push(markedWord(word));
    const pause = /[,;:]$/.test(word.text) && part.length >= MIN_PHRASE;
    if (pause || /[.?!]$/.test(word.text)) parts.push([]);
  }
  return parts.filter((part) => part.length).map((part) => part.join(' '));
}

/**
 * Breaks caption text into pages of at most two centered lines no wider than `maxWidth`.
 * A page ends where a speaker pauses, when the text has such a place: at the end of a
 * sentence or at a comma. Text with no such place breaks into pages of about the same
 * length. A word wider than `maxWidth` makes the text of its page smaller.
 */
export function paginate(
  text: string,
  measure: (text: string, fontSize: number) => number,
  maxWidth: number,
  fontSize: number,
): SubtitlePage[] {
  const fits = (page: string) =>
    splitCaption(page, measure, maxWidth, fontSize).length <= MAX_LINES;
  const pages: string[] = [];
  for (const phrase of phrases(text)) {
    const last = pages.at(-1);
    if (last !== undefined && fits(`${last} ${phrase}`)) {
      pages[pages.length - 1] = `${last} ${phrase}`;
      continue;
    }
    let parts = [phrase];
    // The widest page text that fits: found from the top, so that the pages have about
    // the same length. At `maxWidth` each page is one line.
    for (let width = MAX_LINES * maxWidth; !parts.every(fits); width *= 0.94) {
      parts = splitCaption(phrase, measure, width, fontSize);
    }
    pages.push(...parts);
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
 * Plans the pages of the captions. A page shows all its words at once, then each word
 * is the current word in its turn, at the pace of speech. The last page of a caption
 * stays until the caption ends. A caption that is too short for its words plays them
 * faster. A new caption replaces the page on screen. With a voice (one entry of `voice`
 * for each caption), the words and the pages follow the speech.
 */
export function planSubtitles(
  events: TimedEvent<CaptionEvent>[],
  pages: (text: string) => SubtitlePage[],
  voice: (VoiceCue | undefined)[] = [],
): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const sorted = events.filter((e) => e.text.trim()).sort((a, b) => a.out - b.out);
  sorted.forEach((event, caption) => {
    const laid = pages(event.text.trim());
    const said = voice[caption];
    const planned = said ? spokenPages(laid, event, said) : pacedPages(laid, event);
    // Pages of the caption before that did not start yet give way to this caption.
    while (cues.length && cues[cues.length - 1].start >= planned[0].start) cues.pop();
    const last = cues.at(-1);
    let late = 0;
    if (last && last.end + EXIT > planned[0].start) {
      last.end = Math.max(last.start + MIN_SHOW, Math.min(last.end, planned[0].start - EXIT));
      // A voice does not wait: only the pages without a voice come later.
      if (!said) late = Math.max(0, last.end + EXIT - planned[0].start);
    }
    planned.forEach((page, i) => {
      cues.push({
        caption,
        start: page.start + late,
        end: page.end + late,
        fontSize: laid[i].fontSize,
        height: laid[i].height,
        words: page.words.map((word) => ({
          ...word,
          at: word.at + late,
          until: word.until + late,
        })),
      });
    });
  });
  return cues;
}

type PlannedPage = Pick<SubtitleCue, 'start' | 'end' | 'words'>;

/**
 * Times of the pages of a caption without a voice, from the pace of speech.
 */
function pacedPages(laid: SubtitlePage[], event: TimedEvent<CaptionEvent>): PlannedPage[] {
  const spoken = laid.map((page) => page.words.reduce((sum, w) => sum + wordTime(w.text), 0));
  const natural = spoken.reduce((sum, time) => sum + ENTER + time + PAGE_HOLD, 0);
  const duration = Math.max(0, event.duration);
  const rate = natural > duration ? duration / natural : 1;
  let start = event.out;
  return laid.map((page, i) => {
    let at = start + ENTER * rate;
    const words = page.words.map((word) => {
      const until = at + wordTime(word.text) * rate;
      const timed = { ...word, at, until };
      at = until;
      return timed;
    });
    const end =
      i === laid.length - 1
        ? Math.max(at, event.out + duration)
        : start + (ENTER + spoken[i] + PAGE_HOLD) * rate;
    const planned = { start, end, words };
    start = end + EXIT;
    return planned;
  });
}

/**
 * Times of the pages of a caption with a voice: a page comes just before its first word
 * is said, and each word is the current word while it is said.
 */
function spokenPages(
  laid: SubtitlePage[],
  event: TimedEvent<CaptionEvent>,
  said: VoiceCue,
): PlannedPage[] {
  const times = said.clip.words;
  let index = 0;
  return laid.map((page, i) => {
    const first = index;
    index += page.words.length;
    const next = times[index];
    const words = page.words.map((word, j) => {
      const time = times[first + j] ?? { start: said.clip.duration, end: said.clip.duration };
      const until =
        j < page.words.length - 1 ? (times[first + j + 1]?.start ?? time.end) : time.end;
      return { ...word, at: said.at + time.start, until: said.at + until };
    });
    const start = said.at + (i === 0 ? 0 : (times[first]?.start ?? 0)) - ENTER;
    const end =
      i === laid.length - 1 || !next
        ? Math.max(said.end + VOICE_HOLD, event.out + Math.max(0, event.duration))
        : said.at + next.start - ENTER - EXIT;
    return { start, end: Math.max(end, start), words };
  });
}

export function subtitleVisible(cue: SubtitleCue, t: number): boolean {
  return t >= cue.start && t <= cue.end + EXIT;
}

/**
 * Draws a subtitle page. The page fades in with a small growth and no other movement.
 * The highlight color then goes from word to word: a word has it while it is the current
 * word, and a word between `**` has it all the time. The text has a dark outline, so
 * that it is readable on the page and on the backdrop. On exit the page shrinks a little
 * and fades.
 */
export function drawSubtitle(
  ctx: SKRSContext2D,
  cue: SubtitleCue,
  style: SubtitleStyle,
  t: number,
): void {
  if (!subtitleVisible(cue, t)) return;
  const size = cue.fontSize;
  const enter = 1 - (1 - clamp((t - cue.start) / ENTER, 0, 1)) ** 3;
  const exit = smoothstep(cue.end, cue.end + EXIT, t);
  const scale = (START_SCALE + (1 - START_SCALE) * enter) * (1 + (EXIT_SCALE - 1) * exit);
  const highlight = style.highlights[cue.caption % style.highlights.length];
  const colors = cue.words.map((word) => {
    const current =
      smoothstep(0, LIGHT_IN, t - word.at) * (1 - smoothstep(0, LIGHT_OUT, t - word.until));
    return rgba(mixOklab(TEXT, highlight, word.strong ? 1 : current));
  });
  ctx.save();
  // The page scales about its center.
  ctx.setTransform(scale, 0, 0, scale, style.x, style.y);
  ctx.globalAlpha = enter * (1 - exit);
  ctx.font = subtitleFont(style.family, size);
  ctx.letterSpacing = tracking(size);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.lineWidth = OUTLINE * size;
  ctx.shadowColor = SHADOW_COLOR;
  ctx.shadowBlur = SHADOW_BLUR * size;
  ctx.shadowOffsetY = SHADOW_OFFSET * size;
  ctx.strokeStyle = rgba(OUTLINE_COLOR);
  const top = -cue.height / 2;
  // All the outlines come first: the outline of a word must not cover its neighbor.
  for (const word of cue.words) ctx.strokeText(word.text, word.x, top + word.baseline);
  ctx.shadowColor = 'transparent';
  cue.words.forEach((word, i) => {
    ctx.fillStyle = colors[i];
    ctx.fillText(word.text, word.x, top + word.baseline);
  });
  ctx.restore();
}
