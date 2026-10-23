/**
 * src/api/middleware/rejectBrotliBody.ts — Refuse Brotli-compressed request bodies
 *
 * Express 5's body parsers (body-parser 2.x) decompress a request whose
 * `Content-Encoding` is `br` with node:zlib's Brotli decoder — and they are
 * mounted app-wide, ahead of authentication. CVE-2026-111497 is an
 * out-of-bounds write in that decoder (fixed upstream in Node 24.22.1 /
 * 22.23.4), so on an unpatched runtime any client that can reach the login
 * page could hand it a crafted stream. RHEL's nodejs:24 bundles the affected
 * Brotli 1.2.0 with no backport, so "upgrade Node" is not available everywhere.
 *
 * Nothing legitimate sends one: browsers never compress request bodies, the
 * Polaris Agent sends plain JSON, and API clients use JSON. So refusing is
 * cheap, works on every install shape regardless of the runtime underneath,
 * and stays worth keeping after the runtime is patched — an attack surface
 * with no user is not one to reopen.
 *
 * 415 is the status RFC 9110 assigns to an unsupported content coding.
 * Responds directly rather than throwing an AppError because the first-run
 * setup server mounts it too and has no error handler.
 *
 * MUST be mounted before express.json() / express.urlencoded().
 */

import type { Request, Response, NextFunction } from "express";

/** True when a Content-Encoding header value lists `br` as any of its codings. */
export function contentEncodingHasBrotli(header: string | string[] | undefined): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(",") : header;
  return raw.split(",").some((c) => c.trim().toLowerCase() === "br");
}

export function rejectBrotliBody(req: Request, res: Response, next: NextFunction): void {
  if (contentEncodingHasBrotli(req.headers["content-encoding"])) {
    res.status(415).json({ error: "Brotli-compressed request bodies are not accepted" });
    return;
  }
  next();
}
