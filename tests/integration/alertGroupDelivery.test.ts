/**
 * tests/integration/alertGroupDelivery.test.ts
 *
 * Business rule 75, second half: an AlertGroup owns DELIVERY, its member
 * automations own DETECTION — and that holds from the very first message.
 *
 * Escalation, reminders and the acknowledge gate already resolved the group
 * through `alertOwnerOf`; the FIRE did not. `evaluateAllNotificationRules`
 * drained a grouped alert's first send through the member automation's own
 * actions, so the group's recipients never heard about a new alert, and a
 * member with no notify action of its own — the normal shape inside a group —
 * sent nothing at all. The same held for the "Resolved" send and the reset
 * actions. These pin every one of those paths to the owner:
 *  - a governed alert fires through the group's actions, never the member's;
 *  - a member with no actions of its own is still heard;
 *  - a device outside the group's scope, or a disabled group, leaves the member
 *    delivering on its own;
 *  - the reset actions that run when the alert ends are the group's.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { createGroup, updateGroup } from "../../src/services/alertGroupService.js";

const d = dbDescribe;
const HOST = "alert-group-delivery-test";
const RULE = "alert-group-delivery-test";

let channelId = "";
let assetId = "";

async function wipe(): Promise<void> {
  const rules = await prisma.notificationRule.findMany({ where: { name: { startsWith: RULE } }, select: { id: true } });
  const ids = rules.map((r) => r.id);
  if (ids.length) {
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notificationRule.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.alertGroup.deleteMany({ where: { name: { startsWith: RULE } } });
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: RULE } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

/** A monitored switch with three faulted PoE ports. The PoE-fault condition
 *  reads AssetInterface directly (rule 57's carve-out), so these rows ARE the
 *  readings — no pin, no samples. */
async function seedSwitch(name: string): Promise<string> {
  const now = new Date();
  const asset = await prisma.asset.create({
    data: {
      hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "switch",
      monitorStatus: "up", lastSeen: now, lastMonitorAt: now,
    } as never,
    select: { id: true },
  });
  await prisma.assetInterface.createMany({
    data: ["port2", "port5", "port9"].map((ifName) => ({
      assetId: asset.id, ifName, poeStatus: "fault", operStatus: "down", adminStatus: "up",
      ifType: "ethernetCsmacd", firstSeen: now, lastSeen: now,
    })),
  });
  return asset.id;
}

const notify = (address: string) => ({ type: "notify", channelId, addresses: [address] });

async function seedGroup(over: Record<string, unknown> = {}): Promise<string> {
  const g = await prisma.alertGroup.create({
    data: { name: `${RULE} group`, enabled: true, requireAckNote: false, actions: [notify("group@example.test")], ...over } as never,
    select: { id: true },
  });
  return g.id;
}

async function seedMember(alertGroupId: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await prisma.notificationRule.create({
    data: {
      name: `${RULE} poe`,
      enabled: true,
      severity: "serious",
      trigger: { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      actions: [notify("member@example.test")],
      channels: ["in_app"],
      groupByAsset: true,
      alertGroupId,
      ...over,
    } as never,
    select: { id: true },
  });
  return r.id;
}

async function targetsOf(ruleId: string): Promise<string[]> {
  const rows = await prisma.notificationDelivery.findMany({
    where: { notification: { ruleId } },
    select: { target: true },
  });
  return [...new Set(rows.map((r) => r.target))].sort();
}

d("an AlertGroup delivers its alerts from the first message (business rule 75)", () => {
  beforeEach(async () => {
    await wipe();
    const ch = await prisma.notificationChannel.create({
      data: { name: `${RULE} smtp`, type: "smtp", enabled: true, config: {} },
      select: { id: true },
    });
    channelId = ch.id;
    assetId = await seedSwitch("a");
  });

  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("fires a governed alert through the group's actions, not the member's", async () => {
    const groupId = await seedGroup();
    const ruleId = await seedMember(groupId);
    await evaluateAllNotificationRules();

    const alerts = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertGroupId).toBe(groupId);
    expect(alerts[0]!.dimensionCount).toBe(3);
    expect(await targetsOf(ruleId)).toEqual(["group@example.test"]);
  });

  it("is heard even when the member automation has no actions of its own", async () => {
    const groupId = await seedGroup();
    const ruleId = await seedMember(groupId, { actions: [] });
    await evaluateAllNotificationRules();
    expect(await targetsOf(ruleId)).toEqual(["group@example.test"]);
  });

  it("leaves a device outside the group's scope delivering through the member", async () => {
    const elsewhere = await seedSwitch("b");
    const groupId = await seedGroup({ scope: { assetIds: [elsewhere] } });
    const ruleId = await seedMember(groupId, { scope: { assetIds: [assetId] } });
    await evaluateAllNotificationRules();

    const alerts = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.alertGroupId).toBeNull();
    expect(await targetsOf(ruleId)).toEqual(["member@example.test"]);
  });

  it("hands delivery back to the member when the group is disabled", async () => {
    const groupId = await seedGroup({ enabled: false });
    const ruleId = await seedMember(groupId);
    await evaluateAllNotificationRules();
    expect(await targetsOf(ruleId)).toEqual(["member@example.test"]);
  });

  // The Groups tab posts no actions — it has no recipient editor. A group
  // created there must take its delivery from its first member, or it owns
  // delivery and delivers to nobody.
  it("a group created with no actions takes its first member's, once, and delivers to them", async () => {
    const ruleId = await seedMember(null as unknown as string, {
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 15, actions: [notify("tier@example.test")] }] },
    });
    const g = await createGroup({ name: `${RULE} ui`, ruleIds: [ruleId] }, "tester");
    const stored = await prisma.alertGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(JSON.stringify(stored.actions)).toContain("member@example.test");
    expect(JSON.stringify(stored.escalation)).toContain("tier@example.test");
    expect(await prisma.event.count({ where: { action: "alert_group.seeded", resourceId: g.id } })).toBe(1);

    await evaluateAllNotificationRules();
    expect(await targetsOf(ruleId)).toEqual(["member@example.test"]);

    // Copied ONCE: editing the member afterwards leaves the group alone, and a
    // later save of the group does not re-seed over what it already has.
    await prisma.notificationRule.update({ where: { id: ruleId }, data: { actions: [notify("changed@example.test")] } as never });
    await updateGroup(g.id, { name: `${RULE} ui`, ruleIds: [ruleId] }, "tester");
    const after = await prisma.alertGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(JSON.stringify(after.actions)).toContain("member@example.test");
    expect(JSON.stringify(after.actions)).not.toContain("changed@example.test");
  });

  it("never seeds over actions the group was given", async () => {
    const ruleId = await seedMember(null as unknown as string);
    const g = await createGroup({ name: `${RULE} api`, ruleIds: [ruleId], actions: [notify("group@example.test")] }, "tester");
    const stored = await prisma.alertGroup.findUniqueOrThrow({ where: { id: g.id } });
    expect(JSON.stringify(stored.actions)).toContain("group@example.test");
    expect(JSON.stringify(stored.actions)).not.toContain("member@example.test");
    expect(await prisma.event.count({ where: { action: "alert_group.seeded", resourceId: g.id } })).toBe(0);
  });

  it("runs the group's reset actions when the alert ends, not the member's", async () => {
    const groupId = await seedGroup({ resetActions: [notify("group-reset@example.test")] });
    const ruleId = await seedMember(groupId, { resetActions: [notify("member-reset@example.test")] });
    await evaluateAllNotificationRules();
    expect(await targetsOf(ruleId)).toEqual(["group@example.test"]);

    // Every port recovers: the last contribution out ends the alert.
    await prisma.assetInterface.updateMany({ where: { assetId }, data: { poeStatus: "delivering", operStatus: "up" } });
    await evaluateAllNotificationRules();

    expect(await prisma.notification.count({ where: { ruleId, cleared: false } })).toBe(0);
    const targets = await targetsOf(ruleId);
    expect(targets).toContain("group-reset@example.test");
    expect(targets).not.toContain("member-reset@example.test");
    expect(targets).not.toContain("member@example.test");
  });
});
