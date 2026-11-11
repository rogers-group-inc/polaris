/**
 * tests/unit/dhcpPhasesExtracted2.test.ts — syncDhcpSubnets Phases 2, 2c and
 * 11.5, now modules under src/services/discovery/dhcp/ (CQ-B060 slice 2).
 * Slice 1's phases are in dhcpPhasesExtracted.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  subnetUpdateMany: stubbed(prisma.subnet.updateMany),
  integrationFindUnique: stubbed(prisma.integration.findUnique),
};

const m = vi.hoisted(() => ({
  logEvent: vi.fn(),
  logEventsBatch: vi.fn(),
  applyAutoMonitorForClass: vi.fn(),
  roamsWanted: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/eventLogService.js")>()),
  logEvent: m.logEvent,
  logEventsBatch: m.logEventsBatch,
}));
vi.mock("../../src/services/autoMonitorInterfacesService.js", () => ({
  coerceLegacySelection: (s: unknown) => s,
  applyAutoMonitorForClass: m.applyAutoMonitorForClass,
}));
vi.mock("../../src/services/notificationChangeEvents.js", () => ({ wirelessRoamEventsWanted: m.roamsWanted }));

const { deprecateStaleSubnets, applyAutoMonitorInterfaces } = await import("../../src/services/discovery/dhcp/subnetSweeps.js");
const { flushChangeEvents } = await import("../../src/services/discovery/dhcp/changeEvents.js");

const log = vi.fn();
beforeEach(() => {
  resetDbStub(); vi.clearAllMocks(); });

describe("Phase 2 — deprecate stale subnets", () => {
  const subnet = (over: Record<string, unknown>) => ({
    id: "s", cidr: "10.0.0.0/24", name: "lan", discoveredBy: "i1", status: "available", fortigateDevice: "FGT-A", ...over,
  });

  it("deprecates this integration's subnets whose gate left the roster — case-insensitively — and nothing else", async () => {
    const all = [
      subnet({ id: "gone", fortigateDevice: "FGT-OLD" }),
      subnet({ id: "kept-case", fortigateDevice: "fgt-a" }),
      subnet({ id: "other-intg", fortigateDevice: "FGT-OLD", discoveredBy: "i2" }),
      subnet({ id: "already", fortigateDevice: "FGT-OLD", status: "deprecated" }),
      subnet({ id: "excluded", fortigateDevice: "FGT-OLD", cidr: "192.168.50.0/24" }),
    ];
    const deprecated: string[] = [];
    await deprecateStaleSubnets({
      allSubnets: all,
      knownDeviceNamesLc: new Set(["fgt-a"]),
      subnetExclusions: [{ cidr: "192.168.0.0/16" }] as never,
      deprecated,
      integrationId: "i1",
      integrationName: "FMG",
      actor: "tester",
    });
    expect(db.subnetUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ["gone"] } }, data: { status: "deprecated" } });
    expect(deprecated).toEqual(["10.0.0.0/24"]);
    expect(all.find((s) => s.id === "gone")!.status).toBe("deprecated");
    expect(m.logEvent).toHaveBeenCalledTimes(1);
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "subnet.deprecated", details: { reason: "device-removed" } });
  });

  it("writes nothing when every gate is still on the roster", async () => {
    await deprecateStaleSubnets({
      allSubnets: [subnet({})], knownDeviceNamesLc: new Set(["fgt-a"]), subnetExclusions: [],
      deprecated: [], integrationId: "i1", integrationName: "FMG", actor: undefined,
    });
    expect(db.subnetUpdateMany).not.toHaveBeenCalled();
  });
});

describe("Phase 2c — auto-monitor interfaces", () => {
  it("runs only for a Fortinet integration, per configured class, scoped when the run is", async () => {
    await applyAutoMonitorInterfaces({ integrationId: "i1", integrationName: "W", integrationType: "windowsserver", actor: "t", scopedInfra: undefined, syncLog: log });
    expect(db.integrationFindUnique).not.toHaveBeenCalled();

    db.integrationFindUnique.mockResolvedValue({ config: { fortiswitchMonitor: { autoMonitorInterfaces: { mode: "uplinks" } } } });
    m.applyAutoMonitorForClass.mockResolvedValue({ interfacesAdded: 3, devices: 2 });
    const scoped = new Set(["a1"]);
    await applyAutoMonitorInterfaces({ integrationId: "i1", integrationName: "FMG", integrationType: "fortimanager", actor: "t", scopedInfra: scoped, syncLog: log });
    expect(m.applyAutoMonitorForClass).toHaveBeenCalledTimes(1);
    expect(m.applyAutoMonitorForClass).toHaveBeenCalledWith("i1", "fortiswitch", { mode: "uplinks" }, "t", scoped);
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "integration.auto_monitor_interfaces.applied" });
  });

  it("a failing class logs and does not stop the run", async () => {
    db.integrationFindUnique.mockResolvedValue({ config: { fortigateMonitor: { autoMonitorInterfaces: {} } } });
    m.applyAutoMonitorForClass.mockRejectedValue(new Error("boom"));
    await applyAutoMonitorInterfaces({ integrationId: "i1", integrationName: "F", integrationType: "fortigate", actor: "t", scopedInfra: undefined, syncLog: log });
    expect(log).toHaveBeenCalledWith("error", "Auto-monitor (fortigate) failed: boom");
  });
});

describe("Phase 11.5 — change-event flush", () => {
  const assetIdx = (rows: Record<string, unknown>[]) => ({ findById: (id: string) => rows.find((r) => r.id === id) }) as never;

  it("diffs each baseline against the final row; a roam only while the trigger is in use", async () => {
    const asset = { id: "a1", os: "FortiOS", osVersion: "7.6.2", lastSeenSwitch: "SW-1/port2", lastSeenAp: "AP-2" };
    const baseline = new Map([["a1", { name: "a1", osVersion: "7.6.1", lastSeenSwitch: "SW-1/port1", lastSeenAp: "AP-1" }]]);
    m.roamsWanted.mockResolvedValue(false);
    await flushChangeEvents({ changeBaseline: baseline, assetIdx: assetIdx([asset]), actor: undefined, integrationId: "i1", integrationName: "FMG" });
    expect(m.logEventsBatch.mock.calls[0][0].map((e: { action: string }) => e.action).sort())
      .toEqual(["asset.firmware.changed", "asset.switch_port.changed"]);

    m.roamsWanted.mockResolvedValue(true);
    await flushChangeEvents({ changeBaseline: baseline, assetIdx: assetIdx([asset]), actor: undefined, integrationId: "i1", integrationName: "FMG" });
    expect(m.logEventsBatch.mock.calls[1][0].map((e: { action: string }) => e.action)).toContain("asset.wireless_ap.changed");
  });

  it("writes nothing for an empty baseline or an unchanged fleet, and never throws", async () => {
    m.roamsWanted.mockResolvedValue(true);
    await flushChangeEvents({ changeBaseline: new Map(), assetIdx: assetIdx([]), actor: "x", integrationId: "i1", integrationName: "F" });
    const same = { id: "a1", lastSeenSwitch: "SW-1/port1" };
    await flushChangeEvents({ changeBaseline: new Map([["a1", { name: "a1", lastSeenSwitch: "SW-1/port1" }]]), assetIdx: assetIdx([same]), actor: "x", integrationId: "i1", integrationName: "F" });
    expect(m.logEventsBatch).not.toHaveBeenCalled();
    m.roamsWanted.mockRejectedValue(new Error("db"));
    await expect(flushChangeEvents({ changeBaseline: new Map([["a1", { name: "a1" }]]), assetIdx: assetIdx([same]), actor: "x", integrationId: "i1", integrationName: "F" })).resolves.toBeUndefined();
  });
});
