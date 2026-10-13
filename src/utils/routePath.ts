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
 * Pure. Business rule 108.
 */

import { trimTrailing } from "./trimTrailing.js";

/** Lowercase and drop trailing slashes (a lone "/" stays). */
export function canonicalRoutePath(path: string): string {
  const lower = String(path ?? "").toLowerCase();
  const trimmed = trimTrailing(lower, "/");
  return trimmed === "" ? "/" : trimmed;
}
