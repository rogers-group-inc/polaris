/**
 * src/services/monitorSettingsService.ts
 *
 * Business logic for the four-tier monitoring settings hierarchy:
 *
 *   asset overrides (columns on Asset)
 *     -> (assetType + integration) class override (MonitorClassOverride table)
 *     -> integration tier   (Integration.config.monitorSettings)
 *        OR manual tier     (Setting "manualMonitorSettings")
 *     -> hardcoded floor    (in monitoringService — not user-visible)
 *
 * Extracted from src/api/routes/monitorSettings.ts — the route file keeps the
 * Zod schemas + permission gates and delegates every handler body here.
 *
 * Every write invalidates the in-memory resolver cache in monitoringService
 * for the matching scope so the next monitor pass picks up the change
 * within one tick.
 */

import { prisma } from "../db.js";
import { invalidateMonitorSettingsCache } from "./monitoringService.js";
import { logEvent } from "./eventLogService.js";
import { AppError } from "../utils/errors.js";
import {
  type PollingMethod,
  type AssetSourceKind,
  type Stream,
  assetSourceKindFromIntegrationType,
  isPollingMethodCompatible,
  isMethodValidForStream,
  pollingMethodLabel,
} from "../utils/pollingCompatibility.js";
import { collectorCapability } from "../utils/pollingCapability.js";
import { logger } from "../utils/logger.js";

// Polling-method compatibility check shared by integration-tier and
// class-override writes. A tier whose source is fixed (any single integration
// or a class override scoped to one) cannot store a method that wouldn't
// apply on the assets it covers — the resolver would silently fall through
// and the operator would never see why their setting "didn't take." Manual
// tier accepts every method (it covers any source).
const POLLING_FIELDS = ["responseTimePolling", "cpuMemoryPolling", "temperaturePolling", "interfacesPolling", "lldpPolling", "storagePolling", "processesPolling", "eventLogPolling"] as const;
type PollingField = (typeof POLLING_FIELDS)[number];

/**
 * Parsed tier-settings / override-settings payload as the route hands it over:
 * the Zod-validated body, typed loosely here so the service stays decoupled
 * from the route-side schemas while assertPollingCompatible can still read
 * the per-stream polling fields.
 */
export type TierSettingsInput = Record<string, unknown> &
  Partial<Record<PollingField, PollingMethod | null | undefined>>;

/** Parsed class-override create payload (scope keys + override settings). */
export type ClassOverrideCreateInput = TierSettingsInput & {
  integrationId: string | null;
  assetType: string;
};

function assertPollingCompatible(
  source: AssetSourceKind,
  input: Partial<Record<PollingField, PollingMethod | null | undefined>>,
): void {
  for (const field of POLLING_FIELDS) {
    const v = input[field];
    if (!v) continue;
    if (!isPollingMethodCompatible(source, v)) {
      throw new AppError(
        400,
        `${pollingMethodLabel(v)} polling is not supported for ${source} assets (field: ${field})`,
      );
    }
    // Per-stream method restriction: the cross-transport streams (processes,
    // eventLog) accept only a subset of methods — processes can't ride REST,
    // eventLog can't ride SNMP, neither rides ICMP. The Stream name is the
    // field minus its "Polling" suffix. Streams without a restriction (the
    // original six) pass through unchanged.
    const stream = field.replace(/Polling$/, "") as Stream;
    if (!isMethodValidForStream(stream, v)) {
      throw new AppError(
        400,
        `${pollingMethodLabel(v)} polling is not supported for the ${stream} stream (field: ${field})`,
      );
    }
    // ICMP is only meaningful for the response-time probe — for telemetry /
    // interfaces / LLDP / storage / temperature there's no payload to gather
    // from an ICMP echo. Reject so an operator pick doesn't silently
    // fall through at resolution time.
    if (v === "icmp" && field !== "responseTimePolling") {
      throw new AppError(
        400,
        `ICMP polling is only valid for the response-time stream (field: ${field})`,
      );
    }
    // Does a collector actually exist? WARN rather than throw: a hard refusal
    // would 400 an operator who merely re-saves an integration that already
    // holds one of these values, punishing them for a gap they didn't create.
    // The UI stops offering them and a startup audit names the stored ones; the
    // log line is the third net, for an API caller that sees neither.
    const cap = collectorCapability(source, stream, v);
    if (!cap.implemented) {
      logger.warn(
        { source, stream, method: v, field, reason: cap.reason },
        `Monitor settings accepted a polling method with no collector — this stream will silently collect nothing: ${cap.reason}`,
      );
    }
  }
}

const MANUAL_SETTING_KEY = "manualMonitorSettings";

/**
 * Strip legacy retention keys from a tier-3 or class-override blob before
 * persistence. Retention moved to Setting("sampleRetention") in phase 5;
 * the schema still tolerates the keys on input so old clients don't 400,
 * but persistence drops them so the JSON stays clean.
 */
function stripLegacyRetention<T extends Record<string, unknown>>(input: T): Omit<T, "sampleRetentionDays" | "telemetryRetentionDays" | "systemInfoRetentionDays"> {
  const { sampleRetentionDays: _s, telemetryRetentionDays: _t, systemInfoRetentionDays: _i, ...rest } = input;
  void _s; void _t; void _i;
  return rest;
}

// ─── Manual tier ────────────────────────────────────────────────────────────

/** Read the manual tier (settings for orphan / non-integration-discovered assets). */
export async function getManualMonitorSettings(): Promise<unknown> {
  const row = await prisma.setting.findUnique({ where: { key: MANUAL_SETTING_KEY } });
  // null = not yet seeded; the UI shows the hardcoded-floor defaults until
  // an operator saves something.
  return row?.value ?? null;
}

/** Write the manual tier. Affects every asset with discoveredByIntegrationId = null. */
export async function updateManualMonitorSettings(
  rawInput: TierSettingsInput,
  actor: string | undefined,
): Promise<unknown> {
  const input = stripLegacyRetention(rawInput);
  await prisma.setting.upsert({
    where:  { key: MANUAL_SETTING_KEY },
    update: { value: input as any },
    create: { key: MANUAL_SETTING_KEY, value: input as any },
  });
  invalidateMonitorSettingsCache({ integrationId: null });
  logEvent({
    action: "monitor_settings.manual.updated",
    resourceType: "monitor_settings",
    resourceName: "Manual tier",
    actor,
    message: "Manual monitoring settings updated",
    details: { settings: input },
  });
  return input;
}

// ─── Integration tier ───────────────────────────────────────────────────────

/** Read the integration tier (settings stored in Integration.config.monitorSettings). */
export async function getIntegrationMonitorSettings(integrationId: string): Promise<{
  integrationId: string;
  integrationName: string;
  integrationType: string;
  settings: unknown;
}> {
  const integration = await prisma.integration.findUnique({
    where:  { id: integrationId },
    select: { id: true, name: true, type: true, config: true },
  });
  if (!integration) throw new AppError(404, "Integration not found");
  const cfg = (integration.config as Record<string, unknown> | null) ?? {};
  return {
    integrationId:   integration.id,
    integrationName: integration.name,
    integrationType: integration.type,
    // null = not yet seeded for this integration; UI displays defaults.
    settings:        (cfg.monitorSettings as unknown) ?? null,
  };
}

/** Write the integration tier. Affects every asset discovered by this integration. */
export async function updateIntegrationMonitorSettings(
  integrationId: string,
  rawInput: TierSettingsInput,
  actor: string | undefined,
): Promise<unknown> {
  const input = stripLegacyRetention(rawInput);
  const integration = await prisma.integration.findUnique({
    where:  { id: integrationId },
    select: { id: true, name: true, type: true, config: true },
  });
  if (!integration) throw new AppError(404, "Integration not found");
  // Tier-3 integration polling methods must apply on the integration's
  // source kind — picking WinRM on a FortiManager tier silently drops to
  // the source default at resolve time, leaving the operator confused
  // about why their selection "didn't take."
  assertPollingCompatible(assetSourceKindFromIntegrationType(integration.type), input);
  const cfg = (integration.config as Record<string, unknown> | null) ?? {};
  cfg.monitorSettings = input;
  await prisma.integration.update({
    where: { id: integrationId },
    data:  { config: cfg as any },
  });
  invalidateMonitorSettingsCache({ integrationId });
  logEvent({
    action: "monitor_settings.integration.updated",
    resourceType: "integration",
    resourceId: integrationId,
    resourceName: integration.name,
    actor,
    message: `Monitoring settings updated for integration "${integration.name}"`,
    details: { settings: input },
  });
  return input;
}

// ─── Class overrides ────────────────────────────────────────────────────────

/**
 * List class overrides. Filterable by integrationId (use "null" string to
 * select manual-tier overrides) and assetType. Returns the integration name
 * + type alongside each row so the UI can render badges without a join.
 */
export async function listClassOverrides(
  integrationIdParam: unknown,
  assetTypeParam: unknown,
) {
  const where: Record<string, unknown> = {};
  if (integrationIdParam === "null")          where.integrationId = null;
  else if (typeof integrationIdParam === "string") where.integrationId = integrationIdParam;
  if (typeof assetTypeParam === "string") where.assetType = assetTypeParam;

  return prisma.monitorClassOverride.findMany({
    where,
    include: { integration: { select: { id: true, name: true, type: true } } },
    orderBy: [{ assetType: "asc" }],
  });
}

export async function createClassOverride(
  input: ClassOverrideCreateInput,
  actor: string | undefined,
) {
  // Phase 2 narrowing — integration-scoped class overrides are no longer
  // accepted. Each integration owns per-class settings natively via its
  // Monitoring tab's per-class streams blocks; the Assets-page
  // Class Overrides surface is for manually-added assets only
  // (integrationId = null). The Phase 2 migration job folds any
  // existing integration-scoped rows into the integration streams blocks
  // and deletes them, so by the time this guard fires the DB is clean.
  if (input.integrationId !== null) {
    throw new AppError(
      400,
      "Integration-scoped class overrides are no longer supported — configure per-class settings on the integration's Monitoring tab.",
    );
  }
  const sourceKind: AssetSourceKind = "manual";
  // Class overrides scoped to a single integration must use polling methods
  // valid for that integration's source kind. Manual-tier overrides
  // (integrationId = null) cover any source so they accept any method.
  assertPollingCompatible(sourceKind, input);
  // Service-layer uniqueness for the manual-tier case (Postgres treats nulls
  // as distinct, so the @@unique alone won't catch it).
  const existing = await prisma.monitorClassOverride.findFirst({
    where: { integrationId: input.integrationId, assetType: input.assetType },
  });
  if (existing) {
    throw new AppError(
      409,
      `Class override for (${input.integrationId ?? "manual"}, ${input.assetType}) already exists`,
    );
  }

  const { integrationId, assetType, ...rest } = input;
  const settings = stripLegacyRetention(rest);
  const created = await prisma.monitorClassOverride.create({
    // Cast at the route→service seam: the settings blob arrives as the
    // route's Zod-validated payload typed loosely (TierSettingsInput).
    data:    { integrationId, assetType, ...settings } as any,
    include: { integration: { select: { id: true, name: true, type: true } } },
  });
  invalidateMonitorSettingsCache({ integrationId, assetType });
  logEvent({
    action: "monitor_settings.class_override.created",
    resourceType: "monitor_class_override",
    resourceId: created.id,
    resourceName: `${assetType} @ ${created.integration?.name ?? "Manual"}`,
    actor,
    message: `Class override created for ${assetType} under ${created.integration?.name ?? "Manual"}`,
    details: { settings },
  });
  return created;
}

/** One class override as stored, or null. */
export async function getClassOverride(id: string) {
  return prisma.monitorClassOverride.findUnique({ where: { id } });
}

export async function updateClassOverride(
  id: string,
  rawInput: TierSettingsInput,
  actor: string | undefined,
) {
  const input = stripLegacyRetention(rawInput);
  const existing = await prisma.monitorClassOverride.findUnique({
    where:   { id },
    include: { integration: { select: { type: true } } },
  });
  if (!existing) throw new AppError(404, "Class override not found");
  // Phase 2 narrowing — refuse updates to integration-scoped rows. The
  // migration job should have folded + deleted these, but defend against
  // a partial-rollback / leftover row that escaped the sweep.
  if (existing.integrationId !== null) {
    throw new AppError(
      400,
      "Integration-scoped class overrides are no longer supported — configure per-class settings on the integration's Monitoring tab.",
    );
  }
  // Same compatibility check as create — keep operators from saving a
  // method that wouldn't apply on the assets this row covers.
  const sourceKind: AssetSourceKind = "manual";
  void assetSourceKindFromIntegrationType; // kept for backward-compat with any future callsite
  assertPollingCompatible(sourceKind, input);
  const updated = await prisma.monitorClassOverride.update({
    where:   { id },
    // Cast at the route→service seam — see createClassOverride above.
    data:    input as any,
    include: { integration: { select: { id: true, name: true, type: true } } },
  });
  invalidateMonitorSettingsCache({
    integrationId: existing.integrationId,
    assetType:     existing.assetType,
  });
  logEvent({
    action: "monitor_settings.class_override.updated",
    resourceType: "monitor_class_override",
    resourceId: updated.id,
    resourceName: `${updated.assetType} @ ${updated.integration?.name ?? "Manual"}`,
    actor,
    message: `Class override updated for ${updated.assetType} under ${updated.integration?.name ?? "Manual"}`,
    details: { settings: input },
  });
  return updated;
}

export async function deleteClassOverride(
  id: string,
  actor: string | undefined,
): Promise<void> {
  const existing = await prisma.monitorClassOverride.findUnique({
    where:   { id },
    include: { integration: { select: { id: true, name: true } } },
  });
  if (!existing) throw new AppError(404, "Class override not found");
  await prisma.monitorClassOverride.delete({ where: { id } });
  invalidateMonitorSettingsCache({
    integrationId: existing.integrationId,
    assetType:     existing.assetType,
  });
  logEvent({
    action: "monitor_settings.class_override.deleted",
    resourceType: "monitor_class_override",
    resourceId: id,
    resourceName: `${existing.assetType} @ ${existing.integration?.name ?? "Manual"}`,
    actor,
    message: `Class override deleted for ${existing.assetType} under ${existing.integration?.name ?? "Manual"}`,
  });
}

// ─── Asset-overrides reverse lookup ─────────────────────────────────────────
//
// Lists assets that have at least one per-asset monitor setting override
// (monitorIntervalSec / telemetryIntervalSec / systemInfoIntervalSec /
// probeTimeoutMs). Filterable by the same scope as a class override, so the
// "Asset Overrides" button on the integration/class modal can show "which
// assets are individually deviating from the settings inherited at this
// scope" — and the operator can click through to fix each one.

export async function listAssetOverrides(
  integrationIdParam: unknown,
  assetTypeParam: unknown,
) {
  const assetType = typeof assetTypeParam === "string" ? assetTypeParam : undefined;

  const where: Record<string, unknown> = {
    OR: [
      { monitorIntervalSec:     { not: null } },
      { cpuMemoryIntervalSec:   { not: null } },
      { temperatureIntervalSec: { not: null } },
      { systemInfoIntervalSec:  { not: null } },
      { probeTimeoutMs:         { not: null } },
      { cpuMemoryTimeoutMs:     { not: null } },
      { temperatureTimeoutMs:   { not: null } },
      { systemInfoTimeoutMs:    { not: null } },
      { responseTimePolling:    { not: null } },
      { cpuMemoryPolling:       { not: null } },
      { temperaturePolling:     { not: null } },
      { interfacesPolling:      { not: null } },
      { lldpPolling:            { not: null } },
      { storagePolling:         { not: null } },
    ],
  };
  if (integrationIdParam === "null") where.discoveredByIntegrationId = null;
  else if (typeof integrationIdParam === "string") where.discoveredByIntegrationId = integrationIdParam;
  if (assetType) where.assetType = assetType;

  return prisma.asset.findMany({
    where,
    select: {
      id:                       true,
      hostname:                 true,
      ipAddress:                true,
      assetType:                true,
      monitorIntervalSec:       true,
      cpuMemoryIntervalSec:     true,
      temperatureIntervalSec:   true,
      systemInfoIntervalSec:    true,
      probeTimeoutMs:           true,
      cpuMemoryTimeoutMs:       true,
      temperatureTimeoutMs:     true,
      systemInfoTimeoutMs:      true,
      responseTimePolling:      true,
      cpuMemoryPolling:         true,
      temperaturePolling:       true,
      interfacesPolling:        true,
      lldpPolling:              true,
      storagePolling:           true,
      discoveredByIntegrationId: true,
    },
    orderBy: { hostname: "asc" },
    take:    500,
  });
}
