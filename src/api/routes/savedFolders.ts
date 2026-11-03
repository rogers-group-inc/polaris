/**
 * src/api/routes/savedFolders.ts — the folder half of the saved-filter and
 * saved-dashboard registries (business rule 140).
 *
 * Not mounted on its own: `buildSavedFolderRouter` is mounted at `/folders`
 * INSIDE each item router, so a folder inherits its list's gate and mounts
 * exactly where its list lives —
 *
 *   /api/v1/saved-filters/folders     kind "filter",    scope from the body / the folder row,
 *                                     gated on that scope's key (assets → assets)
 *   /api/v1/saved-dashboards/folders  kind "dashboard", scope "dashboards",
 *                                     gated on savedDashboards (the router's read floor)
 *
 * The folder LIST is not here: it rides in the item list's response
 * (`{ filters, folders }` / `{ dashboards, folders }`), which is what keeps the
 * Dash wallboard working with no new allowlist entry. Every route below writes,
 * so the wallboard's GET-only listener can never reach one.
 *
 *   POST   /                      create (yours)                 read; "public" needs write
 *   PUT    /:id                   rename / publish / unpublish   owner; "public" needs write
 *   PATCH  /:id/parent            move (drag and drop)           owner
 *   DELETE /:id                   delete — contents move up      owner
 *   POST   /:id/owner             give to a user / role / region owner
 *   POST   /:id/make-private      take as your own, private      owner or fullwrite
 *
 * "owner" = the folder's owner, or a fullwrite holder when it is ownerless.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { MAX_NAME_LEN } from "../../services/savedFilterService.js";
import {
  changeFolderOwner,
  createFolder,
  deleteFolder,
  getFolderScope,
  moveFolder,
  takeFolder,
  updateFolder,
  type SavedFolderKind,
} from "../../services/savedFolderService.js";
import { requireViewer, type OwnerTargetInput } from "../../services/savedOwnershipService.js";

/** A new owner, as every Change owner endpoint takes it. */
export const OwnerTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("role"), roleId: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("region"), region: z.string().min(1).max(200) }),
]);

export const ChangeOwnerSchema = z.object({
  owner: OwnerTargetSchema,
  includeContents: z.boolean().optional(),
});

const CreateSchema = z.object({
  scope:      z.string().min(1).max(64).optional(),
  name:       z.string().min(1).max(MAX_NAME_LEN),
  parentId:   z.string().min(1).max(64).nullable().optional(),
  visibility: z.enum(["private", "public"]),
});

const UpdateSchema = z.object({
  name:       z.string().min(1).max(MAX_NAME_LEN),
  visibility: z.enum(["private", "public"]),
});

const ParentSchema = z.object({ parentId: z.string().min(1).max(64).nullable() });

const TakeSchema = z.object({ includeContents: z.boolean().optional() });

export interface SavedFolderRouterOptions {
  kind: SavedFolderKind;
  /**
   * The scope a CREATE lands in, from the body. Dashboards ignore the body and
   * always answer "dashboards"; filters require `scope`.
   */
  scopeForCreate: (body: { scope?: string }) => string;
  /**
   * Assert the caller holds `level` on the scope's gating key and return that
   * key (the saved-filter scope map, or the fixed savedDashboards key).
   */
  assertAccess: (req: Request, scope: string, level: "read" | "write") => Promise<string>;
}

export function buildSavedFolderRouter(opts: SavedFolderRouterOptions): Router {
  const router = Router();

  /** Learn a folder's scope, refuse one of the other kind, gate on its key. */
  async function gateExisting(req: Request, id: string): Promise<string> {
    const { kind, scope } = await getFolderScope(id);
    if (kind !== opts.kind) throw new AppError(404, "Folder not found");
    return opts.assertAccess(req, scope, "read");
  }

  router.post("/", async (req, res, next) => {
    try {
      const body = CreateSchema.parse(req.body);
      const scope = opts.scopeForCreate(body);
      const key = await opts.assertAccess(req, scope, body.visibility === "public" ? "write" : "read");
      const viewer = await requireViewer(req, key);
      const folder = await createFolder(
        { kind: opts.kind, scope, name: body.name, parentId: body.parentId ?? null, visibility: body.visibility },
        viewer,
      );
      res.status(201).json(folder);
    } catch (err) {
      next(err);
    }
  });

  router.put("/:id", async (req, res, next) => {
    try {
      const body = UpdateSchema.parse(req.body);
      const key = await gateExisting(req, req.params.id);
      const viewer = await requireViewer(req, key);
      if (body.visibility === "public" && !viewer.write) {
        throw new AppError(403, `Forbidden — publishing a folder requires ${key}:write`);
      }
      res.json(await updateFolder(req.params.id, body, viewer));
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id/parent", async (req, res, next) => {
    try {
      const body = ParentSchema.parse(req.body);
      const key = await gateExisting(req, req.params.id);
      const viewer = await requireViewer(req, key);
      await moveFolder(req.params.id, body.parentId, viewer);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      const key = await gateExisting(req, req.params.id);
      const viewer = await requireViewer(req, key);
      await deleteFolder(req.params.id, viewer);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/owner", async (req, res, next) => {
    try {
      const body = ChangeOwnerSchema.parse(req.body);
      const key = await gateExisting(req, req.params.id);
      const viewer = await requireViewer(req, key);
      res.json(await changeFolderOwner(req.params.id, body.owner as OwnerTargetInput, !!body.includeContents, viewer));
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/make-private", async (req, res, next) => {
    try {
      const body = TakeSchema.parse(req.body ?? {});
      const key = await gateExisting(req, req.params.id);
      const viewer = await requireViewer(req, key);
      res.json(await takeFolder(req.params.id, !!body.includeContents, viewer));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
