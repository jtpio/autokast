import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BACKGROUND_PRESETS, createBackground } from '../src/render/background.ts';

/**
 * Draws the backdrop images of the README: `npm run docs:backdrops`. An argument gives
 * another output directory.
 */

const SIZE = { width: 400, height: 225 };
const dir = process.argv[2] ?? path.join(import.meta.dirname, 'images', 'backdrops');

await mkdir(dir, { recursive: true });
for (const name of BACKGROUND_PRESETS) {
  const canvas = await createBackground({ type: 'preset', name }, SIZE, SIZE.height / 1080);
  await writeFile(path.join(dir, `${name}.jpg`), await canvas.encode('jpeg', 90));
}
