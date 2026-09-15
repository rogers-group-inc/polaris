/**
 * tests/unit/webauthnChallenge.test.ts — src/utils/webauthnChallenge.ts
 *
 * The in-flight-ceremony store. Three properties here are security controls
 * rather than conveniences:
 *
 *   - single use: a consumed token must never verify a second assertion;
 *   - purpose binding: a token minted for registration must not be spendable
 *     at the login endpoint, and vice versa;
 *   - a hard cap: the login options endpoint is reachable unauthenticated, so
 *     the map needs a ceiling that does not depend on a rate limiter being
 *     configured correctly.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { issue, consume, revokeForUser, _reset } from "../../src/utils/webauthnChallenge.js";

const ceremony = {
  purpose: "login" as const,
  challenge: "Y2hhbGxlbmdl",
  userId: null,
  rpId: "polaris.example.com",
  origin: "https://polaris.example.com",
};

beforeEach(() => {
  _reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("issue / consume", () => {
  it("returns the ceremony it was handed", () => {
    const token = issue(ceremony);
    expect(consume(token, "login")).toMatchObject({
      challenge: "Y2hhbGxlbmdl",
      rpId: "polaris.example.com",
      origin: "https://polaris.example.com",
    });
  });

  it("issues unguessable, distinct tokens", () => {
    const a = issue(ceremony);
    const b = issue(ceremony);
    expect(a).not.toBe(b);
    expect(a).toHaveLength(64); // 32 random bytes, hex
  });

  it("is single-use — a replayed assertion finds nothing", () => {
    const token = issue(ceremony);
    expect(consume(token, "login")).not.toBeNull();
    expect(consume(token, "login")).toBeNull();
  });

  it("returns null for a token it never issued", () => {
    expect(consume("deadbeef", "login")).toBeNull();
  });

  it("returns null for an absent token without throwing", () => {
    expect(consume(undefined, "login")).toBeNull();
    expect(consume(null, "login")).toBeNull();
    expect(consume("", "login")).toBeNull();
  });
});

describe("purpose binding", () => {
  it("refuses a registration token at the login endpoint", () => {
    const token = issue({ ...ceremony, purpose: "register", userId: "user-1" });
    expect(consume(token, "login")).toBeNull();
  });

  it("refuses a login token at the second-factor endpoint", () => {
    const token = issue(ceremony);
    expect(consume(token, "mfa")).toBeNull();
  });

  it("burns the token even on a purpose mismatch, so it cannot be retried at the right one", () => {
    const token = issue({ ...ceremony, purpose: "register", userId: "user-1" });
    expect(consume(token, "login")).toBeNull();
    expect(consume(token, "register")).toBeNull();
  });
});

describe("expiry", () => {
  it("refuses a challenge older than its TTL", () => {
    vi.useFakeTimers();
    const token = issue(ceremony);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(consume(token, "login")).toBeNull();
  });

  it("still accepts one inside the TTL", () => {
    vi.useFakeTimers();
    const token = issue(ceremony);
    vi.advanceTimersByTime(4 * 60 * 1000);
    expect(consume(token, "login")).not.toBeNull();
  });
});

describe("revokeForUser", () => {
  it("drops every ceremony belonging to that user", () => {
    const mine = issue({ ...ceremony, purpose: "register", userId: "user-1" });
    const theirs = issue({ ...ceremony, purpose: "register", userId: "user-2" });
    revokeForUser("user-1");
    expect(consume(mine, "register")).toBeNull();
    expect(consume(theirs, "register")).not.toBeNull();
  });

  it("leaves usernameless login ceremonies alone", () => {
    // They belong to nobody yet — the assertion is what names the account.
    const anonymous = issue(ceremony);
    revokeForUser("user-1");
    expect(consume(anonymous, "login")).not.toBeNull();
  });
});

describe("the cap", () => {
  it("evicts the oldest rather than growing without bound", () => {
    const first = issue(ceremony);
    for (let i = 0; i < 5000; i++) issue(ceremony);
    // The flood cost the earliest caller a retry; it cost the process nothing.
    expect(consume(first, "login")).toBeNull();
  });
});
