/**
 * tests/unit/customWidgetWarningDom.test.ts — a gauge / line custom widget's
 * warning threshold, end to end through the browser half: the Manufacturer
 * Profiles editor that stores it (public/js/server-settings.js) and the asset
 * Custom MIB tab that paints it (public/js/assets.js).
 *
 * `warningAt` was stored for months and drawn by nothing, and it had no
 * direction — a battery warns LOW and a load warns HIGH, so a bare number
 * could not say which. What is pinned here:
 *  - `warningWhen` decides the side, absent meaning "above", and the threshold
 *    itself counts as breached;
 *  - the editor writes `warningWhen` only beside a threshold, and only when it
 *    is the non-default "below", so the stored JSON stays tight;
 *  - the gauge arc never sets SVG's large-arc flag: past the midpoint a 1 drew
 *    the long way round the circle (the loop an operator reported at 69 %);
 *  - the line widget's y-domain takes in the threshold so its dashed line is
 *    on the chart, while the min / max labels keep reporting the data.
 *
 * Both files are browser scripts with no module boundary, so the functions
 * under test are sliced out by name and eval'd — the approach of
 * tests/unit/assetAlertsTabDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { serverSettingsSource } from "./_serverSettingsSource.js";
import { assetsSource } from "./_assetsSource.js";

const g = globalThis as Record<string, any>;
const SPLIT = /\r?\n/;
const FILES = {
  assets: assetsSource().split(SPLIT),
  settings: serverSettingsSource().split(SPLIT),
};

function fnSrc(lines: string[], name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

/** A top-level `var NAME = …;` declaration, up to the line that ends it. */
function varSrc(lines: string[], name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`var ${name} `));
  if (start < 0) throw new Error(`var ${name} not found`);
  const end = lines.findIndex((l, i) => i >= start && /;\s*$/.test(l));
  return lines.slice(start, end + 1).join("\n");
}

beforeAll(() => {
  g.escapeHtml = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const src = [
    ...["_customWidgetWarning", "_customWidgetWarnCaption", "_renderCustomWidgetGauge", "_renderCustomWidgetLine", "_cwNiceScale", "_cwDurationScale",
      "_renderCustomWidgetScalarFallback", "_formatNumber",
      // The renderers draw through the widget display helper (°C/°F in the
      // install's unit, durations) — no PolarisTempUnit here, so plain numbers.
      "_cwDisplay", "_formatDuration", "_customWidgetWarningShown"].map((n) => fnSrc(FILES.assets, n)),
    ...["WIDGET_VALUE_FORMATS", "WIDGET_UNIT_HINT"].map((n) => varSrc(FILES.settings, n)),
    ...["_widgetFormField", "_widgetDisplayOptionsForm", "_widgetOptionsSummary", "_readWidgetDisplayOptions",
      "_widgetFormatSelectHTML"].map((n) => fnSrc(FILES.settings, n)),
  ].join("\n");
  // Indirect eval: the declarations land on globalThis, where the tests call them.
  (0, eval)(src);
  // The line widget draws its time axis through the shared helper and carries
  // the shared tooltip box; both are pinned by their own tests.
  g._chartXTicksSVG = () => '<g data-xticks="1"></g>';
  g.CHART_TOOLTIP_HTML = '<div class="chart-tooltip"></div>';
});

const gauge = (value: number, displayOptions: Record<string, unknown> = {}) =>
  g._renderCustomWidgetGauge({ latest: { value }, displayOptions }) as string;

describe("_customWidgetWarning", () => {
  it("warns at or above by default, and at or below when told", () => {
    expect(g._customWidgetWarning(90, { warningAt: 90 })).toEqual({ at: 90, below: false, breached: true });
    expect(g._customWidgetWarning(89, { warningAt: 90 }).breached).toBe(false);
    expect(g._customWidgetWarning(50, { warningAt: 50, warningWhen: "below" }).breached).toBe(true);
    expect(g._customWidgetWarning(51, { warningAt: 50, warningWhen: "below" }).breached).toBe(false);
  });

  it("is null when the widget sets no threshold", () => {
    expect(g._customWidgetWarning(5, {})).toBeNull();
    expect(g._customWidgetWarning(5, { warningAt: null })).toBeNull();
  });
});

describe("_renderCustomWidgetGauge", () => {
  it("never sets the large-arc flag, so a reading past half way stays on the gauge", () => {
    for (const v of [10, 50, 69, 99, 100]) {
      const d = new DOMParser().parseFromString(`<div>${gauge(v)}</div>`, "text/html")
        .querySelector(".custom-widget-gauge-arc")!.getAttribute("d")!;
      // "M x y A r r rotation large-arc sweep x y"
      expect(d.split(/\s+/)[6]).toBe("0");
    }
  });

  it("turns the arc and value amber past the threshold and says so", () => {
    const html = gauge(95, { unit: "%", warningAt: 90 });
    expect(html).toContain('stroke="var(--color-sev-warning)"');
    expect(html).toContain("Warning — at or above 90.0 %");
    expect(html).toContain("custom-widget-warn-tick");
  });

  it("stays the normal colour short of the threshold, naming the rule muted", () => {
    const html = gauge(100, { unit: "%", warningAt: 50, warningWhen: "below" });
    expect(html).toContain('stroke="#22d3ee"');
    expect(html).toContain("Warns at or below 50.0 %");
    expect(html).not.toContain("is-breached");
  });

  it("draws no tick for a threshold outside the gauge's range, and no caption without one", () => {
    expect(gauge(10, { warningAt: 500 })).not.toContain("custom-widget-warn-tick");
    expect(gauge(10)).not.toContain("custom-widget-warn");
  });
});

describe("_renderCustomWidgetLine", () => {
  const samples = (vals: number[]) => vals.map((v, i) => ({ timestamp: new Date(Date.UTC(2026, 9, 23, 12, i)).toISOString(), value: v }));

  it("draws the threshold inside the chart even when the data never reaches it", () => {
    const html = g._renderCustomWidgetLine({ samples: samples([6000, 6400, 6100]), displayOptions: { unit: "s", warningAt: 1800, warningWhen: "below" } });
    const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
    const y = Number(doc.querySelector(".custom-widget-warn-line")!.getAttribute("y1"));
    // Inside the plot area (padT 8 … padT + innerH 130 of the 150-high viewBox).
    expect(y).toBeGreaterThanOrEqual(8);
    expect(y).toBeLessThanOrEqual(130);
    // The labels report the data, not the stretched domain.
    expect(html).toContain("min 6000 s");
    expect(html).toContain("max 6400 s");
    expect(html).toContain("Warns at or below 1800 s");
  });

  it("flags the latest reading once it crosses", () => {
    const html = g._renderCustomWidgetLine({ samples: samples([2000, 1500]), displayOptions: { warningAt: 1800, warningWhen: "below" } });
    expect(html).toContain("Warning — at or below 1800");
  });

  const parse = (html: string) => new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const lineYs = (doc: Document) =>
    doc.querySelector("polyline")!.getAttribute("points")!.split(" ").map((p) => Number(p.split(",")[1]));

  it("starts a non-negative series at zero, so a 1 % wobble draws as one (APC PDU, 2026-11-11)", () => {
    const doc = parse(g._renderCustomWidgetLine({ samples: samples([0.75, 0.74, 0.75, 0.75, 0.74, 0.75]), displayOptions: { unit: "kW" } }));
    const ys = lineYs(doc);
    // It used to stretch 0.74..0.75 over the full plot height (~120 units).
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(3);
    const labels = Array.from(doc.querySelectorAll("text")).map((t) => t.textContent);
    expect(labels[0]).toBe("0.0 kW");
    expect(labels).toContain("0.8 kW");
  });

  it("labels the value axis with the unit, and draws the time axis and hover points", () => {
    const doc = parse(g._renderCustomWidgetLine({ samples: samples([3.7, 4.2, 3.9]), displayOptions: { unit: "A" } }));
    const labels = Array.from(doc.querySelectorAll("text")).map((t) => t.textContent!);
    expect(labels.every((l) => l.endsWith(" A"))).toBe(true);
    expect(doc.querySelector("[data-xticks]")).not.toBeNull();
    const hits = doc.querySelectorAll("circle.chart-hit");
    expect(hits.length).toBe(3);
    expect(hits[1].getAttribute("data-v")).toBe("4.2 A");
    expect(doc.querySelector(".cw-line .chart-tooltip")).not.toBeNull();
  });

  it("keeps the data's own floor when a reading is negative", () => {
    const doc = parse(g._renderCustomWidgetLine({ samples: samples([-12, -3, 4]), displayOptions: {} }));
    const labels = Array.from(doc.querySelectorAll("text")).map((t) => Number(t.textContent));
    expect(Math.min(...labels)).toBeLessThanOrEqual(-12);
    expect(Math.min(...labels)).toBeGreaterThan(-20);
  });

  it("labels a duration axis in whole time units", () => {
    const doc = parse(g._renderCustomWidgetLine({ samples: samples([5400, 900, 5300]), displayOptions: { format: "duration_s" } }));
    const labels = Array.from(doc.querySelectorAll("text")).map((t) => t.textContent!);
    // 0 … 1 h 30 m in 30-minute steps, never "1 h 6 m" / "33 m 20 s".
    expect(labels).toEqual(["0 s", "30 m 0 s", "1 h 0 m", "1 h 30 m"]);
  });

  it("steps a TimeTicks duration in whole units too", () => {
    const doc = parse(g._renderCustomWidgetLine({ samples: samples([360000, 540000]), displayOptions: { format: "duration_ticks" } }));
    const labels = Array.from(doc.querySelectorAll("text")).map((t) => t.textContent!);
    expect(labels[labels.length - 1]).toBe("1 h 30 m");
  });
});

describe("_cwNiceScale", () => {
  it("rounds to 1 / 2 / 2.5 / 5 × 10ⁿ steps and covers the data", () => {
    expect(g._cwNiceScale(0, 0.75)).toMatchObject({ lo: 0, hi: 0.8, step: 0.2 });
    expect(g._cwNiceScale(0, 100)).toMatchObject({ lo: 0, hi: 100, step: 25 });
    const s = g._cwNiceScale(-12, 4);
    expect(s.lo).toBeLessThanOrEqual(-12);
    expect(s.hi).toBeGreaterThanOrEqual(4);
  });

  it("never returns an empty range for a flat series", () => {
    const s = g._cwNiceScale(5, 5);
    expect(s.hi).toBeGreaterThan(s.lo);
    expect(s.ticks.length).toBeGreaterThan(1);
  });
});

describe("the profile editor's warning fields", () => {
  function formFor(widgetType: string, opts: Record<string, unknown>) {
    const scope = document.createElement("div");
    scope.innerHTML = g._widgetDisplayOptionsForm(widgetType, opts);
    return scope;
  }

  it("offers Warn when on gauge and line, preselecting the stored side", () => {
    for (const t of ["gauge", "line"]) {
      const sel = formFor(t, { warningAt: 20, warningWhen: "below" }).querySelector<HTMLSelectElement>(".mfg-widget-opt-warning-when")!;
      expect(sel.value).toBe("below");
    }
    expect(formFor("gauge", {}).querySelector<HTMLSelectElement>(".mfg-widget-opt-warning-when")!.value).toBe("above");
    expect(formFor("table", {}).querySelector(".mfg-widget-opt-warning-when")).toBeNull();
  });

  it("stores the direction only beside a threshold, and only when it is below", () => {
    const below = formFor("gauge", { warningAt: 20, warningWhen: "below" });
    expect(g._readWidgetDisplayOptions(below, "gauge")).toEqual({ warningAt: 20, warningWhen: "below" });

    const above = formFor("line", { unit: "%", warningAt: 90 });
    expect(g._readWidgetDisplayOptions(above, "line")).toEqual({ unit: "%", warningAt: 90 });

    const noThreshold = formFor("gauge", {});
    noThreshold.querySelector<HTMLSelectElement>(".mfg-widget-opt-warning-when")!.value = "below";
    expect(g._readWidgetDisplayOptions(noThreshold, "gauge")).toEqual({});
  });

  it("summarises the side on the widget card", () => {
    expect(g._widgetOptionsSummary({ widgetType: "gauge", displayOptions: { warningAt: 20, warningWhen: "below" } })).toBe("warn ≤ 20");
    expect(g._widgetOptionsSummary({ widgetType: "line", displayOptions: { unit: "%", warningAt: 90 } })).toBe("unit % · warn ≥ 90");
  });
});
