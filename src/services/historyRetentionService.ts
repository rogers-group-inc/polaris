/**
 * src/services/historyRetentionService.ts — retention for the tables that only
 * ever grew (business rule 158).
 *
 * The sample hypertables, Events and completed script runs all age out. These
 * did not: nothing deleted a row, ever, so each grew for the life of the
 * install (2026-11-11 orphan audit). One job (`jobs/pruneHistory.ts`) runs the
 * prunes below once a day.
 *
 *   Alert history     cleared `Notification` rows (their `NotificationDelivery`
 *                     rows cascade) and sent `QuietTimeSummary` rows, after the
 *                     operator's `alertHistoryDays` (default 365; 0 = keep
 *                     forever). An alert that is still open is never touched,
 *                     however old.
 *   Rule state        `NotificationRuleState` rows that are `clear`, carry no
 *                     alert and no half-counted hold, and have not been
 *                     written for a week. Such a row says nothing an absent row
 *                     does not — the engine upserts one the moment a condition
 *                     is next met — but the evaluator loads EVERY state row of
 *                     a rule on every 60 s tick, so the dead ones (deleted
 *                     devices, removed ports, retired checks) were a cost on
 *                     the hot path that only grew.
 *   Discovery runs    a finished `DiscoveryRun` row whose integration no longer
 *                     exists. There is one row per integration (unique on
 *                     `integrationId`, reused by every run), so this table does
 *                     not grow with time — but the column has no foreign key,
 *                     so deleting an integration left its row for good.
 *   Sightings         `AssetFortigateSighting` rows not seen within the
 *                     quarantine window (`quarantine.sightingMaxAgeDays`,
 *                     default 180; 0 = keep forever). Quarantine already
 *                     ignores them; nothing else should be reading a gate's
 *                     view of a device from half a year ago.
 *   Discovery scans   finished `NetworkScanRun` rows after 90 days, except the
 *                     newest run of each Discovery, which its list row shows.
 *
 * And two sweeps of references that outlive what they name:
 *
 *   Hidden regions    ids in `User.hiddenMapRegionIds` for map regions that no
 *                     longer exist. A deleted region has no eye to click, and
 *                     the client re-saved the whole list on every toggle, so
 *                     the dead ids were permanent and counted toward the cap.
 *   Tag provenance    `TagAutoAssignment` rows whose tag was deleted (no
 *                     foreign key). The reconcile sweeps only tags that still
 *                     exist, so a row stranded by a failed strip stayed.
 *
 * Every prune is bounded per run (`BATCH` rows × `MAX_BATCHES`), so the first
 * run on an install with years of history deletes in slices over a few days
 * instead of holding one enormous transaction, and a 2000-asset fleet's daily
 * steady state is a handful of small deletes. Cutoffs are computed in Node and
 * passed as parameters — never `now()` in SQL (the naive-UTC trap).
 */

import { prisma } from "../db.js";
import { Prisma } from "../generated/prisma/client.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { getSightingSettings } from "./assetSightingService.js";
import { listRegions } from "./mapRegionService.js";
import { sweepFirmwareFiles } from "./firmwareRepositoryService.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── The operator's setting ─────────────────────────────────────────────────

export interface AlertHistorySettings {
  /** Days a CLEARED alert is kept after it cleared. 0 = keep forever. */
  alertHistoryDays: number;
}

const SETTINGS_KEY = "alertHistoryRetention";
export const DEFAULT_ALERT_HISTORY_DAYS = 365;
/** Below this a "what happened last month" question has no answer. */
export const MIN_ALERT_HISTORY_DAYS = 30;
export const MAX_ALERT_HISTORY_DAYS = 3650;

/** A stored or posted value → a usable one, or null when it is not one. Pure. */
export function normalizeAlertHistoryDays(raw: unknown): number | null {
  // Only a number or a numeric string. `Number(null)` and `Number("")` are 0,
  // and 0 means "keep forever" — a blank field (which JSON sends as null) must
  // never be read as that.
  if (typeof raw === "string" ? raw.trim() === "" : typeof raw !== "number") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n === 0) return 0;
  if (n < MIN_ALERT_HISTORY_DAYS || n > MAX_ALERT_HISTORY_DAYS) return null;
  return n;
}

export async function getAlertHistorySettings(): Promise<AlertHistorySettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  const stored = normalizeAlertHistoryDays((row?.value as Record<string, unknown> | undefined)?.alertHistoryDays);
  return { alertHistoryDays: stored ?? DEFAULT_ALERT_HISTORY_DAYS };
}

export async function updateAlertHistorySettings(raw: unknown, actor?: string): Promise<AlertHistorySettings> {
  const days = normalizeAlertHistoryDays(raw);
  if (days === null) {
    throw new AppError(400, `Alert history must be 0 (keep forever) or ${MIN_ALERT_HISTORY_DAYS}–${MAX_ALERT_HISTORY_DAYS} days`);
  }
  const before = await getAlertHistorySettings();
  const next: AlertHistorySettings = { alertHistoryDays: days };
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: next as object },
    update: { value: next as object },
  });
  if (before.alertHistoryDays !== days) {
    const say = (d: number) => (d === 0 ? "kept forever" : `${d} days`);
    await logEvent({
      action: "settings.alert_history_retention.updated",
      resourceType: "setting",
      resourceName: SETTINGS_KEY,
      actor,
      // Shortening the period deletes history at the next run; say so loudly.
      level: days !== 0 && (before.alertHistoryDays === 0 || days < before.alertHistoryDays) ? "warning" : "info",
      message: `Alert history retention changed from ${say(before.alertHistoryDays)} to ${say(days)}`,
      details: { before: before.alertHistoryDays, after: days },
    });
  }
  return next;
}

// ─── The prunes ─────────────────────────────────────────────────────────────

/** Rows deleted per statement, and statements per table per run. */
const BATCH = 2000;
const MAX_BATCHES = 25;

export const RULE_STATE_IDLE_DAYS = 7;
export const SCAN_RUN_DAYS = 90;

/**
 * Delete in id-slices until a slice comes back short or the per-run budget is
 * spent. `pick` returns up to `BATCH` ids still matching; `drop` deletes them.
 */
async function sliceDelete(pick: () => Promise<string[]>, drop: (ids: string[]) => Promise<number>): Promise<number> {
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const ids = await pick();
    if (ids.length === 0) break;
    total += await drop(ids);
    if (ids.length < BATCH) break;
  }
  return total;
}

/**
 * Cleared alerts (and, by cascade, their delivery rows) past the operator's
 * period, and quiet-time summaries that were sent or abandoned that long ago.
 * `alertHistoryDays` 0 keeps everything.
 */
export async function pruneAlertHistory(now: Date = new Date()): Promise<{ alerts: number; summaries: number }> {
  const { alertHistoryDays } = await getAlertHistorySettings();
  if (alertHistoryDays === 0) return { alerts: 0, summaries: 0 };
  const cutoff = new Date(now.getTime() - alertHistoryDays * DAY_MS);

  const alerts = await sliceDelete(
    async () => (await prisma.notification.findMany({
      // `cleared` AND a clear time: an open alert is never history, and a row
      // cleared before `clearedAt` existed is left for the operator.
      where: { cleared: true, clearedAt: { lt: cutoff } },
      select: { id: true },
      take: BATCH,
    })).map((r) => r.id),
    async (ids) => (await prisma.notification.deleteMany({ where: { id: { in: ids }, cleared: true } })).count,
  );

  const summaries = await sliceDelete(
    async () => (await prisma.quietTimeSummary.findMany({
      where: { createdAt: { lt: cutoff }, status: { not: "pending" } },
      select: { id: true },
      take: BATCH,
    })).map((r) => r.id),
    async (ids) => (await prisma.quietTimeSummary.deleteMany({ where: { id: { in: ids } } })).count,
  );

  return { alerts, summaries };
}

/**
 * The `where` for a rule-state row that is indistinguishable from no row:
 * clear, no alert, no pending or recovery timer, no half-counted run, no band
 * bookkeeping — and untouched since `cutoff`. Exported so the test pins every
 * arm: dropping one would delete a row the engine is still counting on.
 */
export function idleRuleStateWhere(cutoff: Date) {
  return {
    state: "clear",
    notificationId: null,
    conditionMetSince: null,
    recoveredSince: null,
    firingSeverity: null,
    bandMetSince: { equals: Prisma.AnyNull },
    metRun: 0,
    clearRun: 0,
    updatedAt: { lt: cutoff },
  };
}

export async function pruneIdleRuleStates(now: Date = new Date()): Promise<number> {
  const where = idleRuleStateWhere(new Date(now.getTime() - RULE_STATE_IDLE_DAYS * DAY_MS));
  return sliceDelete(
    async () => (await prisma.notificationRuleState.findMany({ where, select: { id: true }, take: BATCH })).map((r) => r.id),
    // Re-assert the whole predicate on the delete: a row the engine moved to
    // pending between the read and the write must survive.
    async (ids) => (await prisma.notificationRuleState.deleteMany({ where: { ...where, id: { in: ids } } })).count,
  );
}

/**
 * Finished discovery-run rows whose integration is gone. A queued or running
 * row is never touched here: `discoveryRunReaper` settles those first, and the
 * backup-restore guard counts them. Bounded by the number of integrations an
 * install has ever had.
 */
export async function pruneDiscoveryRuns(): Promise<number> {
  const finished = { status: { in: ["completed", "aborted", "error"] } };
  const runs = await prisma.discoveryRun.findMany({ where: finished, select: { id: true, integrationId: true } });
  if (runs.length === 0) return 0;
  const live = new Set(
    (await prisma.integration.findMany({
      where: { id: { in: [...new Set(runs.map((r) => r.integrationId))] } },
      select: { id: true },
    })).map((i) => i.id),
  );
  const orphaned = runs.filter((r) => !live.has(r.integrationId)).map((r) => r.id);
  if (orphaned.length === 0) return 0;
  return (await prisma.discoveryRun.deleteMany({ where: { ...finished, id: { in: orphaned } } })).count;
}

export async function pruneSightings(now: Date = new Date()): Promise<number> {
  const { sightingMaxAgeDays } = await getSightingSettings();
  if (sightingMaxAgeDays === 0) return 0; // "forever" for quarantine is forever here too
  const cutoff = new Date(now.getTime() - sightingMaxAgeDays * DAY_MS);
  return sliceDelete(
    async () => (await prisma.assetFortigateSighting.findMany({ where: { lastSeen: { lt: cutoff } }, select: { id: true }, take: BATCH })).map((r) => r.id),
    async (ids) => (await prisma.assetFortigateSighting.deleteMany({ where: { id: { in: ids }, lastSeen: { lt: cutoff } } })).count,
  );
}

/**
 * Finished Discovery runs past the window — never the newest run of a
 * Discovery, which its list row shows as "last run" however old it is.
 */
export async function pruneNetworkScanRuns(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SCAN_RUN_DAYS * DAY_MS);
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const old = await prisma.networkScanRun.findMany({
      where: { status: { in: ["completed", "aborted", "error"] }, createdAt: { lt: cutoff } },
      select: { id: true, scanId: true },
      orderBy: { createdAt: "asc" },
      take: BATCH,
    });
    if (old.length === 0) break;
    const newest = await prisma.networkScanRun.findMany({
      where: { scanId: { in: [...new Set(old.map((r) => r.scanId))] } },
      orderBy: { createdAt: "desc" },
      distinct: ["scanId"],
      select: { id: true },
    });
    const keep = new Set(newest.map((r) => r.id));
    const ids = old.map((r) => r.id).filter((id) => !keep.has(id));
    if (ids.length === 0) break; // everything old that is left is a newest run
    total += (await prisma.networkScanRun.deleteMany({ where: { id: { in: ids } } })).count;
    if (old.length < BATCH) break;
  }
  return total;
}

/**
 * Drop ids of deleted map regions from every user's hidden list. Bounded by
 * the number of accounts that have hidden anything.
 */
export async function pruneHiddenRegionIds(): Promise<number> {
  const users = await prisma.user.findMany({
    where: { hiddenMapRegionIds: { isEmpty: false } },
    select: { id: true, hiddenMapRegionIds: true },
  });
  if (users.length === 0) return 0;
  const live = new Set((await listRegions()).map((r) => r.id));
  const stale = users
    .map((u) => ({ id: u.id, keep: u.hiddenMapRegionIds.filter((id) => live.has(id)), had: u.hiddenMapRegionIds.length }))
    .filter((u) => u.keep.length !== u.had);
  await Promise.all(stale.map((u) => prisma.user.update({ where: { id: u.id }, data: { hiddenMapRegionIds: u.keep } })));
  return stale.reduce((n, u) => n + (u.had - u.keep.length), 0);
}

/** Delete auto-assignment provenance rows whose tag no longer exists. */
export async function pruneOrphanTagAssignments(): Promise<number> {
  const tagIds = (await prisma.tag.findMany({ select: { id: true } })).map((t) => t.id);
  return (await prisma.tagAutoAssignment.deleteMany({ where: { tagId: { notIn: tagIds } } })).count;
}

/** A config left by an automatic unpin is kept this long, in case the pin comes back. */
export const PROCESS_CONFIG_UNPINNED_DAYS = 7;

/**
 * Per-process log configs whose process is no longer pinned on the asset
 * (business rule 158(c)).
 *
 * An operator's own unpin deletes the config at once (assetWriteService). This
 * catches the unpins that do not come through that path — a discovery rule
 * that stopped matching, a mass-pin run, a merge. Those can flap, and a
 * re-pin a few minutes later should find the operator's log path still there,
 * so only a config untouched for PROCESS_CONFIG_UNPINNED_DAYS is removed.
 * A config whose asset is gone goes too (the table has no foreign key).
 *
 * Through Prisma, not raw SQL: `updatedAt` is a naive-UTC column, and a raw
 * comparison against a parameter reads it in the session's time zone. The
 * table holds one row per configured process, so two reads and one delete
 * cover it at any fleet size; a run is capped and the rest waits a day.
 */
export async function pruneUnpinnedProcessConfigs(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - PROCESS_CONFIG_UNPINNED_DAYS * DAY_MS);
  const configs = await prisma.assetProcessConfig.findMany({
    where: { updatedAt: { lt: cutoff } },
    select: { id: true, assetId: true, name: true },
    orderBy: { updatedAt: "asc" },
    take: BATCH * 5,
  });
  if (configs.length === 0) return 0;
  const assets = await prisma.asset.findMany({
    where: { id: { in: [...new Set(configs.map((c) => c.assetId))] } },
    select: { id: true, monitoredProcesses: true },
  });
  const pinned = new Map(assets.map((a) => [a.id, new Set(a.monitoredProcesses)]));
  const dead = configs.filter((c) => !pinned.get(c.assetId)?.has(c.name)).map((c) => c.id);
  if (dead.length === 0) return 0;
  // Re-assert the age on the delete: a config edited since the read is kept.
  return (await prisma.assetProcessConfig.deleteMany({ where: { id: { in: dead }, updatedAt: { lt: cutoff } } })).count;
}

/** The networks already reported by reportUnheldReservedNetworks. */
const UNHELD_RESERVED_SETTING_KEY = "unheldReservedNetworksReported";

/**
 * Business rule 175(a): name each network marked `reserved` that no
 * whole-network reservation holds — once.
 *
 * Rule 175 sets a network back to `available` when the whole-network
 * reservation that reserved it expires. Networks stranded `reserved` before
 * that shipped cannot be repaired automatically, because an operator can also
 * mark a network reserved by hand, on purpose, with no reservation at all. So
 * Polaris does not change them; it lists them, one warning Event per network,
 * and remembers it has, so a network an operator means to keep reserved is
 * named once and then left alone. A network that stops qualifying (a
 * reservation now holds it, or its status changed) is forgotten, so if it is
 * stranded again later it is named again.
 *
 * Scale: one read of reserved networks with an anti-join, one Setting row.
 * Returns how many networks were newly reported.
 */
export async function reportUnheldReservedNetworks(): Promise<number> {
  const unheld = await prisma.subnet.findMany({
    where: { status: "reserved", reservations: { none: { status: "active", ipAddress: null } } },
    select: { id: true, name: true, cidr: true },
    orderBy: { cidr: "asc" },
  });
  const row = await prisma.setting.findUnique({ where: { key: UNHELD_RESERVED_SETTING_KEY } });
  const reported = new Set(Array.isArray(row?.value) ? (row!.value as unknown[]).filter((v): v is string => typeof v === "string") : []);
  const fresh = unheld.filter((n) => !reported.has(n.id));
  for (const n of fresh) {
    await logEvent({
      action: "subnet.reserved_unheld",
      level: "warning",
      resourceType: "subnet",
      resourceId: n.id,
      resourceName: n.name,
      actor: "system",
      message: `Network "${n.name}" (${n.cidr}) is marked Reserved, but no reservation holds it. If it should be available for allocation, change its status; if it is reserved on purpose, there is nothing to do — this is reported once.`,
      details: { cidr: n.cidr },
    });
  }
  const next = unheld.map((n) => n.id);
  const changed = next.length !== reported.size || fresh.length > 0;
  if (changed) {
    await prisma.setting.upsert({
      where: { key: UNHELD_RESERVED_SETTING_KEY },
      create: { key: UNHELD_RESERVED_SETTING_KEY, value: next },
      update: { value: next },
    });
  }
  return fresh.length;
}

/**
 * Business rule 158(e): directory-synced contacts whose integration is gone.
 *
 * `DirectoryContactSource.integrationId` has no foreign key on purpose (a
 * cascade would strip the provenance and strand the contacts it justified),
 * so deleting an integration purges them explicitly first
 * (`directorySyncService.purgeDirectoryContacts`). That purge is best-effort:
 * if it throws, the delete still goes through and writes an error Event — and
 * the provenance rows, and the employee roster they put in the address book,
 * were then left with nothing that could ever refresh or remove them.
 *
 * This finds provenance rows naming an integration that no longer exists and
 * runs the same purge for each. Scale: one grouped read of a small table and
 * one read of integration ids; normally nothing to do.
 */
export async function pruneDeadDirectoryContacts(): Promise<number> {
  const owners = await prisma.directoryContactSource.groupBy({ by: ["integrationId"] });
  if (owners.length === 0) return 0;
  const live = new Set(
    (await prisma.integration.findMany({
      where: { id: { in: owners.map((o) => o.integrationId) } },
      select: { id: true },
    })).map((i) => i.id),
  );
  const dead = owners.map((o) => o.integrationId).filter((id) => !live.has(id));
  if (dead.length === 0) return 0;
  const { purgeDirectoryContacts } = await import("./directorySyncService.js");
  let removed = 0;
  for (const id of dead) {
    removed += await purgeDirectoryContacts(id, "its integration no longer exists", "system");
  }
  return removed;
}

/** How long an SD-WAN rule row may sit unread before it is checked for removal. */
export const SDWAN_RULE_STALE_DAYS = 7;

/**
 * Business rule 174: `AssetSdwanRule` is current-state, replaced on every
 * successful SD-WAN read and by nothing else. When collection STOPS for a
 * gate — the integration's SD-WAN pull switched off, its interfaces moved off
 * FortiOS REST, its integration removed — the last rows stay for good, and
 * the SD-WAN tab goes on showing rules as they stood that day.
 *
 * A row untouched for SDWAN_RULE_STALE_DAYS is removed when nothing polls its
 * gate any more (the scheduler's own test, null = not polled). A gate that is
 * still polled keeps its rows however old: a read that keeps failing is a
 * fault to show, not a leftover to tidy.
 *
 * Scale: one grouped read of stale rows by gate (normally empty), then one
 * resolve and one delete per such gate.
 */
export async function pruneStaleSdwanRules(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SDWAN_RULE_STALE_DAYS * 24 * 60 * 60 * 1000);
  const gates = await prisma.assetSdwanRule.groupBy({ by: ["assetId"], where: { updatedAt: { lt: cutoff } } });
  if (gates.length === 0) return 0;
  const { resolveSdwanPollIntervalForAsset } = await import("./monitoringService.js");
  let removed = 0;
  for (const { assetId } of gates) {
    if ((await resolveSdwanPollIntervalForAsset(assetId)) !== null) continue;
    removed += (await prisma.assetSdwanRule.deleteMany({ where: { assetId, updatedAt: { lt: cutoff } } })).count;
  }
  return removed;
}

export interface HistoryPruneResult {
  alerts: number;
  summaries: number;
  ruleStates: number;
  discoveryRuns: number;
  sightings: number;
  scanRuns: number;
  hiddenRegionIds: number;
  tagAssignments: number;
  /** Log configs of processes no longer pinned (rule 158(c)). */
  processConfigs: number;
  /** Firmware repository leftovers (rule 158(b)): unreferenced image files + abandoned uploads + rows whose bytes never landed. */
  firmwareLeftovers: number;
  /** SD-WAN rule rows of gates whose SD-WAN is no longer collected (rule 174). */
  sdwanRules: number;
  /** Directory-synced contacts whose integration no longer exists (rule 158(e)). */
  directoryContacts: number;
  /** Networks newly reported as reserved with no reservation holding them (rule 175(a)). */
  unheldReservedNetworks: number;
}

/**
 * One pass over all of them. Each prune is independent: one that throws is
 * reported in `errors` and the others still run.
 */
export async function pruneHistory(now: Date = new Date()): Promise<{ result: HistoryPruneResult; errors: string[] }> {
  const result: HistoryPruneResult = { alerts: 0, summaries: 0, ruleStates: 0, discoveryRuns: 0, sightings: 0, scanRuns: 0, hiddenRegionIds: 0, tagAssignments: 0, processConfigs: 0, firmwareLeftovers: 0, sdwanRules: 0, directoryContacts: 0, unheldReservedNetworks: 0 };
  const errors: string[] = [];
  const attempt = async (name: string, run: () => Promise<void>) => {
    try { await run(); } catch (err) { errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`); }
  };
  await attempt("alert history", async () => { Object.assign(result, await pruneAlertHistory(now)); });
  await attempt("rule state", async () => { result.ruleStates = await pruneIdleRuleStates(now); });
  await attempt("discovery runs", async () => { result.discoveryRuns = await pruneDiscoveryRuns(); });
  await attempt("sightings", async () => { result.sightings = await pruneSightings(now); });
  await attempt("discovery scans", async () => { result.scanRuns = await pruneNetworkScanRuns(now); });
  await attempt("hidden regions", async () => { result.hiddenRegionIds = await pruneHiddenRegionIds(); });
  await attempt("tag provenance", async () => { result.tagAssignments = await pruneOrphanTagAssignments(); });
  await attempt("process log configs", async () => { result.processConfigs = await pruneUnpinnedProcessConfigs(now); });
  await attempt("stale SD-WAN rules", async () => { result.sdwanRules = await pruneStaleSdwanRules(now); });
  await attempt("directory contacts of deleted integrations", async () => { result.directoryContacts = await pruneDeadDirectoryContacts(); });
  await attempt("reserved networks nothing holds", async () => { result.unheldReservedNetworks = await reportUnheldReservedNetworks(); });
  await attempt("firmware leftovers", async () => {
    const swept = await sweepFirmwareFiles(now);
    result.firmwareLeftovers = swept.files + swept.incoming + swept.rows;
  });
  return { result, errors };
}
