/**
 * tests/unit/num.test.ts
 */

import { describe, it, expect } from "vitest";
import { toNonNegativeInt, toFiniteOrNull, parseFiniteOrNull } from "../../src/utils/num.js";

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

// The two contracts differ exactly where the look-alike helpers they absorbed
// differed from each other: blank strings, null and booleans. Each table pins
// the full contract so a later "simplification" of one into the other fails.
describe("toFiniteOrNull — loose, Number() coercion", () => {
  it("passes finite numbers through unrounded", () => {
    expect(toFiniteOrNull(42)).toBe(42);
    expect(toFiniteOrNull(-1.5)).toBe(-1.5);
    expect(toFiniteOrNull(0)).toBe(0);
  });

  it("is null for NaN and the infinities", () => {
    expect(toFiniteOrNull(NaN)).toBeNull();
    expect(toFiniteOrNull(Infinity)).toBeNull();
    expect(toFiniteOrNull(-Infinity)).toBeNull();
    expect(toFiniteOrNull("Infinity")).toBeNull();
  });

  it("coerces numeric strings, trimming as Number() does", () => {
    expect(toFiniteOrNull("42")).toBe(42);
    expect(toFiniteOrNull(" 7 ")).toBe(7);
    expect(toFiniteOrNull("1e3")).toBe(1000);
    expect(toFiniteOrNull("0x10")).toBe(16);
  });

  it("reads blank strings, null, false and [] as 0 and true as 1", () => {
    expect(toFiniteOrNull("")).toBe(0);
    expect(toFiniteOrNull("   ")).toBe(0);
    expect(toFiniteOrNull(null)).toBe(0);
    expect(toFiniteOrNull(false)).toBe(0);
    expect(toFiniteOrNull([])).toBe(0);
    expect(toFiniteOrNull(true)).toBe(1);
  });

  it("is null for undefined, non-numeric strings and objects", () => {
    expect(toFiniteOrNull(undefined)).toBeNull();
    expect(toFiniteOrNull("12abc")).toBeNull();
    expect(toFiniteOrNull("n/a")).toBeNull();
    expect(toFiniteOrNull({})).toBeNull();
  });
});

describe("parseFiniteOrNull — strict, numbers and numeric strings only", () => {
  it("passes finite numbers through unrounded", () => {
    expect(parseFiniteOrNull(42)).toBe(42);
    expect(parseFiniteOrNull(-1.5)).toBe(-1.5);
    expect(parseFiniteOrNull(0)).toBe(0);
  });

  it("is null for NaN and the infinities", () => {
    expect(parseFiniteOrNull(NaN)).toBeNull();
    expect(parseFiniteOrNull(Infinity)).toBeNull();
    expect(parseFiniteOrNull(-Infinity)).toBeNull();
    expect(parseFiniteOrNull("-Infinity")).toBeNull();
  });

  it("parses numeric strings, trimming as Number() does", () => {
    expect(parseFiniteOrNull("42")).toBe(42);
    expect(parseFiniteOrNull(" 7 ")).toBe(7);
    expect(parseFiniteOrNull("2.5")).toBe(2.5);
    expect(parseFiniteOrNull("1e3")).toBe(1000);
  });

  it("is null for blank strings — not 0", () => {
    expect(parseFiniteOrNull("")).toBeNull();
    expect(parseFiniteOrNull("   ")).toBeNull();
  });

  it("is null for null, undefined, booleans, objects and non-numeric strings", () => {
    expect(parseFiniteOrNull(null)).toBeNull();
    expect(parseFiniteOrNull(undefined)).toBeNull();
    expect(parseFiniteOrNull(true)).toBeNull();
    expect(parseFiniteOrNull(false)).toBeNull();
    expect(parseFiniteOrNull([])).toBeNull();
    expect(parseFiniteOrNull({})).toBeNull();
    expect(parseFiniteOrNull("12abc")).toBeNull();
  });
});
