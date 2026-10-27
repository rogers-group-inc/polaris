/**
 * tests/integration/alertGroupAutomationFold.test.ts
 *
 * Business rule 75, the two automation-shaped folds:
 *  - `automation` — one alert per member AUTOMATION, every governed device
 *    that trips it a member (so it also takes a whole-device "monitor status is
 *    down" automation, as a subnet group does);
 *  - `deviceAutomation` — both folds at once: ONE alert for the whole group,
 *    every device and every member automation in it (until 2026-10-27 it
 *    meant one alert per device per automation; the migration that redefined
 *    it retires alerts raised under that meaning).
 *
 * Two per-component automations on the same switches make the difference
 * visible: PoE fault and interface down, over three pinned, faulted ports
 * (pinned, so their readings come from AssetInterfaceSample rows).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { createGroup, updateGroup } from "../../src/services/alertGroupService.js";
import type { AlertMember } from "../../src/services/notificationTypes.js";

const d = dbDescribe;
const HOST = "automation-fold-test";
const NAME = "automation-fold-test";
const PORTS = ["port2", "port5", "port9"];

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
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  await prisma.assetInterfaceSample.deleteMany({ where: { assetId: { in: assets.map((x) => x.id) } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

/** A monitored switch whose three pinned ports are PoE-faulted and down. */
async function seedSwitch(name: string): Promise<string> {
  const now = new Date();
  const asset = await prisma.asset.create({
    data: {
      hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "switch",
      monitorStatus: "up", lastSeen: now, lastMonitorAt: now, monitoredInterfaces: PORTS,
    } as never,
    select: { id: true },
  });
  await prisma.assetInterface.createMany({
    data: PORTS.map((ifName) => ({
      assetId: asset.id, ifName, poeStatus: "fault", operStatus: "down", adminStatus: "up",
      ifType: "ethernetCsmacd", firstSeen: now, lastSeen: now,
    })),
  });
  // A PINNED port's readings come from the interfaces stream, not the inventory row.
  await prisma.assetInterfaceSample.createMany({
    data: PORTS.map((ifName) => ({ assetId: asset.id, ifName, timestamp: now, poeStatus: "fault", operStatus: "down", adminStatus: "up" })) as never,
  });
  return asset.id;
}

async function seedRule(suffix: string, trigger: Record<string, unknown>): Promise<string> {
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} ${suffix}`,
      enabled: true,
      severity: "serious",
      trigger,
      // Scoped to this test's switches, so it outranks any all-devices
      // automation of the same trigger a seed left behind.
      scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
      reset: { mode: "auto" },
      actions: [],
      channels: ["in_app"],
    } as never,
    select: { id: true },
  });
  return r.id;
}

const poeRule = () => seedRule("poe", { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" });
const linkRule = () => seedRule("link", { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" });
const downRule = () => seedRule("down", { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" });

async function seedGroup(foldBy: string, ruleIds: string[]): Promise<string> {
  const g = await createGroup({
    name: `${NAME} group`,
    foldBy: foldBy as never,
    ruleIds,
    actions: [{ type: "notify", channelId, addresses: ["noc@example.test"] }],
  }, "tester");
  return g.id;
}

const membersOf = (n: { members: unknown }) => (n.members ?? []) as AlertMember[];
const active = (n: { members: unknown }) => membersOf(n).filter((m) => !m.leftAt);
const live = (groupId: string) =>
  prisma.notification.findMany({ where: { alertGroupId: groupId, cleared: false }, orderBy: { triggeredAt: "asc" } });

d("AlertGroups folding by AUTOMATION and by DEVICE + AUTOMATION (business rule 75)", () => {
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

  it("device + automation: the whole group is ONE alert — every device, every automation", async () => {
    await seedSwitch("a");
    await seedSwitch("b");
    const poe = await poeRule();
    const link = await linkRule();
    const groupId = await seedGroup("deviceAutomation", [poe, link]);

    await evaluateAllNotificationRules();

    const alerts = await live(groupId);
    expect(alerts).toHaveLength(1);
    const a = alerts[0]!;
    expect(a.groupKey).toBe(`grp:${groupId}|all`);
    // Named for the group, which is what it is about.
    expect(a.assetHostname).toBe(`${NAME} group`);
    // 2 switches × 3 ports × 2 automations.
    expect(a.dimensionCount).toBe(12);
    expect(new Set(active(a).map((m) => m.ruleId))).toEqual(new Set([poe, link]));
    expect(new Set(active(a).map((m) => m.assetId)).size).toBe(2);
    expect(active(a).every((m) => m.group === `${NAME} group` && m.label.startsWith(`${HOST}-`))).toBe(true);
    // Subject: "[SERIOUS] 2 automations · 2 devices — <group>".
    const ctx = a.templateCtx as Record<string, string>;
    expect(ctx["asset"]).toBe("2 automations");
    expect(ctx["dimension.suffix"]).toBe(" · 2 devices");
    expect(ctx["rule"]).toBe(`${NAME} group`);
  });

  it("device (for contrast): both automations on the switch are one alert", async () => {
    await seedSwitch("a");
    const groupId = await seedGroup("device", [await poeRule(), await linkRule()]);
    await evaluateAllNotificationRules();
    const alerts = await live(groupId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dimensionCount).toBe(6);
  });

  it("automation: one alert per automation across every device, each device's ports its members", async () => {
    await seedSwitch("a");
    await seedSwitch("b");
    const poe = await poeRule();
    const link = await linkRule();
    const groupId = await seedGroup("automation", [poe, link]);

    await evaluateAllNotificationRules();

    const alerts = await live(groupId);
    expect(alerts).toHaveLength(2);
    const a = alerts.find((x) => x.ruleId === poe)!;
    expect(a.groupKey).toBe(`grp:${groupId}|auto:${poe}`);
    // Named for the automation, not for whichever switch led it.
    expect(a.assetHostname).toBe(`${NAME} poe`);
    expect(a.dimensionCount).toBe(6);
    expect(new Set(active(a).map((m) => m.assetId)).size).toBe(2);
    expect(active(a).every((m) => m.label.startsWith(`${HOST}-`))).toBe(true);
    expect(a.message).toContain("2 devices");
  });

  it("automation: takes a whole-device down automation, and the alert ends with the last device", async () => {
    const now = new Date();
    const mk = async (n: string) => (await prisma.asset.create({
      data: { hostname: `${HOST}-${n}`, status: "active", monitored: true, assetType: "server", monitorStatus: "down", lastSeen: now, lastMonitorAt: now } as never,
      select: { id: true },
    })).id;
    const h1 = await mk("h1");
    const h2 = await mk("h2");
    const down = await downRule();
    const groupId = await seedGroup("automation", [down]);

    await evaluateAllNotificationRules();
    let alerts = await live(groupId);
    expect(alerts).toHaveLength(1);
    expect(active(alerts[0]!).map((m) => m.label).sort()).toEqual([`${HOST}-h1`, `${HOST}-h2`]);

    await prisma.asset.update({ where: { id: h1 }, data: { monitorStatus: "up" } });
    await evaluateAllNotificationRules();
    alerts = await live(groupId);
    expect(alerts).toHaveLength(1);
    expect(active(alerts[0]!).map((m) => m.label)).toEqual([`${HOST}-h2`]);
    expect(membersOf(alerts[0]!).find((m) => m.assetId === h1)?.leftAt).toBeTruthy();

    await prisma.asset.update({ where: { id: h2 }, data: { monitorStatus: "up" } });
    await evaluateAllNotificationRules();
    expect(await live(groupId)).toHaveLength(0);
  });

  it("device + automation takes a whole-device automation; a device group refuses it", async () => {
    const down = await downRule();
    await expect(seedGroup("device", [down])).rejects.toThrow(/per device \+ automation/);
    const groupId = await seedGroup("automation", [down]);
    await expect(updateGroup(groupId, { name: `${NAME} group`, foldBy: "deviceAutomation" }, "tester")).resolves.toBeTruthy();
    await expect(updateGroup(groupId, { name: `${NAME} group`, foldBy: "device" }, "tester"))
      .rejects.toThrow(/per automation, per device \+ automation or per subnet/);
  });

  it("the redefinition migration retires alerts raised under the old per-device-per-automation meaning", async () => {
    const sw = await seedSwitch("a");
    const poe = await poeRule();
    const groupId = await seedGroup("deviceAutomation", [poe]);
    // An alert in the OLD shape, its state row pointing at it.
    const old = await prisma.notification.create({
      data: { ruleId: poe, assetId: sw, assetHostname: `${HOST}-a`, severity: "serious", message: "old", groupKey: `grp:${groupId}|${sw}/auto:${poe}`, alertGroupId: groupId } as never,
      select: { id: true },
    });
    await prisma.notificationRuleState.create({
      data: { ruleId: poe, assetId: sw, dimensionKey: "port2", state: "firing", firedAt: new Date(), notificationId: old.id } as never,
    });
    const sql = readFileSync(resolve("prisma/migrations/20261027190000_device_automation_whole_group/migration.sql"), "utf8");
    for (const stmt of sql.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean)) {
      await prisma.$executeRawUnsafe(stmt);
    }
    const after = await prisma.notification.findUnique({ where: { id: old.id } });
    expect(after!.cleared).toBe(true);
    expect(after!.clearedBy).toBe("system:group-refolded");
    const st = await prisma.notificationRuleState.findFirst({ where: { ruleId: poe, assetId: sw, dimensionKey: "port2" } });
    expect(st!.state).toBe("clear");
    expect(st!.notificationId).toBeNull();

    // ...and the next tick raises the group's one alert.
    await evaluateAllNotificationRules();
    const again = await live(groupId);
    expect(again).toHaveLength(1);
    expect(again[0]!.groupKey).toBe(`grp:${groupId}|all`);
  });

  it("retires the group's open alerts when the fold changes between the automation modes", async () => {
    await seedSwitch("a");
    const poe = await poeRule();
    const groupId = await seedGroup("automation", [poe]);
    await evaluateAllNotificationRules();
    expect(await live(groupId)).toHaveLength(1);

    await updateGroup(groupId, { name: `${NAME} group`, foldBy: "deviceAutomation", ruleIds: [poe] }, "tester");
    expect(await live(groupId)).toHaveLength(0);
    // ...and the next check raises it again the new way.
    await evaluateAllNotificationRules();
    const again = await live(groupId);
    expect(again).toHaveLength(1);
    expect(again[0]!.groupKey).toBe(`grp:${groupId}|all`);
  });
});
