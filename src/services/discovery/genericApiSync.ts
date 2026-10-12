/**
 * src/services/discovery/genericApiSync.ts
 *
 * Turns a Generic API integration's mapped records (services/genericApiService.ts)
 * into assets. One source kind (`generic-api`), one record → one asset, and
 * the identity is the operator's choice of field (an id, a serial, a MAC or
 * a hostname), scoped to the integration (utils/genericApiSource.ts).
 *
 * What a generic feed is trusted with, and what it is not (business rule 100):
 *
 *   - It is an INVENTORY claim, not a presence signal. A record's existence
 *     says nothing about whether the device answered anything, so this sync
 *     never writes `lastSeen` (rule 12); the post-sync presence pass
 *     establishes presence the way it does for AD and Entra.
 *   - It never decides monitoring. Its records can be any asset type, and
 *     the per-class addAsMonitored blocks key on block names that a generic
 *     feed does not own; the operator monitors its assets explicitly.
 *   - It ranks below every directory, hypervisor, controller and agent
 *     source in the projection (utils/assetProjection.ts) — above only the
 *     FortiGate DHCP sighting for name / vendor / model / OS, below it for
 *     the IP. On an asset a first-party source also holds, the feed fills
 *     gaps and never overrides.
 *   - The columns no other source projects (department, owner, PO, dates,
 *     description, asset tag) are written directly, under the same rank:
 *     a blank is filled, and a value changes only while it is still the one
 *     the feed wrote last run (genericApiFeedFieldUpdates).
 *
 * Matching (rule 91 — a hostname is not an identity):
 *   own source row → MAC → unique hardware serial (indexUniqueBy, rule 84) →
 *   hostname collision → pending Conflict → create.
 * A MAC or serial hit on an asset that already carries a DIFFERENT record of
 * this integration is refused (two records, one device, is the feed's
 * problem to explain, not Polaris's to fuse) and falls through to the
 * hostname step.
 *
 * Disappearance (opt-in `decommissionMissing`, rule 70's guards): a complete,
 * non-empty read only; the raw identity set (before the device filter) is what
 * "present" means; `absenceExceedsGuard` refuses a mass removal; an asset is
 * decommissioned only when no other inventory source still claims it and no
 * OTHER integration owns it.
 */

import { prisma } from "../../db.js";
import { logEvent, logDiscoveryAssetCreated, logDiscoveryAssetUpdated, snapshotMaterialAssetFields } from "../eventLogService.js";
import { projectAssetFromSources, ENRICHMENT_SOURCE_KINDS } from "../../utils/assetProjection.js";
import { clampAcquiredToLastSeen } from "../../utils/assetInvariants.js";
import { releaseAssetsForDecommission } from "../maintenanceScheduleService.js";
import { reconcileMacAddresses } from "../macAddressService.js";
import {
  MAC_ROW_SELECT,
  buildMacRowsForCreate,
  selectPrimaryMac,
  shapeMacRows,
  type MacJsonEntry,
} from "../../utils/macAddresses.js";
import { absenceExceedsGuard } from "../../utils/directoryAbsence.js";
import { indexUniqueBy, normalizeHardwareSerial } from "../../utils/hardwareIdentity.js";
import {
  GENERIC_API_LABEL,
  GENERIC_API_SOURCE_KIND,
  GENERIC_API_TYPE,
  genericApiExternalId,
  genericApiIdentityFromExternalId,
} from "../../utils/genericApiSource.js";
import type { GenericApiDiscoveryResult, GenericApiMappedRecord, GenericApiIdentityField } from "../genericApiService.js";
import { listAssetTypes } from "../assetTypeService.js";
import { indexHostname, lookupHostname, normalizeMacKey, upsertAssetConflict } from "./discoveryEngine.js";

const KIND = GENERIC_API_SOURCE_KIND;
const MAC_SOURCE = "generic-api";

export interface GenericApiSyncSummary {
  created: string[];
  updated: string[];
  skipped: string[];
  decommissioned: string[];
}

/** The observed blob — the shape assetProjection's generic-api rules read. */
export function genericApiObserved(
  r: GenericApiMappedRecord,
  identityField: GenericApiIdentityField,
  syncedAt: Date,
): Record<string, unknown> {
  return {
    kind: KIND,
    syncedAt: syncedAt.toISOString(),
    identity: r.identity,
    identityField,
    hostname: r.hostname,
    ip: r.ipAddress,
    macs: r.macs,
    serial: r.serialNumber,
    manufacturer: r.manufacturer,
    model: r.model,
    os: r.os,
    osVersion: r.osVersion,
    rawAssetType: r.rawAssetType,
    assetType: r.assetType,
    location: r.location,
    assetTag: r.assetTag,
    department: r.department,
    assignedTo: r.assignedTo,
    description: r.description,
    tags: r.tags,
    acquiredAt: r.acquiredAt,
    warrantyExpiry: r.warrantyExpiry,
    purchaseOrder: r.purchaseOrder,
    latitude: r.latitude,
    longitude: r.longitude,
  };
}

/**
 * The asset columns a feed writes directly — no other source projects them,
 * so the projection has nothing to rank. The rule that keeps the feed below
 * everyone else instead (rule 100(c)): it fills a BLANK column, and it may
 * change a value only while that value is still the one the feed itself
 * wrote last run (its prior observed blob). Once an operator or another
 * integration writes the column, the values differ and the feed stops
 * touching it. A feed never clears a column.
 */
export const GENERIC_API_FEED_FIELDS = [
  "department", "assignedTo", "purchaseOrder", "description", "assetTag", "acquiredAt", "warrantyExpiry",
] as const;
type FeedField = (typeof GENERIC_API_FEED_FIELDS)[number];
const FEED_DATE_FIELDS: ReadonlySet<FeedField> = new Set(["acquiredAt", "warrantyExpiry"]);

function feedComparable(field: FeedField, v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (FEED_DATE_FIELDS.has(field)) {
    const d = v instanceof Date ? v : new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return String(v);
}

export interface FeedFieldContext {
  integrationId: string;
  /** asset id holding each asset tag — a tag is unique across assets. */
  assetIdByTag: ReadonlyMap<string, string>;
}

/**
 * The direct-write columns for one asset. `asset` is its current row (or {}
 * for a create), `prior` this integration's previous observed blob for the
 * record (null on first sight), `next` this run's. Returns the update and the
 * reasons any column was held back, for the sync log.
 */
export function genericApiFeedFieldUpdates(
  asset: Record<string, unknown>,
  prior: Record<string, unknown> | null,
  next: Record<string, unknown>,
  ctx: FeedFieldContext,
): { data: Record<string, unknown>; held: string[] } {
  const data: Record<string, unknown> = {};
  const held: string[] = [];
  const ownedElsewhere = typeof asset.discoveredByIntegrationId === "string" && asset.discoveredByIntegrationId !== ctx.integrationId;
  for (const field of GENERIC_API_FEED_FIELDS) {
    const nv = feedComparable(field, next[field]);
    if (nv === null) continue;
    const cur = feedComparable(field, asset[field]);
    if (cur === nv) continue;
    const pv = feedComparable(field, prior?.[field]);
    if (cur !== null && cur !== pv) continue;
    // A description another integration's device carries can be pushed back
    // to that device by description sync (rule 14) — not the feed's to set.
    if (field === "description" && ownedElsewhere) continue;
    if (field === "assetTag") {
      const holder = ctx.assetIdByTag.get(nv);
      if (holder && holder !== asset.id) { held.push(`asset tag "${nv}" is already on another asset`); continue; }
    }
    data[field] = FEED_DATE_FIELDS.has(field) ? new Date(nv) : nv;
  }
  return { data, held };
}

/**
 * The asset's tags after this run: every tag kept except the ones the feed
 * listed last run and no longer lists, plus this run's feed tags. Tags carry
 * no author, so a tag an operator ALSO set goes when the feed drops it.
 */
export function mergeGenericFeedTags(existing: string[], prior: string[], next: string[]): string[] {
  const dropped = new Set(prior.filter((t) => !next.includes(t)));
  const out = existing.filter((t) => !dropped.has(t));
  for (const t of next) if (!out.includes(t)) out.push(t);
  return out;
}

/**
 * The asset type a record is written with: its mapped type when the registry
 * knows it, else the integration's default when the registry knows THAT, else
 * "other" — a type the registry refuses would fail the whole write.
 */
export function resolveGenericAssetType(
  mapped: string | null,
  fallback: string | null | undefined,
  known: ReadonlySet<string>,
): string {
  if (mapped && known.has(mapped)) return mapped;
  const def = (fallback ?? "").trim().toLowerCase();
  if (def && known.has(def)) return def;
  return "other";
}

/**
 * Why the disappearance sweep must not run on this read, or null when it may.
 * Off unless the operator opted in; then refused on an incomplete read and on
 * an EMPTY read against an integration that holds records (a permissions or
 * path change far more often than an emptied inventory — rule 70(a)).
 */
export function genericApiSweepBlockedReason(
  result: Pick<GenericApiDiscoveryResult, "complete" | "presentIdentities" | "unmapped">,
  priorCount: number,
  decommissionMissing: boolean,
): string | null {
  if (!decommissionMissing) return "decommissioning missing records is switched off";
  if (!result.complete) return "the feed was not read to the end this run";
  if (result.presentIdentities.length === 0 && priorCount > 0) {
    return result.unmapped > 0
      ? "no record mapped to an identity this run (check the field mapping)"
      : "the feed returned no records at all";
  }
  return null;
}

/** Tags this sync owns on an asset (stripped and re-added each run). */
function isGenericManagedTag(t: string): boolean {
  return t === GENERIC_API_TYPE || t === "auto-discovered";
}

interface SourceEntry {
  sourceKind: string;
  externalId: string;
  integrationId: string | null;
  inferred: boolean;
  observed: Record<string, unknown> | null;
  lastSeen: Date | null;
}

export async function syncGenericApiDevices(
  integrationId: string,
  integrationName: string,
  integrationConfig: Record<string, unknown> | null,
  result: GenericApiDiscoveryResult,
  actor?: string,
): Promise<GenericApiSyncSummary> {
  const cfg = (integrationConfig ?? {}) as Record<string, unknown>;
  const identityField = (cfg.identityField as GenericApiIdentityField | undefined) ?? "id";
  const syncLog = (level: "info" | "error" | "warning", message: string) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
  const created: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];
  const now = new Date();
  const nowIso = now.toISOString();

  const knownTypes = new Set((await listAssetTypes()).map((t) => t.name));

  // Preload — tight selects, once (2000-asset scale: no per-record reads).
  const allAssetsWithRows = await prisma.asset.findMany({
    select: {
      id: true, hostname: true, hostnameOverride: true, assetType: true, status: true,
      monitored: true, monitorOverride: true, acquiredAt: true, lastSeen: true,
      tags: true, discoveredByIntegrationId: true, dnsName: true, ipAddress: true,
      os: true, osVersion: true, serialNumber: true, manufacturer: true, model: true,
      learnedLocation: true, notes: true, assignedTo: true, macAddress: true,
      department: true, description: true, purchaseOrder: true, warrantyExpiry: true, assetTag: true,
      coordSource: true, latitude: true, longitude: true,
      macAddressRows: { select: MAC_ROW_SELECT },
    },
  });
  const allAssets = allAssetsWithRows.map((a: any) => ({ ...a, macAddresses: shapeMacRows(a.macAddressRows) }));
  const assetById = new Map<string, any>(allAssets.map((a: any) => [a.id, a]));
  const assetIdByTag = new Map<string, string>();
  for (const a of allAssets) if (a.assetTag) assetIdByTag.set(a.assetTag, a.id);
  const feedCtx: FeedFieldContext = { integrationId, assetIdByTag };

  const allSources = await prisma.assetSource.findMany({
    select: { assetId: true, sourceKind: true, externalId: true, integrationId: true, inferred: true, observed: true, lastSeen: true },
  });
  const sourcesByAssetId = new Map<string, SourceEntry[]>();
  const assetByExternalId = new Map<string, any>();
  /** asset id → the identity of THIS integration's record on it. */
  const ownIdentityByAssetId = new Map<string, string>();
  let priorCount = 0;
  for (const src of allSources) {
    const entry: SourceEntry = {
      sourceKind: src.sourceKind, externalId: src.externalId, integrationId: src.integrationId,
      inferred: src.inferred, observed: (src.observed as Record<string, unknown> | null) || {}, lastSeen: src.lastSeen,
    };
    const list = sourcesByAssetId.get(src.assetId);
    if (list) list.push(entry); else sourcesByAssetId.set(src.assetId, [entry]);
    if (src.sourceKind !== KIND) continue;
    const a = assetById.get(src.assetId);
    if (a) assetByExternalId.set(src.externalId, a);
    const ownIdentity = src.integrationId === integrationId ? genericApiIdentityFromExternalId(integrationId, src.externalId) : null;
    if (ownIdentity !== null) {
      ownIdentityByAssetId.set(src.assetId, ownIdentity);
      priorCount++;
    }
  }

  // Indexes for the cross-link steps. Hostnames: only assets this integration
  // has NOT claimed — a claimed one is matched by its source row or not at all.
  const assetByHostnameUnclaimed = new Map<string, any>();
  const assetByMac = new Map<string, any>();
  const serialCandidates: { key: string | null; value: any; id: string }[] = [];
  for (const a of allAssets) {
    if (a.hostname && !ownIdentityByAssetId.has(a.id)) indexHostname(assetByHostnameUnclaimed, a.hostname, a);
    const keys = [normalizeMacKey(a.macAddress), ...((a.macAddresses as any[]) ?? []).map((m) => normalizeMacKey(m?.mac))];
    for (const k of keys) if (k && !assetByMac.has(k)) assetByMac.set(k, a);
    serialCandidates.push({ key: normalizeHardwareSerial(a.serialNumber), value: a, id: a.id });
  }
  const { index: assetBySerial, ambiguous: ambiguousSerials } = indexUniqueBy(serialCandidates);
  if (ambiguousSerials.size > 0) {
    syncLog("info", `Serial match: ignoring ${ambiguousSerials.size} serial(s) carried by more than one asset (not a usable identity)`);
  }

  /** A cross-link candidate is refused when it already holds a different record of this integration. */
  const heldByOtherRecord = (asset: any, identity: string): boolean => {
    const own = ownIdentityByAssetId.get(asset.id);
    return own !== undefined && own !== identity;
  };

  const freshTags = [GENERIC_API_TYPE, "auto-discovered"];
  const mergeTags = (existing: any, priorFeedTags: string[], feedTags: string[]): string[] => {
    const preserved = ((existing?.tags as string[]) || []).filter((t) => !isGenericManagedTag(t));
    const withFeed = mergeGenericFeedTags(preserved, priorFeedTags, feedTags.filter((t) => !isGenericManagedTag(t)));
    return [...withFeed, ...freshTags.filter((t) => !withFeed.includes(t))];
  };
  const obsTags = (o: Record<string, unknown> | null | undefined): string[] =>
    Array.isArray(o?.tags) ? (o!.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];

  const mergeMacs = (existingMacs: any[], macs: string[]): { primary: string | null; merged: any[] } => {
    const merged = Array.isArray(existingMacs) ? existingMacs.map((m) => ({ ...m })) : [];
    for (const mac of macs) {
      const key = normalizeMacKey(mac);
      if (!key) continue;
      const hit = merged.find((m: any) => normalizeMacKey(m?.mac) === key);
      if (hit) { hit.lastSeen = nowIso; if (!hit.source) hit.source = MAC_SOURCE; }
      else merged.push({ mac, lastSeen: nowIso, source: MAC_SOURCE });
    }
    merged.sort((a: any, b: any) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime());
    return { primary: selectPrimaryMac(merged) ?? merged[0]?.mac ?? null, merged };
  };

  const upsertSource = async (assetId: string, externalId: string, observed: Record<string, unknown>): Promise<void> => {
    await prisma.assetSource.upsert({
      where: { sourceKind_externalId: { sourceKind: KIND, externalId } },
      // lastSeen on the SOURCE row is "the feed listed it this run" — row
      // freshness for the projection, not Asset.lastSeen (rule 12).
      create: { assetId, sourceKind: KIND, externalId, integrationId, observed: observed as any, inferred: false, syncedAt: now, firstSeen: now, lastSeen: now },
      update: { assetId, integrationId, observed: observed as any, inferred: false, syncedAt: now, lastSeen: now },
    });
    const list = (sourcesByAssetId.get(assetId) ?? []).filter((s) => !(s.sourceKind === KIND && s.externalId === externalId));
    list.push({ sourceKind: KIND, externalId, integrationId, inferred: false, observed, lastSeen: now });
    sourcesByAssetId.set(assetId, list);
  };

  for (const r of result.records) {
    const externalId = genericApiExternalId(integrationId, r.identity);
    const displayName = r.hostname || r.ipAddress || r.identity;
    const observed = genericApiObserved(r, identityField, now);
    const assetType = resolveGenericAssetType(r.assetType, cfg.assetTypeDefault as string | undefined, knownTypes);

    // ── Match cascade ───────────────────────────────────────────────────────
    let existing: any = assetByExternalId.get(externalId) ?? null;
    if (!existing) {
      for (const mac of r.macs) {
        const hit = assetByMac.get(normalizeMacKey(mac));
        if (!hit) continue;
        if (heldByOtherRecord(hit, r.identity)) {
          syncLog("warning", `MAC cross-link declined for "${displayName}": asset ${hit.hostname || hit.id} already carries a different record of this feed with MAC ${mac}.`);
          break;
        }
        existing = hit;
        syncLog("info", `MAC cross-link: "${displayName}" matched existing asset ${hit.hostname || hit.id} on MAC ${mac}.`);
        break;
      }
    }
    if (!existing) {
      const serialKey = normalizeHardwareSerial(r.serialNumber);
      const hit = serialKey ? assetBySerial.get(serialKey) : null;
      if (hit && heldByOtherRecord(hit, r.identity)) {
        syncLog("warning", `Serial cross-link declined for "${displayName}": asset ${hit.hostname || hit.id} already carries a different record of this feed with that serial.`);
      } else if (hit) {
        existing = hit;
        syncLog("info", `Serial cross-link: "${displayName}" matched existing asset ${hit.hostname || hit.id} on serial ${r.serialNumber}.`);
      }
    }

    // ── Update ──────────────────────────────────────────────────────────────
    if (existing) {
      try {
        const prior = (sourcesByAssetId.get(existing.id) ?? [])
          .find((s) => s.sourceKind === KIND && s.externalId === externalId)?.observed ?? null;
        await upsertSource(existing.id, externalId, observed);
        const before = snapshotMaterialAssetFields(existing);
        const { projected } = projectAssetFromSources(sourcesByAssetId.get(existing.id) ?? []);
        const updateData: Record<string, unknown> = {};
        if (projected.hostname !== null) updateData.hostname = projected.hostname;
        if (projected.os !== null) updateData.os = projected.os;
        if (projected.osVersion !== null) updateData.osVersion = projected.osVersion;
        if (projected.manufacturer !== null) updateData.manufacturer = projected.manufacturer;
        if (projected.model !== null) updateData.model = projected.model;
        if (projected.serialNumber !== null && projected.serialNumber !== undefined && !existing.serialNumber) {
          updateData.serialNumber = projected.serialNumber;
        }
        if (projected.ipAddress !== null) updateData.ipAddress = projected.ipAddress;
        if (projected.learnedLocation !== null && projected.learnedLocation !== undefined) updateData.learnedLocation = projected.learnedLocation;
        // Retype only from the unclassified default; an operator's or a
        // better source's classification stands.
        if (existing.assetType === "other" && assetType !== "other") updateData.assetType = assetType;
        // Ownership: claim an unowned asset, never one another integration owns.
        if (!existing.discoveredByIntegrationId) updateData.discoveredByIntegrationId = integrationId;
        let mergedMacs: MacJsonEntry[] | null = null;
        if (r.macs.length > 0) {
          const { primary, merged } = mergeMacs(existing.macAddresses as any[], r.macs);
          mergedMacs = merged as MacJsonEntry[];
          if (primary) updateData.macAddress = primary;
        }
        // Operator-typed coordinates (coordSource "manual") are never moved.
        if (existing.coordSource !== "manual" && typeof projected.latitude === "number" && typeof projected.longitude === "number"
          && (projected.latitude !== existing.latitude || projected.longitude !== existing.longitude)) {
          updateData.latitude = projected.latitude;
          updateData.longitude = projected.longitude;
        }
        const feed = genericApiFeedFieldUpdates(existing, prior, observed, feedCtx);
        Object.assign(updateData, feed.data);
        for (const why of feed.held) syncLog("warning", `"${displayName}": ${why} — left unchanged.`);
        if (typeof feed.data.assetTag === "string") assetIdByTag.set(feed.data.assetTag, existing.id);
        updateData.tags = mergeTags(existing, obsTags(prior), r.tags);
        clampAcquiredToLastSeen(updateData, existing);
        await prisma.asset.update({ where: { id: existing.id }, data: updateData });
        logDiscoveryAssetUpdated(before, updateData, existing.id, displayName, { integrationName, integrationId, sourceKind: KIND, actor });
        if (mergedMacs) await reconcileMacAddresses(existing.id, mergedMacs);
        assetByExternalId.set(externalId, existing);
        ownIdentityByAssetId.set(existing.id, r.identity);
        updated.push(displayName);
      } catch (err: any) {
        syncLog("error", `Failed to update asset for "${displayName}": ${err.message || "Unknown error"}`);
      }
      continue;
    }

    // ── Hostname collision → Conflict, never an auto-merge ──────────────────
    const collision = r.hostname ? lookupHostname(assetByHostnameUnclaimed, r.hostname, { assetType, serialNumber: r.serialNumber }) : null;
    if (collision) {
      try {
        await upsertAssetConflict({
          collisionAssetId: collision.asset.id,
          integrationId,
          proposedDeviceId: externalId,
          proposedAssetFields: {
            sourceType: GENERIC_API_TYPE,
            deviceId: externalId,
            hostname: r.hostname,
            assetType,
            ipAddress: r.ipAddress,
            macAddress: r.macs[0] ?? null,
            serialNumber: r.serialNumber,
            manufacturer: r.manufacturer,
            model: r.model,
            os: r.os,
            osVersion: r.osVersion,
            genericObserved: observed,
            collisionReason: "untagged-collision",
            matchedVia: collision.via,
          },
          existingAsset: collision.asset,
        });
        syncLog("warning", `Hostname collision queued for review — "${displayName}" matches existing asset ${collision.asset.id}${collision.via === "netbios" ? " (NetBIOS-truncated match)" : ""}.`);
      } catch (err: any) {
        syncLog("error", `Failed to queue hostname-collision conflict for "${displayName}": ${err.message || "Unknown error"}`);
      }
      skipped.push(`${displayName} (hostname collision — pending review)`);
      continue;
    }

    // ── Create ──────────────────────────────────────────────────────────────
    try {
      const { projected } = projectAssetFromSources([{ sourceKind: KIND, inferred: false, observed }]);
      const seeded = mergeMacs([], r.macs);
      const createData: Record<string, unknown> = {
        hostname: projected.hostname ?? r.hostname,
        macAddress: seeded.primary,
        ...(seeded.merged.length > 0 ? { macAddressRows: { create: buildMacRowsForCreate(seeded.merged as MacJsonEntry[]) } } : {}),
        ipAddress: projected.ipAddress,
        os: projected.os,
        osVersion: projected.osVersion,
        serialNumber: projected.serialNumber ?? null,
        manufacturer: projected.manufacturer,
        model: projected.model,
        learnedLocation: projected.learnedLocation ?? null,
        ...(typeof projected.latitude === "number" && typeof projected.longitude === "number"
          ? { latitude: projected.latitude, longitude: projected.longitude } : {}),
        assetType,
        status: "active",
        statusChangedAt: now,
        statusChangedBy: integrationName,
        // The only discovery-authored notes content (rule 15) — once, at creation.
        notes: `Auto-discovered from ${GENERIC_API_LABEL} integration "${integrationName}"`,
        tags: mergeTags({ tags: [] }, [], r.tags),
        discoveredByIntegrationId: integrationId,
      };
      const feed = genericApiFeedFieldUpdates({ discoveredByIntegrationId: integrationId }, null, observed, feedCtx);
      Object.assign(createData, feed.data);
      for (const why of feed.held) syncLog("warning", `"${displayName}": ${why} — left blank.`);
      clampAcquiredToLastSeen(createData);
      const newAsset = await prisma.asset.create({ data: createData as any });
      try {
        await upsertSource(newAsset.id, externalId, observed);
      } catch (err: any) {
        syncLog("warning", `Created asset for "${displayName}" but failed to upsert its source row: ${err.message || "Unknown error"}`);
      }
      logDiscoveryAssetCreated(newAsset.id, displayName, { integrationName, integrationId, sourceKind: KIND, actor });
      assetById.set(newAsset.id, newAsset);
      assetByExternalId.set(externalId, newAsset);
      if (newAsset.assetTag) assetIdByTag.set(newAsset.assetTag, newAsset.id);
      ownIdentityByAssetId.set(newAsset.id, r.identity);
      for (const mac of r.macs) {
        const k = normalizeMacKey(mac);
        if (k && !assetByMac.has(k)) assetByMac.set(k, newAsset);
      }
      created.push(displayName);
    } catch (err: any) {
      syncLog("error", `Failed to create asset for "${displayName}": ${err.message || "Unknown error"}`);
    }
  }

  // ── Disappearance sweep (opt-in, rule 70's guards) ──────────────────────────
  const decommissioned: string[] = [];
  try {
    const blocked = genericApiSweepBlockedReason(result, priorCount, cfg.decommissionMissing === true);
    if (blocked) {
      if (cfg.decommissionMissing === true && priorCount > 0) {
        syncLog("warning", `Missing-record sweep skipped — ${blocked}. ${priorCount} existing source row(s) left untouched.`);
      }
    } else {
      const present = new Set(result.presentIdentities.map((id) => genericApiExternalId(integrationId, id)));
      const ownRows = await prisma.assetSource.findMany({
        where: { integrationId, sourceKind: KIND },
        select: { id: true, assetId: true, externalId: true },
      });
      const gone = ownRows.filter((row) => !present.has(row.externalId));
      if (gone.length > 0 && absenceExceedsGuard(gone.length, priorCount)) {
        syncLog("warning", `Missing-record sweep refused — ${gone.length} of ${priorCount} record(s) vanished in one read, which is more than the guard allows. Nothing was removed; if this is real, the next runs will keep reporting it.`);
      } else if (gone.length > 0) {
        await prisma.assetSource.deleteMany({ where: { id: { in: gone.map((r) => r.id) } } });
        syncLog("info", `Swept ${gone.length} source row(s) for records no longer in the feed.`);
        const candidateIds = [...new Set(gone.map((r) => r.assetId))];
        const remaining = await prisma.assetSource.findMany({
          where: { assetId: { in: candidateIds }, sourceKind: { notIn: [...ENRICHMENT_SOURCE_KINDS] } },
          select: { assetId: true },
        });
        const stillClaimed = new Set(remaining.map((r) => r.assetId));
        const orphanIds = candidateIds.filter((id) => !stillClaimed.has(id));
        if (orphanIds.length > 0) {
          // Ownership decides (rule 70): an asset another integration owns
          // loses only this feed's row; the feed's word is final only on
          // what it owns, or on what nothing owns.
          const orphans = await prisma.asset.findMany({
            where: {
              id: { in: orphanIds },
              status: { not: "decommissioned" },
              OR: [{ discoveredByIntegrationId: integrationId }, { discoveredByIntegrationId: null }],
            },
            select: { id: true, hostname: true, ipAddress: true },
          });
          if (orphans.length > 0) {
            const ids = orphans.map((a) => a.id);
            await releaseAssetsForDecommission(ids, {
              at: now, actor, statusChangedBy: integrationName, reason: `no longer present in "${integrationName}"`,
            });
            await prisma.asset.updateMany({
              where: { id: { in: ids } },
              data: { status: "decommissioned", statusChangedAt: now, statusChangedBy: integrationName },
            });
            for (const a of orphans) {
              const name = a.hostname || a.ipAddress || a.id;
              decommissioned.push(name);
              logEvent({
                action: "asset.genericapi.decommissioned",
                resourceType: "asset",
                resourceId: a.id,
                resourceName: name,
                actor,
                message: `"${name}" decommissioned — no longer present in "${integrationName}", and no other discovery source claims it`,
                details: { reason: "missing-from-generic-api-feed", integrationId, integrationName },
              });
            }
          }
        }
      }
    }
  } catch (err: any) {
    syncLog("error", `Missing-record sweep failed: ${err.message || "Unknown error"}`);
  }

  const notes: string[] = [];
  if (result.unmapped > 0) notes.push(`${result.unmapped} record(s) had no usable identity${result.unmappedReasons.length ? ` (${result.unmappedReasons.join("; ")})` : ""}`);
  if (result.duplicates > 0) notes.push(`${result.duplicates} duplicate identit${result.duplicates === 1 ? "y" : "ies"} ignored`);
  if (result.filtered > 0) notes.push(`${result.filtered} filtered out`);
  if (result.detailRequests > 0) notes.push(`${result.detailRequests} detail request(s)`);
  if (result.warnings.length > 0) notes.push(...result.warnings);
  syncLog(
    notes.length > 0 && (!result.complete || result.unmapped > 0) ? "warning" : "info",
    `${GENERIC_API_LABEL} sync: ${result.rawCount} record(s) over ${result.pages} page(s) — ${created.length} created, ${updated.length} updated, ${skipped.length} skipped, ${decommissioned.length} decommissioned${notes.length ? `. ${notes.join(". ")}` : ""}`,
  );
  return { created, updated, skipped, decommissioned };
}
