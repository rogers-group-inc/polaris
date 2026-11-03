/**
 * src/api/routes/savedFilters.ts — saved table filters (list-page presets).
 *
 * Mounted at /api/v1/saved-filters (after the global requireAuth in
 * router.ts). Every route resolves the caller's access from the SCOPE in the
 * request — each scope rides the RBAC function key that already gates its page
 * (SAVED_FILTER_SCOPES in savedFilterService.ts), so there is no new function
 * key and no role migration:
 *
 *   GET    /?scope=assets          visible presets + folders          <key>:read
 *   GET    /owner-options?scope=   Change owner pickers               <key>:read
 *   POST   /                       create/overwrite own preset        <key>:read
 *                                  (visibility "public" also needs    <key>:write)
 *   PUT    /:id                    edit                               owner; same publish rule
 *   PATCH  /:id/folder             file in a folder (drag and drop)   owner
 *   DELETE /:id                    delete                             owner
 *   POST   /:id/owner              give to a user / role / region     owner
 *   POST   /:id/make-private       take as your own, private          owner or <key>:fullwrite
 *   …/folders/*                    the folder routes (savedFolders.ts)
 *
 * "owner" (business rule 140) = the preset's owner — the user, any holder of
 * the owning role, any user whose region scope names the owning region — or,
 * for an OWNERLESS preset, a <key>:fullwrite holder. Fullwrite no longer
 * deletes someone's OWNED public preset.
 *
 * The gate is resolved per-request rather than via requirePermission(key,…) at
 * the mount because the key depends on the body/query's scope.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { assertScopeAccess } from "../middleware/scopeAccess.js";
import {
  changeSavedFilterOwner,
  createSavedFilter,
  deleteSavedFilter,
  getSavedFilter,
  listSavedFilters,
  moveSavedFilter,
  normalizeName,
  sanitizeFilterState,
  takeSavedFilter,
  updateSavedFilter,
  MAX_NAME_LEN,
  type SavedFilterVisibility,
} from "../../services/savedFilterService.js";
import {
  listOwnerOptions,
  requireViewer,
  type OwnerTargetInput,
} from "../../services/savedOwnershipService.js";
import { buildSavedFolderRouter, ChangeOwnerSchema } from "./savedFolders.js";

const router = Router();

const BodySchema = z.object({
  scope:      z.string().min(1).max(64),
  name:       z.string().min(1).max(MAX_NAME_LEN),
  visibility: z.enum(["private", "public"]),
  // Shape-validated by sanitizeFilterState (which is also the unit-tested
  // contract); Zod only guarantees it's an object here.
  state:      z.record(z.unknown()),
  // Omitted = leave the preset where it is (PUT) / top level (POST).
  folderId:   z.string().min(1).max(64).nullable().optional(),
});

const FolderSchema = z.object({ folderId: z.string().min(1).max(64).nullable() });

/** Resolve a stored preset's scope, gate on its key at `read`, build the viewer. */
async function viewerForRow(req: Request, id: string) {
  const row = await getSavedFilter(id);
  const key = await assertScopeAccess(req, row.scope, "read");
  return { row, viewer: await requireViewer(req, key) };
}

router.use(
  "/folders",
  buildSavedFolderRouter({
    kind: "filter",
    scopeForCreate: (body) => {
      if (!body.scope) throw new AppError(400, "scope is required");
      return body.scope;
    },
    assertAccess: (req, scope, level) => assertScopeAccess(req, scope, level),
  }),
);

router.get("/", async (req, res, next) => {
  try {
    const scope = String(req.query.scope || "");
    const key = await assertScopeAccess(req, scope, "read");
    const viewer = await requireViewer(req, key);
    res.json(await listSavedFilters(scope, viewer));
  } catch (err) {
    next(err);
  }
});

router.get("/owner-options", async (req, res, next) => {
  try {
    const scope = String(req.query.scope || "");
    const key = await assertScopeAccess(req, scope, "read");
    await requireViewer(req, key);
    res.json(await listOwnerOptions());
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    // Reading the page is enough to keep a private preset; PUBLISHING one to
    // every other operator is a write to shared state.
    const key = await assertScopeAccess(req, body.scope, body.visibility === "public" ? "write" : "read");
    const viewer = await requireViewer(req, key);
    const saved = await createSavedFilter(
      {
        scope:      body.scope,
        name:       normalizeName(body.name),
        visibility: body.visibility as SavedFilterVisibility,
        state:      sanitizeFilterState(body.state),
        folderId:   body.folderId,
      },
      viewer,
    );
    res.status(201).json(saved);
  } catch (err) {
    next(err);
  }
});

router.put("/:id", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const { row, viewer } = await viewerForRow(req, req.params.id);
    if (body.scope !== row.scope) throw new AppError(400, "scope cannot be changed");
    if (body.visibility === "public") await assertScopeAccess(req, row.scope, "write");
    const saved = await updateSavedFilter(
      row.id,
      {
        scope:      row.scope,
        name:       normalizeName(body.name),
        visibility: body.visibility as SavedFilterVisibility,
        state:      sanitizeFilterState(body.state),
        folderId:   body.folderId,
      },
      viewer,
    );
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/folder", async (req, res, next) => {
  try {
    const body = FolderSchema.parse(req.body);
    const { row, viewer } = await viewerForRow(req, req.params.id);
    await moveSavedFilter(row.id, body.folderId, viewer);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/:id/owner", async (req, res, next) => {
  try {
    const body = ChangeOwnerSchema.parse(req.body);
    const { row, viewer } = await viewerForRow(req, req.params.id);
    res.json(await changeSavedFilterOwner(row.id, body.owner as OwnerTargetInput, viewer));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/make-private", async (req, res, next) => {
  try {
    const { row, viewer } = await viewerForRow(req, req.params.id);
    res.json(await takeSavedFilter(row.id, viewer));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    // Ownership (or, ownerless, fullwrite) is decided in the service — the
    // owner of a PUBLIC preset is the only one who may delete it.
    const { row, viewer } = await viewerForRow(req, req.params.id);
    await deleteSavedFilter(row.id, viewer);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
