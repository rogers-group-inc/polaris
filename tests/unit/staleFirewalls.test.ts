/**
 * tests/unit/staleFirewalls.test.ts — the own suite for
 * src/services/discovery/dhcp/staleFirewalls.ts (syncDhcpSubnets Phase 2a, CQ-T010).
 *
 * The pure roster decisions keep their own suites (rosterFirewallReplaced,
 * haStandbyRosterIdentity, syncSweepPhaseGate); this file pins the phase body:
 * the candidate query, the missing-from-roster and chassis-replaced (rule 41(a))
 * Events, maintenance release before the status flip (rule 16), the in-memory
 * index sync, the controller cascade to switches / APs and its infra address
 * release (rule 23), and the scoped-run narrowing (rule 142). A handful of
 * edge cases for the exported pure helpers ride along.
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
  decommissionStaleFirewalls, cascadeControllerOf, firewallNamedForScopedGate, judgeRosterFirewall,
} = await import("../../src/services/discovery/dhcp/staleFirewalls.js");

const db = {
  findMany: stubbed(prisma.asset.findMany),
  updateMany: stubbed(prisma.asset.updateMany),
};

const NOW = "2026-11-14T08:00:00.000Z";
const SERIAL_A = "FGT60FAAA0000001";
const SERIAL_GONE = "FGT60FGONE000001";

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.releaseForDecommission.mockReset().mockResolvedValue(undefined);
  m.releaseInfra.mockReset().mockResolvedValue({ released: 0, deferred: 0 });
  db.updateMany.mockResolvedValue({ count: 1 });
});

type Row = Record<string, any>;
function index(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id as string, r]));
  return { findById: vi.fn((id: string) => byId.get(id)) };
}

function input(over: Record<string, unknown> = {}) {
  return {
    integrationId: "i1", integrationName: "HQ FMG", integrationLabel: "FortiManager", actor: "discovery" as string | undefined,
    now: NOW, scopedRun: false,
    knownDeviceNamesLc: new Set(["site-a-fw"]), knownFirewallSerials: new Set([SERIAL_A]),
    haRosterPublished: new Set<string>(), clusterSerialsByDevice: new Map<string, Set<string>>(),
    assetIdx: index([]) as never, decommissionedSwitches: [] as string[], decommissionedAps: [] as string[],
    ...over,
  };
}
const fw = (id: string, hostname: string | null, serial: string | null, topo: unknown = null) =>
  ({ id, hostname, serialNumber: serial, fortinetTopology: topo });
const child = (id: string, assetType: "switch" | "access_point", controller: string | null, over: Row = {}) =>
  ({ id, hostname: `${id}-host`, serialNumber: `${id}-SN`, assetType, fortinetTopology: controller === null ? null : { controllerFortigate: controller }, ...over });

/** First findMany = firewalls, second = cascade candidates. */
function seed(firewalls: Row[], children: Row[] = []) {
  db.findMany.mockResolvedValueOnce(firewalls).mockResolvedValueOnce(children);
}

const events = () => eventLog.logEvent.mock.calls.map((c) => c[0]);

describe("decommissionStaleFirewalls — candidate query", () => {
  it("judges this integration's non-decommissioned firewalls, maintenance-window rows included", async () => {
    seed([]);
    await decommissionStaleFirewalls(input());
    expect(db.findMany).toHaveBeenCalledTimes(1);
    expect(db.findMany.mock.calls[0][0]).toEqual({
      where: { discoveredByIntegrationId: "i1", assetType: "firewall", status: { not: "decommissioned" } },
      select: { id: true, hostname: true, serialNumber: true, fortinetTopology: true },
    });
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(m.releaseForDecommission).not.toHaveBeenCalled();
  });

  it("does nothing when every firewall is still on the roster (by serial, case-insensitively, or by name)", async () => {
    seed([
      fw("f1", "whatever", SERIAL_A.toLowerCase()),
      fw("f2", "SITE-A-FW", null),
      fw("f3", "renamed-host", "FGT60FOTHER00001", { deviceName: "Site-A-FW" }),
    ]);
    await decommissionStaleFirewalls(input());
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    // No stale gate, so the cascade query never runs.
    expect(db.findMany).toHaveBeenCalledTimes(1);
  });

  it("never judges a row with nothing to identify it by (no hostname, no FMG device name)", async () => {
    seed([fw("f1", null, SERIAL_GONE), fw("f2", "", null)]);
    await decommissionStaleFirewalls(input());
    expect(db.updateMany).not.toHaveBeenCalled();
  });

  it("protects the standby of a cluster whose roster nobody read this run", async () => {
    seed([fw("sb", "fgt-b", "FGT60FSTBY000001", { haRole: "secondary", haPeerSerial: SERIAL_A.toLowerCase() })]);
    await decommissionStaleFirewalls(input());
    expect(db.updateMany).not.toHaveBeenCalled();
  });
});

describe("decommissionStaleFirewalls — missing from the roster", () => {
  it("releases maintenance, flips the status, and audits each gone gate", async () => {
    seed([fw("f1", "GONE-FW", SERIAL_GONE), fw("f2", null, null, { deviceName: "x" }), fw("f3", "other-gone", null)]);
    const run = input();
    await decommissionStaleFirewalls(run);
    expect(m.releaseForDecommission).toHaveBeenCalledWith(["f1", "f2", "f3"], {
      at: new Date(NOW), actor: "discovery", statusChangedBy: "FortiManager", reason: 'no longer configured in "HQ FMG"',
    });
    expect(db.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["f1", "f2", "f3"] } },
      data: { status: "decommissioned", statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" },
    });
    // Maintenance is closed BEFORE the status flip, so the 30s reconcile cannot re-flip it.
    expect(m.releaseForDecommission.mock.invocationCallOrder[0]).toBeLessThan(db.updateMany.mock.invocationCallOrder[0]);
    expect(events()).toEqual([
      {
        action: "asset.fortigate.decommissioned", resourceType: "asset", resourceId: "f1", resourceName: "GONE-FW", actor: "discovery",
        message: 'FortiGate "GONE-FW" decommissioned — no longer configured in "HQ FMG"',
        details: { reason: "missing-from-roster", integrationId: "i1", integrationName: "HQ FMG" },
      },
      // Was a bug until 2026-11-16: a gate with no hostname was kept forever even when its FMG device name had left the roster.
      expect.objectContaining({
        resourceId: "f2", resourceName: "x",
        message: 'FortiGate "x" decommissioned — no longer configured in "HQ FMG"',
      }),
      expect.objectContaining({ resourceId: "f3", resourceName: "other-gone" }),
    ]);
  });

  it("cascades a hostname-less gate's switches and APs by its FMG device name", async () => {
    seed([fw("f1", null, SERIAL_GONE, { deviceName: "Branch-FW" })], [
      child("sw1", "switch", "BRANCH-FW"),
      child("sw2", "switch", "site-a-fw"),
    ]);
    const run = input();
    await decommissionStaleFirewalls(run);
    expect(events()[0]).toMatchObject({ resourceId: "f1", resourceName: "Branch-FW" });
    expect(run.decommissionedSwitches).toEqual(["sw1-host"]);
    expect(db.updateMany).toHaveBeenLastCalledWith({
      where: { id: { in: ["sw1"] } },
      data: { status: "decommissioned", statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" },
    });
  });

  it("keeps the run's in-memory index in step so Phase 3 can resurrect the row", async () => {
    const rows = [{ id: "f1", status: "active" }, { id: "f9", status: "active" }];
    seed([fw("f1", "GONE-FW", SERIAL_GONE)]);
    await decommissionStaleFirewalls(input({ assetIdx: index(rows) }));
    expect(rows).toEqual([{ id: "f1", status: "decommissioned" }, { id: "f9", status: "active" }]);
  });

  it("tolerates a decommissioned id missing from the index", async () => {
    seed([fw("f1", "GONE-FW", SERIAL_GONE)]);
    await expect(decommissionStaleFirewalls(input({ assetIdx: index([]) }))).resolves.toBeUndefined();
    expect(db.updateMany).toHaveBeenCalledTimes(1);
  });

  it("passes an undefined actor through to the release and the Event", async () => {
    seed([fw("f1", "GONE-FW", SERIAL_GONE)]);
    await decommissionStaleFirewalls(input({ actor: undefined }));
    expect(m.releaseForDecommission.mock.calls[0][1].actor).toBeUndefined();
    expect(events()[0].actor).toBeUndefined();
  });
});

describe("decommissionStaleFirewalls — chassis replaced (rule 41(a))", () => {
  it("retires the old chassis with both serials in the Event, and does not cascade", async () => {
    seed(
      [fw("old", "site-a-fw", "fgt60fold0000001")],
      [child("sw1", "switch", "SITE-A-FW"), child("ap1", "access_point", "site-a-fw")],
    );
    const run = input({
      knownFirewallSerials: new Set(["FGT60FNEW0000002", "FGT60FNEW0000001"]),
      clusterSerialsByDevice: new Map([["site-a-fw", new Set(["FGT60FNEW0000002", "FGT60FNEW0000001"])]]),
    });
    await decommissionStaleFirewalls(run);
    expect(events()).toEqual([{
      action: "asset.fortigate.decommissioned", resourceType: "asset", resourceId: "old", resourceName: "site-a-fw", actor: "discovery",
      message: 'FortiGate "site-a-fw" (serial FGT60FOLD0000001) decommissioned — "HQ FMG" now reports chassis FGT60FNEW0000001, FGT60FNEW0000002 under that name',
      details: {
        reason: "chassis-replaced", oldSerial: "FGT60FOLD0000001", newSerials: ["FGT60FNEW0000001", "FGT60FNEW0000002"],
        integrationId: "i1", integrationName: "HQ FMG",
      },
    }]);
    expect(db.updateMany).toHaveBeenCalledTimes(1);
    expect(run.decommissionedSwitches).toEqual([]);
    expect(run.decommissionedAps).toEqual([]);
    expect(m.releaseInfra).not.toHaveBeenCalled();
  });

  it("keeps a named gate whose chassis nobody read this run (absence of evidence)", async () => {
    seed([fw("old", "site-a-fw", "FGT60FOLD0000001")]);
    await decommissionStaleFirewalls(input({ clusterSerialsByDevice: new Map([["site-a-fw", new Set<string>()]]) }));
    expect(db.updateMany).not.toHaveBeenCalled();
  });
});

describe("decommissionStaleFirewalls — controller cascade", () => {
  it("takes the gone gate's switches and APs with it, case-insensitively, and gives their addresses back", async () => {
    const idxRows = [{ id: "sw1", status: "maintenance" }, { id: "ap1", status: "active" }];
    seed([fw("f1", "Gone-FW", SERIAL_GONE)], [
      child("sw1", "switch", "GONE-FW"),
      child("ap1", "access_point", "gone-fw", { hostname: null }),
      child("ap2", "access_point", null, { hostname: null, serialNumber: null }),
      child("sw2", "switch", "SITE-A-FW"),
    ]);
    const run = input({ assetIdx: index(idxRows) });
    await decommissionStaleFirewalls(run);

    expect(db.findMany.mock.calls[1][0]).toEqual({
      where: { discoveredByIntegrationId: "i1", assetType: { in: ["switch", "access_point"] }, status: { not: "decommissioned" } },
      select: { id: true, hostname: true, serialNumber: true, assetType: true, fortinetTopology: true },
    });
    expect(m.releaseForDecommission).toHaveBeenNthCalledWith(2, ["sw1", "ap1"], {
      at: new Date(NOW), actor: "discovery", statusChangedBy: "FortiManager", reason: "its controller FortiGate was decommissioned",
    });
    expect(db.updateMany).toHaveBeenNthCalledWith(2, {
      where: { id: { in: ["sw1", "ap1"] } },
      data: { status: "decommissioned", statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" },
    });
    expect(m.releaseInfra).toHaveBeenCalledWith(["sw1", "ap1"], { reason: "controller FortiGate decommissioned", actor: "discovery" });
    expect(run.decommissionedSwitches).toEqual(["sw1-host"]);
    expect(run.decommissionedAps).toEqual(["ap1-SN"]);
    expect(idxRows.map((r) => r.status)).toEqual(["decommissioned", "decommissioned"]);
    const childEvents = events().slice(1);
    expect(childEvents).toEqual([
      {
        action: "asset.fortiswitch.decommissioned", resourceType: "asset", resourceId: "sw1", resourceName: "sw1-host", actor: "discovery",
        message: 'FortiSwitch "sw1-host" decommissioned — its controller FortiGate "GONE-FW" was decommissioned',
        details: { reason: "controller-decommissioned", controllerFortigate: "GONE-FW", integrationId: "i1", integrationName: "HQ FMG" },
      },
      expect.objectContaining({
        action: "asset.fortiap.decommissioned", resourceName: "ap1-SN",
        message: 'FortiAP "ap1-SN" decommissioned — its controller FortiGate "gone-fw" was decommissioned',
      }),
    ]);
  });

  it("runs the cascade query but writes nothing when no child names a gone gate", async () => {
    seed([fw("f1", "GONE-FW", SERIAL_GONE)], [child("sw2", "switch", "SITE-A-FW")]);
    await decommissionStaleFirewalls(input());
    expect(db.findMany).toHaveBeenCalledTimes(2);
    expect(db.updateMany).toHaveBeenCalledTimes(1);
    expect(m.releaseForDecommission).toHaveBeenCalledTimes(1);
    expect(m.releaseInfra).not.toHaveBeenCalled();
  });

  it("a mixed run cascades only from the gate that LEFT the roster, not the replaced chassis", async () => {
    seed(
      [fw("gone", "GONE-FW", SERIAL_GONE), fw("old", "site-a-fw", "FGT60FOLD0000001")],
      [child("swGone", "switch", "GONE-FW"), child("swA", "switch", "site-a-fw")],
    );
    const run = input({ clusterSerialsByDevice: new Map([["site-a-fw", new Set([SERIAL_A])]]) });
    await decommissionStaleFirewalls(run);
    expect(db.updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["gone", "old"] } });
    expect(db.updateMany.mock.calls[1][0].where).toEqual({ id: { in: ["swGone"] } });
    expect(run.decommissionedSwitches).toEqual(["swGone-host"]);
  });

  // Was a bug until 2026-11-14: the cascade matches each child's `controllerFortigate` (FortiManager's
  // DEVICE name) against the stale gate's `Asset.hostname` only — the mismatch
  // CLAUDE.md's coding conventions forbid. A gate whose FMG name ("BRANCH-12")
  // differs from its configured hostname ("fgt-branch12") leaves the roster
  // (neither name is on it, so it IS decommissioned), but its switch stamped
  // `controllerFortigate: "BRANCH-12"` is never cascaded and stays "active"
  // forever (ghost infra; Phase 2b never judges it either, since the gate is
  // never inventoried again — though its orphan clause may catch it on a later
  // full run). Right: the switch is cascaded — the gate's
  // `fortinetTopology.deviceName` must be in the cascade's name set.
  it("cascades to a child that stamps the gone gate's FortiManager device name, not its hostname", async () => {
    seed(
      [fw("f1", "fgt-branch12", SERIAL_GONE, { deviceName: "BRANCH-12" })],
      [child("sw1", "switch", "BRANCH-12")],
    );
    const run = input();
    await decommissionStaleFirewalls(run);
    expect(db.updateMany).toHaveBeenCalledTimes(2);
    expect(run.decommissionedSwitches).toEqual(["sw1-host"]);
  });
});

describe("decommissionStaleFirewalls — scoped run (rule 142)", () => {
  it("never decommissions a roster-absent gate, scoped or not named for the scope", async () => {
    seed([fw("f1", "GONE-FW", SERIAL_GONE), fw("f2", "elsewhere", "FGT60FELSE000001")]);
    await decommissionStaleFirewalls(input({
      scopedRun: true, clusterSerialsByDevice: new Map([["gone-fw", new Set([SERIAL_GONE])]]),
    }));
    expect(db.updateMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("acts on the scoped gate's replaced chassis, matched through its FMG device name", async () => {
    seed([fw("old", "local-hostname", "FGT60FOLD0000001", { deviceName: "SITE-A-FW" })], []);
    await decommissionStaleFirewalls(input({
      scopedRun: true, clusterSerialsByDevice: new Map([["site-a-fw", new Set([SERIAL_A])]]),
    }));
    expect(db.updateMany).toHaveBeenCalledTimes(1);
    expect(events()[0].details).toMatchObject({ reason: "chassis-replaced", oldSerial: "FGT60FOLD0000001" });
    expect(m.releaseInfra).not.toHaveBeenCalled();
  });

  it("leaves a firewall not named for the scoped gate alone even when it would read replaced", async () => {
    seed([fw("other", "site-a-fw", "FGT60FOLD0000001")]);
    await decommissionStaleFirewalls(input({
      scopedRun: true, clusterSerialsByDevice: new Map([["scoped-gw", new Set(["FGT60FSCOPE00001"])]]),
    }));
    expect(db.updateMany).not.toHaveBeenCalled();
  });
});

describe("staleFirewalls pure helpers — edge cases", () => {
  it("cascadeControllerOf: null / non-string / empty stamps match nothing; the original spelling is returned", () => {
    const names = new Set(["gone-fw"]);
    expect(cascadeControllerOf(null, names)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: 42 }, names)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: "" }, names)).toBeNull();
    expect(cascadeControllerOf({ controllerFortigate: "Gone-FW" }, names)).toBe("Gone-FW");
    expect(cascadeControllerOf({ controllerFortigate: "Gone-FW" }, new Set())).toBeNull();
  });

  it("firewallNamedForScopedGate: trims and lower-cases both names; blank names never match", () => {
    const processed = new Map<string, unknown>([["site-a-fw", new Set()]]);
    expect(firewallNamedForScopedGate({ hostname: "  SITE-A-FW ", fortinetTopology: null }, processed)).toBe(true);
    expect(firewallNamedForScopedGate({ hostname: null, fortinetTopology: { deviceName: "Site-A-FW" } }, processed)).toBe(true);
    expect(firewallNamedForScopedGate({ hostname: "   ", fortinetTopology: { deviceName: 7 } }, processed)).toBe(false);
    expect(firewallNamedForScopedGate({ hostname: "x", fortinetTopology: null }, new Map())).toBe(false);
  });

  it("judgeRosterFirewall: a placeholder serial is no serial — a named row with one is kept, never 'replaced'", () => {
    const verdict = judgeRosterFirewall(
      { hostname: "site-a-fw", serialNumber: "0000000000000000", fortinetTopology: null },
      {
        knownFirewallSerialsUc: new Set([SERIAL_A]), knownDeviceNamesLc: new Set(["site-a-fw"]),
        haRosterPublishedUc: new Set(), clusterSerialsByDevice: new Map([["site-a-fw", new Set([SERIAL_A])]]),
      },
    );
    expect(verdict).toEqual({ kind: "keep" });
  });
});
