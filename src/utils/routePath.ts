/**
 * src/utils/routePath.ts — the path a router would match, for gates that run
 * before the router.
 *
 * Express matches routes case-insensitively and ignores a trailing slash (this
 * app sets neither `case sensitive routing` nor `strict routing`). A guard that
 * decides by looking `req.path` up in a Set of exact, lowercase, slash-less
 * strings therefore skips the very route it protects when the request spells it
 * `/API/V1/AUTH/LOGIN` or `/api/v1/auth/login/` (scan findings F166 and F234).
 * Compare `canonicalRoutePath(req.path)` instead.
 *
 * `req.path` is also RAW — not percent-decoded, repeated slashes and dot
 * segments intact — while express.static decodes and normalizes before it
 * reads a file. So `/%61pi.html`, `//api.html` and `/./api.html` missed the
 * API-docs and login-page gates and were still served the page (re-scan F87).
 * `canonicalRoutePath` therefore resolves the path the way the static handler
 * will, and `nonCanonicalRequestPath` lets app.ts refuse any request whose
 * path is not already in that form, so a gate and the file served can never
 * disagree.
 *
 * Pure. Business rule 108.
 */

import { posix } from "node:path";
import { trimTrailing } from "./trimTrailing.js";

/**
 * Percent-decoded, repeated slashes collapsed, dot segments resolved — the
 * path express.static would read. Null when the encoding is malformed.
 */
export function resolvedRequestPath(path: string, decode = true): string | null {
  let p = String(path ?? "");
  if (decode) {
    try {
      p = decodeURIComponent(p);
    } catch {
      return null;
    }
  }
  if (!p.startsWith("/")) p = "/" + p;
  return posix.normalize(p);
}

/**
 * True when a request path is not in the form a gate compares: it carries a
 * percent-encoding, a repeated slash or a dot segment the static handler would
 * resolve away. Under `/api/` an encoded path parameter is legitimate (the
 * router does not decode while matching), so there only slashes and dot
 * segments count. Trailing slashes are left to canonicalRoutePath: the router
 * already ignores them, and every gate compares the trimmed form.
 */
export function nonCanonicalRequestPath(path: string): boolean {
  const raw = String(path ?? "");
  const resolved = resolvedRequestPath(raw, !raw.startsWith("/api/"));
  if (resolved === null) return true;
  return trimTrailing(resolved, "/") !== trimTrailing(raw, "/");
}

/** Resolved as express.static would (see the header), lowercased, trailing slashes dropped (a lone "/" stays). */
export function canonicalRoutePath(path: string): string {
  const resolved = resolvedRequestPath(path) ?? String(path ?? "");
  const lower = resolved.toLowerCase();
  const trimmed = trimTrailing(lower, "/");
  return trimmed === "" ? "/" : trimmed;
}
