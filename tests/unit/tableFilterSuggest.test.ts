/**
 * tests/unit/tableFilterSuggest.test.ts — the suggestion list a text filter
 * gains from TableSF.setColumnSuggestions() (public/js/table-sf.js), used by
 * the Assets page's Tags column: focus lists every known value, typing narrows
 * the list, picking a row fills the box and commits it as an ordinary text
 * filter (so `!` exclude and saved presets are unaffected).
 *
 * Same eval-into-happy-dom approach as tests/unit/tableFilterPopover.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

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
        <th data-sf-key="tags" data-sf-type="array">Tags</th>
      </tr></thead>
      <tbody id="tb"></tbody>
    </table>`;
  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);
  changes = 0;
  sf = new (g as any).TableSF("tb", () => { changes++; });
}

function input(key: string): any {
  return doc.querySelector(`th[data-sf-key="${key}"] input.sf-filter`);
}
function list(key: string): any {
  return doc.querySelector(`th[data-sf-key="${key}"] .sf-suggest-popover`);
}
function rows(key: string): string[] {
  return Array.from(list(key).querySelectorAll(".sf-suggest-row")).map((r: any) => r.getAttribute("data-value"));
}
function isOpen(key: string): boolean {
  return !list(key).hasAttribute("hidden");
}
function fire(type: string, target: any, extra: Record<string, unknown> = {}) {
  const ev: any = new (win as any).Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, extra);
  target.dispatchEvent(ev);
  return ev;
}
function type(key: string, value: string) {
  const inp = input(key);
  inp.value = value;
  fire("input", inp);
}
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => { setup(); });

describe("text filter suggestions", () => {
  it("is inert on a column with no suggestion source", () => {
    input("name").focus();
    fire("focus", input("name"));
    expect(isOpen("name")).toBe(false);
  });

  it("lists every value on focus and narrows as the operator types", () => {
    sf.setColumnSuggestions("tags", ["prod", "lab", "production-db", "branch"]);
    fire("focus", input("tags"));
    expect(isOpen("tags")).toBe(true);
    expect(rows("tags")).toEqual(["prod", "lab", "production-db", "branch"]);

    type("tags", "PROD");
    expect(rows("tags")).toEqual(["prod", "production-db"]);

    type("tags", "zzz");
    expect(isOpen("tags")).toBe(false);
  });

  it("picking a row fills the box and commits the filter immediately", () => {
    sf.setColumnSuggestions("tags", ["prod", "lab"]);
    fire("focus", input("tags"));
    (list("tags").querySelector('[data-value="lab"]') as any).click();
    expect(input("tags").value).toBe("lab");
    expect(sf._filters.tags).toBe("lab");
    expect(changes).toBe(1);
    expect(isOpen("tags")).toBe(false);
  });

  it("keeps the ! exclude prefix when a row is picked", () => {
    sf.setColumnSuggestions("tags", ["prod", "lab"]);
    fire("focus", input("tags"));
    type("tags", "!la");
    expect(rows("tags")).toEqual(["lab"]);
    (list("tags").querySelector('[data-value="lab"]') as any).click();
    expect(input("tags").value).toBe("!lab");
    expect(sf._filters.tags).toBe("!lab");
  });

  it("reopening a box that holds a known value lists the whole set", () => {
    sf.setColumnSuggestions("tags", ["prod", "lab"]);
    input("tags").value = "prod";
    fire("focus", input("tags"));
    expect(rows("tags")).toEqual(["prod", "lab"]);
  });

  it("arrow keys move the highlight and Enter picks it", () => {
    sf.setColumnSuggestions("tags", ["a1", "b2", "c3"]);
    fire("focus", input("tags"));
    fire("keydown", input("tags"), { key: "ArrowDown" });
    fire("keydown", input("tags"), { key: "ArrowDown" });
    expect(list("tags").querySelector(".sf-suggest-active").getAttribute("data-value")).toBe("b2");
    fire("keydown", input("tags"), { key: "ArrowUp" });
    fire("keydown", input("tags"), { key: "ArrowUp" });
    expect(list("tags").querySelector(".sf-suggest-active").getAttribute("data-value")).toBe("c3");
    fire("keydown", input("tags"), { key: "Enter" });
    expect(input("tags").value).toBe("c3");
    expect(sf._filters.tags).toBe("c3");
  });

  it("hides while the column is in an is-empty / is-not-empty mode", () => {
    sf.setColumnSuggestions("tags", ["prod"]);
    const opRow: any = doc.querySelector('th[data-sf-key="tags"] .sf-op-row[data-op="empty"]');
    opRow.click();
    fire("focus", input("tags"));
    expect(isOpen("tags")).toBe(false);
  });

  it("a loader is fetched lazily on first open, deduped, and drawn when it lands", async () => {
    let calls = 0;
    sf.setColumnSuggestions("tags", async () => { calls++; return ["x", "y", "x", ""]; });
    expect(calls).toBe(0);
    input("tags").focus();
    fire("focus", input("tags"));
    await flush(); await flush();
    expect(calls).toBe(1);
    expect(rows("tags")).toEqual(["x", "y"]);

    // A second open inside the stale window reuses the cache.
    fire("blur", input("tags"));
    fire("focus", input("tags"));
    await flush();
    expect(calls).toBe(1);
    expect(rows("tags")).toEqual(["x", "y"]);
  });

  it("a failed load keeps the cached list", async () => {
    let fail = false;
    sf.setColumnSuggestions("tags", async () => { if (fail) throw new Error("boom"); return ["kept"]; });
    input("tags").focus();
    fire("focus", input("tags"));
    await flush(); await flush();
    fail = true;
    sf._suggest.tags.loadedAt = 0;
    fire("blur", input("tags"));
    fire("focus", input("tags"));
    await flush(); await flush();
    expect(rows("tags")).toEqual(["kept"]);
  });
});
