/**
 * tests/unit/manufacturerNormalize.test.ts
 *
 * The synchronous alias cache behind manufacturer normalisation: trims,
 * maps case-insensitively to the admin's canonical spelling, passes null /
 * undefined through, and falls back to the trimmed input before the cache
 * is loaded (early boot writes are never lost).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setAliasMap, normalizeManufacturer, _resetAliasMap } from "../../src/utils/manufacturerNormalize.js";

beforeEach(() => _resetAliasMap());

describe("normalizeManufacturer", () => {
  it("passes null and undefined through unchanged", () => {
    expect(normalizeManufacturer(null)).toBeNull();
    expect(normalizeManufacturer(undefined)).toBeUndefined();
  });

  it("returns null for empty or whitespace input", () => {
    expect(normalizeManufacturer("")).toBeNull();
    expect(normalizeManufacturer("   ")).toBeNull();
  });

  it("returns the trimmed input before the cache is loaded", () => {
    expect(normalizeManufacturer("  Dell Inc. ")).toBe("Dell Inc.");
  });

  it("maps an alias case-insensitively to the canonical value as typed", () => {
    setAliasMap([["Dell Inc.", "Dell"], ["  HEWLETT-PACKARD ", "HPE"]]);
    expect(normalizeManufacturer("dell inc.")).toBe("Dell");
    expect(normalizeManufacturer("  DELL INC.  ")).toBe("Dell");
    expect(normalizeManufacturer("Hewlett-Packard")).toBe("HPE");
  });

  it("returns the trimmed input when no alias matches", () => {
    setAliasMap([["dell inc.", "Dell"]]);
    expect(normalizeManufacturer(" Lenovo ")).toBe("Lenovo");
  });

  it("skips blank alias keys and replaces the whole map on each set", () => {
    setAliasMap([["  ", "Nobody"], ["a", "A"]]);
    expect(normalizeManufacturer("x")).toBe("x");
    setAliasMap([["b", "B"]]);
    expect(normalizeManufacturer("a")).toBe("a");
    expect(normalizeManufacturer("b")).toBe("B");
  });

  it("_resetAliasMap returns to the pre-load fallback", () => {
    setAliasMap([["a", "A"]]);
    _resetAliasMap();
    expect(normalizeManufacturer("a")).toBe("a");
  });
});
