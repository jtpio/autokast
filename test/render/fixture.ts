import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { saveSession } from '../../src/session.ts';
import type {
  CursorSample,
  CursorStyle,
  FrameRef,
  Point,
  Rect,
  Session,
  TimelineEvent,
} from '../../src/types.ts';

/**
 * A synthetic session that looks like a recorded web app: 2560x1440 frames for a
 * 1280x720 viewport, curved cursor moves, clicks, typing, zooms, a cut, a speed range,
 * a spotlight and a drag.
 */

const VIEWPORT = { width: 1280, height: 720 };
const DSF = 2;

interface AppState {
  hover: 'new' | 'create' | 'row' | null;
  pressed: 'new' | 'create' | null;
  modal: boolean;
  focused: boolean;
  typed: string;
  newRow: boolean;
  tick: number;
  dragX: number;
}

const BASE: AppState = {
  hover: null,
  pressed: null,
  modal: false,
  focused: false,
  typed: '',
  newRow: false,
  tick: 0,
  dragX: 0,
};

export const RECTS = {
  newButton: { x: 1132, y: 12, width: 132, height: 32 },
  toolbarRight: { x: 1020, y: 6, width: 252, height: 44 },
  modal: { x: 440, y: 210, width: 400, height: 250 },
  input: { x: 464, y: 296, width: 352, height: 40 },
  create: { x: 722, y: 400, width: 94, height: 36 },
  row0: { x: 264, y: 296, width: 984, height: 44 },
  card0: { x: 264, y: 148, width: 320, height: 88 },
  cards: { x: 264, y: 148, width: 984, height: 88 },
} satisfies Record<string, Rect>;

const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
const inside = (p: Point, r: Rect) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

function text(
  ctx: SKRSContext2D,
  value: string,
  x: number,
  y: number,
  size: number,
  color: string,
  weight = 400,
  align: CanvasTextAlign = 'left',
): void {
  ctx.font = `${weight} ${size}px Inter`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(value, x, y);
}

function box(
  ctx: SKRSContext2D,
  r: Rect,
  fill: string,
  radius: number,
  stroke?: string,
  lineWidth = 1,
): void {
  ctx.beginPath();
  ctx.roundRect(r.x, r.y, r.width, r.height, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

const ROWS = [
  ['Onboarding revamp', 'Active', 'Maya Chen', '2 min ago'],
  ['Pricing page', 'Review', 'Jonas Weber', '1 h ago'],
  ['Mobile checkout', 'Active', 'Ana Souza', '3 h ago'],
  ['Design tokens v2', 'Draft', 'Liam Park', 'Yesterday'],
  ['Q3 analytics', 'Active', 'Sara Ivanova', 'Yesterday'],
  ['Help center', 'Draft', 'Tom Reed', 'Mon'],
  ['Referral program', 'Review', 'Ines Duarte', 'Sep 12'],
  ['API docs', 'Active', 'Kenji Mori', 'Sep 9'],
];

const PILL: Record<string, [string, string]> = {
  Active: ['#e7f6ec', '#1a7f43'],
  Review: ['#fdf3e1', '#a35f00'],
  Draft: ['#eef0f3', '#555b66'],
};

function drawApp(ctx: SKRSContext2D, s: AppState): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1280, 720);

  ctx.fillStyle = '#f8f9fb';
  ctx.fillRect(0, 56, 232, 664);
  ctx.fillStyle = '#e8e9ee';
  ctx.fillRect(231, 56, 1, 664);
  ctx.fillRect(0, 55, 1280, 1);

  const logo = ctx.createLinearGradient(20, 14, 48, 42);
  logo.addColorStop(0, '#334155');
  logo.addColorStop(1, '#0f172a');
  box(ctx, { x: 20, y: 14, width: 28, height: 28 }, '#0f172a', 7);
  ctx.fillStyle = logo;
  ctx.fill();
  text(ctx, 'A', 34, 34, 16, '#ffffff', 700, 'center');
  text(ctx, 'Acme Studio', 58, 33, 15, '#111827', 600);

  box(ctx, { x: 420, y: 12, width: 440, height: 32 }, '#f3f4f6', 8, '#e5e7eb');
  ctx.beginPath();
  ctx.arc(441, 27, 5.5, 0, Math.PI * 2);
  ctx.moveTo(445, 31);
  ctx.lineTo(449, 35);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#9ca3af';
  ctx.stroke();
  text(ctx, 'Search projects, people, docs…', 458, 32, 13, '#9ca3af');
  box(ctx, { x: 818, y: 18, width: 32, height: 20 }, '#ffffff', 5, '#e5e7eb');
  text(ctx, '⌘K', 834, 32, 11, '#6b7280', 500, 'center');

  box(ctx, { x: 1036, y: 12, width: 84, height: 32 }, '#ffffff', 8, '#d1d5db');
  text(ctx, 'Share', 1078, 32, 13, '#374151', 500, 'center');
  const newFill = s.pressed === 'new' ? '#1e40af' : s.hover === 'new' ? '#1d4ed8' : '#2563eb';
  box(ctx, RECTS.newButton, newFill, 8);
  text(ctx, '+  New project', 1198, 32, 13, '#ffffff', 600, 'center');

  text(ctx, 'WORKSPACE', 20, 88, 11, '#9ca3af', 600);
  ['Dashboard', 'Projects', 'Analytics', 'Team', 'Settings'].forEach((label, i) => {
    const y = 100 + i * 36;
    const active = label === 'Projects';
    if (active) box(ctx, { x: 10, y, width: 212, height: 32 }, '#e8eefc', 6);
    box(ctx, { x: 22, y: y + 8, width: 16, height: 16 }, active ? '#2563eb' : '#c7cbd3', 4);
    text(ctx, label, 48, y + 21, 14, active ? '#1d4ed8' : '#374151', active ? 600 : 500);
  });
  text(ctx, 'Storage', 20, 640, 12, '#6b7280', 500);
  box(ctx, { x: 20, y: 652, width: 192, height: 6 }, '#e5e7eb', 3);
  box(ctx, { x: 20, y: 652, width: 124, height: 6 }, '#64748b', 3);
  text(ctx, '6.4 GB of 10 GB used', 20, 678, 11, '#9ca3af');

  text(ctx, 'Projects', 264, 100, 26, '#0f172a', 700);
  text(ctx, '12 active · Updated 2 minutes ago', 264, 124, 13, '#6b7280');
  box(ctx, { x: 1060, y: 80, width: 80, height: 32 }, '#ffffff', 8, '#d1d5db');
  text(ctx, 'Filter', 1100, 100, 13, '#374151', 500, 'center');
  box(ctx, { x: 1152, y: 80, width: 96, height: 32 }, '#ffffff', 8, '#d1d5db');
  text(ctx, 'Export', 1200, 100, 13, '#374151', 500, 'center');

  const stats = [
    ['Active projects', '12', '+2 this week'],
    ['Open reviews', '5', '−1 since Monday'],
    ['Weekly throughput', `${84 + s.tick}%`, 'Live'],
  ];
  stats.forEach(([label, value, delta], i) => {
    const x = 264 + i * 332 + (i === 0 ? s.dragX : 0);
    box(ctx, { x, y: 148, width: 320, height: 88 }, '#ffffff', 10, '#e5e7eb');
    text(ctx, label, x + 16, 172, 12, '#6b7280', 500);
    text(ctx, value, x + 16, 210, 28, '#0f172a', 700);
    text(ctx, delta, x + 16, 228, 11, i === 1 ? '#b45309' : '#15803d', 500);
    if (i === 2) {
      ctx.beginPath();
      for (let k = 0; k <= 24; k++) {
        const px = x + 150 + k * 6.5;
        const py = 196 - 18 * Math.sin(k * 0.55 + s.tick * 0.6) * Math.exp(-k / 40) - k * 0.6;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#2563eb';
      ctx.stroke();
    }
  });

  box(ctx, { x: 264, y: 260, width: 984, height: 400 }, '#ffffff', 10, '#e5e7eb');
  ctx.fillStyle = '#f9fafb';
  ctx.fillRect(265, 261, 982, 35);
  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(264, 296, 984, 1);
  ['NAME', 'STATUS', 'OWNER', 'UPDATED'].forEach((h, i) => {
    text(ctx, h, [284, 600, 760, 1080][i], 283, 11, '#6b7280', 600);
  });
  const rows = s.newRow ? [['Launch plan', 'Draft', 'You', 'Just now'], ...ROWS] : ROWS;
  rows.slice(0, 8).forEach((row, i) => {
    const y = 296 + i * 44;
    if (s.newRow && i === 0) {
      ctx.fillStyle = s.hover === 'row' ? '#e3ecff' : '#eef4ff';
      ctx.fillRect(265, y + 1, 982, 43);
    }
    if (i > 0) {
      ctx.fillStyle = '#f0f1f4';
      ctx.fillRect(280, y, 952, 1);
    }
    text(ctx, row[0], 284, y + 27, 14, '#111827', 500);
    const [bg, fg] = PILL[row[1]];
    ctx.font = '600 12px Inter';
    const w = ctx.measureText(row[1]).width + 20;
    box(ctx, { x: 600, y: y + 11, width: w, height: 22 }, bg, 11);
    text(ctx, row[1], 600 + w / 2, y + 26, 12, fg, 600, 'center');
    ctx.beginPath();
    ctx.arc(772, y + 22, 11, 0, Math.PI * 2);
    ctx.fillStyle = ['#c7d2fe', '#fde68a', '#bbf7d0', '#fecaca'][i % 4];
    ctx.fill();
    text(
      ctx,
      row[2]
        .split(' ')
        .map((p) => p[0])
        .join(''),
      772,
      y + 26,
      10,
      '#374151',
      600,
      'center',
    );
    text(ctx, row[2], 792, y + 27, 13, '#374151');
    text(ctx, row[3], 1080, y + 27, 13, '#6b7280');
  });
  text(ctx, 'Showing 1–8 of 24 projects', 264, 690, 11, '#9ca3af');

  if (!s.modal) return;
  ctx.fillStyle = 'rgba(15, 23, 42, 0.38)';
  ctx.fillRect(0, 0, 1280, 720);
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 16;
  box(ctx, RECTS.modal, '#ffffff', 14);
  ctx.restore();
  text(ctx, 'Create project', 464, 250, 18, '#0f172a', 600);
  text(ctx, 'Projects group your docs, boards and reviews.', 464, 272, 12.5, '#6b7280');
  text(ctx, 'Project name', 464, 290, 12, '#374151', 500);
  if (s.focused)
    box(ctx, { ...RECTS.input, x: 461, y: 293, width: 358, height: 46 }, '#dbe7ff', 10);
  box(ctx, RECTS.input, '#ffffff', 8, s.focused ? '#2563eb' : '#d1d5db', s.focused ? 1.5 : 1);
  if (s.typed) text(ctx, s.typed, 478, 321, 14, '#111827');
  else text(ctx, 'e.g. Launch plan', 478, 321, 14, '#9ca3af');
  if (s.focused) {
    ctx.font = '400 14px Inter';
    const x = 478 + (s.typed ? ctx.measureText(s.typed).width + 1 : 0);
    ctx.fillStyle = '#111827';
    ctx.fillRect(x, 306, 1.2, 20);
  }
  text(ctx, 'Visible to everyone in Acme Studio', 464, 362, 12, '#6b7280');
  box(ctx, { x: 620, y: 400, width: 90, height: 36 }, '#ffffff', 8, '#d1d5db');
  text(ctx, 'Cancel', 665, 423, 13, '#374151', 500, 'center');
  const createFill =
    s.pressed === 'create' ? '#1e40af' : s.hover === 'create' ? '#1d4ed8' : '#2563eb';
  box(ctx, RECTS.create, createFill, 8);
  text(ctx, 'Create', 769, 423, 13, '#ffffff', 600, 'center');
}

function minJerk(u: number): number {
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

/**
 * Cursor samples every ~16.7 ms along a curved, eased path.
 */
function move(
  samples: CursorSample[],
  from: Point,
  to: Point,
  t0: number,
  t1: number,
  bend = 0.22,
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const c = { x: from.x + dx / 2 - dy * bend, y: from.y + dy / 2 + dx * bend };
  for (let t = t0; t <= t1 + 0.01; t += 1000 / 60) {
    const u = minJerk(Math.min(1, (t - t0) / (t1 - t0)));
    const a = (1 - u) * (1 - u);
    const b = 2 * (1 - u) * u;
    const d = u * u;
    samples.push({
      t: Math.round(t * 10) / 10,
      x: a * from.x + b * c.x + d * to.x,
      y: a * from.y + b * c.y + d * to.y,
    });
  }
}

export interface FixtureOptions {
  /**
   * Captured frame scale: 2 gives 2560x1440 frames.
   */
  deviceScaleFactor?: number;
}

/**
 * Writes the fixture session into `dir` and returns it.
 */
export async function createFixture(dir: string, options: FixtureOptions = {}): Promise<Session> {
  const dsf = options.deviceScaleFactor ?? DSF;
  await mkdir(path.join(dir, 'frames'), { recursive: true });
  const cursor: CursorSample[] = [];
  const events: TimelineEvent[] = [];
  const style = (t: number, s: CursorStyle) => events.push({ type: 'cursorStyle', t, style: s });
  const click = (t: number, p: Point, hold = 80) => {
    events.push({ type: 'mouseDown', t, button: 'left', ...p });
    events.push({ type: 'mouseUp', t: t + hold, button: 'left', ...p });
  };

  const start = { x: 700, y: 430 };
  const pNew = center(RECTS.newButton);
  const pInput = { x: 560, y: 316 };
  const pCreate = center(RECTS.create);
  const pRow = { x: 430, y: 318 };
  const card0 = { x: 420, y: 196 };
  const card2 = { x: 1090, y: 196 };

  cursor.push({ t: 0, ...start });
  style(0, 'default');
  move(cursor, start, pNew, 300, 1100);
  events.push({ type: 'zoom', t: 700, focus: RECTS.toolbarRight, scale: 2.2 });
  click(1300, pNew);
  events.push({ type: 'zoom', t: 1500, focus: RECTS.modal });
  move(cursor, pNew, pInput, 1700, 2300, -0.18);
  click(2400, pInput, 70);
  const typed = 'Launch plan';
  for (let i = 0; i < typed.length; i++) {
    events.push({ type: 'key', t: 2600 + i * 80, kind: 'text', key: typed[i] });
  }
  events.push({ type: 'cut', t: 3700, end: 4500 });
  move(cursor, pInput, { x: 980, y: 610 }, 3750, 4100);
  move(cursor, { x: 980, y: 610 }, { x: 640, y: 380 }, 4150, 4450);
  move(cursor, { x: 640, y: 380 }, pCreate, 4600, 5200, 0.12);
  click(5350, pCreate);
  events.push({ type: 'zoom', t: 5500, focus: null, duration: 1000 });
  move(cursor, pCreate, pRow, 5700, 6400, 0.2);
  events.push({ type: 'spotlight', t: 6600, duration: 1800, rect: RECTS.row0 });
  events.push(
    { type: 'caption', t: 200, duration: 2000, text: 'Create a **new project**' },
    {
      type: 'caption',
      t: 2500,
      duration: 2600,
      text: 'Give it a name. The camera stays on the cursor while you type, so nothing is missed.',
    },
    { type: 'caption', t: 9300, duration: 2600, text: 'Every number, one glance away' },
    { type: 'key', t: 400, kind: 'shortcut', key: 'Meta+K' },
    { type: 'key', t: 3550, kind: 'shortcut', key: 'Shift+Enter' },
    { type: 'key', t: 10200, kind: 'shortcut', key: 'Meta+Z' },
    { type: 'key', t: 10500, kind: 'shortcut', key: 'Meta+Z' },
    { type: 'key', t: 12300, kind: 'shortcut', key: 'Control+Shift+C' },
    { type: 'key', t: 12900, kind: 'shortcut', key: 'Escape' },
  );
  events.push({ type: 'speed', t: 7000, end: 8600, rate: 2 });
  for (let t = 7000; t <= 8600; t += 1000 / 60) {
    const a = ((t - 7000) / 1600) * Math.PI * 3;
    cursor.push({
      t,
      x: 760 + 300 * Math.sin(a) - (330 * (1 - Math.cos(a / 3))) / 2,
      y: 420 + 110 * Math.sin(a * 0.5),
    });
  }
  const loopEnd = cursor[cursor.length - 1];
  move(cursor, loopEnd, card0, 8650, 9100);
  events.push({ type: 'zoom', t: 8800, focus: RECTS.card0, scale: 2.4 });
  move(cursor, card0, card2, 9900, 11000, 0.08);
  style(11200, 'grab');
  events.push({ type: 'mouseDown', t: 11400, button: 'left', ...card2 });
  style(11400, 'grabbing');
  move(cursor, card2, { x: 980, y: 300 }, 11500, 12100, -0.1);
  events.push({ type: 'mouseUp', t: 12200, button: 'left', x: 980, y: 300 });
  style(12200, 'grab');
  style(12500, 'default');
  events.push({ type: 'zoom', t: 12600, focus: null });
  events.push({ type: 'marker', t: 13000, label: 'end' });
  const duration = 13800;
  cursor.push({ t: duration, x: 980, y: 300 });
  cursor.sort((a, b) => a.t - b.t);

  const positionAt = (t: number) => {
    let p = cursor[0];
    for (const s of cursor) if (s.t <= t) p = s;
    return p;
  };
  const firstInside = (r: Rect, from: number, to: number) =>
    cursor.find((s) => s.t >= from && s.t <= to && inside(s, r))?.t ?? from;

  const enterNew = firstInside(RECTS.newButton, 300, 1100);
  const enterInput = firstInside(RECTS.input, 1700, 2300);
  const leaveNew = cursor.find((s) => s.t > 1700 && !inside(s, RECTS.newButton))?.t ?? 1750;
  const enterCreate = firstInside(RECTS.create, 4600, 5200);
  const enterRow = firstInside(RECTS.row0, 5700, 6400);
  style(enterNew, 'pointer');
  style(leaveNew, 'default');
  style(enterInput, 'text');
  style(4600, 'default');
  style(enterCreate, 'pointer');
  style(5700, 'default');

  const states: [number, Partial<AppState>][] = [
    [0, {}],
    [enterNew, { hover: 'new' }],
    [1300, { hover: 'new', pressed: 'new' }],
    [1380, { hover: 'new' }],
    [1420, { modal: true }],
    [2400, { modal: true, focused: true }],
  ];
  for (let i = 1; i <= typed.length; i++) {
    states.push([
      2600 + (i - 1) * 80 + 12,
      { modal: true, focused: true, typed: typed.slice(0, i) },
    ]);
  }
  const done = { modal: true, focused: true, typed };
  for (const t of [3800, 4000, 4200, 4400]) states.push([t, { ...done, tick: t / 100 }]);
  states.push([4500, { ...done, tick: 0 }]);
  states.push([enterCreate, { ...done, hover: 'create' }]);
  states.push([5350, { ...done, hover: 'create', pressed: 'create' }]);
  states.push([5480, { newRow: true }]);
  states.push([enterRow, { newRow: true, hover: 'row' }]);
  states.push([6500, { newRow: true }]);
  for (let t = 7000, k = 1; t < 8600; t += 100, k++)
    states.push([t, { newRow: true, tick: k % 12 }]);
  states.push([8600, { newRow: true }]);
  for (let t = 11500; t <= 12100; t += 50) {
    const p = positionAt(t);
    states.push([t, { newRow: true, dragX: Math.round(p.x - card2.x) / 8 }]);
  }
  states.push([12200, { newRow: true }]);
  states.sort((a, b) => a[0] - b[0]);

  const canvas = createCanvas(VIEWPORT.width * dsf, VIEWPORT.height * dsf);
  const ctx = canvas.getContext('2d');
  const frames: FrameRef[] = [];
  const files = new Map<string, string>();
  for (const [t, partial] of states) {
    const key = JSON.stringify(partial);
    let file = files.get(key);
    if (!file) {
      file = `frames/${String(files.size).padStart(5, '0')}.jpg`;
      ctx.setTransform(dsf, 0, 0, dsf, 0, 0);
      drawApp(ctx, { ...BASE, ...partial });
      await writeFile(path.join(dir, file), await canvas.encode('jpeg', 92));
      files.set(key, file);
    }
    frames.push({ t, file });
  }

  const session: Session = {
    version: 1,
    name: 'fixture',
    createdAt: new Date(0).toISOString(),
    url: 'https://acme.example/projects',
    viewport: VIEWPORT,
    deviceScaleFactor: dsf,
    captureMode: 'frame-perfect',
    frameSize: { width: VIEWPORT.width * dsf, height: VIEWPORT.height * dsf },
    duration,
    frames,
    cursor,
    events: events.sort((a, b) => a.t - b.t),
  };
  await saveSession(dir, session);
  return session;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node test/render/fixture.ts <dir>');
  const session = await createFixture(dir);
  console.log(`Wrote ${session.frames.length} frames to ${dir}`);
}
