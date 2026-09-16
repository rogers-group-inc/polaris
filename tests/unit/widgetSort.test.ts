/**
 * tests/unit/widgetSort.test.ts
 *
 * Unit tests for the dashboard widgets' SORT control — sortCmp / sortOption /
 * applySort / isCustomSort / setHeaderSort in public/js/widgets/index.js, and
 * the edit-mode swap that hands the header slot from the ⤓ export button to
 * the ⇅ sort button. Same harness as tests/unit/widgetHeaderPills.test.ts: the
 * browser IIFE is eval'd into a happy-dom window with the app-shell globals
 * stubbed.
 *
 * What is actually load-bearing here:
 *   • an unknown or missing `sortBy` falls back to options[0], so a dashboard
 *     saved before this control existed keeps its historical order;
 *   • a row with no value for the sort key sinks to the bottom in EITHER
 *     direction — an unknown timestamp is not "the oldest";
 *   • the sort is stable, which is what makes "Hostname A–Z" hold its places
 *     across a wallboard's 30s refresh instead of reshuffling equal rows;
 *   • exactly one of the two header buttons exists at a time, decided by
 *     whether the canvas is in edit mode.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface Row {
  hostname?: string | null;
  at?: string | null;
  value?: number | null;
  alertRank?: number;
  ack?: boolean;
}
interface SortOption { key: string; label: string; cmp: (a: Row, b: Row) => number }

type Cmp = (get?: (r: Row) => unknown) => (a: Row, b: Row) => number;

let W: {
  sortCmp: {
    newest: Cmp;
    oldest: Cmp;
    text: Cmp;
    high: Cmp;
    low: Cmp;
    severity: Cmp;
    flagFirst: (pred: (r: Row) => boolean) => (a: Row, b: Row) => number;
    then: (...cmps: Array<(a: Row, b: Row) => number>) => (a: Row, b: Row) => number;
  };
  sortOption: (options: SortOption[], key?: string) => SortOption | null;
  applySort: (rows: Row[] | null, options: SortOption[], config?: { sortBy?: string }) => Row[];
  isCustomSort: (options: SortOption[], config?: { sortBy?: string }) => boolean;
  setHeaderSort: (el: unknown, spec: { options: SortOption[]; config?: { sortBy?: string } } | null) => void;
  setHeaderExport: (el: unknown, provider: unknown) => void;
};

const g = globalThis as Record<string, unknown>;
let win: Window;
let doc: Window["document"];

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8");
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.downloadCsv = () => {};
  (0, eval)(code);
  W = (win as unknown as { PolarisWidgets: typeof W }).PolarisWidgets;
});

beforeEach(() => {
  doc.body.innerHTML = "";
  delete (win as unknown as Record<string, unknown>).PolarisDashboard;
});

/**
 * A widget shell inside a canvas. `editing` stamps the class dashboard.js
 * stamps while the operator is customizing — the only thing the two header
 * buttons divide on.
 */
function mountWidget(editing: boolean, id = "w1") {
  const canvas = doc.createElement("div");
  canvas.className = "dashboard-canvas" + (editing ? " is-editing" : "");
  canvas.innerHTML =
    '<article class="dashboard-widget" data-id="' + id + '" data-type="downNodes">' +
      '<div class="dashboard-widget-header">' +
        '<div class="dashboard-widget-title">Down Assets</div>' +
      '</div>' +
      '<div class="dashboard-widget-body"></div>' +
    '</article>';
  doc.body.appendChild(canvas);
  const header = canvas.querySelector(".dashboard-widget-header") as unknown as HTMLElement;
  return {
    el: canvas.querySelector(".dashboard-widget-body") as unknown as HTMLElement,
    header,
    sortBtn: () => header.querySelector(".widget-header-sort") as unknown as HTMLElement | null,
    exportBtn: () => header.querySelector(".widget-header-export") as unknown as HTMLElement | null,
  };
}

/** A dashboard seam that records what the menu asked it to persist. */
function stubDashboard() {
  const setWidgetConfig = vi.fn(() => true);
  (win as unknown as Record<string, unknown>).PolarisDashboard = { setWidgetConfig };
  return setWidgetConfig;
}

function optionsFixture(): SortOption[] {
  const C = W.sortCmp;
  return [
    { key: "severity", label: "Severity, then newest", cmp: C.then(C.severity(), C.newest((r) => r.at)) },
    { key: "newest", label: "Most recent first", cmp: C.newest((r) => r.at) },
    { key: "oldest", label: "Longest outstanding first", cmp: C.oldest((r) => r.at) },
    { key: "hostname", label: "Hostname A–Z", cmp: C.text((r) => r.hostname) },
  ];
}

const names = (rows: Row[]) => rows.map((r) => r.hostname);

describe("sortOption / applySort fallback", () => {
  it("uses options[0] when the config carries no sortBy", () => {
    const opts = optionsFixture();
    expect(W.sortOption(opts, undefined)?.key).toBe("severity");
    expect(W.sortOption(opts)?.key).toBe("severity");
  });

  it("uses options[0] for a sortBy this widget does not offer", () => {
    // A config written by a newer build, or an option the widget dropped —
    // either way the rows must not fall back to the feed's raw order.
    expect(W.sortOption(optionsFixture(), "by-vibes")?.key).toBe("severity");
  });

  it("does not mutate the caller's array", () => {
    const rows: Row[] = [{ hostname: "b" }, { hostname: "a" }];
    const out = W.applySort(rows, optionsFixture(), { sortBy: "hostname" });
    expect(names(rows)).toEqual(["b", "a"]);
    expect(names(out)).toEqual(["a", "b"]);
  });

  it("tolerates a null row array", () => {
    expect(W.applySort(null, optionsFixture(), { sortBy: "newest" })).toEqual([]);
  });
});

describe("isCustomSort", () => {
  it("is false for the default and for an unknown key, true for an explicit one", () => {
    const opts = optionsFixture();
    expect(W.isCustomSort(opts, {})).toBe(false);
    expect(W.isCustomSort(opts, { sortBy: "severity" })).toBe(false);
    expect(W.isCustomSort(opts, { sortBy: "by-vibes" })).toBe(false);
    expect(W.isCustomSort(opts, { sortBy: "oldest" })).toBe(true);
  });
});

describe("time comparators", () => {
  const rows = (): Row[] => [
    { hostname: "mid", at: "2026-09-10T12:00:00Z" },
    { hostname: "unknown", at: null },
    { hostname: "newest", at: "2026-09-16T12:00:00Z" },
    { hostname: "oldest", at: "2026-01-01T12:00:00Z" },
  ];

  it("newest first, with the unknown timestamp last", () => {
    const out = W.applySort(rows(), optionsFixture(), { sortBy: "newest" });
    expect(names(out)).toEqual(["newest", "mid", "oldest", "unknown"]);
  });

  it("oldest first — and an unknown age is still LAST, not first", () => {
    // The trap this guards: treating a null as 0 would make every row with no
    // observed timestamp claim to be the longest-outstanding alert on the wall.
    const out = W.applySort(rows(), optionsFixture(), { sortBy: "oldest" });
    expect(names(out)).toEqual(["oldest", "mid", "newest", "unknown"]);
  });

  it("ignores an unparseable timestamp the same way as a missing one", () => {
    const out = W.applySort(
      [{ hostname: "junk", at: "not-a-date" }, { hostname: "real", at: "2026-09-10T12:00:00Z" }],
      optionsFixture(),
      { sortBy: "newest" },
    );
    expect(names(out)).toEqual(["real", "junk"]);
  });
});

describe("text comparator", () => {
  it("is case-insensitive and digit-aware, with nameless rows last", () => {
    const out = W.applySort(
      [{ hostname: "port10" }, { hostname: null }, { hostname: "Port2" }, { hostname: "" }],
      optionsFixture(),
      { sortBy: "hostname" },
    );
    expect(names(out)).toEqual(["Port2", "port10", null, ""]);
  });
});

describe("numeric comparators", () => {
  const C = () => W.sortCmp;
  const rows = (): Row[] => [
    { hostname: "mid", value: 50 },
    { hostname: "none", value: null },
    { hostname: "high", value: 91 },
    { hostname: "low", value: 4 },
  ];

  it("high() ranks the biggest first and sinks the valueless row", () => {
    const opts: SortOption[] = [{ key: "high", label: "high", cmp: C().high((r) => r.value) }];
    expect(names(W.applySort(rows(), opts, {}))).toEqual(["high", "mid", "low", "none"]);
  });

  it("low() ranks the smallest first and STILL sinks the valueless row", () => {
    const opts: SortOption[] = [{ key: "low", label: "low", cmp: C().low((r) => r.value) }];
    expect(names(W.applySort(rows(), opts, {}))).toEqual(["low", "mid", "high", "none"]);
  });
});

describe("severity / flagFirst / then", () => {
  it("severity() defaults to alertRank and leads with the worst", () => {
    const opts: SortOption[] = [{ key: "sev", label: "sev", cmp: W.sortCmp.severity() }];
    const out = W.applySort(
      [{ hostname: "quiet" }, { hostname: "warn", alertRank: 2 }, { hostname: "crit", alertRank: 4 }],
      opts,
      {},
    );
    expect(names(out)).toEqual(["crit", "warn", "quiet"]);
  });

  it("flagFirst() floats the matching rows without disturbing the rest", () => {
    const opts: SortOption[] = [{
      key: "unacked",
      label: "unacked",
      cmp: W.sortCmp.then(W.sortCmp.flagFirst((r) => !r.ack), W.sortCmp.severity()),
    }];
    const out = W.applySort(
      [
        { hostname: "acked-crit", ack: true, alertRank: 4 },
        { hostname: "open-warn", ack: false, alertRank: 2 },
        { hostname: "acked-warn", ack: true, alertRank: 2 },
        { hostname: "open-crit", ack: false, alertRank: 4 },
      ],
      opts,
      {},
    );
    expect(names(out)).toEqual(["open-crit", "open-warn", "acked-crit", "acked-warn"]);
  });

  it("then() falls through to the next comparator only on a tie", () => {
    const out = W.applySort(
      [
        { hostname: "b", alertRank: 4, at: "2026-09-01T00:00:00Z" },
        { hostname: "a", alertRank: 4, at: "2026-09-15T00:00:00Z" },
        { hostname: "c", alertRank: 2, at: "2026-09-16T00:00:00Z" },
      ],
      optionsFixture(),
      { sortBy: "severity" },
    );
    expect(names(out)).toEqual(["a", "b", "c"]);
  });

  it("is STABLE — rows the comparator calls equal keep the feed's own order", () => {
    // This is what makes a wallboard readable: equal rows must not swap places
    // on every 30s refresh.
    const rows: Row[] = [
      { hostname: "z", alertRank: 4, at: "2026-09-15T00:00:00Z" },
      { hostname: "m", alertRank: 4, at: "2026-09-15T00:00:00Z" },
      { hostname: "a", alertRank: 4, at: "2026-09-15T00:00:00Z" },
    ];
    expect(names(W.applySort(rows, optionsFixture(), { sortBy: "severity" }))).toEqual(["z", "m", "a"]);
  });
});

describe("setHeaderSort — the edit-mode button", () => {
  it("stamps ⇅ while editing and nothing while viewing", () => {
    stubDashboard();
    const viewing = mountWidget(false);
    W.setHeaderSort(viewing.el, { options: optionsFixture(), config: {} });
    expect(viewing.sortBtn()).toBeNull();

    const editing = mountWidget(true, "w2");
    W.setHeaderSort(editing.el, { options: optionsFixture(), config: {} });
    expect(editing.sortBtn()).not.toBeNull();
    expect(editing.sortBtn()!.textContent).toBe("⇅");
  });

  it("names the current order — and the fact that it decides the clip — in the tooltip", () => {
    stubDashboard();
    const w = mountWidget(true);
    W.setHeaderSort(w.el, { options: optionsFixture(), config: { sortBy: "oldest" } });
    const tip = w.sortBtn()!.getAttribute("title") || "";
    expect(tip).toContain("Longest outstanding first");
    expect(tip).toContain("Row limit");
  });

  it("removes itself when the widget re-renders outside edit mode", () => {
    stubDashboard();
    const w = mountWidget(true);
    W.setHeaderSort(w.el, { options: optionsFixture(), config: {} });
    expect(w.sortBtn()).not.toBeNull();
    // What dashboard.js does on "Done": drop the class, re-render the widget.
    (doc.querySelector(".dashboard-canvas") as unknown as HTMLElement).classList.remove("is-editing");
    W.setHeaderSort(w.el, { options: optionsFixture(), config: {} });
    expect(w.sortBtn()).toBeNull();
  });

  it("stamps nothing without a dashboard seam to persist through", () => {
    // A library preview / isolated harness: a button that silently did nothing
    // is worse than no button.
    const w = mountWidget(true);
    W.setHeaderSort(w.el, { options: optionsFixture(), config: {} });
    expect(w.sortBtn()).toBeNull();
  });

  it("stamps nothing for a widget offering fewer than two orders", () => {
    stubDashboard();
    const w = mountWidget(true);
    W.setHeaderSort(w.el, { options: [optionsFixture()[0]], config: {} });
    expect(w.sortBtn()).toBeNull();
  });

  it("opens a menu marking the current order, and persists the pick", () => {
    const setWidgetConfig = stubDashboard();
    const w = mountWidget(true, "w-alerts");
    W.setHeaderSort(w.el, { options: optionsFixture(), config: { sortBy: "newest" } });
    w.sortBtn()!.dispatchEvent(new win.Event("click", { bubbles: true }));

    const menu = doc.querySelector(".widget-sort-menu");
    expect(menu).not.toBeNull();
    const items = Array.from(menu!.querySelectorAll("button[data-i]"));
    expect(items.map((b: any) => b.querySelector("span").textContent)).toEqual([
      "Severity, then newest", "Most recent first", "Longest outstanding first", "Hostname A–Z",
    ]);
    expect(items.filter((b: any) => b.getAttribute("aria-checked") === "true").length).toBe(1);
    expect((items[1] as any).getAttribute("aria-checked")).toBe("true");

    (items[2] as any).dispatchEvent(new win.Event("click", { bubbles: true }));
    expect(setWidgetConfig).toHaveBeenCalledWith("w-alerts", "sortBy", "oldest");
    expect(doc.querySelector(".widget-sort-menu")).toBeNull(); // picking closes it
  });
});

describe("the header slot is shared — one button at a time", () => {
  const provider = () => ({
    filename: "down-assets",
    columns: [{ header: "Hostname", get: (r: Row) => r.hostname || "" }],
    rows: [{ hostname: "fgt-1", alertSeverity: "critical" }],
  });

  it("viewing gets ⤓ and no ⇅", () => {
    stubDashboard();
    const w = mountWidget(false);
    W.setHeaderExport(w.el, provider());
    W.setHeaderSort(w.el, { options: optionsFixture(), config: {} });
    expect(w.exportBtn()).not.toBeNull();
    expect(w.sortBtn()).toBeNull();
  });

  it("editing gets ⇅ and no ⤓ — even with rows to export", () => {
    stubDashboard();
    const w = mountWidget(true);
    W.setHeaderExport(w.el, provider());
    W.setHeaderSort(w.el, { options: optionsFixture(), config: {} });
    expect(w.sortBtn()).not.toBeNull();
    expect(w.exportBtn()).toBeNull();
  });

  it("an export button already stamped is removed when edit mode starts", () => {
    stubDashboard();
    const w = mountWidget(false);
    W.setHeaderExport(w.el, provider());
    expect(w.exportBtn()).not.toBeNull();
    (doc.querySelector(".dashboard-canvas") as unknown as HTMLElement).classList.add("is-editing");
    W.setHeaderExport(w.el, provider());
    expect(w.exportBtn()).toBeNull();
  });
});
