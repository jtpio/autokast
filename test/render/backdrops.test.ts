import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createCanvas, loadImage, type Image } from '@napi-rs/canvas';
import { BACKGROUND_PRESETS } from '../../src/render/background.ts';

const root = path.join(import.meta.dirname, '..', '..');
const committed = path.join(root, 'docs', 'images', 'backdrops');

const COLS = 16;
const ROWS = 9;

let fresh: string;

before(async () => {
  fresh = await mkdtemp(path.join(os.tmpdir(), 'autokast-backdrops-'));
  execFileSync(process.execPath, [path.join(root, 'docs', 'backdrops.ts'), fresh]);
});

after(async () => {
  await rm(fresh, { recursive: true, force: true });
});

/**
 * Mean color of each cell of a grid on the image. The mean removes the small differences
 * between the pixels of two platforms.
 */
function cellMeans(image: Image): number[] {
  const { width, height } = image;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height);
  const sums = new Array<number>(COLS * ROWS * 3).fill(0);
  const counts = new Array<number>(COLS * ROWS).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cell = Math.floor((y * ROWS) / height) * COLS + Math.floor((x * COLS) / width);
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) sums[cell * 3 + c] += data[i + c];
      counts[cell]++;
    }
  }
  return sums.map((sum, i) => sum / counts[Math.floor(i / 3)]);
}

test('the README shows a current image of each backdrop', async () => {
  const files = BACKGROUND_PRESETS.map((name) => `${name}.jpg`);
  assert.deepEqual((await readdir(committed)).sort(), [...files].sort());
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');
  for (const file of files) {
    assert.ok(readme.includes(`docs/images/backdrops/${file}`), `${file} is in the README`);
    const [actual, expected] = await Promise.all(
      [committed, fresh].map((dir) => loadImage(path.join(dir, file))),
    );
    const hint = `${file} is not current: run "npm run docs:backdrops"`;
    assert.deepEqual([actual.width, actual.height], [expected.width, expected.height], hint);
    const means = cellMeans(expected);
    const difference = Math.max(...cellMeans(actual).map((v, i) => Math.abs(v - means[i])));
    assert.ok(difference < 1, `${hint} (difference: ${difference.toFixed(2)})`);
  }
});
