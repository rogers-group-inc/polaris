/**
 * tests/unit/assetPanelHeaderActionsDom.test.ts — the asset-details slide-over's
 * per-asset action group lives in the HEADER (public/js/assets.js + styles.css).
 *
 * Screenshot + PDF | Export / Refresh / Open HTTPS / Open SSH moved out of the
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

// Discover Now and Reboot moved from the System tab's Status row into the
// header, right of the hostname (2026-10): they act on the DEVICE, so they
// belong with its name on every tab, not on one tab's row.
describe("asset panel header verbs (Discover Now, Reboot)", () => {
  const VERB_FNS = ["_assetDiscoverNowBtnHTML", "_assetRebootSlotHTML", "_assetHeaderVerbsHTML", "_rebootControlHTML"];

  function loadVerbs(perms: { manage: boolean; read: boolean }) {
    g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    g.canManageAssets = () => perms.manage;
    g.permAtLeast = () => perms.read;
    g._isWorkloadPlatform = () => false;
    g._getServerDiscoveries = () => [];
    g._fwWhenText = () => "soon";
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(
      "var _REBOOT_SCHEDULABLE = { available: true, blocked: true, 'agent-offline': true };\n" +
      VERB_FNS.map(fnSrc).join("\n") + "\n" + VERB_FNS.map((n) => `globalThis.${n} = ${n};`).join("\n"),
    )();
  }

  const GATE = {
    id: "a1", hostname: "GATE-1", assetType: "firewall",
    fortinetTopology: { role: "fortigate", deviceName: "GATE-1" },
    discoveredByIntegration: { id: "i1", type: "fortigate", name: "Lab FG", enabled: true },
  };

  it("renders an empty verbs slot in the title lead, right after the title", () => {
    const verbs = document.getElementById("asset-panel-verbs")!;
    expect(verbs.className).toBe("slideover-header-verbs");
    expect(verbs.parentElement!.classList.contains("slideover-header-lead")).toBe(true);
    expect(verbs.previousElementSibling!.id).toBe("asset-panel-title");
    expect(verbs.innerHTML).toBe("");
    expect(cssSrc).toMatch(/\.slideover-header-verbs:empty\s*\{\s*display:\s*none/);
  });

  it("orders Discover Now before the Reboot slot", () => {
    loadVerbs({ manage: true, read: true });
    const host = document.getElementById("asset-panel-verbs")!;
    host.innerHTML = g._assetHeaderVerbsHTML(GATE);
    const kids = Array.from(host.children).map((n) => n.id);
    expect(kids).toEqual(["btn-asset-discover-now", "asset-reboot-wrap"]);
    expect(host.querySelector("#btn-asset-discover-now")!.textContent).toBe("Discover Now");
  });

  it("a viewer without Read-Write gets the reboot slot only", () => {
    loadVerbs({ manage: false, read: true });
    const html = g._assetHeaderVerbsHTML(GATE);
    expect(html).not.toContain("btn-asset-discover-now");
    expect(html).toContain("asset-reboot-wrap");
  });

  it("labels the reboot button plain \"Reboot\"", () => {
    loadVerbs({ manage: true, read: true });
    const wrap = document.createElement("div");
    wrap.innerHTML = g._rebootControlHTML(GATE, { state: "available", available: true, authority: "Lab FG" });
    expect(wrap.querySelector("#btn-asset-reboot")!.textContent).toBe("Reboot");
  });

  it("fills the slot per open and clears it in the loading reset", () => {
    expect(assetsSrc).toMatch(/verbsEl\.innerHTML = _assetHeaderVerbsHTML\(a\);/);
    const reset = assetsSrc.slice(
      assetsSrc.indexOf('footerEl.innerHTML = "";'),
      assetsSrc.indexOf('footerEl.innerHTML = "";') + 600,
    );
    expect(reset).toMatch(/verbsEl\.innerHTML = ""/);
  });

  it("the Status row holds Simulate Down LEFT of the pill, and no Discover Now or Reboot", () => {
    const row = assetsLines.find((l) => l.includes("'<span class=\"detail-value\">' + depTestBtn"));
    expect(row).toBeTruthy();
    expect(row!.indexOf("depTestBtn")).toBeLessThan(row!.indexOf("asset-status-pill-wrap"));
    expect(row).not.toContain("discoverBtn");
    expect(row).not.toContain("_assetRebootSlotHTML");
    expect(assetsSrc).toContain(">Simulate Down</button>");
    expect(assetsSrc).not.toContain("Simulate Down…");
  });
});

describe("the reboot dialog's Reason field (rule 115(d))", () => {
  const DIALOG_FNS = ["_rebootNoteFieldHTML", "_rebootMethodText", "_rebootScheduleFieldsHTML", "_rebootModalHTML"];

  function loadDialog() {
    g.escapeHtml = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    g.timeAgo = () => "2 days ago";
    g._fwWhenText = () => "soon";
    g._fwLocalInputValue = () => "2026-10-26T13:00";
    g._fwBrowserZone = () => "UTC";
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(DIALOG_FNS.map(fnSrc).join("\n") + "\n" + DIALOG_FNS.map((n) => `globalThis.${n} = ${n};`).join("\n"))();
  }

  const GATE = { id: "a1", hostname: "GATE-1", assetType: "firewall" };
  const RB = { state: "available", available: true, kind: "fortinet", method: "fortigate-rest", authority: "Lab FG", lastRun: null, schedule: null };

  it("offers an optional Reason on a reboot, marked required only when the install requires it", () => {
    loadDialog();
    const opt = document.createElement("div");
    opt.innerHTML = g._rebootModalHTML(GATE, RB, { mode: "choose" });
    expect(opt.querySelector("#rb-note")).not.toBeNull();
    expect(opt.querySelector('label[for="rb-note"]')!.textContent).toContain("(optional)");
    const req = document.createElement("div");
    req.innerHTML = g._rebootModalHTML(GATE, { ...RB, noteRequired: true }, { mode: "choose" });
    expect(req.querySelector('label[for="rb-note"]')!.textContent).toContain("*");
    expect(req.textContent).toContain("requires a reason for every reboot");
  });

  it("pre-fills a booking's reason when changing it, and shows the last reboot's reason", () => {
    loadDialog();
    const wrap = document.createElement("div");
    wrap.innerHTML = g._rebootModalHTML(GATE, { ...RB, lastRun: { status: "succeeded", startedAt: "x", startedBy: "alice", note: "Leak <7.4.3>" } },
      { mode: "change", existing: { scheduledFor: "2026-10-27T02:00:00Z", notifyEmails: ["noc@example.com"], note: "Patch night" } });
    expect((wrap.querySelector("#rb-note") as HTMLInputElement).value).toBe("Patch night");
    expect(wrap.textContent).toContain("— Leak <7.4.3>");
  });
});
