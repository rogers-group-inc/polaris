/**
 * tests/unit/subnetUtilCell.test.ts — the Utilization cell on IPAM → Networks
 * and on the block drill-in panel: how full a network is, as the canonical
 * utilization bar plus a figure.
 *
 * The colour bands are asserted against the Block utilization dashboard widget
 * rather than restated: a network that reads amber on the dashboard and blue in
 * the list reads as a bug in one of the two, and the only thing keeping them
 * together is that both sides are pinned here.
 *
 * `subnetUtilCellHTML` is sliced out of app.js by name — the browser scripts
 * have no module boundary (the approach of tests/unit/assetAlertIndicator.test.ts).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const appLines = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").split(/\r?\n/);
const widgetSrc = readFileSync(resolve(__dirname, "../../public/js/widgets/blockUtilization.js"), "utf8");

function fnSrc(name: string): string {
  const start = appLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`app.js: function ${name} not found`);
  const end = appLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`app.js: no end of function ${name}`);
  return appLines.slice(start, end + 1).join("\n");
}

const CLIENT_FNS = ["subnetUtilBarColor", "subnetUtilCellHTML"];

beforeAll(() => {
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const src = CLIENT_FNS.map(fnSrc).join("\n") + "\n" +
    CLIENT_FNS.map((n) => `globalThis.${n} = ${n};`).join("\n");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(src)();
});

/** Render one cell and hand back its parts. */
function cell(pct: number | null, used: number | null, usable: number | null) {
  document.body.innerHTML = "<td>" + g.subnetUtilCellHTML(pct, used, usable) + "</td>";
  const row = document.querySelector(".util-row") as HTMLElement | null;
  const fill = document.querySelector(".util-bar-fill") as HTMLElement | null;
  return {
    row,
    fill,
    label: row ? (row.lastElementChild as HTMLElement).textContent : null,
    title: row ? row.getAttribute("title") : null,
    text: document.body.textContent,
  };
}

describe("subnetUtilCellHTML", () => {
  it("draws the canonical bar with the figure beside it", () => {
    const c = cell(78.7, 200, 254);
    expect(c.fill!.style.width).toBe("78.7%");
    expect(c.label).toBe("79%");
    // The rounded label fits the narrow column; the exact figure rides the
    // tooltip so nothing is lost.
    expect(c.title).toBe("200 of 254 usable addresses reserved (78.7%)");
  });

  it("says <1% rather than 0% for a network that has something in it", () => {
    // One address on a /24 is 0.4%. "0%" beside a bar claims the network is
    // empty, which is the very thing the em-dash rule below exists to avoid.
    const c = cell(0.4, 1, 254);
    expect(c.label).toBe("<1%");
    expect(c.fill).not.toBeNull();
  });

  it("shows an em dash and NO bar where there is no denominator", () => {
    // IPv6, or a CIDR the server could not measure. A 0%-wide bar would be a
    // positive claim that the network is empty.
    const c = cell(null, 3, null);
    expect(c.row).toBeNull();
    expect(c.fill).toBeNull();
    expect(c.text).toContain("—");
  });

  it("clamps the bar but not the tooltip when the numerator overruns", () => {
    // A reservation sitting on the network or broadcast address can push the
    // count past the usable host count.
    const c = cell(101.2, 257, 254);
    expect(c.fill!.style.width).toBe("100%");
    expect(c.title).toContain("101.2%");
  });

  it("takes the Block utilization widget's colour bands verbatim", () => {
    // Pinned against the widget's own source: change one, change both.
    const widgetBands = widgetSrc.match(/pct > 75 \? "(#[0-9a-f]{6})" : pct > 50 \? "(#[0-9a-f]{6})" : "(#[0-9a-f]{6})"/i);
    expect(widgetBands, "blockUtilization.js no longer states its bands the expected way").not.toBeNull();
    const [, red, amber, base] = widgetBands!;
    expect(g.subnetUtilBarColor(90)).toBe(red);
    expect(g.subnetUtilBarColor(76)).toBe(red);
    expect(g.subnetUtilBarColor(75)).toBe(amber);
    expect(g.subnetUtilBarColor(51)).toBe(amber);
    expect(g.subnetUtilBarColor(50)).toBe(base);
    expect(g.subnetUtilBarColor(0)).toBe(base);
  });
});
