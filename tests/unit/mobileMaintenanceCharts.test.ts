/**
 * tests/unit/mobileMaintenanceCharts.test.ts — the phone shows a maintenance
 * window the way the desktop does.
 *
 * Server-driven polling stops for the whole of a maintenance window
 * (MONITOR_CANDIDATE_WHERE in monitoringService.ts), so every chart has a hole
 * there. The desktop explains the hole with a labelled lavender band and a
 * "Maintenance" pill; the phone used to leave a blank stretch — or, for a
 * window still open at the right-hand edge, cut the axis off at the last
 * sample — and kept showing the probe state frozen from before the window.
 *
 * Pinned here:
 *
 *   • charts.js: a window inside the range draws a band + label under the
 *     series; an ongoing window widens the axis to `to`; a range spent
 *     entirely in maintenance draws the band instead of "No data"; without an
 *     explicit range the bands are clipped to the samples and never widen it.
 *
 *   • asset-detail.js: the pill reads "Maintenance" (outranking a frozen "Up"
 *     and dependency suppression), the header dot is lavender, the subtext
 *     says monitoring is paused, and both sheet charts receive the windows
 *     plus the range bounds — fetched once per open, not once per chart.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHARTS_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "charts.js"), "utf-8");
const DETAIL_SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "asset-detail.js"), "utf-8");
const g = globalThis as any;

type LineChart = (opts: Record<string, unknown>) => string;
function loadCharts(): LineChart {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(CHARTS_SRC)();
  return g.PolarisCharts.lineChart;
}

const H = 3600_000;

describe("mobile lineChart maintenance bands", () => {
  const now = Date.UTC(2026, 8, 27, 12, 0);
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  it("draws a labelled band for a window inside the range", () => {
    const lineChart = loadCharts();
    const html = lineChart({
      series: [{ values: [{ ts: now - 24 * H, v: 5 }, { ts: now - 12 * H, v: 6 }, { ts: now, v: 7 }] }],
      maintenance: [{ startedAt: new Date(now - 20 * H).toISOString(), endedAt: new Date(now - 14 * H).toISOString(), scheduleName: "Patch night" }],
      from: now - 24 * H, to: now,
    });
    expect(html).toContain('class="maintenance-band"');
    expect(html).toContain("Patch night");
    // Under the series: the band rect comes before the first polyline.
    expect(html.indexOf("maintenance-band")).toBeLessThan(html.indexOf("<polyline"));
  });

  it("an ongoing window widens the axis to the end of the range", () => {
    const lineChart = loadCharts();
    const series = [{ values: [{ ts: now - 24 * H, v: 5 }, { ts: now - 6 * H, v: 6 }] }];
    const plain = lineChart({ series, from: now - 24 * H, to: now });
    const withMaint = lineChart({
      series, from: now - 24 * H, to: now,
      maintenance: [{ startedAt: new Date(now - 6 * H).toISOString(), endedAt: null }],
    });
    const right = (html: string) => [...html.matchAll(/<span class="chart-x-tick">([^<]*)<\/span>/g)].map((m) => m[1])[1];
    expect(right(withMaint)).not.toBe(right(plain));
    expect(withMaint).toContain('class="maintenance-band"');
    expect(withMaint).toContain(">Maintenance<");   // no schedule name → the generic label
  });

  it("a range spent entirely in maintenance draws the band, not 'No data'", () => {
    const lineChart = loadCharts();
    const html = lineChart({
      series: [{ values: [] }],
      maintenance: [{ startedAt: new Date(now - 48 * H).toISOString(), endedAt: null }],
      from: now - 24 * H, to: now,
    });
    expect(html).not.toContain("No data");
    expect(html).toContain('class="maintenance-band"');
  });

  it("with no range the bands are clipped to the samples and never widen the axis", () => {
    const lineChart = loadCharts();
    const series = [{ values: [{ ts: now - 24 * H, v: 5 }, { ts: now - 6 * H, v: 6 }] }];
    const plain = lineChart({ series });
    const withMaint = lineChart({ series, maintenance: [{ startedAt: new Date(now - 6 * H).toISOString(), endedAt: null }] });
    const ticks = (html: string) => [...html.matchAll(/<span class="chart-x-tick">([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(ticks(withMaint)).toEqual(ticks(plain));
    expect(lineChart({ series: [{ values: [] }], maintenance: [{ startedAt: new Date(now - 6 * H).toISOString() }] })).toContain("No data");
  });

  it("maintenanceSpans drops out-of-range windows and clamps the rest", () => {
    loadCharts();
    const spans = g.PolarisCharts._maintenanceSpans([
      { startedAt: new Date(now - 100 * H).toISOString(), endedAt: new Date(now - 90 * H).toISOString() },
      { startedAt: new Date(now - 30 * H).toISOString(), endedAt: new Date(now - 20 * H).toISOString(), scheduleName: "A" },
      { startedAt: "garbage" },
    ], now - 24 * H, now, now);
    expect(spans).toEqual([{ from: now - 24 * H, to: now - 20 * H, name: "A" }]);
  });
});

describe("mobile asset sheet in a maintenance window", () => {
  const WINDOWS = [{ startedAt: "2026-09-27T08:00:00.000Z", endedAt: null, scheduleName: "Firmware" }];
  let asset: any;
  let chartCalls: any[];
  let maintenanceWindows: ReturnType<typeof vi.fn>;
  const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };

  function boot() {
    document.body.innerHTML = '<div id="app"></div>';
    chartCalls = [];
    g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
    g.PolarisCharts = { lineChart: (o: any) => { chartCalls.push(o); return ""; } };
    g.PolarisMonitorStates = {
      fromPayload: () => ({ known: false, threshold: 1, recoveryPolls: 1, severity: null }),
      replay: (s: any[]) => s.map(() => ({ status: "up" })),
    };
    g.PolarisMobile = { user: () => ({ permissions: {} }) };
    g.mobileFormatDate = (s: any) => String(s ?? "");
    g.timeAgo = () => "1m ago";
    maintenanceWindows = vi.fn(async () => ({ windows: WINDOWS }));
    const known: Record<string, any> = {
      get: async () => asset,
      maintenanceWindows,
      monitorHistory: async () => ({ samples: [{ timestamp: "2026-09-27T07:00:00.000Z", success: true, responseTimeMs: 4 }], stats: {} }),
      telemetryHistory: async () => ({ samples: [{ timestamp: "2026-09-27T07:00:00.000Z", cpuPct: 10, memPct: 20 }], stats: {} }),
    };
    g.api = { assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(DETAIL_SRC)();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 8, 27, 12, 0));
    asset = {
      id: "a1", hostname: "SW-1", assetType: "switch", monitored: true, status: "maintenance",
      maintenanceReturnStatus: "active", monitorStatus: "up", lastResponseTimeMs: 3,
      dependencySuppressed: true, macAddresses: [],
    };
    boot();
  });
  afterEach(() => { vi.useRealTimers(); });

  it("the pill says Maintenance, not the frozen probe state", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    const pill = document.getElementById("asset-hero-pill")!;
    expect(pill.textContent).toContain("Maintenance");
    expect(pill.textContent).not.toContain("Up");
    expect(pill.textContent).not.toContain("Dep. Down");
    expect(document.getElementById("asset-sheet-dot")!.className).toBe("dot maint");
  });

  it("a section with no stats says polling is paused, not 'No samples'", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    expect(document.getElementById("asset-monitor-sub")!.textContent).toBe("Polling paused for maintenance");
    expect(document.getElementById("asset-telemetry-sub")!.textContent).toBe("Polling paused for maintenance");
  });

  it("the pill subtext names the pause and the return status", async () => {
    // Hold the history fetch open so the loader never overwrites the slot:
    // what is left is the header's initial subtext.
    g.api.assets.monitorHistory = () => new Promise(() => {});
    g.PolarisAssetDetail.open("a1");
    await flush();
    const sub = document.getElementById("asset-monitor-sub")!.textContent || "";
    expect(sub).toContain("monitoring paused");
    expect(sub).toContain("returns to active");
  });

  it("both sheet charts get the windows and the range bounds, fetched once", async () => {
    g.PolarisAssetDetail.open("a1");
    await flush();
    expect(chartCalls).toHaveLength(2);
    for (const c of chartCalls) {
      expect(c.maintenance).toEqual(WINDOWS);
      expect(c.to - c.from).toBe(24 * 3600_000);   // the default 24h range
    }
    expect(maintenanceWindows).toHaveBeenCalledTimes(1);
  });

  it("an asset out of maintenance keeps its probe-state pill", async () => {
    asset = { ...asset, status: "active", dependencySuppressed: false };
    g.PolarisAssetDetail.open("a1");
    await flush();
    expect(document.getElementById("asset-hero-pill")!.textContent).toContain("Up");
    expect(document.getElementById("asset-sheet-dot")!.className).toBe("dot up");
  });
});
