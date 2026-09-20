import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import lockfile from "proper-lockfile";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import extension from "../list-skills.ts";

type Handler = Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
type Custom = ExtensionContext["ui"]["custom"];
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const bounded = { timeout: 3000 };
async function until(check: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!check()) { assert.ok(Date.now() < deadline); await delay(2); }
}
function fixture(t: TestContext) {
  const home = fs.mkdtempSync(join(tmpdir(), "pi-skill-command-"));
  const agentDir = join(home, "alternate-agent");
  fs.mkdirSync(agentDir);
  const savedHome = process.env.HOME;
  const savedAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const settings = join(agentDir, "settings.json");
  const external = join(home, "external.md");
  fs.writeFileSync(external, "---\nname: external\ndescription: Test skill\n---\n");
  const initial = { theme: "dark", skills: [external], packages: ["do-not-change"] };
  fs.writeFileSync(settings, JSON.stringify(initial, null, 2) + "\n");
  let handler!: Handler;
  let shutdown!: () => Promise<void>;
  const state = {
    messages: [] as Array<{ message: string; kind?: string }>,
    opened: [] as Array<Component & { dispose?(): void }>,
    reloads: 0, waits: 0,
    action: undefined as ((component: Component) => void | Promise<void>) | undefined,
    commands: [] as ReturnType<ExtensionAPI["getCommands"]>,
    afterClose: undefined as Promise<void> | undefined,
  };
  extension({
    registerCommand(name: string, options: { handler: Handler }) { assert.equal(name, "listskills"); handler = options.handler; },
    on(event: string, callback: () => Promise<void>) { assert.equal(event, "session_shutdown"); shutdown = callback; },
    getCommands: () => state.commands,
  } as unknown as ExtensionAPI);
  const custom: Custom = async <T>(factory: Parameters<Custom>[0]) => {
    let resolve!: (value: T) => void;
    const result = new Promise<T>(done => { resolve = done; });
    let component: (Component & { dispose?(): void }) | undefined;
    component = await factory({ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
      theme, {} as Parameters<Parameters<Custom>[0]>[2], value => { component?.dispose?.(); resolve(value as T); });
    state.opened.push(component);
    await state.action?.(component);
    const value = await result;
    await state.afterClose;
    return value;
  };
  const ctx = {
    mode: "tui", hasUI: true, cwd: home,
    waitForIdle: async () => { state.waits++; },
    reload: async () => { state.reloads++; await shutdown(); },
    ui: { custom, notify: (message: string, kind?: string) => { state.messages.push({ message, kind }); } },
  } as unknown as ExtensionCommandContext;
  t.after(async () => {
    await shutdown();
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (savedAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedAgent;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return { state, ctx, handler, shutdown, settings, external, initial, home, agentDir,
    read: () => JSON.parse(fs.readFileSync(settings, "utf8")) };
}

test("saving unchanged selection preserves external discovery and exact file bytes", bounded, async t => {
  const f = fixture(t);
  const before = fs.readFileSync(f.settings, "utf8");
  f.state.action = picker => picker.handleInput?.("\x1b");
  await f.handler("", f.ctx);
  assert.equal(fs.readFileSync(f.settings, "utf8"), before);
  assert.equal(f.state.reloads, 1);
  assert.equal(fs.existsSync(join(f.home, ".pi", "agent", "settings.json")), false);
});

test("disabling external skill preserves discovery and unrelated settings then reloads once", bounded, async t => {
  const f = fixture(t);
  f.state.action = picker => { picker.handleInput?.(" "); picker.handleInput?.("\x1b"); };
  await f.handler("", f.ctx);
  assert.deepEqual(f.read(), { ...f.initial, skills: [f.external, `-${f.external}`] });
  assert.equal(f.state.reloads, 1);
  assert.equal(f.state.messages.filter(m => m.kind === "error").length, 0);
});

test("cancel discards toggles without rewriting or reloading", bounded, async t => {
  const f = fixture(t);
  f.state.action = picker => { picker.handleInput?.(" "); picker.handleInput?.("\x03"); };
  await f.handler("", f.ctx);
  assert.deepEqual(f.read(), f.initial);
  assert.equal(f.state.reloads, 0);
});

for (const content of ["{broken", "[]", '{"skills":null}']) {
  test(`unsafe settings ${content} are reported without opening or saving`, bounded, async t => {
    const f = fixture(t);
    fs.writeFileSync(f.settings, content);
    await f.handler("", f.ctx);
    assert.equal(fs.readFileSync(f.settings, "utf8"), content);
    assert.equal(f.state.opened.length, 0);
    assert.equal(f.state.reloads, 0);
    assert.equal(f.state.messages.at(-1)?.kind, "error");
  });
}

test("settings corrupted while picker is open are not replaced on save", bounded, async t => {
  const f = fixture(t);
  f.state.action = picker => {
    picker.handleInput?.(" ");
    fs.writeFileSync(f.settings, "bad-json");
    picker.handleInput?.("\x1b");
  };
  await f.handler("", f.ctx);
  assert.equal(fs.readFileSync(f.settings, "utf8"), "bad-json");
  assert.equal(f.state.reloads, 0);
  assert.equal(f.state.messages.at(-1)?.kind, "error");
});

test("non-TUI commands do not read malformed settings or open the picker", bounded, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.settings, "bad-json");
  await f.handler("", { ...f.ctx, mode: "rpc" });
  assert.equal(f.state.waits, 0);
  assert.equal(f.state.opened.length, 0);
  assert.equal(f.state.messages.at(-1)?.kind, "warning");
});

test("shutdown closes active picker, waits for host cleanup, and rejects late UI", bounded, async t => {
  const f = fixture(t);
  let complete!: () => void;
  f.state.afterClose = new Promise<void>(resolve => { complete = resolve; });
  try {
    const running = f.handler("", f.ctx);
    await until(() => f.state.opened.length === 1);
    let ended = false;
    const closing = f.shutdown().then(() => { ended = true; });
    await delay(10);
    assert.equal(ended, false);
    complete();
    await Promise.all([running, closing]);
    await f.handler("", f.ctx);
    assert.equal(f.state.opened.length, 1);
    assert.equal(f.state.reloads, 0);
    assert.deepEqual(f.read(), f.initial);
  } finally { complete(); }
});

test("shutdown during lock contention cancels the save without stale notifications", bounded, async t => {
  const f = fixture(t);
  const release = lockfile.lockSync(f.settings, { realpath: false });
  try {
    f.state.action = picker => { picker.handleInput?.(" "); picker.handleInput?.("\x1b"); };
    const pending = f.handler("", f.ctx);
    await until(() => f.state.opened.length === 1);
    await delay(10);
    await f.shutdown();
    await pending;
    assert.deepEqual(f.read(), f.initial);
    assert.equal(f.state.reloads, 0);
    assert.equal(f.state.messages.length, 0);
  } finally { release(); }
});

test("shutdown while waiting for idle prevents all subsequent UI and settings work", bounded, async t => {
  const f = fixture(t);
  let release!: () => void;
  const idle = new Promise<void>(resolve => { release = resolve; });
  const pending = f.handler("", { ...f.ctx, waitForIdle: () => idle });
  await f.shutdown();
  release();
  await pending;
  assert.equal(f.state.opened.length, 0);
  assert.equal(f.state.messages.length, 0);
  assert.equal(f.state.reloads, 0);
});

test("reload failures after shutdown do not touch the stale UI context", bounded, async t => {
  const f = fixture(t);
  f.state.action = picker => picker.handleInput?.("\x1b");
  await f.handler("", { ...f.ctx, reload: async () => {
    await f.shutdown();
    throw new Error("Old reload frame is stale");
  } });
  assert.equal(f.state.messages.length, 1);
  assert.match(f.state.messages[0].message, /Saved global skill filters/);
});

test("a second command cannot open an overlapping picker", bounded, async t => {
  const f = fixture(t);
  const first = f.handler("", f.ctx);
  await until(() => f.state.opened.length === 1);
  await f.handler("", f.ctx);
  assert.equal(f.state.opened.length, 1);
  assert.match(f.state.messages.at(-1)!.message, /already open/);
  f.state.opened[0].handleInput?.("\x03");
  await first;
});

test("package and project rows are read-only and saving does not invent global exclusions", bounded, async t => {
  const f = fixture(t);
  f.state.commands = [{ name: "skill:external", description: "Package-owned", source: "skill", sourceInfo: {
    path: f.external, source: "npm:example", scope: "user", origin: "package", baseDir: f.home,
  } }];
  f.state.action = picker => { picker.handleInput?.(" "); picker.handleInput?.("\x1b"); };
  await f.handler("", f.ctx);
  assert.deepEqual(f.read(), f.initial);
});
