/**
 * src/services/historyRetentionService.ts — retention for the tables that only
 * ever grew (business rule 157).
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

export interface HistoryPruneResult {
  alerts: number;
  summaries: number;
  ruleStates: number;
  discoveryRuns: number;
  sightings: number;
  scanRuns: number;
  hiddenRegionIds: number;
  tagAssignments: number;
}

/**
 * One pass over all seven. Each prune is independent: one that throws is
 * reported in `errors` and the others still run.
 */
export async function pruneHistory(now: Date = new Date()): Promise<{ result: HistoryPruneResult; errors: string[] }> {
  const result: HistoryPruneResult = { alerts: 0, summaries: 0, ruleStates: 0, discoveryRuns: 0, sightings: 0, scanRuns: 0, hiddenRegionIds: 0, tagAssignments: 0 };
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
  return { result, errors };
}
