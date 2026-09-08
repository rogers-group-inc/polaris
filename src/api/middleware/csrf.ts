/**
 * src/api/middleware/csrf.ts — Synchronizer-token CSRF protection
 *
 * Pattern: a random token is generated per session and stored in the session
 * store (HttpOnly). The same value is exposed in a readable cookie so
 * same-origin JavaScript in our own pages can echo it in an `X-CSRF-Token`
 * header on state-changing requests. A cross-origin attacker can forge a
 * POST to Polaris but has no way to read the token cookie (Same-Origin
 * Policy) and therefore can't put a valid value in the header.
 *
 * This is defense-in-depth on top of `SameSite=Lax` + strict JSON content
 * types, not a replacement for them.
 */

import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { AppError } from "../../utils/errors.js";

const COOKIE_NAME = "polaris_csrf";
const HEADER_NAME = "x-csrf-token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Paths that must bypass the token check. All other mutating requests
// (including /auth/logout, /auth/totp/*, /users/*, uploads, etc.) are
// protected.
const EXEMPT_PATH_PREFIXES = [
  "/api/v1/auth/login",        // pre-session; rate limiter is the defense
  "/api/v1/auth/azure/",       // SAML flow is cross-origin by design; signed assertion + RelayState are the CSRF guarantee
  "/api/setup/",               // first-run wizard runs on a separate server without sessions
  "/api/v1/agents/",           // Polaris Agent endpoints — agents are programmatic clients with NO browser session.
                                //   * /enroll authenticates via a one-shot enrollment token in the request body
                                //   * /samples, /heartbeat, /config authenticate via the per-agent bearer
                                //     in the Authorization header (issued at /enroll time, asset-bound)
                                //   * /binary/<name> is a public GET (whitelist-checked against manifest.json)
                                // None of these have a session to carry a CSRF token in. Same security
                                // model as /auth/login above — token-based auth is the CSRF defense.
  "/api/v1/ha/enroll",         // HA node enrollment — a node being built has no browser session.
                                // It presents a single-use token in the request body, and redeeming
                                // it only registers a request an operator must then APPROVE in the
                                // UI, so the endpoint cannot release anything by itself. Same
                                // token-is-the-defense model as /agents/ above.
                                // NOTE: this prefix covers /ha/enroll only, NOT the operator
                                // surface at /api/v1/ha/* — those are session routes and keep CSRF.
];

export function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  // Always ensure the cookie reflects the current session's token — the
  // browser needs it to be set *before* the first mutating request. We
  // defer generation until there's actually a session to bind it to.
  if (req.session) {
    if (!req.session.csrfToken) {
      req.session.csrfToken = randomBytes(32).toString("hex");
    }
    // Best-effort: if a previous HTTPS deployment left a Secure-flagged
    // cookie of the same name, modern browsers ("Leave Secure Cookies
    // Alone" rule) will refuse to overwrite it from a non-secure origin —
    // and refuse to delete it too. Some browsers (older / Safari) honor
    // an explicit Max-Age=0 with the Secure attribute even from HTTP, so
    // emitting it costs nothing and may auto-heal those cases. Firefox
    // and Chrome ignore it; the cookieless-error branch below is what
    // actually surfaces the fix to the user there.
    if (!req.secure) {
      res.clearCookie(COOKIE_NAME, { path: "/", secure: true, sameSite: "lax" });
    }
    res.cookie(COOKIE_NAME, req.session.csrfToken, {
      httpOnly: false,       // frontend JS must read this
      sameSite: "lax",
      secure: req.secure,
      path: "/",
    });
  }

  if (SAFE_METHODS.has(req.method)) return next();
  if (EXEMPT_PATH_PREFIXES.some((prefix) => req.path.startsWith(prefix))) return next();

  // Requests carrying an `Authorization: Bearer` header are exempt: CSRF is a
  // cookie-borne-credential attack, and a cross-site attacker cannot attach a
  // custom header — form posts can't carry one, and fetch() with one triggers
  // a CORS preflight we never approve. Any request that has the header
  // therefore originated from a non-browser client or our own same-origin JS
  // (which is trusted anyway). Authentication is still fully enforced
  // downstream: attachApiToken + requirePermission for API tokens,
  // requireAgentBearer for agents.
  const authHeader = req.get("authorization") || "";
  if (/^Bearer\s+\S+$/i.test(authHeader)) return next();

  const fromHeader = req.get(HEADER_NAME);
  const fromSession = req.session?.csrfToken;
  if (!fromHeader || !fromSession || fromHeader !== fromSession) {
    // Distinguish the stale-Secure-cookie case from a regular CSRF mismatch.
    // When the request comes in over plain HTTP and the browser sent NO
    // polaris_csrf cookie at all, the most likely cause is a leftover
    // Secure-flagged cookie from a prior HTTPS install on the same origin:
    // the browser still has it, won't send it over HTTP, and won't let the
    // server overwrite it. Tell the operator exactly how to recover.
    const cookieHeader = req.get("cookie") || "";
    const cookieMissing = !cookieHeader.includes(`${COOKIE_NAME}=`);
    if (!req.secure && cookieMissing) {
      return next(new AppError(
        403,
        "CSRF cookie missing — your browser appears to have a stale cookie from a previous HTTPS install of Polaris on this address. Clear cookies for this site (browser site-info menu → Clear cookies and site data) and reload.",
      ));
    }
    return next(new AppError(403, "CSRF token missing or invalid"));
  }
  next();
}
