/**
 * src/api/middleware/rateLimits.ts — shared per-route rate limiters.
 *
 * The login limiter in app.ts predates this file and stays there. These
 * factories cover the remaining surfaces CodeQL flagged as missing rate
 * limiting (2026-06-11 alert sweep): unauthenticated setup-wizard routes,
 * auth-sensitive TOTP code submission, admin maintenance/backup routes, and
 * the agent-facing routers.
 *
 * Ceilings are deliberately generous for machine-facing endpoints — at 2000
 * monitored assets every agent and SIEM caller hits the web role from its own
 * source IP, so per-IP limits only need to bound a single misbehaving (or
 * hostile) client, not the fleet aggregate. express-rate-limit's default
 * in-memory store is per-process, which is fine: the web role is a single
 * replica (see L2 in docs/security/review-2026-06-03.md).
 */

import rateLimit from "express-rate-limit";

export function makeRateLimiter(opts: { windowMs: number; max: number; message: string }) {
  return rateLimit({
    windowMs: opts.windowMs,
    max: opts.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: opts.message },
  });
}

/**
 * WebAuthn ceremonies (passkey login, the passkey second-factor step, and
 * registration). An assertion cannot be guessed, so this is not a
 * code-grinding ceiling like the TOTP one — it bounds the cheap half of the
 * exchange: `/passkeys/login/options` is reachable with no session at all and
 * mints an in-memory challenge on every call. Roomier than the login limiter
 * because one sign-in is two requests and a user who cancels the browser's
 * credential dialog legitimately starts over.
 */
export const passkeyCeremonyLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: "Too many passkey attempts. Please try again in 15 minutes.",
});

/** Auth-code guessing surfaces (TOTP confirm/disable): mirror the login limiter. */
export const totpCodeLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many code attempts. Please try again in 15 minutes.",
});

/**
 * Self-service password change. The body carries the caller's CURRENT
 * password, so an attacker sitting on a hijacked session can grind for it
 * here without ever touching the login limiter — this is the login surface
 * again, just behind a cookie, and it gets the login ceiling.
 */
export const passwordChangeLimiter = makeRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many password change attempts. Please try again in 15 minutes.",
});

/**
 * Unauthenticated SSO entry redirects — the OIDC and SAML login kick-offs
 * (`GET /oidc/login`, `GET /azure/login`). Nothing is guessed here: the
 * request carries no credential and the response is a redirect to the IdP, so
 * this bounds flood volume rather than attempts. Deliberately NOT the login
 * limiter, and deliberately not its store: SSO must keep working from
 * anywhere even when the password surface is exhausted or IP-restricted
 * (rule 25's "SSO is never gated"), and sharing a budget with the password
 * form breaks that in both directions.
 *
 * The ceiling is sized against `ssoCallbackLimiter`, not against the login
 * limiter, because **one sign-in is exactly one entry followed by one
 * callback** from the same address. Anything tighter here than the callback
 * allows makes the callback's ceiling unreachable — this is the request that
 * gates it. It was 30 / 15 min until 2026-09-16, i.e. ten per five minutes
 * against the callback's three hundred, so a site could never produce more
 * than ten sign-ins per five minutes however roomy the callback was. Same
 * per-IP NAT reasoning as the callback: a whole office arrives at one egress
 * address at shift start, and 120 / 5 min clears a burst of that size while
 * still sitting well below the callback and bounding a runaway client.
 */
export const ssoEntryLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: "Too many sign-in attempts — please try again shortly.",
});

/**
 * IdP-driven SSO callbacks (SAML POST /azure/callback, OIDC GET
 * /oidc/callback) and the public /entra-proxy/config probe the login page
 * reads. These provision sessions, so they must be bounded — but the ceiling
 * is deliberately far above `ssoEntryLimiter`'s: a callback carries a
 * signature-validated assertion rather than a guessable credential, so the
 * limiter bounds replay/flood volume, not guessing. It is per-IP, and an
 * office behind one NAT egress address can land its whole staff here inside a
 * few minutes at shift start — a login-limiter-sized ceiling would lock that
 * site out of SSO entirely, which is a worse outcome than the flood.
 */
export const ssoCallbackLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 300,
  message: "Too many sign-in attempts — please try again shortly.",
});

/**
 * Entra App Proxy header login. ALL App Proxy users arrive from the shared
 * connector IP(s), so the strict per-IP login limiter (10/15min) would lock
 * out the whole external population behind one address. There is no
 * guessable-credential surface here — requests either carry trusted headers
 * or are refused — so a generous ceiling only needs to bound a runaway loop.
 */
export const entraProxyLoginLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: "Too many login attempts — retry shortly.",
});

/** Admin maintenance surfaces (backup/restore/logo) — human-driven, low cadence. */
export const maintenanceLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 120,
  message: "Too many maintenance requests — slow down and retry shortly.",
});

/** Machine-facing API surfaces (SIEM quarantine verify): generous burst headroom. */
export const machineApiLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 300,
  message: "Rate limit exceeded — retry shortly.",
});

/**
 * Polaris Agent bearer router. An agent posts samples/heartbeats every few
 * seconds at most; 4 req/s sustained per source IP is far above any healthy
 * agent and still bounds a runaway one.
 */
export const agentApiLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 1200,
  message: "Rate limit exceeded — retry shortly.",
});

/** Agent binary downloads — one per agent per upgrade; bounds scraping. */
export const agentBinaryLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 60,
  message: "Rate limit exceeded — retry shortly.",
});

/**
 * Dash wallboard weather proxy. One radar refresh is ~14 frames × the
 * viewport's tiles — several hundred small GETs in a burst, repeated every
 * 30 minutes (plus pan/zoom) — so the wallboard's general 600/5min budget
 * would be eaten by a single load. Generous but still bounds a runaway
 * client; the main app mounts /weather without a limiter (session-gated).
 */
export const dashWeatherLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 4000,
  message: "Rate limit exceeded — retry shortly.",
});

/**
 * Address-book recipient search. Session-gated and cheap while it stays local,
 * but with directory search on it PROXIES AN EXTERNAL API (Microsoft Graph / a
 * domain controller) from operator keystrokes, so a stuck key or a scripted
 * caller could hammer the tenant. The client debounces ~250 ms with a 2-char
 * minimum and the service caches identical queries for 60s, so a real operator
 * lands nowhere near this ceiling.
 */
export const contactSearchLimiter = makeRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 600,
  message: "Too many recipient searches — please slow down.",
});
