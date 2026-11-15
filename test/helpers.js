'use strict';

// Test doubles for MarkEdit, EventSource and timers.

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.onerror = null;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name, fn) {
    (this.listeners[name] = this.listeners[name] || []).push(fn);
  }

  close() {
    this.readyState = 2;
  }

  // helpers for the tests
  emit(name, data) {
    for (const fn of this.listeners[name] || []) {
      fn({ data: JSON.stringify(data) });
    }
  }

  emitRaw(name, raw) {
    for (const fn of this.listeners[name] || []) {
      fn({ data: raw });
    }
  }

  fail() {
    if (this.onerror) {
      this.onerror(new Error('connection error'));
    }
  }

  static reset() {
    FakeEventSource.instances = [];
  }

  static last() {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }
}

class FakeTimers {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.pending = new Map();
  }

  setTimeout = (fn, ms) => {
    const id = this.nextId++;
    this.pending.set(id, { fn, at: this.now + ms });
    return id;
  };

  clearTimeout = (id) => {
    this.pending.delete(id);
  };

  advance(ms) {
    const target = this.now + ms;
    for (;;) {
      let nextId = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.pending) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === null) {
        break;
      }
      const timer = this.pending.get(nextId);
      this.pending.delete(nextId);
      this.now = timer.at;
      timer.fn();
    }
    this.now = target;
  }

  get count() {
    return this.pending.size;
  }
}

/** Lets promises scheduled by the code under test run. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Builds a fake `MarkEdit` global around a plain string document.
 */
function makeMarkEdit(options = {}) {
  const editor = {
    doc: options.text ?? 'line one\nline two\nline three',
    disk: options.disk ?? null,
    dispatched: [],
    extensions: [],
    menuItems: [],
    closed: 0,
  };
  if (editor.disk === null) {
    editor.disk = editor.doc;
  }

  const lineStarts = () => {
    const starts = [0];
    for (let i = 0; i < editor.doc.length; i += 1) {
      if (editor.doc[i] === '\n') {
        starts.push(i + 1);
      }
    }
    return starts;
  };

  class Compartment {
    of(extension) {
      return { compartment: this, extension };
    }

    reconfigure(extension) {
      return { reconfigure: extension, compartment: this };
    }
  }

  const MarkEdit = {
    userSettings: options.userSettings ?? {},
    editorAPI: {
      getText: () => editor.doc,
      getLineCount: () => lineStarts().length,
      getLineRange: (row) => {
        const starts = lineStarts();
        const from = starts[row];
        const to = row + 1 < starts.length ? starts[row + 1] - 1 : editor.doc.length;
        return { from, to };
      },
    },
    editorView: {
      dispatch: (spec) => {
        editor.dispatched.push(spec);
        if (spec.changes) {
          const { from, to, insert } = spec.changes;
          editor.doc = editor.doc.slice(0, from) + insert + editor.doc.slice(to);
        }
      },
    },
    codemirror: {
      state: {
        Compartment,
        EditorState: { readOnly: { of: (value) => ({ readOnly: value }) } },
      },
      view: {
        EditorView: {
          editable: { of: (value) => ({ editable: value }) },
          scrollIntoView: (pos, opts) => ({ scrollIntoView: pos, opts }),
        },
      },
    },
    addExtension: (extension) => editor.extensions.push(extension),
    addMainMenuItem: (item) => editor.menuItems.push(item),
    getFileInfo: async () => (options.untitled ? undefined : { filePath: options.path ?? '/tmp/notes/doc.md' }),
    getFileContent: async () => editor.disk,
    closeDocument: async () => {
      editor.closed += 1;
      return true;
    },
  };

  return { MarkEdit, editor };
}

/** Records the requests made through the injected `fetch`. */
function makeFetch() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? JSON.parse(init.body) : undefined });
    return {};
  };
  fetch.calls = calls;
  return fetch;
}

module.exports = { FakeEventSource, FakeTimers, flush, makeMarkEdit, makeFetch };
