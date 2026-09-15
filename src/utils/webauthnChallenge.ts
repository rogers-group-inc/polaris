/**
 * src/utils/webauthnChallenge.ts — short-lived store for an in-flight WebAuthn
 * ceremony (the challenge the server issued, and what it was issued FOR).
 *
 * Same shape and the same trade-off as utils/mfaPending.ts: an opaque
 * single-use token, a 5-minute TTL, process-local storage. A restart drops
 * in-flight ceremonies, which costs a user one extra click on the passkey
 * button; make this Redis-backed if Polaris ever runs multi-replica.
 *
 * WHY THE CHALLENGE IS NOT IN THE SESSION. A passkey login begins with no
 * session at all — that is the point of it — and the session store is a
 * database table, so putting a pre-auth ceremony there would let an
 * unauthenticated caller create rows by hammering the options endpoint.
 * A capped in-memory map with a TTL cannot be grown into a disk problem.
 *
 * The RP ID and origin travel WITH the entry rather than being re-derived at
 * verify time. Both come from the request's Host header, so re-deriving would
 * verify an assertion against whatever the SECOND request claimed to be — a
 * mismatch that should be an error becomes a silent success. Storing them
 * makes the ceremony self-consistent by construction.
 */

import { randomBytes } from "node:crypto";

export type CeremonyPurpose = "register" | "login" | "mfa";

interface Entry {
  purpose: CeremonyPurpose;
  challenge: string;
  /** Who the ceremony is for. Null for a usernameless (discoverable) login. */
  userId: string | null;
  rpId: string;
  origin: string;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
/**
 * Hard cap on concurrent ceremonies. The login options endpoint is reachable
 * unauthenticated (behind a rate limit), so the map needs a ceiling that does
 * not depend on the limiter being configured. At the cap the OLDEST entry is
 * dropped: a flood costs legitimate users an expired challenge and a retry,
 * never memory.
 */
const MAX_ENTRIES = 5000;

const store = new Map<string, Entry>();

export function issue(entry: Omit<Entry, "expiresAt">): string {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  const token = randomBytes(32).toString("hex");
  store.set(token, { ...entry, expiresAt: Date.now() + TTL_MS });
  return token;
}

/**
 * Consume the token (single-use) if it exists, has not expired, and was issued
 * for this purpose. A purpose mismatch returns null rather than the entry: the
 * registration and login ceremonies differ in what they authorize, and a token
 * minted by one must never be spendable at the other's endpoint.
 */
export function consume(token: string | undefined | null, purpose: CeremonyPurpose): Entry | null {
  if (!token) return null;
  const entry = store.get(token);
  if (!entry) return null;
  store.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  if (entry.purpose !== purpose) return null;
  return entry;
}

/** Drop every in-flight ceremony for a user — e.g. when their passkeys are revoked. */
export function revokeForUser(userId: string): void {
  for (const [token, entry] of store.entries()) {
    if (entry.userId === userId) store.delete(token);
  }
}

/** Test seam — the suite needs a clean map between cases. */
export function _reset(): void {
  store.clear();
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(token);
  }
}, 60 * 1000).unref();
