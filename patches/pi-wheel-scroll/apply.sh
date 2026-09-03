#!/usr/bin/env bash
# Re-apply the pi fullscreen 5-line wheel-scroll patch after pi updates.
# See ../pi-wheel-scroll.md for details.
set -euo pipefail

TARGET="$(npm root -g)/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"
ANCHOR='return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {'
PATCHED="wheelScrollLines: 5, // PATCH: 5-line wheel scroll"

if [ ! -f "$TARGET" ]; then
    echo "ERROR: target not found: $TARGET" >&2
    exit 1
fi

if grep -qF "wheelScrollLines" "$TARGET"; then
    echo "Already patched (wheelScrollLines present) — nothing to do."
    exit 0
fi

if ! grep -qF "$ANCHOR" "$TARGET"; then
    echo "ERROR: anchor code not found — pi internals changed, patch manually." >&2
    exit 1
fi

BACKUP="${TARGET}.bak-wheel-scroll-$(date +%Y%m%d-%H%M%S)"
cp "$TARGET" "$BACKUP"

# Insert wheelScrollLines as the first key of the TuiAltScreen options object.
python3 - "$TARGET" "$ANCHOR" "$PATCHED" <<'EOF'
import sys
path, anchor, patched = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
assert src.count(anchor) == 1, "anchor not unique"
open(path, "w").write(src.replace(anchor, anchor + "\n            " + patched))
EOF

grep -nF "wheelScrollLines" "$TARGET"
echo "Patched. Backup: $BACKUP — restart pi to take effect."
