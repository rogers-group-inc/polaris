/**
 * tests/unit/savedFilterService.test.ts
 *
 * The pure validators behind saved table filters. These matter more than they
 * look: a preset's `state` is JSON authored by one operator's browser and
 * REPLAYED into another's when a public preset is loaded, so anything the
 * table can't itself produce must be rejected at the door rather than stored.
 */

import { describe, it, expect } from "vitest";
import {
  functionKeyForScope,
  normalizeName,
  sanitizeFilterState,
  MAX_FILTER_KEYS,
  MAX_NAME_LEN,
  MAX_VALUE_LEN,
} from "../../src/services/savedFilterService.js";

describe("scopes", () => {
  it("accepts the assets scope and maps it to the assets function key", () => {
    expect(functionKeyForScope("assets")).toBe("assets");
  });

  it("rejects an unknown scope rather than inventing a key", () => {
    expect(() => functionKeyForScope("subnets")).toThrowError(/Unknown saved-filter scope/);
  });

  it("rejects an inherited Object.prototype name (toString / constructor / __proto__)", () => {
    for (const s of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(() => functionKeyForScope(s)).toThrowError(/Unknown saved-filter scope/);
    }
  });
});

describe("normalizeName", () => {
  it("trims and collapses interior whitespace", () => {
    expect(normalizeName("  Down   firewalls ")).toBe("Down firewalls");
  });

  it("rejects empty, non-string, over-long and control-character names", () => {
    expect(() => normalizeName("   ")).toThrowError(/name is required/);
    expect(() => normalizeName(42)).toThrowError(/name is required/);
    expect(() => normalizeName("x".repeat(MAX_NAME_LEN + 1))).toThrowError(/exceeds/);
    expect(() => normalizeName('bad' + String.fromCharCode(7) + 'name')).toThrowError(/control characters/);
  });
});

describe("sanitizeFilterState", () => {
  it("round-trips every filter shape table-sf.js produces", () => {
    const state = sanitizeFilterState({
      sfFilters: {
        hostname: "nsh",
        serialNumber: "!demo",
        assetType: ["firewall", "switch"],
        description: { op: "not-contains", q: "spare" },
        model: { op: "empty" },
        os: { op: "notempty" },
        lastSeen: { type: "date", from: "2026-01-01", to: "2026-02-01" },
      },
      sortKey: "hostname",
      sortDir: "desc",
    });
    expect(state.sfFilters).toEqual({
      hostname: "nsh",
      serialNumber: "!demo",
      assetType: ["firewall", "switch"],
      description: { op: "not-contains", q: "spare" },
      model: { op: "empty" },
      os: { op: "notempty" },
      lastSeen: { type: "date", from: "2026-01-01", to: "2026-02-01" },
    });
    expect(state.sortKey).toBe("hostname");
    expect(state.sortDir).toBe("desc");
  });

  it("defaults an absent/invalid sort to no sort", () => {
    const state = sanitizeFilterState({ sfFilters: {} });
    expect(state.sortKey).toBeNull();
    expect(state.sortDir).toBeNull();
    expect(sanitizeFilterState({ sortDir: "sideways" }).sortDir).toBeNull();
  });

  it("normalizes a partial date range to explicit nulls", () => {
    expect(sanitizeFilterState({ sfFilters: { lastSeen: { type: "date", from: "2026-01-01" } } }).sfFilters)
      .toEqual({ lastSeen: { type: "date", from: "2026-01-01", to: null } });
  });

  it("rejects shapes the table cannot produce", () => {
    expect(() => sanitizeFilterState("nope")).toThrowError(/state must be an object/);
    expect(() => sanitizeFilterState({ sfFilters: [] })).toThrowError(/must be an object/);
    expect(() => sanitizeFilterState({ sfFilters: { hostname: 7 } })).toThrowError(/not a recognized filter shape/);
    expect(() => sanitizeFilterState({ sfFilters: { hostname: { op: "drop-table" } } }))
      .toThrowError(/not a recognized filter shape/);
    expect(() => sanitizeFilterState({ sfFilters: { hostname: { nested: { deep: true } } } }))
      .toThrowError(/not a recognized filter shape/);
  });

  it("bounds column count and string length", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i <= MAX_FILTER_KEYS; i++) wide[`c${i}`] = "x";
    expect(() => sanitizeFilterState({ sfFilters: wide })).toThrowError(/column cap/);
    expect(() => sanitizeFilterState({ sfFilters: { hostname: "x".repeat(MAX_VALUE_LEN + 1) } }))
      .toThrowError(/exceeds/);
  });

  it("drops unknown top-level members instead of persisting them", () => {
    const state = sanitizeFilterState({ sfFilters: { hostname: "a" }, evil: "payload" }) as unknown as Record<string, unknown>;
    expect(Object.keys(state).sort()).toEqual(["sfFilters", "sortDir", "sortKey"]);
  });
});
