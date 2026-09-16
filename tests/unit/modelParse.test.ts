/**
 * tests/unit/modelParse.test.ts — the declarative model parse reproduces the
 * one hand-written parser it replaces, then generalizes it.
 *
 * Every vector here for the FortiSwitch shape comes from
 * fortiswitchModel.test.ts, which pinned `fortiswitchModelFromFsSysVersion`
 * against real `fsSysVersion` strings. The parser becomes a row
 * (`parsePattern` + `parseTemplate`) so the model query can live in the
 * editable ManufacturerProfile; if the row form ever stops matching the old
 * function on these strings, a managed FortiSwitch's hardware model goes
 * blank — the deadlock fortinetClassHint.test.ts describes.
 */

import { describe, it, expect } from "vitest";
import { applyModelParse, validateModelParse, templatePrefix } from "../../src/utils/modelParse.js";

// The FortiSwitch seed, exactly as the seed job stamps it.
const FORTISWITCH = {
  pattern:  String.raw`^(?!v\d)(.+?)[-\s]v\d`,
  template: "FortiSwitch $1",
};

describe("applyModelParse — the FortiSwitch fsSysVersion shape", () => {
  it("strips the firmware suffix and prefixes the family (hyphen separator)", () => {
    expect(applyModelParse("S548DF-v7.2.5-build0453,230511 (GA)", FORTISWITCH)).toBe("FortiSwitch S548DF");
    expect(applyModelParse("S124EN-v7.0.6-build0074,221118 (GA)", FORTISWITCH)).toBe("FortiSwitch S124EN");
    expect(applyModelParse("S108EF-v7.2.5-build0453,230511 (GA)", FORTISWITCH)).toBe("FortiSwitch S108EF");
  });

  it("handles the SPACE separator FortiSwitch Rugged uses, and hyphens inside the token", () => {
    expect(applyModelParse("FSR-124F-POE-v7.4.8-build0895,250226 (GA)", FORTISWITCH)).toBe("FortiSwitch FSR-124F-POE");
  });

  it("does not re-prefix a token that already names the family", () => {
    // "FortiSwitch FortiSwitchRugged-112D-POE" would be wrong; the prefix rule
    // is generalized from the template, not hardcoded to one vendor.
    expect(applyModelParse("FortiSwitchRugged-112D-POE v7.4.8,build0895 (GA)", FORTISWITCH)).toBe("FortiSwitchRugged-112D-POE");
    expect(applyModelParse("FortiSwitch S548DF-v7.2.5-build0453 (GA)", FORTISWITCH)).toBe("FortiSwitch S548DF");
  });

  it("returns null for a string with no firmware marker, a firmware-only string, or blank", () => {
    expect(applyModelParse("S548DF", FORTISWITCH)).toBeNull();
    expect(applyModelParse("unexpected string", FORTISWITCH)).toBeNull();
    // Starts with the firmware marker: the negative lookahead folds the old
    // parser's explicit "firmware-only" guard into the pattern.
    expect(applyModelParse("v7.2.5-build0453,230511 (GA)", FORTISWITCH)).toBeNull();
    expect(applyModelParse("", FORTISWITCH)).toBeNull();
    expect(applyModelParse("   ", FORTISWITCH)).toBeNull();
    expect(applyModelParse(null, FORTISWITCH)).toBeNull();
    expect(applyModelParse(undefined, FORTISWITCH)).toBeNull();
  });

  it("trims surrounding whitespace before matching", () => {
    expect(applyModelParse("  S548DF-v7.2.5-build0453 (GA)  ", FORTISWITCH)).toBe("FortiSwitch S548DF");
  });
});

describe("applyModelParse — generalized", () => {
  it("returns the bare token when there is no template", () => {
    expect(applyModelParse("Model: WS-C2960X-48; sw 15.2", { pattern: "Model:\\s*([^;]+)", template: null })).toBe("WS-C2960X-48");
  });

  it("is case-insensitive on the prefix check", () => {
    expect(applyModelParse("fortiswitch S548DF-v7.2.5 (GA)", FORTISWITCH)).toBe("fortiswitch S548DF");
  });

  it("returns null on an empty capture or a malformed pattern rather than throwing", () => {
    expect(applyModelParse("abc", { pattern: "(x*)abc", template: null })).toBeNull();
    expect(applyModelParse("abc", { pattern: "([unclosed", template: null })).toBeNull();
  });
});

describe("validateModelParse", () => {
  it("accepts the FortiSwitch seed", () => {
    expect(validateModelParse(FORTISWITCH.pattern, FORTISWITCH.template)).toBeNull();
    expect(validateModelParse("(.+)", null)).toBeNull();
  });

  it("rejects a missing pattern, a pattern with no capture group, and a template without $1", () => {
    expect(validateModelParse("", null)).toMatch(/required/);
    expect(validateModelParse("^S\\d+", "FortiSwitch $1")).toMatch(/capture group/);
    expect(validateModelParse("(.+)", "FortiSwitch")).toMatch(/\$1/);
    expect(validateModelParse("([", null)).toMatch(/valid regex/);
  });
});

describe("templatePrefix", () => {
  it("returns the literal before $1", () => {
    expect(templatePrefix("FortiSwitch $1")).toBe("FortiSwitch");
    expect(templatePrefix("$1")).toBe("");
    expect(templatePrefix(null)).toBe("");
  });
});
