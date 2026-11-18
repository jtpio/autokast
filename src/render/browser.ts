import type { SKRSContext2D } from '@napi-rs/canvas';
import type { Rect, UrlEvent } from '../types.ts';
import { smoothstep } from './easing.ts';
import type { TimedEvent } from './timeline.ts';

/**
 * Height of the browser toolbar, in units.
 */
export const BROWSER_BAR = 52;

/**
 * Time the typed address stays in the focused field before the page opens, and the time
 * the focus ring takes to appear, in milliseconds.
 */
const ENTER = 380;
const FOCUS = 260;

/**
 * What the address bar shows at one time. The host has the full tone and the rest of the
 * address a lower tone. `focus` is 0 to 1: the field is larger while a URL is typed in it
 * (with a `caret`) or while the script shows the URL.
 */
export interface Address {
  host: string;
  path: string;
  focus: number;
  caret?: boolean;
}

/**
 * Splits a URL into the host and the rest, without the scheme. `origin` replaces the
 * origin of the URL; it can have a path, as in `jupyterlite.github.io/demo`.
 */
export function splitAddress(url: string, origin = ''): { host: string; path: string } {
  let host = url;
  let path = '';
  // Text such as `example.org/docs` has no scheme: read it as a web address.
  const plain = !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^about:|\s/.test(url);
  try {
    const parsed = new URL(plain ? `https://${url}` : url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      host = parsed.host;
      path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch {
    // Not a URL: show the text as it is.
  }
  const base = origin.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  if (base) {
    const slash = base.indexOf('/');
    host = slash < 0 ? base : base.slice(0, slash);
    path = `${slash < 0 ? '' : base.slice(slash)}${path}`;
  }
  return { host, path: path === '/' ? '' : path };
}

/**
 * The address bar at output time `t`: the latest address of the page, as typed text while
 * a `cast.goto` types it. `urls` are in output time order; `start` is the address when the
 * session has no address events.
 */
export function addressAt(
  urls: TimedEvent<UrlEvent>[],
  t: number,
  options: { address: boolean | string; origin: string },
  start = '',
): Address {
  if (options.address === false) return { host: '', path: '', focus: 0 };
  if (typeof options.address === 'string') return { ...splitAddress(options.address), focus: 0 };
  const event = urls.findLast((e) => e.out <= t);
  const full = splitAddress(event?.url ?? start, options.origin);
  const typing = event?.typing ?? 0;
  const show = event?.show ?? 0;
  const age = event ? t - event.out : 0;
  if (show > 0 && age < show) {
    return {
      ...full,
      focus: Math.min(smoothstep(0, FOCUS, age), smoothstep(show, show - FOCUS, age)),
    };
  }
  if (typing <= 0 || age >= typing + ENTER) return { ...full, focus: 0 };
  const length = full.host.length + full.path.length;
  const shown = Math.min(length, Math.ceil((age / typing) * length));
  return {
    host: full.host.slice(0, shown),
    path: full.path.slice(0, Math.max(0, shown - full.host.length)),
    focus: smoothstep(0, FOCUS, age),
    caret: true,
  };
}

const THEMES = {
  light: {
    icon: '#6a6a70',
    field: 'rgba(0, 0, 0, 0.055)',
    fieldFocus: '#ffffff',
    host: '#1d1d21',
    path: '#77777d',
    ring: '59, 130, 246',
  },
  dark: {
    icon: '#a3a3aa',
    field: 'rgba(255, 255, 255, 0.075)',
    fieldFocus: '#1a1a1d',
    host: '#ededf1',
    path: '#9a9aa2',
    ring: '96, 165, 250',
  },
};

/**
 * How much larger the address field is while a URL is typed in it. The text must be easy
 * to read in a video that shows the whole window.
 */
const LENS = 1.55;

type Theme = (typeof THEMES)['light'];

/**
 * Place of the address field on the bar: in the middle of the window, clear of the
 * buttons on the left. `left` is the first free x after the window buttons.
 */
function fieldBox(window: Rect, bar: number, unit: number, left: number): Rect {
  const height = 34 * unit;
  const controls = left + 110 * unit - window.x;
  const width = Math.max(
    40 * unit,
    Math.min(760 * unit, window.width * 0.56, window.width - 2 * controls),
  );
  return {
    x: window.x + (window.width - width) / 2,
    y: window.y + (bar - height) / 2,
    width,
    height,
  };
}

/**
 * Draws the address field with its text. With `focus`, the field has the focus colors and
 * a ring, and a caret after the text while a URL is typed.
 */
function drawField(
  ctx: SKRSContext2D,
  box: Rect,
  unit: number,
  theme: Theme,
  address: Address,
  focus: number,
): void {
  const u = unit;
  const cy = box.y + box.height / 2;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, box.height / 2);
  if (focus > 0) {
    ctx.fillStyle = theme.fieldFocus;
    ctx.fill();
    ctx.lineWidth = 1.4 * u;
    ctx.strokeStyle = `rgba(${theme.ring}, 0.95)`;
    ctx.stroke();
  } else {
    ctx.fillStyle = theme.field;
    ctx.fill();
  }
  ctx.font = `500 ${15 * u}px Inter, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const pad = 17 * u;
  const room = box.width - 2 * pad;
  let { host, path } = address;
  const measure = (text: string) => ctx.measureText(text).width;
  while (path.length > 1 && measure(`${host}${path}`) > room) path = `${path.slice(0, -2)}…`;
  while (host.length > 1 && measure(`${host}${path}`) > room) host = `${host.slice(0, -2)}…`;
  const ty = cy + 0.5 * u;
  ctx.fillStyle = theme.host;
  ctx.fillText(host, box.x + pad, ty);
  ctx.fillStyle = theme.path;
  ctx.fillText(path, box.x + pad + measure(host), ty);
  if (focus > 0 && address.caret) {
    ctx.fillStyle = theme.host;
    const caret = box.x + pad + measure(`${host}${path}`) + 1.5 * u;
    ctx.fillRect(caret, cy - 9.5 * u, 1.5 * u, 19 * u);
  }
}

/**
 * Draws the controls of the browser toolbar on the bar of `window`: back, forward and
 * reload, and the address field in the middle. The caller draws the bar and the window
 * buttons. `left` is the first free x after the window buttons.
 */
export function drawBrowserBar(
  ctx: SKRSContext2D,
  window: Rect,
  bar: number,
  unit: number,
  dark: boolean,
  left: number,
  address: Address,
): void {
  const u = unit;
  const theme = THEMES[dark ? 'dark' : 'light'];
  const cy = window.y + bar / 2;
  ctx.save();
  ctx.lineWidth = 1.7 * u;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = theme.icon;
  const chevron = (x: number, direction: 1 | -1) => {
    ctx.beginPath();
    ctx.moveTo(x + direction * 3 * u, cy - 5.5 * u);
    ctx.lineTo(x - direction * 3 * u, cy);
    ctx.lineTo(x + direction * 3 * u, cy + 5.5 * u);
    ctx.stroke();
  };
  const x0 = left + 22 * u;
  chevron(x0, 1);
  ctx.globalAlpha = 0.4;
  chevron(x0 + 30 * u, -1);
  ctx.globalAlpha = 1;
  // Reload: an open circle with an arrow head at its end.
  const rx = x0 + 62 * u;
  const r = 6 * u;
  ctx.beginPath();
  ctx.arc(rx, cy, r, -0.25 * Math.PI, 1.5 * Math.PI);
  ctx.stroke();
  const tip = { x: rx + r * Math.cos(-0.25 * Math.PI), y: cy + r * Math.sin(-0.25 * Math.PI) };
  ctx.beginPath();
  ctx.moveTo(tip.x - 4.4 * u, tip.y - 0.6 * u);
  ctx.lineTo(tip.x, tip.y);
  ctx.lineTo(tip.x + 0.6 * u, tip.y - 4.4 * u);
  ctx.stroke();
  drawField(ctx, fieldBox(window, bar, u, left), u, theme, address, 0);
  ctx.restore();
}

/**
 * Draws the address field larger, above the toolbar, while a URL is typed in it. Call it
 * after the page content: the larger field covers the edge of the bar.
 */
export function drawAddressLens(
  ctx: SKRSContext2D,
  window: Rect,
  bar: number,
  unit: number,
  dark: boolean,
  left: number,
  address: Address,
): void {
  if (address.focus <= 0) return;
  const box = fieldBox(window, bar, unit, left);
  // The larger field must stay clear of the buttons on the left.
  const room = window.width - 2 * (left + 118 * unit - window.x);
  const width = Math.min(box.width, room / LENS);
  box.x += (box.width - width) / 2;
  box.width = width;
  const grow = 1 - (1 - address.focus) ** 3;
  const scale = 1 + (LENS - 1) * grow;
  ctx.save();
  ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
  ctx.scale(scale, scale);
  ctx.translate(-box.x - box.width / 2, -box.y - box.height / 2);
  ctx.shadowColor = `rgba(0, 0, 0, ${(dark ? 0.5 : 0.22) * grow})`;
  ctx.shadowBlur = 22 * unit;
  ctx.shadowOffsetY = 6 * unit;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.width, box.height, box.height / 2);
  ctx.fillStyle = THEMES[dark ? 'dark' : 'light'].fieldFocus;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  drawField(ctx, box, unit, THEMES[dark ? 'dark' : 'light'], address, 1);
  ctx.restore();
}
