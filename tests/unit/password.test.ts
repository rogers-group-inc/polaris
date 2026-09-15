/**
 * tests/unit/password.test.ts — src/utils/password.ts
 *
 * The hashing helpers, plus what is left of `passwordPolicySchema` after the
 * complexity bar became operator-configurable (2026-09): a SHAPE check —
 * non-empty, bounded — and nothing more. The rules themselves moved to
 * utils/passwordPolicy.ts, which passwordPolicy.test.ts pins, and the
 * assertion every route makes against the live policy is pinned by
 * passwordPolicyService.test.ts.
 *
 * This file's remaining job around the schema is to make sure it is not
 * quietly asked to be the gate again: a complexity rule reappearing here would
 * mean two places enforce the bar and only one of them is configurable.
 */

import { describe, it, expect } from "vitest";
import { hash as argonHash, Algorithm } from "@node-rs/argon2";
import { hashPassword, verifyPassword, passwordPolicySchema } from "../../src/utils/password.js";

describe("passwordPolicySchema", () => {
  it("accepts a password meeting every default rule", () => {
    expect(passwordPolicySchema.safeParse("Replacement-2!").success).toBe(true);
  });

  it("accepts a password that meets NONE of the old rules — complexity is not its job", () => {
    // This would have failed four of the five hard-coded rules. It must pass
    // here: an install may legitimately have relaxed the character classes,
    // and the live policy is what decides.
    expect(passwordPolicySchema.safeParse("aaaaaaaaaaaa").success).toBe(true);
  });

  it("rejects an empty password", () => {
    expect(passwordPolicySchema.safeParse("").success).toBe(false);
  });

  it("caps length, so nothing unbounded reaches argon2", () => {
    expect(passwordPolicySchema.safeParse("A1!" + "x".repeat(200)).success).toBe(true);
    expect(passwordPolicySchema.safeParse("x".repeat(1024)).success).toBe(true);
    expect(passwordPolicySchema.safeParse("x".repeat(1025)).success).toBe(false);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("produces an argon2id hash that verifies", async () => {
    const stored = await hashPassword("Replacement-2!");
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect((await verifyPassword("Replacement-2!", stored)).valid).toBe(true);
  });

  it("salts, so the same password hashes differently every time", async () => {
    const a = await hashPassword("Replacement-2!");
    const b = await hashPassword("Replacement-2!");
    expect(a).not.toBe(b);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("Replacement-2!");
    expect((await verifyPassword("Original-1!", stored)).valid).toBe(false);
  });

  it("fails a null stored hash without throwing — the user-not-found path", async () => {
    // Login passes null here rather than returning early, so the response time
    // of "no such user" matches "wrong password" and the endpoint can't be
    // used to enumerate usernames.
    await expect(verifyPassword("anything", null)).resolves.toEqual({ valid: false, needsRehash: false });
  });

  it("fails closed on a stored value in an unknown format", async () => {
    expect((await verifyPassword("anything", "not-a-hash")).valid).toBe(false);
  });

  it("does not ask for a rehash of a hash at the current params", async () => {
    const current = await hashPassword("Replacement-2!");
    expect(await verifyPassword("Replacement-2!", current)).toEqual({ valid: true, needsRehash: false });
  });

  it("asks for a rehash when the stored params are weaker than the current target", async () => {
    // A genuine hash at deliberately weaker settings — the shape of every
    // password stored before an ARGON2_PARAMS bump. It must still VERIFY (the
    // params travel in the PHC string, so an old hash keeps working) while
    // telling the caller to re-store it at the new cost.
    const weak = await argonHash("Replacement-2!", {
      algorithm: Algorithm.Argon2id,
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
    });
    expect(await verifyPassword("Replacement-2!", weak)).toEqual({ valid: true, needsRehash: true });
  });

  it("does not ask for a rehash on a password that did not verify", async () => {
    // needsRehash is only meaningful alongside a correct password — there is
    // nothing to re-store otherwise, and a caller acting on it would be
    // rehashing whatever the attacker typed.
    const weak = await argonHash("Replacement-2!", {
      algorithm: Algorithm.Argon2id,
      memoryCost: 4096,
      timeCost: 1,
      parallelism: 1,
    });
    expect(await verifyPassword("wrong-password", weak)).toEqual({ valid: false, needsRehash: false });
  });
});
