'use strict';

// MarkEdit does not `require` the script. It runs the source inside a function
// that receives a script-local `MarkEdit` and `require`, while the global
// `MarkEdit` throws for most of the API. These tests load the real source that
// way, which is what caught the first version never connecting.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FakeEventSource, flush, makeMarkEdit, makeFetch } = require('./helpers.js');

const source = fs.readFileSync(path.join(__dirname, '../src/markedit-nvim.js'), 'utf8');

const throwingGlobal = () =>
  new Proxy(
    {},
    {
      get() {
        throw new Error('This API requires a script-local MarkEdit instance.');
      },
    }
  );

/** Runs the script the way MarkEdit does and returns what the test needs. */
function loadLikeMarkEdit(options = {}) {
  const { MarkEdit, editor } = makeMarkEdit(options);
  const readyCallbacks = [];
  MarkEdit.onEditorReady = (fn) => readyCallbacks.push(fn);
  if (options.editorNotReady) {
    delete MarkEdit.editorView;
  }
  if (options.localOverrides) {
    Object.assign(MarkEdit, options.localOverrides);
  }

  const fetch = makeFetch();
  const saved = {
    EventSource: globalThis.EventSource,
    fetch: globalThis.fetch,
    MarkEdit: globalThis.MarkEdit,
    markeditNvim: globalThis.markeditNvim,
  };
  FakeEventSource.reset();
  globalThis.EventSource = FakeEventSource;
  globalThis.fetch = fetch;
  globalThis.MarkEdit = throwingGlobal();

  const module = { exports: {} };
  let failure;
  try {
    const wrapper = new Function('MarkEdit', 'require', 'module', 'exports', source);
    wrapper(MarkEdit, () => ({}), module, module.exports);
  } catch (error) {
    failure = error;
  }

  const handle = globalThis.markeditNvim;
  const restore = () => {
    if (handle) {
      handle.stop();
    }
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete globalThis[key];
      } else {
        globalThis[key] = value;
      }
    }
  };

  if (failure) {
    restore();
    throw failure;
  }
  return { MarkEdit, editor, fetch, module, readyCallbacks, bridge: handle, restore };
}

test('runs inside MarkEdit even though `module` exists', async (t) => {
  const run = loadLikeMarkEdit();
  t.after(run.restore);
  assert.deepEqual(run.module.exports, {}, 'must not behave like a Node module');
  assert.ok(run.bridge, 'the bridge is created');
});

test('uses the script-local MarkEdit and never touches the global one', async (t) => {
  const run = loadLikeMarkEdit();
  t.after(run.restore);
  await flush();
  const es = FakeEventSource.last();
  assert.ok(es, 'connected to the server');
  assert.match(es.url, /\/events\?v=1&path=/);
  assert.equal(run.editor.menuItems.length, 1, 'registered its menu item on the local instance');
});

test('tells Neovim it was loaded', async (t) => {
  const run = loadLikeMarkEdit();
  t.after(run.restore);
  const loaded = run.fetch.calls.find((c) => c.body.type === 'loaded');
  assert.ok(loaded, 'a `loaded` diagnostic is sent');
  assert.equal(loaded.body.hasEventSource, true);
  assert.equal(loaded.body.hasFetch, true);
  assert.equal(loaded.body.hasModule, true);
});

test('starts only once when both the callback and the check fire', async (t) => {
  const run = loadLikeMarkEdit();
  t.after(run.restore);
  await flush();
  for (const fn of run.readyCallbacks) {
    fn();
  }
  await flush();
  assert.equal(FakeEventSource.instances.length, 1);
});

test('waits for onEditorReady when the editor is not up yet', async (t) => {
  const run = loadLikeMarkEdit({ editorNotReady: true });
  t.after(run.restore);
  await flush();
  assert.equal(FakeEventSource.instances.length, 0, 'does not start before the editor is ready');
  run.readyCallbacks.forEach((fn) => fn());
  await flush();
  assert.equal(FakeEventSource.instances.length, 1);
});

test('reports a failure to start instead of staying silent', async (t) => {
  const run = loadLikeMarkEdit({
    localOverrides: {
      getFileInfo: async () => {
        throw new Error('boom');
      },
    },
  });
  t.after(run.restore);
  await flush();
  const error = run.fetch.calls.find((c) => c.body.type === 'error');
  assert.ok(error, 'an error diagnostic is sent');
  assert.equal(error.body.where, 'start');
  assert.match(error.body.message, /boom/);
});
