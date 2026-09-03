#!/usr/bin/env bash
# Re-apply the pi fullscreen 5-line wheel-scroll patch after pi updates.
# See ../pi-wheel-scroll.md for details.
#
# pi v0.84.x runs from the BUNDLED build:
#   dist/bundle/chunks/chunk-OMWWHBTG.js   <- authoritative runtime
#   dist/modes/interactive/interactive-mode.js <- also patched for consistency
# Both must be re-patched after every pi update.
set -euo pipefail

ROOT="$(npm root -g)/@earendil-works/pi-coding-agent/dist"
TARGETS=(
    "$ROOT/bundle/chunks/chunk-OMWWHBTG.js"
    "$ROOT/modes/interactive/interactive-mode.js"
)

MIN_ANCHOR='new TuiAltScreen(terminal,options.showHardwareCursor,options.logDirectory,{'
MIN_PATCH='new TuiAltScreen(terminal,options.showHardwareCursor,options.logDirectory,{wheelScrollLines:5,'
SRC_ANCHOR='return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {'
SRC_PATCH='return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
            wheelScrollLines: 5, // PATCH: 5-line wheel scroll'

rc=0
for target in "${TARGETS[@]}"; do
    echo "--- $target"
    if [ ! -f "$target" ]; then
        echo "MISSING — pi layout changed, patch manually."
        rc=1
        continue
    fi
    if grep -qF "wheelScrollLines" "$target"; then
        echo "already patched"
        continue
    fi
    if grep -qF "$MIN_ANCHOR" "$target"; then
        cp "$target" "$target.bak-wheel-scroll-$(date +%Y%m%d-%H%M%S)"
        python3 - "$target" "$MIN_ANCHOR" "$MIN_PATCH" <<'EOF'
import sys
path, anchor, patched = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
assert src.count(anchor) == 1, "anchor not unique"
open(path, "w").write(src.replace(anchor, patched))
EOF
    elif grep -qF "$SRC_ANCHOR" "$target"; then
        cp "$target" "$target.bak-wheel-scroll-$(date +%Y%m%d-%H%M%S)"
        python3 - "$target" "$SRC_ANCHOR" "$SRC_PATCH" <<'EOF'
import sys
path, anchor, patched = sys.argv[1], sys.argv[2], sys.argv[3]
src = open(path).read()
assert src.count(anchor) == 1, "anchor not unique"
open(path, "w").write(src.replace(anchor, patched))
EOF
    else
        echo "ERROR: no known anchor found — pi internals changed, patch manually."
        rc=1
        continue
    fi
    grep -oF "wheelScrollLines" "$target" | head -1 >/dev/null && echo "patched"
done

exit $rc
