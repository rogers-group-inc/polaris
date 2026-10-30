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
  groupName?: string | null;
  dimensionCount?: number | null;
  acknowledged?: boolean;
  acknowledgedBy?: string | null;
  acknowledgeNote?: string | null;
  ackInheritedFrom?: string | null;
  ackInheritedSameAsset?: boolean;
  raisedAt?: string;
  maintenanceHold?: "self" | "upstream" | null;
  triggerType?: string | null;
  dependencyDown?: boolean;
  dependencyUpstream?: string | null;
  testRun?: boolean;
  tags?: string[];
  ruleIds?: string[];
}
interface Cfg { minSeverity?: string; rowLimit?: number | null; eventAlerts?: string; tagScope?: string; tags?: string[]; automationScope?: string; automations?: string[]; hideAcknowledged?: boolean }
interface WidgetModule {
  type: string;
  defaultConfig: Cfg & Record<string, unknown>;
  renderInstance: (el: unknown, config: Cfg, data: unknown, ctx: { onUnmount: (fn: () => void) => void }) => void;
  renderConfig: (el: unknown, config: Cfg, onChange: (k: string, v: unknown) => void) => void;
}

let mod: WidgetModule;
let evMod: WidgetModule;
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
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/eventAlerts.js"), "utf8"));
  const W = win as unknown as { PolarisWidgets: { getByType: (t: string) => WidgetModule } };
  mod = W.PolarisWidgets.getByType("activeAlerts");
  evMod = W.PolarisWidgets.getByType("eventAlerts");
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
function render(rows: AlertRow[], total: number | null, config: Cfg = {}, m: WidgetModule = mod) {
  const el = mountWidget();
  const cleanups: Array<() => void> = [];
  m.renderInstance(el, config, { rows, total }, { onUnmount: (fn) => cleanups.push(fn) });
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

describe("dependency-down badge (business rule 78)", () => {
  it("badges an alert raised for a dependency-suppressed device and names the upstream in the tooltip", () => {
    const el = render([
      alert({ id: "dep", severity: "critical", hostname: "PLC-7", dependencyDown: true, dependencyUpstream: "SW-PLANT-3" }),
      alert({ id: "plain", severity: "critical", hostname: "SRV-1" }),
    ], 2, { minSeverity: "warning", rowLimit: 100 });
    const rows = rowsOf(el);
    const badge = rows[0].querySelector(".badge-monitor-dep-down");
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe("Dep. Down");
    expect(badge.getAttribute("title")).toContain("SW-PLANT-3");
    expect(rows[1].querySelector(".badge-monitor-dep-down")).toBeNull();
  });

  // Business rule 78a — an acknowledgement inherited from the root cause's
  // alert shows that alert's note, and the hover says whose note it is.
  it("hovers the root cause's acknowledge note on an inherited ack pill, naming the root cause", () => {
    const el = render([
      alert({
        id: "dep", severity: "critical", hostname: "PLC-7", dependencyDown: true, dependencyUpstream: "SW-PLANT-3",
        acknowledged: true, acknowledgedBy: "jsmith", acknowledgeNote: "ISP fibre cut, ticket 4411", ackInheritedFrom: "FG-PLANT",
      }),
      alert({ id: "direct", severity: "critical", hostname: "SRV-1", acknowledged: true, acknowledgedBy: "amy", acknowledgeNote: "rebooting" }),
    ], 2, { minSeverity: "warning", rowLimit: 100 });
    const rows = rowsOf(el);
    const ackPill = (row: any) =>
      (Array.from(row.querySelectorAll(".widget-pill")) as any[]).find((p) => /^ack/.test(p.textContent));
    const inherited = ackPill(rows[0]);
    expect(inherited.textContent).toBe("ack jsmith");
    expect(inherited.getAttribute("title")).toBe(
      "Acknowledged by jsmith\nInherited from the root cause's alert on FG-PLANT\nISP fibre cut, ticket 4411",
    );
    // A direct acknowledgement reads exactly as before.
    expect(ackPill(rows[1]).getAttribute("title")).toBe("Acknowledged by amy\nrebooting");
  });

  // Business rule 78b — carried over from another automation's down alert on
  // the same device: there is no root cause to name.
  it("hovers a same-device carry-over as one, not as a root cause", () => {
    const el = render([
      alert({
        id: "new", severity: "critical", hostname: "SRV-1",
        acknowledged: true, acknowledgedBy: "jsmith", acknowledgeNote: "power work", ackInheritedFrom: "SRV-1", ackInheritedSameAsset: true,
      }),
    ], 1, { minSeverity: "warning", rowLimit: 100 });
    const pill = (Array.from(rowsOf(el)[0].querySelectorAll(".widget-pill")) as any[]).find((p) => /^ack/.test(p.textContent));
    expect(pill.getAttribute("title")).toBe(
      "Acknowledged by jsmith\nCarried over from another automation's down alert on this device\npower work",
    );
  });
});

describe("maintenance pill (business rule 16)", () => {
  // A window FREEZES an open alert rather than clearing it: still listed, but
  // paging nobody. The pill is what tells a wallboard reader it is paused.
  it("badges a frozen alert MAINT, dims it, and says which kind of hold in the tooltip", () => {
    const el = render([
      alert({ id: "self", severity: "warning", maintenanceHold: "self" }),
      alert({ id: "up", severity: "warning", maintenanceHold: "upstream" }),
      alert({ id: "plain", severity: "warning" }),
    ], 3, { minSeverity: "warning", rowLimit: 100 });
    const rows = rowsOf(el);
    const self = rows[0].querySelector(".badge-maintenance");
    expect(self.textContent).toBe("MAINT");
    expect(self.getAttribute("title")).toContain("this device is in a maintenance window");
    expect(rows[1].querySelector(".badge-maintenance").getAttribute("title")).toContain("upstream device");
    expect(rows[2].querySelector(".badge-maintenance")).toBeNull();
    // Dimmed like an acknowledged row — the severity pill carries the fade.
    expect(rows[0].querySelector(".widget-pill").getAttribute("style")).toContain("opacity:.6");
    expect(rows[2].querySelector(".widget-pill").getAttribute("style")).not.toContain("opacity");
  });
});

describe("delivery-test pill (business rule 65)", () => {
  it("pills a wizard test alert TEST right after its severity, and no other row", () => {
    const el = render([
      alert({ id: "t", severity: "critical", assetId: null, hostname: "EXAMPLE-SWITCH-01", ruleName: null, testRun: true }),
      alert({ id: "real", severity: "critical", hostname: "SRV-1" }),
    ], 2, { minSeverity: "warning", rowLimit: 100 });
    const rows = rowsOf(el);
    const pills = Array.from(rows[0].querySelectorAll(".recent-item-title .widget-pill")) as any[];
    expect(pills.map((p) => p.textContent)).toEqual(["critical", "TEST"]);
    expect(pills[1].getAttribute("title")).toContain("made-up device");
    const realPills = Array.from(rows[1].querySelectorAll(".widget-pill")) as any[];
    expect(realPills.some((p) => p.textContent === "TEST")).toBe(false);
  });
});

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
    expect(noteText(el)).toBe("The feed stopped at 100 of 214 active alerts — raise Row limit to fetch more.");
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

  it("marks a grouped alert with a GROUP pill after its title, and drops the lone dimension", () => {
    // A grouped alert's dimension is only its first member; beside the
    // hostname it read as the whole alert while the message listed every port.
    const el = render([
      alert({ id: "a", severity: "serious", ruleName: "POE Faults", groupName: "POE Faults", dimension: "port39", dimensionCount: 2 }),
    ], 1, { minSeverity: "warning" });
    const title = el.querySelector(".recent-item-title") as any;
    const pills = Array.from(title.querySelectorAll(".widget-pill")).map((p: any) => p.textContent);
    expect(pills).toEqual(["serious", "GROUP"]);
    expect(title.textContent).toMatch(/POE Faults\s*GROUP/);
    expect(el.querySelector(".dash-alert-dim")).toBeNull();
  });

  it("treats an automation's own per-device fold (no Alert Group) as grouped too", () => {
    const el = render([
      alert({ id: "a", severity: "serious", ruleName: "POE Fault", groupName: null, dimension: "port1", dimensionCount: 3 }),
    ], 1, { minSeverity: "warning" });
    const pill = Array.from(el.querySelectorAll(".widget-pill")).find((p: any) => p.textContent === "GROUP") as any;
    expect(pill).toBeTruthy();
    expect(pill.getAttribute("title")).toBe("Grouped by device — 3 components");
    expect(el.querySelector(".dash-alert-dim")).toBeNull();
  });

  it("gives an ungrouped alert no GROUP pill", () => {
    const el = render([alert({ id: "a", severity: "serious", dimension: "port2" })], 1, { minSeverity: "warning" });
    const pills = Array.from(el.querySelectorAll(".widget-pill")).map((p: any) => p.textContent);
    expect(pills).not.toContain("GROUP");
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

  it("hovers the acknowledgement note under the owner", () => {
    const el = render([alert({ id: "a", severity: "critical", acknowledged: true, acknowledgedBy: "jsmith",
      acknowledgeNote: "  Carrier ticket 4411 <open>  " })], 1, { minSeverity: "warning" });
    const ackPill = rowsOf(el)[0].querySelector(".widget-pill-neutral")!;
    // Trimmed, on its own line, and escaped into the attribute (the parsed
    // title is the literal text, so nothing in the note became markup).
    expect(ackPill.getAttribute("title")).toBe("Acknowledged by jsmith\nCarrier ticket 4411 <open>");
    expect(ackPill.textContent).toBe("ack jsmith");
  });

  it("keeps the owner-only hover when the note is blank or withheld (/dash)", () => {
    for (const acknowledgeNote of [null, "   "]) {
      const el = render([alert({ id: "a", severity: "critical", acknowledged: true, acknowledgedBy: "jsmith", acknowledgeNote })], 1,
        { minSeverity: "warning" });
      expect(rowsOf(el)[0].querySelector(".widget-pill-neutral")!.getAttribute("title")).toBe("Acknowledged by jsmith");
    }
  });

  it("leaves an unacknowledged row undimmed end to end", () => {
    const el = render([alert({ id: "a", severity: "critical", acknowledged: false })], 1,
      { minSeverity: "warning" });
    expect(rowsOf(el)[0].innerHTML).not.toContain("opacity");
  });
});

describe("event-triggered alerts have their own widget", () => {
  // An event rule fires off an audit Event (an agent disconnecting, a failed
  // sync) rather than off a reading, so it answers a different question from
  // the rest of the feed. Active Alerts lists everything else; Event Alerts
  // lists only those — two widgets over the one feed.
  const evt = (id: string) => alert({ id, severity: "critical", triggerType: "event", assetId: null, hostname: null, ruleName: "Agent disconnected" });
  const ids = (el: any) => rowsOf(el).map((r: any) => r.getAttribute("data-alert-id"));
  const mixed = () => [
    evt("e"),
    alert({ id: "chg", severity: "critical", triggerType: "change" }),
    alert({ id: "cpu", severity: "critical", triggerType: "asset_metric" }),
    alert({ id: "old", severity: "critical" }), // pre-upgrade cached row: no triggerType at all
  ];

  it("keeps the EVENT kind out of Active Alerts, and nothing else", () => {
    // A `change` rule (firmware moved, the switch behind an asset changed) is
    // about the device, so it stays — as does everything metric/state-driven.
    expect(ids(render(mixed(), 4, { minSeverity: "warning", rowLimit: 50 }))).toEqual(["chg", "cpu", "old"]);
  });

  it("lists only the EVENT kind in Event Alerts", () => {
    expect(evMod).toBeTruthy();
    expect(ids(render(mixed(), 4, { minSeverity: "warning", rowLimit: 50 }, evMod))).toEqual(["e"]);
  });

  it("says which widget is empty", () => {
    expect((render([evt("e1")], 1, { minSeverity: "warning" }).querySelector(".empty-state") as any).textContent)
      .toBe("No active alerts");
    expect((render([alert({ id: "d", severity: "critical" })], 1, { minSeverity: "warning" }, evMod)
      .querySelector(".empty-state") as any).textContent).toBe("No event alerts");
  });

  it("does not read as a truncated feed because the other widget's rows were split off", () => {
    // The overflow note measures the SERVER cap against what was FETCHED. Off
    // this widget's share it would announce truncation over a feed that sent
    // everything it had.
    const el = render([evt("e1"), evt("e2"), alert({ id: "d", severity: "critical" })], 3, { minSeverity: "warning", rowLimit: 50 });
    expect(rowsOf(el)).toHaveLength(1);
    expect(noteText(el)).toBeNull();
  });

  it("offers no event toggle in either gear", () => {
    for (const m of [mod, evMod]) {
      const el = mountWidget();
      m.renderConfig(el, {}, () => {});
      expect(el.querySelector('[data-k="eventAlerts"]')).toBeNull();
    }
  });
});

describe("tag filter", () => {
  const row = (id: string, tags: string[] | undefined, assetId: string | null = "as-" + id): AlertRow =>
    ({ id, assetId, hostname: id, severity: "critical", message: id, tags });
  const ids = (el: any) =>
    Array.from(el.querySelectorAll(".recent-item[data-alert-id]")).map((n: any) => n.getAttribute("data-alert-id"));

  it("lists every alert while the scope is All tags, whatever tags are saved", () => {
    const el = render([row("a", ["core"]), row("b", [])], 2, { minSeverity: "warning", tagScope: "all", tags: ["core"] });
    expect(ids(el)).toEqual(["a", "b"]);
  });

  it("keeps only alerts whose asset carries ANY ticked tag", () => {
    const el = render([row("a", ["core"]), row("b", ["edge", "scalehouse"]), row("c", ["edge"]), row("d", undefined)], 4,
      { minSeverity: "warning", tagScope: "custom", tags: ["core", "scalehouse"] });
    expect(ids(el)).toEqual(["a", "b"]);
  });

  it("keeps a device-less alert (about Polaris itself) under a tag filter", () => {
    const el = render([row("a", ["core"]), row("sys", [], null)], 2, { minSeverity: "warning", tagScope: "custom", tags: ["edge"] });
    expect(ids(el)).toEqual(["sys"]);
  });

  it("treats Selected tags with nothing ticked as unfiltered", () => {
    const el = render([row("a", ["core"]), row("b", [])], 2, { minSeverity: "warning", tagScope: "custom", tags: [] });
    expect(ids(el)).toEqual(["a", "b"]);
  });

  it("names the tag filter when it is what emptied the widget", () => {
    const el = render([row("a", ["core"])], 1, { minSeverity: "warning", tagScope: "custom", tags: ["edge"] });
    expect(el.textContent).toContain("No active alerts on assets with the selected tags");
  });

  it("shows a Tags field reading All tags, or the saved pick as removable pills", () => {
    const el = doc.createElement("div") as any;
    mod.renderConfig(el, {}, () => {});
    expect(el.querySelector('.widget-filter-field[data-filter="tags"]').textContent).toContain("All tags");

    const el2 = doc.createElement("div") as any;
    const changes: Array<[string, unknown]> = [];
    mod.renderConfig(el2, { tagScope: "custom", tags: ["core", "edge"] }, (k, v) => changes.push([k, v]));
    const field = el2.querySelector('.widget-filter-field[data-filter="tags"]');
    expect(Array.from(field.querySelectorAll(".tag-chip-delete")).map((b: any) => b.getAttribute("data-chip"))).toEqual(["core", "edge"]);
    // × drops one pick and leaves the rest.
    field.querySelector('[data-chip="core"]').click();
    expect(changes).toEqual([["tags", ["edge"]], ["tagScope", "custom"]]);
    // Removing the last one returns the field to All.
    el2.querySelector('.widget-filter-field[data-filter="tags"] [data-chip="edge"]').click();
    expect(changes.slice(-2)).toEqual([["tags", []], ["tagScope", "all"]]);
    expect(el2.querySelector('.widget-filter-field[data-filter="tags"]').textContent).toContain("All tags");
  });

  it("ships a defaultConfig that filters by nothing", () => {
    expect(mod.defaultConfig.tagScope).toBe("all");
    expect(mod.defaultConfig.tags).toEqual([]);
  });
});

describe("automation filter", () => {
  const row = (id: string, ruleIds: string[] | undefined, assetId: string | null = "as-" + id): AlertRow =>
    ({ id, assetId, hostname: id, severity: "critical", message: id, ruleIds });
  const ids = (el: any) =>
    Array.from(el.querySelectorAll(".recent-item[data-alert-id]")).map((n: any) => n.getAttribute("data-alert-id"));
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("lists every alert while the scope is All automations, whatever ids are saved", () => {
    const el = render([row("a", ["r1"]), row("b", ["r2"])], 2, { minSeverity: "warning", automationScope: "all", automations: ["r1"] });
    expect(ids(el)).toEqual(["a", "b"]);
  });

  it("keeps only alerts raised by a ticked automation — a device-less one included", () => {
    const el = render([row("a", ["r1"]), row("b", ["r2"]), row("sys", ["r3"], null), row("gone", [])], 4,
      { minSeverity: "warning", automationScope: "custom", automations: ["r1", "r3"] });
    expect(ids(el)).toEqual(["a", "sys"]);
  });

  it("matches a grouped alert on ANY contributing automation, not only the primary", () => {
    const el = render([row("grp", ["r1", "r2"]), row("solo", ["r1"])], 2,
      { minSeverity: "warning", automationScope: "custom", automations: ["r2"] });
    expect(ids(el)).toEqual(["grp"]);
  });

  it("keeps a row from a pre-ruleIds payload rather than emptying the widget", () => {
    const el = render([row("old", undefined)], 1, { minSeverity: "warning", automationScope: "custom", automations: ["r1"] });
    expect(ids(el)).toEqual(["old"]);
  });

  it("treats Selected automations with nothing ticked as unfiltered", () => {
    const el = render([row("a", ["r1"]), row("b", ["r2"])], 2, { minSeverity: "warning", automationScope: "custom", automations: [] });
    expect(ids(el)).toEqual(["a", "b"]);
  });

  it("names the automation filter when it is what emptied the widget", () => {
    const el = render([row("a", ["r1"])], 1, { minSeverity: "warning", automationScope: "custom", automations: ["r9"] });
    expect(el.textContent).toContain("No active alerts from the selected automations");
  });

  it("shows an Automations field: All automations, or the saved pick as named, removable pills", async () => {
    g.api = {
      dashboard: {
        filterOptions: () => Promise.resolve({
          automations: [
            { id: "r1", name: "Asset down", enabled: true, triggerType: "asset_state" },
            { id: "r2", name: "Old CPU", enabled: false, triggerType: "asset_metric" },
            { id: "ev", name: "Agent disconnected", enabled: true, triggerType: "event" },
          ],
        }),
      },
    };
    const el = doc.createElement("div") as any;
    mod.renderConfig(el, {}, () => {});
    expect(el.querySelector('.widget-filter-field[data-filter="automations"]').textContent).toContain("All automations");

    const el2 = doc.createElement("div") as any;
    const changes: Array<[string, unknown]> = [];
    mod.renderConfig(el2, { automationScope: "custom", automations: ["r1", "r2", "deleted"] }, (k, v) => changes.push([k, v]));
    await flush();
    const field = el2.querySelector('.widget-filter-field[data-filter="automations"]');
    expect(Array.from(field.querySelectorAll(".tag-chip")).map((c: any) => c.textContent.replace("×", "")))
      .toEqual(["Asset down", "Old CPU (disabled)", "Deleted automation"]);
    field.querySelector('[data-chip="deleted"]').click();
    expect(changes).toEqual([["automations", ["r1", "r2"]], ["automationScope", "custom"]]);
  });

  it("offers each widget only the automations of its own kind", async () => {
    const labels = async (m: WidgetModule) => {
      const el = doc.createElement("div") as any;
      doc.body.appendChild(el);
      m.renderConfig(el, {}, () => {});
      el.querySelector('.widget-filter-field[data-filter="automations"]').click();
      await flush();
      const overlay = doc.querySelector(".widget-filter-picker") as any;
      const out = Array.from(overlay.querySelectorAll(".wfp-opt span")).map((s: any) => s.textContent);
      overlay.remove();
      return out;
    };
    expect(await labels(mod)).toEqual(["Asset down", "Old CPU (disabled)"]);
    expect(await labels(evMod)).toEqual(["Agent disconnected"]);
  });

  it("ships a defaultConfig that filters by nothing", () => {
    expect(mod.defaultConfig.automationScope).toBe("all");
    expect(mod.defaultConfig.automations).toEqual([]);
  });
});

describe("gear config", () => {
  it("offers a row limit seeded at the default", () => {
    const el = mountWidget();
    const changes: Array<[string, unknown]> = [];
    mod.renderConfig(el, {}, (k, v) => changes.push([k, v]));
    const sel = el.querySelector('[data-k="rowLimit"]') as any;
    const selected = Array.from(sel.querySelectorAll("option"))
      .filter((o: any) => o.hasAttribute("selected")).map((o: any) => o.getAttribute("value"));
    expect(selected).toEqual(["50"]);
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
  });
});

describe("hide acknowledged alerts (gear toggle)", () => {
  const ids = (el: any) => rowsOf(el).map((r: any) => r.getAttribute("data-alert-id"));
  const mixed = () => [
    alert({ id: "open", severity: "critical" }),
    alert({ id: "owned", severity: "critical", acknowledged: true, acknowledgedBy: "jsmith" }),
  ];

  it("lists acknowledged alerts by default — the toggle is opt-in", () => {
    expect(mod.defaultConfig.hideAcknowledged).toBe(false);
    expect(ids(render(mixed(), 2, { minSeverity: "warning" }))).toEqual(["open", "owned"]);
  });

  it("drops acknowledged alerts when on, in both alert widgets", () => {
    expect(ids(render(mixed(), 2, { minSeverity: "warning", hideAcknowledged: true } as Cfg))).toEqual(["open"]);
    const evRows = mixed().map((r) => ({ ...r, triggerType: "event" }));
    expect(ids(render(evRows, 2, { minSeverity: "warning", hideAcknowledged: true } as Cfg, evMod))).toEqual(["open"]);
  });

  it("says the alerts are acknowledged when that is what emptied it", () => {
    const el = render([mixed()[1]], 1, { minSeverity: "warning", hideAcknowledged: true } as Cfg);
    expect((el.querySelector(".empty-state") as any).textContent)
      .toBe("The 1 alert here is acknowledged — acknowledged alerts are hidden");
  });

  it("counts a filtered-out acknowledged row as gone from the clip note", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => alert({ id: "o" + i, severity: "critical" })),
      ...Array.from({ length: 5 }, (_, i) => alert({ id: "a" + i, severity: "critical", acknowledged: true })),
    ];
    const el = render(rows, 10, { minSeverity: "warning", rowLimit: 10, hideAcknowledged: true } as Cfg);
    expect(rowsOf(el)).toHaveLength(5);
    expect(noteText(el)).toBeNull();
  });

  it("offers the checkbox in the gear and writes a boolean", () => {
    for (const m of [mod, evMod]) {
      const el = mountWidget();
      const changes: Array<[string, unknown]> = [];
      m.renderConfig(el, {}, (k, v) => changes.push([k, v]));
      const cb = el.querySelector('[data-b="hideAcknowledged"]') as any;
      expect(cb).toBeTruthy();
      expect(cb.checked).toBe(false);
      cb.checked = true;
      cb.dispatchEvent(new (doc.defaultView as any).Event("change"));
      expect(changes).toEqual([["hideAcknowledged", true]]);
    }
  });
});
