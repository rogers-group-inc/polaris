/**
 * src/services/conflictResolutionService.ts — discovery conflict resolution engine
 *
 * Extracted VERBATIM from src/api/routes/conflicts.ts (2026-08 audit — Layer
 * Violations: the accept/reject/merge resolution logic, the ghost-absorb
 * transaction, and the list/count reads lived inline in a route file outside
 * the documented inline-Prisma exemption). The route retains only the
 * request-derived concerns: role-based visibility (visibleEntityTypes) and
 * resolve gating (canResolve); every function here takes plain inputs
 * (conflict row / id, actor username, entity-type list) and throws the same
 * AppErrors the handlers threw, so route error responses are byte-identical.
 *
 * Two entityType variants share this engine:
 *   • "reservation" — discovery proposes changes to a manually-created reservation.
 *     Accept applies the proposed values; reject dismisses.
 *   • "asset" — discovery proposes a new Entra/Intune- or AD-sourced asset
 *     whose hostname collides with another asset. Three flavours, distinguished
 *     by `proposedAssetFields.collisionReason`:
 *       - "untagged-collision"     — collides with an untagged asset
 *       - "duplicate-registration" — collides with another asset already
 *         tagged by the same source (different deviceId / objectGUID for the
 *         same hostname — re-enrol, re-image, dual-boot, re-domain-join)
 *     `proposedAssetFields.matchedVia` is "exact" or "netbios" (the latter
 *     when matching required truncating one side to the 15-char NetBIOS
 *     limit). Accept adopts the existing asset (sets assetTag to
 *     `entra:{deviceId}` / `ad:{guid}` and overlays empty fields; on a
 *     netbios match the longer canonical hostname replaces the truncated
 *     one); reject creates a separate asset (admin confirmed they're
 *     different devices).
 *     Sibling variant (`proposedAssetFields.bothAssetsExist`, raised by the
 *     Entra + vCenter sibling checks): the proposed device ALREADY has its
 *     own asset. Accept still merges — the ghost-absorb below moves the
 *     duplicate's fields/MACs onto the collision target and deletes it —
 *     but reject creates NOTHING (both assets stand; the resolved conflict
 *     row suppresses a re-raise).
 *       - "duplicate-ip"           — two (or more) network-present assets
 *         record the SAME `Asset.ipAddress` (raised by
 *         duplicateIpConflictService's sweep; business rule 40). Accept has no
 *         meaning here — there is nothing to adopt — so it is REFUSED; the
 *         resolution verb is `POST /conflicts/:id/reassign-ip`, which gives one
 *         member a new address. Reject = dismiss (the same member set won't
 *         re-raise). `proposedAssetFields.members[]` carries every claimant.
 *       - "serial-two-controllers" — one managed device (FortiSwitch /
 *         FortiAP) is on the managed roster of TWO controller FortiGates at
 *         once, so whichever integration ran discovery last owns its record
 *         (raised by duplicateSerialConflictService's sweep; business rule 83).
 *         REPORT-ONLY: accept is refused and there is no resolution verb — the
 *         fix is on the gates. Reject dismisses, keyed on the claimant set.
 *         `proposedAssetFields.claimants[]` carries every claiming gate.
 *       - "duplicate-serial"       — two (or more) Asset rows carry the same
 *         serial number, i.e. one device recorded twice (same sweep, same
 *         rule). Accept is refused; the verb is `POST /conflicts/:id/merge`,
 *         which absorbs the duplicates through the shared merge engine.
 *         `proposedAssetFields.members[]` carries every record.
 *       - "ip-override"            — a discovery write proposed an IP that
 *         differs from the asset's operator IP pin (Asset.ipOverride; raised
 *         by ipOverrideService). Accept adopts the discovered IP and releases
 *         the pin; reject keeps the pin (the same discovered IP won't
 *         re-raise). No proposedDeviceId / AssetSource identity involved.
 *
 *   entityType "subnet" — the third entity, added with business rule 41.
 *     Payload lives on `proposedSubnetFields` (its own column; the asset
 *     variants' `proposedAssetFields` would be a lie about what it holds).
 *       - "chassis-replaced"       — the FortiGate serving this subnet answered
 *         with a serial that is neither the stored one nor any member of its HA
 *         cluster, i.e. the physical box was swapped (raised by
 *         subnetChassisConflictService from discovery Phase 1). The old
 *         chassis's subnet + reservations are COPIED into the archive tables
 *         first, so raising destroys nothing. Accept adopts the new chassis
 *         (stamps `Subnet.fortigateSerial`, after which the next run reads the
 *         same serial and nothing re-raises); reject dismisses, and the
 *         rejected row is the dedup marker for that exact (old, new) serial
 *         pair. Dedup is keyed on the PAIR, not the subnet, so a box swapped
 *         twice raises again.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { ENTRA_ASSET_TAG_PREFIX, AD_ASSET_TAG_PREFIX } from "../utils/assetSourceTags.js";
import { logEvent } from "./eventLogService.js";
import { clampAcquiredToLastSeen, bumpLastSeen } from "../utils/assetInvariants.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { MAC_ROW_SELECT } from "../utils/macAddresses.js";
import {
  absorbAssetRelations,
  resolveMonitoringCarry,
  type AbsorbedRelationCounts,
} from "./assetMergeService.js";
import { recomputeMonitorOverrideForAssets } from "./monitorOverrideService.js";
import {
  DUPLICATE_IP_COLLISION_REASON,
  logDuplicateIpDismissal,
} from "./duplicateIpConflictService.js";
import {
  SERIAL_CLAIM_COLLISION_REASON,
  DUPLICATE_SERIAL_COLLISION_REASON,
  logSerialClaimDismissal,
  logDuplicateSerialDismissal,
} from "./duplicateSerialConflictService.js";
import {
  acceptChassisReplacement,
  rejectChassisReplacement,
} from "./subnetChassisConflictService.js";

// Shared with the discovery sync that writes these tags — see
// src/utils/assetSourceTags.ts (imported at the top of this file).

function assetTagPrefixFor(proposed: Record<string, any>): string {
  // Newer conflicts carry the prefix explicitly; older Entra-only conflicts
  // predate the field and default to the Entra prefix.
  const explicit = typeof proposed.assetTagPrefix === "string" ? proposed.assetTagPrefix : "";
  if (explicit === AD_ASSET_TAG_PREFIX || explicit === ENTRA_ASSET_TAG_PREFIX) return explicit;
  return ENTRA_ASSET_TAG_PREFIX;
}

// Which discovery source raised this asset conflict. vCenter conflicts carry
// `sourceType: "vcenter"` in proposedAssetFields (with assetType
// discriminating VM vs ESXi host) and Azure Arc conflicts `sourceType:
// "azurearc"`; AD/Entra keep the legacy tag-prefix convention via
// assetTagPrefixFor.
type AssetConflictSource = "ad" | "entra" | "vcenter-vm" | "vcenter-host" | "arc";
function conflictSourceFor(proposed: Record<string, any>): AssetConflictSource {
  if (proposed.sourceType === "vcenter") {
    return proposed.assetType === "hypervisor" ? "vcenter-host" : "vcenter-vm";
  }
  if (proposed.sourceType === "azurearc") return "arc";
  return assetTagPrefixFor(proposed) === AD_ASSET_TAG_PREFIX ? "ad" : "entra";
}

function conflictSourceLabel(src: AssetConflictSource): string {
  switch (src) {
    case "ad":           return "Active Directory computer";
    case "entra":        return "Entra device";
    case "vcenter-vm":   return "vCenter VM";
    case "vcenter-host": return "vCenter ESXi host";
    case "arc":          return "Azure Arc machine";
  }
}

// ─── Reads (route GET handlers delegate here) ────────────────────────────────

// List conflicts for GET /api/v1/conflicts. entityTypes comes from the
// route's role-based visibility resolution (visibleEntityTypes).
export type ConflictEntityType = "reservation" | "asset" | "subnet";

export async function listConflicts(
  entityTypes: ConflictEntityType[],
  status: string,
  limit: number,
  offset: number,
): Promise<{ conflicts: any[]; total: number }> {
  const where: any = { entityType: { in: entityTypes } };
  if (status !== "all") where.status = status;

  const [conflicts, total] = await Promise.all([
    prisma.conflict.findMany({
      where,
      include: {
        reservation: { include: { subnet: { include: { block: true } } } },
        asset: true,
        // Business rule 41's chassis-replacement variant renders from the live
        // subnet plus `proposedSubnetFields`; the per-address diff is a
        // separate read (see buildChassisDiff on why it is not snapshotted).
        subnet: { include: { block: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
    }),
    prisma.conflict.count({ where }),
  ]);

  for (const c of conflicts) {
    if (c.entityType !== "asset") continue;
    const proposed = c.proposedAssetFields as Record<string, any> | null;
    const raw = proposed?.manufacturer;
    if (typeof raw === "string") {
      const normalized = normalizeManufacturer(raw);
      if (normalized && normalized !== raw) proposed!.manufacturer = normalized;
    }
  }

  return { conflicts, total };
}

// Pending count for GET /api/v1/conflicts/count (nav badge), scoped by the
// route's role-based entity-type visibility.
export async function countPendingConflicts(
  entityTypes: ConflictEntityType[],
): Promise<number> {
  return prisma.conflict.count({
    where: { status: "pending", entityType: { in: entityTypes } },
  });
}

// ─── Resolution entry points ─────────────────────────────────────────────────

// Load a conflict for resolution (accept / merge / reject). Throws the same
// 404 / 409 the route handlers threw; the route checks canResolve on the
// returned row's entityType before calling a resolve function below.
export async function loadPendingConflict(id: string): Promise<any> {
  const conflict = await prisma.conflict.findUnique({
    where: { id },
    include: { reservation: true, asset: { include: { macAddressRows: { select: MAC_ROW_SELECT } } } },
  });
  if (!conflict) throw new AppError(404, "Conflict not found");
  if (conflict.status !== "pending") throw new AppError(409, "Conflict is already resolved");
  return conflict;
}

// POST /api/v1/conflicts/:id/accept
export async function acceptConflict(conflict: any, actor?: string): Promise<void> {
  if (conflict.entityType === "asset") {
    await acceptAssetConflict(conflict, actor, {});
  } else if (conflict.entityType === "subnet") {
    // Business rule 41: adopting a replacement chassis. Stamps the new serial
    // onto the subnet so the next discovery pass reads `same`; per-reservation
    // migration is a separate, explicit action.
    await acceptChassisReplacement(conflict, actor);
  } else {
    await acceptReservationConflict(conflict, actor);
  }

  await prisma.conflict.update({
    where: { id: conflict.id },
    data: { status: "accepted", resolvedBy: actor ?? null, resolvedAt: new Date() },
  });
}

// POST /api/v1/conflicts/:id/merge — asset conflicts only; per-field winner
// selection (fieldWinners already sanitized by the route). Resolves the
// conflict the same way Accept does: stamps the AssetSource row, absorbs
// ghost assets, marks status accepted.
export async function mergeAssetConflict(
  conflict: any,
  actor: string | undefined,
  fieldWinners: Record<string, "existing" | "proposed">,
): Promise<void> {
  await acceptAssetConflict(conflict, actor, fieldWinners);

  await prisma.conflict.update({
    where: { id: conflict.id },
    data: { status: "accepted", resolvedBy: actor ?? null, resolvedAt: new Date() },
  });
}

// POST /api/v1/conflicts/:id/reject
export async function rejectConflict(conflict: any, actor?: string): Promise<void> {
  if (conflict.entityType === "asset") {
    await rejectAssetConflict(conflict, actor);
  } else if (conflict.entityType === "subnet") {
    // The rejected row is the dedup marker for this exact serial pair.
    await rejectChassisReplacement(conflict, actor);
  } else {
    await rejectReservationConflict(conflict, actor);
  }

  await prisma.conflict.update({
    where: { id: conflict.id },
    data: { status: "rejected", resolvedBy: actor ?? null, resolvedAt: new Date() },
  });
}

// ─── Handlers — Reservation ──────────────────────────────────────────────────

async function acceptReservationConflict(conflict: any, actor?: string) {
  if (!conflict.reservation || !conflict.reservationId) {
    throw new AppError(500, "Reservation conflict is missing its reservation link");
  }
  const existing = conflict.reservation;
  // Merge mode: VIP + DHCP collision (neither side is a manual reservation).
  // Final sourceType is "vip" (load-bearing FortiGate config). Existing fields
  // that are non-empty are preserved; blanks get filled from the proposed
  // values. vipInfo + macAddress were already populated by discovery before
  // the conflict was raised, so we don't touch them here.
  const isMergeMode = existing.sourceType !== "manual";
  const updateData: Record<string, unknown> = {};

  if (isMergeMode) {
    if (!existing.hostname && conflict.proposedHostname) updateData.hostname = conflict.proposedHostname;
    if (!existing.owner && conflict.proposedOwner) updateData.owner = conflict.proposedOwner;
    if (!existing.projectRef && conflict.proposedProjectRef) updateData.projectRef = conflict.proposedProjectRef;
    if (!existing.notes && conflict.proposedNotes) updateData.notes = conflict.proposedNotes;
    if (existing.sourceType !== "vip") updateData.sourceType = "vip";
  } else {
    for (const field of conflict.conflictFields as string[]) {
      if (field === "hostname") updateData.hostname = conflict.proposedHostname;
      if (field === "owner") updateData.owner = conflict.proposedOwner;
      if (field === "projectRef") updateData.projectRef = conflict.proposedProjectRef;
      if (field === "notes") updateData.notes = conflict.proposedNotes;
    }
    if (conflict.proposedSourceType) updateData.sourceType = conflict.proposedSourceType;
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.reservation.update({
      where: { id: conflict.reservationId },
      data: updateData,
    });
  }

  logEvent({
    action: "conflict.accepted",
    resourceType: "reservation",
    resourceId: conflict.reservationId,
    resourceName: existing.ipAddress ?? undefined,
    actor,
    message: isMergeMode
      ? `Conflict merged for reservation ${existing.ipAddress} — folded ${conflict.proposedSourceType || "discovered"} metadata into VIP record`
      : `Conflict accepted for reservation ${existing.ipAddress} — applied discovered values (${(conflict.conflictFields as string[]).join(", ")})`,
  });
}

async function rejectReservationConflict(conflict: any, actor?: string) {
  if (!conflict.reservation || !conflict.reservationId) return;
  logEvent({
    action: "conflict.rejected",
    resourceType: "reservation",
    resourceId: conflict.reservationId,
    resourceName: conflict.reservation.ipAddress ?? undefined,
    actor,
    message: `Conflict rejected for reservation ${conflict.reservation.ipAddress} — existing values kept`,
  });
}

// ─── Handlers — Asset ────────────────────────────────────────────────────────

async function acceptAssetConflict(
  conflict: any,
  actor?: string,
  fieldWinners: Record<string, "existing" | "proposed"> = {},
) {
  if (!conflict.asset || !conflict.assetId) {
    throw new AppError(500, "Asset conflict is missing its asset link");
  }
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, any>;
  // IP-override conflicts (operator pin vs discovery, raised by
  // ipOverrideService) are a single-field disagreement with no source
  // identity involved — they take their own narrow path. Merge-with-
  // field-winners degenerates to a plain accept.
  if (proposed.collisionReason === "ip-override") {
    await acceptIpOverrideConflict(conflict, actor);
    return;
  }
  // Duplicate-address conflicts have no proposed values to adopt — accepting
  // one would mark it resolved while both assets still answer to the address.
  // The resolution is POST /conflicts/:id/reassign-ip (or Reject to dismiss).
  if (proposed.collisionReason === DUPLICATE_IP_COLLISION_REASON) {
    throw new AppError(
      400,
      "A duplicate IP conflict is resolved by assigning a new address to one of the assets, or dismissed with Reject",
    );
  }
  // Two gates claiming one device (business rule 83) is REPORT-ONLY: there is
  // no proposed record to adopt, and Polaris deliberately does not pick a
  // winner — whether this is a completed move or a stale roster entry is a
  // fact about the FortiGates' configuration, and the fix lives there. Reject
  // dismisses the card; the sweep closes it on its own once one gate stops
  // reporting the device.
  if (proposed.collisionReason === SERIAL_CLAIM_COLLISION_REASON) {
    throw new AppError(
      400,
      "A contested serial is resolved on the FortiGates — remove the device from the roster of whichever gate no longer owns it. Dismiss the card with Reject.",
    );
  }
  // Two records of one device: nothing to adopt either, but there IS a verb —
  // POST /conflicts/:id/merge absorbs the duplicates into one asset.
  if (proposed.collisionReason === DUPLICATE_SERIAL_COLLISION_REASON) {
    throw new AppError(
      400,
      "A duplicate serial conflict is resolved by merging the records into one asset, or dismissed with Reject",
    );
  }
  if (!conflict.proposedDeviceId) {
    throw new AppError(500, "Asset conflict is missing proposedDeviceId");
  }

  const existing = conflict.asset;
  const src = conflictSourceFor(proposed);
  const isAd = src === "ad";
  const isVcenter = src === "vcenter-vm" || src === "vcenter-host";
  const isArc = src === "arc";
  const sourceLabel = conflictSourceLabel(src);

  // Per-field merge. fieldWinners (from POST /:id/merge) overrides the default
  // logic per field: "proposed" = write proposed value, "existing" = keep
  // current. Fields not present in fieldWinners fall back to today's behavior
  // (blank-fill for most, always-overwrite for os/osVersion, NetBIOS upgrade
  // for hostname). Phase 4d: assetTag is no longer the source-of-truth
  // identity link; AssetSource (sourceKind+externalId) is. The AssetSource
  // row is upserted at the end of this function regardless of fieldWinners.
  const update: Record<string, unknown> = {};
  // Hostname default: NetBIOS-upgrade rule — when the conflict was raised via
  // 15-char NetBIOS truncation, prefer the longer canonical form even if the
  // existing hostname is non-empty.
  const existingHostLower = (existing.hostname || "").toLowerCase();
  const proposedHostLower = (proposed.hostname || "").toLowerCase();
  const isNetbiosUpgrade =
    proposed.matchedVia === "netbios" &&
    proposedHostLower.length > existingHostLower.length &&
    existingHostLower.length > 0 &&
    proposedHostLower.startsWith(existingHostLower);
  const hostnameWinner = fieldWinners.hostname
    ?? ((!existing.hostname && proposed.hostname) || isNetbiosUpgrade ? "proposed" : "existing");
  if (hostnameWinner === "proposed" && proposed.hostname) update.hostname = proposed.hostname;

  const blankFill = (field: string) => {
    const winner = fieldWinners[field] ?? (!existing[field] && proposed[field] ? "proposed" : "existing");
    if (winner === "proposed" && proposed[field]) update[field] = proposed[field];
  };
  blankFill("serialNumber");
  blankFill("macAddress");
  blankFill("manufacturer");
  blankFill("model");
  blankFill("assignedTo");
  // os/osVersion default to always-overwrite (proposed wins) — auto-discovered
  // from Entra/AD, not user-entered, so the source is normally authoritative.
  // The picker can still flip them to "existing" to opt out.
  const osWinner = fieldWinners.os ?? "proposed";
  if (osWinner === "proposed" && proposed.os) update.os = proposed.os;
  const osVersionWinner = fieldWinners.osVersion ?? "proposed";
  if (osVersionWinner === "proposed" && proposed.osVersion) update.osVersion = proposed.osVersion;
  if (!existing.dnsName && proposed.dnsName) update.dnsName = proposed.dnsName;
  if (!existing.location && !existing.learnedLocation && proposed.learnedLocation) update.learnedLocation = proposed.learnedLocation;
  if (!existing.notes && proposed.notes) update.notes = proposed.notes;
  if (proposed.lastSeen) bumpLastSeen(update, existing, new Date(proposed.lastSeen), "conflict-accept");
  if (!existing.acquiredAt && proposed.registrationDateTime) {
    update.acquiredAt = new Date(proposed.registrationDateTime);
  }
  if (existing.assetType === "other" && proposed.assetType) update.assetType = proposed.assetType;
  if (isAd && proposed.disabled === true) {
    update.status = "decommissioned";
    update.statusChangedAt = new Date();
    update.statusChangedBy = actor ?? "system";
  }

  // Merge tags — keep existing manual tags, add source-specific descriptive
  // tags. Phase 4b retired the cross-integration identity tags
  // (sid:* / ad-guid:*); identity now lives on AssetSource. Phase 4e
  // retired the prev-* breadcrumb tags here too — there is no longer a
  // prior assetTag to breadcrumb against, since accept doesn't write
  // assetTag.
  const sourceTags: string[] = isVcenter
    ? ["vcenter", "auto-discovered"]
    : isArc ? ["azurearc", "auto-discovered"]
    : isAd ? ["activedirectory", "auto-discovered"] : ["entraid", "auto-discovered"];
  if (isArc) {
    if (proposed.arcStatus && String(proposed.arcStatus).toLowerCase() !== "connected") {
      sourceTags.push(`arc-${String(proposed.arcStatus).toLowerCase()}`);
    }
  } else if (isAd) {
    if (proposed.disabled === true) sourceTags.push("ad-disabled");
  } else if (!isVcenter) {
    if (proposed.trustType) sourceTags.push(String(proposed.trustType).toLowerCase());
    if (proposed.complianceState) sourceTags.push(`intune-${String(proposed.complianceState).toLowerCase()}`);
  }
  const existingTags = (existing.tags as string[] | null) || [];
  const merged = [...existingTags];
  for (const t of sourceTags) { if (!merged.includes(t)) merged.push(t); }
  update.tags = merged;

  // When the sibling-check path fires (both devices already have their own
  // Polaris assets), there will be a "ghost" asset carrying the proposed
  // source's AssetSource row. Two assets can't both own a row with the
  // same (sourceKind, externalId) because of the unique constraint —
  // before we upsert at the bottom, find the ghost (if any), merge its
  // non-empty fields into the accept target, then delete it so the
  // accept target becomes the single canonical record.
  //
  // The ghost is a REAL multi-source asset, not a placeholder: it commonly
  // carries discovery sources the accept target knows nothing about (the
  // reported case: an AD-only target absorbing a ghost that held
  // entra + intune + fortigate-endpoint + vcenter-vm). Letting the delete
  // cascade those rows away silently destroyed provenance the operator was
  // told the merge would "combine" — so the ghost's relations are RE-BOUND
  // onto the target via the shared `absorbAssetRelations`, exactly like the
  // operator-driven Sources-tab merge. Monitoring intent rides along the
  // same way.
  const sourceKind = src;
  // AD/Entra ids are case-normalized to lowercase everywhere; vCenter
  // externalIds (instanceUuid or `${integrationId}:${moref}`) must match the
  // sync's key verbatim.
  const externalId = isVcenter
    ? String(conflict.proposedDeviceId)
    : String(conflict.proposedDeviceId).toLowerCase();
  const existingSourceForId = await prisma.assetSource.findUnique({
    where: { sourceKind_externalId: { sourceKind, externalId } },
    include: { asset: { include: { macAddressRows: { select: MAC_ROW_SELECT } } } },
  });
  const ghost: any = (existingSourceForId && existingSourceForId.assetId !== existing.id)
    ? existingSourceForId.asset
    : null;
  let absorbed: AbsorbedRelationCounts | null = null;
  let monitorFieldsAdopted: string[] = [];
  let carriedMonitoring = false;
  if (ghost) {
    // Absorb any fields from the ghost that the accept target is still missing.
    // Blank-fill only — the conflict's own field winners (resolved above from
    // `proposed`) always outrank the ghost's row.
    const blankFillFromGhost = (field: string) => {
      if (!update[field] && !existing[field] && ghost[field]) update[field] = ghost[field];
    };
    blankFillFromGhost("serialNumber");
    blankFillFromGhost("macAddress");
    blankFillFromGhost("manufacturer");
    blankFillFromGhost("model");
    blankFillFromGhost("assignedTo");
    blankFillFromGhost("notes");
    // The ghost is usually the side discovery actually reached, so it's the one
    // holding the live address / DNS name / location. An empty accept target
    // must not come out of the merge with no IP at all. (`ipAddress` respects
    // the operator pin the same way every other writer does — the db.ts guard
    // re-asserts `ipOverride` over this write.)
    blankFillFromGhost("ipAddress");
    blankFillFromGhost("dnsName");
    blankFillFromGhost("learnedLocation");
    // Connection facts — they also re-derive the endpoint dependency edge
    // (resolveEndpointParent reads lastSeenSwitch → lastSeenAp → sightings).
    blankFillFromGhost("lastSeenSwitch");
    blankFillFromGhost("lastSeenAp");
    blankFillFromGhost("snmpLocation");
    blankFillFromGhost("learnedAddress");
    blankFillFromGhost("department");
    blankFillFromGhost("location");
    blankFillFromGhost("purchaseOrder");
    blankFillFromGhost("acquiredAt");
    blankFillFromGhost("warrantyExpiry");
    if (!update.os && ghost.os) update.os = ghost.os;
    if (!update.osVersion && ghost.osVersion) update.osVersion = ghost.osVersion;
    if (!update.assetType && existing.assetType === "other" && ghost.assetType) {
      update.assetType = ghost.assetType;
    }
    // lastSeen — keep the more recent, carrying the ghost's provenance label.
    // Routed through bumpLastSeen so rule 12's no-regress + polling-authority
    // deferral still apply to the absorbed evidence.
    if (ghost.lastSeen) {
      bumpLastSeen(update, existing, ghost.lastSeen, ghost.lastSeenSource || "conflict-accept");
    }
    // Tags — union the ghost's on top of the source tags resolved above, so the
    // survivor keeps the ghost's source labels (entraid / vcenter / …).
    const tagsSoFar = Array.isArray(update.tags) ? (update.tags as string[]) : [];
    const ghostTags = Array.isArray(ghost.tags) ? (ghost.tags as string[]) : [];
    if (ghostTags.length > 0) {
      const have = new Set(tagsSoFar);
      const withGhost = [...tagsSoFar];
      for (const t of ghostTags) {
        if (!have.has(t)) {
          withGhost.push(t);
          have.add(t);
        }
      }
      if (withGhost.length > tagsSoFar.length) update.tags = withGhost;
    }
    // Monitoring is an explicit operator choice — absorbing a monitored ghost
    // must not silently stop polling the device.
    const carry = resolveMonitoringCarry(update, existing, ghost);
    carriedMonitoring = carry.carried;
    monitorFieldsAdopted = carry.adopted;
  }

  clampAcquiredToLastSeen(update, existing);

  if (ghost) {
    // One transaction: re-bind the ghost's sources / side tables / agent
    // enrollment onto the accept target, apply the merged fields, then delete
    // the ghost. Everything re-bound first so the delete can't cascade it away.
    await prisma.$transaction(async (tx) => {
      absorbed = await absorbAssetRelations(tx, ghost.id, existing.id);
      await tx.asset.update({ where: { id: existing.id }, data: update });
      await tx.asset.delete({ where: { id: ghost.id } });
    });
    // Keep monitorOverride faithful to the carried-over monitoring intent —
    // best-effort, a recompute failure must not undo the merge.
    if (carriedMonitoring) {
      try {
        await recomputeMonitorOverrideForAssets(prisma, [existing.id]);
      } catch {
        /* swallowed — see above */
      }
    }
  } else {
    await prisma.asset.update({
      where: { id: existing.id },
      data: update,
    });
  }

  // Stamp the AssetSource row that ties this asset to the conflict's
  // entra/ad identity. This replaces the legacy `assetTag = entra:<id>`
  // marker — discovery's re-discovery uses AssetSource.externalId as the
  // primary key (see buildEntraSyncIndex / buildAdSyncIndex), so writing
  // the source row here is what makes the asset findable on the next
  // sync. The observed blob is built from the conflict's snapshot; the next
  // discovery run replaces it with a richer canonical version. In the ghost
  // flavour the row already exists and was just re-bound above, so this lands
  // on the upsert's UPDATE branch — which deliberately doesn't touch
  // `observed`, leaving the ghost's full discovery blob intact instead of
  // flattening it to the snapshot.
  await upsertConflictAssetSource(existing.id, conflict, proposed, src);

  // Spell out what came across, so the audit trail shows the survivor really
  // did inherit the duplicate's provenance rather than silently losing it.
  let ghostNote = "";
  if (ghost) {
    const a = absorbed as AbsorbedRelationCounts | null;
    const moved: string[] = [];
    if (a) {
      if (a.movedSources) moved.push(`${a.movedSources} source row(s)`);
      if (a.movedMacs) moved.push(`${a.movedMacs} MAC(s)`);
      if (a.movedIps) moved.push(`${a.movedIps} associated IP(s)`);
      if (a.movedIpHistory) moved.push(`${a.movedIpHistory} IP history row(s)`);
      if (a.movedSightings) moved.push(`${a.movedSightings} firewall sighting(s)`);
      if (a.movedManagedAgent) moved.push("agent enrollment");
    }
    if (carriedMonitoring) {
      moved.push(
        monitorFieldsAdopted.length > 0
          ? `monitoring (with ${monitorFieldsAdopted.length} config field(s))`
          : "monitoring",
      );
    }
    ghostNote = ` (absorbed and removed ghost asset ${ghost.id}${moved.length ? ` — carried over ${moved.join(", ")}` : ""})`;
  }
  const winnerEntries = Object.entries(fieldWinners);
  const mergeNote = winnerEntries.length > 0
    ? ` (merged with selections: ${winnerEntries.map(([k, v]) => `${k}=${v}`).join(", ")})`
    : "";
  logEvent({
    action: "conflict.accepted",
    resourceType: "asset",
    resourceId: existing.id,
    resourceName: existing.hostname ?? undefined,
    actor,
    message: `Asset conflict accepted — adopted existing asset ${existing.hostname || existing.id} as ${sourceLabel} ${conflict.proposedDeviceId}${ghostNote}${mergeNote}`,
  });
}

// ─── Handlers — IP-override conflicts ────────────────────────────────────────
// Raised by src/services/ipOverrideService.ts when a discovery write proposes
// an IP that differs from the operator pin (Asset.ipOverride).

// Accept = take discovery's side: write the discovered IP as the live address
// and release the pin. Both fields are staged in one write so the db.ts
// override guard treats it as an authoritative operator write.
async function acceptIpOverrideConflict(conflict: any, actor?: string) {
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, any>;
  const discoveredIp = typeof proposed.ipAddress === "string" && proposed.ipAddress ? proposed.ipAddress : null;
  if (!discoveredIp) {
    throw new AppError(500, "IP-override conflict is missing its proposed IP");
  }
  await prisma.asset.update({
    where: { id: conflict.assetId },
    data: {
      ipAddress: discoveredIp,
      ipOverride: null,
      ipSource: typeof proposed.ipSource === "string" && proposed.ipSource ? proposed.ipSource : "discovery",
    },
  });
  const label = conflict.asset?.hostname || discoveredIp;
  logEvent({
    action: "conflict.accepted",
    resourceType: "asset",
    resourceId: conflict.assetId,
    resourceName: label,
    actor,
    message: `IP override conflict accepted on "${label}" — adopted discovered address ${discoveredIp}, released the override (was ${proposed.overrideIp ?? "unknown"})`,
  });
}

// Reject = keep the pin. No asset write — the guard already re-asserted the
// override on every discovery cycle. The rejected row doubles as the dedup
// marker: ipOverrideService won't re-raise for this same discovered IP.
async function rejectIpOverrideConflict(conflict: any, actor?: string) {
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, any>;
  const label = conflict.asset?.hostname || proposed.overrideIp || conflict.assetId;
  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: conflict.assetId,
    resourceName: label,
    actor,
    message: `IP override conflict rejected on "${label}" — kept pinned address ${proposed.overrideIp ?? "unknown"}; discovered ${proposed.ipAddress ?? "unknown"} dismissed (the same address won't re-raise)`,
  });
}

async function rejectAssetConflict(conflict: any, actor?: string) {
  const proposedForKind = (conflict.proposedAssetFields || {}) as Record<string, any>;
  if (proposedForKind.collisionReason === "ip-override") {
    await rejectIpOverrideConflict(conflict, actor);
    return;
  }
  // Duplicate address, dismissed: both assets keep the address. The resolved
  // row is the dedup marker — the sweep re-raises only if the member set moves.
  if (proposedForKind.collisionReason === DUPLICATE_IP_COLLISION_REASON) {
    logDuplicateIpDismissal(conflict, actor);
    return;
  }
  // Contested serial, dismissed: both gates keep the device on their roster
  // and discovery carries on as before (report-only — business rule 83). The
  // resolved row is the dedup marker, keyed on the CLAIMANT set, so the same
  // two gates stay quiet while a third one arriving raises anew.
  if (proposedForKind.collisionReason === SERIAL_CLAIM_COLLISION_REASON) {
    logSerialClaimDismissal(conflict, actor);
    return;
  }
  // Duplicate records, dismissed: the operator says these really are two
  // devices that report one serial. Same dedup model, keyed on the member set.
  if (proposedForKind.collisionReason === DUPLICATE_SERIAL_COLLISION_REASON) {
    logDuplicateSerialDismissal(conflict, actor);
    return;
  }
  if (!conflict.proposedDeviceId) {
    throw new AppError(500, "Asset conflict is missing proposedDeviceId");
  }
  const proposed = (conflict.proposedAssetFields || {}) as Record<string, any>;
  const src = conflictSourceFor(proposed);
  const isAd = src === "ad";
  const isVcenter = src === "vcenter-vm" || src === "vcenter-host";
  const isArc = src === "arc";
  const sourceLabel = conflictSourceLabel(src);

  // Sibling flavour — the proposed device ALREADY has its own asset (its
  // (sourceKind, externalId) AssetSource row exists; raised by the discovery
  // sibling checks with `bothAssetsExist`). Reject means "they really are two
  // devices": record the decision and stop. Creating an asset here would mint
  // a duplicate AND the upsert below would steal the source row off the
  // device's real asset, orphaning it. The resolved conflict row itself is
  // what suppresses a re-raise (upsertAssetConflict's resolved-pair check).
  {
    const rejectExternalId = isVcenter
      ? String(conflict.proposedDeviceId)
      : String(conflict.proposedDeviceId).toLowerCase();
    const alreadyOwned = await prisma.assetSource.findUnique({
      where: { sourceKind_externalId: { sourceKind: src, externalId: rejectExternalId } },
      select: { assetId: true },
    });
    if (alreadyOwned) {
      logEvent({
        action: "conflict.rejected",
        resourceType: "asset",
        resourceId: alreadyOwned.assetId,
        resourceName: proposed.hostname ?? undefined,
        actor,
        message: `Asset conflict rejected — kept ${sourceLabel} ${conflict.proposedDeviceId} and asset ${conflict.asset?.hostname || conflict.assetId} as separate assets (both already exist; nothing created)`,
      });
      return;
    }
  }

  // Phase 4b/4d: cross-integration identity tags (sid:* / ad-guid:*) and
  // the assetTag identity marker are no longer written here. The new
  // asset becomes findable on the next discovery run via the
  // AssetSource row we upsert below.
  const tags: string[] = isVcenter
    ? ["vcenter", "auto-discovered"]
    : isArc ? ["azurearc", "auto-discovered"]
    : isAd ? ["activedirectory", "auto-discovered"] : ["entraid", "auto-discovered"];
  if (isArc) {
    if (proposed.arcStatus && String(proposed.arcStatus).toLowerCase() !== "connected") {
      tags.push(`arc-${String(proposed.arcStatus).toLowerCase()}`);
    }
  } else if (isAd) {
    if (proposed.disabled === true) tags.push("ad-disabled");
  } else if (!isVcenter) {
    if (proposed.trustType) tags.push(String(proposed.trustType).toLowerCase());
    if (proposed.complianceState) tags.push(`intune-${String(proposed.complianceState).toLowerCase()}`);
  }

  // Create a separate asset so the next discovery run finds it by its
  // AssetSource row and doesn't re-fire the collision.
  const defaultStatus: "active" | "decommissioned" = isAd && proposed.disabled === true ? "decommissioned" : "active";
  const createData: Record<string, unknown> = {
    hostname: proposed.hostname || null,
    dnsName: proposed.dnsName || null,
    serialNumber: proposed.serialNumber || null,
    macAddress: proposed.macAddress || null,
    manufacturer: proposed.manufacturer || null,
    model: proposed.model || null,
    // Arc defaults to "server": Arc onboarding is overwhelmingly server
    // estate, and inferArcAssetType normally supplies proposed.assetType
    // anyway — this is only the fallback when it couldn't decide.
    assetType: proposed.assetType || (isVcenter || isArc ? "server" : isAd ? "other" : "workstation"),
    status: proposed.status || defaultStatus,
    statusChangedAt: new Date(),
    statusChangedBy: actor ?? "system",
    os: proposed.os || null,
    osVersion: proposed.osVersion || null,
    assignedTo: proposed.assignedTo || null,
    learnedLocation: proposed.learnedLocation || null,
    lastSeen: proposed.lastSeen ? new Date(proposed.lastSeen) : null,
    ...(proposed.lastSeen ? { lastSeenSource: "conflict-reject" } : {}),
    acquiredAt: proposed.registrationDateTime ? new Date(proposed.registrationDateTime) : null,
    notes: proposed.notes || `Auto-created after hostname collision was rejected — ${sourceLabel} ${conflict.proposedDeviceId}`,
    tags,
  };
  clampAcquiredToLastSeen(createData);
  const newAsset = await prisma.asset.create({ data: createData as any });

  // Stamp the AssetSource row that ties the new asset to the rejected
  // source's identity. Same role the legacy `assetTag = entra:<id>` /
  // `ad:<guid>` write used to play — it's what makes the next discovery
  // run match the existing asset instead of re-firing the conflict.
  await upsertConflictAssetSource(newAsset.id, conflict, proposed, src);

  logEvent({
    action: "conflict.rejected",
    resourceType: "asset",
    resourceId: newAsset.id,
    resourceName: newAsset.hostname ?? undefined,
    actor,
    message: `Asset conflict rejected — created separate asset ${newAsset.hostname || newAsset.id} for ${sourceLabel} ${conflict.proposedDeviceId}`,
  });
}

// Build and upsert the entra/ad AssetSource row for an asset accepted or
// created via the conflict-resolution flow. Replaces the legacy
// `Asset.assetTag = entra:<id> / ad:<guid>` write — discovery's
// re-discovery uses (sourceKind, externalId) on AssetSource as the
// primary lookup, so this row is what makes the asset findable on the
// next sync. The observed blob is built from the conflict's snapshot;
// the next real discovery run replaces it with the canonical version.
async function upsertConflictAssetSource(
  assetId: string,
  conflict: any,
  proposed: Record<string, any>,
  sourceKind: AssetConflictSource,
): Promise<void> {
  const isVcenter = sourceKind === "vcenter-vm" || sourceKind === "vcenter-host";
  // AD/Entra ids are lowercase everywhere; vCenter externalIds must match the
  // discovery sync's key verbatim (instanceUuid / `${integrationId}:${moref}`).
  const externalId = isVcenter
    ? String(conflict.proposedDeviceId)
    : String(conflict.proposedDeviceId).toLowerCase();
  let observed: Record<string, unknown>;
  if (sourceKind === "ad") {
    observed = {
      objectGuid: externalId,
      cn: proposed.hostname ?? null,
      dnsHostName: proposed.dnsHostName ?? null,
      operatingSystem: proposed.os ?? null,
      operatingSystemVersion: proposed.osVersion ?? null,
      objectSid: proposed.objectSid ?? null,
      accountDisabled: proposed.disabled === true,
    };
  } else if (sourceKind === "entra") {
    observed = {
      deviceId: externalId,
      displayName: proposed.hostname ?? null,
      operatingSystem: proposed.os ?? null,
      operatingSystemVersion: proposed.osVersion ?? null,
      accountEnabled: proposed.status !== "disabled" && proposed.status !== "decommissioned",
      trustType: proposed.trustType ?? null,
      onPremisesSecurityIdentifier: proposed.onPremisesSecurityIdentifier ?? null,
    };
  } else if (sourceKind === "arc") {
    // Minimal arc blob — the next discovery run replaces it with the full
    // buildArcObservedBlob shape. Keys match that shape so the projection
    // rules read it correctly in the meantime.
    observed = {
      kind: "arc",
      armId: externalId,
      name: proposed.hostname ?? null,
      displayName: proposed.hostname ?? null,
      dnsFqdn: proposed.dnsName ?? null,
      osSku: proposed.os ?? null,
      osVersion: proposed.osVersion ?? null,
      serialNumber: proposed.serialNumber ?? null,
      manufacturer: proposed.manufacturer ?? null,
      model: proposed.model ?? null,
      resourceGroup: proposed.resourceGroup ?? null,
      subscriptionId: proposed.subscriptionId ?? null,
      vmUuid: proposed.vmUuid ?? null,
      status: proposed.arcStatus ?? null,
    };
  } else if (sourceKind === "vcenter-vm") {
    observed = {
      kind: "vcenter-vm",
      name: proposed.hostname ?? null,
      guestHostname: proposed.hostname ?? null,
      guestOsFullName: proposed.os ?? null,
      guestIp: proposed.ipAddress ?? null,
      powerState: proposed.powerState ?? null,
    };
  } else {
    observed = {
      kind: "vcenter-host",
      name: proposed.hostname ?? null,
      clusterName: proposed.clusterName ?? null,
      resolvedIp: proposed.ipAddress ?? null,
    };
  }
  const lastSeen = proposed.lastSeen ? new Date(proposed.lastSeen) : new Date();
  const now = new Date();
  await prisma.assetSource.upsert({
    where: { sourceKind_externalId: { sourceKind, externalId } },
    create: {
      assetId,
      sourceKind,
      externalId,
      integrationId: conflict.integrationId ?? null,
      observed: observed as any,
      inferred: false,
      syncedAt: now,
      firstSeen: lastSeen,
      lastSeen,
    },
    update: {
      assetId,
      integrationId: conflict.integrationId ?? null,
      syncedAt: now,
      lastSeen,
    },
  });
}
