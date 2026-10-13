/**
 * src/services/operationsCalendarService.ts — the Events page's Calendar tab:
 * every planned or past operation Polaris runs on a schedule, over a day
 * range, in one list.
 *
 * Three kinds:
 *   maintenance — every maintenance schedule's occurrences, expanded by
 *                 `maintenanceScheduleService.listOccurrences` (rules 16, 80).
 *   reboot      — reboot bookings (`RebootSchedule`, rule 115) and reboot runs
 *                 (`RebootRun`) — a booking that ran is ONE item carrying the
 *                 run's outcome; a reboot-now is an item of its own.
 *   firmware    — the same for firmware upgrades (`FirmwareUpgradeSchedule` /
 *                 `FirmwareUpgradeRun`, rules 87, 93).
 *
 * Booked and past: a booking shows whatever happened to it (pending, cancelled,
 * missed, refused, or its run's result), so the calendar answers "what ran last
 * Tuesday" as well as "what runs tonight".
 *
 * Every time is a SERVER-LOCAL wall-clock "YYYY-MM-DDTHH:MM" string, the
 * shape the maintenance occurrences already use, so the browser never
 * re-renders an instant in its own zone and paints it on the wrong day.
 *
 * Which kinds a caller sees is the route's call (each kind's own read key);
 * this service only assembles what it is asked for.
 *
 * Scale: one occurrence expansion plus four range reads on `scheduledFor` /
 * `startedAt` (indexed by `20261014130000_operations_calendar`), each capped at
 * MAX_DEVICE_ITEMS, with a tight `select`. A fleet of 2000 rebooted nightly
 * fills a month past the cap, which `truncated` says.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { formatLocalIsoMinute, parseLocalDay } from "../utils/maintenanceRecurrence.js";
import { listOccurrences, type MaintenanceOccurrenceRow } from "./maintenanceScheduleService.js";

/** The widest range one call may ask for — the maintenance expansion's own limit. */
const MAX_RANGE_DAYS = 400;
/** Per-kind cap on device operations (bookings + runs). */
export const MAX_DEVICE_ITEMS = 2000;
/** How long a point-in-time item is drawn when it has no end of its own. */
const NOMINAL_MS = 15 * 60_000;

export type CalendarKind = "maintenance" | "reboot" | "firmware";

export interface CalendarDeviceItem {
  kind: "reboot" | "firmware";
  /** Stable per item: "booking:<scheduleId>" or "run:<runId>". */
  id: string;
  assetId: string;
  assetName: string;
  /** Server-local "YYYY-MM-DDTHH:MM". A booking's time, or a run's start. */
  start: string;
  end: string;
  /** Came from a booking (true) or was started now (false). */
  booked: boolean;
  scheduleId: string | null;
  runId: string | null;
  /**
   * Booking states (pending / cancelled / refused / missed) until it runs,
   * then the run's (queued / running / sending / rebooting / succeeded /
   * failed / unverified).
   */
  status: string;
  /** Who booked or started it — a username or `automation:<name>`. */
  by: string;
  /** Firmware only: the version it moves to. */
  toVersion: string | null;
  error: string | null;
}

export interface CalendarResult {
  from: string;
  to: string;
  maintenance: MaintenanceOccurrenceRow[] | null;
  reboot: CalendarDeviceItem[] | null;
  firmware: CalendarDeviceItem[] | null;
  /** Any kind hit its cap; the calendar says some items are omitted. */
  truncated: boolean;
}

interface BookingRow {
  id: string; assetId: string; scheduledFor: Date; status: string; runId: string | null;
  createdBy: string; error: string | null; toVersion?: string | null;
  asset: { hostname: string | null; ipAddress: string | null } | null;
}
interface RunRow {
  id: string; assetId: string; status: string; startedBy: string; startedAt: Date; finishedAt: Date | null;
  error: string | null; toVersion?: string | null;
  asset: { hostname: string | null; ipAddress: string | null } | null;
}

function nameOf(asset: { hostname: string | null; ipAddress: string | null } | null, assetId: string): string {
  return asset?.hostname || asset?.ipAddress || assetId;
}

/** Where a run's block ends: when it finished, else now (still running) — never under the nominal length. */
function runEnd(start: Date, finishedAt: Date | null, now: Date): Date {
  const end = finishedAt ?? now;
  return new Date(Math.max(end.getTime(), start.getTime() + NOMINAL_MS));
}

/**
 * Merge bookings and runs of one kind into calendar items. PURE (exported for
 * the tests): a booking that ran carries its run, a run some booking carries
 * is not drawn twice, and everything is sorted by start.
 */
export function mergeDeviceItems(
  kind: "reboot" | "firmware",
  bookings: readonly BookingRow[],
  runs: readonly RunRow[],
  runsById: ReadonlyMap<string, RunRow>,
  bookedRunIds: ReadonlySet<string>,
  now: Date,
): CalendarDeviceItem[] {
  const out: CalendarDeviceItem[] = [];
  for (const b of bookings) {
    const run = b.runId ? runsById.get(b.runId) ?? null : null;
    const start = b.scheduledFor;
    const end = run ? runEnd(start, run.finishedAt, now) : new Date(start.getTime() + NOMINAL_MS);
    out.push({
      kind,
      id: `booking:${b.id}`,
      assetId: b.assetId,
      assetName: nameOf(b.asset, b.assetId),
      start: formatLocalIsoMinute(start),
      end: formatLocalIsoMinute(end),
      booked: true,
      scheduleId: b.id,
      runId: b.runId,
      status: run ? run.status : b.status,
      by: b.createdBy,
      toVersion: b.toVersion ?? null,
      error: run ? run.error : b.error,
    });
  }
  for (const r of runs) {
    if (bookedRunIds.has(r.id)) continue;
    out.push({
      kind,
      id: `run:${r.id}`,
      assetId: r.assetId,
      assetName: nameOf(r.asset, r.assetId),
      start: formatLocalIsoMinute(r.startedAt),
      end: formatLocalIsoMinute(runEnd(r.startedAt, r.finishedAt, now)),
      booked: false,
      scheduleId: null,
      runId: r.id,
      status: r.status,
      by: r.startedBy,
      toVersion: r.toVersion ?? null,
      error: r.error,
    });
  }
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.assetName.localeCompare(b.assetName)));
  return out;
}

/** [start, endExclusive) for a local day range, validated like the maintenance expansion. */
export function calendarRange(from: string, to: string): { start: Date; end: Date } {
  const start = parseLocalDay(from);
  const lastDay = parseLocalDay(to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(lastDay.getTime())) {
    throw new AppError(400, "from and to must be local dates (YYYY-MM-DD)");
  }
  if (lastDay.getTime() < start.getTime()) throw new AppError(400, "to must not be before from");
  if (Math.round((lastDay.getTime() - start.getTime()) / 86_400_000) > MAX_RANGE_DAYS) {
    throw new AppError(400, `Range too wide (max ${MAX_RANGE_DAYS} days)`);
  }
  return { start, end: new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1, 0, 0, 0, 0) };
}

const ASSET_NAME = { select: { hostname: true, ipAddress: true } } as const;

async function rebootItems(start: Date, end: Date, now: Date): Promise<{ items: CalendarDeviceItem[]; truncated: boolean }> {
  const [bookings, runs] = await Promise.all([
    prisma.rebootSchedule.findMany({
      where: { scheduledFor: { gte: start, lt: end } },
      orderBy: { scheduledFor: "asc" },
      take: MAX_DEVICE_ITEMS + 1,
      select: { id: true, assetId: true, scheduledFor: true, status: true, runId: true, createdBy: true, error: true, asset: ASSET_NAME },
    }),
    prisma.rebootRun.findMany({
      where: { startedAt: { gte: start, lt: end } },
      orderBy: { startedAt: "asc" },
      take: MAX_DEVICE_ITEMS + 1,
      select: { id: true, assetId: true, status: true, startedBy: true, startedAt: true, finishedAt: true, error: true, asset: ASSET_NAME },
    }),
  ]);
  return finish("reboot", bookings, runs, now,
    (ids) => prisma.rebootRun.findMany({ where: { id: { in: ids } }, select: { id: true, assetId: true, status: true, startedBy: true, startedAt: true, finishedAt: true, error: true, asset: ASSET_NAME } }),
    (ids) => prisma.rebootSchedule.findMany({ where: { runId: { in: ids } }, select: { runId: true } }));
}

async function firmwareItems(start: Date, end: Date, now: Date): Promise<{ items: CalendarDeviceItem[]; truncated: boolean }> {
  const [bookings, runs] = await Promise.all([
    prisma.firmwareUpgradeSchedule.findMany({
      where: { scheduledFor: { gte: start, lt: end } },
      orderBy: { scheduledFor: "asc" },
      take: MAX_DEVICE_ITEMS + 1,
      select: { id: true, assetId: true, scheduledFor: true, status: true, runId: true, createdBy: true, error: true, toVersion: true, asset: ASSET_NAME },
    }),
    prisma.firmwareUpgradeRun.findMany({
      where: { startedAt: { gte: start, lt: end } },
      orderBy: { startedAt: "asc" },
      take: MAX_DEVICE_ITEMS + 1,
      select: { id: true, assetId: true, status: true, startedBy: true, startedAt: true, finishedAt: true, error: true, toVersion: true, asset: ASSET_NAME },
    }),
  ]);
  return finish("firmware", bookings, runs, now,
    (ids) => prisma.firmwareUpgradeRun.findMany({ where: { id: { in: ids } }, select: { id: true, assetId: true, status: true, startedBy: true, startedAt: true, finishedAt: true, error: true, toVersion: true, asset: ASSET_NAME } }),
    (ids) => prisma.firmwareUpgradeSchedule.findMany({ where: { runId: { in: ids } }, select: { runId: true } }));
}

/**
 * The two joins a merge needs, each one query: the runs the in-range bookings
 * point at (a booking near the range edge may have started just outside it),
 * and which in-range runs belong to a booking (that booking may sit just
 * outside the range — its run is still drawn once, as the booking's).
 */
async function finish(
  kind: "reboot" | "firmware",
  bookingsRaw: BookingRow[],
  runsRaw: RunRow[],
  now: Date,
  loadRuns: (ids: string[]) => Promise<RunRow[]>,
  loadBookedRunIds: (ids: string[]) => Promise<Array<{ runId: string | null }>>,
): Promise<{ items: CalendarDeviceItem[]; truncated: boolean }> {
  const truncated = bookingsRaw.length > MAX_DEVICE_ITEMS || runsRaw.length > MAX_DEVICE_ITEMS;
  const bookings = bookingsRaw.slice(0, MAX_DEVICE_ITEMS);
  const runs = runsRaw.slice(0, MAX_DEVICE_ITEMS);
  const runsById = new Map(runs.map((r) => [r.id, r]));
  const missing = bookings.map((b) => b.runId).filter((id): id is string => !!id && !runsById.has(id));
  const runIds = runs.map((r) => r.id);
  const [extraRuns, booked] = await Promise.all([
    missing.length ? loadRuns(missing) : Promise.resolve([] as RunRow[]),
    runIds.length ? loadBookedRunIds(runIds) : Promise.resolve([] as Array<{ runId: string | null }>),
  ]);
  for (const r of extraRuns) runsById.set(r.id, r);
  const bookedRunIds = new Set(booked.map((b) => b.runId).filter((id): id is string => !!id));
  const items = mergeDeviceItems(kind, bookings, runs, runsById, bookedRunIds, now);
  return { items: items.slice(0, MAX_DEVICE_ITEMS), truncated: truncated || items.length > MAX_DEVICE_ITEMS };
}

/** The calendar over [from, to] (local days, inclusive), for the kinds asked for. */
export async function listCalendar(input: { from: string; to: string; kinds: ReadonlySet<CalendarKind>; now?: Date }): Promise<CalendarResult> {
  const { start, end } = calendarRange(input.from, input.to);
  const now = input.now ?? new Date();
  const [maint, reboot, firmware] = await Promise.all([
    input.kinds.has("maintenance") ? listOccurrences({ from: input.from, to: input.to }) : Promise.resolve(null),
    input.kinds.has("reboot") ? rebootItems(start, end, now) : Promise.resolve(null),
    input.kinds.has("firmware") ? firmwareItems(start, end, now) : Promise.resolve(null),
  ]);
  return {
    from: input.from,
    to: input.to,
    maintenance: maint ? maint.occurrences : null,
    reboot: reboot ? reboot.items : null,
    firmware: firmware ? firmware.items : null,
    truncated: !!(maint?.truncated || reboot?.truncated || firmware?.truncated),
  };
}
