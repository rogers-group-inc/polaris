/**
 * tests/unit/fortiswitchPortVlans.test.ts
 *
 * Managed-FortiSwitch port VLANs, as monitoring overlays them from the
 * controller FortiGate's CMDB.
 *
 * On a FortiLink switch every VLAN field NAMES a FortiGate VLAN interface —
 * `vlan: "_default"`, `allowed-vlans: [{ "vlan-name": "quarantine" }]` — never
 * a number (FortiOS 7.6.8, HUB1-a, 2026-11-04). The old parser only took
 * numbers, so it found a VLAN on 0 of 54 ports; the names now resolve through
 * the gate's interfaces (`_default` → 1, `quarantine` → 4093, `LabProd` → 2).
 * `datasource=1` changed nothing but adding a `datasource` tag to each entry.
 */

import { describe, it, expect } from "vitest";
import {
  fortiosVlanIdByName,
  parseFortiosVlanList,
  parseFortiswitchPortVlan,
  FORTISWITCH_MONITOR_PORT_FORMAT,
} from "../../src/utils/fortiswitchCmdb.js";
import { buildFortiswitchControllerPortsMap } from "../../src/services/monitoringService.js";
import { monitoringServiceSource } from "./_monitoringServiceSource.js";

// The gate's interfaces as `format=name|vlanid` returns them (HUB1-a shapes).
const GATE_IFACES = [
  { name: "fortilink", q_origin_key: "fortilink", vlanid: 0 },
  { name: "_default", q_origin_key: "_default", vlanid: 1 },
  { name: "LabProd", q_origin_key: "LabProd", vlanid: 2 },
  { name: "quarantine", q_origin_key: "quarantine", vlanid: 4093 },
  { name: "wan1", q_origin_key: "wan1" },
];
const BY_NAME = fortiosVlanIdByName(GATE_IFACES);

describe("fortiosVlanIdByName", () => {
  it("maps each VLAN interface's name to its id and leaves out non-VLAN rows", () => {
    expect([...BY_NAME]).toEqual([["_default", 1], ["LabProd", 2], ["quarantine", 4093]]);
    expect(fortiosVlanIdByName(null).size).toBe(0);
  });
});

describe("parseFortiswitchPortVlan — FortiLink name references (HUB1-a 7.6.8)", () => {
  it("resolves a plain access port: native by name, allowed = untagged", () => {
    const port = { "port-name": "port3", vlan: "_default", "allowed-vlans-all": "disable",
      "allowed-vlans": [{ "vlan-name": "quarantine", q_origin_key: "quarantine" }],
      "untagged-vlans": [{ "vlan-name": "quarantine", q_origin_key: "quarantine" }] };
    expect(parseFortiswitchPortVlan(port, BY_NAME)).toEqual({ nativeVlan: 1, taggedVlans: [], trunksAllVlans: false });
  });

  it("resolves a trunk: tagged = allowed minus untagged", () => {
    const port = { "port-name": "port47", vlan: "LabProd",
      "allowed-vlans": [{ "vlan-name": "quarantine" }, { "vlan-name": "_default" }, { "vlan-name": "LabProd" }],
      "untagged-vlans": [{ "vlan-name": "LabProd" }] };
    expect(parseFortiswitchPortVlan(port, BY_NAME)).toEqual({ nativeVlan: 2, taggedVlans: [1, 4093], trunksAllVlans: false });
  });

  it("reads the datasource=1 shape the same (native as { name }, entries tagged)", () => {
    const port = { "port-name": "port3", vlan: { q_origin_key: "_default", name: "_default", datasource: "system.interface" },
      "allowed-vlans": [{ datasource: "system.interface", "vlan-name": "quarantine", q_origin_key: "quarantine" }],
      "untagged-vlans": [] };
    expect(parseFortiswitchPortVlan(port, BY_NAME)).toEqual({ nativeVlan: 1, taggedVlans: [4093], trunksAllVlans: false });
  });

  it("finds nothing without the name map — the bug this fixes", () => {
    const port = { vlan: "_default", "allowed-vlans": [{ "vlan-name": "quarantine" }] };
    expect(parseFortiswitchPortVlan(port, new Map())).toEqual({ nativeVlan: null, taggedVlans: [], trunksAllVlans: false });
  });

  it("an unknown name resolves to nothing, not a guess", () => {
    expect(parseFortiswitchPortVlan({ vlan: "gone", "allowed-vlans": [{ "vlan-name": "gone" }] }, BY_NAME))
      .toEqual({ nativeVlan: null, taggedVlans: [], trunksAllVlans: false });
  });

  it("reports allowed-vlans-all, and the legacy literal \"all\"", () => {
    expect(parseFortiswitchPortVlan({ vlan: "_default", "allowed-vlans-all": "enable", "allowed-vlans": [] }, BY_NAME).trunksAllVlans).toBe(true);
    expect(parseFortiswitchPortVlan({ "allowed-vlans": "all" }, BY_NAME)).toEqual({ nativeVlan: null, taggedVlans: [], trunksAllVlans: true });
  });
});

describe("parseFortiosVlanList — the numeric shapes older firmware sends still parse", () => {
  it("numbers, numeric strings, { vlan-id } objects and range strings", () => {
    expect(parseFortiosVlanList([10, "20", { "vlan-id": 30 }, { id: "40" }])).toEqual([10, 20, 30, 40]);
    expect(parseFortiosVlanList("10,20-22, 4094")).toEqual([10, 20, 21, 22, 4094]);
    expect(parseFortiosVlanList("all")).toEqual([]);
    expect(parseFortiosVlanList([0, 4095, "x", null])).toEqual([]);
  });
  it("a range string may mix in names when a map is given", () => {
    expect(parseFortiosVlanList("10,quarantine", BY_NAME)).toEqual([10, 4093]);
  });
});

describe("buildFortiswitchControllerPortsMap", () => {
  const SWITCHES = [
    { "switch-id": "S248EFTF00000001", sn: "S248EFTF00000001", name: "idf-1" },
    { "switch-id": "idf-2", sn: "S248EFTF00000002", name: "idf-2" },
    { "switch-id": "idf-3", sn: "S248EFTF00000003" },
  ];
  // Child-read order: trunk rows first, then physical ports in order.
  const PORTS = new Map<string, unknown[]>([
    ["S248EFTF00000001", [
      { "port-name": "_FlInK1_ICL0_", vlan: "_default", members: [{ "member-name": "port45" }] },
      { "port-name": "port3", vlan: "_default", "allowed-vlans": [{ "vlan-name": "quarantine" }], "untagged-vlans": [{ "vlan-name": "quarantine" }], description: "printer" },
      { "port-name": "port45", vlan: "_default", "isl-local-trunk-name": "_FlInK1_ICL0_", "mclag-icl-port": 1,
        "isl-peer-device-sn": "S248EFTF00000002", "isl-peer-device-name": "idf-2", "isl-peer-port-name": "port45" },
    ]],
    ["idf-2", [{ "port-name": "port1", vlan: "LabProd" }]],
    // idf-3's ports read failed: absent.
  ]);

  it("keys by serial, resolves VLANs, and keeps trunk / MCLAG / description parsing", () => {
    const map = buildFortiswitchControllerPortsMap(SWITCHES, PORTS, BY_NAME);
    expect([...map.keys()]).toEqual(["S248EFTF00000001", "S248EFTF00000002"]);
    const one = map.get("S248EFTF00000001")!;
    expect(one.vlanByPort.get("port3")).toEqual({ nativeVlan: 1, taggedVlans: [], trunksAllVlans: false });
    expect(one.trunkMembers.get("_FlInK1_ICL0_")).toEqual(["port45"]);
    expect(one.mclagPeers).toEqual([{ localPort: "port45", iclTrunk: "_FlInK1_ICL0_", peerSn: "S248EFTF00000002", peerName: "idf-2", peerPort: "port45" }]);
    expect(one.descriptionByPort.get("port3")).toBe("printer");
    // A switch whose switch-id is not its serial is still keyed by serial.
    expect(map.get("S248EFTF00000002")!.vlanByPort.get("port1")?.nativeVlan).toBe(2);
  });

  it("leaves out a switch whose ports read failed", () => {
    expect(buildFortiswitchControllerPortsMap(SWITCHES, PORTS, BY_NAME).has("S248EFTF00000003")).toBe(false);
  });
});

describe("monitoring's switch reads", () => {
  it("ask each switch's ports child table for every field the parsers read, without datasource=1", () => {
    const fields = FORTISWITCH_MONITOR_PORT_FORMAT.split("|");
    for (const f of ["port-name", "vlan", "allowed-vlans", "untagged-vlans", "allowed-vlans-all", "members", "member",
      "isl-local-trunk-name", "isl-peer-device-name", "isl-peer-device-sn", "isl-peer-port-name", "mclag-icl-port", "description"]) {
      expect(fields, f).toContain(f);
    }
    const src = monitoringServiceSource(); // monitoringService.ts + monitoring/*.ts (CQ-B061)
    expect(src).toContain("/ports?format=${FORTISWITCH_MONITOR_PORT_FORMAT}");
    expect(src).toContain('"/api/v2/cmdb/system/interface?format=name|vlanid"');
    expect(src).not.toContain("managed-switch?datasource=1");
  });
});
