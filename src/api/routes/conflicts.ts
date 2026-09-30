/**
 * src/api/routes/conflicts.ts — Discovery conflict review and resolution
 *
 * Thin route layer: role-based visibility + resolve gating live here; the
 * resolution engine (accept/reject/merge for both entityType variants,
 * including the ip-override flavour and the ghost-absorb transaction) lives
 * in src/services/conflictResolutionService.ts — see its header for the
 * conflict-variant semantics. The duplicate-IP flavour's two verbs delegate to
 * src/services/duplicateIpConflictService.ts: `/:id/reassign-ip` (move one of
 * the assets to a different address) and `/:id/merge` (same route as the
 * per-field asset merge, different body — the records are one device).
 *
 * Access rides the discoveryConflicts permission alone: read = list both
 * entity types, write = resolve both — with two exceptions, `/:id/reassign-ip`
 * and `/:id/merge` on a duplicate-IP conflict, which additionally require
 * `assets:write` because they edit (and, for merge, delete) inventory.
 * (The historical networkadmin↔
 * reservation / assetsadmin↔asset role-NAME partition was dropped 2026-08 —
 * it silently stopped applying when the seeded roles were renamed and never
 * applied to bearer-token callers.)
 */

import { Router, type Request } from "express";
import { AppError } from "../../utils/errors.js";
import { requireAuth, requestActor } from "../middleware/auth.js";
import { hasPermission } from "../middleware/permissions.js";
import {
  listConflicts,
  countPendingConflicts,
  loadPendingConflict,
  acceptConflict,
  mergeAssetConflict,
  rejectConflict,
  type ConflictEntityType,
} from "../../services/conflictResolutionService.js";
import {
  buildChassisDiff,
  migrateArchivedReservations,
} from "../../services/subnetChassisConflictService.js";
import {
  reassignDuplicateIpAsset,
  mergeDuplicateIpAssets,
  DUPLICATE_IP_COLLISION_REASON,
} from "../../services/duplicateIpConflictService.js";
import {
  mergeDuplicateSerialAssets,
  DUPLICATE_SERIAL_COLLISION_REASON,
} from "../../services/duplicateSerialConflictService.js";

const router = Router();
router.use(requireAuth);

function visibleEntityTypes(req: Request): ConflictEntityType[] {
  if (!hasPermission(req, "discoveryConflicts", "read")) return [];
  // "subnet" arrived with business rule 41's chassis-replacement variant. It
  // rides the same `discoveryConflicts` gate as the other two: it IS a
  // discovery conflict, and gating it separately would leave a replaced gate
  // reported to nobody who can act on it.
  return ["reservation", "asset", "subnet"];
}

function canResolve(req: Request): boolean {
  return hasPermission(req, "discoveryConflicts", "write");
}

// GET /api/v1/conflicts — list conflicts visible to the current role
router.get("/", async (req, res, next) => {
  try {
    const status = (req.query.status as string) || "pending";
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 5000);
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const entityTypes = visibleEntityTypes(req);
    if (entityTypes.length === 0) {
      res.json({ conflicts: [], total: 0, limit, offset });
      return;
    }

    const { conflicts, total } = await listConflicts(entityTypes, status, limit, offset);

    res.json({ conflicts, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/conflicts/count — pending count for nav badge, scoped to role
router.get("/count", async (req, res, next) => {
  try {
    const entityTypes = visibleEntityTypes(req);
    if (entityTypes.length === 0) {
      res.json({ count: 0 });
      return;
    }
    const count = await countPendingConflicts(entityTypes);
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/conflicts/:id/chassis-diff — the per-address diff behind a
// `chassis-replaced` subnet conflict (business rule 41): what the archived old
// chassis served against what the live subnet holds now.
//
// A separate read rather than a field on the conflict row: discovery syncs
// subnets in Phase 1 and reservations in Phases 3–5, so a payload built at
// detection time would compare the old chassis against itself. Reading it live
// also means the card can never show a diff that has since gone stale.
router.get("/:id/chassis-diff", async (req, res, next) => {
  try {
    // Same read gate the list and count carry — requireAuth alone would let any
    // authenticated session enumerate a subnet's whole reservation history.
    if (!visibleEntityTypes(req).includes("subnet")) {
      throw new AppError(403, "You do not have permission to view discovery conflicts");
    }
    const conflict = await loadPendingConflict(req.params.id);
    if (conflict.entityType !== "subnet") {
      throw new AppError(400, "This conflict is not a subnet chassis replacement");
    }
    res.json(await buildChassisDiff(conflict));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/migrate-reservations — subnet chassis conflicts
// only. Body: `{ ips: [...], adopt?: boolean }`.
//
// Carries the named addresses' OLD (archived) reservations onto the live
// subnet: `only-old` lines are created, `same`/`differs` lines update the live
// row in place. Every migrated row lands `sourceType: "manual"` with
// `dhcpBinding: null` and, where the integration's DHCP push is on, queued
// (`pushStatus: "pending"`) for `retryQueuedReservationPushes` to send — never
// pushed inline, because a brand-new gate is exactly the device most likely to
// be briefly unreachable and an operator's migrate must not fail on that.
//
// CHAINED gate — `discoveryConflicts:write` AND `reservations:write` (the
// /reassign-ip precedent): resolving conflict queue entries and creating
// reservations are separable grants, and this verb needs both.
//
// `adopt: true` additionally runs the normal accept, closing the conflict and
// stamping the new serial. Omitted, the conflict stays open on purpose — an
// operator may migrate a few lines, look again, and migrate more.
router.post("/:id/migrate-reservations", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (conflict.entityType !== "subnet") {
      throw new AppError(400, "Reservation migration is only supported for subnet chassis conflicts");
    }
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    if (!hasPermission(req, "reservations", "write")) {
      throw new AppError(403, "You do not have permission to create reservations");
    }
    const ips = Array.isArray(req.body?.ips)
      ? req.body.ips.filter((v: unknown): v is string => typeof v === "string")
      : [];
    if (ips.length === 0) throw new AppError(400, "ips must be a non-empty array of addresses");

    const actor = requestActor(req);
    const outcome = await migrateArchivedReservations(conflict, ips, { actor });
    if (req.body?.adopt === true) await acceptConflict(conflict, actor);

    res.json({ ok: true, ...outcome, adopted: req.body?.adopt === true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/accept
router.post("/:id/accept", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    await acceptConflict(conflict, requestActor(req));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/merge — asset conflicts only. TWO bodies, chosen
// by the conflict's flavour:
//   • duplicate-IP      → { survivorAssetId, absorbAssetIds: [...] } — the
//     records are one device; absorb the duplicates into the survivor via the
//     operator merge engine. Needs `assets:fullwrite` on top of
//     discoveryConflicts:write.
//   • duplicate-serial  → the same body, the same gate, the same engine
//     (business rule 83). The contested-serial flavour has NO merge: it is one
//     asset and two gates, not two assets.
//   • everything else → per-field winner selection, below.
// Body: { fieldWinners: { hostname: "existing"|"proposed", ... } }.
// Fields not present in fieldWinners fall back to the default accept logic
// (today's behavior — blank-fill for most, always-overwrite for os/osVersion,
// NetBIOS upgrade for hostname). Resolves the conflict the same way Accept
// does: stamps the AssetSource row, absorbs ghost assets, marks status accepted.
router.post("/:id/merge", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (conflict.entityType !== "asset") {
      throw new AppError(400, "Merge with per-field selection is only supported for asset conflicts");
    }
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    // Duplicate-IP conflicts share the verb but not the body: there is no
    // proposed side to pick fields from, so the operator names a SURVIVOR and
    // the records to absorb into it ("these are one device recorded twice").
    // Same chained gate as /reassign-ip — it deletes asset rows.
    const proposedKind = (conflict.proposedAssetFields || {}) as Record<string, unknown>;
    if (proposedKind.collisionReason === DUPLICATE_IP_COLLISION_REASON) {
      // Merging is editing one asset AND deleting another, so it takes the
      // assets key's destructive tier — the same level `POST /assets/:id/merge`
      // requires, and the level the merge modal is gated on client-side. The
      // reassign verb below stays at `write`: it edits, it deletes nothing.
      if (!hasPermission(req, "assets", "fullwrite")) {
        throw new AppError(403, "Merging assets requires full read-write on Assets");
      }
      const survivorAssetId =
        typeof req.body?.survivorAssetId === "string" ? req.body.survivorAssetId : "";
      if (!survivorAssetId) throw new AppError(400, "survivorAssetId is required");
      const absorbAssetIds = Array.isArray(req.body?.absorbAssetIds)
        ? req.body.absorbAssetIds.filter((v: unknown): v is string => typeof v === "string")
        : [];

      const outcome = await mergeDuplicateIpAssets(
        conflict,
        survivorAssetId,
        absorbAssetIds,
        requestActor(req),
      );

      res.json({ ok: true, ...outcome });
      return;
    }

    // Duplicate-serial conflicts take the same body for the same reason: one
    // device recorded twice, and the operator names which record survives.
    // Same chained `assets:fullwrite` gate — it deletes asset rows.
    if (proposedKind.collisionReason === DUPLICATE_SERIAL_COLLISION_REASON) {
      if (!hasPermission(req, "assets", "fullwrite")) {
        throw new AppError(403, "Merging assets requires full read-write on Assets");
      }
      const survivorAssetId =
        typeof req.body?.survivorAssetId === "string" ? req.body.survivorAssetId : "";
      if (!survivorAssetId) throw new AppError(400, "survivorAssetId is required");
      const absorbAssetIds = Array.isArray(req.body?.absorbAssetIds)
        ? req.body.absorbAssetIds.filter((v: unknown): v is string => typeof v === "string")
        : [];

      const outcome = await mergeDuplicateSerialAssets(
        conflict,
        survivorAssetId,
        absorbAssetIds,
        requestActor(req),
      );

      res.json({ ok: true, ...outcome });
      return;
    }

    const raw = (req.body && req.body.fieldWinners) || {};
    const fieldWinners: Record<string, "existing" | "proposed"> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (v === "existing" || v === "proposed") fieldWinners[k] = v;
    }

    await mergeAssetConflict(conflict, requestActor(req), fieldWinners);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reassign-ip — duplicate-IP conflicts only.
// Body: { assetId, ipAddress }. Gives ONE of the assets sharing the address a
// new one (operator-pin semantics, like editing IP Address on the asset form)
// and closes the conflict once fewer than two current claims remain.
//
// CHAINED gate — discoveryConflicts:write AND assets:write (the
// /network-scans/:id/adopt precedent): resolving conflict queue entries and
// editing device inventory are separable grants, and this verb needs both.
router.post("/:id/reassign-ip", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }
    if (!hasPermission(req, "assets", "write")) {
      throw new AppError(403, "You do not have permission to change an asset's IP address");
    }
    const assetId = typeof req.body?.assetId === "string" ? req.body.assetId : "";
    const ipAddress = typeof req.body?.ipAddress === "string" ? req.body.ipAddress : "";
    if (!assetId) throw new AppError(400, "assetId is required");

    const outcome = await reassignDuplicateIpAsset(
      conflict,
      assetId,
      ipAddress,
      requestActor(req),
    );

    res.json({ ok: true, ...outcome });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/conflicts/:id/reject
router.post("/:id/reject", async (req, res, next) => {
  try {
    const conflict = await loadPendingConflict(req.params.id);
    if (!canResolve(req)) {
      throw new AppError(403, "You do not have permission to resolve this conflict");
    }

    await rejectConflict(conflict, requestActor(req));

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
