/**
 * tests/integration/sdwanMembersStrip.test.ts
 *
 * The SD-WAN Members table's Health Check Status strip against a real
 * database: readSdwanMembers returns one entry per scrape over exactly the last
 * SDWAN_STATUS_STRIP_MINUTES (30), a scrape is `up` only when the member is up
 * in EVERY health check it belongs to, and older samples are left out. The unit
 * test mocks the query; this one proves the `make_interval` window and the
 * per-scrape fold are what Postgres actually runs — and that a scrape is also
 * judged on its values: over the health check's own SLA target (`outOfSla`),
 * or crossing an automation's severity tier (`severity`, via `tiersFor`).
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { readSdwanMembers } from "../../src/services/sampleHistoryService.js";

const ASSET = "00000000-0000-4000-8000-00000000d5a1";
const ASSET_SLA = "00000000-0000-4000-8000-00000000d5a2";
const MIN = 60_000;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.assetPerfSlaSample.deleteMany({ where: { assetId: ASSET } });
  const now = Date.now();
  const row = (agoMin: number, healthCheck: string, state: string) => ({
    assetId: ASSET, timestamp: new Date(now - agoMin * MIN), cadence: "fast",
    healthCheck, link: "wan1", zone: null, state, latencyMs: 10, jitterMs: 1, packetLoss: 0,
  });
  const slaRow = (agoMin: number, packetLoss: number) => ({
    assetId: ASSET_SLA, timestamp: new Date(now - agoMin * MIN), cadence: "fast",
    healthCheck: "HC-A", link: "wan1", zone: null, state: "up", latencyMs: 10, jitterMs: 1, packetLoss,
    packetLossThreshold: 20,
  });
  await prisma.assetPerfSlaSample.deleteMany({ where: { assetId: ASSET_SLA } });
  await prisma.assetPerfSlaSample.createMany({
    data: [slaRow(3, 0), slaRow(6, 8), slaRow(9, 30)] as never,
  });
  await prisma.assetPerfSlaSample.createMany({
    data: [
      // 5 min ago: up in both health checks → up
      row(5, "HC-A", "up"), row(5, "HC-B", "up"),
      // 15 min ago: dead in one of two → down (any dead health check turns it red)
      row(15, "HC-A", "up"), row(15, "HC-B", "down"),
      // 45 min ago: outside the 30-minute window → excluded
      row(45, "HC-A", "down"), row(45, "HC-B", "down"),
    ] as never,
  });
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.assetPerfSlaSample.deleteMany({ where: { assetId: { in: [ASSET, ASSET_SLA] } } });
});

dbDescribe("readSdwanMembers — Health Check Status strip", () => {
  it("covers only the last 30 minutes, oldest first, down if any health check is down", async () => {
    const { members } = await readSdwanMembers(ASSET);
    expect(members).toHaveLength(1);
    expect(members[0]!.recent.map((r) => r.up)).toEqual([false, true]);
  });

  it("marks a scrape over the SLA target out of SLA, and shades an in-SLA one by the automation's tier", async () => {
    const asked: string[] = [];
    const { members } = await readSdwanMembers(ASSET_SLA, (metric, hc, link) => {
      asked.push(`${metric}|${hc}|${link}`);
      return metric === "sdwanPacketLoss" ? [{ severity: "warning", operator: ">=", threshold: 5 }] : [];
    });
    // oldest first: 30% (over the 20% SLA target), 8% (in SLA, over the tier), 0%
    expect(members[0]!.recent.map((r) => [r.up, r.outOfSla, r.severity])).toEqual([
      [true, true, null],
      [true, false, "warning"],
      [true, false, null],
    ]);
    expect(asked).toContain("sdwanPacketLoss|HC-A|wan1");
  });
});
