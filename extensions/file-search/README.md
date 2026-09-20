# file-search

Registers `fd` (filename discovery) and `rg` (content search).

## Predictable search results

- Ripgrep runs with `--no-config`: `RIPGREP_CONFIG_PATH` cannot inject quiet mode, replacements, file listings, extra filters, or other behavior outside the tool parameters. Normal ignore-file handling is unchanged.
- Patterns follow `--`, so leading dashes are not options. Paths support the existing `@` prefix and `~` expansion.
- Genuine empty results remain “No files found” / “No matches found.” Search, setup, validation, timeout, and cancellation errors are not presented as empty results: the renderer honors Pi's error flag and shows the diagnostic even when collapsed.
- Results without extension-specific details display their text instead of inventing a match count. Errors without text get a generic failure label.
- Diagnostic/text-only previews show up to 3 source lines collapsed or 20 expanded, followed by an omitted-line count. Full tool-result text is unchanged.

## Existing limits and binary handling

System `fd`/`fdfind` and `rg` are preferred, then repository `bin/` fallbacks. If neither works, supported platforms download a checksum-verified official release; only a fresh download triggers an install notice.

Searches have a 60-second timeout. `fd` defaults to 1000 entries (maximum 10000); `rg` defaults to 100 matches per file (maximum 1000). Captured output is streamed to disk, with a 2000-line / 50KB preview. Truncated output includes its full-output file path. This file contains what the bounded search emitted, not results excluded by the binary's match limit or ignore rules.

## Validation

From the repository root:

```sh
npm run check
npm --prefix extensions/file-search run check
npm --prefix extensions/file-search test
```

Tests cover argument construction, binary resolution/download bounds, output capture, registered-tool execution/rendering, and real ripgrep with isolated configuration. Real-ripgrep tests explicitly skip when `rg` is unavailable; tests never download binaries or make model calls.
