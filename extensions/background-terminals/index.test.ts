/** Black-box regressions at the registered Pi tool/UI boundary; no model calls. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import backgroundTerminals from "./index.ts";

const processOptions = { skip: process.platform === "win32", timeout: 30_000 };
type Lifecycle = "session_start" | "agent_settled" | "session_shutdown";
type Handler = (event: { type: Lifecycle }, ctx: ExtensionContext) => unknown;
type WidgetFactory = (tui: TUI, theme: Theme) => Component;
type SentMessage = Parameters<ExtensionAPI["sendMessage"]>[0];
type SendOptions = Parameters<ExtensionAPI["sendMessage"]>[1];
type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
interface ListedTerminal {
  id: string;
  status: string;
  pid: number;
}

async function bounded<T>(work: Promise<T>, label: string, ms = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(check: () => boolean | Promise<boolean>, label: string, ms = 8_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(10);
  }
}

function gone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw error;
  }
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function resultText(result: ToolResult) {
  return result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

async function harness(t: TestContext, hasUI = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bt-extension-test-"));
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, Handler[]>();
  const messages: Array<{ message: SentMessage; options: SendOptions }> = [];
  const widgets = new Map<string, WidgetFactory>();
  const pids = new Set<number>();
  let idle = false;
  let callNumber = 0;

  // Only the documented surfaces used by this extension are implemented.
  // Cast at the fake boundary rather than manufacture a live session or TUI.
  const ui = {
    setWidget(key: string, content: string[] | WidgetFactory | undefined) {
      if (typeof content === "function") widgets.set(key, content);
      else if (content === undefined) widgets.delete(key);
      else assert.fail("Expected a custom widget factory");
    },
  } as unknown as ExtensionUIContext;
  const ctx = {
    cwd,
    hasUI,
    mode: hasUI ? "tui" : "print",
    ui,
    isIdle: () => idle,
  } as unknown as ExtensionContext;
  const api = {
    on: ((event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }) as ExtensionAPI["on"],
    registerTool(tool) {
      assert.ok(!tools.has(tool.name), `Duplicate tool ${tool.name}`);
      tools.set(tool.name, tool as ToolDefinition);
    },
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  } satisfies Partial<ExtensionAPI>;

  async function emit(type: Lifecycle) {
    for (const handler of handlers.get(type) ?? []) await handler({ type }, ctx);
  }
  t.after(async () => {
    try {
      await bounded(emit("session_shutdown"), "session_shutdown", 15_000);
    } finally {
      // Emergency fallback is restricted to our exec'ed children; never kill
      // processes by name or touch a running Pi session's manager.
      for (const pid of pids) {
        if (!gone(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      }
      try {
        await until(() => [...pids].every(gone), "own children reaped", 5_000);
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  backgroundTerminals(api as unknown as ExtensionAPI);
  assert.deepEqual([...tools.keys()].sort(), ["bg_kill", "bg_list", "bg_start", "bg_status"]);
  await emit("session_start");

  async function call(name: string, params: Record<string, unknown>, signal?: AbortSignal) {
    const tool = tools.get(name);
    assert.ok(tool, `${name} registered`);
    return bounded(
      tool.execute(`test-${++callNumber}`, params, signal, undefined, ctx),
      name,
    );
  }

  async function start(title: string, resist = false) {
    const ready = path.join(cwd, `${title}.ready`);
    const term = path.join(cwd, `${title}.term`);
    const stdout = `${title}: final stdout tail`;
    const stderr = `${title}: final stderr tail`;
    const script = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => {
        fs.writeSync(1, ${JSON.stringify(stdout + "\n")});
        fs.writeSync(2, ${JSON.stringify(stderr + "\n")});
        fs.writeFileSync(${JSON.stringify(term)}, "signaled");
        ${resist ? "" : "process.exit(0);"}
      });
      setInterval(() => {}, 1000);
      fs.writeFileSync(${JSON.stringify(ready)}, "ready");
    `;
    // exec makes the reported shell pid the actual test child, avoiding a
    // shell exiting on SIGTERM while its child is still holding the pipes.
    const result = await call("bg_start", {
      title,
      command: `exec ${shellQuote(process.execPath)} -e ${shellQuote(script)}`,
      working_dir: cwd,
    });
    const details = result.details as { id: string; pid: number };
    assert.equal(typeof details.id, "string");
    assert.equal(typeof details.pid, "number");
    pids.add(details.pid);
    await until(() => fs.existsSync(ready), `${title} installed SIGTERM handler`);
    return { ...details, stdout, stderr, term };
  }

  async function list() {
    const result = await call("bg_list", {});
    return (result.details as { terminals: ListedTerminal[] }).terminals;
  }

  async function settled(ids: string[]) {
    // bg_status intentionally is NOT used: it consumes deferred completion.
    await until(async () => {
      const terminals = await list();
      return ids.every((id) => terminals.some((entry) => entry.id === id && entry.status !== "running"));
    }, `settlement of ${ids.join(", ")}`);
  }

  async function flush() {
    idle = true;
    await emit("agent_settled");
    // Repeat the lifecycle notification and cross an event-loop turn to catch
    // both repeated drains and late automatic delivery.
    await delay(0);
    await emit("agent_settled");
  }

  function deliveredIds() {
    return messages.map(({ message, options }) => {
      assert.equal(message.customType, "background-terminal-result");
      assert.equal(message.display, true);
      assert.deepEqual(options, { deliverAs: "followUp", triggerTurn: true });
      return (message.details as { id: string }).id;
    }).sort();
  }

  return { call, start, list, settled, flush, deliveredIds, messages, widgets, emit };
}

// Attach rejection handling immediately, even while we wait for a child's
// handshake. This prevents unhandled rejections if the tool regresses early.
function observe(promise: Promise<ToolResult>) {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function aborted(outcome: ReturnType<typeof observe>) {
  const result = await outcome;
  assert.equal(result.ok, false, "aborted collector must not return a successful report");
  if (!result.ok) {
    assert.ok(result.error instanceof Error);
    assert.match(result.error.message, /aborted|interrupt/i);
  }
}

async function succeeded(outcome: ReturnType<typeof observe>) {
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

test("aborting a multi-id bg_kill restores both early and late completion delivery", processOptions, async (t) => {
  const h = await harness(t);
  const first = await h.start("fast");
  const second = await h.start("resistant", true);
  const ids = [first.id, second.id];
  const controller = new AbortController();
  const killing = observe(h.call("bg_kill", { ids }, controller.signal));

  await h.settled([first.id]);
  await until(() => fs.existsSync(second.term), "resistant child received SIGTERM");
  assert.equal((await h.list()).find((entry) => entry.id === second.id)?.status, "running");
  assert.equal(h.messages.length, 0, "agent is busy during kill collection");
  await h.flush();
  assert.equal(h.messages.length, 0, "even an idle flush must respect active delivery reservations");
  controller.abort();
  await aborted(killing);

  await h.settled(ids);
  await h.flush();
  assert.deepEqual(h.deliveredIds(), [...ids].sort(), "each result must be delivered exactly once");
  for (const child of [first, second]) {
    const delivery = h.messages.find(({ message }) => (message.details as { id: string }).id === child.id);
    assert.ok(delivery);
    assert.equal(typeof delivery.message.content, "string");
    assert.ok((delivery.message.content as string).includes(child.stdout));
    assert.ok((delivery.message.content as string).includes(child.stderr));
  }
});

test("a successful overlapping multi-id collector owns its results even if another collector later aborts", processOptions, async (t) => {
  const h = await harness(t);
  const first = await h.start("overlap-first");
  const second = await h.start("overlap-second");
  const third = await h.start("abort-only", true);
  const controller = new AbortController();
  const abandoned = observe(h.call("bg_kill", { ids: [first.id, second.id, third.id] }, controller.signal));
  const collected = observe(h.call("bg_kill", { ids: [first.id, second.id] }));

  await h.settled([first.id, second.id]);
  await until(() => fs.existsSync(third.term), "abort-only child received SIGTERM");
  const report = await succeeded(collected);
  const results = (report.details as { results: Array<{ id: string; status: string }> }).results;
  assert.deepEqual(results.map(({ id }) => id).sort(), [first.id, second.id].sort());
  assert.ok(results.every(({ status }) => status !== "running"));
  assert.equal((await h.list()).find((entry) => entry.id === third.id)?.status, "running");
  controller.abort();
  await aborted(abandoned);

  await h.settled([third.id]);
  await h.flush();
  assert.deepEqual(h.deliveredIds(), [third.id], "successful collector's IDs must not be automatically redelivered");
});

test("successful bg_kill returns final stdout/stderr tails without duplicate automatic completion", processOptions, async (t) => {
  const h = await harness(t);
  const child = await h.start("final-output");
  const result = await h.call("bg_kill", { ids: [child.id] });
  const text = resultText(result);
  // Written only inside SIGTERM: these are final output, not a pre-kill peek.
  assert.ok(text.includes(child.stdout), `kill report omitted stdout:\n${text}`);
  assert.ok(text.includes(child.stderr), `kill report omitted stderr:\n${text}`);
  await h.settled([child.id]);
  await h.flush();
  assert.deepEqual(h.deliveredIds(), []);
});

test("tools cannot recreate a runtime after shutdown", async (t) => {
  const h = await harness(t);
  await h.call("bg_list", {});
  await h.emit("session_shutdown");
  for (const [name, params] of [
    ["bg_list", {}],
    ["bg_status", { id: "bt-1" }],
    ["bg_kill", { ids: ["bt-1"] }],
    ["bg_start", { command: "node --version", title: "must not start" }],
  ] as const) {
    await assert.rejects(h.call(name, params), /shutting down|disposed/i);
  }
});

test("manager initialization racing shutdown does not attach stale hooks or restart", async (t) => {
  const h = await harness(t);
  const pending = observe(h.call("bg_list", {}));
  await h.emit("session_shutdown");
  const outcome = await pending;
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.match(String(outcome.error), /shutting down|disposed/i);
  await assert.rejects(h.call("bg_list", {}), /shutting down|disposed/i);
  assert.equal(h.messages.length, 0);
  assert.equal(h.widgets.size, 0);
});

test("running widget respects narrow widths and recomputes theme styling on rerender", processOptions, async (t) => {
  const h = await harness(t, true);
  await h.start("widget-child");
  const factory = h.widgets.get("background-terminals");
  assert.ok(factory, "running process installs its widget");
  let color = 31;
  const theme = {
    fg(_name: string, text: string) {
      return `\u001b[${color}m${text}\u001b[39m`;
    },
  } as unknown as Theme;
  const widget = factory({ requestRender() {} } as unknown as TUI, theme);
  const original = widget.render(120).join("\n");
  assert.match(original, /1 background terminal running/);
  assert.match(original, /\u001b\[31m/);
  for (const width of [0, 1, 20, 120]) {
    await t.test(`render(${width}) fits the available columns`, () => {
      for (const line of widget.render(width)) {
        assert.ok(visibleWidth(line) <= width, `widget exceeded width ${width}: ${JSON.stringify(line)}`);
      }
    });
  }
  await t.test("rerender reads the current theme", () => {
    color = 32;
    const rerendered = widget.render(120).join("\n");
    assert.match(rerendered, /\u001b\[32m/);
    assert.doesNotMatch(rerendered, /\u001b\[31m/);
  });
  await t.test("invalidate does not preserve stale styled text", () => {
    color = 34;
    widget.invalidate();
    const invalidated = widget.render(120).join("\n");
    assert.match(invalidated, /\u001b\[34m/);
    assert.doesNotMatch(invalidated, /\u001b\[(31|32)m/);
  });
});
