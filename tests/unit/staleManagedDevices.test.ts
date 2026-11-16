/**
 * tests/unit/staleManagedDevices.test.ts — the own suite for
 * src/services/discovery/dhcp/staleManagedDevices.ts (syncDhcpSubnets Phase 2b, CQ-T010).
 *
 * Pins the stale FortiSwitch / FortiAP sweep body: the candidate query, the
 * per-type sightings (switch evidence never vouches for an AP and back), the
 * serial-authoritative vouch and the per-controller hostname / CMDB scope, the
 * renamed-gate judgement through the run's serial → current-name map built from
 * each device AND its HA members (rule 41(b)), the orphan clause and its
 * fleet-wide spare, maintenance release before the flip (rule 16), the infra
 * address release (rule 23), and the Events. Pure-helper edge cases ride along;
 * their main suite is syncSweepPhaseGate.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({
  releaseForDecommission: vi.fn(),
  releaseInfra: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ releaseAssetsForDecommission: m.releaseForDecommission }));
vi.mock("../../src/services/reservationService.js", () => ({ releaseInfraReservationsForAssets: m.releaseInfra }));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
const {
  decommissionStaleManagedDevices, isVouchedManagedDevice, isSightedAnywhere, resolveSweepController,
} = await import("../../src/services/discovery/dhcp/staleManagedDevices.js");

const db = {
  findMany: stubbed(prisma.asset.findMany),
  updateMany: stubbed(prisma.asset.updateMany),
};

const NOW = "2026-11-14T08:00:00.000Z";
const GATE_SERIAL = "FG100FTK20000001";

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.releaseForDecommission.mockReset().mockResolvedValue(undefined);
  m.releaseInfra.mockReset().mockResolvedValue({ released: 0, deferred: 0 });
  db.updateMany.mockResolvedValue({ count: 1 });
});

function input(over: Record<string, unknown> = {}) {
  return {
    result: { devices: [{ name: "SITE-A-FW", hostname: "fgt-a", serial: GATE_SERIAL }] } as never,
    integrationId: "i1", integrationName: "HQ FMG", integrationLabel: "FortiManager", actor: "discovery" as string | undefined,
    now: NOW, rosterJudgeable: true,
    knownDeviceNamesLc: new Set(["site-a-fw"]), knownFirewallSerials: new Set([GATE_SERIAL]),
    switchInventoriedDevices: new Set(["SITE-A-FW"]), apInventoriedDevices: new Set(["SITE-A-FW"]),
    seenSwitchSerials: new Set<string>(), seenApSerials: new Set<string>(),
    seenSwitchHostnamesByController: new Map<string, Set<string>>(), seenApHostnamesByController: new Map<string, Set<string>>(),
    cmdbSwitchSerialsByDevice: new Map<string, Set<string>>(), cmdbApSerialsByDevice: new Map<string, Set<string>>(),
    decommissionedSwitches: [] as string[], decommissionedAps: [] as string[],
    ...over,
  };
}
type Row = Record<string, any>;
const sw = (id: string, serial: string | null, topo: unknown, over: Row = {}) =>
  ({ id, hostname: `${id}-host`, serialNumber: serial, assetType: "switch", fortinetTopology: topo, status: "active", ...over });
const ap = (id: string, serial: string | null, topo: unknown, over: Row = {}) => sw(id, serial, topo, { assetType: "access_point", ...over });
const under = (name: string, serial?: string) => ({ controllerFortigate: name, ...(serial ? { controllerSerial: serial } : {}) });
const events = () => eventLog.logEvent.mock.calls.map((c) => c[0]);
const decommissionedIds = () => (db.updateMany.mock.calls[0]?.[0] as any)?.where.id.in ?? [];

describe("decommissionStaleManagedDevices — the sweep", () => {
  it("queries this integration's live switches and APs, maintenance rows included", async () => {
    db.findMany.mockResolvedValue([]);
    await decommissionStaleManagedDevices(input());
    expect(db.findMany).toHaveBeenCalledWith({
      where: { discoveredByIntegrationId: "i1", assetType: { in: ["switch", "access_point"] }, status: { not: "decommissioned" } },
      select: { id: true, hostname: true, serialNumber: true, macAddress: true, ipAddress: true, assetType: true, fortinetTopology: true, status: true },
    });
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(m.releaseForDecommission).not.toHaveBeenCalled();
    expect(m.releaseInfra).not.toHaveBeenCalled();
  });

  it("decommissions what an inventoried controller no longer reports: release holds, flip, give the address back", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S248E0001", under("SITE-A-FW")), ap("p1", null, under("SITE-A-FW"), { hostname: null })]);
    const run = input();
    await decommissionStaleManagedDevices(run);
    expect(m.releaseForDecommission).toHaveBeenCalledWith(["s1", "p1"], {
      at: new Date(NOW), actor: "discovery", statusChangedBy: "FortiManager", reason: "no longer reported by its controller",
    });
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["s1", "p1"] } },
      data: { status: "decommissioned", statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" },
    });
    expect(m.releaseInfra).toHaveBeenCalledWith(["s1", "p1"], { reason: "no longer reported by its controller", actor: "discovery" });
    const order = [m.releaseForDecommission, db.updateMany, m.releaseInfra].map((f) => f.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(run.decommissionedSwitches).toEqual(["s1-host"]);
    expect(run.decommissionedAps).toEqual(["p1"]);
    expect(events()).toEqual([
      {
        action: "asset.fortiswitch.decommissioned", resourceType: "asset", resourceId: "s1", resourceName: "s1-host", actor: "discovery",
        message: 'FortiSwitch "s1-host" decommissioned — controller "SITE-A-FW" no longer reports it',
        details: { reason: "missing-from-controller", controllerFortigate: "SITE-A-FW", integrationId: "i1", integrationName: "HQ FMG" },
      },
      // Was a bug until 2026-11-16: a nameless, serial-less AP was announced as FortiAP "null".
      expect.objectContaining({ action: "asset.fortiap.decommissioned", resourceName: "p1", message: 'FortiAP (unnamed FortiAP) decommissioned — controller "SITE-A-FW" no longer reports it' }),
    ]);
  });

  it("names a nameless, serial-less AP by its MAC, then its IP", async () => {
    db.findMany.mockResolvedValue([
      ap("p1", null, under("SITE-A-FW"), { hostname: null, macAddress: "AA:BB:CC:00:00:01" }),
      ap("p2", null, under("SITE-A-FW"), { hostname: null, ipAddress: "10.0.0.9" }),
    ]);
    await decommissionStaleManagedDevices(input());
    expect(events().map((e) => e.message)).toEqual([
      'FortiAP "AA:BB:CC:00:00:01" decommissioned — controller "SITE-A-FW" no longer reports it',
      'FortiAP "10.0.0.9" decommissioned — controller "SITE-A-FW" no longer reports it',
    ]);
  });

  it("skips a device whose controller was not inventoried this run (no fresh answer)", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S1", under("SITE-A-FW"))]);
    await decommissionStaleManagedDevices(input({ switchInventoriedDevices: new Set<string>() }));
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("uses each type's own evidence: an AP serial seen does not vouch for a switch, nor the AP inventory for switches", async () => {
    db.findMany.mockResolvedValue([sw("s1", "SHARED1", under("SITE-A-FW")), ap("p1", "SHARED1", under("SITE-A-FW"))]);
    await decommissionStaleManagedDevices(input({ seenApSerials: new Set(["SHARED1"]) }));
    expect(decommissionedIds()).toEqual(["s1"]);

    db.updateMany.mockClear();
    db.findMany.mockResolvedValue([sw("s2", "S2", under("SITE-A-FW"))]);
    await decommissionStaleManagedDevices(input({ switchInventoriedDevices: new Set<string>() }));
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("serial is authoritative: a same-named replacement never shields the dead chassis", async () => {
    db.findMany.mockResolvedValue([sw("dead", "S-DEAD", under("SITE-A-FW"), { hostname: "IDF-1" })]);
    await decommissionStaleManagedDevices(input({
      seenSwitchSerials: new Set(["S-NEW"]),
      seenSwitchHostnamesByController: new Map([["site-a-fw", new Set(["IDF-1"])]]),
    }));
    expect(decommissionedIds()).toEqual(["dead"]);
  });

  it("CMDB protection is per controller: another gate's configured serial does not spare it", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S1", under("SITE-A-FW")), sw("s2", "S2", under("SITE-A-FW"))]);
    await decommissionStaleManagedDevices(input({
      cmdbSwitchSerialsByDevice: new Map([["site-a-fw", new Set(["S1"])], ["site-b-fw", new Set(["S2"])]]),
    }));
    expect(decommissionedIds()).toEqual(["s2"]);
  });

  it("a serial-less device is vouched by its hostname only on its own controller", async () => {
    db.findMany.mockResolvedValue([sw("s1", null, under("SITE-A-FW"), { hostname: "IDF-1" }), sw("s2", null, under("SITE-A-FW"), { hostname: "IDF-2" })]);
    await decommissionStaleManagedDevices(input({
      seenSwitchHostnamesByController: new Map([["site-a-fw", new Set(["IDF-1"])], ["site-b-fw", new Set(["IDF-2"])]]),
    }));
    expect(decommissionedIds()).toEqual(["s2"]);
  });
});

describe("decommissionStaleManagedDevices — renamed gate (rule 41(b))", () => {
  it("judges under the CURRENT name and records the old one", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S1", under("OLD-NAME", GATE_SERIAL.toLowerCase()))]);
    await decommissionStaleManagedDevices(input());
    expect(events()[0]).toMatchObject({
      message: 'FortiSwitch "s1-host" decommissioned — controller "SITE-A-FW" (formerly "OLD-NAME") no longer reports it',
      details: { reason: "missing-from-controller", controllerFortigate: "SITE-A-FW", renamedFrom: "OLD-NAME" },
    });
  });

  it("resolves a stamp naming an HA member's serial to the cluster's current name", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S1", under("OLD", "FG100FMEMBER0002"))]);
    await decommissionStaleManagedDevices(input({
      result: { devices: [{ name: "SITE-A-FW", serial: GATE_SERIAL, haMembers: [{ serial: "fg100fmember0002" }, { serial: "" }] }] },
    }));
    expect(events()[0].details).toMatchObject({ controllerFortigate: "SITE-A-FW", renamedFrom: "OLD" });
  });

  it("falls back to the device hostname when FMG gave no name, and ignores a nameless device", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S1", under("OLD", "FGSERIALHOST0001")), sw("s2", "S2", under("OLD2", "FGSERIALNONE0001"))]);
    await decommissionStaleManagedDevices(input({
      result: { devices: [{ name: "", hostname: "fgt-host", serial: "FGSERIALHOST0001" }, { serial: "FGSERIALNONE0001" }] },
      switchInventoriedDevices: new Set(["fgt-host"]),
      rosterJudgeable: false,
    }));
    expect(decommissionedIds()).toEqual(["s1"]);
    expect(events()[0].details).toMatchObject({ controllerFortigate: "fgt-host", renamedFrom: "OLD" });
  });

  it("no renamedFrom when the stamp already carries the current name", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S1", under("SITE-A-FW", GATE_SERIAL))]);
    await decommissionStaleManagedDevices(input());
    expect(events()[0].details).not.toHaveProperty("renamedFrom");
    expect(events()[0].message).not.toContain("formerly");
  });
});

describe("decommissionStaleManagedDevices — orphans", () => {
  it("decommissions a device whose controller is gone under every identity, on a whole-roster run", async () => {
    db.findMany.mockResolvedValue([ap("p1", "AP1", under("GONE-FW", "FGGONE0000000001"))]);
    const run = input();
    await decommissionStaleManagedDevices(run);
    expect(events()).toEqual([{
      action: "asset.fortiap.decommissioned", resourceType: "asset", resourceId: "p1", resourceName: "p1-host", actor: "discovery",
      message: 'FortiAP "p1-host" decommissioned — its controller "GONE-FW" is no longer in "HQ FMG"',
      details: { reason: "controller-not-in-roster", controllerFortigate: "GONE-FW", integrationId: "i1", integrationName: "HQ FMG" },
    }]);
    expect(run.decommissionedAps).toEqual(["p1-host"]);
    expect(m.releaseInfra).toHaveBeenCalledWith(["p1"], expect.anything());
  });

  it("names a serial-only orphan by its stamped serial", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S1", { controllerSerial: "fggone0000000001" })]);
    await decommissionStaleManagedDevices(input());
    expect(events()[0].details).toMatchObject({ reason: "controller-not-in-roster", controllerFortigate: "FGGONE0000000001" });
  });

  it("spares an orphan any gate still reports live or in its CMDB, and one whose controller is still on the roster", async () => {
    db.findMany.mockResolvedValue([
      sw("live", "S-LIVE", under("GONE-FW")),
      sw("cmdb", "S-CMDB", under("GONE-FW")),
      sw("byName", null, under("GONE-FW"), { hostname: "IDF-9" }),
      sw("rosterName", "S-R1", under("Site-B-FW")),
      sw("rosterSerial", "S-R2", under("WHATEVER", "FGBSERIAL0000001")),
      sw("noStamp", "S-N", null),
    ]);
    await decommissionStaleManagedDevices(input({
      knownDeviceNamesLc: new Set(["site-a-fw", "site-b-fw"]),
      knownFirewallSerials: new Set([GATE_SERIAL, "FGBSERIAL0000001"]),
      seenSwitchSerials: new Set(["S-LIVE"]),
      cmdbSwitchSerialsByDevice: new Map([["other-gw", new Set(["S-CMDB"])]]),
      seenSwitchHostnamesByController: new Map([["other-gw", new Set(["IDF-9"])]]),
    }));
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("holds the orphan clause off when the run did not read the whole roster", async () => {
    db.findMany.mockResolvedValue([sw("s1", "S1", under("GONE-FW"))]);
    await decommissionStaleManagedDevices(input({ rosterJudgeable: false }));
    expect(db.updateMany).not.toHaveBeenCalled();
  });
});

describe("staleManagedDevices pure helpers — edge cases", () => {
  const sightings = (over: Partial<Record<string, unknown>> = {}) => ({
    seenSerials: new Set<string>(), seenHostnamesByController: new Map<string, Set<string>>(), cmdbSerialsByController: new Map<string, Set<string>>(),
    ...over,
  }) as never;

  it("isVouchedManagedDevice keys the controller lower-case; a device with neither serial nor hostname is never vouched", () => {
    expect(isVouchedManagedDevice({ serialNumber: "S1", hostname: null }, "SITE-A-FW",
      sightings({ cmdbSerialsByController: new Map([["site-a-fw", new Set(["S1"])]]) }))).toBe(true);
    expect(isVouchedManagedDevice({ serialNumber: null, hostname: null }, "SITE-A-FW",
      sightings({ seenHostnamesByController: new Map([["site-a-fw", new Set([""])]]) }))).toBe(false);
  });

  it("isSightedAnywhere: a serial device ignores hostname evidence; a bare device is never sighted", () => {
    expect(isSightedAnywhere({ serialNumber: "S1", hostname: "IDF-1" },
      sightings({ seenHostnamesByController: new Map([["x", new Set(["IDF-1"])]]) }))).toBe(false);
    expect(isSightedAnywhere({ serialNumber: null, hostname: null }, sightings())).toBe(false);
  });

  it("resolveSweepController: a stamp with neither name nor serial is skipped even on a whole-roster run", () => {
    expect(resolveSweepController({ controllerFortigate: "  " }, {
      inventoried: new Set(), currentNameBySerial: new Map(), rosterJudgeable: true, rosterNamesLc: new Set(), rosterSerialsUc: new Set(),
    })).toEqual({ kind: "skip" });
  });
});
