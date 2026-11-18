#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { contactSheet, describeSession } from './inspect.ts';
import { recordScreencast } from './record/index.ts';
import { render, renderFrame } from './render/index.ts';
import { loadSession } from './session.ts';
import type { RenderOptions, ScreencastDefinition, Size } from './types.ts';

const HELP = `autocast - automated, polished screencasts of web apps

Usage:
  autocast record <script> [options]     Record a screencast script, then render it
  autocast render <session> [options]    Render a recorded session again
  autocast frame <session> --at <sec>    Render one still frame (PNG)
  autocast inspect <session|video>       Print the timeline and write a contact sheet

Common options:
  -o, --out <file>        Output file (.mp4, .webm, .gif; .png for frame and inspect)
      --config <file>     JSON file with render options
      --set <key=value>   Set one option by path, e.g. --set zoom.maxScale=2.5 (repeatable)
      --preview           Fast render: half size, 30 fps, draft quality
      --size <WxH>        Output size, e.g. 1920x1080
      --fps <n>           Output frame rate
      --background <b>    Background preset name or CSS color
      --range <a:b>       Render only this output time range, in seconds

record options:
      --session <dir>     Session directory (default: .autocast/<name>)
      --no-render         Record only
      --headed            Show the browser window

inspect options:
      --every <sec>       Time between tiles (default: fits 16 tiles)
      --from <sec>        Start time
      --to <sec>          End time
      --cols <n>          Columns (default: 4)

For record, --set applies to the screencast definition (render options are under "render.").
For render, frame and inspect, --set applies to the render options.
`;

/**
 * Sets a value in a nested object by a dotted path.
 */
function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

/**
 * Applies `key=value` pairs. Values are parsed as JSON when possible.
 */
function applySets(target: Record<string, unknown>, sets: string[]): void {
  for (const entry of sets) {
    const index = entry.indexOf('=');
    if (index < 1) {
      throw new Error(`Invalid --set "${entry}". Use key=value, e.g. --set cursor.size=2`);
    }
    const raw = entry.slice(index + 1);
    let value: unknown = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      // A plain string.
    }
    setPath(target, entry.slice(0, index), value);
  }
}

function parseSize(text: string): Size {
  const match = /^(\d+)x(\d+)$/.exec(text);
  if (!match) {
    throw new Error(`Invalid --size "${text}". Use WIDTHxHEIGHT, e.g. 1920x1080`);
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

type Flags = ReturnType<typeof parseFlags>['values'];

function parseFlags(args: string[]) {
  return parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: 'string', short: 'o' },
      config: { type: 'string' },
      set: { type: 'string', multiple: true },
      preview: { type: 'boolean' },
      size: { type: 'string' },
      fps: { type: 'string' },
      background: { type: 'string' },
      range: { type: 'string' },
      session: { type: 'string' },
      'no-render': { type: 'boolean' },
      headed: { type: 'boolean' },
      at: { type: 'string' },
      every: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      cols: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
}

/**
 * Builds render options from the command line flags.
 */
async function renderOptions(flags: Flags, sets: string[]): Promise<RenderOptions> {
  const options: RenderOptions = flags.config
    ? JSON.parse(await readFile(flags.config, 'utf8'))
    : {};
  applySets(options as Record<string, unknown>, sets);
  if (flags.size) {
    options.size = parseSize(flags.size);
  }
  if (flags.fps) {
    options.fps = Number(flags.fps);
  }
  if (flags.background) {
    options.background = flags.background;
  }
  if (flags.range) {
    const [start, end] = flags.range.split(':');
    options.range = {
      start: start ? Number(start) * 1000 : undefined,
      end: end ? Number(end) * 1000 : undefined,
    };
  }
  if (flags.out) {
    options.output = flags.out;
  }
  return options;
}

/**
 * Halves the output size and the frame rate for a fast render.
 */
function applyPreview(options: RenderOptions, base?: RenderOptions): void {
  const size = options.size ?? base?.size ?? { width: 1920, height: 1080 };
  options.size = {
    width: Math.round(size.width / 4) * 2,
    height: Math.round(size.height / 4) * 2,
  };
  options.fps = 30;
  options.encode = { ...options.encode, quality: 'draft' };
}

function progress(label: string): (done: number, total: number) => void {
  let last = -1;
  return (done, total) => {
    const percent = Math.floor((done / total) * 100);
    const step = process.stderr.isTTY ? 1 : 10;
    if (percent === last || percent % step !== 0) {
      return;
    }
    last = percent;
    if (process.stderr.isTTY) {
      process.stderr.write(`\r${label} ${percent}%`);
      if (percent === 100) {
        process.stderr.write('\n');
      }
    } else {
      process.stderr.write(`${label} ${percent}%\n`);
    }
  };
}

async function loadDefinition(script: string): Promise<ScreencastDefinition> {
  const module = await import(pathToFileURL(path.resolve(script)).href);
  const definition = module.default as ScreencastDefinition | undefined;
  if (!definition || typeof definition.run !== 'function') {
    throw new Error(
      `"${script}" must default-export a screencast: export default defineScreencast({ url, run })`,
    );
  }
  return definition;
}

async function commandRecord(positionals: string[], flags: Flags): Promise<void> {
  const script = positionals[0];
  if (!script) {
    throw new Error('Usage: autocast record <script>');
  }
  const definition = await loadDefinition(script);
  const overrides: Record<string, unknown> = {};
  applySets(overrides, flags.set ?? []);
  if (flags.session) {
    overrides.sessionDir = flags.session;
  }
  if (flags.headed) {
    setPath(overrides, 'browser.headless', false);
  }
  process.stderr.write(`Recording ${definition.name ?? script}...\n`);
  const recorded = await recordScreencast(definition, overrides);
  const seconds = (recorded.session.duration / 1000).toFixed(1);
  console.log(`Session: ${recorded.dir} (${seconds}s, ${recorded.session.frames.length} frames)`);
  if (flags['no-render']) {
    return;
  }
  const options = await renderOptions(flags, []);
  if (flags.preview) {
    applyPreview(options, recorded.session.render);
  }
  options.onProgress = progress('Rendering');
  const result = await recorded.render(options);
  printResult(result);
}

async function commandRender(positionals: string[], flags: Flags): Promise<void> {
  const dir = positionals[0];
  if (!dir) {
    throw new Error('Usage: autocast render <session>');
  }
  const session = await loadSession(dir);
  const options = await renderOptions(flags, flags.set ?? []);
  if (flags.preview) {
    applyPreview(options, session.render);
  }
  options.onProgress = progress('Rendering');
  printResult(await render(dir, options));
}

function printResult(result: Awaited<ReturnType<typeof render>>): void {
  const seconds = (result.duration / 1000).toFixed(1);
  const { width, height } = result.size;
  console.log(`Video: ${result.output} (${seconds}s, ${width}x${height} @ ${result.fps} fps)`);
}

async function commandFrame(positionals: string[], flags: Flags): Promise<void> {
  const dir = positionals[0];
  if (!dir || flags.at === undefined) {
    throw new Error('Usage: autocast frame <session> --at <seconds> [-o frame.png]');
  }
  const options = await renderOptions(flags, flags.set ?? []);
  const out = flags.out ?? `frame-${flags.at}s.png`;
  delete options.output;
  const png = await renderFrame(dir, Number(flags.at) * 1000, options);
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, png);
  console.log(`Frame: ${out}`);
}

async function commandInspect(positionals: string[], flags: Flags): Promise<void> {
  const source = positionals[0];
  if (!source) {
    throw new Error('Usage: autocast inspect <session|video> [-o sheet.png]');
  }
  const options = await renderOptions(flags, flags.set ?? []);
  const out = flags.out ?? 'contact-sheet.png';
  delete options.output;
  const isVideo = /\.(mp4|webm|gif|mov|mkv)$/i.test(source);
  if (!isVideo) {
    console.log(describeSession(await loadSession(source), options));
  }
  const sheet = await contactSheet(source, {
    out,
    every: flags.every ? Number(flags.every) * 1000 : undefined,
    from: flags.from ? Number(flags.from) * 1000 : undefined,
    to: flags.to ? Number(flags.to) * 1000 : undefined,
    columns: flags.cols ? Number(flags.cols) : undefined,
    render: options,
  });
  console.log(`Contact sheet: ${sheet.out} (${sheet.tiles} tiles, one every ${sheet.every / 1000}s)`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(HELP);
    return;
  }
  const { values, positionals } = parseFlags(rest);
  if (values.help) {
    console.log(HELP);
    return;
  }
  const commands: Record<string, (positionals: string[], flags: Flags) => Promise<void>> = {
    record: commandRecord,
    render: commandRender,
    frame: commandFrame,
    inspect: commandInspect,
  };
  const run = commands[command];
  if (!run) {
    throw new Error(`Unknown command "${command}".\n\n${HELP}`);
  }
  await run(positionals, values);
}

main().catch((error: Error) => {
  console.error(`autocast: ${error.message}`);
  process.exitCode = 1;
});
