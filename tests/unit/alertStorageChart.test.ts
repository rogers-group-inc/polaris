/**
 * tests/unit/alertStorageChart.test.ts
 *
 * The storage chart in an alert email. A storage alert is about one
 * filesystem, so it charts THAT mount instead of the device's CPU / memory /
 * response time / loss:
 *
 *  - used % / used bytes: the mount's last 24 hours, with the automation's
 *    threshold dashed;
 *  - days until full: a FORECAST — the daily points the automation's number was
 *    fitted on, then the trend carried forward for the automation's own
 *    threshold in days, to the capacity line.
 *
 * The pure spec builders are tested directly (the geometry is the point), and
 * the swap is driven through buildAlertCharts against a mocked Prisma, because
 * "which queries ran" is half of it: a storage alert must not read the device's
 * telemetry or probe tables at all.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { calls, storageRows, dailyRows } = vi.hoisted(() => ({
  calls: [] as string[],
  storageRows: { rows: [] as unknown[] },
  dailyRows: { rows: [] as unknown[] },
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetStorageSample: {
      findMany: vi.fn(async (args: { where: { mountPath: string } }) => {
        calls.push(`storage:${args.where.mountPath}`);
        return storageRows.rows;
      }),
    },
    $queryRawUnsafe: vi.fn(async (_sql: string, ...params: unknown[]) => {
      calls.push(`forecast:${params.slice(1).join(",")}`);
      return dailyRows.rows;
    }),
    assetTelemetrySample: { findMany: vi.fn(async () => { calls.push("telemetry"); return []; }) },
    assetMonitorSample: { findMany: vi.fn(async () => { calls.push("monitor"); return []; }) },
    assetHardwareSensorSample: { findMany: vi.fn(async () => { calls.push("sensor"); return []; }) },
    assetPerfSlaSample: { findMany: vi.fn(async () => { calls.push("perfSla"); return []; }) },
    asset: { findUnique: vi.fn(async () => null) },
  },
}));

// The rasterizer is a native binding; the assertions are about which charts
// were built and what they say.
vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    render() { return { asPng: () => new Uint8Array([1, 2, 3]) }; }
  },
}));

vi.mock("../../src/services/downDetectionService.js", () => ({
  describeDownDetectionFor: vi.fn(async () => null),
  recoveryPollsFor: vi.fn(() => 0),
}));

import {
  buildAlertCharts,
  bytesDisplayScale,
  chartTokenForMetric,
  isStorageScopedAlert,
  storageForecastSpec,
  storageThresholdFromTrigger,
  storageUsageSpec,
  STORAGE_USAGE_WINDOW_MS,
  type ChartToken,
} from "../../src/services/alertChartService.js";
import { forecastFromDailyPoints } from "../../src/services/storageForecastService.js";
import { sparklineSvg, timeAxisLabel } from "../../src/utils/sparklineSvg.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-09-28T12:00:00Z");
const GB = 1024 ** 3;
const TOTAL = 100 * GB;

/** `n` daily points ending today, growing `perDay` GB from `startGb`. */
const growing = (n: number, startGb: number, perDay: number) => {
  const today = Math.floor(NOW / DAY) * DAY;
  return Array.from({ length: n }, (_, i) => ({ t: today - (n - 1 - i) * DAY, v: (startGb + i * perDay) * GB }));
};

const ALL_TOKENS: ChartToken[] = [
  "chart.trigger", "chart.sensor", "chart.probeLoss",
  "chart.sdwanLatency", "chart.sdwanJitter", "chart.sdwanLoss",
  "chart.cpu", "chart.memory", "chart.responseTime", "chart.storage",
];

describe("which alerts are storage alerts", () => {
  it("names the three storage metrics and points each at the storage chart", () => {
    for (const m of ["storageUsedPct", "storageUsedBytes", "storageDaysUntilFull"]) {
      expect(isStorageScopedAlert(m)).toBe(true);
      expect(chartTokenForMetric(m)).toBe("chart.storage");
    }
    for (const m of ["cpuPct", "ifOperStatus", "sdwanLatencyMs", null, undefined, ""]) {
      expect(isStorageScopedAlert(m)).toBe(false);
    }
  });

  it("reads the threshold off a plain storage trigger only", () => {
    expect(storageThresholdFromTrigger({ type: "asset_metric", metric: "storageDaysUntilFull", operator: "<", threshold: 7 })).toBe(7);
    expect(storageThresholdFromTrigger({ type: "host_metric", metric: "storageUsedPct", threshold: 90 })).toBe(90);
    // Not a storage metric, a composite, junk: no line and no horizon.
    expect(storageThresholdFromTrigger({ type: "asset_metric", metric: "cpuPct", threshold: 90 })).toBeNull();
    expect(storageThresholdFromTrigger({ type: "composite", leaves: [] })).toBeNull();
    expect(storageThresholdFromTrigger({ type: "asset_metric", metric: "storageUsedPct", threshold: "90" })).toBeNull();
    expect(storageThresholdFromTrigger(null)).toBeNull();
  });
});

describe("the usage chart (used % / used bytes)", () => {
  const rows = [
    { t: NOW - 20 * 3_600_000, used: 80 * GB, total: TOTAL },
    { t: NOW - 1 * 3_600_000, used: 93 * GB, total: TOTAL },
  ];

  it("covers the last 24 hours in percent, pinned 0–100, with the threshold", () => {
    const spec = storageUsageSpec(rows, { metric: "storageUsedPct", mountPath: "/data", threshold: 90, now: NOW });
    expect(spec.from).toBe(NOW - STORAGE_USAGE_WINDOW_MS);
    expect(spec.to).toBe(NOW);
    expect(spec.percent).toBe(true);
    expect(spec.points.map((p) => Math.round(p.v))).toEqual([80, 93]);
    expect(spec.threshold).toBe(90);
    expect(spec.projection).toEqual([]);
    expect(spec.label).toContain("/data");
    expect(spec.summary).toContain("last 24 h");
    expect(spec.summary).toContain("now 93%");
  });

  it("draws bytes in a readable unit, with the threshold scaled to match", () => {
    const spec = storageUsageSpec(rows, { metric: "storageUsedBytes", mountPath: "/data", threshold: 90 * GB, now: NOW });
    expect(spec.unit).toBe(" GB");
    expect(spec.percent).toBe(false);
    expect(spec.points.map((p) => p.v)).toEqual([80, 93]);
    expect(spec.threshold).toBe(90);
  });

  it("scales bytes to the largest unit that keeps the number at or above 1", () => {
    expect(bytesDisplayScale(512)).toEqual({ divisor: 1, unit: " B" });
    expect(bytesDisplayScale(3 * GB).unit).toBe(" GB");
    expect(bytesDisplayScale(2 * 1024 * GB).unit).toBe(" TB");
  });
});

describe("the forecast chart (days until full)", () => {
  it("fits the same way the automation does", () => {
    // 1 GB/day on a 100 GB disk at 80 GB → 20 days.
    const fc = forecastFromDailyPoints(growing(10, 71, 1), TOTAL);
    expect(fc.slopePerDay).toBeCloseTo(GB, -3);
    expect(fc.daysUntilFull).toBeCloseTo(20, 1);
    // Too few points, or not growing: no fit, but the history comes back.
    expect(forecastFromDailyPoints(growing(5, 71, 1), TOTAL).daysUntilFull).toBeNull();
    expect(forecastFromDailyPoints(growing(10, 80, 0), TOTAL).daysUntilFull).toBeNull();
    expect(forecastFromDailyPoints(growing(10, 80, 0), TOTAL).points).toHaveLength(10);
  });

  it("projects from now to the capacity line inside the automation's horizon", () => {
    // 2 GB/day at 90 GB → full in 5 days; a "< 7 days" automation.
    const fc = forecastFromDailyPoints(growing(14, 64, 2), TOTAL);
    const spec = storageForecastSpec(fc, { mountPath: "/data", horizonDays: 7, now: NOW });
    expect(spec.now).toBe(NOW);
    expect(spec.to).toBe(NOW + 7 * DAY);
    expect(spec.ceiling).toBe(100);
    expect(spec.projection).toHaveLength(2);
    expect(spec.projection[0]).toEqual({ t: NOW, v: 90 });
    // It stops where it hits 100%, at the projected full date.
    expect(spec.projection[1]!.v).toBeCloseTo(100, 5);
    expect(spec.projection[1]!.t).toBeCloseTo(NOW + 5 * DAY, -4);
    expect(spec.caption).toBe("now 90% · +2%/day · full in 5 d");
    expect(spec.summary).toContain("projected full in 5 days");
    expect(spec.summary).toContain("next 7 d");
  });

  it("stops at the horizon, short of full, when the fill date is past it", () => {
    // Full in 20 days, but the automation only looks 7 ahead (a reminder after
    // the mount was partly cleaned up, say).
    const fc = forecastFromDailyPoints(growing(10, 71, 1), TOTAL);
    const spec = storageForecastSpec(fc, { mountPath: "/data", horizonDays: 7, now: NOW });
    expect(spec.projection[1]!.t).toBe(NOW + 7 * DAY);
    expect(spec.projection[1]!.v).toBeCloseTo(87, 5);
    expect(spec.caption).toContain("full in 20 d");
  });

  it("picks its own horizon when the automation's is unknown", () => {
    const fc = forecastFromDailyPoints(growing(10, 71, 1), TOTAL);
    const spec = storageForecastSpec(fc, { mountPath: "/data", horizonDays: null, now: NOW });
    // 20 days × 1.25, so the fill date is on the chart.
    expect(spec.to).toBe(NOW + 25 * DAY);
  });

  it("draws history and says so when the mount has stopped growing", () => {
    const fc = forecastFromDailyPoints(growing(10, 80, 0), TOTAL);
    const spec = storageForecastSpec(fc, { mountPath: "/data", horizonDays: 7, now: NOW });
    expect(spec.projection).toEqual([]);
    expect(spec.points).toHaveLength(10);
    expect(spec.caption).toContain("no longer growing");
  });

  it("falls back to a bytes history when capacity is unknown", () => {
    const spec = storageForecastSpec(forecastFromDailyPoints(growing(10, 71, 1), null), { mountPath: "/data", horizonDays: 7, now: NOW });
    expect(spec.percent).toBe(false);
    expect(spec.projection).toEqual([]);
    expect(spec.caption).toContain("capacity unknown");
  });
});

describe("the renderer", () => {
  it("labels a forecast axis on both sides of now and draws the projection and the capacity line", () => {
    const svg = sparklineSvg(
      [{ t: NOW - 10 * DAY, v: 70 }, { t: NOW - DAY, v: 90 }],
      {
        label: "Storage forecast — /data", unit: "%", yMin: 0, yMax: 100,
        projection: [{ t: NOW, v: 90 }, { t: NOW + 5 * DAY, v: 100 }],
        ceiling: 100, now: NOW, from: NOW - 10 * DAY, to: NOW + 7 * DAY,
        caption: "now 90% · +2%/day · full in 5 d",
      },
    );
    expect(svg).toContain('stroke-dasharray="5 4"');
    expect(svg).toContain(">-10 d<");
    expect(svg).toContain(">now<");
    expect(svg).toContain(">+7 d<");
    expect(svg).toContain(">full<");
    expect(svg).toContain("full in 5 d");
    // The end of a projection that reached full is marked red.
    expect(svg).toContain('fill="#dc2626"');
  });

  it("keeps the ordinary axis when there is no projection", () => {
    const svg = sparklineSvg([{ t: NOW - 3_600_000, v: 1 }, { t: NOW, v: 2 }], { label: "CPU", from: NOW - 3_600_000, to: NOW });
    expect(svg).toContain(">-60 min<");
    expect(svg).not.toContain(">+");
  });

  it("switches the axis to days from 72 hours on", () => {
    expect(timeAxisLabel(48 * 3_600_000)).toBe("48 h");
    expect(timeAxisLabel(72 * 3_600_000)).toBe("3 d");
    expect(timeAxisLabel(30 * DAY)).toBe("30 d");
    expect(timeAxisLabel(3.5 * DAY)).toBe("3.5 d");
    expect(timeAxisLabel(29.5 * DAY)).toBe("30 d");
  });
});

describe("the swap, end to end", () => {
  beforeEach(() => {
    calls.length = 0;
    storageRows.rows = [
      { timestamp: new Date(NOW - 2 * 3_600_000), usedBytes: BigInt(80 * GB), totalBytes: BigInt(TOTAL) },
      { timestamp: new Date(NOW - 60_000), usedBytes: BigInt(94 * GB), totalBytes: BigInt(TOTAL) },
    ];
    dailyRows.rows = growing(14, 64, 2).map((p) => ({ day: new Date(p.t), used: p.v, total: TOTAL }));
  });

  it("charts the mount and NOT the device on a used-% alert", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, {
      now: new Date(NOW), metric: "storageUsedPct", dimension: "/data", ruleThreshold: 90,
    });
    expect([...charts.keys()].sort()).toEqual(["chart.storage", "chart.trigger"]);
    expect(charts.get("chart.trigger")!.cid).toBe(charts.get("chart.storage")!.cid);
    expect(charts.get("chart.storage")!.summary).toContain("now 94%");
    expect(calls).toEqual(["storage:/data"]);
  });

  it("draws the forecast on a days-until-full alert, fitted on that one mount", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, {
      now: new Date(NOW), metric: "storageDaysUntilFull", dimension: "/data", ruleThreshold: 7,
    });
    const storage = charts.get("chart.storage")!;
    expect(storage.hasData).toBe(true);
    expect(storage.summary).toContain("projected full in 5 days");
    expect(storage.summary).toContain("next 7 d");
    expect(calls).toEqual(["forecast:a1,/data"]);
  });

  it("renders nothing for a storage alert with no mount to chart", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, { now: new Date(NOW), metric: "storageUsedPct", dimension: null });
    expect(charts.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it("never draws the storage chart for any other alert", async () => {
    const charts = await buildAlertCharts("a1", ALL_TOKENS, { now: new Date(NOW), metric: "cpuPct", dimension: null });
    expect(charts.has("chart.storage")).toBe(false);
    expect(calls).not.toContain("storage:/data");
  });

  it("invents a forecast for a test alert without reading anything", async () => {
    const charts = await buildAlertCharts(null, ALL_TOKENS, { sampleData: true, metric: "storageDaysUntilFull", dimension: "/data" });
    expect(charts.get("chart.storage")!.summary).toContain("growing");
    expect(calls).toEqual([]);
  });
});
