/**
 * tests/unit/serverSettingsProfiles.stateMapSummary.test.ts
 *
 * The probe card's plain-English state-map line — `_stateMapSummary` in
 * public/js/server-settings-profiles.js ("Alarm when the value is not 0, OK
 * when it is 0"). Maps here are the server's normalized shape
 * (normalizeStateMap in src/utils/stateProbes.ts), which is what the profile
 * API hands the page.
 */

import { describe, it, expect } from "vitest";
import { serverSettingsFileSource } from "./_serverSettingsSource.js";
import { DEFAULT_STATE_MAP, normalizeStateMap, type StateMap } from "../../src/utils/stateProbes.js";

/** Source text of `function <name>(...) { ... }`, braces balanced. */
function extractFn(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name}: unbalanced braces`);
}

const summary = new Function(
  `${extractFn(serverSettingsFileSource("server-settings-profiles.js"), "_stateMapSummary")}; return _stateMapSummary;`,
)() as (m: unknown) => string;

const map = (over: Partial<StateMap> = {}): StateMap => ({ ...DEFAULT_STATE_MAP, ...over });

describe("_stateMapSummary", () => {
  it("spells each mode out in the operator's labels", () => {
    expect(summary(map())).toBe("Alarm when the value is not 0, OK when it is 0");
    expect(summary(map({ mode: "notEquals", values: ["1"] })))
      .toBe("OK when the value is 1, Alarm otherwise");
    expect(summary(map({ mode: "gte", values: ["75"] })))
      .toBe("Alarm when the value is 75 or more, OK below that");
  });

  it("covers the remaining modes", () => {
    expect(summary(map({ mode: "zero" }))).toBe("Alarm when the value is 0, OK otherwise");
    expect(summary(map({ mode: "equals", values: ["2", "3"] })))
      .toBe("Alarm when the value is 2, 3, OK otherwise");
    expect(summary(map({ mode: "lte", values: ["10"], trueLabel: "Low", falseLabel: "Fine" })))
      .toBe("Low when the value is 10 or less, Fine above that");
  });

  it("reads a normalized map from the server unchanged", () => {
    expect(summary(normalizeStateMap({ mode: "equals", values: [2], trueLabel: "Failed", falseLabel: "Present" })))
      .toBe("Failed when the value is 2, Present otherwise");
  });

  it("says so when a probe has no mapping", () => {
    expect(summary(null)).toBe("no mapping");
  });
});
