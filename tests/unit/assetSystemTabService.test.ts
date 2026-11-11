/**
 * tests/unit/assetSystemTabService.test.ts — the System-tab family's reads
 * moved out of routes/assets/system.ts (CQ-B062 slice 2): the ARP table's
 * `current` window is the newest read within the tolerance (not everything
 * retained), a ranged view filters by lastSeen, the "" interface sentinel never
 * leaves the API, and the per-asset reads 404 an unknown asset. The HTTP
 * contract is tests/integration/arpTable.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ retention: vi.fn(), interval: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/sampleRetentionService.js", () => ({ getArpEntryRetentionDays: m.retention }));
vi.mock("../../src/services/monitoring/monitorSettings.js", () => ({ resolveCurrentStateIntervalSec: m.interval }));

import { getAssetArpTable, getAssetServices, getAssetProcesses } from "../../src/services/assetSystemTabService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  arpAggregate: stubbed(prisma.assetArpEntry.aggregate),
  arpFindMany: stubbed(prisma.assetArpEntry.findMany),
  assetFindUnique: stubbed(prisma.asset.findUnique),
};

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(m)) f.mockReset();
  m.retention.mockResolvedValue(30);
  m.interval.mockResolvedValue(300);
});

describe("getAssetArpTable", () => {
  it("current = only the newest read, within the tolerance of its stamp", async () => {
    const newest = new Date("2026-11-11T10:00:00Z");
    db.arpAggregate.mockResolvedValue({ _max: { lastSeen: newest } });
    db.arpFindMany.mockResolvedValue([
      { ipAddress: "10.0.0.5", macAddress: "AA", ifName: "", ageSec: 1, firstSeen: newest, lastSeen: newest, matchedAsset: null },
    ]);
    const r = await getAssetArpTable("g", "current");
    const since: Date = db.arpFindMany.mock.calls[0][0].where.lastSeen.gte;
    expect(newest.getTime() - since.getTime()).toBeGreaterThan(0);
    expect(newest.getTime() - since.getTime()).toBeLessThanOrEqual(5_000);
    expect(r.entries[0].ifName).toBeNull();
    expect(r).toMatchObject({ total: 1, range: "current", retentionDays: 30, pollIntervalSec: 300, collectedAt: newest });
  });
  it("a gate with no ARP rows reads with no lastSeen filter", async () => {
    db.arpAggregate.mockResolvedValue({ _max: { lastSeen: null } });
    db.arpFindMany.mockResolvedValue([]);
    await getAssetArpTable("g", "current");
    expect(db.arpFindMany.mock.calls[0][0].where).toEqual({ assetId: "g" });
  });
  it("a ranged view filters by lastSeen and skips the newest-read query", async () => {
    db.arpFindMany.mockResolvedValue([]);
    await getAssetArpTable("g", "24h");
    expect(db.arpAggregate).not.toHaveBeenCalled();
    const since: Date = db.arpFindMany.mock.calls[0][0].where.lastSeen.gte;
    expect(Math.abs(Date.now() - since.getTime() - 24 * 3600_000)).toBeLessThan(10_000);
  });
});

describe("per-asset reads", () => {
  it("404 an unknown asset", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    await expect(getAssetServices("x")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(getAssetProcesses("x")).rejects.toMatchObject({ httpStatus: 404 });
  });
});
