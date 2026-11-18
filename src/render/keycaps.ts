import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { KeyEvent } from '../types.ts';
import { clamp, smoothstep } from './easing.ts';
import type { TimedEvent } from './timeline.ts';

/**
 * Timing of the keycaps, in output milliseconds.
 */
const APPEAR = 180;
const PRESS_DOWN = 50;
const PRESS_UP = 120;
const HOLD = 1100;
const FADE = 250;
const REPLACE_FADE = 110;

/**
 * One shortcut on screen: caps appear, are pressed one or more times, then leave.
 */
export interface KeyCue {
  keys: string[];
  appear: number;
  presses: number[];
  fadeOut: number;
  fadeDuration: number;
}

const ALIASES: Record<string, string> = {
  ControlOrMeta: 'Meta',
  Command: 'Meta',
  Cmd: 'Meta',
  Ctrl: 'Control',
  Option: 'Alt',
  Return: 'Enter',
  Esc: 'Escape',
  ' ': 'Space',
};

/**
 * Splits a combination such as `Control+Shift+C` into keys; `Control++` ends with `+`.
 */
export function parseShortcut(combo: string): string[] {
  const keys: string[] = [];
  let rest = combo;
  while (rest.length) {
    const i = rest.indexOf('+', 1);
    if (i < 0) {
      keys.push(rest);
      break;
    }
    keys.push(rest.slice(0, i));
    rest = rest.slice(i + 1);
  }
  return keys.filter(Boolean).map((k) => ALIASES[k] ?? k);
}

const LABELS: Record<string, { glyph?: string; name?: string }> = {
  Meta: { glyph: '⌘', name: 'Cmd' },
  Control: { glyph: '⌃', name: 'Ctrl' },
  Alt: { glyph: '⌥', name: 'Opt' },
  Shift: { glyph: '⇧', name: 'Shift' },
  Enter: { glyph: '↵', name: 'Enter' },
  Tab: { glyph: '⇥', name: 'Tab' },
  Escape: { glyph: '⎋', name: 'Esc' },
  Backspace: { glyph: '⌫', name: 'Backspace' },
  Delete: { glyph: '⌦', name: 'Del' },
  ArrowUp: { glyph: '↑' },
  ArrowDown: { glyph: '↓' },
  ArrowLeft: { glyph: '←' },
  ArrowRight: { glyph: '→' },
  Space: { name: 'Space' },
  PageUp: { name: 'Page Up' },
  PageDown: { name: 'Page Down' },
  Home: { name: 'Home' },
  End: { name: 'End' },
};

/**
 * What a cap shows: a glyph, a name, or both. Single characters show in upper case.
 */
export function keyLabel(key: string): { glyph?: string; name?: string } {
  if (LABELS[key]) return LABELS[key];
  if (key.length === 1) return { glyph: key.toUpperCase() };
  if (/^Key[A-Z]$/.test(key)) return { glyph: key.slice(3) };
  if (/^Digit[0-9]$/.test(key)) return { glyph: key.slice(5) };
  return { name: key };
}

/**
 * Plans keycap cues for shortcut events. The same combination pressed again while shown
 * presses the same caps; a new combination replaces the old one with a quick fade.
 */
export function planKeys(events: TimedEvent<KeyEvent>[]): KeyCue[] {
  const cues: KeyCue[] = [];
  const sorted = events.filter((e) => e.kind === 'shortcut').sort((a, b) => a.out - b.out);
  for (const e of sorted) {
    const keys = parseShortcut(e.key);
    if (!keys.length) continue;
    const last = cues[cues.length - 1];
    if (last && last.keys.join('+') === keys.join('+') && e.out <= last.fadeOut) {
      last.presses.push(e.out);
      last.fadeOut = e.out + HOLD;
      continue;
    }
    const appear = e.out - APPEAR;
    if (last && appear < last.fadeOut + last.fadeDuration) {
      last.fadeOut = Math.max(
        last.presses[last.presses.length - 1] + PRESS_UP,
        appear - REPLACE_FADE,
      );
      last.fadeDuration = REPLACE_FADE;
    }
    cues.push({ keys, appear, presses: [e.out], fadeOut: e.out + HOLD, fadeDuration: FADE });
  }
  return cues;
}

export function keyCueVisible(cue: KeyCue, t: number): boolean {
  return t >= cue.appear && t <= cue.fadeOut + cue.fadeDuration;
}

/**
 * Press depth at time `t`, 0 to 1: a quick press and a slower release.
 */
export function pressDepth(cue: KeyCue, t: number): number {
  let depth = 0;
  for (const p of cue.presses) {
    const down = smoothstep(p, p + PRESS_DOWN, t);
    const up = smoothstep(p + PRESS_DOWN, p + PRESS_DOWN + PRESS_UP, t);
    depth = Math.max(depth, down * (1 - up));
  }
  return depth;
}

export interface CapTheme {
  face: [string, string];
  pressed: [string, string];
  lip: string;
  border: string;
  highlight: string;
  ink: string;
  shadow: string;
  contact: string;
}

export const LIGHT_CAPS: CapTheme = {
  face: ['#fbfaf8', '#eeece8'],
  pressed: ['#efedea', '#e2dfda'],
  lip: '#c7c3bc',
  border: 'rgba(0, 0, 0, 0.10)',
  highlight: 'rgba(255, 255, 255, 0.95)',
  ink: '#2a2b30',
  shadow: 'rgba(0, 0, 0, 0.32)',
  contact: 'rgba(0, 0, 0, 0.30)',
};

export const DARK_CAPS: CapTheme = {
  face: ['#3a3b41', '#2d2e33'],
  pressed: ['#313237', '#26272b'],
  lip: '#141518',
  border: 'rgba(255, 255, 255, 0.07)',
  highlight: 'rgba(255, 255, 255, 0.16)',
  ink: '#f2f0ec',
  shadow: 'rgba(0, 0, 0, 0.26)',
  contact: 'rgba(0, 0, 0, 0.35)',
};

const measurer = createCanvas(4, 4).getContext('2d');

export interface CapLayout {
  key: string;
  width: number;
  glyph?: string;
  name?: string;
}

/**
 * Widths of the caps of a cue at a resolution unit.
 */
export function capLayouts(keys: string[], unit: number): CapLayout[] {
  const h = 40 * unit;
  return keys.map((key) => {
    const label = keyLabel(key);
    let content = 0;
    if (label.glyph) {
      measurer.font = glyphFont(label, unit);
      content += measurer.measureText(label.glyph).width;
    }
    if (label.name) {
      measurer.font = `500 ${14 * unit}px Inter`;
      measurer.letterSpacing = '0px';
      content += measurer.measureText(label.name).width + (label.glyph ? 7 * unit : 0);
    }
    const min = key === 'Space' ? 4 * h : h;
    return { key, width: Math.max(min, content + 2 * 13 * unit), ...label };
  });
}

function glyphFont(label: { glyph?: string; name?: string }, unit: number): string {
  return label.name ? `500 ${16 * unit}px Inter` : `600 ${17 * unit}px Inter`;
}

const CAP_GAP = 8;

export function capsWidth(caps: CapLayout[], unit: number): number {
  return caps.reduce((w, c) => w + c.width, 0) + CAP_GAP * unit * (caps.length - 1);
}

/**
 * Draws the caps of a cue with their top-left corner at (x, y), in output pixels. Each
 * cap is a small physical key: a face with a top highlight on a darker lip, a contact
 * shadow and a soft drop shadow. Pressed, the face sinks 2 units and darkens.
 */
export function drawKeycaps(
  ctx: SKRSContext2D,
  cue: KeyCue,
  caps: CapLayout[],
  theme: CapTheme,
  x: number,
  y: number,
  unit: number,
  t: number,
): void {
  if (!keyCueVisible(cue, t)) return;
  const u = unit;
  const appear = clamp((t - cue.appear) / APPEAR, 0, 1);
  const enter = 1 - (1 - appear) ** 3;
  const leave = smoothstep(cue.fadeOut, cue.fadeOut + cue.fadeDuration, t);
  const alpha = enter * (1 - leave);
  if (alpha <= 0.002) return;
  const lift = (1 - enter) * 8 * u + leave * 3 * u;
  const depth = pressDepth(cue, t);
  const h = 40 * u;
  const lip = 3.5 * u;
  const radius = 8 * u;
  const sink = 2 * u * depth;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alpha;
  let cx = x;
  const top = y + lift;
  for (const cap of caps) {
    const w = cap.width;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cx, top, w, h, radius);
    ctx.fillStyle = theme.lip;
    ctx.shadowColor = theme.shadow;
    ctx.shadowBlur = (16 - 6 * depth) * u;
    ctx.shadowOffsetY = (6 - 2 * depth) * u;
    ctx.fill();
    ctx.shadowColor = theme.contact;
    ctx.shadowBlur = 2 * u;
    ctx.shadowOffsetY = 1 * u;
    ctx.fill();
    ctx.restore();

    const faceTop = top + sink;
    const faceH = h - lip;
    const colors = theme.face.map((c, i) => mix(c, theme.pressed[i], depth));
    const g = ctx.createLinearGradient(0, faceTop, 0, faceTop + faceH);
    g.addColorStop(0, colors[0]);
    g.addColorStop(1, colors[1]);
    ctx.beginPath();
    ctx.roundRect(cx, faceTop, w, faceH, radius);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = u;
    ctx.strokeStyle = theme.border;
    ctx.beginPath();
    ctx.roundRect(cx + u / 2, top + u / 2, w - u, h - u, radius - u / 2);
    ctx.stroke();
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(cx, faceTop, w, faceH, radius);
    ctx.clip();
    ctx.beginPath();
    ctx.roundRect(cx + u * 0.75, faceTop + u * 0.75, w - 1.5 * u, faceH + 4 * u, radius - u);
    ctx.strokeStyle = theme.highlight;
    ctx.lineWidth = 1.2 * u;
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = theme.ink;
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = '0px';
    const mid = faceTop + faceH / 2 + 0.5 * u;
    if (cap.glyph && cap.name) {
      ctx.font = glyphFont(cap, u);
      const gw = ctx.measureText(cap.glyph).width;
      ctx.font = `500 ${14 * u}px Inter`;
      const nw = ctx.measureText(cap.name).width;
      let tx = cx + (w - gw - 7 * u - nw) / 2;
      ctx.textAlign = 'left';
      ctx.font = glyphFont(cap, u);
      ctx.fillText(cap.glyph, tx, mid);
      tx += gw + 7 * u;
      ctx.font = `500 ${14 * u}px Inter`;
      ctx.fillText(cap.name, tx, mid);
    } else {
      ctx.textAlign = 'center';
      ctx.font = glyphFont(cap, u);
      ctx.fillText(cap.glyph ?? cap.name ?? '', cx + w / 2, mid);
    }
    cx += w + CAP_GAP * u;
  }
  ctx.restore();
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (p: number, s: number) => (p >> s) & 255;
  const v = (s: number) => Math.round(ch(pa, s) + (ch(pb, s) - ch(pa, s)) * t);
  return `rgb(${v(16)}, ${v(8)}, ${v(0)})`;
}
