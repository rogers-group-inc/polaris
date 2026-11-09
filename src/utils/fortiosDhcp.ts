/**
 * src/utils/fortiosDhcp.ts
 *
 * The FortiOS IPv4 DHCP parsing both Fortinet integrations share: the
 * standalone FortiGate (direct REST, services/fortigateService.ts) and
 * FortiManager (proxied or direct, services/fortimanagerService.ts) read the
 * SAME two FortiOS endpoints and must turn them into the same subnets and
 * entries — they were two hand-kept copies until CQ-B034. Transport, logging
 * and the per-run flags stay with each integration; only the pure row
 * handling lives here.
 *
 *   - CMDB `system.dhcp/server` → `parseDhcpServers` → one DHCP subnet per
 *     server (cidr from ip-range[0] start + netmask) and one static
 *     `dhcp-reservation` entry per `reserved-address` row.
 *   - monitor `system/dhcp` → `flattenDhcpMonitorResults` → one row per lease
 *     → `mergeDhcpMonitorLeases`: CMDB is the base set (a static reservation
 *     whose client is offline is in CMDB only and must not be dropped); a
 *     lease on an address CMDB already has only stamps `seenLeased` and the
 *     wireless medium (business rule 101 prefers wired), anything else is
 *     added.
 *
 * DHCPv6 and router advertisements are utils/fortiosIpv6.ts (rule 125).
 */

import { Netmask } from "netmask";
import { parseDhcpMonitorAddress } from "./fortiosIpv6.js";
import type { DiscoveredSubnet, DiscoveredDhcpEntry } from "../services/fortimanagerService.js";

export interface ParsedDhcpServers {
  subnets: DiscoveredSubnet[];
  reservations: DiscoveredDhcpEntry[];
  /** Interface of every server whose subnet parsed — FortiGate's interface-IP step scopes on it. */
  interfaceNames: string[];
}

/**
 * The CMDB DHCP server rows of one gate. A server with no netmask or no
 * ip-range contributes nothing (not even its reservations — it is not a
 * usable scope); a malformed netmask / start IP drops the subnet but keeps
 * the server's reservations. `deviceSerial` is the chassis identity (business
 * rule 41) — blank stays UNKNOWN (undefined), never a claimed change.
 */
export function parseDhcpServers(servers: any[], deviceName: string, deviceSerial: string | undefined): ParsedDhcpServers {
  const subnets: DiscoveredSubnet[] = [];
  const reservations: DiscoveredDhcpEntry[] = [];
  const interfaceNames: string[] = [];
  for (const server of servers) {
    const iface = typeof server.interface === "string" ? server.interface : String(server.interface ?? "");
    const serverId = String(server.id || iface);
    const netmaskStr = server.netmask;
    const ranges = server["ip-range"];
    if (!netmaskStr || !Array.isArray(ranges) || ranges.length === 0) continue;
    const startIp = ranges[0]["start-ip"];
    if (!startIp) continue;

    try {
      const block = new Netmask(`${startIp}/${netmaskStr}`);
      subnets.push({
        cidr: `${block.base}/${block.bitmask}`,
        name: iface || `dhcp-${serverId}`,
        fortigateDevice: deviceName,
        fortigateSerial: deviceSerial || undefined,
        dhcpServerId: serverId,
      });
      if (iface) interfaceNames.push(iface);
    } catch {
      // malformed netmask / start IP: no subnet, reservations still read
    }

    const reservedAddrs = server["reserved-address"];
    if (!Array.isArray(reservedAddrs)) continue;
    for (const entry of reservedAddrs) {
      const rIp = entry.ip;
      if (!rIp || rIp === "0.0.0.0") continue;
      const numericScopeId = typeof server.id === "number" ? server.id : Number(server.id);
      const numericEntryId = typeof entry.id === "number" ? entry.id : Number(entry.id);
      reservations.push({
        device: deviceName,
        interfaceName: iface || `dhcp-${serverId}`,
        ipAddress: rIp,
        macAddress: entry.mac || "",
        hostname: entry.description || "",
        type: "dhcp-reservation",
        scopeId: Number.isFinite(numericScopeId) ? numericScopeId : undefined,
        entryId: Number.isFinite(numericEntryId) ? numericEntryId : undefined,
      });
    }
  }
  return { subnets, reservations, interfaceNames };
}

/**
 * The monitor `system/dhcp` results as one row per lease. A server row
 * carrying `leases` contributes each lease, tagged with the server's
 * interface (`_serverIface`) for a lease that names none; a bare row with an
 * `ip` is already a lease.
 */
export function flattenDhcpMonitorResults(results: unknown): any[] {
  const flat: any[] = [];
  if (!Array.isArray(results)) return flat;
  for (const entry of results) {
    if (Array.isArray(entry.leases)) {
      const serverIface = String(entry.server_interface || entry.interface || "");
      for (const lease of entry.leases) flat.push({ ...lease, _serverIface: serverIface });
    } else if (entry.ip) {
      flat.push(entry);
    }
  }
  return flat;
}

/**
 * Merge one gate's monitor leases into its CMDB-derived `entries` (mutated).
 * An address CMDB already holds for `deviceName` is a static reservation whose
 * client is online: it gains `seenLeased` (the stale-reservation job's "still
 * online" signal) and, when not already known, the wireless AP / SSID — CMDB
 * wins every other field. Anything else is added as a `dhcp-lease` (or a
 * `dhcp-reservation` the monitor flags `reserved`), its interface the lease's
 * own, else its server's, else the subnet in `subnets` containing it, else
 * "unknown". Returns how many entries were ADDED.
 */
export function mergeDhcpMonitorLeases(
  flatLeases: any[],
  entries: DiscoveredDhcpEntry[],
  subnets: Array<Pick<DiscoveredSubnet, "cidr" | "name">>,
  deviceName: string,
): number {
  let added = 0;
  for (const lease of flatLeases) {
    const parsedLease = parseDhcpMonitorAddress(lease);
    if (!parsedLease) continue;
    const leaseIp = parsedLease.ip;
    let leaseIface = lease.interface || lease._serverIface || "";

    const existingIdx = entries.findIndex((e) => e.ipAddress === leaseIp && e.device === deviceName);
    if (existingIdx >= 0) {
      entries[existingIdx].seenLeased = true;
      if (lease.access_point) entries[existingIdx].accessPoint ??= lease.access_point;
      if (lease.ssid) entries[existingIdx].ssid ??= lease.ssid;
      continue;
    }

    if (!leaseIface) {
      const matched = subnets.find((s) => {
        try { return new Netmask(s.cidr).contains(leaseIp); } catch { return false; }
      });
      leaseIface = matched?.name || "";
    }

    entries.push({
      device: deviceName,
      interfaceName: leaseIface || "unknown",
      ipAddress: leaseIp,
      macAddress: parsedLease.mac,
      hostname: lease.hostname || "",
      type: lease.reserved === true ? "dhcp-reservation" : "dhcp-lease",
      expireTime: lease.expire_time || undefined,
      accessPoint: lease.access_point || undefined,
      ssid: lease.ssid || undefined,
      vci: lease.vci || undefined,
      seenLeased: true,
    });
    added++;
  }
  return added;
}
