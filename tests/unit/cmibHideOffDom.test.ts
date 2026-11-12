/**
 * tests/unit/cmibHideOffDom.test.ts — the Custom MIB tab hides a widget
 * switched off for the asset until edit mode (`_customMibTabHTML`,
 * `_cmibLayoutHTML` in public/js/assets-snmp.js).
 *
 * An APC profile carries UPS and PDU widgets side by side; a PDU switches the
 * ones it cannot answer off, and each of those still drew a "Polling is off"
 * card on every visit (2026-11-12). Off widgets now appear only once the
 * pencil is clicked — which an asset editor gets even without the
 * manufacturer-profile write the layout tools need, since edit mode is the only
 * place a switched-off widget can be switched back on.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect } from "vitest";
import { assetsSource } from "./_assetsSource.js";

const lines = assetsSource().split(/\r?\n/);

function fnSrc(name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end + 1).join("\n");
}

const FNS = [
  "_cmibIsMfr", "_cmibHiddenOff", "_cmibCompleteLayout", "_cmibCanSwitchType", "_cmibTypePickerHTML",
  "_cmibShown", "_cmibCardHTML", "_cmibLayoutHTML", "_customMibTabHTML",
];

type Perms = { assets: boolean; profiles: boolean };

function build(perms: Perms) {
  return new Function(
    "perms",
    "var _cmib = { payload: null, editing: false, working: null };\n" +
    "var CMIB_WIDTHS = [3, 4, 6, 12]; var CMIB_ROW_PX = 170; var CMIB_GAP_PX = 12;\n" +
    "var CMIB_PENCIL_SVG = '<svg data-pencil></svg>'; var CMIB_CHECK_SVG = '<svg data-check></svg>';\n" +
    "var CMIB_DISPLAY_TYPES = [['gauge','Gauge'],['line','Line'],['value','Value']];\n" +
    "function escapeHtml(s) { return String(s == null ? '' : s); }\n" +
    "function canManageAssets() { return perms.assets; }\n" +
    "function permAtLeast() { return perms.profiles; }\n" +
    "function _renderCustomWidgetBody(w) { return '<div data-body=\"' + w.id + '\"></div>'; }\n" +
    FNS.map(fnSrc).join("\n") +
    "\nreturn { tab: _customMibTabHTML, state: _cmib };",
  )(perms) as { tab: (p: Record<string, unknown>) => string; state: Record<string, unknown> };
}

const W = (id: string, enabled: boolean | null) => ({
  id, name: "Widget " + id, symbol: "sym" + id, enabled, type: "scalar", widgetType: "gauge",
  latest: { value: 1 },
});

const payload = (layout: unknown = null) => ({
  assetId: "a1", profileId: "p1", manufacturer: "APC", lastCustomWidgetAt: "2026-11-12T00:00:00Z",
  widgetLayout: layout,
  widgets: [W("on", true), W("off", false), W("feed", null)],
});

function render(html: string) {
  document.body.innerHTML = html;
  const ids = Array.from(document.querySelectorAll(".custom-mib-card")).map((c) => c.getAttribute("data-widget-id"));
  return { ids, text: document.body.textContent || "" };
}

function enterEdit(m: ReturnType<typeof build>, p: Record<string, unknown>) {
  m.tab(p);
  m.state.editing = true;
  m.state.working = { version: 1, columns: [
    { id: "c1", width: 6, widgets: [{ id: "on", height: 1 }] },
    { id: "c2", width: 3, widgets: [{ id: "off", height: 1 }] },
  ] };
  return render(m.tab(p));
}

describe.each([
  ["the default grid", null],
  ["a saved layout", { version: 1, columns: [
    { id: "c1", width: 6, widgets: [{ id: "on", height: 1 }] },
    { id: "c2", width: 3, widgets: [{ id: "off", height: 2 }] },
  ] }],
])("outside edit mode, with %s", (_label, layout) => {
  it("leaves the switched-off widget out and keeps the on one and the Generic API one", () => {
    const m = build({ assets: true, profiles: true });
    const { ids, text } = render(m.tab(payload(layout)));
    expect(ids).toEqual(["on", "feed"]);
    expect(text).not.toContain("Polling is off for this asset.");
    expect(text).toContain("1 widget is switched off for this asset and hidden");
  });
});

describe("outside edit mode, the column a hidden widget alone filled", () => {
  it("is not drawn", () => {
    const m = build({ assets: true, profiles: true });
    m.tab(payload());
    document.body.innerHTML = m.tab(payload({ version: 1, columns: [
      { id: "c1", width: 6, widgets: [{ id: "on", height: 1 }] },
      { id: "c2", width: 3, widgets: [{ id: "off", height: 1 }] },
    ] }));
    expect(document.querySelector('[data-col-id="c2"]')).toBeNull();
    expect(document.querySelector('[data-col-id="c1"]')).not.toBeNull();
  });
});

describe("in edit mode", () => {
  it("shows the switched-off widget with its switch, enabled for an asset editor", () => {
    const m = build({ assets: true, profiles: true });
    const { ids, text } = enterEdit(m, payload());
    expect(ids).toContain("off");
    expect(text).toContain("Polling is off for this asset.");
    const sw = document.querySelector('.custom-mib-card[data-widget-id="off"] .custom-widget-toggle') as HTMLInputElement;
    expect(sw).not.toBeNull();
    expect(sw.disabled).toBe(false);
    expect(sw.checked).toBe(false);
    // The layout tools are there too for a profile writer.
    expect(document.querySelector(".cmib-grip")).not.toBeNull();
  });

  it("without the profile write: switches only — no grips, no column bars, no Reset", () => {
    const m = build({ assets: true, profiles: false });
    const { ids } = enterEdit(m, payload());
    expect(ids).toContain("off");
    expect(document.querySelector(".cmib-grip")).toBeNull();
    expect(document.querySelector(".cmib-col-bar")).toBeNull();
    expect(document.querySelector(".cmib-reset")).toBeNull();
    expect(document.querySelector(".cmib-edit-btn [data-check]")).not.toBeNull();
    expect(m.state.canLayout).toBe(false);
  });
});

describe("the pencil", () => {
  it("is offered to an asset editor without the profile write", () => {
    const m = build({ assets: true, profiles: false });
    render(m.tab(payload()));
    expect(document.querySelector(".cmib-edit-btn [data-pencil]")).not.toBeNull();
  });

  it("is not offered to a read-only user, who never sees a switched-off widget", () => {
    const m = build({ assets: false, profiles: false });
    const { ids, text } = render(m.tab(payload()));
    expect(document.querySelector(".cmib-edit-btn")).toBeNull();
    expect(ids).toEqual(["on", "feed"]);
    expect(text).not.toContain("hidden");
  });
});

describe("every widget switched off", () => {
  it("draws no manufacturer card and points at the pencil", () => {
    const m = build({ assets: true, profiles: false });
    const p = payload();
    p.widgets = [W("x", false), W("y", false)];
    const { ids, text } = render(m.tab(p));
    expect(ids).toEqual([]);
    expect(text).toContain("click the pencil to switch one on");
  });
});
