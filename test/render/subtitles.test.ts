import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { zoomTarget } from '../../src/render/camera.ts';
import { renderFrame } from '../../src/render/index.ts';
import { buildScene } from '../../src/render/scene.ts';
import {
  paginate,
  planSubtitles,
  subtitleMeasure,
  subtitleVisible,
  subtitleZone,
  type SubtitlePage,
} from '../../src/render/subtitles.ts';
import type { TimedEvent } from '../../src/render/timeline.ts';
import type { CaptionEvent, RenderOptions, Session } from '../../src/types.ts';
import { createFixture } from './fixture.ts';

let dir: string;
let session: Session;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-subtitles-'));
  session = await createFixture(path.join(dir, 'session'), { deviceScaleFactor: 1 });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A measure where each character is half a font size wide.
 */
const measure = (text: string, size: number) => text.length * size * 0.5;

const caption = (out: number, duration: number, text: string): TimedEvent<CaptionEvent> => ({
  type: 'caption',
  t: out,
  out,
  duration,
  text,
});

const page = (...words: string[]): SubtitlePage => ({
  fontSize: 60,
  height: 70,
  words: words.map((text, i) => ({ text, strong: false, x: i * 100, baseline: 50 })),
});

test('a short caption is one page, and a long one has pages of at most two lines', () => {
  const short = paginate('Write code in a **notebook**', measure, 600, 60);
  assert.equal(short.length, 1);
  assert.deepEqual(
    short[0].words.map((word) => word.text),
    ['Write', 'code', 'in', 'a', 'notebook'],
  );
  assert.deepEqual(
    short[0].words.map((word) => word.strong),
    [false, false, false, false, true],
  );
  assert.equal(new Set(short[0].words.map((word) => word.baseline)).size, 2);

  const text = 'Give it a name and the camera stays on the cursor while you type the words';
  const long = paginate(text, measure, 600, 60);
  assert.ok(long.length > 1);
  assert.equal(long.flatMap((p) => p.words.map((word) => word.text)).join(' '), text);
  for (const p of long) {
    assert.ok(new Set(p.words.map((word) => word.baseline)).size <= 2);
    for (const word of p.words) {
      const half = measure(word.text, p.fontSize) / 2;
      assert.ok(Math.abs(word.x) + half <= 300 + 1e-6, `"${word.text}" is inside the line`);
    }
  }
  const counts = long.map((p) => p.words.length);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 4, `pages ${counts}`);
});

test('a page ends where a speaker pauses: at the end of a sentence or at a comma', () => {
  const texts = (text: string) =>
    paginate(text, measure, 600, 60).map((p) => p.words.map((word) => word.text).join(' '));
  assert.deepEqual(texts('Need two notebooks at once? Drag a tab down to split the screen.'), [
    'Need two notebooks at once?',
    'Drag a tab down to split the screen.',
  ]);
  assert.deepEqual(texts('Press Shift Enter to run it, and the table shows up right below.'), [
    'Press Shift Enter to run it,',
    'and the table shows up right below.',
  ]);
  assert.deepEqual(texts('Long notebook? Open the contents.'), [
    'Long notebook? Open the contents.',
  ]);
  const first = texts('First, we load a year of weather data.');
  assert.match(first[0], /^First, we load/, 'a comma after one word is no place for a break');
  const strong = paginate('Open **the table, of** contents now. Then go on.', measure, 300, 60);
  assert.deepEqual(
    strong.flatMap((p) => p.words.filter((word) => word.strong).map((word) => word.text)),
    ['the', 'table,', 'of'],
  );
});

test('the lines of a page are centered, and a very long word makes the text smaller', () => {
  const [one] = paginate('Hello there', measure, 600, 60);
  assert.ok(Math.abs(one.words[0].x + one.words[1].x) < 60);
  assert.ok(one.words[0].x < 0 && one.words[1].x > 0);
  const [wide] = paginate('Supercalifragilisticexpialidocious', measure, 600, 60);
  assert.ok(wide.fontSize < 60);
  assert.ok(measure(wide.words[0].text, wide.fontSize) <= 600 + 1e-6);
});

test('the real font gives a wider space between two words', () => {
  const width = subtitleMeasure('Inter Display');
  assert.ok(width('a b', 64) > width('a', 64) + width('b', 64));
  assert.ok(Math.abs(width('ab', 128) - 2 * width('ab', 64)) < 0.01);
});

test('each word of a page is the current word in its turn, and the last page stays', () => {
  const cues = planSubtitles([caption(1000, 6000, 'x')], () => [
    page('Write', 'code'),
    page('in', 'a', 'notebook'),
  ]);
  assert.equal(cues.length, 2);
  const [first, second] = cues;
  assert.equal(first.start, 1000);
  assert.ok(first.words[0].at > 1000, 'the page shows before its first word is current');
  assert.ok(first.words[0].at < 1400);
  assert.equal(first.words[1].at, first.words[0].until);
  assert.ok(first.end > first.words[1].until, 'a page stays after its last word');
  assert.ok(second.start > first.end, 'the next page comes after the exit');
  assert.equal(second.end, 7000);
  assert.ok(
    second.words[2].until - second.words[2].at > second.words[1].until - second.words[1].at,
  );
  assert.ok(subtitleVisible(first, 1500) && !subtitleVisible(first, 1500 + 6000));
  assert.ok(!subtitleVisible(second, 1500));
});

test('a caption that is too short for its words plays them faster', () => {
  const pages = () => [page('one', 'two', 'three'), page('four', 'five', 'six')];
  const slow = planSubtitles([caption(0, 20_000, 'x')], pages);
  const fast = planSubtitles([caption(0, 1200, 'x')], pages);
  const spoken = (cue: (typeof slow)[number]) => cue.words[2].until - cue.words[0].at;
  assert.ok(spoken(fast[0]) < spoken(slow[0]));
  assert.ok(fast[1].end <= 1200 + 1e-6);
});

test('a new caption replaces the page on screen and the pages that did not start', () => {
  const cues = planSubtitles([caption(0, 9000, 'a'), caption(1100, 3000, 'b')], (text) =>
    text === 'a' ? [page('one', 'two'), page('three', 'four')] : [page('five')],
  );
  assert.deepEqual(
    cues.map((cue) => cue.words[0].text),
    ['one', 'five'],
  );
  assert.ok(cues[0].end < 1100);
  assert.equal(cues[1].start, 1100);
});

test('a caption that has only marks gives no page', () => {
  assert.deepEqual(paginate('**', measure, 600, 60), []);
  const cues = planSubtitles([caption(0, 2000, 'Hello there'), caption(500, 2000, '**')], (text) =>
    paginate(text, measure, 600, 60),
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].end, 2000);
});

test('the subtitles are lower in a wide video than in a vertical one', () => {
  const wide = subtitleZone({ width: 1920, height: 1080 }, 'bottom', 64);
  const tall = subtitleZone({ width: 1080, height: 1920 }, 'bottom', 64);
  assert.equal(wide.x, 960);
  assert.ok(wide.y / 1080 > tall.y / 1920);
  assert.ok(tall.bottom < 0.8 * 1920, 'above the interface of a video platform');
  assert.ok(wide.top < wide.y && wide.bottom > wide.y);
  const top = subtitleZone({ width: 1080, height: 1920 }, 'top', 64);
  assert.ok(top.y < 1920 / 2);
});

test('the subtitles style has no caption band, and the window does not move', () => {
  const line = buildScene(session, { fps: 30 });
  const scene = buildScene(session, { fps: 30, captions: { style: 'subtitles' } });
  assert.ok(line.band && line.captions.length > 0);
  assert.deepEqual(line.subtitles, []);
  assert.equal(scene.band, null);
  assert.deepEqual(scene.captions, []);
  assert.ok(scene.subtitles.length >= 3);
  assert.ok(scene.bandOpen.every((open) => open === 0));
  assert.equal(scene.options.captions.fontSize, 64);
  assert.equal(line.options.captions.fontSize, 40);
  assert.equal(buildScene(session, { captions: { fontSize: 50 } }).options.captions.fontSize, 50);
  assert.deepEqual(
    buildScene(session, { captions: { style: 'subtitles', enabled: false } }).subtitles,
    [],
  );
  assert.throws(
    () => buildScene(session, { captions: { style: 'karaoke' as 'line' } }),
    /Unknown captions.style "karaoke". Use one of: line, subtitles/,
  );
});

test('the highlight is one color, and a caption can have its own color', () => {
  const color = (highlight?: string) =>
    buildScene(session, { captions: { style: 'subtitles', highlight } }).options.captions.highlight;
  assert.equal(color(), '#ffd84a');
  assert.equal(color('#ff0000'), '#ff0000');
  const cues = planSubtitles(
    [caption(0, 2000, 'a'), { ...caption(3000, 2000, 'b'), highlight: '#00ff00' }],
    () => [page('word')],
  );
  assert.deepEqual(
    cues.map((cue) => cue.highlight),
    [undefined, { r: 0, g: 255, b: 0, a: 1 }],
  );
});

test('a zoom puts its focus above the subtitles', () => {
  const focus = { x: 400, y: 300, width: 480, height: 120 };
  const viewport = { width: 1280, height: 720 };
  assert.equal(zoomTarget({ focus, scale: 2 }, viewport, 3).cy, 360);
  assert.equal(zoomTarget({ focus, scale: 2 }, viewport, 3, { x: 1, y: 1, dy: 60 }).cy, 390);

  const zoom = { type: 'zoom' as const, t: 100, focus, scale: 2, follow: 'off' as const };
  const text = { type: 'caption' as const, t: 200, duration: 3000, text: 'Hello **there**' };
  const events = [zoom, text];
  const last = (scene: ReturnType<typeof buildScene>) =>
    scene.camera.cy[scene.camera.cy.length - 1];
  const line = buildScene({ ...session, events: [zoom] }, { fps: 30 });
  const subtitled = buildScene(
    { ...session, events },
    { fps: 30, captions: { style: 'subtitles' } },
  );
  assert.equal(last(line), 360);
  assert.ok(last(subtitled) > 360, 'the camera looks lower, so the focus is higher');
  const top = buildScene(
    { ...session, events },
    { fps: 30, captions: { style: 'subtitles', position: 'top' } },
  );
  assert.ok(last(top) < 360);
});

/**
 * A copy of the fixture session with other events and render options.
 */
async function variant(name: string, events: Session['events'], render: RenderOptions) {
  const target = path.join(dir, name);
  await mkdir(target, { recursive: true });
  await symlink(path.join(dir, 'session', 'frames'), path.join(target, 'frames'));
  await writeFile(
    path.join(target, 'session.json'),
    JSON.stringify({ ...session, events, render }),
  );
  return target;
}

const SMALL = { width: 960, height: 540 };

/**
 * Renders one frame and returns a counter of the pixels of some rows that match.
 */
async function frame(source: string, time: number) {
  const image = await loadImage(await renderFrame(source, time));
  const context = createCanvas(SMALL.width, SMALL.height).getContext('2d');
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, SMALL.width, SMALL.height).data;
  return (top: number, bottom: number, match: (r: number, g: number, b: number) => boolean) => {
    let found = 0;
    for (let y = Math.floor(top); y < Math.min(SMALL.height, bottom); y++) {
      for (let x = 0; x < SMALL.width; x++) {
        const i = (y * SMALL.width + x) * 4;
        if (match(data[i], data[i + 1], data[i + 2])) found++;
      }
    }
    return found;
  };
}

const magenta = (r: number, g: number, b: number) => r > 230 && g < 60 && b > 230;
const white = (r: number, g: number, b: number) => r > 245 && g > 245 && b > 245;
const green = (r: number, g: number, b: number) => r < 60 && g > 230 && b < 60;

test('a subtitle shows all its words at once, and the color goes from word to word', async () => {
  const text = (t: number) => ({
    type: 'caption' as const,
    t,
    duration: 4000,
    text: 'Hello **there** friend',
  });
  const options = {
    size: SMALL,
    background: '#203040',
    cursor: { visible: false },
    captions: { style: 'subtitles' as const, highlight: '#ff00ff' },
  };
  const zone = subtitleZone(SMALL, 'bottom', 32);
  const count = async (name: string, events: Session['events'], time: number) => {
    const pixels = await frame(await variant(name, events, options), time);
    return {
      magenta: pixels(zone.top, zone.bottom, magenta),
      white: pixels(zone.top, zone.bottom, white),
      above: pixels(0, zone.top - 20, magenta),
    };
  };
  // The same frame of the page, with no subtitle, after the last word and on the first word.
  const late = [text(2400)];
  const first = buildScene({ ...session, events: late }, options).subtitles[0].words[0];
  const time = (first.at + first.until) / 2;
  const plain = await count('plain', [], time);
  const said = await count('said', [text(100)], time);
  const current = await count('current', late, time);
  assert.equal(plain.magenta, 0);
  assert.ok(said.magenta > 150, 'the word between ** has the color');
  assert.ok(said.white > plain.white + 300, 'the other words are white');
  assert.equal(said.above, 0, 'no text outside the zone');
  assert.ok(current.magenta > said.magenta + 100, 'the current word has the color too');
  assert.ok(current.white > plain.white + 100, 'the words after it show at once, in white');
  assert.ok(current.white < said.white - 100);

  const own = await variant('own', [{ ...text(100), highlight: '#00ff00' }], options);
  const pixels = await frame(own, time);
  assert.equal(pixels(zone.top, zone.bottom, magenta), 0);
  assert.ok(pixels(zone.top, zone.bottom, green) > 150, 'the caption has its own color');
});

test('keycaps sit below the subtitles, and their size is an option', async () => {
  const key = { type: 'key' as const, t: 1900, kind: 'shortcut' as const, key: 'Meta+K' };
  const text = { type: 'caption' as const, t: 100, duration: 4000, text: 'Hello there' };
  const options = (size: number, style: 'line' | 'subtitles') => ({
    size: SMALL,
    background: '#ff00ff',
    frame: { padding: 0.2 },
    cursor: { visible: false },
    keystrokes: { show: 'shortcuts' as const, size },
    captions: { style, enabled: style === 'subtitles' },
  });
  const zone = subtitleZone(SMALL, 'bottom', 32);
  const covered = async (name: string, size: number, style: 'line' | 'subtitles') => {
    const count = await frame(await variant(name, [key, text], options(size, style)), 2000);
    const rows = (top: number, bottom: number) =>
      (bottom - top) * SMALL.width - count(top, bottom, magenta);
    return rows;
  };
  const padding = 0.2 * SMALL.height;
  const line = await covered('keys-line', 1, 'line');
  assert.ok(line(SMALL.height - padding + 20, SMALL.height) > 500, 'keycaps in the padding');
  const small = await covered('keys-small', 1, 'subtitles');
  const large = await covered('keys-large', 2, 'subtitles');
  const below = Math.ceil(zone.bottom);
  assert.ok(small(below, below + 20) > 500, 'keycaps start below the subtitles');
  assert.ok(small(below + 20, SMALL.height) < large(below + 20, SMALL.height), 'larger keycaps');
  assert.equal(buildScene(session).options.keystrokes.size, 1);
});
