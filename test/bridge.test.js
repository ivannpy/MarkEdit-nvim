'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createBridge, diffRange, DEFAULTS, PROTOCOL } = require('../src/markedit-nvim.js');
const { FakeEventSource, FakeTimers, flush, makeMarkEdit, makeFetch } = require('./helpers.js');

async function setup(options) {
  FakeEventSource.reset();
  const timers = new FakeTimers();
  const fetch = makeFetch();
  const { MarkEdit, editor } = makeMarkEdit(options);
  const bridge = createBridge({
    MarkEdit,
    EventSource: FakeEventSource,
    fetch,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const started = await bridge.start();
  return { bridge, editor, timers, fetch, started, es: FakeEventSource.last() };
}

const hello = { protocol: PROTOCOL, server: 'markedit.nvim', version: '0.1.0' };
const locks = (editor) => editor.dispatched.filter((d) => d.effects && d.effects.reconfigure);

test('diffRange finds the smallest change', () => {
  assert.deepEqual(diffRange('abcdef', 'abXdef'), { from: 2, to: 3, insert: 'X' });
  assert.deepEqual(diffRange('abc', 'abc'), { from: 3, to: 3, insert: '' });
  assert.deepEqual(diffRange('abc', 'abcd'), { from: 3, to: 3, insert: 'd' });
  assert.deepEqual(diffRange('abcd', 'ad'), { from: 1, to: 3, insert: '' });
});

test('connects with the document path, protocol and token', async () => {
  const { es, started } = await setup({
    path: '/tmp/a b/ñ.md',
    userSettings: { 'extension.markeditNvim': { token: 's3 cret', port: 9000 } },
  });
  assert.equal(started, true);
  assert.equal(
    es.url,
    `http://127.0.0.1:9000/events?v=1&path=${encodeURIComponent('/tmp/a b/ñ.md')}&token=${encodeURIComponent('s3 cret')}`
  );
});

test('uses the default port when nothing is configured', async () => {
  const { es } = await setup();
  assert.ok(es.url.startsWith(`http://127.0.0.1:${DEFAULTS.port}/events?`));
});

test('does nothing for an untitled document', async () => {
  const { started } = await setup({ untitled: true });
  assert.equal(started, false);
  assert.equal(FakeEventSource.instances.length, 0);
});

test('installs a compartment and a menu item', async () => {
  const { editor } = await setup();
  assert.equal(editor.extensions.length, 1);
  assert.equal(editor.menuItems.length, 1);
});

test('hello alone does not lock the document', async () => {
  const { es, editor, bridge, fetch } = await setup();
  es.emit('hello', hello);
  assert.equal(locks(editor).length, 0);
  assert.equal(bridge.status().connected, true);
  assert.equal(fetch.calls[0].body.type, 'ready');
  assert.equal(fetch.calls[0].body.lines, 3);
});

test('open locks the document read-only and not editable', async () => {
  const { es, editor, bridge } = await setup();
  es.emit('hello', hello);
  es.emit('open', { path: '/tmp/notes/doc.md' });
  const [lock] = locks(editor);
  assert.deepEqual(lock.effects.reconfigure, [{ readOnly: true }, { editable: false }]);
  assert.equal(bridge.status().locked, true);
});

test('lock = false never locks', async () => {
  const { es, editor } = await setup({ userSettings: { 'extension.markeditNvim': { lock: false } } });
  es.emit('hello', hello);
  es.emit('open', {});
  assert.equal(locks(editor).length, 0);
});

test('close unlocks the document', async () => {
  const { es, editor, bridge } = await setup();
  es.emit('open', {});
  es.emit('close', {});
  assert.equal(locks(editor).length, 2);
  assert.deepEqual(locks(editor)[1].effects.reconfigure, []);
  assert.equal(bridge.status().locked, false);
});

test('closeOnDetach closes the window', async () => {
  const { es, editor } = await setup({ userSettings: { 'extension.markeditNvim': { closeOnDetach: true } } });
  es.emit('open', {});
  es.emit('close', {});
  assert.equal(editor.closed, 1);
});

test('bye unlocks the document', async () => {
  const { es, bridge } = await setup();
  es.emit('open', {});
  es.emit('bye', {});
  assert.equal(bridge.status().locked, false);
});

test('cursor moves the selection and scrolls (1-based line, UTF-16 column)', async () => {
  const { es, editor } = await setup({ text: 'one\ntwo\nthree' });
  es.emit('cursor', { line: 2, col: 1 });
  const move = editor.dispatched.pop();
  // "one\n" is 4 characters, so line 2 starts at 4 and column 1 is position 5
  assert.deepEqual(move.selection, { anchor: 5 });
  assert.deepEqual(move.effects, { scrollIntoView: 5, opts: { y: 'center' } });
});

test('cursor positions are clamped to the document', async () => {
  const { es, editor } = await setup({ text: 'one\ntwo' });
  es.emit('cursor', { line: 99, col: 99 });
  assert.deepEqual(editor.dispatched.pop().selection, { anchor: 7 });
  es.emit('cursor', { line: 0, col: -4 });
  assert.deepEqual(editor.dispatched.pop().selection, { anchor: 0 });
});

test('the scroll placement can be configured', async () => {
  const { es, editor } = await setup({ userSettings: { 'extension.markeditNvim': { scroll: 'start' } } });
  es.emit('cursor', { line: 1, col: 0 });
  assert.equal(editor.dispatched.pop().effects.opts.y, 'start');
});

test('saved applies the text from disk when MarkEdit did not reload it', async () => {
  const { es, editor, timers } = await setup({ text: 'old text', disk: 'new text' });
  es.emit('open', {});
  es.emit('saved', {});
  assert.equal(editor.doc, 'old text', 'nothing happens before the delay');
  timers.advance(300);
  await flush();
  assert.equal(editor.doc, 'new text');
  const change = editor.dispatched.pop().changes;
  assert.deepEqual(change, { from: 0, to: 3, insert: 'new' });
});

test('saved does nothing when the document already matches the disk', async () => {
  const { es, editor, timers } = await setup({ text: 'same', disk: 'same' });
  es.emit('open', {});
  const before = editor.dispatched.length;
  es.emit('saved', {});
  timers.advance(300);
  await flush();
  assert.equal(editor.dispatched.length, before);
});

test('saved ignores differences in line breaks only', async () => {
  const { es, editor, timers } = await setup({ text: 'a\nb', disk: 'a\r\nb' });
  es.emit('open', {});
  const before = editor.dispatched.length;
  es.emit('saved', {});
  timers.advance(300);
  await flush();
  assert.equal(editor.dispatched.length, before);
});

test('several saves in a row reconcile once', async () => {
  const { es, editor, timers } = await setup({ text: 'a', disk: 'b' });
  es.emit('open', {});
  es.emit('saved', {});
  es.emit('saved', {});
  es.emit('saved', {});
  timers.advance(300);
  await flush();
  assert.equal(editor.dispatched.filter((d) => d.changes).length, 1);
});

test('reconcile = false leaves the text alone', async () => {
  const { es, editor, timers } = await setup({
    text: 'old',
    disk: 'new',
    userSettings: { 'extension.markeditNvim': { reconcile: false } },
  });
  es.emit('open', {});
  es.emit('saved', {});
  timers.advance(300);
  await flush();
  assert.equal(editor.doc, 'old');
});

test('losing the connection unlocks after the grace period', async () => {
  const { es, bridge, timers } = await setup();
  es.emit('hello', hello);
  es.emit('open', {});
  es.fail();
  assert.equal(bridge.status().locked, true, 'still locked right after the error');
  timers.advance(2900);
  assert.equal(bridge.status().locked, true);
  timers.advance(200);
  assert.equal(bridge.status().locked, false);
});

test('reconnecting in time keeps the lock', async () => {
  const { es, bridge, timers } = await setup();
  es.emit('hello', hello);
  es.emit('open', {});
  es.fail();
  timers.advance(1000);
  const next = FakeEventSource.last();
  assert.notEqual(next, es, 'a new connection is opened');
  next.emit('hello', hello);
  next.emit('open', {});
  timers.advance(10000);
  assert.equal(bridge.status().locked, true);
});

test('reconnection backs off up to a maximum', async () => {
  const { es, timers } = await setup();
  es.fail();
  const delays = [];
  let last = es;
  for (let i = 0; i < 8; i += 1) {
    const before = FakeEventSource.instances.length;
    for (let ms = 0; ms <= 40000 && FakeEventSource.instances.length === before; ms += 250) {
      timers.advance(250);
      if (FakeEventSource.instances.length > before) {
        delays.push(ms + 250);
      }
    }
    last = FakeEventSource.last();
    last.fail();
  }
  assert.ok(delays[0] <= 1250);
  assert.ok(delays[1] > delays[0]);
  assert.ok(Math.max(...delays) <= 30250);
});

test('a protocol mismatch stops the bridge and reports it', async () => {
  const { es, bridge, fetch, timers } = await setup();
  es.emit('hello', { protocol: 99, version: '9.9.9' });
  assert.equal(es.readyState, 2);
  assert.match(bridge.status().lastError, /protocol mismatch/);
  assert.equal(fetch.calls.some((c) => c.body.type === 'error'), true);
  timers.advance(60000);
  assert.equal(FakeEventSource.instances.length, 1, 'does not reconnect');
});

test('invalid event data is reported, not thrown', async () => {
  const { es, bridge } = await setup();
  es.emitRaw('cursor', '{not json');
  assert.match(bridge.status().lastError, /parse/);
});

test('the menu item pins the document unlocked and back', async () => {
  const { es, editor, bridge } = await setup();
  es.emit('open', {});
  assert.equal(bridge.status().locked, true);

  const item = editor.menuItems[0];
  assert.deepEqual(item.state(), { isSelected: true });
  item.action();
  assert.equal(bridge.status().locked, false);
  assert.deepEqual(item.state(), { isSelected: false });

  es.emit('open', {});
  assert.equal(bridge.status().locked, false, 'stays unlocked while pinned');

  item.action();
  assert.equal(bridge.status().locked, true, 'locks again when pinned back');
});

test('stop closes the connection and unlocks', async () => {
  const { es, bridge, timers } = await setup();
  es.emit('open', {});
  bridge.stop();
  assert.equal(es.readyState, 2);
  assert.equal(bridge.status().locked, false);
  timers.advance(60000);
  assert.equal(FakeEventSource.instances.length, 1);
});

test('debug mode reports what it does', async () => {
  const { es, fetch } = await setup({ userSettings: { 'extension.markeditNvim': { debug: true } } });
  es.emit('open', {});
  assert.ok(fetch.calls.some((c) => c.body.type === 'debug' && c.body.message === 'locked'));
});

test('without debug mode nothing but ready and errors is reported', async () => {
  const { es, fetch } = await setup();
  es.emit('hello', hello);
  es.emit('open', {});
  assert.deepEqual([...new Set(fetch.calls.map((c) => c.body.type))], ['ready']);
});
