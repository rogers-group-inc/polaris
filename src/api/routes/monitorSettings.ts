/**
 * src/api/routes/monitorSettings.ts
 *
 * CRUD for the four-tier monitoring settings hierarchy:
 *
 *   asset overrides (columns on Asset)
 *     -> (assetType + integration) class override (MonitorClassOverride table)
 *     -> integration tier   (Integration.config.monitorSettings)
 *        OR manual tier     (Setting "manualMonitorSettings")
 *     -> hardcoded floor    (in monitoringService — not user-visible)
 *
 * Reads are open to any authenticated caller so the asset-modal tier-badge
 * UI works for everyone. Writes require assetsadmin (or admin).
 *
 * Thin route layer: Zod parsing + permission gates only. All business logic
 * (Setting upserts, Integration config rewrites, MonitorClassOverride CRUD,
 * asset reverse-lookups, polling-compatibility validation, resolver-cache
 * invalidation) lives in src/services/monitorSettingsService.ts.
 */

import { Router } from "express";
import { z } from "zod";
import { requirePermission } from "../middleware/permissions.js";
import {
  getManualMonitorSettings,
  updateManualMonitorSettings,
  getIntegrationMonitorSettings,
  updateIntegrationMonitorSettings,
  listClassOverrides,
  createClassOverride,
  updateClassOverride,
  deleteClassOverride,
  listAssetOverrides,
} from "../../services/monitorSettingsService.js";
import { isKnownAssetType } from "../../utils/assetTypes.js";

const router = Router();

// Asset type validated against the AssetTypeDef registry so MonitorClassOverride
// rows can be scoped to operator-added custom types alongside the eight
// built-ins. isKnownAssetType reads the in-memory cache populated at boot;
// before the cache loads it falls back to accepting the eight built-in names.
const AssetTypeSchema = z.string().min(2).max(32).refine(
  (v) => isKnownAssetType(v),
  { message: "Unknown asset type. Add it under Assets → Manage asset types first." },
);

// Mirrors PollingMethod in src/utils/pollingCompatibility.ts. Source-kind
// compatibility is enforced at resolution time inside resolveMonitorSettings —
// not here — so a class-override that sets winrm on a fortinet integration is
// stored fine but silently ignored when resolving that integration's assets.
const PollingMethodEnum = z.enum(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter", "fortimanager", "unraid", "truenas"]);

// Tier-3 / "complete" settings: every cadence field present (no nulls). The
// per-stream polling fields are optional/nullable at every tier — null means
// "use the source default" (fortinet→rest_api, everything else→icmp). Stored
// alongside the cadence fields in Integration.config.monitorSettings (tier-3
// integration) or in the Setting "manualMonitorSettings" row (tier-3 manual).
//
// systemInfoIntervalSeconds note: required at the manual tier (orphan assets
// have no integration to inherit from), but nullable at the integration tier
// — null means "follow this integration's discovery pollInterval", which the
// resolver derives in loadIntegrationTierSettings. See the "integrationPoll-
// Interval" provenance label and the migrateSystemInfoCadenceLinkage startup
// job that retroactively nulls existing 600s defaults so installed fleets
// pick up the linkage on next deploy.
const TierSettingsSchema = z.object({
  intervalSeconds:            z.number().int().min(1).max(86400),
  // DORMANT (business rule 36). The missed-poll count belongs to the covering
  // down-detection automation now, not to this tier — recordProbeResult no
  // longer reads it. Optional rather than removed, and still PERSISTED, for the
  // fastConfirmIntervalSec reasons (see monitoringService's dormant-column
  // note): a client that still sends it must not 400, dropping it would be an
  // irreversible migration for no gain, and the V3 seed reads each install's
  // pre-cutover value to mirror it forward into automations. Nothing renders
  // it — the three settings cards lost the field in the same change.
  failureThreshold:           z.number().int().min(1).max(100).nullable().optional(),
  // Fast-confirm re-probe cadence (business rule 30). Nullable/optional rather
  // than required so a pre-feature client's PUT doesn't 400 — absent means
  // "inherit the floor" (10s). The 5s minimum is the probe loop's own tick;
  // the resolver additionally floors it at the probe timeout, so a legal-but-
  // tighter-than-the-timeout value is raised rather than silently ignored.
  fastConfirmIntervalSec:     z.number().int().min(5).max(300).nullable().optional(),
  probeTimeoutMs:             z.number().int().min(100).max(60000),
  // CPU/memory + temperature + system-info collectors. Range deliberately
  // wider than the response-time probe (1s..120s) — these endpoints can be
  // slow on busy gateways, and a too-tight value here false-fails the scrape.
  cpuMemoryTimeoutMs:         z.number().int().min(1000).max(120000).nullable().optional(),
  temperatureTimeoutMs:       z.number().int().min(1000).max(120000).nullable().optional(),
  systemInfoTimeoutMs:        z.number().int().min(1000).max(120000).nullable().optional(),
  cpuMemoryIntervalSeconds:   z.number().int().min(15).max(86400),
  temperatureIntervalSeconds: z.number().int().min(15).max(86400),
  systemInfoIntervalSeconds:  z.number().int().min(60).max(86400),
  // Phase 1 LLDP + Storage cadences/timeouts: persisted today, inert at
  // runtime (LLDP + Storage still ride systemInfo cadence). Phase 2 wires
  // the actual dispatch + queue carve-out. Tolerated but not required.
  lldpIntervalSeconds:        z.number().int().min(60).max(86400).nullable().optional(),
  lldpTimeoutMs:              z.number().int().min(100).max(120000).nullable().optional(),
  storageIntervalSeconds:     z.number().int().min(60).max(86400).nullable().optional(),
  storageTimeoutMs:           z.number().int().min(100).max(120000).nullable().optional(),
  // Retention used to live on this tier (sample/telemetry/systemInfo
  // RetentionDays). Phase 5 moved it to the global Setting("sampleRetention")
  // edited from Server Settings → Retention. The fields are still tolerated
  // on writes (z.unknown()) so old clients don't 400, but the values are
  // dropped before persistence — no consumer reads them.
  sampleRetentionDays:        z.unknown().optional(),
  telemetryRetentionDays:     z.unknown().optional(),
  systemInfoRetentionDays:    z.unknown().optional(),
  // Cross-transport streams (Phase: processes + event log). Same cadence/timeout
  // shape as LLDP/Storage; method set restricted by STREAM_METHODS + validated
  // in assertPollingCompatible.
  processesIntervalSeconds:   z.number().int().min(60).max(86400).nullable().optional(),
  processesTimeoutMs:         z.number().int().min(100).max(120000).nullable().optional(),
  eventLogIntervalSeconds:    z.number().int().min(60).max(86400).nullable().optional(),
  eventLogTimeoutMs:          z.number().int().min(100).max(120000).nullable().optional(),
  responseTimePolling:        PollingMethodEnum.nullable().optional(),
  cpuMemoryPolling:           PollingMethodEnum.nullable().optional(),
  temperaturePolling:         PollingMethodEnum.nullable().optional(),
  interfacesPolling:          PollingMethodEnum.nullable().optional(),
  lldpPolling:                PollingMethodEnum.nullable().optional(),
  storagePolling:             PollingMethodEnum.nullable().optional(),
  processesPolling:           PollingMethodEnum.nullable().optional(),
  eventLogPolling:            PollingMethodEnum.nullable().optional(),
  // Per-stream MIB IDs stored in the JSON blob ("std:<key>" | uploaded UUID | null)
  responseTimeMibId:          z.string().nullable().optional(),
  cpuMemoryMibId:             z.string().nullable().optional(),
  temperatureMibId:           z.string().nullable().optional(),
  interfacesMibId:            z.string().nullable().optional(),
  lldpMibId:                  z.string().nullable().optional(),
  processesMibId:             z.string().nullable().optional(),
});

// Integration-tier variant: systemInfoIntervalSeconds becomes nullable.
// Null means "follow integration.pollInterval × 3600" — the resolver derives
// the cadence in loadIntegrationTierSettings. Manual tier stays required
// because orphan assets have no integration to inherit from.
const TierSettingsIntegrationSchema = TierSettingsSchema.extend({
  systemInfoIntervalSeconds: z.number().int().min(60).max(86400).nullable(),
});

// Override shape — every field optional/nullable, null = inherit from tier
// below. Used by the class-override CRUD endpoints.
const OverrideSettingsSchema = z.object({
  intervalSeconds:            z.number().int().min(1).max(86400).nullable().optional(),
  failureThreshold:           z.number().int().min(1).max(100).nullable().optional(),
  fastConfirmIntervalSec:     z.number().int().min(5).max(300).nullable().optional(),
  probeTimeoutMs:             z.number().int().min(100).max(60000).nullable().optional(),
  cpuMemoryTimeoutMs:         z.number().int().min(1000).max(120000).nullable().optional(),
  temperatureTimeoutMs:       z.number().int().min(1000).max(120000).nullable().optional(),
  systemInfoTimeoutMs:        z.number().int().min(1000).max(120000).nullable().optional(),
  cpuMemoryIntervalSeconds:   z.number().int().min(15).max(86400).nullable().optional(),
  temperatureIntervalSeconds: z.number().int().min(15).max(86400).nullable().optional(),
  systemInfoIntervalSeconds:  z.number().int().min(60).max(86400).nullable().optional(),
  // Phase 1 LLDP + Storage cadences/timeouts. Same Phase 2 plan as
  // TierSettingsSchema above — persisted, runtime-inert today.
  lldpIntervalSeconds:        z.number().int().min(60).max(86400).nullable().optional(),
  lldpTimeoutMs:              z.number().int().min(100).max(120000).nullable().optional(),
  storageIntervalSeconds:     z.number().int().min(60).max(86400).nullable().optional(),
  storageTimeoutMs:           z.number().int().min(100).max(120000).nullable().optional(),
  processesIntervalSeconds:   z.number().int().min(60).max(86400).nullable().optional(),
  processesTimeoutMs:         z.number().int().min(100).max(120000).nullable().optional(),
  eventLogIntervalSeconds:    z.number().int().min(60).max(86400).nullable().optional(),
  eventLogTimeoutMs:          z.number().int().min(100).max(120000).nullable().optional(),
  // Class-override retention is dead — see the comment on the matching
  // fields in TierSettingsSchema above. Tolerated on input, dropped before
  // persistence; retention now lives globally in Setting("sampleRetention").
  sampleRetentionDays:        z.unknown().optional(),
  telemetryRetentionDays:     z.unknown().optional(),
  systemInfoRetentionDays:    z.unknown().optional(),
  responseTimePolling:        PollingMethodEnum.nullable().optional(),
  cpuMemoryPolling:           PollingMethodEnum.nullable().optional(),
  temperaturePolling:         PollingMethodEnum.nullable().optional(),
  interfacesPolling:          PollingMethodEnum.nullable().optional(),
  lldpPolling:                PollingMethodEnum.nullable().optional(),
  storagePolling:             PollingMethodEnum.nullable().optional(),
  processesPolling:           PollingMethodEnum.nullable().optional(),
  eventLogPolling:            PollingMethodEnum.nullable().optional(),
  // Per-stream credential IDs (FK to Credential, null = inherit)
  responseTimeCredentialId:   z.string().uuid().nullable().optional(),
  cpuMemoryCredentialId:      z.string().uuid().nullable().optional(),
  temperatureCredentialId:    z.string().uuid().nullable().optional(),
  interfacesCredentialId:     z.string().uuid().nullable().optional(),
  lldpCredentialId:           z.string().uuid().nullable().optional(),
  processesCredentialId:      z.string().uuid().nullable().optional(),
  eventLogCredentialId:       z.string().uuid().nullable().optional(),
  // Per-stream MIB IDs ("std:<key>" | uploaded UUID | null = inherit)
  responseTimeMibId:          z.string().nullable().optional(),
  cpuMemoryMibId:             z.string().nullable().optional(),
  temperatureMibId:           z.string().nullable().optional(),
  interfacesMibId:            z.string().nullable().optional(),
  lldpMibId:                  z.string().nullable().optional(),
  processesMibId:             z.string().nullable().optional(),
});

// ─── Manual tier ────────────────────────────────────────────────────────────

/** Read the manual tier (settings for orphan / non-integration-discovered assets). */
router.get("/manual", requirePermission("assetMonitorSettings", "read"), async (_req, res, next) => {
  try {
    res.json(await getManualMonitorSettings());
  } catch (err) { next(err); }
});

/** Write the manual tier. Affects every asset with discoveredByIntegrationId = null. */
router.put("/manual", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const input = TierSettingsSchema.parse(req.body);
    res.json(await updateManualMonitorSettings(input, req.session?.username));
  } catch (err) { next(err); }
});

// ─── Integration tier ───────────────────────────────────────────────────────

/** Read the integration tier (settings stored in Integration.config.monitorSettings). */
router.get("/integration/:id", requirePermission("assetMonitorSettings", "read"), async (req, res, next) => {
  try {
    res.json(await getIntegrationMonitorSettings(req.params.id as string));
  } catch (err) { next(err); }
});

/** Write the integration tier. Affects every asset discovered by this integration. */
router.put("/integration/:id", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const input = TierSettingsIntegrationSchema.parse(req.body);
    res.json(await updateIntegrationMonitorSettings(req.params.id as string, input, req.session?.username));
  } catch (err) { next(err); }
});

// ─── Class overrides ────────────────────────────────────────────────────────

const ClassCreateSchema = z
  .object({
    integrationId: z.string().uuid().nullable(), // null = manual-tier override
    assetType:     AssetTypeSchema,
  })
  .merge(OverrideSettingsSchema);

const ClassUpdateSchema = OverrideSettingsSchema;

/**
 * List class overrides. Filterable by integrationId (use "null" string to
 * select manual-tier overrides) and assetType. Returns the integration name
 * + type alongside each row so the UI can render badges without a join.
 */
router.get("/class-overrides", requirePermission("assetMonitorSettings", "read"), async (req, res, next) => {
  try {
    res.json(await listClassOverrides(req.query.integrationId, req.query.assetType));
  } catch (err) { next(err); }
});

router.post("/class-overrides", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const input = ClassCreateSchema.parse(req.body);
    const created = await createClassOverride(input, req.session?.username);
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.put("/class-overrides/:id", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    const input = ClassUpdateSchema.parse(req.body);
    res.json(await updateClassOverride(req.params.id as string, input, req.session?.username));
  } catch (err) { next(err); }
});

router.delete("/class-overrides/:id", requirePermission("assetMonitorSettings", "write"), async (req, res, next) => {
  try {
    await deleteClassOverride(req.params.id as string, req.session?.username);
    res.status(204).send();
  } catch (err) { next(err); }
});

// ─── Asset-overrides reverse lookup ─────────────────────────────────────────
//
// Lists assets that have at least one per-asset monitor setting override.
// See listAssetOverrides in monitorSettingsService for the field set + scope
// filter semantics.

router.get("/asset-overrides", requirePermission("assetMonitorSettings", "read"), async (req, res, next) => {
  try {
    res.json(await listAssetOverrides(req.query.integrationId, req.query.assetType));
  } catch (err) { next(err); }
});

export default router;
