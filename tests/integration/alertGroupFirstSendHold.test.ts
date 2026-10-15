/**
 * tests/integration/alertGroupFirstSendHold.test.ts
 *
 * Business rule 75, the first-send hold: a grouped alert does not send its
 * first message the tick it opens. It waits ONE polling interval of the
 * reading that opened it, so whatever fails with it is in the first email.
 *
 * Pinned here, end to end through the engine:
 *  - opening sends nothing, and stamps when the first send is due;
 *  - a device joining during the hold sends nothing either, and is in the one
 *    first message the release sends;
 *  - an alert that ends while held sends nothing at all — no reset actions;
 *  - escalation leaves a held alert alone;
 *  - the hold is the opening reading's own cadence (a path check's interval).
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { runEscalationSweep } from "../../src/services/notificationEscalationService.js";
import { resolveAssetCadenceSec } from "../../src/services/notificationCadenceService.js";
import { bumpQuietTimeCache } from "../../src/services/quietTimeHoldService.js";

const d = dbDescribe;
const HOST = "first-send-hold-test";
const NAME = "first-send-hold-test";

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
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: NAME } } });
  await prisma.quietTimeSchedule.deleteMany({ where: { name: { startsWith: NAME } } });
  bumpQuietTimeCache();
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

/** A monitored switch with three faulted PoE ports (read off AssetInterface,
 *  rule 57's carve-out — no pin, no samples). */
async function seedSwitch(name: string, faulted = true): Promise<string> {
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
      assetId: asset.id, ifName, poeStatus: faulted ? "fault" : "delivering", operStatus: "up", adminStatus: "up",
      ifType: "ethernetCsmacd", firstSeen: now, lastSeen: now,
    })),
  });
  return asset.id;
}

const notify = (address: string) => ({ type: "notify", channelId, addresses: [address] });

async function seedGroupAndMember(over: Record<string, unknown> = {}): Promise<{ groupId: string; ruleId: string }> {
  const g = await prisma.alertGroup.create({
    data: {
      name: `${NAME} group`, enabled: true, requireAckNote: false,
      actions: [notify("group@example.test")], resetActions: [notify("group-reset@example.test")], ...over,
    } as never,
    select: { id: true },
  });
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} poe`, enabled: true, severity: "serious",
      trigger: { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" },
      scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
      reset: { mode: "auto" }, actions: [], channels: ["in_app"], alertGroupId: g.id,
    } as never,
    select: { id: true },
  });
  return { groupId: g.id, ruleId: r.id };
}

async function targetsOf(ruleId: string): Promise<string[]> {
  const rows = await prisma.notificationDelivery.findMany({ where: { notification: { ruleId } }, select: { target: true } });
  return rows.map((r) => r.target).sort();
}

/** End the hold now, as the clock would one polling interval later. */
async function expireHolds(ruleId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { ruleId, cleared: false, firstSentAt: null },
    data: { firstSendDueAt: new Date(Date.now() - 1000) },
  });
}

d("a grouped alert holds its first send one polling interval (business rule 75)", () => {
  beforeEach(async () => {
    await wipe();
    const ch = await prisma.notificationChannel.create({
      data: { name: `${NAME} smtp`, type: "smtp", enabled: true, config: {} },
      select: { id: true },
    });
    channelId = ch.id;
  });

  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("opens the alert in the app but sends nothing until the hold ends", async () => {
    await seedSwitch("a");
    const { ruleId } = await seedGroupAndMember();
    const before = Date.now();
    await evaluateAllNotificationRules();

    const [alert] = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alert).toBeTruthy();
    expect(alert!.firstSentAt).toBeNull();
    expect(alert!.firstSendDueAt!.getTime()).toBeGreaterThan(before);
    expect(await targetsOf(ruleId)).toEqual([]);

    // The next pass inside the hold still sends nothing.
    await evaluateAllNotificationRules();
    expect(await targetsOf(ruleId)).toEqual([]);

    await expireHolds(ruleId);
    await evaluateAllNotificationRules();
    expect(await targetsOf(ruleId)).toEqual(["group@example.test"]);
    const sent = await prisma.notification.findUniqueOrThrow({ where: { id: alert!.id } });
    expect(sent.firstSentAt).toBeTruthy();
    expect(await prisma.event.count({ where: { action: "notification.first_send_released", resourceId: alert!.id } })).toBe(1);

    // Released once: a later pass sends nothing more.
    await evaluateAllNotificationRules();
    expect(await targetsOf(ruleId)).toEqual(["group@example.test"]);
  });

  it("a device that joins during the hold is in the one first message", async () => {
    await seedSwitch("a");
    const late = await seedSwitch("b", false);
    // Fold by automation, so both switches share one alert.
    const { ruleId } = await seedGroupAndMember({ foldBy: "automation" });
    await evaluateAllNotificationRules();

    await prisma.assetInterface.updateMany({ where: { assetId: late }, data: { poeStatus: "fault" } });
    await evaluateAllNotificationRules();
    // Joined silently: no growth update while nobody has been told.
    expect(await targetsOf(ruleId)).toEqual([]);

    await expireHolds(ruleId);
    await evaluateAllNotificationRules();
    const alerts = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dimensionCount).toBe(6);
    expect(alerts[0]!.message).toContain("2 devices");
    // One message, to the group's one recipient.
    expect(await targetsOf(ruleId)).toEqual(["group@example.test"]);
  });

  it("an alert that ends while held sends nothing, not even its reset actions", async () => {
    const sw = await seedSwitch("a");
    const { ruleId } = await seedGroupAndMember();
    await evaluateAllNotificationRules();

    await prisma.assetInterface.updateMany({ where: { assetId: sw }, data: { poeStatus: "delivering" } });
    await evaluateAllNotificationRules();

    expect(await prisma.notification.count({ where: { ruleId, cleared: false } })).toBe(0);
    expect(await targetsOf(ruleId)).toEqual([]);
  });

  it("a released first send inside a quiet window is held by quiet time, like any fire (rules 92 / 120)", async () => {
    await prisma.quietTimeSchedule.create({
      data: {
        name: `${NAME} all day`, enabled: true, scope: { allAssets: true },
        quiet: { windows: [{ version: 1, kind: "recurring", freq: "daily", startTime: "00:00", endTime: "23:59" }] },
      } as never,
    });
    // Written straight to the table, so clear the 15 s catalog as a real save does.
    bumpQuietTimeCache();
    await seedSwitch("a");
    const { ruleId } = await seedGroupAndMember();
    await evaluateAllNotificationRules();
    await expireHolds(ruleId);
    await evaluateAllNotificationRules();

    const [alert] = await prisma.notification.findMany({ where: { ruleId, cleared: false } });
    expect(alert!.firstSentAt).toBeTruthy();
    expect(alert!.quietHeldAt).toBeTruthy();
    const rows = await prisma.notificationDelivery.findMany({ where: { notificationId: alert!.id }, select: { status: true } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "held")).toBe(true);
  });

  it("escalation leaves a held alert alone", async () => {
    await seedSwitch("a");
    const { ruleId } = await seedGroupAndMember({
      escalation: { stopOn: "clear", tiers: [{ afterMin: 0, actions: [notify("tier@example.test")] }] },
    });
    await evaluateAllNotificationRules();
    await runEscalationSweep(new Date(Date.now() + 60_000));
    expect(await targetsOf(ruleId)).toEqual([]);
  });

  it("holds a path-check reading for the check's own interval", async () => {
    const check = await prisma.pathCheck.create({
      data: { name: `${NAME} check`, kind: "https", target: "https://example.test", intervalSec: 300, traceroute: {}, scope: {}, definitionSha256: "0".repeat(64) } as never,
      select: { id: true },
    });
    expect(await resolveAssetCadenceSec(null, "pathOk", check.id)).toBe(300);
    expect(await resolveAssetCadenceSec(null, "pathOk", null)).toBeNull();
    expect(await resolveAssetCadenceSec(null, "poeStatus")).toBeNull();
  });
});
