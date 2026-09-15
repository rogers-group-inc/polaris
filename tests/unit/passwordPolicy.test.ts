/**
 * tests/unit/passwordPolicy.test.ts — src/utils/passwordPolicy.ts
 *
 * The configurable complexity bar, as pure data. Two things here are
 * load-bearing beyond "the regexes work":
 *
 *   - The DEFAULTS are exactly the five rules Polaris enforced before the
 *     policy existed. An install that never opens the tab must be gated as it
 *     was, and a drift here would silently lower (or raise) that bar for every
 *     such install on upgrade.
 *   - `parsePasswordPolicy` falls back to those defaults field by field. A
 *     hand-mangled Setting row must degrade to today's rules, never to "no
 *     rules at all" — the difference between a cosmetic bug and an install
 *     quietly accepting one-character passwords.
 */

import { describe, it, expect } from "vitest";
import {
  defaultPasswordPolicy,
  passwordRules,
  evaluatePassword,
  passwordMeetsPolicy,
  passwordPolicyError,
  describePasswordPolicy,
  parsePasswordPolicy,
  clampMinLength,
  PASSWORD_MIN_LENGTH_FLOOR,
  PASSWORD_MIN_LENGTH_CEILING,
  type PasswordPolicy,
} from "../../src/utils/passwordPolicy.js";

const defaults = defaultPasswordPolicy();

describe("defaultPasswordPolicy", () => {
  it("is the five rules this product shipped with", () => {
    expect(defaults).toEqual({
      minLength: 8,
      requireLowercase: true,
      requireUppercase: true,
      requireNumber: true,
      requireSpecial: true,
      forceChangeOnLogin: false,
    });
  });

  it("does not force existing passwords to change — an upgrade must refuse nothing", () => {
    expect(defaults.forceChangeOnLogin).toBe(false);
  });
});

describe("passwordRules", () => {
  it("lists all five under the defaults, length first", () => {
    expect(passwordRules(defaults).map((r) => r.key)).toEqual(["length", "lower", "upper", "number", "special"]);
  });

  it("omits the classes the policy does not require", () => {
    const lengthOnly: PasswordPolicy = {
      ...defaults,
      requireLowercase: false,
      requireUppercase: false,
      requireNumber: false,
      requireSpecial: false,
    };
    expect(passwordRules(lengthOnly).map((r) => r.key)).toEqual(["length"]);
  });

  it("names the configured minimum in the label the client renders", () => {
    expect(passwordRules({ ...defaults, minLength: 16 })[0].label).toBe("At least 16 characters");
  });
});

describe("evaluatePassword", () => {
  it("returns nothing for a conforming password", () => {
    expect(evaluatePassword("Replacement-2!", defaults)).toEqual([]);
    expect(passwordMeetsPolicy("Replacement-2!", defaults)).toBe(true);
  });

  it.each([
    ["Sh0rt!", "length"],
    ["NOLOWERCASE1!", "lower"],
    ["nouppercase1!", "upper"],
    ["NoDigitsHere!", "number"],
    ["NoSpecialChar1", "special"],
  ])("flags %j as failing %s", (pw, key) => {
    expect(evaluatePassword(pw, defaults).map((r) => r.key)).toContain(key);
  });

  it("reports EVERY unmet rule, not just the first", () => {
    // A user who typed "password" should not discover the remaining rules one
    // submission at a time.
    expect(evaluatePassword("password", defaults).map((r) => r.key).sort())
      .toEqual(["number", "special", "upper"]);
  });

  it("accepts a password that only fails a rule the policy switched off", () => {
    const noSpecial: PasswordPolicy = { ...defaults, requireSpecial: false };
    expect(passwordMeetsPolicy("NoSpecialChar1", defaults)).toBe(false);
    expect(passwordMeetsPolicy("NoSpecialChar1", noSpecial)).toBe(true);
  });

  it("honours a raised minimum length", () => {
    const long: PasswordPolicy = { ...defaults, minLength: 20 };
    expect(passwordMeetsPolicy("Replacement-2!", defaults)).toBe(true);
    expect(passwordMeetsPolicy("Replacement-2!", long)).toBe(false);
  });

  it("treats a space as a special character", () => {
    // Passphrases are the posture NIST actually recommends; a space failing
    // "special character" would push users back toward P@ssw0rd1.
    expect(passwordMeetsPolicy("Correct Horse 9B", defaults)).toBe(true);
  });
});

describe("passwordPolicyError", () => {
  it("is null for a conforming password", () => {
    expect(passwordPolicyError("Replacement-2!", defaults)).toBeNull();
  });

  it("names the single unmet rule when only one fails", () => {
    expect(passwordPolicyError("NoSpecialChar1", defaults)).toMatch(/special character/);
  });

  it("names every unmet rule when several fail", () => {
    const message = passwordPolicyError("password", defaults)!;
    expect(message).toMatch(/uppercase/);
    expect(message).toMatch(/number/);
    expect(message).toMatch(/special/);
  });
});

describe("clampMinLength", () => {
  it("holds the floor — a UI that offered 1 would be a footgun", () => {
    expect(clampMinLength(1, 8)).toBe(PASSWORD_MIN_LENGTH_FLOOR);
    expect(clampMinLength(-40, 8)).toBe(PASSWORD_MIN_LENGTH_FLOOR);
  });

  it("holds the ceiling", () => {
    expect(clampMinLength(9999, 8)).toBe(PASSWORD_MIN_LENGTH_CEILING);
  });

  it("passes a value in range through, truncating fractions", () => {
    expect(clampMinLength(16, 8)).toBe(16);
    expect(clampMinLength(16.9, 8)).toBe(16);
  });

  it("falls back for anything that is not a number", () => {
    expect(clampMinLength("nonsense", 12)).toBe(12);
    expect(clampMinLength(undefined, 12)).toBe(12);
    expect(clampMinLength(NaN, 12)).toBe(12);
  });

  it("reads a numeric string, since a JSON blob may hold one", () => {
    expect(clampMinLength("16", 8)).toBe(16);
  });
});

describe("parsePasswordPolicy", () => {
  it("returns the defaults for a missing row", () => {
    expect(parsePasswordPolicy(undefined)).toEqual(defaults);
    expect(parsePasswordPolicy(null)).toEqual(defaults);
  });

  it("returns the defaults for a row that is not an object", () => {
    expect(parsePasswordPolicy("nonsense")).toEqual(defaults);
    expect(parsePasswordPolicy(42)).toEqual(defaults);
  });

  it("round-trips a full policy", () => {
    const stored: PasswordPolicy = {
      minLength: 14,
      requireLowercase: true,
      requireUppercase: false,
      requireNumber: true,
      requireSpecial: false,
      forceChangeOnLogin: true,
    };
    expect(parsePasswordPolicy(stored)).toEqual(stored);
  });

  it("fills each missing field from the defaults rather than dropping the rule", () => {
    // The failure this guards: a partial blob parsing to a policy with every
    // character class false, i.e. an install that quietly stopped enforcing
    // anything but length.
    expect(parsePasswordPolicy({ minLength: 12 })).toEqual({ ...defaults, minLength: 12 });
  });

  it("ignores a stored minLength below the floor", () => {
    expect(parsePasswordPolicy({ minLength: 2 }).minLength).toBe(PASSWORD_MIN_LENGTH_FLOOR);
  });

  it("ignores non-boolean values for the class flags", () => {
    expect(parsePasswordPolicy({ requireSpecial: "no" }).requireSpecial).toBe(true);
  });
});

describe("describePasswordPolicy", () => {
  it("names the length and every required class for the audit Event", () => {
    const text = describePasswordPolicy(defaults);
    expect(text).toMatch(/min 8 characters/);
    expect(text).toMatch(/lowercase \+ uppercase \+ number \+ special/);
  });

  it("says so when no character classes are required", () => {
    const text = describePasswordPolicy({
      ...defaults,
      requireLowercase: false,
      requireUppercase: false,
      requireNumber: false,
      requireSpecial: false,
    });
    expect(text).toMatch(/no character-class requirements/);
  });

  it("calls out the forced change, which is the part that interrupts people", () => {
    expect(describePasswordPolicy({ ...defaults, forceChangeOnLogin: true }))
      .toMatch(/must be changed at next login/);
  });
});
