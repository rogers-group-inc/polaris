/**
 * src/api/routes/deviceIcons.ts — operator-uploaded device icons
 *
 * Admin CRUD for the icons used by the Device Map's topology graph.
 * Image-serve endpoint is auth-only (any logged-in user) so the topology
 * modal can render them without a secondary auth dance.
 */

import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import {
  uploadIcon,
  listIcons,
  getIconImage,
  deleteIcon,
  updateIconKey,
} from "../../services/deviceIconService.js";
import { logEvent } from "./events.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/permissions.js";
import { AppError } from "../../utils/errors.js";

const router = Router();

// PUT /device-icons/:id — re-key an icon; the image is untouched.
const UpdateIconKeySchema = z.object({
  scope:        z.enum(["manufacturer-type", "manufacturer-model"]),
  manufacturer: z.string().trim().min(1, "Manufacturer is required").max(200),
  typeOrModel:  z.string().trim().min(1, "Asset type or model is required").max(200),
});

// Hard cap matches deviceIconService's MAX_ICON_BYTES (raster cap is
// the larger of the two; the service enforces the lower SVG cap after
// inspecting mimeType). Multer rejects oversized uploads before the
// handler ever sees the buffer.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 } });

// GET /device-icons — list. Hashes are not returned (they don't exist),
// just the metadata + a thumbnail URL the UI uses for previews.
router.get("/", requirePermission("deviceIcons", "read"), async (_req, res, next) => {
  try {
    const icons = await listIcons();
    res.json(
      icons.map((i) => ({
        ...i,
        // Convenience URL for the UI thumbnail and the topology renderer.
        // Same path the topology endpoint embeds in node payloads.
        url: `/api/v1/device-icons/${i.id}/image`,
      })),
    );
  } catch (err) {
    next(err);
  }
});

// POST /device-icons — multipart upload.
//   field name: file (required)
//   form fields:
//     scope          ("manufacturer-type" | "manufacturer-model")
//     manufacturer   (string, required; canonicalized via alias map)
//     typeOrModel    (string, required; assetType enum value when
//                     scope=manufacturer-type, free text when
//                     scope=manufacturer-model)
// Re-uploading the same canonical key replaces the existing image.
router.post("/", requirePermission("deviceIcons", "write"), upload.single("file"), async (req, res, next) => {
  try {
    if (!req.file) throw new AppError(400, "Missing 'file' upload");
    const scope = String(req.body?.scope || "");
    const manufacturer = String(req.body?.manufacturer || "");
    const typeOrModel = String(req.body?.typeOrModel || "");
    if (!scope) throw new AppError(400, "scope is required");
    const summary = await uploadIcon({
      scope: scope as "manufacturer-type" | "manufacturer-model",
      manufacturer,
      typeOrModel,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      data: req.file.buffer,
      uploadedBy: (req as any).session?.username,
    });
    logEvent({
      action: "device_icon.uploaded",
      resourceType: "device_icon",
      resourceId: summary.id,
      resourceName: `${summary.scope}:${summary.key}`,
      actor: (req as any).session?.username,
      level: "info",
      message: `Uploaded device icon for ${summary.scope}:${summary.key} (${summary.size} bytes, ${summary.mimeType})`,
    });
    res.json({ ...summary, url: `/api/v1/device-icons/${summary.id}/image` });
  } catch (err) {
    next(err);
  }
});

// PUT /device-icons/:id — change what an icon is keyed to (manufacturer,
// asset type or model, and which of the two it matches by), keeping the
// image. A key another icon already holds is a 409, never a replace.
router.put("/:id", requirePermission("deviceIcons", "write"), async (req, res, next) => {
  try {
    const parsed = UpdateIconKeySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map((e) => e.message).join("; "));
    }
    const { icon, previous } = await updateIconKey(String(req.params.id), parsed.data);
    logEvent({
      action: "device_icon.updated",
      resourceType: "device_icon",
      resourceId: icon.id,
      resourceName: `${icon.scope}:${icon.key}`,
      actor: (req as any).session?.username,
      level: "info",
      message: `Re-keyed device icon from ${previous.scope}:${previous.key} to ${icon.scope}:${icon.key}`,
    });
    res.json({ ...icon, url: `/api/v1/device-icons/${icon.id}/image` });
  } catch (err) {
    next(err);
  }
});

// DELETE /device-icons/:id
router.delete("/:id", requirePermission("deviceIcons", "write"), async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const ok = await deleteIcon(id);
    if (!ok) throw new AppError(404, "Icon not found");
    logEvent({
      action: "device_icon.deleted",
      resourceType: "device_icon",
      resourceId: id,
      actor: (req as any).session?.username,
      level: "info",
      message: `Deleted device icon ${id}`,
    });
    // 204 like every other router's DELETE (api.js request() maps it to null).
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /device-icons/:id/image — serve raw bytes. Auth-only (session
// cookie); cacheable for 1 hour. Topology modal references this URL on
// each Cytoscape node's `background-image`. Browser cache deduplicates
// fetches across re-renders.
//
// SVG uploads are transparently rasterized to PNG at upload time (see
// deviceIconService.uploadIcon + rasterizeStoredSvgIcons backfill), so
// in practice this endpoint only serves raster formats. The SVG branch
// below stays as defense-in-depth in case a legacy row slips past the
// backfill (e.g. resvg refused to parse a malformed SVG).
router.get("/:id/image", requireAuth, async (req, res, next) => {
  try {
    const img = await getIconImage(String(req.params.id));
    if (!img) throw new AppError(404, "Icon not found");
    res.setHeader("Content-Type", img.mimeType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(img.data.length));
    // Defense-in-depth for SVG: the upload-time validator already rejects
    // <script>, event handlers, external refs, etc. — but the same bytes
    // are reachable via a direct GET on this URL, so we layer browser-side
    // mitigations too. nosniff stops MIME confusion; the strict CSP blocks
    // any residual script / fetch / image / font / connect from executing
    // even if a bypass slipped past the validator.
    if (img.mimeType === "image/svg+xml") {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      );
    }
    res.send(img.data);
  } catch (err) {
    next(err);
  }
});

export default router;
