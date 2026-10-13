/**
 * src/services/assetCredentialScopeService.ts — business rule 112(e): which
 * stored credentials an asset ALREADY uses, so a read-level caller may aim
 * only those at it.
 *
 * Rule 112 trusts whoever may EDIT an asset to aim any credential at it, and
 * audits the act. The SNMP walk (`assetsProbe:read`) and the MIB walks
 * (`mibDatabase:read`) are read-level, so the 2026-10-13 re-scan (F60, F62)
 * found read-only roles sending any stored community / v3 keys to any asset.
 * A read-level walk may now use only a credential this asset's monitoring
 * would use anyway; anything else needs `assets:write`, the rule 112 level.
 *
 * "Already uses" = the asset's own credential slots, the class-override
 * credentials its monitor settings resolve, and its discovering integration's
 * monitor credential.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { ASSET_CREDENTIAL_SLOTS } from "./credentialUseAuditService.js";
import { resolveMonitorSettings } from "./monitoringService.js";

const RESOLVED_CREDENTIAL_FIELDS = [
  "responseTimeCredentialId",
  "cpuMemoryCredentialId",
  "temperatureCredentialId",
  "interfacesCredentialId",
  "lldpCredentialId",
  "processesCredentialId",
  "eventLogCredentialId",
] as const;

/** Every credential id the asset's monitoring may already use. Empty for an unknown asset. */
export async function credentialIdsAttachedToAsset(assetId: string): Promise<Set<string>> {
  const select: Record<string, unknown> = {
    assetType: true,
    ipAddress: true,
    discoveredByIntegrationId: true,
    discoveredByIntegration: { select: { type: true, config: true } },
  };
  for (const slot of ASSET_CREDENTIAL_SLOTS) select[slot] = true;
  const a = (await prisma.asset.findUnique({ where: { id: assetId }, select: select as never })) as
    | (Record<string, unknown> & { discoveredByIntegration?: { type: string; config: unknown } | null })
    | null;
  const out = new Set<string>();
  if (!a) return out;
  for (const slot of ASSET_CREDENTIAL_SLOTS) {
    const v = a[slot];
    if (typeof v === "string" && v) out.add(v);
  }
  const integration = a.discoveredByIntegration ?? null;
  const resolved = await resolveMonitorSettings({
    assetType: typeof a.assetType === "string" ? a.assetType : "other",
    ipAddress: typeof a.ipAddress === "string" ? a.ipAddress : null,
    discoveredByIntegrationId: typeof a.discoveredByIntegrationId === "string" ? a.discoveredByIntegrationId : null,
    discoveredByIntegrationType: integration?.type ?? null,
    monitorIntervalSec: null,
    cpuMemoryIntervalSec: null,
    temperatureIntervalSec: null,
    systemInfoIntervalSec: null,
    probeTimeoutMs: null,
  });
  for (const f of RESOLVED_CREDENTIAL_FIELDS) {
    const v = (resolved as unknown as Record<string, unknown>)[f];
    if (typeof v === "string" && v) out.add(v);
  }
  const intCfg = integration?.config && typeof integration.config === "object" ? (integration.config as Record<string, unknown>) : {};
  if (typeof intCfg.monitorCredentialId === "string" && intCfg.monitorCredentialId) out.add(intCfg.monitorCredentialId);
  return out;
}

/**
 * Refuse (403) a read-level caller aiming a credential the asset does not
 * already use. `mayUseAnyCredential` is the caller's assets:write.
 */
export async function assertCredentialInAssetScope(
  assetId: string,
  credentialId: string,
  mayUseAnyCredential: boolean,
): Promise<void> {
  if (mayUseAnyCredential) return;
  const attached = await credentialIdsAttachedToAsset(assetId);
  if (attached.has(credentialId)) return;
  throw new AppError(
    403,
    "Walking with a credential this asset does not already use needs Assets Read-Write — it sends that credential to the asset. Pick the asset's own SNMP credential, or ask someone who can edit the asset.",
  );
}
