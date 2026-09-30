/**
 * tests/unit/assetMonitorLossLineDom.test.ts — the packet-loss line overlaid
 * on the asset-details response-time chart (public/js/assets.js →
 * _renderMonitorChart).
 *
 * Pins what is only observable in the rendered SVG:
 *  - the loss series draws on its own right-hand 0–100 % axis, in a colour
 *    that is none of the reserved chart hues (red = missed poll / Down, grey =
 *    dependency-down — a data line in either reads as an outage marker);
 *  - a gap in the buckets breaks the line rather than being bridged, because
 *    a gap in probing is not a stretch of 0 % loss;
 *  - an older payload with no `loss` keeps the single-axis chart unchanged.
 *
 * The function is sliced out of the ~25k-line browser script and eval'd with
 * the chart-kit globals stubbed — the approach of assetCpuMemoryChartsDom.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(signature: string): string {
  const start = lines.findIndex((l) => l.startsWith(signature));
  if (start < 0) throw new Error(`assets.js: ${signature} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}
function constSrc(name: string): string {
  const l = lines.find((x) => x.startsWith(`var ${name} = `));
  if (!l) throw new Error(`assets.js: ${name} not found`);
  return l;
}

const SRC = [
  constSrc("_CHART_FAIL_COLOR"), constSrc("_CHART_DEP_COLOR"), constSrc("_CHART_UP_COLOR"),
  constSrc("_CHART_MISS_COLOR"), constSrc("_CHART_RECOVER_COLOR"), constSrc("_CHART_LOSS_COLOR"),
  fnSrc("function _renderMonitorChart("),
  "globalThis._renderMonitorChart = _renderMonitorChart;",
  "globalThis._CHART_LOSS_COLOR = _CHART_LOSS_COLOR;",
  "globalThis._CHART_FAIL_COLOR = _CHART_FAIL_COLOR;",
  "globalThis._CHART_DEP_COLOR = _CHART_DEP_COLOR;",
].join("\n");

function installStubs() {
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
  g._failureAwareSeriesSVG = () => ({ defs: "", segments: "" });
  g._chartPointColor = (_p: unknown, c: string) => c;
  g._failureDotsSVG = () => "";
  g._chartXTicksSVG = () => "";
  g._dateChangeMarkers = () => "";
  g._maintenanceBandLayer = () => "";
  g._stashChartGeometry = () => {};
  g._addChartScreenshotButton = () => {};
  g._observeChartResize = () => {};
  g._statsSummaryFrom = () => () => "";
}

const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

function payload(loss: unknown) {
  const samples = Array.from({ length: 30 }, (_, i) => ({ timestamp: iso(i * 2), success: true, responseTimeMs: 20 }));
  return { since: iso(0), until: iso(60), samples, ...(loss === undefined ? {} : { loss }) };
}

function render(data: unknown): HTMLElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "clientWidth", { value: 600 });
  document.body.appendChild(el);
  g._renderMonitorChart(el, data, []);
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  installStubs();
  (0, eval)(SRC);
});

describe("response-time chart — packet-loss line", () => {
  it("draws the loss on a right-hand percentage axis", () => {
    const B = 2 * 60_000;
    const el = render(payload({
      bucketMs: B,
      points: [0, 1, 2, 3].map((i) => ({ t: T0 + i * B, v: i === 2 ? 40 : 0 })),
      ratioPct: 10,
    }));
    const line = el.querySelectorAll("polyline");
    expect(line).toHaveLength(1);
    expect(line[0]!.getAttribute("stroke")).toBe(g._CHART_LOSS_COLOR);
    expect(line[0]!.getAttribute("stroke-dasharray")).toBeTruthy();
    const titles = Array.from(el.querySelectorAll(".chart-axis-title")).map((t) => t.textContent);
    expect(titles).toContain("Packet loss (%)");
    const labels = Array.from(el.querySelectorAll("text")).map((t) => t.textContent);
    expect(labels).toEqual(expect.arrayContaining(["0%", "50%", "100%"]));
    expect(el.querySelectorAll(".monitor-loss-hit")).toHaveLength(4);
    // 40 % sits 40 % of the way up the plot (padT 10, innerH 134).
    const hit = el.querySelectorAll(".monitor-loss-hit")[2]!;
    expect(Number(hit.getAttribute("cy"))).toBeCloseTo(10 + 134 * 0.6, 5);
  });

  it("breaks the line across missing buckets", () => {
    const B = 2 * 60_000;
    const el = render(payload({
      bucketMs: B,
      points: [0, 1, 10, 11].map((i) => ({ t: T0 + i * B, v: 5 })),
      ratioPct: 5,
    }));
    expect(el.querySelectorAll("polyline")).toHaveLength(2);
  });

  it("keeps the single-axis chart for a payload without loss", () => {
    const el = render(payload(undefined));
    expect(el.querySelectorAll("polyline")).toHaveLength(0);
    expect(el.querySelectorAll(".monitor-loss-hit")).toHaveLength(0);
    const titles = Array.from(el.querySelectorAll(".chart-axis-title")).map((t) => t.textContent);
    expect(titles).not.toContain("Packet loss (%)");
  });

  it("takes none of the reserved outage hues", () => {
    const c = String(g._CHART_LOSS_COLOR).toLowerCase();
    expect(c).not.toBe(String(g._CHART_FAIL_COLOR).toLowerCase());
    expect(c).not.toBe(String(g._CHART_DEP_COLOR).toLowerCase());
    // Not red-dominant: a hue away from 0°.
    const [r, gr, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    expect(Math.max(gr!, b!)).toBeGreaterThan(r! * 0.6);
  });
});
