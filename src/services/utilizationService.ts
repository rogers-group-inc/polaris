/**
 * src/services/utilizationService.ts
 *
 * Aggregates subnet usage statistics for the dashboard.
 */

import { prisma } from "../db.js";
import type { Prisma } from "../generated/prisma/client.js";
import type { ReservationSourceType } from "../generated/prisma/enums.js";
import { usableHostCount, cidrAllocationPercent } from "../utils/cidr.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GlobalUtilization {
  totalBlocks: number;
  totalSubnets: number;
  subnetsByStatus: { available: number; reserved: number; deprecated: number };
  totalActiveReservations: number;
  recentReservations: RecentReservation[];
  blockUtilization: BlockUtilizationSummary[];
}

export interface RecentReservation {
  id: string;
  subnetCidr: string;
  subnetName: string;
  subnetPurpose: string | null;
  vlan: number | null;
  ipAddress: string | null;
  owner: string | null;
  projectRef: string | null;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface RecentManualReservation {
  id: string;
  subnetId: string;
  subnetCidr: string;
  subnetName: string;
  vlan: number | null;
  ipAddress: string | null;
  hostname: string | null;
  owner: string | null;
  projectRef: string | null;
  macAddress: string | null;
  createdAt: Date;
  createdBy: string | null;
  expiresAt: Date | null;
}

export interface BlockUtilizationSummary {
  id: string;
  name: string;
  cidr: string;
  totalSubnets: number;
  availableSubnets: number;
  discoveredSubnets: number;
  reservedSubnets: number;
  deprecatedSubnets: number;
  blockAddresses: number;      // total IP addresses the block can hold
  allocatedAddresses: number;  // IP addresses consumed by all carved subnets
  usedPercent: number;         // allocatedAddresses / blockAddresses
}

// Returns the number of addresses in a CIDR block (e.g. /24 → 256, /16 → 65536).
// IPv6 blocks are capped at Number.MAX_SAFE_INTEGER to avoid precision loss.
function cidrAddressCount(cidr: string): number {
  const prefix = parseInt(cidr.split("/")[1], 10);
  if (cidr.includes(":")) {
    const bits = 128 - prefix;
    return bits >= 53 ? Number.MAX_SAFE_INTEGER : Math.pow(2, bits);
  }
  return Math.pow(2, 32 - prefix);
}

// ─── Global summary (for dashboard home page) ─────────────────────────────────

export async function getGlobalUtilization(): Promise<GlobalUtilization> {
  const [
    totalBlocks,
    totalSubnets,
    subnetStatusCounts,
    totalActiveReservations,
    recentReservationsRaw,
    blocks,
  ] = await Promise.all([
    prisma.ipBlock.count(),
    prisma.subnet.count(),
    prisma.subnet.groupBy({ by: ["status"], _count: { id: true } }),
    prisma.reservation.count({ where: { status: "active" } }),
    prisma.reservation.findMany({
      where: { status: "active" },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: {
        subnet: {
          select: { cidr: true, name: true, purpose: true, vlan: true },
        },
      },
    }),
    prisma.ipBlock.findMany({
      include: {
        subnets: { select: { cidr: true, status: true, discoveredBy: true } },
      },
      orderBy: { cidr: "asc" },
    }),
  ]);

  const statusMap = { available: 0, reserved: 0, deprecated: 0 };
  for (const row of subnetStatusCounts) {
    statusMap[row.status] = row._count.id;
  }

  const recentReservations: RecentReservation[] = recentReservationsRaw.map((r) => ({
    id: r.id,
    subnetCidr: r.subnet.cidr,
    subnetName: r.subnet.name,
    subnetPurpose: r.subnet.purpose,
    vlan: r.subnet.vlan,
    ipAddress: r.ipAddress,
    owner: r.owner,
    projectRef: r.projectRef,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }));

  const blockUtilization: BlockUtilizationSummary[] = blocks.map((block) => {
    const total = block.subnets.length;
    const discovered = block.subnets.filter((s) => s.status === "available" && s.discoveredBy !== null).length;
    const available = block.subnets.filter((s) => s.status === "available" && s.discoveredBy === null).length;
    const reserved = block.subnets.filter((s) => s.status === "reserved").length;
    const deprecated = block.subnets.filter((s) => s.status === "deprecated").length;

    const carved = block.subnets.filter((s) => s.status !== "deprecated");
    const blockAddresses = cidrAddressCount(block.cidr);
    const allocatedAddresses = carved.reduce((sum, s) => sum + cidrAddressCount(s.cidr), 0);
    // Exact (BigInt) — the capped counts above would put an IPv6 block at 100%
    // as soon as it held one network. Same figure as the IP Blocks list column.
    const usedPercent = Math.round(cidrAllocationPercent(block.cidr, carved.map((s) => s.cidr)));

    return {
      id: block.id,
      name: block.name,
      cidr: block.cidr,
      totalSubnets: total,
      availableSubnets: available,
      discoveredSubnets: discovered,
      reservedSubnets: reserved,
      deprecatedSubnets: deprecated,
      blockAddresses,
      allocatedAddresses,
      usedPercent,
    };
  });

  return {
    totalBlocks,
    totalSubnets,
    subnetsByStatus: statusMap,
    totalActiveReservations,
    recentReservations,
    blockUtilization,
  };
}

// ─── Recent manual (user-created) reservations ───────────────────────────────
//
// Drives the Dashboard's "Recently Reserved" widget. Default filter is
// sourceType=manual so DHCP discoveries / leases / VIP echoes don't crowd
// out reservations a person actually typed in. Callers (the Recently
// Reserved widget config) can pass an explicit `sourceTypes` array to
// broaden the filter — e.g. ["manual","dhcp_reservation"] to also include
// Polaris-pushed DHCP reservations. Pass an empty array to disable the
// filter entirely. Returns hostname + MAC + createdBy so the card can
// show full attribution without a second fetch.

export async function getRecentManualReservations(
  limit: number | null = 10,
  sourceTypes?: string[],
): Promise<RecentManualReservation[]> {
  const where: Prisma.ReservationWhereInput = { status: "active" };
  if (sourceTypes === undefined) {
    where.sourceType = { in: ["manual"] };
  } else if (sourceTypes.length > 0) {
    // Caller (route layer) validates against the recognized source-type set
    // before we get here, so this cast is safe at runtime.
    where.sourceType = { in: sourceTypes as ReservationSourceType[] };
  }
  // sourceTypes === [] → no filter (every type returned)
  const rows = await prisma.reservation.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit ?? undefined,
    include: {
      subnet: { select: { id: true, cidr: true, name: true, vlan: true } },
    },
  });
  return rows.map((r) => ({
    id:           r.id,
    subnetId:     r.subnet.id,
    subnetCidr:   r.subnet.cidr,
    subnetName:   r.subnet.name,
    vlan:         r.subnet.vlan,
    ipAddress:    r.ipAddress,
    hostname:     r.hostname,
    owner:        r.owner,
    projectRef:   r.projectRef,
    macAddress:   r.macAddress,
    createdAt:    r.createdAt,
    createdBy:    r.createdBy,
    expiresAt:    r.expiresAt,
  }));
}

// ─── Per-block utilization ────────────────────────────────────────────────────

export async function getBlockUtilization(blockId: string) {
  const block = await prisma.ipBlock.findUnique({
    where: { id: blockId },
    include: {
      subnets: {
        include: {
          _count: { select: { reservations: true } },
        },
        orderBy: { cidr: "asc" },
      },
    },
  });

  if (!block) return null;

  const subnetsWithUtil = block.subnets.map((subnet) => ({
    id: subnet.id,
    cidr: subnet.cidr,
    name: subnet.name,
    purpose: subnet.purpose,
    vlan: subnet.vlan,
    status: subnet.status,
    tags: subnet.tags,
    usableHosts: usableHostCount(subnet.cidr),
    activeReservations: subnet._count.reservations,
  }));

  return { block, subnets: subnetsWithUtil };
}
