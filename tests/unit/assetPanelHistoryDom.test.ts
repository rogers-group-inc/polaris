/**
 * tests/unit/assetPanelHistoryDom.test.ts — the asset-details slide-over's
 * back/forward history (public/js/assets.js).
 *
 * The panel is walkable in place: a dependency-tree row, an HA peer, an LLDP
 * neighbour, a MAC-table match and the Application Map rail all call
 * openViewModal on ANOTHER asset, which swaps the panel body rather than
 * stacking a second panel. That left no way back to the device the operator
 * started from.
 *
 * What's pinned here is the part that would rot silently:
 *  - re-opening the CURRENT asset is a REFRESH, not a visit. openViewModal(id)
 *    is what the footer Refresh button, every post-save re-render and the
 *    monitor-pill flip call, so a reducer that pushed on every open would make
 *    a refreshed panel take two ‹ presses to escape — and after N silent
 *    refreshes, N presses;
 *  - a walk must NOT push, or the operator can never reach the start;
 *  - opening from mid-history drops the forward tail (browser semantics);
 *  - the pair is hidden until there is somewhere to go, and each button is
 *    disabled exactly when its direction is spent — that disabled state is the
 *    only signal the stack has an end;
 *  - the Alt+Left/Right chord is gated like Escape, so a nested drilldown keeps
 *    the keys.
 *
 * assets.js is a ~18k-line browser script with no module boundary, so the
 * functions under test are sliced out by name and eval'd with the app-shell
 * globals stubbed — the approach of tests/unit/assetAlertsTabDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const g = globalThis as Record<string, any>;

const assetsLines = readFileSync(resolve(__dirname, "../../public/js/assets.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `[async ]function NAME(...) {` … `}` block out of assets.js. */
function fnSrc(name: string): string {
  const start = assetsLines.findIndex(
    (l) => l.startsWith(`function ${name}(`) || l.startsWith(`async function ${name}(`),
  );
  if (start < 0) throw new Error(`assets.js: function ${name} not found`);
  const end = assetsLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`assets.js: no end of function ${name}`);
  return assetsLines.slice(start, end + 1).join("\n");
}

/** The two app.js helpers the panel's keyboard gates run through — the real
 *  ones, not stubs, so the "yields to a nested drilldown / a modal" cases
 *  exercise the stacking rule the page actually uses. */
const appLines = readFileSync(resolve(__dirname, "../../public/js/app.js"), "utf8").split(/\r?\n/);
function appFnSrc(name: string): string {
  const start = appLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`app.js: function ${name} not found`);
  const end = appLines.findIndex((l, i) => i > start && l === "}");
  return appLines.slice(start, end + 1).join("\n");
}
const APP_SRC = ["isTopmostSlideover", "wireSlideoverEscape"].map(appFnSrc).join("\n") +
  "\nglobalThis.isTopmostSlideover = isTopmostSlideover;\nglobalThis.wireSlideoverEscape = wireSlideoverEscape;";

const FN_NAMES = [
  "_assetHistoryOpen",
  "_assetHistoryTarget",
  "_assetHistoryLabel",
  "_renderAssetPanelNav",
  "_focusAssetPanelNav",
  "_assetPanelGo",
  "_ensureAssetPanelDOM",
];

// The sliced functions call each other by name, so they have to land on
// globalThis rather than in a Function body's scope.
const SRC = FN_NAMES.map(fnSrc).join("\n") + "\n" + FN_NAMES.map((n) => `globalThis.${n} = ${n};`).join("\n");

/** The cap lives beside the reducer as a plain var; read it rather than restate it. */
const HISTORY_MAX = Number(/var ASSET_HISTORY_MAX\s*=\s*(\d+)/.exec(assetsLines.join("\n"))![1]);

/** Module-level state assets.js declares outside any function. */
function resetState(entries: { id: string; label?: string | null }[] = [], idx = entries.length - 1) {
  g._assetPanelHistory = { entries: entries.map((e) => ({ id: e.id, label: e.label ?? null })), idx };
  g._assetPanelWalkDelta = 0;
}

const builtOverlays: HTMLElement[] = [];

/** Build the panel DOM the way the first openViewModal of a session does. */
function buildPanel(): HTMLElement {
  // Every build installs its own document-level keydown listener closing over
  // its own overlay element. happy-dom keeps `document` across tests, and a
  // DETACHED overlay still carries .open — so clear the old ones or a stale
  // handler answers the chord in a test that expects silence.
  builtOverlays.forEach((o) => o.classList.remove("open"));
  document.body.innerHTML = "";
  g._ensureAssetPanelDOM();
  const ov = document.getElementById("asset-panel-overlay") as HTMLElement;
  builtOverlays.push(ov);
  return ov;
}

/** Built and open — the normal state while an operator is looking at a device. */
function mountPanel() {
  buildPanel().classList.add("open");
}

const backBtn = () => document.getElementById("asset-panel-back") as HTMLButtonElement;
const fwdBtn = () => document.getElementById("asset-panel-fwd") as HTMLButtonElement;
const navWrap = () => document.getElementById("asset-panel-nav") as HTMLElement;

beforeEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(APP_SRC)();
  g.ASSET_HISTORY_MAX = HISTORY_MAX;
  resetState();
  // Shell hooks _ensureAssetPanelDOM reaches for.
  g.initSlideoverResize = vi.fn();
  g._handleMonitorPillClick = vi.fn();
  g.closeAssetPanel = vi.fn();
  g.openViewModal = vi.fn(async () => {});
});

describe("asset panel history — reducer", () => {
  it("starts a fresh session at the opened asset", () => {
    const s = g._assetHistoryOpen({ entries: [], idx: -1 }, "A", true);
    expect(s).toEqual({ entries: [{ id: "A", label: null }], idx: 0 });
  });

  it("treats re-opening the current asset as a refresh, not a visit", () => {
    // openViewModal(sameId) is the footer Refresh button, the post-save
    // re-render and the monitor-pill flip. Pushing here would make ‹ walk back
    // through refreshes of one device.
    const before = { entries: [{ id: "A", label: "gate" }], idx: 0 };
    const after = g._assetHistoryOpen(before, "A", false);
    expect(after).toBe(before);
    expect(after.entries).toHaveLength(1);
  });

  it("pushes a pivot onto the stack", () => {
    let s = g._assetHistoryOpen({ entries: [], idx: -1 }, "A", true);
    s = g._assetHistoryOpen(s, "B", false);
    expect(s.entries.map((e: any) => e.id)).toEqual(["A", "B"]);
    expect(s.idx).toBe(1);
  });

  it("drops the forward tail when opening from mid-history", () => {
    const s = g._assetHistoryOpen(
      { entries: [{ id: "A" }, { id: "B" }, { id: "C" }], idx: 0 },
      "D",
      false,
    );
    expect(s.entries.map((e: any) => e.id)).toEqual(["A", "D"]);
    expect(s.idx).toBe(1);
  });

  it("caps the stack from the front so idx stays inside it", () => {
    let s = { entries: [{ id: "seed" }], idx: 0 };
    for (let i = 0; i < HISTORY_MAX + 10; i++) s = g._assetHistoryOpen(s, "a" + i, false);
    expect(s.entries.length).toBe(HISTORY_MAX);
    expect(s.idx).toBe(HISTORY_MAX - 1);
    expect(s.entries[s.idx].id).toBe("a" + (HISTORY_MAX + 9));
    // The oldest entries fell off the front, not the newest off the end.
    expect(s.entries[0].id).not.toBe("seed");
  });

  it("reports the target of each direction, and null when it is spent", () => {
    const s = { entries: [{ id: "A" }, { id: "B" }], idx: 1 };
    expect(g._assetHistoryTarget(s, -1)).toEqual({ idx: 0, entry: { id: "A" } });
    expect(g._assetHistoryTarget(s, 1)).toBeNull();
    expect(g._assetHistoryTarget({ entries: [{ id: "A" }], idx: 0 }, -1)).toBeNull();
  });

  it("labels every entry for an asset, including a revisit", () => {
    const s = { entries: [{ id: "A", label: null }, { id: "B", label: null }, { id: "A", label: null }], idx: 2 };
    g._assetHistoryLabel(s, "A", "HARBOR-61F-1");
    expect(s.entries.map((e: any) => e.label)).toEqual(["HARBOR-61F-1", null, "HARBOR-61F-1"]);
  });
});

describe("asset panel history — header pair", () => {
  it("hides the pair until there is somewhere to go", () => {
    mountPanel();
    resetState([{ id: "A" }]);
    g._renderAssetPanelNav();
    expect(navWrap().hidden).toBe(true);

    resetState([{ id: "A" }, { id: "B" }]);
    g._renderAssetPanelNav();
    expect(navWrap().hidden).toBe(false);
  });

  it("disables each direction exactly when it is spent, and names the target", () => {
    mountPanel();
    resetState([{ id: "A", label: "HARBOR-61F-1" }, { id: "B", label: "HARBOR-SW-2" }], 1);
    g._renderAssetPanelNav();
    expect(backBtn().disabled).toBe(false);
    expect(backBtn().title).toBe("Back to HARBOR-61F-1 (Alt+Left)");
    expect(fwdBtn().disabled).toBe(true);
    expect(fwdBtn().title).toBe("No forward history");

    // Stepped back: forward is now live and back is spent.
    g._assetPanelHistory.idx = 0;
    g._renderAssetPanelNav();
    expect(backBtn().disabled).toBe(true);
    expect(fwdBtn().disabled).toBe(false);
    expect(fwdBtn().title).toBe("Forward to HARBOR-SW-2 (Alt+Right)");
  });

  it("falls back to a generic label before the hostname has loaded", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 1);
    g._renderAssetPanelNav();
    expect(backBtn().title).toBe("Back to the previous asset (Alt+Left)");
  });

  it("does nothing when the panel DOM isn't built", () => {
    document.body.innerHTML = "";
    resetState([{ id: "A" }, { id: "B" }], 1);
    expect(() => g._renderAssetPanelNav()).not.toThrow();
  });
});

describe("asset panel history — walking", () => {
  it("moves the index, flags the walk, and re-opens the target", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 1);
    g._assetPanelGo(-1);
    expect(g._assetPanelHistory.idx).toBe(0);
    // The flag is what stops openViewModal pushing the walk as a new visit.
    expect(g._assetPanelWalkDelta).toBe(-1);
    expect(g.openViewModal).toHaveBeenCalledWith("A");
  });

  it("is a no-op at the end of the stack", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 1);
    g._assetPanelGo(1);
    expect(g._assetPanelHistory.idx).toBe(1);
    expect(g._assetPanelWalkDelta).toBe(0);
    expect(g.openViewModal).not.toHaveBeenCalled();
  });

  it("keeps focus on the pair, handing it over when the direction runs out", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 0);  // already at the start
    g._renderAssetPanelNav();
    g._focusAssetPanelNav(-1);
    // Back is disabled here, so focus must not be parked on it.
    expect(document.activeElement).toBe(fwdBtn());

    g._assetPanelHistory.idx = 1;
    g._renderAssetPanelNav();
    g._focusAssetPanelNav(-1);
    expect(document.activeElement).toBe(backBtn());
  });

  it("wires the two buttons to their directions", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 1);
    g._renderAssetPanelNav();
    backBtn().click();
    expect(g.openViewModal).toHaveBeenCalledWith("A");
    // The real re-open repaints the pair; openViewModal is stubbed here, so do
    // it by hand — forward is disabled until the index has actually moved back.
    g._renderAssetPanelNav();
    fwdBtn().click();
    expect(g.openViewModal).toHaveBeenCalledWith("B");
  });
});

describe("asset panel history — Alt+arrow chord", () => {
  function press(key: string) {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true, cancelable: true }));
  }

  it("walks back and forward", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 1);
    press("ArrowLeft");
    expect(g.openViewModal).toHaveBeenCalledWith("A");

    resetState([{ id: "A" }, { id: "B" }], 0);
    g.openViewModal.mockClear();
    press("ArrowRight");
    expect(g.openViewModal).toHaveBeenCalledWith("B");
  });

  it("ignores the chord without Alt", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 1);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(g.openViewModal).not.toHaveBeenCalled();
  });

  it("yields to an open nested drilldown, like Escape does", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 1);
    const nested = document.createElement("div");
    nested.className = "slideover-overlay slideover-nested open";
    document.body.appendChild(nested);
    press("ArrowLeft");
    expect(g.openViewModal).not.toHaveBeenCalled();
  });

  it("yields to a stacked modal", () => {
    mountPanel();
    resetState([{ id: "A" }, { id: "B" }], 1);
    const modal = document.createElement("div");
    modal.id = "modal-overlay";
    modal.className = "open";
    document.body.appendChild(modal);
    press("ArrowLeft");
    expect(g.openViewModal).not.toHaveBeenCalled();
  });

  it("does nothing while the panel is closed", () => {
    buildPanel();  // built but never opened
    resetState([{ id: "A" }, { id: "B" }], 1);
    press("ArrowLeft");
    expect(g.openViewModal).not.toHaveBeenCalled();
  });
});
