/**
 * tests/unit/lastMonitorSuccessAt.test.ts — readLastMonitorSuccessAt
 *
 * The response-time chart's stale banner reads this instead of the newest
 * sample timestamp, because on a rollup tier that timestamp is a bucketStart
 * (a daily bucket is up to 24h "old" the moment it's written). Asserts the
 * query is scoped to successes at/after the window start and ordered newest
 * first, and that a window with no successful detail sample returns null so
 * the caller can fall back to the rollup-derived value.
 *
 * Also pins the `probeKind` scope: only the response-time poll counts. A device
 * whose SNMP agent has died still answers the ICMP loss sampler, and treating
 * one of those pings as a success would report the monitored service as
 * recently healthy when it has not answered in hours.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { readLastMonitorSuccessAt } from "../../src/services/sampleHistoryService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";

const findFirst = prisma.assetMonitorSample.findFirst as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
});

describe("readLastMonitorSuccessAt", () => {
  it("returns the newest successful sample's real timestamp", async () => {
    const at = new Date("2026-08-10T18:07:00Z");
    findFirst.mockResolvedValueOnce({ timestamp: at });

    const since = new Date("2026-07-11T18:00:00Z");
    expect(await readLastMonitorSuccessAt("asset-1", since)).toEqual(at);

    const args = findFirst.mock.calls[0][0];
    expect(args.where).toEqual({
      assetId: "asset-1",
      success: true,
      timestamp: { gte: since },
      // Response-time poll only — NULL is the pre-sampler value and means primary.
      OR: [{ probeKind: null }, { probeKind: "primary" }],
    });
    expect(args.orderBy).toEqual({ timestamp: "desc" });
  });

  it("returns null when the window holds no successful detail sample", async () => {
    findFirst.mockResolvedValueOnce(null);
    expect(await readLastMonitorSuccessAt("asset-1", new Date("2026-08-01T00:00:00Z"))).toBeNull();
  });
});
