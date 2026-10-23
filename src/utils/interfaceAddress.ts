/**
 * src/utils/interfaceAddress.ts — what an interface row may say about its
 * addresses (business rule 126).
 *
 * Every interface row carries at most two addresses: `ipAddress`, which is
 * IPv4, and `ipv6Address`. Both are REPORTABLE or absent: loopback (127/8,
 * ::1), link-local (169.254/16, fe80::/10 — on every IPv6 interface, it
 * identifies nothing), 0.0.0.0/8, the unspecified / multicast / IPv4-mapped
 * IPv6 ranges and anything malformed never land, because an interface address
 * is mirrored into the asset's address list and IP history (path-check hop
 * resolution, the application map, search). IPv6 is stored canonical (RFC
 * 5952) so one address is one string everywhere it is compared.
 *
 * Every write path runs a collector's reading through `splitInterfaceAddresses`
 * — that is what keeps an un-upgraded agent (which reports `lo` as 127.0.0.1
 * and an IPv6-only NIC as its fe80::) or an older collector that put an IPv6
 * address in `ipAddress` from polluting the address list. Collectors that see
 * a LIST of addresses pick with `pickInterfaceAddresses`.
 */

import { bareInterfaceIp, canonicalIp, ipInCidr, isIpamIpv6Address, isIpv6Address, isLinkLocalIp, isLoopbackIp, isValidIpv4 } from "./cidr.js";

/** A reportable IPv4 address: valid, not loopback, link-local or 0.0.0.0/8. */
function reportableIpv4(ip: string): boolean {
  return isValidIpv4(ip) && !isLoopbackIp(ip) && !isLinkLocalIp(ip) && !ipInCidr(ip, "0.0.0.0/8");
}

/**
 * One address as an interface may report it, or null. Accepts the shapes
 * collectors hand over — a bare address, "addr/prefix", the FortiOS
 * "addr mask" pair, an IPv6 zone index ("fe80::1%eth0") — and answers the bare
 * address, IPv6 canonicalised.
 */
export function reportableInterfaceIp(raw: string | null | undefined): string | null {
  const bare = bareInterfaceIp(raw).split("%")[0] ?? "";
  if (!bare) return null;
  if (isIpv6Address(bare)) return isIpamIpv6Address(bare) ? canonicalIp(bare) : null;
  return reportableIpv4(bare) ? bare : null;
}

/** An interface's two address columns. */
export interface InterfaceAddresses {
  ipAddress: string | null;
  ipv6Address: string | null;
}

/**
 * The first reportable IPv4 and the first reportable IPv6 out of a list, in
 * the collector's own order.
 */
export function pickInterfaceAddresses(candidates: ReadonlyArray<string | null | undefined>): InterfaceAddresses {
  let ipAddress: string | null = null;
  let ipv6Address: string | null = null;
  for (const c of candidates) {
    const ip = reportableInterfaceIp(c);
    if (!ip) continue;
    if (ip.includes(":")) ipv6Address ??= ip;
    else ipAddress ??= ip;
    if (ipAddress && ipv6Address) break;
  }
  return { ipAddress, ipv6Address };
}

/**
 * Normalise a reading's two columns: `ipAddress` keeps only a reportable IPv4,
 * `ipv6Address` a reportable IPv6 — and an IPv6 address a collector put in
 * `ipAddress` moves to `ipv6Address` when that is empty, rather than being
 * lost.
 */
export function splitInterfaceAddresses(
  ipAddress: string | null | undefined,
  ipv6Address?: string | null | undefined,
  allowIpv6 = true,
): InterfaceAddresses {
  const v4 = reportableInterfaceIp(ipAddress);
  const v6 = reportableInterfaceIp(ipv6Address);
  return {
    ipAddress: v4 && !v4.includes(":") ? v4 : null,
    // Business rule 128: with IPv6 off for the install, no IPv6 is stored.
    ipv6Address: !allowIpv6 ? null : (v6 && v6.includes(":") ? v6 : null) ?? (v4 && v4.includes(":") ? v4 : null),
  };
}
