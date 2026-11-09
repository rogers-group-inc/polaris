/**
 * tests/unit/fortiosDhcp.test.ts — the FortiOS DHCP parsing the FortiGate and
 * FortiManager integrations share (CQ-B034), plus the other helpers that left
 * the two services in the same change: the connection-error mapping, the
 * FortiSwitch discovery row and the interface / inventory / DHCP filters.
 *
 * These were two hand-kept copies; the cases pin what both did, including the
 * quiet edges (a malformed netmask keeps the server's reservations, 0.0.0.0 is
 * not a reservation, CMDB wins on overlap but learns the wireless medium).
 */

import { describe, it, expect } from "vitest";
import { parseDhcpServers, flattenDhcpMonitorResults, mergeDhcpMonitorLeases } from "../../src/utils/fortiosDhcp.js";
import { fortinetConnectionErrorMessage } from "../../src/utils/fortinetConnectionError.js";
import { fortiswitchDiscoveryRow } from "../../src/utils/fortiswitchCmdb.js";
import { matchesInterfaceFilter, matchesInventoryFilter, filterDhcpResults } from "../../src/utils/integrationFilter.js";
import type { DiscoveredDhcpEntry } from "../../src/services/fortimanagerService.js";

describe("parseDhcpServers", () => {
  const servers = [
    {
      id: 1, interface: "lan", netmask: "255.255.255.0", "ip-range": [{ "start-ip": "10.1.1.100" }],
      "reserved-address": [
        { id: 7, ip: "10.1.1.10", mac: "aa:bb:cc:dd:ee:01", description: "printer" },
        { id: 8, ip: "0.0.0.0", mac: "aa:bb:cc:dd:ee:02" },
        { id: "x", ip: "10.1.1.11" },
      ],
    },
    // No interface: named by server id.
    { id: 2, interface: "", netmask: "255.255.0.0", "ip-range": [{ "start-ip": "172.16.5.1" }] },
    // Malformed netmask: no subnet, reservations still read.
    { id: 3, interface: "guest", netmask: "not-a-mask", "ip-range": [{ "start-ip": "10.9.9.9" }], "reserved-address": [{ id: 1, ip: "10.9.9.20", mac: "aa:bb:cc:dd:ee:03" }] },
    // No ip-range: not a usable scope — nothing, not even its reservations.
    { id: 4, interface: "dmz", netmask: "255.255.255.0", "ip-range": [], "reserved-address": [{ id: 1, ip: "10.4.4.4" }] },
  ];

  it("turns each usable server into a subnet and each reserved-address into an entry", () => {
    const r = parseDhcpServers(servers, "FGT-A", "FGT60F0000000001");
    expect(r.subnets).toEqual([
      { cidr: "10.1.1.0/24", name: "lan", fortigateDevice: "FGT-A", fortigateSerial: "FGT60F0000000001", dhcpServerId: "1" },
      { cidr: "172.16.0.0/16", name: "dhcp-2", fortigateDevice: "FGT-A", fortigateSerial: "FGT60F0000000001", dhcpServerId: "2" },
    ]);
    expect(r.interfaceNames).toEqual(["lan"]);
    expect(r.reservations).toEqual([
      { device: "FGT-A", interfaceName: "lan", ipAddress: "10.1.1.10", macAddress: "aa:bb:cc:dd:ee:01", hostname: "printer", type: "dhcp-reservation", scopeId: 1, entryId: 7 },
      { device: "FGT-A", interfaceName: "lan", ipAddress: "10.1.1.11", macAddress: "", hostname: "", type: "dhcp-reservation", scopeId: 1, entryId: undefined },
      { device: "FGT-A", interfaceName: "guest", ipAddress: "10.9.9.20", macAddress: "aa:bb:cc:dd:ee:03", hostname: "", type: "dhcp-reservation", scopeId: 3, entryId: 1 },
    ]);
  });

  it("a blank serial stays unknown (business rule 41), never a claimed change", () => {
    expect(parseDhcpServers(servers, "FGT-A", "").subnets[0].fortigateSerial).toBeUndefined();
    expect(parseDhcpServers(servers, "FGT-A", undefined).subnets[0].fortigateSerial).toBeUndefined();
  });
});

describe("flattenDhcpMonitorResults", () => {
  it("expands server rows, tags their interface, keeps bare lease rows, and tolerates a non-array", () => {
    const flat = flattenDhcpMonitorResults([
      { server_interface: "lan", leases: [{ ip: "10.1.1.50" }, { ip: "10.1.1.51", interface: "lan2" }] },
      { ip: "10.2.2.2", interface: "wifi" },
      { nothing: true },
    ]);
    expect(flat).toEqual([
      { ip: "10.1.1.50", _serverIface: "lan" },
      { ip: "10.1.1.51", interface: "lan2", _serverIface: "lan" },
      { ip: "10.2.2.2", interface: "wifi" },
    ]);
    expect(flattenDhcpMonitorResults(undefined)).toEqual([]);
    expect(flattenDhcpMonitorResults({ a: 1 })).toEqual([]);
  });
});

describe("mergeDhcpMonitorLeases", () => {
  const cmdb = (): DiscoveredDhcpEntry[] => [
    { device: "FGT-A", interfaceName: "lan", ipAddress: "10.1.1.10", macAddress: "aa:bb:cc:dd:ee:01", hostname: "printer", type: "dhcp-reservation", scopeId: 1, entryId: 7 },
  ];

  it("CMDB wins on overlap: the reservation only learns it is leased and its wireless medium", () => {
    const entries = cmdb();
    const added = mergeDhcpMonitorLeases(
      [{ ip: "10.1.1.10", mac: "11:22:33:44:55:66", hostname: "other", access_point: "AP-1", ssid: "Corp" }],
      entries, [], "FGT-A",
    );
    expect(added).toBe(0);
    expect(entries).toEqual([{ ...cmdb()[0], seenLeased: true, accessPoint: "AP-1", ssid: "Corp" }]);
  });

  it("adds a live lease, its interface from the lease, the server, or the containing subnet", () => {
    const entries: DiscoveredDhcpEntry[] = [];
    const subnets = [{ cidr: "10.1.1.0/24", name: "lan" }];
    const added = mergeDhcpMonitorLeases([
      { ip: "10.1.1.60", mac: "aa:aa:aa:aa:aa:01", interface: "port5", hostname: "pc1", expire_time: 1700000000, vci: "MSFT 5.0" },
      { ip: "10.1.1.61", mac: "aa:aa:aa:aa:aa:02", _serverIface: "lan-srv", reserved: true },
      { ip: "10.1.1.62", mac: "aa:aa:aa:aa:aa:03" },
      { ip: "192.0.2.9", mac: "aa:aa:aa:aa:aa:04" },
    ], entries, subnets, "FGT-A");
    expect(added).toBe(4);
    expect(entries.map((e) => [e.ipAddress, e.interfaceName, e.type, e.seenLeased])).toEqual([
      ["10.1.1.60", "port5", "dhcp-lease", true],
      ["10.1.1.61", "lan-srv", "dhcp-reservation", true],
      ["10.1.1.62", "lan", "dhcp-lease", true],
      ["192.0.2.9", "unknown", "dhcp-lease", true],
    ]);
    expect(entries[0]).toMatchObject({ hostname: "pc1", expireTime: 1700000000, vci: "MSFT 5.0", macAddress: "aa:aa:aa:aa:aa:01" });
  });

  it("an existing entry for ANOTHER device is not this lease's reservation", () => {
    const entries = cmdb();
    expect(mergeDhcpMonitorLeases([{ ip: "10.1.1.10", mac: "aa:bb:cc:dd:ee:01" }], entries, [], "FGT-B")).toBe(1);
    expect(entries).toHaveLength(2);
  });
});

describe("fortinetConnectionErrorMessage", () => {
  const cause = (code: string, message?: string) => Object.assign(new Error("fetch failed"), { cause: { code, message } });
  it("names the failure the operator can act on", () => {
    expect(fortinetConnectionErrorMessage(cause("ECONNREFUSED"), "gw", undefined)).toBe("Connection refused — gw:443");
    expect(fortinetConnectionErrorMessage(cause("ENOTFOUND"), "gw", 8443)).toBe("Host not found — gw");
    expect(fortinetConnectionErrorMessage(cause("ETIMEDOUT"), "gw", 8443)).toBe("Connection timed out — gw:8443");
    expect(fortinetConnectionErrorMessage(Object.assign(new Error("x"), { name: "TimeoutError" }), "gw", undefined)).toBe("Connection timed out — gw:443");
    expect(fortinetConnectionErrorMessage(cause("DEPTH_ZERO_SELF_SIGNED_CERT"), "gw", 443)).toBe("TLS certificate error (DEPTH_ZERO_SELF_SIGNED_CERT) — try disabling SSL verification");
    expect(fortinetConnectionErrorMessage(cause("EPROTO", "wrong version number"), "gw", 443)).toBe("wrong version number");
  });
  it("leaves anything else to the caller", () => {
    expect(fortinetConnectionErrorMessage(new Error("HTTP 401"), "gw", 443)).toBeNull();
  });
});

describe("fortiswitchDiscoveryRow", () => {
  it("records the switch from its monitor row and the CMDB facts beside it", () => {
    expect(fortiswitchDiscoveryRow(
      { "switch-id": "S124F1", serial: "S124FTF00000001", connecting_from: "10.255.1.2", fgt_peer_intf_name: "fortilink", os_version: "S124FP-v7.4", join_time: 1690000000, state: "Authorized", status: "Connected" },
      { device: "FGT-A", deviceSerial: "FGT60F0000000001" },
      { uplinkPort: "port24", description: "IDF-2" },
    )).toEqual({
      device: "FGT-A", deviceSerial: "FGT60F0000000001", name: "S124F1", serial: "S124FTF00000001", ipAddress: "10.255.1.2",
      fgtInterface: "fortilink", osVersion: "S124FP-v7.4", joinTime: 1690000000, state: "Authorized", connected: true,
      uplinkPhysicalPort: "port24", description: "IDF-2",
    });
    const sparse = fortiswitchDiscoveryRow({ join_time: 0, status: "Down" }, { device: "FGT-A", deviceSerial: "" }, { uplinkPort: null, description: null });
    expect(sparse).toMatchObject({ name: "", serial: "", joinTime: undefined, connected: false, uplinkPhysicalPort: null });
  });
});

describe("the shared Fortinet filters", () => {
  it("interface filter: include wins, else exclude, else everything", () => {
    expect(matchesInterfaceFilter("port1", {})).toBe(true);
    expect(matchesInterfaceFilter("port1", { interfaceInclude: ["port*"] })).toBe(true);
    expect(matchesInterfaceFilter("wan1", { interfaceInclude: ["port*"], interfaceExclude: ["wan*"] })).toBe(false);
    expect(matchesInterfaceFilter("wan1", { interfaceExclude: ["wan*"] })).toBe(false);
    expect(matchesInterfaceFilter("lan", { interfaceExclude: ["wan*"] })).toBe(true);
  });
  it("inventory filter: a plain pattern also covers the interface's VLAN sub-interfaces", () => {
    expect(matchesInventoryFilter("AcmeGuest.100", { inventoryIncludeInterfaces: ["AcmeGuest"] })).toBe(true);
    expect(matchesInventoryFilter("AcmeGuestX", { inventoryIncludeInterfaces: ["AcmeGuest"] })).toBe(false);
    expect(matchesInventoryFilter("dmz.10", { inventoryExcludeInterfaces: ["dmz"] })).toBe(false);
    expect(matchesInventoryFilter("lan.5", { inventoryIncludeInterfaces: ["wan*"] })).toBe(false);
  });
  it("DHCP filter matches a scope by name or server id", () => {
    const s = [{ name: "lan", dhcpServerId: "1" }, { name: "guest", dhcpServerId: "7" }, { name: "dmz", dhcpServerId: "3" }];
    expect(filterDhcpResults(s, ["g*", "3"]).map((x) => x.name)).toEqual(["guest", "dmz"]);
    expect(filterDhcpResults(s, undefined, ["lan"]).map((x) => x.name)).toEqual(["guest", "dmz"]);
    expect(filterDhcpResults(s, ["*"], ["dmz"]).map((x) => x.name)).toEqual(["lan", "guest"]);
    expect(filterDhcpResults(s)).toBe(s);
  });
});
