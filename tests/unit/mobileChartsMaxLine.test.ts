/**
 * tests/unit/mobileChartsMaxLine.test.ts
 *
 * The phone's bucket-max lines: on a chart reading a ROLLUP tier (the history
 * payload's `bucketSeconds > 0`) each series' bucket MAX is drawn as a dashed
 * ("2 3") companion of its average, under every average, broken where a max is
 * null; a `Max` chip toggles them, and the value axis spans them only while
 * they are shown. The choice lives on the sheet's per-asset mount state.
 *
 * Covers PolarisCharts.lineChart (public/js/mobile/charts.js), the split CPU
 * chart (public/js/mobile/telemetry-charts.js) and the response-time chart in
 * the asset sheet (public/js/mobile/asset-detail.js).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(process.cwd(), "public", "js", "mobile", f), "utf-8");
const CHARTS_SRC = read("charts.js");
const TELEMETRY_SRC = read("telemetry-charts.js");
const DETAIL_SRC = read("asset-detail.js");
const g = globalThis as any;
const H = 3600_000;
const T0 = Date.UTC(2026, 10, 1, 0, 0);

function loadCharts() {
  g.escapeHtml = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(CHARTS_SRC)();
  return g.PolarisCharts;
}

const maxLines = (root: ParentNode = document) => Array.from(root.querySelectorAll("polyline.max-line")) as SVGElement[];
const topTick = (html: string) => (html.match(/<span class="chart-y-tick" style="top:0;">([^<]*)<\/span>/) || [])[1];
function frag(html: string) { const d = document.createElement("div"); d.innerHTML = html; return d; }

describe("lineChart bucket max", () => {
  const avg = [0, 1, 2, 3].map((i) => ({ ts: T0 + i * H, v: 10 }));
  const max = [0, 1, 2, 3].map((i) => ({ ts: T0 + i * H, v: 50 }));

  it("draws a dashed, non-scaling companion in the series colour, under the average", () => {
    const C = loadCharts();
    const html = C.lineChart({ series: [{ values: avg, max, color: "#123456" }] });
    const lines = maxLines(frag(html));
    expect(lines).toHaveLength(1);
    const l = lines[0];
    expect(l.getAttribute("stroke-dasharray")).toBe("2 3");
    expect(C.MAX_DASH).toBe("2 3");
    expect(l.getAttribute("vector-effect")).toBe("non-scaling-stroke");
    expect(l.getAttribute("stroke")).toBe("#123456");
    expect(Number(l.getAttribute("stroke-width"))).toBeLessThan(1.6);
    expect(Number(l.getAttribute("stroke-opacity"))).toBeLessThan(1);
    expect(html.indexOf('class="max-line"')).toBeLessThan(html.indexOf('<polyline points='));
  });

  it("draws nothing extra without a max (the detail tier)", () => {
    const C = loadCharts();
    const html = C.lineChart({ series: [{ values: avg }], maxToggle: false });
    expect(maxLines(frag(html))).toHaveLength(0);
    expect(html).not.toContain("data-max-toggle");
  });

  it("breaks the dashed line where a bucket's max is null", () => {
    const C = loadCharts();
    const gappy = [50, 50, null, 50, 50].map((v, i) => ({ ts: T0 + i * H, v }));
    const html = C.lineChart({ series: [{ values: avg, max: gappy }] });
    expect(maxLines(frag(html))).toHaveLength(2);
  });

  it("the Max chip appears only with maxToggle and a max to toggle", () => {
    const C = loadCharts();
    expect(C.lineChart({ series: [{ values: avg, max }], maxToggle: true })).toContain("data-max-toggle");
    expect(C.lineChart({ series: [{ values: avg, max }] })).not.toContain("data-max-toggle");
    const allNull = max.map((p) => ({ ts: p.ts, v: null }));
    expect(C.lineChart({ series: [{ values: avg, max: allNull }], maxToggle: true })).not.toContain("data-max-toggle");
  });

  it("the chip's swatch is the line colour when every max line shares one, the text colour otherwise", () => {
    const C = loadCharts();
    const swatch = (html: string) =>
      (frag(html).querySelector("[data-max-toggle] span") as HTMLElement).getAttribute("style") ?? "";
    expect(swatch(C.lineChart({ series: [{ values: avg, max, color: "var(--md-success)" }], maxToggle: true })))
      .toContain("dashed var(--md-success)");
    expect(swatch(C.lineChart({
      series: [{ values: avg, max, color: "#4fc3f7" }, { values: avg, max, color: "#ffb74d" }], maxToggle: true,
    }))).toContain("dashed currentColor");
  });

  it("hiding the max removes every max line and lowers the axis to the averages", () => {
    const C = loadCharts();
    const on = C.lineChart({ series: [{ values: avg, max }], maxToggle: true });
    const off = C.lineChart({ series: [{ values: avg, max }], maxToggle: true, showMax: false });
    expect(topTick(on)).toBe("50.0");
    expect(topTick(off)).toBe("11.0");   // flat 10 → lineChart's ±1 pad
    expect(maxLines(frag(off))).toHaveLength(0);
    const chip = frag(off).querySelector("[data-max-toggle]")!;
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(chip.textContent).toBe("Max");
  });

  it("a recovering bucket's max takes the recovering colour, like its average", () => {
    const C = loadCharts();
    const rec = [0, 1, 2, 3].map((i) => ({ ts: T0 + i * H, v: 50, rec: i >= 2 }));
    const strokes = maxLines(frag(C.lineChart({ series: [{ values: avg, max: rec, color: "var(--md-success)" }] })))
      .map((l) => l.getAttribute("stroke"));
    expect(strokes).toEqual(["var(--md-success)", "#0288d1"]);
  });

  it("wireMaxToggle calls the latest callback once per tap", () => {
    const C = loadCharts();
    document.body.innerHTML = '<div id="h"></div>';
    const host = document.getElementById("h")!;
    const a = vi.fn(), b = vi.fn();
    C.wireMaxToggle(host, a);
    C.wireMaxToggle(host, b);
    host.innerHTML = C.lineChart({ series: [{ values: avg, max }], maxToggle: true });
    (host.querySelector("[data-max-toggle]") as HTMLElement).click();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("split CPU chart bucket max", () => {
  function loadTelemetry() {
    loadCharts();
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(TELEMETRY_SRC)();
    return g.PolarisTelemetryCharts;
  }
  function rollupSamples(opts: { coreMax?: boolean; cores?: boolean } = {}) {
    return [0, 1, 2].map((i) => ({
      timestamp: new Date(T0 + i * H).toISOString(),
      cpuPct: 20, maxCpuPct: 60,
      cpuCorePcts: opts.cores === false ? undefined : [10, 20, 30],
      cpuCoreMaxPcts: opts.coreMax === false ? undefined : [40, 50, 70],
      memPct: 50,
    }));
  }
  function render(tc: any, samples: any[], resp: any = {}, extra: any = {}) {
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById("host")!;
    const ctx = {
      resp: { samples, stats: {}, tier: "hourly", bucketSeconds: 3600, outages: [], ...resp },
      maint: [], asset: { id: "a1" }, range: "30d", bounds: null, hidden: {}, maxOff: {}, ...extra,
    };
    tc.render(host, ctx);
    return { host, ctx };
  }
  const cpuMax = () => maxLines(document.getElementById("asset-cpu-chart")!);

  it("dashes the average and every drawn core, with a Max chip beside Avg", () => {
    const tc = loadTelemetry();
    render(tc, rollupSamples());
    expect(cpuMax()).toHaveLength(4);   // 3 cores + Avg
    const chips = Array.from(document.querySelectorAll('[data-legend="cpu"] .chip')).map((c) => c.textContent!.trim());
    expect(chips.slice(0, 2)).toEqual(["Avg", "Max"]);
  });

  it("draws a core's max only while that core is drawn", () => {
    const tc = loadTelemetry();
    render(tc, rollupSamples(), {}, { hidden: { "0": true, "2": true } });
    expect(cpuMax()).toHaveLength(2);   // core 1 + Avg
    const strokes = cpuMax().map((l) => l.getAttribute("stroke"));
    expect(strokes).toContain(tc._coreColor(1, 3));
    expect(strokes).not.toContain(tc._coreColor(0, 3));
  });

  it("averages without cpuCoreMaxPcts still dash the cross-core max only", () => {
    const tc = loadTelemetry();
    render(tc, rollupSamples({ coreMax: false }));
    expect(cpuMax()).toHaveLength(1);
  });

  it("no Max chip or line on the detail tier", () => {
    const tc = loadTelemetry();
    render(tc, rollupSamples(), { tier: "detail", bucketSeconds: 0 });
    expect(cpuMax()).toHaveLength(0);
    expect(document.querySelector("[data-max-toggle]")).toBeNull();
  });

  it("a tap hides every max line, keeps the core picks, and survives a re-render", () => {
    const tc = loadTelemetry();
    const { ctx } = render(tc, rollupSamples());
    (document.querySelector("[data-max-toggle]") as HTMLElement).click();
    expect(ctx.maxOff.cpu).toBe(true);
    expect(cpuMax()).toHaveLength(0);
    expect(document.querySelector("[data-max-toggle]")!.getAttribute("aria-pressed")).toBe("false");
    expect(Object.keys(ctx.hidden)).toHaveLength(0);
    // A range change re-renders with the same mount-state object.
    render(tc, rollupSamples(), {}, { maxOff: ctx.maxOff });
    expect(cpuMax()).toHaveLength(0);
  });

  it("the rollup note shows only when the buckets lack per-core figures", () => {
    const tc = loadTelemetry();
    render(tc, rollupSamples());
    expect(document.body.textContent).not.toContain("Per-core detail is not kept");
    render(tc, rollupSamples({ cores: false, coreMax: false }));
    expect(document.body.textContent).toContain("Per-core detail is not kept in hourly buckets");
  });
});

describe("asset sheet response-time chart bucket max", () => {
  let chartCalls: any[];
  let monitorResp: any;
  const flush = async () => { for (let i = 0; i < 8; i++) await vi.advanceTimersByTimeAsync(0); };

  function boot() {
    document.body.innerHTML = '<div id="app"></div>';
    chartCalls = [];
    const C = loadCharts();
    const real = C.lineChart;
    C.lineChart = (o: any) => { chartCalls.push(o); return real(o); };
    g.PolarisTabs = { showSnackbar: vi.fn(), attachSwipeToDismiss: vi.fn() };
    g.PolarisMonitorStates = {
      fromPayload: () => ({ known: false, threshold: 1, recoveryPolls: 1, severity: null }),
      replay: (s: any[]) => s.map(() => ({ status: "up" })),
    };
    g.PolarisMobile = { user: () => ({ permissions: {} }) };
    g.mobileFormatDate = (s: any) => String(s ?? "");
    g.timeAgo = () => "1m ago";
    const known: Record<string, any> = {
      get: async () => ({ id: "a1", hostname: "SW-1", assetType: "switch", monitored: true, status: "active", monitorStatus: "up", macAddresses: [] }),
      maintenanceWindows: async () => ({ windows: [] }),
      monitorHistory: async () => monitorResp,
      telemetryHistory: async () => ({ samples: [], stats: {} }),
    };
    g.api = { assets: new Proxy(known, { get: (t, k: string) => (k in t ? t[k] : async () => ({})) }) };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(DETAIL_SRC)();
  }
  const monitorCalls = () => chartCalls.filter((c) => /^Response time/.test(c.ariaLabel || ""));

  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2026, 10, 2, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });

  it("a rollup tier passes the bucket max (none for a bucket with no successes) and a Max chip", async () => {
    monitorResp = {
      bucketSeconds: 3600, tier: "hourly", stats: {},
      samples: [
        { timestamp: new Date(T0).toISOString(), responseTimeMs: 4, maxResponseTimeMs: 40, sampleCount: 60, successCount: 60, failureCount: 0 },
        { timestamp: new Date(T0 + H).toISOString(), responseTimeMs: null, maxResponseTimeMs: null, sampleCount: 60, successCount: 0, failureCount: 60 },
        { timestamp: new Date(T0 + 2 * H).toISOString(), responseTimeMs: 5, maxResponseTimeMs: 30, sampleCount: 60, successCount: 60, failureCount: 0 },
      ],
    };
    boot();
    g.PolarisAssetDetail.open("a1");
    await flush();
    const call = monitorCalls().pop();
    expect(call.maxToggle).toBe(true);
    expect(call.showMax).toBe(true);
    expect(call.series[0].max.map((p: any) => p.v)).toEqual([40, null, 30]);
    expect(document.querySelector("#asset-monitor-chart [data-max-toggle]")).not.toBeNull();
  });

  it("the detail tier passes no max and no chip", async () => {
    monitorResp = {
      tier: "detail", bucketSeconds: 0, stats: {},
      samples: [{ timestamp: new Date(T0).toISOString(), success: true, responseTimeMs: 4 }],
    };
    boot();
    g.PolarisAssetDetail.open("a1");
    await flush();
    const call = monitorCalls().pop();
    expect(call.maxToggle).toBe(false);
    expect(call.series[0].max).toBeNull();
    expect(document.querySelector("#asset-monitor-chart [data-max-toggle]")).toBeNull();
  });

  it("the chip hides the max and the choice survives a reload of the chart", async () => {
    monitorResp = {
      bucketSeconds: 3600, tier: "hourly", stats: {},
      samples: [0, 1, 2].map((i) => ({ timestamp: new Date(T0 + i * H).toISOString(), responseTimeMs: 4, maxResponseTimeMs: 40, sampleCount: 60, successCount: 60, failureCount: 0 })),
    };
    boot();
    g.PolarisAssetDetail.open("a1");
    await flush();
    (document.querySelector("#asset-monitor-chart [data-max-toggle]") as HTMLElement).click();
    expect(monitorCalls().pop().showMax).toBe(false);
    expect(maxLines(document.getElementById("asset-monitor-chart")!)).toHaveLength(0);
    // Reopening the same asset re-runs the loader against the same mount state.
    g.PolarisAssetDetail.open("a1");
    await flush();
    expect(monitorCalls().pop().showMax).toBe(false);
  });
});
