/**
 * tests/unit/alertMemoryChart.test.ts
 *
 * The memory chart in an alert email reads in BYTES (GB on any real host)
 * against installed memory whenever the device reports bytes — the agent, SNMP
 * HOST-RESOURCES, WMI — and falls back to 0–100% only for a device that reports
 * nothing but a percentage (FortiOS). The pure series builder is tested
 * directly; the email wiring through buildAlertCharts against a mocked Prisma.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { telemetryRows } = vi.hoisted(() => ({ telemetryRows: { rows: [] as unknown[] } }));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetTelemetrySample: { findMany: vi.fn(async () => telemetryRows.rows) },
    assetMonitorSample: { findMany: vi.fn(async () => []) },
    assetHardwareSensorSample: { findMany: vi.fn(async () => []) },
    assetPerfSlaSample: { findMany: vi.fn(async () => []) },
    assetStorageSample: { findMany: vi.fn(async () => []) },
    $queryRawUnsafe: vi.fn(async () => []),
    asset: { findUnique: vi.fn(async () => null) },
  },
}));

vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    render() { return { asPng: () => new Uint8Array([1, 2, 3]) }; }
  },
}));

vi.mock("../../src/services/downDetectionService.js", () => ({
  describeDownDetectionFor: vi.fn(async () => null),
  recoveryPollsFor: vi.fn(() => 0),
}));

import { buildAlertCharts, memorySeriesFrom } from "../../src/services/alertChartService.js";

const GB = 1024 ** 3;
const NOW = new Date("2026-10-01T12:00:00Z");
const at = (minAgo: number) => NOW.getTime() - minAgo * 60_000;

describe("memorySeriesFrom", () => {
  it("charts used bytes in GB against installed memory", () => {
    const s = memorySeriesFrom([
      { t: at(30), memPct: null, memUsedBytes: BigInt(10 * GB), memTotalBytes: BigInt(16 * GB) },
      { t: at(5), memPct: null, memUsedBytes: BigInt(14 * GB), memTotalBytes: BigInt(16 * GB) },
    ]);
    expect(s).toEqual({
      points: [{ t: at(30), v: 10 }, { t: at(5), v: 14 }],
      unit: " GB", percent: false, total: 16,
    });
  });

  it("prefers bytes when a row carries both, and drops percent-only rows from a bytes series", () => {
    const s = memorySeriesFrom([
      { t: at(30), memPct: 99, memUsedBytes: null, memTotalBytes: null },
      { t: at(5), memPct: 50, memUsedBytes: 8 * GB, memTotalBytes: 32 * GB },
    ]);
    expect(s.unit).toBe(" GB");
    expect(s.points).toEqual([{ t: at(5), v: 8 }]);
    expect(s.total).toBe(32);
  });

  it("scales the axis to the largest total in the window (a VM resized mid-hour)", () => {
    const s = memorySeriesFrom([
      { t: at(30), memPct: null, memUsedBytes: 3 * GB, memTotalBytes: 4 * GB },
      { t: at(5), memPct: null, memUsedBytes: 5 * GB, memTotalBytes: 8 * GB },
    ]);
    expect(s.total).toBe(8);
  });

  it("keeps percent for a device that reports only a percentage", () => {
    const s = memorySeriesFrom([
      { t: at(5), memPct: 71.5, memUsedBytes: null, memTotalBytes: null },
      { t: at(4), memPct: null, memUsedBytes: 1 * GB, memTotalBytes: 0 },
    ]);
    expect(s).toEqual({ points: [{ t: at(5), v: 71.5 }], unit: "%", percent: true, total: null });
  });
});

describe("the memory chart in an alert email", () => {
  beforeEach(() => { telemetryRows.rows = []; });

  it("summarises a bytes host in GB with its installed memory", async () => {
    telemetryRows.rows = [
      { timestamp: new Date(at(30)), cpuPct: 20, memPct: null, memUsedBytes: BigInt(12 * GB), memTotalBytes: BigInt(16 * GB) },
      { timestamp: new Date(at(5)), cpuPct: 25, memPct: null, memUsedBytes: BigInt(15 * GB), memTotalBytes: BigInt(16 * GB) },
    ];
    const charts = await buildAlertCharts("a1", ["chart.memory"], { now: NOW, metric: "memPct" });
    const mem = charts.get("chart.memory")!;
    expect(mem.hasData).toBe(true);
    expect(mem.summary).toBe("Memory (last hour): now 15 GB, avg 13.5 GB, peak 15 GB (16 GB installed)");
  });

  it("keeps a FortiOS percentage in percent", async () => {
    telemetryRows.rows = [
      { timestamp: new Date(at(5)), cpuPct: 20, memPct: 81, memUsedBytes: null, memTotalBytes: null },
    ];
    const charts = await buildAlertCharts("a1", ["chart.memory"], { now: NOW, metric: "memPct" });
    expect(charts.get("chart.memory")!.summary).toBe("Memory (last hour): now 81%, avg 81%, peak 81%");
  });
});
