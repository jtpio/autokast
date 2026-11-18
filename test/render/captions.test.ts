import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BAND_DURATION,
  bandAt,
  layoutCaption,
  MERGE_GAP,
  planCaptions,
} from '../../src/render/captions.ts';
import { keyLabel, parseShortcut, planKeys, pressDepth } from '../../src/render/keycaps.ts';
import type { TimedEvent } from '../../src/render/timeline.ts';
import type { CaptionEvent, KeyEvent } from '../../src/types.ts';

const caption = (
  out: number,
  duration: number,
  text = 'Hello there',
): TimedEvent<CaptionEvent> => ({
  type: 'caption',
  t: out,
  out,
  duration,
  text,
});

test('one caption opens the band, reveals after it opens, and closes after the exit', () => {
  const { cues, groups } = planCaptions([caption(1000, 2000)]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].open, 1000);
  assert.ok(cues[0].textIn > 1000 && cues[0].textIn < 1000 + BAND_DURATION);
  assert.equal(cues[0].textOut, 3000);
  assert.ok(groups[0].close > cues[0].textOut);
  assert.equal(bandAt(groups, 900), 0);
  assert.equal(bandAt(groups, 1000 + BAND_DURATION), 1);
  assert.equal(bandAt(groups, 2500), 1);
  assert.equal(bandAt(groups, groups[0].close + BAND_DURATION), 0);
});

test('captions within the merge gap share one open band and swap text', () => {
  const { cues, groups } = planCaptions([caption(0, 1500), caption(1500 + MERGE_GAP - 1, 1000)]);
  assert.equal(groups.length, 1);
  assert.ok(cues[1].textIn >= cues[0].textOut + 100);
  for (let t = 1000; t < cues[1].textOut; t += 10) assert.equal(bandAt(groups, t), 1);
});

test('separate captions get separate bands, and an overlap hands over at the next start', () => {
  assert.equal(
    planCaptions([caption(0, 1000), caption(1000 + MERGE_GAP + 50, 800)]).groups.length,
    2,
  );
  const { cues } = planCaptions([caption(0, 3000), caption(2000, 1000)]);
  assert.equal(cues[0].textOut, 2000);
  assert.ok(cues[1].textIn > 2000);
});

test('band progress is continuous and monotonic while it opens and closes', () => {
  const { groups } = planCaptions([caption(500, 1500), caption(3000, 400)]);
  let last = 0;
  let maxStep = 0;
  for (let t = 0; t < 6000; t += 1) {
    const p = bandAt(groups, t);
    maxStep = Math.max(maxStep, Math.abs(p - last));
    if (t >= 500 && t <= 500 + BAND_DURATION) assert.ok(p >= last - 1e-12);
    last = p;
  }
  assert.ok(maxStep < 0.006, `step ${maxStep}`);
});

const measure = (text: string, size: number) => text.length * size * 0.5;

test('short text stays on one line', () => {
  const l = layoutCaption('Create a new project', measure, 1000, 40);
  assert.deepEqual(l.lines, ['Create a new project']);
  assert.equal(l.fontSize, 40);
  assert.deepEqual(
    l.words.map((w) => w.x),
    [0, measure('Create ', 40), measure('Create a ', 40), measure('Create a new ', 40)],
  );
});

test('long text breaks into two balanced lines', () => {
  const text =
    'Give it a name. The camera stays on the cursor while you type, so nothing is missed.';
  const l = layoutCaption(text, measure, 1000, 40);
  assert.equal(l.lines.length, 2);
  assert.equal(l.fontSize, 40);
  const [a, b] = l.lines.map((s) => measure(s, 40));
  assert.ok(Math.abs(a - b) <= 40 * 0.5 * 8, `unbalanced ${a} / ${b}`);
  assert.equal(l.lines.join(' '), text);
  assert.ok(l.words.filter((w) => w.line === 1)[0].x === 0);
});

test('text too long for two lines shrinks, then ends with an ellipsis', () => {
  const words = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');
  const shrunk = layoutCaption(words.join(' '), measure, 600, 40);
  assert.equal(shrunk.lines.length, 2);
  assert.ok(shrunk.fontSize < 40 && shrunk.fontSize >= 40 * 0.78 - 1e-9);
  const cut = layoutCaption([...words, ...words, ...words].join(' '), measure, 700, 40);
  assert.equal(cut.lines.length, 2);
  assert.ok(cut.lines[1].endsWith('…'));
  for (const line of cut.lines) assert.ok(measure(line, cut.fontSize) <= 700);
});

const key = (out: number, combo: string): TimedEvent<KeyEvent> => ({
  type: 'key',
  t: out,
  out,
  kind: 'shortcut',
  key: combo,
});

test('shortcuts split into caps with glyphs and names', () => {
  assert.deepEqual(parseShortcut('Control+Shift+C'), ['Control', 'Shift', 'C']);
  assert.deepEqual(parseShortcut('Control++'), ['Control', '+']);
  assert.deepEqual(parseShortcut('ControlOrMeta+k'), ['Meta', 'k']);
  assert.deepEqual(keyLabel('Meta'), { glyph: '⌘', name: 'Cmd' });
  assert.deepEqual(keyLabel('k'), { glyph: 'K' });
  assert.deepEqual(keyLabel('F5'), { name: 'F5' });
});

test('repeated shortcuts press the same caps and a new one replaces them', () => {
  const cues = planKeys([key(1000, 'Meta+Z'), key(1400, 'Meta+Z'), key(1900, 'Shift+Enter')]);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0].presses, [1000, 1400]);
  assert.ok(cues[0].fadeOut + cues[0].fadeDuration <= cues[1].appear + 1);
  assert.ok(cues[1].appear < 1900);
  assert.ok(pressDepth(cues[0], 1050) > 0.99);
  assert.equal(pressDepth(cues[0], 1300), 0);
  assert.equal(planKeys([{ ...key(0, 'a'), kind: 'text' }]).length, 0);
});
