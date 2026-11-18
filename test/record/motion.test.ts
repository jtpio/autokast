import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cursorPath,
  easeInOutCubic,
  moveDuration,
  moveEase,
  scrollDuration,
  typingDelay,
} from '../../src/record/motion.ts';
import { createRandom } from '../../src/record/random.ts';

const timing = { speed: 1, minDuration: 220, maxDuration: 1000 };

describe('moveDuration', () => {
  it('does not wait for a near-zero distance', () => {
    assert.equal(moveDuration(0, timing), 0);
    assert.equal(moveDuration(0.9, timing), 0);
  });

  it('grows with the distance, inside the limits', () => {
    const distances = [1, 10, 60, 200, 500, 1000, 1500];
    const durations = distances.map((distance) => moveDuration(distance, timing));
    for (let i = 1; i < durations.length; i++) {
      assert.ok(durations[i] >= durations[i - 1]);
    }
    assert.ok(durations.every((ms) => ms >= 220 && ms <= 1000));
    assert.equal(Math.round(moveDuration(60, timing)), 330);
    assert.equal(Math.round(moveDuration(420, timing)), 570);
    assert.equal(moveDuration(1e6, timing), 1000);
  });

  it('divides by the speed, then clamps', () => {
    const free = { speed: 1, minDuration: 0, maxDuration: Infinity };
    const fast = { ...free, speed: 2 };
    assert.equal(moveDuration(500, fast), moveDuration(500, free) / 2);
    assert.equal(moveDuration(10, { ...timing, speed: 4 }), 220);
  });
});

describe('moveEase', () => {
  it('starts at 0, ends at 1 and never goes back', () => {
    assert.equal(moveEase(0), 0);
    assert.equal(moveEase(1), 1);
    assert.equal(moveEase(-1), 0);
    assert.equal(moveEase(2), 1);
    let previous = 0;
    for (let i = 1; i <= 1000; i++) {
      const value = moveEase(i / 1000);
      assert.ok(value >= previous);
      previous = value;
    }
  });

  it('starts and stops smoothly, with a longer deceleration', () => {
    const speed = (u: number) => (moveEase(u + 1e-4) - moveEase(u - 1e-4)) / 2e-4;
    assert.ok(speed(0.001) < 0.01 && speed(0.999) < 0.01);
    let peak = 0;
    for (let i = 1; i < 1000; i++) {
      if (speed(i / 1000) > speed(peak / 1000)) {
        peak = i;
      }
    }
    assert.ok(peak > 350 && peak < 480, `peak speed at ${peak / 1000}`);
  });

  it('scroll easing is symmetric', () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(0.5), 0.5);
    assert.equal(easeInOutCubic(1), 1);
    assert.ok(Math.abs(easeInOutCubic(0.2) + easeInOutCubic(0.8) - 1) < 1e-12);
  });
});

describe('cursorPath', () => {
  const from = { x: 100, y: 500 };
  const to = { x: 900, y: 200 };

  it('starts and ends exactly on the points', () => {
    for (let seed = 0; seed < 50; seed++) {
      const path = cursorPath(from, to, 0.3, createRandom(seed));
      assert.deepEqual(path(0), from);
      assert.deepEqual(path(1), to);
    }
  });

  it('gives the same path for the same seed', () => {
    const a = cursorPath(from, to, 0.2, createRandom(42));
    const b = cursorPath(from, to, 0.2, createRandom(42));
    const c = cursorPath(from, to, 0.2, createRandom(43));
    for (const s of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      assert.deepEqual(a(s), b(s));
    }
    assert.notDeepEqual(a(0.5), c(0.5));
  });

  it('is straight with no curvature and bends with curvature', () => {
    const distanceToLine = (p: { x: number; y: number }) =>
      Math.abs((to.y - from.y) * p.x - (to.x - from.x) * p.y + to.x * from.y - to.y * from.x) /
      Math.hypot(to.x - from.x, to.y - from.y);
    const straight = cursorPath(from, to, 0, createRandom(1));
    const curved = cursorPath(from, to, 0.2, createRandom(1));
    assert.ok(distanceToLine(straight(0.5)) < 1e-9);
    const bend = distanceToLine(curved(0.5));
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    assert.ok(bend > 0.02 * length && bend < 0.15 * length, `bend ${bend}`);
  });

  it('stays inside the bounds', () => {
    const bounds = { width: 1280, height: 720 };
    for (let seed = 0; seed < 100; seed++) {
      const path = cursorPath({ x: 5, y: 5 }, { x: 1275, y: 5 }, 1, createRandom(seed), bounds);
      for (let i = 0; i <= 100; i++) {
        const p = path(i / 100);
        assert.ok(p.x >= 0 && p.x <= 1280 && p.y >= 0 && p.y <= 720);
      }
    }
  });

  it('handles a zero-length move', () => {
    const path = cursorPath(from, from, 0.2, createRandom(1));
    assert.deepEqual(path(0.5), from);
    assert.deepEqual(path(1), from);
  });
});

describe('typingDelay', () => {
  it('varies around the mean delay, deterministically', () => {
    const a = createRandom(9);
    const b = createRandom(9);
    const delays = Array.from({ length: 500 }, () => typingDelay('a', 55, 0.35, a));
    assert.deepEqual(
      delays,
      Array.from({ length: 500 }, () => typingDelay('a', 55, 0.35, b)),
    );
    assert.ok(delays.every((ms) => ms >= 55 * 0.65 - 1e-9 && ms <= 55 * 1.35 + 1e-9));
    const mean = delays.reduce((sum, ms) => sum + ms, 0) / delays.length;
    assert.ok(Math.abs(mean - 55) < 3, `mean ${mean}`);
    assert.ok(new Set(delays).size > 400);
  });

  it('pauses longer after spaces, punctuation and new lines', () => {
    const fixed = () => 0.5;
    assert.equal(typingDelay('a', 50, 0.3, fixed), 50);
    assert.ok(typingDelay(' ', 50, 0.3, fixed) > 50);
    assert.ok(typingDelay('.', 50, 0.3, fixed) > typingDelay(' ', 50, 0.3, fixed));
    assert.ok(typingDelay('\n', 50, 0.3, fixed) > typingDelay('.', 50, 0.3, fixed));
    assert.equal(typingDelay('a', 0, 0.3, fixed), 0);
  });
});

describe('scrollDuration', () => {
  it('stays between 400 and 900 ms', () => {
    assert.equal(scrollDuration(10), 400);
    assert.equal(scrollDuration(500), 600);
    assert.equal(scrollDuration(5000), 900);
  });
});

describe('createRandom', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = createRandom(123);
    const b = createRandom(123);
    for (let i = 0; i < 1000; i++) {
      const value = a();
      assert.equal(value, b());
      assert.ok(value >= 0 && value < 1);
    }
  });
});
