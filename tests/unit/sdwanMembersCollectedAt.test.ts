/**
 * tests/unit/sdwanMembersCollectedAt.test.ts
 *
 * `readSdwanMembers` reports the SD-WAN scrape's OWN stamp.
 *
 * The SD-WAN tab used to date itself off the asset's `lastSystemInfoAt`, which
 * is the stamp of the whole system-info pass. SD-WAN is one optional leg of
 * that pass (`opts.includeSdwan`, and the collector swallows its own failures),
 * so a pass whose SD-WAN call returned nothing still advances that column — and
 * the tab would report a table that has not moved since yesterday as current.
 * The freshness strip exists to prevent exactly that reading, so the stamp has
 * to come from the rows it labels.
 *
 * Pinned here: the newest of the per-(member, health-check) latest samples is
 * the stamp; a table with no samples at all reports null rather than a
 * fabricated age.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    $queryRawUnsafe: vi.fn(),
    assetInterface: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));

const { readSdwanMembers } = await import("../../src/services/sampleHistoryService.js");

const OLDER = new Date("2026-09-18T12:00:00.000Z");
const NEWER = new Date("2026-09-18T12:10:00.000Z");

/**
 * Two members, scraped at different moments — wan2's health check answered on
 * the newer pass. The queries run in a fixed order: latest-per-pair, then the
 * 90-minute status strip.
 */
function mockSamples(rows: Array<Record<string, unknown>>) {
  h.prisma.$queryRawUnsafe.mockReset();
  h.prisma.$queryRawUnsafe
    .mockResolvedValueOnce(rows)   // A: latest per (link, healthCheck)
    .mockResolvedValueOnce([]);    // B: recent strip
  h.prisma.assetInterface.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  h.prisma.$queryRawUnsafe.mockReset();
  h.prisma.assetInterface.findMany.mockReset();
});

describe("readSdwanMembers collectedAt", () => {
  it("reports the newest latest-sample timestamp as the table's stamp", async () => {
    mockSamples([
      { link: "wan1", healthCheck: "Primary WAN", zone: "Underlay", state: "up", latencyMs: 28.4, jitterMs: 0.2, packetLoss: 0, timestamp: OLDER },
      { link: "wan2", healthCheck: "Primary WAN", zone: "Underlay", state: "up", latencyMs: 31.1, jitterMs: 0.3, packetLoss: 0, timestamp: NEWER },
    ]);
    const res = await readSdwanMembers("asset-1");
    expect(res.members).toHaveLength(2);
    expect(res.collectedAt?.toISOString()).toBe(NEWER.toISOString());
  });

  it("is null when the gate has never produced a perf-SLA sample", async () => {
    mockSamples([]);
    const res = await readSdwanMembers("asset-1");
    expect(res.members).toEqual([]);
    expect(res.collectedAt).toBeNull();
  });
});
