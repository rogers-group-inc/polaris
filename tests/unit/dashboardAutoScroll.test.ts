/**
 * tests/unit/dashboardAutoScroll.test.ts — the NOC auto-scroll's hold
 * (`startAutoScroll` in public/js/dashboard.js).
 *
 * A widget whose content overflows creeps through it 1px every 80ms. That
 * creep is a SCROLL of the widget body, and the row context menu — which is
 * position:fixed and mounted on <body>, so it cannot track its anchor — closes
 * on any scroll of a container holding its anchor. So clicking a row on an
 * overflowing widget opened a menu (Acknowledge alert… / Open device) that
 * vanished a tick later, before the operator could reach it. The hover pause
 * does not cover it: the menu is body-mounted, so moving the pointer onto the
 * menu is a mouseleave from the widget.
 *
 * The contract pinned here is the reading half — a widget body holding an
 * element stamped `data-rowmenu-open` does not scroll. The writing half (the
 * stamp itself, on every open and close path) is in rowContextMenu.test.ts;
 * the two files together are what keeps the menu reachable.
 *
 * dashboard.js is a classic browser script, so it is eval'd into a happy-dom
 * Window with the app-shell globals stubbed — the dashboardPublishedViewDom
 * idiom. happy-dom reports zero-size everything, so the widget body is given
 * an overflowing scrollHeight/clientHeight by hand; that pair is the ONLY
 * thing the scroller measures.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const SRC = readFileSync(resolve(__dirname, "../../public/js/dashboard.js"), "utf8");
const g = globalThis as Record<string, unknown>;

const STEP_MS = 80;          // the scroller's tick
const TOP_PAUSE_MS = 3000;   // its dwell at the top before the first creep

const PAGE_HTML =
  '<div class="page-header-actions">' +
    '<button id="dashboard-customize">Customize Page</button>' +
    '<button id="dashboard-add-widgets" hidden>Add Widgets</button>' +
    '<button id="dashboard-done" hidden>Done Editing</button>' +
    '<button id="dashboard-create">Create New Dashboard</button>' +
  "</div>" +
  '<div id="dashboard-tabs" class="dashboard-tabs" hidden></div>' +
  '<div id="dashboard-empty-state" class="dashboard-empty"></div>' +
  '<div id="dashboard-canvas" class="dashboard-canvas" hidden></div>';

function layout() {
  return {
    version: 3,
    activeId: "dash-local",
    dashboards: [
      {
        id: "dash-local",
        name: "My screen",
        columns: [{ id: "col-local", width: 6, widgets: [{ id: "w-local", type: "downNodes", height: 1, config: {} }] }],
      },
    ],
  };
}

let uuidSeq = 0;

interface Boot {
  win: InstanceType<typeof Window>;
  doc: Window["document"];
  body: HTMLElement;
  /** The widget's first row — the element a row menu would be anchored to. */
  row: HTMLElement;
  scrollTop: () => number;
}

/** Boot dashboard.js on one overflowing widget, with the clock already faked. */
async function boot(): Promise<Boot> {
  const win = new Window();
  const doc = win.document;
  const store: Record<string, string> = {};
  uuidSeq = 0;

  g.window = win;
  g.document = doc;
  delete (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL;

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
    me: { dashboard: { get: async () => layout(), put: async (l: unknown) => l } },
  };
  g.PolarisWidgets = {
    uuid: () => { uuidSeq += 1; return "uuid-" + uuidSeq; },
    getByType: (type: string) => ({
      type,
      title: "Down Assets",
      fetchData: async () => null,
      // A list long enough to overflow — the heights are stubbed below, but the
      // rows are real, because the stamp lands on one of them.
      renderInstance: (el: { innerHTML: string }) => {
        el.innerHTML = '<a class="dash-alert-item" data-asset-id="a1">core-sw-01</a>'
          + '<a class="dash-alert-item" data-asset-id="a2">core-sw-02</a>';
      },
    }),
    getAllowed: () => [],
    widgetTitle: () => "Down Assets",
  };
  g.WidgetLibrary = { open: () => {}, close: () => {}, isOpen: () => false };
  g.CSS = { escape: (s: string) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c) };

  doc.body.innerHTML = PAGE_HTML;
  (0, eval)(SRC);
  doc.dispatchEvent(new win.Event("DOMContentLoaded", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(0);

  const body = doc.querySelector(".dashboard-widget-body") as unknown as HTMLElement;
  expect(body, "no widget body rendered — the harness, not the scroller").toBeTruthy();
  // Overflow by hand: happy-dom lays nothing out, so every dimension is 0 and
  // the scroller would decide the content fits.
  Object.defineProperty(body, "scrollHeight", { value: 400, configurable: true });
  Object.defineProperty(body, "clientHeight", { value: 100, configurable: true });

  return {
    win,
    doc,
    body,
    row: body.querySelector(".dash-alert-item") as unknown as HTMLElement,
    scrollTop: () => body.scrollTop,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  delete g.PolarisDashboard;
});

afterEach(() => {
  // The widget's interval outlives the test otherwise — every boot leaves one
  // more scroller ticking over a dead Window.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("NOC auto-scroll", () => {
  it("creeps through an overflowing widget once the top pause is over", async () => {
    const b = await boot();
    await vi.advanceTimersByTimeAsync(TOP_PAUSE_MS - STEP_MS);
    expect(b.scrollTop(), "moved during the top pause").toBe(0);
    await vi.advanceTimersByTimeAsync(STEP_MS * 10);
    expect(b.scrollTop()).toBeGreaterThan(0);
  });

  it("holds while a row in the widget carries an open row menu, and settles before resuming", async () => {
    const b = await boot();
    await vi.advanceTimersByTimeAsync(TOP_PAUSE_MS + STEP_MS * 5);
    const creeping = b.scrollTop();
    expect(creeping).toBeGreaterThan(0);

    // The operator clicks the row: showRowMenu stamps it and opens a fixed menu
    // over the dashboard. One creep tick from here would close that menu.
    b.row.setAttribute("data-rowmenu-open", "");
    await vi.advanceTimersByTimeAsync(2000);
    expect(b.scrollTop(), "the widget moved under an open menu").toBe(creeping);

    // Menu closed. A short settle, so the list doesn't lurch out from under the
    // pointer the instant the menu disappears.
    b.row.removeAttribute("data-rowmenu-open");
    await vi.advanceTimersByTimeAsync(500);
    expect(b.scrollTop(), "resumed before the settle was over").toBe(creeping);
    await vi.advanceTimersByTimeAsync(1000);
    expect(b.scrollTop()).toBeGreaterThan(creeping);
  });

  it("is not held by a stamp in a DIFFERENT widget", async () => {
    // The hold is scoped to the body that holds the anchor: a menu opened on
    // one widget must not freeze the wall.
    const b = await boot();
    const elsewhere = b.doc.createElement("div") as unknown as HTMLElement;
    elsewhere.setAttribute("data-rowmenu-open", "");
    b.doc.body.appendChild(elsewhere as never);
    await vi.advanceTimersByTimeAsync(TOP_PAUSE_MS + STEP_MS * 5);
    expect(b.scrollTop()).toBeGreaterThan(0);
  });
});
