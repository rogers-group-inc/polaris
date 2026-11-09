/**
 * src/utils/jsonEqual.ts — "would these two values serialise to the same JSON,
 * ignoring object key order?"
 *
 * The question every "did this blob change?" check is actually asking. A bare
 * `JSON.stringify(a) !== JSON.stringify(b)` answers a narrower one, and gets it
 * wrong for any value read back from a Prisma `Json` column: PostgreSQL `jsonb`
 * stores object keys in ITS order (shorter keys first, then bytewise), so
 * `{"field","op","value"}` written by the code comes back as
 * `{"op","field","value"}`, and a stored blob never equals the same blob freshly
 * built. Every such check then reports a change that did not happen — a sync
 * that rewrites every row on every pass, an alert group retired on an unrelated
 * save (CQ-B054, 2026-11-05).
 *
 * Exactly JSON semantics apart from key order: arrays stay ORDER-SENSITIVE (a
 * reordered list is a change), `undefined` properties drop, `toJSON` runs first
 * (a Date compares as its ISO string), NaN and Infinity read as null.
 */

/** JSON.stringify with every object's keys sorted; arrays keep their order. */
export function stableStringify(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[k] = (v as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

/** True when `a` and `b` are the same JSON document, whatever their key order. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
