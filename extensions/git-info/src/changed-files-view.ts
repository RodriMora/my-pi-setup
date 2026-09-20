import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { runCommand, type CommandResult } from "./process.ts";

const DIFF_SCROLL_STEP = 5;
const MAX_DIFF_LINES = 20_000;
// Strip terminal control sequences from repository-controlled paths and diff
// text before applying trusted theme styling.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export function sanitizeTerminalText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

interface ChangedPath {
  path: string;
  status: string;
  sourcePath?: string;
}

export interface ChangedFile {
  additions: number | null;
  deletions: number | null;
  diff: string[];
  name: string;
  path: string;
}

function parseChangedPaths(output: string) {
  if (output && !output.endsWith("\0")) {
    throw new Error("Invalid or truncated git status output.");
  }
  const records = output.split("\0");
  const paths: ChangedPath[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("Invalid git status record.");
    }

    const status = record.slice(0, 2);
    const path = record.slice(3);
    // Porcelain v1 -z puts the destination first, then the source. Both
    // endpoints are needed to compare a rename against HEAD.
    const sourcePath =
      status.includes("R") || status.includes("C")
        ? records[++index]
        : undefined;
    if ((status.includes("R") || status.includes("C")) && !sourcePath) {
      throw new Error("Missing rename source in git status output.");
    }
    paths.push({ path, status, sourcePath });
  }

  return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
}

function parseNumstat(output: string) {
  if (output && !output.endsWith("\0")) {
    throw new Error("Invalid or truncated git numstat output.");
  }
  let additions = 0;
  let deletions = 0;
  let binary = false;
  const records = output.split("\0");
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!match) throw new Error("Invalid or truncated git numstat output.");
    binary ||= match[1] === "-" || match[2] === "-";
    if (match[1] !== "-") additions += Number(match[1]);
    if (match[2] !== "-") deletions += Number(match[2]);
    // With -z, a rename has an empty pathname here and two following records.
    if (record.length === match[0].length) {
      if (!records[index + 1] || !records[index + 2]) {
        throw new Error("Missing rename paths in git numstat output.");
      }
      index += 2;
    }
  }
  return {
    additions: binary ? null : additions,
    deletions: binary ? null : deletions,
  };
}

function requireSuccess(
  result: CommandResult,
  operation: string,
  noIndex = false,
) {
  // --no-index uses exit 1 for differences AND some errors (e.g. a missing
  // file). With --no-quiet, a real difference produces patch/stat output.
  if (result.code === 0 || (noIndex && result.code === 1 && result.stdout)) return;
  const detail = result.stderr.trim() ||
    (result.code === -1 ? "command timed out" : `exit code ${result.code}`);
  throw new Error(sanitizeTerminalText(`${operation}: ${detail}`));
}

function cleanDisplayPath(path: string) {
  return sanitizeTerminalText(path).replace(/[\r\n\t]/g, " ");
}

const run = (cwd: string, args: string[]) =>
  runCommand("git", args, cwd, 10_000);

const loadFile = Effect.fn("git-info.loadFile")(function* (
  repoRoot: string,
  changedPath: ChangedPath,
  hasHead: boolean,
) {
  const useNoIndex = changedPath.status === "??" || !hasHead;
  const endpoints = changedPath.sourcePath
    ? [changedPath.sourcePath, changedPath.path]
    : [changedPath.path];
  // `--` only stops option parsing. Git pathspec magic must be disabled too.
  // Disable user diff drivers/textconv for both the patch and its statistics.
  const common = [
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-exit-code",
    "--no-quiet",
  ];
  const comparison = useNoIndex
    ? ["--no-index", "--", "/dev/null", changedPath.path]
    : ["--find-renames", "HEAD", "--", ...endpoints];
  const diffArguments = [...common, "--unified=3", ...comparison];
  const statArguments = [...common, "--numstat", "-z", ...comparison];
  const [diffResult, statResult] = yield* Effect.all(
    [run(repoRoot, diffArguments), run(repoRoot, statArguments)],
    { concurrency: "unbounded" },
  );
  requireSuccess(
    diffResult, `Cannot load diff for ${changedPath.path}`, useNoIndex,
  );
  requireSuccess(
    statResult, `Cannot load statistics for ${changedPath.path}`, useNoIndex,
  );
  const stats = parseNumstat(statResult.stdout);
  const allDiffLines = diffResult.stdout
    .replace(/\n$/, "")
    .split("\n")
    .map(sanitizeTerminalText);
  const diff =
    allDiffLines.length > MAX_DIFF_LINES
      ? [
          ...allDiffLines.slice(0, MAX_DIFF_LINES),
          `… diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines …`,
        ]
      : allDiffLines;

  return {
    ...stats,
    diff:
      diff.length === 1 && diff[0] === ""
        ? ["No textual diff available."]
        : diff,
    name: cleanDisplayPath(basename(changedPath.path)),
    path: cleanDisplayPath(changedPath.path),
  } satisfies ChangedFile;
});

export const loadChangedFiles = Effect.fn("git-info.loadChangedFiles")(
  function* (cwd: string) {
    const rootResult = yield* run(cwd, ["rev-parse", "--show-toplevel"]);
    if (rootResult.code !== 0) {
      // Only a positively identified non-repository is an empty discovery.
      // Unknown/localized diagnostics are surfaced rather than guessed away.
      if (rootResult.code === 128 && /^fatal: not a git repository(?:[ (:]|$)/im.test(rootResult.stderr)) {
        return null;
      }
      requireSuccess(rootResult, "Cannot locate git repository");
    }

    // Remove the protocol newline only: spaces (and embedded/newline suffixes)
    // can be legitimate characters in the repository directory name.
    const repoRoot = rootResult.stdout.replace(/\n$/, "");
    const [statusResult, headResult] = yield* Effect.all(
      [
        run(repoRoot, [
          "status",
          "--porcelain=v1",
          "--renames",
          "-z",
          "--untracked-files=all",
        ]),
        run(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]),
      ],
      { concurrency: "unbounded" },
    );
    requireSuccess(statusResult, "Cannot load git status");
    const hasHead = headResult.code === 0;
    if (!hasHead) {
      if (headResult.code !== 1 || headResult.stderr.trim()) {
        requireSuccess(headResult, "Cannot resolve git HEAD");
      }
      // Quiet rev-parse returning 1 is not enough: prove HEAD names a branch
      // whose ref does not yet exist, rather than swallowing a broken probe.
      const symbolic = yield* run(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]);
      requireSuccess(symbolic, "Cannot resolve symbolic git HEAD");
      const ref = yield* run(repoRoot, [
        "show-ref", "--verify", "--quiet", symbolic.stdout.replace(/\n$/, ""),
      ]);
      if (ref.code !== 1 || ref.stderr.trim()) {
        requireSuccess(ref, "Cannot inspect git HEAD reference");
        throw new Error("Cannot resolve git HEAD despite an existing branch reference.");
      }
    }

    const changedPaths = parseChangedPaths(statusResult.stdout);
    const files: ChangedFile[] = [];
    for (const changedPath of changedPaths) {
      files.push(yield* loadFile(repoRoot, changedPath, hasHead));
    }

    return files;
  },
);

function padToWidth(text: string, width: number) {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

export async function showChangedFiles(
  ctx: ExtensionContext,
  files: ChangedFile[],
) {
  if (ctx.mode !== "tui" || files.length === 0) return;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let focus: "files" | "diff" = "files";
      let selectedIndex = 0;
      let sidebarOffset = 0;
      let diffOffset = 0;
      let closed = false;

      function totalHeight() {
        const rows = Math.max(0, Math.floor(tui.terminal.rows));
        return Math.min(Math.floor(rows * 0.8), Math.max(0, rows - 2));
      }

      function bodyHeight() {
        return Math.max(0, totalHeight() - 2);
      }

      function ensureSelectedFileVisible() {
        const visibleFiles = Math.max(1, Math.floor(bodyHeight() / 2));
        if (selectedIndex < sidebarOffset) sidebarOffset = selectedIndex;
        if (selectedIndex >= sidebarOffset + visibleFiles) {
          sidebarOffset = selectedIndex - visibleFiles + 1;
        }
      }

      function moveFile(amount: number) {
        selectedIndex = (selectedIndex + amount + files.length) % files.length;
        diffOffset = 0;
        ensureSelectedFileVisible();
        tui.requestRender();
      }

      function moveDiff(amount: number) {
        const maxOffset = Math.max(
          0,
          files[selectedIndex]!.diff.length - bodyHeight(),
        );
        diffOffset = Math.max(0, Math.min(maxOffset, diffOffset + amount));
        tui.requestRender();
      }

      function styleDiffLine(line: string) {
        const expanded = line.replaceAll("\t", "    ");
        if (
          expanded.startsWith("diff --git") ||
          expanded.startsWith("index ")
        ) {
          return theme.fg("accent", theme.bold(expanded));
        }
        if (expanded.startsWith("@@")) return theme.fg("mdHeading", expanded);
        if (expanded.startsWith("---") || expanded.startsWith("+++")) {
          return theme.fg("muted", expanded);
        }
        if (expanded.startsWith("+")) return theme.fg("success", expanded);
        if (expanded.startsWith("-")) return theme.fg("error", expanded);
        if (expanded.startsWith("…")) return theme.fg("warning", expanded);
        return theme.fg("text", expanded);
      }

      function border(width: number, label: string, top: boolean) {
        const left = top ? "┌" : "└";
        const right = top ? "┐" : "┘";
        const text = `─ ${label} `;
        const remaining = Math.max(0, width - visibleWidth(text) - 2);
        return theme.fg(
          "borderAccent",
          truncateToWidth(
            `${left}${text}${"─".repeat(remaining)}${right}`,
            width,
            "",
          ),
        );
      }

      function handleInput(data: string) {
        if (closed) return;
        if (matchesKey(data, Key.ctrl("c"))) {
          closed = true;
          done(undefined);
          return;
        }
        if (focus === "files") {
          if (matchesKey(data, Key.escape)) {
            closed = true;
            done(undefined);
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            moveFile(1);
            return;
          }
          if (matchesKey(data, Key.up) || data === "k") {
            moveFile(-1);
            return;
          }
          if (matchesKey(data, Key.home) || data === "g") {
            selectedIndex = 0;
            diffOffset = 0;
            ensureSelectedFileVisible();
            tui.requestRender();
            return;
          }
          if (matchesKey(data, Key.end) || data === "G") {
            selectedIndex = files.length - 1;
            diffOffset = 0;
            ensureSelectedFileVisible();
            tui.requestRender();
            return;
          }
          if (
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.space) ||
            matchesKey(data, Key.right) ||
            data === "l"
          ) {
            focus = "diff";
            tui.requestRender();
          }
          return;
        }

        if (
          matchesKey(data, Key.escape) ||
          matchesKey(data, Key.left) ||
          data === "h"
        ) {
          focus = "files";
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          moveDiff(DIFF_SCROLL_STEP);
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          moveDiff(-DIFF_SCROLL_STEP);
          return;
        }
        if (matchesKey(data, Key.ctrl("d"))) {
          moveDiff(Math.max(1, Math.floor(bodyHeight() / 2)));
          return;
        }
        if (matchesKey(data, Key.ctrl("u"))) {
          moveDiff(-Math.max(1, Math.floor(bodyHeight() / 2)));
          return;
        }
        if (matchesKey(data, Key.home) || data === "g") {
          diffOffset = 0;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.end) || data === "G") {
          diffOffset = Math.max(
            0,
            files[selectedIndex]!.diff.length - bodyHeight(),
          );
          tui.requestRender();
        }
      }

      function render(width: number) {
        if (closed || width <= 0 || totalHeight() === 0) return [];
        const height = bodyHeight();
        // Small terminals show the focused pane rather than forcing a sidebar
        // wider than the whole overlay. Enter/Escape still switch panes.
        const compact = width < 60;
        const sidebarWidth = compact
          ? Math.max(0, width - 2)
          : Math.min(48, Math.floor(width * 0.34));
        const diffWidth = Math.max(0, width - (compact ? 2 : sidebarWidth + 3));
        ensureSelectedFileVisible();
        const selectedFile = files[selectedIndex]!;
        diffOffset = Math.min(
          diffOffset, Math.max(0, selectedFile.diff.length - height),
        );
        const title = `local changes · ${files.length} ${files.length === 1 ? "file" : "files"} · ${focus === "files" ? "FILES" : "DIFF"}`;
        const lines = [border(width, title, true)];

        for (let row = 0; row < height; row += 1) {
          const fileIndex = sidebarOffset + Math.floor(row / 2);
          const file = files[fileIndex];
          let sidebar = "";

          if (file) {
            const isSelected = fileIndex === selectedIndex;
            if (row % 2 === 0) {
              const marker = isSelected ? "› " : "  ";
              const isBinary =
                file.additions === null || file.deletions === null;
              const stats = isBinary
                ? "binary"
                : `+${file.additions} -${file.deletions}`;
              const styledStats = isBinary
                ? theme.fg("success", stats)
                : `${theme.fg("success", `+${file.additions}`)} ${theme.fg("error", `-${file.deletions}`)}`;
              const nameWidth = Math.max(
                1,
                sidebarWidth - visibleWidth(marker) - visibleWidth(stats) - 1,
              );
              const name = truncateToWidth(file.name, nameWidth, "…");
              const gap = " ".repeat(
                Math.max(
                  1,
                  sidebarWidth -
                    visibleWidth(marker) -
                    visibleWidth(name) -
                    visibleWidth(stats),
                ),
              );
              sidebar = `${marker}${name}${gap}${styledStats}`;
            } else {
              sidebar = `  ${theme.fg("dim", truncateToWidth(file.path, Math.max(1, sidebarWidth - 2), "…"))}`;
            }

            sidebar = padToWidth(sidebar, sidebarWidth);
            if (isSelected) {
              sidebar = theme.bg(
                focus === "files" ? "selectedBg" : "customMessageBg",
                sidebar,
              );
            }
          } else {
            sidebar = " ".repeat(sidebarWidth);
          }

          const diffLine = selectedFile.diff[diffOffset + row];
          const diff = padToWidth(
            diffLine === undefined ? "" : styleDiffLine(diffLine),
            diffWidth,
          );
          const separator = theme.fg(
            focus === "diff" ? "borderAccent" : "borderMuted",
            "│",
          );
          const content = compact
            ? (focus === "files" ? sidebar : diff)
            : `${sidebar}${separator}${diff}`;
          lines.push(
            truncateToWidth(
              `${theme.fg("borderMuted", "│")}${content}${theme.fg("borderMuted", "│")}`,
              width,
              "",
            ),
          );
        }

        const help =
          focus === "files"
            ? "j/k or ↑/↓ select · enter/space/l open diff · esc close"
            : "j/k or ↑/↓ scroll · ctrl-d/u page · g/G top/bottom · esc/h files";
        lines.push(border(width, help, false));
        return lines.slice(0, totalHeight());
      }

      return {
        handleInput,
        dispose() { closed = true; },
        invalidate() {},
        render,
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        margin: 1,
        maxHeight: "90%",
        minWidth: 1,
        width: "95%",
      },
    },
  );
}
