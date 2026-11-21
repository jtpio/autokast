import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCanvas } from '@napi-rs/canvas';
import { computeCursor, cursorPath, tiltTrack } from '../../src/render/cursor.ts';
import { cursorMatrix, cursorShape, drawCursor } from '../../src/render/cursors/shapes.ts';
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

const DEG = Math.PI / 180;

/**
 * Hotspot x positions for an eased horizontal move from x0 to x1 over [t0, t1] ms.
 */
function moveX(times: Float64Array, x0: number, x1: number, t0: number, t1: number): Float64Array {
  return times.map((t) => {
    const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    return x0 + (x1 - x0) * u * u * u * (10 - 15 * u + 6 * u * u);
  });
}

test('the cursor rotates about its hotspot, which stays on the pointer position', () => {
  for (const style of ['default', 'pointer', 'grab'] as const) {
    const { hotspot } = cursorShape(style)!;
    for (const angle of [0, 0.2, -0.25]) {
      const [a, b, c, d, e, f] = cursorMatrix(hotspot, 300, 200, 2.4, angle);
      assert.ok(Math.abs(a * hotspot.x + c * hotspot.y + e - 300) < 1e-9);
      assert.ok(Math.abs(b * hotspot.x + d * hotspot.y + f - 200) < 1e-9);
    }
  }
  const centroid = (angle: number) => {
    const canvas = createCanvas(240, 240);
    const ctx = canvas.getContext('2d');
    drawCursor(ctx, 'default', 80, 80, 6, 1, angle);
    const data = ctx.getImageData(0, 0, 240, 240).data;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let k = 0; k < data.length; k += 4) {
      if (data[k + 3] < 128 || data[k] > 80) continue;
      const p = k / 4;
      sx += (p % 240) + 0.5;
      sy += Math.floor(p / 240) + 0.5;
      n++;
    }
    return [sx / n - 80, sy / n - 80];
  };
  const [x0, y0] = centroid(0);
  for (const angle of [0.22, -0.22]) {
    const [x, y] = centroid(angle);
    const bx = x * Math.cos(-angle) - y * Math.sin(-angle);
    const by = x * Math.sin(-angle) + y * Math.cos(-angle);
    assert.ok(Math.hypot(bx - x0, by - y0) < 0.6, `rotation is not about the hotspot (${angle})`);
  }
});

test('tilt is zero at rest and leans with the horizontal travel, within its limit', () => {
  const times = frameTimes(3000, 60);
  const none = new Array<boolean>(times.length).fill(false);
  assert.ok(
    tiltTrack(
      times,
      times.map(() => 300),
      none,
      1,
    ).every((a) => a === 0),
  );
  const right = tiltTrack(times, moveX(times, 100, 1100, 500, 1100), none, 1);
  const left = tiltTrack(times, moveX(times, 1100, 100, 500, 1100), none, 1);
  const peak = (a: Float64Array) => a.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0);
  assert.ok(peak(right) > 9 * DEG && peak(right) <= 13.5 * DEG, `right ${peak(right) / DEG}`);
  assert.ok(Math.abs(peak(left) + peak(right)) < 1e-9, 'left mirrors right');
  const fast = tiltTrack(times, moveX(times, 0, 3000, 500, 800), none, 1);
  assert.ok(Math.abs(peak(fast)) <= 14 * DEG, `fast ${peak(fast) / DEG}`);
  const small = tiltTrack(times, moveX(times, 300, 400, 500, 1000), none, 1);
  assert.ok(peak(small) < 4 * DEG && peak(small) > 0, `small ${peak(small) / DEG}`);
  const strong = tiltTrack(times, moveX(times, 100, 1100, 500, 1100), none, 2);
  assert.ok(peak(strong) > 1.5 * peak(right));
});

test('tilt is continuous, settles quickly after a stop and barely overshoots', () => {
  const times = frameTimes(3000, 60);
  const none = new Array<boolean>(times.length).fill(false);
  for (const x of [
    moveX(times, 100, 1100, 500, 1100),
    times.map((t) => 100 + 1.6 * Math.min(Math.max(t - 500, 0), 600)),
  ]) {
    const a = tiltTrack(times, x, none, 1);
    let step = 0;
    let bend = 0;
    for (let i = 2; i < a.length; i++) {
      step = Math.max(step, Math.abs(a[i] - a[i - 1]));
      bend = Math.max(bend, Math.abs(a[i] - 2 * a[i - 1] + a[i - 2]));
    }
    assert.ok(step < 1.6 * DEG, `step ${step / DEG}`);
    assert.ok(bend < 0.8 * DEG, `bend ${bend / DEG}`);
    const stop = times.findIndex((t) => t >= 1100);
    const settled = times.findIndex((t) => t >= 1450);
    for (let i = settled; i < a.length; i++) assert.ok(Math.abs(a[i]) < 0.2 * DEG, 'settled');
    const overshoot = Math.max(0, ...Array.from(a.slice(stop)).map((v) => -v));
    assert.ok(overshoot < 1 * DEG, `overshoot ${overshoot / DEG}`);
  }
});

test('a cut gives no lean, and tilt 0 or upright shapes give no rotation', () => {
  const times = frameTimes(2000, 60);
  const x = times.map((t) => (t < 1000 ? 200 : 900));
  const breaks = Array.from(times, (t, i) => i > 0 && times[i - 1] < 1000 && t >= 1000);
  assert.ok(tiltTrack(times, x, breaks, 1).every((a) => a === 0));
  const samples: CursorSample[] = [];
  for (let t = 0; t <= 2000; t += 1000 / 60)
    samples.push({ t, x: 100 + Math.min(t, 1000), y: 300 });
  const map = new TimeMap([], 2000);
  const events = (style: string): TimelineEvent[] => [
    { type: 'cursorStyle', t: 0, style: style as never },
  ];
  const angles = (style: string, tilt: number) =>
    computeCursor(times, samples, events(style), map, {
      visible: true,
      smoothing: 0.3,
      hideAfter: 0,
      tilt,
    }).angle;
  assert.ok(angles('default', 0).every((a) => a === 0));
  assert.ok(angles('text', 1).every((a) => a === 0));
  assert.ok(angles('ew-resize', 1).every((a) => a === 0));
  assert.ok(Math.max(...angles('default', 1)) > 5 * DEG);
});
