/**
 * src/services/sampleQueryRouter.ts
 *
 * Picks which storage tier a chart history query should read from based on
 * the requested range and the operator's configured retention windows.
 * Phase 4 of the tiered sample-retention work.
 *
 * Rule (oldest-point-wins):
 *   - If `from >= now − detailDays` → read raw detail samples.
 *   - Else if `from >= now − hourlyDays` → read hourly rollups.
 *   - Else → read daily rollups.
 *
 * Pure — no I/O, no DB. Each chart history endpoint calls this once after
 * parsing the range, then dispatches to a tier-specific reader.
 *
 * Phase 4 ships with `DEFAULT_TIER_RETENTION` (matches the SolarWinds
 * defaults 7 / 30 / 365). Phase 5 swaps the per-endpoint usage of these
 * defaults for `resolveMonitorSettings(asset)` so per-asset operator
 * overrides actually win.
 */

export type SampleTier = "detail" | "hourly" | "daily";

export interface TierRetention {
  /** Days of detail samples kept. Range > this → drop to hourly. */
  detailDays: number;
  /** Days of hourly rollups kept. Range > this → drop to daily. */
  hourlyDays: number;
}

export interface TierPick {
  tier: SampleTier;
  /** 0 for detail, 3600 for hourly, 86400 for daily. Surface this to the
   *  client so chart renderers can show a "Hourly avg" / "Daily avg" badge
   *  and counter-rate readers know their denominator. */
  bucketSeconds: 0 | 3600 | 86400;
}

const SECONDS_PER_DAY = 86400;

/**
 * Slack on each tier boundary. The preset ranges are exactly as long as the
 * default windows (7d = detailDays, 30d = hourlyDays), and the route computes
 * `since = now − range` BEFORE this function reads its own `Date.now()` —
 * across an await on the retention settings. With no slack the pick hinged on
 * whether those two clocks landed in the same millisecond: a warm settings
 * cache (charts loaded together) read hourly, a cold one (the periodic
 * refresh, > 5 s later) read daily, so a 30-day chart redrew at a coarser
 * resolution a few minutes after opening. Five minutes also absorbs a client
 * that computes its own from/to for a preset.
 */
const TIER_BOUNDARY_GRACE_MS = 5 * 60 * 1000;

/**
 * Tier defaults matching the SolarWinds-style tiering. Used as a fallback
 * when the asset-aware resolver isn't applicable (e.g. tests, fixture
 * data). Production endpoints route through `pickSampleTierForAsset`
 * which consults `Setting("sampleRetention")` per asset class.
 */
export const DEFAULT_TIER_RETENTION: TierRetention = {
  detailDays: 7,
  hourlyDays: 30,
};

/**
 * Pick the right tier for a query whose oldest requested point is `since`.
 *
 * The decision uses ONLY `since`, not `until`, because the oldest point is
 * the binding constraint: a query that asks for the last 30 days needs a
 * tier that has 30-day-old data. The newest point is always available in
 * the detail tier (because detail retention covers "recent"), but for
 * uniformity the entire query reads from one tier.
 */
export function pickSampleTier(
  since: Date,
  retention: TierRetention = DEFAULT_TIER_RETENTION,
): TierPick {
  const now = Date.now();
  const sinceMs = since.getTime();
  // Encoding: FOREVER (-1) → tier covers all of history; 0 → tier off (no data,
  // fall through to the next tier); positive → covers the last N days.
  const covers = (days: number) =>
    days === FOREVER ? true
      : days === 0 ? false
      : sinceMs >= now - days * SECONDS_PER_DAY * 1000 - TIER_BOUNDARY_GRACE_MS;

  if (covers(retention.detailDays)) return { tier: "detail", bucketSeconds: 0 };
  if (covers(retention.hourlyDays)) return { tier: "hourly", bucketSeconds: 3600 };
  return { tier: "daily", bucketSeconds: SECONDS_PER_DAY };
}

/**
 * Entity-aware tier picker: resolves the configured retention for one entity
 * (assets / cpuMem / temperature / interfaces / storage / ipsec) from the
 * global Setting("sampleRetention") and applies pickSampleTier.
 *
 * `assetId` is retained in the signature for the forthcoming selection-aware
 * read (unselected interfaces have no rollup beyond 24h); it isn't consulted
 * for tier selection today.
 */
import { getSampleRetention, FOREVER, type RetentionEntity } from "./sampleRetentionService.js";

export async function pickSampleTierForAsset(
  _assetId: string,
  entity: RetentionEntity,
  since: Date,
): Promise<TierPick> {
  const tier = (await getSampleRetention())[entity];
  return pickSampleTier(since, { detailDays: tier.detail, hourlyDays: tier.hourly });
}
