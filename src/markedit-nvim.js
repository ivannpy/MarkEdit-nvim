/*
 * MarkEdit-nvim
 *
 * Follows a Neovim instance running markedit.nvim: moves the cursor to the
 * line you are editing, picks up the text you save and (optionally) keeps the
 * document read-only so you only edit in Neovim.
 *
 * Install by copying this file to MarkEdit's `scripts` folder, see README.md.
 * The wire protocol is described in docs/protocol.md.
 */
(function (root) {
  'use strict';

  const SETTINGS_KEY = 'extension.markeditNvim';
  // Checkpoints, after a save, used only in debug mode to time MarkEdit's own reload.
  const PROBES_MS = [250, 500, 1000];
  const PROTOCOL = 1;

  // Override any of these in MarkEdit's settings.json under
  // "extension.markeditNvim".
  const DEFAULTS = {
    // Where the markedit.nvim server listens. Must match its `host` and `port`.
    host: '127.0.0.1',
    port: 47821,
    // Shared secret, must match the `token` option of markedit.nvim (if any).
    token: null,
    // Make the document read-only while Neovim is following it.
    lock: true,
    // Unlock this many milliseconds after the connection to Neovim is lost, so
    // a closed Neovim never leaves the document stuck.
    unlockAfterMs: 3000,
    // Where the line Neovim is on goes: 'center', 'start', 'end' or 'nearest'.
    scroll: 'center',
    // MarkEdit reloads a saved file by itself. If it has not done so after
    // `reconcileDelayMs`, apply the text from disk. This is only a fallback:
    // changing the text marks the document as edited. Set to false to rely on
    // MarkEdit alone.
    reconcile: true,
    reconcileDelayMs: 2000,
    // Close the window when Neovim stops following the file (:MarkEditClose).
    closeOnDetach: false,
    // Report what happens to Neovim (:MarkEditLog) for troubleshooting.
    debug: false,
    // Reconnection delays, in milliseconds.
    reconnectMinMs: 1000,
    reconnectMaxMs: 30000,
  };

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function normalizeBreaks(text) {
    return text.replace(/\r\n?/g, '\n');
  }

  /**
   * Smallest single change that turns `from` into `to`, so the editor keeps
   * its scroll position and selection when the text is refreshed.
   */
  function diffRange(from, to) {
    let start = 0;
    const max = Math.min(from.length, to.length);
    while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) {
      start += 1;
    }

    let endFrom = from.length;
    let endTo = to.length;
    while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
      endFrom -= 1;
      endTo -= 1;
    }

    return { from: start, to: endFrom, insert: to.slice(start, endTo) };
  }

  /**
   * Creates the bridge. Everything it needs from the outside is injected, which
   * is what lets the tests run it without MarkEdit.
   */
  function createBridge(env) {
    const MarkEdit = env.MarkEdit;
    const EventSourceImpl = env.EventSource;
    const fetchImpl = env.fetch;
    const setTimer = env.setTimeout;
    const clearTimer = env.clearTimeout;

    const state = {
      settings: Object.assign({}, DEFAULTS),
      path: null,
      source: null,
      connected: false,
      following: false,
      locked: false,
      pinnedUnlocked: false,
      compartment: null,
      unlockTimer: null,
      reconnectTimer: null,
      reconcileTimers: [],
      backoff: 0,
      stopped: false,
      lastError: null,
    };

    function loadSettings() {
      const user = (MarkEdit.userSettings || {})[SETTINGS_KEY] || {};
      state.settings = Object.assign({}, DEFAULTS, user);
    }

    function baseUrl() {
      return 'http://' + state.settings.host + ':' + state.settings.port;
    }

    function eventsUrl() {
      let url = baseUrl() + '/events?v=' + PROTOCOL + '&path=' + encodeURIComponent(state.path);
      if (state.settings.token) {
        url += '&token=' + encodeURIComponent(state.settings.token);
      }
      return url;
    }

    // Diagnostics for :MarkEditLog. A text/plain body keeps this a "simple"
    // request, so the browser does not need a CORS preflight.
    function report(type, extra) {
      if (!fetchImpl) {
        return;
      }
      try {
        const body = JSON.stringify(Object.assign({ type: type, path: state.path }, extra || {}));
        const result = fetchImpl(baseUrl() + '/client', { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain' } });
        if (result && typeof result.catch === 'function') {
          result.catch(function () {});
        }
      } catch (error) {
        // The server may simply not be there, nothing to report to.
      }
    }

    function debug(message, extra) {
      if (state.settings.debug) {
        report('debug', Object.assign({ message: message }, extra || {}));
      }
    }

    function fail(where, error) {
      state.lastError = where + ': ' + (error && error.message ? error.message : String(error));
      report('error', { where: where, message: state.lastError });
    }

    // ----- read-only lock ---------------------------------------------------

    function lockExtensions() {
      const cm = MarkEdit.codemirror;
      return [cm.state.EditorState.readOnly.of(true), cm.view.EditorView.editable.of(false)];
    }

    function applyLock(locked) {
      if (!state.compartment || state.locked === locked) {
        return;
      }
      MarkEdit.editorView.dispatch({
        effects: state.compartment.reconfigure(locked ? lockExtensions() : []),
      });
      state.locked = locked;
      debug(locked ? 'locked' : 'unlocked');
    }

    function lock() {
      if (state.settings.lock && !state.pinnedUnlocked) {
        applyLock(true);
      }
    }

    function unlock() {
      applyLock(false);
    }

    function cancelUnlockTimer() {
      if (state.unlockTimer !== null) {
        clearTimer(state.unlockTimer);
        state.unlockTimer = null;
      }
    }

    function armUnlockTimer() {
      if (!state.locked || state.unlockTimer !== null) {
        return;
      }
      state.unlockTimer = setTimer(function () {
        state.unlockTimer = null;
        state.following = false;
        unlock();
      }, state.settings.unlockAfterMs);
    }

    // ----- cursor and text --------------------------------------------------

    function moveTo(line, col) {
      const api = MarkEdit.editorAPI;
      const count = api.getLineCount();
      if (count < 1) {
        return;
      }
      const row = clamp((Number(line) || 1) - 1, 0, count - 1);
      const range = api.getLineRange(row);
      const pos = clamp(range.from + Math.max(0, Number(col) || 0), range.from, range.to);
      const view = MarkEdit.codemirror.view;

      MarkEdit.editorView.dispatch({
        selection: { anchor: pos },
        effects: view.EditorView.scrollIntoView(pos, { y: state.settings.scroll }),
      });
    }

    // Compares the document with the file on disk.
    async function compare() {
      const disk = await MarkEdit.getFileContent();
      if (typeof disk !== 'string') {
        return null;
      }
      const current = MarkEdit.editorAPI.getText();
      return { disk: disk, current: current, same: normalizeBreaks(disk) === normalizeBreaks(current) };
    }

    function cancelReconcile() {
      state.reconcileTimers.forEach(clearTimer);
      state.reconcileTimers = [];
    }

    // The fallback: MarkEdit did not reload the file, so apply the text.
    async function applyFromDisk() {
      if (!state.following) {
        return;
      }
      const result = await compare();
      if (!result) {
        return;
      }
      if (result.same) {
        debug('in sync, nothing to apply');
        return;
      }
      const change = diffRange(result.current, result.disk);
      MarkEdit.editorView.dispatch({ changes: change });
      debug('applied text from disk', { from: change.from, to: change.to, inserted: change.insert.length });
    }

    // Debug only: measures how long MarkEdit takes to reload by itself.
    async function probe(elapsed) {
      const result = await compare();
      if (!result) {
        return;
      }
      if (result.same) {
        debug('in sync, MarkEdit reloaded by itself', { afterMs: elapsed });
        cancelReconcile();
      } else {
        debug('not in sync yet', { afterMs: elapsed });
      }
    }

    function later(ms, task, where) {
      state.reconcileTimers.push(
        setTimer(function () {
          task().catch(function (error) {
            fail(where, error);
          });
        }, ms)
      );
    }

    function scheduleReconcile() {
      cancelReconcile();
      const s = state.settings;
      if (s.debug) {
        PROBES_MS.filter(function (ms) {
          return ms < s.reconcileDelayMs;
        }).forEach(function (ms) {
          later(ms, function () {
            return probe(ms);
          }, 'probe');
        });
      }
      if (s.reconcile) {
        later(s.reconcileDelayMs, applyFromDisk, 'reconcile');
      }
    }

    // ----- events from Neovim -------------------------------------------------

    function parse(event) {
      // Built-in EventSource events (open, error) carry no data.
      if (event.data === undefined) {
        return null;
      }
      try {
        return JSON.parse(event.data);
      } catch (error) {
        fail('parse', error);
        return null;
      }
    }

    function guarded(where, handler) {
      return function (event) {
        try {
          const data = parse(event);
          if (data) {
            handler(data);
          }
        } catch (error) {
          fail(where, error);
        }
      };
    }

    const handlers = {
      hello: function (data) {
        if (data.protocol !== PROTOCOL) {
          fail('hello', new Error('protocol mismatch: server ' + data.protocol + ', extension ' + PROTOCOL));
          state.stopped = true;
          disconnect();
          return;
        }
        state.connected = true;
        state.backoff = 0;
        cancelUnlockTimer();
        report('ready', {
          server: data.version,
          lines: MarkEdit.editorAPI.getLineCount(),
          locked: state.locked,
          origin: typeof location !== 'undefined' ? location.origin : undefined,
        });
      },

      // Neovim started following this file.
      follow: function () {
        state.following = true;
        cancelUnlockTimer();
        lock();
      },

      cursor: function (data) {
        moveTo(data.line, data.col);
      },

      saved: function () {
        scheduleReconcile();
      },

      // Neovim stopped following this file.
      close: function () {
        state.following = false;
        cancelUnlockTimer();
        unlock();
        if (state.settings.closeOnDetach) {
          MarkEdit.closeDocument();
        }
      },

      // Neovim is quitting.
      bye: function () {
        state.following = false;
        unlock();
      },
    };

    // ----- connection ---------------------------------------------------------

    function disconnect() {
      if (state.reconnectTimer !== null) {
        clearTimer(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      if (state.source) {
        state.source.close();
        state.source = null;
      }
      state.connected = false;
    }

    function scheduleReconnect() {
      if (state.stopped || state.reconnectTimer !== null) {
        return;
      }
      const s = state.settings;
      state.backoff = state.backoff === 0 ? s.reconnectMinMs : Math.min(state.backoff * 2, s.reconnectMaxMs);
      state.reconnectTimer = setTimer(function () {
        state.reconnectTimer = null;
        connect();
      }, state.backoff);
    }

    function connect() {
      if (state.stopped || !state.path) {
        return;
      }
      const source = new EventSourceImpl(eventsUrl());
      state.source = source;

      Object.keys(handlers).forEach(function (name) {
        source.addEventListener(name, guarded(name, handlers[name]));
      });

      source.onerror = function () {
        // Reconnecting by hand gives us the backoff and handles the case where
        // the server refuses the connection (EventSource would give up).
        const wasFollowing = state.connected;
        if (state.source === source) {
          source.close();
          state.source = null;
        }
        state.connected = false;
        if (wasFollowing || state.locked) {
          armUnlockTimer();
        }
        scheduleReconnect();
      };
    }

    // ----- public -------------------------------------------------------------

    async function start() {
      loadSettings();
      const cm = MarkEdit.codemirror;
      state.compartment = new cm.state.Compartment();
      MarkEdit.addExtension(state.compartment.of([]));

      MarkEdit.addMainMenuItem({
        title: 'Neovim: keep read-only',
        action: function () {
          state.pinnedUnlocked = !state.pinnedUnlocked;
          if (state.pinnedUnlocked) {
            unlock();
          } else if (state.following) {
            lock();
          }
        },
        state: function () {
          return { isSelected: !state.pinnedUnlocked };
        },
      });

      const info = await MarkEdit.getFileInfo();
      if (!info || !info.filePath) {
        // Untitled document, there is nothing for Neovim to follow.
        return false;
      }
      state.path = info.filePath;
      connect();
      return true;
    }

    function stop() {
      state.stopped = true;
      cancelUnlockTimer();
      cancelReconcile();
      disconnect();
      unlock();
    }

    function status() {
      return {
        path: state.path,
        connected: state.connected,
        following: state.following,
        locked: state.locked,
        pinnedUnlocked: state.pinnedUnlocked,
        lastError: state.lastError,
        settings: state.settings,
      };
    }

    return { start: start, stop: stop, status: status, report: report, fail: fail, _state: state };
  }

  const api = { createBridge: createBridge, diffRange: diffRange, DEFAULTS: DEFAULTS, PROTOCOL: PROTOCOL };

  // MarkEdit runs every script inside a function that receives its own
  // `MarkEdit` (and `require`) as local variables. The global `MarkEdit` throws
  // "This API requires a script-local MarkEdit instance" for most of the API, so
  // the local one must be used. Outside MarkEdit (tests) there is no such
  // variable and the module is exported instead.
  const localMarkEdit = typeof MarkEdit !== 'undefined' ? MarkEdit : undefined;

  if (localMarkEdit === undefined) {
    if (typeof module !== 'undefined' && module.exports) {
      module.exports = api;
    }
    return;
  }

  const bridge = createBridge({
    MarkEdit: localMarkEdit,
    EventSource: root.EventSource,
    fetch: root.fetch ? root.fetch.bind(root) : undefined,
    setTimeout: root.setTimeout.bind(root),
    clearTimeout: root.clearTimeout.bind(root),
  });
  // Handy for debugging from the web inspector: markeditNvim.status()
  root.markeditNvim = bridge;

  // Tells Neovim the script ran at all (shows up in :MarkEditLog).
  bridge.report('loaded', {
    hasEventSource: typeof root.EventSource === 'function',
    hasFetch: typeof root.fetch === 'function',
    hasModule: typeof module !== 'undefined',
    hasRequire: typeof require === 'function',
  });

  let started = false;
  const begin = function () {
    if (started) {
      return;
    }
    started = true;
    bridge.start().catch(function (error) {
      bridge.fail('start', error);
      console.error('[MarkEdit-nvim]', error);
    });
  };
  localMarkEdit.onEditorReady(begin);
  // The editor may already be up when the script runs.
  let ready = false;
  try {
    ready = Boolean(localMarkEdit.editorView);
  } catch (error) {
    ready = false;
  }
  if (ready) {
    begin();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
