/**
 * tests/unit/subnetSweeps.test.ts — syncDhcpSubnets Phase 2 (stale-subnet
 * deprecation) and Phase 2c (auto-monitor interfaces) as their own module
 * (src/services/discovery/dhcp/subnetSweeps.ts).
 *
 * Phase 2's contract: only THIS integration's subnets, only when their gate
 * left the roster (case-insensitively), never an excluded CIDR (business rule
 * 42 — its fortigateDevice is frozen at whichever site claimed it first), one
 * updateMany, one `subnet.deprecated` Event per row, and the in-memory rows +
 * `deprecated` list updated for the run's summary. Phase 2c: Fortinet types
 * only, per class, legacy selections coerced, a failing class does not stop
 * the next. tests/unit/dhcpPhasesExtracted2.test.ts pins the headline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const m = vi.hoisted(() => ({ applyAutoMonitorForClass: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/autoMonitorInterfacesService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  applyAutoMonitorForClass: m.applyAutoMonitorForClass,
}));

const { deprecateStaleSubnets, applyAutoMonitorInterfaces } = await import("../../src/services/discovery/dhcp/subnetSweeps.js");

const db = {
  subnetUpdateMany: stubbed(prisma.subnet.updateMany),
  integrationFindUnique: stubbed(prisma.integration.findUnique),
};

const log = vi.fn();
const subnet = (id: string, cidr: string, over: Record<string, unknown> = {}) => ({
  id, cidr, name: `net-${id}`, discoveredBy: "int1", status: "available", fortigateDevice: "FGT-A", ...over,
});
const baseSweep = () => ({
  knownDeviceNamesLc: new Set(["fgt-a"]),
  subnetExclusions: [] as Array<{ cidr: string; name: string }>,
  deprecated: [] as string[],
  integrationId: "int1",
  integrationName: "Corp FMG",
  actor: "admin",
});

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  log.mockReset();
  m.applyAutoMonitorForClass.mockReset().mockResolvedValue({ devices: 0, interfacesAdded: 0 });
  db.subnetUpdateMany.mockResolvedValue({ count: 0 });
});

describe("deprecateStaleSubnets (Phase 2)", () => {
  it("deprecates this integration's subnets whose gate left the roster, in one updateMany", async () => {
    const rows = [
      subnet("gone1", "10.1.0.0/24", { fortigateDevice: "FGT-OLD" }),
      subnet("gone2", "10.2.0.0/24", { fortigateDevice: "FGT-OLD" }),
      subnet("kept", "10.3.0.0/24"),
    ];
    const input = { ...baseSweep(), allSubnets: rows };
    await deprecateStaleSubnets(input);
    expect(db.subnetUpdateMany).toHaveBeenCalledTimes(1);
    expect(db.subnetUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ["gone1", "gone2"] } }, data: { status: "deprecated" } });
    expect(input.deprecated).toEqual(["10.1.0.0/24", "10.2.0.0/24"]);
    expect(rows.map((r) => r.status)).toEqual(["deprecated", "deprecated", "available"]);
  });

  it("writes one subnet.deprecated Event per row with the reason and the gate", async () => {
    await deprecateStaleSubnets({ ...baseSweep(), allSubnets: [subnet("gone", "10.1.0.0/24", { fortigateDevice: "FGT-OLD" })] });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toEqual({
      action: "subnet.deprecated",
      resourceType: "subnet",
      resourceId: "gone",
      resourceName: "net-gone",
      actor: "admin",
      message: `Subnet "net-gone" (10.1.0.0/24) deprecated — FortiGate "FGT-OLD" no longer configured in "Corp FMG"`,
      details: {
        reason: "device-removed",
        fortigateDevice: "FGT-OLD",
        integrationId: "int1",
        integrationName: "Corp FMG",
        cidr: "10.1.0.0/24",
      },
    });
  });

  it("matches the roster case-insensitively", async () => {
    await deprecateStaleSubnets({ ...baseSweep(), allSubnets: [subnet("s", "10.1.0.0/24", { fortigateDevice: "Fgt-A" })] });
    expect(db.subnetUpdateMany).not.toHaveBeenCalled();
  });

  it("leaves other integrations' rows, already-deprecated rows and rows with no gate alone", async () => {
    await deprecateStaleSubnets({
      ...baseSweep(),
      allSubnets: [
        subnet("other", "10.1.0.0/24", { discoveredBy: "int2", fortigateDevice: "FGT-OLD" }),
        subnet("manual", "10.2.0.0/24", { discoveredBy: null, fortigateDevice: "FGT-OLD" }),
        subnet("done", "10.3.0.0/24", { status: "deprecated", fortigateDevice: "FGT-OLD" }),
        subnet("nogate", "10.4.0.0/24", { fortigateDevice: null }),
      ],
    });
    expect(db.subnetUpdateMany).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("never deprecates an excluded CIDR or one inside an exclusion (rule 42), but does a wider one", async () => {
    const input = {
      ...baseSweep(),
      subnetExclusions: [{ cidr: "10.99.0.0/16", name: "OOB" }],
      allSubnets: [
        subnet("exact", "10.99.0.0/16", { fortigateDevice: "FGT-OLD" }),
        subnet("inside", "10.99.4.0/24", { fortigateDevice: "FGT-OLD" }),
        subnet("wider", "10.0.0.0/8", { fortigateDevice: "FGT-OLD" }),
      ],
    };
    await deprecateStaleSubnets(input);
    expect(db.subnetUpdateMany.mock.calls[0][0].where).toEqual({ id: { in: ["wider"] } });
    expect(input.deprecated).toEqual(["10.0.0.0/8"]);
  });

  it("does nothing with an empty subnet list", async () => {
    const input = { ...baseSweep(), allSubnets: [] };
    await deprecateStaleSubnets(input);
    expect(db.subnetUpdateMany).not.toHaveBeenCalled();
    expect(input.deprecated).toEqual([]);
  });

  it("propagates a failed updateMany without touching the in-memory rows or writing Events", async () => {
    db.subnetUpdateMany.mockRejectedValue(new Error("db down"));
    const rows = [subnet("gone", "10.1.0.0/24", { fortigateDevice: "FGT-OLD" })];
    const input = { ...baseSweep(), allSubnets: rows };
    await expect(deprecateStaleSubnets(input)).rejects.toThrow("db down");
    expect(rows[0].status).toBe("available");
    expect(input.deprecated).toEqual([]);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("applyAutoMonitorInterfaces (Phase 2c)", () => {
  const base = {
    integrationId: "int1",
    integrationName: "Corp FMG",
    integrationType: "fortimanager",
    actor: "admin",
    scopedInfra: undefined as Set<string> | undefined,
    syncLog: log,
  };

  it("does nothing (no config read) for a non-Fortinet integration", async () => {
    for (const integrationType of ["windowsserver", "entraid", "vcenter", "proxmox"]) {
      await applyAutoMonitorInterfaces({ ...base, integrationType });
    }
    expect(db.integrationFindUnique).not.toHaveBeenCalled();
    expect(m.applyAutoMonitorForClass).not.toHaveBeenCalled();
  });

  it("skips every class with no selection (and a missing integration)", async () => {
    db.integrationFindUnique.mockResolvedValue({ config: { fortigateMonitor: {}, fortiapMonitor: { autoMonitorInterfaces: null } } });
    await applyAutoMonitorInterfaces(base);
    db.integrationFindUnique.mockResolvedValue(null);
    await applyAutoMonitorInterfaces({ ...base, integrationType: "fortigate" });
    expect(m.applyAutoMonitorForClass).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("applies each configured class with its (legacy-coerced) selection and the run's scope", async () => {
    const scope = new Set(["FGT-A"]);
    db.integrationFindUnique.mockResolvedValue({
      config: {
        fortigateMonitor: { autoMonitorInterfaces: { mode: "names", names: ["wan1"] } },
        fortiswitchMonitor: { autoMonitorInterfaces: { byTypes: { types: ["physical"], onlyUp: true } } },
      },
    });
    m.applyAutoMonitorForClass.mockResolvedValue({ devices: 0, interfacesAdded: 0 });
    await applyAutoMonitorInterfaces({ ...base, scopedInfra: scope });
    expect(m.applyAutoMonitorForClass.mock.calls).toEqual([
      ["int1", "fortigate", { byNames: { names: ["wan1"] } }, "admin", scope],
      ["int1", "fortiswitch", { byTypes: { types: ["physical"], onlyUp: true } }, "admin", scope],
    ]);
    expect(eventLog.logEvent).not.toHaveBeenCalled(); // nothing added: no Event, no log line
    expect(log).not.toHaveBeenCalled();
  });

  it("logs and audits a class that pinned interfaces", async () => {
    db.integrationFindUnique.mockResolvedValue({ config: { fortiapMonitor: { autoMonitorInterfaces: { byNames: { names: ["wlan0"] } } } } });
    m.applyAutoMonitorForClass.mockResolvedValue({ devices: 3, interfacesAdded: 5 });
    await applyAutoMonitorInterfaces({ ...base, integrationType: "fortigate" });
    expect(log).toHaveBeenCalledWith("info", "Auto-monitor (fortiap): pinned 5 interface(s) on 3 device(s)");
    expect(eventLog.logEvent.mock.calls[0][0]).toEqual({
      action: "integration.auto_monitor_interfaces.applied",
      resourceType: "integration",
      resourceId: "int1",
      resourceName: "Corp FMG",
      actor: "admin",
      message: `Auto-monitor interfaces applied for "Corp FMG" (fortiap) — 3 device(s), 5 interface(s) added`,
      details: { class: "fortiap", devices: 3, interfacesAdded: 5 },
    });
  });

  it("logs a failing class and still runs the next one", async () => {
    db.integrationFindUnique.mockResolvedValue({
      config: {
        fortigateMonitor: { autoMonitorInterfaces: { byNames: { names: ["a"] } } },
        fortiswitchMonitor: { autoMonitorInterfaces: { byNames: { names: ["b"] } } },
      },
    });
    m.applyAutoMonitorForClass
      .mockRejectedValueOnce(new Error("sample table locked"))
      .mockResolvedValueOnce({ devices: 1, interfacesAdded: 1 });
    await applyAutoMonitorInterfaces(base);
    expect(log).toHaveBeenCalledWith("error", "Auto-monitor (fortigate) failed: sample table locked");
    expect(m.applyAutoMonitorForClass).toHaveBeenCalledTimes(2);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });
});
