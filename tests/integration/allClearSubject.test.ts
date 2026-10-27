/**
 * tests/integration/allClearSubject.test.ts
 *
 * An all-clear email's subject names the alert the way its fire did — the
 * same {asset}, {dimension.suffix} and {rule}, only the severity tag changes
 * to [RESOLVED]. Pinned for the two shapes that drifted:
 *  - a GROUPED alert, which used to build the subject from the one
 *    contribution whose recovery ended it ("[RESOLVED] GRYCRT-S2212 · RGILink
 *    Auth" answering "[WARNING] RGILink Auth · 1 device");
 *  - a TIMED reset, which has no live reading and used to name the asset by
 *    its id and the component by its raw key;
 *  - an operator CLEAR, which named the row's host and dropped the component.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";
import { createGroup } from "../../src/services/alertGroupService.js";
import { clearNotifications } from "../../src/services/notificationService.js";

const d = dbDescribe;
const HOST = "all-clear-subject-test";
const NAME = "all-clear-subject-test";

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

const notify = (address: string) => ({ type: "notify", channelId, addresses: [address] });

async function seedHost(name: string, monitorStatus: string): Promise<string> {
  const now = new Date();
  const a = await prisma.asset.create({
    data: { hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "server", monitorStatus, lastSeen: now, lastMonitorAt: now } as never,
    select: { id: true },
  });
  return a.id;
}

/** The subjects mailed for this rule's alerts, fire first, all-clear second. */
async function subjectsOf(ruleId: string): Promise<{ fire: string[]; resolved: string[] }> {
  const rows = await prisma.notificationDelivery.findMany({
    where: { notification: { ruleId } },
    select: { meta: true },
    orderBy: { createdAt: "asc" },
  });
  const metas = rows.map((r) => (r.meta ?? {}) as { subject?: string; allClear?: boolean });
  return {
    fire: metas.filter((m) => !m.allClear).map((m) => m.subject ?? ""),
    resolved: metas.filter((m) => m.allClear).map((m) => m.subject ?? ""),
  };
}

d("all-clear subject matches the fire", () => {
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

  it("a grouped alert's Resolved names the alert, not the last device to recover", async () => {
    const h1 = await seedHost("h1", "down");
    const h2 = await seedHost("h2", "down");
    const rule = await prisma.notificationRule.create({
      data: {
        name: `${NAME} down`, enabled: true, severity: "serious",
        trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
        scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
        reset: { mode: "auto" }, actions: [], channels: ["in_app"],
      } as never,
      select: { id: true },
    });
    await createGroup({
      name: `${NAME} group`, foldBy: "automation" as never, ruleIds: [rule.id],
      actions: [notify("noc@example.test")], resetActions: [notify("noc@example.test")],
    }, "tester");

    await evaluateAllNotificationRules();
    // End the first-send hold (business rule 75) so the fire is announced.
    await prisma.notification.updateMany({
      where: { ruleId: rule.id, cleared: false, firstSentAt: null },
      data: { firstSendDueAt: new Date(Date.now() - 1000) },
    });
    await evaluateAllNotificationRules();

    await prisma.asset.updateMany({ where: { id: { in: [h1, h2] } }, data: { monitorStatus: "up" } });
    await evaluateAllNotificationRules();

    const { fire, resolved } = await subjectsOf(rule.id);
    expect(fire).toHaveLength(1);
    expect(fire[0]).toContain("2 devices");
    expect(resolved).toEqual([fire[0]!.replace("[SERIOUS]", "[RESOLVED]")]);
  });

  it("an operator Clear of a grouped alert names the alert as the fire did", async () => {
    await seedHost("c1", "down");
    await seedHost("c2", "down");
    const rule = await prisma.notificationRule.create({
      data: {
        name: `${NAME} cleared`, enabled: true, severity: "serious",
        trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
        scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
        reset: { mode: "manual" }, actions: [], channels: ["in_app"],
      } as never,
      select: { id: true },
    });
    await createGroup({
      name: `${NAME} group`, foldBy: "automation" as never, ruleIds: [rule.id],
      actions: [notify("noc@example.test")], resetActions: [notify("noc@example.test")],
    }, "tester");

    await evaluateAllNotificationRules();
    await prisma.notification.updateMany({
      where: { ruleId: rule.id, cleared: false, firstSentAt: null },
      data: { firstSendDueAt: new Date(Date.now() - 1000) },
    });
    await evaluateAllNotificationRules();

    const open = await prisma.notification.findMany({ where: { ruleId: rule.id, cleared: false }, select: { id: true } });
    expect(open).toHaveLength(1);
    await clearNotifications([open[0]!.id], "tester");

    const { fire, resolved } = await subjectsOf(rule.id);
    expect(fire).toHaveLength(1);
    expect(resolved).toEqual([fire[0]!.replace("[SERIOUS]", "[RESOLVED]")]);
  });

  it("a timed reset names the device by hostname, as the fire did", async () => {
    const id = await seedHost("t1", "down");
    const rule = await prisma.notificationRule.create({
      data: {
        name: `${NAME} timed`, enabled: true, severity: "warning",
        trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
        scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
        reset: { mode: "timed", afterSec: 60 }, actions: [notify("noc@example.test")], channels: ["in_app"],
        resetActions: [notify("noc@example.test")],
      } as never,
      select: { id: true },
    });

    await evaluateAllNotificationRules();
    await prisma.notificationRuleState.updateMany({ where: { ruleId: rule.id }, data: { firedAt: new Date(Date.now() - 120_000) } });
    await evaluateAllNotificationRules();

    const { fire, resolved } = await subjectsOf(rule.id);
    expect(fire).toHaveLength(1);
    expect(fire[0]).toContain(`${HOST}-t1`);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).not.toContain(id);
    expect(resolved[0]).toBe(fire[0]!.replace("[WARNING]", "[RESOLVED]"));
  });
});
