/**
 * src/utils/chartRange.ts — the range / from-to query semantics every
 * history endpoint shares (`?range=1h|12h|24h|7d|30d` or `?from=…&to=…`),
 * and the one-bucket lookback that lets a chart's line enter from the left
 * edge. Lifted out of src/api/routes/assets.ts when a second route file
 * (path-checks, the Polaris-server source's history) needed the same answer:
 * two copies of the range table would drift the day one gained a preset.
 */

import { AppError } from "./errors.js";

export const RANGE_MS: Record<string, number> = {
  "1h":  1 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d":  7  * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Resolve a request's chart window. An unknown preset falls back to 24h. */
export function resolveRange(req: { query: Record<string, unknown> }): { since: Date; until: Date; rangeLabel: string } {
  const fromQ = req.query.from ? String(req.query.from) : null;
  const toQ   = req.query.to   ? String(req.query.to)   : null;
  if (fromQ && toQ) {
    const f = new Date(fromQ), t = new Date(toQ);
    if (isNaN(+f) || isNaN(+t)) throw new AppError(400, "Invalid from/to date");
    if (+f >= +t) throw new AppError(400, "from must be before to");
    if (+t - +f > 365 * 24 * 60 * 60 * 1000) throw new AppError(400, "Custom range cannot exceed 1 year");
    return { since: f, until: t, rangeLabel: "custom" };
  }
  const range = String(req.query.range || "24h");
  const windowMs = RANGE_MS[range] ?? RANGE_MS["24h"];
  const until = new Date();
  return { since: new Date(+until - windowMs), until, rangeLabel: range };
}

/**
 * Extend `since` backwards by one bucket of lookback overflow so the chart
 * polyline has at least one sample BEFORE the visible window. The renderer
 * clips drawn content to `[since, until]` via SVG clipPath, so the extra
 * sample is hidden but its presence lets the line enter the chart from the
 * left edge instead of starting partway through. Stats stay scoped to the
 * visible window (filtered in the service). See the "Time-series chart
 * (SVG)" section of polaris-ui-canon.
 *
 *   - detail tier (bucketSeconds=0): 5-minute lookback — covers ~1-5 polls
 *     at 1m/2m/5m cadences without bloating the query.
 *   - hourly tier: one extra bucket (3600s).
 *   - daily tier:  one extra bucket (86400s).
 */
export function extendSinceForLookback(since: Date, bucketSeconds: number): Date {
  const DETAIL_LOOKBACK_MS = 5 * 60 * 1000;
  const lookbackMs = bucketSeconds > 0 ? bucketSeconds * 1000 : DETAIL_LOOKBACK_MS;
  return new Date(+since - lookbackMs);
}
