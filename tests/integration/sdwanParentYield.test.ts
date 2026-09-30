/**
 * tests/integration/sdwanParentYield.test.ts
 *
 * Business rule 90 against a real database: an SD-WAN overlay member riding
 * an underlay that is over the same line does not alert — the underlay's alert
 * names the cause.
 *  - the same tick: wan2 and the overlay on it both lose packets → one alert,
 *    on wan2;
 *  - an overlay alert raised before its parent was known is retired as
 *    superseded (Event reason "sdwan-parent"), never as "resolved";
 *  - a live parent alert from ANOTHER automation silences the overlay too;
 *  - an overlay on a HEALTHY underlay keeps alerting;
 *  - the health-check / member filters take several values, any-of;
 *  - a parent that is DOWN outright (dead on a health check the automation's
 *    filter excludes, or an oper-down port in no health check at all) silences
 *    the overlays riding it.
 *
 * The pure walk is pinned in tests/unit/sdwanDimensions.test.ts.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const d = dbDescribe;
const HOST = "sdwan-parent-yield-test";
const RULE = "sdwan-parent-yield-test";

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
    const aIds = assets.map((a) => a.id);
    await prisma.assetPerfSlaSample.deleteMany({ where: { assetId: { in: aIds } } });
    await prisma.assetIpsecTunnelSample.deleteMany({ where: { assetId: { in: aIds } } });
    await prisma.assetInterface.deleteMany({ where: { assetId: { in: aIds } } });
    await prisma.asset.deleteMany({ where: { id: { in: aIds } } });
  }
  await prisma.event.deleteMany({ where: { resourceName: { startsWith: RULE } } });
}

/** One perf-SLA sample per (health check, member), taken just now. */
async function seedLoss(rows: Array<[healthCheck: string, link: string, loss: number]>): Promise<void> {
  const ts = new Date(Date.now() - 1_000);
  await prisma.assetPerfSlaSample.createMany({
    data: rows.map(([healthCheck, link, packetLoss]) => ({
      assetId, timestamp: ts, cadence: "fast", healthCheck, link, zone: null,
      state: "up", latencyMs: 20, jitterMs: 1, packetLoss,
    })),
  });
}

/** The phase-1 each overlay rides — what names an overlay's parent. */
async function seedTunnels(parents: Record<string, string>): Promise<void> {
  const ts = new Date(Date.now() - 60_000);
  await prisma.assetIpsecTunnelSample.createMany({
    data: Object.entries(parents).map(([tunnelName, parentInterface]) => ({
      assetId, timestamp: ts, tunnelName, parentInterface, status: "up", cadence: "slow",
    })),
  });
}

async function seedRule(name: string, dimensionFilter?: Record<string, string>): Promise<string> {
  const rule = await prisma.notificationRule.create({
    data: {
      name: `${RULE} ${name}`,
      enabled: true,
      severity: "warning",
      trigger: {
        type: "asset_metric", metric: "sdwanPacketLoss", aggregation: "latest", windowSec: 0,
        operator: ">=", threshold: 5, forDurationSec: 0, ...(dimensionFilter ? { dimensionFilter } : {}),
      },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      actions: [],
    } as never,
  });
  return rule.id;
}

/** Member state per (health check, member), taken just now. */
async function seedState(rows: Array<[healthCheck: string, link: string, state: "up" | "down"]>): Promise<void> {
  const ts = new Date(Date.now() - 1_000);
  await prisma.assetPerfSlaSample.createMany({
    data: rows.map(([healthCheck, link, state]) => ({
      assetId, timestamp: ts, cadence: "fast", healthCheck, link, zone: null,
      state, latencyMs: null, jitterMs: null, packetLoss: state === "down" ? 100 : 0,
    })),
  });
}

async function seedStateRule(name: string, dimensionFilter?: Record<string, string>): Promise<string> {
  const rule = await prisma.notificationRule.create({
    data: {
      name: `${RULE} ${name}`,
      enabled: true,
      severity: "warning",
      trigger: {
        type: "asset_state", field: "sdwanMemberState", operator: "==", value: "down",
        forDurationSec: 0, ...(dimensionFilter ? { dimensionFilter } : {}),
      },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      actions: [],
    } as never,
  });
  return rule.id;
}

async function liveMembers(ruleId: string): Promise<string[]> {
  const rows = await prisma.notification.findMany({ where: { ruleId, cleared: false }, select: { dimension: true } });
  return rows.map((r) => (r.dimension ?? "").split("|")[1] ?? "").sort();
}

d("SD-WAN parent members (business rule 90)", () => {
  beforeEach(async () => {
    await wipe();
    const asset = await prisma.asset.create({
      data: {
        hostname: `${HOST}-gate`, status: "active", monitored: true, assetType: "firewall",
        monitorStatus: "up", lastMonitorAt: new Date(),
      } as never,
    });
    assetId = asset.id;
  });

  afterAll(async () => {
    if (dbReachable) await wipe();
  });

  it("alerts once, on the underlay, when it and the overlay riding it both lose packets", async () => {
    await seedTunnels({ "Overlay-3": "wan2", "Overlay-1": "wan1" });
    await seedLoss([["Secondary WAN", "wan2", 100], ["Metrocenter", "Overlay-3", 100], ["Metrocenter", "Overlay-1", 0], ["Primary WAN", "wan1", 0]]);
    const rule = await seedRule("loss");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["wan2"]);
  });

  it("keeps alerting on an overlay whose underlay is healthy", async () => {
    await seedTunnels({ "Overlay-1": "wan1" });
    await seedLoss([["Metrocenter", "Overlay-1", 40], ["Primary WAN", "wan1", 0]]);
    const rule = await seedRule("loss");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["Overlay-1"]);
  });

  it("retires an overlay alert raised before its parent was known as superseded, not resolved", async () => {
    await seedLoss([["Secondary WAN", "wan2", 100], ["Metrocenter", "Overlay-3", 100]]);
    const rule = await seedRule("loss");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["Overlay-3", "wan2"]);

    await seedTunnels({ "Overlay-3": "wan2" });
    await seedLoss([["Secondary WAN", "wan2", 100], ["Metrocenter", "Overlay-3", 100]]);
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["wan2"]);

    const cleared = await prisma.notification.findFirst({ where: { ruleId: rule, dimension: "Metrocenter|Overlay-3" } });
    expect(cleared?.cleared).toBe(true);
    expect(cleared?.clearedBy).toBe("system:superseded");
    const ev = await prisma.event.findFirst({ where: { action: "notification.superseded", resourceName: { startsWith: RULE } } });
    expect(ev?.details).toMatchObject({ reason: "sdwan-parent", parent: "wan2", dimension: "Metrocenter|Overlay-3" });
  });

  it("yields to a live parent alert raised by a DIFFERENT automation", async () => {
    await seedTunnels({ "Overlay-3": "wan2" });
    await seedLoss([["Secondary WAN", "wan2", 100], ["Metrocenter", "Overlay-3", 100]]);
    const overlays = await seedRule("overlays", { link: "Overlay" });
    const underlays = await seedRule("underlays", { link: "wan" });
    await evaluateAllNotificationRules();
    // Whichever order the two ran in, by the second tick the underlay alert is
    // live and the overlay automation has handed off to it.
    await seedLoss([["Secondary WAN", "wan2", 100], ["Metrocenter", "Overlay-3", 100]]);
    await evaluateAllNotificationRules();
    expect(await liveMembers(underlays)).toEqual(["wan2"]);
    expect(await liveMembers(overlays)).toEqual([]);
  });

  it("filters on several health checks and members at once (any-of)", async () => {
    await seedLoss([
      ["Microsoft", "wan1", 30], ["Primary WAN", "wan1", 30],
      ["Microsoft", "Overlay-1", 30], ["Flexential", "Overlay-2", 30],
    ]);
    const rule = await seedRule("multi", { healthCheck: "Primary WAN|Flexential", link: "wan1|Overlay-2" });
    await evaluateAllNotificationRules();
    const rows = await prisma.notification.findMany({ where: { ruleId: rule, cleared: false }, select: { dimension: true } });
    expect(rows.map((r) => r.dimension).sort()).toEqual(["Flexential|Overlay-2", "Primary WAN|wan1"]);
  });

  it("a state automation narrowed to the overlay health checks yields to an underlay dead on ANOTHER health check", async () => {
    await seedTunnels({ "Overlay-3": "wan2", "Overlay-1": "wan1" });
    await seedState([
      ["Internet", "wan2", "down"], ["Internet", "wan1", "up"],
      ["Metrocenter", "Overlay-3", "down"], ["Flexential", "Overlay-3", "down"],
      ["Metrocenter", "Overlay-1", "up"],
    ]);
    const rule = await seedStateRule("filtered", { healthCheck: "Metrocenter|Flexential" });
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual([]);
  });

  it("yields to an operationally-down port that is in no health check", async () => {
    await seedTunnels({ "Overlay-3": "wan2" });
    await prisma.assetInterface.create({ data: { assetId, ifName: "wan2", operStatus: "down", adminStatus: "up" } as never });
    await seedLoss([["Metrocenter", "Overlay-3", 100]]);
    const rule = await seedRule("oper-down");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual([]);
  });

  it("still alerts on an overlay whose underlay is up on every health check and port", async () => {
    await seedTunnels({ "Overlay-3": "wan2" });
    await prisma.assetInterface.create({ data: { assetId, ifName: "wan2", operStatus: "up", adminStatus: "up" } as never });
    await seedState([["Internet", "wan2", "up"], ["Metrocenter", "Overlay-3", "down"]]);
    const rule = await seedStateRule("healthy-parent", { healthCheck: "Metrocenter|Flexential" });
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["Overlay-3"]);
  });
});
