import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeCursor, cursorPath, normalizeStyle } from '../../src/render/cursor.ts';
import { frameTimes, TimeMap } from '../../src/render/timeline.ts';
import type { CursorSample, TimelineEvent } from '../../src/types.ts';

test('cursorPath passes through samples and holds outside them', () => {
  const path = cursorPath([
    { t: 0, x: 0, y: 0 },
    { t: 100, x: 10, y: 5 },
    { t: 200, x: 30, y: 5 },
  ]);
  assert.deepEqual(path(-50), { x: 0, y: 0 });
  assert.deepEqual(path(100), { x: 10, y: 5 });
  assert.deepEqual(path(500), { x: 30, y: 5 });
});

test('cursorPath does not overshoot where the cursor stops', () => {
  const path = cursorPath([
    { t: 0, x: 0, y: 0 },
    { t: 50, x: 50, y: 0 },
    { t: 100, x: 100, y: 0 },
    { t: 400, x: 100, y: 0 },
  ]);
  for (let t = 0; t <= 400; t += 2) {
    const p = path(t);
    assert.ok(p.x <= 100 + 1e-9 && p.x >= -1e-9, `overshoot ${p.x} at ${t}`);
  }
});

test('30 Hz samples render at 60 fps without stair-steps', () => {
  const samples: CursorSample[] = [];
  for (let i = 0; i <= 30; i++) {
    const t = (i * 1000) / 30;
    samples.push({ t, x: 150 * (1 - Math.cos((t / 1000) * 2 * Math.PI)), y: 0 });
  }
  const path = cursorPath(samples);
  const truth = (t: number) => 150 * (1 - Math.cos((t / 1000) * 2 * Math.PI));
  const times = frameTimes(1000, 60);
  const v = Array.from(times.slice(1), (t, i) => path(t).x - path(times[i]).x);
  const vt = Array.from(times.slice(1), (t, i) => truth(t) - truth(times[i]));
  for (let i = 1; i < v.length; i++) {
    const error = Math.abs(v[i] - v[i - 1] - (vt[i] - vt[i - 1]));
    assert.ok(error < 0.35, `acceleration error ${error} at frame ${i}`);
  }
});

test('computeCursor pins to the recorded position while pressed and animates the press', () => {
  const samples: CursorSample[] = [];
  for (let t = 0; t <= 2000; t += 1000 / 60) {
    const u = Math.min(1, t / 600);
    samples.push({ t, x: 100 + 500 * u * u * (3 - 2 * u), y: 300 });
  }
  const events: TimelineEvent[] = [
    { type: 'cursorStyle', t: 0, style: 'default' },
    { type: 'cursorStyle', t: 500, style: 'pointer' },
    { type: 'mouseDown', t: 800, x: 600, y: 300, button: 'left' },
    { type: 'mouseUp', t: 900, x: 600, y: 300, button: 'left' },
  ];
  const map = new TimeMap(events, 2000);
  const times = frameTimes(2000, 60);
  const track = computeCursor(times, samples, events, map, {
    visible: true,
    smoothing: 0.6,
    hideAfter: 0,
  });
  const at = (ms: number) => Math.round(ms * 0.06);
  assert.ok(Math.abs(track.x[at(850)] - 600) < 1e-6);
  assert.ok(track.press[at(880)] > 0.95);
  assert.ok(Math.abs(track.press[at(1200)]) < 1e-9);
  assert.equal(track.style[at(400)], 'default');
  assert.equal(track.style[at(700)], 'pointer');
  assert.ok(track.styleMix[at(510)] < 1 && track.styleMix[at(700)] === 1);
  assert.ok(track.opacity.every((o) => o === 1));
});

test('hideAfter fades the cursor out when idle and back in before it moves', () => {
  const samples: CursorSample[] = [
    { t: 0, x: 0, y: 0 },
    { t: 200, x: 100, y: 0 },
    { t: 3000, x: 100, y: 0 },
    { t: 3300, x: 300, y: 0 },
  ];
  const map = new TimeMap([], 4000);
  const times = frameTimes(4000, 60);
  const track = computeCursor(times, samples, [], map, {
    visible: true,
    smoothing: 0,
    hideAfter: 1000,
  });
  const at = (ms: number) => Math.round(ms * 0.06);
  assert.equal(track.opacity[at(500)], 1);
  assert.equal(track.opacity[at(2000)], 0);
  assert.equal(track.opacity[at(3100)], 1);
  assert.ok(track.opacity[at(2950)] > 0 && track.opacity[at(2950)] < 1);
});

test('unknown cursor styles map to default', () => {
  assert.equal(normalizeStyle('zoom-in'), 'default');
  assert.equal(normalizeStyle('nesw-resize'), 'nesw-resize');
});
