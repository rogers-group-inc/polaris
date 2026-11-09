/**
 * src/services/duplicateReservationConflictService.ts — business rule 139:
 * an asset holding two or more DHCP bindings, at least one a reservation, is a
 * conflict.
 *
 * A DHCP reservation is a person's statement that THIS device gets THIS
 * address. Two of them on one device is almost never what anyone meant: the
 * device was re-addressed and the old entry was left on the gate, or it moved
 * sites and the reservation at the old site still holds an address nobody can
 * use. Polaris used to let both stand, and the asset stayed linked to both — so
 * releasing one left the device still answering to the other.
 *
 * What counts:
 *   - an ACTIVE row that is a binding on a gate: a reservation — `sourceType`
 *     `dhcp_reservation` (learned from the gate), or a Polaris row the gate
 *     confirmed (`pushStatus` `synced`) — or a held lease (`dhcp_lease`);
 *   - a group needs two or more bindings AND at least one reservation: two
 *     leases on one device (a wired and a Wi-Fi card) are DHCP working;
 *   - matched to an asset through its MAC list (`AssetMacAddress`, single-MAC
 *     rows; the all-zero MAC is never anyone's — rule 97);
 *   - on an asset that is not decommissioned / disabled and not Fortinet infra
 *     (their reservations are the controller's, rules 23 / 45).
 * Every MAC of the asset counts, so a wired and a Wi-Fi reservation on one
 * laptop are two — Reject says "that is deliberate" and keeps the pair quiet.
 *
 * One pending Conflict per asset (`entityType` asset, `collisionReason`
 * `duplicate-reservation`), refreshed while the set holds, closed by the sweep
 * when the asset is down to one, and never re-raised for a set the operator
 * dismissed (keyed on the reservation ids). Two resolutions, both through
 * `releaseReservation` (off the gate when DHCP writeback is on — a lease is
 * revoked — and, through rule 102(b), off the asset): `keepOneReservation`
 * releases every other binding in the set; `releaseOneReservation` releases
 * one and resolves the conflict once what is left no longer qualifies.
 *
 * The gate of each binding is resolved to its firewall asset at sweep time
 * (`utils/fortinetParentKey.ts` — `Subnet.fortigateDevice` is FortiManager's
 * device name, never matched against a hostname) so the card can link it.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { chunkArray } from "../utils/chunk.js";
import { isAllZeroMac, normalizeMacOrNull } from "../utils/mac.js";
import { buildInfraParentIndex, parentAssetWhereOr, resolveInfraParentAsset } from "../utils/fortinetParentKey.js";
import { logEvent } from "./eventLogService.js";
import { releaseReservation } from "./reservationService.js";
import { jsonEqual } from "../utils/jsonEqual.js";

export const DUPLICATE_RESERVATION_COLLISION_REASON = "duplicate-reservation";

const DUPLICATE_RESERVATION_CONFLICT_WHERE = {
  entityType: "asset",
  proposedAssetFields: { path: ["collisionReason"], equals: DUPLICATE_RESERVATION_COLLISION_REASON },
} as const;

const EXCLUDED_STATUSES = ["decommissioned", "disabled"];
const INFRA_ASSET_TYPES = new Set(["firewall", "switch", "access_point"]);

/** One binding in a group, as stored on the conflict. */
export interface HeldReservation {
  reservationId: string;
  /** A reservation (configured MAC-to-IP) or a held lease. */
  kind: "reservation" | "lease";
  ipAddress: string | null;
  macAddress: string;
  hostname: string | null;
  sourceType: string;
  pushStatus: string | null;
  subnetId: string;
  subnetCidr: string;
  subnetName: string | null;
  gate: string | null;
  /** The gate's firewall asset, when it resolves (utils/fortinetParentKey). */
  gateAssetId: string | null;
  createdAt: string;
  createdBy: string | null;
  /** The asset's primary address is this reservation's address. */
  isPrimary: boolean;
}

export interface DuplicateReservationGroup {
  assetId: string;
  hostname: string | null;
  assetIpAddress: string | null;
  reservations: HeldReservation[];
}

export interface ReservationRow {
  id: string;
  ipAddress: string | null;
  macAddress: string | null;
  hostname: string | null;
  sourceType: string;
  pushStatus: string | null;
  createdAt: Date;
  createdBy: string | null;
  subnet: { id: string; cidr: string; name: string | null; fortigateDevice: string | null };
}

export interface MacOwnerRow {
  mac: string;
  asset: { id: string; hostname: string | null; ipAddress: string | null; assetType: string; status: string };
}

/** A reservation that is a MAC-to-IP entry on a gate. */
export function isDhcpReservation(r: Pick<ReservationRow, "sourceType" | "pushStatus">): boolean {
  return r.sourceType === "dhcp_reservation" || r.pushStatus === "synced";
}

/** A binding on a gate: a reservation, or a held lease. */
export function isDhcpBinding(r: Pick<ReservationRow, "sourceType" | "pushStatus">): boolean {
  return isDhcpReservation(r) || r.sourceType === "dhcp_lease";
}

/** Whether a set of bindings is still a conflict: two or more, one a reservation. */
export function bindingsConflict(rows: ReadonlyArray<{ kind: HeldReservation["kind"] }>): boolean {
  return rows.length >= 2 && rows.some((r) => r.kind === "reservation");
}

/**
 * Group the gate bindings by the asset their MAC belongs to and keep the
 * assets whose set conflicts (`bindingsConflict`). Pure. Ordered by address so
 * a refresh writes the same blob for the same set. `gateAssetIds` maps a
 * gate's device name to its firewall asset (absent = unresolved).
 */
export function groupDuplicateReservations(
  reservations: readonly ReservationRow[],
  owners: readonly MacOwnerRow[],
  gateAssetIds: ReadonlyMap<string, string> = new Map(),
): DuplicateReservationGroup[] {
  const ownersByMac = new Map<string, MacOwnerRow["asset"][]>();
  for (const o of owners) {
    const mac = normalizeMacOrNull(o.mac);
    if (!mac) continue;
    if (EXCLUDED_STATUSES.includes(o.asset.status) || INFRA_ASSET_TYPES.has(o.asset.assetType)) continue;
    const list = ownersByMac.get(mac) ?? [];
    if (!list.some((a) => a.id === o.asset.id)) list.push(o.asset);
    ownersByMac.set(mac, list);
  }

  const byAsset = new Map<string, { asset: MacOwnerRow["asset"]; rows: Array<{ r: ReservationRow; mac: string }> }>();
  for (const r of reservations) {
    if (!isDhcpBinding(r)) continue;
    const mac = normalizeMacOrNull(r.macAddress);
    if (!mac || isAllZeroMac(mac)) continue;
    // A MAC two assets both list says nothing about which one holds the
    // reservation — that is a duplicate-record problem, not this one.
    const holders = ownersByMac.get(mac);
    if (!holders || holders.length !== 1) continue;
    const asset = holders[0];
    const entry = byAsset.get(asset.id) ?? { asset, rows: [] };
    entry.rows.push({ r, mac });
    byAsset.set(asset.id, entry);
  }

  const groups: DuplicateReservationGroup[] = [];
  for (const { asset, rows } of byAsset.values()) {
    const held = rows
      .map(({ r, mac }): HeldReservation => ({
        reservationId: r.id,
        kind: isDhcpReservation(r) ? "reservation" : "lease",
        ipAddress: r.ipAddress,
        macAddress: mac,
        hostname: r.hostname,
        sourceType: r.sourceType,
        pushStatus: r.pushStatus,
        subnetId: r.subnet.id,
        subnetCidr: r.subnet.cidr,
        subnetName: r.subnet.name,
        gate: r.subnet.fortigateDevice,
        gateAssetId: (r.subnet.fortigateDevice && gateAssetIds.get(r.subnet.fortigateDevice)) || null,
        createdAt: r.createdAt.toISOString(),
        createdBy: r.createdBy,
        isPrimary: !!r.ipAddress && r.ipAddress === asset.ipAddress,
      }))
      .sort((a, b) => (a.ipAddress ?? "").localeCompare(b.ipAddress ?? "") || a.reservationId.localeCompare(b.reservationId));
    if (!bindingsConflict(held)) continue;
    groups.push({ assetId: asset.id, hostname: asset.hostname, assetIpAddress: asset.ipAddress, reservations: held });
  }
  return groups.sort((a, b) => a.assetId.localeCompare(b.assetId));
}

/** The dedup key of a set: its reservation ids, order-free. */
export function reservationSetKey(reservations: ReadonlyArray<{ reservationId: string }>): string {
  return reservations.map((r) => r.reservationId).sort().join(",");
}

function conflictReservationsOf(conflict: { proposedAssetFields: unknown }): HeldReservation[] {
  const p = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
  return Array.isArray(p.reservations) ? (p.reservations as HeldReservation[]) : [];
}

async function loadGroups(): Promise<DuplicateReservationGroup[]> {
  const reservations = await prisma.reservation.findMany({
    where: {
      status: "active",
      macAddress: { not: null },
      OR: [{ sourceType: "dhcp_reservation" }, { sourceType: "dhcp_lease" }, { pushStatus: "synced" }],
    },
    select: {
      id: true, ipAddress: true, macAddress: true, hostname: true, sourceType: true, pushStatus: true,
      createdAt: true, createdBy: true,
      subnet: { select: { id: true, cidr: true, name: true, fortigateDevice: true } },
    },
  });
  const macs = [...new Set(reservations.map((r) => normalizeMacOrNull(r.macAddress)).filter((m): m is string => !!m))];
  if (macs.length === 0) return [];
  // A large install reserves thousands of MACs; chunk the IN list.
  const owners: MacOwnerRow[] = [];
  for (const chunk of chunkArray(macs, 1000)) {
    owners.push(...(await prisma.assetMacAddress.findMany({
      where: { mac: { in: chunk }, macEnd: null },
      select: {
        mac: true,
        asset: { select: { id: true, hostname: true, ipAddress: true, assetType: true, status: true } },
      },
    })) as MacOwnerRow[]);
  }
  return withGateAssets(groupDuplicateReservations(reservations as ReservationRow[], owners));
}

/**
 * Resolve each grouped binding's gate to its firewall asset — one candidate
 * query for the distinct gate names, through the shared parent-key resolver
 * (the VIP rows' pattern), never a hostname match.
 */
async function withGateAssets(groups: DuplicateReservationGroup[]): Promise<DuplicateReservationGroup[]> {
  const names = [...new Set(groups.flatMap((g) => g.reservations.map((r) => r.gate)).filter((n): n is string => !!n))];
  if (names.length === 0) return groups;
  const branches: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const or = parentAssetWhereOr({ name });
    if (or.length > 0) branches.push({ assetType: "firewall", OR: or });
  }
  const candidates = branches.length
    ? await prisma.asset.findMany({
        where: { OR: branches },
        select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
      })
    : [];
  const index = buildInfraParentIndex(candidates);
  const byName = new Map<string, string>();
  for (const name of names) {
    const hit = resolveInfraParentAsset(index, { name }, "firewall");
    if (hit) byName.set(name, hit.id);
  }
  for (const g of groups) for (const r of g.reservations) r.gateAssetId = (r.gate && byName.get(r.gate)) || null;
  return groups;
}

export interface DuplicateReservationReconcileResult {
  groups: number;
  raised: number;
  refreshed: number;
  closed: number;
  suppressed: number;
}

/**
 * Raise, refresh and close the `duplicate-reservation` conflicts to match the
 * fleet. Two queries for the scan; writes only on change.
 */
export async function reconcileDuplicateReservationConflicts(): Promise<DuplicateReservationReconcileResult> {
  const result: DuplicateReservationReconcileResult = { groups: 0, raised: 0, refreshed: 0, closed: 0, suppressed: 0 };
  const groups = await loadGroups();
  result.groups = groups.length;

  const pending = await prisma.conflict.findMany({
    where: { ...DUPLICATE_RESERVATION_CONFLICT_WHERE, status: "pending" },
    orderBy: { createdAt: "asc" },
    select: { id: true, assetId: true, proposedAssetFields: true },
  });
  // One pending row per asset; the oldest wins and any extra is closed.
  const pendingByAsset = new Map<string, (typeof pending)[number]>();
  const stranded: string[] = [];
  for (const row of pending) {
    if (!row.assetId || pendingByAsset.has(row.assetId)) stranded.push(row.id);
    else pendingByAsset.set(row.assetId, row);
  }
  if (stranded.length) {
    const closed = await prisma.conflict.updateMany({
      where: { id: { in: stranded }, status: "pending" },
      data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: new Date() },
    });
    result.closed += closed.count;
  }

  const resolved = groups.length
    ? await prisma.conflict.findMany({
        where: {
          ...DUPLICATE_RESERVATION_CONFLICT_WHERE,
          status: "rejected",
          assetId: { in: groups.map((g) => g.assetId) },
          NOT: { resolvedBy: "system:auto-resolved" },
        },
        select: { assetId: true, proposedAssetFields: true },
      })
    : [];
  const dismissedKeys = new Set(resolved.map((r) => `${r.assetId}|${reservationSetKey(conflictReservationsOf(r))}`));

  for (const group of groups) {
    const proposedAssetFields = {
      collisionReason: DUPLICATE_RESERVATION_COLLISION_REASON,
      // Conflict-queue widget subtitle reads `hostname`.
      hostname: group.hostname,
      assetIpAddress: group.assetIpAddress,
      reservations: group.reservations,
    } as any;
    const open = pendingByAsset.get(group.assetId);
    if (open) {
      if (reservationSetKey(conflictReservationsOf(open)) !== reservationSetKey(group.reservations) ||
          !jsonEqual(open.proposedAssetFields, proposedAssetFields)) {
        await prisma.conflict.update({ where: { id: open.id }, data: { proposedAssetFields } });
        result.refreshed++;
      }
      continue;
    }
    if (dismissedKeys.has(`${group.assetId}|${reservationSetKey(group.reservations)}`)) {
      result.suppressed++;
      continue;
    }
    await prisma.conflict.create({
      data: {
        entityType: "asset",
        assetId: group.assetId,
        conflictFields: ["reservations"],
        proposedAssetFields,
        existingAssetSnapshot: { hostname: group.hostname, ipAddress: group.assetIpAddress } as any,
      },
    });
    result.raised++;
    const name = group.hostname || group.assetIpAddress || group.assetId;
    logEvent({
      action: "conflict.detected",
      resourceType: "asset",
      resourceId: group.assetId,
      resourceName: name,
      actor: "system",
      message: `"${name}" holds ${group.reservations.length} DHCP bindings: ` +
        group.reservations.map((r) => `${r.ipAddress ?? "?"} (${r.kind})${r.gate ? ` on ${r.gate}` : ""}`).join(", "),
      details: {
        collisionReason: DUPLICATE_RESERVATION_COLLISION_REASON,
        reservationIds: group.reservations.map((r) => r.reservationId),
      },
    });
  }

  const live = new Set(groups.map((g) => g.assetId));
  for (const [assetId, row] of pendingByAsset) {
    if (live.has(assetId)) continue;
    await prisma.conflict.update({
      where: { id: row.id },
      data: { status: "rejected", resolvedBy: "system:auto-resolved", resolvedAt: new Date() },
    });
    result.closed++;
    logEvent({
      action: "conflict.rejected",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: ((row.proposedAssetFields || {}) as Record<string, unknown>).hostname as string || assetId,
      actor: "system",
      message: "Duplicate DHCP reservation conflict auto-resolved — the asset no longer holds two DHCP bindings with a reservation among them",
      details: { collisionReason: DUPLICATE_RESERVATION_COLLISION_REASON },
    });
  }
  return result;
}

// ─── Resolution: keep one, release the rest ─────────────────────────────────

export interface KeepReservationOutcome {
  kept: string;
  released: string[];
  failed: Array<{ reservationId: string; error: string }>;
}

/**
 * Keep `keepReservationId` and release every other reservation in the
 * conflict's set that is still active. `mayRelease` is the route's ownership
 * check, run on every row before anything is released so a refusal releases
 * nothing. The conflict is accepted once every release succeeded; a partial
 * failure leaves it pending for the sweep to refresh.
 */
export async function keepOneReservation(
  conflict: { id: string; assetId: string | null; proposedAssetFields: unknown },
  keepReservationId: string,
  actor: string | undefined,
  mayRelease: (row: { createdBy: string | null }) => void,
): Promise<KeepReservationOutcome> {
  const stored = conflictReservationsOf(conflict);
  if (!stored.some((r) => r.reservationId === keepReservationId)) {
    throw new AppError(400, "That reservation is not one of this conflict's reservations");
  }
  const others = await prisma.reservation.findMany({
    where: {
      id: { in: stored.map((r) => r.reservationId).filter((id) => id !== keepReservationId) },
      status: "active",
    },
    select: { id: true, createdBy: true, ipAddress: true },
  });
  for (const row of others) mayRelease(row);

  const outcome: KeepReservationOutcome = { kept: keepReservationId, released: [], failed: [] };
  for (const row of others) {
    try {
      await releaseReservation(row.id, actor);
      outcome.released.push(row.id);
    } catch (err) {
      outcome.failed.push({ reservationId: row.id, error: (err as Error)?.message || String(err) });
    }
  }

  const kept = stored.find((r) => r.reservationId === keepReservationId)!;
  const name = ((conflict.proposedAssetFields || {}) as Record<string, unknown>).hostname as string || conflict.assetId || conflict.id;
  if (outcome.failed.length === 0) {
    await prisma.conflict.update({
      where: { id: conflict.id },
      data: { status: "accepted", resolvedBy: actor ?? "unknown", resolvedAt: new Date() },
    });
  }
  logEvent({
    action: outcome.failed.length === 0 ? "conflict.accepted" : "conflict.resolve_failed",
    level: outcome.failed.length === 0 ? "info" : "warning",
    resourceType: "asset",
    resourceId: conflict.assetId ?? undefined,
    resourceName: name,
    actor,
    message: `Duplicate DHCP bindings on "${name}": kept the ${kept.kind ?? "reservation"} ${kept.ipAddress ?? keepReservationId}` +
      (kept.gate ? ` on ${kept.gate}` : "") +
      `, released ${outcome.released.length}` +
      (outcome.failed.length ? `, ${outcome.failed.length} failed — the conflict stays open` : ""),
    details: { collisionReason: DUPLICATE_RESERVATION_COLLISION_REASON, ...outcome },
  });
  return outcome;
}

export interface ReleaseOneOutcome {
  released: string;
  resolved: boolean;
  remaining: number;
}

/**
 * Release ONE binding of the set (a reservation, or a lease — revoked on the
 * gate when DHCP writeback is on). `mayRelease` is the route's ownership check.
 * The conflict is accepted when what is still active no longer conflicts
 * (`bindingsConflict`); otherwise it stays pending with the released row
 * dropped from its set.
 */
export async function releaseOneReservation(
  conflict: { id: string; assetId: string | null; proposedAssetFields: unknown },
  reservationId: string,
  actor: string | undefined,
  mayRelease: (row: { createdBy: string | null }) => void,
): Promise<ReleaseOneOutcome> {
  const stored = conflictReservationsOf(conflict);
  const target = stored.find((r) => r.reservationId === reservationId);
  if (!target) throw new AppError(400, "That reservation is not one of this conflict's reservations");
  const row = await prisma.reservation.findUnique({ where: { id: reservationId }, select: { status: true, createdBy: true } });
  if (!row || row.status !== "active") throw new AppError(409, "That reservation is no longer active");
  mayRelease(row);
  await releaseReservation(reservationId, actor);

  const stillActive = new Set((await prisma.reservation.findMany({
    where: { id: { in: stored.map((r) => r.reservationId) }, status: "active" },
    select: { id: true },
  })).map((r) => r.id));
  const remaining = stored.filter((r) => stillActive.has(r.reservationId));
  const resolved = !bindingsConflict(remaining.map((r) => ({ kind: r.kind ?? "reservation" })));
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
  await prisma.conflict.update({
    where: { id: conflict.id },
    data: resolved
      ? { status: "accepted", resolvedBy: actor ?? "unknown", resolvedAt: new Date() }
      : { proposedAssetFields: { ...proposed, reservations: remaining } as any },
  });
  const name = (proposed.hostname as string) || conflict.assetId || conflict.id;
  logEvent({
    action: resolved ? "conflict.accepted" : "conflict.updated",
    resourceType: "asset",
    resourceId: conflict.assetId ?? undefined,
    resourceName: name,
    actor,
    message: `Duplicate DHCP bindings on "${name}": ${target.kind === "lease" ? "revoked the lease" : "released the reservation"} ${target.ipAddress ?? reservationId}` +
      (target.gate ? ` on ${target.gate}` : "") +
      (resolved ? " — resolved" : ` — ${remaining.length} still held`),
    details: { collisionReason: DUPLICATE_RESERVATION_COLLISION_REASON, reservationId, kind: target.kind ?? "reservation", resolved },
  });
  return { released: reservationId, resolved, remaining: remaining.length };
}

function duplicateReservationRejectMessage(conflict: { proposedAssetFields: unknown }): string {
  const n = conflictReservationsOf(conflict).length;
  return `Duplicate DHCP reservation conflict dismissed — the asset keeps all ${n} bindings; the same set will not re-raise`;
}

export function logDuplicateReservationDismissal(
  conflict: { assetId: string | null; proposedAssetFields: unknown },
  actor?: string,
): void {
  const name = ((conflict.proposedAssetFields || {}) as Record<string, unknown>).hostname as string || conflict.assetId || "";
  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: conflict.assetId ?? undefined,
    resourceName: name,
    actor,
    message: `${duplicateReservationRejectMessage(conflict)} ("${name}")`,
    details: { collisionReason: DUPLICATE_RESERVATION_COLLISION_REASON },
  });
}

export function logScanFailure(err: unknown): void {
  logger.error({ err }, "duplicate-reservation conflict reconcile failed");
}
