/**
 * tests/unit/fortiswitchTrunkMembers.test.ts
 *
 * Pure-function coverage for the FortiSwitch trunk → physical-member overlay.
 * SNMP IF-MIB surfaces a managed switch's FortiLink uplink trunk and its
 * member ports as flat, unrelated rows, so the parent/member edge comes from
 * outside it: the controller's managed-switch CMDB (covered here) or the
 * `fsTrunkMember` scalar (covered in fortiswitchTrunkMap.test.ts, which owns
 * `trunkMemberMap`). `parseFortiosMemberList` normalizes the CMDB member
 * shapes, and `overlayFortiswitchTrunkMembers` — shared by both sources so
 * they can't disagree — back-fills `ifParent` so the topology layer can swap a
 * single-member trunk (e.g. the serial-named uplink → port52) for its physical
 * port, and the System tab can nest the member under it.
 */

import { describe, it, expect } from "vitest";
import {
  parseFortiosMemberList,
  buildFortiswitchTrunkMembers,
  findFortiswitchUplinkPorts,
  overlayFortiswitchTrunkMembers,
  type InterfaceSample,
} from "../../src/services/monitoringService.js";
import { parseFortiswitchMclagPeers, parseFortiswitchPortDescriptions } from "../../src/utils/fortiswitchCmdb.js";

// Minimal managed-switch CMDB port entries mirroring the shapes confirmed on a
// live FortiOS 7.6 switch-controller payload: access ports carry `members: []`,
// and auto-ISL uplink ports express their trunk membership ONLY via
// `isl-local-trunk-name` (with empty `members` + `trunk-member: 0`).
const accessPort = (name: string) => ({
  "port-name": name,
  "trunk-member": 0,
  "isl-local-trunk-name": "",
  members: [],
});
const islPort = (name: string, trunk: string, peerSn: string, peerPort: string) => ({
  "port-name": name,
  "trunk-member": 0,
  "isl-local-trunk-name": trunk,
  "isl-peer-port-name": peerPort,
  "isl-peer-device-sn": peerSn,
  members: [],
});
const lacpTrunkPort = (name: string, memberNames: string[]) => ({
  "port-name": name,
  "trunk-member": 0,
  "isl-local-trunk-name": "",
  members: memberNames.map((m) => ({ "member-name": m })),
});
// The directly-cabled FortiLink uplink port: fortilink-port flag set + names
// the FortiGate in fgt-peer-device-name (fgt-peer-port-name is the FGT's
// logical "fortilink" interface, not a physical port).
const fgtUplinkPort = (name: string, fgtSn: string) => ({
  "port-name": name,
  "trunk-member": 0,
  "fortilink-port": 1,
  "fgt-peer-port-name": "fortilink",
  "fgt-peer-device-name": fgtSn,
  "isl-local-trunk-name": "",
  members: [],
});

describe("parseFortiosMemberList", () => {
  it("reads an array of { member-name } objects", () => {
    expect(parseFortiosMemberList([{ "member-name": "port52" }, { "member-name": "port53" }]))
      .toEqual(["port52", "port53"]);
  });

  it("falls back to q_origin_key / name / interface-name keys", () => {
    expect(parseFortiosMemberList([{ q_origin_key: "port1" }, { name: "port2" }, { "interface-name": "port3" }]))
      .toEqual(["port1", "port2", "port3"]);
  });

  it("reads an array of bare strings", () => {
    expect(parseFortiosMemberList(["port52", "port53"])).toEqual(["port52", "port53"]);
  });

  it("splits a space- or comma-separated string", () => {
    expect(parseFortiosMemberList("port52 port53")).toEqual(["port52", "port53"]);
    expect(parseFortiosMemberList("port52,port53")).toEqual(["port52", "port53"]);
  });

  it("de-dupes and drops blanks", () => {
    expect(parseFortiosMemberList(["port52", "", "port52", { "member-name": "  " }])).toEqual(["port52"]);
  });

  it("is null/garbage tolerant", () => {
    expect(parseFortiosMemberList(null)).toEqual([]);
    expect(parseFortiosMemberList(undefined)).toEqual([]);
    expect(parseFortiosMemberList(42)).toEqual([]);
    expect(parseFortiosMemberList([null, {}, 7])).toEqual([]);
  });
});

describe("buildFortiswitchTrunkMembers", () => {
  it("maps a FortiLink auto-ISL trunk to its single physical member", () => {
    // TESTSWITCH-2 port50 ↔ TESTSWITCH-3, port52 ↔ TESTSWITCH-1 (real shape:
    // each ISL port names a different peer-serial trunk; `members` is empty).
    const ports = [
      accessPort("port1"),
      islPort("port50", "8FFTF25005384-0", "S148FFTF25000002", "port51"),
      islPort("port52", "8FFTF25005352-0", "S148FFTF25000001", "port51"),
    ];
    const map = buildFortiswitchTrunkMembers(ports);
    expect(map.get("8FFTF25005384-0")).toEqual(["port50"]);
    expect(map.get("8FFTF25005352-0")).toEqual(["port52"]);
    // Access ports contribute nothing.
    expect(map.has("port1")).toBe(false);
    expect(map.size).toBe(2);
  });

  it("still maps operator LACP/static bundles via the members field", () => {
    const ports = [lacpTrunkPort("Trunk1", ["port1", "port2"]), accessPort("port3")];
    const map = buildFortiswitchTrunkMembers(ports);
    expect(map.get("Trunk1")).toEqual(["port1", "port2"]);
    expect(map.size).toBe(1);
  });

  it("handles a switch carrying both an LACP bundle and an auto-ISL uplink", () => {
    const ports = [
      lacpTrunkPort("Trunk1", ["port1", "port2"]),
      islPort("port51", "8FFTF25011393-0", "S148FFTF25000003", "port52"),
    ];
    const map = buildFortiswitchTrunkMembers(ports);
    expect(map.get("Trunk1")).toEqual(["port1", "port2"]);
    expect(map.get("8FFTF25011393-0")).toEqual(["port51"]);
  });

  it("feeds overlayFortiswitchTrunkMembers end-to-end so ifParent lands on the physical port", () => {
    // The opaque ISL trunk name is what LLDP / interface-name inference report
    // as the edge endpoint; the overlay must stamp ifParent on port50 so the
    // topology layer's preferPhysical swaps the label to the physical port.
    const trunkMembers = buildFortiswitchTrunkMembers([
      islPort("port50", "8FFTF25005384-0", "S148FFTF25000002", "port51"),
    ]);
    const ifaces: InterfaceSample[] = [
      { ifName: "8FFTF25005384-0", ifType: null, operStatus: "up" }, // trunk as IF-MIB surfaced it
      { ifName: "port50", ifType: "physical", operStatus: "up" },
    ];
    const links = overlayFortiswitchTrunkMembers(ifaces, trunkMembers);
    expect(links).toBe(1);
    expect(ifaces.find((i) => i.ifName === "8FFTF25005384-0")!.ifType).toBe("aggregate");
    expect(ifaces.find((i) => i.ifName === "port50")!.ifParent).toBe("8FFTF25005384-0");
  });

  it("is null/garbage tolerant", () => {
    expect(buildFortiswitchTrunkMembers(null).size).toBe(0);
    expect(buildFortiswitchTrunkMembers(undefined).size).toBe(0);
    expect(buildFortiswitchTrunkMembers(42).size).toBe(0);
    expect(buildFortiswitchTrunkMembers([null, {}, 7, { "port-name": "" }]).size).toBe(0);
  });
});

describe("findFortiswitchUplinkPorts", () => {
  it("finds the directly-cabled FortiLink uplink port (chain-head switch)", () => {
    // TESTSWITCH-1: port47 is the FGT uplink; port51 is an ISL to TESTSWITCH-2.
    const ports = [
      accessPort("port1"),
      islPort("port51", "8FFTF25011393-0", "S148FFTF25000003", "port52"),
      fgtUplinkPort("port47", "FGT91GTK25000001"),
    ];
    expect(findFortiswitchUplinkPorts(ports)).toEqual(["port47"]);
  });

  it("returns [] for a chained switch with no direct FortiGate uplink", () => {
    // TESTSWITCH-2/3 reach the FGT over ISL trunks only — no fortilink-port.
    const ports = [
      accessPort("port1"),
      islPort("port50", "8FFTF25005384-0", "S148FFTF25000002", "port51"),
      islPort("port52", "8FFTF25005352-0", "S148FFTF25000001", "port51"),
    ];
    expect(findFortiswitchUplinkPorts(ports)).toEqual([]);
  });

  it("detects the uplink via fgt-peer-device-name even if fortilink-port is unset", () => {
    const ports = [{
      "port-name": "port24",
      "fortilink-port": 0,
      "fgt-peer-device-name": "FGT-CORE-1",
      "fgt-peer-port-name": "fortilink",
    }];
    expect(findFortiswitchUplinkPorts(ports)).toEqual(["port24"]);
  });

  it("returns both ports for a dual-homed switch (caller treats >1 as ambiguous)", () => {
    const ports = [fgtUplinkPort("port47", "FGT-A"), fgtUplinkPort("port48", "FGT-A")];
    expect(findFortiswitchUplinkPorts(ports)).toEqual(["port47", "port48"]);
  });

  it("is null/garbage tolerant", () => {
    expect(findFortiswitchUplinkPorts(null)).toEqual([]);
    expect(findFortiswitchUplinkPorts(undefined)).toEqual([]);
    expect(findFortiswitchUplinkPorts(42)).toEqual([]);
    expect(findFortiswitchUplinkPorts([null, {}, { "port-name": "" }])).toEqual([]);
  });
});

describe("parseFortiswitchMclagPeers", () => {
  // An MCLAG ICL port: mclag-icl-port set + names the peer switch by serial.
  // It's also an auto-ISL trunk (isl-local-trunk-name), which is what
  // distinguishes it from a normal access/uplink port.
  const iclPort = (
    name: string,
    trunk: string,
    peerSn: string,
    peerName: string,
    peerPort: string,
  ) => ({
    "port-name": name,
    "mclag-icl-port": 1,
    "isl-local-trunk-name": trunk,
    "isl-peer-device-sn": peerSn,
    "isl-peer-device-name": peerName,
    "isl-peer-port-name": peerPort,
  });

  it("extracts an ICL leg keyed by peer serial", () => {
    const ports = [
      accessPort("port1"),
      iclPort("port51", "_FlInK1_ICL0_", "FS1E48T420001255", "METRO-1048E-2", "port51"),
    ];
    expect(parseFortiswitchMclagPeers(ports)).toEqual([
      {
        localPort: "port51",
        iclTrunk: "_FlInK1_ICL0_",
        peerSn: "FS1E48T420001255",
        peerName: "METRO-1048E-2",
        peerPort: "port51",
      },
    ]);
  });

  it("returns one entry per physical ICL leg (multi-link ICL aggregate)", () => {
    const ports = [
      iclPort("port51", "_FlInK1_ICL0_", "FS1E48T420001255", "METRO-1048E-2", "port51"),
      iclPort("port52", "_FlInK1_ICL0_", "FS1E48T420001255", "METRO-1048E-2", "port52"),
    ];
    const peers = parseFortiswitchMclagPeers(ports);
    expect(peers).toHaveLength(2);
    expect(peers.map((p) => p.localPort)).toEqual(["port51", "port52"]);
    expect(new Set(peers.map((p) => p.peerSn))).toEqual(new Set(["FS1E48T420001255"]));
  });

  it("ignores ports that aren't mclag-icl-port (plain auto-ISL uplinks)", () => {
    const ports = [
      islPort("port50", "8FFTF25005384-0", "S148FFTF25000002", "port51"),
      lacpTrunkPort("Trunk1", ["port1", "port2"]),
      accessPort("port3"),
    ];
    expect(parseFortiswitchMclagPeers(ports)).toEqual([]);
  });

  it("honors string/'enable' forms of the mclag-icl-port flag", () => {
    const ports = [{
      "port-name": "port51",
      "mclag-icl-port": "enable",
      "isl-local-trunk-name": "_FlInK1_ICL0_",
      "isl-peer-device-sn": "FS1E48T420001255",
    }];
    expect(parseFortiswitchMclagPeers(ports)).toEqual([
      { localPort: "port51", iclTrunk: "_FlInK1_ICL0_", peerSn: "FS1E48T420001255", peerName: null, peerPort: null },
    ]);
  });

  it("drops an ICL leg with no peer serial (can't be paired)", () => {
    const ports = [{
      "port-name": "port51",
      "mclag-icl-port": 1,
      "isl-local-trunk-name": "_FlInK1_ICL0_",
    }];
    expect(parseFortiswitchMclagPeers(ports)).toEqual([]);
  });

  it("is null/garbage tolerant", () => {
    expect(parseFortiswitchMclagPeers(null)).toEqual([]);
    expect(parseFortiswitchMclagPeers(undefined)).toEqual([]);
    expect(parseFortiswitchMclagPeers(42)).toEqual([]);
    expect(parseFortiswitchMclagPeers([null, {}, 7, { "port-name": "" }])).toEqual([]);
  });
});

describe("overlayFortiswitchTrunkMembers", () => {
  const mk = (ifName: string, extra: Partial<InterfaceSample> = {}): InterfaceSample => ({
    ifName,
    ifType: "physical",
    operStatus: "up",
    ...extra,
  });

  it("stamps ifParent on the member and marks the trunk an aggregate", () => {
    const ifaces: InterfaceSample[] = [
      mk("G101FTK23000001", { ifType: null }), // the serial-named uplink trunk
      mk("port52"),
    ];
    const links = overlayFortiswitchTrunkMembers(ifaces, new Map([["G101FTK23000001", ["port52"]]]));
    expect(links).toBe(1);
    expect(ifaces.find((i) => i.ifName === "G101FTK23000001")!.ifType).toBe("aggregate");
    const member = ifaces.find((i) => i.ifName === "port52")!;
    expect(member.ifParent).toBe("G101FTK23000001");
    expect(member.ifType).toBe("physical");
  });

  it("synthesizes a member row when IF-MIB omitted the subordinate port", () => {
    const ifaces: InterfaceSample[] = [mk("trunkA", { ifType: "aggregate" })];
    const links = overlayFortiswitchTrunkMembers(ifaces, new Map([["trunkA", ["port9"]]]));
    expect(links).toBe(1);
    const synth = ifaces.find((i) => i.ifName === "port9");
    expect(synth).toBeDefined();
    expect(synth!.ifParent).toBe("trunkA");
    expect(synth!.ifType).toBe("physical");
    expect(synth!.operStatus ?? null).toBeNull();
  });

  // The `fsTrunkMember` caller passes synthesizeMissing:false. That scalar rides
  // the same walk as the interface list, so a member the list doesn't carry means
  // the walk named its ports by description — inventing a row would mint a second
  // identity for a port already listed under its label.
  it("skips an unknown member instead of synthesizing when told not to", () => {
    const ifaces: InterfaceSample[] = [mk("trunkA", { ifType: "aggregate" })];
    const links = overlayFortiswitchTrunkMembers(
      ifaces,
      new Map([["trunkA", ["port9"]]]),
      { synthesizeMissing: false },
    );
    expect(links).toBe(0);
    expect(ifaces).toHaveLength(1);
    expect(ifaces.find((i) => i.ifName === "port9")).toBeUndefined();
  });

  it("still stamps the members it CAN resolve when synthesis is off", () => {
    const ifaces: InterfaceSample[] = [mk("trunkA", { ifType: null }), mk("port9")];
    const links = overlayFortiswitchTrunkMembers(
      ifaces,
      new Map([["trunkA", ["port9", "port10"]]]),
      { synthesizeMissing: false },
    );
    expect(links).toBe(1);
    expect(ifaces).toHaveLength(2);
    expect(ifaces.find((i) => i.ifName === "port9")!.ifParent).toBe("trunkA");
    expect(ifaces.find((i) => i.ifName === "trunkA")!.ifType).toBe("aggregate");
  });

  it("never clobbers an existing ifParent or a real aggregate type", () => {
    const ifaces: InterfaceSample[] = [
      mk("trunkA", { ifType: "aggregate" }),
      mk("port5", { ifParent: "preexisting" }),
    ];
    overlayFortiswitchTrunkMembers(ifaces, new Map([["trunkA", ["port5"]]]));
    expect(ifaces.find((i) => i.ifName === "port5")!.ifParent).toBe("preexisting");
    expect(ifaces.find((i) => i.ifName === "trunkA")!.ifType).toBe("aggregate");
  });

  it("handles multi-member LACP bundles (all members linked)", () => {
    const ifaces: InterfaceSample[] = [mk("lag1", { ifType: "aggregate" }), mk("port1"), mk("port2")];
    const links = overlayFortiswitchTrunkMembers(ifaces, new Map([["lag1", ["port1", "port2"]]]));
    expect(links).toBe(2);
    expect(ifaces.find((i) => i.ifName === "port1")!.ifParent).toBe("lag1");
    expect(ifaces.find((i) => i.ifName === "port2")!.ifParent).toBe("lag1");
  });

  it("is a no-op for an empty trunk map", () => {
    const ifaces: InterfaceSample[] = [mk("port1")];
    expect(overlayFortiswitchTrunkMembers(ifaces, new Map())).toBe(0);
    expect(ifaces).toHaveLength(1);
  });

  // FS-248E: the ifTable lists each trunk with its role appended
  // ("1CD11A4549B7-0(primary)", ifType 54 → null) while fsTrunkMember names it
  // bare, so the members pointed at a parent no row carried and the System tab
  // showed them flat.
  it("renames a role-suffixed trunk row to the trunk name and nests its member", () => {
    const ifaces: InterfaceSample[] = [
      mk("1CD11A4549B7-0(primary)", { ifType: null }),
      mk("_FlInK1_ICL0_(primary)", { ifType: null }),
      mk("port51"),
      mk("port52"),
    ];
    const links = overlayFortiswitchTrunkMembers(
      ifaces,
      new Map([["_FlInK1_ICL0_", ["port51"]], ["1CD11A4549B7-0", ["port52"]]]),
      { synthesizeMissing: false },
    );
    expect(links).toBe(2);
    expect(ifaces.map((i) => i.ifName).sort()).toEqual(["1CD11A4549B7-0", "_FlInK1_ICL0_", "port51", "port52"]);
    expect(ifaces.find((i) => i.ifName === "1CD11A4549B7-0")!.ifType).toBe("aggregate");
    expect(ifaces.find((i) => i.ifName === "port52")!.ifParent).toBe("1CD11A4549B7-0");
    expect(ifaces.find((i) => i.ifName === "port51")!.ifParent).toBe("_FlInK1_ICL0_");
  });

  it("moves a child already parented on the suffixed name along with the rename", () => {
    const ifaces: InterfaceSample[] = [
      mk("trunkA(primary)", { ifType: null }),
      mk("vlan30", { ifType: "vlan", ifParent: "trunkA(primary)" }),
      mk("port9"),
    ];
    overlayFortiswitchTrunkMembers(ifaces, new Map([["trunkA", ["port9"]]]));
    expect(ifaces.find((i) => i.ifName === "vlan30")!.ifParent).toBe("trunkA");
  });

  it("leaves a suffixed row alone when the trunk map doesn't name it", () => {
    const ifaces: InterfaceSample[] = [mk("other(primary)", { ifType: null }), mk("port9")];
    overlayFortiswitchTrunkMembers(ifaces, new Map([["trunkA", ["port9"]]]), { synthesizeMissing: false });
    expect(ifaces.find((i) => i.ifName === "other(primary)")).toBeDefined();
  });

  it("prefers an exact-name row over a suffixed one", () => {
    const ifaces: InterfaceSample[] = [mk("trunkA", { ifType: null }), mk("trunkA(primary)", { ifType: null }), mk("port9")];
    overlayFortiswitchTrunkMembers(ifaces, new Map([["trunkA", ["port9"]]]));
    expect(ifaces.find((i) => i.ifName === "trunkA(primary)")).toBeDefined();
  });
});

describe("parseFortiswitchPortDescriptions", () => {
  it("collects non-empty trimmed descriptions keyed by port name", () => {
    const map = parseFortiswitchPortDescriptions([
      { "port-name": "port1", description: "  AP uplink  " },
      { "port-name": "port2", description: "printer" },
      { "port-name": "port3", description: "" },
      { "port-name": "port4" }, // no description field at all
    ]);
    expect(map.get("port1")).toBe("AP uplink");
    expect(map.get("port2")).toBe("printer");
    expect(map.has("port3")).toBe(false);
    expect(map.has("port4")).toBe(false);
  });

  it("tolerates malformed input shapes", () => {
    expect(parseFortiswitchPortDescriptions(null).size).toBe(0);
    expect(parseFortiswitchPortDescriptions("nope").size).toBe(0);
    expect(parseFortiswitchPortDescriptions([null, 42, { description: "orphan (no port-name)" }]).size).toBe(0);
    // Non-string description is ignored rather than coerced.
    expect(parseFortiswitchPortDescriptions([{ "port-name": "port1", description: 7 }]).size).toBe(0);
  });
});
