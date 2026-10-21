/**
 * src/utils/snmpIpAddressTable.ts — an interface's addresses from IP-MIB over
 * SNMP, both families (business rule 126).
 *
 *   ipAddressTable  1.3.6.1.2.1.4.34.1  (RFC 4293 — current, IPv4 AND IPv6)
 *     ipAddressIfIndex  .3   index: <addrType>.<len>.<octets…>
 *     ipAddressType     .4   unicast(1) | anycast(2) | broadcast(3)
 *   ipAddrTable     1.3.6.1.2.1.4.20.1  (RFC 1213 — legacy, IPv4 only)
 *     ipAdEntIfIndex    .2   index: the dotted-quad address itself
 *
 * A device that implements the current table is read from it; one that only
 * has the legacy table (older gear, some embedded stacks) falls back to it, and
 * an empty current-table walk is what says which. Both are inverted into
 * `ifIndex → [addresses]` in walk order; the collector then keeps the first
 * REPORTABLE address of each family (utils/interfaceAddress.ts).
 *
 * Pure — the SNMP walks happen in monitoringService; values arrive already
 * converted to numbers.
 */

import { ipv6FromBytes } from "./arpNeighbors.js";

export const IP_ADDRESS_IF_INDEX_OID = "1.3.6.1.2.1.4.34.1.3";
export const IP_ADDRESS_TYPE_OID = "1.3.6.1.2.1.4.34.1.4";

const ADDR_TYPE_IPV4 = 1;
const ADDR_TYPE_IPV6 = 2;
const IP_ADDRESS_TYPE_UNICAST = 1;

/**
 * Decode an ipAddressTable index suffix into the address it names, or null.
 *
 * RFC 4001 puts an InetAddress's LENGTH before its octets in the OID
 * (`1.4.192.0.2.1`); a few agents omit it (`1.192.0.2.1`), and that form is
 * unambiguous because the octet count then IS 4 or 16. Zoned types (ipv4z /
 * ipv6z) are scoped addresses — link-local by construction — and decode to
 * null rather than to an address no operator manages.
 */
export function parseIpAddressIndex(suffix: string): string | null {
  const nums = suffix.split(".").filter((p) => p !== "").map(Number);
  if (nums.length < 2 || nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  const type = nums[0];
  const want = type === ADDR_TYPE_IPV4 ? 4 : type === ADDR_TYPE_IPV6 ? 16 : 0;
  if (!want) return null;
  // A second number equal to the expected length IS the length: a suffix that
  // then has the wrong octet count is refused, not re-read as the no-length
  // form (which would turn `1.4.192.0.2` into 4.192.0.2). The price is that a
  // no-length agent's address whose first octet equals the length (4.x.x.x)
  // is dropped — rarer than a misread index, and no address beats a wrong one.
  let bytes: number[];
  if (nums[1] === want) {
    if (nums.length !== want + 2) return null;
    bytes = nums.slice(2);
  } else if (nums.length === want + 1) bytes = nums.slice(1);
  else return null;
  if (bytes.some((b) => b > 255)) return null;
  return type === ADDR_TYPE_IPV4 ? bytes.join(".") : ipv6FromBytes(bytes);
}

/**
 * Invert ipAddressIfIndex into `ifIndex → [address…]`. When the ipAddressType
 * column was read, only unicast rows are kept: a router lists its subnet-router
 * anycast and broadcast addresses here too, and neither is the interface's own
 * address. A row with no type reading is kept — absence is not a verdict.
 */
export function addressesByIfIndexFromIpAddressTable(
  ifIndexBySuffix: ReadonlyMap<string, number | null>,
  typeBySuffix?: ReadonlyMap<string, number | null> | null,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [suffix, idx] of ifIndexBySuffix) {
    if (idx == null || idx <= 0) continue;
    const t = typeBySuffix?.get(suffix);
    if (t != null && t !== IP_ADDRESS_TYPE_UNICAST) continue;
    const address = parseIpAddressIndex(suffix);
    if (!address) continue;
    const key = String(idx);
    const list = out.get(key);
    if (list) list.push(address);
    else out.set(key, [address]);
  }
  return out;
}

/** Invert the legacy ipAdEntIfIndex (index = the address itself) into the same shape. */
export function addressesByIfIndexFromIpAddrTable(
  ifIndexByAddress: ReadonlyMap<string, number | null>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [address, idx] of ifIndexByAddress) {
    if (idx == null || idx <= 0 || !/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) continue;
    const key = String(idx);
    const list = out.get(key);
    if (list) list.push(address);
    else out.set(key, [address]);
  }
  return out;
}
