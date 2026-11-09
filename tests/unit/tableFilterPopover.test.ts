/**
 * tests/unit/tableFilterPopover.test.ts — the document-wide popover-close
 * wiring in public/js/table-sf.js (TableSF._wireDocClose).
 *
 * table-sf.js is a plain browser script (no module exports), so it's eval'd
 * into a happy-dom Window with the app-shell globals stubbed — same approach as
 * tests/unit/tableColumnOrder.test.ts.
 *
 * What's pinned here is the interaction that broke on the Events page: a
 * multi-select filter popover has its own max-height + overflow-y, and the
 * capture-phase scroll listener (which exists so a page scroll can't leave the
 * position:fixed popover floating away from its button) used to close it when
 * the operator scrolled the LIST — wheel or scrollbar drag alike.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

const g = globalThis as Record<string, any>;

const TABLE_HTML = `
  <table>
    <thead><tr>
      <th data-sf-key="resourceType" data-sf-type="string" data-sf-options="asset|integration|subnet">Resource</th>
      <th data-sf-key="resourceName" data-sf-type="string">Name</th>
    </tr></thead>
    <tbody id="tb"><tr><td>integration</td><td>CENTRALFMG1</td></tr></tbody>
  </table>`;

let win: Window;
// Typed as the lib.dom Document (happy-dom implements it) so the test can use
// the standard HTMLElement / HTMLInputElement casts.
let doc: Document;

function setup(insideTransformedHost = false) {
  win = new Window();
  doc = win.document as unknown as Document;
  g.window = win;
  g.document = doc;
  g.MutationObserver = (win as any).MutationObserver;
  g.getComputedStyle = (el: Element) => (win as any).getComputedStyle(el);
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  doc.body.innerHTML = insideTransformedHost ? `<div id="host">${TABLE_HTML}</div>` : TABLE_HTML;
  const src = readFileSync(resolve(__dirname, "../../public/js/table-sf.js"), "utf8");
  (0, eval)(src);
  return new (g as any).TableSF("tb", () => {});
}

function fire(type: string, target: any, extra: Record<string, unknown> = {}): void {
  const ev: any = new (win as any).Event(type, { bubbles: type !== "scroll", cancelable: true });
  Object.assign(ev, extra);
  target.dispatchEvent(ev);
}

function popover(): Element {
  return doc.querySelector(".sf-multi-popover")!;
}

function isOpen(): boolean {
  return !popover().hasAttribute("hidden");
}

function openPopover(): void {
  (doc.querySelector(".sf-multi-button") as any).click();
  expect(isOpen()).toBe(true);
}

beforeEach(() => { setup(); });

describe("filter popover close wiring", () => {
  it("stays open while the operator scrolls INSIDE the popover", () => {
    openPopover();
    fire("scroll", popover());
    expect(isOpen()).toBe(true);
  });

  it("stays open when a scrollbar drag started inside it releases outside", () => {
    openPopover();
    // Scrollbar drag: mousedown on the popover, mouseup off it — the browser
    // dispatches the resulting click on the common ancestor (body).
    fire("mousedown", popover());
    fire("scroll", popover());
    fire("click", doc.body);
    expect(isOpen()).toBe(true);
  });

  it("still closes on a page scroll outside the popover", () => {
    openPopover();
    fire("scroll", doc.body);
    expect(isOpen()).toBe(false);
  });

  // The dashboard's NOC auto-scroll creeps every overflowing widget body by a
  // pixel every 80ms. Those scroll events don't move a filter button sitting in
  // the asset-details slide-over, and closing on them made its dropdowns
  // disappear the instant they opened.
  it("stays open when a container that doesn't hold the button scrolls", () => {
    const other = doc.createElement("div");
    doc.body.appendChild(other);
    openPopover();
    fire("scroll", other);
    expect(isOpen()).toBe(true);
  });

  it("still closes on a document-level scroll", () => {
    openPopover();
    fire("scroll", doc);
    expect(isOpen()).toBe(false);
  });

  it("still closes on an outside click, a resize, and Escape", () => {
    openPopover();
    fire("click", doc.body);
    expect(isOpen()).toBe(false);

    openPopover();
    fire("resize", win);
    expect(isOpen()).toBe(false);

    openPopover();
    fire("keydown", doc, { key: "Escape" });
    expect(isOpen()).toBe(false);
  });
});

/**
 * The popover is position:fixed, which is laid out against the viewport ONLY
 * while no ancestor establishes a containing block for it. `.slideover` (asset
 * details) and `.modal` both carry a transform for their open animation, and a
 * transform establishes one even at its identity value — so every filter
 * popover in the asset-details panel used to land roughly half a screen to the
 * right of its button, vertically correct because the panel's top is 0.
 */
describe("filter popover positioning", () => {
  const BTN = { left: 985, bottom: 120, width: 60 };

  function stubRect(el: any, rect: Record<string, number>): void {
    el.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0, ...rect });
  }
  function popStyle(): { top: string; left: string } {
    const p = popover() as any;
    return { top: p.style.top, left: p.style.left };
  }

  it("uses raw viewport coordinates on an ordinary page", () => {
    stubRect(doc.querySelector(".sf-multi-button"), BTN);
    openPopover();
    expect(popStyle()).toEqual({ top: "122px", left: "985px" });
  });

  it("subtracts a transformed ancestor's padding-box origin", () => {
    setup(true);
    const host: any = doc.getElementById("host");
    stubRect(host, { left: 880, top: 0 });
    stubRect(doc.querySelector(".sf-multi-button"), BTN);
    // happy-dom has no layout engine, so the transform + border that make this
    // element a containing block are reported rather than computed.
    const real = g.getComputedStyle;
    g.getComputedStyle = (el: Element) => (el === host
      ? { transform: "matrix(1, 0, 0, 1, 0, 0)", borderTopWidth: "0px", borderLeftWidth: "1px" }
      : real(el));
    try {
      openPopover();
      // 985 − 880 − 1px border, NOT 985: the button sits 104px into the panel.
      expect(popStyle()).toEqual({ top: "122px", left: "104px" });
    } finally {
      g.getComputedStyle = real;
    }
  });
});
