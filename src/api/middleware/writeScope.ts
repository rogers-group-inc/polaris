/**
 * src/api/middleware/writeScope.ts — per-route write-scope gates for the asset
 * routers (business rule 141 (e)).
 *
 * Each factory runs AFTER `requirePermission(key, "write")` on the same route
 * and narrows a Read-Write caller to the records they own or that carry one
 * of their tags (`services/writeScopeService.ts`); Full Read-Write passes
 * untouched. They load only `{ createdBy, tags }` — one indexed read for a
 * single asset, one `findMany` over the ids for a bulk verb — and never 404:
 * an id that names no asset is left for the handler, which already answers
 * for it, so a scoped caller cannot probe which ids exist.
 *
 *   scopeAssetParam(key, verb)         the asset in `req.params[param]`
 *   scopeAssetIds(key, verb, pick)     every asset `pick(req)` names, checked
 *                                      before any write
 *   requireFleetWide(key, what)        a verb with no record to be "in" —
 *                                      Full Read-Write only
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { prisma } from "../../db.js";
import {
  resolveWriteScope,
  assertInWriteScope,
  assertAllInWriteScope,
  assertFleetWide,
} from "../../services/writeScopeService.js";

const SCOPE_SELECT = { id: true, createdBy: true, tags: true } as const;

/** The asset named by a path parameter (default `:id`). */
export function scopeAssetParam(key: string, verb: string, param = "id"): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const scope = await resolveWriteScope(req, key);
      if (scope.kind === "all") return next();
      const id = String(req.params[param] ?? "");
      const asset = id ? await prisma.asset.findUnique({ where: { id }, select: SCOPE_SELECT }) : null;
      if (asset) assertInWriteScope(scope, asset, verb);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Every asset the body names. `pick` returns the ids (unknown shapes yield
 * nothing — the handler's own validation then answers with its 400). Ids that
 * name no asset are ignored here for the same reason as above.
 */
export function scopeAssetIds(key: string, verb: string, pick: (req: Request) => readonly string[]): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const scope = await resolveWriteScope(req, key);
      if (scope.kind === "all") return next();
      const ids = Array.from(new Set(pick(req).filter((v): v is string => typeof v === "string" && v.length > 0)));
      if (ids.length === 0) return next();
      const assets = await prisma.asset.findMany({ where: { id: { in: ids } }, select: { ...SCOPE_SELECT, hostname: true } });
      assertAllInWriteScope(scope, assets, verb, (a) => a.hostname || a.id);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** A fleet-wide verb on a scoped key: Full Read-Write only. */
export function requireFleetWide(key: string, what: string): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      assertFleetWide(await resolveWriteScope(req, key), what);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** `body.ids` as a string array, or nothing. */
export function idsFromBody(req: Request): readonly string[] {
  const ids = (req.body as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) ? (ids as unknown[]).filter((v): v is string => typeof v === "string") : [];
}
