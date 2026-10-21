/**
 * src/utils/fortiosIpv6.ts — the IPv6 half of FortiGate DHCP / interface
 * discovery (business rule 125).
 *
 * Shared by the FortiManager and the standalone FortiGate collectors so the
 * two transports cannot drift on what a FortiOS IPv6 field means. The shapes
 * below were read off real gates on FortiOS 7.6.7 and 8.0.1:
 *
 *   system.dhcp6/server   { id, status, interface, subnet: "2001:db8:1::/64",
 *                           ip-mode: "range"|"delegated", ip-range: [...] }
 *                         `subnet` is "::/0" until configured (a delegated
 *                         server learns its prefix at runtime). There is NO
 *                         reserved-address table: FortiOS has no DHCPv6
 *                         reservations, so every DHCPv6 binding is a lease.
 *   system/interface      ipv6: { ip6-mode, ip6-address: "2001:db8:1::1/64",
 *                           ip6-extra-addr: [{ prefix }], ip6-send-adv,
 *                           ip6-prefix-list: [{ prefix, ... }] }
 *                         ip6-address is "::/0" when unset; a dhcp / pppoe /
 *                         delegated interface's address is runtime state
 *                         and not in the CMDB at all.
 *
 * FortiManager's CMDB answers option fields as integers where FortiOS answers
 * strings, which is why every flag goes through `fortiosEnabled`.
 *
 * Type-only import from fortimanagerService (the shared Discovered* shapes'
 * home), as utils/fortinetDetectedDevice.ts does.
 */

import type { DiscoveredSubnet } from "../services/fortimanagerService.js";
import { canonicalIp, detectIpVersion, isIpamIpv6Address, isValidCidr, normalizeCidr } from "./cidr.js";
import { macColonUpperOrNull } from "./mac.js";

/**
 * A FortiOS enable/disable option as a boolean, across both transports:
 * FortiOS sends "enable" / "disable", FortiManager 0 / 1. Undefined when the
 * value says neither — the caller decides what an unreadable flag means.
 */
export function fortiosEnabled(v: unknown): boolean | undefined {
  if (v === "enable" || v === 1 || v === true) return true;
  if (v === "disable" || v === 0 || v === false) return false;
  return undefined;
}

/**
 * Parse a FortiOS IPv6 prefix string ("2001:db8:1::1/64") into the address
 * and the network it sits on. Null for the unset placeholder ("::/0"), a
 * network no operator manages (its base is link-local, multicast, loopback —
 * see `isIpamIpv6Address`), and anything malformed. The address half is
 * whatever was written before the slash; a caller that wants a HOST address
 * checks it with `isIpamIpv6Address` itself.
 */
export function parseFortiosIpv6Prefix(raw: unknown): { ip: string; cidr: string } | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!isValidCidr(value) || detectIpVersion(value) !== "v6") return null;
  const [addr, bits] = value.split("/");
  if (Number(bits) === 0) return null;
  const ip = canonicalIp(addr);
  if (!ip) return null;
  const cidr = normalizeCidr(value);
  if (!isIpamIpv6Address(cidr.split("/")[0])) return null;
  return { ip, cidr };
}

/**
 * One `system.dhcp6/server` table → the networks it serves. A disabled server
 * is skipped; one whose prefix is not yet known ("::/0", the delegated-prefix
 * case) is too, because there is no network to record.
 *
 * `dhcpServerId` is `dhcp6-<id>`: the DHCP include / exclude filters match on
 * it, and DHCPv6 server 3 must not be caught by a pattern written for IPv4
 * server 3.
 */
export function parseDhcp6Servers(
  rows: unknown,
  device: string,
  fortigateSerial: string | undefined,
): DiscoveredSubnet[] {
  if (!Array.isArray(rows)) return [];
  const out: DiscoveredSubnet[] = [];
  for (const raw of rows) {
    const s = raw as Record<string, unknown>;
    if (fortiosEnabled(s.status) === false) continue;
    const net = parseFortiosIpv6Prefix(s.subnet);
    if (!net) continue;
    const iface = typeof s.interface === "string" ? s.interface : String(s.interface ?? "");
    const id = String(s.id ?? iface);
    out.push({
      cidr: net.cidr,
      name: iface || `dhcp6-${id}`,
      fortigateDevice: device,
      fortigateSerial: fortigateSerial || undefined,
      dhcpServerId: `dhcp6-${id}`,
      origin: "dhcp6",
    });
  }
  return out;
}

/** What one interface's CMDB `ipv6` block says, once parsed. */
export interface ParsedInterfaceIpv6 {
  /** The gate's own addresses on the interface: primary, then each extra. */
  addresses: Array<{ ipAddress: string; role: "interface" | "secondary" }>;
  /**
   * Networks the gate ANNOUNCES to clients on the interface — the prefixes
   * its router advertisements carry. Only populated when `ip6-send-adv` is
   * on: an address configured on a WAN link is the gate's, not a network it
   * serves, exactly as an IPv4 interface address does not make its /24 a
   * discovered network.
   */
  advertisedPrefixes: string[];
}

/**
 * Parse an interface row's `ipv6` block (absent on builds or transports that
 * did not return it — that reads as "no IPv6", never an error).
 *
 * Advertised prefixes are `ip6-prefix-list`; an advertising interface with an
 * empty list announces its own on-link prefix, so the network of
 * `ip6-address` stands in for it.
 */
export function parseInterfaceIpv6(iface: Record<string, unknown>): ParsedInterfaceIpv6 {
  const out: ParsedInterfaceIpv6 = { addresses: [], advertisedPrefixes: [] };
  const v6 = iface?.ipv6;
  if (!v6 || typeof v6 !== "object") return out;
  const b = v6 as Record<string, unknown>;

  const primary = parseFortiosIpv6Prefix(b["ip6-address"]);
  if (primary && isIpamIpv6Address(primary.ip)) out.addresses.push({ ipAddress: primary.ip, role: "interface" });
  const extras = Array.isArray(b["ip6-extra-addr"]) ? (b["ip6-extra-addr"] as unknown[]) : [];
  for (const e of extras) {
    const p = parseFortiosIpv6Prefix((e as Record<string, unknown>)?.prefix);
    if (p && isIpamIpv6Address(p.ip) && !out.addresses.some((a) => a.ipAddress === p.ip)) {
      out.addresses.push({ ipAddress: p.ip, role: "secondary" });
    }
  }

  if (fortiosEnabled(b["ip6-send-adv"]) === true) {
    const list = Array.isArray(b["ip6-prefix-list"]) ? (b["ip6-prefix-list"] as unknown[]) : [];
    const prefixes = new Set<string>();
    for (const e of list) {
      const p = parseFortiosIpv6Prefix((e as Record<string, unknown>)?.prefix);
      if (p) prefixes.add(p.cidr);
    }
    if (prefixes.size === 0 && primary) prefixes.add(primary.cidr);
    out.advertisedPrefixes = [...prefixes];
  }
  return out;
}

/**
 * The networks a gate announces by router advertisement, as discovered
 * subnets. `dhcpServerId` is `ra-<interface>` for the reason
 * `parseDhcp6Servers` prefixes its ids. A prefix a DHCPv6 server on the same
 * gate already reported is left to that server's entry (`existing`), so one
 * network yields one subnet.
 */
export function advertisedPrefixSubnets(
  interfaceName: string,
  parsed: ParsedInterfaceIpv6,
  device: string,
  fortigateSerial: string | undefined,
  existing: ReadonlyArray<{ cidr: string; fortigateDevice: string }>,
): DiscoveredSubnet[] {
  const out: DiscoveredSubnet[] = [];
  for (const cidr of parsed.advertisedPrefixes) {
    if (existing.some((s) => s.cidr === cidr && s.fortigateDevice === device)) continue;
    if (out.some((s) => s.cidr === cidr)) continue;
    out.push({
      cidr,
      name: interfaceName,
      fortigateDevice: device,
      fortigateSerial: fortigateSerial || undefined,
      dhcpServerId: `ra-${interfaceName}`,
      origin: "ra",
    });
  }
  return out;
}

/**
 * The `format=` field list both transports request from
 * `/api/v2/monitor/system/dhcp`. `type` ("ipv4" / "ipv6") is what tells the
 * two families apart once `ipv6=true` makes the answer the combined table.
 */
export const DHCP_MONITOR_FORMAT = "ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci|type";

/**
 * The address + MAC of one `monitor/system/dhcp` row, or null for a row that
 * names no usable address.
 *
 * IPv4 keeps its historical handling exactly (any non-empty value but the
 * 0.0.0.0 placeholder, the MAC as FortiOS spelled it). IPv6 is canonicalised
 * and must be IPAM space; its `mac` is kept only when it IS a 48-bit MAC —
 * DHCPv6 identifies a client by DUID, and a DUID in that column must not reach
 * the MAC index, where it would name no device at all.
 */
export function parseDhcpMonitorAddress(lease: Record<string, unknown>): { ip: string; mac: string; v6: boolean } | null {
  const raw = typeof lease.ip === "string" ? lease.ip.trim() : "";
  if (!raw || raw === "0.0.0.0") return null;
  if (lease.type === "ipv6" || raw.includes(":")) {
    const ip = clientIpv6Address(raw);
    if (!ip) return null;
    return { ip, mac: macColonUpperOrNull(lease.mac) ? String(lease.mac) : "", v6: true };
  }
  return { ip: raw, mac: typeof lease.mac === "string" ? lease.mac : "", v6: false };
}

/**
 * A client IPv6 address a FortiOS row reports (`ipv6_address` on the device
 * inventory and the FortiSwitch detected-device table), canonicalised, or
 * undefined when absent, "::", link-local, or otherwise not IPAM space.
 */
export function clientIpv6Address(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const ip = canonicalIp(raw.trim());
  return ip && isIpamIpv6Address(ip) ? ip : undefined;
}
