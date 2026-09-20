/**
 * Deferred one-shot delivery map (same semantics as subagents'): a settled
 * terminal's result is held here until it is either drained into a follow-up
 * message or consumed by a tool call (bg_kill / bg_status) that already
 * returned the settlement itself. Keyed by id, so double delivery is
 * structurally impossible — whoever drains first wins.
 */
export function createDeferredResultDelivery<T extends { id: string }>() {
  const pending = new Map<string, T>();
  const held = new Map<string, number>();

  return {
    /** Active collectors reserve delivery, but do not acknowledge receipt yet. */
    hold(ids: Iterable<string>) {
      for (const id of ids) held.set(id, (held.get(id) ?? 0) + 1);
    },
    release(ids: Iterable<string>) {
      for (const id of ids) {
        const count = (held.get(id) ?? 0) - 1;
        if (count > 0) held.set(id, count);
        else held.delete(id);
      }
    },
    defer(result: T) {
      pending.set(result.id, result);
    },
    consume(ids: Iterable<string>) {
      for (const id of ids) pending.delete(id);
    },
    drain() {
      const results: T[] = [];
      for (const [id, result] of pending) {
        if (held.has(id)) continue;
        results.push(result);
        pending.delete(id);
      }
      return results;
    },
    clear() {
      pending.clear();
      held.clear();
    },
  };
}
