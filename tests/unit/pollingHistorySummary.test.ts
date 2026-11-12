/**
 * tests/unit/pollingHistorySummary.test.ts — readPollingHistorySummary's
 * tier-stitched counting (mocked $queryRawUnsafe): all of daily, hourly past
 * daily coverage, detail past hourly coverage; span from min/max across every
 * tier of both streams; empty-history and bigint-coercion edges.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { readPollingHistorySummary } from "../../src/services/sampleHistoryService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";

const rawUnsafe = prisma.$queryRawUnsafe as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Call order inside readPollingHistorySummary: monitor daily → hourly →
// detail, then telemetry daily → hourly → detail.
function mockStream(rows: Array<{ mn: Date | null; mx: Date | null; cnt: bigint | number }>) {
  for (const r of rows) rawUnsafe.mockResolvedValueOnce([r]);
}

describe("readPollingHistorySummary", () => {
  it("stitches tier counts without double-counting and spans oldest→newest", async () => {
    const dailyMin = new Date("2025-01-01T00:00:00Z");
    const dailyMax = new Date("2026-07-27T00:00:00Z");
    const hourlyMax = new Date("2026-07-29T09:00:00Z");
    const detailMax = new Date("2026-07-30T10:30:00Z");
    mockStream([
      // monitor: daily holds the deep history, hourly + detail the recent tail
      { mn: dailyMin, mx: dailyMax, cnt: 1_000_000n },
      { mn: new Date("2026-06-30T00:00:00Z"), mx: hourlyMax, cnt: 5000n },
      { mn: new Date("2026-07-23T00:00:00Z"), mx: detailMax, cnt: 170n },
      // telemetry: empty
      { mn: null, mx: null, cnt: 0n },
      { mn: null, mx: null, cnt: 0n },
      { mn: null, mx: null, cnt: 0n },
    ]);

    const out = await readPollingHistorySummary("asset-1");

    expect(out.monitor.sampleCount).toBe(1_005_170);
    expect(out.telemetry.sampleCount).toBe(0);
    expect(out.sampleCount).toBe(1_005_170);
    expect(out.oldestAt).toEqual(dailyMin);
    expect(out.newestAt).toEqual(detailMax);
    expect(out.spanDays).toBe(Math.floor((detailMax.getTime() - dailyMin.getTime()) / DAY));

    // Coverage boundaries: hourly counts only buckets ≥ last daily bucket's
    // end (+1 day), detail only rows ≥ last hourly bucket's end (+1 hour).
    const hourlyCall = rawUnsafe.mock.calls[1];
    expect(hourlyCall[2]).toEqual(new Date(dailyMax.getTime() + DAY));
    const detailCall = rawUnsafe.mock.calls[2];
    expect(detailCall[2]).toEqual(new Date(hourlyMax.getTime() + HOUR));
  });

  it("passes a null boundary when a stream has no rollup rows (count everything)", async () => {
    const first = new Date("2026-07-30T08:00:00Z");
    const last = new Date("2026-07-30T09:00:00Z");
    mockStream([
      { mn: null, mx: null, cnt: 0n },
      { mn: null, mx: null, cnt: 0n },
      { mn: first, mx: last, cnt: 120n },
      { mn: null, mx: null, cnt: 0n },
      { mn: null, mx: null, cnt: 0n },
      { mn: null, mx: null, cnt: 0n },
    ]);

    const out = await readPollingHistorySummary("asset-2");

    expect(rawUnsafe.mock.calls[1][2]).toBeNull(); // hourly boundary
    expect(rawUnsafe.mock.calls[2][2]).toBeNull(); // detail boundary
    expect(out.sampleCount).toBe(120);
    expect(out.oldestAt).toEqual(first);
    expect(out.newestAt).toEqual(last);
    expect(out.spanDays).toBe(0); // sub-day history
  });

  it("returns an all-empty summary when neither stream has samples", async () => {
    mockStream(Array.from({ length: 6 }, () => ({ mn: null, mx: null, cnt: 0n })));

    const out = await readPollingHistorySummary("asset-3");

    expect(out).toEqual({
      oldestAt: null,
      newestAt: null,
      spanDays: 0,
      sampleCount: 0,
      monitor: { oldestAt: null, newestAt: null, sampleCount: 0 },
      telemetry: { oldestAt: null, newestAt: null, sampleCount: 0 },
    });
  });

  it("combines monitor and telemetry spans (telemetry may predate monitor)", async () => {
    const telOld = new Date("2024-05-01T00:00:00Z");
    const monNew = new Date("2026-07-30T00:00:00Z");
    mockStream([
      { mn: new Date("2026-01-01T00:00:00Z"), mx: new Date("2026-07-01T00:00:00Z"), cnt: 100n },
      { mn: null, mx: null, cnt: 0n },
      { mn: new Date("2026-07-02T00:00:00Z"), mx: monNew, cnt: 50 }, // plain number cnt also accepted
      { mn: telOld, mx: new Date("2025-01-01T00:00:00Z"), cnt: 2000n },
      { mn: null, mx: null, cnt: 0n },
      { mn: null, mx: null, cnt: 0n },
    ]);

    const out = await readPollingHistorySummary("asset-4");

    expect(out.oldestAt).toEqual(telOld);
    expect(out.newestAt).toEqual(monNew);
    expect(out.sampleCount).toBe(2150);
  });
});
