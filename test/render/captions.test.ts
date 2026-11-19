import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BAND_DURATION,
  bandAt,
  layoutCaption,
  MERGE_GAP,
  parseCaption,
  planCaptions,
  splitCaption,
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
const LONG = 'Give it a name. The camera stays on the cursor while you type, so nothing is missed.';

test('a line that fits keeps the font size, and each word has its place', () => {
  const l = layoutCaption('Create a new project', measure, 1000, 40);
  assert.equal(l.text, 'Create a new project');
  assert.equal(l.fontSize, 40);
  assert.equal(l.width, measure(l.text, 40));
  assert.deepEqual(
    l.runs.map((run) => run.x),
    [0, measure('Create ', 40), measure('Create a ', 40), measure('Create a new ', 40)],
  );
});

test('long text splits into the fewest lines, of about the same width', () => {
  assert.deepEqual(splitCaption('Create a new project', measure, 1000, 40), [
    'Create a new project',
  ]);
  const two = splitCaption(LONG, measure, 1000, 40);
  assert.equal(two.length, 2);
  assert.equal(two.join(' '), LONG);
  const [a, b] = two.map((line) => measure(line, 40));
  assert.ok(a <= 1000 && b <= 1000);
  assert.ok(Math.abs(a - b) <= 40 * 0.5 * 8, `unbalanced ${a} / ${b}`);
  const four = splitCaption(`${LONG} ${LONG}`, measure, 1000, 40);
  assert.equal(four.length, 4);
  for (const line of four) assert.ok(measure(line, 40) <= 1000, line);
});

test('a word wider than the line has a line of its own, and its font shrinks to fit', () => {
  const word = 'a'.repeat(80);
  assert.deepEqual(splitCaption(`see ${word} now`, measure, 1000, 40), ['see', word, 'now']);
  const l = layoutCaption(word, measure, 1000, 40);
  assert.ok(l.fontSize < 40);
  assert.ok(Math.abs(l.width - 1000) < 1e-6);
});

test('** marks the emphasis, also inside a word, and is not part of the text', () => {
  assert.deepEqual(
    parseCaption('Built on **JupyterLab 4.7**, with **no** server').map((word) => word.runs),
    [
      [{ text: 'Built', strong: false }],
      [{ text: 'on', strong: false }],
      [{ text: 'JupyterLab', strong: true }],
      [
        { text: '4.7', strong: true },
        { text: ',', strong: false },
      ],
      [{ text: 'with', strong: false }],
      [{ text: 'no', strong: true }],
      [{ text: 'server', strong: false }],
    ],
  );
  const l = layoutCaption('The **doc** URL, **fast**', measure, 1000, 40);
  assert.equal(l.text, 'The doc URL, fast');
  assert.deepEqual(
    l.runs.map((run) => [run.text, run.x, run.strong]),
    [
      ['The', 0, false],
      ['doc', measure('The ', 40), true],
      ['URL,', measure('The doc ', 40), false],
      ['fast', measure('The doc URL, ', 40), true],
    ],
  );
});

test('the marks stay with their words when the text splits', () => {
  const text = '**one two three** four five **six** seven';
  const lines = splitCaption(text, measure, 240, 40);
  assert.ok(lines.length > 2);
  assert.deepEqual(parseCaption(lines.join(' ')), parseCaption(text));
  assert.ok(lines[0].startsWith('**one**'));
});

test('a caption with several lines shows one line at a time, in one band', () => {
  const split = () => ['**aaaa** bbbb', 'cccc'];
  const { cues, groups } = planCaptions([caption(1000, 9000, '**aaaa** bbbb cccc')], split);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    cues.map((cue) => [cue.text, cue.start, cue.end, cue.emphasis]),
    [
      ['**aaaa** bbbb', 1000, 1000 + 1500 + 55 * 9, true],
      ['cccc', 1000 + 1500 + 55 * 9, 10000, true],
    ],
  );
  assert.ok(cues[1].textIn > cues[0].textOut);
  const short = planCaptions([caption(0, 1000, 'aaaa bbbb cccc')], split).cues;
  assert.ok(Math.abs(short[1].end - 1000) < 1e-9);
  assert.ok(short[0].end > 400 && short[0].end < 700);
});

test('text without marks, or with every word marked, has one tone', () => {
  const emphasis = (text: string) => planCaptions([caption(0, 1000, text)]).cues[0].emphasis;
  assert.equal(emphasis('Create a new project'), false);
  assert.equal(emphasis('**Create a new project**'), false);
  assert.equal(emphasis('Create a **new project**'), true);
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
  assert.deepEqual(parseShortcut('ControlOrMeta+k', 'pc'), ['Control', 'k']);
  assert.deepEqual(keyLabel('Alt', 'pc'), { name: 'Alt' });
  assert.deepEqual(keyLabel('Shift', 'pc'), { glyph: '⇧', name: 'Shift' });
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
