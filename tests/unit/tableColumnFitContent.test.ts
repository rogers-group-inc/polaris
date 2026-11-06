/**
 * tests/unit/tableColumnFitContent.test.ts — `data-col-fit="content"` in
 * `setupColumnLayout` (public/js/table-sf.js).
 *
 * A content-fit column is as wide as its widest rendered cell (header label
 * included), re-measured every time the page repaints its tbody. It has no
 * drag handle and never takes the slack, so the rightmost RESIZABLE column
 * before it becomes the auto-fill one. The Events table's User column is the
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
