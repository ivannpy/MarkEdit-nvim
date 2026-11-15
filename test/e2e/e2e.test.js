'use strict';

// End-to-end: a real headless Neovim running markedit.nvim talks to the real
// extension code (only MarkEdit itself is simulated).
//
// Needs the plugin checkout, by default ../markedit.nvim next to this repo, or
// set MARKEDIT_NVIM_PLUGIN. The test is skipped when it cannot be found.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

const { createBridge } = require('../../src/markedit-nvim.js');
const { SseClient } = require('../sse-client.js');
const { makeMarkEdit } = require('../helpers.js');

const plugin = process.env.MARKEDIT_NVIM_PLUGIN || path.resolve(__dirname, '../../../markedit.nvim');
const nvim = process.env.NVIM || 'nvim';

function hasNvim() {
  try {
    execFileSync(nvim, ['--version'], { stdio: 'ignore' });
    return true;
  } catch (error) {
    return false;
  }
}

const skip = !fs.existsSync(path.join(plugin, 'lua/markedit/init.lua')) || !hasNvim();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, what, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for ' + what);
    }
    await sleep(20);
  }
}

test('Neovim and the extension work together', { skip, timeout: 30000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkedit-e2e-'));
  const doc = path.join(dir, 'doc.md');
  const portFile = path.join(dir, 'port');
  const socket = path.join(dir, 'nvim.sock');
  fs.writeFileSync(doc, 'one\ntwo\nthree\nfour\n');
  const port = await freePort();

  const child = spawn(
    nvim,
    ['--headless', '-u', 'NONE', '--listen', socket, '-c', `luafile ${path.resolve(__dirname, 'start.lua')}`],
    {
      env: { ...process.env, MARKEDIT_NVIM_PLUGIN: plugin, E2E_DOC: doc, E2E_PORTFILE: portFile, E2E_PORT: String(port) },
      stdio: 'ignore',
    }
  );
  t.after(() => child.kill());

  const lua = (code) =>
    execFileSync(nvim, ['--server', socket, '--remote-expr', `execute("lua ${code}")`], { encoding: 'utf8' });
  const luaValue = (code) =>
    execFileSync(nvim, ['--server', socket, '--remote-expr', `luaeval("${code}")`], { encoding: 'utf8' }).trim();

  await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim(), 'Neovim to start');

  // A fake MarkEdit whose document is the real file, read from disk on demand.
  const { MarkEdit, editor } = makeMarkEdit({
    path: doc,
    text: fs.readFileSync(doc, 'utf8').replace(/\n$/, ''),
    userSettings: { 'extension.markeditNvim': { port, reconcileDelayMs: 50, unlockAfterMs: 300 } },
  });
  MarkEdit.getFileContent = async () => fs.readFileSync(doc, 'utf8').replace(/\n$/, '');

  const bridge = createBridge({
    MarkEdit,
    EventSource: SseClient,
    fetch,
    setTimeout,
    clearTimeout,
  });
  t.after(() => bridge.stop());
  assert.equal(await bridge.start(), true);

  await t.test('locks the document and receives the initial cursor', async () => {
    await until(() => bridge.status().locked, 'the document to lock');
    const last = await until(() => editor.dispatched.find((d) => d.selection), 'the first cursor event');
    assert.deepEqual(last.selection, { anchor: 0 });
  });

  await t.test('follows the cursor', async () => {
    lua('vim.api.nvim_win_set_cursor(0, {3, 2}); vim.api.nvim_exec_autocmds(\'CursorMoved\', {})');
    // "one\ntwo\n" is 8 characters, so line 3 column 2 is position 10
    await until(() => editor.dispatched.some((d) => d.selection && d.selection.anchor === 10), 'the cursor to arrive');
  });

  await t.test('picks up text saved from Neovim', async () => {
    lua("vim.api.nvim_buf_set_lines(0, 0, 1, false, {'ONE changed'}); vim.cmd('silent write')");
    await until(() => editor.doc.startsWith('ONE changed'), 'the new text to arrive');
    assert.equal(editor.doc, fs.readFileSync(doc, 'utf8').replace(/\n$/, ''));
  });

  await t.test('reports the connection to Neovim', async () => {
    const clients = await until(() => Number(luaValue("#require('markedit').status().clients")) > 0, 'the client list');
    assert.ok(clients);
    const log = luaValue("table.concat(require('markedit.log').lines(), ' | ')");
    assert.match(log, /"type":"ready"/);
  });

  await t.test('unlocks when Neovim stops following the file', async () => {
    lua("require('markedit').close()");
    await until(() => !bridge.status().locked, 'the document to unlock');
  });

  await t.test('locks again when Neovim follows the file again', async () => {
    // the server stopped with the last tracked file; the bridge reconnects by itself
    lua("require('markedit').open()");
    await until(() => bridge.status().locked, 'the document to lock again', 8000);
  });

  await t.test('unlocks when Neovim quits', async () => {
    try {
      lua("vim.cmd('qa!')");
    } catch (error) {
      // Neovim exits while answering, so the remote call is cut off.
    }
    await until(() => !bridge.status().locked, 'the document to unlock after quitting', 8000);
  });
});
