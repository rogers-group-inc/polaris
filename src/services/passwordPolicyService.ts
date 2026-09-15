/**
 * src/services/passwordPolicyService.ts — business rule 63
 *
 * The DB side of the password complexity policy (Users → Authentication →
 * Settings). Single Setting row (`passwordPolicyConfig`), JSON blob,
 * TTL-cached via settingsStore — the loginAccessService / dashSettingsService
 * pattern. The rules themselves are pure and live in utils/passwordPolicy.ts.
 *
 * FAILS TO THE DEFAULT, NEVER TO "NO POLICY". Every read that throws (DB blip,
 * hand-mangled row) resolves to `defaultPasswordPolicy()` — the five rules this
 * product shipped with — because the alternative reading of a failed read is
 * "accept any password", and a settings outage must not quietly lower the bar
 * on account creation. This is the opposite posture to loginAccessService's
 * fail-OPEN, and for the same reason: there, failing safe means letting people
 * IN (a lockout is the hazard); here, failing safe means keeping the bar UP.
 *
 * Call sites of assertPasswordMeetsPolicy() — every route that stores a new
 * password: users.ts (admin create, admin reset), auth.ts (self-service change,
 * forced change at login) and setup/setupRoutes.ts (the first admin).
 */

import { createSettingStore } from "./settingsStore.js";
import { AppError } from "../utils/errors.js";
import {
  clampMinLength,
  defaultPasswordPolicy,
  parsePasswordPolicy,
  passwordPolicyError,
  type PasswordPolicy,
} from "../utils/passwordPolicy.js";

export const PASSWORD_POLICY_SETTING_KEY = "passwordPolicyConfig";

const passwordPolicyStore = createSettingStore<PasswordPolicy>({
  key: PASSWORD_POLICY_SETTING_KEY,
  ttlMs: 10_000,
  parse: parsePasswordPolicy,
});

export function invalidatePasswordPolicyCache(): void {
  passwordPolicyStore.invalidate();
}

/** The active policy. Never throws — a failed read resolves to the defaults. */
export async function getPasswordPolicy(): Promise<PasswordPolicy> {
  try {
    return await passwordPolicyStore.get();
  } catch {
    return defaultPasswordPolicy();
  }
}

export async function savePasswordPolicy(input: Partial<PasswordPolicy>): Promise<PasswordPolicy> {
  const current = await getPasswordPolicy();
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

  const next: PasswordPolicy = {
    minLength: input.minLength === undefined ? current.minLength : clampMinLength(input.minLength, current.minLength),
    requireLowercase: bool(input.requireLowercase, current.requireLowercase),
    requireUppercase: bool(input.requireUppercase, current.requireUppercase),
    requireNumber: bool(input.requireNumber, current.requireNumber),
    requireSpecial: bool(input.requireSpecial, current.requireSpecial),
    forceChangeOnLogin: bool(input.forceChangeOnLogin, current.forceChangeOnLogin),
  };

  return passwordPolicyStore.save(next);
}

/**
 * Throw a 400 AppError naming every unmet rule, or return cleanly.
 *
 * The route-level Zod schemas only assert "a non-empty string" now; this is
 * the enforcement, and it is deliberately one call rather than a generated
 * schema so that the same function serves the login-time re-check, where there
 * is no request body to parse.
 */
export async function assertPasswordMeetsPolicy(plaintext: string): Promise<void> {
  const policy = await getPasswordPolicy();
  const message = passwordPolicyError(plaintext, policy);
  if (message) throw new AppError(400, message);
}

/**
 * Does this plaintext still satisfy the policy? Used at local login, where the
 * answer decides whether the session is issued or a forced change is demanded.
 * Never throws: a policy read that failed already resolved to the defaults, and
 * a login must not 500 because a Setting row is unreadable.
 */
export async function passwordNeedsPolicyChange(plaintext: string): Promise<boolean> {
  const policy = await getPasswordPolicy();
  if (!policy.forceChangeOnLogin) return false;
  return passwordPolicyError(plaintext, policy) !== null;
}
