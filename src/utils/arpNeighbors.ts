/**
 * Pure decoding of a device's IP neighbour cache out of IP-MIB SNMP walks.
 *
 * Two generations of the same table, both bundled in `std:ip`:
 *
 *   ipNetToPhysicalTable  1.3.6.1.2.1.4.35.1  (RFC 4293 — current)
 *     INDEX { ifIndex, addressType, address }   — IPv4 ARP *and* IPv6 NDP
 *   ipNetToMediaTable     1.3.6.1.2.1.4.22.1  (RFC 1213 — deprecated)
 *     INDEX { ifIndex, netAddress }             — IPv4 only
 *
 * Prefer the first, fall back to the second: the same shape as the
 * dot1qTpFdbTable -> dot1dTpFdbTable fallback in macForwarding.ts, and for the
 * same reason — the modern table is not universally implemented.
 *
 * The ADDRESS is decoded from the OID index in both cases. On the modern table
 * that is the only place it exists (the index objects are not-accessible, so
 * walking them answers nothing); on the legacy table the columns are readable
 * too, but decoding the index works for both and avoids a second walk whose
 * rows would have to be re-joined.
 *
 * No I/O — the caller does the walking. See collectArpNeighborsSnmp.
 */

import { macFromFdbAddressValue } from "./macForwarding.js";

/** One neighbour-cache row, transport-independent (SNMP and FortiOS REST both produce these). */
export interface ArpNeighborEntry {
  ipAddress:  string;
  macAddress: string;
  /** Resolved by the caller against the IF-MIB walk; null when the join failed. */
  ifName:     string | null;
  /** Seconds since the entry was last refreshed. Null = the agent did not say. */
  ageSec:     number | null;
}

/** ipNetToPhysicalType / ipNetToMediaType — shared enum across both tables. */
const NEIGHBOR_TYPE = { other: 1, invalid: 2, dynamic: 3, static: 4, local: 5 } as const;

/**
 * ipNetToPhysicalState. `invalid(5)` and `incomplete(7)` are DROPPED at
 * collection: an incomplete row is a resolution attempt in flight — the device
 * asked and nothing answered — so storing it would put an address in the tab
 * that was never actually resolved to that MAC.
 */
const NEIGHBOR_STATE = {
  reachable: 1, stale: 2, delay: 3, probe: 4, invalid: 5, unknown: 6, incomplete: 7,
} as const;

/** addressType from InetAddressType (RFC 4001). Only these two are neighbours. */
const ADDR_TYPE_IPV4 = 1;
const ADDR_TYPE_IPV6 = 2;

/** Parsed `ipNetToPhysicalTable` index: {ifIndex, addressType, address}. */
export interface PhysicalIndex {
  ifIndex: number;
  address: string;
}

/**
 * Decode an ipNetToPhysical index suffix.
 *
 * Shape is `<ifIndex>.<addrType>.<len>.<byte>...` — InetAddress is a variable-
 * length OCTET STRING, so the RFC 4001 encoding puts its LENGTH in the OID
 * before the bytes. A decoder that assumes 4 bytes silently mangles every IPv6
 * row, and one that ignores the length byte is off by one on every row.
 *
 * Returns null for a suffix that doesn't parse or whose length disagrees with
 * the byte count — a half-read index is not an address.
 */
export function parsePhysicalIndex(suffix: string): PhysicalIndex | null {
  const parts = suffix.split(".").filter((p) => p !== "");
  if (parts.length < 4) return null;
  const nums = parts.map((p) => Number(p));
  const ifIndex  = nums[0];
  const addrType = nums[1];
  const len      = nums[2];
  const bytes    = nums.slice(3);
  if (!Number.isInteger(ifIndex) || ifIndex < 0) return null;
  if (!Number.isInteger(len) || len !== bytes.length) return null;
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;

  if (addrType === ADDR_TYPE_IPV4 && len === 4) {
    return { ifIndex, address: bytes.join(".") };
  }
  if (addrType === ADDR_TYPE_IPV6 && len === 16) {
    return { ifIndex, address: ipv6FromBytes(bytes) };
  }
  return null;
}

/**
 * Decode an ipNetToMedia index suffix: `<ifIndex>.<a>.<b>.<c>.<d>`. No length
 * prefix and no address type — the legacy table is IPv4 by definition.
 */
export function parseMediaIndex(suffix: string): PhysicalIndex | null {
  const parts = suffix.split(".").filter((p) => p !== "");
  if (parts.length !== 5) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const [ifIndex, ...bytes] = nums;
  if (bytes.some((b) => b > 255)) return null;
  return { ifIndex, address: bytes.join(".") };
}

/** RFC 5952 lower-case, zero-compressed form of a 16-byte IPv6 address. */
export function ipv6FromBytes(bytes: readonly number[]): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  // Longest run of zero groups collapses to "::" — runs of one are left alone,
  // which is what RFC 5952 requires.
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === "0") {
      if (curStart < 0) { curStart = i; curLen = 0; }
      curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLen).join(":")}`;
}

/** Inputs to `buildArpNeighbors` — one map per walked column, keyed by index suffix. */
export interface ArpWalkInput {
  /** ipNetToPhysicalPhysAddress (.4) or ipNetToMediaPhysAddress (.2). */
  physAddress: Map<string, unknown>;
  /** ipNetToPhysicalType (.6) or ipNetToMediaType (.4). Optional — absence never drops a row. */
  type?:       Map<string, unknown>;
  /** ipNetToPhysicalState (.7). Modern table only. */
  state?:      Map<string, unknown>;
  /** ipNetToPhysicalLastUpdated (.5), a sysUpTime TimeTicks stamp. Modern table only. */
  lastUpdated?: Map<string, unknown>;
  /** The device's current sysUpTime in TimeTicks, for turning LastUpdated into an age. */
  sysUpTimeTicks?: number | null;
  /** ifIndex -> ifName, from the IF-MIB walk the collector already does. */
  ifNameByIndex: Map<number, string>;
  /** Which table's index encoding the suffixes use. */
  variant: "physical" | "media";
  /** Coerce a varbind to a number; injected so this file stays I/O- and SNMP-library-free. */
  toNumber: (v: unknown) => number | null;
}

/**
 * Assemble neighbour rows from the walked columns.
 *
 * Rows are dropped when: the MAC does not decode (an entry with no hardware
 * address has resolved nothing), the index does not decode, the type is
 * `invalid(2)`, or the state is `invalid(5)` / `incomplete(7)`.
 *
 * `local(5)` type rows — the device's own addresses — are KEPT. They are how an
 * operator sees which of the gate's own interfaces sits on the segment, and
 * unlike the FDB's `self` they are not double-counted anywhere.
 *
 * An unresolved ifIndex yields `ifName: null` rather than dropping the row: the
 * binding is real even when the interface join is not, exactly as the MAC table
 * keeps a row whose basePort never resolved.
 */
export function buildArpNeighbors(input: ArpWalkInput): ArpNeighborEntry[] {
  const { physAddress, type, state, lastUpdated, sysUpTimeTicks, ifNameByIndex, variant, toNumber } = input;
  const parseIndex = variant === "physical" ? parsePhysicalIndex : parseMediaIndex;
  const out: ArpNeighborEntry[] = [];

  for (const [suffix, value] of physAddress) {
    const macAddress = macFromFdbAddressValue(value);
    if (!macAddress) continue;

    const idx = parseIndex(suffix);
    if (!idx) continue;

    const typeVal = type ? toNumber(type.get(suffix)) : null;
    if (typeVal === NEIGHBOR_TYPE.invalid) continue;

    const stateVal = state ? toNumber(state.get(suffix)) : null;
    if (stateVal === NEIGHBOR_STATE.invalid || stateVal === NEIGHBOR_STATE.incomplete) continue;

    out.push({
      ipAddress:  idx.address,
      macAddress,
      ifName:     ifNameByIndex.get(idx.ifIndex) ?? null,
      ageSec:     ageFromLastUpdated(lastUpdated ? toNumber(lastUpdated.get(suffix)) : null, sysUpTimeTicks ?? null),
    });
  }
  return out;
}

/**
 * `ipNetToPhysicalLastUpdated` is the sysUpTime AT WHICH the entry was last
 * refreshed, not an age — the age is the difference from the CURRENT sysUpTime.
 * Both are TimeTicks (hundredths of a second).
 *
 * Returns null rather than 0 whenever the arithmetic can't be trusted: either
 * value missing, or a stamp in the future (which means sysUpTime wrapped, or
 * the two reads straddled an agent restart). A null age renders as a dash;
 * a wrong 0 would read as "just refreshed", which is the opposite of the truth.
 */
export function ageFromLastUpdated(lastUpdatedTicks: number | null, sysUpTimeTicks: number | null): number | null {
  if (lastUpdatedTicks == null || sysUpTimeTicks == null) return null;
  if (!Number.isFinite(lastUpdatedTicks) || !Number.isFinite(sysUpTimeTicks)) return null;
  // 0 is the documented "never updated" value, not a fresh entry.
  if (lastUpdatedTicks <= 0) return null;
  const deltaTicks = sysUpTimeTicks - lastUpdatedTicks;
  if (deltaTicks < 0) return null;
  return Math.round(deltaTicks / 100);
}

/**
 * Map FortiOS `/api/v2/monitor/network/arp` rows onto the same shape.
 *
 * The REST endpoint is IPv4 ARP only — there is no NDP equivalent — and its
 * `age` is already seconds, so no sysUpTime arithmetic is involved. Kept beside
 * the SNMP decoders so both transports produce one row type and the writer
 * never learns which one it came from.
 */
export function arpNeighborsFromFortiosRest(rows: readonly unknown[]): ArpNeighborEntry[] {
  const out: ArpNeighborEntry[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    const ipAddress = typeof r?.ip === "string" ? r.ip.trim() : "";
    const macRaw    = typeof r?.mac === "string" ? r.mac.trim() : "";
    if (!ipAddress || !macRaw) continue;
    const macAddress = macRaw.toUpperCase().replace(/-/g, ":");
    // Incomplete / broadcast entries resolve nothing, same drop the discovery
    // parser makes.
    if (macAddress === "00:00:00:00:00:00" || macAddress === "FF:FF:FF:FF:FF:FF") continue;
    const ifRaw = typeof r?.interface === "string" ? r.interface.trim() : "";
    out.push({
      ipAddress,
      macAddress,
      ifName: ifRaw === "" ? null : ifRaw,
      ageSec: Number.isFinite(r?.age) ? Math.trunc(Number(r.age)) : null,
    });
  }
  return out;
}
