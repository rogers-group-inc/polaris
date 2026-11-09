/**
 * tests/integration/resetMatchEscalation.test.ts
 *
 * Business rule 145 end to end against a real database:
 *  - the escalation sweep records a tier's first send on the alert
 *    (escalationFired / escalationTier / escalatedAt) and writes ONE
 *    `notification.escalated` Event on it;
 *  - an operator Clear runs the EXPANDED reset list: a matched reset Notify
 *    reaches the trigger action's CURRENT recipients (not its stored copy), and
 *    the escalation reset reaches the tier that sent — and only that one.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { runEscalationSweep } from "../../src/services/notificationEscalationService.js";
import { clearNotifications } from "../../src/services/notificationService.js";

const d = dbDescribe;
const NAME = "reset-match-escalation-test";

let channelId = "";

async function wipe(): Promise<void> {
  const rules = await prisma.notificationRule.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  const ids = rules.map((r) => r.id);
  if (ids.length) {
    const notifs = await prisma.notification.findMany({ where: { ruleId: { in: ids } }, select: { id: true } });
    await prisma.event.deleteMany({ where: { resourceId: { in: notifs.map((n) => n.id) } } });
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notificationRule.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.notificationChannel.deleteMany({ where: { name: { startsWith: NAME } } });
}

/** Every address a delivery row for this alert names, split by fire / all-clear. */
async function addressesOf(notificationId: string): Promise<{ resolved: string }> {
  const rows = await prisma.notificationDelivery.findMany({ where: { notificationId }, select: { target: true, meta: true } });
  const resolved = rows
    .filter((r) => ((r.meta ?? {}) as { allClear?: boolean }).allClear)
    .map((r) => `${r.target} ${JSON.stringify(r.meta)}`)
    .join(" ");
  return { resolved };
}

const tier = (afterMin: number, address: string) => ({ afterMin, actions: [{ type: "notify", channelId, addresses: [address] }] });

async function seedRule(over: Record<string, unknown>): Promise<string> {
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} rule`, enabled: true, severity: "warning",
      trigger: { type: "event", actionPattern: "rme.test.never" },
      scope: {}, reset: { mode: "manual" }, channels: ["in_app"],
      ...over,
    } as never,
    select: { id: true },
  });
  return r.id;
}

d("reset actions that match a trigger action (business rule 145)", () => {
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

  it("the sweep records a tier's first send on the alert and writes one Event on it", async () => {
    const ruleId = await seedRule({
      actions: [{ type: "notify", id: "n1", channelId, addresses: ["noc@example.test"] }],
      escalation: { stopOn: "acknowledge", tiers: [tier(15, "lead@example.test"), tier(60, "director@example.test")] },
    });
    const n = await prisma.notification.create({
      data: { ruleId, severity: "warning", message: "rme", triggeredAt: new Date(Date.now() - 20 * 60_000) } as never,
      select: { id: true },
    });

    await runEscalationSweep();

    const row = await prisma.notification.findUnique({ where: { id: n.id }, select: { escalationTier: true, escalatedAt: true, escalationFired: true } });
    expect(row!.escalationTier).toBe(1);
    expect(row!.escalatedAt).toBeInstanceOf(Date);
    expect(row!.escalationFired).toEqual([expect.objectContaining({ severity: "warning", chain: "", tier: 0 })]);
    const events = await prisma.event.findMany({ where: { action: "notification.escalated", resourceId: n.id } });
    expect(events).toHaveLength(1);

    // A second sweep with nothing new due writes nothing more.
    await runEscalationSweep();
    expect(await prisma.event.count({ where: { action: "notification.escalated", resourceId: n.id } })).toBe(1);
  });

  it("an operator Clear sends the matched reset to the trigger action's CURRENT recipients, and to the tier that sent", async () => {
    const ruleId = await seedRule({
      // The trigger action was edited after the reset's copy was stored.
      actions: [{ type: "notify", id: "n1", channelId, addresses: ["noc-now@example.test"] }],
      escalation: { stopOn: "acknowledge", tiers: [tier(15, "lead@example.test"), tier(60, "director@example.test")] },
      resetActions: [{ type: "notify", channelId, addresses: ["noc-then@example.test"], matchActionId: "n1", resetEscalation: {} }],
    });
    const n = await prisma.notification.create({
      data: {
        ruleId, severity: "warning", message: "rme", triggeredAt: new Date(Date.now() - 30 * 60_000),
        escalationFired: [{ severity: "warning", chain: "", tier: 0, at: new Date().toISOString() }],
        escalationTier: 1,
      } as never,
      select: { id: true },
    });

    await clearNotifications([n.id], "tester");

    const { resolved } = await addressesOf(n.id);
    expect(resolved).toContain("noc-now@example.test");
    expect(resolved).not.toContain("noc-then@example.test");
    expect(resolved).toContain("lead@example.test");
    // Tier 2 never sent for this alert, so nobody there hears that it ended.
    expect(resolved).not.toContain("director@example.test");
  });
});
