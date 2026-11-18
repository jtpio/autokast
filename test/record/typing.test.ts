import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';
import { record } from '../../src/record/index.ts';
import type { ActionEvent, KeyEvent } from '../../src/types.ts';
import { CODE, serve, type TestServer } from './helpers.ts';

const PAGE = `<!doctype html><body style="margin:0">
<textarea id="plain-auto" rows="12" cols="40"></textarea>
<textarea id="plain-raw" rows="12" cols="40"></textarea>
<textarea id="smart-auto" rows="12" cols="40"></textarea>
<textarea id="smart-raw" rows="12" cols="40"></textarea>
<script>
  // An editor that indents by itself, like CodeMirror with Python.
  for (const id of ['smart-auto', 'smart-raw']) {
    const area = document.getElementById(id);
    area.addEventListener('keydown', (event) => {
      const value = area.value;
      const caret = area.selectionStart;
      const start = value.lastIndexOf('\\n', caret - 1) + 1;
      const before = value.slice(start, caret);
      if (event.key === 'Enter') {
        event.preventDefault();
        const indent = /^[ \\t]*/.exec(before)[0] + (/:\\s*$/.test(before) ? '    ' : '');
        area.setRangeText('\\n' + indent, caret, area.selectionEnd, 'end');
      } else if (event.key === 'Backspace' && before && !/\\S/.test(before)) {
        event.preventDefault();
        area.setRangeText('', start + Math.floor((before.length - 1) / 4) * 4, caret, 'end');
      }
    });
  }
</script></body>`;

let server: TestServer;
let dir: string;

before(async () => {
  server = await serve({ '/': PAGE });
  dir = await mkdtemp(path.join(os.tmpdir(), 'autocast-typing-'));
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

it('types the exact text with auto indentation, also in an editor that indents', async () => {
  const values: Record<string, string> = {};
  const ids = ['plain-auto', 'plain-raw', 'smart-auto', 'smart-raw'];
  const { session } = await record(
    { url: server.url, sessionDir: dir, pacing: { startDelay: 0, endDelay: 0 } },
    async (cast) => {
      for (const id of ids) {
        const indent = id.endsWith('raw') ? 'raw' : 'auto';
        await cast.type(CODE, { into: `#${id}`, indent, delay: 5, variance: 0 });
        values[id] = await cast.page.locator(`#${id}`).inputValue();
      }
    },
  );
  assert.equal(values['plain-auto'], CODE);
  assert.equal(values['plain-raw'], CODE);
  assert.equal(values['smart-auto'], CODE);
  assert.notEqual(values['smart-raw'], CODE, 'the editor indents by itself');
  assert.ok(values['smart-raw'].includes('\n        for i'), 'raw typing doubles the indentation');

  const actions = session.events.filter((event): event is ActionEvent => event.type === 'action');
  const keysOf = (action: ActionEvent) =>
    session.events
      .filter((event): event is KeyEvent => event.type === 'key')
      .filter((event) => event.t >= action.t && event.t <= action.end)
      .map((event) => event.key)
      .join('');
  const types = actions.filter((action) => action.call.startsWith('type('));
  assert.equal(types.length, 4);
  assert.equal(types[0].call, 'type("def table(n):\\n    for i in ra…")');
  assert.equal(keysOf(types[0]), CODE, 'without editor indentation, auto types every key');
  assert.equal(keysOf(types[1]), CODE);
  assert.ok(keysOf(types[2]).length < CODE.length, 'auto skips the indentation the editor adds');
});
