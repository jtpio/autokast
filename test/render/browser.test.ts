import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressAt, splitAddress } from '../../src/render/browser.ts';
import type { TimedEvent } from '../../src/render/timeline.ts';
import type { UrlEvent } from '../../src/types.ts';

const url = (out: number, address: string, typing?: number): TimedEvent<UrlEvent> => ({
  type: 'url',
  t: out,
  out,
  url: address,
  ...(typing ? { typing } : {}),
});

const PAGE = { address: true, origin: '' };

test('an address has no scheme, and the host is apart from the rest', () => {
  assert.deepEqual(splitAddress('http://localhost:8000/lab/index.html?path=a.ipynb#x'), {
    host: 'localhost:8000',
    path: '/lab/index.html?path=a.ipynb#x',
  });
  assert.deepEqual(splitAddress('https://example.org/'), { host: 'example.org', path: '' });
  assert.deepEqual(splitAddress('about:blank'), { host: 'about:blank', path: '' });
  assert.deepEqual(splitAddress('not a url'), { host: 'not a url', path: '' });
});

test('origin replaces the origin of the page, with its own path first', () => {
  assert.deepEqual(splitAddress('http://localhost:8000/tree/index.html', 'example.org'), {
    host: 'example.org',
    path: '/tree/index.html',
  });
  assert.deepEqual(
    splitAddress('http://localhost:8000/tree/index.html', 'https://example.org/demo/'),
    { host: 'example.org', path: '/demo/tree/index.html' },
  );
  assert.deepEqual(splitAddress('http://localhost:8000/', 'example.org/demo'), {
    host: 'example.org',
    path: '/demo/',
  });
});

test('the address bar shows the latest address of the page', () => {
  const urls = [
    url(0, 'http://a.test/'),
    url(1000, 'http://a.test/one'),
    url(1000, 'http://a.test/two'),
  ];
  assert.deepEqual(addressAt(urls, 999, PAGE), { host: 'a.test', path: '', focus: 0 });
  assert.deepEqual(addressAt(urls, 1000, PAGE), { host: 'a.test', path: '/two', focus: 0 });
  assert.deepEqual(addressAt(urls, 5000, { address: false, origin: '' }), {
    host: '',
    path: '',
    focus: 0,
  });
  assert.deepEqual(addressAt(urls, 5000, { address: 'docs.test/guide', origin: '' }), {
    host: 'docs.test',
    path: '/guide',
    focus: 0,
  });
});

test('a typed address grows with time, with the focus, then stays complete', () => {
  const urls = [url(0, 'http://a.test/'), url(1000, 'http://a.test/abcd', 1000)];
  const at = (t: number) => addressAt(urls, t, PAGE);
  assert.deepEqual(at(1000), { host: '', path: '', focus: 0, caret: true });
  const half = at(1500);
  assert.equal(`${half.host}${half.path}`, 'a.test');
  assert.equal(half.focus, 1);
  assert.equal(half.caret, true);
  let last = 0;
  for (let t = 1000; t <= 2000; t += 20) {
    const { host, path } = at(t);
    assert.ok(host.length + path.length >= last);
    last = host.length + path.length;
  }
  assert.deepEqual(at(2000), { host: 'a.test', path: '/abcd', focus: 1, caret: true });
  assert.deepEqual(at(2500), { host: 'a.test', path: '/abcd', focus: 0 });
});

test('a shown address is complete and larger for its time, with no caret', () => {
  const shown: TimedEvent<UrlEvent> = { ...url(1000, 'http://a.test/abcd'), show: 2000 };
  const at = (t: number) => addressAt([url(0, 'http://a.test/'), shown], t, PAGE);
  assert.deepEqual(at(1000), { host: 'a.test', path: '/abcd', focus: 0 });
  assert.deepEqual(at(2000), { host: 'a.test', path: '/abcd', focus: 1 });
  assert.ok(at(1100).focus > 0 && at(1100).focus < 1);
  assert.ok(at(2900).focus > 0 && at(2900).focus < 1);
  assert.deepEqual(at(3000), { host: 'a.test', path: '/abcd', focus: 0 });
});
