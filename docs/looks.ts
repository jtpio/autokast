import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Makes the "looks" video of the README: `npm run docs:looks`. It renders the recording
 * of `examples/orbit-board.ts` with four looks and puts them on a grid with ffmpeg.
 * Record that script first. An argument gives another output file.
 */

const root = path.join(import.meta.dirname, '..');
const cli = path.join(root, 'src', 'cli.ts');
const session = path.join(root, '.autokast', 'orbit-board');
const output = process.argv[2] ?? 'looks.mp4';

const GRADIENT = { type: 'gradient', colors: ['#2b5876', '#d98a6a'], angle: 135 };
const BROWSER = ['--set', 'frame.chromeTheme=dark', '--set', 'frame.origin=orbit.example'];
const LOOKS = [
  ['--preset', 'plain'],
  ['--preset', 'showcase', '--background', 'ink', ...BROWSER],
  ['--set', `background=${JSON.stringify(GRADIENT)}`, '--padding', '0.12'],
  ['--background', 'sage', '--set', 'frame.chrome=window', '--set', 'frame.title=Orbit'],
];

const dir = await mkdtemp(path.join(os.tmpdir(), 'autokast-looks-'));
const files = LOOKS.map((look, index) => {
  const file = path.join(dir, `${index}.mp4`);
  // The crop mode keeps the window and the backdrop in view during the zooms.
  const common = ['--size', '960x540', '--set', 'zoom.mode=crop', '--set', 'encode.quality=high'];
  execFileSync(process.execPath, [cli, 'render', session, '-o', file, ...common, ...look], {
    stdio: 'inherit',
  });
  return file;
});
execFileSync(
  process.env.AUTOKAST_FFMPEG ?? 'ffmpeg',
  [
    ...['-y', '-v', 'error'],
    ...files.flatMap((file) => ['-i', file]),
    ...['-filter_complex', 'xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0'],
    ...['-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
    output,
  ],
  { stdio: 'inherit' },
);
await rm(dir, { recursive: true });
