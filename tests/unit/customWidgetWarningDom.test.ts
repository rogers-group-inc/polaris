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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;
const SPLIT = /\r?\n/;
const FILES = {
  assets: readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(SPLIT),
  settings: readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8").split(SPLIT),
};

function fnSrc(lines: string[], name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

beforeAll(() => {
  g.escapeHtml = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const src = [
    ...["_customWidgetWarning", "_customWidgetWarnCaption", "_renderCustomWidgetGauge", "_renderCustomWidgetLine",
      "_renderCustomWidgetScalarFallback", "_formatNumber"].map((n) => fnSrc(FILES.assets, n)),
    ...["_widgetFormField", "_widgetDisplayOptionsForm", "_widgetOptionsSummary", "_readWidgetDisplayOptions"]
      .map((n) => fnSrc(FILES.settings, n)),
  ].join("\n");
  // Indirect eval: the declarations land on globalThis, where the tests call them.
  (0, eval)(src);
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
    expect(y).toBeGreaterThanOrEqual(4);
    expect(y).toBeLessThanOrEqual(86);
    // The labels report the data, not the stretched domain.
    expect(html).toContain("min 6000 s");
    expect(html).toContain("max 6400 s");
    expect(html).toContain("Warns at or below 1800 s");
  });

  it("flags the latest reading once it crosses", () => {
    const html = g._renderCustomWidgetLine({ samples: samples([2000, 1500]), displayOptions: { warningAt: 1800, warningWhen: "below" } });
    expect(html).toContain("Warning — at or below 1800");
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
