/**
 * tests/unit/connectionPathService.test.ts — CQ-T010 own suite for
 * src/services/connectionPathService.ts (`resolveConnectionPath`).
 *
 * The asset table is in memory and `findMany` honours the where shapes the
 * service builds (`hostname` / `serialNumber` OR for the endpoint's switch,
 * `parentAssetWhereOr` for a topology stamp), so the real `fortinetParentKey`
 * precedence runs. `AssetDependencyParent` rows are served per child id.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { resolveConnectionPath } from "../../src/services/connectionPathService.js";

type A = {
  id: string; hostname: string | null; serialNumber: string | null; ipAddress: string | null; macAddress: string | null;
  assetType: string; monitorStatus: string | null; monitored: boolean; lastMonitorAt: Date | null;
  fortinetTopology: Record<string, unknown> | null; lastSeenSwitch: string | null;
};
const a = (id: string, assetType: string, extra: Partial<A> = {}): A => ({
  id, hostname: id, serialNumber: null, ipAddress: null, macAddress: null, assetType,
  monitorStatus: "up", monitored: true, lastMonitorAt: null, fortinetTopology: null, lastSeenSwitch: null, ...extra,
});

function matches(r: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!(v as Array<Record<string, unknown>>).some((w) => matches(r, w))) return false;
    } else if (k === "fortinetTopology") {
      const { path, equals } = v as { path: string[]; equals: unknown };
      const t = r.fortinetTopology as Record<string, unknown> | null;
      if (!t || t[path[0]] !== equals) return false;
    } else if (r[k] !== v) {
      return false;
    }
  }
  return true;
}

let table: A[];
let deps: Array<{ assetId: string; parentId: string; source: string }>;

const findUnique = stubbed(prisma.asset.findUnique);
const findMany = stubbed(prisma.asset.findMany);
const depFind = stubbed(prisma.assetDependencyParent.findMany);
const macFind = stubbed(prisma.assetMacTableEntry.findMany);
const sightFind = stubbed(prisma.assetFortigateSighting.findMany);

beforeEach(() => {
  resetDbStub();
  table = [];
  deps = [];
  findUnique.mockImplementation(async (args: { where: { id: string } }) => table.find((r) => r.id === args.where.id) ?? null);
  findMany.mockImplementation(async (args: { where: Record<string, unknown> }) => table.filter((r) => matches(r, args.where)));
  depFind.mockImplementation(async (args: { where: { assetId: string } }) =>
    deps.filter((d) => d.assetId === args.where.assetId).map((d) => ({ ...d, parent: table.find((r) => r.id === d.parentId)! })));
  macFind.mockResolvedValue([]);
  sightFind.mockResolvedValue([]);
});

const ids = (p: { hops: Array<{ id: string }> } | null) => p!.hops.map((h) => h.id);

describe("resolveConnectionPath — start cases", () => {
  it("returns null for a missing asset", async () => {
    expect(await resolveConnectionPath("nope")).toBeNull();
  });

  it("short-circuits a firewall: hops = [self], siteId = self, no walk", async () => {
    table = [a("fgt", "firewall", { ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:00:00:01" })];
    const out = await resolveConnectionPath("fgt");
    expect(out).toEqual({
      asset: { id: "fgt", hostname: "fgt", ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:00:00:01", assetType: "firewall", monitorStatus: "up" },
      hops: [{ kind: "firewall", id: "fgt", hostname: "fgt", ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:00:00:01", assetType: "firewall", monitorStatus: "up", monitored: true }],
      alternateUplinks: 0,
      siteId: "fgt",
    });
    expect(depFind).not.toHaveBeenCalled();
  });

  it("walks an endpoint through its lastSeenSwitch switch (port + uplink) to the gate", async () => {
    table = [
      a("ep", "workstation", { lastSeenSwitch: " IDF-1 / port12 " }),
      a("sw", "switch", { hostname: "IDF-1", fortinetTopology: { uplinkInterface: "port49" } }),
      a("fgt", "firewall"),
    ];
    deps = [{ assetId: "sw", parentId: "fgt", source: "computed" }];
    const out = await resolveConnectionPath("ep");
    expect(ids(out)).toEqual(["ep", "sw", "fgt"]);
    expect(out!.hops[0].kind).toBe("endpoint");
    expect(out!.hops[1]).toMatchObject({ kind: "switch", endpointPort: "port12", uplinkInterface: "port49" });
    expect(out!.hops[2].kind).toBe("firewall");
    expect(out!.siteId).toBe("fgt");
    expect(out!.alternateUplinks).toBe(0);
  });

  it("resolves the endpoint's switch by serial, and omits the port when none was stamped", async () => {
    table = [a("ep", "printer", { lastSeenSwitch: "S108F0000001" }), a("sw", "switch", { hostname: "X", serialNumber: "S108F0000001" })];
    const out = await resolveConnectionPath("ep");
    expect(ids(out)).toEqual(["ep", "sw"]);
    expect(out!.hops[1]).not.toHaveProperty("endpointPort");
    expect(out!.siteId).toBeNull();
  });

  it("an endpoint with no lastSeenSwitch, or one naming no switch, is a one-hop orphan", async () => {
    table = [a("ep", "workstation")];
    expect(await resolveConnectionPath("ep")).toMatchObject({ hops: [{ id: "ep" }], siteId: null });
    expect(depFind).not.toHaveBeenCalled();

    table = [a("ep", "workstation", { lastSeenSwitch: "GONE/port1" }), a("fgt", "firewall", { hostname: "GONE" })];
    // A firewall carrying the name is not a switch.
    expect(ids(await resolveConnectionPath("ep"))).toEqual(["ep"]);
  });

  it("starts a switch's walk at itself, with its uplink on hop 0", async () => {
    table = [a("sw", "switch", { fortinetTopology: { uplinkInterface: "x1" } }), a("fgt", "firewall")];
    deps = [{ assetId: "sw", parentId: "fgt", source: "computed" }];
    const out = await resolveConnectionPath("sw");
    expect(out!.hops[0]).toMatchObject({ kind: "switch", uplinkInterface: "x1" });
    expect(ids(out)).toEqual(["sw", "fgt"]);
  });

  it("gives an AP a switch-kind leaf hop", async () => {
    table = [a("ap", "access_point")];
    expect((await resolveConnectionPath("ap"))!.hops[0].kind).toBe("switch");
  });
});

describe("resolveConnectionPath — a switch name several devices share (rule 91)", () => {
  const fleet = () => [
    a("gA", "firewall", { serialNumber: "FGTA" }),
    a("gB", "firewall", { serialNumber: "FGTB", hostname: "GATE-B" }),
    a("swA", "switch", { hostname: "IDF-1", fortinetTopology: { controllerSerial: "FGTA" } }),
    a("swB", "switch", { hostname: "IDF-1", fortinetTopology: { controllerSerial: "FGTB" } }),
  ];

  it("prefers the switch whose MAC table holds the endpoint", async () => {
    table = [a("ep", "workstation", { lastSeenSwitch: "IDF-1/port1" }), ...fleet()];
    macFind.mockResolvedValue([{ assetId: "swB" }]);
    // ...and on through swB's controller stamp (no dependency rows) to gate B.
    expect(ids(await resolveConnectionPath("ep"))).toEqual(["ep", "swB", "gB"]);
    expect(macFind.mock.calls[0][0].where).toMatchObject({ matchedAssetId: "ep", status: "learned" });
  });

  it("settles by the gate that sighted the endpoint, freshest first", async () => {
    table = [a("ep", "workstation", { lastSeenSwitch: "IDF-1/port1" }), ...fleet()];
    sightFind.mockResolvedValue([{ fortigateDevice: "GATE-B" }, { fortigateDevice: "gA" }]);
    expect(ids(await resolveConnectionPath("ep"))).toEqual(["ep", "swB", "gB"]);
    expect(sightFind.mock.calls[0][0]).toMatchObject({ where: { assetId: "ep", NOT: { fortigateDevice: "" } }, orderBy: { lastSeen: "desc" } });
  });

  it("adds no switch hop when nothing decides — never the first row", async () => {
    table = [a("ep", "workstation", { lastSeenSwitch: "IDF-1/port1" }), ...fleet()];
    expect(ids(await resolveConnectionPath("ep"))).toEqual(["ep"]);
  });
});

describe("resolveConnectionPath — the upward walk", () => {
  it("prefers override parents over computed ones", async () => {
    table = [a("sw", "switch"), a("fgtC", "firewall"), a("fgtO", "firewall")];
    deps = [
      { assetId: "sw", parentId: "fgtC", source: "computed" },
      { assetId: "sw", parentId: "fgtO", source: "override" },
    ];
    expect(ids(await resolveConnectionPath("sw"))).toEqual(["sw", "fgtO"]);
  });

  it("picks the up parent with the newest lastMonitorAt among MCLAG peers and sums the alternates across hops", async () => {
    table = [
      a("sw", "switch"),
      a("coreDown", "switch", { monitorStatus: "down", lastMonitorAt: new Date("2026-11-14T00:00:09Z") }),
      a("coreOld", "switch", { lastMonitorAt: new Date("2026-11-14T00:00:01Z") }),
      a("coreNew", "switch", { lastMonitorAt: new Date("2026-11-14T00:00:05Z") }),
      a("fgt1", "firewall"),
      a("fgt2", "firewall", { lastMonitorAt: new Date("2026-11-14T00:00:00Z") }),
    ];
    deps = [
      { assetId: "sw", parentId: "coreDown", source: "computed" },
      { assetId: "sw", parentId: "coreOld", source: "computed" },
      { assetId: "sw", parentId: "coreNew", source: "computed" },
      { assetId: "coreNew", parentId: "fgt1", source: "computed" },
      { assetId: "coreNew", parentId: "fgt2", source: "computed" },
    ];
    const out = await resolveConnectionPath("sw");
    expect(ids(out)).toEqual(["sw", "coreNew", "fgt2"]);
    expect(out!.alternateUplinks).toBe(3);
    expect(out!.siteId).toBe("fgt2");
  });

  it("ignores non-computed, non-override rows and falls through to the topology stamp", async () => {
    table = [a("sw", "switch", { fortinetTopology: { controllerSerial: "FGT1" } }), a("v", "firewall"), a("fgt", "firewall", { serialNumber: "FGT1" })];
    deps = [{ assetId: "sw", parentId: "v", source: "vcenter" }];
    expect(ids(await resolveConnectionPath("sw"))).toEqual(["sw", "fgt"]);
  });

  it("stops on a cycle", async () => {
    table = [a("s1", "switch"), a("s2", "switch")];
    deps = [
      { assetId: "s1", parentId: "s2", source: "computed" },
      { assetId: "s2", parentId: "s1", source: "computed" },
    ];
    const out = await resolveConnectionPath("s1");
    expect(ids(out)).toEqual(["s1", "s2"]);
    expect(out!.siteId).toBeNull();
  });

  it("caps the walk at 16 hops above the start", async () => {
    table = Array.from({ length: 30 }, (_, i) => a(`s${i}`, "switch"));
    deps = Array.from({ length: 29 }, (_, i) => ({ assetId: `s${i}`, parentId: `s${i + 1}`, source: "computed" }));
    const out = await resolveConnectionPath("s0");
    expect(out!.hops).toHaveLength(17);
    expect(out!.siteId).toBeNull();
  });
});

describe("resolveConnectionPath — fortinetTopology fallback", () => {
  it("jumps a switch with no dependency rows to its controller gate, via the FMG device name", async () => {
    table = [
      a("sw", "switch", { fortinetTopology: { controllerFortigate: "BRANCH" } }),
      a("fgt", "firewall", { hostname: "other", fortinetTopology: { deviceName: "BRANCH" } }),
    ];
    const out = await resolveConnectionPath("sw");
    expect(ids(out)).toEqual(["sw", "fgt"]);
    expect(out!.siteId).toBe("fgt");
  });

  it("hops an AP to its parentSwitch, then that switch to its controller", async () => {
    table = [
      a("ap", "access_point", { fortinetTopology: { parentSwitch: "IDF-1", controllerSerial: "FGT1" } }),
      a("sw", "switch", { hostname: "IDF-1", fortinetTopology: { controllerSerial: "FGT1" } }),
      a("fgt", "firewall", { serialNumber: "FGT1" }),
    ];
    const out = await resolveConnectionPath("ap");
    expect(ids(out)).toEqual(["ap", "sw", "fgt"]);
    expect(out!.hops.map((h) => h.kind)).toEqual(["switch", "switch", "firewall"]);
  });

  it("jumps an AP with no parentSwitch straight to its controller", async () => {
    table = [a("ap", "access_point", { fortinetTopology: { controllerSerial: "FGT1" } }), a("fgt", "firewall", { serialNumber: "FGT1" })];
    expect(ids(await resolveConnectionPath("ap"))).toEqual(["ap", "fgt"]);
  });

  it("ends the walk when the stamp names nothing in inventory", async () => {
    table = [a("sw", "switch", { fortinetTopology: { controllerSerial: "MISSING" } })];
    expect(await resolveConnectionPath("sw")).toMatchObject({ hops: [{ id: "sw" }], siteId: null });
  });

  // BUG: the service contract says "`uplinkInterface` lives on every switch / AP
  // hop (from fortinetTopology.uplinkInterface)". A switch reached through the
  // fortinetTopology FALLBACK (an AP with no dependency rows whose parentSwitch
  // is IDF-1, IDF-1 stamped uplinkInterface "port49") is pushed without it —
  // hops[1].uplinkInterface is undefined; it should be "port49", as it is when
  // the same switch is reached through AssetDependencyParent.
  it.fails("puts the uplink on a switch hop reached through the topology fallback", async () => {
    table = [
      a("ap", "access_point", { fortinetTopology: { parentSwitch: "IDF-1" } }),
      a("sw", "switch", { hostname: "IDF-1", fortinetTopology: { uplinkInterface: "port49" } }),
    ];
    const out = await resolveConnectionPath("ap");
    expect(out!.hops[1]).toMatchObject({ id: "sw", uplinkInterface: "port49" });
  });

  // BUG: an AP whose parentSwitch names a switch Polaris does not hold (a
  // third-party switch its LLDP table reported) never reaches the controller
  // fallback: resolveTopologyFallback returns the null from the parentSwitch
  // branch, so AP {parentSwitch: "CISCO-3850", controllerSerial: "FGT1"} with
  // FGT1 in inventory yields hops [ap], siteId null. It should fall through to
  // the controller and yield [ap, fgt], siteId "fgt".
  it.fails("falls through to the AP's controller when its parentSwitch resolves to nothing", async () => {
    table = [
      a("ap", "access_point", { fortinetTopology: { parentSwitch: "CISCO-3850", controllerSerial: "FGT1" } }),
      a("fgt", "firewall", { serialNumber: "FGT1" }),
    ];
    const out = await resolveConnectionPath("ap");
    expect(ids(out)).toEqual(["ap", "fgt"]);
    expect(out!.siteId).toBe("fgt");
  });
});
