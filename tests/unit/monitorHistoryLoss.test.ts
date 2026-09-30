/**
 * tests/unit/monitorHistoryLoss.test.ts — the packet-loss line on the
 * response-time chart (readMonitorHistory's `loss`).
 *
 * Pins the split the detail tier makes from ONE read: the ICMP sweep's rows
 * count toward `loss` (packets, not outcomes) and never reach `samples` or the
 * response-time stats; and the rollup tiers' arithmetic — poll columns count a
 * packet per row, sweep columns their own packets, NULL sweep columns add
 * nothing, an empty bucket is skipped rather than plotted as 0 %.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetMonitorSample: { findMany: vi.fn(), findFirst: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));

import { readMonitorHistory, rollupLossSeries, monitorLossBucketMs } from "../../src/services/sampleHistoryService.js";
import { prisma } from "../../src/db.js";

const findMany = prisma.assetMonitorSample.findMany as unknown as ReturnType<typeof vi.fn>;
const queryRaw = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const T0 = Date.parse("2026-09-30T12:00:00Z");
const min = (n: number) => new Date(T0 + n * 60_000);

function poll(n: number, success: boolean, rtt: number | null = success ? 20 : null) {
  return {
    timestamp: min(n), success, responseTimeMs: rtt, error: null, dependencyDown: false,
    probeKind: null, packetsSent: null, packetsReceived: null,
  };
}
function burst(n: number, sent: number, received: number) {
  return {
    timestamp: min(n), success: received > 0, responseTimeMs: null, error: null, dependencyDown: false,
    probeKind: "icmp", packetsSent: sent, packetsReceived: received,
  };
}

describe("monitorLossBucketMs", () => {
  it("floors at two minutes and scales to ~120 points", () => {
    expect(monitorLossBucketMs(60 * 60_000)).toBe(2 * 60_000);
    expect(monitorLossBucketMs(24 * 60 * 60_000)).toBe(12 * 60_000);
  });
});

describe("readMonitorHistory — detail tier loss", () => {
  it("reads every probe kind once, counts sweep packets in loss, keeps them out of samples", async () => {
    findMany.mockResolvedValueOnce([
      poll(0, true), burst(0.5, 5, 5),
      poll(1, true), burst(1.5, 5, 0), // a burst with every echo lost
      poll(2, false), burst(2.5, 5, 5),
      poll(3, true), burst(3.5, 5, 5),
    ]);
    const since = min(0);
    const until = min(60);
    const r = await readMonitorHistory("a1", since, until, "detail");

    // One query, no probeKind filter.
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0].where).not.toHaveProperty("OR");

    // samples / stats: response-time poll only.
    expect(r.samples).toHaveLength(4);
    expect(r.samples.every((s) => !("probeKind" in s))).toBe(true);
    expect(r.stats.total).toBe(4);
    expect(r.stats.failed).toBe(1);

    // loss: 24 packets sent (4 polls + 20 echoes), 18 received → 25 %.
    expect(r.loss.bucketMs).toBe(2 * 60_000);
    expect(r.loss.ratioPct).toBe(25);
    // Buckets [0,2) and [2,4): 12 sent each; lost 5 and 1.
    expect(r.loss.points).toEqual([
      { t: min(0).getTime(), v: 41.7 },
      { t: min(2).getTime(), v: 8.3 },
    ]);
  });

  it("figures the ratio over the visible window only", async () => {
    // A lookback-overflow burst before `since` draws on the line, not in the figure.
    findMany.mockResolvedValueOnce([burst(-3, 5, 0), poll(0, true), burst(0.5, 5, 5)]);
    const r = await readMonitorHistory("a1", min(0), min(60), "detail", min(-5));
    expect(r.loss.ratioPct).toBe(0);
    expect(r.loss.points[0]!.v).toBe(100);
  });

  it("reports no loss for an empty window", async () => {
    findMany.mockResolvedValueOnce([]);
    const r = await readMonitorHistory("a1", min(0), min(60), "detail");
    expect(r.loss.points).toEqual([]);
    expect(r.loss.ratioPct).toBeNull();
  });
});

describe("rollupLossSeries", () => {
  const H = 3_600_000;
  const at = (h: number) => new Date(T0 + h * H);

  it("adds the poll rows to the sweep packets", () => {
    const s = rollupLossSeries([
      { bucketStart: at(0), sampleCount: 60, successCount: 60, packetsSent: 300, packetsReceived: 270 },
    ], T0, H);
    // 360 sent, 330 received.
    expect(s.points).toEqual([{ t: T0, v: 8.3 }]);
    expect(s.ratioPct).toBe(8.3);
    expect(s.bucketMs).toBe(H);
  });

  it("treats NULL sweep columns as no sweep, not as zero received", () => {
    const s = rollupLossSeries([
      { bucketStart: at(0), sampleCount: 60, successCount: 57, packetsSent: null, packetsReceived: null },
    ], T0, H);
    expect(s.points).toEqual([{ t: T0, v: 5 }]);
  });

  it("skips a bucket with nothing sent and excludes overflow from the ratio", () => {
    const s = rollupLossSeries([
      { bucketStart: at(-1), sampleCount: 10, successCount: 0, packetsSent: null, packetsReceived: null },
      { bucketStart: at(0), sampleCount: 0, successCount: 0, packetsSent: null, packetsReceived: null },
      { bucketStart: at(1), sampleCount: 10, successCount: 10, packetsSent: null, packetsReceived: null },
    ], T0, H);
    expect(s.points.map((p) => p.v)).toEqual([100, 0]);
    expect(s.ratioPct).toBe(0);
  });

  it("is what readMonitorHistory returns on a rollup tier", async () => {
    queryRaw.mockResolvedValueOnce([
      {
        bucketStart: at(0), sampleCount: 60, successCount: 60, failureCount: 0, dependencyFailureCount: 0,
        avgResponseTimeMs: 20, minResponseTimeMs: 10, maxResponseTimeMs: 30, packetsSent: 300, packetsReceived: 240,
      },
    ]);
    const r = await readMonitorHistory("a1", at(0), at(24), "hourly");
    expect(String(queryRaw.mock.calls[0]![0])).toContain('"packetsSent"');
    expect(r.loss.bucketMs).toBe(H);
    expect(r.loss.ratioPct).toBe(16.7);
  });
});
