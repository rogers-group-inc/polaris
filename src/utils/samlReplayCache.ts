/**
 * src/utils/samlReplayCache.ts — a SAML assertion is accepted once.
 *
 * Polaris builds its SAML client with request binding off for unsolicited
 * (IdP-initiated) responses, which Azure "My Apps" launches use, so nothing tied
 * a response to a request and nothing stopped one signed response being
 * presented twice (scan finding F242; business rule 108). Request binding is now
 * on whenever the response carries an InResponseTo; this cache is the other half:
 * it remembers the ID of every assertion that has signed someone in and refuses a
 * repeat, which closes replay of a captured response for as long as it is
 * remembered.
 *
 * Process-local, like the login lockout: the web role is a single process, and a
 * restart or a failover empties it. A response older than the window is rejected
 * by the assertion's own NotOnOrAfter anyway; the window only needs to outlast
 * that. Bounded, oldest evicted.
 */

const seen = new Map<string, number>(); // assertion id -> expires (epoch ms)

export const SAML_REPLAY_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 5000;

function prune(now: number): void {
  for (const [id, exp] of seen) {
    if (exp <= now) seen.delete(id);
  }
  // Still over the cap (a burst of distinct logins): drop the oldest first. Map
  // iteration is insertion order, which is also expiry order here.
  while (seen.size > MAX_ENTRIES) {
    const first = seen.keys().next();
    if (first.done) break;
    seen.delete(first.value);
  }
}

/**
 * Record `id` as used. True the first time; false when it has been seen within
 * the window (a replay). An empty id cannot be tracked and is refused — a
 * signed assertion with no ID is not one this cache can protect.
 */
export function claimSamlAssertion(id: string | undefined | null, now: number = Date.now()): boolean {
  if (!id) return false;
  prune(now);
  if (seen.has(id)) return false;
  seen.set(id, now + SAML_REPLAY_TTL_MS);
  return true;
}

/** Test hook. */
export function clearSamlReplayCache(): void {
  seen.clear();
}
