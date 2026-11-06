/**
 * tests/unit/chartMaxLineDom.test.ts — the rollup tiers' dashed bucket-peak
 * ("max") line on the asset-details charts (public/js/assets.js).
 *
 * On the hourly / daily tiers a chart's solid line is the bucket AVERAGE, which
 * flattens a short spike to nothing. Each rollup chart therefore draws the
 * bucket's MAX as a fine dashed line (`2 3`) under the average, behind one
 * per-chart "Max (hourly peak)" / "Max (daily peak)" chip that persists per
 * user in the charts prefs map. Pinned here, per chart where it differs:
 *  - drawn on a rollup payload, absent on the detail tier, dashed `2 3`;
 *  - the chip exists only on a rollup tier and names the tier;
 *  - switching it off removes the lines AND lowers the y-axis top when the
 *    peaks stood above the averages; the choice survives a re-render;
 *  - the tooltip names avg AND max even with the line hidden;
 *  - a bucket with no max BREAKS the line rather than bridging it;
 *  - the response-time chart's key (which carries the chip) sits ABOVE it.
 * The CPU chart's per-core max lines are pinned in assetCpuMemoryChartsDom.
 *
 * Functions are sliced out of assets.js by name and eval'd with the chart-kit
 * globals stubbed — the approach of assetMonitorLossLineDom.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}
function constSrc(name: string): string {
  const l = lines.find((x) => x.startsWith(`var ${name} = `));
  if (!l) throw new Error(`assets.js: ${name} not found`);
  return l;
}

const FNS = [
  "_getChartRangePref", "_setChartRangePref", "_inChartWindow", "_chartRollupTier", "_getMaxLinePref",
  "_setMaxLinePref", "_maxLineChipHTML", "_maxLineLegendRowHTML", "_wireMaxLineChip", "_maxLineSVG", "_avgMaxText",
  "_chartStateLegendHTML", "_renderMonitorChart", "_renderIfaceThroughputChart", "_derivePerIntervalSeries",
  "_hwFmtNum", "_renderSensorChart", "_renderPerfSlaMultiChart",
];
const SRC = [
  constSrc("_CHART_FAIL_COLOR"), constSrc("_CHART_DEP_COLOR"), constSrc("_CHART_UP_COLOR"),
  constSrc("_CHART_MISS_COLOR"), constSrc("_CHART_RECOVER_COLOR"),
  ...FNS.map(fnSrc),
  ...FNS.map((n) => `globalThis.${n} = ${n};`),
  "globalThis._CHART_UP_COLOR = _CHART_UP_COLOR;",
].join("\n");

function installStubs() {
  g.currentUsername = "tester";
  try { localStorage.clear(); } catch { /* private mode */ }
  g.escapeHtml = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c: string) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  g._chartTimeBounds = (samples: any[], since?: string, until?: string) => ({
    t0: since ? +new Date(since) : +new Date(samples[0].timestamp),
    t1: until ? +new Date(until) : +new Date(samples[samples.length - 1].timestamp),
  });
  g._chartPad2 = (n: number) => String(n).padStart(2, "0");
  g._chartXScale = (padL: number, innerW: number, t0: number, t1: number) =>
    (t: string | number) => padL + ((+new Date(t) - t0) / Math.max(1, t1 - t0)) * innerW;
  g._chartYScale = (padT: number, innerH: number, yMin: number, yMax: number) =>
    (v: number) => padT + innerH - ((v - yMin) / Math.max(1e-9, yMax - yMin)) * innerH;
  g._chartClipId = (p: string) => `clip-${p}`;
  g._chartClipDefs = () => "";
  g._chartClipAttr = (id: string) => `clip-path="url(#${id})"`;
  g._intermittencyStates = (s: any[]) => s.map(() => ({ status: "up", missed: 0 }));
  g._failureAwareSeriesSVG = () => ({ defs: "", segments: '<polyline class="avg-line"/>' });
  g._chartPointColor = (p: any, c: string) => (p.rec ? "#rec" : c);
  g._failureDotsSVG = () => "";
  g._chartXTicksSVG = () => "";
  g._dateChangeMarkers = () => "";
  g._maintenanceBandLayer = () => "";
  g._stashChartGeometry = () => {};
  g._addChartScreenshotButton = () => {};
  g._observeChartResize = () => {};
  g._statsSummaryFrom = () => () => "";
  g._outageMarkers = () => [];
  g._outagePts = () => [];
  g._outageDotsSVG = () => "";
  g._outageHitsSVG = () => "";
  g._missTooltipHTML = () => "<div>miss</div>";
  g._fmtTooltipTs = (ts: string) => String(ts);
  g._fmtBitsPerSec = (n: number) => `${n} bps`;
  g._fmtBitsPerSecAxis = (n: number) => String(n);
  g._severityChartLayer = () => ({ defs: "", lines: "", stroke: "#accent", labels: "" });
  g.CHART_TOOLTIP_HTML = '<div class="chart-tooltip"></div>';
  // Captured so a test can render what the shared tooltip would show.
  g.__tooltipFns = [] as Array<(t: Element) => string>;
  g._wireChartTooltip = (_c: Element, fn: (t: Element) => string) => { g.__tooltipFns.push(fn); };
  g._sdwanTabState = { hiddenMembers: new Set() };
  g._perfSlaShotStats = () => "";
}

beforeEach(() => {
  document.body.innerHTML = "";
  installStubs();
  (0, eval)(SRC);
});

const T0 = Date.UTC(2026, 10, 1, 0, 0, 0);
const HOUR = 3_600_000;
const iso = (h: number) => new Date(T0 + h * HOUR).toISOString();

function box(): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 600 });
  document.body.appendChild(el);
  return el;
}
const maxLines = (el: Element) => Array.from(el.querySelectorAll(".chart-max-line"));
const chip = (root: ParentNode) => root.querySelector(".chart-max-chip") as HTMLElement | null;
const tickLabels = (el: Element) => Array.from(el.querySelectorAll("text")).map((t) => t.textContent ?? "");
const prefs = () => JSON.parse(localStorage.getItem("polaris-prefs-charts-tester") || "{}");

describe("_maxLineSVG", () => {
  it("breaks the line where max is null instead of bridging", () => {
    const pt = (x: number) => ({ x, y: 10 });
    const host = document.createElement("svg");
    host.innerHTML = g._maxLineSVG([pt(1), pt(2), null, pt(4), pt(5)], "#abc");
    const polys = host.querySelectorAll("polyline");
    expect(polys).toHaveLength(2);
    polys.forEach((p) => {
      expect(p.getAttribute("stroke-dasharray")).toBe("2 3");
      expect(p.getAttribute("stroke-width")).toBe("1.25");
      expect(p.getAttribute("stroke")).toBe("#abc");
    });
    // A lone bucket between gaps cannot carry a dash, so it is a dot.
    host.innerHTML = g._maxLineSVG([pt(1), null, pt(3), null], "#abc");
    expect(host.querySelectorAll("polyline")).toHaveLength(0);
    expect(host.querySelectorAll("circle")).toHaveLength(2);
  });

  it("splits where the per-point colour changes", () => {
    const host = document.createElement("svg");
    host.innerHTML = g._maxLineSVG(
      [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1, color: "#rec" }, { x: 4, y: 1, color: "#rec" }], "#up");
    const strokes = Array.from(host.querySelectorAll("polyline")).map((p) => p.getAttribute("stroke"));
    expect(strokes).toEqual(["#up", "#rec"]);
  });
});

describe("_chartRollupTier", () => {
  it("names the rollup tier, null on detail", () => {
    expect(g._chartRollupTier({ tier: "hourly", bucketSeconds: 3600 })).toBe("hourly");
    expect(g._chartRollupTier({ tier: "daily", bucketSeconds: 86400 })).toBe("daily");
    expect(g._chartRollupTier({ bucketSeconds: 86400 })).toBe("daily");
    expect(g._chartRollupTier({ tier: "detail", bucketSeconds: 0 })).toBeNull();
    expect(g._chartRollupTier(null)).toBeNull();
  });
});

// ─── Response time ──────────────────────────────────────────────────────────

function rollupMonitor(tier = "hourly", over: Record<string, any> = {}) {
  const samples = Array.from({ length: 6 }, (_, i) => ({
    timestamp: iso(i), sampleCount: 60, successCount: 60, failureCount: 0,
    responseTimeMs: 20, minResponseTimeMs: 5, maxResponseTimeMs: i === 3 ? 400 : 30,
  }));
  return { since: iso(0), until: iso(6), tier, bucketSeconds: tier === "daily" ? 86400 : 3600, samples, ...over };
}

/** The asset panel's layout: the key slot sits immediately ABOVE the chart. */
function renderMonitor(data: unknown): { el: HTMLElement; key: HTMLElement } {
  const key = document.createElement("div");
  key.className = "chart-state-legend";
  document.body.appendChild(key);
  const el = box();
  g._renderMonitorChart(el, data, []);
  return { el, key };
}

describe("response-time chart — max line", () => {
  it("draws a dashed max line on an hourly payload, under the average", () => {
    const { el } = renderMonitor(rollupMonitor());
    const ml = maxLines(el);
    expect(ml.length).toBeGreaterThan(0);
    expect(ml.every((m) => m.getAttribute("stroke-dasharray") === "2 3")).toBe(true);
    // Coloured like the average point beside it (Up here).
    expect(ml[0]!.getAttribute("stroke")).toBe(g._CHART_UP_COLOR);
    // Under the average: earlier in paint order.
    const all = Array.from(el.querySelectorAll("polyline"));
    expect(all.indexOf(ml[0] as SVGPolylineElement)).toBeLessThan(all.findIndex((p) => p.classList.contains("avg-line")));
  });

  it("draws nothing — and no chip — on the detail tier", () => {
    const samples = Array.from({ length: 6 }, (_, i) => ({ timestamp: iso(i), success: true, responseTimeMs: 20 }));
    const { el, key } = renderMonitor({ since: iso(0), until: iso(6), tier: "detail", bucketSeconds: 0, samples });
    expect(maxLines(el)).toHaveLength(0);
    expect(chip(key)).toBeNull();
  });

  it("puts the chip in the key ABOVE the chart, labelled by tier", () => {
    const { el, key } = renderMonitor(rollupMonitor("hourly"));
    expect(el.previousElementSibling).toBe(key);
    expect(chip(key)!.textContent).toBe("Max (hourly peak)");
    // The swatch is the line's own colour (the Up green), never the grey of
    // the key's Parent down entry.
    const sw = chip(key)!.querySelector(".chart-max-swatch") as HTMLElement;
    expect(sw.getAttribute("style")).toContain("var(--color-success) 0");
    expect(sw.getAttribute("style")).not.toContain("currentColor");
    document.body.innerHTML = "";
    const daily = renderMonitor(rollupMonitor("daily"));
    expect(chip(daily.key)!.textContent).toBe("Max (daily peak)");
  });

  it("toggling off removes the max lines and lowers the y-axis top; the choice persists", () => {
    const { el, key } = renderMonitor(rollupMonitor());
    expect(tickLabels(el)).toContain("400");
    chip(key)!.click();
    expect(maxLines(el)).toHaveLength(0);
    expect(tickLabels(el)).not.toContain("400");
    expect(tickLabels(el)).toContain("50");
    expect(prefs()["assetMonitor:max"]).toBe("off");
    // Struck through, like a switched-off series chip.
    expect(chip(key)!.getAttribute("style")).toContain("line-through");
    // A fresh render (silent refresh / resize) keeps it off.
    g._renderMonitorChart(el, rollupMonitor(), []);
    expect(maxLines(el)).toHaveLength(0);
    chip(key)!.click();
    expect(maxLines(el).length).toBeGreaterThan(0);
    expect(prefs()["assetMonitor:max"]).toBe("on");
  });

  it("draws no max for a bucket with zero successes", () => {
    const data = rollupMonitor();
    data.samples[2] = { ...data.samples[2], successCount: 0, failureCount: 60, responseTimeMs: null, maxResponseTimeMs: 999 } as any;
    const { el } = renderMonitor(data);
    // Buckets 0-1 and 3-5: two runs, the failed bucket breaks the line.
    expect(maxLines(el)).toHaveLength(2);
    expect(tickLabels(el)).not.toContain("1000");
  });

  it("the tooltip names avg AND max with the line hidden", () => {
    g._setMaxLinePref("assetMonitor", false);
    const { el } = renderMonitor(rollupMonitor());
    expect(maxLines(el)).toHaveLength(0);
    const hit = el.querySelectorAll(".monitor-hit")[3]!;
    hit.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const tip = el.querySelector(".monitor-tooltip")!.textContent ?? "";
    expect(tip).toContain("20 ms avg");
    expect(tip).toContain("400 ms max");
    expect(tip).toContain("Min: 5 ms");
  });
});

// ─── Interface throughput ───────────────────────────────────────────────────

function ifacePayload(withMax = true) {
  const samples = Array.from({ length: 6 }, (_, i) => ({
    timestamp: iso(i), inBytesPerSec: 1000, outBytesPerSec: 500,
    ...(withMax ? { maxInBytesPerSec: i === 2 ? 100_000 : 2000, maxOutBytesPerSec: i < 2 ? null : 900 } : {}),
  }));
  return { since: iso(0), until: iso(6), tier: "hourly", bucketSeconds: 3600, samples };
}
function renderIface(data: any): HTMLElement {
  const el = box();
  const derived = g._derivePerIntervalSeries(data.samples, data);
  g._renderIfaceThroughputChart(el, derived, { since: data.since, until: data.until, maxTier: g._chartRollupTier(data) });
  return el;
}

describe("interface throughput — max line", () => {
  it("draws in/out peaks, breaks where a bucket predates the column, and rescales on toggle", () => {
    const el = renderIface(ifacePayload());
    const ml = maxLines(el);
    expect(ml).toHaveLength(2); // in: one run; out: one run after the two null buckets
    expect(ml.every((m) => m.getAttribute("stroke-dasharray") === "2 3")).toBe(true);
    // 100 kB/s peak = 800 kbit/s → the axis tops out at 1e6.
    expect(tickLabels(el)).toContain("1000000");
    chip(el)!.click();
    expect(maxLines(el)).toHaveLength(0);
    expect(tickLabels(el)).not.toContain("1000000");
    expect(tickLabels(el)).toContain("10000");
    expect(prefs()["assetInterface:max"]).toBe("off");
    // Hidden, the tooltip still names both.
    const fn = g.__tooltipFns[g.__tooltipFns.length - 1];
    const hit = el.querySelectorAll(".chart-hit")[2]!;
    const html = fn(hit);
    expect(html).toContain("8000 bps avg");
    expect(html).toContain("800000 bps max");
  });

  it("an older rollup with no max columns draws nothing", () => {
    const el = renderIface(ifacePayload(false));
    expect(maxLines(el)).toHaveLength(0);
    expect(chip(el)).not.toBeNull();
  });

  it("no chip and no line without a rollup tier", () => {
    const data = ifacePayload();
    const el = box();
    g._renderIfaceThroughputChart(el, g._derivePerIntervalSeries(data.samples, data), { since: data.since, until: data.until });
    expect(chip(el)).toBeNull();
    expect(maxLines(el)).toHaveLength(0);
  });
});

// ─── Hardware sensor ────────────────────────────────────────────────────────

describe("hardware sensor — max line", () => {
  const samples = Array.from({ length: 5 }, (_, i) => ({ timestamp: iso(i), value: 40, maxValue: i === 1 ? 90 : 45 }));
  const opts = (over: Record<string, unknown> = {}) =>
    ({ since: iso(0), until: iso(5), subject: "CPU temp", unit: "°C", maxTier: "daily", maxPrefKey: "assetSensor", ...over });

  it("draws in the series stroke, labels the chip by tier, and toggles the axis", () => {
    const el = box();
    g._renderSensorChart(el, samples, opts());
    expect(chip(el)!.textContent).toBe("Max (daily peak)");
    const ml = maxLines(el);
    expect(ml).toHaveLength(1);
    expect(ml[0]!.getAttribute("stroke")).toBe("#accent");
    const topShown = tickLabels(el).filter((t) => /°C$/.test(t)).map((t) => parseFloat(t));
    expect(Math.max(...topShown)).toBeGreaterThanOrEqual(90);
    chip(el)!.click();
    expect(maxLines(el)).toHaveLength(0);
    const topHidden = tickLabels(el).filter((t) => /°C$/.test(t)).map((t) => parseFloat(t));
    expect(Math.max(...topHidden)).toBeLessThan(90);
    const fn = g.__tooltipFns[g.__tooltipFns.length - 1];
    const html = fn(el.querySelectorAll(".chart-hit")[1]!);
    expect(html).toContain("40.0 °C avg");
    expect(html).toContain("90.0 °C max");
  });

  it("the process charts that share the renderer get no max", () => {
    const el = box();
    g._renderSensorChart(el, samples, { since: iso(0), until: iso(5), subject: "nginx CPU", unit: "%" });
    expect(chip(el)).toBeNull();
    expect(maxLines(el)).toHaveLength(0);
  });
});

// ─── SD-WAN Performance SLA ─────────────────────────────────────────────────

describe("SD-WAN performance SLA — max line", () => {
  const mk = (label: string, color: string, peak: number) => ({
    label, color,
    samples: Array.from({ length: 4 }, (_, i) => ({ timestamp: iso(i), latencyMs: 10, maxLatencyMs: i === 1 ? peak : 12, packetLoss: 0 })),
  });
  const series = [mk("wan1", "#111", 300), mk("wan2", "#222", 40)];
  const meta = { label: "Latency", unit: "ms", maxKey: "maxLatencyMs" };

  it("draws one dashed max per visible member and only for metrics given a maxKey", () => {
    const el = box();
    g._renderPerfSlaMultiChart(el, series, "latencyMs", meta, { since: iso(0), until: iso(4), maxTier: "hourly" });
    const ml = maxLines(el);
    expect(ml.map((m) => m.getAttribute("stroke"))).toEqual(["#111", "#222"]);
    expect(tickLabels(el)).toContain("500");
    // A hidden member draws no max and no longer holds the axis up.
    g._sdwanTabState.hiddenMembers = new Set(["wan1"]);
    g._renderPerfSlaMultiChart(el, series, "latencyMs", meta, { since: iso(0), until: iso(4), maxTier: "hourly" });
    expect(maxLines(el).map((m) => m.getAttribute("stroke"))).toEqual(["#222"]);
    expect(tickLabels(el)).not.toContain("500");
    // Packet loss passes no maxKey: nothing.
    g._renderPerfSlaMultiChart(el, series, "packetLoss", { label: "Packet loss", unit: "%" }, { since: iso(0), until: iso(4), maxTier: "hourly" });
    expect(maxLines(el)).toHaveLength(0);
  });

  it("hidden by the pref, the axis drops back and the tooltip still names the max", () => {
    g._setMaxLinePref("assetSdwan", false);
    const el = box();
    g._renderPerfSlaMultiChart(el, series, "latencyMs", meta, { since: iso(0), until: iso(4), maxTier: "hourly" });
    expect(maxLines(el)).toHaveLength(0);
    expect(tickLabels(el)).not.toContain("500");
    const fn = g.__tooltipFns[g.__tooltipFns.length - 1];
    const html = fn(el.querySelectorAll(".chart-hit")[1]!);
    expect(html).toContain("10 ms avg");
    expect(html).toContain("300 ms max");
  });
});
