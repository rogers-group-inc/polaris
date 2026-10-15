/**
 * tests/unit/widgetTopNHeaderCounts.test.ts
 *
 * Unit tests for the header severity breakdown the shared top-N renderer stamps
 * (`PolarisTopN.renderRows` in public/js/widgets/_topnBar.js — Highest Avg CPU /
 * Memory, Slowest Response, Packet Loss, Highest Disk Usage, Highest
 * Temperature). Same harness as widgetHeaderPills.test.ts, with index.js eval'd
 * first so the renderer finds its PolarisWidgets helpers.
 *
 * The property under test is the 2026-08 convention: the pills count the rows
 * the widget ACTUALLY RENDERS — post minimum-severity filter, post row limit,
 * post red guarantee — so a 3-row panel never claims a 40-row breakdown. The
 * CSV export provider deliberately keeps the full matched set, which is why the
 * two can disagree.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface TopNRow { id?: string; hostname: string; value: number; alertSeverity?: string; alertRank?: number }
interface RenderOpts {
  unit?: string;
  thresholds?: Array<{ over: number; color: string }>;
  baseColor?: string;
  emptyText?: string;
  config?: { rowLimit?: number | null; minSeverity?: string; groupBy?: string };
  fillTo?: number;
}

let TopN: { renderRows: (el: unknown, rows: TopNRow[] | null, opts: RenderOpts) => void };
const g = globalThis as Record<string, unknown>;
let doc: Window["document"];

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8"));
  // _topnBar references `PolarisWidgets` bare (it runs as a browser global), so
  // hoist what index.js hung off `window` onto the eval scope's global.
  g.PolarisWidgets = (win as unknown as { PolarisWidgets: unknown }).PolarisWidgets;
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/_topnBar.js"), "utf8"));
  TopN = (win as unknown as { PolarisTopN: typeof TopN }).PolarisTopN;
});

/** A widget shell with the header the pills + export button land in. */
function mountWidget() {
  const article = doc.createElement("article");
  article.className = "dashboard-widget";
  article.setAttribute("data-type", "topCpu");
  article.innerHTML =
    '<div class="dashboard-widget-header"><h3 class="dashboard-widget-title">Highest Avg CPU</h3></div>' +
    '<div class="body"></div>';
  doc.body.appendChild(article);
  const el = article.querySelector(".body") as unknown as HTMLElement;
  const title = article.querySelector(".dashboard-widget-title") as unknown as HTMLElement;
  return {
    el,
    pills: () =>
      Array.from(title.querySelectorAll(".widget-header-count .widget-pill")).map((p: any) => ({
        text: p.textContent,
        cls: (p.getAttribute("class") || "").replace("widget-pill ", ""),
      })),
    host: () => title.querySelector(".widget-header-count"),
    rendered: () => el.querySelectorAll(".recent-item").length,
  };
}

// Severity-first is server-side ordering, mirrored client-side off alertRank —
// the two quiet rows carry the HIGHEST values, so they only survive a row limit
// via the red guarantee.
const rows = (): TopNRow[] => [
  { id: "c", hostname: "crit-node", value: 95, alertSeverity: "critical", alertRank: 5 },
  { id: "s", hostname: "serious-node", value: 50, alertSeverity: "serious", alertRank: 4 },
  { id: "w", hostname: "warned-node", value: 40, alertSeverity: "warning", alertRank: 3 },
  { id: "q1", hostname: "quiet-hot-1", value: 99 },
  { id: "q2", hostname: "quiet-hot-2", value: 98 },
];

describe("PolarisTopN.renderRows header severity counts", () => {
  it("counts only the rows the row limit actually renders", () => {
    const { el, pills, rendered } = mountWidget();
    TopN.renderRows(el, rows(), { unit: "%", config: { rowLimit: 2 } });
    expect(rendered()).toBe(2);
    // crit + serious are the two most severe; the warning row is clipped away and
    // must NOT appear in the breakdown.
    expect(pills()).toEqual([
      { text: "1", cls: "widget-pill-red" },
      { text: "1", cls: "widget-pill-orange" },
    ]);
  });

  it("counts red-guarantee rows that show past the limit, but never the quiet ones", () => {
    const { el, pills, rendered } = mountWidget();
    TopN.renderRows(el, rows(), {
      unit: "%",
      thresholds: [{ over: 90, color: "#ff1744" }],
      fillTo: 20,
      config: { rowLimit: 2 },
    });
    // 2 by limit (crit, serious) + the two ≥90% quiet rows kept by the guarantee.
    expect(rendered()).toBe(4);
    // Those extra rows carry no alert, so they stay out of the pills ("omit").
    expect(pills()).toEqual([
      { text: "1", cls: "widget-pill-red" },
      { text: "1", cls: "widget-pill-orange" },
    ]);
  });

  it("counts every rendered severity when nothing is clipped", () => {
    const { el, pills } = mountWidget();
    TopN.renderRows(el, rows(), { unit: "%", config: { rowLimit: null } });
    expect(pills()).toEqual([
      { text: "1", cls: "widget-pill-red" },
      { text: "1", cls: "widget-pill-orange" },
      { text: "1", cls: "widget-pill-amber" },
    ]);
  });

  it("respects the gear's minimum-severity filter", () => {
    const { el, pills, rendered } = mountWidget();
    TopN.renderRows(el, rows(), { unit: "%", config: { rowLimit: null, minSeverity: "serious" } });
    expect(rendered()).toBe(2);
    expect(pills()).toEqual([
      { text: "1", cls: "widget-pill-red" },
      { text: "1", cls: "widget-pill-orange" },
    ]);
  });

  it("shows no pills for an all-quiet set, and clears them when the set empties", () => {
    const { el, pills, host } = mountWidget();
    TopN.renderRows(el, rows(), { unit: "%", config: { rowLimit: null } });
    expect(host()).not.toBeNull();
    TopN.renderRows(el, [{ id: "q", hostname: "quiet", value: 12 }], { unit: "%", config: {} });
    expect(pills()).toEqual([]);
    expect(host()).toBeNull();
    TopN.renderRows(el, [], { unit: "%", config: {} });
    expect(host()).toBeNull();
  });

  it("counts the same rows when they're grouped by site", () => {
    const { el, pills } = mountWidget();
    const sited = rows().map((r, i) => ({ ...r, site: i % 2 ? "DC West" : "Plant A" }));
    TopN.renderRows(el, sited, { unit: "%", config: { rowLimit: 3, groupBy: "site" } });
    expect(pills()).toEqual([
      { text: "1", cls: "widget-pill-red" },
      { text: "1", cls: "widget-pill-orange" },
      { text: "1", cls: "widget-pill-amber" },
    ]);
  });
});

describe("PolarisTopN.renderRows value labels", () => {
  // The Highest Temperature widget passes "°F" when the install renders
  // Fahrenheit; a °C-only branch used to drop it through to the "%" fallback.
  it.each([
    ["°C", 84.4, "84 °C"],
    ["°F", 183.2, "183 °F"],
    ["ms", 12.6, "13 ms"],
    ["%", 42, "42%"],
  ])("renders unit %s value %s as %s", (unit, value, expected) => {
    const { el } = mountWidget();
    TopN.renderRows(el, [{ id: "a", hostname: "node", value }], { unit, config: {} });
    expect(el.textContent).toContain(expected);
    if (unit !== "%") expect(el.textContent).not.toMatch(/\d%/);
  });
});
