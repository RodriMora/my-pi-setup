# pi fullscreen wheel-scroll = 5 lines

## What

pi's fullscreen TUI (`--tui-mode fullscreen`, which is the default in
`~/.pi/agent/settings.json`) scrolls the transcript **1 line** per mouse-wheel /
trackpad tick. This patch makes it scroll **5 lines** per tick by passing the
supported `wheelScrollLines: 5` option to `TuiAltScreen` (native option in
`@earendil-works/pi-tui`, `tui-alt-screen.js` reads
`options.wheelScrollLines ?? 1`; `createInteractiveTui` is the only caller and
doesn't forward it).

## Where — important: pi runs from the BUNDLE

pi v0.84.x executes `dist/bundle/cli.js`, which imports everything from
`dist/bundle/chunks/chunk-OMWWHBTG.js` (minified, with its own inlined copy of
`createInteractiveTui` and the whole TUI). **`dist/modes/**` files are dead
code at runtime** — patching only those silently does nothing (this bit us on
2026-09-03). Two sites get patched:

1. `dist/bundle/chunks/chunk-OMWWHBTG.js` (minified anchor) — authoritative
2. `dist/modes/interactive/interactive-mode.js` (readable anchor) — consistency

## Why a patch instead of a setting

`wheelScrollLines` is not exposed as a setting or keybinding in pi
(as of v0.84.4). **pi updates wipe both files** — the original patch
(2026-08-19) was lost in the 2026-08-31 update to v0.84.4, and the first
re-apply (2026-09-03) hit only the dead `dist/modes` file before we noticed.

## Restore / apply

```sh
~/.pi/agent/my-pi-setup/patches/pi-wheel-scroll/apply.sh
```

Idempotent: backs up each target as `.bak-wheel-scroll-<ts>` once, skips if
already patched, fails loudly if the anchors have drifted. Then restart pi for
it to take effect. Verify with:

```sh
grep -c wheelScrollLines "$(npm root -g)/@earendil-works/pi-coding-agent/dist/bundle/chunks/chunk-OMWWHBTG.js"
```
