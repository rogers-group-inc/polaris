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

const { readSdwanMembers, SDWAN_STATUS_STRIP_MINUTES } = await import("../../src/services/sampleHistoryService.js");

const OLDER = new Date("2026-09-18T12:00:00.000Z");
const NEWER = new Date("2026-09-18T12:10:00.000Z");

/**
 * Two members, scraped at different moments — wan2's health check answered on
 * the newer pass. The queries run in a fixed order: latest-per-pair, then the
 * 30-minute status strip.
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

// The Health Check Status strip. It used to read 90 minutes and keep the
// newest 48 readings, which on the 60s SD-WAN cadence meant "the last 48
// minutes". The window is now the only bound.
describe("readSdwanMembers status strip", () => {
  const latestRow = { link: "wan1", healthCheck: "Primary WAN", zone: null, state: "up", latencyMs: 20, jitterMs: 1, packetLoss: 0, timestamp: NEWER };

  it("asks for exactly the last 30 minutes", async () => {
    mockSamples([latestRow]);
    await readSdwanMembers("asset-1");
    expect(SDWAN_STATUS_STRIP_MINUTES).toBe(30);
    const [sql, assetId, minutes] = h.prisma.$queryRawUnsafe.mock.calls[1]!;
    expect(String(sql)).toContain("make_interval(mins => $2::int)");
    expect(assetId).toBe("asset-1");
    expect(minutes).toBe(30);
  });

  it("returns every reading in the window — no count cap", async () => {
    // 60 readings is more than the old 48 cap; the window, not a count, bounds it.
    const strip = Array.from({ length: 60 }, (_, i) => ({
      link: "wan1", timestamp: new Date(NEWER.getTime() - (60 - i) * 30_000), up: i % 7 !== 0,
    }));
    h.prisma.$queryRawUnsafe.mockReset();
    h.prisma.$queryRawUnsafe.mockResolvedValueOnce([latestRow]).mockResolvedValueOnce(strip);
    h.prisma.assetInterface.findMany.mockResolvedValue([]);
    const res = await readSdwanMembers("asset-1");
    expect(res.members[0]!.recent).toHaveLength(60);
    expect(res.members[0]!.recent[0]!.up).toBe(false);
  });
});
