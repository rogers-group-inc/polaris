/**
 * tests/unit/jsonEqual.test.ts — src/utils/jsonEqual.ts
 *
 * The load-bearing case is the first: PostgreSQL jsonb returns
 * {"field","op","value"} as {"op","field","value"} (verified against
 * postgres:17 on 2026-11-05), and a plain JSON.stringify comparison called
 * those different, so every "did the stored blob change?" check said yes.
 */

import { describe, it, expect } from "vitest";
import { jsonEqual, stableStringify } from "../../src/utils/jsonEqual.js";

describe("jsonEqual", () => {
  it("treats a jsonb-reordered object as equal to the one the code built", () => {
    const built = { field: "tags", op: "in", value: ["a"] };
    const fromJsonb = { op: "in", field: "tags", value: ["a"] };
    expect(JSON.stringify(built)).not.toBe(JSON.stringify(fromJsonb)); // the bug
    expect(jsonEqual(built, fromJsonb)).toBe(true);
  });

  it("sorts keys at every depth, inside arrays too", () => {
    const a = { op: "and", conditions: [{ field: "x", op: "eq", value: 1 }, { nested: { b: 1, a: 2 } }] };
    const b = { conditions: [{ value: 1, op: "eq", field: "x" }, { nested: { a: 2, b: 1 } }], op: "and" };
    expect(jsonEqual(a, b)).toBe(true);
  });

  it("keeps arrays order-sensitive: a reordered list is a change", () => {
    expect(jsonEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(jsonEqual([[1, 2], [3, 4]], [[1, 2], [3, 4]])).toBe(true);
  });

  it("sees a changed value or a missing key", () => {
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 3 })).toBe(false);
    expect(jsonEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it("keeps JSON semantics: undefined drops, Date is its ISO string, null is null", () => {
    expect(jsonEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    const at = "2026-11-05T12:00:00.000Z";
    expect(jsonEqual({ at: new Date(at) }, { at })).toBe(true);
    expect(jsonEqual(null, null)).toBe(true);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual("x", "x")).toBe(true);
  });

  it("stableStringify output is key-sorted and array-order-preserving", () => {
    expect(stableStringify({ b: [2, 1], a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":[2,1]}');
    expect(stableStringify(undefined)).toBeUndefined();
  });
});
