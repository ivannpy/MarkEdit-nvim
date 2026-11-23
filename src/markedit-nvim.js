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
  const SERVER_NAME = 'markedit.nvim';
  // How long a server has to say whether it follows the file.
  const PROBE_TIMEOUT_MS = 500;

  // Override any of these in MarkEdit's settings.json under
  // "extension.markeditNvim".
  const DEFAULTS = {
    // Where the markedit.nvim server listens. Must match its `host` and `port`.
    host: '127.0.0.1',
    port: 47821,
    // How many ports to look through, starting at `port`. Every Neovim takes the
    // first free one. Must match `port_count`; 1 means only `port`.
    portCount: 10,
    // While Neovim does not follow this file, how often to look again.
    rescanMs: 5000,
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
      // Port of the server `source` is connected to.
      port: null,
      connected: false,
      following: false,
      locked: false,
      pinnedUnlocked: false,
      compartment: null,
      unlockTimer: null,
      reconnectTimer: null,
      rescanTimer: null,
      scanId: 0,
      reconcileTimers: [],
      backoff: 0,
      stopped: false,
      lastError: null,
    };

    function loadSettings() {
      const user = (MarkEdit.userSettings || {})[SETTINGS_KEY] || {};
      state.settings = Object.assign({}, DEFAULTS, user);
    }

    function baseUrl(port) {
      return 'http://' + state.settings.host + ':' + port;
    }

    function portRange() {
      const first = Number(state.settings.port);
      const count = Math.max(1, Number(state.settings.portCount) || 1);
      const ports = [first];
      for (let port = first + 1; port < first + count && port <= 65535; port += 1) {
        ports.push(port);
      }
      return ports;
    }

    function endpointUrl(port, endpoint) {
      let url = baseUrl(port) + endpoint + '?v=' + PROTOCOL + '&path=' + encodeURIComponent(state.path);
      if (state.settings.token) {
        url += '&token=' + encodeURIComponent(state.settings.token);
      }
      return url;
    }

    // Diagnostics for :MarkEditLog. A text/plain body keeps this a "simple"
    // request, so the browser does not need a CORS preflight. Until a server is
    // chosen every possible one is told, whichever the user is looking at.
    function report(type, extra) {
      if (!fetchImpl) {
        return;
      }
      const body = JSON.stringify(Object.assign({ type: type, path: state.path }, extra || {}));
      const ports = state.port === null ? portRange() : [state.port];
      ports.forEach(function (port) {
        try {
          const result = fetchImpl(baseUrl(port) + '/client', { method: 'POST', body: body, headers: { 'Content-Type': 'text/plain' } });
          if (result && typeof result.catch === 'function') {
            result.catch(function () {});
          }
        } catch (error) {
          // The server may simply not be there, nothing to report to.
        }
      });
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
        scheduleRescan();
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
        // `hello` does not cancel a pending unlock, only `follow` does: this may
        // be another Neovim, one that does not follow the file.
        report('ready', {
          server: data.version,
          port: state.port,
          lines: MarkEdit.editorAPI.getLineCount(),
          locked: state.locked,
          origin: typeof location !== 'undefined' ? location.origin : undefined,
        });
      },

      // Neovim started following this file.
      follow: function () {
        state.following = true;
        cancelUnlockTimer();
        cancelRescan();
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
        // Another Neovim may be following it too.
        scheduleRescan();
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

    // Asks one server whether it follows the file. Resolves to null when there
    // is no markedit.nvim there (or it does not answer in time).
    function probePort(port) {
      return new Promise(function (resolve) {
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = setTimer(function () {
          if (controller) {
            controller.abort();
          }
          resolve(null);
        }, PROBE_TIMEOUT_MS);
        const done = function (result) {
          clearTimer(timer);
          resolve(result);
        };
        Promise.resolve()
          .then(function () {
            return fetchImpl(endpointUrl(port, '/tracks'), controller ? { signal: controller.signal } : {});
          })
          .then(function (response) {
            return response.ok ? response.json() : null;
          })
          .then(function (data) {
            done(data && data.server === SERVER_NAME ? { port: port, tracked: data.tracked === true } : null);
          })
          .catch(function () {
            done(null);
          });
      });
    }

    // Picks the server to connect to: the one that follows the file, else the one
    // already in use, else any that is running. If none answers, the first port is
    // still tried, so a failed search is never worse than not searching.
    async function findPort() {
      const ports = portRange();
      if (!fetchImpl || ports.length === 1) {
        return ports[0];
      }
      const servers = (await Promise.all(ports.map(probePort))).filter(Boolean);
      const tracking = servers.find(function (server) {
        return server.tracked;
      });
      if (tracking) {
        return tracking.port;
      }
      if (state.source) {
        return state.port;
      }
      return servers.length > 0 ? servers[0].port : ports[0];
    }

    function cancelRescan() {
      if (state.rescanTimer !== null) {
        clearTimer(state.rescanTimer);
        state.rescanTimer = null;
      }
    }

    // Connected to a Neovim that does not follow this file: another one may start
    // following it later.
    function scheduleRescan() {
      if (state.stopped || state.following || !state.source || state.rescanTimer !== null || portRange().length === 1) {
        return;
      }
      state.rescanTimer = setTimer(function () {
        state.rescanTimer = null;
        connect();
      }, state.settings.rescanMs);
    }

    // Looks for Neovim right now instead of waiting for the next attempt.
    function wake() {
      if (state.stopped || state.following || !state.path) {
        return;
      }
      cancelRescan();
      if (state.reconnectTimer !== null) {
        clearTimer(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      state.backoff = 0;
      connect();
    }

    function disconnect() {
      cancelRescan();
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

    async function connect() {
      if (state.stopped || !state.path) {
        return;
      }
      state.scanId += 1;
      const scanId = state.scanId;
      const port = await findPort();
      // Things may have changed during the search.
      if (state.stopped || scanId !== state.scanId || (state.source && state.following)) {
        return;
      }
      if (state.source && state.port === port) {
        scheduleRescan();
        return;
      }
      openSource(port);
    }

    function openSource(port) {
      disconnect();
      // The new server says so again with `follow` if it follows the file.
      state.following = false;
      const source = new EventSourceImpl(endpointUrl(port, '/events'));
      state.source = source;
      state.port = port;
      scheduleRescan();

      Object.keys(handlers).forEach(function (name) {
        source.addEventListener(name, guarded(name, handlers[name]));
      });

      source.onerror = function () {
        // Reconnecting by hand gives us the backoff and handles the case where
        // the server refuses the connection (EventSource would give up).
        if (state.source !== source) {
          return;
        }
        const wasFollowing = state.connected;
        cancelRescan();
        source.close();
        state.source = null;
        state.port = null;
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
      await connect();
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
        port: state.port,
        connected: state.connected,
        following: state.following,
        locked: state.locked,
        pinnedUnlocked: state.pinnedUnlocked,
        lastError: state.lastError,
        settings: state.settings,
      };
    }

    return { start: start, stop: stop, wake: wake, status: status, report: report, fail: fail, _state: state };
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

  // `:MarkEditOpen` brings the window to the front: look for that Neovim at once.
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('focus', bridge.wake);
  }

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
