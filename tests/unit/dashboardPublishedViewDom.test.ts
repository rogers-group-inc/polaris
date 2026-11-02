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
 *   linkActiveTab()  — the wallboard: the ACTIVE tab shows a published row,
 *                      read-only, and follows it (applyPublished) — while the
 *                      other tabs and the pencil stay
 *
 * The last one is the load-bearing case: the published layout is someone
 * else's, so nothing on a linked tab may edit, and the rest of the viewer's
 * own layout must survive it. Also here: renderWidget's stale-render guard.
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

/** A stored layout: two tabs (the active one first), one column, one widget each. */
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
      {
        id: "dash-other",
        name: "Other screen",
        columns: [{ id: "col-other", width: 6, widgets: [{ id: "w-other", type: "statusSummary", height: 1, config: {} }] }],
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
    linkActiveTab: (row: unknown) => boolean;
    linkedTabs: () => { tabId: string; publishedId: string; updatedAt: string | null }[];
    applyPublished: (row: unknown) => number;
    unlinkTab: (tabId?: string) => boolean;
    unlinkPublished: (id: string) => number;
    setWidgetConfig: (id: string, key: string, value: unknown) => boolean;
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

describe("PolarisDashboard seam — a tab linked to a published dashboard", () => {
  const click = (b: Boot, id: string) => (b.doc.getElementById(id) as unknown as { click: () => void }).click();
  const stored = (b: Boot) => JSON.parse(b.store["polaris-dash-layout"]) as {
    activeId: string;
    dashboards: { id: string; name: string; published?: { id: string; updatedAt: string | null }; columns: { widgets: { type: string }[] }[] }[];
  };

  it("shows it on the ACTIVE tab, keeping the other tabs and the pencil", async () => {
    const b = await boot({ wallboard: true });
    expect(b.seam().isWallboard()).toBe(true);
    expect(b.seam().linkActiveTab(PUBLISHED)).toBe(true);
    expect(b.seam().publishedId()).toBe("pub-1");

    // The tab strip stays, the active tab now named for the published
    // dashboard and marked linked; the other tab is untouched.
    expect(hidden(b.doc, "dashboard-tabs")).toBe(false);
    const tabs = Array.from(b.doc.querySelectorAll(".dashboard-tab"));
    expect(tabs.map((t) => t.textContent!.trim())).toEqual(["NOC overview", "Other screen"]);
    expect(tabs[0].classList.contains("linked")).toBe(true);
    expect(tabs[0].classList.contains("active")).toBe(true);
    expect(tabs[1].classList.contains("linked")).toBe(false);
    // The pencil stays: the other tabs are still the viewer's to edit.
    expect(hidden(b.doc, "dashboard-customize")).toBe(false);
    expect(hidden(b.doc, "dashboard-refresh")).toBe(false);
    // The published widgets, unknown types dropped.
    const shells = Array.from(b.doc.querySelectorAll("#dashboard-canvas .dashboard-widget"));
    expect(shells.map((s) => s.getAttribute("data-type"))).toEqual(["downNodes"]);
    // Nothing to publish from someone else's dashboard.
    expect(b.seam().snapshot()).toBeNull();
  });

  it("is stored with the layout, link and widgets together, so a reboot paints it", async () => {
    const b = await boot({ wallboard: true });
    b.seam().linkActiveTab(PUBLISHED);
    await new Promise((r) => setTimeout(r, 850));
    const layout = stored(b);
    expect(layout.dashboards).toHaveLength(2);
    expect(layout.dashboards[0].published).toMatchObject({ id: "pub-1", updatedAt: "2026-09-02T00:00:00.000Z" });
    expect(layout.dashboards[0].columns[0].widgets.map((w) => w.type)).toEqual(["downNodes"]);
    expect(layout.dashboards[1].name).toBe("Other screen");
    expect(b.puts).toHaveLength(0); // the wallboard saves to this browser only
  }, 10_000);

  it("customizing a linked tab offers no edit controls on it, but the other tabs still edit", async () => {
    const b = await boot({ wallboard: true });
    b.seam().linkActiveTab(PUBLISHED);
    click(b, "dashboard-customize");
    const canvas = b.doc.getElementById("dashboard-canvas")!;
    expect(hidden(b.doc, "dashboard-done")).toBe(false);
    expect(canvas.classList.contains("is-editing")).toBe(false);
    expect(canvas.querySelector(".dashboard-linked-note")).not.toBeNull();
    expect(canvas.querySelector(".dashboard-widget-grip")).toBeNull();
    expect(canvas.querySelector('[data-action="gear"]')).toBeNull();
    expect(canvas.querySelector(".dashboard-column-add")).toBeNull();
    expect(canvas.querySelector(".dashboard-newcol-target")).toBeNull();
    // Its name follows the publisher, so no inline rename input.
    expect(b.doc.querySelector(".dashboard-tab-name-input")).toBeNull();
    // A header control's config write is refused on it.
    const wid = canvas.querySelector(".dashboard-widget")!.getAttribute("data-id")!;
    expect(b.seam().setWidgetConfig(wid, "limit", 5)).toBe(false);

    // Switching to the viewer's own tab brings the edit controls back.
    (b.doc.querySelector('.dashboard-tab[data-dash="dash-other"]') as unknown as { click: () => void }).click();
    expect(canvas.classList.contains("is-editing")).toBe(true);
    expect(canvas.querySelector(".dashboard-linked-note")).toBeNull();
    expect(canvas.querySelector(".dashboard-widget-grip")).not.toBeNull();
    expect(b.seam().publishedId()).toBeNull();
  });

  it("Unlink keeps the widgets as an ordinary, editable tab", async () => {
    const b = await boot({ wallboard: true });
    b.seam().linkActiveTab(PUBLISHED);
    click(b, "dashboard-customize");
    (b.doc.querySelector('.dashboard-linked-note [data-action="unlink"]') as unknown as { click: () => void }).click();
    expect(b.seam().publishedId()).toBeNull();
    const canvas = b.doc.getElementById("dashboard-canvas")!;
    expect(canvas.classList.contains("is-editing")).toBe(true);
    expect(canvas.querySelector(".dashboard-widget-grip")).not.toBeNull();
    expect(b.seam().snapshot()!.name).toBe("NOC overview");
    expect(b.seam().widgetCount()).toBe(1);
  });

  it("follows the publisher: a newer row replaces the linked copy, an unchanged one is a no-op", async () => {
    const b = await boot({ wallboard: true });
    b.seam().linkActiveTab(PUBLISHED);
    expect(b.seam().linkedTabs()).toEqual([{ tabId: "dash-local", publishedId: "pub-1", updatedAt: "2026-09-02T00:00:00.000Z" }]);
    // Same updatedAt: nothing moves (no re-render blink on the wallboard).
    expect(b.seam().applyPublished(PUBLISHED)).toBe(0);

    const edited = {
      ...PUBLISHED, name: "NOC overview v2", updatedAt: "2026-09-03T00:00:00.000Z",
      layout: { columns: [{ id: "c", width: 12, widgets: [{ id: "x", type: "statusSummary", height: 1, config: {} }, { id: "y", type: "downNodes", height: 1, config: {} }] }] },
    };
    expect(b.seam().applyPublished(edited)).toBe(1);
    expect(b.doc.querySelector(".dashboard-tab.active")!.textContent!.trim()).toBe("NOC overview v2");
    expect(b.doc.querySelectorAll("#dashboard-canvas .dashboard-widget")).toHaveLength(2);
  });

  it("a published dashboard that is gone unlinks its tab, which keeps the last copy", async () => {
    const b = await boot({ wallboard: true });
    b.seam().linkActiveTab(PUBLISHED);
    expect(b.seam().unlinkPublished("pub-1")).toBe(1);
    expect(b.seam().publishedId()).toBeNull();
    expect(b.doc.querySelectorAll("#dashboard-canvas .dashboard-widget")).toHaveLength(1);
  });

  it("says an EMPTY published dashboard is empty, then restores the page's own prompt", async () => {
    const b = await boot({ wallboard: true });
    b.seam().linkActiveTab({ ...PUBLISHED, name: "Blank screen", layout: { columns: [] } });
    const empty = b.doc.getElementById("dashboard-empty-state")!;
    expect(empty.hasAttribute("hidden")).toBe(false);
    expect(empty.textContent).toContain('"Blank screen" has no widgets');

    // Switching to the viewer's own tab: back to the shipped prompt — its TEXT
    // must not stay stamped with someone else's dashboard name for the next
    // time it shows.
    (b.doc.querySelector('.dashboard-tab[data-dash="dash-other"]') as unknown as { click: () => void }).click();
    expect(empty.innerHTML).toContain("Customize Page");
  });
});

describe("renderWidget — only the latest render of a widget draws", () => {
  // The gear's FortiGates picker writes two config keys back to back: two
  // renderWidget calls into the SAME body while the first one's fetchData is
  // still in flight. Both used to draw — a stale instance (a Leaflet map, a
  // second Cytoscape graph) stacked in the body and never unmounted.
  it("a superseded render neither draws nor leaks", async () => {
    const b = await boot();
    const resolvers: Array<(v: unknown) => void> = [];
    const drawn: string[] = [];
    const reg = g.PolarisWidgets as { getByType: (t: string) => unknown };
    reg.getByType = (type: string) => ({
      type, title: type,
      fetchData: (config: { tag?: string }) => new Promise((r) => resolvers.push(() => r(config.tag))),
      renderInstance: (el: { appendChild: (n: unknown) => void }, _c: unknown, tag: string) => {
        drawn.push(tag);
        const p = b.doc.createElement("p");
        p.className = "drawn";
        el.appendChild(p);
      },
    });
    click(b, "dashboard-customize");
    resolvers.length = 0; // the edit-mode render's own fetch is not under test
    b.seam().setWidgetConfig("w-local", "tag", "first");
    b.seam().setWidgetConfig("w-local", "tag", "second");
    expect(resolvers).toHaveLength(2);
    // The SLOWER, older fetch resolving last is the dangerous order.
    resolvers[1](null);
    resolvers[0](null);
    await new Promise((r) => setTimeout(r, 0));
    expect(drawn).toEqual(["second"]);
    expect(b.doc.querySelectorAll(".dashboard-widget-body .drawn")).toHaveLength(1);
  });

  function click(b: Boot, id: string) { (b.doc.getElementById(id) as unknown as { click: () => void }).click(); }
});
