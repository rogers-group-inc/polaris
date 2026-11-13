/**
 * tests/integration/ipHistoryRefreshBatch.test.ts — refreshIpHistoryLastSeen
 * keeps an address's history fresh when a discovery write no longer stages an
 * unchanged IP (utils/assetWritePrune.ts). Same upsert as db.ts's per-write
 * recordIpHistory: lastSeen advances, source follows, firstSeen resets only
 * when the source changes; an asset deleted meanwhile is skipped, not fatal.
 */

import { it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { refreshIpHistoryLastSeen } from "../../src/services/assetIpHistoryService.js";

const HOST = "IPHIST-BATCH";
async function cleanup() {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}
beforeEach(cleanup);
afterAll(cleanup);

dbDescribe("refreshIpHistoryLastSeen", () => {
  it("advances lastSeen, follows the source, resets firstSeen only on a source change, and skips a missing asset", async () => {
    const a = await prisma.asset.create({ data: { hostname: `${HOST}-a`, assetType: "workstation", status: "active", ipAddress: "10.91.0.1" } });
    const b = await prisma.asset.create({ data: { hostname: `${HOST}-b`, assetType: "workstation", status: "active", ipAddress: "10.91.0.2" } });
    const old = new Date("2026-01-01T00:00:00Z");
    // The create hook writes history rows fire-and-forget; settle, then set a known baseline.
    await new Promise((r) => setTimeout(r, 150));
    await prisma.assetIpHistory.deleteMany({ where: { assetId: { in: [a.id, b.id] } } });
    await prisma.assetIpHistory.createMany({
      data: [
        { assetId: a.id, ip: "10.91.0.1", source: "GATE-1", firstSeen: old, lastSeen: old },
        { assetId: b.id, ip: "10.91.0.2", source: "GATE-1", firstSeen: old, lastSeen: old },
      ],
    });

    await refreshIpHistoryLastSeen([
      { assetId: a.id, ip: "10.91.0.1", source: "GATE-1" }, // same source
      { assetId: b.id, ip: "10.91.0.2", source: "GATE-2" }, // source moved
      { assetId: "no-such-asset", ip: "10.91.0.9", source: "GATE-1" },
    ]);

    const rows = await prisma.assetIpHistory.findMany({ where: { assetId: { in: [a.id, b.id] } } });
    const ra = rows.find((r) => r.assetId === a.id)!;
    const rb = rows.find((r) => r.assetId === b.id)!;
    expect(ra.lastSeen.getTime()).toBeGreaterThan(old.getTime());
    expect(ra.firstSeen.getTime()).toBe(old.getTime());
    expect(rb.source).toBe("GATE-2");
    expect(rb.firstSeen.getTime()).toBeGreaterThan(old.getTime());
    expect(await prisma.assetIpHistory.count({ where: { assetId: "no-such-asset" } })).toBe(0);
  });
});
