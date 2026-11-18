import assert from 'node:assert/strict';
import { test } from 'node:test';
import { frameIndexAt, frameTimes, TimeMap, timedEvents } from '../../src/render/timeline.ts';
import type { TimelineEvent } from '../../src/types.ts';

const events: TimelineEvent[] = [
  { type: 'cut', t: 1000, end: 2000 },
  { type: 'speed', t: 3000, end: 5000, rate: 4 },
];

test('cuts remove time and speed ranges shorten it', () => {
  const map = new TimeMap(events, 6000);
  assert.equal(map.duration, 6000 - 1000 - 2000 + 500);
  assert.equal(map.toOutput(500), 500);
  assert.equal(map.toOutput(1500), 1000);
  assert.equal(map.toOutput(2000), 1000);
  assert.equal(map.toOutput(2500), 1500);
  assert.equal(map.toOutput(4000), 2250);
  assert.equal(map.toOutput(5000), 2500);
  assert.equal(map.toOutput(6000), 3500);
});

test('output to record is the inverse outside cuts, and lands after a cut at its point', () => {
  const map = new TimeMap(events, 6000);
  for (const rec of [0, 400, 999, 2000, 2700, 3000, 3333, 4999, 5000, 5800]) {
    assert.ok(Math.abs(map.toRecord(map.toOutput(rec)) - rec) < 1e-9, `rec ${rec}`);
  }
  assert.equal(map.toRecord(1000), 2000);
  assert.equal(map.toRecord(999), 999);
});

test('overlapping speeds multiply and a cut wins over a speed', () => {
  const map = new TimeMap(
    [
      { type: 'speed', t: 0, end: 2000, rate: 2 },
      { type: 'speed', t: 1000, end: 2000, rate: 2 },
      { type: 'cut', t: 1500, end: 2500 },
    ],
    3000,
  );
  assert.equal(map.duration, 500 + 125 + 500);
  assert.equal(map.rateAt(1200), 4);
  assert.ok(map.inCut(1700));
  assert.ok(map.cutBetween(1400, 1600));
  assert.ok(!map.cutBetween(2600, 2900));
});

test('events inside cuts are dropped, but a zoom applies instantly at the cut point', () => {
  const map = new TimeMap(events, 6000);
  const timed = timedEvents(
    [
      { type: 'mouseDown', t: 1200, x: 1, y: 1, button: 'left' },
      { type: 'zoom', t: 1500, focus: null, duration: 800 },
      { type: 'caption', t: 2500, duration: 100, text: 'hi' },
      ...events,
    ],
    map,
  );
  assert.deepEqual(
    timed.map((e) => [e.type, e.out]),
    [
      ['zoom', 1000],
      ['caption', 1500],
    ],
  );
  assert.equal((timed[0] as { duration?: number }).duration, 0);
});

test('a caption at the start of a cut or inside it starts at the cut point', () => {
  const map = new TimeMap(events, 6000);
  const timed = timedEvents(
    [
      { type: 'caption', t: 1000, duration: 4000, text: 'before' },
      { type: 'caption', t: 1600, duration: 4000, text: 'inside' },
      ...events,
    ],
    map,
  );
  assert.deepEqual(
    timed.map((e) => [e.type, e.out, (e as { duration?: number }).duration]),
    [
      ['caption', 1000, 4000],
      ['caption', 1000, 4000],
    ],
  );
});

test('a page address inside a cut is kept at the cut point', () => {
  const map = new TimeMap(events, 6000);
  const timed = timedEvents(
    [
      { type: 'url', t: 0, url: 'http://a/' },
      { type: 'url', t: 1400, url: 'http://a/b' },
      { type: 'url', t: 1700, url: 'http://a/c' },
      ...events,
    ],
    map,
  );
  assert.deepEqual(
    timed.map((e) => [e.type === 'url' && e.url, e.out]),
    [
      ['http://a/', 0],
      ['http://a/b', 1000],
      ['http://a/c', 1000],
    ],
  );
});

test('frameIndexAt finds the latest frame at or before a time', () => {
  const frames = [0, 100, 250, 900].map((t) => ({ t, file: `${t}.jpg` }));
  assert.equal(frameIndexAt(frames, -5), 0);
  assert.equal(frameIndexAt(frames, 0), 0);
  assert.equal(frameIndexAt(frames, 99.9), 0);
  assert.equal(frameIndexAt(frames, 100), 1);
  assert.equal(frameIndexAt(frames, 899), 2);
  assert.equal(frameIndexAt(frames, 5000), 3);
});

test('frameTimes covers the duration at the frame rate', () => {
  const t = frameTimes(1000, 60);
  assert.equal(t.length, 60);
  assert.equal(t[1], 1000 / 60);
  assert.ok(t[59] < 1000);
});
