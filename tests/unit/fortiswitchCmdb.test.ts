/**
 * tests/unit/fortiswitchCmdb.test.ts
 *
 * Pure parsers over a FortiGate switch-controller managed-switch CMDB. The
 * VLAN parsers are covered by fortiswitchPortVlans.test.ts, MCLAG / port
 * descriptions / trunk overlay by fortiswitchTrunkMembers.test.ts and the
 * serial read by managedSwitchCmdbSerial.test.ts. This pins the member-list
 * shapes, both trunk representations feeding one map, the uplink finder's
 * boolean coercions, and the discovery row.
 */

import { describe, it, expect } from "vitest";
import {
  parseFortiosMemberList,
  buildFortiswitchTrunkMembers,
  findFortiswitchUplinkPorts,
  parseFortiswitchMclagPeers,
  readManagedSwitchCmdbSerial,
  fortiswitchDiscoveryRow,
  FORTISWITCH_DISCOVERY_CMDB_FORMAT,
} from "../../src/utils/fortiswitchCmdb.js";

describe("parseFortiosMemberList", () => {
  it("reads every FortiOS shape, de-duplicated, in order", () => {
    expect(parseFortiosMemberList([{ "member-name": "port1" }, { q_origin_key: "port2" }, { name: "port3" }, { "interface-name": "port4" }]))
      .toEqual(["port1", "port2", "port3", "port4"]);
    expect(parseFortiosMemberList(["port1", " port2 ", "port1"])).toEqual(["port1", "port2"]);
    expect(parseFortiosMemberList("port1, port2  port3,,port1")).toEqual(["port1", "port2", "port3"]);
  });

  it("prefers member-name over the other keys in one entry", () => {
    expect(parseFortiosMemberList([{ "member-name": "a", q_origin_key: "b", name: "c" }])).toEqual(["a"]);
  });

  it("degrades to [] for absent or unexpected shapes", () => {
    expect(parseFortiosMemberList(null)).toEqual([]);
    expect(parseFortiosMemberList(undefined)).toEqual([]);
    expect(parseFortiosMemberList(42)).toEqual([]);
    expect(parseFortiosMemberList({ "member-name": "x" })).toEqual([]);
    expect(parseFortiosMemberList([null, 5, { other: "x" }, { name: 7 }, ""])).toEqual([]);
  });
});

describe("buildFortiswitchTrunkMembers", () => {
  it("maps an operator LACP trunk to its members (members or member)", () => {
    const m = buildFortiswitchTrunkMembers([
      { "port-name": "trunk1", members: [{ "member-name": "port1" }, { "member-name": "port2" }] },
      { "port-name": "trunk2", member: "port3 port4" },
      { "port-name": "port9", members: [] },
    ]);
    expect(Object.fromEntries(m)).toEqual({ trunk1: ["port1", "port2"], trunk2: ["port3", "port4"] });
  });

  it("maps a FortiLink auto-ISL trunk to the physical ports that name it", () => {
    const m = buildFortiswitchTrunkMembers([
      { "port-name": "port49", "isl-local-trunk-name": "8FFTF25005384-0" },
      { "port-name": "port50", "isl-local-trunk-name": "8FFTF25005384-0" },
      { "port-name": "port50", "isl-local-trunk-name": "8FFTF25005384-0" },
      { "port-name": "8FFTF25005384-0", members: [], "trunk-member": 0 },
    ]);
    expect(m.get("8FFTF25005384-0")).toEqual(["port49", "port50"]);
    expect(m.size).toBe(1);
  });

  it("skips nameless and non-object rows, and a non-array input", () => {
    expect(buildFortiswitchTrunkMembers([null, "x", { members: ["port1"] }, { "port-name": "  " }]).size).toBe(0);
    expect(buildFortiswitchTrunkMembers({}).size).toBe(0);
  });
});

describe("findFortiswitchUplinkPorts", () => {
  it.each([1, "1", true, "enable", "yes", "TRUE", " Enable "])("treats fortilink-port %j as an uplink", (v) => {
    expect(findFortiswitchUplinkPorts([{ "port-name": "port48", "fortilink-port": v }])).toEqual(["port48"]);
  });

  it.each([0, "0", false, "disable", "no", null, {}])("does not treat fortilink-port %j as an uplink", (v) => {
    expect(findFortiswitchUplinkPorts([{ "port-name": "port48", "fortilink-port": v }])).toEqual([]);
  });

  it("also counts a port naming the FortiGate peer, de-duplicated, and returns [] for a chained switch", () => {
    expect(findFortiswitchUplinkPorts([
      { "port-name": "port47", "fgt-peer-device-name": "FGT-HQ" },
      { "port-name": "port48", "fortilink-port": 1 },
      { "port-name": "port48", "fortilink-port": 1 },
      { "port-name": "port1", "fgt-peer-device-name": "  " },
    ])).toEqual(["port47", "port48"]);
    expect(findFortiswitchUplinkPorts([{ "port-name": "port50", "isl-local-trunk-name": "X-0" }])).toEqual([]);
    expect(findFortiswitchUplinkPorts("nope")).toEqual([]);
  });
});

describe("parseFortiswitchMclagPeers", () => {
  it("keeps only ICL ports with a local port and peer serial; blank labels become null", () => {
    expect(parseFortiswitchMclagPeers([
      { "port-name": "port51", "mclag-icl-port": "enable", "isl-peer-device-sn": "S2", "isl-local-trunk-name": " ", "isl-peer-device-name": "", "isl-peer-port-name": "port51" },
      { "port-name": "port52", "mclag-icl-port": 1 },
      { "port-name": "port53", "mclag-icl-port": 0, "isl-peer-device-sn": "S2" },
    ])).toEqual([{ localPort: "port51", iclTrunk: null, peerSn: "S2", peerName: null, peerPort: "port51" }]);
  });
});

describe("readManagedSwitchCmdbSerial", () => {
  it("never reads the display name as a serial", () => {
    expect(readManagedSwitchCmdbSerial({ name: "S108EF000001" })).toBeNull();
    expect(readManagedSwitchCmdbSerial(null)).toBeNull();
  });
});

describe("fortiswitchDiscoveryRow", () => {
  const ctl = { device: "FGT-HQ", deviceSerial: "FGT60F000001" };

  it("maps a status row plus CMDB facts", () => {
    expect(fortiswitchDiscoveryRow(
      { "switch-id": "SW1", serial: "S1", connecting_from: "10.0.0.2", fgt_peer_intf_name: "fortilink", os_version: "7.6.8", join_time: 1700000000, state: "Authorized", status: "Connected" },
      ctl,
      { uplinkPort: "port48", description: "BLD1-IDF2" },
    )).toEqual({
      device: "FGT-HQ", deviceSerial: "FGT60F000001", name: "SW1", serial: "S1", ipAddress: "10.0.0.2", fgtInterface: "fortilink",
      osVersion: "7.6.8", joinTime: 1700000000, state: "Authorized", connected: true, uplinkPhysicalPort: "port48", description: "BLD1-IDF2",
    });
  });

  it("defaults missing fields to empty and a zero / non-numeric join time to undefined", () => {
    const r = fortiswitchDiscoveryRow({ status: "Disconnected", join_time: 0 }, ctl, { uplinkPort: null, description: null });
    expect(r).toMatchObject({ name: "", serial: "", ipAddress: "", connected: false, joinTime: undefined, uplinkPhysicalPort: null });
    expect(fortiswitchDiscoveryRow({ join_time: "1700000000" }, ctl, { uplinkPort: null, description: null }).joinTime).toBeUndefined();
  });
});

describe("FORTISWITCH_DISCOVERY_CMDB_FORMAT", () => {
  it("keeps the ports table the uplink finder reads", () => {
    expect(FORTISWITCH_DISCOVERY_CMDB_FORMAT.split("|")).toContain("ports");
  });
});
