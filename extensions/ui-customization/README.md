# ui-customization

TUI-only gradient header, two-line model/Git dashboard, extension status rows,
and five-line fullscreen wheel scrolling. Dashboard data comes from the shared
model-info/git-info event channels; this extension makes no model calls and
writes no settings or session files.

## Safe theme-list hiding

Pi currently has no public API for hiding only the startup `[Themes]` listing.
The isolated `src/theme-section.ts` compatibility shim supports the component
layout verified in Pi 0.84.1 and 0.85.1 (regular and fullscreen):

- The first root component is a document with exactly three containers:
  header, loaded resources, and transcript.
- The header must directly contain **this extension's exact header object**.
- Only immediate leaf Text/Spacer children of the resource container are
  inspected. Exactly one expandable Text section headed `[Themes]` and its
  following Spacer may be removed. Other sections and diagnostics remain.
- The transcript is never searched or speculatively rendered. Unknown layouts,
  nested resource components, ambiguous matches, or incompatible classes leave
  the listing visible rather than guessing. Themes remain loaded/selectable.

Removal is best-effort, with attempts at 0, 50, 250 and 1000 ms after header
installation or resource discovery. Success cancels the remaining attempts;
resources loading beyond the retry window may leave the listing visible.
Header replacement and shutdown cancel pending attempts. Generation and
permanent shutdown guards prevent obsolete callbacks from restarting work.

## Lifecycle and compatibility

Shutdown unsubscribes dashboard listeners, restores the wheel setting where
still owned, and restores the default header/footer only if these components
have not already been replaced by another extension. Disposed components and
late callbacks do not reactivate the extension. Reload creates a fresh instance.

`src/fullscreen-scroll.ts` is also an unsupported compatibility shim. It checks
for Pi's writable wheel-scroll field and identifies renderer replacements via
their children-array identity. If upstream hides/freezes the field it does
nothing; cleanup does not overwrite another actor's subsequent change.
Neither shim patches Pi's installed files. Prefer supported APIs if Pi adds them.

## Tests

From the repository root:

```sh
npm run check
./node_modules/.bin/vitest run extensions/ui-customization/*.test.ts
```

Tests use component fixtures and controlled timers without changing user
settings. Installed Pi 0.85.1 compatibility is additionally checked using an
isolated PTY, a temporary agent directory and synthetic resumed conversation,
including actual `/reload`, regular/fullscreen modes and future transcript output.
