/**
 * tests/unit/tickSampleCache.test.ts — the alert engine reads the telemetry
 * rows for one asset set once per tick (efficiency audit group 2): the High CPU
 * and High memory rules over the same scope asked for the identical rows.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import type { Trigger } from "../../src/services/notificationTypes.js";
import type { ScopeAssetRow } from "../../src/services/notifications/ruleModel.js";
import { resolveAssetMetricReadings, clearTickSampleCache } from "../../src/services/notifications/readings.js";

type MetricTrigger = Extract<Trigger, { type: "asset_metric" }>;
const trig = (metric: string, windowSec = 300): MetricTrigger =>
  ({ type: "asset_metric", metric, aggregation: "latest", windowSec, operator: ">=", threshold: 90, forDurationSec: 0 }) as unknown as MetricTrigger;
const assets = [{ id: "a1", hostname: "h1", tags: [] }, { id: "a2", hostname: "h2", tags: [] }] as unknown as ScopeAssetRow[];
const findMany = () => vi.mocked(prisma.assetTelemetrySample.findMany);

beforeEach(() => {
  resetDbStub();
  const now = Date.now();
  findMany().mockResolvedValue([
    { assetId: "a1", timestamp: new Date(now - 60_000), cpuPct: 95, memPct: 40, memUsedBytes: null, sessionCount: null },
    { assetId: "a2", timestamp: new Date(now - 60_000), cpuPct: 10, memPct: 97, memUsedBytes: null, sessionCount: null },
  ] as never);
});

afterEach(() => clearTickSampleCache(false));

describe("per-tick telemetry rows", () => {
  it("inside a pass, CPU and memory over one asset set share one read", async () => {
    clearTickSampleCache(true);
    const cpu = await resolveAssetMetricReadings(trig("cpuPct"), assets);
    const mem = await resolveAssetMetricReadings(trig("memPct"), assets);
    expect(findMany()).toHaveBeenCalledTimes(1);
    expect(cpu.find((r) => r.assetId === "a1")?.value).toBe(95);
    expect(mem.find((r) => r.assetId === "a2")?.value).toBe(97);
  });

  it("a different asset set, or a window reaching further back, reads again", async () => {
    clearTickSampleCache(true);
    await resolveAssetMetricReadings(trig("cpuPct"), assets);
    await resolveAssetMetricReadings(trig("cpuPct"), assets.slice(0, 1));
    expect(findMany()).toHaveBeenCalledTimes(2);
    await resolveAssetMetricReadings(trig("memPct", 86_400), assets);
    expect(findMany()).toHaveBeenCalledTimes(3);
  });

  it("outside a pass (an operator's preview) every call reads live", async () => {
    clearTickSampleCache(false);
    await resolveAssetMetricReadings(trig("cpuPct"), assets);
    await resolveAssetMetricReadings(trig("memPct"), assets);
    expect(findMany()).toHaveBeenCalledTimes(2);
  });
});
