import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Editor,
  getKeybindings,
  isFocusable,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import askUser, { type AskUserInput } from "./index.ts";

type Result = Awaited<ReturnType<ToolDefinition["execute"]>>;
type Details = {
  question: string;
  options: string[];
  answer: string | null;
  wasCustom: boolean;
  cancelled: boolean;
  index?: number;
};
type Custom = ExtensionContext["ui"]["custom"];
type CustomFactory = Parameters<Custom>[0];
type ToolRenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
type Dialog = Component & { dispose?(): void };
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

const ESC = "\x1b";
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const bounds = { timeout: 2_000 };
const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;
const input = (question = "Pick one?"): AskUserInput => ({
  question,
  options: [{ label: "Alpha", description: "First choice" }, { label: "Beta" }],
});

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 600;
  while (!predicate() && Date.now() < deadline) await delay(1);
  assert.ok(predicate(), message);
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Operation did not settle within 600ms")), 600);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const details = (result: Result) => result.details as Details;
const text = (result: Result) => result.content
  .filter((part) => part.type === "text")
  .map((part) => part.text).join("\n");

function cancelled(result: Result) {
  assert.equal(text(result), "Cancelled");
  assert.equal(details(result).cancelled, true);
  assert.equal(details(result).answer, null);
  assert.equal(details(result).index, undefined);
}

interface Opening {
  component?: Dialog;
  doneCalls: number;
  closed: boolean;
  settled: boolean;
  mount(): Promise<void>;
  complete(): void;
  fail(error: Error): void;
  cancel(): void;
}

// This host deliberately separates done(), UI teardown, and custom() promise
// resolution. A queue must await the last of those, even when aborted.
class Host {
  openings: Opening[] = [];
  events: string[] = [];
  holdResolution = false;
  delayFactory = false;
  disposed = false;
  renders = 0;
  tui = {
    terminal: { rows: 40, columns: 120 },
    requestRender: () => { this.renders++; },
  } as unknown as TUI;

  custom: Custom = <T>(factory: Parameters<Custom>[0], options?: Parameters<Custom>[1]): Promise<T> => {
    if (this.disposed) return Promise.resolve(null as T);
    assert.notEqual(options?.overlay, true, "exercise the non-overlay UI contract");
    const id = this.openings.length;
    this.events.push(`open:${id}`);
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    let value: unknown;
    let mounted = false;
    const close = () => {
      if (opening.closed) return;
      opening.closed = true;
      this.events.push(`close:${id}`);
      opening.component?.dispose?.();
    };
    const done = (result: unknown) => {
      opening.doneCalls++;
      if (opening.doneCalls !== 1) return;
      value = result;
      close();
      if (!this.holdResolution) opening.complete();
    };
    const opening: Opening = {
      doneCalls: 0, closed: false, settled: false,
      mount: async () => {
        if (mounted) return;
        mounted = true;
        try {
          opening.component = await factory(
            this.tui, theme,
            getKeybindings() as unknown as Parameters<CustomFactory>[2],
            done,
          );
          if (opening.closed) opening.component.dispose?.();
        } catch (error) {
          opening.fail(error instanceof Error ? error : new Error(String(error)));
        }
      },
      complete: () => {
        if (opening.settled) return;
        assert.ok(opening.doneCalls > 0, "host cannot resolve before done");
        opening.settled = true;
        this.events.push(`resolve:${id}`);
        resolve(value as T);
      },
      fail: (error) => {
        if (opening.settled) return;
        close();
        opening.settled = true;
        this.events.push(`reject:${id}`);
        reject(error);
      },
      cancel: () => { if (!opening.doneCalls) done(null); opening.complete(); },
    };
    this.openings.push(opening);
    if (!this.delayFactory) void opening.mount();
    return promise;
  };

  async opened(index = 0) {
    await until(() => !!this.openings[index]?.component, `question ${index + 1} did not open`);
    return this.openings[index].component!;
  }

  async cleanup() {
    this.disposed = true;
    this.holdResolution = false;
    for (const opening of this.openings) {
      await opening.mount();
      opening.cancel();
    }
  }
}

function fixture(t: TestContext, host = new Host()) {
  let registered: ToolDefinition | undefined;
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool: ((tool) => { registered = tool as unknown as ToolDefinition; }) satisfies ExtensionAPI["registerTool"],
    on: ((event: string, handler: Handler) => { handlers.set(event, handler); }) as ExtensionAPI["on"],
  } satisfies Pick<ExtensionAPI, "registerTool" | "on">;
  askUser(fake as ExtensionAPI);
  assert.ok(registered, "extension must register its real tool");
  const tool = registered;
  assert.equal(tool.name, "ask_user");
  const ctx = { mode: "tui", hasUI: true, ui: { custom: host.custom } } as unknown as ExtensionContext;
  const controllers: AbortController[] = [];
  const pending: Promise<Result>[] = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    await host.cleanup();
    await bounded(Promise.allSettled(pending));
  });
  return {
    host, tool, ctx,
    call(params = input(), controller = new AbortController(), context = ctx) {
      controllers.push(controller);
      const promise = tool.execute(`call-${pending.length}`, params, controller.signal, undefined, context);
      // Attach immediately so intentional rejection tests cannot leak unhandled errors.
      void promise.catch(() => {});
      pending.push(promise);
      return promise;
    },
    shutdown() {
      const handler = handlers.get("session_shutdown");
      assert.ok(handler, "must register shutdown cleanup");
      return Promise.resolve(handler({ type: "session_shutdown", reason: "quit" }, ctx));
    },
    render(result: Result) {
      assert.ok(tool.renderResult);
      const context: ToolRenderContext = {
        args: input(), toolCallId: "render", invalidate() {}, lastComponent: undefined,
        state: {}, cwd: "/unused", executionStarted: true, argsComplete: true,
        isPartial: false, expanded: false, showImages: false, isError: false,
      };
      return tool.renderResult(result, { expanded: false, isPartial: false }, theme, context)
        .render(120).map(stripVTControlCharacters).join("\n").trimEnd();
    },
  };
}

function press(component: Dialog, ...keys: string[]) {
  assert.ok(component.handleInput);
  for (const key of keys) component.handleInput(key);
}

function fits(component: Dialog, width: number) {
  const lines = component.render(width);
  assert.ok(lines.length < 2_000, "render must remain bounded");
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width,
      `width ${width}: ${visibleWidth(line)} cells in ${JSON.stringify(line)}`);
  }
  return lines;
}

test("number keys choose immediately and preserve a one-based index", bounds, async (t) => {
  const f = fixture(t);
  const promise = f.call();
  press(await f.host.opened(), "2");
  const result = await bounded(promise);
  assert.equal(text(result), "User selected option 2: Beta");
  assert.deepEqual(details(result), {
    question: "Pick one?", options: ["Alpha", "Beta"], answer: "Beta",
    wasCustom: false, cancelled: false, index: 2,
  });
  assert.equal(f.render(result), "✓ 2. Beta");
});

test("arrow navigation wraps and Enter confirms without number input", bounds, async (t) => {
  const f = fixture(t);
  const promise = f.call();
  const dialog = await f.host.opened();
  press(dialog, UP, DOWN, DOWN, ENTER);
  assert.equal(details(await bounded(promise)).answer, "Beta");
});

test("free-form choice uses the real Editor, trims text, and carries no index", bounds, async (t) => {
  const f = fixture(t);
  const promise = f.call();
  const dialog = await f.host.opened();
  press(dialog, "3", "  My own answer  ", ENTER);
  const result = await bounded(promise);
  assert.equal(details(result).answer, "My own answer");
  assert.equal(details(result).wasCustom, true);
  assert.equal(details(result).cancelled, false);
  assert.equal(details(result).index, undefined);
  assert.equal(f.render(result), "✓ (wrote) My own answer");
});

test("Escape in editor clears draft and returns to choices; Escape there dismisses", bounds, async (t) => {
  const f = fixture(t);
  const promise = f.call();
  const dialog = await f.host.opened();
  press(dialog, "3", "discard this draft", ESC);
  assert.equal(f.host.openings[0].doneCalls, 0);
  press(dialog, "3");
  assert.doesNotMatch(dialog.render(120).join("\n"), /discard this draft/);
  press(dialog, ESC, ESC);
  const result = await bounded(promise);
  assert.match(text(result), /dismissed the question without answering/);
  assert.equal(details(result).answer, null);
  assert.equal(details(result).cancelled, true);
  assert.equal(f.render(result), "✗ dismissed");
});

test("empty or whitespace editor submission returns to choices without settling", bounds, async (t) => {
  const f = fixture(t);
  const promise = f.call();
  const dialog = await f.host.opened();
  for (const value of ["", "   "]) {
    press(dialog, "3", value, ENTER);
    assert.equal(f.host.openings[0].doneCalls, 0);
    assert.doesNotMatch(dialog.render(120).join("\n"), /Your answer:/);
  }
  press(dialog, "1");
  assert.equal(details(await bounded(promise)).answer, "Alpha");
});

test("invalid number input is ignored and a dialog only settles once", bounds, async (t) => {
  const f = fixture(t);
  const promise = f.call();
  const dialog = await f.host.opened();
  press(dialog, "0", "9", "x");
  assert.equal(f.host.openings[0].doneCalls, 0);
  press(dialog, ENTER, ESC, "2");
  assert.equal(f.host.openings[0].doneCalls, 1);
  assert.equal(details(await bounded(promise)).answer, "Alpha");
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`${mode} returns no-UI guidance without opening custom UI`, bounds, async (t) => {
    const f = fixture(t);
    const result = await bounded(f.call(input(), undefined, { ...f.ctx, mode, hasUI: mode === "rpc" }));
    assert.match(text(result), /No interactive UI is available/);
    assert.equal(details(result).cancelled, true);
    assert.equal(f.host.openings.length, 0);
  });
}

for (const count of [0, 1, 6]) {
  test(`rejects ${count} model options before touching UI`, bounds, async (t) => {
    const f = fixture(t);
    await assert.rejects(bounded(f.call({ question: "Invalid?", options: Array.from({ length: count }, () => ({ label: "x" })) })),
      /requires between 2 and 5 options/);
    assert.equal(f.host.openings.length, 0);
  });
}

test("five options remain valid and sixth number opens the custom editor", bounds, async (t) => {
  const f = fixture(t);
  const promise = f.call({ question: "Five?", options: Array.from({ length: 5 }, (_, i) => ({ label: `Choice ${i + 1}` })) });
  press(await f.host.opened(), "6", "sixth is custom", ENTER);
  assert.equal(details(await bounded(promise)).wasCustom, true);
});

test("concurrent calls serialize FIFO until each custom promise resolves", bounds, async (t) => {
  const f = fixture(t);
  f.host.holdResolution = true;
  const first = f.call(input("First?"));
  const second = f.call(input("Second?"));
  const third = f.call(input("Third?"));
  const dialog = await f.host.opened();
  await delay(10);
  assert.equal(f.host.openings.length, 1, "second call must not replace first");
  assert.match(dialog.render(120).join("\n"), /First\?/);
  press(dialog, "1");
  await delay(10);
  assert.equal(f.host.openings.length, 1, "done alone must not release queue slot");
  f.host.openings[0].complete();
  assert.equal(details(await bounded(first)).question, "First?");
  const next = await f.host.opened(1);
  assert.match(next.render(120).join("\n"), /Second\?/);
  press(next, "2");
  f.host.openings[1].complete();
  assert.equal(details(await bounded(second)).question, "Second?");
  press(await f.host.opened(2), "1");
  f.host.openings[2].complete();
  assert.equal(details(await bounded(third)).question, "Third?");
  assert.deepEqual(f.host.events, [
    "open:0", "close:0", "resolve:0", "open:1", "close:1", "resolve:1", "open:2", "close:2", "resolve:2",
  ]);
});

test("queue is local to each extension instance", bounds, async (t) => {
  const a = fixture(t);
  const b = fixture(t);
  const pa = a.call();
  const pb = b.call();
  const [da, db] = await Promise.all([a.host.opened(), b.host.opened()]);
  press(da, "1");
  press(db, "2");
  assert.equal(details(await bounded(pa)).answer, "Alpha");
  assert.equal(details(await bounded(pb)).answer, "Beta");
});

test("pre-aborted calls return Cancelled without opening UI or blocking next call", bounds, async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  cancelled(await bounded(f.call(input(), controller)));
  assert.equal(f.host.openings.length, 0);
  const next = f.call();
  press(await f.host.opened(), "1");
  await bounded(next);
});

test("queued abort returns promptly without displaying and preserves remaining FIFO order", bounds, async (t) => {
  const f = fixture(t);
  const first = f.call(input("First"));
  const controller = new AbortController();
  const skipped = f.call(input("Must not display"), controller);
  const last = f.call(input("Last"));
  const dialog = await f.host.opened();
  controller.abort();
  cancelled(await bounded(skipped));
  assert.equal(f.host.openings.length, 1);
  press(dialog, "1");
  await bounded(first);
  const next = await f.host.opened(1);
  assert.match(next.render(120).join("\n"), /Last/);
  press(next, "2");
  await bounded(last);
  assert.equal(f.host.openings.length, 2);
});

test("active abort closes UI but holds queue until custom promise resolves after done", bounds, async (t) => {
  const f = fixture(t);
  f.host.holdResolution = true;
  const controller = new AbortController();
  const first = f.call(input("Abort me"), controller);
  await f.host.opened();
  const second = f.call(input("Next"));
  controller.abort();
  await until(() => f.host.openings[0].doneCalls === 1, "abort must close the active UI");
  assert.equal(f.host.openings[0].closed, true);
  assert.equal(f.host.openings[0].settled, false, "fake deliberately retains unresolved custom promise");
  await delay(15);
  assert.equal(f.host.openings.length, 1, "interruption must not release slot before custom settles");
  f.host.openings[0].complete();
  cancelled(await bounded(first));
  const next = await f.host.opened(1);
  press(next, "2");
  f.host.openings[1].complete();
  assert.equal(details(await bounded(second)).answer, "Beta");
  assert.ok(f.host.events.indexOf("resolve:0") < f.host.events.indexOf("open:1"));
});

test("custom rejection releases slot and does not poison subsequent requests", bounds, async (t) => {
  const f = fixture(t);
  const first = f.call();
  await f.host.opened();
  const second = f.call();
  f.host.openings[0].fail(new Error("UI failed"));
  await assert.rejects(bounded(first), /UI failed/);
  press(await f.host.opened(1), "2");
  assert.equal(details(await bounded(second)).answer, "Beta");
});

test("synchronous custom failure releases slot as well", bounds, async (t) => {
  const f = fixture(t);
  const broken = { ...f.ctx, ui: { ...f.ctx.ui, custom: (() => { throw new Error("factory failed"); }) as Custom } };
  const first = f.call(input(), undefined, broken);
  const second = f.call();
  await assert.rejects(bounded(first), /factory failed/);
  press(await f.host.opened(), "1");
  await bounded(second);
});

test("shutdown cancels active and queued calls and prevents late calls from opening UI", bounds, async (t) => {
  const f = fixture(t);
  const active = f.call();
  await f.host.opened();
  const queued = f.call(input("Queued"));
  await bounded(f.shutdown());
  cancelled(await bounded(active));
  cancelled(await bounded(queued));
  assert.equal(f.host.openings[0].doneCalls, 1);
  assert.equal(f.host.openings.length, 1);
  cancelled(await bounded(f.call(input("Too late"))));
  assert.equal(f.host.openings.length, 1);
  await bounded(f.shutdown());
});

test("shutdown racing a delayed custom factory closes it when it finally mounts", bounds, async (t) => {
  const f = fixture(t);
  f.host.delayFactory = true;
  const active = f.call();
  await until(() => f.host.openings.length === 1, "custom must be called");
  const queued = f.call(input("Queued"));
  const shutdown = f.shutdown();
  await f.host.openings[0].mount();
  await bounded(shutdown);
  cancelled(await bounded(active));
  cancelled(await bounded(queued));
  assert.equal(f.host.openings[0].doneCalls, 1);
  assert.equal(f.host.openings.length, 1);
});

for (const editing of [false, true]) {
  test(`resize cache respects width in ${editing ? "editor" : "option"} mode`, bounds, async (t) => {
    const f = fixture(t);
    const promise = f.call(input("Long question with Unicode 界界 e\u0301 and a descriptive suffix"));
    const dialog = await f.host.opened();
    if (editing) press(dialog, "3", "Long editor content 界界 e\u0301 ".repeat(4));
    // No invalidate calls between resizes: width itself must be a cache key.
    for (const width of [120, 50, 20, 2, 1, 0, 1, 2, 20, 50, 120]) fits(dialog, width);
    assert.match(dialog.render(120).join("\n"), /descriptive suffix/);
    if (editing) press(dialog, ESC);
    press(dialog, ESC);
    await bounded(promise);
  });
}

test("Unicode and long unbroken question tokens wrap without losing any suffix", bounds, async (t) => {
  const f = fixture(t);
  const question = `界界界界界界界界界界 e\u0301e\u0301 ${"abcdefghij".repeat(9)}TOKEN_END QUESTION_SUFFIX`;
  const promise = f.call(input(question));
  const dialog = await f.host.opened();
  for (const width of [20, 50, 120]) {
    const lines = fits(dialog, width).map(stripVTControlCharacters);
    const end = lines.indexOf("", 1);
    assert.ok(end > 1, "question is separated from options");
    assert.equal(lines.slice(1, end).join("").replace(/\s/g, ""), question.replace(/\s/g, ""));
  }
  press(dialog, ESC);
  await bounded(promise);
});

test("Focusable getter/setter propagates to the real Editor only while editing", bounds, async (t) => {
  const original = Editor.prototype.render;
  let editor: Editor | undefined;
  t.mock.method(Editor.prototype, "render", function (this: Editor, width: number) {
    editor = this;
    return original.call(this, width);
  });
  const f = fixture(t);
  const promise = f.call();
  const dialog = await f.host.opened();
  assert.ok(isFocusable(dialog), "container must implement Focusable");
  dialog.focused = true;
  assert.equal(dialog.focused, true);
  assert.ok(!dialog.render(80).join("").includes(CURSOR_MARKER));
  press(dialog, "3");
  assert.ok(dialog.render(80).join("").includes(CURSOR_MARKER), "focused editor must emit IME marker");
  assert.ok(editor);
  assert.equal(editor.focused, true);
  dialog.focused = false;
  assert.equal(dialog.focused, false);
  assert.equal(editor.focused, false);
  assert.ok(!dialog.render(80).join("").includes(CURSOR_MARKER), "focus change must invalidate cached lines");
  dialog.focused = true;
  assert.ok(dialog.render(80).join("").includes(CURSOR_MARKER));
  press(dialog, ESC);
  assert.equal(editor.focused, false);
  dialog.focused = false;
  dialog.focused = true;
  assert.equal(editor.focused, false, "focus on options must not leak to hidden editor");
  press(dialog, "3", ENTER);
  assert.equal(editor.focused, false, "empty submission returns focus to options");
  press(dialog, ESC);
  await bounded(promise);
});

test("invalidate forwards to the embedded real Editor", bounds, async (t) => {
  const spy = t.mock.method(Editor.prototype, "invalidate");
  const f = fixture(t);
  const promise = f.call();
  const dialog = await f.host.opened();
  const before = spy.mock.callCount();
  dialog.invalidate();
  assert.equal(spy.mock.callCount(), before + 1);
  press(dialog, "3");
  dialog.render(80);
  const editingBefore = spy.mock.callCount();
  dialog.invalidate();
  assert.equal(spy.mock.callCount(), editingBefore + 1);
  press(dialog, ESC, ESC);
  await bounded(promise);
});

test("duplicate option labels retain selected index in details and rendered result", bounds, async (t) => {
  const f = fixture(t);
  const promise = f.call({ question: "Which duplicate?", options: [{ label: "Same" }, { label: "Same" }] });
  press(await f.host.opened(), "2");
  const result = await bounded(promise);
  assert.equal(details(result).index, 2);
  assert.equal(f.render(result), "✓ 2. Same");
});

test("renderResult uses explicit index and infers only unambiguous legacy numbering", bounds, (t) => {
  const f = fixture(t);
  const render = (options: string[], answer: string, index?: number) => f.render({
    content: [], details: { question: "Old?", options, answer, index, wasCustom: false, cancelled: false } satisfies Details,
  });
  assert.equal(render(["Same", "Same"], "Same", 2), "✓ 2. Same");
  assert.equal(render(["Alpha", "Beta"], "Beta"), "✓ 2. Beta");
  assert.equal(render(["Same", "Same"], "Same"), "✓ Same");
  assert.equal(render(["Alpha", "Beta"], "Missing"), "✓ Missing");
  assert.equal(f.render({ content: [{ type: "text", text: "Legacy raw result" }], details: undefined }), "Legacy raw result");
});
