/**
 * tests/unit/widgetAssetTypes.test.ts
 *
 * The dashboard widgets' asset-type vocabulary — `BUILTIN_ASSET_TYPES`,
 * `ASSET_TYPE_LABELS` / `ASSET_TYPE_COLORS` and `effectiveAssetTypes` in
 * public/js/widgets/index.js, plus the Assets-by-type chart that reads them
 * (public/js/widgets/assetTypes.js). Same harness as widgetActiveAlerts:
 * index.js is eval'd into a happy-dom window with the app-shell globals
 * stubbed, then the widget module registers itself and is pulled back off
 * the registry.
 *
 * The property under test is that a type the REGISTRY knows about is a type
 * the dashboard can see, and the three ways that stopped being true:
 *   • the widgets kept their own copy of the built-in list and it fell two
 *     names behind (`hypervisor`, `kubernetes_cluster`). The server derives
 *     the HIDDEN set as (its built-ins − the ones the widget sent), so a name
 *     missing from the widget's copy is one the operator can never filter on.
 *     The first test is a straight parity guard against the registry constant
 *     — it is the whole point of this file.
 *   • the stored filter is the ENABLED list, so a config saved before a new
 *     built-in existed doesn't mention it — which reads identically to
 *     "operator switched it off". Widening an all-on legacy config is what
 *     keeps adding a built-in from silently hiding it everywhere.
 *   • the chart mapped over the LABEL map's keys rather than the rows, so an
 *     unknown type was dropped from the drawing while still counting toward
 *     the total: the pie came up a wedge short and every percentage read low.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Window } from "happy-dom";
import { BUILT_IN_ASSET_TYPES } from "../../src/utils/assetTypes.js";

interface ChartModule {
  type: string;
  renderInstance: (
    el: unknown,
    config: Record<string, unknown>,
    data: unknown,
    ctx: { onUnmount: (fn: () => void) => void },
  ) => void;
}
interface Widgets {
  BUILTIN_ASSET_TYPES: string[];
  ASSET_TYPE_LABELS: Record<string, string>;
  ASSET_TYPE_COLORS: Record<string, string>;
  effectiveAssetTypes: (list: unknown) => string[] | null;
  hiddenAssetTypes: (config: Record<string, unknown>) => string[];
  assetTypeLabel: (t: string, fallback?: string) => string;
  getAssetTypeOptions: () => Promise<Array<{ value: string; label: string }>>;
  renderNocFilterConfig: (
    el: unknown,
    config: Record<string, unknown>,
    onChange: (key: string, value: unknown) => void,
    includeAssetTypes: boolean,
  ) => void;
  nocFilterOpts: (config: Record<string, unknown>) => Record<string, unknown>;
  getNocSummary: (opts: Record<string, unknown>, feeds?: string[]) => Promise<unknown>;
  widgetTitle: (module: unknown, w: { config?: Record<string, unknown> }) => string;
  getByType: (t: string) => ChartModule;
}

/**
 * The fleet the stubbed /dashboard/filter-options describes: every built-in
 * (that is what the endpoint sends) plus one operator-added type that assets
 * actually wear. `plc` is deliberately absent — the endpoint only offers
 * customs that are present, so an unused registry row gets no checkbox.
 */
const FILTER_OPTIONS_TYPES = [
  ...BUILT_IN_ASSET_TYPES.map((name) => ({ name, label: name === "access_point" ? "Access Point" : name })),
  { name: "network_camera", label: "Network Camera" },
];
const nocSummary = vi.fn().mockResolvedValue({});

/** The eight types that existed before the registry grew. */
const LEGACY = [
  "server", "switch", "router", "firewall",
  "workstation", "printer", "access_point", "other",
];

let W: Widgets;
let doc: Window["document"];
const g = globalThis as Record<string, unknown>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const win = new Window();
  doc = win.document;
  g.window = win;
  g.document = doc;
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.timeAgo = () => "5m ago";
  // The app-shell API client the widgets call as a bare global. filterOptions
  // is the one fetch the type grid rides; nocSummary lets a test read the
  // query string the filter actually produces.
  g.api = {
    dashboard: {
      filterOptions: () => Promise.resolve({ assetTypes: FILTER_OPTIONS_TYPES, regions: [], fortigates: [] }),
      nocSummary,
    },
  };
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/index.js"), "utf8"));
  W = (win as unknown as { PolarisWidgets: Widgets }).PolarisWidgets;
  g.PolarisWidgets = W;
  (0, eval)(readFileSync(resolve(here, "../../public/js/widgets/assetTypes.js"), "utf8"));
});

describe("widget asset-type vocabulary vs the registry", () => {
  // The drift-catcher. If someone adds a built-in to the registry without
  // touching the widgets, this fails and names the missing type.
  it("BUILTIN_ASSET_TYPES matches BUILT_IN_ASSET_TYPES exactly, in order", () => {
    expect(W.BUILTIN_ASSET_TYPES).toEqual([...BUILT_IN_ASSET_TYPES]);
  });

  it("every built-in has a display label", () => {
    const missing = BUILT_IN_ASSET_TYPES.filter((t) => !W.ASSET_TYPE_LABELS[t]);
    expect(missing).toEqual([]);
  });

  it("every built-in has a chart color", () => {
    const missing = BUILT_IN_ASSET_TYPES.filter((t) => !W.ASSET_TYPE_COLORS[t]);
    expect(missing).toEqual([]);
  });

  it("carries the two built-ins that were missing (hypervisor, kubernetes_cluster)", () => {
    expect(W.BUILTIN_ASSET_TYPES).toContain("hypervisor");
    expect(W.BUILTIN_ASSET_TYPES).toContain("kubernetes_cluster");
  });
});

describe("effectiveAssetTypes — reading a stored filter in today's terms", () => {
  it("leaves an unset filter unfiltered", () => {
    expect(W.effectiveAssetTypes(undefined)).toBeNull();
    expect(W.effectiveAssetTypes(null)).toBeNull();
  });

  // The regression that matters: a config that was all-on when it was saved
  // must not become a NARROWING the moment a built-in is added, or the server
  // starts hiding the types that config never heard of.
  it("widens an all-on legacy config to every current built-in", () => {
    expect(W.effectiveAssetTypes(LEGACY)).toEqual([...BUILT_IN_ASSET_TYPES]);
  });

  it("widened all-on is not a strict subset, so no filter param is sent", () => {
    const resolved = W.effectiveAssetTypes(LEGACY)!;
    expect(resolved.length).toBe(W.BUILTIN_ASSET_TYPES.length);
  });

  it("passes a deliberate narrowing through untouched", () => {
    expect(W.effectiveAssetTypes(["server", "switch"])).toEqual(["server", "switch"]);
  });

  it("passes a post-upgrade pick through untouched", () => {
    const pick = [...LEGACY.slice(0, 7), "hypervisor"];
    expect(W.effectiveAssetTypes(pick)).toEqual(pick);
  });
});

describe("Assets-by-type chart renders types the label map doesn't know", () => {
  const rows = [
    { assetType: "server", count: 10 },
    { assetType: "kubernetes_cluster", count: 5 },
    { assetType: "plc_controller", count: 5 }, // operator-added custom type
  ];

  function render(chartStyle: string) {
    const el = doc.createElement("div");
    W.getByType("assetTypes").renderInstance(
      el, { chartStyle, hiddenTypes: [] }, rows, { onUnmount: () => {} },
    );
    return el;
  }

  it("draws a newer built-in with its label", () => {
    expect(render("pie").innerHTML).toContain("K8s Cluster");
  });

  it("draws an operator-added custom type, humanized from its stored name", () => {
    expect(render("pie").innerHTML).toContain("Plc Controller");
  });

  it("legends every type present, not just the known ones", () => {
    const hits = render("pie").innerHTML.match(/dash-pie-legend-item/g) || [];
    expect(hits.length).toBe(3);
  });

  // 10/5/5 of 20 = 50/25/25. Before the fix the two unknown types were dropped
  // from the drawing but kept in the total, so server read 50% and the
  // remaining half of the circle was simply absent.
  it("takes percentages from the rows it actually draws", () => {
    const html = render("pie").innerHTML;
    expect(html).toContain("50%");
    expect(html).toContain("25%");
  });

  it("bars every type present, scaled against a visible max", () => {
    const hits = render("bar").innerHTML.match(/util-bar-fill/g) || [];
    expect(hits.length).toBe(3);
  });

  it("still honors the gear's hidden-types pick", () => {
    const el = doc.createElement("div");
    W.getByType("assetTypes").renderInstance(
      el, { chartStyle: "pie", hiddenTypes: ["kubernetes_cluster"] }, rows, { onUnmount: () => {} },
    );
    expect(el.innerHTML).not.toContain("K8s Cluster");
    expect(el.innerHTML).toContain("Plc Controller");
  });
});

/**
 * The filter is stored as the switched-OFF list (`assetTypesOff`) and sent as
 * ?hideAssetTypes=. The legacy enabled list (`assetTypes`, built-ins only) is
 * still read: naming the hidden set is what makes a CUSTOM type filterable,
 * and it is why a type added to the registry later stays visible — it is in
 * nobody's off-list.
 */
describe("hiddenAssetTypes — the filter as the server hears it", () => {
  it("hides nothing for an unset filter", () => {
    expect(W.hiddenAssetTypes({})).toEqual([]);
  });

  it("hides nothing for an all-on legacy config (widened, not read as a narrowing)", () => {
    expect(W.hiddenAssetTypes({ assetTypes: LEGACY })).toEqual([]);
  });

  it("turns a legacy enabled list into the built-ins it leaves out", () => {
    expect(W.hiddenAssetTypes({ assetTypes: ["server", "switch"] }))
      .toEqual(BUILT_IN_ASSET_TYPES.filter((t) => !["server", "switch"].includes(t)));
  });

  // The whole point: a custom type can be switched off. Under the legacy shape
  // the hidden set came from the built-ins, so a custom name could never be in
  // it and the type showed in every widget no matter what the operator picked.
  it("hides a custom type named in the off-list", () => {
    expect(W.hiddenAssetTypes({ assetTypesOff: ["network_camera"] })).toEqual(["network_camera"]);
  });

  // The known limit of the widening rule, retired: unchecking ONLY the newer
  // built-ins used to store an all-eight-legacy enabled list, which read as
  // all-on and widened straight back.
  it("keeps a newer-built-ins-only pick that the legacy shape lost", () => {
    expect(W.hiddenAssetTypes({
      assetTypes: LEGACY,
      assetTypesOff: ["hypervisor", "kubernetes_cluster"],
    })).toEqual(["hypervisor", "kubernetes_cluster"]);
  });

  it("unions both shapes without repeating a name", () => {
    expect(W.hiddenAssetTypes({ assetTypes: ["server"], assetTypesOff: ["printer", "network_camera"] }))
      .toEqual(["printer", "network_camera", ...BUILT_IN_ASSET_TYPES.filter((t) => !["server", "printer"].includes(t))]);
  });
});

describe("what the asset-type filter puts on the wire", () => {
  const call = async (config: Record<string, unknown>) => {
    nocSummary.mockClear();
    await W.getNocSummary(W.nocFilterOpts(config), ["downNodes"]);
    return String((nocSummary.mock.calls[0] || [""])[0]);
  };

  it("sends no asset-type param when nothing is off", async () => {
    expect(await call({ assetTypes: LEGACY })).toBe("feeds=downNodes");
  });

  it("sends the off-list as hideAssetTypes, sorted", async () => {
    expect(await call({ assetTypesOff: ["network_camera", "printer"] }))
      .toBe("hideAssetTypes=network_camera%2Cprinter&feeds=downNodes");
  });

  it("sends a legacy enabled list as the built-ins it hides", async () => {
    const qs = await call({ assetTypes: ["server", "switch"] });
    expect(qs).toContain("hideAssetTypes=");
    expect(decodeURIComponent(qs)).toContain("access_point,firewall,hypervisor");
    expect(decodeURIComponent(qs)).not.toContain("server");
  });
});

describe("the gear's asset-type grid", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("paints the built-ins synchronously, then adds the fleet's custom types", async () => {
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    W.renderNocFilterConfig(el, {}, () => {}, true);
    expect(el.querySelectorAll("[data-noctype]").length).toBe(BUILT_IN_ASSET_TYPES.length);
    await flush();
    const names = Array.from(el.querySelectorAll("[data-noctype]"))
      .map((cb) => (cb as unknown as Element).getAttribute("data-noctype"));
    expect(names).toEqual([...BUILT_IN_ASSET_TYPES, "network_camera"]);
    // Registry label, so the checkbox doesn't read "network_camera"…
    expect(el.innerHTML).toContain("Network Camera");
    // …while the compact built-in label the widgets use survives the
    // registry's longer "Access Point".
    expect(W.ASSET_TYPE_LABELS.access_point).toBe("AP");
    expect(W.ASSET_TYPE_LABELS.network_camera).toBe("Network Camera");
  });

  it("everything is checked by default, and unchecking a custom type stores it off", async () => {
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const changes: Array<[string, unknown]> = [];
    W.renderNocFilterConfig(el, {}, (k, v) => changes.push([k, v]), true);
    await flush();
    const boxes = Array.from(el.querySelectorAll("[data-noctype]")) as unknown as Array<
      Element & { checked: boolean; dispatchEvent: (e: unknown) => void }
    >;
    expect(boxes.every((b) => b.checked)).toBe(true);
    const camera = boxes.find((b) => b.getAttribute("data-noctype") === "network_camera")!;
    camera.checked = false;
    camera.dispatchEvent(new (doc.defaultView as unknown as { Event: new (t: string) => unknown }).Event("change"));
    expect(changes).toEqual([
      ["assetTypesOff", ["network_camera"]],
      ["assetTypes", BUILT_IN_ASSET_TYPES.filter((t) => t !== "network_camera")],
    ]);
  });

  it("shows a stored off-list unchecked, and keeps a type the grid no longer offers", async () => {
    const el = doc.createElement("div");
    doc.body.appendChild(el);
    const changes: Array<[string, unknown]> = [];
    // `plc` isn't offered (no assets wear it any more) but is still switched
    // off — dropping it on the next toggle would silently un-hide it.
    W.renderNocFilterConfig(el, { assetTypesOff: ["printer", "plc"] }, (k, v) => changes.push([k, v]), true);
    await flush();
    const boxes = Array.from(el.querySelectorAll("[data-noctype]")) as unknown as Array<
      Element & { checked: boolean; dispatchEvent: (e: unknown) => void }
    >;
    expect(boxes.find((b) => b.getAttribute("data-noctype") === "printer")!.checked).toBe(false);
    const camera = boxes.find((b) => b.getAttribute("data-noctype") === "network_camera")!;
    camera.checked = false;
    camera.dispatchEvent(new (doc.defaultView as unknown as { Event: new (t: string) => unknown }).Event("change"));
    expect(changes[0]).toEqual(["assetTypesOff", ["printer", "network_camera", "plc"]]);
  });
});

describe("widgetTitle names the narrowing the short way round", () => {
  const mod = { label: "Down Assets" };

  it("stays bare when nothing is off", () => {
    expect(W.widgetTitle(mod, { config: { assetTypes: LEGACY } })).toBe("Down Assets");
  });

  it("names the types shown when most are off", () => {
    expect(W.widgetTitle(mod, { config: { assetTypes: ["switch", "server"] } }))
      .toBe("Down Assets (Server, Switch)");
  });

  // Listing the eleven types that remain to say one is off is a header nobody
  // can read at wallboard distance.
  it("names what's excluded when only a few are off", () => {
    expect(W.widgetTitle(mod, { config: { assetTypesOff: ["network_camera", "printer"] } }))
      .toBe("Down Assets (excl. Printer, Network Camera)");
  });

  it("says so when the grid has nothing left on", () => {
    expect(W.widgetTitle(mod, { config: { assetTypes: [], assetTypesOff: [...BUILT_IN_ASSET_TYPES] } }))
      .toBe("Down Assets (no types)");
  });
});
