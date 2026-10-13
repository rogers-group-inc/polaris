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

import { FORTISWITCH_MODEL_PARSE, LEGACY_FORTISWITCH_MODEL_PATTERN } from "../../src/utils/fortiswitchModel.js";
import { describe, it, expect } from "vitest";
import { applyModelParse, validateModelParse, templatePrefix } from "../../src/utils/modelParse.js";
import { MAX_REGEX_SUBJECT } from "../../src/utils/regexSafety.js";

// The FortiSwitch seed, exactly as the seed job stamps it.
const FORTISWITCH = FORTISWITCH_MODEL_PARSE;

describe("the FortiSwitch seed without lookahead (rule 115)", () => {
  it("parses exactly like the lookahead pattern it replaced", () => {
    // The old pattern on the JS engine is the oracle; the new one runs on RE2.
    const oracle = new RegExp(LEGACY_FORTISWITCH_MODEL_PATTERN, "i");
    const corpus = [
      "S548DF-v7.2.5-build0453,230511 (GA)",
      "FSR-124F-POE-v7.4.8-build0895,250226 (GA)",
      "FortiSwitchRugged-112D-POE v7.4.8,build0895 (GA)",
      "v7.2.5-build0453",
      "V7.2.5 build",
      "v-v7.0",
      "vX1-v7.0",
      "va v7",
      "S1-v",
      "plain text",
      "S108EF v7.2.5",
    ];
    for (const s of corpus) {
      const want = oracle.exec(s)?.[1]?.trim() ?? null;
      const got = (applyModelParse(s, { pattern: FORTISWITCH_MODEL_PARSE.pattern, template: null }) ?? null);
      expect(got, s).toBe(want);
    }
  });

  it("the legacy lookahead seed itself is refused by the RE2 validator", () => {
    expect(validateModelParse(LEGACY_FORTISWITCH_MODEL_PATTERN, "FortiSwitch $1")).toMatch(/lookahead or lookbehind/);
  });
});

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

  it("accepts a once-catastrophic pattern and runs it in linear time (rule 115)", () => {
    // Per asset per poll against whatever the device returned — on RE2 no
    // pattern can hang the monitor, so nested repeats are no longer refused.
    expect(validateModelParse("^((.+)+)-v", "FortiSwitch $1")).toBeNull();
    const t = Date.now();
    expect(applyModelParse("a".repeat(900) + "!", { pattern: "^((a+)+)-v", template: null })).toBeNull();
    expect(Date.now() - t).toBeLessThan(1000);
  });

  it("still accepts the ordinary shapes an operator actually writes", () => {
    expect(validateModelParse(String.raw`^(\w+)-v[\d.]+-build`, "Cisco $1")).toBeNull();
    expect(validateModelParse("(ab)+(c)", null)).toBeNull();
  });
});

describe("applyModelParse — the subject cap", () => {
  it("returns null rather than matching a scalar longer than the cap", () => {
    // Rule 2's "unrecognized, never a guess" covers a scalar too long to be a
    // model string. The cap is what keeps subject length from being the thing
    // that makes an operator's pattern expensive (utils/regexSafety.ts).
    const parse = { pattern: String.raw`^(.+?)-v\d`, template: null };
    const long = "S548DF".padEnd(MAX_REGEX_SUBJECT + 1, "x") + "-v7";
    expect(long.length).toBeGreaterThan(MAX_REGEX_SUBJECT);
    expect(applyModelParse(long, parse)).toBeNull();
    expect(applyModelParse("S548DF-v7", parse)).toBe("S548DF");
  });
});

describe("templatePrefix", () => {
  it("returns the literal before $1", () => {
    expect(templatePrefix("FortiSwitch $1")).toBe("FortiSwitch");
    expect(templatePrefix("$1")).toBe("");
    expect(templatePrefix(null)).toBe("");
  });
});
