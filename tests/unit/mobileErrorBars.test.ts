/**
 * tests/unit/mobileErrorBars.test.ts — the phone's interface error charts
 * (business rule 159a, the approved Polaris Mobile canvas 2026-11-12).
 *
 * `PolarisCharts.barChart` (public/js/mobile/charts.js) is the phone half of
 * the desktop `_renderIfaceRateBars`. Pinned:
 *  - a segment takes the md-sev colour of the band its own automation puts it
 *    in, else the series colour; "informational" maps to md-sev-info;
 *  - each upward band is a dashed line plus a caption naming the series when
 *    there are two;
 *  - the axis reaches the lowest band on a quiet port;
 *  - an event draws a diamond in its band's colour;
 *  - nothing to draw says so.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { loadSharedModules } from "./_sharedModules.js";

type BarChart = (opts: Record<string, unknown>) => string;
let barChart: BarChart;
let formatRate: (v: number) => string;
const g = globalThis as Record<string, any>;

beforeAll(() => {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  loadSharedModules();
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/chart-severity.js"), "utf8"));
  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/mobile/charts.js"), "utf8"));
  const pc = (win as unknown as { PolarisCharts: { barChart: BarChart; formatRate: (v: number) => string } }).PolarisCharts;
  barChart = pc.barChart;
  formatRate = pc.formatRate;
});

const T0 = Date.parse("2026-11-12T14:00:00Z");
const iso = (m: number) => new Date(T0 + m * 60_000).toISOString();
const tier = (severity: string, threshold: number) => ({ severity, operator: ">", threshold, ruleId: "r", ruleName: "Port errors" });
const base = { from: T0, to: T0 + 10 * 60_000 };

describe("barChart", () => {
  it("colours a segment by its own automation's band, and leaves the other series alone", () => {
    const html = barChart({
      ...base,
      points: [
        { ts: iso(1), values: [0.1, 0.02] },
        { ts: iso(2), values: [0.8, 0] },
        { ts: iso(3), values: [2.5, 0.05] },
      ],
      series: [
        { color: "var(--md-primary)", tiers: [tier("warning", 0.5), tier("critical", 2)], short: "in" },
        { color: "var(--md-tertiary)", tiers: [], short: "out" },
      ],
      floorMax: 0.05,
    });
    expect(html).toContain('fill="var(--md-primary)"');
    expect(html).toContain('fill="var(--md-sev-warning)"');
    expect(html).toContain('fill="var(--md-sev-critical)"');
    expect(html).toContain('fill="var(--md-tertiary)"');
    expect(html).toContain("warning &gt; 0.5 (in)");
    expect(html).toContain("critical &gt; 2 (in)");
    expect((html.match(/stroke-dasharray="4,4"/g) ?? []).length).toBe(2);
  });

  it("reaches the lowest band on a quiet port", () => {
    const html = barChart({ ...base, points: [{ ts: iso(1), values: [0.01] }], series: [{ tiers: [tier("warning", 5)] }], floorMax: 0.05 });
    expect(html).toContain("warning &gt; 5");
    expect(html).toContain(">5.8<"); // 5 × 1.15, the axis top
  });

  it("maps informational to md-sev-info and draws an event diamond in its colour", () => {
    const html = barChart({
      ...base,
      points: [{ ts: iso(2), values: [3, 1], event: { count: 1, severity: "informational" } }],
      series: [{ tiers: [tier("informational", 1)] }, {}],
    });
    expect(html).toContain("var(--md-sev-info)");
    expect(html).toContain("rotate(45deg);background:var(--md-sev-info)");
  });

  it("says there is nothing to draw", () => {
    expect(barChart({ ...base, points: [{ ts: iso(1), values: [null, null] }], series: [{}, {}], empty: "Nothing yet" })).toContain("Nothing yet");
  });
});

describe("formatRate", () => {
  it("keeps the decimals a small rate needs", () => {
    expect(formatRate(0)).toBe("0");
    expect(formatRate(0.043)).toBe("0.04");
    expect(formatRate(1.46)).toBe("1.5");
    expect(formatRate(12.4)).toBe("12");
  });
});
