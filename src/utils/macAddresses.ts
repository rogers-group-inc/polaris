/**
 * src/utils/macAddresses.ts
 *
 * Helpers for working with the AssetMacAddress side table that replaced
 * the legacy `Asset.macAddresses` JSONB column.
 *
 * Three surfaces:
 *
 *   - `shapeMacRows(rows)` — convert side-table rows to the JSON shape the
 *     API response and the discovery code's in-memory pipeline both expect.
 *     Sorted by lastSeen desc to mirror the prior code's sort, which
 *     several call sites (notably the device-inventory + DHCP merges and
 *     the asset details panel) rely on for "most-recent MAC first".
 *
 *   - The DB writers — `reconcileMacAddresses` (discovery's in-memory-list
 *     sync) and `reconcileInterfaceMacs` (the interface-scrape range fold) —
 *     live in services/macAddressService (moved 2026-08: utils are pure
 *     helpers, services own DB writes). The ownership split between them
 *     (INTERFACE_MAC_SOURCE rows belong to the fold, everything else to
 *     discovery) is documented on the constants and functions below.
 */

import { macColonUpperOrNull, normalizeMacOrNull, isAllZeroMac } from "./mac.js";

export interface MacJsonEntry {
  mac: string;
  lastSeen: string;
  source?: string;
  device?: string;
  subnetCidr?: string;
  subnetName?: string;
  /** Inclusive range end — set only on interface-fold range rows. */
  macEnd?: string;
}

export interface MacRow {
  mac: string;
  macEnd: string | null;
  source: string;
  device: string | null;
  subnetCidr: string | null;
  subnetName: string | null;
  lastSeen: Date;
  firstSeen: Date;
}

export const MAC_ROW_SELECT = {
  mac: true, macEnd: true, source: true, device: true, subnetCidr: true, subnetName: true,
  lastSeen: true, firstSeen: true,
} as const;

/**
 * The source value stamped on rows written by the interface-scrape fold
 * (`reconcileInterfaceMacs`). Rows with this source — the only rows that can
 * carry a `macEnd` range — are OWNED by the fold: `reconcileMacAddresses`
 * (the discovery full-replace) never deletes or re-inserts them.
 */
export const INTERFACE_MAC_SOURCE = "monitor-interface";

/**
 * Sources whose MAC entries are HARDWARE TRUTH — the device's own NICs as
 * reported by something running on (or configuring) the device itself: the
 * Polaris Agent, Intune's hardware inventory, vCenter's vNIC config. Everything
 * else in the MAC list is a network SIGHTING: what some gate or switch saw the
 * device transmit as, which includes USB docks/adapters (the dock's MAC follows
 * the dock, not the laptop), randomized Wi-Fi MACs, and ZTNA-relayed
 * identities. Sightings are still identity evidence for matching — they just
 * must not steal the PRIMARY MAC from the real NICs (see selectPrimaryMac) and
 * must not have their source label overwritten by a later sighting of the same
 * address (see isHardwareMacSource's call sites in discovery).
 */
export const HARDWARE_MAC_SOURCES: ReadonlySet<string> = new Set([
  "polaris-agent",
  "intune-ethernet",
  "intune-wifi",
  "vcenter-vnic",
]);

export function isHardwareMacSource(source: string | null | undefined): boolean {
  return !!source && HARDWARE_MAC_SOURCES.has(source);
}

/**
 * Pick the asset's PRIMARY MAC from its entry list.
 *
 * When the list carries at least one hardware-truth entry (see
 * HARDWARE_MAC_SOURCES), the primary is chosen among those only — freshest
 * lastSeen wins — so a dock, dongle, or randomized-Wi-Fi sighting can never
 * displace the device's real NIC (prod 2026-08: a shared dock's MAC, kept
 * fresh by ZTNA sightings on a remote gate, was re-promoted to primary every
 * discovery run and dragged the fortigate-endpoint identity with it). Assets
 * with no hardware-truth entry (printers, cameras, anything outside
 * Intune/agent/vCenter coverage) keep the historical freshest-overall rule.
 *
 * Range rows (macEnd set — the interface-fold shape) are never primary: a
 * range is a port block, not a device identity. Neither is the all-zero MAC.
 * Returns null only when the list holds no usable single-MAC entry.
 */
export function selectPrimaryMac(
  macs: ReadonlyArray<Pick<MacJsonEntry, "mac" | "lastSeen" | "source" | "macEnd">> | null | undefined,
): string | null {
  if (!Array.isArray(macs) || macs.length === 0) return null;
  const singles = macs.filter((m) => m && m.mac && !m.macEnd && !isAllZeroMac(m.mac));
  if (singles.length === 0) return null;
  const hardware = singles.filter((m) => isHardwareMacSource(m.source));
  const candidates = hardware.length > 0 ? hardware : singles;
  let best = candidates[0];
  let bestMs = Date.parse(best.lastSeen ?? "") || 0;
  for (let i = 1; i < candidates.length; i++) {
    const ms = Date.parse(candidates[i].lastSeen ?? "") || 0;
    // Strictly-greater keeps the first entry on ties, so re-runs are stable.
    if (ms > bestMs) { best = candidates[i]; bestMs = ms; }
  }
  return best.mac;
}

/**
 * Convert side-table rows to the JSON shape the legacy code expected.
 * Sorted by lastSeen desc so the first entry is always the most recently
 * seen MAC — mirrors `macList.sort((a,b) => new Date(b.lastSeen) - ...)`
 * pattern that was scattered across discovery code.
 */
export function shapeMacRows(rows: readonly MacRow[] | null | undefined): MacJsonEntry[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .slice()
    .sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())
    .map((r) => {
      const out: MacJsonEntry = {
        mac: r.mac,
        lastSeen: r.lastSeen.toISOString(),
        source: r.source,
      };
      if (r.macEnd)     out.macEnd     = r.macEnd;
      if (r.device)     out.device     = r.device;
      if (r.subnetCidr) out.subnetCidr = r.subnetCidr;
      if (r.subnetName) out.subnetName = r.subnetName;
      return out;
    });
}


/**
 * Normalize a MAC to canonical upper-colon form ("AA:BB:CC:DD:EE:FF"), the
 * shape every row in this side table is stored as. Returns null for anything
 * that isn't exactly 12 hex digits. Loose form (all-zero kept): it READS stored
 * rows, so a row written before the all-zero MAC was refused still expands.
 * Every writer into the side table drops the all-zero MAC instead — it is how
 * devices spell "no MAC", never an address (see isAllZeroMac).
 */
const macColonUpper = macColonUpperOrNull;

// 48-bit MAC ↔ integer. 2^48 < 2^53, so plain JS numbers are exact.
// Exported for macAddressService's occupied-key slide in reconcileInterfaceMacs.
export function macToInt(mac: string): number {
  return parseInt(mac.replace(/:/g, ""), 16);
}
export function intToMac(n: number): string {
  return n.toString(16).padStart(12, "0").toUpperCase().match(/.{2}/g)!.join(":");
}

/** One folded entry: a single MAC (macEnd null) or an inclusive range. */
export interface MacRangeEntry {
  mac: string;
  macEnd: string | null;
}

/**
 * Normalize + dedupe a MAC list and coalesce numerically-contiguous runs into
 * inclusive ranges. Switch/AP/firewall ports typically carry sequentially-
 * allocated MACs off one base, so a 48-port switch folds to a single
 * `{mac, macEnd}` entry; isolated MACs stay single entries (macEnd null).
 * Invalid and all-zero entries are skipped (loopback / tunnel interfaces
 * report 00:00:00:00:00:00). Output is sorted ascending.
 */
export function foldMacsToRanges(
  macs: ReadonlyArray<string | null | undefined>,
): MacRangeEntry[] {
  const ints = Array.from(
    new Set(
      macs
        .map((m) => normalizeMacOrNull(m))
        .filter((m): m is string => m !== null)
        .map(macToInt),
    ),
  ).sort((a, b) => a - b);
  const out: MacRangeEntry[] = [];
  let i = 0;
  while (i < ints.length) {
    let j = i;
    while (j + 1 < ints.length && ints[j + 1] === ints[j] + 1) j++;
    out.push({
      mac: intToMac(ints[i]),
      macEnd: j > i ? intToMac(ints[j]) : null,
    });
    i = j + 1;
  }
  return out;
}

/**
 * Expand a range row back into individual MACs, capped so a pathological
 * range can't blow up an in-memory index. Single rows (macEnd null/absent)
 * return just [mac]. Invalid bounds return [].
 */
export function expandMacRange(
  mac: string,
  macEnd: string | null | undefined,
  cap = 256,
): string[] {
  const start = macColonUpper(mac);
  if (!start) return [];
  const end = macEnd ? macColonUpper(macEnd) : null;
  if (!end || end === start) return [start];
  const s = macToInt(start);
  const e = macToInt(end);
  if (e < s) return [start];
  const n = Math.min(e - s + 1, cap);
  const out: string[] = new Array(n);
  for (let k = 0; k < n; k++) out[k] = intToMac(s + k);
  return out;
}


/**
 * Helper for the create-time path: convert a list of MAC entries into the
 * `macAddressRows.create` array Prisma expects on a nested create. Avoids
 * a separate post-create reconcile call when the asset is brand new.
 */
export function buildMacRowsForCreate(
  macs: readonly MacJsonEntry[],
): Array<{
  mac: string; source: string; device: string | null;
  subnetCidr: string | null; subnetName: string | null;
  lastSeen: Date; firstSeen: Date;
}> {
  return macs
    .filter((m) => !!m.mac && !isAllZeroMac(m.mac))
    .map((m) => {
      const lastSeen = m.lastSeen ? new Date(m.lastSeen) : new Date();
      return {
        mac: m.mac,
        source: m.source || "unknown",
        device: m.device ?? null,
        subnetCidr: m.subnetCidr ?? null,
        subnetName: m.subnetName ?? null,
        lastSeen,
        firstSeen: lastSeen,
      };
    });
}
