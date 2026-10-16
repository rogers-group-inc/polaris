/**
 * tests/unit/chartLeftEdgeDom.test.ts — lookback rows before a chart's left
 * edge are drawn (so the line enters from the edge) but never counted.
 *
 * History endpoints return rows before `since` — the route's overflow window
 * plus the row anchor in sampleHistoryService.readDetailWithAnchor. Pins:
 *  - desktop `_inChartWindow` keeps rows at or after `since` (any timestamp
 *    key, Date / ISO / epoch), and passes everything through without a since;
 *  - a client-computed stats line (`_renderPerfSlaStats`) counts only those;
 *  - the mobile `lineChart` starts its time axis at `from` when a lookback
 *    row exists, and a lookback value never widens the value axis.
 *
 * Desktop functions are sliced out of public/js/assets.js and eval'd — the
 * approach of assetMonitorLossLineDom.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;
const lines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

function fnSrc(signature: string): string {
  const start = lines.findIndex((l) => l.startsWith(signature));
  if (start < 0) throw new Error(`assets.js: ${signature} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

type Charts = { lineChart: (opts: Record<string, unknown>) => string };
let charts: Charts;

beforeAll(() => {
  (0, eval)([
    fnSrc("function _inChartWindow("),
    fnSrc("function _renderPerfSlaStats("),
    "globalThis._inChartWindow = _inChartWindow;",
    "globalThis._renderPerfSlaStats = _renderPerfSlaStats;",
  ].join("\n"));

  const win = new Window();
  g.window = win;
  g.document = win.document;
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/mobile/charts.js"), "utf8"));
  charts = (win as unknown as { PolarisCharts: Charts }).PolarisCharts;
});

const T0 = Date.parse("2026-10-16T12:00:00Z");
const min = (n: number) => T0 + n * 60_000;
const iso = (n: number) => new Date(min(n)).toISOString();

describe("_inChartWindow", () => {
  it("keeps rows at or after since, whatever the timestamp form", () => {
    const rows = [{ timestamp: iso(-10) }, { timestamp: iso(0) }, { timestamp: min(5) }];
    expect(g._inChartWindow(rows, iso(0))).toEqual(rows.slice(1));
    expect(g._inChartWindow(rows, min(0))).toEqual(rows.slice(1));
  });

  it("honours a custom timestamp key", () => {
    const pts = [{ t: min(-1), v: 9 }, { t: min(1), v: 1 }];
    expect(g._inChartWindow(pts, iso(0), "t")).toEqual([pts[1]]);
  });

  it("passes the list through without a usable since", () => {
    const rows = [{ timestamp: iso(-10) }];
    expect(g._inChartWindow(rows, null)).toBe(rows);
    expect(g._inChartWindow(rows, "not a date")).toBe(rows);
    expect(g._inChartWindow(undefined, iso(0))).toEqual([]);
  });
});

describe("_renderPerfSlaStats", () => {
  it("counts and averages only the rows inside the window", () => {
    let got: { count: number; parts: { label: string; value: string | null }[] } | null = null;
    g._renderChartStats = (_c: unknown, count: number, parts: any[]) => { got = { count, parts }; };
    g._tierStatsPart = () => null;
    const series = [
      { label: "wan1", samples: [{ timestamp: iso(-3), latencyMs: 900 }, { timestamp: iso(1), latencyMs: 10 }] },
      { label: "wan2", samples: [{ timestamp: iso(2), latencyMs: 30 }] },
    ];
    g._renderPerfSlaStats({}, series, { since: iso(0) }, "hc");
    expect(got!.count).toBe(2);
    expect(got!.parts.find((p) => p.label === "Avg latency")!.value).toBe("20 ms");
  });
});

describe("mobile lineChart left edge", () => {
  const leftTick = (html: string) => html.match(/<span class="chart-x-tick">([^<]*)<\/span>/)![1];
  const topTick = (html: string) => html.match(/<span class="chart-y-tick" style="top:0;">([^<]*)<\/span>/)![1];
  const fmt = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  it("starts the axis at `from`, not at a lookback row", () => {
    const html = charts.lineChart({
      from: min(0), to: min(60),
      series: [{ values: [{ ts: min(-20), v: 500 }, { ts: min(10), v: 5 }, { ts: min(60), v: 8 }] }],
    });
    expect(leftTick(html)).toContain(fmt(min(0)));
    // The lookback reading (500) never sets the value axis.
    expect(topTick(html)).toBe("8.00");
  });

  it("keeps the samples' own span without a lookback row", () => {
    const html = charts.lineChart({
      from: min(0), to: min(60),
      series: [{ values: [{ ts: min(10), v: 5 }, { ts: min(60), v: 8 }] }],
    });
    expect(leftTick(html)).toContain(fmt(min(10)));
  });
});
