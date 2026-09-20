import assert from "node:assert/strict";
import test from "node:test";
import type { OutputView, TerminalSnapshot } from "./src/domain.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import {
  BG_START_PARAMETER_DESCRIPTIONS,
  BG_START_TOOL_DESCRIPTION,
  buildKillReport,
  buildStatusResult,
  buildTerminalResultMessage,
} from "./src/prompt.ts";

test("start descriptions identify the platform-specific shell contract", () => {
  assert.match(BG_START_TOOL_DESCRIPTION, /sh -c on POSIX/);
  assert.match(BG_START_TOOL_DESCRIPTION, /cmd\.exe \/d \/s \/c on Windows/);
  assert.match(BG_START_PARAMETER_DESCRIPTIONS.command, /sh -c on POSIX/);
  assert.match(
    BG_START_PARAMETER_DESCRIPTIONS.command,
    /cmd\.exe \/d \/s \/c on Windows/,
  );
});

function view(overrides: Partial<OutputView> = {}): OutputView {
  return { text: "", totalBytes: 0, truncatedBytes: 0, ...overrides };
}

function snap(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    id: "bt-1",
    command: "sleep 999",
    title: "test",
    cwd: "/tmp",
    pid: 123,
    status: "done",
    createdAt: Date.now() - 5_000,
    settledAt: Date.now(),
    exitCode: 0,
    stdout: view(),
    stderr: view(),
    ...overrides,
  };
}

test("kill report distinguishes killed / raced natural exit / already settled", () => {
  const report = buildKillReport([
    {
      id: "bt-1",
      title: "a",
      status: "killed",
      wasRunning: true,
      killed: true,
      exit: "SIGTERM",
    },
    {
      id: "bt-2",
      title: "b",
      status: "done",
      wasRunning: true,
      killed: false,
      exit: "exit 0",
    },
    {
      id: "bt-3",
      title: "c",
      status: "failed",
      wasRunning: false,
      killed: false,
      exit: "exit 1",
    },
  ]);
  const lines = report.split("\n");
  assert.equal(lines[0], 'Killed bt-1 "a" (SIGTERM).');
  assert.match(lines[1], /exited on its own before the kill landed \(exit 0\)/);
  assert.match(lines[2], /was already failed \(exit 1\)/);
});

test("kill report includes bounded final stdout/stderr and full-log pointers", () => {
  const stdout = "early output\n".repeat(2_000) + "FINAL STDOUT";
  const report = buildKillReport([{
    id: "bt-1", title: "test", status: "killed", wasRunning: true, killed: true, exit: "SIGTERM",
    snapshot: snap({
      stdout: view({ text: stdout, totalBytes: Buffer.byteLength(stdout), spillPath: "/tmp/full.stdout.log" }),
      stderr: view({ text: "FINAL STDERR", totalBytes: 12 }),
    }),
  }]);
  assert.match(report, /FINAL STDOUT/);
  assert.match(report, /FINAL STDERR/);
  assert.match(report, /stdout truncated/);
  assert.match(report, /Full log: \/tmp\/full.stdout.log/);
  assert.ok(Buffer.byteLength(report) <= DEFAULT_MAX_BYTES);
});

test("multi-terminal kill output respects aggregate limits and keeps all status lines", () => {
  const text = "x".repeat(100_000) + "END";
  const report = buildKillReport(Array.from({ length: 32 }, (_, index) => ({
    id: `bt-${index + 1}`, title: "test", status: "killed" as const,
    wasRunning: true, killed: true, exit: "SIGTERM",
    snapshot: snap({
      errorText: "warning ".repeat(500),
      stdout: view({ text, totalBytes: text.length, spillPath: `/tmp/${index}.stdout.log` }),
      stderr: view({ text, totalBytes: text.length, spillPath: `/tmp/${index}.stderr.log` }),
    }),
  })));
  for (let index = 1; index <= 32; index++) assert.ok(report.includes(`Killed bt-${index} `));
  assert.ok(Buffer.byteLength(report) <= DEFAULT_MAX_BYTES);
  assert.ok(report.split("\n").length <= DEFAULT_MAX_LINES);
  assert.match(report, /Kill report truncated/);
});

test("status result marks head-truncated output with a pointer at the full log", () => {
  const text = buildStatusResult(
    snap({
      stdout: view({
        text: "tail of the log\n",
        totalBytes: 5 * 1024 * 1024,
        truncatedBytes: 5 * 1024 * 1024 - 16,
        spillPath: "/tmp/bt-1.stdout.log",
      }),
    }),
  );
  assert.match(text, /stdout truncated: showing last /);
  assert.match(text, /Full log: \/tmp\/bt-1\.stdout\.log/);
});

test("a missing spill does not promise full output that was already discarded", () => {
  const report = buildStatusResult(snap({
    stdout: view({ text: "retained tail", totalBytes: 100_000, truncatedBytes: 99_987 }),
  }));
  assert.match(report, /older output was not preserved/);
  assert.doesNotMatch(report, /Full output in/);
});

test("completion message reports kill vs exit and omits empty stderr", () => {
  const killed = buildTerminalResultMessage(
    snap({ status: "killed", exitCode: undefined, signal: "SIGTERM" }),
  );
  assert.match(killed, /was killed after/);
  assert.ok(!killed.includes("stderr"), "empty stderr section omitted");

  const failed = buildTerminalResultMessage(
    snap({
      status: "failed",
      exitCode: 3,
      stderr: view({ text: "boom\n", totalBytes: 5 }),
    }),
  );
  assert.match(failed, /exited \(exit 3\)/);
  assert.match(failed, /stderr:\nboom/);
});

test("completion output is a shorter tail than the detailed status view", () => {
  const output = Array.from(
    { length: 100 },
    (_, index) => `line-${index + 1}`,
  ).join("\n");
  const terminal = snap({
    stdout: view({ text: output, totalBytes: Buffer.byteLength(output) }),
  });

  const completion = buildTerminalResultMessage(terminal);
  const status = buildStatusResult(terminal);

  assert.ok(!completion.includes("line-1\n"));
  assert.match(completion, /line-100/);
  assert.match(completion, /stdout truncated/);
  assert.match(status, /line-1\n/);
});
