/**
 * tests/unit/quarantineStatusDrift.test.ts — the two service halves of the
 * quarantine routes moved out of routes/assets/quarantine.ts (CQ-B062 slice 2):
 * the status read (404 when the asset is gone) and the drift recorder (persist
 * the flipped targets, then write the asset.quarantine.drift_detected Event).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { getQuarantineStatus, recordQuarantineDrift } from "../../src/services/assetQuarantineService.js";

const m = { findUnique: stubbed(prisma.asset.findUnique), update: stubbed(prisma.asset.update), logEvent: eventLog.logEvent };

beforeEach(() => { resetDbStub(); resetEventLogStub(); });

describe("getQuarantineStatus", () => {
  it("returns the quarantine columns of the asset", async () => {
    const row = { id: "a1", status: "quarantined", quarantineTargets: [] };
    m.findUnique.mockResolvedValue(row);
    expect(await getQuarantineStatus("a1")).toBe(row);
    const arg = m.findUnique.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "a1" });
    expect(Object.keys(arg.select)).toEqual([
      "id", "status", "statusBeforeQuarantine", "quarantineReason", "quarantinedAt", "quarantinedBy", "quarantineTargets",
    ]);
  });

  it("throws a 404 AppError when the asset does not exist", async () => {
    m.findUnique.mockResolvedValue(null);
    await expect(getQuarantineStatus("gone")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("recordQuarantineDrift", () => {
  const targets = [{ integrationId: "i1", fortigateDevice: "FG1", status: "drift" }] as any;

  it("persists the targets and logs a warning Event named after the host", async () => {
    m.update.mockResolvedValue({});
    m.findUnique.mockResolvedValue({ hostname: "pc-7", ipAddress: "10.0.0.7" });
    await recordQuarantineDrift("a1", targets, "alice");
    expect(m.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { quarantineTargets: targets } });
    expect(m.logEvent).toHaveBeenCalledTimes(1);
    const ev = m.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({
      action: "asset.quarantine.drift_detected",
      resourceType: "asset",
      resourceId: "a1",
      resourceName: "pc-7",
      actor: "alice",
      level: "warning",
      details: { targets },
    });
    expect(ev.message).toContain("pc-7");
  });

  it("falls back to the IP, then the id, when the asset has no hostname", async () => {
    m.update.mockResolvedValue({});
    m.findUnique.mockResolvedValue({ hostname: null, ipAddress: "10.0.0.7" });
    await recordQuarantineDrift("a1", targets, undefined);
    const ev = m.logEvent.mock.calls[0][0];
    expect(ev.resourceName).toBe("10.0.0.7");
    expect(ev.message).toContain("a1");
  });
});
