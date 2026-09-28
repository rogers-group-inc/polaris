/**
 * src/services/storageForecastService.ts
 *
 * Per-filesystem "days until full" forecasting — the shared computation behind
 * the Storage Forecast dashboard widget (nocDashboardService feed) and the
 * storageDaysUntilFull automation metric (notificationEngine resolver).
 *
 * Trend source: a UNION of the storage DETAIL samples (7-day retention,
 * day-bucketed — covers EVERY storage-scraped asset, including the slow 24h
 * cadence) and the DAILY rollups (365-day retention, but populated only for
 * cadence='fast' rows, i.e. assets with pinned storage — see
 * sampleRollupService's sqlStorageHourly cadence filter). Pinned assets get a
 * richer 30-day trend; everyone else still gets ~7 daily points from detail.
 * One aggregate query via regr_slope over (avg used bytes, day) — flat at
 * 2000 assets; the JS side only does the days-until-full division
 * (utils/linearTrend.daysUntilFull).
 *
 * Only GROWING mounts with ≥ minPoints distinct days qualify (a shrinking or
 * flat filesystem has no fill date; too few points = noise). READ-ONLY over
 * the hypertable + rollup table.
 */

import { prisma } from "../db.js";
import { daysUntilFull, leastSquaresSlopePerDay, type TrendPoint } from "../utils/linearTrend.js";

export interface StorageForecastRow {
  assetId: string;
  mountPath: string;
  /** Projected days until the filesystem is full (≥ 0; 0 = full now). */
  daysUntilFull: number;
  /** Latest used % of capacity (0–100), when capacity is known. */
  usedPct: number | null;
  /** Fitted growth rate (bytes/day). */
  slopeBytesPerDay: number;
  /** Distinct daily points the fit used. */
  points: number;
}

/** Default trend lookback (days) — user-confirmed 30-day window. */
export const FORECAST_LOOKBACK_DAYS = 30;
/** Minimum distinct daily points for a fit (a fresh install/new mount stays quiet). */
export const FORECAST_MIN_POINTS = 7;
/** Forecasts beyond this horizon are dropped — beyond a year is noise, not planning. */
export const FORECAST_MAX_DAYS = 365;

/**
 * The per-(asset, mount, day) points every forecast is fitted on, as a `WITH`
 * clause ending in `dedup`. ONE definition, shared by the fleet-wide fit below
 * and the single-mount series the alert email draws
 * (loadStorageForecastSeries), so the picture under a "days until full" alert
 * is fitted on exactly the points the automation's number came from. `$1` is
 * always the lookback in days; the two filters add whatever else narrows it.
 */
function dailyPointsCte(detailFilter: string, dailyFilter: string): string {
  return `WITH pts AS (
       SELECT s."assetId" AS "assetId", s."mountPath" AS "mountPath",
              date_trunc('day', s."timestamp") AS day,
              avg(s."usedBytes")::float8 AS used,
              (ARRAY_AGG(s."totalBytes" ORDER BY s."timestamp" DESC) FILTER (WHERE s."totalBytes" IS NOT NULL))[1]::float8 AS total
       FROM "asset_storage_samples" s
       WHERE s."timestamp" > (now() AT TIME ZONE 'UTC') - ($1 || ' days')::interval
         AND s."usedBytes" IS NOT NULL${detailFilter}
       GROUP BY 1, 2, 3
       UNION ALL
       SELECT d."assetId", d."mountPath", d."bucketStart" AS day,
              d."avgUsedBytes"::float8, d."lastTotalBytes"::float8
       FROM "asset_storage_samples_daily" d
       WHERE d."bucketStart" > (now() AT TIME ZONE 'UTC') - ($1 || ' days')::interval
         AND d."avgUsedBytes" IS NOT NULL${dailyFilter}
     ),
     dedup AS (
       -- Fast-cadence assets have BOTH a detail bucket and a rollup bucket for
       -- the same day; keep one per (asset, mount, day) — the values agree.
       SELECT DISTINCT ON ("assetId", "mountPath", day) "assetId", "mountPath", day, used, total
       FROM pts ORDER BY "assetId", "mountPath", day
     )`;
}

export async function computeStorageForecast(
  assetIds: string[] | null = null,
  lookbackDays: number = FORECAST_LOOKBACK_DAYS,
  minPoints: number = FORECAST_MIN_POINTS,
): Promise<StorageForecastRow[]> {
  const idDetail = assetIds ? ` AND s."assetId" = ANY($3::text[])` : "";
  const idDaily = assetIds ? ` AND d."assetId" = ANY($3::text[])` : "";
  const params: unknown[] = [String(lookbackDays), minPoints];
  if (assetIds) params.push(assetIds);

  const rows = await prisma.$queryRawUnsafe<Array<{
    assetId: string;
    mountPath: string;
    slope_per_day: number | null;
    points: number;
    last_used: number | null;
    total_bytes: number | null;
  }>>(
    `${dailyPointsCte(idDetail, idDaily)}
     SELECT "assetId", "mountPath",
            regr_slope(used, extract(epoch from day)::float8 / 86400.0) AS slope_per_day,
            count(*)::int AS points,
            (ARRAY_AGG(used ORDER BY day DESC))[1] AS last_used,
            (ARRAY_AGG(total ORDER BY day DESC) FILTER (WHERE total IS NOT NULL))[1] AS total_bytes
     FROM dedup
     GROUP BY 1, 2
     HAVING count(*) >= $2
        AND regr_slope(used, extract(epoch from day)::float8 / 86400.0) > 0`,
    ...params,
  );

  const out: StorageForecastRow[] = [];
  for (const r of rows) {
    if (r.slope_per_day == null || r.last_used == null || r.total_bytes == null || r.total_bytes <= 0) continue;
    const days = daysUntilFull({ slopePerDay: r.slope_per_day, currentUsed: r.last_used, totalBytes: r.total_bytes });
    if (days == null || days > FORECAST_MAX_DAYS) continue;
    out.push({
      assetId: r.assetId,
      mountPath: r.mountPath,
      daysUntilFull: Math.round(days * 10) / 10,
      usedPct: Math.round((r.last_used / r.total_bytes) * 1000) / 10,
      slopeBytesPerDay: Math.round(r.slope_per_day),
      points: r.points,
    });
  }
  // Soonest-full first — the callers' natural order (the feed re-sorts
  // severity-first on top; equal ranks keep this).
  out.sort((a, b) => a.daysUntilFull - b.daysUntilFull);
  return out;
}

/** One mount's forecast, with the daily points it was fitted on. */
export interface StorageForecastSeries {
  /** Daily average used bytes, ascending by day (`t` = the day's UTC start). */
  points: TrendPoint[];
  /** Latest known capacity, or null when the mount never reported one. */
  totalBytes: number | null;
  /** Fitted growth (bytes/day) — null when the fit does not qualify. */
  slopePerDay: number | null;
  /** Projected days until full — null exactly when `computeStorageForecast`
   *  would leave this mount out (too few points, not growing, no capacity,
   *  beyond FORECAST_MAX_DAYS). */
  daysUntilFull: number | null;
}

/**
 * The fit, from one mount's daily points. Pure; mirrors
 * `computeStorageForecast` rule for rule — the same minimum point count, the
 * same "growing only" gate, the same capacity and horizon cut-offs, and the
 * same regression (`leastSquaresSlopePerDay` is the documented JS twin of
 * Postgres `regr_slope` over epoch days) — so the forecast drawn under an
 * alert says the same number the alert fired on. Points that do not qualify
 * still come back, so the history can be drawn without a projection.
 */
export function forecastFromDailyPoints(
  points: TrendPoint[],
  totalBytes: number | null,
  minPoints: number = FORECAST_MIN_POINTS,
): StorageForecastSeries {
  const none = { points, totalBytes, slopePerDay: null, daysUntilFull: null };
  if (points.length < minPoints || totalBytes == null || totalBytes <= 0) return none;
  const slope = leastSquaresSlopePerDay(points);
  if (slope == null || slope <= 0) return none;
  const days = daysUntilFull({ slopePerDay: slope, currentUsed: points[points.length - 1]!.v, totalBytes });
  if (days == null || days > FORECAST_MAX_DAYS) return none;
  return { points, totalBytes, slopePerDay: slope, daysUntilFull: Math.round(days * 10) / 10 };
}

/**
 * One mount's forecast series — what the alert email's storage forecast chart
 * draws. ONE read of the same daily points as `computeStorageForecast`
 * (`dailyPointsCte`, narrowed to the asset and mount), then the fit in JS.
 * Read-only; a failed read is the caller's to degrade.
 */
export async function loadStorageForecastSeries(
  assetId: string,
  mountPath: string,
  lookbackDays: number = FORECAST_LOOKBACK_DAYS,
): Promise<StorageForecastSeries> {
  const rows = await prisma.$queryRawUnsafe<Array<{ day: Date; used: number | null; total: number | null }>>(
    `${dailyPointsCte(
      ` AND s."assetId" = $2 AND s."mountPath" = $3`,
      ` AND d."assetId" = $2 AND d."mountPath" = $3`,
    )}
     SELECT day, used, total FROM dedup ORDER BY day`,
    String(lookbackDays),
    assetId,
    mountPath,
  );
  const points: TrendPoint[] = [];
  let total: number | null = null;
  for (const r of rows) {
    if (r.used == null) continue;
    points.push({ t: new Date(r.day).getTime(), v: Number(r.used) });
    // The newest day that reported a capacity wins, as in the fleet query.
    if (r.total != null) total = Number(r.total);
  }
  return forecastFromDailyPoints(points, total);
}
