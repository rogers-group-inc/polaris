/**
 * tests/integration/priorityTagSeverity.test.ts
 *
 * Business rule 136(e): ONE "monitor status is down" automation whose severity
 * follows each device's Priority tag replaces one automation per priority —
 * Critical-tagged devices alert critical, Warning-tagged warning, and an
 * untagged device does not alert. The same for "interface oper status is down"
 * with the PORT's Priority tag. A tag changed while down moves the live
 * alert's severity; a tag removed while down clears it (tagGateGone — a
 * device left with no readings would otherwise be frozen firing forever).
 *
 * Also pins the same carve-out for rule 133(g): a switch whose ONLY ifTag-
 * matching port loses the tag clears, rather than freezing.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const d = dbDescribe;
const HOST = "prio-sev-test";
const NAME = "prio-sev-test";

async function wipe(): Promise<void> {
  const rules = await prisma.notificationRule.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  const ids = rules.map((r) => r.id);
  if (ids.length) {
    await prisma.notificationRuleState.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notification.deleteMany({ where: { ruleId: { in: ids } } });
    await prisma.notificationRule.deleteMany({ where: { id: { in: ids } } });
  }
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  await prisma.assetInterfaceSample.deleteMany({ where: { assetId: { in: assets.map((x) => x.id) } } });
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
}

async function seedDownDevice(name: string, tags: string[]): Promise<string> {
  const now = new Date();
  const a = await prisma.asset.create({
    data: {
      hostname: `${HOST}-${name}`, status: "active", monitored: true, assetType: "server",
      monitorStatus: "down", lastSeen: now, lastMonitorAt: now, tags,
    } as never,
    select: { id: true },
  });
  return a.id;
}

async function seedSwitch(ports: Record<string, string[]>): Promise<string> {
  const now = new Date();
  const names = Object.keys(ports);
  const a = await prisma.asset.create({
    data: {
      hostname: `${HOST}-sw`, status: "active", monitored: true, assetType: "switch",
      monitorStatus: "up", lastSeen: now, lastMonitorAt: now, monitoredInterfaces: names,
    } as never,
    select: { id: true },
  });
  await prisma.assetInterfaceSample.createMany({
    data: names.map((ifName) => ({ assetId: a.id, ifName, timestamp: now, operStatus: "down", adminStatus: "up" })) as never,
  });
  const tagRows = names.flatMap((ifName) => ports[ifName]!.map((tag) => ({ assetId: a.id, ifName, tag, source: "manual" })));
  if (tagRows.length) await prisma.assetInterfaceTag.createMany({ data: tagRows });
  return a.id;
}

async function seedRule(suffix: string, trigger: Record<string, unknown>, severityFromPriorityTag: boolean): Promise<string> {
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} ${suffix}`,
      enabled: true,
      severity: "notice",
      severityFromPriorityTag,
      trigger,
      scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
      reset: { mode: "auto" },
      actions: [],
      channels: ["in_app"],
    } as never,
    select: { id: true },
  });
  return r.id;
}

const DOWN = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };
const IF_DOWN = { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" };

/** Live alert severity per asset (device rule) or per port (interface rule). */
async function liveSeverities(ruleId: string): Promise<Record<string, string>> {
  const rows = await prisma.notificationRuleState.findMany({
    where: { ruleId, state: "firing" },
    select: { assetId: true, dimensionKey: true, firingSeverity: true, notificationId: true },
  });
  const out: Record<string, string> = {};
  for (const r of rows) {
    const n = r.notificationId ? await prisma.notification.findUnique({ where: { id: r.notificationId }, select: { severity: true } }) : null;
    expect(n?.severity).toBe(r.firingSeverity);
    out[r.dimensionKey || (r.assetId as string)] = r.firingSeverity as string;
  }
  return out;
}

d("severity from the Priority tag (business rule 136(e))", () => {
  beforeEach(wipe);
  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("one down automation alerts each device at its Priority tag's severity, and an untagged device not at all", async () => {
    const crit = await seedDownDevice("crit", ["prod", "Critical"]);
    const warn = await seedDownDevice("warn", ["Warning"]);
    const both = await seedDownDevice("both", ["Warning", "critical"]); // highest wins, any case
    await seedDownDevice("none", ["prod"]);
    const rule = await seedRule("down", DOWN, true);

    await evaluateAllNotificationRules();

    expect(await liveSeverities(rule)).toEqual({ [crit]: "critical", [warn]: "warning", [both]: "critical" });
  });

  it("a tag changed while down moves the live alert's severity", async () => {
    const id = await seedDownDevice("moves", ["Warning"]);
    const rule = await seedRule("down", DOWN, true);
    await evaluateAllNotificationRules();
    expect(await liveSeverities(rule)).toEqual({ [id]: "warning" });

    await prisma.asset.update({ where: { id }, data: { tags: ["Critical"] } });
    await evaluateAllNotificationRules();

    expect(await liveSeverities(rule)).toEqual({ [id]: "critical" });
  });

  it("a tag removed while down clears the alert rather than freezing it", async () => {
    const id = await seedDownDevice("untag", ["Serious"]);
    const rule = await seedRule("down", DOWN, true);
    await evaluateAllNotificationRules();
    expect(await liveSeverities(rule)).toEqual({ [id]: "serious" });

    await prisma.asset.update({ where: { id }, data: { tags: [] } });
    await evaluateAllNotificationRules();

    expect(await liveSeverities(rule)).toEqual({});
    expect(await prisma.notification.count({ where: { ruleId: rule, cleared: false } })).toBe(0);
  });

  it("an interface rule takes each PORT's Priority tag", async () => {
    await seedSwitch({ port1: ["Critical"], port2: ["Warning", "uplink"], port3: [] });
    const rule = await seedRule("ifdown", IF_DOWN, true);

    await evaluateAllNotificationRules();

    expect(await liveSeverities(rule)).toEqual({ port1: "critical", port2: "warning" });
  });

  it("without the switch the rule keeps its own severity for every device", async () => {
    const a = await seedDownDevice("plain-a", ["Critical"]);
    const b = await seedDownDevice("plain-b", []);
    const rule = await seedRule("plain", DOWN, false);

    await evaluateAllNotificationRules();

    expect(await liveSeverities(rule)).toEqual({ [a]: "notice", [b]: "notice" });
  });

  it("rule 133(g): a switch whose ONLY tagged port loses the tag clears instead of freezing", async () => {
    const sw = await seedSwitch({ port1: ["Critical"], port2: [] });
    const rule = await seedRule("iftag", { ...IF_DOWN, dimensionFilter: { ifTag: "Critical" } }, false);
    await evaluateAllNotificationRules();
    expect(Object.keys(await liveSeverities(rule))).toEqual(["port1"]);

    await prisma.assetInterfaceTag.deleteMany({ where: { assetId: sw } });
    await evaluateAllNotificationRules();

    expect(await liveSeverities(rule)).toEqual({});
  });
});
