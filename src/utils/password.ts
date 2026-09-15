/**
 * src/utils/password.ts — Password hashing + verification helpers
 *
 * Call sites:
 *   - hashPassword() — every place a new/updated password is stored
 *   - verifyPassword() — every place a stored password is checked
 *   - passwordPolicySchema — every route that accepts a NEW password
 */

import { hash as argonHash, verify as argonVerify, Algorithm } from "@node-rs/argon2";
import { z } from "zod";

// OWASP 2024 second-option params — ~50ms/login on commodity hardware, good
// GPU resistance via 19 MiB of memory per hash. Bump memoryCost to 65536 and
// timeCost to 3 for stronger settings if latency budget allows.
const ARGON2_PARAMS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // KiB (19 MiB)
  timeCost: 2,
  parallelism: 1,
} as const;

// Pre-computed dummy, generated once at module load. Used by verifyPassword()
// when the caller passes `stored = null` (user-not-found case) so response
// time matches the valid-user-wrong-password path — prevents username
// enumeration via timing analysis on the login endpoint.
const DUMMY_HASH: Promise<string> = argonHash("__polaris_timing_dummy__", ARGON2_PARAMS);

/**
 * The house password-complexity policy, as a Zod schema.
 *
 * It lives here rather than beside a route because three surfaces enforce the
 * same bar and carried three verbatim copies of it: `api/routes/users.ts`
 * (admin create + admin reset), `setup/setupRoutes.ts` (the first admin the
 * wizard mints) and `api/routes/auth.ts` (a user changing their own). A fourth
 * copy is how the rules drift apart. The client-side checklist in
 * `public/js/password-self.js` mirrors these five rules and says so — it is a
 * courtesy, and this schema is the enforcement.
 */
export const passwordPolicySchema = z.string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number")
  .regex(/[^a-zA-Z0-9]/, "Password must contain a special character");

/** Produce a new argon2id hash for a plaintext password. */
export async function hashPassword(plaintext: string): Promise<string> {
  return argonHash(plaintext, ARGON2_PARAMS);
}

/**
 * Verify a plaintext password against a stored argon2id hash.
 *
 * Pass `stored = null` when the user lookup missed — we still burn the CPU
 * time of a real verify to keep the endpoint's response time constant.
 *
 * `needsRehash` is true when the stored argon2id hash uses weaker params
 * than the current target (e.g. after a params upgrade).
 */
export async function verifyPassword(
  plaintext: string,
  stored: string | null,
): Promise<{ valid: boolean; needsRehash: boolean }> {
  if (!stored) {
    // Burn equivalent CPU on a known-bad compare so timing stays constant
    await argonVerify(await DUMMY_HASH, plaintext).catch(() => false);
    return { valid: false, needsRehash: false };
  }

  if (stored.startsWith("$argon2")) {
    const valid = await argonVerify(stored, plaintext).catch(() => false);
    const needsRehash = valid && argonParamsWeakerThanTarget(stored);
    return { valid, needsRehash };
  }

  // Unknown format — fail closed
  return { valid: false, needsRehash: false };
}

// Parse the PHC-format argon2 string and return true when any stored parameter
// is weaker than our current target, so the caller can trigger a rehash.
// Format: $argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>
function argonParamsWeakerThanTarget(stored: string): boolean {
  const match = stored.match(/\$m=(\d+),t=(\d+),p=(\d+)\$/);
  if (!match) return true; // unparseable — force rehash to be safe
  const [, m, t, p] = match;
  return (
    Number(m) < ARGON2_PARAMS.memoryCost ||
    Number(t) < ARGON2_PARAMS.timeCost ||
    Number(p) < ARGON2_PARAMS.parallelism
  );
}
