/**
 * tests/integration/sdwanMembersStrip.test.ts
 *
 * The SD-WAN Members table's Health Check Status strip against a real
 * database: readSdwanMembers returns one entry per scrape over exactly the last
 * SDWAN_STATUS_STRIP_MINUTES (30), a scrape is `up` only when the member is up
 * in EVERY health check it belongs to, and older samples are left out. The unit
 * test mocks the query; this one proves the `make_interval` window and the
 * bool_and aggregation are what Postgres actually runs.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { readSdwanMembers } from "../../src/services/sampleHistoryService.js";

const ASSET = "00000000-0000-4000-8000-00000000d5a1";
const MIN = 60_000;

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.assetPerfSlaSample.deleteMany({ where: { assetId: ASSET } });
  const now = Date.now();
  const row = (agoMin: number, healthCheck: string, state: string) => ({
    assetId: ASSET, timestamp: new Date(now - agoMin * MIN), cadence: "fast",
    healthCheck, link: "wan1", zone: null, state, latencyMs: 10, jitterMs: 1, packetLoss: 0,
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
  await prisma.assetPerfSlaSample.deleteMany({ where: { assetId: ASSET } });
});

dbDescribe("readSdwanMembers — Health Check Status strip", () => {
  it("covers only the last 30 minutes, oldest first, down if any health check is down", async () => {
    const { members } = await readSdwanMembers(ASSET);
    expect(members).toHaveLength(1);
    expect(members[0]!.recent.map((r) => r.up)).toEqual([false, true]);
  });
});
