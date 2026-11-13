/**
 * tests/unit/timeWindowAggregate.test.ts
 *
 * Business rule 178: a time-windowed aggregate covers the window the rule
 * states. "Average CPU over 5 minutes" used to average the whole fetch, which
 * is floored at 15 minutes — so the High CPU / High memory / Slow response /
 * temperature baselines averaged 15. When the stated window holds no reading
 * (shorter than the polling interval) the newest reading stands in, provided
 * it is no older than the old 15-minute span.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import type { Trigger } from "../../src/services/notificationTypes.js";
import type { ScopeAssetRow } from "../../src/services/notifications/ruleModel.js";
import { timeWindowMs, aggregateSinceMs, aggregateFallbackSinceMs } from "../../src/services/notifications/ruleModel.js";
import { resolveAssetMetricReadings, resolveHostMetricReading } from "../../src/services/notifications/readings.js";

const NOW = new Date("2026-11-13T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const cpu = (o: Record<string, unknown>) =>
  ({ type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90, forDurationSec: 0, ...o }) as unknown as Extract<Trigger, { type: "asset_metric" }>;
const asset = { id: "a1", hostname: "a1", tags: [] } as unknown as ScopeAssetRow;
const sample = (min: number, cpuPct: number) => ({ assetId: "a1", timestamp: ago(min), cpuPct, memPct: null, memUsedBytes: null, sessionCount: null });

beforeEach(() => { resetDbStub(); vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

describe("rule 178: the window a time aggregate covers", () => {
  it("is the stated window for avg/min/max/median, and nothing for latest, a count window, or no window", () => {
    expect(timeWindowMs({ windowSec: 300, aggregation: "avg" })).toBe(300_000);
    expect(timeWindowMs({ windowSec: 300, aggregation: "max" })).toBe(300_000);
    expect(timeWindowMs({ windowSec: 300, aggregation: "latest" })).toBe(0);
    expect(timeWindowMs({ windowSec: 0, aggregation: "avg" })).toBe(0);
    expect(timeWindowMs({ windowSec: 300, aggregation: "avg", windowPolls: 5 })).toBe(0);
    const now = NOW.getTime();
    expect(aggregateSinceMs({ windowSec: 300, aggregation: "avg" }, now)).toBe(now - 300_000);
    expect(aggregateFallbackSinceMs({ windowSec: 300, aggregation: "avg" }, now)).toBe(now - 15 * 60_000);
    expect(aggregateFallbackSinceMs({ windowSec: 0, aggregation: "latest" }, now)).toBe(-Infinity);
  });

  it("averages only the last 5 minutes of a 5-minute rule, not the 15 fetched", async () => {
    vi.mocked(prisma.assetTelemetrySample.findMany).mockResolvedValue([
      sample(1, 95), sample(4, 95), sample(9, 10), sample(14, 10),
    ] as never);
    const [r] = await resolveAssetMetricReadings(cpu({}), [asset]);
    // Was (95+95+10+10)/4 = 52.5, under the threshold; now 95, over it.
    expect(r!.value).toBe(95);
  });

  it("a window narrower than the polling interval uses the newest reading", async () => {
    // 10-minute polling, 5-minute window: nothing inside it.
    vi.mocked(prisma.assetTelemetrySample.findMany).mockResolvedValue([sample(7, 93), sample(14, 20)] as never);
    const [r] = await resolveAssetMetricReadings(cpu({}), [asset]);
    expect(r!.value).toBe(93);
  });

  it("never reaches further back than the old 15-minute span for that stand-in", async () => {
    // A reset widened the fetch (recoveryLookbackMs); the newest reading is 20 min old.
    vi.mocked(prisma.assetTelemetrySample.findMany).mockResolvedValue([sample(20, 99)] as never);
    const [r] = await resolveAssetMetricReadings(cpu({ recoveryLookbackMs: 60 * 60_000 }), [asset]);
    expect(r!.value).toBeNull();
  });

  it("leaves latest-aggregation rules exactly as they were", async () => {
    vi.mocked(prisma.assetTelemetrySample.findMany).mockResolvedValue([sample(1, 40), sample(9, 99)] as never);
    const [r] = await resolveAssetMetricReadings(cpu({ aggregation: "latest", windowSec: 0 }), [asset]);
    expect(r!.value).toBe(40);
  });

  it("the Polaris host's own metrics follow the same window", async () => {
    const host = (o: Record<string, unknown>) =>
      ({ type: "host_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90, forDurationSec: 0, ...o }) as unknown as Extract<Trigger, { type: "host_metric" }>;
    vi.mocked(prisma.hostMetricsSample.findMany).mockResolvedValue([
      { timestamp: ago(1), cpuPct: 95 }, { timestamp: ago(4), cpuPct: 95 }, { timestamp: ago(12), cpuPct: 5 },
    ] as never);
    expect((await resolveHostMetricReading(host({})))!.value).toBe(95);
  });
});
