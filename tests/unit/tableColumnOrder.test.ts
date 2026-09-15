/**
 * tests/unit/tableColumnOrder.test.ts — drag-to-reorder columns in the
 * setupColumnLayout chooser (public/js/table-sf.js).
 *
 * table-sf.js is a plain browser script (no module exports), so it's eval'd
 * into a happy-dom Window with the app-shell globals stubbed — same approach as
 * tests/unit/automationsWizardDom.test.ts.
 *
 * What's pinned here is the part that silently rots: reordering PHYSICALLY
 * moves <th>/<col>/<td> nodes (there is no CSS way to permute table columns),
 * so every position-derived behaviour has to follow — the hide rules'
 * nth-child indexes, the body cells after a re-render, and a saved order read
 * back on the next page load once a Polaris update has added a column. The
 * order-only setPrefs is pinned here too: the Assets view tabs push a per-tab
 * order through it on every tab switch and must not disturb the widths and
 * hidden columns, which stay per-browser.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

const TABLE_HTML = `
  <div class="table-wrapper">
    <table>
      <thead><tr>
        <th class="cb-col"></th>
        <th data-sf-key="hostname">Hostname</th>
        <th data-sf-key="ip">IP Address</th>
        <th data-sf-key="serial">Serial Number</th>
        <th data-col-id="actions" data-col-required="true">Actions</th>
      </tr></thead>
      <tbody id="tb">
        <tr><td class="cb-col">cb</td><td>host-1</td><td>10.0.0.1</td><td>SN1</td><td>act</td></tr>
        <tr><td class="cb-col">cb</td><td>host-2</td><td>10.0.0.2</td><td>SN2</td><td>act</td></tr>
      </tbody>
    </table>
  </div>`;

let win: Window;
let doc: Window["document"];
let changes: number;

/** Text of each cell in a row / header, left to right. */
function cellsOf(row: Element | null): string[] {
  if (!row) return [];
  return Array.prototype.map.call(row.children, (c: Element) => c.textContent!.trim()) as string[];
}

function headerLabels(): string[] {
  return cellsOf(doc.querySelector("thead tr"));
}

function fireDrag(type: string, target: any, extra: Record<string, unknown> = {}): void {
  const ev: any = new (win as any).Event(type, { bubbles: true, cancelable: true });
  ev.dataTransfer = { setData() {}, getData: () => "", effectAllowed: "", dropEffect: "" };
  Object.assign(ev, extra);
  target.dispatchEvent(ev);
}

/**
 * Drag `fromId`'s chooser row onto `toId`'s. happy-dom's getBoundingClientRect
 * is all-zeros, so the midpoint test lands on "after" — the drop puts `fromId`
 * immediately after `toId`.
 */
function dragColumnAfter(fromId: string, toId: string): void {
  const pop = doc.querySelector(".sf-col-chooser")!;
  const fromRow = pop.querySelector(`.sf-col-chooser-row[data-col-id="${fromId}"]`)!;
  const toRow = pop.querySelector(`.sf-col-chooser-row[data-col-id="${toId}"]`)!;
  fireDrag("dragstart", fromRow.querySelector(".sf-col-grip"));
  fireDrag("dragover", toRow, { clientY: 0 });
  fireDrag("drop", toRow, { clientY: 0 });
}

function setup(html = TABLE_HTML) {
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.MutationObserver = (win as any).MutationObserver;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  doc.body.innerHTML = html;
  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);

  changes = 0;
  const table = doc.querySelector("table")!;
  const layout = (g as any).setupColumnLayout(table, { onChange: () => { changes++; } });
  layout.openChooser();
  return layout;
}

beforeEach(() => { setup(); });

describe("column chooser drag-to-reorder", () => {
  it("lists every optional column with a drag grip, and skips required ones", () => {
    const rows = Array.from(doc.querySelectorAll(".sf-col-chooser-row"));
    expect(rows.map((r) => r.getAttribute("data-col-id"))).toEqual(["hostname", "ip", "serial"]);
    expect(rows.every((r) => !!r.querySelector(".sf-col-grip[draggable='true']"))).toBe(true);
  });

  it("moves the <th> and every body cell, and reports the change", () => {
    dragColumnAfter("serial", "hostname");

    expect(headerLabels()).toEqual(["", "Hostname", "Serial Number", "IP Address", "Actions"]);
    expect(cellsOf(doc.querySelector("tbody tr"))).toEqual(["cb", "host-1", "SN1", "10.0.0.1", "act"]);
    expect(cellsOf(doc.querySelectorAll("tbody tr")[1])).toEqual(["cb", "host-2", "SN2", "10.0.0.2", "act"]);
    expect(changes).toBeGreaterThan(0);
  });

  it("carries each <col> along so saved widths stay on their own column", () => {
    const layout = setup();
    layout.setPrefs({ widths: { hostname: 100, ip: 200, serial: 300 } });
    dragColumnAfter("serial", "hostname");
    const widths = Array.from(doc.querySelectorAll("colgroup col")).map((c) => (c as any).style.width);
    expect(widths[1]).toBe("100px");   // hostname
    expect(widths[2]).toBe("300px");   // serial, now second
    expect(widths[3]).toBe("200px");   // ip, now third
  });

  it("stays correct across a second drag on the same rendered rows", () => {
    // Regression: the second pass has to read back where each cell currently
    // sits. Treating an already-moved row as authored-order scrambles it.
    dragColumnAfter("serial", "hostname");
    dragColumnAfter("ip", "hostname");
    expect(headerLabels()).toEqual(["", "Hostname", "IP Address", "Serial Number", "Actions"]);
    expect(cellsOf(doc.querySelector("tbody tr"))).toEqual(["cb", "host-1", "10.0.0.1", "SN1", "act"]);
  });

  it("keeps required columns anchored at their authored index", () => {
    dragColumnAfter("hostname", "serial");
    // Actions is required — it stays last no matter how the others shuffle.
    expect(headerLabels()[0]).toBe("");
    expect(headerLabels()[4]).toBe("Actions");
  });
});

describe("reordered columns survive the surrounding machinery", () => {
  it("re-applies the order after the page re-renders its tbody", async () => {
    dragColumnAfter("serial", "hostname");
    doc.getElementById("tb")!.innerHTML =
      "<tr><td class='cb-col'>cb</td><td>host-9</td><td>10.0.0.9</td><td>SN9</td><td>act</td></tr>";
    // The MutationObserver runs as a microtask.
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(cellsOf(doc.querySelector("tbody tr"))).toEqual(["cb", "host-9", "SN9", "10.0.0.9", "act"]);
  });

  it("leaves colspan rows (empty states, section headers) alone", async () => {
    dragColumnAfter("serial", "hostname");
    doc.getElementById("tb")!.innerHTML = '<tr><td colspan="5">No results</td></tr>';
    await new Promise((r) => setTimeout(r, 0));
    expect(cellsOf(doc.querySelector("tbody tr"))).toEqual(["No results"]);
  });

  it("writes hide rules at the column's DISPLAY position, not its authored one", () => {
    dragColumnAfter("serial", "hostname");
    // Display order is cb | hostname | serial | ip | actions, so hiding the IP
    // column must target nth-child(4) — its authored index was 3rd (nth-child 3).
    const cb = doc.querySelector('.sf-col-chooser input[data-col-id="ip"]') as any;
    cb.checked = false;
    cb.dispatchEvent(new (win as any).Event("change", { bubbles: true }));
    const css = doc.querySelector("style[id^='sf-style-']")!.textContent!;
    expect(css).toContain("nth-child(4)");
    expect(css).not.toContain("nth-child(3)");
  });
});

describe("saved order round-trip", () => {
  it("getPrefs returns the operator order and setPrefs restores it", () => {
    const layout = setup();
    dragColumnAfter("serial", "hostname");
    const prefs = layout.getPrefs();
    expect(prefs.order).toEqual(["hostname", "serial", "ip"]);

    // Fresh table, same saved blob → same visual order.
    const restored = setup();
    restored.setPrefs(prefs);
    expect(headerLabels()).toEqual(["", "Hostname", "Serial Number", "IP Address", "Actions"]);
    expect(cellsOf(doc.querySelector("tbody tr"))).toEqual(["cb", "host-1", "SN1", "10.0.0.1", "act"]);
  });

  it("splices a newly-shipped column in next to its authored neighbour", () => {
    // A Polaris update adds "model" after "ip"; the operator's saved order
    // predates it and must not strand the newcomer at the far right.
    const withModel = TABLE_HTML
      .replace('<th data-sf-key="serial">Serial Number</th>',
               '<th data-sf-key="ip2">Second IP</th><th data-sf-key="serial">Serial Number</th>')
      .replace(/<td>SN(\d)<\/td>/g, "<td>IP2-$1</td><td>SN$1</td>");
    const layout = setup(withModel);
    layout.setPrefs({ order: ["serial", "hostname", "ip"] });
    // "ip2" was authored right after "ip", so it lands right after it.
    expect(headerLabels()).toEqual(["", "Serial Number", "Hostname", "IP Address", "Second IP", "Actions"]);
    expect(layout.getPrefs().order).toEqual(["serial", "hostname", "ip", "ip2"]);
  });

  it("ignores column ids in a saved order that no longer exist", () => {
    const layout = setup();
    layout.setPrefs({ order: ["serial", "gonePhantomColumn", "hostname"] });
    expect(layout.getPrefs().order).toEqual(["serial", "hostname", "ip"]);
  });

  it("does not mistake an Object.prototype key for a known column", () => {
    // The saved order is untrusted input — localStorage, or the server blob
    // behind the Assets view tabs. On a plain {} lookup "constructor" reads as
    // a known column, gets spliced into the order, then maps to no <th>, and
    // placeInOrder's all-or-nothing guard silently stops applying the order at
    // all — the arrangement just quietly stops working.
    const layout = setup();
    layout.setPrefs({ order: ["constructor", "serial", "toString", "hostname"] });
    expect(layout.getPrefs().order).toEqual(["serial", "hostname", "ip"]);
    expect(headerLabels()).toEqual(["", "Serial Number", "Hostname", "IP Address", "Actions"]);
  });

  it("an order-only setPrefs leaves widths and hidden columns alone", () => {
    // What the Assets view tabs rely on: switching tab rearranges the columns
    // but must not undo the widths the operator dragged or the columns they
    // hid — those are per-browser, the order is per-view (assets-tabs.js).
    const layout = setup();
    layout.setPrefs({ widths: { hostname: 111, ip: 222, serial: 333 }, hidden: ["ip"] });
    layout.setPrefs({ order: ["serial", "hostname", "ip"] });

    const prefs = layout.getPrefs();
    expect(prefs.order).toEqual(["serial", "hostname", "ip"]);
    expect(prefs.hidden).toEqual(["ip"]);
    expect(prefs.widths.hostname).toBe(111);
    expect(prefs.widths.serial).toBe(333);
    // …and the widths followed their own <col> into the new positions.
    const widths = Array.from(doc.querySelectorAll("colgroup col")).map((c) => (c as any).style.width);
    expect(widths[1]).toBe("333px");   // serial, now first
    expect(widths[2]).toBe("111px");   // hostname, now second
  });
});

describe("reset", () => {
  it("offers a reset only once the order differs, and restores the authored order", () => {
    expect(doc.querySelector(".sf-col-chooser-reset")).toBeNull();
    dragColumnAfter("serial", "hostname");
    const reset = doc.querySelector(".sf-col-chooser-reset") as any;
    expect(reset).toBeTruthy();
    reset.dispatchEvent(new (win as any).Event("click", { bubbles: true, cancelable: true }));
    expect(headerLabels()).toEqual(["", "Hostname", "IP Address", "Serial Number", "Actions"]);
    expect(cellsOf(doc.querySelector("tbody tr"))).toEqual(["cb", "host-1", "10.0.0.1", "SN1", "act"]);
    expect(doc.querySelector(".sf-col-chooser-reset")).toBeNull();
  });
});
