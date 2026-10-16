/**
 * tests/unit/tableFilterPick.test.ts — the pick filter (th data-sf-filter="pick")
 * in public/js/table-sf.js, used by the Assets page's Tags column: the box is a
 * button, clicking it opens a checkbox menu of the setColumnSuggestions values,
 * ticks are a draft until OK, Cancel throws them away, and the button reads
 * "All" / the one value / "N selected".
 *
 * Same eval-into-happy-dom approach as tests/unit/tableFilterSuggest.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { sanitizeFilterState } from "../../src/services/savedFilterService.js";

const g = globalThis as Record<string, any>;

let win: Window;
let doc: Window["document"];
let sf: any;
let changes: number;

function setup() {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.MutationObserver = (win as any).MutationObserver;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  doc.body.innerHTML = `
    <table>
      <thead><tr>
        <th data-sf-key="name" data-sf-type="string">Name</th>
        <th data-sf-key="tags" data-sf-type="array" data-sf-filter="pick" data-sf-pick-none="(No tags)">Tags</th>
      </tr></thead>
      <tbody id="tb"></tbody>
    </table>`;
  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);
  changes = 0;
  sf = new (g as any).TableSF("tb", () => { changes++; });
  sf.setColumnSuggestions("tags", ["prod", "lab", "dc,1"]);
}

const th = () => doc.querySelector('th[data-sf-key="tags"]') as any;
const button = () => th().querySelector(".sf-pick-button") as any;
const pop = () => th().querySelector(".sf-pick-popover") as any;
const isOpen = () => !pop().hasAttribute("hidden");
const box = (v: string) => pop().querySelector(`.sf-pick-list input[value="${v}"]`) as any;
const noneBox = () => pop().querySelector("input[data-pick-none]") as any;
const listed = () =>
  Array.from(pop().querySelectorAll(".sf-pick-list input[value]")).map((i: any) => i.value);

function tick(cb: any, on = true) {
  cb.checked = on;
  cb.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
}
const click = (sel: string) => (pop().querySelector(sel) as any).click();

beforeEach(() => { setup(); });

describe("pick filter", () => {
  it("renders a button reading All, not a text box", () => {
    expect(th().querySelector("input.sf-filter:not(.sf-pick-search)")).toBeNull();
    expect(button().textContent).toBe("All");
    expect(isOpen()).toBe(false);
  });

  it("clicking the button opens a checkbox list of every value", () => {
    button().click();
    expect(isOpen()).toBe(true);
    expect(listed()).toEqual(["prod", "lab", "dc,1"]);
    expect(noneBox()).not.toBeNull();
  });

  it("ticks are a draft: nothing filters until OK", () => {
    button().click();
    tick(box("prod"));
    tick(box("lab"));
    expect(sf._filters.tags).toBeUndefined();
    expect(changes).toBe(0);
    expect(pop().querySelector(".sf-pick-count").textContent).toBe("2 selected");
    click(".sf-pick-ok");
    expect(sf._filters.tags).toEqual({ op: "pick", mode: "any", values: ["prod", "lab"], none: false });
    expect(changes).toBe(1);
    expect(isOpen()).toBe(false);
    expect(button().textContent).toBe("2 selected");
  });

  it("one pick reads as its own name", () => {
    button().click();
    tick(box("dc,1"));
    click(".sf-pick-ok");
    expect(button().textContent).toBe("dc,1");
  });

  it("Cancel throws the draft away and the next open shows the committed set", () => {
    button().click();
    tick(box("prod"));
    click(".sf-pick-ok");
    button().click();
    tick(box("lab"));
    click(".sf-pick-cancel");
    expect(sf._filters.tags.values).toEqual(["prod"]);
    expect(changes).toBe(1);
    button().click();
    expect(box("prod").checked).toBe(true);
    expect(box("lab").checked).toBe(false);
  });

  it("search narrows the list without losing ticks; Enter commits", () => {
    button().click();
    tick(box("prod"));
    const s = pop().querySelector(".sf-pick-search");
    s.value = "LA";
    s.dispatchEvent(new (win as any).Event("input", { bubbles: true }));
    expect(listed()).toEqual(["lab"]);
    tick(box("lab"));
    s.dispatchEvent(Object.assign(new (win as any).Event("keydown", { bubbles: true }), { key: "Enter" }));
    expect(sf._filters.tags.values).toEqual(["prod", "lab"]);
  });

  it("All mode is stored and disables the (No tags) row", () => {
    button().click();
    tick(noneBox());
    tick(box("prod"));
    click('.sf-pick-mode-btn[data-mode="all"]');
    expect(noneBox().disabled).toBe(true);
    click(".sf-pick-ok");
    expect(sf._filters.tags).toEqual({ op: "pick", mode: "all", values: ["prod"], none: false });
  });

  it("(No tags) alone is a filter", () => {
    button().click();
    tick(noneBox());
    click(".sf-pick-ok");
    expect(sf._filters.tags).toEqual({ op: "pick", mode: "any", values: [], none: true });
    expect(button().textContent).toBe("(No tags)");
  });

  it("Clear then OK removes the filter", () => {
    button().click();
    tick(box("prod"));
    click(".sf-pick-ok");
    button().click();
    click(".sf-pick-clear");
    click(".sf-pick-ok");
    expect(sf._filters.tags).toBeUndefined();
    expect(button().textContent).toBe("All");
  });

  it("a ticked value the source no longer lists stays listed and ticked", () => {
    sf._filters.tags = { op: "pick", mode: "any", values: ["gone"], none: false };
    sf.restoreFilterUI();
    button().click();
    expect(listed()).toContain("gone");
    expect(box("gone").checked).toBe(true);
  });

  it("restore keeps a legacy text preset (still applied) and describes it", () => {
    sf._filters.tags = "!prod";
    sf.restoreFilterUI();
    expect(sf._filters.tags).toBe("!prod");
    expect(button().textContent).toContain("not");
    expect(button().textContent).toContain("prod");
  });

  it("restore drops an empty pick and an array", () => {
    sf._filters.tags = { op: "pick", mode: "any", values: [], none: false };
    sf.restoreFilterUI();
    expect(sf._filters.tags).toBeUndefined();
    sf._filters.tags = ["prod"];
    sf.restoreFilterUI();
    expect(sf._filters.tags).toBeUndefined();
  });

  it("a page opener replaces the built-in menu and applies what it returns", () => {
    const seen: any[] = [];
    let finish: any = null;
    sf.setPickOpener("tags", (cur: any, done: any) => { seen.push(cur); finish = done; });
    button().click();
    expect(isOpen()).toBe(false);
    expect(seen).toEqual([null]);
    expect(changes).toBe(0);
    finish({ op: "pick", mode: "any", values: ["prod", "lab"], none: false });
    expect(sf._filters.tags).toEqual({ op: "pick", mode: "any", values: ["prod", "lab"], none: false });
    expect(button().textContent).toBe("2 selected");
    expect(changes).toBe(1);

    // The opener gets a COPY of the stored pick; null (or an empty pick) clears.
    button().click();
    expect(seen[1]).toEqual(sf._filters.tags);
    expect(seen[1]).not.toBe(sf._filters.tags);
    finish({ op: "pick", mode: "any", values: [], none: false });
    expect(sf._filters.tags).toBeUndefined();
    expect(button().textContent).toBe("All");

    sf.setPickOpener("tags", null);
    button().click();
    expect(isOpen()).toBe(true);
  });

  it("saved view tabs / presets accept the pick shape (the server sanitizer)", () => {
    const s = sanitizeFilterState({
      sfFilters: { tags: { op: "pick", mode: "all", values: ["prod", "dc,1"], none: false, junk: 1 } },
    });
    expect(s.sfFilters.tags).toEqual({ op: "pick", mode: "all", values: ["prod", "dc,1"], none: false });
    expect((sanitizeFilterState({ sfFilters: { tags: { op: "pick", mode: "x", values: [] } } }).sfFilters.tags as any).mode)
      .toBe("any");
    expect(() => sanitizeFilterState({ sfFilters: { tags: { op: "pick", values: "prod" } } })).toThrow();
    expect(() => sanitizeFilterState({ sfFilters: { tags: { op: "pick", values: [5] } } })).toThrow();
  });

  it("apply() matches any / all / untagged exactly", () => {
    const rows = [
      { name: "a", tags: ["prod", "lab"] },
      { name: "b", tags: ["prod"] },
      { name: "c", tags: [] },
      { name: "d", tags: ["production"] },
    ];
    const names = () => sf.apply(rows).map((r: any) => r.name);
    sf._filters.tags = { op: "pick", mode: "any", values: ["prod"], none: false };
    expect(names()).toEqual(["a", "b"]);
    sf._filters.tags = { op: "pick", mode: "all", values: ["prod", "lab"], none: false };
    expect(names()).toEqual(["a"]);
    sf._filters.tags = { op: "pick", mode: "any", values: ["lab"], none: true };
    expect(names()).toEqual(["a", "c"]);
    sf._filters.tags = { op: "pick", mode: "any", values: [], none: true };
    expect(names()).toEqual(["c"]);
  });
});
