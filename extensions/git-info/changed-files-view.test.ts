import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadChangedFiles, sanitizeTerminalText, showChangedFiles, type ChangedFile } from "./src/changed-files-view.ts";
import { CommandRunner, type CommandResult } from "./src/process.ts";

test("repository text cannot inject terminal control sequences", () => {
  const input =
    "before\u001b]52;c;Y2xpcGJvYXJk\u0007after\u001b[31mred\u001b[0m\u0001";
  assert.equal(sanitizeTerminalText(input), "beforeafterred");
});

function loadFixture(overrides: Partial<Record<"root" | "status" | "head" | "symbolic" | "ref" | "diff" | "stat", Partial<CommandResult>>> = {}) {
  const fixtures = {
    root: { stdout: "/virtual/repo\n", code: 0, stderr: "" },
    status: { stdout: " M file.ts\0", code: 0, stderr: "" },
    head: { stdout: "abc\n", code: 0, stderr: "" },
    symbolic: { stdout: "refs/heads/main\n", code: 0, stderr: "" },
    ref: { stdout: "", code: 1, stderr: "" },
    diff: { stdout: "diff --git a/file.ts b/file.ts\n+line with trailing spaces  \n", code: 0, stderr: "" },
    stat: { stdout: "1\t0\tfile.ts\0", code: 0, stderr: "" },
  };
  return Effect.runPromise(loadChangedFiles("/virtual/repo").pipe(
    Effect.provideService(CommandRunner, {
      run(_command, args, cwd) {
        const key = args.includes("--show-toplevel") ? "root"
          : args.includes("status") ? "status"
          : args.includes("symbolic-ref") ? "symbolic"
          : args.includes("show-ref") ? "ref"
          : args.includes("--verify") ? "head"
          : args.includes("--numstat") ? "stat" : "diff";
        assert.equal(cwd, "/virtual/repo");
        return Effect.succeed({ ...fixtures[key], ...overrides[key] });
      },
    }),
  ));
}

test("aggregates every numstat record and preserves trailing patch whitespace", async () => {
  const files = await loadFixture({ stat: { stdout: "2\t3\tone\0" + "4\t5\ttwo\0" } });
  assert.equal(files?.[0].additions, 6);
  assert.equal(files?.[0].deletions, 8);
  assert.equal(files?.[0].diff.at(-1), "+line with trailing spaces  ");
});

test("NUL rename statistics skip both names, even names resembling a stat", async () => {
  const files = await loadFixture({ stat: { stdout: "2\t3\t\0old\tname\0new\nname\0" + "4\t5\tother\0" } });
  assert.equal(files?.[0].additions, 6);
  assert.equal(files?.[0].deletions, 8);
});

test("any binary numstat record makes totals unknown, not NaN or partial totals", async () => {
  const files = await loadFixture({ stat: { stdout: "2\t3\tone\0-\t-\tbinary\0" } });
  assert.equal(files?.[0].additions, null);
  assert.equal(files?.[0].deletions, null);
});

for (const operation of ["root", "head", "status", "diff", "stat"] as const) {
  test(`${operation} errors retain sanitized diagnostics`, async () => {
    await assert.rejects(loadFixture({ [operation]: { code: 128, stderr: "\x1b[31mpermission denied\x1b[0m" } }), (error: unknown) => {
      assert.match(String(error), /permission denied/);
      assert.ok(!String(error).includes("\x1b"));
      return true;
    });
    if (operation === "root") {
      await assert.rejects(loadFixture({ root: { code: 128, stderr: "fatal: detected dubious ownership in repository at '/tmp/not a git repository'" } }), /dubious ownership/);
    }
  });
  test(`${operation} timeout is not a clean/empty result`, async () => {
    await assert.rejects(loadFixture({ [operation]: { code: -1 } }), /timed out/);
  });
}

for (const [label, overrides] of [
  ["truncated status", { status: { stdout: " M file.ts\n[command output truncated]\n" } }],
  ["malformed status", { status: { stdout: "bad\0" } }],
  ["missing rename source", { status: { stdout: "R  new\0" } }],
  ["truncated statistics", { stat: { stdout: "1\t0\tfile" } }],
  ["malformed statistics", { stat: { stdout: "no-number\t0\tfile\0" } }],
  ["missing statistic rename paths", { stat: { stdout: "1\t0\t\0old\0" } }],
] as const) {
  test(`rejects ${label}`, async () => {
    await assert.rejects(loadFixture(overrides), /Invalid|Missing/);
  });
}

test("no-index exit 1 is successful; exit 2 retains failure", async () => {
  const options = { status: { stdout: "?? file.ts\0" }, diff: { code: 1, stderr: "warning: line endings" }, stat: { code: 1 } };
  assert.equal((await loadFixture(options))?.[0].additions, 1);
  await assert.rejects(loadFixture({ ...options, diff: { code: 2, stderr: "cannot open file" } }), /cannot open file/);
});

test("non-repository and clean repository remain distinct", async () => {
  assert.equal(await loadFixture({ root: { code: 128, stderr: "fatal: not a git repository (or any of the parent directories): .git" } }), null);
  assert.deepEqual(await loadFixture({ status: { stdout: "" } }), []);
});

test("a missing HEAD is unborn only when its symbolic branch ref is absent", async () => {
  const missingHead = { head: { code: 1, stdout: "" } };
  assert.equal((await loadFixture(missingHead))?.[0].additions, 1);
  await assert.rejects(loadFixture({ ...missingHead, ref: { code: 0 } }), /existing branch reference/);
  await assert.rejects(loadFixture({ ...missingHead, symbolic: { code: 1 } }), /symbolic git HEAD/);
  await assert.rejects(loadFixture({ ...missingHead, ref: { code: 128, stderr: "broken ref" } }), /broken ref/);
});

const files: ChangedFile[] = Array.from({ length: 40 }, (_, i) => ({
  name: `file-${i}.ts`, path: `dir/file-${i}.ts`, additions: i, deletions: i,
  diff: Array.from({ length: 100 }, (_, line) => `+DIFF-${i}-LINE-${line}`),
}));

async function viewer(input = files, mode = "tui") {
  let component: any;
  let options: any;
  let closed = 0;
  let mounts = 0;
  let redraws = 0;
  const terminal = { rows: 40, columns: 120 };
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
  await showChangedFiles({ mode, ui: {
    custom(factory: any, opts: any) {
      mounts++;
      options = opts;
      component = factory({ terminal, requestRender() { redraws++; } }, theme, {}, () => { closed++; });
      return Promise.resolve();
    },
  } } as unknown as ExtensionContext, input);
  return { component, options, terminal, get closed() { return closed; }, get mounts() { return mounts; }, get redraws() { return redraws; } };
}

test("empty and non-TUI viewers do not mount", async () => {
  assert.equal((await viewer([])).mounts, 0);
  assert.equal((await viewer(files, "rpc")).mounts, 0);
});

test("viewer fits tiny/narrow/normal terminal widths and heights in either pane", async () => {
  const v = await viewer();
  assert.equal(v.options.overlayOptions.minWidth, 1);
  for (const rows of [0, 1, 2, 3, 5, 10, 40]) {
    v.terminal.rows = rows;
    for (const width of [0, 1, 2, 3, 10, 20, 59, 60, 80, 120]) {
      for (const key of ["h", "l"]) {
        v.component.handleInput(key);
        const output: string[] = v.component.render(width);
        assert.ok(output.length <= Math.max(0, rows - 2), `rows=${rows}`);
        for (const line of output) assert.ok(visibleWidth(line) <= width, `width=${width}: ${line}`);
      }
    }
  }
});

test("resize keeps selection visible and clamps diff scroll when height grows", async () => {
  const v = await viewer();
  v.component.handleInput("G");
  assert.match(v.component.render(120).join("\n"), /› file-39\.ts/);
  v.terminal.rows = 10;
  assert.match(v.component.render(120).join("\n"), /› file-39\.ts/);
  v.component.handleInput("l");
  v.component.handleInput("G");
  assert.match(v.component.render(20).join("\n"), /DIFF-39-LINE-99/);
  v.terminal.rows = 40;
  const output = v.component.render(120).join("\n");
  assert.match(output, /DIFF-39-LINE-70/);
  assert.match(output, /DIFF-39-LINE-99/);
});

test("compact viewer switches between full-width file and diff panes", async () => {
  const v = await viewer();
  assert.match(v.component.render(20).join("\n"), /file-0\.ts/);
  v.component.handleInput("l");
  assert.match(v.component.render(20).join("\n"), /DIFF-0-LINE-0/);
  v.component.handleInput("\x1b");
  assert.match(v.component.render(20).join("\n"), /file-0\.ts/);
  assert.equal(v.closed, 0);
  v.component.handleInput("\x1b");
  assert.equal(v.closed, 1);
  v.component.handleInput("\x1b");
  v.component.handleInput("j");
  assert.equal(v.closed, 1);
  assert.deepEqual(v.component.render(80), []);
});

test("Ctrl+C closes from diff focus; disposed viewers ignore late input", async () => {
  const v = await viewer();
  v.component.handleInput("l");
  v.component.handleInput("\x03");
  assert.equal(v.closed, 1);
  const disposed = await viewer();
  disposed.component.dispose();
  disposed.component.handleInput("\x03");
  assert.equal(disposed.closed, 0);
  assert.deepEqual(disposed.component.render(80), []);
});
