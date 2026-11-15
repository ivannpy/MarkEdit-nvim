# MarkEdit-nvim

A [MarkEdit](https://github.com/MarkEdit-app/MarkEdit) extension that follows a
Neovim instance running [markedit.nvim](../markedit.nvim).

You edit in Neovim; MarkEdit shows the rendered result:

- **Follows your cursor.** The editor cursor in MarkEdit moves to the line you
  are on in Neovim. With
  [MarkEdit-preview](https://github.com/MarkEdit-app/MarkEdit-preview), the
  preview scrolls along (it follows the editor selection).
- **Picks up your changes.** When Neovim saves the file, the document is
  refreshed.
- **View only.** While Neovim follows a document, MarkEdit keeps it read-only
  so you never edit the same file in two places. It unlocks by itself when Neovim
  closes, stops following the file or disconnects.

> **Status: experimental (0.1.0).** It is tested against the real plugin with a
> simulated MarkEdit, and has not been run inside the real MarkEdit yet. Follow
> [docs/first-run.md](docs/first-run.md) to check each assumption and report what
> differs.

## Requirements

- MarkEdit 1.37 or newer (written against `markedit-api` 0.39).
- [markedit.nvim](../markedit.nvim) in Neovim.
- Recommended: MarkEdit-preview, for the rendered view.

## Installation

The extension is one file with no dependencies: `src/markedit-nvim.js`.

```sh
./scripts/install.sh
```

The script copies it to MarkEdit's scripts folder:

```
~/Library/Containers/app.cyan.markedit/Data/Documents/scripts/markedit-nvim.js
```

macOS protects that folder, so the script can fail with *Operation not
permitted* when run from a terminal. If so, it prints the manual steps: open the
folder from MarkEdit's main menu (*Open Documents Folder*), put the file in
`scripts/`, and restart MarkEdit. Giving the terminal *Full Disk Access* also works.

To remove it: `./scripts/install.sh --uninstall`.

## Usage

1. Open a Markdown file in Neovim and run `:MarkEditOpen` (see markedit.nvim).
2. MarkEdit opens the file in the background. Switch it to the preview mode of
   MarkEdit-preview (*Extensions → View Mode*).
3. Edit in Neovim. MarkEdit follows.

The *Extensions* menu of MarkEdit gets an item, **Neovim: keep read-only**. It is
checked by default. Unchecking it lets you edit in MarkEdit until you check it
again (useful if something goes wrong).

## Settings

Optional. Add a node to MarkEdit's `settings.json`
(`~/Library/Containers/app.cyan.markedit/Data/Documents/settings.json`):

```json
{
  "extension.markeditNvim": {
    "port": 47821,
    "lock": true
  }
}
```

MarkEdit validates this file strictly: an invalid value invalidates the whole
file, so double-check the JSON.

| Setting | Default | Meaning |
| --- | --- | --- |
| `host` | `"127.0.0.1"` | Where the plugin listens. Must match the plugin. |
| `port` | `47821` | Same. |
| `token` | `null` | Shared secret, must match the plugin's `token`. |
| `lock` | `true` | Make the document read-only while Neovim follows it. |
| `unlockAfterMs` | `3000` | Unlock this long after the connection is lost. |
| `scroll` | `"center"` | Where the cursor line goes: `center`, `start`, `end` or `nearest`. |
| `reconcile` | `true` | Apply the text from disk if MarkEdit did not reload it. |
| `reconcileDelayMs` | `250` | Wait this long after a save before checking. |
| `closeOnDetach` | `false` | Close the window when Neovim stops following the file. |
| `debug` | `false` | Report what the extension does to Neovim (`:MarkEditLog`). |
| `reconnectMinMs`, `reconnectMaxMs` | `1000`, `30000` | Reconnection backoff. |

## Troubleshooting

- Nothing happens: in Neovim run `:MarkEditStatus`. `connected viewers: 0` means
  the extension is not loaded (restart MarkEdit after installing) or cannot
  reach the port.
- The web inspector helps: right-click the editor → *Inspect Element* (or
  ⌥⌘I). In the console, `markeditNvim.status()` prints the state of the
  extension, including the last error.
- Set `"debug": true` and read `:MarkEditLog` in Neovim.
- The document stays read-only after Neovim is gone: wait three seconds, or
  uncheck *Neovim: keep read-only* in the Extensions menu.

## How it works

The extension opens an event stream (`EventSource`) to the plugin for the file of
each window and reacts to the events described in
[docs/protocol.md](docs/protocol.md): `open` locks the editor, `cursor` moves the
selection and scrolls, `saved` refreshes the text, `close` and `bye` unlock.

Locking uses a CodeMirror compartment with `EditorState.readOnly` and
`EditorView.editable` set to false, both exposed through `MarkEdit.codemirror`.
Moving the cursor dispatches a selection with `scrollIntoView`; MarkEdit-preview
listens to selection changes and scrolls the preview. Refreshing the text
dispatches the smallest change between the open text and the file, so the scroll
position and selection survive.

## Development

```sh
npm test    # or: node --test "test/**/*.test.js"
```

- `test/bridge.test.js`: unit tests with a simulated MarkEdit, EventSource and timers.
- `test/e2e/`: starts a real headless Neovim with markedit.nvim and runs the
  extension against it. It looks for the plugin at `../markedit.nvim`, or at
  `$MARKEDIT_NVIM_PLUGIN`, and is skipped if it is not found.

No build step: `src/markedit-nvim.js` is what MarkEdit loads.

## License

MIT
