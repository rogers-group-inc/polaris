/**
 * src/utils/loginLockout.ts — Per-username login failure counter & lockout
 *
 * Complements the per-IP rate limiter on /auth/login. The IP limiter stops
 * concentrated attacks from a single source; this module caps the total
 * number of failed attempts against a single account name (across all IPs),
 * which matters because distributed botnets trivially bypass IP throttling.
 *
 * Storage is process-local — a restart clears all lockouts. That is fine for
 * a single-instance deployment. If Polaris ever runs multi-replica, swap the
 * Map for a Redis-backed implementation with the same interface.
 */

interface Entry {
  failures: number;
  lockedUntil: number;   // epoch ms; 0 = not locked
  firstFailureAt: number;
}

const MAX_FAILURES = 5;
const LOCKOUT_MS   = 15 * 60 * 1000; // 15 min lockout once threshold is hit
const WINDOW_MS    = 15 * 60 * 1000; // failures older than this reset the counter

const store = new Map<string, Entry>();

function key(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * How much longer the lockout has to run, as an operator-facing phrase
 * ("12 minutes", "1 minute", "less than a minute").
 *
 * A DURATION rather than a wall-clock time on purpose. The lockout message is
 * produced before the caller has authenticated, so there is no account whose
 * timezone we could render in — and looking one up by the submitted username
 * would turn this message into an account-existence oracle. The previous form
 * interpolated a bare server-local `toLocaleTimeString()` with no zone name at
 * all, which on a UTC-clocked host told a Central operator to come back five
 * hours after they actually could.
 *
 * Rounds UP, so the phrase never invites a retry that is still locked.
 */
export function lockoutRemaining(until: Date | undefined, now: Date = new Date()): string {
  if (!until) return "later";
  const ms = until.getTime() - now.getTime();
  if (ms <= 0) return "now";
  const mins = Math.ceil(ms / 60_000);
  if (mins < 1) return "less than a minute";
  return mins === 1 ? "1 minute" : `${mins} minutes`;
}

export function isLocked(username: string): { locked: boolean; until?: Date } {
  const entry = store.get(key(username));
  if (!entry) return { locked: false };
  if (entry.lockedUntil > Date.now()) {
    return { locked: true, until: new Date(entry.lockedUntil) };
  }
  return { locked: false };
}

/**
 * Record a failed login attempt. Returns whether this attempt tipped the
 * account into the locked state, plus the new unlock time.
 */
export function recordFailure(username: string): { lockedNow: boolean; failures: number; until?: Date } {
  const k = key(username);
  const now = Date.now();
  let entry = store.get(k);

  // Fresh window if this is the first failure or the last one is stale
  if (!entry || now - entry.firstFailureAt > WINDOW_MS) {
    entry = { failures: 0, lockedUntil: 0, firstFailureAt: now };
  }

  entry.failures += 1;

  if (entry.failures >= MAX_FAILURES) {
    entry.lockedUntil = now + LOCKOUT_MS;
    store.set(k, entry);
    return { lockedNow: true, failures: entry.failures, until: new Date(entry.lockedUntil) };
  }

  store.set(k, entry);
  return { lockedNow: false, failures: entry.failures };
}

/** Clear the counter + any active lockout. Call on successful login and on admin password reset. */
export function clearLockout(username: string): void {
  store.delete(key(username));
}

// Periodic cleanup keeps memory bounded in pathological scenarios (attacker
// cycling through thousands of usernames). Runs every 10 min, drops entries
// whose lockout has expired and whose failure window is also stale.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store.entries()) {
    if (v.lockedUntil <= now && now - v.firstFailureAt > WINDOW_MS) {
      store.delete(k);
    }
  }
}, 10 * 60 * 1000).unref();
