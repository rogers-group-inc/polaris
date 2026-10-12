/**
 * tests/unit/totpStep.test.ts
 *
 * verifyCodeStep reports WHICH 30-second step a code belongs to, so a caller can
 * record it and refuse a replay (RFC 6238 section 5.2; scan finding F237;
 * business rule 108). verifyCode remains the boolean view of the same check.
 */

import { describe, it, expect } from "vitest";
import { TOTP, Secret } from "otpauth";
import { generateSecret, verifyCode, verifyCodeStep } from "../../src/services/totpService.js";

const SECRET = generateSecret();
const totp = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(SECRET) });
// A fixed instant in the middle of a step, so +/-1 step arithmetic is unambiguous.
const NOW = 1_800_000_015_000;
const STEP = Math.floor(NOW / 1000 / 30);

const codeAt = (offsetSteps: number) => totp.generate({ timestamp: NOW + offsetSteps * 30_000 });

describe("verifyCodeStep", () => {
  it("returns the current step for a current code", () => {
    expect(verifyCodeStep(SECRET, codeAt(0), NOW)).toBe(STEP);
  });

  it("returns the neighbouring step for a code from the previous or next window", () => {
    expect(verifyCodeStep(SECRET, codeAt(-1), NOW)).toBe(STEP - 1);
    expect(verifyCodeStep(SECRET, codeAt(1), NOW)).toBe(STEP + 1);
  });

  it("returns null outside the +/-1 window", () => {
    expect(verifyCodeStep(SECRET, codeAt(-2), NOW)).toBeNull();
    expect(verifyCodeStep(SECRET, codeAt(2), NOW)).toBeNull();
  });

  it("returns null for anything that is not six digits", () => {
    for (const bad of ["", "12345", "1234567", "abcdef", "12 34 5x"]) {
      expect(verifyCodeStep(SECRET, bad, NOW)).toBeNull();
    }
  });

  it("ignores whitespace inside a code, as verifyCode always did", () => {
    const c = codeAt(0);
    expect(verifyCodeStep(SECRET, `${c.slice(0, 3)} ${c.slice(3)}`, NOW)).toBe(STEP);
  });

  it("gives the SAME step for the same code however many times it is checked", () => {
    // Why the caller must record the step: verification alone says "valid" every
    // time. The replay refusal lives in claimTotpStep.
    const c = codeAt(0);
    expect(verifyCodeStep(SECRET, c, NOW)).toBe(verifyCodeStep(SECRET, c, NOW + 20_000));
  });
});

describe("verifyCode", () => {
  it("is the boolean view of verifyCodeStep", () => {
    expect(verifyCode(SECRET, totp.generate())).toBe(true);
    expect(verifyCode(SECRET, "000000")).toBe(totp.generate() === "000000");
  });
});
