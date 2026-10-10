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
 */

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { chunkArray } from "../utils/chunk.js";
import type { AddressMedium } from "../utils/dhcpClaimFreshness.js";

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

/** Test seam: forget the last age sweep so the next call runs one. */
export function _resetAgeSweepForTests(): void {
  lastAgeSweepMs = 0;
}
