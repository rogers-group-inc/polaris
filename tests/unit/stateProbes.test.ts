/**
 * tests/unit/stateProbes.test.ts — the 0/1 mapping behind state probes
 * (src/utils/stateProbes.ts).
 *
 * This is the whole correctness surface of the feature: the collector stores
 * what `evaluateStateMap` returns, and the automation engine then only ever
 * compares 0 or 1. Two properties matter more than the rest and are pinned
 * hardest below:
 *   - a value the mapping can't read produces NULL, never 0 (0 is a positive
 *     claim of health that would clear a live alert), and
 *   - polarity is whatever the operator declared, not whatever the number is.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_STATE_MAP,
  STATE_MAP_MODES,
  evaluateStateMap,
  joinStateRows,
  normalizeStateMap,
  validateStateMap,
  type StateMap,
} from "../../src/utils/stateProbes.js";

function map(over: Partial<StateMap> = {}): StateMap {
  return { ...DEFAULT_STATE_MAP, ...over };
}

describe("normalizeStateMap", () => {
  it("defaults to the plain alarm bit with Alarm/OK labels", () => {
    expect(normalizeStateMap(undefined)).toEqual({
      mode: "nonzero", values: [], trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true,
    });
  });

  it("degrades an unknown mode to nonzero rather than throwing on the hot path", () => {
    expect(normalizeStateMap({ mode: "whatever" }).mode).toBe("nonzero");
  });

  it("keeps values only for the modes that compare against them", () => {
    expect(normalizeStateMap({ mode: "equals", values: ["2", "3"] }).values).toEqual(["2", "3"]);
    // nonzero has nothing to compare, so a stray set is dropped rather than
    // silently changing what the probe means.
    expect(normalizeStateMap({ mode: "nonzero", values: ["2"] }).values).toEqual([]);
  });

  it("coerces numeric values, trims, and drops blanks", () => {
    expect(normalizeStateMap({ mode: "equals", values: [2, " alarm ", ""] }).values).toEqual(["2", "alarm"]);
  });

  it("takes only the first operand for the single-value modes", () => {
    expect(normalizeStateMap({ mode: "gte", values: ["5", "9"] }).values).toEqual(["5"]);
  });

  it("truncates over-long labels and falls back to the defaults when blank", () => {
    const m = normalizeStateMap({ trueLabel: "x".repeat(80), falseLabel: "   " });
    expect(m.trueLabel).toHaveLength(32);
    expect(m.falseLabel).toBe("OK");
  });

  it("honours an explicit trueIsProblem=false", () => {
    expect(normalizeStateMap({ trueIsProblem: false }).trueIsProblem).toBe(false);
    expect(normalizeStateMap({}).trueIsProblem).toBe(true);
  });
});

describe("validateStateMap", () => {
  it("accepts every mode's happy path", () => {
    expect(validateStateMap({})).toBeNull();
    for (const mode of STATE_MAP_MODES) {
      const needsValues = ["equals", "notEquals", "gte", "lte"].includes(mode);
      expect(validateStateMap({ mode, values: needsValues ? ["1"] : [] })).toBeNull();
    }
  });

  it("refuses a comparison mode with no operand", () => {
    // The failure this prevents: every reading evaluates false, so the probe
    // reports healthy forever and nothing ever fires.
    expect(validateStateMap({ mode: "equals", values: [] })).toMatch(/needs at least one/i);
    expect(validateStateMap({ mode: "notEquals" })).toMatch(/needs at least one/i);
  });

  it("refuses a non-numeric operand for the ordered modes", () => {
    expect(validateStateMap({ mode: "gte", values: ["alarm"] })).toMatch(/numeric/i);
  });

  it("refuses an invalid mode and identical labels", () => {
    expect(validateStateMap({ mode: "nope" })).toMatch(/Invalid state mode/);
    expect(validateStateMap({ trueLabel: "Up", falseLabel: "up" })).toMatch(/must differ/i);
  });

  it("refuses a non-object", () => {
    expect(validateStateMap(null)).toMatch(/must be an object/i);
  });
});

describe("evaluateStateMap", () => {
  it("maps a plain alarm bit", () => {
    const m = map();
    expect(evaluateStateMap(0, m)).toBe(0);
    expect(evaluateStateMap(1, m)).toBe(1);
    expect(evaluateStateMap(7, m)).toBe(1);
  });

  it("inverts for a health register", () => {
    const m = map({ mode: "zero" });
    expect(evaluateStateMap(0, m)).toBe(1);
    expect(evaluateStateMap(1, m)).toBe(0);
  });

  it("handles an enum where a specific code is the bad state", () => {
    const m = map({ mode: "equals", values: ["2", "3"] });
    expect(evaluateStateMap(2, m)).toBe(1);
    expect(evaluateStateMap(3, m)).toBe(1);
    expect(evaluateStateMap(1, m)).toBe(0);
  });

  it("handles SNMPv2 TruthValue, where true(1) is the GOOD state", () => {
    // The case a bare "value >= 1" gets exactly backwards.
    const m = map({ mode: "notEquals", values: ["1"] });
    expect(evaluateStateMap(1, m)).toBe(0);
    expect(evaluateStateMap(2, m)).toBe(1);
  });

  it("compares strings case-insensitively, so one probe covers a numeric and a string agent", () => {
    const m = map({ mode: "equals", values: ["alarm"] });
    expect(evaluateStateMap("alarm", m)).toBe(1);
    expect(evaluateStateMap("ALARM", m)).toBe(1);
    expect(evaluateStateMap(" Alarm ", m)).toBe(1);
    expect(evaluateStateMap("ok", m)).toBe(0);
  });

  it("compares numerically when both sides are numbers, so \"2\" matches 2", () => {
    const m = map({ mode: "equals", values: ["2"] });
    expect(evaluateStateMap("2", m)).toBe(1);
    expect(evaluateStateMap("2.0", m)).toBe(1);
    expect(evaluateStateMap(2, m)).toBe(1);
  });

  it("applies the ordered modes", () => {
    expect(evaluateStateMap(80, map({ mode: "gte", values: ["75"] }))).toBe(1);
    expect(evaluateStateMap(74, map({ mode: "gte", values: ["75"] }))).toBe(0);
    expect(evaluateStateMap(3, map({ mode: "lte", values: ["5"] }))).toBe(1);
    expect(evaluateStateMap(6, map({ mode: "lte", values: ["5"] }))).toBe(0);
  });

  it("returns NULL — never 0 — for an absent or unreadable reading", () => {
    // The invariant: 0 asserts health. A missing sensor must not clear an alert
    // (or, on an inverted probe, raise one about hardware that isn't there).
    const m = map();
    expect(evaluateStateMap(null, m)).toBeNull();
    expect(evaluateStateMap(undefined, m)).toBeNull();
    expect(evaluateStateMap("", m)).toBeNull();
    expect(evaluateStateMap("   ", m)).toBeNull();
    expect(evaluateStateMap("noSuchInstance", m)).toBeNull();
    expect(evaluateStateMap("N/A", map({ mode: "zero" }))).toBeNull();
    expect(evaluateStateMap("high", map({ mode: "gte", values: ["5"] }))).toBeNull();
  });

  it("treats an unmatched string as a real 'not equal' under notEquals", () => {
    // The operand set defines the good state, so anything else is genuinely bad
    // — this must not degrade to null and go silent.
    expect(evaluateStateMap("degraded", map({ mode: "notEquals", values: ["ok"] }))).toBe(1);
  });

  it("accepts booleans, which is what a REST-sourced probe would hand it", () => {
    expect(evaluateStateMap(true, map())).toBe(1);
    expect(evaluateStateMap(false, map())).toBe(0);
  });
});

// The pill polarity, the pill label and the plain-English summary are browser
// code, tested there: assetsSnmp.stateProbe.test.ts (_stateProbeIsProblem,
// _stateProbeLabel) and
// serverSettingsProfiles.stateMapSummary.test.ts (_stateMapSummary).

describe("joinStateRows", () => {
  const values = new Map<string, unknown>([["1", 0], ["2", 1], ["3", 0]]);

  it("names rows from the label walk, joined on the OID index", () => {
    const labels = new Map<string, unknown>([["1", "CPU ON-DIE"], ["2", "TMP1 External"], ["3", "FAN1"]]);
    const rows = joinStateRows(values, labels, map());
    expect(rows).toEqual([
      { rowKey: "1", rowLabel: "CPU ON-DIE", value: 0, raw: "0" },
      { rowKey: "2", rowLabel: "TMP1 External", value: 1, raw: "1" },
      { rowKey: "3", rowLabel: "FAN1", value: 0, raw: "0" },
    ]);
  });

  it("falls back to the bare index when there's no label column", () => {
    expect(joinStateRows(values, null, map()).map((r) => r.rowLabel)).toEqual(["1", "2", "3"]);
  });

  it("falls back per row when the label walk is missing or blank for that index", () => {
    const labels = new Map<string, unknown>([["1", "CPU ON-DIE"], ["2", "  "]]);
    expect(joinStateRows(values, labels, map()).map((r) => r.rowLabel)).toEqual(["CPU ON-DIE", "2", "3"]);
  });

  it("drops unreadable rows instead of reporting them as healthy", () => {
    const withGap = new Map<string, unknown>([["1", 1], ["2", null], ["3", ""]]);
    const rows = joinStateRows(withGap, null, map());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rowKey: "1", value: 1 });
  });

  it("keeps the raw device value for display, and labels a scalar's empty suffix", () => {
    const scalar = new Map<string, unknown>([["", "alarm"]]);
    const rows = joinStateRows(scalar, null, map({ mode: "equals", values: ["alarm"] }));
    expect(rows).toEqual([{ rowKey: "", rowLabel: "(single value)", value: 1, raw: "alarm" }]);
  });
});
