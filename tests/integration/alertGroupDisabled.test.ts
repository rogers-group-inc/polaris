/**
 * tests/integration/alertGroupDisabled.test.ts
 *
 * Business rule 75(b): a DISABLED alert group governs nothing.
 *  - its member automations alert exactly as they would outside it: one alert
 *    per device, keyed on the automation, with no group stamp — never folded
 *    the group's way;
 *  - a live alert still folded under a disabled group (raised before the fix,
 *    or by a write that bypassed the group's own disable) is retired on the
 *    next tick and raised again the member's own way.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const d = dbDescribe;
const HOST = "disabled-group-test";
const NAME = "disabled-group-test";

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

/** A switch with two faulted PoE ports (rule 57's carve-out: read off
 *  AssetInterface, no pin, no samples). */
async function seedSwitch(name: string): Promise<string> {
  const now = new Date();
  const asset = await prisma.asset.create({
    data: { hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "switch", monitorStatus: "up", lastSeen: now, lastMonitorAt: now } as never,
    select: { id: true },
  });
  await prisma.assetInterface.createMany({
    data: ["port2", "port5"].map((ifName) => ({
      assetId: asset.id, ifName, poeStatus: "fault", operStatus: "up", adminStatus: "up",
      ifType: "ethernetCsmacd", firstSeen: now, lastSeen: now,
    })),
  });
  return asset.id;
}

async function seedGroup(enabled: boolean): Promise<{ groupId: string; ruleId: string }> {
  const g = await prisma.alertGroup.create({
    data: { name: `${NAME} group`, enabled, requireAckNote: false, foldBy: "automation", actions: [{ type: "notify", channelId, addresses: ["noc@example.test"] }] } as never,
    select: { id: true },
  });
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} rule`, enabled: true, severity: "serious",
      trigger: { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" },
      scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
      reset: { mode: "auto" }, actions: [], channels: ["in_app"], alertGroupId: g.id,
    } as never,
    select: { id: true },
  });
  return { groupId: g.id, ruleId: r.id };
}

const live = (ruleId: string) => prisma.notification.findMany({
  where: { ruleId, cleared: false },
  select: { id: true, groupKey: true, alertGroupId: true, assetId: true },
});

d("a disabled alert group governs nothing (business rule 75(b))", () => {
  beforeEach(async () => {
    await wipe();
    const ch = await prisma.notificationChannel.create({ data: { name: `${NAME} smtp`, type: "smtp", enabled: true, config: {} }, select: { id: true } });
    channelId = ch.id;
  });
  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("an enabled automation group folds both switches into one alert (the control)", async () => {
    await seedSwitch("a");
    await seedSwitch("b");
    const { ruleId, groupId } = await seedGroup(true);
    await evaluateAllNotificationRules();
    const rows = await live(ruleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alertGroupId).toBe(groupId);
  });

  it("a disabled group's member alerts per device, with no group key or stamp", async () => {
    const a = await seedSwitch("a");
    const b = await seedSwitch("b");
    const { ruleId } = await seedGroup(false);
    await evaluateAllNotificationRules();
    const rows = await live(ruleId);
    // Not one folded alert: one per alert the member makes on its own.
    expect(rows.length).toBeGreaterThan(1);
    expect(new Set(rows.map((r) => r.assetId))).toEqual(new Set([a, b]));
    for (const r of rows) {
      expect(r.alertGroupId).toBeNull();
      expect(r.groupKey ?? "").not.toMatch(/^grp:/);
    }
  });

  it("a live alert folded under a group that is now disabled is retired and raised again unfolded", async () => {
    await seedSwitch("a");
    await seedSwitch("b");
    const { ruleId, groupId } = await seedGroup(true);
    await evaluateAllNotificationRules();
    const [folded] = await live(ruleId);
    expect(folded!.alertGroupId).toBe(groupId);

    // Disabled behind the service's back — the engine must not keep folding.
    await prisma.alertGroup.update({ where: { id: groupId }, data: { enabled: false } });
    await evaluateAllNotificationRules();

    const old = await prisma.notification.findUnique({ where: { id: folded!.id }, select: { cleared: true, clearedBy: true } });
    expect(old).toEqual({ cleared: true, clearedBy: "system:group-disabled" });
    const rows = await live(ruleId);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.alertGroupId).toBeNull();
  });
});
