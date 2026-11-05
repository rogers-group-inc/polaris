/**
 * tests/integration/memoryForecastCountdownLive.test.ts
 *
 * A live memory-forecast alert keeps counting down. "Days until Serious: 6"
 * fires once; while the trend holds, the next day the same alert must read 5,
 * in its message and in the snapshot reminders render from, without a second
 * alert, a re-notify or a new Event. The pure gate is pinned in
 * tests/unit/memoryForecastCountdown.test.ts.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { computeMemoryForecastDetail, computeMemoryProjection, loadMemoryForecastSeries } from "../../src/services/memoryForecastService.js";

const HOST = "mem-forecast-countdown-live";
const RULE = "mem-forecast-countdown-live";
const DAY = 86_400_000;

let assetId = "";

async function wipe(): Promise<void> {
  const rules = await prisma.notificationRule.findMany({ where: { name: { startsWith: RULE } }, select: { id: true } });
  const ids = rules.map((r) => r.id);
  if (ids.length) {
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notificationRule.deleteMany({ where: { id: { in: ids } } });
  }
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  if (assets.length) {
    const aid = assets.map((a) => a.id);
    await prisma.assetTelemetrySampleDaily.deleteMany({ where: { assetId: { in: aid } } });
    await prisma.assetTelemetrySampleHourly.deleteMany({ where: { assetId: { in: aid } } });
    await prisma.asset.deleteMany({ where: { id: { in: aid } } });
  }
}

/** Ten daily points growing 1 %/day and ending at `todayPct`, on the DB's UTC day. */
async function seedTrend(todayPct: number): Promise<void> {
  await prisma.assetTelemetrySampleDaily.deleteMany({ where: { assetId } });
  const [{ today }] = await prisma.$queryRaw<Array<{ today: Date }>>`
    SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AS today`;
  const todayMs = new Date(today).getTime();
  await prisma.assetTelemetrySampleDaily.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      assetId, bucketStart: new Date(todayMs - (9 - i) * DAY), sampleCount: 1440, avgMemPct: todayPct - 9 + i,
    })),
  });
}

dbDescribe("a live memory forecast alert counts down", () => {
  beforeEach(async () => {
    await wipe();
    const asset = await prisma.asset.create({
      data: { hostname: `${HOST}-a`, status: "active", monitored: true, assetType: "server", monitorStatus: "up", lastMonitorAt: new Date() } as never,
    });
    assetId = asset.id;
  });

  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("rewrites the countdown on the same alert as the days go by", async () => {
    const rule = await prisma.notificationRule.create({
      data: {
        name: `${RULE} rule`, enabled: true, severity: "serious",
        trigger: { type: "asset_metric", metric: "memForecastPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 85, forDurationSec: 0, forecastDays: 14 },
        scope: { allAssets: true }, reset: { mode: "auto" }, actions: [],
      } as never,
    });

    await seedTrend(79);
    await evaluateAllNotificationRules();
    const [first] = await prisma.notification.findMany({ where: { ruleId: rule.id, cleared: false } });
    expect(first?.message).toContain("Days until Serious: 6");

    // The same day again: nothing moved, nothing is rewritten.
    await evaluateAllNotificationRules();
    const same = await prisma.notification.findUnique({ where: { id: first!.id } });
    expect(same?.message).toBe(first!.message);

    // A day later on the same trend.
    await seedTrend(80);
    await evaluateAllNotificationRules();
    const live = await prisma.notification.findMany({ where: { ruleId: rule.id, cleared: false } });
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(first!.id);
    expect(live[0]!.message).toContain("Days until Serious: 5");
    expect((live[0]!.templateCtx as Record<string, string>)["forecast.days"]).toBe("5");
    expect(await prisma.notification.count({ where: { ruleId: rule.id } })).toBe(1);
  });

  it("a reboot restarts the forecast and ends the live alert", async () => {
    const rule = await prisma.notificationRule.create({
      data: {
        name: `${RULE} reboot`, enabled: true, severity: "serious",
        trigger: { type: "asset_metric", metric: "memForecastPct", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 85, forDurationSec: 0, forecastDays: 14 },
        scope: { allAssets: true }, reset: { mode: "auto" }, actions: [],
      } as never,
    });
    await seedTrend(79);
    await evaluateAllNotificationRules();
    expect(await prisma.notification.count({ where: { ruleId: rule.id, cleared: false } })).toBe(1);

    // Rebooted two days ago at 10:00 UTC, seen by its uptime. Only yesterday
    // and today follow the boot day: 2 points, short of the 7 a fit needs.
    const todayMs = await dbTodayMs();
    const boot = new Date(todayMs - 2 * DAY + 10 * 3_600_000);
    await markRebooted(boot);
    await evaluateAllNotificationRules();
    expect(await prisma.notification.count({ where: { ruleId: rule.id, cleared: false } })).toBe(0);

    const series = await loadMemoryForecastSeries(assetId);
    expect(series.points).toHaveLength(2);
    expect(series.slopePerDay).toBeNull();
    expect(series.restartedAt).toBe(boot.toISOString());
    const detail = await computeMemoryForecastDetail([assetId]);
    expect(detail.rows).toEqual([]);
    expect(detail.restartedWithoutForecast).toEqual([assetId]);
  });

  it("fits only the days after the boot once there are enough of them", async () => {
    // 20 days: flat at 90 % before a reboot 11 days ago, then 50 % growing
    // 1 %/day. Fitted across the reboot the slope would be steeply NEGATIVE.
    const todayMs = await dbTodayMs();
    await prisma.assetTelemetrySampleDaily.createMany({
      data: Array.from({ length: 20 }, (_, i) => {
        const daysAgo = 19 - i;
        return {
          assetId, bucketStart: new Date(todayMs - daysAgo * DAY), sampleCount: 1440,
          avgMemPct: daysAgo > 11 ? 90 : 50 + (10 - daysAgo),
        };
      }),
    });
    const boot = new Date(todayMs - 11 * DAY + 3 * 3_600_000);
    await markRebooted(boot);
    const [row] = await computeMemoryProjection([assetId], 14);
    expect(row?.slopePctPerDay).toBeCloseTo(1, 3);
    expect(row?.usedPct).toBe(60);
    const series = await loadMemoryForecastSeries(assetId);
    // The boot day's bucket mixes both hosts, so the fit starts the day after.
    expect(series.points).toHaveLength(11);
    expect(series.points[0]!.v).toBe(50);
  });

  it("ignores a reboot older than the lookback", async () => {
    await seedTrend(79);
    await markRebooted(new Date((await dbTodayMs()) - 45 * DAY));
    const [row] = await computeMemoryProjection([assetId], 14);
    expect(row?.slopePctPerDay).toBeCloseTo(1, 3);
    expect((await loadMemoryForecastSeries(assetId)).restartedAt).toBeNull();
  });
});

async function dbTodayMs(): Promise<number> {
  const [{ today }] = await prisma.$queryRaw<Array<{ today: Date }>>`
    SELECT date_trunc('day', now() AT TIME ZONE 'UTC') AS today`;
  return new Date(today).getTime();
}

/** The asset as monitoring leaves it after seeing its uptime drop at `boot`. */
async function markRebooted(boot: Date): Promise<void> {
  const seen = new Date();
  await prisma.asset.update({
    where: { id: assetId },
    data: { lastRebootAt: boot, lastMonitorAt: seen, lastUptimeSec: Math.round((seen.getTime() - boot.getTime()) / 1000) },
  });
}
