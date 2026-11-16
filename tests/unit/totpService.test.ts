/**
 * tests/unit/totpService.test.ts — the pure TOTP helpers: secret generation,
 * the enrollment URI + QR, and the backup-code round trip (10 codes of
 * XXXX-XXXX hex, hashed; consuming one removes exactly that hash).
 *
 * verifyCode / verifyCodeStep (the ±1 step window) are pinned by
 * tests/unit/totpStep.test.ts; only the edges it does not reach are here.
 * The password hash is stubbed so the backup-code tests do not pay for argon2.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/utils/password.js", () => ({
  hashPassword: vi.fn(async (p: string) => `h:${p}`),
  verifyPassword: vi.fn(async (p: string, hash: string) => ({ valid: hash === `h:${p}` })),
}));

import { TOTP, Secret } from "otpauth";
import {
  generateSecret,
  buildEnrollment,
  verifyCode,
  verifyCodeStep,
  generateBackupCodes,
  consumeBackupCode,
} from "../../src/services/totpService.js";

describe("generateSecret", () => {
  it("returns a 160-bit base32 secret, different every call", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(a).not.toBe(b);
    expect(Secret.fromBase32(a).bytes.length).toBe(20);
  });
});

describe("buildEnrollment", () => {
  it("builds an otpauth URI for the Polaris issuer and the account, with RFC 6238 defaults", async () => {
    const secret = generateSecret();
    const { otpauthUri, qrSvg } = await buildEnrollment(secret, "jdoe");
    const url = new URL(otpauthUri);
    expect(url.protocol).toBe("otpauth:");
    expect(url.host).toBe("totp");
    expect(decodeURIComponent(url.pathname)).toBe("/Polaris:jdoe");
    expect(url.searchParams.get("secret")).toBe(secret);
    expect(url.searchParams.get("issuer")).toBe("Polaris");
    expect(url.searchParams.get("algorithm")).toBe("SHA1");
    expect(url.searchParams.get("digits")).toBe("6");
    expect(url.searchParams.get("period")).toBe("30");
    expect(qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
  });
});

describe("verifyCode / verifyCodeStep edges", () => {
  const secret = generateSecret();
  const totp = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(secret) });

  it("accepts a current code with surrounding whitespace", () => {
    const now = Date.now();
    expect(verifyCodeStep(secret, `  ${totp.generate({ timestamp: now })}\n`, now)).toBe(Math.floor(now / 30_000));
  });

  it("refuses a code generated for a different secret", () => {
    const other = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(generateSecret()) });
    const now = 1_800_000_015_000;
    const code = other.generate({ timestamp: now });
    // The chance the other secret's code collides inside the ±1 window is ~3e-6.
    expect(verifyCodeStep(secret, code, now)).toBeNull();
  });

  it("refuses an 8-digit code even when its last six digits are valid", () => {
    expect(verifyCode(secret, `00${totp.generate()}`)).toBe(false);
  });
});

describe("generateBackupCodes", () => {
  it("returns 10 distinct XXXX-XXXX hex codes and one hash per code, in order", async () => {
    const { plaintext, hashes } = await generateBackupCodes();
    expect(plaintext).toHaveLength(10);
    expect(new Set(plaintext).size).toBe(10);
    for (const c of plaintext) expect(c).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
    expect(hashes).toEqual(plaintext.map((c) => `h:${c}`));
  });
});

describe("consumeBackupCode", () => {
  const stored = ["h:AAAA-1111", "h:BBBB-2222", "h:CCCC-3333"];

  it("removes exactly the matched hash and keeps the others in order", async () => {
    expect(await consumeBackupCode(stored, "BBBB-2222")).toEqual(["h:AAAA-1111", "h:CCCC-3333"]);
    expect(stored).toHaveLength(3); // the input is not mutated — the caller persists the result
  });

  it("accepts lower case and surrounding whitespace", async () => {
    expect(await consumeBackupCode(stored, "  cccc-3333 ")).toEqual(["h:AAAA-1111", "h:BBBB-2222"]);
  });

  it("returns null for a code that matches nothing, and for an empty store", async () => {
    expect(await consumeBackupCode(stored, "DDDD-4444")).toBeNull();
    expect(await consumeBackupCode([], "AAAA-1111")).toBeNull();
  });

  it("consuming the last code leaves an empty list, not null", async () => {
    expect(await consumeBackupCode(["h:AAAA-1111"], "AAAA-1111")).toEqual([]);
  });

  it("a code can be used once: consuming it again from the returned list fails", async () => {
    const left = await consumeBackupCode(stored, "AAAA-1111");
    expect(left).not.toBeNull();
    expect(await consumeBackupCode(left as string[], "AAAA-1111")).toBeNull();
  });
});
