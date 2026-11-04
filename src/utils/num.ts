/**
 * src/utils/num.ts — numeric coercion for loosely-typed stored settings.
 *
 * `toNonNegativeInt` replaced two byte-identical private copies on 2026-11-04:
 * monitoringService.toPositiveInt (misnamed — it always accepted 0) and the
 * monitor-settings hierarchy migration's toInt. The other `toInt` / `asNumber`
 * / `numOrNull` helpers around the codebase differ in contract (null instead of
 * a fallback, trimming, rejecting 0) and are deliberately not folded in here.
 */

/**
 * `v` as an integer >= 0, floored; `fallback` when it is not a finite number
 * or is negative. Strings are coerced with `Number()`, so "30" reads as 30 and
 * "" as 0.
 */
export function toNonNegativeInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
