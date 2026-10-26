/**
 * src/services/memoryForecastService.ts
 *
 * Per-asset "days until memory full" forecasting — the shared computation
 * behind the Memory chart's forecast overlay on the asset System tab
 * (GET /assets/:id/memory-forecast) and the memDaysUntilFull automation
 * metric (notificationEngine resolver). The memory twin of
 * storageForecastService, and deliberately shaped like it: the same 30-day
 * lookback, the same ≥ 7 daily points, the same growing-only gate and the
 * same 365-day horizon, so an operator who has learnt one forecast has learnt
 * both. The same fit also answers the memForecastPct metric
 * (computeMemoryProjection): the level memory reaches N days out, so an
 * automation's severity levels can be the memory levels it warns about.
 *
 * What is fitted: memory IN USE as a percentage of installed memory, one
 * point per day. Bytes when the source reports them (used / total — the
 * agent's "resident in processes" figure, so reclaimable page cache never
 * reads as a leak), otherwise the source's own percentage (FortiOS). A
 * percentage rather than bytes so a resized VM does not read as a sudden
 * growth spurt, and so the one fit covers every telemetry source.
 *
 * Trend source: the telemetry ROLLUPS, never the detail table. Telemetry is
 * sampled every ~60s for every monitored asset, so 30 days of detail at 2000
 * assets is tens of millions of rows — read on every engine tick that would
 * dominate the database. The daily rollup carries every asset (telemetry
 * rollups have no cadence filter, unlike storage's) at one row per asset per
 * day; the last two days are re-derived from the HOURLY rollup instead,
 * because the daily bucket for today (and, until the daily job's next run,
 * yesterday) can lag behind. One aggregate query via regr_slope — ~32 rows per
 * asset, flat at 2000 assets. READ-ONLY.
 */

import { prisma } from "../db.js";
import { daysUntilFull, leastSquaresSlopePerDay, type TrendPoint } from "../utils/linearTrend.js";
import type { ForecastLevel } from "./notificationTypes.js";

export interface MemoryForecastRow {
  assetId: string;
  /** Projected days until memory in use reaches 100% (≥ 0; 0 = full now). */
  daysUntilFull: number;
  /** The newest day's average memory in use (0–100). */
  usedPct: number;
  /** Fitted growth rate (percentage points per day). */
  slopePctPerDay: number;
  /** Distinct daily points the fit used. */
  points: number;
}

/** Trend lookback (days) — the storage forecast's window. */
export const MEMORY_FORECAST_LOOKBACK_DAYS = 30;
/** Minimum distinct daily points for a fit (a fresh install / new asset stays quiet). */
export const MEMORY_FORECAST_MIN_POINTS = 7;
/** Forecasts beyond this horizon are dropped — beyond a year is noise, not planning. */
export const MEMORY_FORECAST_MAX_DAYS = 365;
/** Days at the recent end re-derived from the hourly rollup (see header). */
const HOURLY_TAIL_DAYS = 2;

/** One rollup row's memory in use, as a percentage — bytes first, else the source's own %. */
function pctExpr(alias: string): string {
  return `CASE WHEN ${alias}."avgMemUsedBytes" IS NOT NULL AND ${alias}."lastMemTotalBytes" > 0
            THEN ${alias}."avgMemUsedBytes"::float8 / ${alias}."lastMemTotalBytes"::float8 * 100.0
            ELSE ${alias}."avgMemPct" END`;
}

/**
 * The per-(asset, day) points every memory forecast is fitted on, as a `WITH`
 * clause ending in `dedup`. ONE definition, shared by the fleet-wide fit and
 * the single-asset series the chart draws, so the overlay quotes the number
 * the automation compares. `$1` is always the lookback in days; the filter
 * argument narrows both arms (it must reference the alias `r`).
 */
function dailyPointsCte(filter: string): string {
  return `WITH hourly AS (
       SELECT r."assetId" AS "assetId", date_trunc('day', r."bucketStart") AS day,
              ${pctExpr("r")} AS pct, r."sampleCount" AS n
       FROM "asset_telemetry_samples_hourly" r
       WHERE r."bucketStart" > date_trunc('day', (now() AT TIME ZONE 'UTC')) - interval '${HOURLY_TAIL_DAYS - 1} days'${filter}
     ),
     pts AS (
       -- Recent days from the hourly tier (prio 0), weighted by sample count
       -- like the daily rollup itself is.
       SELECT "assetId", day, 0 AS prio,
              SUM(pct * n) / NULLIF(SUM(n), 0) AS pct
       FROM hourly WHERE pct IS NOT NULL
       GROUP BY 1, 2
       UNION ALL
       SELECT r."assetId", r."bucketStart" AS day, 1 AS prio, ${pctExpr("r")} AS pct
       FROM "asset_telemetry_samples_daily" r
       WHERE r."bucketStart" > (now() AT TIME ZONE 'UTC') - ($1 || ' days')::interval${filter}
     ),
     dedup AS (
       -- A recent day can be in both tiers; the hourly-derived one is the
       -- fresher, so it wins.
       SELECT DISTINCT ON ("assetId", day) "assetId", day, LEAST(GREATEST(pct, 0), 100) AS pct
       FROM pts WHERE pct IS NOT NULL
       ORDER BY "assetId", day, prio
     )`;
}

interface FitRow {
  assetId: string;
  slope_per_day: number | null;
  points: number;
  last_pct: number | null;
}

/** Every asset's fit with enough points, ANY slope (`growingOnly` narrows it
 *  in SQL). One aggregate query — the shared read behind both fleet-wide
 *  answers below. */
async function loadFits(
  assetIds: string[] | null,
  lookbackDays: number,
  minPoints: number,
  growingOnly: boolean,
): Promise<FitRow[]> {
  const params: unknown[] = [String(lookbackDays), minPoints];
  if (assetIds) params.push(assetIds);
  const filter = assetIds ? ` AND r."assetId" = ANY($3::text[])` : "";
  return prisma.$queryRawUnsafe<FitRow[]>(
    `${dailyPointsCte(filter)}
     SELECT "assetId",
            regr_slope(pct, extract(epoch from day)::float8 / 86400.0) AS slope_per_day,
            count(*)::int AS points,
            (ARRAY_AGG(pct ORDER BY day DESC))[1] AS last_pct
     FROM dedup
     GROUP BY 1
     HAVING count(*) >= $2${growingOnly ? `
        AND regr_slope(pct, extract(epoch from day)::float8 / 86400.0) > 0` : ""}`,
    ...params,
  );
}

/** One asset's memory projection over a forecast horizon. */
export interface MemoryProjectionRow {
  assetId: string;
  /** Memory in use (0–100) the trend reaches `horizonDays` out — null when the
   *  host's memory is not growing (no projection to warn about). */
  projectedPct: number | null;
  /** The newest day's average memory in use (0–100). */
  usedPct: number;
  /** Fitted growth rate (percentage points per day), any sign. */
  slopePctPerDay: number;
}

/**
 * The level memory in use reaches `horizonDays` from now, from the newest
 * day's average and the fitted slope, capped at 100. Pure. Null when the trend
 * is flat or shrinking: "projected to reach 85% within 14 days" about a host
 * that has sat at 85% all month is the memory-utilization automation's alert,
 * not a forecast — and a null reading is what ends a forecast alert once the
 * growth stops.
 */
export function projectMemoryPct(usedPct: number, slopePerDay: number, horizonDays: number): number | null {
  if (!Number.isFinite(usedPct) || !Number.isFinite(slopePerDay) || slopePerDay <= 0) return null;
  const v = Math.min(100, Math.max(0, usedPct) + slopePerDay * Math.max(0, horizonDays));
  return Math.round(v * 10) / 10;
}

/** Has memory at `pct` reached `level`, by the level's own comparison? */
function reached(pct: number, level: ForecastLevel): boolean {
  return level.strict ? pct > level.threshold : pct >= level.threshold;
}

/**
 * The level a memForecastPct alert counts down to: the LOWEST of the
 * automation's levels memory has not reached yet. A level already passed is
 * the memory-utilization automation's alert, not a forecast — so a host past
 * serious counts down to critical, and one past every level has no target.
 * Pure; null when there is none.
 */
export function nextForecastLevel(usedPct: number, levels: ForecastLevel[]): ForecastLevel | null {
  const sorted = [...levels].sort((a, b) => a.threshold - b.threshold);
  return sorted.find((l) => !reached(usedPct, l)) ?? null;
}

/**
 * The memForecastPct reading for one host: the projected level, but placed so
 * the ordinary severity ladder (business rule 19) lands on the NEXT level the
 * host has not reached — "Days until Serious", then once past serious "Days
 * until Critical". Null (no alert; a live one ends) when memory is not
 * growing, when every level is already passed, or when the next level is not
 * reached within `horizonDays`. Otherwise the projection, capped just below
 * the level after the next one, so a host that would sail through serious AND
 * critical inside the window still counts down to serious first. Pure.
 */
export function forecastLevelReading(usedPct: number, slopePerDay: number, horizonDays: number, levels: ForecastLevel[]): number | null {
  const projected = projectMemoryPct(usedPct, slopePerDay, horizonDays);
  if (projected == null) return null;
  const next = nextForecastLevel(usedPct, levels);
  if (!next || !reached(projected, next)) return null;
  const after = [...levels].sort((a, b) => a.threshold - b.threshold).find((l) => l.threshold > next.threshold);
  if (!after) return projected;
  // Just short of the following level by ITS comparison: `>` is not met AT its
  // threshold, `>=` is, so the cap sits a hair below it.
  const cap = after.strict ? after.threshold : after.threshold - 0.001;
  return Math.max(next.threshold, Math.min(projected, cap));
}

/**
 * The memForecastPct automation reading: for every asset with at least
 * `minPoints` daily points, the memory in use projected `horizonDays` out
 * (null for a host that is not growing). A host with too little history has
 * NO row — the engine then leaves any alert it already had frozen, as for any
 * device that reported nothing. Same fit as `computeMemoryForecast`.
 */
export async function computeMemoryProjection(
  assetIds: string[] | null,
  horizonDays: number,
  lookbackDays: number = MEMORY_FORECAST_LOOKBACK_DAYS,
  minPoints: number = MEMORY_FORECAST_MIN_POINTS,
): Promise<MemoryProjectionRow[]> {
  if (assetIds && assetIds.length === 0) return [];
  const rows = await loadFits(assetIds, lookbackDays, minPoints, false);
  const out: MemoryProjectionRow[] = [];
  for (const r of rows) {
    if (r.last_pct == null) continue;
    const used = Number(r.last_pct);
    const slope = r.slope_per_day == null ? 0 : Number(r.slope_per_day);
    out.push({
      assetId: r.assetId,
      projectedPct: projectMemoryPct(used, slope, horizonDays),
      usedPct: Math.round(used * 10) / 10,
      slopePctPerDay: Math.round(slope * 1000) / 1000,
    });
  }
  return out;
}

export async function computeMemoryForecast(
  assetIds: string[] | null = null,
  lookbackDays: number = MEMORY_FORECAST_LOOKBACK_DAYS,
  minPoints: number = MEMORY_FORECAST_MIN_POINTS,
): Promise<MemoryForecastRow[]> {
  if (assetIds && assetIds.length === 0) return [];
  const rows = await loadFits(assetIds, lookbackDays, minPoints, true);

  const out: MemoryForecastRow[] = [];
  for (const r of rows) {
    if (r.slope_per_day == null || r.last_pct == null) continue;
    const days = daysUntilFull({ slopePerDay: Number(r.slope_per_day), currentUsed: Number(r.last_pct), totalBytes: 100 });
    if (days == null || days > MEMORY_FORECAST_MAX_DAYS) continue;
    out.push({
      assetId: r.assetId,
      daysUntilFull: Math.round(days * 10) / 10,
      usedPct: Math.round(Number(r.last_pct) * 10) / 10,
      slopePctPerDay: Math.round(Number(r.slope_per_day) * 1000) / 1000,
      points: r.points,
    });
  }
  out.sort((a, b) => a.daysUntilFull - b.daysUntilFull);
  return out;
}

/** One asset's memory forecast, with the daily points it was fitted on. */
export interface MemoryForecastSeries {
  /** Daily average memory in use (0–100), ascending by day (`t` = the day's UTC start). */
  points: TrendPoint[];
  /** Fitted trend (percentage points per day), ANY sign — null only when there
   *  are too few points to fit. The chart draws flat and shrinking trends too. */
  slopePerDay: number | null;
  /** Projected days until full — null exactly when `computeMemoryForecast`
   *  would leave this asset out (too few points, not growing, beyond
   *  MEMORY_FORECAST_MAX_DAYS). */
  daysUntilFull: number | null;
  /** Thresholds the fit used, so a reader can say "needs N days of history". */
  minPoints: number;
  lookbackDays: number;
}

/**
 * The fit, from one asset's daily points. Pure; mirrors `computeMemoryForecast`
 * rule for rule (same minimum point count, growing-only gate for
 * daysUntilFull, same horizon, and `leastSquaresSlopePerDay` is the JS twin of
 * Postgres `regr_slope` over epoch days).
 */
export function memoryForecastFromDailyPoints(
  points: TrendPoint[],
  minPoints: number = MEMORY_FORECAST_MIN_POINTS,
  lookbackDays: number = MEMORY_FORECAST_LOOKBACK_DAYS,
): MemoryForecastSeries {
  const base = { points, minPoints, lookbackDays };
  if (points.length < minPoints) return { ...base, slopePerDay: null, daysUntilFull: null };
  const slope = leastSquaresSlopePerDay(points);
  if (slope == null) return { ...base, slopePerDay: null, daysUntilFull: null };
  const days = daysUntilFull({ slopePerDay: slope, currentUsed: points[points.length - 1]!.v, totalBytes: 100 });
  return {
    ...base,
    slopePerDay: slope,
    daysUntilFull: days == null || days > MEMORY_FORECAST_MAX_DAYS ? null : Math.round(days * 10) / 10,
  };
}

/**
 * One asset's forecast series — what the Memory chart's overlay draws. ONE
 * read of the same daily points as `computeMemoryForecast`, narrowed to the
 * asset, then the fit in JS. Read-only.
 */
export async function loadMemoryForecastSeries(
  assetId: string,
  lookbackDays: number = MEMORY_FORECAST_LOOKBACK_DAYS,
): Promise<MemoryForecastSeries> {
  const rows = await prisma.$queryRawUnsafe<Array<{ day: Date; pct: number | null }>>(
    `${dailyPointsCte(` AND r."assetId" = $2`)}
     SELECT day, pct FROM dedup ORDER BY day`,
    String(lookbackDays),
    assetId,
  );
  const points: TrendPoint[] = [];
  for (const r of rows) {
    if (r.pct == null) continue;
    points.push({ t: new Date(r.day).getTime(), v: Number(r.pct) });
  }
  return memoryForecastFromDailyPoints(points, MEMORY_FORECAST_MIN_POINTS, lookbackDays);
}
