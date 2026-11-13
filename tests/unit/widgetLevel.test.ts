/**
 * tests/unit/widgetLevel.test.ts — business rule 181: a custom widget's own
 * warning and critical levels, read one way for the card, the automation
 * condition and the email chart.
 */

import { describe, it, expect } from "vitest";
import { widgetLevel, widgetLevelsOf, widgetLevelsProblem } from "../../src/utils/widgetLevel.js";

describe("widgetLevelsOf", () => {
  it("is null when the widget sets neither level", () => {
    expect(widgetLevelsOf({})).toBeNull();
    expect(widgetLevelsOf(null)).toBeNull();
    expect(widgetLevelsOf({ warningAt: "x" })).toBeNull();
  });

  it("reads either level alone, and the direction", () => {
    expect(widgetLevelsOf({ warningAt: 16 })).toEqual({ warningAt: 16, criticalAt: null, below: false });
    expect(widgetLevelsOf({ criticalAt: 5, warningWhen: "below" })).toEqual({ warningAt: null, criticalAt: 5, below: true });
  });
});

describe("widgetLevel", () => {
  const amps = widgetLevelsOf({ warningAt: 16, criticalAt: 18 });
  const battery = widgetLevelsOf({ warningAt: 50, criticalAt: 25, warningWhen: "below" });

  it("above: normal, warning at the threshold, critical at its threshold", () => {
    expect(widgetLevel(15.9, amps)).toBe(0);
    expect(widgetLevel(16, amps)).toBe(1);
    expect(widgetLevel(17.9, amps)).toBe(1);
    expect(widgetLevel(18, amps)).toBe(2);
  });

  it("below: the same ladder downward", () => {
    expect(widgetLevel(80, battery)).toBe(0);
    expect(widgetLevel(50, battery)).toBe(1);
    expect(widgetLevel(25, battery)).toBe(2);
  });

  it("a critical level alone skips warning", () => {
    expect(widgetLevel(3, widgetLevelsOf({ criticalAt: 1 }))).toBe(2);
    expect(widgetLevel(0, widgetLevelsOf({ criticalAt: 1 }))).toBe(0);
  });

  it("is null with no reading or no levels", () => {
    expect(widgetLevel(null, amps)).toBeNull();
    expect(widgetLevel(NaN, amps)).toBeNull();
    expect(widgetLevel(5, null)).toBeNull();
  });
});

describe("widgetLevelsProblem", () => {
  it("refuses critical on the wrong side of warning", () => {
    expect(widgetLevelsProblem(widgetLevelsOf({ warningAt: 18, criticalAt: 16 }))).toMatch(/at or above/);
    expect(widgetLevelsProblem(widgetLevelsOf({ warningAt: 25, criticalAt: 50, warningWhen: "below" }))).toMatch(/at or below/);
  });

  it("accepts a correct pair, equal values, or one level", () => {
    expect(widgetLevelsProblem(widgetLevelsOf({ warningAt: 16, criticalAt: 18 }))).toBeNull();
    expect(widgetLevelsProblem(widgetLevelsOf({ warningAt: 16, criticalAt: 16 }))).toBeNull();
    expect(widgetLevelsProblem(widgetLevelsOf({ warningAt: 16 }))).toBeNull();
  });
});
