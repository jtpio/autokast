import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { mergeOptions, resolveOptions } from '../../src/record/defaults.ts';
import type { RecordOptions } from '../../src/types.ts';

describe('resolveOptions', () => {
  it('applies the defaults', () => {
    const options = resolveOptions({});
    assert.equal(options.name, 'screencast');
    assert.deepEqual(options.viewport, { width: 1280, height: 720 });
    assert.equal(options.deviceScaleFactor, 2);
    assert.deepEqual(options.capture, {
      mode: 'realtime',
      fps: 60,
      clockLead: 600_000,
      format: 'jpeg',
      quality: 92,
    });
    assert.deepEqual(options.cursor, {
      start: { x: 640, y: 360 },
      speed: 1,
      curvature: 0.2,
      minDuration: 220,
      maxDuration: 1000,
    });
    assert.deepEqual(options.typing, { delay: 45, variance: 0.35 });
    assert.deepEqual(options.pacing, {
      startDelay: 400,
      endDelay: 900,
      beforeClick: 60,
      afterClick: 180,
      afterType: 120,
      pressDuration: 90,
    });
    assert.equal(options.sessionDir, path.resolve('.autokast/screencast'));
    assert.equal(options.scrollBehavior, 'smooth');
    assert.equal(options.timeout, 10_000);
  });

  it('derives the session directory and the seed from the name', () => {
    const a = resolveOptions({ name: 'my demo/../x' });
    assert.equal(a.sessionDir, path.resolve('.autokast/my-demo-..-x'));
    assert.equal(a.seed, resolveOptions({ name: 'my demo/../x' }).seed);
    assert.notEqual(a.seed, resolveOptions({ name: 'other' }).seed);
    assert.equal(resolveOptions({ seed: 5 }).seed, 5);
  });

  it('centers the cursor start in a custom viewport', () => {
    const options = resolveOptions({ viewport: { width: 800, height: 600 } });
    assert.deepEqual(options.cursor.start, { x: 400, y: 300 });
  });

  it('rejects invalid values with a clear message', () => {
    assert.throws(() => resolveOptions({ deviceScaleFactor: 0 }), /deviceScaleFactor/);
    assert.throws(() => resolveOptions({ viewport: { width: 10.5, height: 10 } }), /viewport/);
    assert.throws(() => resolveOptions({ cursor: { speed: 0 } }), /cursor\.speed/);
    assert.throws(() => resolveOptions({ timeout: 0 }), /timeout/);
    assert.throws(() => resolveOptions({ capture: { clockLead: -1 } }), /capture\.clockLead/);
  });
});

describe('mergeOptions', () => {
  it('merges nested objects and ignores undefined', () => {
    const base: RecordOptions = {
      name: 'demo',
      url: 'http://x',
      browser: { args: ['--a'], headless: true },
      cursor: { speed: 2, curvature: 0.1 },
    };
    const merged = mergeOptions(base, {
      url: undefined,
      browser: { headless: false },
      cursor: { speed: 3 },
      viewport: { width: 640, height: 480 },
    });
    assert.deepEqual(merged, {
      name: 'demo',
      url: 'http://x',
      browser: { args: ['--a'], headless: false },
      cursor: { speed: 3, curvature: 0.1 },
      viewport: { width: 640, height: 480 },
    });
    assert.deepEqual(base.cursor, { speed: 2, curvature: 0.1 });
  });
});
