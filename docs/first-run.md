# First run with the real MarkEdit

Everything in this repository is tested against a simulated MarkEdit. This list
checks the assumptions that only the real application can confirm. Each step says
what you should see, and what it means if you do not.

## Setup

1. In MarkEdit, install **MarkEdit-preview** (if you have not) and note the
   *Extensions → View Mode* menu.
2. Install this extension: `./scripts/install.sh`, or copy `src/markedit-nvim.js`
   to the `scripts` folder by hand (see the README).
3. Quit and reopen MarkEdit.
4. Add markedit.nvim to Neovim (see its README), or try it without touching your
   configuration: `nvim -c "set rtp+=$HOME/Developer/markedit.nvim | runtime plugin/markedit.lua" scratch.md`.

Use a scratch file with a few screens of text and a formula for the checks, for
example 80 lines with headings, a list and `$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$`.

## Checks

### 1. The webview can reach Neovim

In Neovim run `:MarkEditOpen`, then `:MarkEditStatus`.

- Expected: `connected viewers: 1` with the path of your file.
- Then `:MarkEditLog`. Expect three kinds of lines, in this order:
  1. `{"type":"loaded", ...}`: the script ran inside MarkEdit. If it is missing,
     MarkEdit did not load the file: check it is in the `scripts` folder and
     restart MarkEdit.
  2. `client ... connected`: the script reached the server.
  3. `{"type":"ready", ...}` with an `origin=` value. With MarkEdit 1.37.1 it is
     `http://localhost`, which markedit.nvim allows by default.
  An `{"type":"error", ...}` line says what failed.
- If `connected viewers: 0`: open MarkEdit's web inspector (right-click the
  editor → *Inspect Element*), look at the Console and the Network tab for a
  failed `events` request. A CSP or network restriction would show up there.
- If the log says `rejected request from origin ...`: the webview reports an
  `http(s)` origin that is not allowed. Add the value printed in the log to
  `allowed_origins` in `setup()` (it replaces the default list).

### 2. The editor is locked

- Expected: you cannot type or paste in the MarkEdit window.
- Menu *Extensions → Neovim: keep read-only* is checked.
- If you can type: in the inspector console run `markeditNvim.status()` and send
  me the output (`locked`, `lastError`). If `locked` is true but typing works,
  `EditorView.editable` is not enough and another mechanism is needed.

### 3. The cursor and the preview follow Neovim

Switch MarkEdit to **side-by-side**, then to **preview (overlay)** with
*Extensions → View Mode*, and move the cursor in Neovim with `j`, `G`, `gg`.

- Expected (side-by-side): the editor scrolls so the line is centered, and the
  preview scrolls with it.
- Expected (overlay): the preview scrolls to the same section.
- If the editor moves but the overlay does not: MarkEdit-preview ignores
  selection changes in that mode. That is the case to solve next (scrolling the
  preview element directly).
- If nothing moves: check `markeditNvim.status()` for `connected` and `following`.

### 4. Saved text reaches MarkEdit

Change a line in Neovim and leave insert mode (autosave writes the file).

- Expected: MarkEdit shows the new text within about a second.
- This tells us **which mechanism did it**. Set `"debug": true` in the extension
  settings (MarkEdit's `settings.json`, see the README), repeat the edit and run
  `:MarkEditLog` in Neovim:
  - a line `applied text from disk` means MarkEdit did **not** reload by itself
    and the extension did it;
  - no such line means MarkEdit reloaded the file natively.
- Then check the window title. If it shows *Edited* (or asks to save when you
  close the window) after the extension applied the text, the document got
  marked dirty. Tell me, this is the main risk of that mechanism.

### 5. Unlocking

- `:MarkEditClose` → you can type in MarkEdit again.
- `:MarkEditOpen`, then quit Neovim with `:qa` → MarkEdit unlocks.
- `:MarkEditOpen`, then kill Neovim (`kill` its process) → MarkEdit unlocks after
  about three seconds.

### 6. Formulas

Check that the long formula from the scratch file renders without overlapping.
This is the reason for using MarkEdit-preview and has nothing to do with the
bridge, but it is worth confirming once.

## What to report

For each step: what happened, the `markeditNvim.status()` output if something
failed, and the `:MarkEditLog` content. The unknowns that matter most are:

1. Can the webview open the event stream, and which origin does it report?
2. Does MarkEdit reload by itself, or did the extension have to apply the text?
3. Does the preview follow in overlay mode?
4. Is the document marked as edited after a refresh?
