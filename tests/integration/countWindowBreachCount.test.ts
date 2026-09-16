/**
 * tests/integration/countWindowBreachCount.test.ts
 *
 * The engine half of COUNT-WINDOWED aggregation (business rule 66): does "the
 * average of the last N responses, over the line M times running" actually
 * behave that way against real sample rows?
 *
 * The cases here are the ones the TIME window gets wrong, and the ones a naive
 * count window would get wrong:
 *  - a miss must not shrink the window — the same N real values must give the
 *    same reading whether or not failed probes are interleaved with them;
 *  - a partial window must produce NO reading, not an average of what landed;
 *  - the hold must count RECALCULATIONS of the window, so one spike inside an
 *    otherwise healthy window never starts the run;
 *  - a genuine climb must fire on the Mth recalculation and not before.
 *
 * The pure arithmetic is pinned in tests/unit/notificationCountWindow.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const d = dbDescribe;
const HOST = "count-window-test";
const RULE = "count-window-test rule";

let assetId = "";
let ruleId = "";

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
    await prisma.assetMonitorSample.deleteMany({ where: { assetId: { in: assets.map((a) => a.id) } } });
    await prisma.asset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
  }
}

/**
 * `values` newest-LAST, one per minute. A `null` is a FAILED probe: the row
 * exists (the probe ran) and carries a NULL responseTimeMs, which is exactly
 * what recordProbeResult writes and the only thing a NULL there can mean.
 */
async function seedProbes(values: Array<number | null>, agoMin = 0): Promise<void> {
  const now = Date.now();
  await prisma.assetMonitorSample.createMany({
    data: values.map((v, i) => ({
      assetId,
      timestamp: new Date(now - (agoMin + (values.length - 1 - i)) * 60_000),
      success: v !== null,
      responseTimeMs: v,
      probeKind: "primary",
    })),
  });
}

/** The shape the builder writes: both counts, each with its wall-clock mirror
 *  at a 60s cadence. `windowSec`/`forDurationSec` size the engine's fetch. */
async function seedRule(windowPolls: number, forPolls: number, threshold = 500): Promise<void> {
  const rule = await prisma.notificationRule.create({
    data: {
      name: RULE,
      enabled: true,
      severity: "warning",
      trigger: {
        type: "asset_metric", metric: "responseTimeMs", aggregation: "avg",
        operator: ">", threshold,
        windowPolls, windowSec: windowPolls * 60,
        forPolls, forDurationSec: forPolls * 60,
      },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      actions: [],
    } as never,
  });
  ruleId = rule.id;
}

async function activeAlerts(): Promise<number> {
  return prisma.notification.count({ where: { ruleId, clearedAt: null } });
}

async function lastValue(): Promise<number | null> {
  const st = await prisma.notificationRuleState.findFirst({ where: { ruleId }, select: { lastValue: true } });
  return st?.lastValue ?? null;
}

d("count-windowed aggregation + breach counter", () => {
  beforeEach(async () => {
    await wipe();
    const asset = await prisma.asset.create({
      data: {
        hostname: `${HOST}-a`, status: "active", monitored: true, assetType: "server",
        monitorStatus: "up", lastMonitorAt: new Date(),
      } as never,
    });
    assetId = asset.id;
  });

  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("reads the last N SUCCESSFUL responses, unmoved by the misses between them", async () => {
    // THE POINT. Three real responses averaging 507, with seven failed probes
    // interleaved. A time window would have divided by whatever landed; this
    // divides by three and reads what the device does when it answers.
    await seedRule(3, 1);
    await seedProbes([501, null, null, 500, null, null, null, 520, null, null]);
    await evaluateAllNotificationRules();
    const v = await lastValue();
    expect(v).toBeCloseTo(507, 0);
    expect(await activeAlerts()).toBe(1);
  });

  it("gives the SAME reading as the identical values with no misses at all", async () => {
    // The equality that defines the rule: loss changes how far back the window
    // reaches, never what it measures.
    await seedRule(3, 1);
    await seedProbes([501, 500, 520]);
    await evaluateAllNotificationRules();
    expect(await lastValue()).toBeCloseTo(507, 0);
  });

  it("produces NO reading below a full window, rather than averaging what landed", async () => {
    // Two real responses cannot fill a window of three. An aggregate over a
    // partial window is a different statistic under the same threshold, so the
    // asset is skipped exactly as one that has reported nothing is.
    await seedRule(3, 1);
    await seedProbes([900, null, null, 900, null]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
    expect(await lastValue()).toBeNull();
  });

  it("does not fire on a single spike inside an otherwise healthy window", async () => {
    // One 1500 ms response among healthy ones: no 5-reading average clears 500,
    // so the breach counter never starts. This is the composition a time window
    // cannot express.
    await seedRule(5, 3);
    await seedProbes([118, 115, 125, 110, 1500, 130, 120]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
    expect((await lastValue()) ?? 0).toBeLessThan(500);
  });

  it("counts RECALCULATIONS, not samples: 2 of a 3-breach hold does not fire", async () => {
    // Seven readings, a 3-wide window -> five recalculations, but only the
    // newest two clear the line (the third-newest window still holds a 100).
    await seedRule(3, 3);
    await seedProbes([100, 100, 100, 100, 900, 900, 900]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
  });

  it("fires on the Mth consecutive recalculation over the line", async () => {
    await seedRule(3, 3);
    await seedProbes([100, 100, 100, 900, 900, 900, 900, 900]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);
  });

  it("takes longer on a lossy device, because it waits for MEASUREMENTS", async () => {
    // The consequence of only-successes-recalculate, stated as a test: the same
    // rule that fires on 5 consecutive readings needs 5 consecutive SUCCESSES,
    // however many failed probes are mixed in among them.
    await seedRule(3, 3);
    // 5 successes over the line but spread across 13 probe slots.
    await seedProbes([100, 100, 100, null, 900, null, 900, null, null, 900, null, 900, null]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);
  });
});
