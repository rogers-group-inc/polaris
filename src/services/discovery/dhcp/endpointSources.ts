/**
 * src/services/discovery/dhcp/endpointSources.ts — syncDhcpSubnets Phases 10
 * and 11: stamp a `fortigate-endpoint` AssetSource row on every endpoint the
 * run touched, then re-project each touched asset from all its sources and
 * write back the fields the projection disagrees with. CQ-B060; bodies moved
 * verbatim, their free variables made parameters. The engine's
 * `upsertFortigateEndpointSource` is passed in, so this module imports
 * nothing from the engine at runtime.
 */

import type { AssetIndex } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import type { ChangeBaselineFields } from "./changeEvents.js";
import { chunkArray } from "../../../utils/chunk.js";
import { prisma } from "../../../db.js";
import { bareFortinetDeviceName } from "../../../utils/assetSourceLocation.js";
import { buildEndpointGateResolver } from "../../../utils/endpointGate.js";
import { projectAssetFromSources } from "../../../utils/assetProjection.js";
import { clampAcquiredToLastSeen } from "../../../utils/assetInvariants.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";

/**
 * Phase 10 — fortigate-endpoint AssetSource flush. Runs on every mode;
 * best-effort per asset (failures are logged, never thrown). The gate each
 * row names follows business rule 101(b): the gate whose network holds the
 * primary address, else the touching pathway's gate, else the row's prior one.
 */
export async function stampEndpointSources(input: {
  fortigateEndpointAssetIds: Set<string>;
  fortigateEndpointDeviceByAsset: Map<string, string>;
  allSubnets: Parameters<typeof buildEndpointGateResolver>[0];
  assetIdx: AssetIndex;
  integrationId: string;
  integrationName: string;
  integrationType: string;
  now: string;
  upsertFortigateEndpointSource: (
    assetId: string, integrationId: string, asset: any, integrationType: string,
    lastSeen: Date, integrationName: string | null, gateName: string | null,
    prior?: { assetId: string; integrationId: string | null; observed: unknown; lastSeen: Date },
  ) => Promise<"written" | "unchanged" | Date | null | unknown>;
  syncLog: SyncLog;
}): Promise<number> {
  const {
    fortigateEndpointAssetIds, fortigateEndpointDeviceByAsset, allSubnets, assetIdx,
    integrationId, integrationName, integrationType, now, upsertFortigateEndpointSource, syncLog,
  } = input;
  let endpointSourcesStamped = 0;
  if (fortigateEndpointAssetIds.size > 0) {
    const flushedAt = new Date(now);
    // Gate name fallback for the rare touch that carried none (a device-
    // inventory row with no `device`): keep whatever this source last said
    // rather than nulling it. One bulk read, mirroring Phase 11's — and NOT
    // shared with it, because Phase 11 must see the rows this phase writes.
    const priorGateByAsset = new Map<string, string>();
    // The same read gives each row's prior state, so an unchanged blob is not
    // rewritten (efficiency audit) — keyed by externalId (the MAC).
    const priorByExternalId = new Map<string, { assetId: string; integrationId: string | null; observed: unknown; lastSeen: Date }>();
    try {
      const priorRows = await prisma.assetSource.findMany({
        where: { sourceKind: "fortigate-endpoint", assetId: { in: [...fortigateEndpointAssetIds] } },
        select: { assetId: true, externalId: true, integrationId: true, observed: true, lastSeen: true },
      });
      for (const row of priorRows) {
        priorByExternalId.set(row.externalId, { assetId: row.assetId, integrationId: row.integrationId, observed: row.observed, lastSeen: row.lastSeen });
        const prior = (row.observed as Record<string, unknown> | null)?.learnedLocation;
        if (typeof prior !== "string" || !prior.trim()) continue;
        priorGateByAsset.set(row.assetId, bareFortinetDeviceName(prior.trim()));
      }
    } catch (err: any) {
      syncLog("error", `fortigate-endpoint AssetSource: prior-gate preload failed (${err?.message || "unknown"})`);
    }
    const stampedAssetIds: string[] = [];
    const lastSeenBumps: Array<{ externalId: string; lastSeen: Date }> = [];
    // Parsed once for the whole flush — one lookup per touched endpoint.
    const gateForAddress = buildEndpointGateResolver(allSubnets);
    const results = await mapSettledWithConcurrency(
      Array.from(fortigateEndpointAssetIds), 50,
      async (assetId: string) => {
        const asset = assetIdx.findById(assetId);
        if (!asset || !asset.macAddress) return false;
        // Business rule 101(b): the gate whose network holds the primary
        // address names it; the pathway's gate only when IPAM cannot say.
        const pathwayGate = fortigateEndpointDeviceByAsset.get(assetId);
        const priorGate = priorGateByAsset.get(assetId);
        const gateName = gateForAddress(asset.ipAddress, [pathwayGate, priorGate])
          ?? pathwayGate
          ?? priorGate
          ?? null;
        const prior = priorByExternalId.get(String(asset.macAddress).trim().toUpperCase());
        const outcome = await upsertFortigateEndpointSource(assetId, integrationId, asset, integrationType, asset.lastSeen ?? flushedAt, integrationName, gateName, prior);
        if (outcome === null) return false;
        stampedAssetIds.push(assetId);
        if (outcome instanceof Date) lastSeenBumps.push({ externalId: String(asset.macAddress).trim().toUpperCase(), lastSeen: outcome });
        return true;
      },
    );
    // Unchanged rows whose only news is a fresher lastSeen: one statement.
    if (lastSeenBumps.length > 0) {
      const syncedAt = new Date();
      for (const chunk of chunkArray(lastSeenBumps, 1000)) {
        const params: unknown[] = [syncedAt.toISOString()];
        const groups = chunk.map((b) => {
          const e = params.push(b.externalId);
          const l = params.push(b.lastSeen.toISOString());
          return `($${e}::text, $${l}::timestamp)`;
        });
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE "asset_sources" s SET "lastSeen" = v.ls, "syncedAt" = $1::timestamp
               FROM (VALUES ${groups.join(", ")}) AS v(ext, ls)
              WHERE s."sourceKind" = 'fortigate-endpoint' AND s."externalId" = v.ext`,
            ...params,
          );
        } catch (err: any) {
          syncLog("error", `fortigate-endpoint AssetSource: lastSeen refresh failed (${err?.message || "unknown"})`);
        }
      }
    }
    // The Phase 1 backfill placeholder (sourceKind "manual") is superseded by
    // a real source on every stamped asset: one sweep for the flush, instead
    // of one per endpoint. It runs after every stamp, so a placeholder the
    // unawaited db.ts shadow-write minted for an asset created this run is
    // at least as likely to be in place as with the per-endpoint delete.
    for (const chunk of chunkArray(stampedAssetIds, 1000)) {
      try {
        await prisma.assetSource.deleteMany({ where: { assetId: { in: chunk }, sourceKind: "manual" } });
      } catch {
        // Non-fatal: the manual row just lingers (both source cards show).
      }
    }
    for (const r of results) {
      if (r.status === "fulfilled" && r.value === true) endpointSourcesStamped++;
    }
    const failed = results.filter((r) => r.status === "rejected").length;
    if (failed > 0) {
      syncLog("error", `fortigate-endpoint AssetSource: stamped ${endpointSourcesStamped}, ${failed} failed`);
    }
  }
  return endpointSourcesStamped;
}

/**
 * Phase 11 — projection apply pass. Re-projects every touched endpoint from
 * all of its AssetSource rows (one bulk read) and writes only the fields where
 * the projection is non-null and differs; a primary-address pin (business rule
 * 102) keeps its address. Records the os / osVersion change baseline first.
 */
export async function applyEndpointProjection(input: {
  fortigateEndpointAssetIds: Set<string>;
  assetIdx: AssetIndex;
  integrationType: string;
  noteChangeBaseline: (asset: any, fields: ChangeBaselineFields[]) => void;
  syncLog: SyncLog;
}): Promise<number> {
  const { fortigateEndpointAssetIds, assetIdx, integrationType, noteChangeBaseline, syncLog } = input;
  let projectionCorrected = 0;
  if (fortigateEndpointAssetIds.size > 0) {
    // Pre-load every touched asset's AssetSource rows in ONE query and
    // partition by assetId in JS. Was: N sequential `assetSource.findMany`
    // calls (one per touched endpoint) — for a 5K-endpoint sync that's 5K
    // round-trips before any update happens. The bulk fetch + Map dispatch
    // collapses that to one round-trip. Per-asset writes still go through
    // mapSettledWithConcurrency so unchanged assets don't pay any DB cost.
    const allSourceRows = await prisma.assetSource.findMany({
      where: { assetId: { in: [...fortigateEndpointAssetIds] } },
      // lastSeen rides along so the projection can let the FRESHEST of
      // several same-kind rows speak for the kind — an asset that changed
      // NICs keeps one fortigate-endpoint row per MAC, and without the
      // freshness cue the stale NIC's blob could win the pick and revert
      // the ipAddress Phase 6 just corrected.
      select: { assetId: true, sourceKind: true, inferred: true, observed: true, lastSeen: true },
    });
    const sourcesByAsset = new Map<string, typeof allSourceRows>();
    for (const r of allSourceRows) {
      const existing = sourcesByAsset.get(r.assetId);
      if (existing) existing.push(r);
      else sourcesByAsset.set(r.assetId, [r]);
    }

    const projectionResults = await mapSettledWithConcurrency(
      Array.from(fortigateEndpointAssetIds), 50,
      async (assetId: string) => {
        const asset = assetIdx.findById(assetId);
        if (!asset) return false;
        const sourceRows = sourcesByAsset.get(assetId) ?? [];
        const { projected } = projectAssetFromSources(
          sourceRows.map((s) => ({
            sourceKind: s.sourceKind,
            inferred: s.inferred,
            observed: s.observed as Record<string, unknown> | null,
            lastSeen: s.lastSeen,
          })),
        );
        const corrections: Record<string, unknown> = {};
        const considerString = (key: "hostname" | "os" | "osVersion" | "manufacturer" | "model" | "learnedLocation" | "ipAddress" | "serialNumber") => {
          const next = projected[key];
          if (next !== null && next !== (asset as any)[key]) {
            corrections[key] = next;
          }
        };
        considerString("hostname");
        considerString("os");
        considerString("osVersion");
        considerString("manufacturer");
        considerString("model");
        considerString("learnedLocation");
        considerString("ipAddress");
        // Pinned asset whose projection agrees with the pin: stage the IP so
        // the db.ts guard releases the override (an equal value is otherwise
        // skipped above and the pin would never self-clear).
        const pinnedIp = (asset as any).ipOverride as string | null | undefined;
        if (pinnedIp && projected.ipAddress === pinnedIp) corrections.ipAddress = pinnedIp;
        // A primary-address pin (business rule 102) owns the address outright;
        // re-projecting it would only hand the db.ts guard a write to rewrite.
        // The Phase 6/7 claim writes still reach the guard, which is what lets
        // a pin follow a renumbered card.
        if ((asset as any).primaryAddressIp) delete corrections.ipAddress;
        considerString("serialNumber");
        // lat/long: only meaningful for firewall-typed assets (excluded
        // from this set since infrastructure assets aren't tracked in
        // fortigateEndpointAssetIds), so we don't bother projecting.
        if (Object.keys(corrections).length === 0) return false;
        // ipAddress correction needs to clear ipSource if the inline path
        // wrote a stale tag. Mirror the existing inline pattern.
        if ("ipAddress" in corrections) {
          corrections.ipSource = `${integrationType}:fortigate-endpoint`;
        }
        clampAcquiredToLastSeen(corrections, asset);
        // Baseline before the in-memory assign: this pass is the one that
        // corrects Phase 7's coarse osVersion back to the projected value, so
        // for an asset Phase 7 already touched the baseline is ALREADY the
        // pre-run value (first touch wins) and the round trip nets out.
        {
          const touched: ChangeBaselineFields[] = [];
          if ("os" in corrections) touched.push("os");
          if ("osVersion" in corrections) touched.push("osVersion");
          if (touched.length) noteChangeBaseline(asset, touched);
        }
        await prisma.asset.update({ where: { id: assetId }, data: corrections });
        Object.assign(asset, corrections);
        return true;
      },
    );
    for (const r of projectionResults) {
      if (r.status === "fulfilled" && r.value === true) projectionCorrected++;
    }
    const projFailed = projectionResults.filter((r) => r.status === "rejected").length;
    if (projFailed > 0) {
      syncLog("error", `fortigate-endpoint projection apply: corrected ${projectionCorrected}, ${projFailed} failed`);
    } else if (projectionCorrected > 0) {
      syncLog("info", `fortigate-endpoint projection apply: corrected ${projectionCorrected} of ${fortigateEndpointAssetIds.size} touched assets`);
    }
  }
  return projectionCorrected;
}
