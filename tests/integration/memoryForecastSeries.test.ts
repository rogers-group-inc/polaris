/**
 * tests/integration/memoryForecastSeries.test.ts
 *
 * The Memory chart's forecast headline must say the same "days until full"
 * a memDaysUntilFull automation compares. The automation's number comes from
 * `computeMemoryForecast` (one fleet-wide regr_slope query); the chart's from
 * `loadMemoryForecastSeries` (the same daily points for one asset, fitted in
 * JS). Only a real Postgres proves the shared CTE binds its parameters in
 * both shapes, that the hourly tail wins over a stale daily bucket for the
 * same day, that bytes beat the source's own percentage, and that a second
 * asset does not leak into the first one's fit.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, ensureTestUser } from "./_helpers.js";
import { computeMemoryForecast, computeMemoryProjection, loadMemoryForecastSeries, projectMemoryPct } from "../../src/services/memoryForecastService.js";
import { previewRule, previewAlertMessage } from "../../src/services/notificationEngine.js";
import { previewInputSchema, ruleInputSchema } from "../../src/services/notificationTypes.js";
import { createRule } from "../../src/services/notificationRuleService.js";

const GROWING = "it-mem-forecast-growing";
const PCT_ONLY = "it-mem-forecast-pct-only";
const IDS = [GROWING, PCT_ONLY];
const GB = 1024 ** 3;
const TOTAL = 16 * GB;
const DAY = 86_400_000;

async function wipe() {
  await prisma.assetTelemetrySampleDaily.deleteMany({ where: { assetId: { in: IDS } } });
  await prisma.assetTelemetrySampleHourly.deleteMany({ where: { assetId: { in: IDS } } });
  await prisma.asset.deleteMany({ where: { id: { in: IDS } } });
}

dbDescribe("memory forecast series for the Memory chart", () => {
  beforeAll(async () => {
    await ensureTestUser();
    await wipe();
    // Monitored, so the engine's rule-37 gate lets them through.
    for (const [i, id] of IDS.entries()) {
      await prisma.asset.create({
        data: { id, hostname: id, assetType: "server", status: "active", ipAddress: `10.78.0.${i + 1}`, monitored: true, monitorStatus: "up" } as never,
      });
    }
    // Day buckets relative to the DATABASE's UTC day — the forecast windows
    // on now() AT TIME ZONE 'UTC', and a drifted VM clock would otherwise
    // age every row out.
    const [{ today }] = await prisma.$queryRaw<Array<{ today: Date }>>`
      SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AS today`;
    const todayMs = new Date(today).getTime();
    const daily = [];
    for (let d = 14; d >= 0; d--) {
      const i = 14 - d;
      // GROWING: 40% → ~68% over 14 days, 2 points/day, a little noise — in
      // BYTES, with a deliberately wrong avgMemPct the fit must ignore.
      daily.push({
        assetId: GROWING, bucketStart: new Date(todayMs - d * DAY), sampleCount: 1440,
        avgMemUsedBytes: BigInt(Math.round(((40 + i * 2 + (i % 3) * 0.2) / 100) * TOTAL)),
        lastMemTotalBytes: BigInt(TOTAL), avgMemPct: 5,
      });
      // PCT_ONLY: the FortiOS shape — a shrinking percentage, no bytes.
      daily.push({ assetId: PCT_ONLY, bucketStart: new Date(todayMs - d * DAY), sampleCount: 1440, avgMemPct: 70 - i });
    }
    await prisma.assetTelemetrySampleDaily.createMany({ data: daily });
    // Today's daily bucket is stale (written at 00:15); the hourly tier has
    // moved on. The hourly figure is the one that must count.
    await prisma.assetTelemetrySampleDaily.updateMany({
      where: { assetId: GROWING, bucketStart: new Date(todayMs) },
      data: { avgMemUsedBytes: BigInt(Math.round(0.10 * TOTAL)) },
    });
    await prisma.assetTelemetrySampleHourly.createMany({
      data: [0, 1].map((h) => ({
        assetId: GROWING, bucketStart: new Date(todayMs + h * 3_600_000), sampleCount: 60,
        avgMemUsedBytes: BigInt(Math.round(0.68 * TOTAL)), lastMemTotalBytes: BigInt(TOTAL),
      })),
    });
  });

  afterAll(wipe);

  it("fits the same days-until-full as the automation's fleet query", async () => {
    const fleet = await computeMemoryForecast(IDS);
    const row = fleet.find((r) => r.assetId === GROWING);
    expect(row).toBeDefined();
    const series = await loadMemoryForecastSeries(GROWING);
    expect(series.daysUntilFull).not.toBeNull();
    expect(series.daysUntilFull).toBeCloseTo(row!.daysUntilFull, 1);
    expect(series.slopePerDay).toBeCloseTo(row!.slopePctPerDay, 2);
    // ~2 points/day from ~68% → roughly 16 days.
    expect(row!.daysUntilFull).toBeGreaterThan(12);
    expect(row!.daysUntilFull).toBeLessThan(20);
  });

  it("takes today's point from the hourly tier and fits bytes, not the wrong percentage", async () => {
    const series = await loadMemoryForecastSeries(GROWING);
    expect(series.points).toHaveLength(15);
    const last = series.points[series.points.length - 1]!;
    expect(last.v).toBeCloseTo(68, 0);
    expect(series.points.every((p) => p.v > 30)).toBe(true);
  });

  it("keeps a shrinking percentage-only host out of the automation, with its trend for the chart", async () => {
    const fleet = await computeMemoryForecast(IDS);
    expect(fleet.find((r) => r.assetId === PCT_ONLY)).toBeUndefined();
    const series = await loadMemoryForecastSeries(PCT_ONLY);
    expect(series.points).toHaveLength(15);
    expect(series.slopePerDay).toBeCloseTo(-1, 3);
    expect(series.daysUntilFull).toBeNull();
  });

  it("is what a memDaysUntilFull automation reads — one reading per device, growing hosts only", async () => {
    const res = await previewRule(previewInputSchema.parse({
      name: "preview",
      trigger: { type: "asset_metric", metric: "memDaysUntilFull", aggregation: "latest", operator: "<=", threshold: 30, forDurationSec: 0 },
      scope: { assetIds: IDS },
    }) as never);
    const matches = (res as { matches: Array<{ assetId: string; value: number; dimLabel?: string }> }).matches;
    const fleet = await computeMemoryForecast(IDS);
    expect(matches.map((m) => m.assetId)).toEqual([GROWING]);
    expect(matches[0]!.value).toBe(fleet[0]!.daysUntilFull);
  });

  it("is what a memForecastPct automation reads — the level reached within its horizon, growing hosts only", async () => {
    const preview = async (forecastDays: number) => {
      const res = await previewRule(previewInputSchema.parse({
        name: "preview",
        trigger: { type: "asset_metric", metric: "memForecastPct", aggregation: "latest", operator: ">=", threshold: 80, forDurationSec: 0, forecastDays },
        scope: { assetIds: IDS },
      }) as never);
      // The preview lists every evaluated device; the shrinking host is there
      // with a null reading that does not meet.
      return (res as { matches: Array<{ assetId: string; value: number; meets: boolean }> }).matches.filter((m) => m.meets);
    };
    // ~68% growing ~2 points/day: past 80% inside 14 days, not inside 3.
    const proj = await computeMemoryProjection(IDS, 14);
    const grow = proj.find((r) => r.assetId === GROWING)!;
    expect(grow.projectedPct).toBe(projectMemoryPct(grow.usedPct, grow.slopePctPerDay, 14));
    expect(grow.projectedPct!).toBeGreaterThan(80);
    // The shrinking host still has a row — a NULL one, so a live alert ends.
    expect(proj.find((r) => r.assetId === PCT_ONLY)?.projectedPct).toBeNull();
    const within14 = await preview(14);
    expect(within14.map((m) => m.assetId)).toEqual([GROWING]);
    expect(within14[0]!.value).toBeCloseTo(grow.projectedPct!, 0);
    expect(await preview(3)).toEqual([]);
  });

  it("links a forecast to a memory-utilization automation's levels, and says 'Days until <level>'", async () => {
    const created: string[] = [];
    try {
      const source = await createRule(ruleInputSchema.parse({
        name: "it-mem-forecast high memory",
        severity: "serious",
        trigger: { type: "asset_metric", metric: "memPct", aggregation: "latest", operator: ">=", threshold: 85 },
        severityBands: [{ threshold: 90, severity: "critical", actions: [] }],
        scope: { assetIds: IDS },
        actions: [],
      }) as never);
      created.push(source.id);
      const forecast = await createRule(ruleInputSchema.parse({
        name: "it-mem-forecast linked",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "memForecastPct", aggregation: "latest", operator: ">=", threshold: 50, forecastDays: 14, levelsFromRuleId: source.id },
        scope: { assetIds: IDS },
        actions: [],
      }) as never);
      created.push(forecast.id);
      // The source's levels are stored on the forecast at save.
      expect(forecast.severity).toBe("serious");
      expect((forecast.trigger as { threshold: number }).threshold).toBe(85);
      expect((forecast.severityBands as Array<{ threshold: number; severity: string }>).map((b) => [b.threshold, b.severity])).toEqual([[90, "critical"]]);

      // ~68% growing ~2 points/day reaches 85% in ~8-9 days: the example
      // message counts down to Serious, not to the 96% the trend reaches.
      const ex = await previewAlertMessage(previewInputSchema.parse({
        name: "it-mem-forecast linked",
        severity: "warning",
        trigger: { type: "asset_metric", metric: "memForecastPct", aggregation: "latest", operator: ">=", threshold: 50, forDurationSec: 0, forecastDays: 14, levelsFromRuleId: source.id },
        scope: { assetIds: IDS },
      }) as never, GROWING);
      expect(ex.message).toMatch(/^it-mem-forecast-growing — Days until Serious: \d+$/);

      // A source that cannot lend levels is refused.
      await expect(createRule(ruleInputSchema.parse({
        name: "it-mem-forecast self", severity: "warning",
        trigger: { type: "asset_metric", metric: "memForecastPct", aggregation: "latest", operator: ">=", threshold: 80, levelsFromRuleId: forecast.id },
        scope: { assetIds: IDS }, actions: [],
      }) as never)).rejects.toThrow(/Memory utilization/);
    } finally {
      await prisma.notificationRule.deleteMany({ where: { id: { in: created } } });
    }
  });

  it("serves the chart's series over GET /assets/:id/memory-forecast", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${GROWING}/memory-forecast`);
    expect(res.status).toBe(200);
    const fleet = await computeMemoryForecast([GROWING]);
    expect(res.body.daysUntilFull).toBeCloseTo(fleet[0]!.daysUntilFull, 1);
    expect(res.body.points).toHaveLength(15);
    expect(res.body.minPoints).toBe(7);
  });
});
