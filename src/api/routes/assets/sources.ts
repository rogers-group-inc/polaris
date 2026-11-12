/**
 * src/api/routes/assets/sources.ts — Where an asset came from: sightings, the per-source records and splitting one
 * off, polling history, and merging two assets (assetMerge). Split out of
 * routes/assets.ts (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, hasPermission } from "../../middleware/permissions.js";
import { scopeAssetParam } from "../../middleware/writeScope.js";
import { requestActor } from "../../middleware/auth.js";
import { getSightingsForDisplay } from "../../../services/assetSightingService.js";
import { MERGEABLE_FIELDS, type MergeableField, type FieldWinner } from "../../../services/assetMergeService.js";
import { readPollingHistorySummary } from "../../../services/sampleHistoryService.js";
import { assertAssetExists } from "../../../services/assetDetailReadService.js";
import { listAssetSourcesForDisplay, splitAssetSource, mergeAssetsAudited } from "../../../services/assetSourceService.js";

const router = Router();

// ─── Quarantine + sightings ─────────────────────────────────────────────

// GET /api/v1/assets/:id/sightings — DHCP sighting history (any auth user)
// Each sighting is decorated with its network (name, VLAN, id) resolved from
// the stored IP against networks discovered on the same FortiGate, and the
// firewall asset its gate name resolves to, so the FortiGate and VLAN cells
// can open what they name (assetSightingService.getSightingsForDisplay).
router.get("/:id/sightings", requirePermission("assetsQuarantine", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await assertAssetExists(id);
    res.json(await getSightingsForDisplay(id));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/sources — per-discovery-source view of an asset
// (Phase 3a of the multi-source asset model). Returns every AssetSource row
// for this asset with the originating integration's name + type joined in,
// sorted by sourceKind in a stable presentation order. Drives the "Sources"
// tab on the asset details modal — operators can see what each integration
// independently said, side-by-side.
router.get("/:id/sources", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await listAssetSourcesForDisplay(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/sources/:sourceId/split — admin recovery action
// (Phase 3a of the multi-source asset model). Detaches one AssetSource row
// from this asset and binds it to a freshly-created Asset, with the new
// Asset's discovery-owned fields seeded from the source's `observed` blob.
//
// Use case: a phase-1 backfill or hostname-collision conflict accept merged
// two devices into one Asset by mistake; the operator pulls the wrong source
// off and now has two correctly-separated Assets. Today's only fix without
// this endpoint is hand-editing the assetSources table.
//
// Refusal rules:
//   - Source not found, or doesn't belong to this asset → 404
//   - Source is the asset's only source — splitting would leave the original
//     Asset orphaned with no sources → 409. Operator should delete the
//     misclassified Asset instead and let the next discovery recreate it.
//   - Source is a "manual" source kind — that's a phase-1 backfill marker,
//     not a real discovery source; nothing useful to detach → 409.
//
// Asset-row FKs (monitoring samples, IP history, sightings, quarantine,
// conflicts) all stay on the *original* Asset.id. Only the AssetSource row
// moves; the new Asset starts clean (operator can configure monitoring etc.
// on it from scratch).
const splitSourceParamsSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
});

router.post("/:id/sources/:sourceId/split", requirePermission("assets", "write"), scopeAssetParam("assets", "edit assets"), async (req, res, next) => {
  try {
    const { id, sourceId } = splitSourceParamsSchema.parse(req.params);
    res.json(await splitAssetSource(id, sourceId, requestActor(req)));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/polling-history — how much sample history the asset
// holds (monitor probes + telemetry across all retention tiers): oldest/newest
// timestamps, span in days, and a stitched approximate sample count. Feeds the
// merge comparison UI, which defaults the survivor to the side with the longer
// history because the absorbed side's samples are orphaned by the merge.
router.get("/:id/polling-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await assertAssetExists(id);
    res.json(await readPollingHistorySummary(id));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/merge — operator-driven asset merge (the inverse of
// the per-source Split action above). Absorbs another asset into this one,
// re-binding the absorbed asset's discovery sources / MAC / IP / sighting
// history onto the survivor and deleting the absorbed row. The operator picks
// which side survives and resolves each differing field in the comparison UI.
//
// Body:
//   - otherAssetId: the asset to merge with this one (required)
//   - survivor: "this" (default — the :id asset survives) | "other"
//   - fieldWinners: { <field>: "this" | "other" } — per-field overrides; any
//     field omitted defaults to blank-fill (keep survivor, fill from absorbed
//     only when the survivor's value is empty)
//   - dependencyWinner: "this" | "other" — whose upstream dependency-parent
//     links the merged asset keeps when BOTH sides have some (the modal shows
//     the conflict); omitted, the survivor keeps its own. One-sided parent
//     links blank-fill, and devices depending on the absorbed asset are always
//     re-pointed at the survivor — see transferDependencyEdges.
//
// The absorbed asset's monitoring/telemetry sample history, interface comment
// overrides, and pending conflicts cascade-delete with it — the survivor keeps
// its own (the UI warns about this and surfaces which side is monitored so the
// operator picks the right survivor).
//
// `monitored` itself is OR-ed, not "survivor wins": if either side was
// monitored the survivor comes out monitored, and when that flips the survivor
// ON the absorbed row's polling methods / credentials / cadences / pins ride
// along so the enabled monitoring can actually resolve a method. See
// assetMergeService's header.
const mergeBodySchema = z.object({
  otherAssetId: z.string().min(1),
  survivor: z.enum(["this", "other"]).default("this"),
  fieldWinners: z.record(z.string(), z.enum(["this", "other"])).optional(),
  dependencyWinner: z.enum(["this", "other"]).optional(),
});

// Merging is editing one asset AND deleting another, which is why it is its
// own key (`assetMerge`, 2026-11-03) rather than the `write` that create/edit
// use — and no longer the assets key's Full Read-Write rung, which release 2
// of the write-scope change turns into reach alone (business rule 141). The
// merge modal (asset-merge-modal.js) and the conflict card's merge verbs gate
// on the same key, so what the UI offers is what the API allows.
router.post("/:id/merge", requirePermission("assetMerge", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { otherAssetId, survivor, fieldWinners, dependencyWinner } = mergeBodySchema.parse(req.body);
    if (id === otherAssetId) throw new AppError(400, "Cannot merge an asset into itself");

    // Resolve survivor (canonical) vs. absorbed (ghost) from the operator's
    // choice, then translate the "this"/"other" field winners into the
    // service's "canonical"/"ghost" vocabulary.
    const canonicalId = survivor === "this" ? id : otherAssetId;
    const ghostId = survivor === "this" ? otherAssetId : id;
    const thisIsCanonical = survivor === "this";
    const resolvedWinners: Partial<Record<MergeableField, FieldWinner>> = {};
    for (const [field, who] of Object.entries(fieldWinners ?? {})) {
      if (!(MERGEABLE_FIELDS as readonly string[]).includes(field)) continue;
      // who === "this" means the :id asset wins for this field.
      const winnerIsThis = who === "this";
      resolvedWinners[field as MergeableField] =
        winnerIsThis === thisIsCanonical ? "canonical" : "ghost";
    }
    const resolvedDependencyWinner = dependencyWinner
      ? ((dependencyWinner === "this") === thisIsCanonical ? ("canonical" as const) : ("ghost" as const))
      : undefined;

    const result = await mergeAssetsAudited({
      canonicalId,
      ghostId,
      fieldWinners: resolvedWinners,
      dependencyWinner: resolvedDependencyWinner,
      canManageIntegrations: hasPermission(req, "integrations", "write"),
      actor: requestActor(req),
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
