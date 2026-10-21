/**
 * src/utils/observedIpv6.ts — the `observed` reservations of business rule 125.
 *
 * An IPv6 client usually ASSIGNS ITSELF its address (SLAAC, privacy
 * extensions, or a static address), so the gate's DHCP tables never list it.
 * The gate still sees it in use: FortiOS reports `ipv6_address` on the device
 * inventory and on the FortiSwitch detected-device table. Those addresses are
 * recorded in their IPAM network as `observed` rows — evidence that an address
 * is in use, never a claim on it:
 *
 *   • a row of any other source at the address wins and is left untouched
 *     (no Conflict is raised — a sighting disputes nothing);
 *   • each row carries `expiresAt` = last sighting + OBSERVED_IPV6_TTL_MS, and
 *     the 15-minute expireReservations job ages it out once the client stops
 *     using it. Privacy addresses rotate about daily, so a client holds one or
 *     two rows at a time, not a growing history;
 *   • a create may take one over (reservationService isSupersedableByCreate).
 *
 * Pure planning only; discoveryEngine Phase 7c executes the plan.
 */

import type { DiscoveredInventoryDevice, DiscoveredSwitchMacEntry } from "../services/fortimanagerService.js";
import { normalizeMacOrNull } from "./mac.js";

/** How long an observed address stays in IPAM after it was last seen. */
export const OBSERVED_IPV6_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A sighting this recent is CURRENT: it moves an existing row's expiry to
 * now + TTL. Older ones (a remembered-offline inventory row) only create.
 */
export const OBSERVED_IPV6_CURRENT_MS = 15 * 60 * 1000;

export interface ObservedIpv6Sighting {
  ip: string;
  mac: string | null;
  hostname: string | null;
  device: string;
  source: "device-inventory" | "detected-device";
  seenAtMs: number;
}

/**
 * FortiOS reports detected-device `last_seen` as SECONDS AGO (7 on a live row,
 * 7.6.7) — the type's "Unix epoch" comment notwithstanding. A value that is
 * plausibly an epoch (after 2001) is read as one, so either spelling works.
 */
function detectedDeviceSeenAtMs(lastSeen: number | undefined, nowMs: number): number {
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen) || lastSeen < 0) return nowMs;
  return lastSeen > 1_000_000_000 ? lastSeen * 1000 : nowMs - lastSeen * 1000;
}

/**
 * Every IPv6 address this run saw in use, one sighting per address — the
 * freshest wins when several gates or both tables report it. Inventory rows
 * stamp `now` when the client is online and their own `last_seen` otherwise,
 * the same evidence-time rule Phase 7 applies to presence.
 */
export function collectObservedIpv6Sightings(
  inventory: ReadonlyArray<DiscoveredInventoryDevice> | null | undefined,
  macTable: ReadonlyArray<DiscoveredSwitchMacEntry> | null | undefined,
  nowMs: number,
): ObservedIpv6Sighting[] {
  const byIp = new Map<string, ObservedIpv6Sighting>();
  const offer = (s: ObservedIpv6Sighting): void => {
    if (!Number.isFinite(s.seenAtMs)) return;
    const prev = byIp.get(s.ip);
    if (!prev || s.seenAtMs > prev.seenAtMs) byIp.set(s.ip, s);
  };
  for (const inv of inventory ?? []) {
    if (!inv.ipv6Address) continue;
    offer({
      ip: inv.ipv6Address,
      mac: normalizeMacOrNull(inv.macAddress),
      hostname: inv.hostname || null,
      device: inv.device,
      source: "device-inventory",
      seenAtMs: inv.isOnline ? nowMs : Date.parse(inv.lastSeen),
    });
  }
  for (const row of macTable ?? []) {
    // A FortiLink peer row is the gate's own MAC on a switch uplink.
    if (!row.ipv6Address || row.isFortilinkPeer) continue;
    offer({
      ip: row.ipv6Address,
      mac: normalizeMacOrNull(row.mac),
      hostname: row.deviceName || null,
      device: row.fortigateDevice,
      source: "detected-device",
      seenAtMs: detectedDeviceSeenAtMs(row.lastSeen, nowMs),
    });
  }
  return [...byIp.values()];
}

export interface ObservedIpv6ActiveRow {
  id: string;
  sourceType: string;
  macAddress: string | null;
  hostname: string | null;
}

export interface ObservedIpv6Plan {
  creates: Array<{ subnetId: string; ip: string; mac: string | null; hostname: string | null; device: string; source: ObservedIpv6Sighting["source"]; expiresAt: Date }>;
  /** Existing observed rows to move forward; they share one expiresAt, so one updateMany. */
  refresh: { ids: string[]; expiresAt: Date };
  /** Existing observed rows whose MAC or hostname changed (rare — per-row). */
  patches: Array<{ id: string; data: { macAddress?: string; hostname?: string } }>;
  skippedNoSubnet: number;
  /** Addresses another source already holds — that row wins. */
  heldByOtherSource: number;
}

/**
 * Turn this run's sightings into writes.
 *
 * Only a sighting within the TTL becomes a row (expiring TTL after it was
 * seen). A refresh is pinned to `nowMs + TTL` and is given only to CURRENT
 * sightings (`OBSERVED_IPV6_CURRENT_MS`); an older remembered-offline
 * sighting of an existing row moves nothing and lets the row age out on the
 * clock it already has.
 */
export function planObservedIpv6(input: {
  sightings: ReadonlyArray<ObservedIpv6Sighting>;
  findSubnetId: (ip: string) => string | undefined;
  activeRow: (subnetId: string, ip: string) => ObservedIpv6ActiveRow | undefined;
  hostnameForMac: (mac: string) => string | null;
  nowMs: number;
}): ObservedIpv6Plan {
  const { sightings, findSubnetId, activeRow, hostnameForMac, nowMs } = input;
  const refreshAt = new Date(nowMs + OBSERVED_IPV6_TTL_MS);
  const plan: ObservedIpv6Plan = { creates: [], refresh: { ids: [], expiresAt: refreshAt }, patches: [], skippedNoSubnet: 0, heldByOtherSource: 0 };
  for (const s of sightings) {
    const expiresMs = s.seenAtMs + OBSERVED_IPV6_TTL_MS;
    if (expiresMs <= nowMs) continue;
    const subnetId = findSubnetId(s.ip);
    if (!subnetId) { plan.skippedNoSubnet++; continue; }
    // The asset Polaris already knows by this MAC names the row; the client's
    // own hostname only when no asset does.
    const hostname = (s.mac ? hostnameForMac(s.mac) : null) || s.hostname;
    const existing = activeRow(subnetId, s.ip);
    if (!existing) {
      plan.creates.push({ subnetId, ip: s.ip, mac: s.mac, hostname, device: s.device, source: s.source, expiresAt: new Date(expiresMs) });
      continue;
    }
    if (existing.sourceType !== "observed") { plan.heldByOtherSource++; continue; }
    if (nowMs - s.seenAtMs <= OBSERVED_IPV6_CURRENT_MS) plan.refresh.ids.push(existing.id);
    const data: { macAddress?: string; hostname?: string } = {};
    if (s.mac && normalizeMacOrNull(existing.macAddress) !== s.mac) data.macAddress = s.mac;
    if (hostname && existing.hostname !== hostname) data.hostname = hostname;
    if (data.macAddress || data.hostname) plan.patches.push({ id: existing.id, data });
  }
  return plan;
}
