/**
 * src/services/sampleRetentionService.ts
 *
 * Global sample-retention policy, edited from the Server Settings → Retention
 * card and stored in `Setting("sampleRetention")`.
 *
 * Why global: retention is a storage concern, not a per-device concern —
 * operators tune it because disk fills up, which is a fleet-wide question. The
 * tiered model (detail / hourly / daily) is uniform across the fleet so the
 * rollup writer produces one set of *_hourly / *_daily rows every consumer reads.
 *
 * Axis: per-ENTITY, not per-asset-class. The volume driver is the kind of thing
 * being sampled (interfaces, with per-port cardinality, dwarf per-asset data),
 * not whether the asset is a switch vs an AP. The configurable entities are:
 *
 *   assets       — asset_monitor_samples        (per-asset response-time probe)
 *   cpuMem       — asset_telemetry_samples       (per-asset CPU / memory)
 *   hardware     — asset_hardware_sensor_samples  (per hardware sensor)
 *   interfaces   — asset_interface_samples        (per-interface)
 *   storage      — asset_storage_samples          (per-volume)
 *   ipsec        — asset_ipsec_tunnel_samples     (per-tunnel)
 *
 * Selection split: for interfaces / storage / ipsec the configured retention
 * applies to OPERATOR-SELECTED (monitored) entities only — their samples are
 * stamped `cadence="fast"` and kept at full retention with rollups. UNSELECTED
 * (bulk) samples (`cadence="slow"` / legacy NULL) are kept for a FIXED
 * `UNSELECTED_DETAIL_HOURS` and never rolled up; that 24h is a property of being
 * unselected, not a configurable cell. assets / cpuMem / hardware have no
 * selection concept — their retention applies to every row.
 *
 * NOTE `interfaces` no longer WRITES unselected rows (pinned-only cutover,
 * 2026-08): unpinned interfaces produce no sample rows at all, and current
 * state for every interface lives in the `AssetInterface` table instead. Its
 * detail tier is therefore all-`fast` and keeps the configured retention like
 * an ordinary stream. It stays in SELECTION_AWARE_ENTITIES because the slow
 * prune arm is still the drain for pre-cutover rows, and the arm is shared
 * with storage + ipsec, which DO still write them.
 *
 * FLAT entities: a second, non-tiered dimension in the same Setting row for
 * tables that are current-state-with-age rather than tiered time-series, so
 * detail/hourly/daily would be meaningless. Today that's:
 *
 *   appMapConnections — asset_process_connections   (Application Map socket facts)
 *   arpEntries        — asset_arp_entries           (FortiGate IP neighbour cache)
 *   pathCheckTraceroutes — asset_path_check_traceroutes (path snapshots; a
 *                       standalone HYPERTABLE, pruned by drop_chunks — the
 *                       flat window is just its one retention number)
 *
 * They carry a single `{ days }` window using the same encoding as a tier, and
 * they also bound what the reading surface can show — the Application Map's
 * "Seen within" range is derived from this number so the widest option can't
 * promise more history than is retained.
 *
 * Encoding (per tier, and per flat window): positive = N days; 0 = OFF (pruned
 * away — do not keep this tier); FOREVER (-1) = keep forever. NOTE: this flips
 * the legacy meaning of 0 (which meant "keep forever"); the one-shot migration
 * translates legacy 0 → FOREVER. See migrateSampleRetentionToEntities.
 *
 * Defaults: 7 days detail / 30 days hourly / 365 days daily, uniform across
 * entities. Operators tune from the Retention card.
 *
 * In-process cache with a 5-second TTL: prune reads this once per nightly tick,
 * but chart history endpoints resolve retention on every request, so the cache
 * avoids a DB roundtrip per chart open. Invalidated on every write.
 */

import { prisma } from "../db.js";

export const SETTING_KEY = "sampleRetention";

/** Sentinel: keep this tier forever (never prune). */
export const FOREVER = -1;

/** Fixed retention for UNSELECTED (bulk) interface / storage / ipsec samples.
 *  Not operator-configurable — a property of being unselected. No rollup. */
export const UNSELECTED_DETAIL_HOURS = 24;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Time window for the unselected/slow detail prune (interface / storage / ipsec).
 * Slow rows (cadence="slow" or legacy NULL) older than UNSELECTED_DETAIL_HOURS
 * are deleted — but ONLY back to the compressed-chunk frontier.
 *
 * Why the lower bound: a row-level DELETE that matches rows inside a COMPRESSED
 * TimescaleDB chunk forces the whole chunk to be decompressed into its rowstore
 * heap to perform the delete; autovacuum then reclaims the dead tuples to the
 * FSM but never returns the pages to the OS, leaving multi-GB of un-truncatable
 * low-density heap (prod incident 2026-06-08: chunks at 0 live tuples / 10 GB
 * on disk holding ~350 MB of real compressed data). Slow rows that age past the
 * compress-after window therefore ride along compressed (negligible bytes)
 * until drop_chunks removes the whole chunk at the selected-retention boundary.
 *
 * Returns `{ gte, lt }`: delete slow rows with `gte <= timestamp < lt`.
 * `gte` is null (legacy unbounded behavior) when:
 *   - compression is disabled (`compressAfterDays <= 0`) — no chunk is ever
 *     compressed, so the delete can safely reach all the way back; or
 *   - the compress frontier is not strictly older than the 24h cutoff
 *     (`compressAfterDays <= 1`) — bounding there would make the window empty
 *     and slow rows would never prune. Selection-aware tables floor compress-
 *     after at 2 days, so in practice `gte` is always set for them.
 *
 * Pure / side-effect-free for unit testing — pass `Date.now()` as `nowMs`.
 */
export function unselectedSlowPruneWindow(
  nowMs: number,
  compressAfterDays: number,
): { gte: Date | null; lt: Date } {
  const lt = new Date(nowMs - UNSELECTED_DETAIL_HOURS * 3600 * 1000);
  const frontierMs = nowMs - compressAfterDays * DAY_MS;
  const gte = compressAfterDays > 0 && frontierMs < lt.getTime() ? new Date(frontierMs) : null;
  return { gte, lt };
}

/**
 * Window for a by-days tier prune — the hourly/daily rollup tiers of every
 * entity, plus the detail tiers of the non-selection-aware streams (monitor /
 * cpuMem / hardware / perfSla). Mirrors `unselectedSlowPruneWindow`'s
 * compression-frontier safety, generalized for the common rollup case where
 * the retention cutoff is much OLDER than the compression frontier.
 *
 * `drop_chunks(cutoff)` (called by the prune layer regardless of this result)
 * removes whole chunks entirely older than the cutoff in O(1). What's left to
 * clean is the residue inside the single chunk straddling the cutoff. The
 * danger: that straddling chunk is usually COMPRESSED (it sits well past the
 * compress-after frontier for long-retention rollup tiers), and a row-level
 * DELETE matching compressed rows forces TimescaleDB to decompress the whole
 * chunk into its rowstore heap — leaving multi-GB of un-truncatable low-density
 * heap. This is the exact mechanism behind the 2026-06-08 and 2026-06-17 prod
 * incidents (the latter: a 30-day `asset_interface_samples_hourly` deleteMany
 * decompressing chunks, fanning into a tuple-lock pile-up that pinned the xmin
 * horizon and pegged every core).
 *
 * Returns `{ cutoff, gte, skipRowDelete }`:
 *  - `cutoff`         — the retention boundary; the caller passes it to drop_chunks.
 *  - `skipRowDelete`  — true when EVERY row older than the cutoff is at/beyond the
 *                       compression frontier (the rollup case). No row-DELETE runs;
 *                       drop_chunks alone reclaims the data once the straddling
 *                       chunk fully ages past the cutoff (≤ one chunk_interval of
 *                       harmless over-retention).
 *  - `gte`            — when the cutoff is NEWER than the frontier (short retention,
 *                       e.g. an operator-shortened tier), the row-DELETE is bounded
 *                       to the uncompressed window `[frontier, cutoff)`; rows older
 *                       than the frontier ride compressed until drop_chunks. `gte`
 *                       is null when compression is disabled — then the residue
 *                       DELETE is unbounded (`< cutoff`), which is safe.
 *
 * Pure / side-effect-free for unit testing — pass `Date.now()` as `nowMs`.
 */
export function tieredPruneWindow(
  nowMs: number,
  retentionDays: number,
  compressAfterDays: number,
): { cutoff: Date; gte: Date | null; skipRowDelete: boolean } {
  const cutoff = new Date(retentionDays <= 0 ? nowMs : nowMs - retentionDays * DAY_MS);
  if (compressAfterDays <= 0) {
    // No compression policy → no chunk can be decompressed; delete all residue.
    return { cutoff, gte: null, skipRowDelete: false };
  }
  const frontierMs = nowMs - compressAfterDays * DAY_MS;
  if (frontierMs >= cutoff.getTime()) {
    // Everything we'd delete sits at/beyond the compression frontier — leave it
    // to drop_chunks, never row-DELETE into a compressed chunk.
    return { cutoff, gte: null, skipRowDelete: true };
  }
  // Cutoff is newer than the frontier: delete only the uncompressed window.
  return { cutoff, gte: new Date(frontierMs), skipRowDelete: false };
}

export type RetentionEntity =
  | "assets"
  | "cpuMem"
  | "hardware"
  | "interfaces"
  | "storage"
  | "ipsec"
  | "perfSla"
  | "pathCheck"
  | "process";
export type RetentionTier = "detail" | "hourly" | "daily";

export const RETENTION_ENTITIES: RetentionEntity[] = [
  "assets",
  "cpuMem",
  "hardware",
  "interfaces",
  "storage",
  "ipsec",
  "perfSla",
  "pathCheck",
  "process",
];

/** Entities with a single window instead of detail/hourly/daily tiers — see the
 *  "FLAT entities" note in the file header. `pathCheckTraceroutes` is the
 *  path-snapshot table: averaging a path means nothing, so it has no tiers. */
export type FlatRetentionEntity = "appMapConnections" | "arpEntries" | "pathCheckTraceroutes";

export const FLAT_RETENTION_ENTITIES: FlatRetentionEntity[] = ["appMapConnections", "arpEntries", "pathCheckTraceroutes"];

export interface FlatRetention {
  days: number;
}

/** Entities whose configured retention applies to SELECTED rows only
 *  (unselected rows are fixed at UNSELECTED_DETAIL_HOURS, no rollup). */
export const SELECTION_AWARE_ENTITIES: RetentionEntity[] = ["interfaces", "storage", "ipsec"];

export interface TierRetention {
  detail: number;
  hourly: number;
  daily: number;
}

/** Intersection, not a union member: `retention[tieredEntity][tier]` keeps
 *  working unchanged while flat entities read `retention.appMapConnections.days`. */
export type SampleRetention =
  Record<RetentionEntity, TierRetention> & Record<FlatRetentionEntity, FlatRetention>;

// SolarWinds-style defaults. Operators tune from the Retention card.
const DEFAULT_DETAIL_DAYS = 7;
const DEFAULT_HOURLY_DAYS = 30;
const DEFAULT_DAILY_DAYS = 365;

/** Default window for the Application Map's connection facts.
 *
 *  POLARIS_PROCESS_CONN_RETENTION_DAYS used to be the authority for this table.
 *  It is now only the DEFAULT SEED: an install that set the env keeps its number
 *  until an operator saves the Retention card, after which the Setting wins and
 *  there is exactly one source of truth. */
const DEFAULT_APPMAP_CONN_DAYS = 30;

function defaultAppMapConnDays(): number {
  const v = Number(process.env.POLARIS_PROCESS_CONN_RETENTION_DAYS);
  return Number.isFinite(v) && v > 0 ? Math.trunc(v) : DEFAULT_APPMAP_CONN_DAYS;
}

function defaultTier(): TierRetention {
  return { detail: DEFAULT_DETAIL_DAYS, hourly: DEFAULT_HOURLY_DAYS, daily: DEFAULT_DAILY_DAYS };
}

export function defaultSampleRetention(): SampleRetention {
  return {
    assets:      defaultTier(),
    cpuMem:      defaultTier(),
    hardware:    defaultTier(),
    interfaces:  defaultTier(),
    storage:     defaultTier(),
    ipsec:       defaultTier(),
    perfSla:     defaultTier(),
    pathCheck: defaultTier(),
    process:     defaultTier(),
    appMapConnections: { days: defaultAppMapConnDays() },
    // How far back the ARP Table tab's range selector can reach. 30 days
    // matches its widest option and the appMapConnections precedent; the table
    // is interval-per-binding, so this bounds distinct bindings retained, not
    // scrapes.
    arpEntries: { days: 30 },
    // Traceroute snapshots for path checks. 30 days is enough to answer
    // "has this path changed since last month" without the ~2 KB rows (every
    // 5th run per check per agent host) dominating the database.
    pathCheckTraceroutes: { days: 30 },
  };
}

// In-process cache. Short TTL so an admin PUT is visible to chart queries
// within a few seconds, but a hot path (every chart request) doesn't hit the DB.
const CACHE_TTL_MS = 5000;
let cache: { value: SampleRetention; fetchedAt: number } | null = null;

export function invalidateSampleRetentionCache(): void {
  cache = null;
}

/** Accept positive (N days), 0 (tier off), or FOREVER (-1). Anything else
 *  (NaN, < -1) falls back. */
function toRetentionDays(v: unknown, fallback: number): number {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < FOREVER) return fallback;
  return Math.trunc(n);
}

function parseTier(raw: unknown, fallback: TierRetention): TierRetention {
  if (raw == null || typeof raw !== "object") return { ...fallback };
  const r = raw as Record<string, unknown>;
  return {
    detail: toRetentionDays(r.detail, fallback.detail),
    hourly: toRetentionDays(r.hourly, fallback.hourly),
    daily:  toRetentionDays(r.daily,  fallback.daily),
  };
}

function parseFlat(raw: unknown, fallback: FlatRetention): FlatRetention {
  if (raw == null || typeof raw !== "object") return { ...fallback };
  const r = raw as Record<string, unknown>;
  return { days: toRetentionDays(r.days, fallback.days) };
}

function parseSampleRetention(raw: unknown): SampleRetention {
  const fallback = defaultSampleRetention();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const out = {} as SampleRetention;
  for (const e of RETENTION_ENTITIES) out[e] = parseTier(r[e], fallback[e]);
  // Stored rows that predate a flat entity simply lack the key and inherit the
  // default here — that's why adding one needs no migration.
  for (const e of FLAT_RETENTION_ENTITIES) out[e] = parseFlat(r[e], fallback[e]);
  return out;
}

export async function getSampleRetention(): Promise<SampleRetention> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.value;
  }
  const row = await prisma.setting.findUnique({ where: { key: SETTING_KEY } });
  const value = parseSampleRetention(row?.value);
  cache = { value, fetchedAt: now };
  return value;
}

function mergeTier(current: TierRetention, input: unknown): TierRetention {
  if (input == null || typeof input !== "object") return { ...current };
  const i = input as Record<string, unknown>;
  return {
    detail: i.detail == null ? current.detail : toRetentionDays(i.detail, current.detail),
    hourly: i.hourly == null ? current.hourly : toRetentionDays(i.hourly, current.hourly),
    daily:  i.daily  == null ? current.daily  : toRetentionDays(i.daily,  current.daily),
  };
}

function mergeFlat(current: FlatRetention, input: unknown): FlatRetention {
  if (input == null || typeof input !== "object") return { ...current };
  const i = input as Record<string, unknown>;
  return { days: i.days == null ? current.days : toRetentionDays(i.days, current.days) };
}

function mergeRetention(
  current: SampleRetention,
  input: Partial<SampleRetention> | Record<string, unknown>,
): SampleRetention {
  const i = input as Record<string, unknown>;
  const out = {} as SampleRetention;
  for (const e of RETENTION_ENTITIES) out[e] = i[e] == null ? { ...current[e] } : mergeTier(current[e], i[e]);
  for (const e of FLAT_RETENTION_ENTITIES) out[e] = i[e] == null ? { ...current[e] } : mergeFlat(current[e], i[e]);
  return out;
}

/**
 * Replace the stored retention. Missing fields inherit from the current stored
 * value (partial PUT merges cleanly). Each numeric is validated to a day count,
 * 0 (off), or FOREVER (-1); out-of-range / non-numeric values keep the existing
 * stored value.
 */
export async function updateSampleRetention(
  input: Partial<SampleRetention> | Record<string, unknown>,
): Promise<SampleRetention> {
  const current = await getSampleRetention();
  const merged = mergeRetention(current, input);
  await prisma.setting.upsert({
    where:  { key: SETTING_KEY },
    update: { value: merged as any },
    create: { key: SETTING_KEY, value: merged as any },
  });
  invalidateSampleRetentionCache();
  return merged;
}

/** Retention days for one (entity, tier). Returns 0 (tier off) or FOREVER (-1)
 *  as stored. */
export function getRetentionDays(
  retention: SampleRetention,
  entity: RetentionEntity,
  tier: RetentionTier,
): number {
  return retention[entity][tier];
}

/**
 * Configured window (days) for the Application Map's connection facts. Returns 0
 * (prune everything) or FOREVER (-1) as stored. Two callers, both fine on the
 * 5-second cache: the nightly prune, and the graph endpoint — which uses it to
 * bound its read AND to tell the client how far back "Seen within" can reach, so
 * the widest option can't promise history that was already pruned.
 */
export async function getAppMapConnectionRetentionDays(): Promise<number> {
  return (await getSampleRetention()).appMapConnections.days;
}

/**
 * Configured window (days) for the ARP Table tab's neighbour rows. Same two
 * callers and the same reason as the Application Map's: the nightly prune, and
 * the tab endpoint — which reports it so the range selector cannot offer
 * "last 30 days" on an install that only keeps 7.
 */
export async function getArpEntryRetentionDays(): Promise<number> {
  return (await getSampleRetention()).arpEntries.days;
}

/** Configured window (days) for path-check traceroute snapshots. */
export async function getPathCheckTracerouteRetentionDays(): Promise<number> {
  return (await getSampleRetention()).pathCheckTraceroutes.days;
}
