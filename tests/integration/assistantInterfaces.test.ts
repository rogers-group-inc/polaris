/**
 * tests/integration/assistantInterfaces.test.ts
 *
 * The assistant's interface_summary tool (business rule 95) against real
 * AssetInterface + interface sample rows:
 *  - rates are counter deltas in SQL: average = bytes / seconds, peak = the
 *    fastest interval, a counter reset (negative delta) skipped — never read
 *    as traffic or errors — the same rule as the interface chart;
 *  - utilization is against the link speed; Mbps is bits;
 *  - an interface not selected for monitoring keeps its current state and
 *    says history: false instead of reading as idle;
 *  - "down" is link down while enabled, "disabled" is shut by an operator;
 *    PoE fault covers fault and other-fault;
 *  - the hourly tier rates each bucket from its first / last counters.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { runAssistantTool, interfaceAggregates } from "../../src/services/assistantToolService.js";

const d = dbDescribe;
const HOST = "assistant-if-test";
const req = { session: { userId: "u1", roleSnapshot: { permissions: { assets: "read" } } } } as never;
let swId = "";

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const ids = assets.map((a) => a.id);
  if (!ids.length) return;
  await prisma.assetInterfaceSample.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.assetInterfaceSampleHourly.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.assetInterface.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.asset.deleteMany({ where: { id: { in: ids } } });
}

const run = async (args: Record<string, unknown>) =>
  (await runAssistantTool("interface_summary", JSON.stringify({ search: HOST, ...args }), { req, maxRows: 50 })).data as any;

d("interface_summary", () => {
  beforeAll(async () => {
    await wipe();
    const sw = await prisma.asset.create({
      data: { hostname: `${HOST}-sw`, status: "active", assetType: "switch", monitoredInterfaces: ["wan1"] } as never,
    });
    swId = sw.id;
    const M = BigInt(1_000_000);
    await prisma.assetInterface.createMany({
      data: [
        { assetId: swId, ifName: "wan1", alias: "ISP uplink", adminStatus: "up", operStatus: "up", speedBps: 100n * M },
        { assetId: swId, ifName: "port1", adminStatus: "up", operStatus: "down", speedBps: 1000n * M, vlanId: 20 },
        { assetId: swId, ifName: "port2", adminStatus: "down", operStatus: "down", speedBps: 1000n * M },
        { assetId: swId, ifName: "port3", adminStatus: "up", operStatus: "up", speedBps: 1000n * M, poeStatus: "other-fault", poeClass: "class3" },
      ],
    });
    const t0 = Date.now() - 10 * 60_000;
    const at = (s: number) => new Date(t0 + s * 1000);
    await prisma.assetInterfaceSample.createMany({
      data: [
        { assetId: swId, ifName: "wan1", timestamp: at(0), inOctets: 0n, outOctets: 0n, inErrors: 0n, outErrors: 0n },
        // +60 s: 60 MB in (8 Mbps), 30 MB out (4 Mbps), 5 errors.
        { assetId: swId, ifName: "wan1", timestamp: at(60), inOctets: 60n * M, outOctets: 30n * M, inErrors: 5n, outErrors: 0n },
        // +60 s: 120 MB in (16 Mbps — the peak), 30 MB out.
        { assetId: swId, ifName: "wan1", timestamp: at(120), inOctets: 180n * M, outOctets: 60n * M, inErrors: 5n, outErrors: 0n },
        // A reset on the in counters: skipped for in, out still counts.
        { assetId: swId, ifName: "wan1", timestamp: at(180), inOctets: 1000n, outOctets: 90n * M, inErrors: 1n, outErrors: 0n },
      ],
    });
  });
  afterAll(wipe);

  it("rates from counter deltas: reset skipped, Mbps in bits, utilization against link speed", async () => {
    const r = await run({ interface: "wan" });
    expect(r.rows).toHaveLength(1);
    // in: 180 MB over 120 s = 1.5 MB/s = 12 Mbps; out: 90 MB over 180 s = 4 Mbps.
    expect(r.rows[0]).toMatchObject({
      interface: "wan1", description: "ISP uplink", state: "up", speedMbps: 100, history: true,
      avgInMbps: 12, avgOutMbps: 4, peakInMbps: 16, peakOutMbps: 4, avgUtilPct: 12, peakUtilPct: 16, inErrors: 5, outErrors: 0,
    });
  });

  it("an interface without monitoring keeps its state and says it has no history; it sorts after measured ones", async () => {
    const r = await run({});
    expect(r.rows[0].interface).toBe("wan1");
    const port1 = r.rows.find((x: any) => x.interface === "port1");
    expect(port1).toMatchObject({ history: false, avgInMbps: null, state: "down", vlan: 20 });
    expect(r).toMatchObject({ total: 4, interfacesWithHistory: 1 });
  });

  it("down is link-down-while-enabled, disabled is admin down, PoE fault includes other-fault", async () => {
    expect((await run({ state: ["down"] })).rows.map((x: any) => x.interface)).toEqual(["port1"]);
    expect((await run({ state: "disabled" })).rows.map((x: any) => x.interface)).toEqual(["port2"]);
    expect((await run({ poe: "fault" })).rows.map((x: any) => [x.interface, x.poe])).toEqual([["port3", "other-fault / class3"]]);
  });

  it("withErrors keeps the monitored interfaces that logged errors, worst first", async () => {
    const r = await run({ withErrors: true });
    expect(r.rows.map((x: any) => [x.interface, x.inErrors])).toEqual([["wan1", 5]]);
    expect(r.sortedBy).toBe("errors");
  });

  it("hourly tier: each bucket rated from its first / last counters; a reset bucket is skipped", async () => {
    const b = new Date("2026-10-20T00:00:00Z");
    const end = new Date(b.getTime() + 3_600_000);
    await prisma.assetInterfaceSampleHourly.createMany({
      data: [
        // 3600 MB in an hour (≈ 1 MB/s over the 3600 s the bucket covers).
        { assetId: swId, ifName: "wan1", bucketStart: b, sampleCount: 60, firstInOctets: 0n, lastInOctets: 3_600_000_000n, firstOutOctets: 0n, lastOutOctets: 0n, firstInErrors: 0n, lastInErrors: 2n, firstOutErrors: 0n, lastOutErrors: 0n, lastBucketSampleAt: end },
        // A reset inside the next bucket: last < first → no traffic, no errors counted.
        { assetId: swId, ifName: "wan1", bucketStart: end, sampleCount: 60, firstInOctets: 5_000_000_000n, lastInOctets: 10n, firstOutOctets: 0n, lastOutOctets: 0n, firstInErrors: 9n, lastInErrors: 1n, firstOutErrors: 0n, lastOutErrors: 0n, lastBucketSampleAt: new Date(end.getTime() + 3_600_000) },
      ],
    });
    const [g] = await interfaceAggregates([swId], ["wan1"], b, new Date(b.getTime() + 86_400_000), "hourly");
    expect(g.avgIn).toBeCloseTo(1_000_000, 3);
    expect(g.peakIn).toBeCloseTo(1_000_000, 3);
    expect(g.inErrors).toBe(2);
  });
});
