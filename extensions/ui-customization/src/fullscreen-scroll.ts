const WHEEL_SCROLL_LINES = 5;

/**
 * Pi exposes wheelScrollLines only as a TuiAltScreen constructor option.
 * Its TypeScript-private/readonly field is currently writable at runtime.
 * Keep this unsupported shim isolated; never patch Pi's installed files.
 */
export function createFullscreenScrollOverride() {
  const originals = new WeakMap<object, number>();
  let disposed = false;

  function target(tui: object) {
    const mode: unknown = Reflect.get(tui, "mode");
    const lines: unknown = Reflect.get(tui, "wheelScrollLines");
    const children: unknown = Reflect.get(tui, "children");
    if (
      mode !== "fullscreen" ||
      typeof lines !== "number" ||
      !Number.isFinite(lines) ||
      !Array.isArray(children)
    ) return undefined;

    // Pi passes a stable Proxy whose underlying renderer changes on mode
    // switches. Its public children array identifies the current renderer.
    return { lines, identity: children };
  }

  return {
    apply(tui: object) {
      if (disposed) return;
      try {
        const current = target(tui);
        if (!current) return;
        if (!originals.has(current.identity)) {
          originals.set(current.identity, current.lines);
        }
        if (current.lines !== WHEEL_SCROLL_LINES) {
          Reflect.set(tui, "wheelScrollLines", WHEEL_SCROLL_LINES);
        }
      } catch {
        // Future Pi versions may hide/freeze this field. Leave the UI working.
      }
    },
    dispose(tui: object | undefined) {
      if (disposed) return;
      disposed = true;
      if (!tui) return;
      try {
        const current = target(tui);
        if (!current || current.lines !== WHEEL_SCROLL_LINES) return;
        const original = originals.get(current.identity);
        if (original !== undefined) Reflect.set(tui, "wheelScrollLines", original);
      } catch {
        // Cleanup must not interrupt shutdown/reload if Pi internals change.
      }
    },
  };
}
