import { describe, it, expect } from "vitest";
import { normalizeConflictValue, conflictValuesEqual } from "../../src/utils/conflictValue.js";

describe("normalizeConflictValue", () => {
  it("maps null, undefined and blank to null", () => {
    expect(normalizeConflictValue("owner", null)).toBeNull();
    expect(normalizeConflictValue("owner", undefined)).toBeNull();
    expect(normalizeConflictValue("owner", " \t\u00A0\u200B ")).toBeNull();
  });

  it("trims and collapses whitespace runs, NBSP included", () => {
    expect(normalizeConflictValue("owner", "  net \u00A0\t ops  ")).toBe("net ops");
  });

  it("removes zero-width characters", () => {
    expect(normalizeConflictValue("projectRef", "Forti\u200DManager\uFEFF")).toBe("FortiManager");
  });

  it("applies NFKC (full-width letters read as ASCII)", () => {
    expect(normalizeConflictValue("owner", "\uFF2E\uFF45\uFF54")).toBe("Net");
  });

  it("lower-cases the hostname only", () => {
    expect(normalizeConflictValue("hostname", "KRONOS-INTOUCH-DX")).toBe("kronos-intouch-dx");
    expect(normalizeConflictValue("owner", "NetOps")).toBe("NetOps");
  });
});

describe("conflictValuesEqual", () => {
  it("treats values that read the same as equal", () => {
    expect(conflictValuesEqual("hostname", "KRONOS-INTOUCH-DX ", "kronos-intouch-dx")).toBe(true);
    expect(conflictValuesEqual("owner", null, "   ")).toBe(true);
  });

  it("keeps a real difference", () => {
    expect(conflictValuesEqual("hostname", "gw-1", "gw-2")).toBe(false);
    expect(conflictValuesEqual("owner", "NetOps", "netops")).toBe(false);
    expect(conflictValuesEqual("owner", null, "netops")).toBe(false);
  });
});
