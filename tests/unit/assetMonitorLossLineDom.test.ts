/**
 * tests/unit/assetMonitorLossLineDom.test.ts — the packet-loss line overlaid
 * on the asset-details response-time chart (public/js/assets.js →
 * _renderMonitorChart).
 *
 * Pins what is only observable in the rendered SVG:
 *  - the loss series draws on its own right-hand percentage axis, scaled to
 *    the worst bucket in the window (whole-percent quarters), DASHED and
 *    coloured by the device's verdict over each bucket — the response line's
 *    own vocabulary (Up green, grey while the parent was dark, red Down, blue
 *    recovering), so the two lines never disagree about the same minutes;
 *  - the key under the chart names only the colours drawn;
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
  constSrc("_CHART_MISS_COLOR"), constSrc("_CHART_RECOVER_COLOR"),
  fnSrc("function _chartStateLegendHTML("),
  fnSrc("function _renderMonitorChart("),
  "globalThis._renderMonitorChart = _renderMonitorChart;",
  "globalThis._CHART_UP_COLOR = _CHART_UP_COLOR;",
  "globalThis._CHART_FAIL_COLOR = _CHART_FAIL_COLOR;",
  "globalThis._CHART_DEP_COLOR = _CHART_DEP_COLOR;",
  "globalThis._CHART_RECOVER_COLOR = _CHART_RECOVER_COLOR;",
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
  // A test sets g.__statuses to script the replay; default all up.
  g._intermittencyStates = (s: any[]) => s.map((_x, i) => ({ status: g.__statuses?.[i] ?? "up", missed: 0 }));
  g.__statuses = undefined;
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
  // The key's slot, as the asset panel lays it out: the chart's next sibling.
  const key = document.createElement("div");
  key.className = "chart-state-legend";
  document.body.appendChild(key);
  g._renderMonitorChart(el, data, []);
  return el;
}
const keyLabels = (): string[] =>
  Array.from(document.querySelectorAll(".chart-state-legend > div > span")).map((s) => s.textContent ?? "");

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
    // Every poll answered, so every bucket is Up — a lossy bucket on an Up
    // device is a reading, not a verdict, and draws in the Up green.
    expect(line[0]!.getAttribute("stroke")).toBe(g._CHART_UP_COLOR);
    expect(line[0]!.getAttribute("stroke-dasharray")).toBeTruthy();
    const titles = Array.from(el.querySelectorAll(".chart-axis-title")).map((t) => t.textContent);
    expect(titles).toContain("Packet loss (%)");
    const labels = Array.from(el.querySelectorAll("text")).map((t) => t.textContent);
    // The worst bucket is 40 %, so the axis tops out at 40 %, not 100 %.
    expect(labels).toEqual(expect.arrayContaining(["0%", "10%", "20%", "30%", "40%"]));
    expect(labels).not.toContain("100%");
    expect(el.querySelectorAll(".monitor-loss-hit")).toHaveLength(4);
    // 40 % sits at the top of the plot (padT 10).
    const hit = el.querySelectorAll(".monitor-loss-hit")[2]!;
    expect(Number(hit.getAttribute("cy"))).toBeCloseTo(10, 5);
  });

  it("scales the loss axis to the worst bucket", () => {
    const B = 2 * 60_000;
    const axis = (peak: number) => {
      document.body.innerHTML = "";
      const el = render(payload({
        bucketMs: B,
        points: [0, 1, 2].map((i) => ({ t: T0 + i * B, v: i === 1 ? peak : 0 })),
        ratioPct: peak / 3,
      }));
      return Array.from(el.querySelectorAll("text"))
        .map((t) => t.textContent ?? "")
        .filter((t) => /^\d+(\.\d+)?%$/.test(t));
    };
    expect(axis(0)).toEqual(["0%", "1%", "2%", "3%", "4%"]);
    expect(axis(1.5)).toEqual(["0%", "1%", "2%", "3%", "4%"]);
    expect(axis(9)).toEqual(["0%", "3%", "6%", "9%", "12%"]);
    expect(axis(55)).toEqual(["0%", "15%", "30%", "45%", "60%"]);
    expect(axis(100)).toEqual(["0%", "25%", "50%", "75%", "100%"]);
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

  it("colours each bucket by the verdict over it: grey while the parent was dark, blue climbing back, green after", () => {
    // The 2026-10-26 report: a device behind a dark parent drew its 100 % loss
    // in alarm red right through the explained stretch, and red again at 0 %.
    const B = 2 * 60_000;
    const samples = Array.from({ length: 30 }, (_, i) => (
      i < 20
        ? { timestamp: iso(i * 2), success: false, dependencyDown: true }
        : { timestamp: iso(i * 2), success: true, responseTimeMs: 20 }
    ));
    g.__statuses = samples.map((_s, i) => (i < 20 ? "down" : i < 24 ? "recovering" : "up"));
    const el = document.body.appendChild(document.createElement("div"));
    Object.defineProperty(el, "clientWidth", { value: 600 });
    const key = document.body.appendChild(document.createElement("div"));
    key.className = "chart-state-legend";
    g._renderMonitorChart(el, {
      since: iso(0), until: iso(60), samples,
      loss: { bucketMs: B, points: samples.map((_s, i) => ({ t: T0 + i * B, v: i < 20 ? 100 : 0 })), ratioPct: 66 },
    }, []);
    const strokes = Array.from(el.querySelectorAll("polyline")).map((p) => p.getAttribute("stroke"));
    expect(strokes).toEqual([g._CHART_DEP_COLOR, g._CHART_RECOVER_COLOR, g._CHART_UP_COLOR]);
    // Never the Down red: every miss was explained.
    expect(strokes).not.toContain(g._CHART_FAIL_COLOR);
    // The state changes fade rather than jump, dashed like the rest.
    const fades = Array.from(el.querySelectorAll("line")).filter((l) => /^url\(#/.test(l.getAttribute("stroke") ?? ""));
    expect(fades.length).toBe(2);
    expect(fades.every((l) => l.getAttribute("stroke-dasharray"))).toBe(true);
    expect(keyLabels()).toEqual(["Up", "Recovering", "Parent down", "Packet loss (right axis)"]);
  });

  it("draws an unexplained outage's loss in the Down colour", () => {
    const B = 2 * 60_000;
    const samples = Array.from({ length: 4 }, (_, i) => ({ timestamp: iso(i * 2), success: false }));
    g.__statuses = samples.map(() => "down");
    const el = render({
      since: iso(0), until: iso(8), samples,
      loss: { bucketMs: B, points: samples.map((_s, i) => ({ t: T0 + i * B, v: 100 })), ratioPct: 100 },
    });
    expect(el.querySelector("polyline")!.getAttribute("stroke")).toBe(g._CHART_FAIL_COLOR);
    expect(keyLabels()).toContain("Down");
  });

  it("draws no key when the chart drew nothing but Up", () => {
    render(payload(undefined));
    expect(keyLabels()).toEqual([]);
  });
});
