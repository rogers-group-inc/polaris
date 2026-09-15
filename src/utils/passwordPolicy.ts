/**
 * src/utils/passwordPolicy.ts — the operator-configurable password complexity
 * policy, as pure data + pure evaluation.
 *
 * Before this file the bar was five hard-coded Zod refinements in
 * `utils/password.ts` (min 8 + four character classes). Those five rules are
 * still the DEFAULT — an install that never opens Users → Authentication →
 * Settings gets exactly the behaviour it had — but they are now values an
 * admin can raise (or relax, down to a floor) rather than constants.
 *
 * Pure on purpose: the DB-backed store lives in
 * `services/passwordPolicyService.ts`, and this module is what the store, the
 * routes, the login-time re-check and the unit tests all agree on. Keeping the
 * evaluation here is also what lets the setup wizard — which runs before there
 * is a Setting row to read — validate against the defaults with the same code.
 *
 * FLOORS ARE NOT NEGOTIABLE. `minLength` clamps to [8, 128]: NIST SP 800-63B
 * puts the memorized-secret minimum at 8, and a UI that let an operator type 1
 * would be a footgun that outlives the operator who pulled it. Character
 * classes are free to toggle — NIST actually discourages mandatory composition
 * rules, so an install that wants length alone is a legitimate posture, not a
 * misconfiguration.
 */

export interface PasswordPolicy {
  /** Minimum character count. Clamped to [8, 128]; default 8. */
  minLength: number;
  requireLowercase: boolean;
  requireUppercase: boolean;
  requireNumber: boolean;
  requireSpecial: boolean;
  /**
   * When true, a LOCAL login whose plaintext password fails the policy is not
   * issued a session — it is handed a one-time token and must set a
   * conforming password first (see the forced-change step in auth.ts).
   *
   * Evaluated against the plaintext the user just typed, which is the only
   * moment Polaris can know whether a stored hash satisfies the rules: a hash
   * is one-way, so the alternative (a "changed before the policy" timestamp)
   * would force a change on users whose password already complies. Default
   * false — an upgrade must never start refusing logins on its own.
   */
  forceChangeOnLogin: boolean;
}

export const PASSWORD_MIN_LENGTH_FLOOR = 8;
export const PASSWORD_MIN_LENGTH_CEILING = 128;

export function defaultPasswordPolicy(): PasswordPolicy {
  return {
    minLength: PASSWORD_MIN_LENGTH_FLOOR,
    requireLowercase: true,
    requireUppercase: true,
    requireNumber: true,
    requireSpecial: true,
    forceChangeOnLogin: false,
  };
}

/** One rule of the policy, in the order the checklist renders them. */
export interface PasswordRule {
  key: "length" | "lower" | "upper" | "number" | "special";
  /** Operator/end-user facing label — the client checklist renders this verbatim. */
  label: string;
  /** The message a violation produces server-side. */
  message: string;
  test: (password: string) => boolean;
}

/**
 * The active rules for a policy, omitting the classes it does not require.
 * The client fetches the same list (GET /auth/password-policy) rather than
 * carrying its own copy of the regexes — the drift that
 * `public/js/password-self.js` documents was five constants in two languages.
 */
export function passwordRules(policy: PasswordPolicy): PasswordRule[] {
  const rules: PasswordRule[] = [
    {
      key: "length",
      label: `At least ${policy.minLength} characters`,
      message: `Password must be at least ${policy.minLength} characters`,
      test: (p) => p.length >= policy.minLength,
    },
  ];
  if (policy.requireLowercase) {
    rules.push({
      key: "lower",
      label: "Lowercase letter",
      message: "Password must contain a lowercase letter",
      test: (p) => /[a-z]/.test(p),
    });
  }
  if (policy.requireUppercase) {
    rules.push({
      key: "upper",
      label: "Uppercase letter",
      message: "Password must contain an uppercase letter",
      test: (p) => /[A-Z]/.test(p),
    });
  }
  if (policy.requireNumber) {
    rules.push({
      key: "number",
      label: "Number",
      message: "Password must contain a number",
      test: (p) => /[0-9]/.test(p),
    });
  }
  if (policy.requireSpecial) {
    rules.push({
      key: "special",
      label: "Special character",
      message: "Password must contain a special character",
      test: (p) => /[^a-zA-Z0-9]/.test(p),
    });
  }
  return rules;
}

/** Every rule the password fails, in checklist order. Empty = conforming. */
export function evaluatePassword(password: string, policy: PasswordPolicy): PasswordRule[] {
  return passwordRules(policy).filter((r) => !r.test(password));
}

/** True when the password satisfies every active rule. */
export function passwordMeetsPolicy(password: string, policy: PasswordPolicy): boolean {
  return evaluatePassword(password, policy).length === 0;
}

/**
 * The 400 message for a rejected password: every unmet rule, not just the
 * first. A user retrying one rule at a time against an 8-character minimum
 * they also do not meet is the experience this avoids.
 */
export function passwordPolicyError(password: string, policy: PasswordPolicy): string | null {
  const failures = evaluatePassword(password, policy);
  if (failures.length === 0) return null;
  if (failures.length === 1) return failures[0].message;
  return `Password does not meet the complexity policy: ${failures.map((f) => f.label.toLowerCase()).join(", ")}`;
}

/** Operator-facing one-liner for audit Event messages. */
export function describePasswordPolicy(policy: PasswordPolicy): string {
  const classes: string[] = [];
  if (policy.requireLowercase) classes.push("lowercase");
  if (policy.requireUppercase) classes.push("uppercase");
  if (policy.requireNumber) classes.push("number");
  if (policy.requireSpecial) classes.push("special");
  const composition = classes.length ? `, requires ${classes.join(" + ")}` : ", no character-class requirements";
  const force = policy.forceChangeOnLogin ? ", existing passwords must be changed at next login" : "";
  return `min ${policy.minLength} characters${composition}${force}`;
}

/**
 * Parse a stored blob into a whole policy. Unknown/invalid fields fall back to
 * the default so a hand-edited Setting row degrades to today's behaviour
 * instead of to "no rules at all".
 */
export function parsePasswordPolicy(raw: unknown): PasswordPolicy {
  const fallback = defaultPasswordPolicy();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;

  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    minLength: clampMinLength(r.minLength, fallback.minLength),
    requireLowercase: bool(r.requireLowercase, fallback.requireLowercase),
    requireUppercase: bool(r.requireUppercase, fallback.requireUppercase),
    requireNumber: bool(r.requireNumber, fallback.requireNumber),
    requireSpecial: bool(r.requireSpecial, fallback.requireSpecial),
    forceChangeOnLogin: bool(r.forceChangeOnLogin, fallback.forceChangeOnLogin),
  };
}

export function clampMinLength(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(PASSWORD_MIN_LENGTH_CEILING, Math.max(PASSWORD_MIN_LENGTH_FLOOR, Math.trunc(n)));
}
