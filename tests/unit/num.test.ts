/**
 * tests/unit/num.test.ts
 */

import { describe, it, expect } from "vitest";
import { toNonNegativeInt } from "../../src/utils/num.js";

describe("toNonNegativeInt", () => {
  it("floors a finite non-negative number", () => {
    expect(toNonNegativeInt(30, 5)).toBe(30);
    expect(toNonNegativeInt(2.9, 5)).toBe(2);
  });

  it("accepts 0 (the old toPositiveInt name notwithstanding)", () => {
    expect(toNonNegativeInt(0, 5)).toBe(0);
  });

  it("coerces numeric strings the way Number() does", () => {
    expect(toNonNegativeInt("45", 5)).toBe(45);
    expect(toNonNegativeInt("", 5)).toBe(0);
  });

  it("falls back on negative, non-finite and non-numeric input", () => {
    expect(toNonNegativeInt(-1, 5)).toBe(5);
    expect(toNonNegativeInt(Infinity, 5)).toBe(5);
    expect(toNonNegativeInt(NaN, 5)).toBe(5);
    expect(toNonNegativeInt("abc", 5)).toBe(5);
    expect(toNonNegativeInt(undefined, 5)).toBe(5);
    expect(toNonNegativeInt({}, 5)).toBe(5);
  });

  it("treats null as 0, as Number(null) does", () => {
    expect(toNonNegativeInt(null, 5)).toBe(0);
  });
});
