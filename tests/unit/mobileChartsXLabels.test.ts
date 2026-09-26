/**
 * tests/unit/mobileChartsXLabels.test.ts — pins the x-axis end labels of the
 * mobile SPA's chart helper (`public/js/mobile/charts.js`).
 *
 * A 24-hour window used to label both ends with a bare HH:MM, so a phone
 * showed "14:05 … 14:05" with no way to tell yesterday from today. A sub-day
 * window that crosses midnight now carries the date on both labels; one that
 * stays inside a single calendar day keeps the compact time-only form.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

type Charts = { lineChart: (opts: Record<string, unknown>) => string };
let charts: Charts;

beforeAll(() => {
  const win = new Window();
  const g = globalThis as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  const src = readFileSync(resolve(__dirname, "../../public/js/mobile/charts.js"), "utf8");
  (0, eval)(src);
  charts = (win as unknown as { PolarisCharts: Charts }).PolarisCharts;
});

function xTicks(fromMs: number, toMs: number): string[] {
  const html = charts.lineChart({ series: [{ values: [{ ts: fromMs, v: 1 }, { ts: toMs, v: 2 }] }] });
  return [...html.matchAll(/<span class="chart-x-tick">([^<]*)<\/span>/g)].map((m) => m[1]);
}

const dateOnly = (ms: number) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });

describe("mobile chart x-axis labels", () => {
  it("a 24h window labels both ends with their date", () => {
    const end = new Date(2026, 8, 26, 14, 5).getTime();
    const start = end - 24 * 3600_000;
    const [left, right] = xTicks(start, end);
    expect(left).toContain(dateOnly(start));
    expect(right).toContain(dateOnly(end));
    expect(left).not.toBe(right);
  });

  it("a short window inside one day stays time-only", () => {
    const start = new Date(2026, 8, 26, 9, 0).getTime();
    const end = new Date(2026, 8, 26, 13, 0).getTime();
    const [left, right] = xTicks(start, end);
    expect(left).not.toContain(dateOnly(start));
    expect(right).not.toContain(dateOnly(end));
  });

  it("a short window across midnight carries the date", () => {
    const start = new Date(2026, 8, 25, 22, 0).getTime();
    const end = new Date(2026, 8, 26, 2, 0).getTime();
    const [left, right] = xTicks(start, end);
    expect(left).toContain(dateOnly(start));
    expect(right).toContain(dateOnly(end));
  });
});
