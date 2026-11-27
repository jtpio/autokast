import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULTS as RECORD_DEFAULTS } from '../src/record/defaults.ts';
import { DEFAULTS as RENDER_DEFAULTS } from '../src/render/defaults.ts';

const root = path.join(import.meta.dirname, '..');
const read = (...parts: string[]) => readFile(path.join(root, ...parts), 'utf8');

const readme = await read('README.md');
const skill = await read('skills', 'autokast', 'SKILL.md');
const types = await read('src', 'types.ts');
const help = execFileSync(process.execPath, [path.join(root, 'src', 'cli.ts'), '--help'], {
  encoding: 'utf8',
});

/**
 * Options whose value is an object, but which the README has as one option.
 */
const VALUES = ['size', 'viewport', 'frame.shadow', 'zoom.levels'];

/**
 * Dotted paths of the options in a defaults object.
 */
function optionPaths(options: object, prefix = ''): string[] {
  return Object.entries(options).flatMap(([key, value]) => {
    const name = prefix + key;
    const group = typeof value === 'object' && value !== null && !VALUES.includes(name);
    return group ? optionPaths(value, `${name}.`) : [name];
  });
}

const OPTIONS = [...optionPaths(RECORD_DEFAULTS), ...optionPaths(RENDER_DEFAULTS)];
const GROUPS = [...new Set(OPTIONS.filter((name) => name.includes('.')).map(group))];

function group(name: string): string {
  return name.split('.')[0];
}

/**
 * Methods of the `Cast` interface.
 */
const CALLS = Array.from(
  types
    .slice(types.indexOf('export interface Cast {'))
    .split('\n}\n')[0]
    .matchAll(/^ {2}(\w+)[<(]/gm),
  (match) => match[1],
);

function codeSpans(text: string): string[] {
  return Array.from(text.matchAll(/`([^`\n]+)`/g), (match) => match[1]);
}

function flags(text: string): string[] {
  return [...new Set(text.match(/--[a-z][a-z-]*/g))];
}

/**
 * Option paths in `text`, such as `zoom.levels` in `--set 'zoom.levels={"close":2.6}'`.
 */
function namedOptions(text: string): string[] {
  const pattern = new RegExp(`\\b(?:${GROUPS.join('|')})(?:\\.[A-Za-z]+)+`, 'g');
  return [...new Set(text.match(pattern))];
}

/**
 * Cast calls that `text` does not show in a code span, as `click`, `click(...)` or
 * `cast.click(...)`.
 */
function missingCalls(text: string): string[] {
  const spans = codeSpans(text).map((span) => span.replace(/^cast\./, '').split('(')[0]);
  return CALLS.filter((call) => !spans.includes(call));
}

function missing(names: string[], known: string[]): string[] {
  return names.filter((name) => !known.includes(name));
}

test('the test finds the options, the flags and the calls', () => {
  assert.ok(OPTIONS.includes('capture.mode') && OPTIONS.includes('cursor.click.type'));
  assert.ok(flags(help).includes('--tile-width'));
  assert.ok(CALLS.includes('moveTo') && CALLS.includes('cut') && CALLS.includes('marker'));
});

test('the README has each option, flag and call', () => {
  assert.deepEqual(missing(OPTIONS, codeSpans(readme)), [], 'options');
  assert.deepEqual(missing(flags(help), flags(readme)), [], 'flags');
  assert.deepEqual(missingCalls(readme), [], 'calls');
});

test('the skill has each call', () => {
  assert.deepEqual(missingCalls(skill), []);
});

test('the skill names only options, flags and calls that exist', () => {
  assert.deepEqual(missing(namedOptions(skill), codeSpans(readme)), [], 'options');
  // The install command has flags of npm.
  const cli = skill.replace(/^npm .*$/gm, '');
  assert.deepEqual(missing(flags(cli), flags(help)), [], 'flags');
  const calls = Array.from(skill.matchAll(/\bcast\.(\w+)/g), (match) => match[1]);
  assert.deepEqual(missing(calls, [...CALLS, 'page', 'viewport']), [], 'calls');
});
