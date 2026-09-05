import { describe, expect, it } from "vitest";
import { createFullscreenScrollOverride } from "./src/fullscreen-scroll.ts";

function fullscreen(wheelScrollLines = 1) {
  return { mode: "fullscreen", children: [], wheelScrollLines };
}

describe("fullscreen wheel scrolling", () => {
  it("sets five lines and restores the original without stacking on repeated renders", () => {
    const tui = fullscreen(3);
    const override = createFullscreenScrollOverride();
    override.apply(tui);
    override.apply(tui);
    expect(tui.wheelScrollLines).toBe(5);
    override.dispose(tui);
    expect(tui.wheelScrollLines).toBe(3);
    override.apply(tui);
    override.dispose(tui);
    expect(tui.wheelScrollLines).toBe(3);
  });

  it("supports Pi's stable renderer proxy and fullscreen/regular mode switches", () => {
    let renderer: object = fullscreen();
    const tui = new Proxy({}, {
      get: (_, key) => Reflect.get(renderer, key),
      set: (_, key, value) => Reflect.set(renderer, key, value),
    });
    const override = createFullscreenScrollOverride();
    override.apply(tui);
    expect(Reflect.get(tui, "wheelScrollLines")).toBe(5);
    renderer = { mode: "regular", children: [] };
    override.apply(tui);
    expect(Reflect.has(renderer, "wheelScrollLines")).toBe(false);
    renderer = fullscreen(2);
    override.apply(tui);
    expect(Reflect.get(tui, "wheelScrollLines")).toBe(5);
    override.dispose(tui);
    expect(Reflect.get(tui, "wheelScrollLines")).toBe(2);
  });

  it("does not reset another renderer's preexisting five-line preference", () => {
    const override = createFullscreenScrollOverride();
    override.apply(fullscreen());
    const next = fullscreen(5);
    override.apply(next);
    override.dispose(next);
    expect(next.wheelScrollLines).toBe(5);
  });

  it("leaves regular mode, missing fields, and frozen future implementations alone", () => {
    const override = createFullscreenScrollOverride();
    const regular = { ...fullscreen(), mode: "regular" };
    const missing = { mode: "fullscreen", children: [] };
    const frozen = Object.freeze(fullscreen());
    for (const tui of [regular, missing, frozen, {}]) {
      expect(() => override.apply(tui)).not.toThrow();
    }
    expect(regular.wheelScrollLines).toBe(1);
    expect("wheelScrollLines" in missing).toBe(false);
    expect(frozen.wheelScrollLines).toBe(1);
    expect(() => override.dispose(frozen)).not.toThrow();
  });

  it("does not overwrite a subsequent change during cleanup", () => {
    const tui = fullscreen();
    const override = createFullscreenScrollOverride();
    override.apply(tui);
    tui.wheelScrollLines = 7;
    override.dispose(tui);
    expect(tui.wheelScrollLines).toBe(7);
  });

  it("can be installed again after reload and tolerates shutdown without a TUI", () => {
    const tui = fullscreen();
    const first = createFullscreenScrollOverride();
    first.apply(tui);
    first.dispose(tui);
    const second = createFullscreenScrollOverride();
    second.apply(tui);
    expect(tui.wheelScrollLines).toBe(5);
    second.dispose(tui);
    expect(tui.wheelScrollLines).toBe(1);
    expect(() => createFullscreenScrollOverride().dispose(undefined)).not.toThrow();
  });
});
