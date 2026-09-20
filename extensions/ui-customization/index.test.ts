import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyGitInfoState, emptyModelInfoState,
  GIT_INFO_CHANNEL, MODEL_INFO_CHANNEL, REFRESH_CHANNEL,
} from "../shared/dashboard-state.ts";
import uiCustomization from "./index.ts";

// Pi's private loaded-resource component is a Text subclass, not a container.
// Keep the real Text renderer; only reproduce its public expansion protocol.
class ExpandableText extends Text {
  setExpanded = vi.fn((_expanded: boolean) => {});
}

function section(name = "Themes") {
  return new ExpandableText(`\x1b[36m[${name}]\x1b[0m\n  /fixture/${name.toLowerCase()}`, 1, 0);
}
function container(...children: Component[]) {
  const result = new Container();
  children.forEach((child) => result.addChild(child));
  return result;
}
type OwnedComponent = Component & { dispose?: () => void };
type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
type Listener = (value: unknown) => void;

function harness(options: { mode?: ExtensionContext["mode"]; fullscreen?: boolean } = {}) {
  const headerContainer = container();
  const resources = container();
  const message = container(new Text("[Themes]\nPlease preserve this conversation.", 1, 0));
  const chat = container(message, new Spacer(1), new Text("Assistant reply", 1, 0));
  // Both audited Pi versions use exactly these three document children.
  const document = container(headerContainer, resources, chat);
  const tui = Object.assign(container(document, container()), {
    mode: options.fullscreen ? "fullscreen" : "regular",
    wheelScrollLines: 1,
    // Fullscreen's separate layoutRoot must not become a search root.
    layoutRoot: container(new Text("[Themes]\nnot loaded resources", 0, 0)),
    requestRender: vi.fn(),
  });
  const theme = { fg: (_color: string, text: string) => text };
  const statuses = new Map<string, string>();
  const footerData = { getExtensionStatuses: () => statuses };
  type Factory = (renderer: typeof tui, colors: typeof theme, data: typeof footerData) => OwnedComponent;
  let header: OwnedComponent | undefined;
  let footer: OwnedComponent | undefined;
  const headerFactories: Factory[] = [];
  const footerFactories: Factory[] = [];
  const ui = {
    setHeader: vi.fn((factory?: Factory) => {
      header?.dispose?.();
      headerContainer.clear();
      header = undefined;
      if (factory) {
        headerFactories.push(factory);
        header = factory(tui, theme, footerData);
        // Mount synchronously, just as Pi does, before any retry timer fires.
        headerContainer.addChild(header);
      }
    }),
    setFooter: vi.fn((factory?: Factory) => {
      footer?.dispose?.();
      footer = undefined;
      if (factory) {
        footerFactories.push(factory);
        footer = factory(tui, theme, footerData);
      }
    }),
    setTitle: vi.fn(),
  };
  const ctx = {
    cwd: "/fixture/project", mode: options.mode ?? "tui",
    hasUI: options.mode === undefined || options.mode === "tui" || options.mode === "rpc", ui,
  } as unknown as ExtensionContext;
  const handlers = new Map<string, Handler[]>();
  const listeners = new Map<string, Set<Listener>>();
  const subscriptions: { channel: string; listener: Listener; stop: ReturnType<typeof vi.fn> }[] = [];
  const events = {
    on: vi.fn((channel: string, listener: Listener) => {
      const group = listeners.get(channel) ?? new Set<Listener>();
      group.add(listener);
      listeners.set(channel, group);
      const stop = vi.fn(() => { group.delete(listener); });
      subscriptions.push({ channel, listener, stop });
      return stop;
    }),
    emit: vi.fn((channel: string, value: unknown) => {
      for (const listener of listeners.get(channel) ?? []) listener(value);
    }),
  };
  const api = {
    on: vi.fn((name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    }), events,
  } as unknown as ExtensionAPI;
  uiCustomization(api);
  function fire(name: string, reason = "startup") {
    for (const handler of handlers.get(name) ?? []) handler({ type: name, reason, cwd: ctx.cwd }, ctx);
  }
  return {
    api, ctx, ui, tui, document, headerContainer, resources, chat, message,
    events, subscriptions, handlers, statuses, theme, footerData,
    headerFactories, footerFactories,
    get header() { return header!; }, get footer() { return footer!; },
    fire, start: () => fire("session_start"), shutdown: () => fire("session_shutdown", "quit"),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("registered UI customization: narrowly anchored Themes removal", () => {
  it.each([false, true])("removes only the resource Themes leaf (fullscreen=%s), never the transcript", (fullscreen) => {
    const h = harness({ fullscreen });
    const skills = section("Skills");
    const before = new Spacer(1);
    const themes = section();
    const after = new Spacer(1);
    const diagnostic = new Text("[Themes]\nwarning: failed to load one theme", 1, 0);
    h.resources.children.push(skills, before, themes, after, diagnostic);
    const chatChildren = [...h.chat.children];
    const messageChildren = [...h.message.children];
    const chatRender = vi.spyOn(h.chat, "render");
    const messageRender = vi.spyOn(h.message, "render");
    const rootRender = vi.spyOn(h.tui.layoutRoot, "render");
    h.start();
    expect(h.headerContainer.children).toContain(h.header);
    expect(h.resources.children).toContain(themes);
    vi.advanceTimersByTime(0);
    expect(h.resources.children).toEqual([skills, before, diagnostic]);
    expect(h.document.children).toEqual([h.headerContainer, h.resources, h.chat]);
    expect(h.chat.children).toEqual(chatChildren);
    expect(h.message.children).toEqual(messageChildren);
    expect(h.tui.requestRender).toHaveBeenCalledWith(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5_000);
    h.fire("resources_discover", "reload");
    vi.runAllTimers();
    expect(h.chat.children).toEqual(chatChildren);
    expect(h.message.children).toEqual(messageChildren);
    expect(h.resources.children).toEqual([skills, before, diagnostic]);
    expect(chatRender).not.toHaveBeenCalled();
    expect(messageRender).not.toHaveBeenCalled();
    expect(rootRender).not.toHaveBeenCalled();
    expect(themes.setExpanded).not.toHaveBeenCalled();
  });

  it("preserves a transcript beginning [Themes] when no actual Themes section exists, across every retry", () => {
    const h = harness();
    const skills = section("Skills");
    h.resources.children.push(skills, new Spacer(1));
    const resources = [...h.resources.children];
    const transcript = [...h.chat.children];
    const render = vi.spyOn(h.chat, "render");
    h.start();
    for (const elapsed of [0, 50, 200, 750, 10_000]) {
      vi.advanceTimersByTime(elapsed);
      expect(h.document.children).toEqual([h.headerContainer, h.resources, h.chat]);
      expect(h.chat.children).toEqual(transcript);
      expect(h.resources.children).toEqual(resources);
    }
    expect(render).not.toHaveBeenCalled();
    expect(h.tui.requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, 50, 250, 1_000])("finds resources mounted just before the %i ms attempt", (delay) => {
    const h = harness();
    h.start();
    if (delay > 0) vi.advanceTimersByTime(delay - 1);
    const themes = section();
    h.resources.children.push(themes, new Spacer(1));
    vi.advanceTimersByTime(delay === 0 ? 0 : 1);
    expect(h.resources.children).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not remove a blank diagnostic or preceding Spacer instead of the following Spacer", () => {
    const h = harness();
    const before = new Spacer(1);
    const blank = new Text("", 0, 0);
    const diagnostic = new Text("Theme diagnostics: invalid JSON", 1, 0);
    h.resources.children.push(before, section(), blank, diagnostic);
    h.start();
    vi.runAllTimers();
    expect(h.resources.children).toEqual([before, blank, diagnostic]);
  });

  it("preserves ordinary diagnostic Text even when its first line is exactly [Themes]", () => {
    const h = harness();
    const diagnostic = new Text("[Themes]\nFailed to load", 1, 0);
    h.resources.children.push(diagnostic, new Spacer(1));
    const original = [...h.resources.children];
    h.start();
    vi.runAllTimers();
    expect(h.resources.children).toEqual(original);
    expect(h.tui.requestRender).not.toHaveBeenCalled();
  });

  it.each(["[Themes] extra", "[Themes diagnostics]", "[Skills]\n[Themes]"])("does not match %s", (label) => {
    const h = harness();
    const leaf = new ExpandableText(label, 1, 0);
    h.resources.children.push(leaf);
    h.start();
    vi.runAllTimers();
    expect(h.resources.children).toEqual([leaf]);
  });

  it.each(["extra document child", "nested document", "document not first", "nested header", "foreign header", "nested resource", "foreign resource"])("fails safe for %s without speculative renders", (layout) => {
    const h = harness();
    const themes = section();
    h.resources.children.push(themes, new Spacer(1));
    h.start();
    const opaque = { render: vi.fn(() => ["[Themes]"]), invalidate: vi.fn() };
    switch (layout) {
      case "extra document child": h.document.addChild(container()); break;
      case "nested document": h.tui.children[0] = container(h.document); break;
      case "document not first": h.tui.children.unshift(container()); break;
      case "nested header": h.headerContainer.children = [container(h.header)]; break;
      case "foreign header": h.headerContainer.children = [new Text("lookalike header", 0, 0)]; break;
      case "nested resource": h.resources.children = [container(themes)]; break;
      case "foreign resource": h.resources.addChild(opaque); break;
    }
    const original = [...h.resources.children];
    const themesRender = vi.spyOn(themes, "render");
    const chatRender = vi.spyOn(h.chat, "render");
    vi.runAllTimers();
    expect(h.resources.children).toEqual(original);
    expect(themesRender).not.toHaveBeenCalled();
    expect(chatRender).not.toHaveBeenCalled();
    expect(opaque.render).not.toHaveBeenCalled();
    expect(h.tui.requestRender).not.toHaveBeenCalled();
  });

  it("leaves duplicate Themes candidates visible rather than guessing", () => {
    const h = harness();
    h.resources.children.push(section(), new Spacer(1), section(), new Spacer(1));
    const original = [...h.resources.children];
    h.start();
    vi.runAllTimers();
    expect(h.resources.children).toEqual(original);
    expect(h.tui.requestRender).not.toHaveBeenCalled();
  });
});

describe("retry and component ownership lifecycle", () => {
  it("schedules only bounded attempts and resources_discover replaces, rather than stacks, retries", () => {
    const h = harness();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    expect(vi.getTimerCount()).toBe(0);
    h.start();
    expect(timeout.mock.calls.map((call) => call[1])).toEqual([0, 50, 250, 1_000]);
    vi.advanceTimersByTime(100);
    h.fire("resources_discover", "reload");
    expect(vi.getTimerCount()).toBe(4);
    expect(timeout.mock.calls.slice(4).map((call) => call[1])).toEqual([0, 50, 250, 1_000]);
    vi.runAllTimers();
    expect(vi.getTimerCount()).toBe(0);
    const themes = section();
    h.resources.children.push(themes, new Spacer(1));
    vi.advanceTimersByTime(10_000);
    expect(h.resources.children).toContain(themes);
    h.fire("resources_discover", "reload");
    vi.advanceTimersByTime(0);
    expect(h.resources.children).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels and guards removal after another extension replaces the header", () => {
    const h = harness();
    h.start();
    const oldHeader = h.header;
    expect(oldHeader.dispose).toEqual(expect.any(Function));
    const otherHeader = new Text("Other extension", 0, 0);
    h.ui.setHeader(() => otherHeader);
    expect(vi.getTimerCount()).toBe(0);
    h.resources.children.push(section(), new Spacer(1));
    h.fire("resources_discover", "reload");
    vi.runAllTimers();
    expect(h.resources.children).toHaveLength(2);
    expect(h.header).toBe(otherHeader);
    oldHeader.dispose?.();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("guards already queued callbacks after header disposal, even if its anchor is still mounted", () => {
    const h = harness();
    const timeout = vi.spyOn(globalThis, "setTimeout");
    h.start();
    const pending = timeout.mock.calls.map(([callback]) => callback);
    h.resources.children.push(section(), new Spacer(1));
    h.header.dispose?.();
    // Cancellation alone is insufficient if the host already queued a callback.
    for (const callback of pending) if (typeof callback === "function") callback();
    h.fire("resources_discover", "reload");
    vi.runAllTimers();
    expect(h.resources.children).toHaveLength(2);
    expect(h.tui.requestRender).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a replacement header from the live factory has its own anchor and old disposal cannot cancel it", () => {
    const h = harness();
    h.start();
    const previous = h.header;
    h.ui.setHeader(h.headerFactories[0]);
    expect(h.header).not.toBe(previous);
    previous.dispose?.();
    h.resources.children.push(section(), new Spacer(1));
    vi.advanceTimersByTime(0);
    expect(h.resources.children).toEqual([]);
    expect(h.headerContainer.children).toEqual([h.header]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["header", "footer", "both"])("shutdown preserves another extension's %s replacement", (replacement) => {
    const h = harness();
    h.start();
    const otherHeader = Object.assign(new Text("other header", 0, 0), { dispose: vi.fn() });
    const otherFooter = Object.assign(new Text("other footer", 0, 0), { dispose: vi.fn() });
    if (replacement !== "footer") h.ui.setHeader(() => otherHeader);
    if (replacement !== "header") h.ui.setFooter(() => otherFooter);
    h.ui.setHeader.mockClear();
    h.ui.setFooter.mockClear();
    h.shutdown();
    if (replacement !== "footer") {
      expect(h.header).toBe(otherHeader);
      expect(h.ui.setHeader).not.toHaveBeenCalled();
      expect(otherHeader.dispose).not.toHaveBeenCalled();
    } else expect(h.ui.setHeader).toHaveBeenCalledWith(undefined);
    if (replacement !== "header") {
      expect(h.footer).toBe(otherFooter);
      expect(h.ui.setFooter).not.toHaveBeenCalled();
      expect(otherFooter.dispose).not.toHaveBeenCalled();
    } else expect(h.ui.setFooter).toHaveBeenCalledWith(undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("permanently guards stale event handlers and UI factories after shutdown", () => {
    const h = harness({ fullscreen: true });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    h.start();
    const pending = timeout.mock.calls.map(([callback]) => callback);
    const headerFactory = h.headerFactories[0]!;
    const footerFactory = h.footerFactories[0]!;
    const staleHeader = h.header;
    const staleFooter = h.footer;
    h.shutdown();
    expect(h.tui.wheelScrollLines).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    for (const subscription of h.subscriptions) expect(subscription.stop).toHaveBeenCalledTimes(1);
    h.ui.setHeader.mockClear(); h.ui.setFooter.mockClear(); h.ui.setTitle.mockClear();
    h.events.emit.mockClear(); h.tui.requestRender.mockClear();
    h.resources.children.push(section(), new Spacer(1));
    for (const callback of pending) if (typeof callback === "function") callback();
    h.start();
    h.fire("resources_discover", "reload");
    for (const subscription of h.subscriptions) {
      subscription.listener(subscription.channel === MODEL_INFO_CHANNEL ? emptyModelInfoState() : emptyGitInfoState());
    }
    for (const component of [
      staleHeader, staleFooter,
      headerFactory(h.tui, h.theme, h.footerData),
      footerFactory(h.tui, h.theme, h.footerData),
    ]) {
      component.render(80);
      component.invalidate();
      component.dispose?.();
    }
    h.shutdown();
    vi.runAllTimers();
    expect(h.resources.children).toHaveLength(2);
    expect(h.ui.setHeader).not.toHaveBeenCalled();
    expect(h.ui.setFooter).not.toHaveBeenCalled();
    expect(h.ui.setTitle).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
    expect(h.tui.requestRender).not.toHaveBeenCalled();
    expect(h.tui.wheelScrollLines).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    for (const subscription of h.subscriptions) expect(subscription.stop).toHaveBeenCalledTimes(1);
  });

  it("a fresh extension factory supports reload without the disposed instance reclaiming ownership", () => {
    const h = harness();
    h.start();
    const oldStart = h.handlers.get("session_start")![0]!;
    const oldShutdown = h.handlers.get("session_shutdown")![0]!;
    h.shutdown();
    uiCustomization(h.api);
    const newStart = h.handlers.get("session_start")![1]!;
    newStart({ type: "session_start", reason: "reload" }, h.ctx);
    const currentHeader = h.header;
    const currentFooter = h.footer;
    oldStart({ type: "session_start", reason: "reload" }, h.ctx);
    oldShutdown({ type: "session_shutdown", reason: "reload" }, h.ctx);
    expect(h.header).toBe(currentHeader);
    expect(h.footer).toBe(currentFooter);
    h.resources.children.push(section(), new Spacer(1));
    vi.advanceTimersByTime(0);
    expect(h.resources.children).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["print", "json", "rpc"] as const)("does not install or schedule UI in %s mode", (mode) => {
    const h = harness({ mode });
    h.start();
    h.fire("resources_discover");
    h.shutdown();
    expect(h.ui.setHeader).not.toHaveBeenCalled();
    expect(h.ui.setFooter).not.toHaveBeenCalled();
    expect(h.ui.setTitle).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("dashboard rendering through registered factories and event bus", () => {
  it("requests refresh, accepts shared states, ignores malformed events, and sorts multiline statuses", () => {
    const h = harness();
    h.start();
    expect(h.ui.setTitle).toHaveBeenCalledWith("pi · /fixture/project");
    expect(h.events.emit).toHaveBeenCalledWith(REFRESH_CHANNEL, undefined);
    expect(h.footer.render(160).join("\n")).toContain("no-model");
    h.tui.requestRender.mockClear();
    h.events.emit(MODEL_INFO_CHANNEL, { cost: "invalid" });
    h.events.emit(GIT_INFO_CHANNEL, null);
    expect(h.tui.requestRender).not.toHaveBeenCalled();
    h.events.emit(MODEL_INFO_CHANNEL, {
      ...emptyModelInfoState(), provider: "fixture", modelId: "test-model", thinking: "high",
      contextWindow: 200_000, contextPercent: 25.4, cost: 1.25, tokensPerSecond: 42.4, summary: "test summary",
    });
    h.events.emit(GIT_INFO_CHANNEL, { ...emptyGitInfoState(), isRepository: true, branch: "main", changedFiles: 1 });
    expect(h.tui.requestRender).toHaveBeenCalledTimes(2);
    h.statuses.set("z-last", "last");
    h.statuses.set("a-first", "first\nsecond");
    const lines = h.footer.render(160).map(stripVTControlCharacters);
    expect(lines[0]).toContain("fixture/test-model · high");
    expect(lines[1]).toContain("25%/200k · $1.25 · 42 tok/s · test summary");
    expect(lines[1]).toContain("main · 1 file changed");
    expect(lines.slice(2)).toEqual(["first", "second", "last"]);
    h.events.emit(MODEL_INFO_CHANNEL, { ...emptyModelInfoState(), summarizing: true });
    expect(h.footer.render(160).join("\n")).toContain("summarizing…");
  });

  it.each([1, 2, 5, 20, 80, 160])("header and footer stay within %i terminal columns", (width) => {
    const h = harness();
    h.start();
    h.statuses.set("wide", "\x1b[32m界界 dashboard status with a long label\x1b[0m");
    h.events.emit(GIT_INFO_CHANNEL, { ...emptyGitInfoState(), branch: "feature/very-long-branch-name", changedFiles: 42 });
    const header = h.header.render(width);
    const footer = h.footer.render(width);
    expect(header).toHaveLength(9);
    expect(footer).toHaveLength(3);
    for (const line of [...header, ...footer]) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });
});
