/**
 * tests/unit/widgetMaintenanceSchedulesActions.test.ts
 *
 * The Active Maintenance widget (public/js/widgets/maintenanceSchedules.js):
 * its row verbs, its expiry readout, and the one filter rule that differs from
 * every other NOC widget's.
 *
 * The properties under test:
 *   • the window EXPIRY is the server's own wall clock, printed verbatim — the
 *     recurrence engine evaluates against the Polaris server's zone, so a
 *     browser that re-derives the time from the instant paints the window on
 *     the wrong hour. The countdown beside it is the only thing computed from
 *     the instant.
 *   • which verbs a row offers, and to whom — Open schedule needs the
 *     maintenance modal on the page, Disable needs the shared writer plus a
 *     confirm; a role below maintenanceManagement:fullwrite (and the /dash
 *     wallboard, which loads neither) gets no menu rather than an empty one.
 *   • that a disable STICKS on screen. The feed's 15s client memo sits over the
 *     route's 10s TTL, so the disabled schedule comes straight back and the
 *     click would read as a no-op.
 *
 * Harness matches widgetActiveAlertsActions.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface SchedRow {
  id: string;
  name: string;
  deviceCount: number;
  matchedCount: number;
  filtered: boolean;
  assetTypes: Array<{ assetType: string; count: number }>;
  kind: string;
  adhoc: boolean;
  suppressChildren: boolean;
  startedAt: string | null;
  endsAt: string | null;
  endsAtUtc: string | null;
}
interface Cfg { rowLimit?: number | null; sortBy?: string }
interface WidgetModule {
  renderInstance: (el: unknown, config: Cfg, data: unknown, ctx: { onUnmount: (fn: () => void) => void }) => void;
}

let mod: WidgetModule;
let win: Window;
let doc: Window["document"];
const g = globalThis as Record<string, unknown>;

let menuItems: Array<{ label: string; onSelect: () => void }> | null;
let openedModal: Array<Record<string, unknown>>;
let enabledCalls: Array<[string, boolean]>;
let toasts: Array<[string, string]>;
let confirmAnswer: boolean;
let mayManage: boolean;
/** What the feed keeps handing back on every refresh — deliberately stale. */
let feedRows: SchedRow[];

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.api = {};
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8"));
  g.PolarisWidgets = (win as unknown as { PolarisWidgets: unknown }).PolarisWidgets;
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/maintenanceSchedules.js"), "utf8"));
  const W = win as unknown as { PolarisWidgets: { getByType: (t: string) => WidgetModule } };
  mod = W.PolarisWidgets.getByType("maintenanceSchedules");
});

/** The full in-app surface: app.js, the maintenance modal, a role that may manage. */
beforeEach(() => {
  menuItems = null;
  openedModal = [];
  enabledCalls = [];
  toasts = [];
  confirmAnswer = true;
  mayManage = true;
  feedRows = [];
  const w = win as unknown as Record<string, unknown>;
  w.showRowMenu = (_anchor: unknown, items: Array<{ label: string; onSelect: () => void }>) => {
    menuItems = items.filter((i) => i && i.label);
  };
  w.canManageMaintenance = () => mayManage;
  w.openMaintenanceModal = (opts: Record<string, unknown>) => { openedModal.push(opts); };
  w.maintSetScheduleEnabled = (id: string, enabled: boolean) => {
    enabledCalls.push([id, enabled]);
    return Promise.resolve({});
  };
  w.showConfirm = () => Promise.resolve(confirmAnswer);
  w.showToast = (msg: string, kind: string) => { toasts.push([msg, kind]); };
  w.POLARIS_DASH_LOCAL = undefined;
  // Stand in for the memoized feed accessor: its cache is module-level and
  // 15s, so one test's payload would be served to the next test's refresh.
  // Handing `feedRows` straight back IS the stale read the overrides exist for.
  (w.PolarisWidgets as { getNocSummary: unknown }).getNocSummary = () =>
    Promise.resolve({ maintenanceSchedules: feedRows });
  doc.body.innerHTML = "";
});

function mountWidget() {
  const article = doc.createElement("article");
  article.className = "dashboard-widget";
  article.setAttribute("data-type", "maintenanceSchedules");
  article.innerHTML =
    '<div class="dashboard-widget-header"><h3 class="dashboard-widget-title">Active Maintenance</h3></div>' +
    '<div class="body"></div>';
  doc.body.appendChild(article);
  return article.querySelector(".body") as unknown as HTMLElement;
}

/** Ends `mins` from now, with the wall clock stated independently. */
const sched = (o: Partial<SchedRow> & { id: string }): SchedRow => ({
  name: "Switch firmware",
  deviceCount: 3,
  matchedCount: 3,
  filtered: false,
  assetTypes: [{ assetType: "switch", count: 2 }, { assetType: "access_point", count: 1 }],
  kind: "oneshot",
  adhoc: false,
  suppressChildren: true,
  startedAt: "2026-07-10T11:00",
  endsAt: "2026-07-10T14:00",
  endsAtUtc: new Date(Date.now() + 90 * 60000).toISOString(),
  ...o,
});

function mount(rows: SchedRow[], config: Cfg = { rowLimit: 10 }) {
  const el = mountWidget();
  const cleanups: Array<() => void> = [];
  mod.renderInstance(el, config, rows, { onUnmount: (fn) => cleanups.push(fn) });
  return { el, teardown: () => cleanups.forEach((fn) => fn()) };
}

function clickFirst(el: HTMLElement) {
  const row = el.querySelector(".recent-item") as unknown as HTMLElement;
  const ev = new (win as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  row.dispatchEvent(ev as unknown as Event);
  return ev;
}

const labels = () => (menuItems || []).map((i) => i.label);
const pick = (label: string) => (menuItems || []).find((i) => i.label === label)!.onSelect();
const rowIds = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(".recent-item")).map((r: any) => r.getAttribute("data-schedule-id"));
/** Let the confirm → write → repaint promise chain settle. */
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("what a row says", () => {
  it("prints the window end in the SERVER's wall clock, not the browser's zone", () => {
    const { el, teardown } = mount([sched({ id: "s1" })]);
    // 2026-07-10T14:00 server-local — no instant is parsed to produce this, so
    // the viewer's timezone cannot move it.
    expect(el.innerHTML).toContain("Jul 10, 14:00");
    teardown();
  });

  it("counts down from the instant, which is the only form that can be", () => {
    // +30s of slack: the countdown floors whole minutes, so an exact 90 min
    // reads as 1h 29m by the time the row renders.
    const { el, teardown } = mount([sched({ id: "s1", endsAtUtc: new Date(Date.now() + 90.5 * 60000).toISOString() })]);
    expect(el.textContent).toContain("1h 30m");
    teardown();
  });

  it("names every asset type in the schedule and the device total", () => {
    const { el, teardown } = mount([sched({ id: "s1" })]);
    expect(el.textContent).toContain("3 devices");
    expect(el.textContent).toContain("Switch 2");
    expect(el.textContent).toContain("AP 1");
    teardown();
  });

  it("says how much of a partly-matched schedule the filter claimed", () => {
    // The filter rule this widget exists to get right: the schedule is listed
    // WHOLE (3 devices, every type), with the in-scope share stated.
    const { el, teardown } = mount([sched({ id: "s1", matchedCount: 1, filtered: true })]);
    expect(el.textContent).toContain("3 devices");
    expect(el.textContent).toContain("1 in this scope");
    teardown();
  });

  it("reads 'ending' for a schedule whose occurrence has passed while its rows stay open", () => {
    const { el, teardown } = mount([sched({ id: "s1", endsAt: null, endsAtUtc: null, startedAt: null })]);
    expect(el.textContent).toContain("ending");
    teardown();
  });

  it("renders the empty state when nothing is in maintenance", () => {
    const { el, teardown } = mount([]);
    expect(el.textContent).toContain("No maintenance windows are open");
    teardown();
  });
});

describe("the + New schedule button", () => {
  const bar = (el: HTMLElement) => el.querySelector("[data-maint-new]");

  it("sits above the list, and above the EMPTY state too", () => {
    const withRows = mount([sched({ id: "s1" })]);
    expect(bar(withRows.el)).not.toBeNull();
    withRows.teardown();

    // The empty widget is exactly when someone wants to schedule something.
    const empty = mount([]);
    expect(bar(empty.el)).not.toBeNull();
    expect(empty.el.textContent).toContain("No maintenance windows are open");
    empty.teardown();
  });

  it("opens the maintenance editor with no schedule loaded — a CREATE", () => {
    const { el, teardown } = mount([sched({ id: "s1" })]);
    (bar(el) as any).dispatchEvent(
      new (win as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    expect(openedModal).toEqual([{}]);
    teardown();
  });

  it("is withheld below maintenanceManagement:fullwrite", () => {
    mayManage = false;
    const { el, teardown } = mount([sched({ id: "s1" })]);
    expect(bar(el)).toBeNull();
    teardown();
  });

  it("is withheld on the /dash wallboard, which cannot open a modal", () => {
    (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL = true;
    const { el, teardown } = mount([sched({ id: "s1" })]);
    expect(bar(el)).toBeNull();
    teardown();
  });

  it("is withheld where the maintenance modal is not loaded at all", () => {
    delete (win as unknown as Record<string, unknown>).openMaintenanceModal;
    const { el, teardown } = mount([sched({ id: "s1" })]);
    expect(bar(el)).toBeNull();
    teardown();
  });
});

describe("which verbs a row offers", () => {
  it("offers review and disable to a role that may manage maintenance", () => {
    const { el, teardown } = mount([sched({ id: "s1" })]);
    const ev = clickFirst(el);
    expect(ev.defaultPrevented).toBe(true);
    expect(labels()).toEqual(["Open schedule…", "Disable schedule"]);
    teardown();
  });

  it("opens the maintenance modal ON that schedule", () => {
    const { el, teardown } = mount([sched({ id: "s1" })]);
    clickFirst(el);
    pick("Open schedule…");
    expect(openedModal).toEqual([{ scheduleId: "s1" }]);
    teardown();
  });

  it("offers nothing to a role below maintenanceManagement:fullwrite", () => {
    mayManage = false;
    const { el, teardown } = mount([sched({ id: "s1" })]);
    clickFirst(el);
    expect(menuItems).toBeNull();
    teardown();
  });

  it("offers nothing on the /dash wallboard, which loads no dialogs", () => {
    (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL = true;
    const { el, teardown } = mount([sched({ id: "s1" })]);
    clickFirst(el);
    expect(menuItems).toBeNull();
    // …and the row doesn't claim a click it can't honour.
    expect((el.querySelector(".recent-item") as any).className).not.toContain("recent-item-link");
    teardown();
  });
});

describe("disabling from the widget", () => {
  it("confirms, writes, toasts, and drops the row over a stale feed", async () => {
    feedRows = [sched({ id: "s1" }), sched({ id: "s2", name: "DC power" })];
    const { el, teardown } = mount(feedRows);
    clickFirst(el);
    pick("Disable schedule");
    await settle();

    expect(enabledCalls).toEqual([["s1", false]]);
    expect(toasts[0]?.[0]).toBe("Schedule disabled");
    // The feed still serves s1 (15s memo over a 10s TTL); the row is gone
    // anyway, which is what makes the click mean something.
    expect(rowIds(el)).toEqual(["s2"]);
    teardown();
  });

  it("writes nothing when the operator declines the confirm", async () => {
    confirmAnswer = false;
    feedRows = [sched({ id: "s1" })];
    const { el, teardown } = mount(feedRows);
    clickFirst(el);
    pick("Disable schedule");
    await settle();

    expect(enabledCalls).toEqual([]);
    expect(rowIds(el)).toEqual(["s1"]);
    teardown();
  });

  it("reports a failed write and keeps the row", async () => {
    (win as unknown as Record<string, unknown>).maintSetScheduleEnabled = () =>
      Promise.reject(new Error("Schedule is gone"));
    feedRows = [sched({ id: "s1" })];
    const { el, teardown } = mount(feedRows);
    clickFirst(el);
    pick("Disable schedule");
    await settle();

    expect(toasts).toEqual([["Schedule is gone", "error"]]);
    expect(rowIds(el)).toEqual(["s1"]);
    teardown();
  });
});
