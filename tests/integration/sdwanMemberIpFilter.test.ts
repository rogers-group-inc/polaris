/**
 * tests/integration/sdwanMemberIpFilter.test.ts
 *
 * Business rule 98 against a real database: `dimensionFilter.sdwanMemberIp`
 * keeps a member reading only when the member interface's CURRENT address
 * passes the comparison.
 *  - "!= 0.0.0.0" leaves an unaddressed WAN (every shape of it) out of both a
 *    packet-loss and a member-state automation, and keeps an addressed one;
 *  - a member with no interface row, or an interface that reported no
 *    address, is KEPT — the filter only removes what it has evidence about;
 *  - "== <address>" narrows to that one member;
 *  - a live alert on a member that stops passing is retired, not frozen.
 *
 * The pure parse / compare / schema half is tests/unit/sdwanMemberIpFilter.test.ts.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { evaluateAllNotificationRules } from "../../src/services/notificationEngine.js";

const d = dbDescribe;
const HOST = "sdwan-member-ip-test";
const RULE = "sdwan-member-ip-test";

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
    await prisma.assetInterface.deleteMany({ where: { assetId: { in: aIds } } });
    await prisma.asset.deleteMany({ where: { id: { in: aIds } } });
  }
  await prisma.event.deleteMany({ where: { resourceName: { startsWith: RULE } } });
}

async function seedInterfaces(ips: Record<string, string | null>): Promise<void> {
  await prisma.assetInterface.createMany({
    data: Object.entries(ips).map(([ifName, ipAddress]) => ({ assetId, ifName, ipAddress, operStatus: "up", adminStatus: "up" })) as never,
  });
}

async function seedSamples(rows: Array<[link: string, state: "up" | "down", loss: number]>): Promise<void> {
  const ts = new Date(Date.now() - 1_000);
  await prisma.assetPerfSlaSample.createMany({
    data: rows.map(([link, state, packetLoss]) => ({
      assetId, timestamp: ts, cadence: "fast", healthCheck: "Internet", link, zone: null,
      state, latencyMs: 20, jitterMs: 1, packetLoss,
    })),
  });
}

async function seedRule(kind: "loss" | "state", memberIp?: string): Promise<string> {
  const dimensionFilter = memberIp ? { sdwanMemberIp: memberIp } : undefined;
  const trigger = kind === "loss"
    ? { type: "asset_metric", metric: "sdwanPacketLoss", aggregation: "latest", windowSec: 0, operator: ">=", threshold: 5, forDurationSec: 0, ...(dimensionFilter ? { dimensionFilter } : {}) }
    : { type: "asset_state", field: "sdwanMemberState", operator: "==", value: "down", forDurationSec: 0, ...(dimensionFilter ? { dimensionFilter } : {}) };
  const rule = await prisma.notificationRule.create({
    data: {
      name: `${RULE} ${kind} ${memberIp ?? "none"}`,
      enabled: true, severity: "warning", trigger, scope: { allAssets: true }, reset: { mode: "auto" }, actions: [],
    } as never,
  });
  return rule.id;
}

async function liveMembers(ruleId: string): Promise<string[]> {
  const rows = await prisma.notification.findMany({ where: { ruleId, cleared: false }, select: { dimension: true } });
  return rows.map((r) => (r.dimension ?? "").split("|")[1] ?? "").sort();
}

d("SD-WAN member IP address filter (business rule 98)", () => {
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

  it("leaves an unaddressed member out of a packet-loss automation, in every shape it is reported", async () => {
    await seedInterfaces({ wan1: "203.0.113.9 255.255.255.0", wan2: "0.0.0.0 0.0.0.0", wan3: "0.0.0.0" });
    await seedSamples([["wan1", "up", 50], ["wan2", "up", 50], ["wan3", "up", 50]]);
    const rule = await seedRule("loss", "!= 0.0.0.0");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["wan1"]);
  });

  it("does the same for member state", async () => {
    await seedInterfaces({ wan1: "203.0.113.9", wan2: "0.0.0.0" });
    await seedSamples([["wan1", "down", 100], ["wan2", "down", 100]]);
    const rule = await seedRule("state", "!= 0.0.0.0");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["wan1"]);
  });

  it("keeps a member whose address it cannot read", async () => {
    // Overlay-1 has no interface row at all; wan1 reported no address field.
    await seedInterfaces({ wan1: null });
    await seedSamples([["wan1", "up", 50], ["Overlay-1", "up", 50]]);
    const rule = await seedRule("loss", "!= 0.0.0.0");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["Overlay-1", "wan1"]);
  });

  it("narrows to one member with ==", async () => {
    await seedInterfaces({ wan1: "203.0.113.9/29", wan2: "198.51.100.4" });
    await seedSamples([["wan1", "up", 50], ["wan2", "up", 50]]);
    const rule = await seedRule("loss", "== 198.51.100.4");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["wan2"]);
  });

  it("filters nothing when the automation sets no filter", async () => {
    await seedInterfaces({ wan1: "203.0.113.9", wan2: "0.0.0.0" });
    await seedSamples([["wan1", "up", 50], ["wan2", "up", 50]]);
    const rule = await seedRule("loss");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["wan1", "wan2"]);
  });

  it("retires a live alert on a member that loses its address, rather than freezing it", async () => {
    // wan2 keeps reporting: the vanished sweep retires a dimension only on a
    // gate that produced readings this tick (one that produced NONE is frozen,
    // the contract for every per-component automation).
    await seedInterfaces({ wan1: "203.0.113.9", wan2: "198.51.100.4" });
    await seedSamples([["wan1", "up", 50], ["wan2", "up", 0]]);
    const rule = await seedRule("loss", "!= 0.0.0.0");
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual(["wan1"]);

    await prisma.assetInterface.updateMany({ where: { assetId, ifName: "wan1" }, data: { ipAddress: "0.0.0.0" } });
    await seedSamples([["wan1", "up", 50], ["wan2", "up", 0]]);
    await evaluateAllNotificationRules();
    expect(await liveMembers(rule)).toEqual([]);
  });
});
