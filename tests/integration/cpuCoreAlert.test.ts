/**
 * tests/integration/cpuCoreAlert.test.ts
 *
 * The per-core CPU automation metric (`cpuCorePct`, "CPU core utilization")
 * and business rule 89:
 *  - the hold is counted PER CORE: the same core over the line for N polls
 *    fires, a hot thread hopping between cores does not;
 *  - one alert per DEVICE, whose message names the cores — even while the
 *    all-cores average is low;
 *  - a device with no per-core data has no reading at all;
 *  - while the device carries a live all-cores `cpuPct` alert, the per-core
 *    automation does not fire on it, and an alert it already raised is
 *    cleared as superseded — including in the tick the all-cores alert fires.
 *
 * The pure helpers are pinned in tests/unit/cpuCores.test.ts.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const d = dbDescribe;
const HOST = "cpu-core-alert-test";
const RULE = "cpu-core-alert-test";

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
    await prisma.assetTelemetrySample.deleteMany({ where: { assetId: { in: assets.map((a) => a.id) } } });
    await prisma.asset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
  }
}

/** One sample per entry, newest LAST, a minute apart and ending now. */
async function seed(samples: Array<{ cpuPct: number; cores: number[] | null }>): Promise<void> {
  const now = Date.now();
  await prisma.assetTelemetrySample.createMany({
    data: samples.map((s, i) => ({
      assetId,
      timestamp: new Date(now - (samples.length - 1 - i) * 60_000 - 1_000),
      cpuPct: s.cpuPct,
      ...(s.cores ? { cpuCorePcts: s.cores } : {}),
    })),
  });
}

async function seedRule(name: string, metric: "cpuPct" | "cpuCorePct", over: Record<string, unknown> = {}): Promise<string> {
  const rule = await prisma.notificationRule.create({
    data: {
      name: `${RULE} ${name}`,
      enabled: true,
      severity: "warning",
      trigger: { type: "asset_metric", metric, aggregation: "latest", windowSec: 0, operator: ">=", threshold: 90, forDurationSec: 0, ...over },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      actions: [],
    } as never,
  });
  return rule.id;
}

async function live(ruleId: string) {
  return prisma.notification.findMany({ where: { ruleId, cleared: false } });
}

d("per-core CPU alert (business rule 89)", () => {
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

  it("fires on one hot core while the average is low, and names the hot cores", async () => {
    const coreRule = await seedRule("core", "cpuCorePct");
    await seed([{ cpuPct: 30, cores: [10, 97, 12, 93] }]);
    await evaluateAllNotificationRules();
    const alerts = await live(coreRule);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.metric).toBe("cpuCorePct");
    expect(alerts[0]!.message).toContain("Core 1 (97%), Core 3 (93%)");
    expect(alerts[0]!.message).not.toContain("Core 0");
    // the cores carry their own readings — no "cpuCorePct = 97" repeating one
    expect(alerts[0]!.message).toMatch(/\[Core 1 \(97%\), Core 3 \(93%\)\] \(threshold 90\)$/);
    expect(alerts[0]!.message).not.toContain("cpuCorePct =");
  });

  it("fires when the SAME core is over the line for the held number of polls, naming it", async () => {
    const coreRule = await seedRule("core", "cpuCorePct", { forPolls: 3, forDurationSec: 180 });
    await seed([
      { cpuPct: 20, cores: [10, 96, 12, 5] },
      { cpuPct: 20, cores: [10, 94, 12, 5] },
      { cpuPct: 20, cores: [91, 97, 12, 5] },
    ]);
    await evaluateAllNotificationRules();
    const alerts = await live(coreRule);
    expect(alerts).toHaveLength(1);
    // core 0 is over the line too, but only on the newest poll — not named
    expect(alerts[0]!.message).toContain("[Core 1 (97%)]");
  });

  it("does not fire when a different core is hot on each poll", async () => {
    const coreRule = await seedRule("core", "cpuCorePct", { forPolls: 3, forDurationSec: 180 });
    await seed([
      { cpuPct: 30, cores: [96, 10, 10, 10] },
      { cpuPct: 30, cores: [10, 96, 10, 10] },
      { cpuPct: 30, cores: [10, 10, 96, 10] },
    ]);
    await evaluateAllNotificationRules();
    expect(await live(coreRule)).toHaveLength(0);
  });

  it("has no reading on a device that reports no per-core data", async () => {
    const coreRule = await seedRule("core", "cpuCorePct");
    await seed([{ cpuPct: 99, cores: null }]);
    await evaluateAllNotificationRules();
    expect(await live(coreRule)).toHaveLength(0);
  });

  it("stays silent on a device the all-cores alert fires on in the same tick", async () => {
    const coreRule = await seedRule("core", "cpuCorePct");
    const allRule = await seedRule("all", "cpuPct");
    await seed([{ cpuPct: 95, cores: [96, 94, 95, 95] }]);
    await evaluateAllNotificationRules();
    expect(await live(allRule)).toHaveLength(1);
    expect(await live(coreRule)).toHaveLength(0);
  });

  it("clears a live per-core alert as superseded once the all-cores alert fires", async () => {
    const coreRule = await seedRule("core", "cpuCorePct");
    await seed([{ cpuPct: 40, cores: [99, 10, 20, 30] }]);
    await evaluateAllNotificationRules();
    const [coreAlert] = await live(coreRule);
    expect(coreAlert).toBeTruthy();

    const allRule = await seedRule("all", "cpuPct");
    await seed([{ cpuPct: 95, cores: [99, 92, 94, 95] }]);
    await evaluateAllNotificationRules();
    expect(await live(allRule)).toHaveLength(1);
    expect(await live(coreRule)).toHaveLength(0);
    const cleared = await prisma.notification.findUnique({ where: { id: coreAlert!.id } });
    expect(cleared?.cleared).toBe(true);
    const ev = await prisma.event.findFirst({
      where: { action: "notification.superseded", resourceId: coreAlert!.id },
      select: { details: true },
    });
    expect((ev?.details as { reason?: string } | null)?.reason).toBe("all-cores-cpu");
  });
});
