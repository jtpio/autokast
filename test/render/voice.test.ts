import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, mock, test } from 'node:test';
import { render } from '../../src/render/index.ts';
import { buildScene } from '../../src/render/scene.ts';
import { planSubtitles, type SubtitlePage } from '../../src/render/subtitles.ts';
import type { TimedEvent } from '../../src/render/timeline.ts';
import {
  loadSpeech,
  planVoice,
  spokenText,
  VOICE_DIR,
  VOICE_KEY,
  voiceTrack,
  wordTimes,
  type SpeechClip,
} from '../../src/render/voice.ts';
import type { CaptionEvent, Session } from '../../src/types.ts';
import { createFixture } from './fixture.ts';

let dir: string;
let session: Session;
const VOICE = { enabled: true, voiceId: 'voice-1', model: 'model-1', speed: 1 };

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-voice-'));
  session = await createFixture(path.join(dir, 'session'), { deviceScaleFactor: 1 });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => {
  mock.restoreAll();
  delete process.env[VOICE_KEY];
});

const caption = (out: number, text: string, duration = 3000): TimedEvent<CaptionEvent> => ({
  type: 'caption',
  t: out,
  out,
  duration,
  text,
});

const clip = (duration: number, ...words: [number, number][]): SpeechClip => ({
  file: 'clip.mp3',
  duration,
  words: words.map(([start, end]) => ({ start, end })),
});

/**
 * One second of a 440 Hz tone, as a WAV file: ffmpeg reads it whatever its file name.
 */
function tone(): Buffer {
  const rate = 8000;
  const data = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i++) {
    data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Replaces `fetch` with an API that says each character in 0.1 s, and records the calls.
 */
function fakeApi(status = 200) {
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] =
    [];
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, headers: init.headers as Record<string, string>, body });
    if (status !== 200) {
      return new Response(JSON.stringify({ detail: { message: 'The key is not valid.' } }), {
        status,
      });
    }
    const characters = [...(body.text as string)];
    return new Response(
      JSON.stringify({
        audio_base64: tone().toString('base64'),
        alignment: {
          characters,
          character_start_times_seconds: characters.map((c, i) => i / 10),
          character_end_times_seconds: characters.map((c, i) => (i + 1) / 10),
        },
      }),
    );
  });
  return calls;
}

test('the spoken text of a caption has its words and no emphasis marks', () => {
  assert.equal(spokenText('Write  code in a **notebook**'), 'Write code in a notebook');
  assert.equal(spokenText('**'), '');
});

test('the time of each word comes from the time of its characters', () => {
  const text = 'Hi all';
  const alignment = {
    characters: [...text],
    character_start_times_seconds: [0, 0.1, 0.2, 0.5, 0.6, 0.7],
    character_end_times_seconds: [0.1, 0.2, 0.5, 0.6, 0.7, 0.9],
  };
  assert.deepEqual(wordTimes(text, alignment, 1000), [
    { start: 0, end: 200 },
    { start: 500, end: 900 },
  ]);
  const shares = wordTimes('Hi all there', { ...alignment, characters: [...'Hi-all'] }, 1300);
  assert.equal(shares.length, 3);
  assert.equal(shares[0].start, 0);
  assert.equal(shares[1].start, shares[0].end);
  assert.ok(Math.abs(shares[2].end - 1300) < 1e-6);
  assert.ok(shares[2].end - shares[2].start > shares[0].end - shares[0].start);
  assert.equal(wordTimes('One two', null, 800).length, 2);
});

test('a voice starts just after its caption, and waits for the voice before it', () => {
  const clips = new Map([
    ['One two', clip(2000)],
    ['Three', clip(1000)],
  ]);
  const free = planVoice([caption(1000, 'One **two**'), caption(5000, 'Three')], clips, 9000);
  assert.deepEqual(
    free.cues.map((cue) => cue && [cue.at, cue.end]),
    [
      [1200, 3200],
      [5200, 6200],
    ],
  );
  assert.deepEqual(free.warnings, []);

  const close = planVoice([caption(1000, 'One two'), caption(2000, 'Three')], clips, 9000);
  assert.ok(close.cues[1]!.at > close.cues[0]!.end, 'two voices are not at the same time');
  assert.equal(close.warnings.length, 1);
  assert.match(close.warnings[0], /The voice of the caption at 2\.0 s starts 1\.\d s late/);

  const end = planVoice([caption(8500, 'Three')], clips, 9000);
  assert.match(end.warnings[0], /ends 0\.7 s after the end of the video/);
  assert.deepEqual(planVoice([caption(0, 'Other')], clips, 9000).cues, [undefined]);
});

test('the audio track puts each clip at its time, also for a part of the video', () => {
  const cues = [
    { clip: { ...clip(2000), file: 'a.mp3' }, at: 1200, end: 3200 },
    { clip: { ...clip(1000), file: 'b.mp3' }, at: 5200, end: 6200 },
  ];
  const whole = voiceTrack(cues, 0, 9000)!;
  assert.deepEqual(whole.inputs, ['-i', 'a.mp3', '-i', 'b.mp3']);
  assert.match(whole.filter, /\[1:a\]adelay=1200:all=1\[v0\];\[2:a\]adelay=5200:all=1\[v1\];/);
  assert.match(whole.filter, /amix=inputs=2:normalize=0.*atrim=end=9\.000\[voice\]$/);
  const part = voiceTrack(cues, 2000, 5500)!;
  assert.match(part.filter, /\[1:a\]atrim=start=0\.800,asetpts=PTS-STARTPTS\[v0\]/);
  assert.match(part.filter, /\[2:a\]adelay=3200:all=1\[v1\]/);
  const one = voiceTrack(cues, 4000, 9000)!;
  assert.deepEqual(one.inputs, ['-i', 'b.mp3']);
  assert.doesNotMatch(one.filter, /amix/);
  assert.equal(voiceTrack(cues, 3300, 5000), null);
});

test('a speech clip comes from the API one time, then from the session directory', async () => {
  const target = path.join(dir, 'clips');
  await assert.rejects(
    loadSpeech(target, ['Hello there'], VOICE),
    /needs an ElevenLabs API key: set the ELEVENLABS_API_KEY environment variable/,
  );
  process.env[VOICE_KEY] = 'secret';
  const calls = fakeApi();
  const clips = await loadSpeech(target, ['Hello **there**', 'Hello there', ' '], VOICE);
  assert.equal(calls.length, 1, 'the same words are one clip');
  assert.equal(
    calls[0].url,
    'https://api.elevenlabs.io/v1/text-to-speech/voice-1/with-timestamps?output_format=mp3_44100_128',
  );
  assert.equal(calls[0].headers['xi-api-key'], 'secret');
  assert.deepEqual(calls[0].body, { text: 'Hello there', model_id: 'model-1' });
  const speech = clips.get('Hello there')!;
  assert.deepEqual(speech.words, [
    { start: 0, end: 500 },
    { start: 600, end: 1100 },
  ]);
  assert.ok(speech.duration >= 1100);
  assert.deepEqual((await readdir(target)).map((name) => path.extname(name)).sort(), [
    '.json',
    '.mp3',
  ]);

  delete process.env[VOICE_KEY];
  const again = await loadSpeech(target, ['Hello there'], VOICE);
  assert.equal(calls.length, 1, 'no call and no key for a clip that exists');
  assert.deepEqual(again.get('Hello there'), speech);

  process.env[VOICE_KEY] = 'secret';
  await loadSpeech(target, ['Hello there'], { ...VOICE, speed: 1.1 });
  assert.equal(calls.length, 2, 'another speed is another clip');
  assert.deepEqual(calls[1].body.voice_settings, { speed: 1.1 });
});

test('an error of the API gives its message', async () => {
  process.env[VOICE_KEY] = 'wrong';
  fakeApi(401);
  await assert.rejects(
    loadSpeech(path.join(dir, 'failed'), ['Hello'], VOICE),
    /ElevenLabs did not give the voice of "Hello" \(status 401\): The key is not valid\./,
  );
});

test('with a voice, the words and the pages of a subtitle follow the speech', () => {
  const page = (...words: string[]): SubtitlePage => ({
    fontSize: 60,
    height: 70,
    words: words.map((text, i) => ({ text, strong: false, x: i * 100, baseline: 50 })),
  });
  const said = {
    clip: clip(2600, [0, 400], [450, 900], [1500, 1900], [2000, 2500]),
    at: 1200,
    end: 3800,
  };
  const cues = planSubtitles(
    [caption(1000, 'x', 1000)],
    () => [page('One', 'two'), page('three', 'four')],
    [said],
  );
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 1000, 'the page shows just before the voice starts');
  assert.deepEqual(
    cues[0].words.map((word) => [word.at, word.until]),
    [
      [1200, 1650],
      [1650, 2100],
    ],
  );
  assert.ok(cues[0].end < cues[1].start && cues[1].start < 1200 + 1500);
  assert.equal(cues[1].words[0].at, 1200 + 1500);
  assert.equal(cues[1].words[1].until, 1200 + 2500);
  assert.ok(cues[1].end > said.end, 'the last page stays until the voice is at its end');
});

test('a render with the voice has an audio stream of the length of the video', async () => {
  const streams = (file: string) =>
    execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name,duration',
      '-of',
      'csv=p=0',
      file,
    ])
      .toString()
      .trim()
      .split('\n')
      .map((line) => line.split(','));
  const source = path.join(dir, 'session');
  const options = { size: { width: 320, height: 180 }, fps: 10, range: { end: 3000 } };
  const silent = await render(source, { ...options, output: path.join(dir, 'silent.mp4') });
  assert.deepEqual(
    streams(silent.output).map((stream) => stream[1]),
    ['video'],
  );

  process.env[VOICE_KEY] = 'secret';
  const calls = fakeApi();
  const voiced = await render(source, {
    ...options,
    voice: { enabled: true },
    captions: { style: 'subtitles' },
    output: path.join(dir, 'voiced.mp4'),
  });
  const captions = session.events.filter((event) => event.type === 'caption');
  assert.equal(calls.length, captions.length);
  assert.match(calls[0].url, /text-to-speech\/JBFqnCBsd6RMkjVDRZzb\/with-timestamps/);
  assert.equal(calls[0].body.model_id, 'eleven_multilingual_v2');
  assert.equal((await readdir(path.join(source, VOICE_DIR))).length, 2 * captions.length);
  const [video, audio] = streams(voiced.output);
  assert.deepEqual([video[0], audio[0]], ['h264', 'aac']);
  assert.ok(Math.abs(Number(audio[2]) - 3) < 0.15, `audio of ${audio[2]} s`);

  const webm = await render(source, {
    ...options,
    voice: { enabled: true },
    output: path.join(dir, 'voiced.webm'),
  });
  assert.equal(calls.length, captions.length, 'the clips are made one time');
  assert.deepEqual(
    streams(webm.output).map((stream) => stream[0]),
    ['vp9', 'opus'],
  );

  const gif = await render(source, {
    ...options,
    voice: { enabled: true },
    output: path.join(dir, 'voiced.gif'),
  });
  assert.ok(gif.warnings.some((warning) => /A GIF has no sound/.test(warning)));
});

test('the voice is off by default, and a scene without speech clips has no voice', () => {
  assert.equal(buildScene(session).options.voice.enabled, false);
  const scene = buildScene(session, { voice: { enabled: true, voiceId: 'abc' } });
  assert.equal(scene.options.voice.voiceId, 'abc');
  assert.equal(scene.options.voice.model, 'eleven_multilingual_v2');
  assert.deepEqual(scene.voice, []);
  assert.deepEqual(scene.voiceWarnings, []);
});
