/**
 * src/services/assetBulkMonitorService.ts — POST /assets/bulk-monitor's write:
 * flip `monitored` (plus a uniform credential / cadence) on a selection in one
 * updateMany, refuse the ids whose status cannot carry monitoring (rule 10)
 * per id instead of failing the batch, recompute monitorOverride for the
 * touched ids in one statement, record the credential's new destinations
 * (rule 112), and write the monitor.bulk_* Event. Moved out of
 * routes/assets/list.ts (CQ-B062 slice 2); the route keeps the Zod body.
 */

import { prisma } from "../db.js";
import { clampMonitoredState, statusAllowsMonitoring } from "../utils/assetInvariants.js";
import { assertCredentialAssignments } from "./credentialService.js";
import { recomputeMonitorOverrideForAssets } from "./monitorOverrideService.js";
import { recordCredentialUse, assetCredentialDestination, type CredentialUseActor } from "./credentialUseAuditService.js";
import { logEvent } from "./eventLogService.js";

export interface BulkMonitorInput {
  ids: string[];
  monitored: boolean;
  monitorCredentialId?: string | null;
  monitorIntervalSec?: number | null;
  probeTimeoutMs?: number | null;
}

export async function bulkSetMonitored(
  body: BulkMonitorInput,
  credentialActor: CredentialUseActor,
  actor: string | undefined,
): Promise<{ updated: number; errors: Array<{ id: string; error: string }> }> {
  // Existence only, and deliberately so: the batch carries ONE credential id
  // for every asset in it, so this is a single query no matter how many ids
  // were selected. The per-stream TYPE check the PUT does would need each
  // asset's own polling columns — 2000 rows of them on a full-fleet select —
  // to answer a question this endpoint cannot ask anyway, since it only sets
  // the asset-level default, which is never type-checked.
  await assertCredentialAssignments({ monitorCredentialId: body.monitorCredentialId }, null);

  // Build the per-asset data shape ONCE — every selected asset gets the
  // same monitor config in a bulk operation. monitorOverride is NOT set
  // here because it depends on each asset's discoveredByIntegrationId +
  // assetType (per-asset-varying) — instead we recompute it in one SQL
  // pass against the touched ids after the updateMany lands.
  const data: Record<string, unknown> = {
    monitored: body.monitored,
  };
  if (body.monitorCredentialId !== undefined) data.monitorCredentialId = body.monitorCredentialId;
  if (body.monitorIntervalSec !== undefined)  data.monitorIntervalSec  = body.monitorIntervalSec;
  if (body.probeTimeoutMs !== undefined)      data.probeTimeoutMs      = body.probeTimeoutMs;
  clampMonitoredState(data);

  // Identify which of the requested ids actually exist so the response
  // can flag missing rows. One round-trip vs the previous N-asset loop.
  const found = await prisma.asset.findMany({
    where: { id: { in: body.ids } },
    select: { id: true, status: true, hostname: true, dnsName: true, ipAddress: true, monitorCredentialId: true },
  });
  const foundSet = new Set(found.map((a) => a.id));
  const errors: Array<{ id: string; error: string }> = body.ids
    .filter((id) => !foundSet.has(id))
    .map((id) => ({ id, error: "Asset not found" }));

  // Enabling monitoring on a status that can't carry it (business rule 10):
  // named per id rather than left to the db.ts clamp. A mixed selection is
  // the normal case here — the operator multi-selected a page of assets —
  // so the skipped rows are REPORTED and the rest still go through, instead
  // of failing the whole batch or silently updating rows whose box stays
  // clear.
  if (body.monitored) {
    for (const a of found) {
      if (statusAllowsMonitoring(a.status)) continue;
      foundSet.delete(a.id);
      errors.push({ id: a.id, error: `A ${String(a.status)} asset cannot be monitored` });
    }
  }

  // Single bulk update — Postgres' `WHERE id = ANY(...)` planner walks
  // the (newly-added) primary key once and applies the uniform data
  // change to every matched row. Was 1000 sequential round-trips, is
  // now one statement.
  let updatedCount = 0;
  if (foundSet.size > 0) {
    const result = await prisma.asset.updateMany({
      where: { id: { in: [...foundSet] } },
      data: data as any,
    });
    updatedCount = result.count;
    // Recompute monitorOverride for every touched asset in one SQL UPDATE.
    // Each asset's override depends on its discoveredByIntegrationId +
    // assetType, so it has to be done per-asset against the integration's
    // per-class addAsMonitored. Assets without an integration link are
    // skipped by the WHERE clause and keep monitorOverride=false.
    await recomputeMonitorOverrideForAssets(prisma, [...foundSet]);
    // Rule 112: the credential now goes to every touched asset's address.
    if (body.monitorCredentialId) {
      const credId = body.monitorCredentialId;
      const uses = found
        .filter((a) => foundSet.has(a.id) && a.monitorCredentialId !== credId)
        .map((a) => ({ credentialId: credId, destination: assetCredentialDestination(a), assetId: a.id, assetName: a.hostname ?? a.ipAddress }));
      if (uses.length) await recordCredentialUse(credentialActor, "asset.bulk-monitor", uses);
    }
  }

  logEvent({
    action: body.monitored ? "monitor.bulk_enabled" : "monitor.bulk_disabled",
    resourceType: "asset",
    actor,
    message: `Bulk ${body.monitored ? "enabled" : "disabled"} monitoring on ${updatedCount} asset(s)` + (errors.length ? `; ${errors.length} error(s)` : ""),
    details: errors.length ? { errors } : undefined,
  });
  return { updated: updatedCount, errors };
}
