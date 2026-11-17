/**
 * tests/unit/arcgisLayerTypesForm.test.ts — the ArcGIS integration's Layers
 * tab drawn by type (business rule 188(b), public/js/integrations-forms.js):
 * One style keeps the colour swatches; By type draws the types table — a
 * tick-box column with no header word, each type's value, count, colour,
 * width and line, and the Other types row — and the config sent on save
 * carries the types and the layer's area (rule 188(c)). Synthetic data only.
 */

import { describe, it, expect, beforeAll } from "vitest";
import vm from "node:vm";
import { integrationsFileSource } from "./_integrationsSource.js";

const ID = "aaaaaaaa-0000-4000-8000-000000000001";
let sb: Record<string, any>;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

beforeAll(() => {
  sb = { console, window: {}, escapeHtml: esc, document: { getElementById: (id: string) => (id === "arc-selected" ? {} : null) } };
  vm.createContext(sb);
  vm.runInContext(integrationsFileSource("integrations-forms.js"), sb);
});

const st = (color: string, dash = "solid") => ({ color, width: 3, dash });
function layer(extra: Record<string, unknown> = {}) {
  return {
    id: ID, url: "https://services.example.test/x/FeatureServer/0", title: "Utility lines", geometry: "line", idField: "GlobalID",
    popupFields: [], style: { color: "accent", width: 3, dash: "solid" }, ...extra,
  };
}
const TYPES = {
  field: "LINE_TYPE", numeric: false,
  values: [{ value: "GAS", label: "Gas line", on: true, style: st("#f4e04d") }, { value: "OH", label: "OH electric line", on: false, style: st("#e53935", "dashed") }],
  other: { on: false, style: st("#9aa0a6") },
};

function open(l: Record<string, unknown>) {
  sb.arcgisLayersHTML({ layers: [l] });
  sb._arcgisDraft.fields[ID] = [{ name: "LINE_TYPE", alias: "Line type", type: "esriFieldTypeString" }, { name: "LEN", alias: "LEN", type: "esriFieldTypeDouble" }];
}

describe("Layers tab — style by type (rule 188(b))", () => {
  it("One style keeps the colour swatches and offers the By type switch", () => {
    open(layer());
    const html: string = sb.arcgisEditorHTML();
    expect(html).toContain('data-arc-mode="types"');
    expect(html).toContain("data-arc-color=");
    expect(html).not.toContain("data-arc-types");
  });

  it("By type keeps the Layers tab short: a summary, the drawn types and Edit types — no table", () => {
    open(layer({ types: TYPES }));
    const html: string = sb.arcgisEditorHTML();
    expect(html).not.toContain("data-arc-color=");
    expect(html).not.toContain("data-arc-types");
    expect(html).toContain('id="arc-types-edit"');
    expect(html).toContain("1 of 2 types drawn");
    expect(html).toContain("Gas line");
    expect(html).not.toContain("OH electric line");
  });

  it("the types dialog draws the table: an unlabelled tick-box column, values, styles and Other types", () => {
    open(layer({ types: TYPES }));
    sb._arcgisDraft.typeInfo[ID] = { field: "LINE_TYPE", values: [{ value: "GAS", count: 1204, fromArcgis: true }], blank: 3 };
    const html: string = sb.arcgisTypesDialogHTML(ID, TYPES);
    const editor: string = sb.arcgisEditorHTML();
    expect(html).toContain("data-arc-types");
    expect(html).toContain('id="arc-types-reset"');
    expect(html).toContain('<th style="width:34px"></th>');
    expect(html).toContain('data-arc-type-on="0" aria-label="Draw Gas line" checked');
    expect(html).toMatch(/data-arc-type-on="1" aria-label="Draw OH electric line"(?! checked)/);
    expect(html).toContain('value="#e53935"');
    expect(html).toContain(new Intl.NumberFormat().format(1204));
    expect(html).toContain("Other types");
    expect(html).toContain("3 lines with no type");
    // Only text and whole-number fields can sort lines into types.
    const typeSelect = editor.slice(editor.indexOf('id="arc-type-field"'), editor.indexOf("</select>", editor.indexOf('id="arc-type-field"')));
    expect(typeSelect).toContain('<option value="LINE_TYPE" selected>');
    expect(typeSelect).not.toContain('<option value="LEN"');
    // The layer list shows how many types are drawn.
    expect(sb.arcgisSelectedRowsHTML()).toContain("1 of 2 types");
  });

  it("By type with nothing read yet asks for the field first", () => {
    open(layer());
    sb._arcgisDraft.mode[ID] = "types";
    const html: string = sb.arcgisEditorHTML();
    expect(html).toContain("Pick the field that sorts the lines into kinds");
    expect(html).toContain('id="arc-read-types"');
  });

  it("sends the types and the area on save", () => {
    open(layer({ types: TYPES, extent: [-86, 37, -85, 38] }));
    const [out] = JSON.parse(JSON.stringify(sb.getArcgisLayersConfig()));
    expect(out.types).toEqual(TYPES);
    expect(out.extent).toEqual([-86, 37, -85, 38]);
    open(layer());
    const [plain] = JSON.parse(JSON.stringify(sb.getArcgisLayersConfig()));
    expect(plain).not.toHaveProperty("types");
    expect(plain).not.toHaveProperty("extent");
  });
});
