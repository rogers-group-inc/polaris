/**
 * tests/integration/nocSdwanFeeds.test.ts
 *
 * The five SD-WAN dashboard feeds' SQL against a real database. The unit test
 * (tests/unit/nocSdwanFeeds.test.ts) mocks every query and pins the folding;
 * this one proves what Postgres actually runs: the naive-UTC windows, the
 * array subscript on availableMembers, the lag() drop count, the in-SLA test,
 * the IPsec parent join, and the asset-id filter's parameter numbering (every
 * feed is called scoped to this file's gates, which is also what keeps other
 * suites' rows out of the assertions).
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import * as noc from "../../src/services/nocDashboardService.js";

const HOST = "noc-sdwan-feeds";
const MIN = 60_000;
let gA = ""; // wan1 up, wan2 down → one path left; rules failed over / down
let gB = ""; // healthy, two paths; wan1 flaps and runs near / over SLA
let gC = ""; // in maintenance → dropped from every feed
let ids: string[] = [];

async function gate(suffix: string, status = "active") {
  const a = await prisma.asset.create({
    data: {
      hostname: `${HOST}-${suffix}`, status, monitored: true, assetType: "firewall",
      monitorStatus: "up", lastMonitorAt: new Date(),
    } as never,
  });
  return a.id;
}

function sample(assetId: string, agoMin: number, link: string, state: string, over: Record<string, unknown> = {}) {
  return {
    assetId, timestamp: new Date(Date.now() - agoMin * MIN), cadence: "fast",
    healthCheck: "HC", link, zone: "underlay", state,
    latencyMs: 10, jitterMs: 1, packetLoss: 0,
    latencyThresholdMs: 100, jitterThresholdMs: 30, packetLossThreshold: 2,
    ...over,
  };
}

async function cleanup() {
  const old = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const oldIds = old.map((a) => a.id);
  if (!oldIds.length) return;
  await prisma.assetPerfSlaSample.deleteMany({ where: { assetId: { in: oldIds } } });
  await prisma.assetIpsecTunnelSample.deleteMany({ where: { assetId: { in: oldIds } } });
  await prisma.assetSdwanRule.deleteMany({ where: { assetId: { in: oldIds } } });
  await prisma.asset.deleteMany({ where: { id: { in: oldIds } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  gA = await gate("a");
  gB = await gate("b");
  gC = await gate("c", "maintenance");
  ids = [gA, gB, gC];

  const rows = [
    // gA: wan1 up, wan2 down, Overlay-2 (rides wan2) down → 1 of 2 paths.
    sample(gA, 2, "wan1", "up"), sample(gA, 2, "wan2", "down"), sample(gA, 2, "Overlay-2", "down"),
    // gB: both up now. wan1 dropped twice in the last hour and once ~3h ago,
    // and its latency runs at 90% of target (95 then 85 avg → 90).
    sample(gB, 2, "wan2", "up"),
    sample(gB, 2, "wan1", "up", { latencyMs: 95 }),
    sample(gB, 5, "wan1", "up", { latencyMs: 85 }),
    sample(gB, 30, "wan1", "down"), sample(gB, 31, "wan1", "up"),
    sample(gB, 40, "wan1", "down"), sample(gB, 41, "wan1", "up"),
    sample(gB, 180, "wan1", "down"), sample(gB, 181, "wan1", "up"),
    // An over-target reading 2h ago: in the 24h compliance window, not the 1h.
    sample(gB, 120, "wan1", "up", { latencyMs: 150 }),
    // Older than 24h: outside every window.
    sample(gB, 26 * 60, "wan1", "down"),
    // gC is in maintenance: one path left, but it must not be listed.
    sample(gC, 2, "wan1", "up"), sample(gC, 2, "wan2", "down"),
  ];
  await prisma.assetPerfSlaSample.createMany({ data: rows as never });
  await prisma.assetIpsecTunnelSample.create({
    data: { assetId: gA, timestamp: new Date(Date.now() - 2 * MIN), tunnelName: "Overlay-2", status: "down", parentInterface: "wan2" } as never,
  });
  await prisma.assetSdwanRule.createMany({
    data: [
      { assetId: gA, ruleName: "VoIP", mode: "sla", enabled: true, status: "up", selectedMember: "wan1", availableMembers: ["wan2", "wan1"] },
      { assetId: gA, ruleName: "BestQ", mode: "priority", enabled: true, status: "up", selectedMember: "wan1", availableMembers: ["wan2", "wan1"] },
      { assetId: gA, ruleName: "Off", mode: "sla", enabled: false, status: "down", selectedMember: null, availableMembers: ["wan2", "wan1"] },
      { assetId: gA, ruleName: "To-HQ", mode: "manual", enabled: true, status: "down", selectedMember: null, availableMembers: ["Overlay-2"] },
      { assetId: gB, ruleName: "VoIP", mode: "sla", enabled: true, status: "up", selectedMember: "wan1", availableMembers: ["wan1", "wan2"] },
      { assetId: gC, ruleName: "VoIP", mode: "sla", enabled: true, status: "down", selectedMember: null, availableMembers: ["wan1", "wan2"] },
    ] as never,
  });
  noc.clearSdwanHistoryCache();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

dbDescribe("SD-WAN dashboard feeds", () => {
  it("rules off their preferred link: down first, ordered modes only, enabled only", async () => {
    const rows = await noc.getSdwanRuleFailovers(100, ids);
    expect(rows.map((r) => [r.assetId === gA, r.ruleName, r.state])).toEqual([
      [true, "To-HQ", "down"],
      [true, "VoIP", "failedOver"],
    ]);
    expect(rows[1]).toMatchObject({ selectedMember: "wan1", preferredMembers: ["wan2"] });
  });

  it("sites down to one path, folding an overlay onto the port it rides", async () => {
    const rows = await noc.getSdwanSingleLinkSites(100, ids);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetId: gA, alivePaths: 1, totalPaths: 2, alive: ["wan1"], downMembers: ["Overlay-2", "wan2"] });
  });

  it("SLA headroom averages the last 15 minutes of live readings", async () => {
    const rows = await noc.getSdwanSlaHeadroom(100, ids);
    expect(rows[0]).toMatchObject({ id: gB, value: 90, detail: "HC · wan1 · latency 90 ms of 100 ms" });
    // gA's dead members are not ranked; its live wan1 is.
    expect(rows.filter((r) => r.id === gA).map((r) => r.detail)).toEqual(["HC · wan1 · latency 10 ms of 100 ms"]);
  });

  it("flapping counts up → down drops per window", async () => {
    const hour = await noc.getSdwanFlappingLinks("1h", 100, ids);
    const day = await noc.getSdwanFlappingLinks("24h", 100, ids);
    expect(hour.find((r) => r.id === gB)).toMatchObject({ value: 2, detail: "wan1 · HC" });
    expect(day.find((r) => r.id === gB)).toMatchObject({ value: 3 });
  });

  it("compliance counts dead and over-target scrapes as out of SLA", async () => {
    const day = await noc.getSdwanSlaCompliance("24h", 100, ids);
    // gB wan1 over 24h: 9 scrapes, 3 down + 1 over target → 4/9 out.
    expect(day.find((r) => r.id === gB && r.detail === "HC · wan1")?.value).toBeCloseTo(44.44, 2);
    const hour = await noc.getSdwanSlaCompliance("1h", 100, ids);
    // Last hour: 6 scrapes, 2 down → 2/6 out (the over-target one is 2h old).
    expect(hour.find((r) => r.id === gB && r.detail === "HC · wan1")?.value).toBeCloseTo(33.33, 2);
  });
});
