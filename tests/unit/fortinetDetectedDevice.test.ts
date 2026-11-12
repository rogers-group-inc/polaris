/**
 * tests/unit/fortinetDetectedDevice.test.ts
 *
 * The shared post-fetch half of FortiOS detected-device and ARP discovery:
 * the switch MAC table (every learned MAC, FortiLink peers flagged not
 * dropped), AP→switch-port pairing (LLDP wins, mesh leaves skipped, first-seen
 * MAC wins), and the ARP parse (incomplete / broadcast skipped).
 */

import { describe, it, expect, vi } from "vitest";
import { processDetectedDeviceRows, processArpRows } from "../../src/utils/fortinetDetectedDevice.js";
import type {
  DiscoveredFortiAP,
  DiscoveredSwitchMacEntry,
  DiscoveredArpEntry,
} from "../../src/services/fortimanagerService.js";

const ap = (over: Partial<DiscoveredFortiAP>): DiscoveredFortiAP => ({ ...over } as DiscoveredFortiAP);

describe("processDetectedDeviceRows", () => {
  it("normalises MACs and builds the MAC table with the optional fields only when present", () => {
    const macTable: DiscoveredSwitchMacEntry[] = [];
    const log = vi.fn();
    processDetectedDeviceRows({
      rows: [
        {
          mac: "aa-bb-cc-dd-ee-ff", switch_id: "S1", port_name: "port3", vlan_id: 10, last_seen: 42,
          ipv4_address: "10.0.0.5", device_name: "pc1", device_type: "Windows", os_name: "Win", host_src: "dhcp",
          is_fortilink_peer: 1,
        },
        { mac: "11:22:33:44:55:66", switch_id: "S2", port_name: "port1", vlan_id: "7", ipv4_address: "", device_name: "" },
        { mac: "", switch_id: "S3" },
        { switch_id: "S4" },
      ],
      deviceName: "FGT-A", displayName: "fgt-a.example", aps: [], macTable, log,
    });
    expect(macTable).toHaveLength(2);
    expect(macTable[0]).toMatchObject({
      fortigateDevice: "FGT-A", switchId: "S1", portName: "port3", mac: "AA:BB:CC:DD:EE:FF", vlanId: 10, lastSeen: 42,
      ipv4Address: "10.0.0.5", deviceName: "pc1", deviceType: "Windows", osName: "Win", hostSrc: "dhcp", isFortilinkPeer: true,
    });
    expect(macTable[1]).toMatchObject({ mac: "11:22:33:44:55:66", vlanId: undefined, ipv4Address: undefined, deviceName: undefined, isFortilinkPeer: false });
    expect(log).toHaveBeenCalledWith("discover.ap-uplinks", "info", expect.stringContaining("fgt-a.example: Resolved 0/0"), "fgt-a.example");
  });

  it("drops an IPv6 address outside IPAM space and keeps a global one canonicalised", () => {
    const macTable: DiscoveredSwitchMacEntry[] = [];
    processDetectedDeviceRows({
      rows: [
        { mac: "aa:aa:aa:aa:aa:01", ipv6_address: "fe80::1" },
        { mac: "aa:aa:aa:aa:aa:02", ipv6_address: "2001:DB8:0:0::5" },
      ],
      deviceName: "d", displayName: "d", aps: [], macTable, log: vi.fn(),
    });
    expect(macTable[0].ipv6Address).toBeUndefined();
    expect(macTable[1].ipv6Address).toBe("2001:db8::5");
  });

  it("pairs APs to the switch port that learned their base MAC, skipping LLDP-resolved and mesh APs", () => {
    const macTable: DiscoveredSwitchMacEntry[] = [];
    const log = vi.fn();
    const viaMac = ap({ baseMac: "aa-bb-cc-00-00-01" });
    const viaLldp = ap({ baseMac: "AA:BB:CC:00:00:02", peerSource: "lldp", peerSwitch: "LLDP-SW", peerPort: "p9" });
    const mesh = ap({ baseMac: "AA:BB:CC:00:00:03", meshUplink: "mesh" });
    const noMac = ap({});
    const unmatched = ap({ baseMac: "AA:BB:CC:00:00:99" });
    processDetectedDeviceRows({
      rows: [
        { mac: "AA:BB:CC:00:00:01", switch_id: "SW1", port_name: "port5", vlan_id: 20 },
        { mac: "AA:BB:CC:00:00:01", switch_id: "SW2", port_name: "port1", vlan_id: 30 }, // later sighting loses
        { mac: "AA:BB:CC:00:00:02", switch_id: "SW1", port_name: "port6" },
        { mac: "AA:BB:CC:00:00:03", switch_id: "SW1", port_name: "port7" },
      ],
      deviceName: "d", displayName: "gate", aps: [viaMac, viaLldp, mesh, noMac, unmatched], macTable, log,
    });
    expect(viaMac).toMatchObject({ peerSwitch: "SW1", peerPort: "port5", peerVlan: 20, peerSource: "detected-device" });
    expect(viaLldp).toMatchObject({ peerSwitch: "LLDP-SW", peerPort: "p9", peerSource: "lldp" });
    expect(mesh.peerSwitch).toBeUndefined();
    expect(unmatched.peerSwitch).toBeUndefined();
    expect(macTable).toHaveLength(4);
    expect(log.mock.calls[0][2]).toBe("gate: Resolved 2/5 AP→switch-port uplinks (1 via LLDP, 1 via detected-device)");
  });
});

describe("processArpRows", () => {
  it("parses rows, normalises MACs and skips incomplete, broadcast and partial rows", () => {
    const arpTable: DiscoveredArpEntry[] = [];
    const log = vi.fn();
    processArpRows({
      rows: [
        { ip: " 10.0.0.1 ", mac: "aa-bb-cc-dd-ee-ff", interface: "port1", age: 12 },
        { ip: "10.0.0.2", mac: "00:00:00:00:00:00", interface: "port1" },
        { ip: "10.0.0.3", mac: "ff:ff:ff:ff:ff:ff" },
        { ip: "", mac: "aa:aa:aa:aa:aa:aa" },
        { ip: "10.0.0.4" },
        { ip: 5, mac: "aa:aa:aa:aa:aa:ab" },
        { ip: "10.0.0.6", mac: "aa:aa:aa:aa:aa:ac", interface: 3, age: "old" },
      ],
      deviceName: "FGT", displayName: "fgt", arpTable, log,
    });
    expect(arpTable).toEqual([
      { fortigateDevice: "FGT", ip: "10.0.0.1", mac: "AA:BB:CC:DD:EE:FF", interface: "port1", age: 12 },
      { fortigateDevice: "FGT", ip: "10.0.0.6", mac: "AA:AA:AA:AA:AA:AC", interface: "", age: undefined },
    ]);
    expect(log).toHaveBeenCalledWith("discover.arp", "info", "fgt: ARP table — 2 entries", "fgt");
  });
});
