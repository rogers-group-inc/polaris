/**
 * tests/integration/interfaceTagAutomation.test.ts
 *
 * Business rule 133(g): an interface condition narrowed by `dimensionFilter.ifTag`
 * fires only about the ports carrying the tag — manual or auto rows alike — and
 * a port that loses the tag stops producing a reading, so its alert clears.
 *
 * One switch, four pinned ports all down: two tagged Critical (one manual, one
 * auto), one tagged Warning, one untagged.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const d = dbDescribe;
const HOST = "iftag-automation-test";
const NAME = "iftag-automation-test";
const PORTS = ["port1", "port2", "port3", "port4"];

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

async function seedSwitch(): Promise<string> {
  const now = new Date();
  const asset = await prisma.asset.create({
    data: {
      hostname: `${HOST}-sw`, status: "active", monitored: true, assetType: "switch",
      monitorStatus: "up", lastSeen: now, lastMonitorAt: now, monitoredInterfaces: PORTS,
    } as never,
    select: { id: true },
  });
  await prisma.assetInterfaceSample.createMany({
    data: PORTS.map((ifName) => ({ assetId: asset.id, ifName, timestamp: now, operStatus: "down", adminStatus: "up" })) as never,
  });
  await prisma.assetInterfaceTag.createMany({
    data: [
      { assetId: asset.id, ifName: "port1", tag: "Critical", source: "manual" },
      { assetId: asset.id, ifName: "port2", tag: "critical", source: "auto" },
      { assetId: asset.id, ifName: "port3", tag: "Warning", source: "manual" },
    ],
  });
  return asset.id;
}

async function seedRule(suffix: string, ifTag: string): Promise<string> {
  const r = await prisma.notificationRule.create({
    data: {
      name: `${NAME} ${suffix}`,
      enabled: true,
      severity: suffix === "critical" ? "critical" : "warning",
      trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", dimensionFilter: { ifTag } },
      scope: { condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: HOST }] } },
      reset: { mode: "auto" },
      actions: [],
      channels: ["in_app"],
    } as never,
    select: { id: true },
  });
  return r.id;
}

const firingPorts = async (ruleId: string) =>
  (await prisma.notificationRuleState.findMany({ where: { ruleId, state: "firing" }, select: { dimensionKey: true } }))
    .map((s) => s.dimensionKey)
    .sort();

d("interface tag filter on interface automations (business rule 133(g))", () => {
  beforeEach(wipe);
  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("each automation fires only about the ports carrying its tag", async () => {
    await seedSwitch();
    const crit = await seedRule("critical", "Critical");
    const warn = await seedRule("warning", "Warning");

    await evaluateAllNotificationRules();

    expect(await firingPorts(crit)).toEqual(["port1", "port2"]);
    expect(await firingPorts(warn)).toEqual(["port3"]);
  });

  it("a port that loses its tag stops producing a reading, and its alert clears", async () => {
    const assetId = await seedSwitch();
    const crit = await seedRule("critical", "Critical");
    await evaluateAllNotificationRules();
    expect(await firingPorts(crit)).toEqual(["port1", "port2"]);

    await prisma.assetInterfaceTag.deleteMany({ where: { assetId, ifName: "port1" } });
    await evaluateAllNotificationRules();

    expect(await firingPorts(crit)).toEqual(["port2"]);
  });
});
