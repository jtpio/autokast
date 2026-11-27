import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  autoZoomEvents,
  clampCamera,
  computeCamera,
  DEAD_ZONE,
  FOLLOW_MARGIN,
  interpolateCamera,
  zoomTarget,
  type CameraTrack,
} from '../../src/render/camera.ts';
import { frameTimes, type TimedEvent } from '../../src/render/timeline.ts';
import type { ZoomEvent } from '../../src/types.ts';

const VP = { width: 1280, height: 720 };
const OPTIONS = { maxScale: 3, duration: 900, easing: 'smooth' as const, follow: 'edge' as const };

const zoom = (out: number, z: Partial<ZoomEvent>): TimedEvent<ZoomEvent> => ({
  type: 'zoom',
  t: out,
  out,
  focus: null,
  ...z,
});

function visibleInside(track: CameraTrack): void {
  for (let i = 0; i < track.scale.length; i++) {
    const hw = VP.width / (2 * track.scale[i]);
    const hh = VP.height / (2 * track.scale[i]);
    assert.ok(track.scale[i] >= 1 - 1e-9, `scale ${track.scale[i]}`);
    assert.ok(track.cx[i] - hw >= -1e-6 && track.cx[i] + hw <= VP.width + 1e-6, `x at ${i}`);
    assert.ok(track.cy[i] - hh >= -1e-6 && track.cy[i] + hh <= VP.height + 1e-6, `y at ${i}`);
  }
}

test('zoomTarget fits the focus with padding and clamps scale and center', () => {
  const fit = zoomTarget({ focus: { x: 540, y: 310, width: 200, height: 100 } }, VP, 3);
  assert.equal(fit.scale, Math.min(1280 / 280, 720 / 180, 3));
  assert.deepEqual([fit.cx, fit.cy], [640, 360]);
  const corner = zoomTarget({ focus: { x: 0, y: 0, width: 10, height: 10 }, scale: 2 }, VP, 3);
  assert.deepEqual(corner, { scale: 2, cx: 320, cy: 180 });
  assert.equal(
    zoomTarget({ focus: { x: 0, y: 0, width: 1, height: 1 }, scale: 9 }, VP, 3).scale,
    3,
  );
  assert.equal(zoomTarget({ focus: { x: 0, y: 0, width: 5000, height: 5000 } }, VP, 3).scale, 1);
  assert.deepEqual(zoomTarget({ focus: null }, VP, 3), { scale: 1, cx: 640, cy: 360 });
});

test('interpolateCamera pivots on a fixed screen point and pans straight at equal scales', () => {
  const a = { scale: 1, cx: 640, cy: 360 };
  const b = clampCamera({ scale: 3, cx: 0, cy: 0 }, VP);
  const screen = (s: typeof a, x: number) => (x - s.cx) * s.scale;
  for (const e of [0.25, 0.5, 0.75]) {
    const m = interpolateCamera(a, b, e);
    assert.ok(Math.abs(screen(m, 0) - screen(a, 0)) < 1e-6, 'corner stays put');
    assert.ok(Math.abs(m.scale - 3 ** e) < 1e-9);
  }
  const pan = interpolateCamera(
    { scale: 2, cx: 400, cy: 300 },
    { scale: 2, cx: 800, cy: 300 },
    0.5,
  );
  assert.deepEqual(pan, { scale: 2, cx: 600, cy: 300 });
});

test('a transition reaches its target and the visible rect stays in the viewport', () => {
  const times = frameTimes(3000, 60);
  const track = computeCamera(
    times,
    [zoom(500, { focus: { x: 1200, y: 650, width: 40, height: 40 }, scale: 2.5 }), zoom(2000, {})],
    null,
    VP,
    OPTIONS,
  );
  visibleInside(track);
  const i = Math.round(1500 * 0.06);
  assert.ok(Math.abs(track.scale[i] - 2.5) < 1e-6);
  assert.ok(Math.abs(track.cx[i] - (1280 - 1280 / 5)) < 1e-6);
  assert.equal(track.scale[0], 1);
  assert.equal(track.scale[times.length - 1], 1);
});

test('an interrupted transition keeps position and velocity continuous', () => {
  const times = frameTimes(3000, 60);
  const track = computeCamera(
    times,
    [
      zoom(300, { focus: { x: 100, y: 100, width: 10, height: 10 }, scale: 3 }),
      zoom(700, { focus: { x: 1100, y: 600, width: 10, height: 10 }, scale: 2 }),
    ],
    null,
    VP,
    OPTIONS,
  );
  const v = (f: Float64Array, i: number) => f[i] - f[i - 1];
  let maxV = 0;
  let maxDv = 0;
  for (let i = 2; i < times.length; i++) {
    for (const f of [track.cx, track.cy]) {
      maxV = Math.max(maxV, Math.abs(v(f, i)));
      maxDv = Math.max(maxDv, Math.abs(v(f, i) - v(f, i - 1)));
    }
  }
  assert.ok(maxDv < 0.12 * maxV, `velocity jump ${maxDv} vs peak ${maxV}`);
  visibleInside(track);
});

/**
 * Cursor track from keyframes [time, x, y], eased between them.
 */
function cursorPathOf(times: Float64Array, keys: [number, number, number][]) {
  const n = times.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = times[i];
    let k = 0;
    while (k < keys.length - 1 && keys[k + 1][0] <= t) k++;
    const [t0, x0, y0] = keys[k];
    const [t1, x1, y1] = keys[Math.min(k + 1, keys.length - 1)];
    const u = t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 1;
    const e = u * u * (3 - 2 * u);
    x[i] = x0 + (x1 - x0) * e;
    y[i] = y0 + (y1 - y0) * e;
  }
  return { x, y, extent: 30 };
}

const DIALOG = { x: 360, y: 102, width: 560, height: 515 };
const at = (times: Float64Array, ms: number) => times.findIndex((t) => t >= ms);

test('a cursor outside the view when the zoom starts does not pull the camera', () => {
  const times = frameTimes(5000, 60);
  const cursor = cursorPathOf(times, [
    [0, 1100, 28],
    [2500, 1100, 28],
    [3000, 1180, 60],
  ]);
  const track = computeCamera(
    times,
    [zoom(500, { focus: DIALOG, scale: 1.3 })],
    cursor,
    VP,
    OPTIONS,
  );
  const home = zoomTarget({ focus: DIALOG, scale: 1.3 }, VP, 3);
  for (let i = at(times, 1500); i < times.length; i++) {
    assert.equal(track.scale[i], home.scale);
    assert.ok(Math.abs(track.cx[i] - home.cx) < 1e-9 && Math.abs(track.cy[i] - home.cy) < 1e-9);
  }
});

test('follow offsets the camera a little near an edge and returns home in the middle', () => {
  const times = frameTimes(8000, 60);
  const home = zoomTarget({ focus: DIALOG, scale: 1.3 }, VP, 3);
  const hw = VP.width / (2 * home.scale);
  const cursor = cursorPathOf(times, [
    [0, 1100, 28],
    [2000, 1100, 28],
    [2600, 640, 360],
    [3000, 640, 360],
    [3500, home.cx + hw - 100, 360],
    [5000, home.cx + hw - 100, 360],
    [5500, 640, 360],
  ]);
  const track = computeCamera(
    times,
    [zoom(500, { focus: DIALOG, scale: 1.3 })],
    cursor,
    VP,
    OPTIONS,
  );
  const near = at(times, 4600);
  const offset = track.cx[near] - home.cx;
  const smallest = cursor.x[near] - (home.cx + hw - (FOLLOW_MARGIN * VP.width) / home.scale - 30);
  assert.ok(smallest > 0 && Math.abs(offset - smallest) < 1, `offset ${offset} vs ${smallest}`);
  assert.ok(Math.abs(track.cy[near] - home.cy) < 0.01);
  assert.ok(cursor.x[near] < track.cx[near] + hw, 'cursor stays in view');
  const back = at(times, 7500);
  assert.ok(Math.abs(track.cx[back] - home.cx) < 0.5, `left offset ${track.cx[back] - home.cx}`);
  assert.ok(Math.abs(track.cy[back] - home.cy) < 0.5);
});

test('follow keeps a cursor that leaves far in view', () => {
  const times = frameTimes(4000, 60);
  const n = times.length;
  const cursor = cursorPathOf(times, [
    [0, 500, 360],
    [1500, 500, 360],
    [2700, 1100, 360],
  ]);
  const track = computeCamera(
    times,
    [zoom(200, { focus: { x: 480, y: 340, width: 40, height: 40 }, scale: 2.5 })],
    cursor,
    VP,
    OPTIONS,
  );
  for (let i = 0; i < n; i++) {
    const hw = VP.width / (2 * track.scale[i]);
    const x = cursor.x[i];
    assert.ok(x >= track.cx[i] - hw && x <= track.cx[i] + hw, `cursor out at ${times[i]}`);
  }
  assert.ok(track.cx[n - 1] > 800);
  visibleInside(track);
});

test('a directive with follow overrides zoom.follow until the next directive', () => {
  const times = frameTimes(9000, 60);
  const cursor = cursorPathOf(times, [
    [0, 640, 360],
    [1500, 640, 360],
    [2500, 1150, 360],
    [3500, 640, 360],
    [5500, 640, 360],
    [6500, 1150, 360],
  ]);
  const focus = { x: 600, y: 340, width: 80, height: 40 };
  const home = zoomTarget({ focus, scale: 2 }, VP, 3);
  const off = computeCamera(
    times,
    [zoom(200, { focus, scale: 2, follow: 'off' }), zoom(4000, { focus, scale: 2 })],
    cursor,
    VP,
    OPTIONS,
  );
  assert.equal(off.cx[at(times, 2600)], home.cx);
  assert.ok(off.cx[at(times, 6800)] > home.cx + 100, 'the next directive follows again');
  const on = computeCamera(
    times,
    [zoom(200, { focus, scale: 2, follow: 'edge' }), zoom(4000, { focus, scale: 2 })],
    cursor,
    VP,
    { ...OPTIONS, follow: 'off' },
  );
  assert.ok(on.cx[at(times, 2600)] > home.cx + 100);
  assert.equal(on.cx[at(times, 6800)], home.cx);
  const travel = computeCamera(
    times,
    [zoom(200, { focus, scale: 2, follow: 'cursor' }), zoom(4000, { focus, scale: 2 })],
    cursor,
    VP,
    { ...OPTIONS, follow: 'off' },
  );
  assert.ok(travel.cx[at(times, 2000)] > home.cx + 20, 'cursor mode moves early');
  assert.equal(travel.cx[at(times, 6800)], home.cx);
});

const ACROSS: [number, number, number][] = [
  [0, 640, 360],
  [1500, 640, 360],
  [3500, 900, 450],
];
const CENTER = { x: 600, y: 340, width: 80, height: 40 };

test("follow 'off' keeps the directed framing while the cursor crosses the page", () => {
  const times = frameTimes(6000, 60);
  const cursor = cursorPathOf(times, ACROSS);
  const track = computeCamera(times, [zoom(200, { focus: CENTER, scale: 2 })], cursor, VP, {
    ...OPTIONS,
    follow: 'off',
  });
  const home = zoomTarget({ focus: CENTER, scale: 2 }, VP, 3);
  for (let i = at(times, 1100); i < times.length; i++) {
    assert.equal(track.cx[i], home.cx);
    assert.equal(track.cy[i], home.cy);
  }
});

test("follow 'edge' pans only when the cursor nears the edge", () => {
  const times = frameTimes(6000, 60);
  const cursor = cursorPathOf(times, [...ACROSS.slice(0, 2), [3500, 1000, 450]]);
  const track = computeCamera(times, [zoom(200, { focus: CENTER, scale: 2 })], cursor, VP, OPTIONS);
  const home = zoomTarget({ focus: CENTER, scale: 2 }, VP, 3);
  const hw = VP.width / 4;
  const limit = home.cx + hw - (FOLLOW_MARGIN * VP.width) / 2 - 30;
  const lead = 2000 / 6;
  for (let i = at(times, 1100); i < times.length; i++) {
    const ahead = times.findIndex((t) => t >= times[i] + lead);
    const later = ahead < 0 ? times.length - 1 : ahead;
    if (Math.max(...Array.from(cursor.x.slice(i, later + 1))) < limit) {
      assert.equal(track.cx[i], home.cx, `moved early at ${times[i]}`);
    }
    assert.ok(cursor.x[i] < track.cx[i] + hw, 'cursor visible');
  }
  assert.ok(track.cx[times.length - 1] > home.cx + 10);
});

test("follow 'cursor' travels with the cursor, calmly, and never returns home", () => {
  const times = frameTimes(7000, 60);
  const cursor = cursorPathOf(times, ACROSS);
  const track = computeCamera(times, [zoom(200, { focus: CENTER, scale: 2 })], cursor, VP, {
    ...OPTIONS,
    follow: 'cursor',
  });
  const hw = VP.width / 4;
  const hh = VP.height / 4;
  const dead = DEAD_ZONE * hw;
  for (let i = at(times, 1100); i < times.length; i++) {
    assert.ok(Math.abs(cursor.x[i] - track.cx[i]) <= dead + 0.1 * hw, `x out at ${times[i]}`);
    assert.ok(Math.abs(cursor.y[i] - track.cy[i]) <= DEAD_ZONE * hh + 0.1 * hh, `y out`);
  }
  let peak = 0;
  let jump = 0;
  for (let i = 2; i < times.length; i++) {
    const v = track.cx[i] - track.cx[i - 1];
    peak = Math.max(peak, Math.abs(v));
    jump = Math.max(jump, Math.abs(v - (track.cx[i - 1] - track.cx[i - 2])));
  }
  assert.ok(jump < 0.12 * peak, `velocity jump ${jump} vs ${peak}`);
  for (let i = at(times, 3500) + 1; i < times.length; i++) {
    assert.ok(track.cx[i] - track.cx[i - 1] >= -1e-9, `oscillation at ${times[i]}`);
  }
  const last = times.length - 1;
  assert.ok(Math.abs(track.cx[last] - track.cx[last - 1]) < 1e-3, 'settled');
  assert.ok(Math.abs(900 - track.cx[last]) <= dead + 1e-6);
  assert.ok(track.cx[last] > 700, 'stays with the cursor');
});

test('small cursor wiggles inside the dead zone do not move the camera', () => {
  const times = frameTimes(5000, 60);
  const keys: [number, number, number][] = [[0, 640, 360]];
  for (let t = 1500; t < 4500; t += 250) keys.push([t, 640 + (keys.length % 2 ? 40 : -40), 370]);
  const cursor = cursorPathOf(times, keys);
  const home = zoomTarget({ focus: CENTER, scale: 2 }, VP, 3);
  for (const follow of ['edge', 'cursor'] as const) {
    const track = computeCamera(times, [zoom(200, { focus: CENTER, scale: 2 })], cursor, VP, {
      ...OPTIONS,
      follow,
    });
    for (let i = at(times, 1100); i < times.length; i++) {
      assert.equal(track.cx[i], home.cx, `${follow} moved at ${times[i]}`);
    }
  }
});

test("follow 'edge' on a cursor-anchored zoom stays where the cursor pushed it", () => {
  const times = frameTimes(7000, 60);
  const cursor = cursorPathOf(times, [
    [0, 640, 360],
    [1500, 640, 360],
    [2500, 1100, 360],
    [3500, 1100, 360],
    [4500, 800, 360],
  ]);
  const point = { x: 640, y: 360, width: 0, height: 0 };
  const anchored = computeCamera(
    times,
    [zoom(200, { focus: point, scale: 2, anchor: 'cursor' })],
    cursor,
    VP,
    OPTIONS,
  );
  const target = computeCamera(times, [zoom(200, { focus: point, scale: 2 })], cursor, VP, OPTIONS);
  const last = times.length - 1;
  assert.ok(anchored.cx[last] > 800, `anchored ${anchored.cx[last]}`);
  assert.ok(Math.abs(target.cx[last] - 640) < 0.5, `target ${target.cx[last]}`);
});

test('followSpeed multiplies the follow spring', () => {
  const times = frameTimes(6000, 60);
  const cursor = cursorPathOf(times, [
    [0, 640, 360],
    [1500, 640, 360],
    [1700, 900, 360],
  ]);
  const settle = (followSpeed: number) => {
    const track = computeCamera(times, [zoom(200, { focus: CENTER, scale: 2 })], cursor, VP, {
      ...OPTIONS,
      follow: 'cursor',
      followSpeed,
    });
    const final = track.cx[times.length - 1];
    const start = track.cx[at(times, 1100)];
    return times[track.cx.findIndex((x) => x >= start + 0.9 * (final - start))];
  };
  const slow = settle(1) - 1100;
  const fast = settle(2) - 1100;
  assert.ok(fast < slow * 0.8, `speed 2 settles at ${fast}, speed 1 at ${slow}`);
});

test('zoom levels give the scale; scale wins; unknown levels name the known ones', () => {
  const times = frameTimes(2000, 60);
  const levels = { wide: 1.3, medium: 1.6, close: 2.2, hero: 2.8 };
  const final = (z: Partial<ZoomEvent>, maxScale = 3) =>
    computeCamera(times, [zoom(100, { focus: CENTER, ...z })], null, VP, {
      ...OPTIONS,
      maxScale,
      levels,
    }).scale[times.length - 1];
  assert.equal(final({ level: 'close' }), 2.2);
  assert.equal(final({ level: 'hero' }), 2.8);
  assert.equal(final({ level: 'hero' }, 2), 2);
  assert.equal(final({ level: 'close', scale: 1.5 }), 1.5);
  assert.throws(() => final({ level: 'nope' }), /Known levels: wide, medium, close, hero/);
});

test('auto zoom zooms in before the first click, pans to far clicks, and zooms out after', () => {
  const events = [
    { type: 'mouseDown', t: 2000, out: 2000, x: 200, y: 200, button: 'left' },
    { type: 'mouseDown', t: 3000, out: 3000, x: 1100, y: 600, button: 'left' },
    { type: 'mouseDown', t: 9000, out: 9000, x: 640, y: 360, button: 'left' },
  ] as TimedEvent[];
  const zooms = autoZoomEvents(
    events,
    () => ({ x: 0, y: 0 }),
    VP,
    { scale: 1.8, hold: 1500, mergeWindow: 2500 },
    900,
  );
  assert.deepEqual(
    zooms.map((z) => [z.out, z.focus ? 'in' : 'out']),
    [
      [800, 'in'],
      [1800, 'in'],
      [4500, 'out'],
      [7800, 'in'],
      [10500, 'out'],
    ],
  );
});
