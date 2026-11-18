import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  autoZoomEvents,
  clampCamera,
  computeCamera,
  interpolateCamera,
  zoomTarget,
  type CameraTrack,
} from '../../src/render/camera.ts';
import { frameTimes, type TimedEvent } from '../../src/render/timeline.ts';
import type { ZoomEvent } from '../../src/types.ts';

const VP = { width: 1280, height: 720 };
const OPTIONS = { maxScale: 3, duration: 900, easing: 'smooth' as const, followCursor: true };

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

test('follow pans to keep a moving cursor inside the visible rect', () => {
  const times = frameTimes(4000, 60);
  const n = times.length;
  const x = new Float64Array(n);
  const y = new Float64Array(n).fill(360);
  const moving = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const u = Math.min(1, Math.max(0, (times[i] - 1500) / 1200));
    x[i] = 500 + 600 * u * u * (3 - 2 * u);
    moving[i] = i > 0 && x[i] !== x[i - 1] ? 1 : 0;
  }
  const track = computeCamera(
    times,
    [zoom(200, { focus: { x: 480, y: 340, width: 40, height: 40 }, scale: 2.5 })],
    { x, y, moving, extent: 30 },
    VP,
    OPTIONS,
  );
  for (let i = 0; i < n; i++) {
    const hw = VP.width / (2 * track.scale[i]);
    assert.ok(x[i] >= track.cx[i] - hw && x[i] <= track.cx[i] + hw, `cursor out at ${times[i]}`);
  }
  assert.ok(track.cx[n - 1] > 800);
  visibleInside(track);
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
