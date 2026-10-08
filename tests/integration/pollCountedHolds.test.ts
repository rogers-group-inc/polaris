/**
 * tests/integration/pollCountedHolds.test.ts
 *
 * The engine half of poll-counted holds: does "sustained for 3 polls" actually
 * wait for three READINGS?
 *
 * This is the behaviour the wall-clock hold could not express, and every case
 * here is one it got wrong (FOR_POLLS_NOTE in notificationTypes):
 *  - two qualifying samples must NOT fire a 3-poll hold, however long the
 *    condition has been true in wall-clock terms;
 *  - a device that stopped reporting must NOT satisfy a hold at all — the old
 *    path re-read its last over-threshold sample at every 60s tick and fired on
 *    that one reading;
 *  - a reading back under the line ENDS the run, so the count restarts;
 *  - "must stay cleared for N polls" is the same count on the way out.
 *
 * The pure decision functions are pinned in tests/unit/notificationPollHolds.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const d = dbDescribe;
const HOST = "poll-hold-test";
const RULE = "poll-hold-test rule";

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
    // Sample tables carry assetId but no FK (they are hypertables), so they are
    // cleaned by id rather than by cascade.
    await prisma.assetTelemetrySample.deleteMany({ where: { assetId: { in: assets.map((a) => a.id) } } });
    await prisma.asset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
  }
}

/** `values` newest-LAST, one per minute ending `agoMin` minutes ago. */
async function seedSamples(values: number[], agoMin = 0): Promise<void> {
  const now = Date.now();
  await prisma.assetTelemetrySample.createMany({
    data: values.map((v, i) => ({
      assetId,
      timestamp: new Date(now - (agoMin + (values.length - 1 - i)) * 60_000),
      cpuPct: v,
    })),
  });
}

async function seedRule(over: Record<string, unknown> = {}, resetOver: Record<string, unknown> = {}): Promise<void> {
  const rule = await prisma.notificationRule.create({
    data: {
      name: RULE,
      enabled: true,
      severity: "warning",
      trigger: {
        type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0,
        operator: ">=", threshold: 90,
        // 3 readings, mirrored as 3 × a 60s cadence — the shape the wizard writes.
        forPolls: 3, forDurationSec: 180,
        ...over,
      },
      scope: { allAssets: true },
      reset: { mode: "auto", ...resetOver },
      actions: [],
    } as never,
  });
  ruleId = rule.id;
}

async function activeAlerts(): Promise<number> {
  return prisma.notification.count({ where: { ruleId, clearedAt: null } });
}

async function ruleState(): Promise<{ state: string; metRun: number; clearRun: number } | null> {
  const st = await prisma.notificationRuleState.findFirst({ where: { ruleId }, select: { state: true, metRun: true, clearRun: true } });
  return st;
}

d("poll-counted holds", () => {
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

  it("does not fire on two qualifying readings when the hold is three", async () => {
    await seedRule();
    await seedSamples([95, 96]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
    expect((await ruleState())?.state).toBe("pending");
  });

  it("fires on the third consecutive qualifying reading", async () => {
    await seedRule();
    await seedSamples([95, 96, 97]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);
  });

  it("does NOT fire on one stale over-threshold reading, however old the engine's view of it", async () => {
    // The wall-clock hold's worst failure: a device that stops reporting keeps
    // presenting its last sample, so "3 polls" elapsed on a single reading.
    await seedRule();
    await seedSamples([99], 10);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
  });

  it("restarts the count when a reading lands back under the line", async () => {
    await seedRule();
    await seedSamples([95, 96, 40, 97, 98]); // newest two qualify, the 40 broke the run
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
    await seedSamples([99]);                  // third in a row now
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);
  });

  it("fires immediately when the rule asks for one reading", async () => {
    await seedRule({ forPolls: 1, forDurationSec: 60 });
    await seedSamples([95]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);
  });

  it("keeps the wall-clock path for a rule that states only seconds", async () => {
    // Nothing is migrated: a pre-cutover rule still fires the moment its
    // seconds have elapsed, on whatever the newest sample says.
    await seedRule({ forPolls: undefined, forDurationSec: 0 });
    await seedSamples([95]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);
  });

  it("holds the alert until the recovery has lasted its own count of readings", async () => {
    await seedRule({}, { sustainPolls: 2, sustainSec: 120 });
    await seedSamples([95, 96, 97]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);

    await seedSamples([10]);                  // one recovered reading — not enough
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);

    await seedSamples([11]);                  // two in a row — clears
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
  });

  it("a reading back over the line ends the recovery run too", async () => {
    await seedRule({}, { sustainPolls: 3, sustainSec: 180 });
    await seedSamples([95, 96, 97]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);

    await seedSamples([10, 11, 99]);          // newest is over the line again
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);
  });

  // A count-cleared reset on a TIME-windowed trigger: the readings it counts
  // must be fetched even when they reach past the trigger's own window. The
  // 2026-10-08 SD-WAN case — 15 polls to clear, a 900s window, a collector a
  // hair slower than a minute — never held 15 samples inside 900s, so the
  // alert sat at 0% for hours.
  it("clears when the recovery run reaches past the trigger's window", async () => {
    await seedRule(
      { aggregation: "avg", windowSec: 900, forPolls: undefined, forDurationSec: 0, threshold: 20 },
      { sustainPolls: 15, sustainSec: 900 },
    );
    await seedSamples([35, 35, 35]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(1);

    // 20 recovered samples 61s apart, the newest 59s old: only 14 of them sit
    // inside 900s, so a fetch sized from the window alone can never count 15.
    await prisma.assetTelemetrySample.deleteMany({ where: { assetId } });
    const now = Date.now();
    await prisma.assetTelemetrySample.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({ assetId, timestamp: new Date(now - 59_000 - i * 61_000), cpuPct: 0 })),
    });
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
  });

  it("widening the fetch for the clear does not widen the average", async () => {
    // Older samples sit far over the line; the 900s window is clean. An
    // average over everything fetched (30 min) would fire.
    await seedRule(
      { aggregation: "avg", windowSec: 900, forPolls: undefined, forDurationSec: 0, threshold: 20 },
      { sustainPolls: 15, sustainSec: 900 },
    );
    await seedSamples([100, 100, 100, 100, 100, 100, 100, 100, 100, 100], 16);
    await seedSamples([0, 0, 0, 0, 0]);
    await evaluateAllNotificationRules();
    expect(await activeAlerts()).toBe(0);
  });
});
