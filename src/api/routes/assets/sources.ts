/**
 * src/api/routes/assets/sources.ts — Where an asset came from: sightings, the per-source records and splitting one
 * off, polling history, and merging two assets (assetMerge). Split out of
 * routes/assets.ts (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../../db.js";
import { AppError } from "../../../utils/errors.js";
import { requirePermission, hasPermission } from "../../middleware/permissions.js";
import { scopeAssetParam } from "../../middleware/writeScope.js";
import { reconcileDuplicateIpForAddresses, repointDuplicateIpConflicts } from "../../../services/duplicateIpConflictService.js";
import { repointDuplicateSerialConflicts, settleDuplicateSerialConflictsAfterMerge } from "../../../services/duplicateSerialConflictService.js";
import { requestActor } from "../../middleware/auth.js";
import { logEvent } from "../events.js";
import { getSightingsForDisplay } from "../../../services/assetSightingService.js";
import { mergeAssets, MERGEABLE_FIELDS, type MergeableField, type FieldWinner } from "../../../services/assetMergeService.js";
import { projectAssetFromSources } from "../../../utils/assetProjection.js";
import { deriveAssetSourceState } from "../../../utils/assetSourceState.js";
import { readPollingHistorySummary } from "../../../services/sampleHistoryService.js";
import { assetTypeForWorkloadRole, parseWorkloadSourceKind } from "../../../utils/workloadSources.js";
import { logger } from "../../../utils/logger.js";

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
    const exists = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, "Asset not found");
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
    const id = req.params.id as string;
    const exists = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, "Asset not found");

    const rows = await prisma.assetSource.findMany({
      where: { assetId: id },
      include: { integration: { select: { id: true, name: true, type: true } } },
      orderBy: [{ sourceKind: "asc" }, { lastSeen: "desc" }],
    });

    // Stable presentation order — identity-first, manual last.
    const ORDER: Record<string, number> = {
      "entra": 1,
      "intune": 2,
      "ad": 3,
      "fortigate-firewall": 4,
      "fortiswitch": 5,
      "fortiap": 6,
      "fortigate-endpoint": 7,
      // Enrichment, so it sorts under the sources that own the device — but
      // above "manual", since it is a real reading rather than a fallback.
      "snmp-sysdescr": 8,
      "fortinet-live": 9,
      "manual": 99,
    };
    rows.sort((a, b) => {
      const ai = ORDER[a.sourceKind] ?? 50;
      const bi = ORDER[b.sourceKind] ?? 50;
      if (ai !== bi) return ai - bi;
      return (b.lastSeen?.getTime() ?? 0) - (a.lastSeen?.getTime() ?? 0);
    });

    // Collapse rows that are the "same source" but split across multiple
    // AssetSource rows because the device's identity key churned. The worst
    // offender is `fortigate-endpoint`, whose externalId is the endpoint MAC —
    // a MAC change spawns a fresh source row and leaves the old one behind, so
    // the same integration would render as several near-identical cards. We
    // key dedup on (sourceKind, integrationId) and keep the most recent row
    // (rows are already lastSeen-desc within each sourceKind from the sort
    // above). The serial/GUID-keyed kinds (fortigate-firewall/switch/ap, ad,
    // entra, intune) have stable externalIds and so never collapse. The
    // dropped MAC history is still visible in the Firewall Sightings and IP
    // History tables on the same Sources tab.
    const seen = new Set<string>();
    const deduped = rows.filter((r) => {
      const key = `${r.sourceKind}\u0000${r.integrationId ?? ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json(
      deduped.map((r) => ({
        id: r.id,
        sourceKind: r.sourceKind,
        externalId: r.externalId,
        integration: r.integration ? { id: r.integration.id, name: r.integration.name, type: r.integration.type } : null,
        observed: r.observed,
        // Normalized enabled/disabled verdict for THIS source — Entra's
        // `accountEnabled`, AD's inverted `accountDisabled`, vCenter's
        // powerState/connectionState and the Fortinet connection flags all
        // collapse to one tri-state so the Sources tab can badge each card
        // instead of making the operator decode four vocabularies.
        state: deriveAssetSourceState(r.sourceKind, r.observed),
        inferred: r.inferred,
        syncedAt: r.syncedAt,
        firstSeen: r.firstSeen,
        lastSeen: r.lastSeen,
      })),
    );
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
    const originalAsset = await prisma.asset.findUnique({ where: { id }, select: { id: true, hostname: true } });
    if (!originalAsset) throw new AppError(404, "Asset not found");

    const allSources = await prisma.assetSource.findMany({ where: { assetId: id } });
    const target = allSources.find((s) => s.id === sourceId);
    if (!target) throw new AppError(404, "Source not found on this asset");
    if (target.sourceKind === "manual") {
      throw new AppError(409, "Cannot split a manual source — it's a backfill marker, not a discovery source");
    }
    if (allSources.length <= 1) {
      throw new AppError(409, "Cannot split the asset's only source. Delete the asset instead and let discovery recreate it.");
    }

    // Project the discovery-owned fields from the moved source alone — that's
    // the new Asset's seed data.
    const { projected } = projectAssetFromSources([
      { sourceKind: target.sourceKind, inferred: target.inferred, observed: target.observed as Record<string, unknown> | null },
    ]);

    // assetType per source kind. Phase 4d: assetTag is no longer set here —
    // the AssetSource row that this split path detaches from the original
    // asset (and re-binds to the new asset just below) carries the
    // canonical identity link via (sourceKind, externalId). The legacy
    // entra:/ad:/fgt: prefixes were back-compat markers that re-discovery
    // already stopped consulting in Phase 2.
    let assetType: "firewall" | "switch" | "access_point" | "workstation" | "server" | "hypervisor" | "container" | "other" = "other";
    const splitWorkload = parseWorkloadSourceKind(target.sourceKind);
    const tagSet = new Set<string>(["split-from-asset", "auto-discovered"]);
    if (target.sourceKind === "entra") {
      assetType = "workstation";
      tagSet.add("entraid");
    } else if (target.sourceKind === "intune") {
      assetType = "workstation";
      tagSet.add("entraid");
      tagSet.add("intune");
    } else if (target.sourceKind === "ad") {
      assetType = "workstation";
      tagSet.add("activedirectory");
    } else if (target.sourceKind === "fortigate-firewall") {
      assetType = "firewall";
      tagSet.add("fortigate");
    } else if (target.sourceKind === "fortiswitch") {
      assetType = "switch";
      tagSet.add("fortiswitch");
    } else if (target.sourceKind === "fortiap") {
      assetType = "access_point";
      tagSet.add("fortiap");
    } else if (target.sourceKind === "vcenter-vm") {
      assetType = "server";
      tagSet.add("vcenter");
    } else if (target.sourceKind === "vcenter-host") {
      assetType = "hypervisor";
      tagSet.add("vcenter");
    } else if (target.sourceKind === "arc") {
      // Arc onboarding is overwhelmingly server estate; the next discovery
      // run refines this via inferArcAssetType if it's actually a client SKU.
      assetType = "server";
      tagSet.add("azurearc");
    } else if (splitWorkload) {
      assetType = assetTypeForWorkloadRole(splitWorkload.role);
      tagSet.add(splitWorkload.platform);
    } else if (target.sourceKind === "generic-api") {
      // The record's own type is on the blob; the next discovery run retypes
      // the new asset from "other" (genericApiSync's rule).
      tagSet.add("genericapi");
    }

    // Manufacturer fallback — projection only gives "Fortinet" for fortinet
    // sources; AD/Entra don't carry hardware vendor on their own.
    const manufacturer = projected.manufacturer ?? (assetType === "firewall" || assetType === "switch" || assetType === "access_point" ? "Fortinet" : null);

    const newAssetData: Record<string, unknown> = {
      hostname: projected.hostname,
      assetType,
      status: "active",
      statusChangedAt: new Date(),
      statusChangedBy: requestActor(req) || "system",
      os: projected.os,
      osVersion: projected.osVersion,
      serialNumber: projected.serialNumber,
      manufacturer,
      model: projected.model,
      learnedLocation: projected.learnedLocation,
      ipAddress: projected.ipAddress,
      latitude: projected.latitude,
      longitude: projected.longitude,
      tags: Array.from(tagSet),
      notes: `Split from asset ${originalAsset.hostname || originalAsset.id} — ${target.sourceKind} source detached on ${new Date().toISOString()}`,
      ...(target.integrationId ? { discoveredByIntegrationId: target.integrationId } : {}),
      createdBy: requestActor(req) || null,
    };

    // Two-step: create the new Asset, then re-bind the source row. Done in a
    // transaction so we never leave an orphan AssetSource pointing at a
    // never-created Asset on partial failure.
    const result = await prisma.$transaction(async (tx) => {
      const newAsset = await tx.asset.create({ data: newAssetData as any });
      await tx.assetSource.update({
        where: { id: target.id },
        data: { assetId: newAsset.id },
      });
      return { newAsset };
    });

    logEvent({
      action: "asset.split",
      resourceType: "asset",
      resourceId: id,
      resourceName: originalAsset.hostname || undefined,
      actor: requestActor(req),
      level: "info",
      message: `Split ${target.sourceKind} source (externalId ${target.externalId}) off asset ${originalAsset.hostname || id} → new asset ${result.newAsset.id}`,
      details: {
        originalAssetId: id,
        newAssetId: result.newAsset.id,
        sourceId: target.id,
        sourceKind: target.sourceKind,
        externalId: target.externalId,
      },
    });

    res.json({
      originalAssetId: id,
      newAssetId: result.newAsset.id,
      movedSourceId: target.id,
      newAsset: result.newAsset,
    });
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
    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!asset) throw new AppError(404, "Asset not found");
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
  fieldWinners: z.record(z.enum(["this", "other"])).optional(),
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

    const [survivorBefore, absorbedBefore] = await Promise.all([
      prisma.asset.findUnique({ where: { id: canonicalId }, select: { id: true, hostname: true } }),
      prisma.asset.findUnique({ where: { id: ghostId }, select: { id: true, hostname: true, ipAddress: true } }),
    ]);
    if (!survivorBefore) throw new AppError(404, "Survivor asset not found");
    if (!absorbedBefore) throw new AppError(404, "Absorbed asset not found");

    // A duplicate-serial or duplicate-ip card filed on the asset about to be
    // deleted would cascade away with it — unresolved and unaudited. Move both
    // first so the settle below can close them properly (rules 83 and 40(i)).
    await repointDuplicateSerialConflicts(ghostId, canonicalId);
    await repointDuplicateIpConflicts(ghostId, canonicalId);

    const result = await mergeAssets({
      canonicalId,
      ghostId,
      fieldWinners: resolvedWinners,
      dependencyWinner: resolvedDependencyWinner,
      canManageIntegrations: hasPermission(req, "integrations", "write"),
    });

    await logEvent({
      action: "asset.merged",
      resourceType: "asset",
      resourceId: result.survivorId,
      resourceName: survivorBefore.hostname || undefined,
      actor: requestActor(req),
      level: "info",
      message: `Merged asset ${absorbedBefore.hostname || result.absorbedId} into ${survivorBefore.hostname || result.survivorId} — moved ${result.movedSources} source(s)` +
        (result.carriedMonitoring ? "; monitoring carried over from the absorbed asset" : "") +
        (result.movedDependents > 0 ? `; re-pointed ${result.movedDependents} dependent device(s)` : "") +
        (result.movedDependencyParents > 0 ? `; carried ${result.movedDependencyParents} dependency parent link(s)` : ""),
      details: {
        survivorId: result.survivorId,
        absorbedId: result.absorbedId,
        carriedMonitoring: result.carriedMonitoring,
        monitorFieldsAdopted: result.monitorFieldsAdopted,
        movedSources: result.movedSources,
        movedMacs: result.movedMacs,
        movedIps: result.movedIps,
        movedIpHistory: result.movedIpHistory,
        movedSightings: result.movedSightings,
        movedManagedAgent: result.movedManagedAgent,
        movedDependencyParents: result.movedDependencyParents,
        replacedDependencyParents: result.replacedDependencyParents,
        movedDependents: result.movedDependents,
        dependencyWinner: resolvedDependencyWinner ?? null,
        appliedFields: result.appliedFields,
        fieldWinners: resolvedWinners,
      },
    });

    // Settle the conflict cards this merge resolved, AWAITED: both cards'
    // "Review & merge..." open this modal and reload the conflict queue on
    // success, and a card still listed after the merge it asked for reads as a
    // merge that did not happen. A failure here must not fail a merge that
    // already committed — the sweeps stay the backstop.
    //
    // Duplicate-ip (rule 40(i)): re-evaluate the survivor's address AND the
    // absorbed asset's old one — when the survivor kept a different address,
    // the card being resolved is about the absorbed row's, which checking only
    // the survivor would never look at.
    try {
      const survivorAfter = await prisma.asset.findUnique({
        where: { id: result.survivorId },
        select: { ipAddress: true },
      });
      await reconcileDuplicateIpForAddresses([survivorAfter?.ipAddress, absorbedBefore.ipAddress]);
    } catch (err) {
      logger.warn({ err, survivorId: result.survivorId }, "Duplicate-ip conflict reconcile after merge failed");
    }
    // Duplicate-serial (rule 83).
    try {
      await settleDuplicateSerialConflictsAfterMerge({
        survivorAssetId: result.survivorId,
        absorbedAssetId: result.absorbedId,
        survivorLabel: survivorBefore.hostname || result.survivorId,
        actor: requestActor(req),
      });
    } catch (err) {
      logger.warn({ err, survivorId: result.survivorId }, "Duplicate-serial conflict settle after merge failed");
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
