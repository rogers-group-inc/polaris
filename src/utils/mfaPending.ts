/**
 * src/utils/mfaPending.ts — Short-lived store for a login that is partly
 * complete: the password was right, but the session is not issued yet.
 *
 * After a correct password, the server issues a single-use opaque token
 * bound to a user ID and a 5-minute TTL. The browser sends it back on the
 * next step; on success it's consumed immediately (replay protection).
 *
 * Two kinds of "next step" use it, distinguished by `purpose`:
 *
 *   "mfa"             a second factor is still owed — a TOTP code, a backup
 *                     code, or a passkey assertion (see `methods`).
 *   "password-change" (business rule 63) every factor passed, but the password just
 *                     typed no longer meets the complexity policy and the
 *                     operator asked for those to be changed at login. The
 *                     token buys exactly one thing: the right to set a new
 *                     password and receive the session that was withheld.
 *
 * The purpose is checked on consume rather than kept in a second map, so that
 * ONE `revokeForUser` (called by the admin password reset) invalidates every
 * half-finished login for that account, whichever step it is sitting at.
 *
 * A "password-change" token is ONLY ever minted after all factors are
 * satisfied. Minting it at the password step would let someone holding a
 * stolen password set a new one without ever facing the second factor — the
 * MFA bypass this ordering exists to prevent.
 *
 * Storage is process-local — a restart drops all pending logins, forcing users
 * to redo their password. Acceptable for single-instance deployment; swap for
 * Redis if Polaris ever goes multi-replica.
 */

import { randomBytes } from "node:crypto";

export type PendingPurpose = "mfa" | "password-change";

/** Which second factors this account can actually finish the login with. */
export interface PendingMethods {
  totp: boolean;
  passkey: boolean;
}

interface Entry {
  userId: string;
  username: string;
  purpose: PendingPurpose;
  methods: PendingMethods;
  /**
   * Carried from the password step to the far side of the second factor: the
   * password that was just accepted fails the current policy, so the session
   * must not be issued until it is replaced.
   */
  mustChangePassword: boolean;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const store = new Map<string, Entry>();

/** Create a pending token for the given user. Call after password verify succeeds. */
export function issue(
  userId: string,
  username: string,
  opts?: { purpose?: PendingPurpose; methods?: Partial<PendingMethods>; mustChangePassword?: boolean },
): string {
  const token = randomBytes(32).toString("hex");
  store.set(token, {
    userId,
    username,
    purpose: opts?.purpose ?? "mfa",
    methods: { totp: opts?.methods?.totp ?? true, passkey: opts?.methods?.passkey ?? false },
    mustChangePassword: opts?.mustChangePassword ?? false,
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

/**
 * Look up but do not consume the token. Used to get the username for audit
 * logs when the TOTP code is wrong (so we don't leak "that token's for Alice"
 * by accepting bad codes silently).
 *
 * `purpose` defaults to "mfa": every pre-existing caller is the TOTP step, and
 * a password-change token must not answer there.
 */
export function peek(token: string | undefined | null, purpose: PendingPurpose = "mfa"): Entry | null {
  if (!token) return null;
  const entry = store.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(token);
    return null;
  }
  if (entry.purpose !== purpose) return null;
  return entry;
}

/** Consume the token (single-use) and return its payload, or null if missing/expired. */
export function consume(token: string | undefined | null, purpose: PendingPurpose = "mfa"): Entry | null {
  const entry = peek(token, purpose);
  if (entry) store.delete(token as string);
  return entry;
}

/** Drop any pending login for a given user — e.g. on password reset. */
export function revokeForUser(userId: string): void {
  for (const [token, entry] of store.entries()) {
    if (entry.userId === userId) store.delete(token);
  }
}

// Periodic cleanup so expired entries don't accumulate
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(token);
  }
}, 60 * 1000).unref();
