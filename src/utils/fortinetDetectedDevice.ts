/**
 * src/utils/fortinetDetectedDevice.ts — shared processing of the FortiOS
 * `switch-controller/detected-device` monitor rows.
 *
 * The FMG-proxied and direct-REST discovery paths fetch the table over
 * different transports, then ran byte-identical ~85-line processing loops
 * (2026-08 audit). This owns the post-fetch half: the per-row parse into the
 * switch MAC table, the AP→switch-port uplink pairing, and the FortiSwitch
 * base-MAC stamping. Type-only imports from fortimanagerService (the shared
 * Discovered* shapes' home) — no runtime dependency.
 */

import type {
  DiscoveredFortiSwitch,
  DiscoveredFortiAP,
  DiscoveredSwitchMacEntry,
  DiscoveredArpEntry,
  DiscoveryProgressCallback,
} from "../services/fortimanagerService.js";
import { clientIpv6Address } from "./fortiosIpv6.js";

export function processDetectedDeviceRows(opts: {
  rows: unknown[];
  /** CMDB device name — stamps macTable.fortigateDevice and matches switches by `sw.device`. */
  deviceName: string;
  /** Display label for log lines (the direct-REST path uses the resolved hostname). */
  displayName: string;
  aps: DiscoveredFortiAP[];
  switches: DiscoveredFortiSwitch[];
  macTable: DiscoveredSwitchMacEntry[];
  log: DiscoveryProgressCallback;
}): void {
  const { rows, deviceName, displayName, aps, switches, macTable, log } = opts;

  const macMap = new Map<string, { switchId: string; portName: string; vlan?: number }>();
  // FortiLink-peer rows carry each managed FortiSwitch's own management MAC,
  // keyed on switch_id. Used below to stamp baseMac onto every
  // DiscoveredFortiSwitch.
  const switchMacByName = new Map<string, string>();
  for (const raw of rows) {
    const d = raw as Record<string, unknown>;
    const mac = String(d.mac || "").toUpperCase().replace(/-/g, ":");
    if (!mac) continue;
    const switchId = String(d.switch_id || "");
    const portName = String(d.port_name || "");
    const vlanId = Number.isFinite(d.vlan_id) ? Number(d.vlan_id) : undefined;
    const isFortilinkPeer = d.is_fortilink_peer === true || d.is_fortilink_peer === 1;
    if (isFortilinkPeer && switchId && !switchMacByName.has(switchId)) {
      switchMacByName.set(switchId, mac);
    }
    // Surface every learned MAC to the sync layer for endpoint-asset
    // attribution. FortiLink-peer rows are flagged so the consumer can skip
    // the FortiGate's own MAC seen on managed-switch uplinks.
    macTable.push({
      fortigateDevice: deviceName,
      switchId,
      portName,
      mac,
      vlanId,
      lastSeen: Number.isFinite(d.last_seen) ? Number(d.last_seen) : undefined,
      ipv4Address: typeof d.ipv4_address === "string" && d.ipv4_address ? d.ipv4_address : undefined,
      // Canonicalised and IPAM-space only: it feeds the `observed`
      // reservations of business rule 125.
      ipv6Address: clientIpv6Address(d.ipv6_address),
      deviceName: typeof d.device_name === "string" && d.device_name ? d.device_name : undefined,
      deviceType: typeof d.device_type === "string" && d.device_type ? d.device_type : undefined,
      osName: typeof d.os_name === "string" && d.os_name ? d.os_name : undefined,
      hostSrc: typeof d.host_src === "string" && d.host_src ? d.host_src : undefined,
      isFortilinkPeer,
    });
    // The AP-attribution loop only needs (switchId, portName, vlan) per MAC.
    // First-seen wins (matches prior behaviour).
    if (!macMap.has(mac)) {
      macMap.set(mac, { switchId, portName, vlan: vlanId });
    }
  }

  let pairedCount = 0;
  let lldpAlreadyCount = 0;
  for (const ap of aps) {
    // Skip APs already resolved via LLDP — the AP's own LLDP table is
    // authoritative and works even when FortiOS filters managed-AP MACs out
    // of detected-device. Only fall back to the MAC-table path for APs
    // where LLDP gave us nothing.
    if (ap.peerSource === "lldp") {
      lldpAlreadyCount++;
      continue;
    }
    // A wireless-mesh leaf has no switch uplink — its base MAC showing up
    // in a switch's MAC table means that switch is bridged BEHIND the AP
    // (traffic egressing the AP's LAN port), not upstream of it.
    if (ap.meshUplink === "mesh") continue;
    if (!ap.baseMac) continue;
    const norm = ap.baseMac.toUpperCase().replace(/-/g, ":");
    const hit = macMap.get(norm);
    if (hit) {
      ap.peerSwitch = hit.switchId;
      ap.peerPort = hit.portName;
      ap.peerVlan = hit.vlan;
      ap.peerSource = "detected-device";
      pairedCount++;
    }
  }
  const totalResolved = pairedCount + lldpAlreadyCount;
  log("discover.ap-uplinks", "info", `${displayName}: Resolved ${totalResolved}/${aps.length} AP→switch-port uplinks (${lldpAlreadyCount} via LLDP, ${pairedCount} via detected-device)`, displayName);

  // Stamp each managed FortiSwitch's management MAC onto its
  // DiscoveredFortiSwitch entry using the FortiLink-peer rows collected
  // above. Lets the sync layer dedup against DHCP/ARP-discovered orphan
  // endpoint assets at the switch's mgmt IP.
  let switchMacResolved = 0;
  for (const sw of switches) {
    if (sw.device !== deviceName || !sw.name) continue;
    const mac = switchMacByName.get(sw.name);
    if (mac) {
      sw.baseMac = mac;
      switchMacResolved++;
    }
  }
  if (switchMacByName.size > 0) {
    log("discover.fortiswitches.mac", "info", `${displayName}: Resolved ${switchMacResolved} FortiSwitch base MAC(s) from detected-device fortilink-peer rows`, displayName);
  }
}

/**
 * Shared parse of the FortiOS `/api/v2/monitor/network/arp` rows into the
 * discovery ARP table (same FMG-vs-direct transport split as above). Skips
 * incomplete (all-zero) and broadcast MACs; logs one summary line.
 */
export function processArpRows(opts: {
  rows: unknown[];
  deviceName: string;
  displayName: string;
  arpTable: DiscoveredArpEntry[];
  log: DiscoveryProgressCallback;
}): void {
  const { rows, deviceName, displayName, arpTable, log } = opts;
  for (const raw of rows) {
    const a = raw as Record<string, unknown>;
    const ip = typeof a.ip === "string" ? a.ip.trim() : "";
    const macRaw = typeof a.mac === "string" ? a.mac.trim() : "";
    if (!ip || !macRaw) continue;
    const mac = macRaw.toUpperCase().replace(/-/g, ":");
    // Skip the all-zero MAC (incomplete ARP entries) and broadcast.
    if (mac === "00:00:00:00:00:00" || mac === "FF:FF:FF:FF:FF:FF") continue;
    arpTable.push({
      fortigateDevice: deviceName,
      ip,
      mac,
      interface: typeof a.interface === "string" ? a.interface : "",
      age: Number.isFinite(a.age) ? Number(a.age) : undefined,
    });
  }
  log("discover.arp", "info", `${displayName}: ARP table — ${arpTable.length} entries`, displayName);
}
