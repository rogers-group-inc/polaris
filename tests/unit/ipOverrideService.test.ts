/**
 * tests/unit/ipOverrideService.test.ts
 *
 * The follow-up side effects of an operator IP override (Asset.ipOverride),
 * run fire-and-forget from the db.ts guard after the asset write lands:
 *
 *   • reasserted → at most ONE pending ip-override Conflict per asset; a repeat
 *     sighting refreshes it (re-pointing the proposal); an operator rejection
 *     of the SAME discovered IP is the dedup marker, a NEW IP raises again;
 *     race guards for a pin that was cleared or moved onto the discovered IP;
 *     a BLANK pin (ipBlankPinned) disagrees with every discovered address;
 *   • released → every pending ip-override conflict is auto-closed (status
 *     "rejected", the auto-resolution convention) and audited;
 *   • every entry point swallows its errors — the asset write already landed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  assetFindUnique: stubbed(prisma.asset.findUnique),
  conflictFindMany: stubbed(prisma.conflict.findMany),
  conflictUpdate: stubbed(prisma.conflict.update),
  conflictCreate: stubbed(prisma.conflict.create),
  conflictUpdateMany: stubbed(prisma.conflict.updateMany),
};

const m = vi.hoisted(() => ({
  logEvent: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { warn: m.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const svc = await import("../../src/services/ipOverrideService.js");

const pinned = {
  id: "a1", hostname: "printer-1", ipAddress: "10.0.0.5", ipOverride: "10.0.0.5",
  ipBlankPinned: false, ipSource: "manual", discoveredByIntegrationId: "int-1",
};

beforeEach(() => {
  resetDbStub();
  for (const fn of Object.values(m)) fn.mockReset();
  db.assetFindUnique.mockResolvedValue(pinned);
  db.conflictFindMany.mockResolvedValue([]);
  db.conflictUpdateMany.mockResolvedValue({ count: 0 });
});

describe("raiseIpOverrideConflict", () => {
  it("raises one ipAddress conflict carrying the discovered IP, its pathway and the pin", async () => {
    await svc.raiseIpOverrideConflict("a1", "10.0.0.99", "fortigate");
    expect(db.conflictCreate).toHaveBeenCalledTimes(1);
    const data = db.conflictCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      entityType: "asset",
      assetId: "a1",
      integrationId: "int-1",
      conflictFields: ["ipAddress"],
      proposedAssetFields: {
        collisionReason: "ip-override", ipAddress: "10.0.0.99", ipSource: "fortigate",
        overrideIp: "10.0.0.5", blankPinned: false, hostname: "printer-1",
      },
      existingAssetSnapshot: { ipAddress: "10.0.0.5", ipOverride: "10.0.0.5", ipBlankPinned: false },
    });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "conflict.detected", actor: "system", message: expect.stringContaining("(via fortigate)"),
    }));
  });

  it("looks up prior conflicts by the ip-override collision reason, scoped to the asset", async () => {
    await svc.raiseIpOverrideConflict("a1", "10.0.0.99");
    expect(db.conflictFindMany.mock.calls[0][0].where).toEqual({
      entityType: "asset",
      proposedAssetFields: { path: ["collisionReason"], equals: "ip-override" },
      assetId: "a1",
    });
  });

  it("refreshes the pending conflict instead of raising a second one, re-pointing its proposal", async () => {
    db.conflictFindMany.mockResolvedValue([{ id: "c1", status: "pending", proposedAssetFields: { ipAddress: "10.0.0.98" } }]);
    await svc.raiseIpOverrideConflict("a1", "10.0.0.99");
    expect(db.conflictCreate).not.toHaveBeenCalled();
    expect(db.conflictUpdate).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({ proposedAssetFields: expect.objectContaining({ ipAddress: "10.0.0.99" }) }),
    });
    expect(m.logEvent).not.toHaveBeenCalled();
  });

  it("does not re-raise an IP the operator already rejected", async () => {
    db.conflictFindMany.mockResolvedValue([{ id: "c1", status: "rejected", proposedAssetFields: { ipAddress: "10.0.0.99" } }]);
    await svc.raiseIpOverrideConflict("a1", "10.0.0.99");
    expect(db.conflictCreate).not.toHaveBeenCalled();
  });

  it("does raise when discovery now reports a DIFFERENT IP than the rejected one", async () => {
    db.conflictFindMany.mockResolvedValue([{ id: "c1", status: "rejected", proposedAssetFields: { ipAddress: "10.0.0.99" } }]);
    await svc.raiseIpOverrideConflict("a1", "10.0.0.100");
    expect(db.conflictCreate).toHaveBeenCalledTimes(1);
  });

  it("raises again after an ACCEPTED one (only a rejection is the dedup marker)", async () => {
    db.conflictFindMany.mockResolvedValue([{ id: "c1", status: "accepted", proposedAssetFields: { ipAddress: "10.0.0.99" } }]);
    await svc.raiseIpOverrideConflict("a1", "10.0.0.99");
    expect(db.conflictCreate).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the pin was cleared, or moved onto the discovered IP, before the follow-up ran", async () => {
    db.assetFindUnique.mockResolvedValue({ ...pinned, ipOverride: null });
    await svc.raiseIpOverrideConflict("a1", "10.0.0.99");
    db.assetFindUnique.mockResolvedValue({ ...pinned, ipOverride: "10.0.0.99" });
    await svc.raiseIpOverrideConflict("a1", "10.0.0.99");
    db.assetFindUnique.mockResolvedValue(null);
    await svc.raiseIpOverrideConflict("a1", "10.0.0.99");
    expect(db.conflictFindMany).not.toHaveBeenCalled();
    expect(db.conflictCreate).not.toHaveBeenCalled();
  });

  it("treats a blank pin as disagreeing with every discovered address", async () => {
    db.assetFindUnique.mockResolvedValue({ ...pinned, ipAddress: null, ipOverride: null, ipBlankPinned: true });
    await svc.raiseIpOverrideConflict("a1", "10.0.0.5");
    const data = db.conflictCreate.mock.calls[0][0].data;
    expect(data.proposedAssetFields).toMatchObject({ overrideIp: null, blankPinned: true, ipAddress: "10.0.0.5" });
    expect(m.logEvent.mock.calls[0][0].message).toContain("no address (cleared)");
  });

  it("swallows a database failure (the asset write already landed)", async () => {
    db.conflictFindMany.mockRejectedValue(new Error("db down"));
    await expect(svc.raiseIpOverrideConflict("a1", "10.0.0.99")).resolves.toBeUndefined();
    expect(m.warn).toHaveBeenCalled();
  });

  // QUESTION (not a confirmed bug — see CQ-T010 in the ledger): an operator who
  // re-pins A → B while a conflict proposing X is pending auto-closes it as
  // "rejected" (resolvePendingIpOverrideConflicts), and that row then
  // suppresses X forever, against the NEW pin too — the operator never saw X
  // against B. The dedup compares only the proposed IP, not overrideIp.
  it.todo("re-raises a discovered IP against a NEW pin even when an auto-closed conflict proposed it against the old one");
});

describe("handleIpOverrideReleased", () => {
  it("auto-closes pending ip-override conflicts as rejected and audits the release", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-09T08:00:00Z"));
      db.conflictUpdateMany.mockResolvedValue({ count: 2 });
      await svc.handleIpOverrideReleased("a1", "10.0.0.5");
      expect(db.conflictUpdateMany).toHaveBeenCalledWith({
        where: {
          entityType: "asset",
          proposedAssetFields: { path: ["collisionReason"], equals: "ip-override" },
          assetId: "a1",
          status: "pending",
        },
        data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date("2026-11-09T08:00:00Z") },
      });
      expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: "asset.ip_override.released", resourceName: "printer-1", details: { autoResolvedConflicts: 2 },
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits details when nothing was pending, and names the IP when the asset has no hostname", async () => {
    db.assetFindUnique.mockResolvedValue({ hostname: null });
    await svc.handleIpOverrideReleased("a1", "10.0.0.5");
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ resourceName: "10.0.0.5", details: undefined });
  });

  it("swallows a failure", async () => {
    db.conflictUpdateMany.mockRejectedValue(new Error("db down"));
    await expect(svc.handleIpOverrideReleased("a1", "10.0.0.5")).resolves.toBeUndefined();
    expect(m.logEvent).not.toHaveBeenCalled();
  });
});

describe("handleIpClearedReleased (business rule 40(j))", () => {
  it("audits a blank filled by a NEW address", async () => {
    await svc.handleIpClearedReleased("a1", "10.0.0.7", "filled");
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({
      action: "asset.ip_cleared.filled", details: { ipAddress: "10.0.0.7", how: "filled" },
      message: expect.stringContaining("it now reports 10.0.0.7"),
    });
  });

  it("audits the blanked address returning once nothing else holds it", async () => {
    await svc.handleIpClearedReleased("a1", "10.0.0.5", "returned");
    expect(m.logEvent.mock.calls[0][0].message).toContain("no longer held by another asset");
  });
});

describe("resolvePendingIpOverrideConflicts", () => {
  it("records who resolved them and returns how many closed", async () => {
    db.conflictUpdateMany.mockResolvedValue({ count: 1 });
    await expect(svc.resolvePendingIpOverrideConflicts("a1", "alice")).resolves.toBe(1);
    expect(db.conflictUpdateMany.mock.calls[0][0].data).toMatchObject({ status: "rejected", resolvedBy: "alice" });
  });
});
