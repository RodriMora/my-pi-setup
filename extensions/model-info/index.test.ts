import { createHash } from "node:crypto";
import { getEventListeners } from "node:events";
import { appendFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSupportedThinkingLevels, hasApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelInfoState } from "../shared/dashboard-state.ts";
import { MODEL_INFO_CHANNEL, REFRESH_CHANNEL } from "../shared/dashboard-state.ts";
import modelInfo from "./index.ts";

// Never load real providers, credentials, settings, or write the error log.
vi.mock("node:fs", () => ({ appendFileSync: vi.fn() }));
vi.mock("@earendil-works/pi-ai", () => ({
  uuidv7: vi.fn((() => {
    let sequence = 0;
    return () => `test-summary-${++sequence}`;
  })()),
  hasApi: vi.fn((model, api) => model.api === api),
  getSupportedThinkingLevels: vi.fn((model) =>
    model.reasoning
      ? ["off", "minimal", "low", "medium", "high"].filter((level) => model.thinkingLevelMap?.[level] !== null)
      : ["off"],
  ),
}));

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Entry = Record<string, any>;
const REQUEST = "Fix the dashboard title lifecycle";
const hash = (text: string) => createHash("sha256").update(`v1\0${text.slice(0, 8000)}`).digest("hex");
const usage = (cost: number, output = 20) => ({
  input: 10, output, cacheRead: 2, cacheWrite: 3, totalTokens: 15 + output,
  cost: { input: cost / 4, output: cost / 4, cacheRead: cost / 4, cacheWrite: cost / 4, total: cost },
});
const response = (text = "Dashboard title lifecycle", cost = 0.25, output = 20) => ({
  role: "assistant", content: [{ type: "text", text }], usage: usage(cost, output),
  api: "openai-responses", provider: "fake", model: "fake-model", stopReason: "stop", timestamp: Date.now(),
});
const user = (text = REQUEST): Entry => ({ type: "message", message: { role: "user", content: text, timestamp: Date.now() } });
const titleEntry = (text: string, summary: string | null, cost = 0.25): Entry => ({
  type: "custom", customType: "model-info:title", data: { version: 1, requestHash: hash(text), summary, cost },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// Drain async continuations without advancing a fallback, backoff, or deadline.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const fixtures: { close: () => Promise<void> }[] = [];
function fixture(options: { entries?: Entry[]; branch?: Entry[]; mode?: string; model?: Record<string, any> } = {}) {
  const entries = options.entries ?? [user()];
  let branch = options.branch ?? [...entries];
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<(data?: unknown) => void>>();
  const states: ModelInfoState[] = [];
  const complete = vi.fn<(...args: any[]) => Promise<ReturnType<typeof response>>>().mockResolvedValue(response());
  const appendEntry = vi.fn((customType: string, data: unknown) => {
    const entry = { type: "custom", id: `custom-${entries.length}`, customType, data };
    entries.push(entry);
    branch.push(entry);
  });
  const events = {
    emit: vi.fn((name: string, data?: unknown) => {
      if (name === MODEL_INFO_CHANNEL) states.push({ ...(data as ModelInfoState) });
      for (const listener of listeners.get(name) ?? []) listener(data);
    }),
    on: vi.fn((name: string, listener: (data?: unknown) => void) => {
      const set = listeners.get(name) ?? new Set();
      listeners.set(name, set);
      set.add(listener);
      return () => { set.delete(listener); };
    }),
  };
  const ctx = {
    mode: options.mode ?? "tui",
    signal: undefined as AbortSignal | undefined,
    hasUI: options.mode === undefined || options.mode === "tui" || options.mode === "rpc",
    model: { id: "proxy-reasoner", name: "Fake model", provider: "fake", api: "openai-responses",
      reasoning: true, contextWindow: 128000, ...options.model },
    modelRegistry: { complete, hasConfiguredAuth: vi.fn(() => true) },
    sessionManager: {
      getEntries: vi.fn(() => entries), getBranch: vi.fn(() => branch),
      getSessionId: () => "fake-session", getSessionFile: () => undefined,
    },
    getContextUsage: vi.fn(() => ({ tokens: 3200, contextWindow: 128000, percent: 2.5 })),
    ui: { setTitle: vi.fn() },
  };
  const api = { on: (name: string, handler: Handler) => handlers.set(name, handler), events, appendEntry,
    getThinkingLevel: vi.fn(() => "high") };
  modelInfo(api as unknown as ExtensionAPI);
  const f = {
    ctx, api, handlers, entries, states, complete, appendEntry,
    get state() { expect(states.length).toBeGreaterThan(0); return states.at(-1)!; },
    setBranch(value: Entry[]) { branch = [...value]; },
    async emit(name: string, event: Record<string, unknown> = {}) {
      const handler = handlers.get(name);
      expect(handler, `registered ${name} handler`).toBeTypeOf("function");
      await handler!({ type: name, ...event }, ctx as unknown as ExtensionContext);
      await flush();
    },
    async delta(type = "text_delta", delta = "working") {
      await f.emit("message_update", { message: response(), assistantMessageEvent: { type, delta } });
    },
    async start() { await f.emit("session_start", { reason: "startup" }); },
    async close() { await f.emit("session_shutdown", { reason: "quit" }); },
    refresh() { events.emit(REFRESH_CHANNEL); },
    refreshListeners() { return [...(listeners.get(REFRESH_CHANNEL) ?? [])]; },
  };
  fixtures.push(f);
  return f;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  vi.clearAllMocks();
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  await flush();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("summary scheduling and lifecycle", () => {
  it("does no factory/startup work and waits for a meaningful delta after the user message", async () => {
    const f = fixture({ entries: [] });
    expect(vi.getTimerCount()).toBe(0);
    expect(f.complete).not.toHaveBeenCalled();
    await f.start();
    const first = user();
    f.entries.push(first);
    f.setBranch([first]);
    await f.emit("message_start", { message: first.message });
    await f.emit("agent_start");
    await f.delta("text_delta", "");
    await f.delta("text_start", "ignored");
    expect(f.complete).not.toHaveBeenCalled();
    await f.delta();
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.state.summary).toBe("Dashboard title lifecycle");
  });

  it.each(["restored", "live"])("uses the first textual request after image-only and empty %s user entries", async (source) => {
    const image = user();
    image.message.content = [{ type: "image", data: "fake-image", mimeType: "image/png" }];
    const empty = user("   ");
    const firstText = user();
    firstText.message.content = [{ type: "text", text: `  ${REQUEST}  ` }];
    const laterText = user("A later unrelated request");
    const all = [image, empty, firstText, laterText];
    const f = fixture({ entries: source === "restored" ? all : [] });
    await f.start();
    if (source === "live") {
      for (const entry of all) {
        f.entries.push(entry);
        f.setBranch([...f.entries]);
        await f.emit("message_start", { message: entry.message });
        if (entry === image || entry === empty) {
          await f.emit("turn_start");
          await f.delta();
          await f.emit("agent_settled");
          expect(f.complete).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(0);
        }
      }
    }
    expect(f.complete).not.toHaveBeenCalled();
    await f.delta();
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.complete.mock.calls[0]![1].messages[0].content[0].text).toBe(`USER REQUEST:\n${REQUEST}`);
    expect(f.appendEntry).toHaveBeenCalledExactlyOnceWith("model-info:title", expect.objectContaining({
      requestHash: hash(REQUEST), summary: "Dashboard title lifecycle",
    }));
  });

  it.each(["text_delta", "thinking_delta", "toolcall_delta"])("starts once on %s and cancels the fallback", async (kind) => {
    const f = fixture();
    await f.start();
    await f.emit("turn_start");
    expect(vi.getTimerCount()).toBe(1);
    await f.delta(kind);
    expect(vi.getTimerCount()).toBe(0);
    await f.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tracks a single fallback and starts it at 1000ms", async () => {
    const f = fixture();
    await f.start();
    await f.emit("turn_start");
    await f.emit("turn_start");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses agent_settled as a last-resort trigger", async () => {
    const f = fixture();
    await f.start();
    expect(f.complete).not.toHaveBeenCalled();
    await f.emit("agent_settled");
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.state.generating).toBe(false);
  });

  it("cancels an old fallback on session_start reset without generating at startup", async () => {
    const f = fixture();
    await f.start();
    await f.emit("turn_start");
    await f.emit("session_start", { reason: "reload" });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("regression: shutdown clears the pending fallback and permanently guards every stale handler", async () => {
    const f = fixture();
    await f.start();
    await f.emit("turn_start");
    const staleRefresh = f.refreshListeners()[0]!;
    await f.close();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.refreshListeners()).toHaveLength(0);
    const publicationCount = f.states.length;
    const reads = f.ctx.sessionManager.getEntries.mock.calls.length;
    // Deliberately invalid payload/context: disposed handlers must return before accessing either.
    const staleContext = new Proxy({}, { get() { throw new Error("stale context accessed"); } });
    for (const [name, handler] of f.handlers) {
      await expect(Promise.resolve().then(() => handler({ type: name }, staleContext as ExtensionContext)))
        .resolves.toBeUndefined();
    }
    staleRefresh();
    f.refresh();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.states).toHaveLength(publicationCount);
    expect(f.ctx.sessionManager.getEntries).toHaveBeenCalledTimes(reads);
  });

  it.each(["print", "json", "rpc"])("never starts title generation in %s mode (RPC hasUI is true)", async (mode) => {
    const f = fixture({ mode });
    await f.start();
    await f.emit("agent_start");
    await f.emit("turn_start");
    await f.delta();
    await f.delta("toolcall_delta");
    await f.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.ctx.ui.setTitle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bounded, observed async work", () => {
  it.each(["pending provider", "retry backoff"])("links turn abort during %s and cleans both signals and all timers", async (phase) => {
    const f = fixture();
    const turn = new AbortController();
    f.ctx.signal = turn.signal;
    const pending = deferred<ReturnType<typeof response>>();
    if (phase === "pending provider") f.complete.mockReturnValue(pending.promise);
    else f.complete.mockResolvedValue(response("", 0.1));
    await f.start();
    await f.delta();
    const signal = f.complete.mock.calls[0]![2].signal as AbortSignal;
    expect(signal).not.toBe(turn.signal);
    expect(f.state.summarizing).toBe(true);
    expect(getEventListeners(turn.signal, "abort")).toHaveLength(1);
    turn.abort(new Error("user cancelled the turn"));
    await flush();
    expect(signal.aborted).toBe(true);
    expect(f.state).toMatchObject({ summary: null, summarizing: false, cost: phase === "pending provider" ? 0 : 0.1 });
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(getEventListeners(turn.signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    const publications = f.states.length;
    if (phase === "pending provider") pending.reject(new Error("late failure despite turn abort"));
    await flush();
    await nextTurn();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.states).toHaveLength(publications);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.appendEntry).toHaveBeenCalledTimes(phase === "pending provider" ? 0 : 1);
    await f.emit("agent_settled");
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it.each(["error", "aborted"])("discards text from a %s response but records its usage and retries", async (stopReason) => {
    const f = fixture();
    f.complete.mockResolvedValueOnce({ ...response("Not a valid title", 0.1), stopReason })
      .mockResolvedValueOnce(response("Recovered topic", 0.2));
    await f.start();
    await f.delta();
    expect(f.state).toMatchObject({ summary: null, summarizing: true, cost: 0.1 });
    expect(f.appendEntry).toHaveBeenCalledExactlyOnceWith("model-info:title", expect.objectContaining({
      version: 1, requestHash: hash(REQUEST), summary: null, cost: 0.1,
    }));
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.state).toMatchObject({ summary: "Recovered topic", summarizing: false });
    expect(f.state.cost).toBeCloseTo(0.3);
    expect(f.appendEntry).toHaveBeenNthCalledWith(2, "model-info:title", expect.objectContaining({
      version: 1, requestHash: hash(REQUEST), summary: "Recovered topic", cost: 0.2,
    }));
    expect(f.states.every((state) => state.summary !== "Not a valid title")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject"] as const)("ignores late provider %s after shutdown, even when it ignores abort", async (settle) => {
    const f = fixture();
    const pending = deferred<ReturnType<typeof response>>();
    f.complete.mockReturnValue(pending.promise);
    await f.start();
    await f.delta();
    const signal = f.complete.mock.calls[0]![2].signal as AbortSignal;
    expect(f.state.summarizing).toBe(true);
    await f.close();
    const count = f.states.length;
    expect(signal.aborted).toBe(true);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    if (settle === "resolve") pending.resolve(response("Stale title", 99));
    else pending.reject(new Error("provider failed after shutdown"));
    await flush();
    // A real event-loop turn lets Vitest observe any unhandled rejection.
    await nextTurn();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.states).toHaveLength(count);
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("ends the spinner at the 30s total deadline despite an uncooperative provider", async () => {
    const f = fixture();
    const pending = deferred<ReturnType<typeof response>>();
    f.complete.mockReturnValue(pending.promise);
    await f.start();
    await f.delta();
    const signal = f.complete.mock.calls[0]![2].signal as AbortSignal;
    await vi.advanceTimersByTimeAsync(29999);
    expect(f.state.summarizing).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(f.state).toMatchObject({ summarizing: false, summary: null });
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    const count = f.states.length;
    pending.reject(new Error("late deadline failure"));
    await flush();
    await nextTurn();
    await f.emit("agent_settled");
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(f.states.slice(count).every((state) => !state.summarizing && state.summary === null)).toBe(true);
  });

  it("uses one total deadline including provider time and backoff, not 30s per attempt", async () => {
    const f = fixture();
    const first = deferred<ReturnType<typeof response>>();
    const second = deferred<ReturnType<typeof response>>();
    f.complete.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await f.start();
    await f.delta();
    await vi.advanceTimersByTimeAsync(27000);
    first.resolve(response("", 0.1));
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.complete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.state.summarizing).toBe(false);
    expect(f.complete.mock.calls[1]![2].signal.aborted).toBe(true);
    second.resolve(response("Too late", 99));
    await flush();
    expect(f.appendEntry).toHaveBeenCalledTimes(1);
    expect(f.state.cost).toBeCloseTo(0.1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("makes exactly three empty-response attempts at 0s, 2s, 6s and records every cost", async () => {
    const f = fixture();
    f.complete.mockResolvedValue(response("", 0.1));
    await f.start();
    await f.delta();
    expect(f.complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(f.complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.complete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(f.complete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.complete).toHaveBeenCalledTimes(3);
    expect(f.state).toMatchObject({ summarizing: false, summary: null });
    expect(f.state.cost).toBeCloseTo(0.3);
    expect(f.appendEntry.mock.calls).toEqual(Array.from({ length: 3 }, () => ["model-info:title",
      expect.objectContaining({ version: 1, requestHash: hash(REQUEST), summary: null, cost: 0.1 })]));
    const signal = f.complete.mock.calls[0]![2].signal as AbortSignal;
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await f.emit("agent_settled");
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.complete).toHaveBeenCalledTimes(3);
  });

  it.each(["session_start", "session_shutdown"])("cancels retry backoff and listeners on %s", async (event) => {
    const f = fixture();
    f.complete.mockResolvedValue(response("", 0.1));
    await f.start();
    await f.delta();
    const signal = f.complete.mock.calls[0]![2].signal as AbortSignal;
    await f.emit(event);
    expect(signal.aborted).toBe(true);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.appendEntry).toHaveBeenCalledTimes(1);
  });

  it.each(["initial", "final"])("observes %s publication failures without leaving a spinner or unhandled rejection", async (phase) => {
    const f = fixture();
    await f.start();
    const original = f.api.events.emit.getMockImplementation()!;
    f.api.events.emit.mockImplementation((name, data) => {
      if (name === MODEL_INFO_CHANNEL && (phase === "initial" ? (data as ModelInfoState).summarizing : (data as ModelInfoState).summary !== null)) {
        throw new Error(`${phase} dashboard publication failed`);
      }
      original(name, data);
    });
    await f.delta();
    await flush();
    await nextTurn();
    expect(vi.getTimerCount()).toBe(0);
    f.api.events.emit.mockImplementation(original);
    f.refresh();
    expect(f.state.summarizing).toBe(false);
    expect(appendFileSync).toHaveBeenCalled();
  });

  it("observes even publication failures whose error cannot be stringified", async () => {
    const f = fixture();
    await f.start();
    f.api.events.emit.mockImplementation(() => { throw { toString() { throw new Error("broken error formatter"); } }; });
    await f.delta();
    await nextTurn();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("handles synchronous completion errors without retrying or persisting fictional usage", async () => {
    const f = fixture();
    f.complete.mockImplementation(() => { throw new Error("provider setup failed"); });
    await f.start();
    await f.delta();
    expect(f.state).toMatchObject({ summarizing: false, summary: null, cost: 0 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.appendEntry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("durable titles and complete accounting", () => {
  it("persists a cleaned successful title and restores it in a fresh extension on reload", async () => {
    const f = fixture();
    f.complete.mockResolvedValue(response('  "Dashboard\n title lifecycle."  ', 0.4));
    await f.start();
    await f.delta();
    expect(f.appendEntry).toHaveBeenCalledExactlyOnceWith("model-info:title", expect.objectContaining({
      version: 1, requestHash: hash(REQUEST), summary: "Dashboard title lifecycle", cost: 0.4,
    }));
    expect(f.state).toMatchObject({ summary: "Dashboard title lifecycle", summarizing: false, cost: 0.4 });
    f.refresh();
    f.refresh();
    expect(f.state.cost).toBe(0.4); // persisted and live accounting must not double-count
    await f.close();
    const reloaded = fixture({ entries: [...f.entries] });
    await reloaded.emit("session_start", { reason: "reload" });
    expect(reloaded.state.summary).toBe("Dashboard title lifecycle");
    expect(reloaded.state.cost).toBe(0.4);
    await reloaded.delta();
    await reloaded.emit("turn_start");
    await reloaded.emit("agent_settled");
    expect(reloaded.complete).not.toHaveBeenCalled();
    expect(reloaded.appendEntry).not.toHaveBeenCalled();
  });

  it("records empty attempts separately before success and restores their combined cost", async () => {
    const f = fixture();
    f.complete.mockResolvedValueOnce(response("", 0.1)).mockResolvedValueOnce(response("Useful topic", 0.2));
    await f.start();
    await f.delta();
    expect(f.appendEntry).toHaveBeenCalledExactlyOnceWith("model-info:title", expect.objectContaining({
      version: 1, requestHash: hash(REQUEST), summary: null, cost: 0.1,
    }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.appendEntry).toHaveBeenCalledTimes(2);
    expect(f.state.summary).toBe("Useful topic");
    expect(f.state.cost).toBeCloseTo(0.3);
    await f.close();
    const reloaded = fixture({ entries: [...f.entries] });
    await reloaded.start();
    expect(reloaded.state.summary).toBe("Useful topic");
    expect(reloaded.state.cost).toBeCloseTo(0.3);
    await reloaded.delta();
    expect(reloaded.complete).not.toHaveBeenCalled();
  });

  it("an empty persisted attempt contributes cost but is not a successful title cache", async () => {
    const f = fixture({ entries: [user(), titleEntry(REQUEST, null, 0.1)] });
    await f.start();
    expect(f.state).toMatchObject({ summary: null, cost: 0.1 });
    expect(f.complete).not.toHaveBeenCalled();
    await f.delta();
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.state.summary).toBe("Dashboard title lifecycle");
    expect(f.state.cost).toBeCloseTo(0.35);
  });

  it("keys the title and sent first request by the same 8000-character SHA256 input", async () => {
    const text = "x".repeat(8000) + "never sent";
    const f = fixture({ entries: [user(text)] });
    await f.start();
    await f.delta();
    expect(f.appendEntry.mock.calls[0]![1]).toMatchObject({ requestHash: hash(text) });
    const prompt = f.complete.mock.calls[0]![1].messages[0].content[0].text;
    expect(prompt).toBe(`USER REQUEST:\n${"x".repeat(8000)}`);
    f.setBranch([user("x".repeat(8000) + "different suffix")]);
    await f.emit("session_tree");
    await f.delta();
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("restores matching cached titles across branch navigation, not the latest unrelated title", async () => {
    const a = user("Request A");
    const b = user("Request B");
    const f = fixture({ entries: [a, titleEntry("Request A", "Title A", 0.1), b, titleEntry("Request B", "Title B", 0.2)], branch: [a] });
    await f.start();
    expect(f.state.summary).toBe("Title A");
    f.setBranch([b]);
    await f.emit("session_tree");
    expect(f.state.summary).toBe("Title B");
    f.setBranch([a]);
    await f.emit("session_tree");
    expect(f.state.summary).toBe("Title A");
    await f.delta();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.state.cost).toBeCloseTo(0.3);
  });

  it("cancels an old in-flight request when the first request changes and ignores its late success", async () => {
    const f = fixture();
    const old = deferred<ReturnType<typeof response>>();
    f.complete.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response("New topic", 0.2));
    await f.start();
    await f.delta();
    const signal = f.complete.mock.calls[0]![2].signal as AbortSignal;
    const replacement = user("A different first request");
    f.entries.push(replacement);
    f.setBranch([replacement]);
    await f.emit("session_tree");
    expect(signal.aborted).toBe(true);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(f.state).toMatchObject({ summary: null, summarizing: false });
    expect(f.complete).toHaveBeenCalledTimes(1); // navigation alone must not generate
    await f.delta();
    old.resolve(response("Obsolete title", 99));
    await flush();
    expect(f.state).toMatchObject({ summary: "New topic", cost: 0.2 });
    expect(f.appendEntry).toHaveBeenCalledTimes(1);
    expect(f.appendEntry.mock.calls[0]![1]).toMatchObject({ requestHash: hash("A different first request") });
  });

  it("cancels old work and restores an already cached replacement request immediately", async () => {
    const b = user("Cached request");
    const f = fixture({ entries: [user(), b, titleEntry("Cached request", "Cached topic", 0.3)], branch: [user()] });
    const old = deferred<ReturnType<typeof response>>();
    f.complete.mockReturnValue(old.promise);
    await f.start();
    await f.delta();
    f.setBranch([b]);
    await f.emit("session_tree");
    expect(f.state).toMatchObject({ summary: "Cached topic", summarizing: false, cost: 0.3 });
    old.reject(new Error("old branch failed late"));
    await flush();
    await nextTurn();
    await f.delta();
    expect(f.complete).toHaveBeenCalledTimes(1);
    expect(f.appendEntry).not.toHaveBeenCalled();
  });

  it("retains live returned cost when appendEntry fails, including after refresh", async () => {
    const f = fixture();
    f.appendEntry.mockImplementation(() => { throw new Error("persistence unavailable"); });
    await f.start();
    await f.delta();
    expect(f.state).toMatchObject({ summary: "Dashboard title lifecycle", cost: 0.25, summarizing: false });
    f.refresh();
    await f.emit("turn_end");
    expect(f.state.cost).toBe(0.25);
    expect(f.appendEntry).toHaveBeenCalledTimes(1);
    expect(appendFileSync).toHaveBeenCalled();
  });

  it("does not double-count when appendEntry records the attempt before throwing", async () => {
    const f = fixture();
    f.appendEntry.mockImplementation((customType, data) => {
      f.entries.push({ type: "custom", customType, data });
      throw new Error("post-commit persistence failure");
    });
    await f.start();
    await f.delta();
    expect(f.state.cost).toBe(.25);
    f.refresh();
    expect(f.state.cost).toBe(.25);
    expect(f.state.summary).toBe("Dashboard title lifecycle");
  });

  it("counts all session assistant/tool/compaction/branch-summary/title usage once, not retained-tail copies", async () => {
    const first = user();
    const assistant = { type: "message", message: response("old assistant", 1) };
    const tool = { type: "message", message: { role: "toolResult", content: [], usage: usage(2) } };
    const compact = { type: "compaction", summary: "compacted", usage: usage(4), retainedTail: [assistant.message, tool.message] };
    const branchSummary = { type: "branch_summary", summary: "other branch", usage: usage(8) };
    const f = fixture({ entries: [first, assistant, tool, compact, branchSummary,
      titleEntry(REQUEST, "Saved title", 16), titleEntry("other request", null, 32),
      { type: "message", message: { role: "toolResult", content: [] } },
      { type: "compaction", summary: "legacy without usage" },
    ], branch: [first, compact] });
    await f.start();
    expect(f.state.cost).toBe(63);
    expect(f.ctx.sessionManager.getEntries).toHaveBeenCalled();
    f.setBranch([first, branchSummary]);
    await f.emit("session_tree");
    expect(f.state.cost).toBe(63);
    expect(f.complete).not.toHaveBeenCalled();
  });

  it.each(["message_end", "session_compact", "session_tree"])("refreshes accounting immediately after %s", async (event) => {
    const f = fixture();
    await f.start();
    const tool = { role: "toolResult", content: [], usage: usage(2) };
    const entry = event === "message_end" ? { type: "message", message: tool }
      : { type: event === "session_compact" ? "compaction" : "branch_summary", summary: "summary", usage: usage(2) };
    f.entries.push(entry);
    await f.emit(event, { message: tool, compactionEntry: entry, summaryEntry: entry });
    expect(f.state.cost).toBe(2);
    expect(f.complete).not.toHaveBeenCalled();
  });
});

describe("model capability routing", () => {
  it.each(["openai-responses", "openai-completions", "openai-codex-responses", "azure-openai-responses"])("uses low reasoning for a capable %s model with a non-GPT id", async (api) => {
    const f = fixture({ model: { api, id: "corporate-proxy-alias" } });
    await f.start();
    await f.delta();
    expect(f.complete.mock.calls[0]![0]).toBe(f.ctx.model);
    expect(f.complete.mock.calls[0]![2]).toMatchObject({ reasoningEffort: "low", maxTokens: 2048, cacheRetention: "none" });
    expect(getSupportedThinkingLevels).toHaveBeenCalledWith(f.ctx.model);
    expect(hasApi).toHaveBeenCalled();
  });

  it.each([
    { api: "anthropic-messages", id: "gpt-5.4-proxy", reasoning: true },
    { api: "openai-responses", id: "gpt-5.4", reasoning: false },
    { api: "openai-responses", id: "gpt-5.4", reasoning: true, thinkingLevelMap: { low: null } },
  ])("does not infer low reasoning from the id: %j", async (model) => {
    const f = fixture({ model });
    await f.start();
    await f.delta();
    expect(f.complete.mock.calls[0]![2]).not.toHaveProperty("reasoningEffort");
  });

  it("does not call an unauthenticated model and clears generation state", async () => {
    const f = fixture();
    f.ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
    await f.start();
    await f.delta();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.state.summarizing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("TPS measurements", () => {
  it("excludes the first chunk and post-stream latency, then uses final output token usage", async () => {
    const f = fixture({ mode: "print" });
    await f.start();
    await f.emit("agent_start");
    await f.delta("text_delta", "12345678"); // first two estimated tokens are excluded
    expect(f.state.tokensPerSecond).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    await f.delta("text_delta", "1234567890123456"); // four estimated tokens / second
    expect(f.state.tokensPerSecond).toBe(4);
    await vi.advanceTimersByTimeAsync(5000); // network/stop latency is not streaming time
    await f.emit("message_end", { message: response("done", 0, 12) });
    expect(f.state.tokensPerSecond).toBe(10);
  });

  it("uses estimated content rather than tool argument output tokens for tool-call messages", async () => {
    const f = fixture({ mode: "print" });
    await f.start();
    await f.emit("agent_start");
    await f.delta("thinking_delta", "12345678");
    await vi.advanceTimersByTimeAsync(1000);
    await f.delta("text_delta", "1234567890123456");
    await f.delta("toolcall_delta", "lots of tool arguments");
    await f.emit("message_end", { message: response("done", 0, 200) });
    expect(f.state.tokensPerSecond).toBe(4);
  });

  it("weights multiple message rates by streaming duration rather than averaging TPS or counting pauses", async () => {
    const f = fixture({ mode: "print" });
    await f.start();
    await f.emit("agent_start");
    await f.delta("text_delta", "1234");
    await vi.advanceTimersByTimeAsync(1000);
    await f.delta("text_delta", "1234");
    await f.emit("message_end", { message: response("first", 0, 11) }); // 10 tokens / 1s
    await vi.advanceTimersByTimeAsync(10000);
    await f.emit("message_start", { message: response() });
    await f.delta("text_delta", "1234");
    await vi.advanceTimersByTimeAsync(3000);
    await f.delta("text_delta", "1234");
    await f.emit("message_end", { message: response("second", 0, 61) }); // 60 tokens / 3s
    expect(f.state.tokensPerSecond).toBe(17.5); // 70 / 4, not 15 or 70 / 14
  });

  it.each([0, 49])("does not manufacture TPS from a single chunk followed by %ims latency", async (ms) => {
    const f = fixture({ mode: "print" });
    await f.start();
    await f.emit("agent_start");
    await f.delta("text_delta", "1234");
    await vi.advanceTimersByTimeAsync(ms);
    await f.emit("message_end", { message: response("done", 0, 20) });
    expect(f.state.tokensPerSecond).toBeNull();
  });
});
