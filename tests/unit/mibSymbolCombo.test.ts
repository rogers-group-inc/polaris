/**
 * tests/unit/mibSymbolCombo.test.ts — the Manufacturer Profiles Symbol picker
 * as a type-to-filter combobox (`renderSymbolPicker` + the delegated handlers).
 *
 * It replaced a <select>: a vendor MIB carries hundreds to thousands of symbols
 * (APC PowerNet-MIB alone is ~3 MB) and nobody can scroll that. The risk in the
 * swap is losing what the <select> did for free — a restore after a MIB or Type
 * change dropping a symbol the new list doesn't offer — so that is pinned here
 * beside the filtering itself.
 *
 * server-settings.js is evaluated into a happy-dom Window the same way
 * manufacturerProfileFormPreserve.test.ts does it.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";

interface Sandbox {
  document: Document;
  renderSymbolPicker: (sym: string, mibId: string, cls: string, type?: string) => string;
  _renderSymCombo: (input: HTMLInputElement) => void;
  _symComboAccepts: (input: HTMLInputElement, v: string) => boolean;
  _filterSuggestRows: (rows: { value: string; assetCount: number }[], q: string) => { value: string }[];
  _manufacturerCountRows: (names: string[]) => { value: string; assetCount: number }[];
  _mfgRestoreEditors: (snap: Record<string, Record<string, unknown>>) => void;
  _mfgMibSymbolsCache: Record<string, unknown>;
}

let win: Window;
let sb: Sandbox;

beforeAll(() => {
  win = new Window({ url: "https://polaris.test/server-settings.html" });
  Object.assign(win as unknown as Record<string, unknown>, {
    formatBytes: (n: number) => String(n),
    escapeHtml: (x: unknown) => String(x ?? ""),
    showToast: () => {},
    permAtLeast: () => true,
    api: {},
  });
  const code = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8");
  (win as unknown as { eval: (s: string) => void }).eval(code);
  sb = win as unknown as Sandbox;
});

beforeEach(() => {
  sb._mfgMibSymbolsCache = {
    "mib-ups": {
      loading: false,
      scalars: ["upsAdvBatteryCapacity", "upsAdvBatteryTemperature", "upsBasicIdentModel", "xupsBatteryCapacity"],
      tables: ["upsPhaseInputTable"],
    },
    "mib-other": { loading: false, scalars: ["otherThing"], tables: [] },
  };
});

function mount(html: string): HTMLInputElement {
  sb.document.body.innerHTML = '<div class="mfg-widget-add-card" data-profile-id="p1">' + html + "</div>";
  return sb.document.querySelector(".mfg-widget-symbol") as HTMLInputElement;
}

function shown(input: HTMLInputElement): string[] {
  return Array.from(input.nextElementSibling!.querySelectorAll(".aw-suggest-item"))
    .map((el) => el.getAttribute("data-val")!);
}

describe("renderSymbolPicker", () => {
  it("renders a typeable box, not a select, once the MIB's symbols are loaded", () => {
    const input = mount(sb.renderSymbolPicker("", "mib-ups", "mfg-widget-symbol", "scalar"));
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("placeholder")).toBe("Type to filter 4 scalar symbols");
  });

  it("still renders the disabled loading select while the list is in flight", () => {
    sb._mfgMibSymbolsCache = { "mib-ups": { loading: true, scalars: [], tables: [] } };
    sb.document.body.innerHTML = sb.renderSymbolPicker("", "mib-ups", "mfg-widget-symbol", "scalar");
    expect(sb.document.querySelector("select.mfg-widget-symbol")!.hasAttribute("disabled")).toBe(true);
  });

  it("keeps a saved symbol that is not in the chosen list, flagged rather than erased", () => {
    const input = mount(sb.renderSymbolPicker("upsPhaseInputTable", "mib-ups", "mfg-widget-symbol", "scalar"));
    expect(input.value).toBe("upsPhaseInputTable");
    expect(input.getAttribute("title")).toBe("Not a scalar in this MIB");
  });
});

describe("filtering", () => {
  it("lists prefix matches before interior ones, case-insensitively", () => {
    const input = mount(sb.renderSymbolPicker("", "mib-ups", "mfg-widget-symbol", "scalar"));
    input.value = "UPSADVBATTERY";
    sb._renderSymCombo(input);
    expect(shown(input)).toEqual(["upsAdvBatteryCapacity", "upsAdvBatteryTemperature"]);

    input.value = "batterycap";
    sb._renderSymCombo(input);
    expect(shown(input)).toEqual(["upsAdvBatteryCapacity", "xupsBatteryCapacity"]);
  });

  it("keeps a fully-typed symbol listed, first, instead of reporting no match", () => {
    const input = mount(sb.renderSymbolPicker("", "mib-ups", "mfg-widget-symbol", "scalar"));
    input.value = "upsadvbatterycapacity";
    sb._renderSymCombo(input);
    expect(shown(input)).toEqual(["upsAdvBatteryCapacity"]);
  });

  it("offers the table side when the symbol type is table", () => {
    const input = mount(sb.renderSymbolPicker("", "mib-ups", "mfg-widget-symbol", "table"));
    sb._renderSymCombo(input);
    expect(shown(input)).toEqual(["upsPhaseInputTable"]);
  });
});

describe("_filterSuggestRows (both manufacturer pickers)", () => {
  // Rows arrive in device-count order; the filter must keep that order inside
  // each band. Reported: typing "APC" — a name 8 devices carry — got "No known
  // manufacturer matches" because the exact match was being dropped.
  const rows = [
    { value: "Fortinet", assetCount: 900 },
    { value: "APC Partner Co", assetCount: 20 },
    { value: "APC", assetCount: 8 },
    { value: "Napco", assetCount: 3 },
  ];

  it("keeps the exact match and puts it first, then prefix, then interior", () => {
    expect(sb._filterSuggestRows(rows, "apc").map((r) => r.value)).toEqual(["APC", "APC Partner Co", "Napco"]);
  });

  it("returns every row, in the caller's order, for an empty query", () => {
    expect(sb._filterSuggestRows(rows, "").map((r) => r.value)).toEqual(["Fortinet", "APC Partner Co", "APC", "Napco"]);
  });
});

describe("_manufacturerCountRows (MIB upload, Device Icons, aliases, MAC overrides)", () => {
  it("de-duplicates case-insensitively, attaches device counts, and sorts busiest first", () => {
    (sb as unknown as { _mibFacets: unknown })._mibFacets = {
      manufacturers: ["APC", "Cisco", "Xytronix"],
      modelsByManufacturer: {},
      assetCounts: { APC: 8, Cisco: 40 },
    };
    const rows = sb._manufacturerCountRows(["apc", "APC", "Cisco", "Xytronix", "Axis Communications", ""]);
    expect(rows).toEqual([
      { value: "Cisco", assetCount: 40 },
      { value: "apc", assetCount: 8 },
      { value: "Axis Communications", assetCount: 0 },
      { value: "Xytronix", assetCount: 0 },
    ]);
  });
});

describe("restore after a re-render", () => {
  it("drops a symbol the newly-picked MIB doesn't offer, as the select did", () => {
    mount(sb.renderSymbolPicker("", "mib-other", "mfg-widget-symbol", "scalar"));
    sb._mfgRestoreEditors({ "new-widget:p1": { "mfg-widget-symbol": "upsAdvBatteryCapacity" } });
    expect((sb.document.querySelector(".mfg-widget-symbol") as HTMLInputElement).value).toBe("");
  });

  it("restores a symbol the list does offer", () => {
    mount(sb.renderSymbolPicker("", "mib-ups", "mfg-widget-symbol", "scalar"));
    sb._mfgRestoreEditors({ "new-widget:p1": { "mfg-widget-symbol": "upsBasicIdentModel" } });
    expect((sb.document.querySelector(".mfg-widget-symbol") as HTMLInputElement).value).toBe("upsBasicIdentModel");
  });

  it("never restores the loading placeholder's text into the box", () => {
    const input = mount(sb.renderSymbolPicker("", "mib-ups", "mfg-widget-symbol", "scalar"));
    expect(sb._symComboAccepts(input, "Loading symbols…")).toBe(false);
  });
});
