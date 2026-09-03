# pi fullscreen wheel-scroll = 5 lines

## What

pi's fullscreen TUI (`--tui-mode fullscreen`, which is the default in
`~/.pi/agent/settings.json`) scrolls the transcript **1 line** per mouse-wheel /
trackpad tick. This patch makes it scroll **5 lines** per tick by passing the
supported `wheelScrollLines: 5` option to `TuiAltScreen`.

## Where

File: `$(npm root -g)/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js`

Inside `createInteractiveTui(options)`, the fullscreen branch constructs:

```js
return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
```

Add `wheelScrollLines: 5` as the first key of that options object:

```js
return new TuiAltScreen(terminal, options.showHardwareCursor, options.logDirectory, {
    wheelScrollLines: 5, // PATCH: 5-line wheel scroll ...
    searchMatchStyle: (text) => theme.underline(styleSearchMatch(text)),
    ...
});
```

(The option itself is native to `@earendil-works/pi-tui`:
`tui-alt-screen.js` reads `options.wheelScrollLines ?? 1` in the
`TuiAltScreen` constructor. Only the agent package needs patching, since
`interactive-mode.js` is the only caller and doesn't forward it.)

## Why a patch instead of a setting

`wheelScrollLines` is not exposed as a setting or keybinding in pi
(as of v0.84.4), so dist-file patching is the only way. **pi updates wipe
this** — the original patch (2026-08-19) was lost when pi was updated to
v0.84.4 on 2026-08-31. Re-run `apply.sh` after every `pi` update.

## Restore / apply

```sh
~/.pi/agent/my-pi-setup/patches/pi-wheel-scroll/apply.sh
```

`apply.sh` is idempotent: it backs up the original as
`tui-alt-screen`-style `.bak-wheel-scroll-<ts>` once, skips if the patch is
already applied, and fails loudly if the target code has drifted. Then restart
pi (or `/reload`) for it to take effect.
