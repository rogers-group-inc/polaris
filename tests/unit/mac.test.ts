/**
 * tests/unit/mac.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  normalizeMacOrNull,
  normalizeMacsDistinct,
  macColonUpperOrNull,
  macHexKeyOrNull,
  normalizeMacLowerColon,
  isAllZeroMac,
} from "../../src/utils/mac.js";

describe("isAllZeroMac", () => {
  it("recognizes the all-zero MAC in every separator style and case", () => {
    for (const z of ["00:00:00:00:00:00", "00-00-00-00-00-00", "000000000000", "0000.0000.0000"]) {
      expect(isAllZeroMac(z)).toBe(true);
    }
  });

  it("is false for a real MAC, a near-zero MAC, malformed and empty input", () => {
    for (const v of ["00:00:00:00:00:01", "AA:BB:CC:DD:EE:FF", "00:00:00", "", null, undefined, 0]) {
      expect(isAllZeroMac(v)).toBe(false);
    }
  });
});

describe("normalizeMacOrNull", () => {
  it("normalizes colon-separated lowercase to uppercase", () => {
    expect(normalizeMacOrNull("38:C0:EA:00:00:01")).toBe("38:C0:EA:00:00:01");
  });

  it("normalizes dash-separated form", () => {
    expect(normalizeMacOrNull("38-C0-EA-00-00-01")).toBe("38:C0:EA:00:00:01");
  });

  it("normalizes bare-hex (no separators) form", () => {
    expect(normalizeMacOrNull("38c0ea000001")).toBe("38:C0:EA:00:00:01");
  });

  it("normalizes dotted Cisco-style form", () => {
    expect(normalizeMacOrNull("38c0.ea00.0001")).toBe("38:C0:EA:00:00:01");
  });

  it("returns null for the all-zero MAC", () => {
    expect(normalizeMacOrNull("00:00:00:00:00:00")).toBeNull();
    expect(normalizeMacOrNull("000000000000")).toBeNull();
  });

  it("returns null for empty / nullish input", () => {
    expect(normalizeMacOrNull("")).toBeNull();
    expect(normalizeMacOrNull(null)).toBeNull();
    expect(normalizeMacOrNull(undefined)).toBeNull();
  });

  it("returns null for the wrong number of hex digits", () => {
    expect(normalizeMacOrNull("38:c0:ea:81:55")).toBeNull();       // too short
    expect(normalizeMacOrNull("38:c0:ea:00:00:01:00")).toBeNull(); // too long
  });

  it("returns null for non-hex garbage", () => {
    expect(normalizeMacOrNull("not-a-mac")).toBeNull();
    expect(normalizeMacOrNull("zz:zz:zz:zz:zz:zz")).toBeNull();
  });

  it("trims surrounding whitespace via the hex filter", () => {
    expect(normalizeMacOrNull("  38:C0:EA:00:00:01  ")).toBe("38:C0:EA:00:00:01");
  });
});

describe("macColonUpperOrNull (loose)", () => {
  it("normalizes every separator style to upper-colon", () => {
    expect(macColonUpperOrNull("38:C0:EA:00:00:01")).toBe("38:C0:EA:00:00:01");
    expect(macColonUpperOrNull("38-C0-EA-00-00-01")).toBe("38:C0:EA:00:00:01");
    expect(macColonUpperOrNull("38c0.ea00.0001")).toBe("38:C0:EA:00:00:01");
  });

  it("ACCEPTS the all-zero MAC (unlike the strict form)", () => {
    expect(macColonUpperOrNull("000000000000")).toBe("00:00:00:00:00:00");
    expect(macColonUpperOrNull("00:00:00:00:00:00")).toBe("00:00:00:00:00:00");
  });

  it("returns null for empty / wrong-length / non-hex input", () => {
    expect(macColonUpperOrNull("")).toBeNull();
    expect(macColonUpperOrNull(null)).toBeNull();
    expect(macColonUpperOrNull("38:c0:ea:81:55")).toBeNull();
    expect(macColonUpperOrNull("not-a-mac")).toBeNull();
  });
});

describe("macHexKeyOrNull (match key)", () => {
  it("emits bare-hex uppercase for any separator style", () => {
    expect(macHexKeyOrNull("38:c0:ea:00:00:01")).toBe("38C0EA000001");
    expect(macHexKeyOrNull("38-C0-EA-00-00-01")).toBe("38C0EA000001");
    expect(macHexKeyOrNull("38c0.ea00.0001")).toBe("38C0EA000001");
  });

  it("rejects the all-zero MAC so unrelated devices can't collide on it", () => {
    expect(macHexKeyOrNull("00:00:00:00:00:00")).toBeNull();
    expect(macHexKeyOrNull("000000000000")).toBeNull();
  });

  it("returns null for empty / malformed input", () => {
    expect(macHexKeyOrNull("")).toBeNull();
    expect(macHexKeyOrNull(null)).toBeNull();
    expect(macHexKeyOrNull("38c0ea81")).toBeNull();
  });
});

describe("normalizeMacLowerColon (FortiOS wire form)", () => {
  it("emits colon-separated lowercase for a recognizable MAC", () => {
    expect(normalizeMacLowerColon("38:C0:EA:00:00:01")).toBe("38:c0:ea:00:00:01");
    expect(normalizeMacLowerColon("38C0EA000001")).toBe("38:c0:ea:00:00:01");
    expect(normalizeMacLowerColon("38-C0-EA-00-00-01")).toBe("38:c0:ea:00:00:01");
  });

  it("keeps the all-zero MAC (device-side semantics, not identity)", () => {
    expect(normalizeMacLowerColon("00:00:00:00:00:00")).toBe("00:00:00:00:00:00");
  });

  it("passes unrecognizable input through lowercased (device rejects it)", () => {
    expect(normalizeMacLowerColon("NOT-A-MAC")).toBe("not-a-mac");
    expect(normalizeMacLowerColon("38:c0:ea")).toBe("38:c0:ea");
  });
});

describe("normalizeMacsDistinct", () => {
  it("normalizes, dedupes, and preserves first-seen order", () => {
    expect(
      normalizeMacsDistinct(["38:c0:ea:00:00:01", "38-C0-EA-00-00-02", "38c0ea000001"]),
    ).toEqual(["38:C0:EA:00:00:01", "38:C0:EA:00:00:02"]);
  });

  it("drops all-zero (loopback/tunnel) and invalid entries", () => {
    expect(
      normalizeMacsDistinct(["00:00:00:00:00:00", "", null, undefined, "garbage", "38:c0:ea:00:00:01"]),
    ).toEqual(["38:C0:EA:00:00:01"]);
  });

  it("returns an empty array when nothing is usable", () => {
    expect(normalizeMacsDistinct(["00:00:00:00:00:00", null, "nope"])).toEqual([]);
    expect(normalizeMacsDistinct([])).toEqual([]);
  });
});
