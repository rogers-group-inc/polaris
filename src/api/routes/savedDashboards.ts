/**
 * src/api/routes/savedDashboards.ts — saved dashboards (named canvases).
 *
 * Mounted TWICE, deliberately:
 *   - /api/v1/saved-dashboards on the main router (after the global
 *     requireAuth) — the Dashboard page's "Dashboards ▾" menu.
 *   - /dash/api/v1/saved-dashboards on the Dash wallboard listener, which is
 *     GET-only app-wide and carries NO session: a wallboard can therefore load
 *     a published dashboard and can never save one, structurally rather than by
 *     a check here. Its reads answer with PUBLIC rows (and public folders) only,
 *     and /owner-options refuses it (401) — it names accounts.
 *
 * The mount carries a `savedDashboards:read` floor for both, so the wallboard's
 * synthetic readonly identity is gated by the same matrix an operator's is.
 * Per route on top of that:
 *
 *   GET    /                  visible dashboards + folders          read
 *                             (public only with no session)
 *   GET    /owner-options     Change owner pickers                  read, signed in
 *   GET    /:id               one, 404 (not 403) when not visible   read
 *   POST   /                  create/overwrite own by name          read
 *                             (visibility "public" also needs      write)
 *   PUT    /:id               edit                                  owner; same publish rule
 *   PATCH  /:id/folder        file in a folder (drag and drop)      owner
 *   DELETE /:id               delete                                owner
 *   POST   /:id/owner         give to a user / role / region        owner
 *   POST   /:id/make-private  take as your own, private             owner or fullwrite
 *   …/folders/*               the folder routes (savedFolders.ts)
 *
 * "owner" (business rule 140) = the dashboard's owner — the user, any holder
 * of the owning role, any user whose region scope names the owning region —
 * or, for an OWNERLESS dashboard, a fullwrite holder. Fullwrite no longer
 * deletes someone's OWNED public dashboard.
 *
 * Keeping a PRIVATE dashboard needs only the read level because the ungated
 * per-user /me/dashboard already lets any caller store the same layout;
 * PUBLISHING is what reaches other operators and the unauthenticated wallboard,
 * which is the write. See services/savedDashboardService.ts for the model.
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { hasPermission, requirePermission } from "../middleware/permissions.js";
import {
  changeSavedDashboardOwner,
  createSavedDashboard,
  deleteSavedDashboard,
  listSavedDashboards,
  moveSavedDashboard,
  normalizeName,
  readSavedDashboard,
  sanitizeDashboardLayout,
  takeSavedDashboard,
  updateSavedDashboard,
  DASHBOARD_FOLDER_SCOPE,
  type SavedDashboardVisibility,
} from "../../services/savedDashboardService.js";
import {
  listOwnerOptions,
  requireViewer,
  viewerFromRequest,
  type OwnerTargetInput,
} from "../../services/savedOwnershipService.js";
import { MAX_DASHBOARD_NAME_LEN } from "../../utils/dashboardLayout.js";
import { buildSavedFolderRouter, ChangeOwnerSchema } from "./savedFolders.js";

const router = Router();
const KEY = "savedDashboards";

const BodySchema = z.object({
  name:       z.string().min(1).max(MAX_DASHBOARD_NAME_LEN),
  visibility: z.enum(["private", "public"]),
  // Shape-validated by sanitizeDashboardLayout (the unit-tested contract);
  // Zod only guarantees it's an object here.
  layout:     z.record(z.unknown()),
  // Omitted = leave it where it is (PUT) / top level (POST).
  folderId:   z.string().min(1).max(64).nullable().optional(),
});

const FolderSchema = z.object({ folderId: z.string().min(1).max(64).nullable() });

/**
 * Publishing to everyone (and to the wallboard) is a write to shared state;
 * keeping a private dashboard is not. Checked per request rather than at the
 * mount because the level depends on the payload's `visibility`.
 */
function assertMayPublish(req: Request, visibility: SavedDashboardVisibility): void {
  if (visibility === "public" && !hasPermission(req, KEY, "write")) {
    throw new AppError(403, "Forbidden — publishing a public dashboard requires savedDashboards:write");
  }
}

// Read floor for every route on both mounts. requirePermission refreshes the
// role snapshot, so hasPermission checks below read a fresh matrix.
router.use(requirePermission(KEY, "read"));

router.use(
  "/folders",
  buildSavedFolderRouter({
    kind: "dashboard",
    scopeForCreate: () => DASHBOARD_FOLDER_SCOPE,
    // The read floor above already ran; only the publish level is left.
    assertAccess: async (req, _scope, level) => {
      if (level === "write" && !hasPermission(req, KEY, "write")) {
        throw new AppError(403, `Forbidden — requires ${KEY}:write`);
      }
      return KEY;
    },
  }),
);

router.get("/", async (req, res, next) => {
  try {
    res.json(await listSavedDashboards(await viewerFromRequest(req, KEY)));
  } catch (err) {
    next(err);
  }
});

router.get("/owner-options", async (req, res, next) => {
  try {
    // Signed-in only: it lists accounts, and the wallboard reaches this router.
    await requireViewer(req, KEY);
    res.json(await listOwnerOptions());
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = BodySchema.parse(req.body);
    const viewer = await requireViewer(req, KEY);
    assertMayPublish(req, body.visibility);
    const saved = await createSavedDashboard(
      {
        name:       normalizeName(body.name),
        visibility: body.visibility as SavedDashboardVisibility,
        layout:     sanitizeDashboardLayout(body.layout),
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
    const viewer = await requireViewer(req, KEY);
    assertMayPublish(req, body.visibility);
    const saved = await updateSavedDashboard(
      req.params.id,
      {
        name:       normalizeName(body.name),
        visibility: body.visibility as SavedDashboardVisibility,
        layout:     sanitizeDashboardLayout(body.layout),
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
    const viewer = await requireViewer(req, KEY);
    await moveSavedDashboard(req.params.id, body.folderId, viewer);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post("/:id/owner", async (req, res, next) => {
  try {
    const body = ChangeOwnerSchema.parse(req.body);
    const viewer = await requireViewer(req, KEY);
    res.json(await changeSavedDashboardOwner(req.params.id, body.owner as OwnerTargetInput, viewer));
  } catch (err) {
    next(err);
  }
});

router.post("/:id/make-private", async (req, res, next) => {
  try {
    const viewer = await requireViewer(req, KEY);
    res.json(await takeSavedDashboard(req.params.id, viewer));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    // Ownership (or, ownerless, fullwrite) is decided in the service — the
    // owner of a PUBLIC dashboard is the only one who may delete it.
    const viewer = await requireViewer(req, KEY);
    await deleteSavedDashboard(req.params.id, viewer);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// Declared LAST so the literal paths above can never be captured by :id.
router.get("/:id", async (req, res, next) => {
  try {
    res.json(await readSavedDashboard(req.params.id, await viewerFromRequest(req, KEY)));
  } catch (err) {
    next(err);
  }
});

export default router;
