# git-info

Publishes Git/PR dashboard state, provides `/pr` for an explicit refresh, and `/lg` for the interactive local-changes viewer.

## Correct diff selection

- Tracked diffs and statistics use Git's literal-pathspec mode. Names such as `[id].tsx`, `*.txt`, and `:(glob)…` cannot select unrelated files.
- NUL-delimited status records retain both rename endpoints. Rename previews compare both paths against HEAD with rename detection explicitly enabled, even when `diff.renames` is disabled in user configuration.
- Statistics use NUL-delimited records and aggregate every returned record. Binary changes have unknown line totals rather than fabricated numeric counts.
- Repository discovery removes only Git's final newline, preserving directory names ending in spaces or containing newlines. Trailing spaces in patch lines are preserved; terminal control sequences are stripped before display.
- Both patch and statistics commands disable external diff drivers and text conversion. Probe/status/diff/statistics failures retain diagnostics instead of looking like clean or empty results. An unborn HEAD is confirmed through a missing symbolic branch reference, not inferred from a failed command. No-index exit 1 requires actual output, since missing-file errors can also return 1. Incomplete status/statistics records are rejected.

The comparison is **HEAD → current working tree**, combining staged and unstaged changes, not separate index/worktree panes. Untracked files and files in unborn repositories are compared against `/dev/null`. Git's rename detection remains heuristic: heavily rewritten renames may show a deletion plus an addition. Both endpoint paths are included, so recreating or modifying the old path can also appear in that rename's comparison.

## Viewer

At normal widths, files and the selected diff appear side by side. Below 60 columns, only the focused pane appears. Enter/Space/Right/`l` opens the diff; Escape/Left/`h` returns to files. Escape from files or Ctrl+C from either pane closes the viewer.

`j`/`k` or arrows navigate; `g`/`G` go to the beginning/end. Ctrl+D/U scroll half a page in the diff. Resize keeps the selected file visible and clamps diff scrolling. Empty/non-TUI viewers do not mount; disposed components ignore late input.

## Limits

Loading remains eager and cancellable through the command context signal. Each Git viewer command has a 10-second timeout; loading many files can take longer overall. Process capture is bounded at 10 Mi characters per stream, and each displayed patch at 20,000 lines. There is no full-diff spill file. Changes made during loading can invalidate the snapshot; rerun `/lg` if a file disappears or a command fails.

Dashboard polling remains every 3 seconds. PR data stays cached on the same branch until `/pr` forces a refresh; automatic TTL refresh and lazy diff loading are not implemented. GitHub network behavior is not covered by the isolated tests.

## Validation

```sh
npm run check
npm --prefix extensions/git-info run check
npm --prefix extensions/git-info test
```

Tests use temporary repositories, isolated Git configuration, or injected command/UI fixtures. They do not modify user repositories/settings or call GitHub/model services.
