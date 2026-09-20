import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { TerminalManager } from "./src/manager.ts";
import { createTerminalRuntime, runTool } from "./src/runtime.ts";

function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
function nodeCommand(script: string) { return `${quote(process.execPath)} -e ${quote(script)}`; }

function alive(pid: number) {
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

async function until(check: () => boolean, timeout = 7_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < deadline, "condition completed before its deadline");
    await delay(10);
  }
}

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(join(tmpdir(), "bt-lifecycle-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ready = join(dir, "ready");
  const heartbeat = join(dir, "heartbeat");
  const signaled = join(dir, "signaled");
  const child = `
const fs = require("node:fs");
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(signaled)}, "yes"));
fs.writeFileSync(${JSON.stringify(ready)}, String(process.pid));
let n = 0;
setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(++n)), 20);
`;
  return { dir, ready, heartbeat, signaled, child };
}

for (const action of ["natural-exit", "kill", "dispose"] as const) {
  test(`redirected SIGTERM-resistant descendants are reaped on ${action}`, {
    skip: process.platform === "win32", timeout: 12_000,
  }, async (t) => {
    const f = fixture(t);
    const runtime = createTerminalRuntime();
    let childPid: number | undefined;
    try {
      const manager = await runtime.runPromise(TerminalManager);
      const snap = await runTool(runtime, manager.start({
        command: `${nodeCommand(f.child)} >/dev/null 2>&1 & while [ ! -s ${quote(f.ready)} ]; do sleep 0.01; done; ${action === "natural-exit" ? "exit 0" : "wait"}`,
        title: action,
        cwd: f.dir,
      }));
      await until(() => fs.existsSync(f.ready) && fs.existsSync(f.heartbeat));
      childPid = Number(fs.readFileSync(f.ready, "utf8"));
      assert.ok(Number.isInteger(childPid) && childPid > 0);
      assert.equal(alive(childPid), true);
      if (action === "kill") {
        const killing = runTool(runtime, manager.kill([snap.id]));
        await until(() => fs.existsSync(f.signaled));
        assert.equal(snap.status, "running", "closed shell pipes must not settle a live group");
        const [report] = await killing;
        assert.equal(report.status, "killed");
        assert.equal(report.killed, true);
      } else if (action === "dispose") {
        await runtime.dispose();
      } else {
        await until(() => snap.status !== "running");
        assert.equal(snap.status, "done", "preserve the shell's natural exit status");
        assert.equal(snap.exitCode, 0);
      }
      assert.equal(alive(childPid), false, "descendant must be dead before cleanup reports completion");
      const stopped = fs.readFileSync(f.heartbeat, "utf8");
      await delay(80);
      assert.equal(fs.readFileSync(f.heartbeat, "utf8"), stopped);
      await runtime.dispose();
      assert.equal(alive(childPid), false);
    } finally {
      await runtime.dispose();
      // Regressions must not leave the test's own redirected child behind.
      if (!childPid && fs.existsSync(f.ready)) childPid = Number(fs.readFileSync(f.ready, "utf8"));
      if (childPid && alive(childPid)) {
        try { process.kill(childPid, "SIGKILL"); } catch { /* Already gone. */ }
      }
    }
  });
}

type ReadPipe = { readable?: boolean; _handle?: { constructor: { name: string } } };
function readablePipes() {
  return (process as unknown as { _getActiveHandles(): ReadPipe[] })._getActiveHandles()
    .filter((handle) => handle.readable && handle._handle?.constructor.name === "Pipe");
}

test("forced settlement closes inherited capture pipes and freezes output before disposal", {
  skip: process.platform === "win32", timeout: 12_000,
}, async (t) => {
  const f = fixture(t);
  const before = new Set(readablePipes());
  const runtime = createTerminalRuntime();
  let escapedPid: number | undefined;
  try {
    const manager = await runtime.runPromise(TerminalManager);
    const escaped = `
const fs = require("node:fs");
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
fs.writeFileSync(${JSON.stringify(f.ready)}, String(process.pid));
setInterval(() => { process.stdout.write("late stdout\\n"); process.stderr.write("late stderr\\n"); }, 20);
`;
    const parent = `
const child = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(escaped)}], {
  detached: true, stdio: ["ignore", 1, 2],
});
child.unref();
`;
    const snap = await runTool(runtime, manager.start({
      command: `exec ${nodeCommand(parent)}`, title: "escaped pipes", cwd: f.dir,
    }));
    await until(() => fs.existsSync(f.ready));
    escapedPid = Number(fs.readFileSync(f.ready, "utf8"));
    assert.ok(escapedPid > 0);
    await until(() => snap.status !== "running");
    assert.match(snap.errorText ?? "", /stdio did not close/);
    assert.ok(snap.stdout.totalBytes > 0 && snap.stderr.totalBytes > 0);
    const finalBytes = [snap.stdout.totalBytes, snap.stderr.totalBytes];
    await delay(100);
    assert.deepEqual([snap.stdout.totalBytes, snap.stderr.totalBytes], finalBytes);
    await runtime.dispose();
    await until(() => readablePipes().every((handle) => before.has(handle)));
    await delay(100);
    assert.deepEqual([snap.stdout.totalBytes, snap.stderr.totalBytes], finalBytes);
    assert.equal(alive(escapedPid), true, "test child deliberately escaped the managed process group");
  } finally {
    await runtime.dispose();
    if (!escapedPid && fs.existsSync(f.ready)) escapedPid = Number(fs.readFileSync(f.ready, "utf8"));
    if (escapedPid && alive(escapedPid)) {
      try { process.kill(-escapedPid, "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
});
