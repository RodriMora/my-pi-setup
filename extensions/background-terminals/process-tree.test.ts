import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { test } from "node:test";
import { createProcessTree } from "./src/process-tree.ts";

const posix = { skip: process.platform === "win32" };
const missing = () => Object.assign(new Error("missing"), { code: "ESRCH" });

test("process-group liveness does not depend on shell exit or redirected pipes", posix, (t) => {
  const calls: Array<[number, string | number | undefined]> = [];
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    calls.push([pid, signal]);
    return true;
  });
  const tree = createProcessTree({ pid: 1234 } as ChildProcess, () => true);
  assert.equal(tree.isAlive(), true);
  tree.signal("SIGTERM");
  tree.signal("SIGKILL");
  assert.deepEqual(calls, [[-1234, 0], [-1234, "SIGTERM"], [-1234, "SIGKILL"]]);
});

test("once a group disappears its numeric PGID is never probed or signaled again", posix, (t) => {
  const kill = t.mock.method(process, "kill", () => { throw missing(); });
  const tree = createProcessTree({ pid: 1234 } as ChildProcess, () => true);
  assert.equal(tree.isAlive(), false);
  assert.equal(tree.isAlive(), false);
  tree.signal("SIGTERM");
  tree.signal("SIGKILL");
  assert.equal(kill.mock.callCount(), 1);
});

test("ESRCH while signaling also retires the group", posix, (t) => {
  let probes = 0;
  t.mock.method(process, "kill", (_pid: number, signal?: string | number) => {
    probes++;
    if (signal !== 0) throw missing();
    return true;
  });
  const tree = createProcessTree({ pid: 1234 } as ChildProcess, () => true);
  assert.equal(tree.isAlive(), true);
  tree.signal("SIGTERM");
  assert.equal(tree.isAlive(), false);
  tree.signal("SIGKILL");
  assert.equal(probes, 2);
});

test("permission errors are not mistaken for a dead group", posix, (t) => {
  t.mock.method(process, "kill", () => {
    throw Object.assign(new Error("permission"), { code: "EPERM" });
  });
  const tree = createProcessTree({ pid: 1234 } as ChildProcess, () => true);
  assert.equal(tree.isAlive(), true);
});

test("failed spawns with no pid are never probed or signaled", (t) => {
  const kill = t.mock.method(process, "kill", () => { throw new Error("must not signal"); });
  const tree = createProcessTree({} as ChildProcess, () => true);
  assert.equal(tree.isAlive(), false);
  tree.signal("SIGTERM");
  assert.equal(kill.mock.callCount(), 0);
});
