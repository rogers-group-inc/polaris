/**
 * tests/unit/manufacturerProfileScopeUi.test.ts — the profile table draws the
 * three scope tiers and the row facts that used to live in code.
 *
 * The table is the only place an operator can see what a profile will do, so
 * what is pinned is what would quietly mislead: a device-type default must
 * read as a DEFAULT for that type rather than a model exception with an empty
 * pattern; the hierarchy has to be visible because the resolver's precedence
 * follows it; the server's `order` must survive the grouping (it decides
 * which regex wins at probe time); and the add row has to offer the registry's
 * device types, or the tier is unreachable from the UI. The metric-specific
 * extras (aggregate / label / parse) are pinned per metric because each is a
 * fact that could only be expressed in the hardcoded constant before Phase 4.
 *
 * server-settings.js is a plain browser script whose only load-time side effect
 * is a DOMContentLoaded listener (never dispatched here), so it evals into a
 * happy-dom Window and its `function`/`var` declarations land on that global.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

interface Sandbox {
  renderProfileDetail: (detail: unknown) => string;
  _mfgGroupOverrides: (rows: unknown[]) => Array<{ id: string }>;
  _mfgDeviceTypeSelect: (selected: string | null, cls: string) => string;
  _mfgExtraViewHTML: (metricKey: string, vals: unknown) => string;
  _mfgExtraEditHTML: (metricKey: string, prefix: string, vals: unknown) => string;
  _mfgEditContainerKey: (el: unknown) => string;
  _mfgEditContainerOf: (el: unknown) => unknown;
  _mfgSnapshotFields: (el: unknown) => Record<string, unknown>;
  _assetTypes: Array<{ name: string; label: string }>;
  _mibsData: unknown[];
  METRIC_KEY_LABELS: Record<string, string>;
  document: Document;
}

let sb: Sandbox;

beforeAll(() => {
  const win = new Window({ url: "https://polaris.test/server-settings.html" });
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => String(n),
    escapeHtml: (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)),
    showToast: () => {},
    permAtLeast: () => true,
    api: {},
  });
  const code = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8");
  (win as unknown as { eval: (s: string) => void }).eval(code);
  sb = win as unknown as Sandbox;
});

beforeEach(() => {
  sb._mibsData = [];
  sb._assetTypes = [
    { name: "firewall",     label: "Firewall" },
    { name: "switch",       label: "Switch" },
    { name: "access_point", label: "Access Point" },
  ];
});

function override(o: Record<string, unknown>) {
  return {
    id: "o", assetType: null, modelPattern: null, symbol: "sym", symbolB: null,
    mibId: null, mibStdKey: null, type: "scalar", transform: null,
    aggregate: "none", label: null, parsePattern: null, parseTemplate: null, order: 0, ...o,
  };
}

function detail(metrics: Array<Record<string, unknown>>) {
  return {
    id: "p1", manufacturer: "Fortinet", matchPattern: null, widgets: [],
    metrics: metrics.map((m) => ({
      id: "m-" + m.metricKey, defaultSymbol: null, defaultSymbolB: null,
      defaultMibId: null, defaultMibStdKey: null, defaultType: "scalar",
      defaultTransform: null, defaultAggregate: "none", defaultLabel: null,
      defaultParsePattern: null, defaultParseTemplate: null, overrides: [], ...m,
    })),
  };
}

describe("_mfgGroupOverrides", () => {
  it("puts each type's default above that type's model exceptions, any-type rows last", () => {
    const rows = [
      override({ id: "sw-model", assetType: "switch", modelPattern: "S548DF" }),
      override({ id: "any-model", modelPattern: "201G" }),
      override({ id: "ap-default", assetType: "access_point" }),
      override({ id: "sw-default", assetType: "switch" }),
    ];
    expect(sb._mfgGroupOverrides(rows).map((r) => r.id)).toEqual([
      // Device types sort by the label an operator sees: Access Point, Switch.
      "ap-default", "sw-default", "sw-model", "any-model",
    ]);
  });

  it("keeps the server's order within a tier — it decides which regex wins", () => {
    const rows = [
      override({ id: "second", assetType: "switch", modelPattern: "S5", order: 1 }),
      override({ id: "first",  assetType: "switch", modelPattern: "S548DF", order: 0 }),
    ];
    expect(sb._mfgGroupOverrides(rows).map((r) => r.id)).toEqual(["second", "first"]);
  });
});

describe("_mfgDeviceTypeSelect", () => {
  it("offers every registry type plus an explicit any", () => {
    const html = sb._mfgDeviceTypeSelect(null, "x");
    expect(html).toContain(">Any device type<");
    expect(html).toContain('value="access_point"');
    expect(html).toContain('value="switch"');
  });

  it("keeps a stored type the registry no longer carries selectable", () => {
    // Otherwise opening the editor on such a row would silently rewrite its
    // scope to "any" the moment it was saved.
    const html = sb._mfgDeviceTypeSelect("camera", "x");
    expect(html).toContain('value="camera"');
    expect(html).toContain("(unknown)");
  });
});

describe("the profile's 'also applies when' pattern", () => {
  it("renders the stored pattern, and an empty box when there is none", () => {
    const withPattern = sb.renderProfileDetail({ ...detail([{ metricKey: "cpu" }]), matchPattern: "aruba|hpe|procurve" });
    expect(withPattern).toContain("Also applies when");
    expect(withPattern).toContain('class="mfg-matchpattern" value="aruba|hpe|procurve"');

    const without = sb.renderProfileDetail(detail([{ metricKey: "cpu" }]));
    expect(without).toContain('class="mfg-matchpattern" value=""');
  });

  it("keys the box for the form-preserve snapshot, so an unsaved pattern survives a re-render", () => {
    // _mfgEditContainerKey needs the container to be findable AND to have its
    // own identity; without both, typing a pattern and then touching any MIB
    // select below erases it.
    const html = sb.renderProfileDetail(detail([{ metricKey: "cpu" }]));
    expect(html).toContain('class="mfg-profile-scope"');
    expect(html).toContain('data-profile-id="p1"');

    const doc = sb.document;
    doc.body.innerHTML = html;
    const box = doc.querySelector(".mfg-profile-scope");
    expect(sb._mfgEditContainerKey(box)).toBe("profile:p1");
    expect(sb._mfgEditContainerOf(doc.querySelector(".mfg-matchpattern"))).toBe(box);
    expect(sb._mfgSnapshotFields(box)).toHaveProperty("mfg-matchpattern");
  });
});

describe("renderProfileDetail — the three tiers", () => {
  it("marks a device-type default as that type's DEFAULT, not a blank pattern", () => {
    const html = sb.renderProfileDetail(detail([
      { metricKey: "cpu", overrides: [override({ id: "o1", assetType: "switch", symbol: "fsSysCpuUsage" })] },
    ]));
    expect(html).toContain("Switch");
    // Two DEFAULT markers on this metric: the profile-wide row and the switch
    // row. The switch row must not render an empty <code> model cell.
    expect(html.match(/>DEFAULT</g)?.length).toBe(2);
    expect(html).not.toContain('<code style="font-size:0.8rem"></code>');
  });

  it("indents a model exception deeper than the device-type default above it", () => {
    const html = sb.renderProfileDetail(detail([
      {
        metricKey: "temperature",
        overrides: [
          override({ id: "o1", assetType: "firewall", symbol: "fgHwSensorTable", type: "table" }),
          override({ id: "o2", assetType: "firewall", modelPattern: "201G", symbol: "fgHwSensorTable", type: "table" }),
        ],
      },
    ]));
    expect(html).toContain("padding-left:20px");  // the type default
    expect(html).toContain("padding-left:32px");  // its model exception
    expect(html).toContain("201G");
  });

  it("gives the add row both halves of a scope", () => {
    const html = sb.renderProfileDetail(detail([{ metricKey: "cpu" }]));
    expect(html).toContain("mfg-new-override-assettype");
    expect(html).toContain("mfg-new-override-pattern");
    expect(html).toContain("Model regex (optional)");
  });
});

describe("the row facts that used to live in the hardcoded constant", () => {
  it("offers an aggregate on cpu/memory, a label on storage/temperature, a parse on model — and nothing elsewhere", () => {
    expect(sb._mfgExtraEditHTML("cpu", "mfg-edit", {})).toContain("mfg-edit-aggregate");
    expect(sb._mfgExtraEditHTML("memory", "mfg-edit", {})).toContain("mfg-edit-aggregate");
    expect(sb._mfgExtraEditHTML("storage", "mfg-edit", {})).toContain("mfg-edit-label");
    expect(sb._mfgExtraEditHTML("temperature", "mfg-edit", {})).toContain("mfg-edit-label");
    const parse = sb._mfgExtraEditHTML("model", "mfg-edit", {});
    expect(parse).toContain("mfg-edit-parsepattern");
    expect(parse).toContain("mfg-edit-parsetemplate");
    expect(sb._mfgExtraEditHTML("lldp", "mfg-edit", {})).toBe("");
  });

  it("shows each fact in the view row only when it is set", () => {
    expect(sb._mfgExtraViewHTML("memory", { aggregate: "sum" })).toContain("sum rows");
    expect(sb._mfgExtraViewHTML("memory", { aggregate: "none" })).toBe("");
    expect(sb._mfgExtraViewHTML("storage", { label: "flash" })).toContain("flash");
    expect(sb._mfgExtraViewHTML("model", { parsePattern: "^(.+?)-v", parseTemplate: "FortiSwitch $1" })).toContain("FortiSwitch $1");
    expect(sb._mfgExtraViewHTML("cpu", {})).toBe("");
  });

  it("labels the model row", () => {
    expect(sb.METRIC_KEY_LABELS.model).toBe("Model identity");
  });

  it("every extra control is keyed for the form-preserve snapshot", () => {
    // _mfgFieldKey keys on the first `mfg-` class; a control without one is
    // erased by the chained-select re-render that manufacturerProfileFormPreserve
    // exists to prevent.
    for (const html of [sb._mfgExtraEditHTML("cpu", "mfg-edit", {}), sb._mfgExtraEditHTML("storage", "mfg-edit", {}), sb._mfgExtraEditHTML("model", "mfg-edit", {})]) {
      for (const m of html.matchAll(/class="([^"]+)"/g)) expect(m[1]).toMatch(/^mfg-/);
    }
  });
});
