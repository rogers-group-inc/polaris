/**
 * tests/unit/queryParams.test.ts
 */

import { describe, it, expect } from "vitest";
import { intQuery, boolQuery } from "../../src/utils/queryParams.js";

describe("intQuery", () => {
  it("parses a plain integer", () => {
    expect(intQuery("25")).toBe(25);
  });

  it("parses the way parseInt does: leading digits, floors nothing but truncates", () => {
    expect(intQuery("25abc")).toBe(25);
    expect(intQuery("1.9")).toBe(1);
  });

  it("returns undefined for absent / unparseable / 0 when there is no fallback", () => {
    expect(intQuery(undefined)).toBeUndefined();
    expect(intQuery("")).toBeUndefined();
    expect(intQuery("abc")).toBeUndefined();
    expect(intQuery("0")).toBeUndefined();
  });

  it("takes the fallback for absent, unparseable and 0 (the `|| fallback` the routes used)", () => {
    expect(intQuery(undefined, { fallback: 20 })).toBe(20);
    expect(intQuery("abc", { fallback: 20 })).toBe(20);
    expect(intQuery("0", { fallback: 20 })).toBe(20);
  });

  it("clamps to min and max, the fallback included", () => {
    expect(intQuery("9999", { fallback: 10, min: 1, max: 50 })).toBe(50);
    expect(intQuery("-5", { fallback: 10, min: 1, max: 50 })).toBe(1);
    expect(intQuery(undefined, { fallback: 500, min: 1, max: 200 })).toBe(200);
  });

  it("lets a negative through when no min is given, as the offset sites did", () => {
    expect(intQuery("-3", { fallback: 0 })).toBe(-3);
  });

  it("reads the first value of a repeated parameter as String() does", () => {
    expect(intQuery(["7", "9"])).toBe(7);
  });
});

describe("boolQuery", () => {
  it("is true for 1, true and yes in any case", () => {
    for (const v of ["1", "true", "TRUE", "True", "yes", "YES"]) expect(boolQuery(v)).toBe(true);
  });

  it("is false for everything else, absence and arrays included", () => {
    for (const v of [undefined, null, "", "0", "false", "no", "on", ["1"], 1, true]) expect(boolQuery(v)).toBe(false);
  });
});
