/**
 * tests/integration/assistantTelemetrySummary.test.ts
 *
 * Business rule 95(c) for CPU / memory: the assistant's telemetry_summary
 * figures are computed by the database. Pins the two raw aggregates in
 * telemetryAggregates against real tables:
 *  - detail tier: memPct where the source reports a percentage, else
 *    used / total bytes; the window is half-open and other assets' rows are
 *    never counted;
 *  - rollup tier: each bucket's average weighted by its sample count, a
 *    bucket that does not carry the metric adding nothing to either side.
 *
 * The tool's filtering, ranking and permission gate are in
 * tests/unit/assistantToolService.test.ts.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { telemetryAggregates } from "../../src/services/assistantToolService.js";

const d = dbDescribe;
const HOST = "assistant-telemetry-test";
const GiB = BigInt(1024 ** 3);

let pctAsset = "";
let bytesAsset = "";
let otherAsset = "";

async function wipe(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST } }, select: { id: true } });
  const ids = assets.map((a) => a.id);
  if (!ids.length) return;
  await prisma.assetTelemetrySample.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.assetTelemetrySampleHourly.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.asset.deleteMany({ where: { id: { in: ids } } });
}

async function asset(suffix: string): Promise<string> {
  const a = await prisma.asset.create({
    data: { hostname: `${HOST}-${suffix}`, status: "active", monitored: true, assetType: "firewall", monitorStatus: "up" } as never,
  });
  return a.id;
}

d("telemetryAggregates", () => {
  const from = new Date("2026-10-20T00:00:00Z");
  const to = new Date("2026-10-21T00:00:00Z");
  const at = (h: number) => new Date(from.getTime() + h * 3_600_000);

  beforeEach(async () => {
    await wipe();
    pctAsset = await asset("pct");
    bytesAsset = await asset("bytes");
    otherAsset = await asset("other");
  });
  afterAll(wipe);

  it("detail tier: percent or bytes ratio, half-open window, only the asked assets", async () => {
    await prisma.assetTelemetrySample.createMany({
      data: [
        { assetId: pctAsset, timestamp: at(1), cpuPct: 10, memPct: 40 },
        { assetId: pctAsset, timestamp: at(2), cpuPct: 30, memPct: 60 },
        // At `to` exactly: outside the half-open window.
        { assetId: pctAsset, timestamp: to, cpuPct: 99, memPct: 99 },
        // Before `from`: outside.
        { assetId: pctAsset, timestamp: new Date(from.getTime() - 1000), cpuPct: 99, memPct: 99 },
        // Bytes only: 2 of 8 GiB = 25 %, 6 of 8 = 75 %.
        { assetId: bytesAsset, timestamp: at(1), memUsedBytes: 2n * GiB, memTotalBytes: 8n * GiB },
        { assetId: bytesAsset, timestamp: at(3), memUsedBytes: 6n * GiB, memTotalBytes: 8n * GiB },
        { assetId: otherAsset, timestamp: at(1), cpuPct: 100, memPct: 100 },
      ],
    });
    const rows = await telemetryAggregates([pctAsset, bytesAsset], from, to, "detail");
    const by = new Map(rows.map((r) => [r.assetId, r]));
    expect(by.has(otherAsset)).toBe(false);
    expect(by.get(pctAsset)).toMatchObject({ samples: 2, avgCpu: 20, maxCpu: 30, avgMem: 50, maxMem: 60 });
    expect(by.get(bytesAsset)).toMatchObject({ samples: 2, avgCpu: null, maxCpu: null, avgMem: 50, maxMem: 75 });
  });

  it("hourly tier: averages weighted by sample count; a bucket without the metric adds nothing", async () => {
    await prisma.assetTelemetrySampleHourly.createMany({
      data: [
        // 10 samples at 20 % and 30 samples at 60 % → (200 + 1800) / 40 = 50 %, not 40 %.
        { assetId: pctAsset, bucketStart: at(1), sampleCount: 10, avgCpuPct: 20, maxCpuPct: 25, avgMemPct: 20, maxMemPct: 22 },
        { assetId: pctAsset, bucketStart: at(2), sampleCount: 30, avgCpuPct: 60, maxCpuPct: 80, avgMemPct: 60, maxMemPct: 70 },
        // A bucket with no memory reading must not dilute the memory average.
        { assetId: pctAsset, bucketStart: at(3), sampleCount: 40, avgCpuPct: 50, maxCpuPct: 55 },
        // Bytes only: avg 4 of 8 GiB = 50 %, peak 7 of 8 = 87.5 %.
        { assetId: bytesAsset, bucketStart: at(1), sampleCount: 12, avgMemUsedBytes: 4n * GiB, maxMemUsedBytes: 7n * GiB, lastMemTotalBytes: 8n * GiB },
      ],
    });
    const rows = await telemetryAggregates([pctAsset, bytesAsset], from, to, "hourly");
    const by = new Map(rows.map((r) => [r.assetId, r]));
    const p = by.get(pctAsset)!;
    expect(p.samples).toBe(80);
    expect(p.avgMem).toBeCloseTo(50, 6);
    expect(p.maxMem).toBe(70);
    // CPU: (200 + 1800 + 2000) / 80 = 50.
    expect(p.avgCpu).toBeCloseTo(50, 6);
    expect(p.maxCpu).toBe(80);
    expect(by.get(bytesAsset)).toMatchObject({ samples: 12, avgCpu: null, avgMem: 50, maxMem: 87.5 });
  });

  it("asks nothing of the database for an empty asset list", async () => {
    expect(await telemetryAggregates([], from, to, "detail")).toEqual([]);
  });
});
