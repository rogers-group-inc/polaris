/**
 * src/utils/queryParams.ts — the two query-string coercions route handlers
 * repeat: an integer with a default and bounds, and a boolean flag.
 *
 * Before 2026-11-04 about a dozen route files hand-rolled these four ways —
 * `parseInt(x) || d`, `Number(x) || d`, `x ? Number(x) : undefined`, and
 * `Math.min(max, Math.max(min, …))` — and the boolean flags accepted "1" in
 * one route, "true" in another and both in a third. Routes that validate their
 * query with a co-located Zod schema (`z.coerce.number()`) keep doing that;
 * this is for the ones that read `req.query` by hand.
 */

export interface IntQueryOptions {
  /** Used when the value is absent, unparseable or 0. Omitted → undefined. */
  fallback?: number;
  min?: number;
  max?: number;
}

/**
 * An integer query value. Parsed with `parseInt(…, 10)`, so "25abc" reads 25
 * and "1.5" reads 1. Absent, unparseable and 0 all take `fallback` — the
 * `parseInt(x) || fallback` every hand-rolled site used — and the result is
 * then clamped to `min` / `max` when given. Returns undefined only when there
 * is no value and no fallback, so a service default can apply.
 */
export function intQuery(raw: unknown, opts: IntQueryOptions = {}): number | undefined {
  const n = parseInt(String(raw ?? ""), 10);
  let v = Number.isFinite(n) && n !== 0 ? n : opts.fallback;
  if (v === undefined) return undefined;
  if (opts.min !== undefined) v = Math.max(opts.min, v);
  if (opts.max !== undefined) v = Math.min(opts.max, v);
  return v;
}

/** A query-string flag: "1", "true" and "yes" (any case) are true; anything else, absence included, is false. */
export function boolQuery(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const s = raw.toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}
