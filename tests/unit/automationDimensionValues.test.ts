/**
 * tests/unit/automationDimensionValues.test.ts — the automation builder's
 * dimension-value picker.
 *
 * Two halves, both pure:
 *  - `foldValuePairs` (notificationDimensionService) turns the Postgres-side
 *    GROUP BY (value, assetId) rows into per-value DEVICE counts. Counting rows
 *    instead of distinct assets would report "temperature (12431)".
 *  - the client's option/note builders (public/js/automations-wizard.js, off
 *    window.PolarisAutomationDimensions). The load-bearing cases: a stored
 *    filter value the scoped devices don't currently report must stay selected
 *    (otherwise opening an old automation quietly widens it to "any"), and an
 *    empty result has to say so — that message is the whole reason the picker
 *    replaced a free-text box.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import { foldValuePairs } from "../../src/services/notificationDimensionService.js";

interface DimResult {
  values: { value: string; assetCount: number }[];
  noun: string;
  narrowLabel?: string;
  scopedAssets: number;
  sampledAssets: number;
  assetsWithData: number;
  windowHours: number;
  loading?: boolean;
  error?: boolean;
}

let optionsHtml: (res: DimResult | null, current: string) => string;
let suggestHtml: (res: DimResult | null | { loading: true } | { error: true }, query: string) => string;
let matchCue: (res: DimResult | null | { loading: true } | { error: true }, value: string) => { text: string; warn: boolean };
let note: (res: DimResult | null | { loading: true } | { error: true }) => { text: string; warn: boolean };
let narrow: (
  dim: string,
  df: Record<string, string> | null,
  state?: { stateOperator?: string; stateValue?: string } | null,
) => Record<string, string>;

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const code = readFileSync(resolve(here, "../../public/js/automations-wizard.js"), "utf8");
  const sandbox: Record<string, any> = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null },
    escapeHtml: (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    api: {},
    permAtLeast: () => true,
    showToast: () => {},
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  ({ optionsHtml, suggestHtml, matchCue, note, narrow } = sandbox.window.PolarisAutomationDimensions);
});

const result = (over: Partial<DimResult> = {}): DimResult => ({
  values: [{ value: "temperature", assetCount: 8 }, { value: "fan", assetCount: 6 }],
  noun: "hardware sensors",
  narrowLabel: "",
  scopedAssets: 8,
  sampledAssets: 8,
  assetsWithData: 8,
  windowHours: 3,
  ...over,
});

describe("foldValuePairs", () => {
  it("counts DISTINCT devices per value, not sample rows", () => {
    const { values, assetsWithData } = foldValuePairs([
      { value: "temperature", assetId: "a" },
      { value: "temperature", assetId: "b" },
      { value: "temperature", assetId: "a" }, // same device again
      { value: "fan", assetId: "a" },
    ]);
    expect(values).toEqual([
      { value: "temperature", assetCount: 2 },
      { value: "fan", assetCount: 1 },
    ]);
    expect(assetsWithData).toBe(2);
  });

  it("drops null/empty values and reports no devices when nothing is reported", () => {
    const { values, assetsWithData } = foldValuePairs([
      { value: null, assetId: "a" },
      { value: "", assetId: "b" },
    ]);
    expect(values).toEqual([]);
    expect(assetsWithData).toBe(0);
  });

  it("orders by device count then alphabetically, so ties are stable", () => {
    const { values } = foldValuePairs([
      { value: "voltage", assetId: "a" },
      { value: "fan", assetId: "a" },
      { value: "power", assetId: "a" },
      { value: "temperature", assetId: "a" },
      { value: "temperature", assetId: "b" },
    ]);
    expect(values.map((v) => v.value)).toEqual(["temperature", "fan", "power", "voltage"]);
  });

  it("names values that aren't self-describing (a state probe's registry id)", () => {
    const { values } = foldValuePairs(
      [{ value: "uuid-1", assetId: "a" }, { value: "uuid-2", assetId: "b" }],
      (v) => (v === "uuid-1" ? "Hardware sensor alarm (Fortinet)" : undefined),
    );
    // Labelled where resolvable, and an unresolvable id keeps working as a bare
    // value rather than disappearing from the picker.
    expect(values).toEqual([
      { value: "uuid-1", assetCount: 1, label: "Hardware sensor alarm (Fortinet)" },
      { value: "uuid-2", assetCount: 1 },
    ]);
  });
});

describe("dimension picker options", () => {
  it("offers (any) plus each reported value with its device count", () => {
    const html = optionsHtml(result(), "");
    expect(html).toContain('<option value="">(any)</option>');
    expect(html).toContain('<option value="temperature">temperature (8)</option>');
    expect(html).toContain('<option value="fan">fan (6)</option>');
  });

  it("marks the current value selected", () => {
    expect(optionsHtml(result(), "fan")).toContain('<option value="fan" selected>');
  });

  it("KEEPS a stored value the devices no longer report, flagged", () => {
    const html = optionsHtml(result(), "disk");
    expect(html).toContain('<option value="disk" selected>disk — not currently reported</option>');
  });

  it("renders just (any) before the values have loaded", () => {
    expect(optionsHtml(null, "")).toBe('<option value="">(any)</option>');
  });

  it("still preserves the stored value with no data loaded", () => {
    expect(optionsHtml(null, "temperature")).toContain('value="temperature" selected');
  });

  it("shows a label instead of the value when the option carries one", () => {
    // The state-probe case: the operator picks a NAME, the rule stores the id.
    const html = optionsHtml(result({
      values: [{ value: "uuid-1", assetCount: 4, label: "Hardware sensor alarm" } as never],
    }), "uuid-1");
    expect(html).toContain('<option value="uuid-1" selected>Hardware sensor alarm (4)</option>');
    expect(html).not.toContain(">uuid-1 (4)<");
  });

});

describe("dimension picker suggestions (substring dimensions)", () => {
  const sensors = result({
    values: [
      { value: "CPU ON-DIE Temperature", assetCount: 12 },
      { value: "CPU Fan", assetCount: 12 },
      { value: "DTS CPU0", assetCount: 4 },
    ],
  });

  it("lists every reported value with its device count when nothing is typed", () => {
    const html = suggestHtml(sensors, "");
    expect(html).toContain('data-val="CPU ON-DIE Temperature"');
    expect(html).toContain('data-val="CPU Fan"');
    expect(html).toContain('data-val="DTS CPU0"');
    expect(html).toContain("(12)");
  });

  it("filters case-insensitively by SUBSTRING, matching what the engine does", () => {
    // "fan" is mid-string in "CPU Fan" — a prefix-matching datalist showed nothing.
    const html = suggestHtml(sensors, "fan");
    expect(html).toContain('data-val="CPU Fan"');
    expect(html).not.toContain('data-val="DTS CPU0"');
  });

  it("says so when a typo matches none of the reported values", () => {
    const html = suggestHtml(sensors, "cpu-temp");
    expect(html).toContain("None of the 3 reported hardware sensors");
    expect(html).toContain("cpu-temp");
    expect(html).not.toContain("aw-suggest-item");
  });

  it("names the empty slice when the devices report nothing (narrowed or not)", () => {
    expect(suggestHtml(result({ values: [], narrowLabel: " of class fan" }), ""))
      .toContain("no hardware sensors of class fan");
  });

  it("stays usable while loading and on error", () => {
    expect(suggestHtml({ loading: true }, "")).toContain("Checking");
    expect(suggestHtml({ error: true }, "")).toContain("still works");
    expect(suggestHtml(null, "")).toContain("Checking");
  });

  it("caps the list and says how much was withheld", () => {
    const many = result({
      values: Array.from({ length: 75 }, (_, i) => ({ value: "sensor" + i, assetCount: 1 })),
    });
    const html = suggestHtml(many, "");
    expect((html.match(/aw-suggest-item/g) || []).length).toBe(60);
    expect(html).toContain("+15 more");
  });
});

describe("dimension picker match cue", () => {
  const sensors = result({
    values: [
      { value: "CPU ON-DIE Temperature", assetCount: 12 },
      { value: "CPU Fan", assetCount: 12 },
    ],
  });

  it("WARNS that a pattern matching nothing would never fire", () => {
    // The reason the cue exists: a pattern dimension accepts free text, so a
    // typo saves cleanly and then silently never matches a reading.
    const c = matchCue(sensors, "CPU ON DIE");
    expect(c.warn).toBe(true);
    expect(c.text).toContain("matches none of the 2 reported hardware sensors");
    expect(c.text).toContain("never fire");
  });

  it("confirms an exact pick", () => {
    expect(matchCue(sensors, "CPU ON-DIE Temperature")).toEqual({ text: "✓ exact match", warn: false });
  });

  it("counts how many a partial pattern selects", () => {
    const c = matchCue(sensors, "cpu");
    expect(c.warn).toBe(false);
    expect(c.text).toBe("✓ matches 2 of 2 reported hardware sensors");
  });

  it("stays silent with an empty filter, while loading, on error, and with no data", () => {
    expect(matchCue(sensors, "").text).toBe("");
    expect(matchCue(sensors, "   ").text).toBe("");
    expect(matchCue({ loading: true }, "CPU").text).toBe("");
    expect(matchCue({ error: true }, "CPU").text).toBe("");
    expect(matchCue(result({ values: [] }), "CPU").text).toBe("");
    expect(matchCue(null, "CPU").text).toBe("");
  });
});

describe("dimension picker note", () => {
  it("warns — and says the condition can never match — when the devices report none", () => {
    const n = note(result({ values: [], assetsWithData: 0 }));
    expect(n.warn).toBe(true);
    expect(n.text).toContain("None of the 8 selected device(s)");
    expect(n.text).toContain("hardware sensors");
    expect(n.text).toContain("never match");
  });

  it("warns when the device filter itself matches nothing", () => {
    const n = note(result({ values: [], scopedAssets: 0, sampledAssets: 0, assetsWithData: 0 }));
    expect(n.warn).toBe(true);
    expect(n.text).toContain("No devices match the filter");
  });

  it("stays quiet when every sampled device reports the dimension", () => {
    expect(note(result())).toEqual({ text: "", warn: false });
  });

  it("says how many devices report it when only some do", () => {
    const n = note(result({ scopedAssets: 48, sampledAssets: 48, assetsWithData: 8 }));
    expect(n.warn).toBe(false);
    expect(n.text).toContain("Reported by 8 of 48 device(s)");
  });

  it("discloses a capped sample", () => {
    const n = note(result({ scopedAssets: 2000, sampledAssets: 250, assetsWithData: 250 }));
    expect(n.text).toContain("Sampled 250 of 2000 selected devices");
  });

  it("shows a checking hint while loading and nothing on error", () => {
    expect(note({ loading: true }).text).toContain("Checking");
    expect(note({ error: true })).toEqual({ text: "", warn: false });
  });

  it("says WHICH slice was empty when the list was narrowed by a sibling", () => {
    // Without the narrow label this reads as "this device has no sensors at
    // all", when it only has no sensors of the class the operator picked.
    const n = note(result({ values: [], assetsWithData: 0, noun: "hardware sensors", narrowLabel: " of class fan" }));
    expect(n.text).toContain("hardware sensors of class fan");
  });
});

describe("sibling narrowing", () => {
  it("narrows sensor NAMES by the class already chosen on the row", () => {
    expect(narrow("sensorNamePattern", { sensorClass: "temperature" })).toEqual({ sensorClass: "temperature" });
  });

  it("narrows SD-WAN members by the chosen health check", () => {
    expect(narrow("link", { healthCheck: "Internet" })).toEqual({ healthCheck: "Internet" });
  });

  it("narrows state-probe ROWS by the chosen probe", () => {
    // "PSU 2" is not a row of the fan-tray probe — offering every probe's rows
    // would invite a probe+row pair that matches nothing.
    expect(narrow("stateRowPattern", { stateProbeId: "p1" })).toEqual({ stateProbeId: "p1" });
    expect(narrow("stateRowPattern", {})).toEqual({});
  });

  it("does not narrow when the sibling is unset, or for independent dimensions", () => {
    expect(narrow("sensorNamePattern", {})).toEqual({});
    expect(narrow("sensorNamePattern", null)).toEqual({});
    expect(narrow("sensorClass", { sensorNamePattern: "CPU" })).toEqual({});
    expect(narrow("ifNamePattern", { sensorClass: "temperature" })).toEqual({});
  });

  // The interface list is the one narrowing input that is NOT a sibling
  // dimension: `poeStatus == fault` fires on every PoE-capable port while every
  // other PoE comparison stays pinned-only (business rule 57's carve-out), so
  // the picker has to tell the server which comparison the row is making or it
  // offers the wrong set of ports.
  it("carries the row's comparison into the interface list", () => {
    expect(narrow("ifNamePattern", {}, { stateOperator: "==", stateValue: "fault" }))
      .toEqual({ stateOperator: "==", stateValue: "fault" });
    expect(narrow("ifNamePattern", {}, { stateOperator: "==", stateValue: "searching" }))
      .toEqual({ stateOperator: "==", stateValue: "searching" });
  });

  it("carries nothing when the row states no comparison, so no other picker re-fetches", () => {
    expect(narrow("ifNamePattern", {}, null)).toEqual({});
    expect(narrow("ifNamePattern", {}, {})).toEqual({});
    expect(narrow("ifNamePattern", {})).toEqual({});
  });

  it("leaves the other component dimensions' narrowing alone", () => {
    const poe = { stateOperator: "==", stateValue: "fault" };
    expect(narrow("mountPathPattern", {}, poe)).toEqual({});
    expect(narrow("tunnelName", {}, poe)).toEqual({});
  });
});
