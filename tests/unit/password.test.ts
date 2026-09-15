/**
 * tests/unit/password.test.ts — src/utils/password.ts
 *
 * The hashing helpers and `passwordPolicySchema`, the single Zod copy of the
 * complexity bar. The schema is the reason this file has a test at all: it
 * used to be three verbatim copies (admin create, admin reset, the setup
 * wizard's first admin), the self-service change made it a fourth, and the
 * whole point of folding them together is that the bar can only move in one
 * place. `public/js/password-self.js` renders the same five rules to the user
 * as a hint — passwordSelfModule.test.ts pins that list, this one pins the
 * gate, and the two are meant to name the same five properties.
 */

import { describe, it, expect } from "vitest";
import { hash as argonHash, Algorithm } from "@node-rs/argon2";
import { hashPassword, verifyPassword, passwordPolicySchema } from "../../src/utils/password.js";

describe("passwordPolicySchema", () => {
  it("accepts a password meeting every rule", () => {
    expect(passwordPolicySchema.safeParse("Replacement-2!").success).toBe(true);
  });

  it.each([
    ["Sh0rt!",         /8 characters/,      "too short"],
    ["NOLOWERCASE1!",  /lowercase/,         "no lowercase letter"],
    ["nouppercase1!",  /uppercase/,         "no uppercase letter"],
    ["NoDigitsHere!",  /number/,            "no number"],
    ["NoSpecialChar1", /special character/, "no special character"],
  ])("rejects %j — %s", (pw, expected) => {
    const result = passwordPolicySchema.safeParse(pw);
    expect(result.success).toBe(false);
    // The message is surfaced verbatim to the user by the route's Zod error
    // handler, so it has to name the rule that failed rather than the field.
    expect(result.error!.issues.map((i) => i.message).join(" ")).toMatch(expected);
  });

  it("names every unmet rule at once rather than stopping at the first", () => {
    // A user who typed "password" should not have to discover the four
    // remaining rules one submission at a time.
    const result = passwordPolicySchema.safeParse("password");
    expect(result.success).toBe(false);
    expect(result.error!.issues.length).toBeGreaterThanOrEqual(3);
  });

  it("puts no ceiling on length", () => {
    expect(passwordPolicySchema.safeParse("A1!" + "x".repeat(200)).success).toBe(true);
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
