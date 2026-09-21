/**
 * tests/unit/sdwanMembersShotDom.test.ts — the SD-WAN Members table's up/down
 * signals have to survive the table screenshot (public/js/assets.js).
 *
 * The per-table camera button rasterizes the live table now
 * (tests/unit/tableShotCaptureDom.test.ts), but it still falls back to a CANVAS
 * RE-DRAW of each cell's flattened text (_shotCellText) painted in one resolved
 * color (_shotCellColor) when html-to-image didn't load or its rasterization
 * failed. In that composer a cell whose entire meaning is a color with no text
 * in it comes out BLANK while looking correct on screen, which is exactly what
 * happened here: the member status dot and the whole Health Check Status strip
 * vanished from every screenshot of this table. This file pins the stand-ins
 * that keep the fallback honest.
 *
 * What's pinned:
 *  - every column that means "up or down" flattens to a glyph, so the state
 *    reads without color (a screenshot gets pasted into tickets and printed);
 *  - the strip states the summary its 48 segments add up to, rather than nothing;
 *  - the Health Checks cell declares NO cell color — its chips disagree with
 *    each other, and one color for the cell would assert one of them fleet-wide.
 *
 * assets.js has no module boundary, so the functions under test are sliced out
 * by name and eval'd into a happy-dom Window — the harness of
 * tests/unit/assetInterfacesTableDom.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

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
  "_sdwanStatusStripHTML",
  "_sdwanMembersTableHTML",
  "_shotCellText",
  "_shotCellColor",
  "_shotVisible",
];

const UP = "#2a9d8f";
const DOWN = "#d32f2f";

/** Two members: wan1 up in both health-checks, wan2 down in one of them. */
function makeMembers() {
  const ts = "2026-08-20T12:00:00.000Z";
  return [
    {
      link: "wan1", zone: "Underlay", state: "up", ip: "63.135.181.113",
      linkSpeedBps: 1e9, linkUp: true, txBytes: 1200000, rxBytes: 112900,
      healthChecks: [
        { healthCheck: "Microsoft", state: "up", latencyMs: 56.321, jitterMs: 0.1, packetLoss: 0 },
        { healthCheck: "Primary WAN", state: "up", latencyMs: 28.49, jitterMs: 0.2, packetLoss: 0 },
      ],
      recent: [{ timestamp: ts, up: true }, { timestamp: ts, up: true }, { timestamp: ts, up: true }],
    },
    {
      link: "Overlay-1", zone: "Overlay", state: "down", ip: null,
      linkSpeedBps: null, linkUp: null, txBytes: null, rxBytes: null,
      healthChecks: [
        { healthCheck: "Metrocenter", state: "down", latencyMs: null, jitterMs: null, packetLoss: null },
        { healthCheck: "Microsoft", state: "up", latencyMs: 71.53, jitterMs: 0.3, packetLoss: 1 },
      ],
      recent: [{ timestamp: ts, up: false }, { timestamp: ts, up: true }, { timestamp: ts, up: true },
               { timestamp: ts, up: true }],
    },
  ];
}

let win: Window;
let doc: Window["document"];

beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.MONITOR_STATE_COLORS = { up: UP, down: DOWN, warning: "#f4a261" };
  g._fmtTooltipTs = (t: unknown) => String(t);
  g._fmtBytes = (b: number) => `${b}B`;
  g._fmtBitsPerSec = (b: number) => `${b}bps`;
  for (const name of FN_NAMES) (0, eval)(fnSrc(name));

  doc.body.innerHTML = g._sdwanMembersTableHTML(makeMembers());
});

/** Data rows only — the zone grouping headers span all six columns. */
const dataRows = () =>
  Array.from(doc.querySelectorAll("#sdwan-members-table tbody > tr")).filter(
    (tr) => tr.querySelectorAll(":scope > td").length > 1,
  );
const rowFor = (link: string) =>
  dataRows().find((tr) => (tr.textContent || "").includes(link))!;
const cell = (link: string, colId: string) =>
  rowFor(link).querySelector(`td[data-col-id="${colId}"]`)!;
const shotText = (link: string, colId: string) => g._shotCellText(cell(link, colId));
const shotColor = (link: string, colId: string) =>
  g._shotCellColor(cell(link, colId), win as any, "rgb(0, 0, 0)");

describe("SD-WAN Members table — screenshot legibility", () => {
  it("flattens the member's status dot to an up/down glyph", () => {
    expect(shotText("wan1", "member")).toContain("▲");
    expect(shotText("wan1", "member")).toContain("wan1");
    expect(shotText("Overlay-1", "member")).toContain("▼");
  });

  it("paints the member cell in its state color", () => {
    expect(shotColor("wan1", "member")).toBe(UP);
    expect(shotColor("Overlay-1", "member")).toBe(DOWN);
  });

  it("replaces the color-only status strip with the summary it adds up to", () => {
    // Was empty: 48 background-colored spans hold no text at all.
    expect(shotText("wan1", "hcstatus")).toBe("▲ 3/3 up");
    expect(shotText("Overlay-1", "hcstatus")).toBe("▼ 3/4 up");
    expect(shotColor("wan1", "hcstatus")).toBe(UP);
    expect(shotColor("Overlay-1", "hcstatus")).toBe(DOWN);
  });

  it("keeps the '—' fallback when no scrapes are in the window", () => {
    const span = doc.createElement("div");
    span.innerHTML = g._sdwanStatusStripHTML([]);
    expect(g._shotCellText(span)).toBe("—");
  });

  it("gives each health-check chip its own state glyph", () => {
    const mixed = shotText("Overlay-1", "checks");
    expect(mixed).toContain("▼ Metrocenter");
    expect(mixed).toContain("▲ Microsoft 71.53ms");
    expect(shotText("wan1", "checks")).toContain("▲ Microsoft 56.32ms");
  });

  it("declares no single color for a Health Checks cell whose chips disagree", () => {
    // One resolved color per cell, so an up chip and a down chip in the same
    // cell must not let either state speak for the other.
    expect(cell("Overlay-1", "checks").querySelector("[data-shot-color]")).toBeNull();
  });

  it("still carries the link state, which was already textual", () => {
    expect(shotText("wan1", "link")).toContain("▲ 1000000000bps");
    expect(shotText("Overlay-1", "link")).toBe("—");
  });
});
