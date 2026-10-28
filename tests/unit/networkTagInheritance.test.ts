/**
 * tests/unit/networkTagInheritance.test.ts
 *
 * Business rule 137, the pure half: which network tags a FortiSwitch and its
 * ports inherit. The DB half (provenance, occupied ports, the hooks) is
 * tests/integration/networkTagInheritance.test.ts.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  isInheritableNetworkTag,
  planNetworkTagInheritance,
  portCarriesVlan,
  type InheritancePort,
} from "../../src/services/networkTagInheritanceService.js";

const gate = (id: string, serial: string, hostname: string, deviceName?: string) => ({
  id,
  hostname,
  serialNumber: serial,
  assetType: "firewall",
  fortinetTopology: { role: "fortigate", ...(deviceName ? { deviceName } : {}) },
});

const sw = (id: string, controller: { serial?: string; name?: string }, via: string | null = "fortilink") => ({
  id,
  hostname: id,
  serialNumber: "S-" + id,
  assetType: "switch",
  fortinetTopology: { role: "fortiswitch", controllerSerial: controller.serial, controllerFortigate: controller.name, uplinkInterface: via },
});

const port = (assetId: string, ifName: string, nativeVlan: number | null, taggedVlans: number[] = [], trunksAllVlans = false): InheritancePort =>
  ({ assetId, ifName, nativeVlan, taggedVlans, trunksAllVlans });

const net = (vlan: number, tags: string[], serial: string | null, device: string | null = null, vlanParent: string | null = "fortilink") =>
  ({ fortigateSerial: serial, fortigateDevice: device, vlanParent, vlan, tags });

const portsOf = (plan: ReturnType<typeof planNetworkTagInheritance>, assetId: string): Record<string, string[]> =>
  Object.fromEntries([...(plan.ports.get(assetId) ?? new Map()).entries()].map(([k, v]) => [k, [...v].sort()]));

describe("isInheritableNetworkTag", () => {
  it("hands down operator tags, Priority tags included", () => {
    expect(isInheritableNetworkTag("Priority Critical")).toBe(true);
    expect(isInheritableNetworkTag("Users")).toBe(true);
  });
  it("keeps the system-managed tags and discovery's markers on the network", () => {
    for (const t of ["region:Nashville", "azure:env=prod", "dhcp-discovered", "fortimanager", "FortiGate", " "]) {
      expect(isInheritableNetworkTag(t)).toBe(false);
    }
  });
});

describe("portCarriesVlan", () => {
  it("matches the native VLAN and the tagged VLANs", () => {
    expect(portCarriesVlan(port("a", "p1", 30), 30)).toBe(true);
    expect(portCarriesVlan(port("a", "p48", 1, [30, 40]), 40)).toBe(true);
    expect(portCarriesVlan(port("a", "p1", 30), 40)).toBe(false);
  });
  it("never matches an allow-all trunk, whatever it lists", () => {
    expect(portCarriesVlan(port("a", "fortilink", 30, [30], true), 30)).toBe(false);
  });
});

describe("planNetworkTagInheritance", () => {
  const gates = [gate("g1", "FGT1", "hq-fw", "HQ-FMG-NAME"), gate("g2", "FGT2", "branch-fw")];

  it("tags the ports carrying the VLAN and their switch, per gate", () => {
    const plan = planNetworkTagInheritance({
      gates,
      switches: [sw("s1", { serial: "FGT1" }), sw("s2", { serial: "FGT2" })],
      networks: [net(30, ["Priority Critical", "dhcp-discovered", "fortigate"], "FGT1")],
      // s2 is behind the OTHER gate: same VLAN id, a different network.
      ports: [port("s1", "port1", 30), port("s1", "port2", 40), port("s2", "port1", 30)],
    });
    expect(portsOf(plan, "s1")).toEqual({ port1: ["Priority Critical"] });
    expect([...(plan.assets.get("s1") ?? [])]).toEqual(["Priority Critical"]);
    expect(plan.ports.has("s2")).toBe(false);
    expect(plan.assets.has("s2")).toBe(false);
  });

  it("gives a trunk every listed VLAN's tags, so the highest Priority is there to win", () => {
    const plan = planNetworkTagInheritance({
      gates,
      switches: [sw("s1", { serial: "FGT1" })],
      networks: [net(30, ["Priority Critical"], "FGT1"), net(40, ["Priority Warning"], "FGT1")],
      ports: [port("s1", "port48", 1, [30, 40]), port("s1", "fortilink", 1, [30, 40], true)],
    });
    expect(portsOf(plan, "s1")).toEqual({ port48: ["Priority Critical", "Priority Warning"] });
    expect([...(plan.assets.get("s1") ?? [])].sort()).toEqual(["Priority Critical", "Priority Warning"]);
  });

  it("meets a network's FMG device name and a switch's serial stamp on the same gate", () => {
    const plan = planNetworkTagInheritance({
      gates,
      switches: [sw("s1", { serial: "FGT1" })],
      // A network that predates the serial column: name only, FMG's name.
      networks: [net(30, ["Users"], null, "HQ-FMG-NAME")],
      ports: [port("s1", "port1", 30)],
    });
    expect(portsOf(plan, "s1")).toEqual({ port1: ["Users"] });
  });

  it("tells two VLAN 30s on one gate apart by the interface they sit on", () => {
    const plan = planNetworkTagInheritance({
      gates,
      switches: [sw("s1", { serial: "FGT1" }, "fortilink"), sw("s2", { serial: "FGT1" }, "FortiLink2")],
      networks: [
        net(30, ["Priority Critical"], "FGT1", null, "fortilink"),
        net(30, ["Priority Warning"], "FGT1", null, "fortilink2"),
      ],
      ports: [port("s1", "port1", 30), port("s2", "port1", 30)],
    });
    expect(portsOf(plan, "s1")).toEqual({ port1: ["Priority Critical"] });
    // Interface names compare case-insensitively.
    expect(portsOf(plan, "s2")).toEqual({ port1: ["Priority Warning"] });
  });

  it("hands nothing down while a network's parent, or a switch's management interface, is unknown", () => {
    const plan = planNetworkTagInheritance({
      gates,
      switches: [sw("s1", { serial: "FGT1" }), sw("s2", { serial: "FGT1" }, null)],
      networks: [net(30, ["Users"], "FGT1", null, null), net(40, ["Voice"], "FGT1")],
      ports: [port("s1", "port1", 30), port("s2", "port1", 40)],
    });
    expect(plan.ports.size).toBe(0);
  });

  it("hands nothing down from a network with no gate, or a gate it cannot resolve", () => {
    const plan = planNetworkTagInheritance({
      gates,
      switches: [sw("s1", { serial: "FGT1" }), sw("orphan", {})],
      networks: [net(30, ["Users"], null, null), net(30, ["Users"], "UNKNOWN")],
      ports: [port("s1", "port1", 30), port("orphan", "port1", 30)],
    });
    expect(plan.ports.size).toBe(0);
    expect(plan.assets.size).toBe(0);
  });
});
