/**
 * tests/unit/rowSelectDom.test.ts — row selection by click, drag, Shift+click
 * and Ctrl+click (public/js/app.js → "Row selection").
 *
 * The list tables no longer draw a checkbox column: rows are picked the way a
 * file explorer picks files, and the controller drives the (hidden) row
 * checkboxes, firing a bubbling `change` for each one it flips so every page's
 * own selection logic keeps working. What is pinned here is that contract —
 * which boxes end up checked, that each flip announces itself, and that a
 * replacing gesture tells the page to drop off-page picks.
 *
 * app.js is a classic browser script, eval'd into a happy-dom Window. Auto-
 * scroll is layout-driven and only checkable in a real browser.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, unknown>;
const APP_SRC = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8");

let win: InstanceType<typeof Window>;
let doc: Window["document"];
let changes: string[];
let clears: number;

const ROWS = ["a", "b", "c", "d", "e"];

beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  g.fetch = () => Promise.reject(new Error("no network in this test"));
  g.showToast = () => {};
  g.api = {};
  g.escapeHtml = (s: unknown) => String(s ?? "");

  doc.body.innerHTML =
    '<p id="outside">page text</p>' +
    '<div class="bulk-bar"><button id="bulk-act">Act on selected</button></div>' +
    '<div id="modal-overlay"><button id="modal-btn">Confirm</button></div>' +
    '<table><tbody id="tb">' +
    ROWS.map((id) =>
      '<tr id="r-' + id + '"><td class="cb-col"><input type="checkbox" data-id="' + id + '"></td>' +
      '<td class="name"><button class="row-menu-trigger">' + id + '</button></td>' +
      '<td class="plain">cell ' + id + "</td></tr>").join("") +
    '<tr id="r-x"><td class="cb-col"></td><td class="plain">not selectable</td></tr>' +
    "</tbody></table>";
  try { (0, eval)(APP_SRC); } catch (_e) { /* app.js boot wiring touches page-specific DOM */ }

  changes = [];
  clears = 0;
  doc.getElementById("tb")!.addEventListener("change", (e: any) => changes.push(e.target.getAttribute("data-id")));
  doc.getElementById("tb")!.addEventListener("polaris:rowselect-clear", () => { clears++; });
});

const cell = (id: string) => doc.querySelector("#r-" + id + " td.plain") as any;
function mouse(type: string, el: any, opts: Record<string, unknown> = {}) {
  el.dispatchEvent(new (win as any).MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...opts }));
}
function press(id: string, opts: Record<string, unknown> = {}) {
  mouse("mousedown", cell(id), { buttons: 1, ...opts });
}
function release(id: string) { mouse("mouseup", cell(id)); }
function clickRow(id: string, opts: Record<string, unknown> = {}) { press(id, opts); release(id); }
function moveTo(id: string, opts: Record<string, unknown> = {}) { mouse("mousemove", cell(id), { buttons: 1, ...opts }); }
function selected() {
  return ROWS.filter((id) => (doc.querySelector('#r-' + id + ' input') as any).checked);
}

describe("row selection", () => {
  it("a click selects that row only", () => {
    clickRow("b");
    expect(selected()).toEqual(["b"]);
    expect(changes).toEqual(["b"]);
    expect(doc.getElementById("r-b")!.classList.contains("selected")).toBe(true);
    clickRow("d");
    expect(selected()).toEqual(["d"]);
  });

  it("clicking the only selected row again clears it", () => {
    clickRow("b");
    clickRow("b");
    expect(selected()).toEqual([]);
  });

  it("Ctrl+click toggles a row and keeps the rest", () => {
    clickRow("a");
    clickRow("c", { ctrlKey: true });
    expect(selected()).toEqual(["a", "c"]);
    clickRow("a", { ctrlKey: true });
    expect(selected()).toEqual(["c"]);
  });

  it("⌘+click works like Ctrl+click", () => {
    clickRow("a");
    clickRow("e", { metaKey: true });
    expect(selected()).toEqual(["a", "e"]);
  });

  it("Shift+click selects the range from the last clicked row", () => {
    clickRow("b");
    clickRow("d", { shiftKey: true });
    expect(selected()).toEqual(["b", "c", "d"]);
    // The anchor stays put: a second Shift+click re-ranges from b.
    clickRow("a", { shiftKey: true });
    expect(selected()).toEqual(["a", "b"]);
  });

  it("Ctrl+Shift+click adds the range to what is already selected", () => {
    clickRow("a");
    clickRow("c", { ctrlKey: true });
    clickRow("e", { ctrlKey: true, shiftKey: true });
    expect(selected()).toEqual(["a", "c", "d", "e"]);
  });

  it("dragging across rows selects the range, replacing the selection", () => {
    clickRow("e");
    press("b");
    moveTo("c");
    moveTo("d");
    expect(selected()).toEqual(["b", "c", "d"]);
    moveTo("c"); // dragging back shrinks the range
    release("c");
    expect(selected()).toEqual(["b", "c"]);
    expect(clears).toBeGreaterThan(0);
  });

  it("Ctrl+drag adds the dragged range to the existing selection", () => {
    clickRow("a");
    press("c", { ctrlKey: true });
    moveTo("d", { ctrlKey: true });
    release("d");
    expect(selected()).toEqual(["a", "c", "d"]);
  });

  it("does not start a selection from a button, link or menu trigger", () => {
    const btn = doc.querySelector("#r-b .row-menu-trigger") as any;
    mouse("mousedown", btn, { buttons: 1 });
    mouse("mouseup", btn);
    expect(selected()).toEqual([]);
  });

  it("ignores rows with no checkbox", () => {
    clickRow("x");
    expect(selected()).toEqual([]);
  });

  it("announces a replacing click so the page can drop off-page picks", () => {
    clickRow("a");
    expect(clears).toBe(1);
    clickRow("b", { ctrlKey: true });
    expect(clears).toBe(1); // additive: nothing to drop
  });

  it("clicking off the table clears the selection", () => {
    clickRow("a");
    clickRow("c", { ctrlKey: true });
    const before = clears;
    mouse("mousedown", doc.getElementById("outside"));
    expect(selected()).toEqual([]);
    expect(clears).toBeGreaterThan(before); // off-page picks go too
  });

  it("keeps the selection for a click on the bulk bar or a dialog over the page", () => {
    clickRow("a");
    clickRow("b", { ctrlKey: true });
    mouse("mousedown", doc.getElementById("bulk-act"));
    mouse("mousedown", doc.getElementById("modal-btn"));
    expect(selected()).toEqual(["a", "b"]);
  });

  it("keeps the selection for a click inside the table that is not on a row", () => {
    clickRow("a");
    mouse("mousedown", cell("x"));
    expect(selected()).toEqual(["a"]);
  });

  it("clears a table inside a dialog when the click lands elsewhere in that dialog", () => {
    doc.getElementById("modal-overlay")!.appendChild(doc.querySelector("table")!);
    clickRow("a");
    mouse("mousedown", doc.getElementById("modal-btn"));
    expect(selected()).toEqual([]);
  });

  it("Ctrl+A selects every row of the table last clicked", () => {
    // happy-dom gives every element a null offsetParent; the real check is a
    // visibility guard, so stand in a parent here.
    Object.defineProperty(doc.getElementById("tb"), "offsetParent", { get: () => doc.body });
    clickRow("a");
    doc.body.dispatchEvent(new (win as any).KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(selected()).toEqual(ROWS);
  });

  it("Ctrl+A with no table clicked yet selects the table that holds the selection", () => {
    Object.defineProperty(doc.getElementById("tb"), "offsetParent", { get: () => doc.body });
    // Selected some other way (a re-render, a right click) — no row was clicked.
    (doc.querySelector("#r-c input") as any).checked = true;
    doc.body.dispatchEvent(new (win as any).KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true }));
    expect(selected()).toEqual(ROWS);
  });
});
