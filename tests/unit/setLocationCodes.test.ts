/**
 * tests/unit/setLocationCodes.test.ts
 *
 * The location-code WRITER (business rule 148): a description keeps its
 * leading free text, loses every old code, and takes the new codes in
 * a: b: f: r: jb: order — and what it writes parses back to exactly those codes.
 */

import { describe, it, expect } from "vitest";
import {
  setLocationCodes,
  parseLocationCodes,
  locationCodeValueProblem,
  MAX_LOCATION_CODE_VALUE_LEN,
  mergeLocationLevels,
  isFloorNumber,
  floorCodeProblem,
  isRackUnit,
} from "../../src/utils/locationCodes.js";

describe("mergeLocationLevels (rule 148(a))", () => {
  const now = parseLocationCodes("b:Scale House r:Weigh Room jb:7");
  it("a building polygon changes the building and keeps the room and junction box", () => {
    const m = mergeLocationLevels(now, { building: "Office" }, ["building"]);
    expect(setLocationCodes("Core b:Scale House r:Weigh Room jb:7", m)).toBe("Core b:Office r:Weigh Room jb:7");
  });
  it("a building already right changes nothing; a floor layer only adds the floor", () => {
    expect(mergeLocationLevels(now, { building: "Scale House" }, ["building"])).toEqual(now);
    expect(mergeLocationLevels(parseLocationCodes("b:Hoist f:Surface"), { floor: "2" }, ["floor"]))
      .toMatchObject({ building: "Hoist", floor: "2" });
  });
  it("a rack region sets its chain and leaves the junction box; a listed empty level clears", () => {
    const m = mergeLocationLevels(now, { room: "MDF", rack: "R1" }, ["room", "rack"]);
    expect(m).toMatchObject({ building: "Scale House", room: "MDF", rack: "R1", junctionBox: "7" });
    expect(mergeLocationLevels(now, {}, ["junctionBox"]).junctionBox).toBeNull();
  });
});

describe("setLocationCodes", () => {
  it("replaces existing codes and keeps the leading free text", () => {
    expect(setLocationCodes("Line 3 core b:Plant", { building: "Plant", floor: "1" })).toBe("Line 3 core b:Plant f:1");
    expect(setLocationCodes("Dock AP b:Plant f:2 r:Dock", { building: "Office" })).toBe("Dock AP b:Office");
  });

  it("writes codes outermost first whatever order the input object has", () => {
    expect(setLocationCodes(null, { junctionBox: "JB-4", room: "MCC", area: "Mine", floor: "1", building: "Plant" }))
      .toBe("a:Mine b:Plant f:1 r:MCC jb:JB-4");
  });

  it("handles an empty or code-only description", () => {
    expect(setLocationCodes("", { building: "Plant" })).toBe("b:Plant");
    expect(setLocationCodes(undefined, { room: "North Closet" })).toBe("r:North Closet");
    expect(setLocationCodes("a:Old b:Gone", { floor: "2" })).toBe("f:2");
  });

  it("round-trips through the parser", () => {
    const codes = { area: "Pug Mill", building: "Shop", floor: "2", room: "North Closet", rack: "R2", junctionBox: "112-305" };
    const written = setLocationCodes("Core switch", codes);
    expect(parseLocationCodes(written)).toEqual(codes);
  });

  it("collapses whitespace inside a value and skips empty fields", () => {
    expect(setLocationCodes("x", { building: "  Big   Shop ", floor: "", room: null })).toBe("x b:Big Shop");
  });

  it("does not treat a word ending in a code letter as a code", () => {
    // "hub:5" is not a token, so it stays part of the free text.
    expect(setLocationCodes("hub:5 uplink", { building: "Plant" })).toBe("hub:5 uplink b:Plant");
  });

  it("refuses a value that would re-parse as another code", () => {
    expect(() => setLocationCodes("", { building: "Plant f:2" })).toThrow(/another location code/);
  });
});

// Rule 150(b), operator request 2026-11-18: a racked device's U is u:.
describe("the rack unit code (u:)", () => {
  it("parses u: apart from the rack, writes it after ra:, and round-trips", () => {
    expect(parseLocationCodes("Core b:Plant r:MDF ra:R2 u:14").rack).toBe("R2");
    expect(parseLocationCodes("Core b:Plant r:MDF ra:R2 u:14").unit).toBe("14");
    expect(parseLocationCodes("menu:x r:MDF").unit).toBeUndefined();
    const d = setLocationCodes("Core", { building: "Plant", room: "MDF", rack: "R2", unit: "14", junctionBox: null });
    expect(d).toBe("Core b:Plant r:MDF ra:R2 u:14");
    expect(parseLocationCodes(d)).toMatchObject({ rack: "R2", unit: "14" });
    expect(locationCodeValueProblem("R2 u:3")).toBe("contains another location code");
  });
  it("a rack placement sets the U; a junction box clears it", () => {
    const cur = parseLocationCodes("b:Plant r:MDF ra:R2 u:14");
    expect(mergeLocationLevels(cur, { rack: "R1", unit: "3" }, ["rack", "unit", "junctionBox"])).toMatchObject({ rack: "R1", unit: "3", room: "MDF" });
    expect(mergeLocationLevels(cur, { junctionBox: "JB 1" }, ["junctionBox", "rack", "unit"])).toMatchObject({ rack: null, unit: null, junctionBox: "JB 1" });
  });
  it("knows a rack unit", () => {
    expect(["1", "42", "60", " 7 "].every((v) => isRackUnit(v))).toBe(true);
    expect(["0", "61", "1.5", "U3", "", "-2"].some((v) => isRackUnit(v))).toBe(false);
  });
});

describe("locationCodeValueProblem", () => {
  it("accepts ordinary values", () => {
    expect(locationCodeValueProblem("North Closet")).toBeNull();
    expect(locationCodeValueProblem("112-305")).toBeNull();
  });

  it("rejects empty, oversize, control characters and embedded codes", () => {
    expect(locationCodeValueProblem("   ")).toMatch(/empty/);
    expect(locationCodeValueProblem("x".repeat(MAX_LOCATION_CODE_VALUE_LEN + 1))).toMatch(/longer/);
    expect(locationCodeValueProblem("a\tb")).toMatch(/control/);
    expect(locationCodeValueProblem("x jb:1")).toMatch(/another location code/);
  });
});

describe("floors are numbers (rule 168)", () => {
  it("knows a floor number", () => {
    for (const v of ["0", "-1", "-20", "2", "99", " 3 "]) expect(isFloorNumber(v)).toBe(true);
    for (const v of ["Surface", "B1", "1.5", "-21", "100", "", null]) expect(isFloorNumber(v as string)).toBe(false);
  });
  it("refuses a NEW text floor, lets an old one stay, and ignores descriptions with no floor", () => {
    expect(floorCodeProblem(null, "Core b:Hoist f:2")).toBeNull();
    expect(floorCodeProblem(null, "Core b:Hoist f:Surface")).toMatch(/is a number/);
    expect(floorCodeProblem("b:Hoist f:Surface", "Uplink b:Hoist f:surface")).toBeNull();
    expect(floorCodeProblem("b:Hoist f:Surface", "b:Hoist f:Roof")).toMatch(/is a number/);
    expect(floorCodeProblem("b:Hoist f:Surface", "b:Hoist r:MDF")).toBeNull();
  });
});
