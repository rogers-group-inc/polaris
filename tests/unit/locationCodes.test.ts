/**
 * tests/unit/locationCodes.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  parseLocationCodes,
  resolveEffectiveLocation,
  hasLocationCodes,
  locationGroupKey,
} from "../../src/utils/locationCodes.js";

describe("parseLocationCodes", () => {
  it("parses all four keys with multi-word values", () => {
    expect(parseLocationCodes("b:Shop f:2 r:North Closet jb:112-305")).toEqual({
      area: null,
      building: "Shop",
      floor: "2",
      room: "North Closet",
      rack: null,
      junctionBox: "112-305",
    });
  });

  it("returns all-null for empty / null / undefined / prose-only input", () => {
    const empty = { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };
    expect(parseLocationCodes(null)).toEqual(empty);
    expect(parseLocationCodes(undefined)).toEqual(empty);
    expect(parseLocationCodes("")).toEqual(empty);
    expect(parseLocationCodes("uplink switch for the east wing")).toEqual(empty);
  });

  it("is case-insensitive on keys and preserves value casing", () => {
    expect(parseLocationCodes("B:Shop JB:A-1 R:MDF")).toEqual({
      area: null,
      building: "Shop",
      floor: null,
      room: "MDF",
      rack: null,
      junctionBox: "A-1",
    });
  });

  it("only matches keys at start or after whitespace (hub:/shelf: are not tokens)", () => {
    const parsed = parseLocationCodes("hub:5 shelf:3");
    expect(parsed).toEqual({ area: null, building: null, floor: null, room: null, rack: null, junctionBox: null });
    // ...but a real token after prose still parses
    expect(parseLocationCodes("core switch b:Office").building).toBe("Office");
  });

  it("parses the a: area code and keeps it distinct from b:", () => {
    const parsed = parseLocationCodes("a:Mine b:Shop f:2");
    expect(parsed.area).toBe("Mine");
    expect(parsed.building).toBe("Shop");
    expect(parsed.floor).toBe("2");
    // multi-word area values run to the next token like every other code
    expect(parseLocationCodes("a:North Campus b:Lab").area).toBe("North Campus");
  });

  it("reads ra: as rack, never as r: (room) or a: (area)", () => {
    expect(parseLocationCodes("r:MDF ra:R2 jb:7")).toEqual({ area: null, building: null, floor: null, room: "MDF", rack: "R2", junctionBox: "7" });
    expect(parseLocationCodes("ra:Rack 12")).toMatchObject({ rack: "Rack 12", room: null, area: null });
    expect(parseLocationCodes("RA:r3")).toMatchObject({ rack: "r3" });
    // "bra:" / "para:" are not tokens: a key matches only after whitespace.
    expect(parseLocationCodes("cobra:x")).toMatchObject({ rack: null, area: null, building: null });
  });

  it("does not let b: match inside jb:", () => {
    expect(parseLocationCodes("jb:12")).toEqual({
      area: null,
      building: null,
      floor: null,
      room: null,
      rack: null,
      junctionBox: "12",
    });
  });

  it("supports underground / free-form floor values", () => {
    expect(parseLocationCodes("b:Shop f:-1").floor).toBe("-1");
    expect(parseLocationCodes("b:Shop f:B2").floor).toBe("B2");
    expect(parseLocationCodes("f:Mezzanine").floor).toBe("Mezzanine");
  });

  it("ignores unknown xx: tokens (their text folds into the preceding value)", () => {
    const parsed = parseLocationCodes("b:Shop rack:4 r:MDF");
    // "rack:4" is not a token, so it rides along inside the building value.
    expect(parsed.building).toBe("Shop rack:4");
    expect(parsed.room).toBe("MDF");
  });

  it("keeps the last non-empty occurrence of a duplicated key", () => {
    expect(parseLocationCodes("b:Shop b:Annex").building).toBe("Annex");
    expect(parseLocationCodes("b:Shop b:").building).toBe("Shop");
  });

  it("treats an empty value as absent", () => {
    expect(parseLocationCodes("b: r:MDF")).toEqual({
      area: null,
      building: null,
      floor: null,
      room: "MDF",
      rack: null,
      junctionBox: null,
    });
  });
});

describe("resolveEffectiveLocation", () => {
  it("a description with codes defines the grouping exclusively (no per-key fall-through)", () => {
    // Regression: description edited from "b:Mine jb:Fuel" to "a:Mine jb:Fuel"
    // while the device copy still holds the old value — the removed b: must
    // NOT show through from deviceDescription.
    expect(
      resolveEffectiveLocation({
        deviceDescription: "b:Mine jb:Fuel",
        description: "a:Mine jb:Fuel",
      })
    ).toEqual({ area: "Mine", building: null, floor: null, room: null, rack: null, junctionBox: "Fuel" });
  });

  it("a description with no codes falls back to the device description wholesale", () => {
    expect(
      resolveEffectiveLocation({
        deviceDescription: "b:Shop f:1 r:MDF",
        description: "edge switch by the dock door",
      })
    ).toEqual({ area: null, building: "Shop", floor: "1", room: "MDF", rack: null, junctionBox: null });
    expect(
      resolveEffectiveLocation({ deviceDescription: "b:Shop", description: null })
    ).toEqual({ area: null, building: "Shop", floor: null, room: null, rack: null, junctionBox: null });
  });

  it("returns all-null when no source carries codes", () => {
    const codes = resolveEffectiveLocation({ description: "plain prose", deviceDescription: null });
    expect(hasLocationCodes(codes)).toBe(false);
  });
});

describe("locationGroupKey", () => {
  it("trims, collapses whitespace, and lowercases", () => {
    expect(locationGroupKey("  North   Closet ")).toBe("north closet");
    expect(locationGroupKey("SHOP")).toBe(locationGroupKey("shop"));
  });
});
