/**
 * tests/unit/secretBox.test.ts
 *
 * Envelope encryption for secrets stored in JSON columns. The properties that
 * matter operationally, in the order they matter:
 *
 *   1. A sealed value does not contain the plaintext. That is the whole point —
 *      a pg_dump must be inert.
 *   2. Sealing is idempotent, and opening a plaintext value is a pass-through.
 *      Both are what let a partially-backfilled install work.
 *   3. Nothing throws. A wrong key must degrade to "this credential stopped
 *      working", never to an exception on every monitor tick.
 *   4. With no key configured, behavior is exactly the pre-2026-08 plaintext
 *      behavior, so an in-app update cannot break a running install.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  sealValue,
  openValue,
  isSealed,
  generateSecretKey,
  secretEncryptionEnabled,
  _resetKeyCacheForTests,
} from "../../src/utils/secretBox.js";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const SECRET = "S3cret-community-string!";

const savedKey = process.env.POLARIS_SECRET_KEY;

function useKey(key: string | undefined): void {
  if (key === undefined) delete process.env.POLARIS_SECRET_KEY;
  else process.env.POLARIS_SECRET_KEY = key;
  _resetKeyCacheForTests();
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  useKey(KEY_A);
});

afterEach(() => {
  vi.restoreAllMocks();
  useKey(savedKey);
});

describe("sealValue / openValue round trip", () => {
  it("seals to a self-describing token that does not contain the plaintext", () => {
    const sealed = sealValue(SECRET);
    expect(sealed).not.toBe(SECRET);
    expect(sealed.startsWith("psec:v1:")).toBe(true);
    expect(sealed).not.toContain(SECRET);
    expect(isSealed(sealed)).toBe(true);
    expect(openValue(sealed)).toBe(SECRET);
  });

  it("uses a fresh IV per value, so the same secret seals differently twice", () => {
    // Identical ciphertexts would leak "these two devices share a community
    // string" to anyone reading the dump.
    const a = sealValue(SECRET);
    const b = sealValue(SECRET);
    expect(a).not.toBe(b);
    expect(openValue(a)).toBe(SECRET);
    expect(openValue(b)).toBe(SECRET);
  });

  it("round-trips unicode and long values (SSH private keys)", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\n" + "x".repeat(3000) + "\n-----END-----";
    expect(openValue(sealValue(pem))).toBe(pem);
    const unicode = "pässwörd-🔐-é";
    expect(openValue(sealValue(unicode))).toBe(unicode);
  });

  it("is idempotent — sealing an already-sealed value is a no-op", () => {
    const once = sealValue(SECRET);
    expect(sealValue(once)).toBe(once);
    expect(openValue(sealValue(once))).toBe(SECRET);
  });

  it("passes an empty string through untouched", () => {
    // "" is meaningful: the masking layer uses it for "this secret is not set".
    expect(sealValue("")).toBe("");
    expect(openValue("")).toBe("");
  });

  it("passes plaintext through on open, so mixed rows work mid-backfill", () => {
    expect(openValue("still-plaintext")).toBe("still-plaintext");
    expect(isSealed("still-plaintext")).toBe(false);
  });
});

describe("key handling", () => {
  it("reports encryption enabled only when a key is present", () => {
    expect(secretEncryptionEnabled()).toBe(true);
    useKey(undefined);
    expect(secretEncryptionEnabled()).toBe(false);
  });

  it("stores PLAINTEXT when no key is configured (pre-2026-08 behavior)", () => {
    // An in-app update must never leave an install unable to reach its own
    // FortiManager because a new env var appeared.
    useKey(undefined);
    const out = sealValue(SECRET);
    expect(out).toBe(SECRET);
    expect(isSealed(out)).toBe(false);
  });

  it("returns empty (never throws) when the key is wrong", () => {
    const sealed = sealValue(SECRET);
    useKey(KEY_B);
    expect(() => openValue(sealed)).not.toThrow();
    expect(openValue(sealed)).toBe("");
  });

  it("returns empty (never throws) when the key has been removed", () => {
    const sealed = sealValue(SECRET);
    useKey(undefined);
    expect(() => openValue(sealed)).not.toThrow();
    expect(openValue(sealed)).toBe("");
  });

  it("does not throw on a malformed token", () => {
    expect(openValue("psec:v1:not-enough-parts")).toBe("");
    expect(openValue("psec:v1:!!!:!!!:!!!")).toBe("");
  });

  it("accepts a base64 key and a long passphrase, not just 64 hex chars", () => {
    useKey(Buffer.alloc(32, 7).toString("base64"));
    expect(secretEncryptionEnabled()).toBe(true);
    expect(openValue(sealValue(SECRET))).toBe(SECRET);

    // A pasted passphrase is hashed to 32 bytes rather than silently ignored —
    // believing you have encryption when you do not is the worst outcome here.
    useKey("a long human-chosen passphrase that is not hex or base64");
    expect(secretEncryptionEnabled()).toBe(true);
    expect(openValue(sealValue(SECRET))).toBe(SECRET);
  });

  it("generateSecretKey produces the documented 64-hex-char form", () => {
    const k = generateSecretKey();
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    useKey(k);
    expect(openValue(sealValue(SECRET))).toBe(SECRET);
  });
});

/**
 * User.totpSecret is a SCALAR column, so it is outside the JSON-blob
 * seal-on-write extension in db.ts and is sealed explicitly by auth.ts. What
 * makes that safe on an existing install is openValue's pass-through: the
 * verify path must keep working for enrollments made before sealing existed,
 * on an install with no key, and on one where the key arrived later.
 */
describe("TOTP secret at rest (the scalar-column case)", () => {
  const TOTP = "JBSWY3DPEHPK3PXP";

  it("round-trips a base32 TOTP secret and never stores it in the clear", () => {
    const sealed = sealValue(TOTP);
    expect(sealed).not.toContain(TOTP);
    expect(openValue(sealed)).toBe(TOTP);
  });

  it("passes a legacy plaintext enrollment straight through, so it still verifies", () => {
    // The row a pre-sealing install already has. openValue must not touch it.
    expect(isSealed(TOTP)).toBe(false);
    expect(openValue(TOTP)).toBe(TOTP);
  });

  it("keeps working on an install with no key configured at all", () => {
    useKey(undefined);
    expect(sealValue(TOTP)).toBe(TOTP);
    expect(openValue(TOTP)).toBe(TOTP);
  });

  it("is idempotent, so the backfill cannot double-seal a row it already converted", () => {
    const once = sealValue(TOTP);
    expect(sealValue(once)).toBe(once);
    expect(openValue(sealValue(once))).toBe(TOTP);
  });
});
