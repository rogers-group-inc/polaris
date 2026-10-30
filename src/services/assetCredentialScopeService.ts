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
import { isFortinetIntegrationType } from "../utils/pollingCompatibility.js";

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

// ─── The credential SNMP polling uses ───────────────────────────────────────
//
// The SNMP Walk tab starts on the credential the asset's own SNMP polling
// authenticates with. Each stream mirrors its collector's chain in
// monitoringService (`resolveSnmpConfigForStream`): the asset's per-stream
// credential, else its default monitor credential — used only when that
// one is SNMP — then the class-override stream credential, then a Fortinet
// integration's monitor credential. Custom MIB widgets keep their own chain
// (widget → sensors → CPU/memory → default, then the integration).

type SnmpStreamField =
  | "responseTimeCredentialId" | "cpuMemoryCredentialId" | "temperatureCredentialId"
  | "interfacesCredentialId" | "lldpCredentialId" | "processesCredentialId" | "eventLogCredentialId";

// Stream order is the walk-tab default's tie-break: the response-time probe
// first, as it is the stream most likely to be SNMP on a device that polls
// over SNMP at all. Storage authenticates as the interfaces stream.
const SNMP_POLLED_STREAMS: { polling: string; credential: SnmpStreamField }[] = [
  { polling: "responseTimePolling", credential: "responseTimeCredentialId" },
  { polling: "cpuMemoryPolling",    credential: "cpuMemoryCredentialId" },
  { polling: "temperaturePolling",  credential: "temperatureCredentialId" },
  { polling: "interfacesPolling",   credential: "interfacesCredentialId" },
  { polling: "lldpPolling",         credential: "lldpCredentialId" },
  { polling: "storagePolling",      credential: "interfacesCredentialId" },
  { polling: "processesPolling",    credential: "processesCredentialId" },
  { polling: "eventLogPolling",     credential: "eventLogCredentialId" },
];

export interface SnmpPollingCredentialInput {
  /** The asset's own credential slots plus its custom-widget polling pick. */
  asset: Partial<Record<SnmpStreamField | "monitorCredentialId" | "customWidgetCredentialId", string | null>> & {
    customWidgetPolling?: string | null;
  };
  /** Resolved monitor settings: the polling picks and the class-override credential ids. */
  resolved: Record<string, unknown>;
  integration: { type: string; config: unknown } | null;
  /** Credential id → type, for every id named above that still exists. */
  credentialTypes: Map<string, string>;
}

/** Every credential id `pickSnmpPollingCredentialId` may look at — the type lookup's key list. */
export function snmpPollingCredentialCandidates(input: Omit<SnmpPollingCredentialInput, "credentialTypes">): string[] {
  const ids = new Set<string>();
  const add = (v: unknown) => { if (typeof v === "string" && v) ids.add(v); };
  for (const [k, v] of Object.entries(input.asset)) if (k !== "customWidgetPolling") add(v);
  for (const s of SNMP_POLLED_STREAMS) add(input.resolved[s.credential]);
  const intCfg = input.integration?.config && typeof input.integration.config === "object"
    ? (input.integration.config as Record<string, unknown>) : {};
  add(intCfg.monitorCredentialId);
  return [...ids];
}

/**
 * The id of the SNMP credential the first SNMP-polled stream authenticates
 * with, or null when nothing is polled over SNMP or no chain ends on one.
 */
export function pickSnmpPollingCredentialId(input: SnmpPollingCredentialInput): string | null {
  const { asset, resolved, integration, credentialTypes } = input;
  const exists = (id: string | null | undefined): id is string => !!id && credentialTypes.has(id);
  const isSnmp = (id: string | null | undefined): id is string => exists(id) && credentialTypes.get(id) === "snmp";
  const intCfg = integration?.config && typeof integration.config === "object"
    ? (integration.config as Record<string, unknown>) : {};
  const intCredId = typeof intCfg.monitorCredentialId === "string" ? intCfg.monitorCredentialId : null;
  const fortinetFallback = isFortinetIntegrationType(integration?.type) && isSnmp(intCredId) ? intCredId : null;

  for (const s of SNMP_POLLED_STREAMS) {
    if (resolved[s.polling] !== "snmp") continue;
    const own = asset[s.credential];
    const effective = exists(own) ? own : asset.monitorCredentialId;
    if (isSnmp(effective)) return effective;
    const classCred = resolved[s.credential];
    if (typeof classCred === "string" && isSnmp(classCred)) return classCred;
    if (fortinetFallback) return fortinetFallback;
  }
  if (asset.customWidgetPolling === "snmp") {
    const widget = [asset.customWidgetCredentialId, asset.temperatureCredentialId, asset.cpuMemoryCredentialId, asset.monitorCredentialId]
      .find((id) => isSnmp(id));
    if (widget) return widget;
    if (fortinetFallback) return fortinetFallback;
  }
  return null;
}

/** `pickSnmpPollingCredentialId` with the credential types read in one query. */
export async function snmpPollingCredentialId(input: Omit<SnmpPollingCredentialInput, "credentialTypes">): Promise<string | null> {
  const ids = snmpPollingCredentialCandidates(input);
  if (ids.length === 0) return null;
  const rows = await prisma.credential.findMany({ where: { id: { in: ids } }, select: { id: true, type: true } });
  return pickSnmpPollingCredentialId({ ...input, credentialTypes: new Map(rows.map((r) => [r.id, r.type])) });
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
