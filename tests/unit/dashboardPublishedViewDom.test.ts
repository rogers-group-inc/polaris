/**
 * tests/unit/dashboardPublishedViewDom.test.ts — DOM smoke for the saved-
 * dashboard seam in public/js/dashboard.js (`window.PolarisDashboard`).
 *
 * dashboard-saved.js is tested against a STUB of this seam, so this is the
 * other half: the real orchestrator, eval'd into happy-dom, doing the three
 * things the menu asks of it.
 *
 *   snapshot()       — the canvas on screen as a saved-dashboard payload
 *   loadAsNewTab()   — a saved row becomes a new TAB (a COPY: fresh widget
 *                      instance ids, unknown widget types dropped)
 *   viewPublished()  — a published row renders INSTEAD of the local layout,
 *                      read-only, and nothing about it may be persisted
 *
 * The last one is the load-bearing case: the Dash wallboard has no session to
 * save with, and a viewer looking at someone else's screen must not overwrite
 * their own stored layout.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/dashboard.js"), "utf8");
const g = globalThis as Record<string, unknown>;

const PAGE_HTML =
  '<div class="page-header-actions">' +
    '<button id="dashboard-refresh">Refresh</button>' +
    '<button id="dashboard-customize">Customize Page</button>' +
    '<button id="dashboard-add-widgets" hidden>Add Widgets</button>' +
    '<button id="dashboard-done" hidden>Done Editing</button>' +
    '<button id="dashboard-create">Create New Dashboard</button>' +
  "</div>" +
  '<div id="dashboard-tabs" class="dashboard-tabs" hidden></div>' +
  '<div id="dashboard-empty-state" class="dashboard-empty">Click <strong>Customize Page</strong> to build your dashboard.</div>' +
  '<div id="dashboard-canvas" class="dashboard-canvas" hidden></div>';

let uuidSeq = 0;
function uuid() { uuidSeq += 1; return "uuid-" + uuidSeq; }

/** A stored layout for the signed-in page: one tab, one column, one widget. */
function localLayout() {
  return {
    version: 3,
    activeId: "dash-local",
    dashboards: [
      {
        id: "dash-local",
        name: "My screen",
        columns: [{ id: "col-local", width: 6, widgets: [{ id: "w-local", type: "statusSummary", height: 1, config: {} }] }],
      },
    ],
  };
}

/** A published row as the API returns it — including a widget type this build doesn't register. */
const PUBLISHED = {
  id: "pub-1",
  name: "NOC overview",
  ownerName: "dana",
  visibility: "public",
  updatedAt: "2026-09-02T00:00:00.000Z",
  layout: {
    columns: [
      { id: "col-pub", width: 12, widgets: [
        { id: "w-pub", type: "downNodes", height: 2, config: { limit: 20 } },
        { id: "w-ghost", type: "aWidgetThisBuildDoesNotHave", height: 1, config: {} },
      ] },
      { id: "col-empty", width: 3, widgets: [{ id: "w-ghost2", type: "alsoUnknown", height: 1, config: {} }] },
    ],
  },
};

interface Boot {
  win: InstanceType<typeof Window>;
  doc: Window["document"];
  seam: () => {
    isWallboard: () => boolean;
    snapshot: () => { name: string; layout: { columns: unknown[] } } | null;
    widgetCount: () => number;
    publishedId: () => string | null;
    loadAsNewTab: (row: unknown) => boolean;
    viewPublished: (row: unknown) => boolean;
    clearPublished: () => boolean;
  };
  puts: unknown[];
  store: Record<string, string>;
}

async function boot(opts: { wallboard?: boolean } = {}): Promise<Boot> {
  const win = new Window();
  const doc = win.document;
  const puts: unknown[] = [];
  const store: Record<string, string> = {};
  uuidSeq = 0;

  g.window = win;
  g.document = doc;
  (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL = opts.wallboard ? true : undefined;
  if (opts.wallboard) store["polaris-dash-layout"] = JSON.stringify(localLayout());

  g.escapeHtml = (s: unknown) => String(s ?? "");
  g.showToast = () => {};
  g.showConfirm = async () => true;
  g.openModal = () => {};
  g.closeModal = () => {};
  g.isAdmin = () => false;
  g.currentUsername = "tester";
  g.userReady = Promise.resolve();
  g.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
  };
  g.api = {
    me: {
      dashboard: {
        get: async () => localLayout(),
        put: async (layout: unknown) => { puts.push(layout); return layout; },
      },
    },
  };
  g.PolarisWidgets = {
    uuid,
    // Everything except the two deliberately-unknown types in PUBLISHED.
    getByType: (type: string) =>
      /DoesNotHave|alsoUnknown/.test(type)
        ? null
        : { type, title: type, fetchData: async () => null, renderInstance: () => {} },
    getAllowed: () => [],
    widgetTitle: (module: { title?: string } | null) => (module && module.title) || "Widget",
  };
  g.WidgetLibrary = { open: () => {}, close: () => {}, isOpen: () => false };
  // dashboard.js's cssEscape polyfill checks window.CSS && CSS.escape, then
  // falls back — but the bare `CSS` reference in the guard needs to resolve.
  g.CSS = { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };
  // dashboard-saved.js is NOT loaded here — the seam must not depend on it.
  delete (win as unknown as Record<string, unknown>).PolarisSavedDashboards;

  doc.body.innerHTML = PAGE_HTML;
  (0, eval)(SRC);
  doc.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));

  return {
    win,
    doc,
    seam: () => (win as unknown as Record<string, unknown>).PolarisDashboard as ReturnType<Boot["seam"]>,
    puts,
    store,
  };
}

function hidden(doc: Window["document"], id: string) {
  return doc.getElementById(id)!.hasAttribute("hidden");
}

beforeEach(() => {
  delete g.PolarisDashboard;
});

// Each boot() eval's ANOTHER live instance of dashboard.js, and every instance
// reads the BARE globals (`window`, `localStorage`, `api`) — so a debounced
// save queued by a previous case would land in the NEXT case's store, through
// the next case's POLARIS_DASH_LOCAL branch. Drain the 800ms debounce here,
// while this case's stubs are still the current ones.
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 850));
});

describe("PolarisDashboard seam — signed-in page", () => {
  it("snapshots the canvas on screen as a saved-dashboard payload", async () => {
    const b = await boot();
    const snap = b.seam().snapshot()!;
    expect(snap.name).toBe("My screen");
    expect(snap.layout.columns).toHaveLength(1);
    expect(b.seam().widgetCount()).toBe(1);
    // A CLONE, not the live array — the save modal must not be able to mutate
    // the canvas while the operator types a name.
    (snap.layout.columns as { widgets: unknown[] }[])[0].widgets.length = 0;
    expect(b.seam().snapshot()!.layout.columns[0]).toMatchObject({ id: "col-local" });
    expect(b.seam().widgetCount()).toBe(1);
  });

  it("Refresh re-fetches every widget on the canvas, and hides while customizing", async () => {
    const b = await boot();
    const fetches: string[] = [];
    const reg = g.PolarisWidgets as { getByType: (t: string) => unknown };
    reg.getByType = (type: string) => ({
      type, title: type, renderInstance: () => {},
      fetchData: async () => { fetches.push(type); return null; },
    });
    expect(hidden(b.doc, "dashboard-refresh")).toBe(false);
    const shell = b.doc.querySelector("#dashboard-canvas .dashboard-widget");
    b.doc.getElementById("dashboard-refresh")!.dispatchEvent(new b.win.Event("click", { bubbles: true }));
    expect(fetches).toEqual(["statusSummary"]);
    // Bodies remount in place; the widget's shell is the same element.
    expect(b.doc.querySelector("#dashboard-canvas .dashboard-widget")).toBe(shell);
    expect(b.puts).toHaveLength(0);

    b.doc.getElementById("dashboard-customize")!.dispatchEvent(new b.win.Event("click", { bubbles: true }));
    expect(hidden(b.doc, "dashboard-refresh")).toBe(true);
  });

  it("loads a saved row as a NEW tab, with fresh instance ids and unknown widgets dropped", async () => {
    const b = await boot();
    expect(b.seam().loadAsNewTab(PUBLISHED)).toBe(true);

    const snap = b.seam().snapshot()!;
    expect(snap.name).toBe("NOC overview");
    // The unknown-type widget and the column left empty by dropping one are gone.
    expect(snap.layout.columns).toHaveLength(1);
    const widgets = (snap.layout.columns as { widgets: { id: string; type: string; config: unknown }[] }[])[0].widgets;
    expect(widgets.map((w) => w.type)).toEqual(["downNodes"]);
    // Fresh instance id — the same widget may already sit on the viewer's own
    // canvas, and two identical ids would collide in the DOM and in unmounts.
    expect(widgets[0].id).not.toBe("w-pub");
    expect(widgets[0].config).toEqual({ limit: 20 });
    // The viewer's own tab is still there — loading is additive.
    expect(b.doc.getElementById("dashboard-tabs")!.hasAttribute("hidden")).toBe(false);
    expect(b.seam().publishedId()).toBeNull();
  });
});

describe("PolarisDashboard seam — viewing a published dashboard", () => {
  it("renders it instead of the local layout, with every edit affordance gone", async () => {
    const b = await boot({ wallboard: true });
    expect(b.seam().isWallboard()).toBe(true);
    // Baseline: the wallboard's own layout is editable. Adding a dashboard is
    // an edit-mode verb — the + after the last tab — so it appears only once
    // Customize Page is clicked; the old header Create button stays hidden.
    expect(hidden(b.doc, "dashboard-customize")).toBe(false);
    expect(b.doc.getElementById("dashboard-tab-add")).toBeNull();
    // The single dashboard's tab shows even out of edit mode.
    expect(hidden(b.doc, "dashboard-tabs")).toBe(false);
    (b.doc.getElementById("dashboard-customize") as unknown as { click: () => void }).click();
    expect(b.doc.getElementById("dashboard-tab-add")).not.toBeNull();
    expect(hidden(b.doc, "dashboard-create")).toBe(true);

    expect(b.seam().viewPublished(PUBLISHED)).toBe(true);
    expect(b.seam().publishedId()).toBe("pub-1");
    // Customize / Create / Add Widgets / Done all withdrawn, tab strip hidden
    // (a published dashboard is one screen), canvas still rendering.
    expect(hidden(b.doc, "dashboard-customize")).toBe(true);
    expect(hidden(b.doc, "dashboard-create")).toBe(true);
    expect(hidden(b.doc, "dashboard-add-widgets")).toBe(true);
    expect(hidden(b.doc, "dashboard-done")).toBe(true);
    expect(hidden(b.doc, "dashboard-tabs")).toBe(true);
    // Refresh is a viewing verb: it stays on a published dashboard.
    expect(hidden(b.doc, "dashboard-refresh")).toBe(false);
    expect(b.doc.querySelectorAll("#dashboard-canvas .dashboard-widget")).toHaveLength(1);
    // Nothing to publish while looking at someone else's screen.
    expect(b.seam().snapshot()).toBeNull();
  });

  it("cannot be edited into, and never persists over the viewer's own layout", async () => {
    const b = await boot({ wallboard: true });
    const before = b.store["polaris-dash-layout"];
    b.seam().viewPublished(PUBLISHED);

    // The button is hidden, but a stale click (or a keyboard path) must not
    // open edit mode on a dashboard the viewer cannot save.
    b.doc.getElementById("dashboard-customize")!.dispatchEvent(new b.win.Event("click", { bubbles: true }));
    expect(b.doc.getElementById("dashboard-canvas")!.classList.contains("is-editing")).toBe(false);

    // Give the 800ms save debounce more than enough time to fire.
    await new Promise((r) => setTimeout(r, 900));
    expect(b.store["polaris-dash-layout"]).toBe(before);
    expect(b.puts).toHaveLength(0);
  }, 10_000);

  it("goes back to the viewer's own layout on clearPublished", async () => {
    const b = await boot({ wallboard: true });
    b.seam().viewPublished(PUBLISHED);
    expect(b.seam().clearPublished()).toBe(true);
    expect(b.seam().publishedId()).toBeNull();
    expect(b.seam().snapshot()!.name).toBe("My screen");
    expect(hidden(b.doc, "dashboard-customize")).toBe(false);
  });

  it("says an EMPTY published dashboard is empty, then restores the page's own prompt", async () => {
    const b = await boot({ wallboard: true });
    b.seam().viewPublished({ ...PUBLISHED, name: "Blank screen", layout: { columns: [] } });
    const empty = b.doc.getElementById("dashboard-empty-state")!;
    expect(empty.hasAttribute("hidden")).toBe(false);
    expect(empty.textContent).toContain('"Blank screen" has no widgets');

    b.seam().clearPublished();
    // Back to the shipped prompt — the viewer's own layout has widgets, so the
    // empty state hides, but its TEXT must not stay stamped with someone
    // else's dashboard name for the next time it shows.
    expect(empty.innerHTML).toContain("Customize Page");
  });
});
