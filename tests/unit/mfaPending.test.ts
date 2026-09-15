/**
 * tests/unit/mfaPending.test.ts — src/utils/mfaPending.ts
 *
 * The store for a login that is partly complete: the password was right, the
 * session is not issued yet.
 *
 * It grew a second `purpose` in 2026-09 ("password-change", business rule 63)
 * and that is what this file is mostly here for. The two purposes authorize
 * different things — one buys a second-factor attempt, the other buys the
 * right to set a new password AND collect the withheld session — so a token
 * minted for one must never be spendable at the other's endpoint. Get that
 * wrong and a password-change token, which is issued only after every factor
 * has passed, would be accepted at the TOTP step; get the inverse wrong and an
 * MFA token would buy a password change without the second factor, which is
 * the MFA bypass rule 63 exists to prevent.
 *
 * `revokeForUser` is checked across BOTH purposes for the same reason it is one
 * map: an admin resetting a password must invalidate every half-finished login
 * on that account, whichever step it is sitting at.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { issue, peek, consume, revokeForUser } from "../../src/utils/mfaPending.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("issue", () => {
  it("returns an unguessable token", () => {
    const token = issue("user-1", "jsmith");
    expect(token).toHaveLength(64); // 32 random bytes, hex
    expect(issue("user-1", "jsmith")).not.toBe(token);
  });

  it("defaults to the MFA purpose, so every pre-existing caller is unchanged", () => {
    const token = issue("user-1", "jsmith");
    expect(peek(token)).toMatchObject({ userId: "user-1", username: "jsmith", purpose: "mfa" });
  });

  it("defaults to TOTP as the available method", () => {
    // The pre-passkey shape: an account reaching this step had TOTP enrolled.
    expect(peek(issue("user-1", "jsmith"))!.methods).toEqual({ totp: true, passkey: false });
  });

  it("records which second factors the account can actually finish with", () => {
    const token = issue("user-1", "jsmith", { methods: { totp: false, passkey: true } });
    expect(peek(token)!.methods).toEqual({ totp: false, passkey: true });
  });

  it("carries the forced-password-change flag across the second factor", () => {
    const token = issue("user-1", "jsmith", { mustChangePassword: true });
    expect(peek(token)!.mustChangePassword).toBe(true);
  });

  it("does not demand a password change unless asked", () => {
    expect(peek(issue("user-1", "jsmith"))!.mustChangePassword).toBe(false);
  });
});

describe("peek / consume", () => {
  it("peek does not spend the token", () => {
    const token = issue("user-1", "jsmith");
    expect(peek(token)).not.toBeNull();
    expect(peek(token)).not.toBeNull();
    expect(consume(token)).not.toBeNull();
  });

  it("consume is single-use", () => {
    const token = issue("user-1", "jsmith");
    expect(consume(token)).not.toBeNull();
    expect(consume(token)).toBeNull();
  });

  it("answers null for an absent or unknown token rather than throwing", () => {
    expect(peek(undefined)).toBeNull();
    expect(peek(null)).toBeNull();
    expect(peek("")).toBeNull();
    expect(consume("deadbeef")).toBeNull();
  });

  it("expires after the TTL", () => {
    vi.useFakeTimers();
    const token = issue("user-1", "jsmith");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(peek(token)).toBeNull();
  });

  it("still answers inside the TTL", () => {
    vi.useFakeTimers();
    const token = issue("user-1", "jsmith");
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(peek(token)).not.toBeNull();
  });
});

describe("purpose binding", () => {
  it("refuses an MFA token at the password-change step", () => {
    // The MFA bypass this guard exists to prevent: a password-change token is
    // only ever minted after every factor has passed, so accepting an MFA one
    // here would let a stolen password set a new one and take the session.
    const token = issue("user-1", "jsmith");
    expect(peek(token, "password-change")).toBeNull();
    expect(consume(token, "password-change")).toBeNull();
  });

  it("refuses a password-change token at the MFA step", () => {
    const token = issue("user-1", "jsmith", { purpose: "password-change" });
    expect(peek(token, "mfa")).toBeNull();
    expect(consume(token)).toBeNull();
  });

  it("does not spend a token it refused, so the right endpoint still works", () => {
    // A mismatch is a routing mistake, not an attack on a token the caller
    // legitimately holds — burning it would strand a user mid-login.
    const token = issue("user-1", "jsmith", { purpose: "password-change" });
    expect(consume(token, "mfa")).toBeNull();
    expect(consume(token, "password-change")).not.toBeNull();
  });
});

describe("revokeForUser", () => {
  it("drops that user's pending login", () => {
    const mine = issue("user-1", "jsmith");
    const theirs = issue("user-2", "adoe");
    revokeForUser("user-1");
    expect(peek(mine)).toBeNull();
    expect(peek(theirs)).not.toBeNull();
  });

  it("drops it whichever step it is sitting at", () => {
    // One map, so an admin password reset invalidates the second-factor step
    // AND a forced-change step in flight for the same account.
    const atMfa = issue("user-3", "rroe");
    const atChange = issue("user-3", "rroe", { purpose: "password-change" });
    revokeForUser("user-3");
    expect(peek(atMfa)).toBeNull();
    expect(peek(atChange, "password-change")).toBeNull();
  });
});
