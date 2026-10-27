/**
 * tests/unit/widgetDownNodesAckMenu.test.ts
 *
 * The Down Assets widget's click-through (public/js/widgets/downNodes.js +
 * PolarisWidgets.openAssetRow in public/js/widgets/index.js).
 *
 * A row on this widget is a prompt to do one of two things — put your name on
 * the alert, or go look at the device. A plain left-click opens the device
 * ("Open device" is the menu's primary item); a right click is the menu. The
 * property under test is when the menu offers Acknowledge and when it doesn't,
 * because every "doesn't" is a case where the verb would be a dead end:
 *
 *   • nothing to acknowledge  — a down device no automation covers (business
 *                               rule 36's `passive`) carries no alert at all
 *   • already acknowledged    — someone owns it; re-acknowledging is a no-op
 *                               the server skips
 *   • no dialogs on the page  — the /dash wallboard loads neither app.js nor
 *                               the acknowledge modules
 *   • the role may not ack    — offering a verb that 403s is worse than not
 *                               offering it (the row-menu canon)
 *
 * Harness matches widgetActiveAlerts.test.ts: index.js is eval'd first so the
 * widget finds its PolarisWidgets helpers, then downNodes.js registers itself.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface Node {
  id: string;
  hostname?: string | null;
  ipAddress?: string | null;
  assetType?: string;
  site?: string;
  division?: string | null;
  monitorStatus?: string;
  monitorStatusChangedAt?: string | null;
  dependencySuppressed?: boolean;
  alertSeverity?: string;
  alertId?: string;
  alertAcknowledged?: boolean;
  alertAcknowledgedBy?: string | null;
  alertAcknowledgeNote?: string | null;
}
interface Cfg { groupBy?: string; rowLimit?: number | null; hideAcknowledged?: boolean }
interface WidgetModule {
  type: string;
  renderInstance: (el: unknown, config: Cfg, data: unknown, ctx: { onUnmount: (fn: () => void) => void }) => void;
  renderConfig: (el: unknown, config: Cfg, onChange: (k: string, v: unknown) => void) => void;
}

let mod: WidgetModule;
let win: Window;
let doc: Window["document"];
const g = globalThis as Record<string, unknown>;

/** What the click ended up doing, per test. */
let menuItems: Array<{ label: string; onSelect: () => void; primary?: boolean }> | null;
let menuAnchor: unknown;
/** True while the click under test is a right click (app.js's forced menu). */
let forceMenu = false;
let openedAsset: string | null;
let ackOpened: { alertId: string; opts: Record<string, unknown> } | null;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "5m ago";
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8"));
  g.PolarisWidgets = (win as unknown as { PolarisWidgets: unknown }).PolarisWidgets;
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/downNodes.js"), "utf8"));
  const W = win as unknown as { PolarisWidgets: { getByType: (t: string) => WidgetModule } };
  mod = W.PolarisWidgets.getByType("downNodes");
});

/** The full in-app surface: a page with app.js, the ack modules, and a role
 *  that may acknowledge. Each test narrows from here. */
beforeEach(() => {
  menuItems = null;
  menuAnchor = null;
  openedAsset = null;
  ackOpened = null;
  forceMenu = false;
  const w = win as unknown as Record<string, unknown>;
  // showRowMenu's contract (app.js): a plain click runs the primary item, a
  // right click draws the menu.
  w.showRowMenu = (anchor: unknown, items: Array<{ label: string; onSelect: () => void; primary?: boolean }>) => {
    const primary = items.find((i) => i && i.primary);
    if (!forceMenu && primary) { primary.onSelect(); return; }
    menuAnchor = anchor;
    menuItems = items.filter((i) => i && i.label);
  };
  w.openModal = () => {};
  w.openViewModal = (id: string) => { openedAsset = id; };
  w.permAtLeast = () => true;
  w.PolarisAlertAckModal = {
    open: (alertId: string, opts: Record<string, unknown>) => { ackOpened = { alertId, opts }; },
  };
  w.POLARIS_DASH_LOCAL = undefined;
  doc.body.innerHTML = "";
});

function mountWidget() {
  const article = doc.createElement("article");
  article.className = "dashboard-widget";
  article.setAttribute("data-type", "downNodes");
  article.innerHTML =
    '<div class="dashboard-widget-header"><h3 class="dashboard-widget-title">Down Assets</h3></div>' +
    '<div class="body"></div>';
  doc.body.appendChild(article);
  return article.querySelector(".body") as unknown as HTMLElement;
}

const node = (o: Partial<Node> & { id: string }): Node => ({
  hostname: "sw-" + o.id, ipAddress: "10.0.0.1", assetType: "switch", site: "Plant A",
  division: "Ops", monitorStatus: "down", monitorStatusChangedAt: "2026-08-30T00:00:00Z",
  dependencySuppressed: false, ...o,
});

/** Render, click the first row (`menu`: a right click), hand back what happened. */
function clickFirstRow(nodes: Node[], config: Cfg = { groupBy: "none", rowLimit: 10 }, menu = false) {
  const el = mountWidget();
  const cleanups: Array<() => void> = [];
  mod.renderInstance(el, config, { nodes, total: nodes.length }, { onUnmount: (fn) => cleanups.push(fn) });
  const row = el.querySelector(".dash-alert-item") as unknown as HTMLElement;
  expect(row, "the widget rendered no rows").toBeTruthy();
  const ev = new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", { bubbles: true, cancelable: true });
  forceMenu = menu;
  try { row.dispatchEvent(ev); } finally { forceMenu = false; }
  cleanups.forEach((fn) => fn()); // stop the 30s refresh + drop the listener
  return { el, row, ev };
}
const rightClickFirstRow = (nodes: Node[]) => clickFirstRow(nodes, { groupBy: "none", rowLimit: 10 }, true);

describe("the row carries the alert its severity pill is showing", () => {
  it("stamps the alert id and its handled state on the row", () => {
    const { row } = clickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: false, alertSeverity: "critical" })]);
    expect(row.getAttribute("data-alert-id")).toBe("n-1");
    expect(row.getAttribute("data-alert-ack")).toBe("0");
  });

  it("stamps no alert attributes at all when the feed named no alert", () => {
    // A device that is down with no automation covering it. There is nothing to
    // acknowledge, and an empty data-alert-id would read as one.
    const { row } = clickFirstRow([node({ id: "a" })]);
    expect(row.hasAttribute("data-alert-id")).toBe(false);
  });

  it("keeps the href so ctrl/middle-click can still open the Assets page", () => {
    const { row } = clickFirstRow([node({ id: "a", alertId: "n-1" })]);
    expect(row.getAttribute("href")).toBe("/assets.html#view=asset:a");
  });
});

// An acknowledged outage is still an outage, so it stays listed — but it has
// to LOOK owned, or an operator glancing at the wallboard re-takes alerts a
// colleague already has. Same treatment as the Active Alerts widget.
describe("an acknowledged row reads as owned", () => {
  function renderRows(nodes: Node[]) {
    const el = mountWidget();
    const cleanups: Array<() => void> = [];
    mod.renderInstance(el, { groupBy: "none", rowLimit: 10 }, { nodes, total: nodes.length }, { onUnmount: (fn) => cleanups.push(fn) });
    cleanups.forEach((fn) => fn());
    return Array.from(el.querySelectorAll(".dash-alert-item")) as unknown as HTMLElement[];
  }
  const ackPill = (row: HTMLElement) => row.querySelector(".dash-alert-title .widget-pill-neutral");

  it("dims the outage and names its owner in a pill", () => {
    const [row] = renderRows([node({ id: "a", alertId: "n-1", alertAcknowledged: true, alertAcknowledgedBy: "jsmith", alertSeverity: "critical" })]);
    expect(row.classList.contains("dash-alert-item-acked")).toBe(true);
    expect(ackPill(row)?.textContent).toBe("ack jsmith");
    expect((row.querySelector(".dash-alert-sub") as HTMLElement).getAttribute("style")).toContain("opacity:.6");
    expect((row.querySelector(".dash-alert-time") as HTMLElement).getAttribute("style")).toContain("opacity:.6");
  });

  it("never dims the owner pill itself — a wallboard has to read the name", () => {
    const [row] = renderRows([node({ id: "a", alertId: "n-1", alertAcknowledged: true, alertAcknowledgedBy: "jsmith" })]);
    let p: Element | null = ackPill(row);
    while (p && p !== row) {
      expect((p.getAttribute("style") || "")).not.toContain("opacity");
      p = p.parentElement;
    }
  });

  it("hovers the acknowledgement note under the owner, or the owner alone without one", () => {
    const [noted, bare] = renderRows([
      node({ id: "a", alertId: "n-1", alertAcknowledged: true, alertAcknowledgedBy: "jsmith", alertAcknowledgeNote: "ISP outage, ticket 88" }),
      node({ id: "b", alertId: "n-2", alertAcknowledged: true, alertAcknowledgedBy: "jsmith", alertAcknowledgeNote: null }),
    ]);
    expect(ackPill(noted)?.getAttribute("title")).toBe("Acknowledged by jsmith\nISP outage, ticket 88");
    expect(ackPill(bare)?.getAttribute("title")).toBe("Acknowledged by jsmith");
  });

  it("falls back to a bare 'ack' when the feed names nobody", () => {
    const [row] = renderRows([node({ id: "a", alertId: "n-1", alertAcknowledged: true, alertAcknowledgedBy: null })]);
    expect(ackPill(row)?.textContent).toBe("ack");
  });

  it("leaves unacknowledged and alert-less rows at full strength", () => {
    const rows = renderRows([
      node({ id: "a", alertId: "n-1", alertAcknowledged: false }),
      node({ id: "b" }),
    ]);
    for (const row of rows) {
      expect(row.classList.contains("dash-alert-item-acked")).toBe(false);
      expect(ackPill(row)).toBeNull();
      expect(row.innerHTML).not.toContain("opacity");
    }
  });
});

describe("hide acknowledged outages (gear toggle)", () => {
  function ids(nodes: Node[], config: Cfg) {
    const el = mountWidget();
    const cleanups: Array<() => void> = [];
    mod.renderInstance(el, config, { nodes, total: nodes.length }, { onUnmount: (fn) => cleanups.push(fn) });
    cleanups.forEach((fn) => fn());
    return { el, ids: Array.from(el.querySelectorAll(".dash-alert-item")).map((r) => r.getAttribute("data-asset-id")) };
  }
  const mixed = () => [
    node({ id: "open", alertId: "n-1", alertAcknowledged: false }),
    node({ id: "owned", alertId: "n-2", alertAcknowledged: true, alertAcknowledgedBy: "jsmith" }),
    node({ id: "bare" }),
  ];

  it("lists acknowledged outages by default", () => {
    expect(ids(mixed(), { groupBy: "none", rowLimit: 10 }).ids).toEqual(["open", "owned", "bare"]);
  });

  it("drops only the acknowledged outage when on — an alert-less node stays", () => {
    expect(ids(mixed(), { groupBy: "none", rowLimit: 10, hideAcknowledged: true }).ids).toEqual(["open", "bare"]);
  });

  it("says they are acknowledged when that is what emptied it", () => {
    const { el } = ids([mixed()[1], node({ id: "o2", alertId: "n-3", alertAcknowledged: true })],
      { groupBy: "none", rowLimit: 10, hideAcknowledged: true });
    expect(el.querySelector(".empty-state")?.textContent)
      .toBe("All 2 down assets here are acknowledged — acknowledged outages are hidden");
  });

  it("offers the checkbox in the gear and writes a boolean", () => {
    const el = mountWidget();
    const changes: Array<[string, unknown]> = [];
    mod.renderConfig(el, {}, (k, v) => changes.push([k, v]));
    const cb = el.querySelector('[data-b="hideAcknowledged"]') as unknown as HTMLInputElement;
    expect(cb.checked).toBe(false);
    cb.checked = true;
    cb.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("change"));
    expect(changes).toEqual([["hideAcknowledged", true]]);
  });
});

describe("an unacknowledged alert: left click opens, right click asks", () => {
  it("a left click opens the device in place, not the Assets page", () => {
    const { ev } = clickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: false })]);
    expect(menuItems).toBeNull();
    expect(openedAsset).toBe("a");
    // The navigation the href would otherwise do is suppressed — the device
    // opens over the dashboard.
    expect(ev.defaultPrevented).toBe(true);
  });

  it("a right click opens the row menu, Open device first", () => {
    const { row } = rightClickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: false })]);
    expect(menuItems?.map((i) => i.label)).toEqual(["Open device", "Acknowledge alert"]);
    expect(menuItems?.[0].primary).toBe(true);
    expect(menuAnchor).toBe(row);
    expect(openedAsset).toBeNull();
  });

  it("Acknowledge opens the modal for THAT alert, with a way back to the device", () => {
    rightClickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: false })]);
    menuItems!.find((i) => i.label.startsWith("Acknowledge"))!.onSelect();
    expect(ackOpened?.alertId).toBe("n-1");
    // The modal gets the widget's own in-place opener rather than navigating:
    // on the dashboard the device opens over the widgets.
    expect(typeof ackOpened?.opts.onOpenDevice).toBe("function");
    (ackOpened!.opts.onOpenDevice as () => void)();
    expect(openedAsset).toBe("a");
    // …and a refresh hook, since the row would otherwise keep offering
    // Acknowledge until the next 30s poll.
    expect(typeof ackOpened?.opts.onAcknowledged).toBe("function");
  });

  it("Open device goes straight to the slide-in", () => {
    rightClickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: false })]);
    menuItems!.find((i) => i.label === "Open device")!.onSelect();
    expect(openedAsset).toBe("a");
    expect(ackOpened).toBeNull();
  });
});

describe("nothing to acknowledge → the right-click menu holds only Open device", () => {
  it("when the alert is already acknowledged", () => {
    rightClickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: true })]);
    expect(menuItems?.map((i) => i.label)).toEqual(["Open device"]);
    clickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: true })]);
    expect(openedAsset).toBe("a");
  });

  it("when the row carries no alert", () => {
    rightClickFirstRow([node({ id: "a" })]);
    expect(menuItems?.map((i) => i.label)).toEqual(["Open device"]);
  });

  it("when the role cannot acknowledge", () => {
    // Withholding the verb beats a menu item that 403s. The route stays the
    // control — this is only the courtesy.
    (win as unknown as Record<string, unknown>).permAtLeast = (key: string, level: string) =>
      !(key === "alerts" && level === "write");
    rightClickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: false })]);
    expect(menuItems?.map((i) => i.label)).toEqual(["Open device"]);
  });

  it("opens the slide-in on a surface with no dialogs (the /dash wallboard)", () => {
    // dash.html loads neither app.js (showRowMenu, openModal) nor the ack
    // modules, and has no session behind it.
    const w = win as unknown as Record<string, unknown>;
    delete w.showRowMenu;
    delete w.PolarisAlertAckModal;
    delete w.openModal;
    clickFirstRow([node({ id: "a", alertId: "n-1", alertAcknowledged: false })]);
    expect(menuItems).toBeNull();
    expect(openedAsset).toBe("a");
  });
});

describe("modified clicks are left alone", () => {
  it("ctrl-click neither menus nor opens in place", () => {
    const el = mountWidget();
    const cleanups: Array<() => void> = [];
    mod.renderInstance(el, { groupBy: "none" }, { nodes: [node({ id: "a", alertId: "n-1" })], total: 1 },
      { onUnmount: (fn) => cleanups.push(fn) });
    const row = el.querySelector(".dash-alert-item") as unknown as HTMLElement;
    row.dispatchEvent(new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
      bubbles: true, cancelable: true, ctrlKey: true,
    }));
    cleanups.forEach((fn) => fn());
    expect(menuItems).toBeNull();
    expect(openedAsset).toBeNull();
  });
});

describe("openAssetRow is the one decider", () => {
  it("is exported off PolarisWidgets so a second outage widget cannot re-derive it", () => {
    const W = win as unknown as { PolarisWidgets: Record<string, unknown> };
    expect(typeof W.PolarisWidgets.openAssetRow).toBe("function");
  });

  it("opens the device on a plain click when handed no alert id at all", () => {
    const W = win as unknown as { PolarisWidgets: { openAssetRow: (a: unknown, o: unknown) => boolean } };
    W.PolarisWidgets.openAssetRow(doc.createElement("a"), { assetId: "z" });
    expect(menuItems).toBeNull();
    expect(openedAsset).toBe("z");
  });

  it("marks every row it renders for the right-click listener", () => {
    const { row } = clickFirstRow([node({ id: "a" })]);
    expect(row.hasAttribute("data-row-menu")).toBe(true);
  });
});

// Sanity: the harness is not silently rendering nothing.
it("renders one row per down node", () => {
  const el = mountWidget();
  const cleanups: Array<() => void> = [];
  mod.renderInstance(el, { groupBy: "none" }, { nodes: [node({ id: "a" }), node({ id: "b" })], total: 2 },
    { onUnmount: (fn) => cleanups.push(fn) });
  cleanups.forEach((fn) => fn());
  expect(el.querySelectorAll(".dash-alert-item")).toHaveLength(2);
  vi.restoreAllMocks();
});
