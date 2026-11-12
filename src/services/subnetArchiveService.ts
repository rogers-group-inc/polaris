/**
 * src/services/subnetArchiveService.ts — retiring a subnet without letting it
 * squat on its CIDR (business rule 41).
 *
 * WHY AN ARCHIVE AND NOT A STATUS
 * `Subnet.status = "deprecated"` marks a subnet retired but leaves the row in
 * place, and the row still holds `@@unique([blockId, cidr])`. So a replacement
 * FortiGate serving the same address space could not be recorded at all:
 * discovery's lookup index skips deprecated rows (no update path) while
 * `createSubnetRowChecked`'s committed-state overlap check counts them (no
 * create path), and every such subnet came back as
 * `Skipped subnet 10.x.0.0/24: Subnet 10.x.0.0/24 overlaps with existing
 * subnet 10.x.0.0/24` on every run — taking that subnet's leases, DHCP
 * reservations, VIPs and interface IPs down with it, since `findSubnetForIp`
 * skips deprecated rows too. Moving the row OUT is what frees the CIDR.
 *
 * It also makes the retired data LOCKED by construction rather than by
 * enforcement. An archived reservation is not in `reservations` at all, so none
 * of the ~50 reservation write sites can reach it — no guard to add in fifty
 * places, and no future writer to forget one. Compare `assertNotDeviceOwned`,
 * which has to sit at the route layer precisely because discovery still writes
 * the rows it protects.
 *
 * TWO ENTRY POINTS, AND THE DIFFERENCE MATTERS
 *   snapshotSubnet()  — copies the subnet + its reservations into the archive
 *                       and leaves the live rows ALONE. Additive. Used by the
 *                       chassis-replacement path, where the archive is the
 *                       evidence an operator resolves the conflict against and
 *                       nothing should be destroyed on the strength of an
 *                       automatic detection.
 *   archiveSubnet()   — snapshot, then DELETE the live subnet (its reservations
 *                       cascade). The operator's explicit "retire this" action,
 *                       and the thing that frees the CIDR.
 *
 * archiveSubnet deliberately does NOT enforce business rule 4's active-
 * reservation protection. That protection exists to stop an accidental
 * DESTRUCTION; archiving preserves everything it moves, which is the opposite.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { chunkArray } from "../utils/chunk.js";

/** Why a subnet was retired. Stored verbatim on `ArchivedSubnet.archiveReason`. */
export type ArchiveReason = "chassis-replaced" | "operator";

/** Rows-per-statement for the reservation copy. A /16 scope can hold a lot. */
const COPY_CHUNK = 500;

/**
 * Columns of a live Reservation the archive keeps. Push POINTERS
 * (pushedScopeId / pushedEntryId / pushedToId) are excluded on purpose — see
 * the comment on ArchivedReservation in schema.prisma.
 */
const RESERVATION_SELECT = {
  id: true,
  ipAddress: true,
  hostname: true,
  owner: true,
  projectRef: true,
  expiresAt: true,
  notes: true,
  status: true,
  sourceType: true,
  createdBy: true,
  macAddress: true,
  dhcpBinding: true,
  vipInfo: true,
  pushStatus: true,
  pushedAt: true,
  lastSeenLeased: true,
  lastSeenArp: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The client handed to an interactive `$transaction` callback. Derived from our
 * own extended `prisma` singleton, same reason as subnetService's TxClient.
 */
type PrismaLike = Omit<
  typeof prisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;

export interface SnapshotResult {
  archivedSubnetId: string;
  cidr: string;
  reservationCount: number;
}

/**
 * Copy one subnet + its reservations into the archive. Live rows untouched.
 *
 * Runs inside the caller's transaction when one is passed — the chassis-
 * replacement path archives and re-points in one commit, so a crash between
 * the two cannot leave a subnet re-pointed at a new chassis with no record of
 * what it was.
 */
export async function snapshotSubnet(
  subnetId: string,
  opts: { reason: ArchiveReason; actor?: string | null },
  tx?: PrismaLike,
): Promise<SnapshotResult> {
  const db = tx ?? prisma;

  const subnet = await db.subnet.findUnique({
    where: { id: subnetId },
    include: {
      block: { select: { cidr: true, name: true } },
      integration: { select: { name: true } },
    },
  });
  if (!subnet) throw new AppError(404, `Subnet ${subnetId} not found`);

  const archived = await db.archivedSubnet.create({
    data: {
      originalSubnetId: subnet.id,
      blockId: subnet.blockId,
      // Denormalized so the archive survives the block's deletion.
      blockCidr: subnet.block?.cidr ?? "",
      blockName: subnet.block?.name ?? "",
      cidr: subnet.cidr,
      name: subnet.name,
      purpose: subnet.purpose,
      status: subnet.status,
      vlan: subnet.vlan,
      tags: subnet.tags,
      discoveredBy: subnet.discoveredBy,
      integrationName: subnet.integration?.name ?? null,
      fortigateDevice: subnet.fortigateDevice,
      fortigateSerial: subnet.fortigateSerial,
      createdBy: subnet.createdBy,
      lastDiscoveredAt: subnet.lastDiscoveredAt,
      originalCreatedAt: subnet.createdAt,
      originalUpdatedAt: subnet.updatedAt,
      archivedBy: opts.actor ?? null,
      archiveReason: opts.reason,
    },
    select: { id: true },
  });

  // One `createMany` per chunk rather than a per-row await — the fleet-scale
  // write pattern CLAUDE.md calls for.
  const rows = await db.reservation.findMany({
    where: { subnetId: subnet.id },
    select: RESERVATION_SELECT,
    orderBy: { ipAddress: "asc" },
  });

  for (const batch of chunkArray(rows, COPY_CHUNK)) {
    await db.archivedReservation.createMany({
      data: batch.map((r) => ({
        archivedSubnetId: archived.id,
        originalReservationId: r.id,
        ipAddress: r.ipAddress,
        hostname: r.hostname,
        owner: r.owner,
        projectRef: r.projectRef,
        expiresAt: r.expiresAt,
        notes: r.notes,
        status: r.status,
        sourceType: r.sourceType,
        createdBy: r.createdBy,
        macAddress: r.macAddress,
        dhcpBinding: r.dhcpBinding,
        vipInfo: r.vipInfo ?? undefined,
        pushStatus: r.pushStatus,
        pushedAt: r.pushedAt,
        lastSeenLeased: r.lastSeenLeased,
        lastSeenArp: r.lastSeenArp,
        originalCreatedAt: r.createdAt,
        originalUpdatedAt: r.updatedAt,
      })),
    });
  }

  return { archivedSubnetId: archived.id, cidr: subnet.cidr, reservationCount: rows.length };
}

/**
 * Retire a subnet: snapshot it, then delete the live row (its reservations and
 * any pending Conflict pointing at it cascade). This is what frees the CIDR so
 * a replacement gate's identical address space can be recorded.
 */
export async function archiveSubnet(
  subnetId: string,
  opts: { actor?: string | null; reason?: ArchiveReason } = {},
): Promise<SnapshotResult> {
  const reason = opts.reason ?? "operator";
  const result = await prisma.$transaction(async (tx) => {
    const snap = await snapshotSubnet(subnetId, { reason, actor: opts.actor }, tx);
    await tx.subnet.delete({ where: { id: subnetId } });
    return snap;
  });

  void logEvent({
    action: "subnet.archived",
    resourceType: "subnet",
    resourceId: subnetId,
    resourceName: result.cidr,
    actor: opts.actor ?? undefined,
    message:
      `Subnet ${result.cidr} archived with ${result.reservationCount} reservation(s) — ` +
      `its address space is now free for re-use`,
    details: {
      archivedSubnetId: result.archivedSubnetId,
      cidr: result.cidr,
      reservationCount: result.reservationCount,
      reason,
    },
  });

  return result;
}

/** One archived subnet with its reservations, for the review surface. */
export async function getArchivedSubnet(id: string) {
  const row = await prisma.archivedSubnet.findUnique({
    where: { id },
    include: { reservations: { orderBy: { ipAddress: "asc" } } },
  });
  if (!row) throw new AppError(404, `Archived subnet ${id} not found`);
  return row;
}

/**
 * Delete one archived subnet and the reservations archived with it (business
 * rule 158(d)).
 *
 * The archive was append-only: nothing in Polaris could remove an entry, so a
 * site that replaced hardware a few times, or archived a network by mistake,
 * kept every copy for good. It is a record kept for REVIEW, so it is removed
 * by an operator's decision and never by age.
 *
 * Refused (409) while a PENDING chassis-replacement conflict still points at
 * the entry: that conflict's comparison and its Accept both read the archived
 * reservations (rule 41), and deleting them would leave a conflict that can
 * only be rejected. A resolved conflict is a frozen snapshot and needs nothing.
 */
export async function deleteArchivedSubnet(id: string, opts: { actor?: string | null } = {}): Promise<{ cidr: string; reservationCount: number }> {
  const row = await prisma.archivedSubnet.findUnique({
    where: { id },
    select: { id: true, cidr: true, name: true, blockCidr: true, fortigateSerial: true, archivedAt: true, archiveReason: true, _count: { select: { reservations: true } } },
  });
  if (!row) throw new AppError(404, `Archived subnet ${id} not found`);

  const pending = await prisma.conflict.findFirst({
    where: { entityType: "subnet", status: "pending", proposedSubnetFields: { path: ["archivedSubnetId"], equals: id } },
    select: { id: true },
  });
  if (pending) {
    throw new AppError(409, `Archived network ${row.cidr} is still being compared by a pending chassis-replacement conflict. Accept or reject that conflict first.`);
  }

  // ArchivedReservation rows cascade.
  await prisma.archivedSubnet.delete({ where: { id } });

  void logEvent({
    action: "subnet.archive_deleted",
    resourceType: "subnet",
    resourceId: id,
    resourceName: row.cidr,
    actor: opts.actor ?? undefined,
    level: "warning",
    message: `Archived network ${row.cidr} deleted with ${row._count.reservations} archived reservation(s)`,
    details: {
      archivedSubnetId: id,
      cidr: row.cidr,
      name: row.name,
      blockCidr: row.blockCidr,
      fortigateSerial: row.fortigateSerial,
      archivedAt: row.archivedAt,
      archiveReason: row.archiveReason,
      reservationCount: row._count.reservations,
    },
  });
  return { cidr: row.cidr, reservationCount: row._count.reservations };
}

export interface ListArchivedFilter {
  cidr?: string;
  blockId?: string;
  fortigateSerial?: string;
  limit?: number;
  offset?: number;
}

/** Newest retirement first; `total` is the UNPAGED match count. */
export async function listArchivedSubnets(filter: ListArchivedFilter = {}) {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const offset = Math.max(filter.offset ?? 0, 0);
  const where: Record<string, unknown> = {};
  if (filter.cidr) where.cidr = { contains: filter.cidr };
  if (filter.blockId) where.blockId = filter.blockId;
  if (filter.fortigateSerial) where.fortigateSerial = filter.fortigateSerial;

  const [rows, total] = await Promise.all([
    prisma.archivedSubnet.findMany({
      where,
      orderBy: { archivedAt: "desc" },
      take: limit,
      skip: offset,
      include: { _count: { select: { reservations: true } } },
    }),
    prisma.archivedSubnet.count({ where }),
  ]);
  return { archivedSubnets: rows, total, limit, offset };
}
