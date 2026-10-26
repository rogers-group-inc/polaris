/**
 * tests/integration/assistantPathChecks.test.ts
 *
 * The assistant's path_check_summary tool (business rule 95) against real
 * Path Monitor rows:
 *  - one row per check × source — an agent host or the Polaris server, whose
 *    samples are keyed by POLARIS_SERVER_SUBJECT rather than an asset;
 *  - availability and latency are SQL aggregates over the window; on a rollup
 *    tier latency is weighted by SUCCESSFUL runs (a failed run has none);
 *  - worst availability first; failingOnly and source filters narrow;
 *  - a role without `pathChecks` read gets "Not permitted".
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { runAssistantTool, pathCheckAggregates } from "../../src/services/assistantToolService.js";
import { POLARIS_SERVER_SUBJECT } from "../../src/services/pathCheckIngestService.js";

const d = dbDescribe;
const NAME = "assistant-path-test";
const req = { session: { userId: "u1", roleSnapshot: { permissions: { pathChecks: "read" } } } } as never;
let checkId = "";
let hostId = "";

async function wipe(): Promise<void> {
  const checks = await prisma.pathCheck.findMany({ where: { name: { startsWith: NAME } }, select: { id: true } });
  const ids = checks.map((c) => c.id);
  if (ids.length) {
    await prisma.assetPathCheckSample.deleteMany({ where: { checkId: { in: ids } } });
    await prisma.assetPathCheckSampleHourly.deleteMany({ where: { checkId: { in: ids } } });
    await prisma.pathCheck.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: NAME } } });
}

d("path_check_summary", () => {
  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60_000);

  beforeAll(async () => {
    await wipe();
    const host = await prisma.asset.create({ data: { hostname: `${NAME}-branch`, status: "active", assetType: "server" } as never });
    hostId = host.id;
    const check = await prisma.pathCheck.create({
      data: { name: `${NAME} erp`, kind: "https", target: "erp.example.test", traceroute: {}, scope: {}, definitionSha256: "x" } as never,
    });
    checkId = check.id;
    await prisma.pathCheckSource.createMany({
      data: [
        { checkId, assetId: hostId, lastOk: false, lastError: "timeout", lastSampleAt: ago(1), lastFailAt: ago(1) },
        { checkId, assetId: null, lastOk: true, lastSampleAt: ago(1) },
      ],
    });
    await prisma.assetPathCheckSample.createMany({
      data: [
        // Branch: 1 of 4 failed → 75 %, latency over the three that answered.
        { assetId: hostId, checkId, timestamp: ago(40), ok: true, latencyMs: 100 },
        { assetId: hostId, checkId, timestamp: ago(30), ok: true, latencyMs: 200 },
        { assetId: hostId, checkId, timestamp: ago(20), ok: true, latencyMs: 300 },
        { assetId: hostId, checkId, timestamp: ago(10), ok: false, error: "timeout" },
        // Server: all good.
        { assetId: POLARIS_SERVER_SUBJECT, checkId, timestamp: ago(30), ok: true, latencyMs: 20 },
        { assetId: POLARIS_SERVER_SUBJECT, checkId, timestamp: ago(20), ok: true, latencyMs: 40 },
      ],
    });
  });
  afterAll(wipe);

  it("one row per source, worst availability first, the server named as such", async () => {
    const r = (await runAssistantTool("path_check_summary", JSON.stringify({ check: "erp.example" }), { req, maxRows: 50 })).data as any;
    expect(r.rows.map((x: any) => [x.source, x.availabilityPct, x.avgLatencyMs, x.maxLatencyMs, x.samples])).toEqual([
      [`${NAME}-branch`, 75, 200, 300, 4],
      ["Polaris server", 100, 30, 40, 2],
    ]);
    expect(r.rows[0]).toMatchObject({ lastOk: false, lastError: "timeout", kind: "https" });
    expect(r).toMatchObject({ matchedChecks: 1, failingNow: 1 });
  });

  it("failingOnly and source narrow the rows", async () => {
    const failing = (await runAssistantTool("path_check_summary", JSON.stringify({ check: NAME, failingOnly: true }), { req, maxRows: 50 })).data as any;
    expect(failing.rows.map((x: any) => x.source)).toEqual([`${NAME}-branch`]);
    const server = (await runAssistantTool("path_check_summary", JSON.stringify({ check: NAME, source: "server" }), { req, maxRows: 50 })).data as any;
    expect(server.rows.map((x: any) => x.source)).toEqual(["Polaris server"]);
  });

  it("hourly tier: latency weighted by successful runs, availability by all runs", async () => {
    const b = new Date("2026-10-20T00:00:00Z");
    await prisma.assetPathCheckSampleHourly.createMany({
      data: [
        // 60 runs, 30 OK at 100 ms; 60 runs, 10 OK at 400 ms → latency (3000+4000)/40 = 175, availability 40/120.
        { assetId: hostId, checkId, bucketStart: b, sampleCount: 60, okCount: 30, failCount: 30, avgLatencyMs: 100, maxLatencyMs: 150, lastBucketSampleAt: b },
        { assetId: hostId, checkId, bucketStart: new Date(b.getTime() + 3_600_000), sampleCount: 60, okCount: 10, failCount: 50, avgLatencyMs: 400, maxLatencyMs: 900, lastBucketSampleAt: b },
      ],
    });
    const [g] = await pathCheckAggregates([hostId], [checkId], b, new Date(b.getTime() + 86_400_000), "hourly");
    expect(g).toMatchObject({ samples: 120, okCount: 40, maxLatency: 900 });
    expect(g.avgLatency).toBeCloseTo(175, 6);
  });

  it("refuses a role without Path Monitor read", async () => {
    const r = await runAssistantTool("path_check_summary", "{}", { req: { session: { roleSnapshot: { permissions: { assets: "read" } } } } as never, maxRows: 50 });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.data)).toMatch(/Not permitted/);
  });
});
