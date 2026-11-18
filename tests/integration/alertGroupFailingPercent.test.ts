/**
 * tests/integration/alertGroupFailingPercent.test.ts
 *
 * Business rule 193: an alert group with a percent threshold.
 *  - below the threshold there is no alert at all, and no contribution is
 *    written to state (each re-fires next tick and is counted again);
 *  - at the threshold ONE alert opens naming every failing device, and its
 *    `notification.triggered` Event carries the count that crossed;
 *  - once up it ends only when the last member recovers (rule 75) — falling
 *    back under the threshold does not end it;
 *  - the denominator is the devices the automations READ, so a whole-group fold
 *    counts devices across member automations;
 *  - a per-device fold stores no threshold, and a disabled group's is ignored.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { createGroup, updateGroup } from "../../src/services/alertGroupService.js";
import type { AlertMember } from "../../src/services/notificationTypes.js";

const d = dbDescribe;
const HOST = "fail-pct-test";
const NAME = "fail-pct-test";

let channelId = "";

async function wipe(): Promise<void> {
  const rules = await prisma.notificationRule.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  const ids = rules.map((r) => r.id);
  if (ids.length) {
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notificationRule.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

/** A switch with two PoE ports, faulted or not (rule 57's carve-out: read off
 *  AssetInterface, no pin, no samples — so a healthy switch still reports). */
async function seedSwitch(name: string, faulted: boolean): Promise<string> {
  const now = new Date();
  const asset = await prisma.asset.create({
    data: { hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "switch", monitorStatus: "up", lastSeen: now, lastMonitorAt: now } as never,
    select: { id: true },
  });
  await prisma.assetInterface.createMany({
    data: ["port2", "port5"].map((ifName) => ({
      assetId: asset.id, ifName, poeStatus: faulted ? "fault" : "delivering", operStatus: "up", adminStatus: "up",
      ifType: "ethernetCsmacd", firstSeen: now, lastSeen: now,
    })),
  });
  return asset.id;
}
const setPoe = (assetId: string, poeStatus: string) => prisma.assetInterface.updateMany({ where: { assetId }, data: { poeStatus } });

async function seedRule(suffix: string, trigger: Record<string, unknown>): Promise<string> {
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} ${suffix}`, enabled: true, severity: "serious", trigger,
      scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
      reset: { mode: "auto" }, actions: [], channels: ["in_app"],
    } as never,
    select: { id: true },
  });
  return r.id;
}
const poeRule = () => seedRule("poe", { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" });

async function seedGroup(foldBy: string, ruleIds: string[], minFailingPercent: number | null): Promise<string> {
  const g = await createGroup({
    name: `${NAME} group`, foldBy: foldBy as never, ruleIds, minFailingPercent,
    actions: [{ type: "notify", channelId, addresses: ["noc@example.test"] }],
  }, "tester");
  return g.id;
}

const live = (groupId: string) => prisma.notification.findMany({ where: { alertGroupId: groupId, cleared: false } });
const activeMembers = (n: { members: unknown }) => ((n.members ?? []) as AlertMember[]).filter((m) => !m.leftAt);

d("alert group percent threshold (business rule 193)", () => {
  beforeEach(async () => {
    await wipe();
    const ch = await prisma.notificationChannel.create({ data: { name: `${NAME} smtp`, type: "smtp", enabled: true, config: {} }, select: { id: true } });
    channelId = ch.id;
  });
  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("raises nothing below the threshold, then one alert with every failing device at it", async () => {
    await seedSwitch("a", true);
    await seedSwitch("b", true);
    const c = await seedSwitch("c", false);
    await seedSwitch("d", false);
    const ruleId = await poeRule();
    const groupId = await seedGroup("automation", [ruleId], 75);

    // 2 of 4 = 50 % < 75 %: no alert, and nothing written to state.
    await evaluateAllNotificationRules();
    expect(await live(groupId)).toHaveLength(0);
    expect(await prisma.notification.count({ where: { ruleId, cleared: false } })).toBe(0);
    expect(await prisma.notificationRuleState.count({ where: { ruleId, state: "firing" } })).toBe(0);

    // Still below on the next tick: still nothing.
    await evaluateAllNotificationRules();
    expect(await live(groupId)).toHaveLength(0);

    // 3 of 4 = 75 %: one alert, all three devices in it.
    await setPoe(c, "fault");
    await evaluateAllNotificationRules();
    const rows = await live(groupId);
    expect(rows).toHaveLength(1);
    expect(new Set(activeMembers(rows[0]!).map((m) => m.assetId)).size).toBe(3);
    const ev = await prisma.event.findFirst({
      where: { action: "notification.triggered", resourceId: rows[0]!.id },
      select: { details: true },
    });
    expect((ev?.details as Record<string, unknown>)?.failingPercent).toEqual({ failing: 3, reporting: 4, percent: 75 });
  });

  it("once up, dropping under the threshold does not end it — the last recovery does", async () => {
    const a = await seedSwitch("a", true);
    const b = await seedSwitch("b", true);
    await seedSwitch("c", false);
    await seedSwitch("d", false);
    const ruleId = await poeRule();
    const groupId = await seedGroup("automation", [ruleId], 50);
    await evaluateAllNotificationRules();
    expect(await live(groupId)).toHaveLength(1);

    // 1 of 4 = 25 %: under the line, but the alert stays up.
    await setPoe(a, "delivering");
    await evaluateAllNotificationRules();
    expect(await live(groupId)).toHaveLength(1);

    await setPoe(b, "delivering");
    await evaluateAllNotificationRules();
    expect(await live(groupId)).toHaveLength(0);
  });

  it("a whole-group fold counts devices across member automations", async () => {
    // a: PoE fault. b: monitor status down. c, d: healthy. 2 failing of 4.
    await seedSwitch("a", true);
    const b = await seedSwitch("b", false);
    await prisma.asset.update({ where: { id: b }, data: { monitorStatus: "down" } });
    await seedSwitch("c", false);
    await seedSwitch("d", false);
    const poe = await poeRule();
    const down = await seedRule("down", { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" });
    const groupId = await seedGroup("deviceAutomation", [poe, down], 75);

    await evaluateAllNotificationRules();
    expect(await live(groupId)).toHaveLength(0);

    await updateGroup(groupId, { name: `${NAME} group`, foldBy: "deviceAutomation", minFailingPercent: 50 }, "tester");
    await evaluateAllNotificationRules();
    const rows = await live(groupId);
    expect(rows).toHaveLength(1);
    const ms = activeMembers(rows[0]!);
    expect(new Set(ms.map((m) => m.assetId)).size).toBe(2);
    expect(new Set(ms.map((m) => m.ruleId))).toEqual(new Set([poe, down]));
  });

  it("a per-device fold stores no threshold", async () => {
    const ruleId = await poeRule();
    const groupId = await seedGroup("device", [ruleId], 80);
    const g = await prisma.alertGroup.findUnique({ where: { id: groupId }, select: { minFailingPercent: true } });
    expect(g?.minFailingPercent).toBeNull();
  });

  it("switching to a per-device fold drops a stored threshold", async () => {
    const ruleId = await poeRule();
    const groupId = await seedGroup("automation", [ruleId], 60);
    expect((await prisma.alertGroup.findUnique({ where: { id: groupId } }))?.minFailingPercent).toBe(60);
    await updateGroup(groupId, { name: `${NAME} group`, foldBy: "device" }, "tester");
    expect((await prisma.alertGroup.findUnique({ where: { id: groupId } }))?.minFailingPercent).toBeNull();
  });

  it("a disabled group's threshold is ignored: its member alerts on its own", async () => {
    await seedSwitch("a", true);
    await seedSwitch("b", false);
    await seedSwitch("c", false);
    await seedSwitch("d", false);
    const ruleId = await poeRule();
    const groupId = await seedGroup("automation", [ruleId], 100);
    await prisma.alertGroup.update({ where: { id: groupId }, data: { enabled: false } });
    await evaluateAllNotificationRules();
    expect(await prisma.notification.count({ where: { ruleId, cleared: false } })).toBeGreaterThan(0);
    expect(await live(groupId)).toHaveLength(0);
  });
});
