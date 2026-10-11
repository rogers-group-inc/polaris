/**
 * src/services/assetAddressService.ts — the discovery half of an asset's
 * address list (business rule 102).
 *
 * `AssetAssociatedIp` holds one row per (asset, IP), each with the MAC it is
 * bound to — so a card with secondary addresses has several rows. Three writers
 * share the table, and each owns its own rows:
 *
 *   - "manual"               — legacy / operator rows. Never touched here.
 *   - "monitor-system-info"  — the monitored device's own interface table
 *                              (monitoringService → persistAssocIpMirror).
 *                              Never overwritten here.
 *   - DISCOVERED_ADDRESS_SOURCES — this file: what a FortiGate reports as a
 *                              CURRENT binding for the asset's MAC.
 *
 * Discovered rows are current-state PER GATE: a successful read of a gate
 * replaces that gate's rows for the kinds it read (the DHCP monitor for leases
 * and held reservations, the detected-device table, the ARP table). A binding
 * the gate stops reporting is gone on its next read, so a recycled address is
 * never left pointing at the asset it used to belong to — which matters
 * because reservation staleness, LLDP matching, network-scan exclusion,
 * search and IP lookup all read this table. A gate that is never read again
 * (removed from FortiManager) leaves rows behind; DISCOVERED_ROW_MAX_AGE_MS
 * sweeps those.
 *
 * Between gate reads, IPAM is the fresher record of a DHCP binding: an
 * operator who releases or re-assigns an address there changes `Reservation`,
 * and nothing in that path reaches this table. `reconcileAddressesWithIpam`
 * closes the gap for ONE asset when its details are opened (business rule
 * 102(a)).
 */

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { chunkArray } from "../utils/chunk.js";
import { mostSpecificContaining } from "../utils/cidr.js";
import { normalizeMacOrNull } from "../utils/mac.js";
import type { AddressMedium } from "../utils/dhcpClaimFreshness.js";
import { logEvent } from "./eventLogService.js";

export const DISCOVERED_ADDRESS_SOURCES = ["dhcp-lease", "dhcp-reservation", "device-inventory", "arp"] as const;
export type DiscoveredAddressSource = (typeof DISCOVERED_ADDRESS_SOURCES)[number];

/** A discovered row no gate has re-reported for this long is swept. */
export const DISCOVERED_ROW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** At most one age sweep per process per this interval. */
const AGE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let lastAgeSweepMs = 0;

export interface AddressSighting {
  assetId: string;
  mac: string;
  ip: string;
  source: DiscoveredAddressSource;
  /** The gate that reported the binding. */
  device: string;
  medium?: AddressMedium;
  /** Evidence time — when the gate last saw the binding. */
  seenAt: Date;
}

/** Which gates' reads succeeded this run, per kind — the prune scope. */
export interface AddressReadScope {
  dhcpDevices: readonly string[];
  inventoryDevices: readonly string[];
  arpDevices: readonly string[];
}

const SOURCE_RANK: Record<DiscoveredAddressSource, number> = {
  "device-inventory": 3, "dhcp-reservation": 2, "dhcp-lease": 1, arp: 0,
};

/**
 * Collapse several sightings of one (asset, ip) into one row: the strongest
 * source names it, the freshest evidence time stands, and a known medium beats
 * an unknown one.
 */
export function collapseSightings(sightings: readonly AddressSighting[]): AddressSighting[] {
  const byKey = new Map<string, AddressSighting>();
  for (const s of sightings) {
    if (!s.assetId || !s.mac || !s.ip || !s.device) continue;
    const key = `${s.assetId}|${s.ip}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { ...s }); continue; }
    const stronger = SOURCE_RANK[s.source] > SOURCE_RANK[prev.source];
    const merged: AddressSighting = stronger ? { ...s } : { ...prev };
    merged.seenAt = s.seenAt > prev.seenAt ? s.seenAt : prev.seenAt;
    const known = [s.medium, prev.medium].find((m) => m && m !== "unknown");
    if (known && (!merged.medium || merged.medium === "unknown")) merged.medium = known;
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

/** Which discovered sources a gate's successful reads cover. */
export function prunableSourcesFor(device: string, scope: AddressReadScope): DiscoveredAddressSource[] {
  const out: DiscoveredAddressSource[] = [];
  if (scope.dhcpDevices.includes(device)) out.push("dhcp-lease", "dhcp-reservation");
  if (scope.inventoryDevices.includes(device)) out.push("device-inventory");
  if (scope.arpDevices.includes(device)) out.push("arp");
  return out;
}

/**
 * Write one discovery pass's sightings and drop the bindings each fully-read
 * gate no longer reports. Two statements per gate plus one bulk upsert per
 * 500 rows. Never touches manual / monitor-system-info rows.
 */
export async function reconcileDiscoveredAddresses(
  sightings: readonly AddressSighting[],
  scope: AddressReadScope,
  now: Date = new Date(),
): Promise<{ upserted: number; pruned: number }> {
  const rows = collapseSightings(sightings);
  let upserted = 0;
  let pruned = 0;

  // Upsert. ON CONFLICT updates only a row discovery owns; a manual or
  // system-info row for the same IP keeps its source and only gains a MAC it
  // lacked. Sorted so concurrent per-gate reconciles lock index pages in one
  // order (the macAddressService deadlock lesson).
  const sorted = rows.slice().sort((a, b) =>
    a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : a.ip < b.ip ? -1 : a.ip > b.ip ? 1 : 0);
  for (const batch of chunkArray(sorted, 500)) {
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const r of batch) {
      const seen = r.seenAt.toISOString();
      tuples.push(
        `(gen_random_uuid()::text, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::timestamp, $${p++}::timestamp)`,
      );
      params.push(r.assetId, r.ip, r.source, r.mac, r.device,
        r.medium && r.medium !== "unknown" ? r.medium : null, seen, seen);
    }
    const discovered = DISCOVERED_ADDRESS_SOURCES.map((s) => `'${s}'`).join(", ");
    const sql =
      `INSERT INTO "asset_associated_ips" ("id", "assetId", "ip", "source", "mac", "device", "medium", "lastSeen", "firstSeen") ` +
      `VALUES ${tuples.join(", ")} ` +
      `ON CONFLICT ("assetId", "ip") DO UPDATE SET ` +
      `  "source"   = CASE WHEN "asset_associated_ips"."source" IN (${discovered}) THEN EXCLUDED."source" ELSE "asset_associated_ips"."source" END, ` +
      `  "mac"      = CASE WHEN "asset_associated_ips"."source" IN (${discovered}) THEN EXCLUDED."mac" ELSE COALESCE("asset_associated_ips"."mac", EXCLUDED."mac") END, ` +
      `  "device"   = CASE WHEN "asset_associated_ips"."source" IN (${discovered}) THEN EXCLUDED."device" ELSE "asset_associated_ips"."device" END, ` +
      `  "medium"   = CASE WHEN "asset_associated_ips"."source" IN (${discovered}) THEN EXCLUDED."medium" ELSE "asset_associated_ips"."medium" END, ` +
      `  "lastSeen" = CASE WHEN "asset_associated_ips"."source" IN (${discovered}) THEN GREATEST("asset_associated_ips"."lastSeen", EXCLUDED."lastSeen") ELSE "asset_associated_ips"."lastSeen" END`;
    await retryOnDeadlock(() => prisma.$executeRawUnsafe(sql, ...params));
    upserted += batch.length;
  }

  // Prune per gate, only for the kinds whose read succeeded. A binding is kept
  // when ANY of this run's sightings still reports the (asset, ip) on that
  // gate — a lease that is also in ARP survives the lease ending.
  const gates = new Set<string>([...scope.dhcpDevices, ...scope.inventoryDevices, ...scope.arpDevices]);
  // Read-then-delete-by-id rather than one NOT(OR …) per sighting: a busy
  // gate reports thousands of bindings, and that predicate grows with them.
  for (const device of gates) {
    const sources = prunableSourcesFor(device, scope);
    if (sources.length === 0) continue;
    const keep = new Set(rows.filter((r) => r.device === device).map((r) => `${r.assetId}|${r.ip}`));
    const existing = await prisma.assetAssociatedIp.findMany({
      where: { device, source: { in: sources } },
      select: { id: true, assetId: true, ip: true },
    });
    const stale = existing.filter((e) => !keep.has(`${e.assetId}|${e.ip}`)).map((e) => e.id);
    for (const ids of chunkArray(stale, 1000)) {
      const res = await retryOnDeadlock(() => prisma.assetAssociatedIp.deleteMany({ where: { id: { in: ids } } }));
      pruned += res.count;
    }
  }

  // Rows from a gate nobody reads any more.
  const nowMs = now.getTime();
  if (nowMs - lastAgeSweepMs >= AGE_SWEEP_INTERVAL_MS) {
    lastAgeSweepMs = nowMs;
    const res = await prisma.assetAssociatedIp.deleteMany({
      where: {
        source: { in: [...DISCOVERED_ADDRESS_SOURCES] },
        lastSeen: { lt: new Date(nowMs - DISCOVERED_ROW_MAX_AGE_MS) },
      },
    });
    pruned += res.count;
  }

  return { upserted, pruned };
}

// ─── IPAM cross-check (business rule 102(a)) ────────────────────────────────

/** The discovered sources IPAM can vouch for — a DHCP binding is a reservation row there. */
const IPAM_CHECKED_SOURCES = ["dhcp-lease", "dhcp-reservation"] as const;

export type IpamAddressVerdict =
  | { action: "keep" }
  | { action: "remove"; reason: string }
  | { action: "relabel"; source: "dhcp-lease" | "dhcp-reservation" };

/**
 * What IPAM says about one discovered DHCP address row. Pure.
 *
 * `covered` is whether IPAM holds a subnet on the row's gate that contains the
 * IP — without one IPAM has no opinion and the row stands (an excluded range,
 * a scope never imported). `reservation` is the ACTIVE reservation at that IP
 * in that subnet, or null. A different MAC on it means the address is now
 * someone else's; no reservation means it was released. An operator-owned row
 * keeps the address whatever its sourceType, so only a DHCP-sourced or synced
 * pushed row re-labels the binding kind.
 */
export function judgeDhcpAddressAgainstIpam(
  row: { mac: string | null; source: string },
  covered: boolean,
  reservation: { macAddress: string | null; sourceType: string; pushStatus: string | null } | null,
): IpamAddressVerdict {
  if (!covered) return { action: "keep" };
  if (!reservation) return { action: "remove", reason: "no active IPAM entry at this address" };
  const resMac = normalizeMacOrNull(reservation.macAddress);
  const rowMac = normalizeMacOrNull(row.mac);
  if (resMac && rowMac && resMac !== rowMac) {
    return { action: "remove", reason: `IPAM assigns this address to ${resMac}` };
  }
  const kind =
    reservation.sourceType === "dhcp_lease" ? "dhcp-lease"
    : reservation.sourceType === "dhcp_reservation" ? "dhcp-reservation"
    : reservation.pushStatus === "synced" ? "dhcp-reservation"
    : null;
  if (kind && kind !== row.source) return { action: "relabel", source: kind };
  return { action: "keep" };
}

export interface IpamAddressCheckResult {
  removed: Array<{ ip: string; mac: string | null; device: string | null; reason: string }>;
  relabelled: number;
}

/**
 * Bring ONE asset's discovered DHCP address rows in line with IPAM. Called
 * when the asset's details are read, so an IPAM release or re-assignment shows
 * on the asset without waiting for the next gate read. Writes only on a
 * difference. Scoped per gate (`row.device` = `Subnet.fortigateDevice`)
 * because RFC1918 space repeats behind different gates. ARP and
 * detected-device rows are not DHCP bindings and are left alone, as are
 * manual and interface-scrape rows.
 */
export async function reconcileAddressesWithIpam(
  assetId: string,
  actor?: string,
): Promise<IpamAddressCheckResult> {
  const result: IpamAddressCheckResult = { removed: [], relabelled: 0 };
  const rows = await prisma.assetAssociatedIp.findMany({
    where: { assetId, source: { in: [...IPAM_CHECKED_SOURCES] } },
    select: { id: true, ip: true, mac: true, source: true, device: true },
  });
  const devices = [...new Set(rows.map((r) => r.device).filter((d): d is string => !!d))];
  if (devices.length === 0) return result;

  const subnets = await prisma.subnet.findMany({
    where: { fortigateDevice: { in: devices } },
    select: { id: true, cidr: true, fortigateDevice: true },
  });
  const subnetFor = new Map<string, { id: string; cidr: string }>();
  for (const r of rows) {
    if (!r.device) continue;
    const s = mostSpecificContaining(subnets.filter((x) => x.fortigateDevice === r.device), `${r.ip}/32`);
    if (s) subnetFor.set(r.id, s);
  }
  const subnetIds = [...new Set([...subnetFor.values()].map((s) => s.id))];
  const reservations = subnetIds.length
    ? await prisma.reservation.findMany({
        where: { subnetId: { in: subnetIds }, status: "active", ipAddress: { in: rows.map((r) => r.ip) } },
        select: { subnetId: true, ipAddress: true, macAddress: true, sourceType: true, pushStatus: true },
      })
    : [];
  const resByKey = new Map(reservations.map((r) => [`${r.subnetId}|${r.ipAddress}`, r]));

  const removeIds: string[] = [];
  const relabels: Array<{ id: string; source: string }> = [];
  for (const r of rows) {
    const subnet = subnetFor.get(r.id);
    const verdict = judgeDhcpAddressAgainstIpam(
      r, !!subnet, subnet ? resByKey.get(`${subnet.id}|${r.ip}`) ?? null : null,
    );
    if (verdict.action === "remove") {
      removeIds.push(r.id);
      result.removed.push({ ip: r.ip, mac: r.mac, device: r.device, reason: verdict.reason });
    } else if (verdict.action === "relabel") {
      relabels.push({ id: r.id, source: verdict.source });
    }
  }
  if (removeIds.length === 0 && relabels.length === 0) return result;

  await retryOnDeadlock(() =>
    prisma.$transaction([
      prisma.assetAssociatedIp.deleteMany({ where: { id: { in: removeIds } } }),
      ...relabels.map((u) => prisma.assetAssociatedIp.update({ where: { id: u.id }, data: { source: u.source } })),
    ]),
  );
  result.relabelled = relabels.length;

  if (result.removed.length > 0) {
    const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true, ipAddress: true } });
    const name = asset?.hostname || asset?.ipAddress || assetId;
    await logEvent({
      action: "asset.addresses_ipam_reconciled",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: name,
      actor,
      message:
        `Removed ${result.removed.length} DHCP address${result.removed.length === 1 ? "" : "es"} from asset "${name}" ` +
        `that IPAM no longer records: ${result.removed.map((x) => x.ip).join(", ")}`,
      details: { removed: result.removed, relabelled: result.relabelled },
    });
  }
  return result;
}

/** Test seam: forget the last age sweep so the next call runs one. */
export function _resetAgeSweepForTests(): void {
  lastAgeSweepMs = 0;
}
