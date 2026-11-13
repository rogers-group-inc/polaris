/**
 * src/services/reservationStaleService.ts — Stale DHCP-reservation detection.
 *
 * The DHCP discovery sync stamps `Reservation.lastSeenLeased` whenever
 * /api/v2/monitor/system/dhcp confirms an IP is being actively held by a
 * client. The job below reads those timestamps and flags rows whose target
 * has either never been seen online or hasn't been seen in too long. Each
 * transition into "stale" emits one `reservation.stale` Event and stamps
 * `staleNotifiedAt` so the alert doesn't refire daily.
 *
 * The discovery sync clears `staleNotifiedAt` whenever it sees the IP active
 * again, so a reservation that comes back online and then goes silent
 * later will re-arm the alert cleanly.
 *
 * The DHCP lease is not the only presence signal Polaris holds. A device that
 * is *statically* configured with an IP that also has a DHCP reservation never
 * pulls a lease, so `lastSeenLeased` stays null forever — yet the device is
 * online and discovered as an Asset (via FortiGate device inventory / ARP /
 * monitor probe). To avoid flagging those as stale, detection also folds in
 * `Asset.lastSeen` (the no-regress verified-presence timestamp from
 * `bumpLastSeen`) for any Asset that correlates to the reservation by MAC
 * (authoritative — DHCP reservations are MAC→IP) or, failing that, by IP.
 *
 * A third signal, `lastSeenArp`, is stamped by the discovery sync (Phase 7.6
 * in integrations.ts) when the owning FortiGate's ARP table binds the
 * reservation's IP to its reserved MAC — minutes-fresh L2 proof of life that
 * needs no lease, no asset record, and no ICMP reply. The opt-in per-
 * integration `arpPresenceSweep` toggle actively primes the gate's ARP cache
 * (fire-and-forget UDP at each reserved IP, see arpPrimeService.ts) right
 * before the table read so even quiet devices resolve.
 *
 * The effective "last signal" is the freshest of the lease, the ARP
 * confirmation, and the matched asset; a device that is genuinely gone has
 * none of the three fresh, so it still flags correctly.
 *
 * Threshold is admin-tunable via the `reservationStale` Setting
 * (`staleAfterDays`, default 60, 0 = disabled). The grace baseline below
 * absorbs the cold-start case: after the migration deploys, no rows have
 * `lastSeenLeased` populated yet, so we use `max(createdAt, detectionStartedAt)`
 * to avoid flooding the alert list with every existing dhcp_reservation row
 * before discovery has had a chance to populate the column.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { normalizeMacOrNull } from "../utils/mac.js";

const SETTINGS_KEY = "reservationStale";
const DETECTION_STARTED_AT_KEY = "reservationStaleDetectionStartedAt";

// Defaults: 60 days threshold, alerts disabled until the operator opts in.
// 0 = disabled (no alerts emitted, no rows considered stale).
const DEFAULT_STALE_AFTER_DAYS = 60;

export interface ReservationStaleSettings {
  staleAfterDays: number;
}

export async function getStaleSettings(): Promise<ReservationStaleSettings> {
  const row = await prisma.setting.findUnique({ where: { key: SETTINGS_KEY } });
  if (!row) return { staleAfterDays: DEFAULT_STALE_AFTER_DAYS };
  const val = row.value as Record<string, unknown>;
  const days = Number(val.staleAfterDays);
  return {
    staleAfterDays: Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_STALE_AFTER_DAYS,
  };
}

export async function updateStaleSettings(
  settings: Partial<ReservationStaleSettings>,
  actor?: string,
): Promise<ReservationStaleSettings> {
  const days = Number(settings.staleAfterDays);
  const merged: ReservationStaleSettings = {
    staleAfterDays: Number.isFinite(days) && days >= 0 ? Math.floor(days) : DEFAULT_STALE_AFTER_DAYS,
  };
  await prisma.setting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: merged as any },
    update: { value: merged as any },
  });
  void logEvent({
    action: "reservation.stale-settings.updated",
    resourceType: "setting",
    actor,
    message: `Reservation stale-detection threshold set to ${merged.staleAfterDays} day(s)${merged.staleAfterDays === 0 ? " — alerts disabled" : ""}`,
    details: { staleAfterDays: merged.staleAfterDays },
  });
  invalidateStaleReservationCount();
  return merged;
}

/**
 * Returns the cold-start detection baseline. On first call after migration,
 * stamps "now" so subsequent calls return the same timestamp — gives every
 * existing dhcp_reservation row a fresh `staleAfterDays` window before the
 * job can flag it, even if its createdAt predates the migration.
 */
async function getDetectionStartedAt(): Promise<Date> {
  const row = await prisma.setting.findUnique({ where: { key: DETECTION_STARTED_AT_KEY } });
  if (row) {
    const ts = (row.value as { startedAt?: string }).startedAt;
    if (ts) {
      const d = new Date(ts);
      if (!isNaN(d.getTime())) return d;
    }
  }
  const now = new Date();
  await prisma.setting.upsert({
    where: { key: DETECTION_STARTED_AT_KEY },
    create: { key: DETECTION_STARTED_AT_KEY, value: { startedAt: now.toISOString() } as any },
    update: { value: { startedAt: now.toISOString() } as any },
  });
  return now;
}

export interface ReservationAlertEntry {
  // Rule 141 (e): what the stale verbs are judged on (the route adds `canEdit`).
  createdBy: string | null;
  subnetTags: string[];
  id: string;
  ipAddress: string | null;
  hostname: string | null;
  macAddress: string | null;
  subnetId: string;
  subnetCidr: string;
  subnetName: string;
  createdAt: Date;
  lastSeenLeased: Date | null;
  // ARP presence evidence: last time discovery saw the FortiGate ARP table
  // bind this reservation's IP to its reserved MAC (Phase 7.6 stamp in
  // integrations.ts; the opt-in arpPresenceSweep toggle actively primes the
  // gate's cache first). Real presence evidence, same standing as the lease.
  lastSeenArp: Date | null;
  staleNotifiedAt: Date | null;
  daysSinceSeen: number; // since the freshest of {lease, ARP, matched asset} OR baseline
  fortigateDevice: string | null;
  pushedToId: string | null;
  pushedToName: string | null;
  // Cross-signal presence: the lastSeen of an Asset that correlates to this
  // reservation (by MAC first, then IP), and how it matched. Null when no
  // asset correlates. Lets the alert explain that a flagged row's device is
  // also absent from asset presence — and, more importantly, keeps a
  // statically-addressed-but-online device OUT of the stale list entirely.
  assetLastSeen: Date | null;
  assetPresenceMatch: AssetPresenceMatch;
}

type AssetPresenceMatch = "mac" | "ip" | null;

interface AssetPresence {
  lastSeen: Date | null;
  match: AssetPresenceMatch;
}

/**
 * Pick the freshest "last signal" for a reservation from the available
 * evidence. The lease timestamp, the ARP-confirmation timestamp, and the
 * matched-asset timestamp are all real evidence; the baseline is only a
 * fallback used when NO real evidence exists (cold-start grace — see module
 * header). Pure + exported for unit testing.
 *
 * Note the baseline is a fallback, not a floor: a reservation with a genuine
 * but old lease/ARP/asset signal uses that real timestamp even when it
 * predates the baseline, so a long-dead reservation still flags during the
 * cold-start window rather than being spared.
 */
export function effectiveLastSignalMs(opts: {
  lastSeenLeasedMs: number | null;
  lastSeenArpMs?: number | null;
  assetLastSeenMs: number | null;
  baselineMs: number;
}): { ms: number; evidence: "lease" | "arp" | "asset" | "baseline" } {
  let best: { ms: number; evidence: "lease" | "arp" | "asset" } | null = null;
  if (opts.lastSeenLeasedMs != null) best = { ms: opts.lastSeenLeasedMs, evidence: "lease" };
  if (opts.lastSeenArpMs != null && (best == null || opts.lastSeenArpMs > best.ms)) {
    best = { ms: opts.lastSeenArpMs, evidence: "arp" };
  }
  if (opts.assetLastSeenMs != null && (best == null || opts.assetLastSeenMs > best.ms)) {
    best = { ms: opts.assetLastSeenMs, evidence: "asset" };
  }
  return best ?? { ms: opts.baselineMs, evidence: "baseline" };
}

/**
 * Build an asset-presence resolver for a batch of reservation rows. Collects
 * the distinct MACs / IPs across the batch, runs three indexed batched queries
 * (primary Asset columns + the AssetMacAddress / AssetAssociatedIp side tables
 * so multi-interface / multi-IP devices still correlate), and returns a closure
 * that resolves each reservation to its freshest matching Asset.lastSeen.
 *
 * Scale: the three queries are bounded by the number of stale-candidate
 * reservations (itself bounded by total dhcp_reservation count — low thousands
 * at most), run in parallel, and hit the mac/ip indexes; the per-row resolver
 * is O(1) map lookups. Safe at both 100 and 2000+ assets.
 */
async function buildAssetPresenceResolver(
  rows: Array<{ macAddress: string | null; ipAddress: string | null }>,
): Promise<(r: { macAddress: string | null; ipAddress: string | null }) => AssetPresence> {
  const macs = new Set<string>();
  const ips = new Set<string>();
  for (const r of rows) {
    const m = normalizeMacOrNull(r.macAddress);
    if (m) macs.add(m);
    if (r.ipAddress) ips.add(r.ipAddress);
  }

  const byMac = new Map<string, number>();
  const byIp = new Map<string, number>();
  const bump = (map: Map<string, number>, key: string, d: Date | null | undefined) => {
    if (!d) return;
    const ms = d.getTime();
    const prev = map.get(key);
    if (prev === undefined || ms > prev) map.set(key, ms);
  };

  const macList = [...macs];
  const ipList = [...ips];
  if (macList.length === 0 && ipList.length === 0) {
    return () => ({ lastSeen: null, match: null });
  }

  const [assetsByPrimary, macRows, ipRows] = await Promise.all([
    prisma.asset.findMany({
      where: {
        OR: [
          ...(macList.length ? [{ macAddress: { in: macList } }] : []),
          ...(ipList.length ? [{ ipAddress: { in: ipList } }] : []),
        ],
      },
      select: { macAddress: true, ipAddress: true, lastSeen: true },
    }),
    macList.length
      ? prisma.assetMacAddress.findMany({
          where: {
            OR: [
              { mac: { in: macList } },
              // Interface-fold RANGE rows (macEnd set): prefilter to ranges
              // overlapping the batch's [min, max] MAC interval (canonical
              // colon-upper, so lexicographic == numeric); exact per-MAC
              // containment is resolved in the loop below.
              {
                AND: [
                  { macEnd: { not: null } },
                  { mac: { lte: macList.reduce((a, b) => (a > b ? a : b)) } },
                  { macEnd: { gte: macList.reduce((a, b) => (a < b ? a : b)) } },
                ],
              },
            ],
          },
          select: { mac: true, macEnd: true, asset: { select: { lastSeen: true } } },
        })
      : Promise.resolve([] as Array<{ mac: string; macEnd: string | null; asset: { lastSeen: Date | null } }>),
    ipList.length
      ? prisma.assetAssociatedIp.findMany({
          where: { ip: { in: ipList } },
          select: { ip: true, asset: { select: { lastSeen: true } } },
        })
      : Promise.resolve([] as Array<{ ip: string; asset: { lastSeen: Date | null } }>),
  ]);

  for (const a of assetsByPrimary) {
    const m = normalizeMacOrNull(a.macAddress);
    if (m && macs.has(m)) bump(byMac, m, a.lastSeen);
    if (a.ipAddress && ips.has(a.ipAddress)) bump(byIp, a.ipAddress, a.lastSeen);
  }
  for (const row of macRows) {
    if (row.macEnd) {
      // Range row: bump every batch MAC the range contains. Bounded by
      // (overlapping range rows × batch size), both small.
      for (const m of macList) {
        if (m >= row.mac && m <= row.macEnd) bump(byMac, m, row.asset?.lastSeen);
      }
      continue;
    }
    const m = normalizeMacOrNull(row.mac);
    if (m) bump(byMac, m, row.asset?.lastSeen);
  }
  for (const row of ipRows) {
    bump(byIp, row.ip, row.asset?.lastSeen);
  }

  return (r) => {
    const m = normalizeMacOrNull(r.macAddress);
    if (m && byMac.has(m)) return { lastSeen: new Date(byMac.get(m)!), match: "mac" };
    if (r.ipAddress && byIp.has(r.ipAddress)) return { lastSeen: new Date(byIp.get(r.ipAddress)!), match: "ip" };
    return { lastSeen: null, match: null };
  };
}

export interface SnoozeReservationResult {
  reservationId: string;
  snoozedUntil: Date;
  daysAdded: number;
}

/**
 * Push a stale-reservation alert out by `staleAfterDays` more days. Sets
 * `staleSnoozedUntil = now + staleAfterDays`. While that future, the row is
 * suppressed from listStaleReservations and the job won't re-fire. Discovery
 * clears the field if the IP comes back online before the snooze expires.
 *
 * Throws if the reservation is not an active dhcp_reservation row, or if
 * stale-detection is disabled (staleAfterDays === 0). Idempotent: snoozing
 * an already-snoozed row extends from "now" rather than from the current
 * snoozedUntil, so repeated clicks always give exactly one full window.
 */
export async function snoozeReservation(reservationId: string, actor?: string): Promise<SnoozeReservationResult> {
  const settings = await getStaleSettings();
  if (settings.staleAfterDays === 0) {
    throw new AppError(409, "Stale-reservation detection is disabled — set a non-zero threshold before snoozing alerts");
  }
  const row = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, status: true, sourceType: true },
  });
  if (!row) throw new AppError(404, `Reservation ${reservationId} not found`);
  if (row.status !== "active" || row.sourceType !== "dhcp_reservation") {
    throw new AppError(409, `Cannot snooze — reservation must be active and dhcp_reservation (status=${row.status}, sourceType=${row.sourceType})`);
  }

  const snoozedUntil = new Date(Date.now() + settings.staleAfterDays * 24 * 60 * 60 * 1000);
  await prisma.reservation.update({
    where: { id: reservationId },
    data: { staleSnoozedUntil: snoozedUntil, staleNotifiedAt: null },
  });
  void logEvent({
    action: "reservation.stale.snoozed",
    resourceType: "reservation",
    resourceId: reservationId,
    actor,
    message: `Stale-reservation alert snoozed for ${settings.staleAfterDays} day(s); next alert eligibility ${snoozedUntil.toISOString()}`,
    details: { snoozedUntil: snoozedUntil.toISOString(), daysAdded: settings.staleAfterDays },
  });
  invalidateStaleReservationCount();
  return { reservationId, snoozedUntil, daysAdded: settings.staleAfterDays };
}

/**
 * List all currently-stale reservations. A row is stale when the threshold
 * is non-zero AND its freshest presence signal is older than the threshold.
 * The freshest signal is the most recent of (a) `lastSeenLeased` (the DHCP
 * lease), (b) `lastSeenArp` (FortiGate ARP table binding the reserved IP to
 * the reserved MAC), and (c) the lastSeen of an Asset that correlates to the
 * reservation by MAC or IP (so a statically-addressed device that never
 * leases but is up still clears). When none exists, the effective baseline
 * `max(createdAt, detectionStartedAt)` is used so the cold-start grace window
 * doesn't flood the alert list before discovery has populated either signal.
 *
 * Reservations on DEPRECATED subnets are excluded from the active list (and
 * therefore the badge count): a deprecated subnet means its owning FortiGate
 * was decommissioned, so the whole network is gone and per-IP stale alerts are
 * noise rather than actionable signal.
 *
 * `mode` controls which rows are returned:
 *   "active"  — non-ignored stale rows on non-deprecated subnets (default; what
 *               the badge counts)
 *   "ignored" — rows the operator has set staleIgnored=true on, regardless
 *               of whether they're still stale by the threshold rule
 */
/** Shape of a reservation row as loaded by listStaleReservations' includes. */
interface StaleCandidateRow {
  id: string;
  ipAddress: string | null;
  hostname: string | null;
  macAddress: string | null;
  subnetId: string;
  createdBy: string | null;
  createdAt: Date;
  lastSeenLeased: Date | null;
  lastSeenArp: Date | null;
  staleNotifiedAt: Date | null;
  pushedToId: string | null;
  subnet: { cidr: string; name: string; fortigateDevice: string | null; tags?: string[] };
  pushedTo: { name: string } | null;
}

/** The one row→entry mapping both listStaleReservations modes share. */
function toAlertEntry(
  r: StaleCandidateRow,
  presence: { lastSeen: Date | null; match: AssetPresenceMatch },
  daysSinceSeen: number,
): ReservationAlertEntry {
  return {
    id: r.id,
    ipAddress: r.ipAddress,
    hostname: r.hostname,
    macAddress: r.macAddress,
    subnetId: r.subnetId,
    // Rule 141 (e): what the stale verbs are judged on.
    createdBy: r.createdBy ?? null,
    subnetTags: r.subnet.tags ?? [],
    subnetCidr: r.subnet.cidr,
    subnetName: r.subnet.name,
    createdAt: r.createdAt,
    lastSeenLeased: r.lastSeenLeased,
    lastSeenArp: r.lastSeenArp,
    staleNotifiedAt: r.staleNotifiedAt,
    daysSinceSeen,
    fortigateDevice: r.subnet.fortigateDevice,
    pushedToId: r.pushedToId,
    pushedToName: r.pushedTo?.name ?? null,
    assetLastSeen: presence.lastSeen,
    assetPresenceMatch: presence.match,
  };
}

export async function listStaleReservations(
  mode: "active" | "ignored" = "active",
): Promise<ReservationAlertEntry[]> {
  const settings = await getStaleSettings();
  if (mode === "active" && settings.staleAfterDays === 0) return [];

  if (mode === "ignored") {
    // Just return every ignored dhcp_reservation regardless of threshold,
    // so the operator can review what they've silenced.
    const rows = await prisma.reservation.findMany({
      where: { status: "active", sourceType: "dhcp_reservation", staleIgnored: true },
      include: {
        subnet: { select: { id: true, cidr: true, name: true, fortigateDevice: true, tags: true } },
        pushedTo: { select: { id: true, name: true } },
      },
      orderBy: [{ lastSeenLeased: "asc" }, { createdAt: "asc" }],
    });
    const resolvePresence = await buildAssetPresenceResolver(rows);
    const nowMs = Date.now();
    return rows.map((r) => {
      const presence = resolvePresence(r);
      const { ms: lastSignalMs } = effectiveLastSignalMs({
        lastSeenLeasedMs: r.lastSeenLeased?.getTime() ?? null,
        lastSeenArpMs: r.lastSeenArp?.getTime() ?? null,
        assetLastSeenMs: presence.lastSeen?.getTime() ?? null,
        baselineMs: r.createdAt.getTime(),
      });
      return toAlertEntry(r, presence, Math.floor((nowMs - lastSignalMs) / (24 * 60 * 60 * 1000)));
    });
  }

  const detectionStartedAt = await getDetectionStartedAt();
  const cutoffMs = Date.now() - settings.staleAfterDays * 24 * 60 * 60 * 1000;

  // Pull every non-ignored active dhcp_reservation in one go and filter in
  // memory. Volume is bounded by total reservation count — small (low
  // thousands at most) on real deployments.
  //
  // Skip reservations on DEPRECATED subnets: when a FortiGate drops out of the
  // FMG roster, discovery decommissions the firewall AND deprecates every
  // subnet it owned (Subnet.status="deprecated"; integrations.ts Phase 2).
  // Those subnets' devices stop being seen entirely (no lease, no asset
  // presence), so every reservation on them would otherwise flag stale —
  // flooding the operator with per-IP noise for a network they already
  // retired by one action. Excluding deprecated subnets matches the existing
  // convention (e.g. dns_resolved auto-reservations only target non-deprecated
  // subnets — Business Rule #11). If a subnet was deprecated in error,
  // rediscovery flips it back to "available" and alerting resumes.
  const rows = await prisma.reservation.findMany({
    where: {
      status: "active",
      sourceType: "dhcp_reservation",
      staleIgnored: false,
      subnet: { status: { not: "deprecated" } },
    },
    include: {
      subnet: { select: { id: true, cidr: true, name: true, fortigateDevice: true, tags: true } },
      pushedTo: { select: { id: true, name: true } },
    },
    orderBy: [{ lastSeenLeased: "asc" }, { createdAt: "asc" }],
  });

  const resolvePresence = await buildAssetPresenceResolver(rows);
  const result: ReservationAlertEntry[] = [];
  const nowMs = Date.now();
  for (const r of rows) {
    // Operator snooze: while the snooze is in the future, suppress the row.
    if (r.staleSnoozedUntil && r.staleSnoozedUntil.getTime() > nowMs) continue;

    const baseline = r.createdAt.getTime() > detectionStartedAt.getTime()
      ? r.createdAt.getTime()
      : detectionStartedAt.getTime();
    const presence = resolvePresence(r);
    const { ms: lastSignalMs } = effectiveLastSignalMs({
      lastSeenLeasedMs: r.lastSeenLeased?.getTime() ?? null,
      lastSeenArpMs: r.lastSeenArp?.getTime() ?? null,
      assetLastSeenMs: presence.lastSeen?.getTime() ?? null,
      baselineMs: baseline,
    });
    if (lastSignalMs > cutoffMs) continue;

    result.push(toAlertEntry(r, presence, Math.floor((nowMs - lastSignalMs) / (24 * 60 * 60 * 1000))));
  }
  return result;
}

// ─── Badge count ─────────────────────────────────────────────────────────────
//
// The sidebar badge, the Events page and the Stale Reservations widget each
// poll GET /reservations/alerts/count every 30 s from every open tab, and the
// count is the same for every caller (it is not write-scoped). One evaluation
// per STALE_COUNT_TTL_MS serves them all; concurrent callers share the one in
// flight. The operator's own changes (snooze, ignore, the threshold) drop the
// memo so the badge moves at once; discovery-driven changes show within the TTL.
const STALE_COUNT_TTL_MS = 30_000;
let staleCountMemo: { at: number; value: Promise<number> } | null = null;

export function countStaleReservations(): Promise<number> {
  const now = Date.now();
  if (staleCountMemo && now - staleCountMemo.at < STALE_COUNT_TTL_MS) return staleCountMemo.value;
  const value = listStaleReservations("active").then((rows) => rows.length);
  const memo = { at: now, value };
  staleCountMemo = memo;
  // A failure is not remembered: the next caller tries again.
  value.catch(() => { if (staleCountMemo === memo) staleCountMemo = null; });
  return value;
}

export function invalidateStaleReservationCount(): void {
  staleCountMemo = null;
}

export interface IgnoreReservationResult {
  reservationId: string;
  staleIgnored: boolean;
}

/**
 * Set or clear the staleIgnored flag on a dhcp_reservation. When true, the
 * row is suppressed from the active alert list and the job won't ever re-fire
 * on it — even if it later goes online and offline again. Cleared by an
 * explicit un-ignore (passing false), not by discovery activity.
 *
 * Reserved for admin / network-admin via the route guard; the service trusts
 * the caller and just mutates the row.
 */
export async function setStaleIgnored(
  reservationId: string,
  staleIgnored: boolean,
  actor?: string,
): Promise<IgnoreReservationResult> {
  const row = await prisma.reservation.findUnique({
    where: { id: reservationId },
    select: { id: true, status: true, sourceType: true },
  });
  if (!row) throw new AppError(404, `Reservation ${reservationId} not found`);
  if (row.status !== "active" || row.sourceType !== "dhcp_reservation") {
    throw new AppError(409, `Cannot ignore — reservation must be active and dhcp_reservation (status=${row.status}, sourceType=${row.sourceType})`);
  }
  await prisma.reservation.update({
    where: { id: reservationId },
    data: {
      staleIgnored,
      // Clearing the snooze + notified timestamps when ignoring keeps the
      // row state consistent (no point in tracking a snooze on an ignored
      // row); when un-ignoring, leave them alone so the next scan picks
      // up the row fresh.
      ...(staleIgnored ? { staleSnoozedUntil: null, staleNotifiedAt: null } : {}),
    },
  });
  void logEvent({
    action: staleIgnored ? "reservation.stale.ignored" : "reservation.stale.unignored",
    resourceType: "reservation",
    resourceId: reservationId,
    actor,
    message: staleIgnored
      ? `Stale-reservation alert permanently ignored — operator opted out of future notifications for this row`
      : `Stale-reservation alert un-ignored — row will alert again on the next stale crossing`,
  });
  invalidateStaleReservationCount();
  return { reservationId, staleIgnored };
}

/**
 * Job entry point. Scans for stale reservations, emits one
 * `reservation.stale` Event per row that hasn't already been notified, and
 * stamps `staleNotifiedAt` so the next run doesn't refire the same alert
 * unless the row's lastSeenLeased advances (sync clears staleNotifiedAt).
 */
export async function flagStaleReservations(): Promise<number> {
  const settings = await getStaleSettings();
  if (settings.staleAfterDays === 0) return 0;

  const stale = await listStaleReservations();
  const toNotify = stale.filter((row) => !row.staleNotifiedAt);
  if (toNotify.length === 0) return 0;
  const now = new Date();

  // Emit all events in parallel (allSettled — one failed event write must not
  // block the rest or the stamp), THEN stamp staleNotifiedAt in a single
  // updateMany. The prior per-row `await logEvent` + `await update` loop was
  // 2N sequential round-trips — a 6h scan on a large fleet can surface
  // hundreds of rows at once. Event-before-stamp keeps the original
  // at-least-once alerting bias: a crash between the two refires next run
  // rather than losing alerts.
  await Promise.allSettled(toNotify.map((row) => {
    const ipLabel = row.ipAddress ?? "(no IP)";
    const dayWord = (n: number) => `${n} day${n === 1 ? "" : "s"}`;
    const sinceLabel = row.lastSeenLeased
      ? `${dayWord(row.daysSinceSeen)} since last seen leased`
      : row.lastSeenArp
        ? `never seen leased — ${dayWord(row.daysSinceSeen)} since last ARP confirmation`
        : `never seen leased — ${dayWord(row.daysSinceSeen)} since detection baseline`;
    // When an asset correlates, the row is only here because that asset is ALSO
    // stale (a fresh asset would have excluded it). Say so — it tells the
    // operator the device is absent from every presence signal, not just DHCP.
    const assetLabel = row.assetPresenceMatch
      ? ` Matched asset (by ${row.assetPresenceMatch.toUpperCase()}) last seen ${row.assetLastSeen ? new Date(row.assetLastSeen).toISOString() : "never"}.`
      : "";
    return logEvent({
      action: "reservation.stale",
      level: "warning",
      resourceType: "reservation",
      resourceId: row.id,
      resourceName: row.hostname || ipLabel,
      message: `DHCP reservation ${ipLabel} on ${row.subnetCidr}${row.fortigateDevice ? ` (${row.fortigateDevice})` : ""} appears stale — ${sinceLabel}.${assetLabel}`,
      details: {
        subnetCidr: row.subnetCidr,
        subnetName: row.subnetName,
        ipAddress: row.ipAddress,
        macAddress: row.macAddress,
        hostname: row.hostname,
        fortigateDevice: row.fortigateDevice,
        pushedTo: row.pushedToName,
        lastSeenLeased: row.lastSeenLeased?.toISOString() ?? null,
        lastSeenArp: row.lastSeenArp?.toISOString() ?? null,
        assetLastSeen: row.assetLastSeen?.toISOString() ?? null,
        assetPresenceMatch: row.assetPresenceMatch,
        daysSinceSeen: row.daysSinceSeen,
        staleAfterDays: settings.staleAfterDays,
      },
    });
  }));

  await prisma.reservation.updateMany({
    where: { id: { in: toNotify.map((row) => row.id) } },
    data:  { staleNotifiedAt: now },
  });
  return toNotify.length;
}
