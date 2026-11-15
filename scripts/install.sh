#!/usr/bin/env bash
# Copies the extension into MarkEdit's scripts folder (or removes it with --uninstall).
set -euo pipefail

SCRIPTS="$HOME/Library/Containers/app.cyan.markedit/Data/Documents/scripts"
SRC="$(cd "$(dirname "$0")/.." && pwd)/src/markedit-nvim.js"
DEST="$SCRIPTS/markedit-nvim.js"

manual() {
  cat >&2 <<MSG

macOS did not let this terminal write into MarkEdit's container. Do it by hand:

  1. In MarkEdit, choose the "Open Documents Folder" item from the main menu.
  2. Open (or create) the "scripts" folder inside it.
  3. Copy this file there:
       $SRC
  4. Quit and reopen MarkEdit.

Or give your terminal "Full Disk Access" in System Settings > Privacy & Security
and run this script again.
MSG
  exit 1
}

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$DEST" 2>/dev/null || manual
  echo "Removed $DEST. Restart MarkEdit."
  exit 0
fi

[ -f "$SRC" ] || { echo "Cannot find $SRC" >&2; exit 1; }

mkdir -p "$SCRIPTS" 2>/dev/null || manual
cp "$SRC" "$DEST" 2>/dev/null || manual
echo "Installed $DEST"
echo "Quit and reopen MarkEdit so it loads the script."
