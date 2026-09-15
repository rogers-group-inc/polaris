/**
 * src/utils/loginRedirect.ts — "send me back where I was going" across a login.
 *
 * An emailed Acknowledge button points at /alert-ack.html?id=… (business rule
 * 25). A reader who isn't signed in gets bounced to the login page, and without
 * this they would sign in and land on the dashboard, with nothing left of the
 * alert they were asked to look at.
 *
 * WHY A COOKIE and not a `?next=` query parameter threaded through every
 * provider: there are five ways into Polaris (local, TOTP second step, SAML,
 * OIDC, Entra App Proxy) and three of them bounce through an identity provider
 * that hands the browser back on a URL Polaris does not control. Worse, the
 * SSO callbacks call `req.session.regenerate()` — a session-stashed target does
 * not survive that, which is the whole point of regenerating. A short-lived
 * cookie survives every one of those hops and needs no per-provider plumbing.
 *
 * It is NOT HttpOnly, because the local-login path reads it from login.js
 * after the fetch succeeds. That is safe by construction: `safeNextPath`
 * reduces whatever is in it to a same-origin PATH, so the worst a forged value
 * can do is land the operator on a different page of their own Polaris. It is
 * never a credential and never carries one.
 *
 * WHY SameSite=None ON HTTPS (2026-09-15). A cookie is only half the answer:
 * `SameSite=Lax` is sent on a cross-site top-level GET but NOT on a cross-site
 * POST, and the SAML assertion comes back as a form POST from the IdP's origin
 * — so on an Azure SSO install this cookie was never present at
 * /azure/callback and every emailed Acknowledge link landed the reader on the
 * dashboard after signing in. `None` is what makes a cookie survive that hop.
 * It is only available with `Secure`, so a plain-HTTP install stays on `Lax`
 * (and relies on the SAML RelayState carrying the path instead — see
 * `generateRelayState` in services/azureAuthService.ts, which covers the case
 * where this cookie is missing for any reason, including a reverse proxy that
 * leaves `req.secure` false). Widening it costs nothing: the value is a
 * same-origin path, not a credential, and nothing is authorized by it.
 */

import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { safeNextPath } from "./safeRedirect.js";

export const LOGIN_NEXT_COOKIE = "polaris_next";

/**
 * Ten minutes. Long enough for an SSO round trip with a password prompt and an
 * MFA push, short enough that a target abandoned mid-login doesn't ambush the
 * operator's NEXT login hours later with a page they no longer expect.
 */
const MAX_AGE_MS = 10 * 60 * 1000;

/** Remember where an unauthenticated request was headed, before bouncing it. */
export function rememberLoginTarget(req: Request, res: Response, target: string): void {
  // ONLY a top-level navigation is somewhere a person is trying to GO. A page
  // fetched as a subresource — `<img src="https://polaris/alert-ack.html?id=…">`
  // on a foreign site — is not, and under the `SameSite=None` below the browser
  // WOULD store the cookie that request provokes (a `Lax` one it would drop),
  // letting a third-party page choose where the operator lands after their next
  // sign-in. safeNextPath bounds that to a same-origin path, so the worst case
  // is a confusing landing rather than a redirect off-origin — but nothing
  // wants it, so it stops here. `Sec-Fetch-Dest` is the browser's own answer to
  // "what is this request for"; absent (a pre-2020 browser, curl) it reads as a
  // navigation, which is exactly the behavior this had before the header
  // existed.
  const dest = req.get("sec-fetch-dest");
  if (dest && dest !== "document") return;
  const path = safeNextPath(target);
  // "/" is where login lands anyway — writing a cookie to say so is pure noise
  // and would keep overwriting a real target set moments earlier.
  if (path === "/") return;
  res.cookie(LOGIN_NEXT_COOKIE, path, {
    httpOnly: false, // login.js reads it — see the header note
    // `None` needs `Secure`, and a browser drops the pair on plain HTTP — so
    // the two flags move together rather than being decided separately.
    sameSite: req.secure ? "none" : "lax",
    secure: req.secure,
    path: "/",
    maxAge: MAX_AGE_MS,
  });
}

/**
 * Read the remembered target WITHOUT consuming it, as a path or null.
 *
 * The SAML login route needs it to fold into the RelayState it sends the IdP,
 * and must leave the cookie in place: that request is only the outbound half
 * of a flow that can fail, and the browser-side flows (login.js) still read
 * the cookie themselves if the operator ends up back on the form.
 */
export function peekLoginTarget(req: Request): string | null {
  const raw = readCookie(req.get("cookie") ?? undefined, LOGIN_NEXT_COOKIE);
  const path = safeNextPath(raw ?? undefined);
  return path === "/" ? null : path;
}

/**
 * Pull one cookie out of a raw Cookie header. Polaris runs no cookie-parser —
 * express-session reads its own — so this does the one lookup it needs rather
 * than adding a dependency and a middleware for a single value. Exported for
 * the tests; the header is attacker-controlled, so the result still goes
 * through safeNextPath.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // A malformed percent-escape is not a path we should be redirecting to.
      return null;
    }
  }
  return null;
}

/**
 * Read and CONSUME the remembered target. Always returns something safe to
 * redirect to, falling back to "/". Clearing is unconditional: a target that
 * failed to be honored must not be honored on the next login instead.
 */
export function takeLoginTarget(req: Request, res: Response): string {
  const raw = readCookie(req.get("cookie") ?? undefined, LOGIN_NEXT_COOKIE);
  res.clearCookie(LOGIN_NEXT_COOKIE, { path: "/" });
  return safeNextPath(raw ?? undefined);
}

/* ─── The SAML carrier ───────────────────────────────────────────────────────
 *
 * RelayState is the only thing that survives a SAML round trip intact, so it
 * carries the same destination the cookie above does — and it lives here, next
 * to the cookie, because the two are one contract: "where does this login
 * land", written twice because no single carrier covers every path.
 *
 * WHY A SECOND CARRIER AT ALL. The assertion comes back as a form POST from
 * the IdP's origin, and a cross-site POST carries no `SameSite=Lax` cookie —
 * not the session (which is why the relay-state check in /azure/callback has
 * to tolerate an empty one) and, before this, not `polaris_next` either. The
 * `None` above fixes that wherever `req.secure` is true, but that depends on
 * TLS reaching Express's notion of the request: a reverse proxy that does not
 * forward `X-Forwarded-Proto`, or a `TRUST_PROXY` that does not reach it,
 * leaves the cookie on `Lax` and the target lost. RelayState depends on
 * nothing but the IdP echoing it back, which the spec requires.
 *
 * THE 80-BYTE CEILING is the SAML 2.0 binding spec's, and some IdPs truncate
 * past it. That budget is why the nonce is base64url — 12 characters for 9
 * random bytes, where the hex it replaced spent 48 on 24. 72 bits is ample for
 * a value only ever compared for equality inside a login flow that lasts
 * minutes, and the 36 characters it gives back are what let
 * `/alert-ack.html?id=<uuid>&src=push` — the longest link Polaris mails or
 * pushes (business rule 25) — fit beside it. A target too long to fit is
 * DROPPED rather than truncated: half a path is a worse landing than the
 * dashboard, and the cookie is still there to catch it.
 *
 * THE PATH IS NEVER TRUSTED COMING BACK. It made a round trip through the IdP
 * and the browser, so `relayStateTarget` re-runs `safeNextPath` on it — the
 * same reduction to a same-origin path `rememberLoginTarget` applied on the
 * way out. Nothing is authorized by RelayState; it names a page.
 */

const RELAY_STATE_MAX_BYTES = 80;
const RELAY_STATE_SEPARATOR = ".";

/** `<nonce>` alone, or `<nonce>.<path>` when a destination fits beside it. */
export function generateRelayState(nextPath?: string | null): string {
  // base64url has no "." in its alphabet, so the separator can never be
  // mistaken for part of the nonce — the path is everything after the first one.
  const nonce = randomBytes(9).toString("base64url");
  const path = nextPath ? safeNextPath(nextPath) : "/";
  if (path === "/") return nonce;
  const carried = `${nonce}${RELAY_STATE_SEPARATOR}${path}`;
  return Buffer.byteLength(carried) <= RELAY_STATE_MAX_BYTES ? carried : nonce;
}

/** The path a RelayState was carrying, or null when it carried none. */
export function relayStateTarget(relayState: unknown): string | null {
  if (typeof relayState !== "string") return null;
  const cut = relayState.indexOf(RELAY_STATE_SEPARATOR);
  if (cut < 0) return null;
  const path = safeNextPath(relayState.slice(cut + 1));
  return path === "/" ? null : path;
}
