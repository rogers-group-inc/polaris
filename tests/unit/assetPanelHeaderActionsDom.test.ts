/**
 * tests/unit/assetPanelHeaderActionsDom.test.ts — the asset-details slide-over's
 * per-asset action group lives in the HEADER (public/js/assets.js + styles.css).
 *
 * Copy / Screenshot | Export / Refresh / Open HTTPS / Open SSH moved out of the
 * footer in 2026-08: they act on the tab the operator is reading, and at the
 * bottom of a full-height panel they sat a screen away from it. Three things
 * about that placement break silently:
 *
 *  - the group must sit BEFORE the lock button in DOM order, because the CSS
 *    that keeps the lock flush against the X is a following-sibling selector
 *    (`.slideover-header-actions ~ .panel-lock-btn`) neutralizing the inline
 *    `margin-left:auto` _ensureLockButton stamps. Insert the group after the
 *    lock and flex splits the header's free space between two auto margins,
 *    stranding the lock mid-header;
 *  - the two dropdowns in the group (Export, the SSH caret) must NOT carry
 *    `.drop-up` — that variant existed only because the footer sits at the
 *    bottom of the viewport, and from the header it opens off-panel;
 *  - the group has to be cleared alongside the footer in openViewModal's
 *    loading reset, or walking to another asset leaves the previous device's
 *    Open HTTPS / Open SSH buttons on screen pointing at its IP.
 *
 * assets.js is a ~20k-line browser script with no module boundary, so the
 * function under test is sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/assetPanelHistoryDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsSrc = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8");
const assetsLines = assetsSrc.split(/\r?\n/);
const cssSrc = readFileSync(resolve(__dirname, "../../public/css/styles.css"), "utf8");

function fnSrc(name: string): string {
  const start = assetsLines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

const FN_NAMES = ["_renderAssetPanelNav", "_assetPanelGo", "_ensureAssetPanelDOM"];
const SRC =
  FN_NAMES.map(fnSrc).join("\n") + "\n" + FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n");

/**
 * app.js's lock injector, verbatim in the part this test depends on: a
 * `.panel-lock-btn` inserted before the header's close button, carrying an
 * INLINE margin-left:auto. Reimplemented rather than sliced because app.js
 * isn't loaded here — the invariant under test is the DOM ORDER it produces.
 */
function injectLockButton() {
  const head = document.querySelector(".slideover .slideover-header-top") as HTMLElement;
  const closeBtn = head.querySelector(".btn-icon") as HTMLElement;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-icon panel-lock-btn";
  btn.style.marginLeft = "auto";
  closeBtn.parentNode!.insertBefore(btn, closeBtn);
}

beforeEach(() => {
  document.body.innerHTML = "";
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  g._assetPanelHistory = { entries: [], idx: -1 };
  g._assetPanelWalkDelta = 0;
  g.initSlideoverResize = vi.fn();
  // app.js keyboard helpers _ensureAssetPanelDOM wires — the header markup is
  // what this file pins; the key handling is tests/unit/assetPanelHistoryDom.test.ts.
  g.wireSlideoverEscape = vi.fn();
  g.isTopmostSlideover = vi.fn(() => false);
  g._handleMonitorPillClick = vi.fn();
  g.closeAssetPanel = vi.fn();
  g.openViewModal = vi.fn(async () => {});
  g._ensureAssetPanelDOM();
});

describe("asset panel header actions — placement", () => {
  it("renders an empty actions container in the header, not the footer", () => {
    const actions = document.getElementById("asset-panel-actions")!;
    expect(actions.className).toBe("slideover-header-actions");
    expect(actions.closest(".slideover-header-top")).toBeTruthy();
    expect(actions.innerHTML).toBe("");
    // The footer stays in the DOM — it still carries Close / Edit.
    expect(document.getElementById("asset-panel-footer")).toBeTruthy();
  });

  it("puts the actions group between the title lead and the close button", () => {
    const head = document.querySelector(".slideover-header-top")!;
    const kids = Array.from(head.children);
    const lead = kids.findIndex((n) => n.classList.contains("slideover-header-lead"));
    const actions = kids.findIndex((n) => n.id === "asset-panel-actions");
    const close = kids.findIndex((n) => n.id === "asset-panel-close");
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(actions).toBeGreaterThan(lead);
    expect(close).toBeGreaterThan(actions);
  });

  it("leaves the lock button AFTER the actions group, which the CSS depends on", () => {
    injectLockButton();
    const head = document.querySelector(".slideover-header-top")!;
    const kids = Array.from(head.children);
    const actions = kids.findIndex((n) => n.id === "asset-panel-actions");
    const lock = kids.findIndex((n) => n.classList.contains("panel-lock-btn"));
    const close = kids.findIndex((n) => n.id === "asset-panel-close");
    expect(lock).toBeGreaterThan(actions);
    expect(close).toBeGreaterThan(lock);
    // The sibling combinator only reaches a LATER sibling — and only
    // !important beats the injector's inline style.
    expect(cssSrc).toMatch(
      /\.slideover-header-actions\s*~\s*\.panel-lock-btn\s*\{\s*margin-left:\s*0\s*!important/,
    );
    expect(cssSrc).toMatch(/\.slideover-header-actions\s*\{[^}]*margin-left:\s*auto/);
  });
});

describe("asset panel header actions — source invariants", () => {
  it("drops .drop-up from both dropdowns in the group", () => {
    // They hang below a header at the TOP of the viewport now.
    expect(assetsSrc).toMatch(/btn-dropdown-menu" id="asset-export-menu"/);
    expect(assetsSrc).toMatch(/btn-dropdown-menu" id="asset-ssh-menu"/);
    expect(assetsSrc).not.toContain("drop-up");
  });

  it("clears the group in the loading reset, beside the footer", () => {
    // A walk to another asset must not leave the previous device's Open HTTPS /
    // Open SSH buttons on screen while the new one loads.
    const reset = assetsSrc.slice(
      assetsSrc.indexOf('footerEl.innerHTML = "";'),
      assetsSrc.indexOf('footerEl.innerHTML = "";') + 400,
    );
    expect(reset).toMatch(/actionsEl\.innerHTML = ""/);
  });

  it("fills the group with the action buttons and the footer with the dismiss pair", () => {
    expect(assetsSrc).toMatch(/actionsEl\.innerHTML = actionBtns;/);
    expect(assetsSrc).toMatch(/footerEl\.innerHTML = dismissBtns;/);
  });
});

// The tab strip is frozen in the header (2026-09): openViewModal renders it
// into the body with tabbedBodyHTML, then moves #asset-view-tabs into the
// header slot so it no longer scrolls away with the tab content.
describe("asset panel frozen tab strip", () => {
  it("renders an empty tab slot in the header, after the meta row, outside the body", () => {
    const slot = document.getElementById("asset-panel-tabs")!;
    expect(slot.className).toBe("slideover-tabs");
    expect(slot.parentElement!.classList.contains("slideover-header")).toBe(true);
    expect(slot.closest("#asset-panel-body")).toBeNull();
    expect(slot.previousElementSibling!.id).toBe("asset-panel-meta");
    expect(slot.innerHTML).toBe("");
  });

  it("moves the rendered strip into the slot and clears it in the loading reset", () => {
    expect(assetsSrc).toMatch(/var tabBar = bodyEl\.querySelector\("#asset-view-tabs"\);/);
    expect(assetsSrc).toMatch(/tabsSlot\.appendChild\(tabBar\);/);
    const loading = assetsSrc.indexOf(
      'bodyEl.innerHTML = \'<p class="empty-state" style="padding:1rem 1.25rem">Loading...</p>\';',
    );
    expect(loading).toBeGreaterThan(0);
    const reset = assetsSrc.slice(loading - 300, loading);
    expect(reset).toMatch(/tabsSlot\.innerHTML = ""/);
  });

  it("styles the slot so the header border is the strip's rule", () => {
    expect(cssSrc).toMatch(/\.slideover-tabs:empty\s*\{\s*display:\s*none/);
    expect(cssSrc).toMatch(
      /\.slideover-header:has\(> \.slideover-tabs:not\(:empty\)\)\s*\{\s*padding-bottom:\s*0/,
    );
  });
});
