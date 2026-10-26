/**
 * src/utils/linearTrend.ts
 *
 * Least-squares trend helpers for the forecast surfaces (the Storage
 * Forecast dashboard widget + the storageDaysUntilFull automation metric, and
 * the memory forecast — the Memory chart overlay + memDaysUntilFull, which
 * passes totalBytes = 100 because it fits a percentage).
 * The heavy lifting (per-mount / per-asset slope over the sample history)
 * happens in SQL via regr_slope (storageForecastService,
 * memoryForecastService); these pure helpers cover the
 * JS-side arithmetic (days-until-full projection) and give tests/JS callers a
 * reference implementation of the same regression.
 */

export interface TrendPoint {
  /** Sample time (ms epoch). */
  t: number;
  /** Observed value at t. */
  v: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * Ordinary least-squares slope over (t, v) points, expressed in value-units
 * PER DAY. Returns null when fewer than 2 points or when every point shares
 * the same timestamp (vertical line — slope undefined). Matches Postgres
 * regr_slope(v, epoch_days).
 */
export function leastSquaresSlopePerDay(points: TrendPoint[]): number | null {
  if (!Array.isArray(points) || points.length < 2) return null;
  const n = points.length;
  let sumX = 0, sumY = 0;
  for (const p of points) { sumX += p.t / MS_PER_DAY; sumY += p.v; }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let sxx = 0, sxy = 0;
  for (const p of points) {
    const dx = p.t / MS_PER_DAY - meanX;
    sxx += dx * dx;
    sxy += dx * (p.v - meanY);
  }
  if (sxx === 0) return null;
  return sxy / sxx;
}

/**
 * Project how many days until a filesystem fills, from a bytes-per-day growth
 * slope. Null when the mount isn't growing (slope ≤ 0), when capacity is
 * unknown/zero, or when inputs are non-finite; an already-over-capacity mount
 * clamps to 0 (full now).
 */
export function daysUntilFull(opts: { slopePerDay: number; currentUsed: number; totalBytes: number }): number | null {
  const { slopePerDay, currentUsed, totalBytes } = opts;
  if (!Number.isFinite(slopePerDay) || slopePerDay <= 0) return null;
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(currentUsed)) return null;
  const remaining = totalBytes - currentUsed;
  if (remaining <= 0) return 0;
  return remaining / slopePerDay;
}
