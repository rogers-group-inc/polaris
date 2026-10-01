/**
 * tests/unit/alertCpuCoreChart.test.ts
 *
 * The CPU chart in an alert email. Every CPU alert charts the all-cores line;
 * a PER-CORE alert (`cpuCorePct`, business rule 89) draws every core thin
 * behind it and leads its caption with the busiest core, because that core —
 * not the average — is what crossed the line. A per-core alert on a window
 * with no core vectors falls back to the plain chart.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { telemetryRows, selects } = vi.hoisted(() => ({
  telemetryRows: { rows: [] as unknown[] },
  selects: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetTelemetrySample: {
      findMany: vi.fn(async (args: { select: Record<string, unknown> }) => {
        selects.push(args.select);
        return telemetryRows.rows;
      }),
    },
    assetMonitorSample: { findMany: vi.fn(async () => []) },
    assetHardwareSensorSample: { findMany: vi.fn(async () => []) },
    assetPerfSlaSample: { findMany: vi.fn(async () => []) },
    assetStorageSample: { findMany: vi.fn(async () => []) },
    $queryRawUnsafe: vi.fn(async () => []),
    asset: { findUnique: vi.fn(async () => null) },
  },
}));

const { svgs } = vi.hoisted(() => ({ svgs: [] as string[] }));
vi.mock("@resvg/resvg-js", () => ({
  Resvg: class {
    constructor(svg: string) { svgs.push(svg); }
    render() { return { asPng: () => new Uint8Array([1, 2, 3]) }; }
  },
}));

vi.mock("../../src/services/downDetectionService.js", () => ({
  describeDownDetectionFor: vi.fn(async () => null),
  recoveryPollsFor: vi.fn(() => 0),
}));

import {
  buildAlertCharts,
  busiestCore,
  coreSeriesFrom,
  cpuCoreColor,
  sampleChartSeries,
} from "../../src/services/alertChartService.js";
import { backgroundRuns } from "../../src/utils/sparklineSvg.js";

const NOW = new Date("2026-10-01T12:00:00Z");
const at = (minAgo: number) => NOW.getTime() - minAgo * 60_000;

describe("coreSeriesFrom", () => {
  it("transposes the per-sample vectors into one series per core, core 0 first", () => {
    expect(coreSeriesFrom([
      { t: 1, cores: [10, 90] },
      { t: 2, cores: [12, 95] },
    ])).toEqual([
      [{ t: 1, v: 10 }, { t: 2, v: 12 }],
      [{ t: 1, v: 90 }, { t: 2, v: 95 }],
    ]);
  });

  it("is null when no row carries a vector, and skips the rows that don't", () => {
    expect(coreSeriesFrom([{ t: 1, cores: null }, { t: 2, cores: "junk" }])).toBeNull();
    expect(coreSeriesFrom([{ t: 1, cores: null }, { t: 2, cores: [50] }])).toEqual([[{ t: 2, v: 50 }]]);
  });

  it("gives the extra cores of a VM resized mid-window shorter series", () => {
    const s = coreSeriesFrom([{ t: 1, cores: [1, 2] }, { t: 2, cores: [1, 2, 3, 4] }])!;
    expect(s).toHaveLength(4);
    expect(s[3]).toEqual([{ t: 2, v: 4 }]);
  });
});

describe("busiestCore", () => {
  it("picks the core busiest at the newest sample, ties to the higher peak", () => {
    expect(busiestCore([
      [{ t: 1, v: 100 }, { t: 2, v: 40 }],
      [{ t: 1, v: 60 }, { t: 2, v: 97 }],
      [{ t: 1, v: 99 }, { t: 2, v: 97 }],
    ])).toEqual({ index: 2, last: 97, peak: 99 });
    expect(busiestCore([[], []])).toBeNull();
  });
});

describe("cpuCoreColor", () => {
  it("never paints a core red or grey (the outage and dependency colours)", () => {
    for (const n of [2, 8, 64]) {
      for (let i = 0; i < n; i++) {
        const hex = cpuCoreColor(i, n);
        expect(hex).toMatch(/^#[0-9a-f]{6}$/);
        const [r, g, b] = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
        // Not grey: the channels are spread apart.
        expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeGreaterThan(40);
        // Not red: red dominant with both others well below it.
        expect(r! > 180 && g! < 90 && b! < 90).toBe(false);
      }
    }
  });
});

describe("backgroundRuns", () => {
  it("breaks a line where its own samples stop arriving", () => {
    const pts = [0, 60, 120, 180, 900, 960].map((s) => ({ t: s * 1000, v: 1 }));
    expect(backgroundRuns(pts).map((r) => r.length)).toEqual([4, 2]);
  });
});

describe("the CPU chart in an alert email", () => {
  beforeEach(() => {
    telemetryRows.rows = [
      { timestamp: new Date(at(10)), cpuPct: 20, memPct: 50, memUsedBytes: null, memTotalBytes: null, cpuCorePcts: [10, 95, 5, 10] },
      { timestamp: new Date(at(5)), cpuPct: 30, memPct: 50, memUsedBytes: null, memTotalBytes: null, cpuCorePcts: [12, 98, 6, 4] },
    ];
    selects.length = 0;
    svgs.length = 0;
  });

  it("a per-core alert draws every core behind the all-cores line and leads with the busiest", async () => {
    const charts = await buildAlertCharts("a1", ["chart.cpu"], { now: NOW, metric: "cpuCorePct" });
    const cpu = charts.get("chart.cpu")!;
    expect(selects[0]).toMatchObject({ cpuCorePcts: true });
    expect(cpu.summary).toBe(
      "CPU per core (last hour, 4 cores): busiest Core 1 now 98%, peak 98%; all cores now 30%, avg 25%, peak 30%",
    );
    const svg = svgs[0]!;
    expect(svg).toContain("CPU per core");
    expect(svg).toContain("Core 1 now 98% · peak 98% · all cores now 30%");
    // Three thin core lines and the busiest one emphasised, drawn last, in the
    // darker step of its own hue.
    expect(svg.match(/stroke-width="1\.2"/g)).toHaveLength(3);
    for (const i of [0, 2, 3]) expect(svg).toContain(cpuCoreColor(i, 4));
    expect(svg).toMatch(new RegExp(`stroke="${cpuCoreColor(1, 4, true)}" stroke-width="1\\.8"[^>]*opacity="1"`));
    expect(svg.lastIndexOf('stroke-width="1.8"')).toBeGreaterThan(svg.lastIndexOf('stroke-width="1.2"'));
  });

  it("an all-cores CPU alert keeps the single line and never reads the core vectors", async () => {
    const charts = await buildAlertCharts("a1", ["chart.cpu"], { now: NOW, metric: "cpuPct" });
    expect(selects[0]).toMatchObject({ cpuCorePcts: false });
    expect(charts.get("chart.cpu")!.summary).toBe("CPU (last hour): now 30%, avg 25%, peak 30%");
    expect(svgs[0]).not.toContain('stroke-width="1.2"');
  });

  it("a per-core alert with no core vectors in the window falls back to the plain chart", async () => {
    telemetryRows.rows = (telemetryRows.rows as Array<Record<string, unknown>>).map((r) => ({ ...r, cpuCorePcts: null }));
    const charts = await buildAlertCharts("a1", ["chart.cpu"], { now: NOW, metric: "cpuCorePct" });
    expect(charts.get("chart.cpu")!.summary).toBe("CPU (last hour): now 30%, avg 25%, peak 30%");
  });

  it("a per-core TEST alert draws invented cores with one pinned", async () => {
    const charts = await buildAlertCharts(null, ["chart.cpu"], { now: NOW, metric: "cpuCorePct", sampleData: true });
    expect(charts.get("chart.cpu")!.summary).toMatch(/^CPU per core \(last hour, 8 cores\): busiest Core 3 now 9\d/);
  });
});

describe("sampleChartSeries per core", () => {
  const since = new Date(NOW.getTime() - 60 * 60 * 1000);
  const base = { since, now: NOW, lossSince: since, lossBucketMs: 5 * 60 * 1000, displayUnit: "c" as const };

  it("generates cores only when asked, and the all-cores line is their mean", () => {
    expect(sampleChartSeries(["chart.cpu"], base).cores).toBeNull();
    const s = sampleChartSeries(["chart.cpu"], { ...base, perCore: true });
    expect(s.cores).toHaveLength(8);
    const i = s.cpu.length - 1;
    const mean = s.cores!.reduce((acc, c) => acc + c[i]!.v, 0) / 8;
    expect(s.cpu[i]!.v).toBeCloseTo(mean, 0);
  });
});
