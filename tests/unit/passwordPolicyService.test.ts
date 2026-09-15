/**
 * tests/unit/passwordPolicyService.test.ts
 *
 * `passwordPolicyConfig` persistence plus the assertion every password-writing
 * route makes. Prisma is mocked.
 *
 * The load-bearing case is the failure posture, and it is the OPPOSITE of
 * loginAccessService's: there, a settings read that throws must fail OPEN,
 * because a DB blip turning into "nobody can log in" is the hazard. Here a
 * read that throws must fall back to the DEFAULT rules, because the hazard is
 * an install quietly accepting "a" as a password while its Setting row is
 * unreadable. Both are "fail safe"; safe means different things.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import {
  getPasswordPolicy,
  savePasswordPolicy,
  invalidatePasswordPolicyCache,
  assertPasswordMeetsPolicy,
  passwordNeedsPolicyChange,
  PASSWORD_POLICY_SETTING_KEY,
} from "../../src/services/passwordPolicyService.js";
import { defaultPasswordPolicy } from "../../src/utils/passwordPolicy.js";
import { prisma } from "../../src/db.js";
import { AppError } from "../../src/utils/errors.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.setting.findUnique as unknown as Mock;
const upsert = prisma.setting.upsert as unknown as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  invalidatePasswordPolicyCache();
});

describe("getPasswordPolicy", () => {
  it("returns the defaults when no row exists — a fresh install is gated as before", async () => {
    findUnique.mockResolvedValue(null);
    await expect(getPasswordPolicy()).resolves.toEqual(defaultPasswordPolicy());
  });

  it("reads the row it is given", async () => {
    findUnique.mockResolvedValue({ value: { minLength: 16, requireSpecial: false } });
    const policy = await getPasswordPolicy();
    expect(policy.minLength).toBe(16);
    expect(policy.requireSpecial).toBe(false);
    // Everything unspecified still comes from the defaults.
    expect(policy.requireUppercase).toBe(true);
  });

  it("falls back to the DEFAULTS when the read throws, never to 'no policy'", async () => {
    findUnique.mockRejectedValue(new Error("connection terminated"));
    await expect(getPasswordPolicy()).resolves.toEqual(defaultPasswordPolicy());
  });

  it("reads the row under the documented key", async () => {
    findUnique.mockResolvedValue(null);
    await getPasswordPolicy();
    expect(findUnique).toHaveBeenCalledWith({ where: { key: PASSWORD_POLICY_SETTING_KEY } });
  });

  it("caches, so a login does not re-read the row on every password check", async () => {
    findUnique.mockResolvedValue({ value: { minLength: 12 } });
    await getPasswordPolicy();
    await getPasswordPolicy();
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});

describe("savePasswordPolicy", () => {
  beforeEach(() => {
    findUnique.mockResolvedValue(null);
    upsert.mockImplementation(async ({ create }: { create: { value: unknown } }) => ({ value: create.value }));
  });

  it("merges a partial update onto the current policy", async () => {
    const saved = await savePasswordPolicy({ minLength: 14 });
    expect(saved).toEqual({ ...defaultPasswordPolicy(), minLength: 14 });
  });

  it("clamps a minimum length below the floor rather than storing it", async () => {
    expect((await savePasswordPolicy({ minLength: 3 })).minLength).toBe(8);
  });

  it("stores a policy with no character-class requirements", async () => {
    // Length-only is a legitimate posture (NIST discourages mandatory
    // composition rules), so this must survive the save rather than be
    // "corrected" back to the defaults.
    const saved = await savePasswordPolicy({
      requireLowercase: false,
      requireUppercase: false,
      requireNumber: false,
      requireSpecial: false,
    });
    expect(saved.requireLowercase).toBe(false);
    expect(saved.requireSpecial).toBe(false);
  });

  it("stores the forced-change choice", async () => {
    expect((await savePasswordPolicy({ forceChangeOnLogin: true })).forceChangeOnLogin).toBe(true);
  });

  it("primes the cache with what it wrote", async () => {
    await savePasswordPolicy({ minLength: 20 });
    findUnique.mockClear();
    expect((await getPasswordPolicy()).minLength).toBe(20);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("assertPasswordMeetsPolicy", () => {
  it("accepts a conforming password under the defaults", async () => {
    findUnique.mockResolvedValue(null);
    await expect(assertPasswordMeetsPolicy("Replacement-2!")).resolves.toBeUndefined();
  });

  it("throws a 400 naming the unmet rule", async () => {
    findUnique.mockResolvedValue(null);
    await expect(assertPasswordMeetsPolicy("nospecialchar1")).rejects.toThrow(AppError);
    await expect(assertPasswordMeetsPolicy("nospecialchar1")).rejects.toThrow(/uppercase|special/);
  });

  it("enforces a RAISED bar", async () => {
    findUnique.mockResolvedValue({ value: { minLength: 20 } });
    await expect(assertPasswordMeetsPolicy("Replacement-2!")).rejects.toThrow(/20 characters/);
  });

  it("enforces a RELAXED bar — what the operator configured, not what shipped", async () => {
    findUnique.mockResolvedValue({
      value: { requireUppercase: false, requireNumber: false, requireSpecial: false },
    });
    await expect(assertPasswordMeetsPolicy("correcthorse")).resolves.toBeUndefined();
  });
});

describe("passwordNeedsPolicyChange", () => {
  it("is false while the operator has not asked for existing passwords to change", async () => {
    findUnique.mockResolvedValue({ value: { minLength: 20, forceChangeOnLogin: false } });
    // The password fails the policy, but nobody asked for it to be replaced.
    await expect(passwordNeedsPolicyChange("short1!A")).resolves.toBe(false);
  });

  it("is true for a non-conforming password once the operator has", async () => {
    findUnique.mockResolvedValue({ value: { minLength: 20, forceChangeOnLogin: true } });
    // 14 characters against a 20-character minimum.
    await expect(passwordNeedsPolicyChange("Replacement-2!")).resolves.toBe(true);
  });

  it("is false for a conforming password even with the forced change on", async () => {
    // The check is against the PLAINTEXT the user just typed — the only moment
    // a stored hash can be judged — so a compliant user is never interrupted.
    findUnique.mockResolvedValue({ value: { forceChangeOnLogin: true } });
    await expect(passwordNeedsPolicyChange("Replacement-2!")).resolves.toBe(false);
  });

  it("does not throw when the policy cannot be read — a login must not 500", async () => {
    findUnique.mockRejectedValue(new Error("connection terminated"));
    await expect(passwordNeedsPolicyChange("anything")).resolves.toBe(false);
  });
});
