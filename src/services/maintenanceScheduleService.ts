/**
 * src/services/maintenanceScheduleService.ts
 *
 * Maintenance schedules: operator-defined windows during which matched
 * monitored assets are put into maintenance mode — `Asset.status` is flipped
 * to "maintenance" (prior status parked in `maintenanceReturnStatus`, restored
 * on exit), which stops all server-driven polling (the monitor candidate
 * queries exclude it), makes the asset count as "down" for child dependency
 * suppression, and silences notifications.
 *
 * State model: one open `AssetMaintenanceWindow` row per (asset, schedule)
 * while that schedule holds the asset in maintenance. Open rows are the
 * source of truth — an asset is "in maintenance" iff it has ≥1 open row, it
 * enters when it gains its first and exits when it loses its last, and a
 * restart recovers for free (the first reconcile tick re-derives everything
 * from open rows + `maintenanceReturnStatus`). Closed rows are kept as
 * history for the chart maintenance bands.
 *
 * `reconcileMaintenance()` runs every 30s from src/jobs/maintenanceScheduler.ts
 * and inline after every schedule mutation (so an ad-hoc "enter maintenance
 * now" takes effect immediately). Targets = union(criteria matches, explicit
 * assetIds) ∩ monitored=true; criteria reuse the tagAssignmentService engine
 * (hostname/model/manufacturer/os contains/pattern, subnet inCidr, assetType).
 *
 * Operator interplay: an operator PUT that moves status off "maintenance"
 * while windows are open goes through `operatorReleaseAsset()` (called from
 * the assets route BEFORE the write) — the operator wins, and the
 * `endReason: "operator"` rows suppress re-entry for the current occurrence
 * of each schedule. A SYSTEM writer that clobbers status mid-window (a
 * discovery path not yet guarded) is self-healed: the reconcile re-flips to
 * "maintenance" and absorbs the clobbered value into `maintenanceReturnStatus`
 * so exit restores what the system writer wanted.
 *
 * Deletion-at-source is the one system signal that OUTRANKS the window:
 * `releaseAssetsForDecommission()` (called by the discovery decommission
 * sweeps) force-closes the windows and decommissions the asset outright —
 * see its doc comment for why roster absence is not a reachability signal.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent, logEventsBatch } from "./eventLogService.js";
import { clearSuppressedAlerts } from "./notificationService.js";
import {
  normalizeCriteria,
  resolveMatchingAssetIds,
  type TagCriteria,
} from "./tagAssignmentService.js";
import {
  validateScheduleShape,
  resolveStartNow,
  isInWindow,
  currentWindow,
  nextWindow,
  expandOccurrences,
  formatLocalIsoMinute,
  parseLocalDay,
  type MaintenanceScheduleShape,
} from "../utils/maintenanceRecurrence.js";

const SYSTEM_ACTOR = "system:maintenance";
const PREVIEW_CAP = 50;
/** Closed window rows older than this are pruned by the reconcile tick. */
const HISTORY_RETENTION_DAYS = 400;

// ─── Input validation ────────────────────────────────────────────────────────

export interface MaintenanceScheduleInput {
  name: string;
  enabled?: boolean;
  criteria?: unknown;
  assetIds?: string[];
  // Optional at the type level (z.unknown() infers optional); normalizeInput
  // rejects a missing/invalid shape with a 400.
  schedule?: unknown;
  /** In-window assets count as DOWN for child dependency suppression. Default true. */
  suppressChildren?: boolean;
}

interface NormalizedInput {
  name: string;
  enabled: boolean;
  criteria: TagCriteria | null;
  assetIds: string[];
  schedule: MaintenanceScheduleShape;
  suppressChildren: boolean;
}

function normalizeInput(input: MaintenanceScheduleInput): NormalizedInput {
  const name = String(input.name ?? "").trim();
  if (!name) throw new AppError(400, "Schedule name is required");
  if (name.length > 200) throw new AppError(400, "Schedule name must be 200 characters or fewer");

  let schedule: MaintenanceScheduleShape;
  try {
    // startNow (the ad-hoc "enter maintenance now" path) resolves to a
    // SERVER-stamped startAt before validation — see resolveStartNow.
    schedule = validateScheduleShape(resolveStartNow(input.schedule));
  } catch (err: any) {
    const first = err?.issues?.[0];
    throw new AppError(400, `Invalid schedule: ${first?.message ?? "malformed recurrence shape"}`);
  }

  const criteria = normalizeCriteria(input.criteria ?? null);
  if (criteria && criteria.rules.some((r) => r.field === "status")) {
    // Maintenance itself flips status — a status rule would make membership
    // oscillate (asset enters → status becomes "maintenance" → rule stops
    // matching → asset exits → …).
    throw new AppError(400, "Maintenance criteria cannot filter on status");
  }

  const assetIds = Array.from(
    new Set((input.assetIds ?? []).map((id) => String(id).trim()).filter((id) => id.length > 0)),
  );
  if (!criteria && assetIds.length === 0) {
    throw new AppError(400, "Schedule must target at least one asset (criteria or explicit assets)");
  }

  return {
    name,
    enabled: input.enabled !== false,
    criteria,
    assetIds,
    schedule,
    suppressChildren: input.suppressChildren !== false,
  };
}

/**
 * The ad-hoc shape: a one-shot schedule targeting exactly one explicit asset
 * with no criteria — what the status-pill / edit-modal "enter maintenance
 * until…" path creates. Such a schedule is single-purpose: once its window is
 * over (operator ended it early, or it ran to its end time) it can never fire
 * again, so it self-deletes instead of accumulating in the Schedules list.
 * Multi-asset / criteria-based / recurring schedules are never auto-deleted.
 */
function isAdhocShape(
  row: { criteria: unknown; assetIds: string[] },
  shape: MaintenanceScheduleShape | null,
): boolean {
  return !!shape && shape.kind === "oneshot" && row.criteria == null && row.assetIds.length === 1;
}

/** Parse a stored schedule blob defensively; null (+ warn) on mismatch. */
function parseStoredShape(row: { id: string; name: string; schedule: unknown }): MaintenanceScheduleShape | null {
  try {
    return validateScheduleShape(row.schedule);
  } catch {
    logger.warn({ scheduleId: row.id, name: row.name }, "maintenance schedule has invalid recurrence shape; skipping");
    return null;
  }
}

// ─── Target resolution ───────────────────────────────────────────────────────

const TARGET_SELECT = {
  id: true,
  hostname: true,
  ipAddress: true,
  model: true,
  manufacturer: true,
  status: true,
  maintenanceReturnStatus: true,
} as const;

type TargetAsset = {
  id: string;
  hostname: string | null;
  ipAddress: string | null;
  model: string | null;
  manufacturer: string | null;
  status: string;
  maintenanceReturnStatus: string | null;
};

/**
 * Resolve the assets a (criteria, assetIds) pair currently targets:
 * union(criteria matches, explicit ids) ∩ monitored=true. Only monitored
 * assets can be in maintenance — there is nothing to pause otherwise, and it
 * keeps the filter preview honest.
 */
async function resolveTargetAssets(
  criteria: TagCriteria | null,
  assetIds: string[],
): Promise<TargetAsset[]> {
  const union = new Set<string>(assetIds);
  if (criteria) {
    for (const id of await resolveMatchingAssetIds(criteria)) union.add(id);
  }
  if (union.size === 0) return [];
  return prisma.asset.findMany({
    where: { id: { in: Array.from(union) }, monitored: true },
    select: TARGET_SELECT,
  }) as Promise<TargetAsset[]>;
}

export interface MaintenancePreview {
  total: number;
  assets: Array<{
    id: string;
    hostname: string | null;
    ipAddress: string | null;
    model: string | null;
    manufacturer: string | null;
  }>;
}

/** Dry-run the target filter for the builder's live device-list preview. */
export async function previewTargets(input: {
  criteria?: unknown;
  assetIds?: string[];
}): Promise<MaintenancePreview> {
  const criteria = normalizeCriteria(input.criteria ?? null);
  if (criteria && criteria.rules.some((r) => r.field === "status")) {
    throw new AppError(400, "Maintenance criteria cannot filter on status");
  }
  const assetIds = (input.assetIds ?? []).map((id) => String(id)).filter(Boolean);
  const targets = await resolveTargetAssets(criteria, assetIds);
  targets.sort((a, b) => (a.hostname ?? "").localeCompare(b.hostname ?? ""));
  return {
    total: targets.length,
    assets: targets.slice(0, PREVIEW_CAP).map(({ id, hostname, ipAddress, model, manufacturer }) => ({
      id, hostname, ipAddress, model, manufacturer,
    })),
  };
}

// ─── Calendar occurrences ────────────────────────────────────────────────────

/** Widest range the calendar may ask for in one call (a year plus slack). */
const MAX_OCCURRENCE_RANGE_DAYS = 400;
/** Per-response occurrence cap — a daily all-day schedule over a year is 366. */
const MAX_OCCURRENCES = 2000;

export interface MaintenanceOccurrenceRow {
  scheduleId: string;
  name: string;
  enabled: boolean;
  kind: "oneshot" | "recurring";
  /** Single-asset one-shot with no criteria — the pill / edit-modal artifact. */
  adhoc: boolean;
  /** SERVER-LOCAL wall clock "YYYY-MM-DDTHH:MM" — never a UTC instant. */
  start: string;
  end: string;
}

/**
 * Expand every schedule's occurrences across [from, to] for the Maintenance
 * modal's calendar tab. `from`/`to` are local day strings ("YYYY-MM-DD"),
 * inclusive of `to` (the range end is `to` + 1 day at midnight).
 *
 * Times come back as local-ISO minute strings rather than instants: the
 * recurrence engine is server-local wall-clock, so handing the browser a UTC
 * Date would have it re-render windows in ITS timezone and paint them on the
 * wrong day for any operator not sitting in the server's zone.
 */
export async function listOccurrences(input: {
  from: string;
  to: string;
}): Promise<{ from: string; to: string; occurrences: MaintenanceOccurrenceRow[]; truncated: boolean }> {
  const rangeStart = parseLocalDay(input.from);
  const rangeEndDay = parseLocalDay(input.to);
  if (!Number.isFinite(rangeStart.getTime()) || !Number.isFinite(rangeEndDay.getTime())) {
    throw new AppError(400, "from and to must be local dates (YYYY-MM-DD)");
  }
  if (rangeEndDay.getTime() < rangeStart.getTime()) {
    throw new AppError(400, "to must not be before from");
  }
  const spanDays = Math.round((rangeEndDay.getTime() - rangeStart.getTime()) / 86_400_000);
  if (spanDays > MAX_OCCURRENCE_RANGE_DAYS) {
    throw new AppError(400, `Range too wide (max ${MAX_OCCURRENCE_RANGE_DAYS} days)`);
  }
  // Exclusive end = midnight after the last requested day.
  const rangeEnd = new Date(
    rangeEndDay.getFullYear(), rangeEndDay.getMonth(), rangeEndDay.getDate() + 1, 0, 0, 0, 0,
  );

  const schedules = await prisma.maintenanceSchedule.findMany({ orderBy: { name: "asc" } });
  const occurrences: MaintenanceOccurrenceRow[] = [];
  let truncated = false;
  for (const s of schedules) {
    const shape = parseStoredShape(s);
    if (!shape) continue;
    const remaining = MAX_OCCURRENCES - occurrences.length;
    if (remaining <= 0) { truncated = true; break; }
    const occs = expandOccurrences(shape, rangeStart, rangeEnd, remaining);
    for (const occ of occs) {
      occurrences.push({
        scheduleId: s.id,
        name: s.name,
        enabled: s.enabled,
        kind: shape.kind,
        adhoc: isAdhocShape(s, shape),
        start: formatLocalIsoMinute(occ.start),
        end: formatLocalIsoMinute(occ.end),
      });
    }
  }
  occurrences.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.name.localeCompare(b.name)));
  return { from: input.from, to: input.to, occurrences, truncated };
}

// ─── Active-window readout (dashboard widget feed) ───────────────────────────

export interface ActiveMaintenanceSchedule {
  id: string;
  name: string;
  /** Devices this schedule is holding in maintenance right now (open windows). */
  deviceCount: number;
  /** Per-assetType breakdown of those devices, largest first. */
  assetTypes: Array<{ assetType: string; count: number }>;
  /** True when the widget's asset filter matched only SOME of the devices. */
  filtered: boolean;
  /** Devices matching the caller's filter; equals deviceCount when unfiltered. */
  matchedCount: number;
  kind: "oneshot" | "recurring";
  /** Single-asset one-shot with no criteria — the status-pill / edit-modal artifact. */
  adhoc: boolean;
  suppressChildren: boolean;
  /** SERVER-LOCAL wall clock "YYYY-MM-DDTHH:MM" for display — never a UTC instant. */
  startedAt: string | null;
  endsAt: string | null;
  /**
   * The same window end as a true instant, for a browser-side countdown. The
   * pair is deliberate: `endsAt` is what the operator must SEE (the recurrence
   * engine runs on the server's wall clock, so re-rendering it in the viewer's
   * zone paints the window on the wrong hour), `endsAtUtc` is the only form
   * "ends in 40m" can be computed from without assuming the two clocks agree.
   */
  endsAtUtc: string | null;
}

/**
 * Every maintenance schedule currently IN EFFECT, for the Active Maintenance
 * dashboard widget (`/dashboard/noc-summary?feeds=maintenanceSchedules`).
 *
 * "In effect" = enabled AND (holding ≥1 open window OR inside an occurrence
 * right now). Open windows are the source of truth for which devices are
 * actually held (see the module header); the isInWindow arm additionally
 * catches a schedule whose occurrence has just opened but whose devices the
 * 30s reconcile has not entered yet, so the widget doesn't read empty for
 * half a minute at the top of every window.
 *
 * `assetIds` is the widget's shared NOC filter (region / asset type /
 * FortiGate), resolved by nocDashboardService.resolveFilteredAssetIds; null =
 * unfiltered. **A schedule matches when ANY of its devices does** (business
 * rule 73 — a scoped view narrows the LIST, never the window) — a window
 * covering switches, APs and servers is still the thing a switch-scoped
 * dashboard needs to know about, so it is listed WHOLE (every device counted,
 * every type named) with `matchedCount` recording how much of it the filter
 * actually claimed. Filtering it down to the matching devices would report a
 * smaller outage than the one the operator is looking at.
 *
 * Scale: one findMany over the (operator-sized) schedule table plus one
 * GROUP BY over open window rows — at most (#schedules x #assetTypes) rows
 * back, flat from 100 to 2000 assets. Nothing here iterates devices.
 */
export async function getActiveMaintenanceSchedules(
  limit: number | null = 50,
  assetIds: string[] | null = null,
): Promise<ActiveMaintenanceSchedule[]> {
  const now = new Date();
  const schedules = await prisma.maintenanceSchedule.findMany({ where: { enabled: true } });
  if (schedules.length === 0) return [];

  // Open windows grouped per (schedule, assetType). The filter is a second
  // aggregate over the same scan rather than a narrowing of it, so a filtered
  // call still knows each schedule's TRUE device count and type list. The id
  // set is bound as one array parameter (the nocDashboardService idiom), never
  // interpolated.
  const rows = await prisma.$queryRawUnsafe<
    Array<{ scheduleId: string; assetType: string; total: bigint; matched: bigint }>
  >(
    `SELECT w."scheduleId" AS "scheduleId",
            a."assetType"  AS "assetType",
            count(*)::bigint AS total,
            count(*) FILTER (WHERE a."id" = ANY($1::text[]))::bigint AS matched
     FROM "asset_maintenance_windows" w
     JOIN "assets" a ON a."id" = w."assetId"
     WHERE w."endedAt" IS NULL AND w."scheduleId" IS NOT NULL
     GROUP BY 1, 2`,
    assetIds ?? [],
  );

  const bySchedule = new Map<string, { types: Map<string, number>; total: number; matched: number }>();
  for (const r of rows) {
    let e = bySchedule.get(r.scheduleId);
    if (!e) { e = { types: new Map(), total: 0, matched: 0 }; bySchedule.set(r.scheduleId, e); }
    const n = Number(r.total);
    e.types.set(r.assetType, (e.types.get(r.assetType) ?? 0) + n);
    e.total += n;
    e.matched += Number(r.matched);
  }

  const out: ActiveMaintenanceSchedule[] = [];
  for (const s of schedules) {
    const shape = parseStoredShape(s);
    if (!shape) continue;
    const held = bySchedule.get(s.id);
    const occ = currentWindow(shape, now);
    // Holding devices, or inside an occurrence the reconcile hasn't acted on
    // yet. A schedule whose window has ended but whose rows are still open
    // (the up-to-30s closing lag) stays listed, with no end time to show.
    if (!held && !occ) continue;
    // With a filter on, a schedule none of whose devices matched is not this
    // dashboard's business. Unfiltered, a just-opened window with no devices
    // yet is still worth showing.
    if (assetIds !== null && (!held || held.matched === 0)) continue;
    out.push({
      id: s.id,
      name: s.name,
      deviceCount: held?.total ?? 0,
      assetTypes: [...(held?.types ?? new Map<string, number>())]
        .map(([assetType, count]) => ({ assetType, count }))
        .sort((a, b) => b.count - a.count || a.assetType.localeCompare(b.assetType)),
      matchedCount: assetIds === null ? (held?.total ?? 0) : (held?.matched ?? 0),
      filtered: assetIds !== null && !!held && held.matched < held.total,
      kind: shape.kind,
      adhoc: isAdhocShape(s, shape),
      suppressChildren: s.suppressChildren,
      startedAt: occ ? formatLocalIsoMinute(occ.start) : null,
      endsAt: occ ? formatLocalIsoMinute(occ.end) : null,
      endsAtUtc: occ ? occ.end.toISOString() : null,
    });
  }
  // Soonest to end first — the widget's question is "what comes back when?".
  // A schedule with no readable end (closing lag) sinks rather than sorting as
  // "ends first", the same posture as the widgets' own missing-value sorts.
  out.sort((a, b) => {
    if (a.endsAtUtc !== b.endsAtUtc) {
      if (!a.endsAtUtc) return 1;
      if (!b.endsAtUtc) return -1;
      return a.endsAtUtc < b.endsAtUtc ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
  return limit == null ? out : out.slice(0, limit);
}

// ─── Schedule CRUD ───────────────────────────────────────────────────────────

export async function listSchedules() {
  return prisma.maintenanceSchedule.findMany({ orderBy: { createdAt: "desc" } });
}

export async function getSchedule(id: string) {
  const row = await prisma.maintenanceSchedule.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Maintenance schedule not found");
  return row;
}

export async function createSchedule(input: MaintenanceScheduleInput, actor?: string) {
  const n = normalizeInput(input);
  const row = await prisma.maintenanceSchedule.create({
    data: {
      name: n.name,
      enabled: n.enabled,
      criteria: (n.criteria ?? undefined) as any,
      assetIds: n.assetIds,
      schedule: n.schedule as any,
      suppressChildren: n.suppressChildren,
      createdBy: actor ?? null,
    },
  });
  await logEvent({
    action: "maintenance_schedule.created",
    resourceType: "maintenance-schedule",
    resourceId: row.id,
    resourceName: row.name,
    actor,
    message: `Maintenance schedule "${row.name}" created (${n.schedule.kind})`,
    details: { kind: n.schedule.kind, enabled: n.enabled },
  });
  await reconcileMaintenance();
  return row;
}

export async function updateSchedule(id: string, input: MaintenanceScheduleInput, actor?: string) {
  await getSchedule(id); // 404 if missing
  const n = normalizeInput(input);
  const row = await prisma.maintenanceSchedule.update({
    where: { id },
    data: {
      name: n.name,
      enabled: n.enabled,
      criteria: (n.criteria ?? null) as any,
      assetIds: n.assetIds,
      schedule: n.schedule as any,
      suppressChildren: n.suppressChildren,
    },
  });
  await logEvent({
    action: "maintenance_schedule.updated",
    resourceType: "maintenance-schedule",
    resourceId: row.id,
    resourceName: row.name,
    actor,
    message: `Maintenance schedule "${row.name}" updated`,
    details: { kind: n.schedule.kind, enabled: n.enabled },
  });
  await reconcileMaintenance();
  return row;
}

export async function deleteSchedule(id: string, actor?: string) {
  const row = await getSchedule(id);
  await prisma.maintenanceSchedule.delete({ where: { id } });
  await logEvent({
    action: "maintenance_schedule.deleted",
    resourceType: "maintenance-schedule",
    resourceId: id,
    resourceName: row.name,
    actor,
    message: `Maintenance schedule "${row.name}" deleted`,
  });
  // Open rows now have scheduleId=null (SetNull) — the reconcile closes them
  // ("deleted") and restores statuses.
  await reconcileMaintenance();
}

export interface RemoveAssetFromScheduleResult {
  /** The schedule was deleted outright because the asset was its last target. */
  scheduleDeleted: boolean;
  scheduleName: string;
  /** Explicit targets left on the schedule (0 when it was deleted). */
  remainingAssetIds: number;
}

/**
 * Drop ONE asset from a schedule's explicit target list — the Maintenance tab
 * of the asset edit modal, where an operator who sees "covered by schedule X"
 * wants this device out of X without hunting for X on the Maintenance page.
 *
 * Two refusals, both deliberate:
 *  - an asset the schedule's CRITERIA match is not removable one asset at a
 *    time. Dropping the explicit id would leave the filter matching it, the
 *    next reconcile would re-target it, and the operator would have been told
 *    "removed" about a device still heading into the window. Narrowing the
 *    filter is the real fix, and it belongs to the schedule builder.
 *  - an asset the schedule doesn't target at all is a 400, not a silent
 *    no-op, because the only way to ask is from a stale tab.
 *
 * When the asset is the schedule's LAST target the schedule is deleted rather
 * than updated: `normalizeInput` refuses a targetless schedule on every other
 * write path (it can never fire again), so leaving one behind would create a
 * row the builder itself would reject on the next save.
 *
 * Open windows are closed by the reconcile that follows, not here — falling
 * out of the target set is exactly the case it already handles (endReason
 * "criteria", or "deleted" when the schedule went with it), so the exit path,
 * the status restore and the entering/exiting events stay in one place.
 */
export async function removeAssetFromSchedule(
  scheduleId: string,
  assetId: string,
  actor?: string,
): Promise<RemoveAssetFromScheduleResult> {
  const row = await getSchedule(scheduleId); // 404 if missing
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  const assetLabel = asset.hostname ?? assetId;

  const criteria = (row.criteria ?? null) as TagCriteria | null;
  const byCriteria = criteria ? (await resolveMatchingAssetIds(criteria)).has(assetId) : false;
  const explicit = row.assetIds.includes(assetId);

  if (byCriteria) {
    throw new AppError(
      400,
      `"${row.name}" targets this asset through its filter, so taking it off the device list ` +
        "would not take it out of the window. Edit the schedule's filter under " +
        "Assets → Maintenance to exclude it.",
    );
  }
  if (!explicit) throw new AppError(400, `"${row.name}" does not target this asset`);

  const remaining = row.assetIds.filter((id) => id !== assetId);

  if (remaining.length === 0 && !criteria) {
    await prisma.maintenanceSchedule.delete({ where: { id: scheduleId } });
    await logEvent({
      action: "maintenance_schedule.deleted",
      resourceType: "maintenance-schedule",
      resourceId: scheduleId,
      resourceName: row.name,
      actor,
      message: `Maintenance schedule "${row.name}" deleted (last device ${assetLabel} removed)`,
      details: { reason: "last-asset-removed", assetId, assetName: assetLabel },
    });
    await reconcileMaintenance();
    return { scheduleDeleted: true, scheduleName: row.name, remainingAssetIds: 0 };
  }

  await prisma.maintenanceSchedule.update({
    where: { id: scheduleId },
    data: { assetIds: remaining },
  });
  await logEvent({
    action: "maintenance_schedule.updated",
    resourceType: "maintenance-schedule",
    resourceId: scheduleId,
    resourceName: row.name,
    actor,
    message: `${assetLabel} removed from maintenance schedule "${row.name}"`,
    details: { reason: "asset-removed", assetId, assetName: assetLabel, remaining: remaining.length },
  });
  await reconcileMaintenance();
  return { scheduleDeleted: false, scheduleName: row.name, remainingAssetIds: remaining.length };
}

// ─── Per-asset reads ─────────────────────────────────────────────────────────

/** Window rows overlapping [since, until] — powers the chart maintenance bands. */
export async function listAssetWindows(assetId: string, since: Date, until: Date) {
  return prisma.assetMaintenanceWindow.findMany({
    where: {
      assetId,
      startedAt: { lte: until },
      OR: [{ endedAt: null }, { endedAt: { gte: since } }],
    },
    orderBy: { startedAt: "asc" },
    select: { id: true, scheduleId: true, scheduleName: true, startedAt: true, endedAt: true, endReason: true },
  });
}

export interface AssetMaintenanceInfo {
  inMaintenance: boolean;
  /**
   * The asset's status as of THIS read. The edit modal's Status dropdown was
   * filled when the modal opened; an action on this tab can end a window and
   * move the status underneath it, and saving the stale "maintenance" would
   * re-park the device by hand — so the tab re-syncs the dropdown from here.
   */
  status: string;
  returnStatus: string | null;
  openWindows: Array<{
    id: string;
    scheduleId: string | null;
    scheduleName: string;
    startedAt: Date;
    /** Predicted end of the current occurrence (null when not derivable). */
    until: Date | null;
  }>;
  /** Schedules whose target filter currently includes this asset. */
  schedules: Array<{
    id: string;
    name: string;
    enabled: boolean;
    activeNow: boolean;
    nextStart: Date | null;
    nextEnd: Date | null;
    /** Asset is named on the schedule's explicit `assetIds` list. */
    explicit: boolean;
    /** Asset is matched by the schedule's criteria filter. */
    byCriteria: boolean;
    /**
     * A per-asset removal can actually drop this asset (explicit membership
     * and NOT also matched by the filter, which would re-target it the
     * instant the list changed — see removeAssetFromSchedule).
     */
    removable: boolean;
    /**
     * Removing this asset would leave the schedule with no targets at all, so
     * the removal deletes the schedule instead of leaving a dead row.
     */
    lastTarget: boolean;
  }>;
}

/**
 * The edit-modal / slide-over bundle: current windows + every schedule that
 * covers this asset. Evaluates each schedule's filter against the one asset —
 * fine at single-asset cost, schedule counts are notification-rule-sized.
 */
export async function getAssetMaintenanceInfo(assetId: string): Promise<AssetMaintenanceInfo> {
  const [asset, open, schedules] = await Promise.all([
    prisma.asset.findUnique({
      where: { id: assetId },
      select: { id: true, status: true, maintenanceReturnStatus: true, monitored: true },
    }),
    prisma.assetMaintenanceWindow.findMany({
      where: { assetId, endedAt: null },
      orderBy: { startedAt: "asc" },
      select: { id: true, scheduleId: true, scheduleName: true, startedAt: true },
    }),
    prisma.maintenanceSchedule.findMany({ orderBy: { name: "asc" } }),
  ]);
  if (!asset) throw new AppError(404, "Asset not found");

  const now = new Date();
  const shapeById = new Map<string, MaintenanceScheduleShape>();
  const covering: AssetMaintenanceInfo["schedules"] = [];

  for (const s of schedules) {
    const shape = parseStoredShape(s);
    if (!shape) continue;
    shapeById.set(s.id, shape);
    const explicit = s.assetIds.includes(assetId);
    // Both halves are evaluated even when the asset is explicitly listed: an
    // asset the filter ALSO matches is not removable one asset at a time, and
    // the Maintenance tab has to say so rather than offer a button that
    // re-targets the asset on the next reconcile.
    let byCriteria = false;
    if (s.criteria) {
      const criteria = s.criteria as unknown as TagCriteria;
      byCriteria = (await resolveMatchingAssetIds(criteria)).has(assetId);
    }
    // Unmonitored assets can never be targeted (targets ∩ monitored=true),
    // so covering schedules are only reported for monitored assets.
    if ((!explicit && !byCriteria) || !asset.monitored) continue;
    const next = nextWindow(shape, now);
    covering.push({
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      activeNow: s.enabled && isInWindow(shape, now),
      nextStart: next?.start ?? null,
      nextEnd: next?.end ?? null,
      explicit,
      byCriteria,
      removable: explicit && !byCriteria,
      lastTarget: explicit && !s.criteria && s.assetIds.length === 1,
    });
  }

  return {
    inMaintenance: open.length > 0,
    status: asset.status,
    returnStatus: asset.maintenanceReturnStatus,
    openWindows: open.map((w) => {
      const shape = w.scheduleId ? shapeById.get(w.scheduleId) : undefined;
      const occ = shape ? currentWindow(shape, now) : null;
      return {
        id: w.id,
        scheduleId: w.scheduleId,
        scheduleName: w.scheduleName,
        startedAt: w.startedAt,
        until: occ?.end ?? null,
      };
    }),
    schedules: covering,
  };
}

/**
 * Operator ends maintenance on one asset (called from the assets PUT route
 * BEFORE applying an operator status write that moves off "maintenance").
 * Closes every open window (endReason "operator" — suppresses scheduler
 * re-entry for each schedule's current occurrence) and clears the parked
 * return status. Deliberately does NOT write status: the operator's own
 * incoming value wins.
 */
export async function operatorReleaseAsset(assetId: string, actor?: string): Promise<boolean> {
  const open = await prisma.assetMaintenanceWindow.findMany({
    where: { assetId, endedAt: null },
    select: { id: true, scheduleId: true, scheduleName: true },
  });
  if (open.length === 0) return false;
  const now = new Date();
  await prisma.$transaction([
    prisma.assetMaintenanceWindow.updateMany({
      where: { id: { in: open.map((w) => w.id) } },
      data: { endedAt: now, endReason: "operator" },
    }),
    prisma.asset.update({ where: { id: assetId }, data: { maintenanceReturnStatus: null } }),
  ]);
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } });
  await logEvent({
    action: "maintenance.exited",
    resourceType: "asset",
    resourceId: assetId,
    resourceName: asset?.hostname ?? assetId,
    actor,
    message: `Maintenance ended by operator (${open.map((w) => w.scheduleName).join(", ")})`,
    details: { reason: "operator", schedules: open.map((w) => w.scheduleName) },
  });

  // Spent ad-hoc cleanup: a released single-asset one-shot can never fire
  // again (release suppresses its only occurrence), so delete it rather than
  // leaving a dead row in the Schedules list. Closed window rows keep their
  // scheduleName snapshot for the chart bands (scheduleId goes SetNull).
  await deleteSpentAdhocSchedules(
    open.map((w) => w.scheduleId),
    actor,
    "maintenance ended by operator",
    "adhoc-spent-operator",
  );
  return true;
}

/**
 * Delete the single-asset ad-hoc one-shots among `scheduleIds` — the pill /
 * edit-modal "enter maintenance until…" artifacts, which are single-purpose
 * and can never usefully fire again once their window has been ended early.
 * Multi-asset / criteria-based / recurring schedules are never auto-deleted.
 */
async function deleteSpentAdhocSchedules(
  scheduleIds: Array<string | null>,
  actor: string | undefined,
  note: string,
  reasonCode: string,
): Promise<void> {
  const ids = Array.from(new Set(scheduleIds.filter((id): id is string => !!id)));
  if (ids.length === 0) return;
  const rows = await prisma.maintenanceSchedule.findMany({ where: { id: { in: ids } } });
  const spent = rows.filter((s) => isAdhocShape(s, parseStoredShape(s)));
  if (spent.length === 0) return;
  await prisma.maintenanceSchedule.deleteMany({ where: { id: { in: spent.map((s) => s.id) } } });
  await logEventsBatch(
    spent.map((s) => ({
      action: "maintenance_schedule.deleted",
      resourceType: "maintenance-schedule",
      resourceId: s.id,
      resourceName: s.name,
      actor: actor ?? SYSTEM_ACTOR,
      message: `Ad-hoc maintenance schedule "${s.name}" removed (${note})`,
      details: { reason: reasonCode },
    })),
  );
}

/**
 * Force-exit maintenance for assets a discovery sweep has just found GONE at
 * their source of truth (no longer in the FMG device roster / no longer in a
 * FortiGate controller's managed FortiSwitch-FortiAP inventory), and
 * decommission them.
 *
 * Deletion-at-source OUTRANKS the maintenance window. The window guard on the
 * decommission sweeps exists because maintenance makes a device deliberately
 * unreachable — but roster absence is CONFIG truth, not a reachability
 * signal (an offline/unreachable device stays in the roster and is never
 * flagged). Without this, a device deleted from FortiManager mid-window sat in
 * "maintenance" for the rest of the window and was then restored to its
 * parked status — usually "active" — so a deleted device came back as live
 * inventory and only aged out months later via decommissionStaleAssets.
 *
 * Closes every open window (`endReason: "decommissioned"`), clears the parked
 * return status, and writes `status: "decommissioned"` in ONE transaction, so
 * the 30s reconcile can never observe a half-state it would "fix": open rows
 * with a non-maintenance status get self-heal-reflipped, and closed rows on a
 * still-`monitored` asset get re-entered. The status write also clamps
 * `monitored=false` (business rule 10) via the Prisma extension in db.ts,
 * which is what keeps the asset out of the target set on later ticks.
 *
 * Returns the ids that were actually in maintenance (callers apply their own
 * status write to the rest of the sweep's batch).
 */
export async function releaseAssetsForDecommission(
  assetIds: string[],
  opts: { at?: Date; actor?: string; statusChangedBy?: string; reason?: string } = {},
): Promise<string[]> {
  if (assetIds.length === 0) return [];
  const open = await prisma.assetMaintenanceWindow.findMany({
    where: { assetId: { in: assetIds }, endedAt: null },
    select: { id: true, assetId: true, scheduleId: true, scheduleName: true },
  });
  if (open.length === 0) return [];

  const now = opts.at ?? new Date();
  const releasedIds = Array.from(new Set(open.map((w) => w.assetId)));
  await prisma.$transaction([
    prisma.assetMaintenanceWindow.updateMany({
      where: { id: { in: open.map((w) => w.id) } },
      data: { endedAt: now, endReason: "decommissioned" },
    }),
    prisma.asset.updateMany({
      where: { id: { in: releasedIds } },
      data: {
        status: "decommissioned" as any,
        maintenanceReturnStatus: null,
        statusChangedAt: now,
        statusChangedBy: opts.statusChangedBy ?? SYSTEM_ACTOR,
      },
    }),
  ]);

  const rows = await prisma.asset.findMany({
    where: { id: { in: releasedIds } },
    select: { id: true, hostname: true },
  });
  const nameById = new Map(rows.map((r) => [r.id, r.hostname ?? r.id]));
  const schedNamesByAsset = new Map<string, string[]>();
  for (const w of open) {
    const list = schedNamesByAsset.get(w.assetId) ?? [];
    list.push(w.scheduleName);
    schedNamesByAsset.set(w.assetId, list);
  }
  await logEventsBatch(
    releasedIds.map((id) => ({
      action: "maintenance.exited",
      resourceType: "asset",
      resourceId: id,
      resourceName: nameById.get(id) ?? id,
      actor: opts.actor ?? SYSTEM_ACTOR,
      message: `Maintenance ended — asset decommissioned${opts.reason ? ` (${opts.reason})` : ""}`,
      details: {
        reason: "decommissioned",
        detail: opts.reason ?? null,
        schedules: schedNamesByAsset.get(id) ?? [],
      },
    })),
  );
  logger.info(
    { count: releasedIds.length, reason: opts.reason },
    "maintenance: force-exited asset(s) for decommission (deleted at source)",
  );

  // The ad-hoc one-shot that put a now-deleted device into maintenance is
  // spent — the asset is unmonitored, so it can never be a target again.
  await deleteSpentAdhocSchedules(
    open.map((w) => w.scheduleId),
    opts.actor,
    "asset decommissioned",
    "adhoc-spent-decommissioned",
  );
  return releasedIds;
}

// ─── Reconcile ───────────────────────────────────────────────────────────────

// Serialized + coalesced: an in-flight run never overlaps another, and a call
// made during a run (a CRUD mutation racing the 30s tick) queues exactly one
// follow-up so the mutation is guaranteed to be reflected by a run that
// STARTED after it.
let inFlight: Promise<void> | null = null;
let followUp: Promise<void> | null = null;

export function reconcileMaintenance(): Promise<void> {
  if (inFlight) {
    if (!followUp) {
      followUp = inFlight
        .catch(() => {})
        .then(() => {
          followUp = null;
          return reconcileMaintenance();
        });
    }
    return followUp;
  }
  inFlight = runReconcile()
    .catch((err: any) => {
      logger.warn({ err: err?.message ?? String(err) }, "maintenance reconcile failed (non-fatal)");
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function runReconcile(): Promise<void> {
  const now = new Date();
  const schedules = await prisma.maintenanceSchedule.findMany();
  const scheduleById = new Map(schedules.map((s) => [s.id, s]));

  // Desired (asset, schedule) pairs for every schedule active RIGHT NOW.
  const desired = new Map<string, Set<string>>(); // scheduleId → assetIds
  const shapeById = new Map<string, MaintenanceScheduleShape>();
  for (const s of schedules) {
    const shape = parseStoredShape(s);
    if (!shape) continue;
    shapeById.set(s.id, shape);
    if (!s.enabled || !isInWindow(shape, now)) continue;
    const targets = await resolveTargetAssets(
      (s.criteria ?? null) as TagCriteria | null,
      s.assetIds,
    );
    desired.set(s.id, new Set(targets.map((t) => t.id)));
  }

  const openRows = await prisma.assetMaintenanceWindow.findMany({
    where: { endedAt: null },
    select: { id: true, assetId: true, scheduleId: true, scheduleName: true },
  });

  // ── Diff ──────────────────────────────────────────────────────────────────
  const toClose: Array<{ id: string; assetId: string; scheduleId: string | null; reason: string }> = [];
  const openPairs = new Set<string>(); // "assetId|scheduleId" for rows staying open
  for (const row of openRows) {
    const sched = row.scheduleId ? scheduleById.get(row.scheduleId) : undefined;
    if (!sched) {
      toClose.push({ id: row.id, assetId: row.assetId, scheduleId: row.scheduleId, reason: "deleted" });
    } else if (!sched.enabled) {
      toClose.push({ id: row.id, assetId: row.assetId, scheduleId: row.scheduleId, reason: "disabled" });
    } else if (!desired.has(sched.id)) {
      toClose.push({ id: row.id, assetId: row.assetId, scheduleId: row.scheduleId, reason: "schedule" });
    } else if (!desired.get(sched.id)!.has(row.assetId)) {
      toClose.push({ id: row.id, assetId: row.assetId, scheduleId: row.scheduleId, reason: "criteria" });
    } else {
      openPairs.add(`${row.assetId}|${row.scheduleId}`);
    }
  }

  // Candidate opens = desired pairs without an open row.
  const candidateOpens: Array<{ assetId: string; scheduleId: string }> = [];
  for (const [scheduleId, assetIds] of desired) {
    for (const assetId of assetIds) {
      if (!openPairs.has(`${assetId}|${scheduleId}`)) candidateOpens.push({ assetId, scheduleId });
    }
  }

  // Operator-release suppression: skip a candidate pair when the operator
  // ended maintenance during THIS occurrence of that schedule.
  let toOpen = candidateOpens;
  if (candidateOpens.length > 0) {
    const released = await prisma.assetMaintenanceWindow.findMany({
      where: {
        endReason: "operator",
        assetId: { in: Array.from(new Set(candidateOpens.map((c) => c.assetId))) },
        scheduleId: { in: Array.from(new Set(candidateOpens.map((c) => c.scheduleId))) },
        endedAt: { not: null },
      },
      select: { assetId: true, scheduleId: true, endedAt: true },
    });
    const latestRelease = new Map<string, number>();
    for (const r of released) {
      const key = `${r.assetId}|${r.scheduleId}`;
      const t = r.endedAt!.getTime();
      if ((latestRelease.get(key) ?? 0) < t) latestRelease.set(key, t);
    }
    toOpen = candidateOpens.filter((c) => {
      const releasedAt = latestRelease.get(`${c.assetId}|${c.scheduleId}`);
      if (releasedAt == null) return true;
      const occ = currentWindow(shapeById.get(c.scheduleId)!, now);
      return occ ? releasedAt < occ.start.getTime() : true;
    });
  }

  if (toClose.length === 0 && toOpen.length === 0) {
    await pruneOldWindows(now);
    return;
  }

  // Per-asset open-row accounting → who ENTERS (0 → >0) and who EXITS (>0 → 0).
  const beforeCount = new Map<string, number>();
  for (const row of openRows) beforeCount.set(row.assetId, (beforeCount.get(row.assetId) ?? 0) + 1);
  const afterCount = new Map<string, number>(beforeCount);
  for (const c of toClose) afterCount.set(c.assetId, (afterCount.get(c.assetId) ?? 0) - 1);
  for (const o of toOpen) afterCount.set(o.assetId, (afterCount.get(o.assetId) ?? 0) + 1);

  const entering = Array.from(afterCount.entries())
    .filter(([assetId, n]) => n > 0 && (beforeCount.get(assetId) ?? 0) === 0)
    .map(([assetId]) => assetId);
  const exiting = Array.from(afterCount.entries())
    .filter(([assetId, n]) => n <= 0 && (beforeCount.get(assetId) ?? 0) > 0)
    .map(([assetId]) => assetId);

  // ── Window-row writes (grouped) ───────────────────────────────────────────
  const closesByReason = new Map<string, string[]>();
  for (const c of toClose) {
    const list = closesByReason.get(c.reason) ?? [];
    list.push(c.id);
    closesByReason.set(c.reason, list);
  }
  const writes: any[] = [];
  for (const [reason, ids] of closesByReason) {
    writes.push(
      prisma.assetMaintenanceWindow.updateMany({
        where: { id: { in: ids } },
        data: { endedAt: now, endReason: reason },
      }),
    );
  }
  if (toOpen.length > 0) {
    writes.push(
      prisma.assetMaintenanceWindow.createMany({
        data: toOpen.map((o) => ({
          assetId: o.assetId,
          scheduleId: o.scheduleId,
          scheduleName: scheduleById.get(o.scheduleId)?.name ?? "(unknown)",
          startedAt: now,
        })),
      }),
    );
  }
  await prisma.$transaction(writes);

  // ── Status flips (grouped updateMany per target status) ──────────────────
  // ENTERS: park the current status and flip to maintenance. An asset the
  // operator had ALREADY set to "maintenance" parks "maintenance" verbatim —
  // exit restores the operator's manual state, no loop.
  if (entering.length > 0) {
    const rows = await prisma.asset.findMany({
      where: { id: { in: entering } },
      select: { id: true, status: true, hostname: true },
    });
    const byStatus = new Map<string, string[]>();
    for (const r of rows) {
      const list = byStatus.get(r.status) ?? [];
      list.push(r.id);
      byStatus.set(r.status, list);
    }
    await prisma.$transaction(
      Array.from(byStatus.entries()).map(([status, ids]) =>
        prisma.asset.updateMany({
          where: { id: { in: ids } },
          data: {
            status: "maintenance" as any,
            maintenanceReturnStatus: status as any,
            statusChangedAt: now,
            statusChangedBy: SYSTEM_ACTOR,
          },
        }),
      ),
    );
    const nameById = new Map(rows.map((r) => [r.id, r.hostname ?? r.id]));
    const openNamesByAsset = new Map<string, string[]>();
    for (const o of toOpen) {
      const list = openNamesByAsset.get(o.assetId) ?? [];
      list.push(scheduleById.get(o.scheduleId)?.name ?? "(unknown)");
      openNamesByAsset.set(o.assetId, list);
    }
    const schedNames = (assetId: string) => openNamesByAsset.get(assetId) ?? [];
    await logEventsBatch(
      entering.map((assetId) => ({
        action: "maintenance.entered",
        resourceType: "asset",
        resourceId: assetId,
        resourceName: nameById.get(assetId) ?? assetId,
        actor: SYSTEM_ACTOR,
        message: `Entered maintenance mode (${schedNames(assetId).join(", ") || "schedule"})`,
        details: { schedules: schedNames(assetId) },
      })),
    );
    // A window is announced downtime, so it must not open on top of a live
    // alert (business rule 16). The 60s engine sweep would catch these
    // anyway; doing it on the edge is what makes an ad-hoc "enter
    // maintenance now" clear the board while the operator is still looking
    // at it. Best-effort — a failed sweep must never leave the status flip
    // half-applied.
    await clearSuppressedAlerts(entering).catch((err) => {
      logger.warn({ err: (err as Error)?.message }, "clearSuppressedAlerts on maintenance entry failed (non-fatal)");
    });
  }

  // EXITS: restore the parked status — but only when status is still
  // "maintenance" (an operator or guarded system writer that moved it since
  // is respected). The parked column is cleared for every exiting asset
  // either way (no longer scheduler-managed).
  if (exiting.length > 0) {
    const rows = await prisma.asset.findMany({
      where: { id: { in: exiting } },
      select: { id: true, status: true, maintenanceReturnStatus: true, hostname: true },
    });
    const restorable = rows.filter((r) => r.status === "maintenance");
    const byReturn = new Map<string, string[]>();
    for (const r of restorable) {
      const target = r.maintenanceReturnStatus ?? "active";
      const list = byReturn.get(target) ?? [];
      list.push(r.id);
      byReturn.set(target, list);
    }
    const others = rows.filter((r) => r.status !== "maintenance").map((r) => r.id);
    const txn: any[] = Array.from(byReturn.entries()).map(([status, ids]) =>
      prisma.asset.updateMany({
        where: { id: { in: ids } },
        data: {
          status: status as any,
          maintenanceReturnStatus: null,
          statusChangedAt: now,
          statusChangedBy: SYSTEM_ACTOR,
        },
      }),
    );
    if (others.length > 0) {
      txn.push(
        prisma.asset.updateMany({
          where: { id: { in: others } },
          data: { maintenanceReturnStatus: null },
        }),
      );
    }
    await prisma.$transaction(txn);
    await logEventsBatch(
      rows.map((r) => ({
        action: "maintenance.exited",
        resourceType: "asset",
        resourceId: r.id,
        resourceName: r.hostname ?? r.id,
        actor: SYSTEM_ACTOR,
        message:
          r.status === "maintenance"
            ? `Exited maintenance mode (status restored to ${r.maintenanceReturnStatus ?? "active"})`
            : "Exited maintenance mode (status left as-is — changed while in maintenance)",
        details: { restored: r.status === "maintenance", returnStatus: r.maintenanceReturnStatus },
      })),
    );
  }

  // ── Self-heal ─────────────────────────────────────────────────────────────
  // Assets that REMAIN in maintenance but whose status was clobbered by an
  // unguarded system writer: re-flip and absorb the clobbered value so exit
  // restores what that writer wanted. (Operator moves never land here — the
  // assets PUT route closes the windows synchronously first.)
  const enteringSet = new Set(entering);
  const staying = Array.from(afterCount.entries())
    .filter(([assetId, n]) => n > 0 && !enteringSet.has(assetId))
    .map(([assetId]) => assetId);
  await selfHealStatuses(staying, now);

  // ── Spent ad-hoc cleanup ──────────────────────────────────────────────────
  // Single-asset one-shots whose window just ended by SCHEDULE (occurrence
  // over) can never fire again — delete them so the pill's "enter maintenance
  // until…" artifacts don't accumulate in the Schedules list. Disabled-closes
  // are an operator choice and criteria/deleted reasons can't apply to the
  // ad-hoc shape, so only reason "schedule" qualifies; the nextWindow guard
  // keeps an edited-to-the-future one-shot alive.
  const endedScheduleIds = Array.from(new Set(
    toClose.filter((c) => c.reason === "schedule" && c.scheduleId).map((c) => c.scheduleId as string),
  ));
  const spentAdhoc = endedScheduleIds
    .map((id) => scheduleById.get(id))
    .filter((s): s is NonNullable<typeof s> => !!s)
    .filter((s) => {
      const shape = shapeById.get(s.id) ?? null;
      return isAdhocShape(s, shape) && shape != null && nextWindow(shape, now) == null;
    });
  if (spentAdhoc.length > 0) {
    await prisma.maintenanceSchedule.deleteMany({ where: { id: { in: spentAdhoc.map((s) => s.id) } } });
    await logEventsBatch(
      spentAdhoc.map((s) => ({
        action: "maintenance_schedule.deleted",
        resourceType: "maintenance-schedule",
        resourceId: s.id,
        resourceName: s.name,
        actor: SYSTEM_ACTOR,
        message: `Ad-hoc maintenance schedule "${s.name}" removed (window ended)`,
        details: { reason: "adhoc-spent" },
      })),
    );
  }

  await pruneOldWindows(now);
}

/** Re-flip clobbered in-maintenance assets; absorb the clobbered status. */
async function selfHealStatuses(assetIds: string[], now: Date): Promise<void> {
  if (assetIds.length === 0) return;
  const clobbered = await prisma.asset.findMany({
    where: { id: { in: assetIds }, status: { not: "maintenance" as any } },
    select: { id: true, status: true, hostname: true },
  });
  if (clobbered.length === 0) return;
  const byStatus = new Map<string, string[]>();
  for (const r of clobbered) {
    const list = byStatus.get(r.status) ?? [];
    list.push(r.id);
    byStatus.set(r.status, list);
  }
  await prisma.$transaction(
    Array.from(byStatus.entries()).map(([status, ids]) =>
      prisma.asset.updateMany({
        where: { id: { in: ids } },
        data: {
          status: "maintenance" as any,
          maintenanceReturnStatus: status as any,
          statusChangedAt: now,
          statusChangedBy: SYSTEM_ACTOR,
        },
      }),
    ),
  );
  logger.info(
    { count: clobbered.length },
    "maintenance self-heal: re-flipped assets whose status was changed by a system writer mid-window",
  );
}

async function pruneOldWindows(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.assetMaintenanceWindow.deleteMany({ where: { endedAt: { lt: cutoff } } });
}
