/**
 * src/services/assetVipService.ts
 *
 * Answers one question the asset-details General tab could not previously
 * answer without opening Networks and hunting the address by hand: **is this
 * device published through a firewall VIP or virtual server, what is its
 * external address, and which firewall does that VIP live on?**
 *
 * Nothing new is collected. FortiManager / FortiGate discovery already writes
 * a `Reservation` for every address a VIP touches — its external IP, each
 * mapped IP, and each virtual-server realserver — and stamps
 * `Reservation.vipInfo` with `{ name, device, extip, role, isVirtualServer }`
 * (discoveryEngine Phase 3c). A server sitting behind a VIP therefore already
 * has, on the reservation for its own address, the external address and the
 * gate's name. This service reads exactly that, for every address the asset
 * carries (primary + associated), and resolves the gate NAME to an Asset.
 *
 * Two things it deliberately does not do:
 *
 *  - **It never re-derives containment.** Which subnet holds an address is
 *    `subnetService.buildIpContexts` and only that — the same helper the
 *    assets table's View-Lease button and the dns_resolved reconciler use. A
 *    second `cidr >>= ip` query here would let this row disagree with them
 *    about which reservation belongs to the address.
 *  - **It never matches the gate against `Asset.hostname`.** `vipInfo.device`
 *    is FortiManager's DEVICE NAME, under no obligation to match the gate's
 *    own hostname, so resolution rides `utils/fortinetParentKey.ts` like every
 *    other gate-name consumer. Unresolved is a state, not an error: the VIP is
 *    still worth naming when Polaris holds no Asset row for its firewall, so
 *    the entry keeps the name and carries `asset: null`.
 *
 * One reservation per (subnet, address) means one VIP per address: a server
 * published through several VIPs on one address shows the most recently
 * discovered one, because that is all the schema records. Its other addresses
 * each contribute their own entry.
 *
 * Read-only — no device I/O, no rows, no Events.
 */

import { prisma } from "../db.js";
import { buildIpContexts } from "./subnetService.js";
import {
  buildInfraParentIndex,
  parentAssetWhereOr,
  resolveInfraParentAsset,
} from "../utils/fortinetParentKey.js";

/** Which side of the VIP the asset's address sits on. */
export type AssetVipRole = "external" | "mapped" | "realserver";

/** One VIP (or virtual server) touching one of the asset's addresses. */
export interface AssetVipEntry {
  /** The asset address this entry was found on. */
  ip: string;
  /** The containing network, for the "which network" half of the answer. */
  subnetCidr: string;
  /** The reservation carrying the VIP stamp — the row the IP panel opens. */
  reservationId: string;
  /** The VIP / virtual-server object name on the gate. */
  name: string;
  /** The VIP's external address. Null only if discovery stamped none. */
  extip: string | null;
  /** Whether `ip` is the VIP's external side, a mapped IP, or a VS pool member. */
  role: AssetVipRole;
  /** Load-balance virtual server (realserver pool) rather than a DNAT VIP. */
  isVirtualServer: boolean;
  /** The gate the VIP is configured on, as FortiManager names it. */
  device: string;
  /** That gate resolved to an Asset, or null when Polaris holds no row for it. */
  asset: { id: string; hostname: string | null } | null;
}

export interface AssetVips {
  vips: AssetVipEntry[];
}

const VIP_ROLES: readonly string[] = ["external", "mapped", "realserver"];

/** Role display order: the external side first, then the internals behind it. */
const ROLE_RANK: Record<string, number> = { external: 0, mapped: 1, realserver: 2 };

type VipInfoShape = {
  name: string;
  device: string;
  extip: string | null;
  role: AssetVipRole;
  isVirtualServer: boolean;
};

/**
 * Validate a `Reservation.vipInfo` blob into the shape this surface renders.
 *
 * Pure, and deliberately strict about the two fields the row is FOR: a stamp
 * with no VIP name or no gate name answers neither half of the question, so it
 * yields nothing rather than a row reading "VIP  on ". `extip` is allowed to
 * be missing (an unusual VIP with no external address still names its gate),
 * and an unrecognized `role` falls back to "mapped" — the overwhelmingly
 * common case, and the reading that understates rather than overstates.
 */
export function parseVipInfo(raw: unknown): VipInfoShape | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = raw as Record<string, unknown>;
  const name = typeof v.name === "string" ? v.name.trim() : "";
  const device = typeof v.device === "string" ? v.device.trim() : "";
  if (!name || !device) return null;
  const extipRaw = typeof v.extip === "string" ? v.extip.trim() : "";
  const roleRaw = typeof v.role === "string" ? v.role.trim() : "";
  return {
    name,
    device,
    extip: extipRaw || null,
    role: (VIP_ROLES.includes(roleRaw) ? roleRaw : "mapped") as AssetVipRole,
    isVirtualServer: v.isVirtualServer === true,
  };
}

/**
 * Resolve every VIP / virtual server touching one asset's addresses.
 *
 * Three round-trips regardless of how many addresses the asset carries: the
 * asset + its associated IPs, the containment/reservation join (one query for
 * every address), the VIP stamps, and one candidate query for every distinct
 * gate name — never a query per address or per gate.
 *
 * Returns null only when the asset itself is gone; an asset behind no VIP —
 * which is nearly all of them — returns an empty list.
 */
export async function resolveAssetVips(assetId: string): Promise<AssetVips | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true,
      ipAddress: true,
      associatedIpRows: { select: { ip: true } },
    },
  });
  if (!asset) return null;

  const ips = Array.from(
    new Set(
      [asset.ipAddress, ...asset.associatedIpRows.map((r) => r.ip)]
        .map((ip) => (typeof ip === "string" ? ip.trim() : ""))
        .filter((ip) => !!ip),
    ),
  );
  if (ips.length === 0) return { vips: [] };

  // Containment + the active reservation on each address, through the single
  // implementation of that SQL. The reservation ids it hands back are what the
  // vipInfo read is keyed on, so this can never pick up a same-address
  // reservation from a subnet that doesn't contain the asset's address.
  const contexts = await buildIpContexts(ips);
  const byReservationId = new Map<string, { ip: string; subnetCidr: string }>();
  for (const ip of ips) {
    const ctx = contexts.get(ip);
    if (ctx?.reservation) byReservationId.set(ctx.reservation.id, { ip, subnetCidr: ctx.subnetCidr });
  }
  if (byReservationId.size === 0) return { vips: [] };

  const rows = await prisma.reservation.findMany({
    where: { id: { in: Array.from(byReservationId.keys()) } },
    select: { id: true, vipInfo: true },
  });

  const parsed: Array<{ ctx: { ip: string; subnetCidr: string }; id: string; vip: VipInfoShape }> = [];
  for (const row of rows) {
    const vip = parseVipInfo(row.vipInfo);
    const ctx = byReservationId.get(row.id);
    if (vip && ctx) parsed.push({ ctx, id: row.id, vip });
  }
  if (parsed.length === 0) return { vips: [] };

  // One candidate query for every distinct gate name, then the shared
  // per-kind precedence — never a findFirst per name, and never an OR match
  // that lets SQL choose which row wins.
  const deviceNames = Array.from(new Set(parsed.map((p) => p.vip.device)));
  const branches: Array<Record<string, unknown>> = [];
  for (const name of deviceNames) {
    const or = parentAssetWhereOr({ name });
    if (or.length > 0) branches.push({ assetType: "firewall", OR: or });
  }
  const candidates =
    branches.length > 0
      ? await prisma.asset.findMany({
          where: { OR: branches },
          select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
        })
      : [];
  const index = buildInfraParentIndex(candidates);
  const gateByName = new Map<string, { id: string; hostname: string | null } | null>();
  for (const name of deviceNames) {
    const hit = resolveInfraParentAsset(index, { name }, "firewall");
    const row = hit ? candidates.find((c) => c.id === hit.id) : undefined;
    gateByName.set(name, row ? { id: row.id, hostname: row.hostname } : null);
  }

  const vips: AssetVipEntry[] = parsed.map(({ ctx, id, vip }) => ({
    ip: ctx.ip,
    subnetCidr: ctx.subnetCidr,
    reservationId: id,
    name: vip.name,
    extip: vip.extip,
    role: vip.role,
    isVirtualServer: vip.isVirtualServer,
    device: vip.device,
    asset: gateByName.get(vip.device) ?? null,
  }));
  // External side first, then by address, so a multi-homed server's rows read
  // in the order an operator traces the path: outside in.
  vips.sort((a, b) => (ROLE_RANK[a.role] - ROLE_RANK[b.role]) || a.ip.localeCompare(b.ip) || a.name.localeCompare(b.name));
  return { vips };
}
