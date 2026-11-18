import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EASING_NAMES, easing } from '../../src/render/easing.ts';
import { springSmooth, springStep } from '../../src/render/spring.ts';

const derivative = (f: (t: number) => number, t: number, h = 1e-4) =>
  (f(Math.min(1, t + h)) - f(Math.max(0, t - h))) / (Math.min(1, t + h) - Math.max(0, t - h));

test('every easing goes from 0 to 1, clamps, and never moves backward', () => {
  for (const name of EASING_NAMES) {
    const e = easing(name);
    assert.equal(e(0), 0, name);
    assert.ok(Math.abs(e(1) - 1) < 1e-9, name);
    assert.equal(e(-1), 0, name);
    assert.equal(e(2), 1, name);
    let last = 0;
    for (let i = 1; i <= 1000; i++) {
      const v = e(i / 1000);
      assert.ok(v >= last - 1e-12, `${name} decreases at ${i / 1000}`);
      last = v;
    }
  }
});

test('unknown easing names fall back to smooth', () => {
  assert.equal(easing(undefined)(0.3), easing('smooth')(0.3));
});

test('smooth starts and lands softly, with no linear middle', () => {
  const e = easing('smooth');
  assert.ok(derivative(e, 0.001) < 0.01);
  assert.ok(derivative(e, 0.999) < 0.01);
  const peak = Math.max(...Array.from({ length: 99 }, (_, i) => derivative(e, (i + 1) / 100)));
  assert.ok(peak > 2 && peak < 2.6, `peak velocity ${peak}`);
  let prev = derivative(e, 0.3) - derivative(e, 0.29);
  for (let t = 0.31; t < 0.6; t += 0.01) {
    const accel = derivative(e, t) - derivative(e, t - 0.01);
    assert.ok(Math.abs(accel) > 1e-4 || Math.sign(accel) !== Math.sign(prev), 'linear stretch');
    prev = accel;
  }
});

test('springStep converges without overshoot and is exact for any step size', () => {
  let [x, v] = [0, 0];
  let max = 0;
  for (let i = 0; i < 120; i++) {
    [x, v] = springStep(x, v, 1, 10, 1 / 60);
    max = Math.max(max, x);
  }
  assert.ok(Math.abs(x - 1) < 1e-3);
  assert.ok(max <= 1 + 1e-9);
  const [big] = springStep(0, 0, 1, 10, 2);
  let small = 0;
  let sv = 0;
  for (let i = 0; i < 200; i++) [small, sv] = springStep(small, sv, 1, 10, 0.01);
  assert.ok(Math.abs(big - small) < 1e-9);
});

test('springSmooth adds no lag to a constant-velocity ramp', () => {
  const times = Array.from({ length: 300 }, (_, i) => (i * 1000) / 60);
  const values = times.map((t) => t * 0.5);
  const out = springSmooth(times, values, 20);
  for (let i = 100; i < 200; i++) assert.ok(Math.abs(out[i] - values[i]) < 0.5, `lag at ${i}`);
});
