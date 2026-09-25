/**
 * tests/unit/sdwanPerfSlaLegendDom.test.ts — the SD-WAN tab's Performance SLA
 * section has ONE member legend driving all three charts (public/js/assets.js).
 *
 * Each of the latency / jitter / packet-loss charts used to draw its own
 * legend inside its SVG, under the x-axis. It is now one HTML chip row between
 * the section header and the stats line, built from the CPU chart's
 * `_seriesChipHTML` and carrying its gestures: click hides/shows a member,
 * double-click shows ONLY that member, and "Show all" appears once anything
 * is off.
 *
 * Pinned here: one chip per member that has samples; a click hides the member
 * (after the double-click window) and re-renders all three charts; a
 * double-click isolates; Show all clears; and the screenshot stats line names
 * the members a capture shows, since the SVG no longer carries a legend.
 *
 * Harness: functions sliced out of assets.js by name and eval'd, as in
 * tests/unit/sdwanSectionHeaderDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = [
  "_seriesChipHTML",
  "_statsSummaryFrom",
  "_renderAllPerfSlaCharts",
  "_renderPerfSlaLegend",
  "_perfSlaShotStats",
];

const sample = { timestamp: "2026-09-24T00:00:00Z", latencyMs: 10, jitterMs: 1, packetLoss: 0 };

let chartCalls: Array<{ id: string; hidden: string[] }>;

function legend() { return document.getElementById("sdwan-perfsla-legend")!; }
function chip(label: string) {
  return legend().querySelector(`.sdwan-legend-chip[data-series="${label}"]`) as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers();
  g.escapeHtml = (s: any) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  chartCalls = [];
  g._renderPerfSlaMultiChart = (el: HTMLElement) => {
    chartCalls.push({ id: el.id, hidden: [...(g._sdwanTabState.hiddenMembers || [])].sort() });
  };
  document.body.innerHTML =
    '<div id="sdwan-perfsla-legend"></div>' +
    '<div id="sdwan-perfsla-stats" data-summary="120 samples"></div>' +
    '<div id="sdwan-latency-chart"></div><div id="sdwan-jitter-chart"></div><div id="sdwan-loss-chart"></div>';
  g._sdwanTabState = {
    hiddenMembers: new Set(),
    perfSla: {
      series: [
        { label: "wan1", color: "#111", samples: [sample] },
        { label: "wan2", color: "#222", samples: [sample] },
        { label: "lte", color: "#333", samples: [] },
      ],
      copts: {},
      thr: {},
    },
  };
  // eslint-disable-next-line no-eval
  (0, eval)(FN_NAMES.map(fnSrc).join("\n\n"));
});

afterEach(() => { vi.useRealTimers(); });

describe("Performance SLA shared legend", () => {
  it("renders one chip per member with samples, and all three charts", () => {
    g._renderAllPerfSlaCharts();
    expect(legend().querySelectorAll(".sdwan-legend-chip")).toHaveLength(2);
    expect(chip("lte")).toBeNull();
    expect(legend().querySelector(".sdwan-legend-all")).toBeNull();
    expect(chartCalls.map((c) => c.id)).toEqual(["sdwan-latency-chart", "sdwan-jitter-chart", "sdwan-loss-chart"]);
  });

  it("a click hides the member on all three charts after the double-click window", () => {
    g._renderAllPerfSlaCharts();
    chartCalls = [];
    chip("wan1").click();
    expect(chartCalls).toHaveLength(0);
    vi.advanceTimersByTime(250);
    expect(chartCalls).toHaveLength(3);
    chartCalls.forEach((c) => expect(c.hidden).toEqual(["wan1"]));
    expect(chip("wan1").style.textDecoration).toBe("line-through");
    expect(legend().querySelector(".sdwan-legend-all")).not.toBeNull();
  });

  it("a double-click shows only that member", () => {
    g._renderAllPerfSlaCharts();
    const c = chip("wan2");
    c.click(); c.click();
    c.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    vi.advanceTimersByTime(250);
    expect([...g._sdwanTabState.hiddenMembers]).toEqual(["wan1"]);
  });

  it("Show all brings every member back", () => {
    g._sdwanTabState.hiddenMembers = new Set(["wan1", "wan2"]);
    g._renderAllPerfSlaCharts();
    (legend().querySelector(".sdwan-legend-all") as HTMLElement).click();
    expect(g._sdwanTabState.hiddenMembers.size).toBe(0);
    expect(legend().querySelector(".sdwan-legend-all")).toBeNull();
  });

  it("screenshot stats name the members the capture shows", () => {
    g._sdwanTabState.hiddenMembers = new Set(["wan2"]);
    expect(g._perfSlaShotStats()).toBe("120 samples · Members: wan1");
  });
});
