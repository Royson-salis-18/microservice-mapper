/**
 * Structural sharing for a list of id'd items carrying a `data` object.
 *
 * Returns `prev` itself when nothing changed, the previous object for each
 * item whose content signature is unchanged, and a freshly built object for
 * the rest. Signatures are remembered against the *data object* in `keys`,
 * never against the id, and that is what keeps this safe to run inside a
 * React state updater: React StrictMode runs updaters twice with the same
 * previous state, and an id-keyed record written by the first run made the
 * second run believe nothing had changed, so the update was thrown away.
 * Keyed by the old data object, both runs reach the same answer.
 */
export function shareById<T extends { id: string; data?: unknown }>(
  prev: T[],
  nextIds: string[],
  keyById: Map<string, string>,
  keys: WeakMap<object, string>,
  build: (id: string, index: number, previous: T | undefined) => T,
): T[] {
  const prevById = new Map(prev.map((p) => [p.id, p]));
  let changed = prev.length !== nextIds.length;
  const out = nextIds.map((id, i) => {
    const key = keyById.get(id);
    const old = prevById.get(id);
    if (old && key !== undefined && old.data && typeof old.data === 'object' && keys.get(old.data) === key) {
      if (prev[i] !== old) changed = true;
      return old;
    }
    const item = build(id, i, old);
    if (key !== undefined && item.data && typeof item.data === 'object') keys.set(item.data, key);
    changed = true;
    return item;
  });
  return changed ? out : prev;
}
