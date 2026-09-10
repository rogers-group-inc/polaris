/**
 * tests/unit/widgetActiveAlerts.test.ts
 *
 * Unit tests for the Active Alerts widget's render (public/js/widgets/
 * activeAlerts.js). Same harness as widgetTopNHeaderCounts.test.ts: index.js is
 * eval'd first so the widget finds its PolarisWidgets helpers, then the widget
 * module registers itself and is pulled back off the registry.
 *
 * The property under test is the widget's promise — AN ACTIVE ALERT APPEARS IN
 * IT — and the three things that used to break it:
 *   • the row cap was 25 with no control, and it slices a severity-DESC list,
 *     so a screenful of criticals made every serious/warning alert on the fleet
 *     invisible while the header still read "Warning and up". Where the cap
 *     bites must now be STATED.
 *   • per-port alerts of one automation share a rule, a minute and a message
 *     template, so without Notification.dimension they differ in nothing.
 *   • an alert is a prompt to go look at a device, so the row links to it —
 *     except an alert about Polaris itself, which has no device to open.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";

interface AlertRow {
  id: string;
  assetId?: string | null;
  hostname?: string | null;
  dimension?: string | null;
  message?: string;
  severity: string;
  ruleName?: string | null;
  acknowledged?: boolean;
  acknowledgedBy?: string | null;
  raisedAt?: string;
  triggerType?: string | null;
}
interface Cfg { minSeverity?: string; rowLimit?: number | null; eventAlerts?: string }
interface WidgetModule {
  type: string;
  defaultConfig: Cfg & Record<string, unknown>;
  renderInstance: (el: unknown, config: Cfg, data: unknown, ctx: { onUnmount: (fn: () => void) => void }) => void;
  renderConfig: (el: unknown, config: Cfg, onChange: (k: string, v: unknown) => void) => void;
}

let mod: WidgetModule;
const g = globalThis as Record<string, unknown>;
let doc: Window["document"];

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  // app.js's relative-time helper; the widget only prints its output.
  g.timeAgo = () => "5m ago";
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8"));
  // The widget references `PolarisWidgets` bare (a browser global), so hoist
  // what index.js hung off `window` onto the eval scope's global.
  g.PolarisWidgets = (win as unknown as { PolarisWidgets: unknown }).PolarisWidgets;
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/activeAlerts.js"), "utf8"));
  const W = win as unknown as { PolarisWidgets: { getByType: (t: string) => WidgetModule } };
  mod = W.PolarisWidgets.getByType("activeAlerts");
});

/** A widget shell with the header the pills + export button land in. */
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

/** Render one payload and hand back the body + a teardown for its 30s timer. */
function render(rows: AlertRow[], total: number | null, config: Cfg = {}) {
  const el = mountWidget();
  const cleanups: Array<() => void> = [];
  mod.renderInstance(el, config, { rows, total }, { onUnmount: (fn) => cleanups.push(fn) });
  cleanups.forEach((fn) => fn());  // stop the refresh interval
  return el;
}

const alert = (o: Partial<AlertRow> & { id: string; severity: string }): AlertRow => ({
  assetId: "asset-" + o.id, hostname: "sw-1", message: "m", ruleName: "Interface down",
  acknowledged: false, raisedAt: "2026-08-24T00:00:00Z", ...o,
});

const rowsOf = (el: HTMLElement) => Array.from(el.querySelectorAll(".recent-item")) as any[];
const noteText = (el: HTMLElement) => {
  const p = el.querySelector(".widget-overflow-note");
  return p ? (p as any).textContent : null;
};

describe("severity filtering", () => {
  it("keeps every tier at or above the configured minimum", () => {
    // The reported symptom: "Warning and up" was set and serious alerts were
    // missing. Serious outranks warning, so it must never be filtered out here.
    const el = render([
      alert({ id: "crit", severity: "critical" }),
      alert({ id: "ser", severity: "serious" }),
      alert({ id: "warn", severity: "warning" }),
      alert({ id: "note", severity: "notice" }),
    ], 4, { minSeverity: "warning", rowLimit: 100 });
    expect(rowsOf(el)).toHaveLength(3);
    expect(el.textContent).toContain("serious");
    expect(el.textContent).not.toContain("notice");
  });

  it("says the tier when the filter is what emptied it", () => {
    const el = render([alert({ id: "n", severity: "notice" })], 1, { minSeverity: "critical" });
    expect((el.querySelector(".empty-state") as any).textContent).toContain("critical");
  });

  it("reads 'No active alerts' when there is genuinely nothing", () => {
    const el = render([], 0, { minSeverity: "warning" });
    expect((el.querySelector(".empty-state") as any).textContent).toBe("No active alerts");
  });
});

describe("row limit + overflow note", () => {
  const many = (n: number, severity = "critical") =>
    Array.from({ length: n }, (_, i) => alert({ id: "a" + i, severity }));

  it("defaults a widget carrying no rowLimit key to DEFAULT_ROWS", () => {
    const el = render(many(60), 60, { minSeverity: "warning" });
    expect(rowsOf(el)).toHaveLength(50);
  });

  it("honors a raised row limit", () => {
    const el = render(many(60), 60, { minSeverity: "warning", rowLimit: 100 });
    expect(rowsOf(el)).toHaveLength(60);
  });

  it("honors a lowered row limit", () => {
    const el = render(many(60), 60, { minSeverity: "warning", rowLimit: 10 });
    expect(rowsOf(el)).toHaveLength(10);
  });

  it("states where the CLIENT clip stops", () => {
    const el = render(many(40), 40, { minSeverity: "warning", rowLimit: 10 });
    expect(noteText(el)).toBe("Showing 10 of 40 at this severity — raise Row limit to see the rest.");
  });

  it("states where the SERVER cap stops, which is what hid the lower tiers", () => {
    // 100 fetched out of 214 uncleared: the feed is severity-DESC, so the 114
    // it never sent are the LEAST severe — exactly the serious/warning alerts
    // an operator goes looking for. Silence here reads as "there are none".
    const el = render(many(100), 214, { minSeverity: "warning", rowLimit: 100 });
    expect(noteText(el)).toBe("Showing 100 of 214 active alerts — raise Row limit to fetch more.");
  });

  it("says nothing when the whole set is on screen", () => {
    const el = render(many(3), 3, { minSeverity: "warning", rowLimit: 50 });
    expect(noteText(el)).toBeNull();
  });

  it("survives a payload with no total (a pre-upgrade cached response)", () => {
    const el = render(many(3), null, { minSeverity: "warning", rowLimit: 50 });
    expect(rowsOf(el)).toHaveLength(3);
    expect(noteText(el)).toBeNull();
  });
});

describe("row contents", () => {
  it("prints the dimension, so two ports of one automation are tellable apart", () => {
    const el = render([
      alert({ id: "a", severity: "serious", dimension: "port2" }),
      alert({ id: "b", severity: "serious", dimension: "port10" }),
    ], 2, { minSeverity: "warning", rowLimit: 50 });
    const dims = Array.from(el.querySelectorAll(".dash-alert-dim")).map((d: any) => d.textContent);
    expect(dims).toEqual(["port2", "port10"]);
  });

  it("omits the dimension element for a whole-device alert", () => {
    const el = render([alert({ id: "a", severity: "critical", dimension: null })], 1, { minSeverity: "warning" });
    expect(el.querySelector(".dash-alert-dim")).toBeNull();
  });

  it("links the row to the asset's details, keeping the href as the fallback", () => {
    const el = render([alert({ id: "a", severity: "critical", assetId: "asset-9" })], 1, { minSeverity: "warning" });
    const row = rowsOf(el)[0];
    expect(row.tagName.toLowerCase()).toBe("a");
    expect(row.getAttribute("data-asset-id")).toBe("asset-9");
    // The hash carries the Alerts tab too, so the Assets page lands there on
    // a ctrl/middle-click just as the in-place open does.
    expect(row.getAttribute("href")).toBe("/assets.html#view=asset:asset-9&tab=notifications");
    expect(row.getAttribute("class")).toContain("recent-item-link");
  });

  it("opens the asset slide-over on its Alerts tab, not General", () => {
    // An alert entry is a prompt to look at THAT alert; landing on General
    // made the operator hunt for the tab on every click.
    const win = g.window as any;
    const opened: Array<[string, unknown]> = [];
    win.openViewModal = (id: string, opts: unknown) => { opened.push([id, opts]); };
    try {
      const el = mountWidget();
      const cleanups: Array<() => void> = [];
      mod.renderInstance(el, { minSeverity: "warning" },
        { rows: [alert({ id: "a", severity: "critical", assetId: "asset-9" })], total: 1 },
        { onUnmount: (fn) => cleanups.push(fn) });
      const ev = new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      rowsOf(el)[0].dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(opened).toEqual([["asset-9", { tab: "notifications" }]]);
      cleanups.forEach((fn) => fn());
    } finally {
      delete win.openViewModal;
    }
  });

  it("keeps an alert about Polaris itself unlinked but ACTIONABLE — no device page, still an alert", () => {
    // A host_metric rule or an event-triggered alert carries no assetId, so
    // there is no href to give it. It used to be an inert div because of that,
    // which made the alerts most likely to need a human the only ones nobody
    // could acknowledge or clear from here. It carries the alert id instead.
    const el = render([alert({ id: "a", severity: "critical", assetId: null, hostname: "Polaris server" })], 1,
      { minSeverity: "warning" });
    const row = rowsOf(el)[0];
    expect(row.tagName.toLowerCase()).toBe("div");
    expect(row.hasAttribute("data-asset-id")).toBe(false);
    expect(row.getAttribute("data-alert-id")).toBe("a");
    expect(row.getAttribute("class")).toContain("recent-item-link");
  });

  it("keeps an acknowledged alert listed, dims the ALERT, and names who has it", () => {
    const el = render([alert({ id: "a", severity: "critical", acknowledged: true, acknowledgedBy: "jsmith" })], 1,
      { minSeverity: "warning" });
    const row = rowsOf(el)[0];
    // The row itself must NOT dim: compounded onto the ack pill's already-
    // tertiary grey it lands under the AA floor, on exactly the rows whose
    // owner someone has to read. The alert's own parts carry it instead.
    expect(row.getAttribute("style")).not.toContain("opacity");
    expect(row.querySelector(".recent-item-meta")!.getAttribute("style")).toContain("opacity:.6");
    expect(row.querySelector(".widget-pill-red")!.getAttribute("style")).toContain("opacity:.6");
    // Wallboards never hover, so the owner is in the pill, not only its title.
    const ackPill = row.querySelector(".widget-pill-neutral")!;
    expect(ackPill.textContent).toBe("ack jsmith");
    expect(ackPill.getAttribute("style") || "").not.toContain("opacity");
    expect(ackPill.getAttribute("title")).toBe("Acknowledged by jsmith");
  });

  it("falls back to a bare ack pill when the feed gives no owner", () => {
    const el = render([alert({ id: "a", severity: "critical", acknowledged: true, acknowledgedBy: null })], 1,
      { minSeverity: "warning" });
    const ackPill = rowsOf(el)[0].querySelector(".widget-pill-neutral")!;
    expect(ackPill.textContent).toBe("ack");
    expect(ackPill.getAttribute("title")).toBe("Acknowledged");
  });

  it("leaves an unacknowledged row undimmed end to end", () => {
    const el = render([alert({ id: "a", severity: "critical", acknowledged: false })], 1,
      { minSeverity: "warning" });
    expect(rowsOf(el)[0].innerHTML).not.toContain("opacity");
  });
});

describe("event-triggered alerts", () => {
  // An event rule fires off an audit Event (an agent disconnecting, a failed
  // sync) rather than off a reading, so it answers a different question from
  // the rest of the feed — hideable per widget, shown until someone says
  // otherwise.
  const evt = (id: string) => alert({ id, severity: "critical", triggerType: "event", assetId: null, hostname: null, ruleName: "Agent disconnected" });

  it("lists them by default, so an existing dashboard's feed does not change under the control", () => {
    const el = render([evt("e"), alert({ id: "d", severity: "critical" })], 2, { minSeverity: "warning", rowLimit: 50 });
    expect(rowsOf(el)).toHaveLength(2);
  });

  it("hides only the EVENT kind when the gear says hide", () => {
    // A `change` rule (firmware moved, the switch behind an asset changed) is
    // about the device, so it stays — as does everything metric/state-driven.
    const el = render([
      evt("e"),
      alert({ id: "chg", severity: "critical", triggerType: "change" }),
      alert({ id: "cpu", severity: "critical", triggerType: "asset_metric" }),
      alert({ id: "old", severity: "critical" }), // pre-upgrade cached row: no triggerType at all
    ], 4, { minSeverity: "warning", rowLimit: 50, eventAlerts: "hide" });
    expect(rowsOf(el).map((r: any) => r.getAttribute("data-alert-id"))).toEqual(["chg", "cpu", "old"]);
  });

  it("names the event filter, not the severity floor, when it is what emptied the widget", () => {
    const el = render([evt("e1"), evt("e2")], 2, { minSeverity: "warning", eventAlerts: "hide" });
    expect((el.querySelector(".empty-state") as any).textContent).toBe("No active alerts — event-triggered alerts are hidden");
  });

  it("does not read as a truncated feed just because rows were filtered out", () => {
    // The overflow note measures the SERVER cap against what was FETCHED. Off
    // the filtered set it would announce "Showing 1 of 3 active alerts — raise
    // Row limit to fetch more" over a feed that sent everything it had.
    const el = render([evt("e1"), evt("e2"), alert({ id: "d", severity: "critical" })], 3,
      { minSeverity: "warning", rowLimit: 50, eventAlerts: "hide" });
    expect(rowsOf(el)).toHaveLength(1);
    expect(noteText(el)).toBeNull();
  });
});

describe("gear config", () => {
  it("offers a row limit seeded at the default, and warns that the cap is severity-ordered", () => {
    const el = mountWidget();
    const changes: Array<[string, unknown]> = [];
    mod.renderConfig(el, {}, (k, v) => changes.push([k, v]));
    const sel = el.querySelector('[data-k="rowLimit"]') as any;
    const selected = Array.from(sel.querySelectorAll("option"))
      .filter((o: any) => o.hasAttribute("selected")).map((o: any) => o.getAttribute("value"));
    expect(selected).toEqual(["50"]);
    // The hint is what makes a low limit's behaviour predictable.
    expect(el.textContent).toContain("most-severe-first");
    // …and the minimum-severity control still follows it.
    expect(el.querySelector("[data-minsev]")).toBeTruthy();
  });

  it("writes rowLimit as a number", () => {
    const el = mountWidget();
    const changes: Array<[string, unknown]> = [];
    mod.renderConfig(el, { rowLimit: 50 }, (k, v) => changes.push([k, v]));
    const sel = el.querySelector('[data-k="rowLimit"]') as any;
    sel.value = "100";
    sel.dispatchEvent(new (doc.defaultView as any).Event("change"));
    expect(changes).toEqual([["rowLimit", 100]]);
  });

  it("ships a defaultConfig carrying the row limit", () => {
    expect(mod.defaultConfig.rowLimit).toBe(50);
    expect(mod.defaultConfig.minSeverity).toBe("warning");
    expect(mod.defaultConfig.eventAlerts).toBe("show");
  });

  it("offers Show/Hide for event-triggered alerts, seeded at Show", () => {
    const el = mountWidget();
    mod.renderConfig(el, {}, () => {});
    const sel = el.querySelector('[data-k="eventAlerts"]') as any;
    const selected = Array.from(sel.querySelectorAll("option"))
      .filter((o: any) => o.hasAttribute("selected")).map((o: any) => o.getAttribute("value"));
    expect(selected).toEqual(["show"]);
    // The hidden rows still spend the server's cap — say so where it's set.
    expect(el.textContent).toContain("still count against the row limit");
  });

  it("seeds the control from a saved hide, and writes the choice back", () => {
    const el = mountWidget();
    const changes: Array<[string, unknown]> = [];
    mod.renderConfig(el, { eventAlerts: "hide" }, (k, v) => changes.push([k, v]));
    const sel = el.querySelector('[data-k="eventAlerts"]') as any;
    expect(Array.from(sel.querySelectorAll("option"))
      .filter((o: any) => o.hasAttribute("selected")).map((o: any) => o.getAttribute("value"))).toEqual(["hide"]);
    sel.value = "show";
    sel.dispatchEvent(new (doc.defaultView as any).Event("change"));
    expect(changes).toEqual([["eventAlerts", "show"]]);
  });
});
