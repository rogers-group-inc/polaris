/**
 * tests/unit/tableSortApply.test.ts — TableSF.apply()'s typed sorting.
 *
 * Pins the per-type sort semantics across the decorate-sort-undecorate
 * rewrite (sort keys are now resolved once per row instead of re-parsed on
 * both sides of every comparison): ip sorts numerically via the BigInt
 * conversion (not lexicographically), date sorts by instant, number by
 * parseFloat, string case-insensitively through a dotted key path — and
 * apply() returns a new array rather than reordering its input.
 *
 * table-sf.js is a plain browser script (no module exports), so it's eval'd
 * into a happy-dom Window — same approach as tableFilterPopover.test.ts.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

const TABLE_HTML = `
  <table>
    <thead><tr>
      <th data-sf-key="ip" data-sf-type="ip">IP</th>
      <th data-sf-key="seen" data-sf-type="date">Seen</th>
      <th data-sf-key="count" data-sf-type="number">Count</th>
      <th data-sf-key="block.name" data-sf-type="string">Block</th>
    </tr></thead>
    <tbody id="tb"></tbody>
  </table>`;

function setup() {
  const win = new Window();
  g.window = win;
  g.document = win.document;
  g.MutationObserver = (win as any).MutationObserver;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  win.document.body.innerHTML = TABLE_HTML;
  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);
  return new (g as any).TableSF("tb", () => {});
}

const rows = [
  { ip: "10.0.0.10",   seen: "2026-03-01T00:00:00Z", count: 2,  block: { name: "beta" } },
  { ip: "10.0.0.9",    seen: "2026-01-01T00:00:00Z", count: 10, block: { name: "Alpha" } },
  { ip: "2001:db8::1", seen: "2026-02-01T00:00:00Z", count: 1,  block: { name: "gamma" } },
];

describe("TableSF.apply typed sorting", () => {
  it("ip sorts numerically — .9 before .10, v6 above all v4", () => {
    const sf = setup();
    sf.setPrefs({ sortKey: "ip", sortDir: "asc" });
    expect(sf.apply(rows).map((r: any) => r.ip)).toEqual(["10.0.0.9", "10.0.0.10", "2001:db8::1"]);
  });

  it("date sorts by instant and number by parseFloat, honoring direction", () => {
    const sf = setup();
    sf.setPrefs({ sortKey: "seen", sortDir: "desc" });
    expect(sf.apply(rows).map((r: any) => r.count)).toEqual([2, 1, 10]);
    sf.setPrefs({ sortKey: "count", sortDir: "asc" });
    expect(sf.apply(rows).map((r: any) => r.count)).toEqual([1, 2, 10]);
  });

  it("number and date sorts put blank values last in both directions and fully order the rest", () => {
    const sf = setup();
    const mixed = [
      { count: 40 }, { count: null }, { count: 5 }, { count: "" }, { count: 1800 },
      { count: undefined }, { count: 26 }, { count: null }, { count: 7 },
    ];
    sf.setPrefs({ sortKey: "count", sortDir: "desc" });
    expect(sf.apply(mixed).map((r: any) => r.count).slice(0, 5)).toEqual([1800, 40, 26, 7, 5]);
    sf.setPrefs({ sortKey: "count", sortDir: "asc" });
    const asc = sf.apply(mixed).map((r: any) => r.count);
    expect(asc.slice(0, 5)).toEqual([5, 7, 26, 40, 1800]);
    expect(asc.slice(5).every((v: unknown) => v == null || v === "")).toBe(true);

    sf.setPrefs({ sortKey: "seen", sortDir: "asc" });
    const dated = [{ seen: null }, { seen: "2026-02-01T00:00:00Z" }, { seen: "" }, { seen: "2026-01-01T00:00:00Z" }];
    expect(sf.apply(dated).map((r: any) => r.seen).slice(0, 2)).toEqual(["2026-01-01T00:00:00Z", "2026-02-01T00:00:00Z"]);
  });

  it("string sort walks dotted key paths case-insensitively and never reorders its input", () => {
    const sf = setup();
    sf.setPrefs({ sortKey: "block.name", sortDir: "asc" });
    const input = rows.slice();
    expect(sf.apply(input).map((r: any) => r.block.name)).toEqual(["Alpha", "beta", "gamma"]);
    expect(input).toEqual(rows);
  });
});
