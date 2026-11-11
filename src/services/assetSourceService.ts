/**
 * src/services/assetSourceService.ts — the asset details Sources tab's server
 * half: the per-discovery-source view, splitting one source off into a new
 * asset, and the operator-driven merge with its audit Event and conflict
 * settling. Moved out of routes/assets/sources.ts (CQ-B062 slice 2); the route
 * keeps only validation and the "this" / "other" -> canonical / ghost
 * translation of the merge body.
 *
 * The merge orchestration lives here and not in assetMergeService because the
 * duplicate-ip and duplicate-serial conflict services import assetMergeService,
 * and this function calls both of them.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { reconcileDuplicateIpForAddresses, repointDuplicateIpConflicts } from "./duplicateIpConflictService.js";
import { repointDuplicateSerialConflicts, settleDuplicateSerialConflictsAfterMerge } from "./duplicateSerialConflictService.js";
import { mergeAssets, type MergeableField, type FieldWinner, type MergeAssetsResult } from "./assetMergeService.js";
import { projectAssetFromSources } from "../utils/assetProjection.js";
import { deriveAssetSourceState } from "../utils/assetSourceState.js";
import { assetTypeForWorkloadRole, parseWorkloadSourceKind } from "../utils/workloadSources.js";
import { assertAssetExists } from "./assetDetailReadService.js";

/**
 * Every AssetSource row of an asset with the originating integration joined
 * in, in a stable presentation order and collapsed to one row per
 * (sourceKind, integration). 404 when the asset does not exist.
 */
export async function listAssetSourcesForDisplay(id: string) {
  await assertAssetExists(id);

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
    "snmp-identity": 8,
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

  return deduped.map((r) => ({
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
  }));
}

/**
 * Detach one AssetSource from an asset onto a freshly created Asset seeded
 * from that source's observed blob (POST /assets/:id/sources/:sourceId/split).
 * 404 for an unknown asset or a source not on it; 409 for a manual source or
 * the asset's only source. Writes the asset.split Event.
 */
export async function splitAssetSource(id: string, sourceId: string, actor: string | undefined) {
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
    statusChangedBy: actor || "system",
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
    createdBy: actor || null,
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
    actor,
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


  return {
    originalAssetId: id,
    newAssetId: result.newAsset.id,
    movedSourceId: target.id,
    newAsset: result.newAsset,
  };
}

/**
 * The operator merge (POST /assets/:id/merge) once the route has resolved
 * survivor (canonical) and absorbed (ghost): move the conflict cards filed on
 * the absorbed row, merge, write the asset.merged Event, then settle the
 * duplicate-ip / duplicate-serial cards the merge resolved. 404 when either
 * asset is missing.
 */
export async function mergeAssetsAudited(input: {
  canonicalId: string;
  ghostId: string;
  fieldWinners: Partial<Record<MergeableField, FieldWinner>>;
  dependencyWinner: "canonical" | "ghost" | undefined;
  canManageIntegrations: boolean;
  actor: string | undefined;
}): Promise<MergeAssetsResult> {
  const { canonicalId, ghostId, fieldWinners, dependencyWinner, canManageIntegrations, actor } = input;
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
    fieldWinners,
    dependencyWinner,
    canManageIntegrations,
  });

  await logEvent({
    action: "asset.merged",
    resourceType: "asset",
    resourceId: result.survivorId,
    resourceName: survivorBefore.hostname || undefined,
    actor,
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
      dependencyWinner: dependencyWinner ?? null,
      appliedFields: result.appliedFields,
      fieldWinners,
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
      actor,
    });
  } catch (err) {
    logger.warn({ err, survivorId: result.survivorId }, "Duplicate-serial conflict settle after merge failed");
  }

  return result;
}
