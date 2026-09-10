/**
 * tests/unit/widgetActiveAlertsActions.test.ts
 *
 * The Active Alerts widget's row verbs (public/js/widgets/activeAlerts.js +
 * PolarisWidgets.openAlertRow in public/js/widgets/index.js).
 *
 * openAssetRow (Down Assets) is for a row that is a DEVICE carrying an alert,
 * so its fallback is the device page. This one is for a row that IS the alert,
 * where the device is the optional part — an event-triggered or host_metric
 * alert has no asset at all. Those rows used to render as inert divs, which
 * left the alerts most likely to need a human (an agent disconnecting, a
 * failed sync, Polaris itself) the only ones the widget wouldn't let anyone
 * act on.
 *
 * The properties under test:
 *   • which verbs a row offers, and to whom — Acknowledge needs `alerts:write`
 *     and an unacknowledged alert, Clear needs `alerts:fullwrite`, Open device
 *     needs a device; a row left with only "Open device" opens it without
 *     asking, as the click always did, and a row with nothing to offer does
 *     nothing rather than opening an empty menu
 *   • that the act STICKS on screen. Both caches sit between the write and the
 *     next fetch (15s client memo over the route's 10s TTL), so a cleared row
 *     comes back from the feed and would read as a click that did nothing.
 *
 * Harness matches widgetDownNodesAckMenu.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface AlertRow {
  id: string;
  assetId?: string | null;
  hostname?: string | null;
  message?: string;
  severity: string;
  ruleName?: string | null;
  triggerType?: string | null;
  acknowledged?: boolean;
  acknowledgedBy?: string | null;
  raisedAt?: string;
}
interface Cfg { minSeverity?: string; rowLimit?: number | null; eventAlerts?: string }
interface WidgetModule {
  renderInstance: (el: unknown, config: Cfg, data: unknown, ctx: { onUnmount: (fn: () => void) => void }) => void;
}

let mod: WidgetModule;
let win: Window;
let doc: Window["document"];
const g = globalThis as Record<string, unknown>;

let menuItems: Array<{ label: string; onSelect: () => void }> | null;
let openedAsset: Array<[string, unknown]>;
let ackOpened: { alertId: string; opts: Record<string, unknown> } | null;
let cleared: string[][];
let toasts: Array<[string, string]>;
let confirmAnswer: boolean;
/** What the feed keeps handing back on every refresh — deliberately stale. */
let feedRows: AlertRow[];

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "5m ago";
  g.api = {
    alerts: {
      clear: (ids: string[]) => { cleared.push(ids); return Promise.resolve({ cleared: ids.length }); },
    },
  };
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8"));
  g.PolarisWidgets = (win as unknown as { PolarisWidgets: unknown }).PolarisWidgets;
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/activeAlerts.js"), "utf8"));
  const W = win as unknown as { PolarisWidgets: { getByType: (t: string) => WidgetModule } };
  mod = W.PolarisWidgets.getByType("activeAlerts");
});

/** The full in-app surface: app.js, the ack modules, a role that may do both. */
beforeEach(() => {
  menuItems = null;
  openedAsset = [];
  ackOpened = null;
  cleared = [];
  toasts = [];
  confirmAnswer = true;
  feedRows = [];
  const w = win as unknown as Record<string, unknown>;
  w.showRowMenu = (_anchor: unknown, items: Array<{ label: string; onSelect: () => void }>) => {
    menuItems = items.filter((i) => i && i.label);
  };
  w.openModal = () => {};
  w.openViewModal = (id: string, opts: unknown) => { openedAsset.push([id, opts]); };
  w.permAtLeast = () => true;
  w.showConfirm = () => Promise.resolve(confirmAnswer);
  w.showToast = (msg: string, kind: string) => { toasts.push([msg, kind]); };
  w.PolarisAlertAckModal = {
    open: (alertId: string, opts: Record<string, unknown>) => { ackOpened = { alertId, opts }; },
  };
  w.POLARIS_DASH_LOCAL = undefined;
  // Stand in for the memoized feed accessor rather than going through it: its
  // cache is module-level and 15s, so one test's payload would be served to
  // the next test's refresh. Serving `feedRows` straight back IS the stale
  // read the widget's overrides exist for.
  (w.PolarisWidgets as { getNocSummary: unknown }).getNocSummary = () =>
    Promise.resolve({ activeAlerts: feedRows, activeAlertsTotal: feedRows.length });
  doc.body.innerHTML = "";
});

function mountWidget() {
  const article = doc.createElement("article");
  article.className = "dashboard-widget";
  article.setAttribute("data-type", "activeAlerts");
  article.innerHTML =
    '<div class="dashboard-widget-header"><h3 class="dashboard-widget-title">Active Alerts</h3></div>' +
    '<div class="body"></div>';
  doc.body.appendChild(article);
  return article.querySelector(".body") as unknown as HTMLElement;
}

const alert = (o: Partial<AlertRow> & { id: string }): AlertRow => ({
  assetId: null, hostname: null, message: "m", severity: "critical",
  ruleName: "Agent disconnected", triggerType: "event", acknowledged: false,
  raisedAt: "2026-09-05T00:00:00Z", ...o,
});

/** Render rows, click the first one, hand back the live body + teardown. */
function mountAndClick(rows: AlertRow[], config: Cfg = { minSeverity: "warning", rowLimit: 50 }) {
  const el = mountWidget();
  const cleanups: Array<() => void> = [];
  mod.renderInstance(el, config, { rows, total: rows.length }, { onUnmount: (fn) => cleanups.push(fn) });
  const row = el.querySelector(".recent-item") as unknown as HTMLElement;
  const ev = new (win as any).MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  row.dispatchEvent(ev as unknown as Event);
  return { el, ev, teardown: () => cleanups.forEach((fn) => fn()) };
}

const labels = () => (menuItems || []).map((i) => i.label);
const pick = (label: string) => (menuItems || []).find((i) => i.label === label)!.onSelect();
const rowIds = (el: HTMLElement) =>
  Array.from(el.querySelectorAll(".recent-item")).map((r: any) => r.getAttribute("data-alert-id"));
/** Let the confirm → clear → repaint promise chain settle. */
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("which verbs a row offers", () => {
  it("offers Acknowledge and Clear on an alert with NO device — the case that used to be inert", () => {
    const { ev, teardown } = mountAndClick([alert({ id: "n1" })]);
    expect(ev.defaultPrevented).toBe(true);
    expect(labels()).toEqual(["Acknowledge alert…", "Clear alert"]);
    teardown();
  });

  it("adds Open device when the alert names one", () => {
    const { teardown } = mountAndClick([alert({ id: "n1", assetId: "asset-9", hostname: "sw-1" })]);
    expect(labels()).toEqual(["Acknowledge alert…", "Clear alert", "Open device"]);
    pick("Open device");
    // The device opens on ITS Alerts tab — the alert, not the General tab the
    // operator would then have to leave.
    expect(openedAsset).toEqual([["asset-9", { tab: "notifications" }]]);
    teardown();
  });

  it("drops Acknowledge from an alert someone already owns", () => {
    const { teardown } = mountAndClick([alert({ id: "n1", acknowledged: true, acknowledgedBy: "jsmith" })]);
    expect(labels()).toEqual(["Clear alert"]);
    teardown();
  });

  it("withholds a verb the role cannot perform", () => {
    // A courtesy, not the control — both routes gate server-side either way.
    (win as unknown as Record<string, unknown>).permAtLeast = (_k: string, level: string) => level !== "fullwrite";
    const { teardown } = mountAndClick([alert({ id: "n1" })]);
    expect(labels()).toEqual(["Acknowledge alert…"]);
    teardown();
  });

  it("opens the device without asking when that is the only verb left", () => {
    (win as unknown as Record<string, unknown>).permAtLeast = () => false;
    const { teardown } = mountAndClick([alert({ id: "n1", assetId: "asset-9" })]);
    expect(menuItems).toBeNull();
    expect(openedAsset).toEqual([["asset-9", { tab: "notifications" }]]);
    teardown();
  });

  it("does nothing on a device-less alert a read-only role cannot act on", () => {
    (win as unknown as Record<string, unknown>).permAtLeast = () => false;
    const { teardown } = mountAndClick([alert({ id: "n1" })]);
    expect(menuItems).toBeNull();
    expect(openedAsset).toEqual([]);
    teardown();
  });

  it("asks nothing on the /dash wallboard, which loads neither app.js nor the dialogs", () => {
    (win as unknown as Record<string, unknown>).POLARIS_DASH_LOCAL = true;
    const { teardown } = mountAndClick([alert({ id: "n1", assetId: "asset-9" })]);
    expect(menuItems).toBeNull();
    teardown();
  });
});

describe("acting on the alert", () => {
  it("hands the alert to the acknowledge modal, and stamps the owner the SERVER reports", async () => {
    feedRows = [alert({ id: "n1" })]; // the feed keeps saying unacknowledged
    const { el, teardown } = mountAndClick([alert({ id: "n1" })]);
    pick("Acknowledge alert…");
    expect(ackOpened!.alertId).toBe("n1");
    // The modal re-reads after the write, so who owns it is the server's
    // answer rather than an assumption about who clicked.
    (ackOpened!.opts.onAcknowledged as (a: unknown) => void)({ id: "n1", acknowledged: true, acknowledgedBy: "jsmith" });
    await settle();
    const pill = el.querySelector(".widget-pill-neutral") as any;
    expect(pill.textContent).toBe("ack jsmith");
    teardown();
  });

  it("clears the alert and keeps it off screen while the cached feed still sends it", async () => {
    feedRows = [alert({ id: "n1" }), alert({ id: "n2" })];
    const { el, teardown } = mountAndClick(feedRows.slice());
    pick("Clear alert");
    await settle();
    expect(cleared).toEqual([["n1"]]);
    expect(toasts).toEqual([["Alert cleared", "success"]]);
    // The refresh that follows re-serves BOTH rows from the cache; the cleared
    // one must not come back, or the click reads as having done nothing.
    expect(rowIds(el)).toEqual(["n2"]);
    teardown();
  });

  it("leaves the alert alone when the confirm is declined", async () => {
    confirmAnswer = false;
    feedRows = [alert({ id: "n1" })];
    const { el, teardown } = mountAndClick([alert({ id: "n1" })]);
    pick("Clear alert");
    await settle();
    expect(cleared).toEqual([]);
    expect(rowIds(el)).toEqual(["n1"]);
    teardown();
  });

  it("reports what the SERVER did — a no-op clear is not a success", async () => {
    (g.api as { alerts: { clear: (ids: string[]) => Promise<unknown> } }).alerts.clear =
      () => Promise.resolve({ cleared: 0 });
    feedRows = [alert({ id: "n1" })];
    const { teardown } = mountAndClick([alert({ id: "n1" })]);
    pick("Clear alert");
    await settle();
    expect(toasts).toEqual([["That alert was already cleared", "error"]]);
    teardown();
  });

  it("surfaces a refused clear as a toast, not a silent nothing", async () => {
    (g.api as { alerts: { clear: (ids: string[]) => Promise<unknown> } }).alerts.clear =
      () => Promise.reject(Object.assign(new Error("Forbidden"), { status: 403 }));
    feedRows = [alert({ id: "n1" })];
    const { el, teardown } = mountAndClick([alert({ id: "n1" })]);
    pick("Clear alert");
    await settle();
    expect(toasts).toEqual([["Forbidden", "error"]]);
    expect(rowIds(el)).toEqual(["n1"]);
    teardown();
  });
});
