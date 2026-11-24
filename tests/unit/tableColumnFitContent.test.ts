/**
 * tests/unit/tableColumnFitContent.test.ts — `data-col-fit="content"` in
 * `setupColumnLayout` (public/js/table-sf.js).
 *
 * A content-fit column is as wide as its widest rendered cell (header label
 * included), re-measured every time the page repaints its tbody. It has no
 * drag handle and never takes the slack, so the rightmost RESIZABLE column
 * before it becomes the auto-fill one — which gets a handle on the divider
 * between them (see the last describe block). The Events table's User column is the
 * case: once the Actions column went, User was rightmost and absorbed every
 * spare pixel of the table.
 *
 * Same harness as tests/unit/tableColumnFit.test.ts: table-sf.js is eval'd into
 * a happy-dom Window, the container width is stubbed, and the measuring probe
 * reports 10px per character (no stylesheet, so zero cell padding).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;
const AVAIL = 1000;

function rows(users: string[]): string {
  return users.map((u) => `<tr><td>host</td><td>a message</td><td>${u}</td></tr>`).join("");
}

const TABLE_HTML = `
  <div class="table-wrapper">
    <table>
      <thead><tr>
        <th style="width:160px" data-col-id="hostname">Hostname</th>
        <th data-col-id="message">Message</th>
        <th style="width:100px" data-col-fit="content" data-col-id="user">User</th>
      </tr></thead>
      <tbody id="tb">${rows(["admin", "jsmith"])}</tbody>
    </table>
  </div>`;

let win: Window;
let doc: Window["document"];
let layout: any;

function widthOf(colId: string): number {
  const ids = Array.from(doc.querySelectorAll("thead th")).map((t) => t.getAttribute("data-col-id"));
  const cols = Array.from(doc.querySelectorAll("colgroup col"));
  return parseFloat((cols[ids.indexOf(colId)] as any).style.width) || 0;
}

function total(): number {
  return Array.from(doc.querySelectorAll("colgroup col"))
    .reduce((a, c) => a + (parseFloat((c as any).style.width) || 0), 0);
}

/** MutationObserver callbacks are microtasks. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.MutationObserver = (win as any).MutationObserver;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) => String(s ?? "");

  const proto = (win as any).HTMLElement.prototype;
  const orig = proto.getBoundingClientRect;
  proto.getBoundingClientRect = function (this: any) {
    if (this.classList && this.classList.contains("sf-autofit-probe")) {
      const w = (this.textContent || "").length * 10;
      return { width: w, height: 10, top: 0, left: 0, right: w, bottom: 10 };
    }
    return orig.call(this);
  };

  doc.body.innerHTML = TABLE_HTML;
  const table = doc.querySelector("table")! as any;
  const wrapper = doc.querySelector(".table-wrapper")! as any;
  table.getBoundingClientRect = () => ({ width: AVAIL, height: 100, top: 0, left: 0, right: AVAIL, bottom: 100 });
  Object.defineProperty(wrapper, "clientWidth", { value: AVAIL, configurable: true });

  (0, eval)(readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8"));
  layout = (g as any).setupColumnLayout(table, { onChange: () => {} });
});

describe('data-col-fit="content"', () => {
  it("sizes the column to its widest cell, and the column before it takes the slack", () => {
    // "jsmith" (60) beats "User" (40) and "admin" (50).
    expect(widthOf("user")).toBe(60);
    expect(total()).toBe(AVAIL);
    expect(widthOf("message")).toBeGreaterThan(widthOf("hostname"));
  });

  it("has no resize handle", () => {
    expect(doc.querySelector('th[data-col-id="user"] .sf-resize-handle')).toBeNull();
    expect(doc.querySelector('th[data-col-id="hostname"] .sf-resize-handle')).not.toBeNull();
  });

  it("gives the auto-fill column before it a visible handle (the Message | User divider)", () => {
    const h = doc.querySelector('th[data-col-id="message"] .sf-resize-handle') as any;
    expect(h).not.toBeNull();
    expect(h.style.display).toBe("");
  });

  it("re-measures when the page repaints its rows — wider and narrower", async () => {
    doc.getElementById("tb")!.innerHTML = rows(["service-account-01"]);
    await flush();
    expect(widthOf("user")).toBe(180);
    expect(total()).toBe(AVAIL);

    doc.getElementById("tb")!.innerHTML = rows(["-"]);
    await flush();
    expect(widthOf("user")).toBe(40); // the header label is the floor
    expect(total()).toBe(AVAIL);
  });

  it("is capped at a third of the container", async () => {
    doc.getElementById("tb")!.innerHTML = rows(["x".repeat(60)]);
    await flush();
    expect(widthOf("user")).toBe(Math.floor(AVAIL / 3));
  });

  it("ignores a saved width for the column", () => {
    layout.setPrefs({ widths: { user: 400 } });
    expect(widthOf("user")).toBe(60);
  });
});

/** A resize drag on `colId`'s handle, `dx` px (negative = narrower). */
function dragHandle(colId: string, dx: number): void {
  const handle = doc.querySelector(`thead th[data-col-id="${colId}"] .sf-resize-handle`)!;
  const fire = (target: any, type: string, clientX: number) => {
    const ev: any = new (win as any).Event(type, { bubbles: true, cancelable: true });
    ev.clientX = clientX;
    target.dispatchEvent(ev);
  };
  fire(handle, "mousedown", 500);
  fire(doc, "mousemove", 500 + dx);
  fire(doc, "mouseup", 500 + dx);
}

/**
 * The divider between the auto-fill column and a static-width column on its
 * right. The auto-fill column used to have no handle at all, so on the Events
 * table Message could not be made narrower: its width was simply whatever the
 * other columns left. Now that divider drags like any other — the width
 * Message gives up goes to User, on top of User's content width.
 */
describe("the auto-fill column's divider with a static column on its right", () => {
  beforeEach(() => {
    // 1000 − 60 (user) = 940 shared by hostname (160) + message (400) → ×1.68:
    // hostname 268, message 672.
    layout.setPrefs({ widths: { hostname: 160, message: 400 } });
  });

  it("narrowing the auto-fill column widens the static column, 1:1", () => {
    expect(widthOf("message")).toBe(672);
    dragHandle("message", -100);
    expect(widthOf("message")).toBe(572);
    expect(widthOf("user")).toBe(160);
    expect(widthOf("hostname")).toBe(268);
    expect(total()).toBe(AVAIL);
  });

  it("widening takes the width back, then grows into the horizontal scroll", () => {
    dragHandle("message", -100);
    dragHandle("message", 150);
    expect(widthOf("user")).toBe(60);
    expect(widthOf("message")).toBe(722);
    expect(total()).toBeGreaterThan(AVAIL);
  });

  it("stops the auto-fill column at its floor", () => {
    dragHandle("message", -5000);
    expect(widthOf("message")).toBe(36);
    expect(total()).toBe(AVAIL);
  });

  it("gives the extra back before the table would scroll when the container narrows", () => {
    dragHandle("message", -100);
    const wrapper = doc.querySelector(".table-wrapper")! as any;
    Object.defineProperty(wrapper, "clientWidth", { value: 900, configurable: true });
    layout.refresh();
    expect(widthOf("user")).toBe(60);
    expect(total()).toBe(900);
  });

  it("persists through getPrefs / setPrefs", () => {
    dragHandle("message", -100);
    const saved = JSON.parse(JSON.stringify(layout.getPrefs()));
    expect(saved.trailGive).toEqual({ id: "user", px: 100 });

    layout.setPrefs({ trailGive: null });
    expect(widthOf("user")).toBe(60);
    layout.setPrefs(saved);
    expect(widthOf("user")).toBe(160);
    expect(widthOf("message")).toBe(572);
  });

  it("refuses a saved give naming a resizable or unknown column", () => {
    layout.setPrefs({ trailGive: { id: "hostname", px: 100 } });
    expect(layout.getPrefs().trailGive).toBeUndefined();
    layout.setPrefs({ trailGive: { id: "constructor", px: 100 } });
    expect(layout.getPrefs().trailGive).toBeUndefined();
    expect(total()).toBe(AVAIL);
  });

  it("keeps the static column's give through a row repaint", async () => {
    dragHandle("message", -100);
    doc.getElementById("tb")!.innerHTML = rows(["admin"]);
    await flush();
    expect(widthOf("user")).toBe(150); // content 50 + the 100 handed over
    expect(total()).toBe(AVAIL);
  });

  it("dragging the column before the auto-fill one trades with it, not past the border", () => {
    dragHandle("hostname", 50);
    expect(widthOf("hostname")).toBe(318);
    expect(widthOf("message")).toBe(622);
    expect(total()).toBe(AVAIL);
  });
});
