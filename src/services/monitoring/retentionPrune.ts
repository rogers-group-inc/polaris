/**
 * src/services/monitoring/retentionPrune.ts — sample retention pruning (CQ-B061, moved verbatim from monitoringService.ts):
 * the per-table prune helpers and the coordinated, single-flight prune the monitor
 * fleet runs once a day (runRetentionPrune). monitoringService.ts re-exports the
 * public names, so importers are unchanged.
 */

import { prisma } from "../../db.js";
import pg from "pg";
import { dropChunks, getEffectiveCompressAfterDays } from "../timescaleService.js";
import { getSampleRetention, getAppMapConnectionRetentionDays, getArpEntryRetentionDays, FOREVER, unselectedSlowPruneWindow, tieredPruneWindow } from "../sampleRetentionService.js";
import { getDirectDatabaseUrl } from "../../utils/dbConnections.js";

// ─── Retention prune helpers ────────────────────────────────────────────────
//
// Retention is per-ENTITY (assets / cpuMem / hardware / interfaces /
// storage / ipsec) with a detail/hourly/daily tier each. Encoding per tier:
// positive = N days; 0 = tier off (prune everything); FOREVER (-1) = keep all.
//
// Selection split (interfaces / storage / ipsec only): the configured detail
// retention applies to SELECTED rows (cadence="fast" — operator-pinned). The
// UNSELECTED/bulk rows (cadence="slow" or legacy NULL) are kept only
// UNSELECTED_DETAIL_HOURS and are never rolled up. assets / cpuMem /
// hardware have no selection and prune uniformly.

type SamplePruneFn = (where: Record<string, unknown>) => Promise<{ count: number }>;

const DAY_MS = 24 * 3600 * 1000;

/**
 * Prune one tier with a single retention window (no selection split). Used for
 * assets / cpuMem / hardware (all tiers) and the hourly/daily rollup tiers
 * of every entity. `days`: >0 keep N days; 0 keep nothing; FOREVER keep all.
 *
 * When the table is a Timescale hypertable, drop whole chunks older than the
 * cutoff first (O(1), no seq-scan / lock contention). The residue inside the
 * chunk straddling the cutoff is then handled by `tieredPruneWindow`, which
 * keeps the row-DELETE strictly on the UNCOMPRESSED side of the compression
 * frontier — or skips it entirely when the whole delete set is past the
 * frontier (the common rollup case). A blanket `lt: cutoff` deleteMany here
 * would decompress chunks and bloat the heap (prod incidents 2026-06-08 and
 * 2026-06-17). No-op drop on plain Postgres.
 */
async function pruneTierByDays(
  fn: SamplePruneFn,
  days: number,
  timeColumn: "timestamp" | "bucketStart",
  hypertableName?: string,
): Promise<number> {
  if (days === FOREVER) return 0;
  const compressAfter = hypertableName ? getEffectiveCompressAfterDays(hypertableName) : 0;
  const win = tieredPruneWindow(Date.now(), days, compressAfter);
  // drop_chunks always runs at the retention cutoff — even when the row-DELETE
  // is skipped, whole aged chunks must still drop in O(1).
  if (hypertableName) await dropChunks(hypertableName, win.cutoff);
  if (win.skipRowDelete) return 0;
  const where = win.gte
    ? { [timeColumn]: { gte: win.gte, lt: win.cutoff } }
    : { [timeColumn]: { lt: win.cutoff } };
  const { count } = await fn(where);
  return count;
}

/**
 * Prune the DETAIL tier of a selection-aware entity (interfaces / storage /
 * ipsec). Selected rows (cadence="fast") keep `selectedDays`; unselected rows
 * (cadence="slow" OR legacy NULL) keep the fixed UNSELECTED_DETAIL_HOURS.
 *
 * drop_chunks uses the LONGER (selected) window so aged fast+slow chunks go in
 * O(1); the 24h slow trim then runs as a deleteMany on the (recent, ideally
 * uncompressed) residue — see the chunk-interval/compression tuning in
 * timescaleService for why recent chunks stay deletable.
 */
async function pruneSelectionAwareDetail(
  fn: SamplePruneFn,
  selectedDays: number,
  hypertableName: string,
): Promise<number> {
  const now = Date.now();
  let total = 0;
  if (selectedDays !== FOREVER) {
    const sel = selectedDays <= 0 ? new Date(now) : new Date(now - selectedDays * DAY_MS);
    await dropChunks(hypertableName, sel);
    total += (await fn({ cadence: "fast", timestamp: { lt: sel } })).count;
  }
  // Unselected = "slow" or legacy NULL. `{ not: "fast" }` excludes NULL in SQL,
  // so NULL is matched explicitly. Lower-bound the window at the compressed-
  // chunk frontier (getEffectiveCompressAfterDays) so this DELETE can never
  // match rows inside a compressed chunk — doing so would decompress the whole
  // chunk into its rowstore heap and leave un-truncatable low-density bloat
  // (prod incident 2026-06-08). Slow rows past the frontier ride compressed
  // until drop_chunks removes the whole chunk at the selected window above.
  const { gte, lt } = unselectedSlowPruneWindow(now, getEffectiveCompressAfterDays(hypertableName));
  total += (await fn({
    OR: [{ cadence: null }, { cadence: { not: "fast" } }],
    timestamp: gte ? { gte, lt } : { lt },
  })).count;
  return total;
}

/**
 * Trim every tier (detail / hourly / daily) for the monitor sample stream.
 * Each tier reads its own retention values from the global setting. 0 (or
 * negative) disables retention for that class within the tier.
 */
async function pruneMonitorSamples(): Promise<number> {
  const r = (await getSampleRetention()).assets;
  const [detail, hourly, daily] = await Promise.all([
    pruneTierByDays((w) => prisma.assetMonitorSample.deleteMany({       where: w as any }), r.detail, "timestamp",   "asset_monitor_samples"),
    pruneTierByDays((w) => prisma.assetMonitorSampleHourly.deleteMany({ where: w as any }), r.hourly, "bucketStart", "asset_monitor_samples_hourly"),
    pruneTierByDays((w) => prisma.assetMonitorSampleDaily.deleteMany({  where: w as any }), r.daily,  "bucketStart", "asset_monitor_samples_daily"),
  ]);
  return detail + hourly + daily;
}

/**
 * Trim every tier of AssetTelemetrySample (cpuMem entity) +
 * AssetHardwareSensorSample (hardware entity). These have independent
 * per-entity retention — operators can keep hardware-sensor history longer
 * than CPU/mem (or vice versa) since they're separate rows in the Retention
 * card. Hardware sensors are gauges with no selection split, so they prune
 * uniformly like cpuMem.
 */
async function pruneTelemetrySamples(): Promise<number> {
  const ret = await getSampleRetention();
  const cm = ret.cpuMem;
  const hw = ret.hardware;
  const pr = ret.process;
  const [tDetail, tHourly, tDaily, hwDetail, hwHourly, hwDaily, pDetail, pHourly, pDaily] = await Promise.all([
    pruneTierByDays((w) => prisma.assetTelemetrySample.deleteMany({            where: w as any }), cm.detail, "timestamp",   "asset_telemetry_samples"),
    pruneTierByDays((w) => prisma.assetTelemetrySampleHourly.deleteMany({      where: w as any }), cm.hourly, "bucketStart", "asset_telemetry_samples_hourly"),
    pruneTierByDays((w) => prisma.assetTelemetrySampleDaily.deleteMany({       where: w as any }), cm.daily,  "bucketStart", "asset_telemetry_samples_daily"),
    pruneTierByDays((w) => prisma.assetHardwareSensorSample.deleteMany({       where: w as any }), hw.detail, "timestamp",   "asset_hardware_sensor_samples"),
    pruneTierByDays((w) => prisma.assetHardwareSensorSampleHourly.deleteMany({ where: w as any }), hw.hourly, "bucketStart", "asset_hardware_sensor_samples_hourly"),
    pruneTierByDays((w) => prisma.assetHardwareSensorSampleDaily.deleteMany({  where: w as any }), hw.daily,  "bucketStart", "asset_hardware_sensor_samples_daily"),
    // Pinned-process CPU/RAM (gauge; not selection-aware — only pinned programs
    // are sampled, so every detail row is "fast").
    pruneTierByDays((w) => prisma.assetProcessSample.deleteMany({       where: w as any }), pr.detail, "timestamp",   "asset_process_samples"),
    pruneTierByDays((w) => prisma.assetProcessSampleHourly.deleteMany({ where: w as any }), pr.hourly, "bucketStart", "asset_process_samples_hourly"),
    pruneTierByDays((w) => prisma.assetProcessSampleDaily.deleteMany({  where: w as any }), pr.daily,  "bucketStart", "asset_process_samples_daily"),
  ]);
  return tDetail + tHourly + tDaily + hwDetail + hwHourly + hwDaily + pDetail + pHourly + pDaily;
}

/**
 * Trim every tier of AssetInterfaceSample + AssetStorageSample +
 * AssetIpsecTunnelSample, plus the AssetLldpNeighbor table that rides the
 * system-info cadence. LLDP rows use `lastSeen` rather than `timestamp` so
 * they're pruned by their own helper and only consume the DETAIL retention
 * tier (no rollups for LLDP — it's current-state, not time-series).
 */
async function pruneSystemInfoSamples(): Promise<number> {
  const r = await getSampleRetention();
  const [
    iDetail, iHourly, iDaily, sDetail, sHourly, sDaily, ipDetail, ipHourly, ipDaily,
    psDetail, psHourly, psDaily, lldp, customWidget, stateProbe, processLog, processConn, arpEntries,
    cDetail, cHourly, cDaily, cTrace,
  ] = await Promise.all([
    // interfaces — detail is selection-aware. Nothing WRITES unselected
    // (cadence="slow") interface rows any more (see persistInterfaceSampleStream:
    // current state moved to `asset_interfaces`), so the slow arm of this prune
    // is now a legacy drain: it clears rows written before the cutover and then
    // matches nothing. It is deliberately kept rather than removed — dropping it
    // would leave those legacy rows to age out on the much longer selected
    // window, and the arm is shared with storage/ipsec, which still use it.
    pruneSelectionAwareDetail((w) => prisma.assetInterfaceSample.deleteMany({ where: w as any }), r.interfaces.detail, "asset_interface_samples"),
    pruneTierByDays((w) => prisma.assetInterfaceSampleHourly.deleteMany({ where: w as any }), r.interfaces.hourly, "bucketStart", "asset_interface_samples_hourly"),
    pruneTierByDays((w) => prisma.assetInterfaceSampleDaily.deleteMany({  where: w as any }), r.interfaces.daily,  "bucketStart", "asset_interface_samples_daily"),
    // storage
    pruneSelectionAwareDetail((w) => prisma.assetStorageSample.deleteMany({ where: w as any }), r.storage.detail, "asset_storage_samples"),
    pruneTierByDays((w) => prisma.assetStorageSampleHourly.deleteMany({ where: w as any }), r.storage.hourly, "bucketStart", "asset_storage_samples_hourly"),
    pruneTierByDays((w) => prisma.assetStorageSampleDaily.deleteMany({  where: w as any }), r.storage.daily,  "bucketStart", "asset_storage_samples_daily"),
    // ipsec
    pruneSelectionAwareDetail((w) => prisma.assetIpsecTunnelSample.deleteMany({ where: w as any }), r.ipsec.detail, "asset_ipsec_tunnel_samples"),
    pruneTierByDays((w) => prisma.assetIpsecTunnelSampleHourly.deleteMany({ where: w as any }), r.ipsec.hourly, "bucketStart", "asset_ipsec_tunnel_samples_hourly"),
    pruneTierByDays((w) => prisma.assetIpsecTunnelSampleDaily.deleteMany({  where: w as any }), r.ipsec.daily,  "bucketStart", "asset_ipsec_tunnel_samples_daily"),
    // SD-WAN perf-SLA — not selection-aware (no pin concept); every detail row
    // is stamped "fast" so the plain by-days prune is correct for all of them.
    pruneTierByDays((w) => prisma.assetPerfSlaSample.deleteMany({       where: w as any }), r.perfSla.detail, "timestamp",   "asset_perf_sla_samples"),
    pruneTierByDays((w) => prisma.assetPerfSlaSampleHourly.deleteMany({ where: w as any }), r.perfSla.hourly, "bucketStart", "asset_perf_sla_samples_hourly"),
    pruneTierByDays((w) => prisma.assetPerfSlaSampleDaily.deleteMany({  where: w as any }), r.perfSla.daily,  "bucketStart", "asset_perf_sla_samples_daily"),
    // SD-WAN service rules are now CURRENT-STATE (asset_sdwan_rules, a plain
    // table replaced per scrape by persistSdwanRules) — no retention prune,
    // same as LLDP / wireless-station current-state tables.
    // LLDP neighbors are current-state (per-asset, no rollup, no cadence) — prune
    // by the interfaces detail window as the system-info umbrella.
    pruneLldpNeighbors(r.interfaces.detail),
    // Custom-widget samples are a standalone detail-only hypertable (no rollup
    // tiers). Prune on the same interfaces detail umbrella window as LLDP via
    // the compression-safe drop_chunks + residue path.
    pruneTierByDays((w) => prisma.assetCustomWidgetSample.deleteMany({ where: w as any }), r.interfaces.detail, "timestamp", "asset_custom_widget_samples"),
    // State-probe samples ride the same standalone-hypertable path and the same
    // system-info umbrella window — they're collected by the same pass.
    pruneTierByDays((w) => prisma.assetStateSample.deleteMany({ where: w as any }), r.interfaces.detail, "timestamp", "asset_state_samples"),
    // Process logs are a standalone detail-only hypertable (no rollups) — prune
    // on the process entity's detail window via the same compression-safe path.
    pruneTierByDays((w) => prisma.assetProcessLogSample.deleteMany({ where: w as any }), r.process.detail, "timestamp", "asset_process_log_samples"),
    // Service (journalctl) logs — same standalone-hypertable prune on the
    // process entity's detail window as process logs.
    pruneTierByDays((w) => prisma.assetServiceLogSample.deleteMany({ where: w as any }), r.process.detail, "timestamp", "asset_service_log_samples"),
    // Application Map connection rows (plain accumulate+age table) — the FLAT
    // `appMapConnections` retention entity (single window, no tiers).
    pruneProcessConnections(),
    // ARP neighbour rows — the other accumulate+age table, on its own flat
    // `arpEntries` window. Same encoding as a tier (FOREVER = never prune).
    pruneArpEntries(),
    // Agent-run path checks — a tiered entity (every detail row is
    // stamped "fast", so the plain by-days prune is correct) plus the
    // traceroute snapshots, a standalone hypertable on the FLAT
    // `pathCheckTraceroutes` window.
    pruneTierByDays((w) => prisma.assetPathCheckSample.deleteMany({       where: w as any }), r.pathCheck.detail, "timestamp",   "asset_path_check_samples"),
    pruneTierByDays((w) => prisma.assetPathCheckSampleHourly.deleteMany({ where: w as any }), r.pathCheck.hourly, "bucketStart", "asset_path_check_samples_hourly"),
    pruneTierByDays((w) => prisma.assetPathCheckSampleDaily.deleteMany({  where: w as any }), r.pathCheck.daily,  "bucketStart", "asset_path_check_samples_daily"),
    pruneTierByDays((w) => prisma.assetPathCheckTraceroute.deleteMany({   where: w as any }), r.pathCheckTraceroutes.days, "timestamp", "asset_path_check_traceroutes"),
  ]);
  return iDetail + iHourly + iDaily + sDetail + sHourly + sDaily + ipDetail + ipHourly + ipDaily
    + psDetail + psHourly + psDaily + lldp + customWidget + stateProbe + processLog + processConn + arpEntries
    + cDetail + cHourly + cDaily + cTrace;
}

async function pruneLldpNeighbors(days: number): Promise<number> {
  if (days === FOREVER) return 0;
  const cutoff = days <= 0 ? new Date() : new Date(Date.now() - days * DAY_MS);
  const { count } = await prisma.assetLldpNeighbor.deleteMany({ where: { lastSeen: { lt: cutoff } } });
  return count;
}

// Application Map connection rows use the FLAT `appMapConnections` retention
// entity — one window, no detail/hourly/daily tiers, because the table is
// current-state-with-age rather than a tiered time-series. Encoding matches a
// tier (FOREVER = never prune, <= 0 = drop everything), so this mirrors
// pruneLldpNeighbors exactly. POLARIS_PROCESS_CONN_RETENTION_DAYS is now only the
// default seed for that setting, not the authority.
// ARP neighbour rows. Accumulate+age like the connection rows above, so
// retention is the ONLY thing that ever removes a row -- no scrape wipes it.
// Pruned on lastSeen, which is exactly what the tab's range selector filters
// on, so "last 30 days" and "kept for 30 days" mean the same window.
async function pruneArpEntries(): Promise<number> {
  const days = await getArpEntryRetentionDays();
  if (days === FOREVER) return 0;
  const cutoff = days <= 0 ? new Date() : new Date(Date.now() - days * DAY_MS);
  const { count } = await prisma.assetArpEntry.deleteMany({ where: { lastSeen: { lt: cutoff } } });
  return count;
}

async function pruneProcessConnections(): Promise<number> {
  const days = await getAppMapConnectionRetentionDays();
  if (days === FOREVER) return 0;
  const cutoff = days <= 0 ? new Date() : new Date(Date.now() - days * DAY_MS);
  const { count } = await prisma.assetProcessConnection.deleteMany({ where: { lastSeen: { lt: cutoff } } });
  return count;
}

// ─── Coordinated retention prune (single-flight across the monitor fleet) ────
//
// The retention prune is a FLEET-WIDE maintenance task, not a per-process one:
// it trims global sample tables. In the split-role deployment every
// `polaris-monitor@N` replica runs the same heavy tick, so without
// coordination N replicas fire the same prune concurrently — N overlapping
// `deleteMany`s on the same rollup tables, serializing on tuple locks. Worse,
// the previous trigger (`lastPruneAt = 0` initialized in monitorAssets) fired
// the prune on the FIRST heavy tick after every process start, so a crash/
// restart loop re-issued the prune every ~30s. That cascade pinned the xmin
// horizon and pegged every core (prod incident 2026-06-17).
//
// Two coordination mechanisms close that gap:
//  1. A PERSISTED last-run timestamp (Setting row) — survives restarts, so a
//     frequently-cycled host prunes 24h after the last SUCCESSFUL prune, not
//     24h after each boot, and never on boot.
//  2. A Postgres session-level ADVISORY LOCK held on a dedicated side
//     connection (NOT a transaction — that would re-pin xmin for the whole
//     prune) so only one replica prunes at a time; the rest skip cheaply.
//
// The advisory-lock key is a fixed Polaris-reserved (classid, objid) pair,
// distinct from pg-boss's single-bigint keyspace.
const PRUNE_LOCK_CLASSID = 0x504c5253;
 // "PLRS"
const PRUNE_LOCK_OBJID = 1;
 // retention prune
const RETENTION_PRUNE_SETTING_KEY = "lastRetentionPruneAt";

/** Default cadence between retention prunes. Overridable by the caller. */
export const RETENTION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RetentionPruneResult {
  monitor: number;
  telemetry: number;
  systemInfo: number;
  /** true when this replica did NOT prune (not due, or another replica held the lock). */
  skipped: boolean;
  reason?: "not-due" | "lock-held";
}

async function getLastRetentionPruneAt(): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: RETENTION_PRUNE_SETTING_KEY } });
  const v = row?.value as { at?: unknown } | null | undefined;
  return typeof v?.at === "number" ? v.at : 0;
}

async function setLastRetentionPruneAt(at: number): Promise<void> {
  await prisma.setting.upsert({
    where: { key: RETENTION_PRUNE_SETTING_KEY },
    update: { value: { at } },
    create: { key: RETENTION_PRUNE_SETTING_KEY, value: { at } },
  });
}

/**
 * Run `fn` while holding the prune advisory lock on a dedicated connection.
 * Returns `fn()`'s result, or `null` when another replica already holds the
 * lock (caller should treat that as "skipped"). The lock is session-level and
 * released on a `finally`, and the connection is always closed — so a crash
 * mid-prune drops the connection and the lock with it.
 */
async function withPruneLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const url = getDirectDatabaseUrl();
  // No URL (shouldn't happen in a running app) → run uncoordinated rather than
  // silently skip maintenance. Single-process dev has exactly one caller anyway.
  if (!url) return fn();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS locked",
      [PRUNE_LOCK_CLASSID, PRUNE_LOCK_OBJID],
    );
    if (!res.rows[0]?.locked) return null;
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [PRUNE_LOCK_CLASSID, PRUNE_LOCK_OBJID]);
    }
  } finally {
    await client.end();
  }
}

/**
 * Fleet-coordinated retention prune. Call this on every heavy tick; it decides
 * whether a prune is due (persisted timestamp) and, if so, takes the advisory
 * lock and runs the three prune passes exactly once across the fleet. Cheap and
 * safe to call every ~30s — the not-due path is a single indexed Setting read.
 */
export async function runRetentionPrune(
  intervalMs: number = RETENTION_PRUNE_INTERVAL_MS,
): Promise<RetentionPruneResult> {
  const zero: RetentionPruneResult = { monitor: 0, telemetry: 0, systemInfo: 0, skipped: true };
  if (Date.now() - (await getLastRetentionPruneAt()) < intervalMs) {
    return { ...zero, reason: "not-due" };
  }
  const result = await withPruneLock(async () => {
    // Re-check inside the lock: another replica may have just pruned and
    // bumped the timestamp while we waited to acquire.
    if (Date.now() - (await getLastRetentionPruneAt()) < intervalMs) return null;
    const [monitor, telemetry, systemInfo] = await Promise.all([
      pruneMonitorSamples(),
      pruneTelemetrySamples(),
      pruneSystemInfoSamples(),
    ]);
    await setLastRetentionPruneAt(Date.now());
    return { monitor, telemetry, systemInfo };
  });
  if (result === null) return { ...zero, reason: "lock-held" };
  return { ...result, skipped: false };
}
