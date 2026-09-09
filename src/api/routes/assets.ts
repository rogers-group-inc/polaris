/**
 * src/api/routes/assets.ts — Asset management CRUD
 * GET routes are available to all authenticated users.
 * POST / PUT / DELETE require assets admin role.
 */

import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { mapWithConcurrency } from "../../utils/concurrency.js";
import { requirePermission, hasPermission } from "../middleware/permissions.js";
import { requestActor } from "../middleware/auth.js";
import { machineApiLimiter } from "../middleware/rateLimits.js";
import { logEvent, buildChanges } from "./events.js";
import { buildFirmwareChangedEvent, logEventsBatch, type LogEventInput } from "../../services/eventLogService.js";
import { assetMatchesIntegrationFilter } from "../../utils/integrationFilter.js";
import { getConfiguredResolver } from "../../services/dnsService.js";
import { lookupOui, lookupOuiOverride } from "../../services/ouiService.js";
import {
  clampAcquiredToLastSeen,
  EXCLUDED_LIFECYCLE_STATUSES,
  statusAllowsMonitoring,
  UNMONITORABLE_STATUSES,
} from "../../utils/assetInvariants.js";
import { getIpHistory, getHistorySettings, updateHistorySettings, pruneOldHistory } from "../../services/assetIpHistoryService.js";
import { getSightingsForAsset, getSightingSettings, updateSightingSettings } from "../../services/assetSightingService.js";
import {
  quarantineAsset,
  releaseQuarantine,
  verifyAssetQuarantine,
  getQuarantinePushAvailability,
} from "../../services/assetQuarantineService.js";
import { syncDescriptionsOnSave } from "../../services/descriptionSyncService.js";
import { cidrContains } from "../../utils/cidr.js";
import { buildIpContexts } from "../../services/subnetService.js";
import { isKnownAssetType } from "../../utils/assetTypes.js";
import { recomputeMonitorOverrideForAssets, getAddAsMonitoredFromConfig } from "../../services/monitorOverrideService.js";
import { reconcileTagsForAsset, listAssetTags } from "../../services/tagAssignmentService.js";
import { manualCoordPatchError } from "../../utils/geo.js";
import { reconcileMapRegions } from "../../services/mapRegionService.js";
import { mergeAssets, MERGEABLE_FIELDS, type MergeableField, type FieldWinner } from "../../services/assetMergeService.js";
import { projectAssetFromSources } from "../../utils/assetProjection.js";
import { deriveAssetSourceState } from "../../utils/assetSourceState.js";
import { resolvePendingIpOverrideConflicts } from "../../services/ipOverrideService.js";
import { getDiscoveredHostnames, getDiscoveredHostname, findAssetIdsByDiscoveredHostname } from "../../services/discoveredHostnameService.js";
import { shapeMacRows, MAC_ROW_SELECT } from "../../utils/macAddresses.js";
import { csvParam } from "../../utils/text.js";
import { buildPrismaTextFilter, TEXT_FILTER_OPS } from "../../utils/prismaTextFilter.js";
import {
  probeAsset, recordProbeResult,
  collectTelemetry, recordTelemetryResult,
  collectHardwareSensors, recordHardwareSensorResult,
  collectSystemInfo, recordSystemInfoResult,
  snmpWalkRaw,
  resolveMonitorSettings,
  resolveMonitorSettingsWithProvenance,
} from "../../services/monitoringService.js";
import { getApRadioInventory } from "../../services/apRadioService.js";
import { describeDownDetectionFor, recoveryPollsFor } from "../../services/downDetectionService.js";
import { getArpEntryRetentionDays } from "../../services/sampleRetentionService.js";
import { getCredential } from "../../services/credentialService.js";
import { resolveConnectionPath } from "../../services/connectionPathService.js";
import { resolveAssetUpstream } from "../../services/assetUpstreamService.js";
import { shapeManagementAccessForClient } from "../../services/fortinetManagementAccessService.js";
import { propagateAfterStatusChange, FORTINET_INFRA_ASSET_TYPES } from "../../services/dependencyTreeService.js";
import { pickSampleTierForAsset } from "../../services/sampleQueryRouter.js";
import {
  readMonitorHistory,
  readLastMonitorSuccessAt,
  readTelemetryHistory,
  readHardwareSensorHistory,
  readInterfaceHistory,
  readStorageHistory,
  readProcessHistory,
  readPollingHistorySummary,
} from "../../services/sampleHistoryService.js";
import { evaluateLogFlags } from "../../services/logFlagRuleService.js";
import { getAssetNotifications, activeAlertSummaryByAsset } from "../../services/notificationService.js";
import { getMetricSeverityTiers, listScopeOptions } from "../../services/notificationRuleService.js";
import { SCOPE_FIELD_OPS, scopeConditionMeta, scopeConditionSchema } from "../../services/notificationTypes.js";
import { loadScopeAssetIds } from "../../services/notificationEngine.js";
import { listAssetTypes } from "../../services/assetTypeService.js";
import {
  applyMassPins,
  getPinInventoryForAssets,
  MASS_PIN_MAX_ASSETS,
  MASS_PIN_MAX_DELTAS,
} from "../../services/massPinService.js";
import { operatorReleaseAsset, listAssetWindows, getAssetMaintenanceInfo } from "../../services/maintenanceScheduleService.js";
import { resolveContactsForAsset } from "../../services/contactService.js";
import { releaseInfraReservationsForAssets } from "../../services/reservationService.js";
import { getAssetProcessConnections } from "../../services/applicationMapService.js";
import { recordOperatorPinChanges, type OperatorPinChange } from "../../services/appMapDiscoveryService.js";
import {
  readIpsecHistory,
  readPerfSlaHistory,
  readSdwanMembers,
} from "../../services/sampleHistoryService.js";
import { readProbeOutages, serializeOutages } from "../../services/probeOutageService.js";
import {
  type PollingMethod,
  type Stream,
  assetSourceKindFromIntegrationType,
  isFortinetIntegrationType,
  isMethodValidForStream,
  isPollingMethodCompatible,
  pollingMethodLabel,
} from "../../utils/pollingCompatibility.js";
import { collectorCapability } from "../../utils/pollingCapability.js";
import { logger } from "../../utils/logger.js";
import {
  buildInferredNeighborsForAsset,
  dedupeInferredNeighbors,
  aggregateMembershipMap,
} from "../../services/peerInferredLldpService.js";
// Cross-route-file import precedent: serverSettings.ts imports
// hasActiveDiscoveries from ./integrations.js the same way.
import { triggerDiscovery } from "../../services/discovery/discoveryEngine.js";
import { resolveDiscoveryScopeForAsset } from "../../services/discovery/assetDiscoveryScope.js";
import { isRunActive } from "../../services/discoveryRunState.js";

const router = Router();

// ─── associatedIps shape helper ──────────────────────────────────────────────
//
// `Asset.associatedIps` was a JSONB column until the side-table migration; the
// frontend (`public/js/assets.js`) and any external API consumer still expect
// the response to carry an `associatedIps: [...]` JSON array on the asset
// object. Rather than change the wire format, every place that reads asset
// rows + their `associatedIpRows` relation runs the rows through this helper
// to project them back into the original JSON shape.

interface AssociatedIpJson {
  ip: string;
  source: string;
  interfaceName?: string;
  mac?: string;
  ptrName?: string;
  ptrTtl?: number;
  ptrFetchedAt?: string;
  lastSeen?: string;
  firstSeen?: string;
}

interface AssociatedIpRow {
  ip: string;
  source: string;
  interfaceName: string | null;
  mac: string | null;
  ptrName: string | null;
  ptrTtl: number | null;
  ptrFetchedAt: Date | null;
  lastSeen: Date;
  firstSeen: Date;
}

function shapeAssociatedIps(rows: AssociatedIpRow[] | null | undefined): AssociatedIpJson[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const out: AssociatedIpJson = { ip: r.ip, source: r.source };
    if (r.interfaceName) out.interfaceName = r.interfaceName;
    if (r.mac)           out.mac           = r.mac;
    if (r.ptrName)       out.ptrName       = r.ptrName;
    if (r.ptrTtl != null) out.ptrTtl       = r.ptrTtl;
    if (r.ptrFetchedAt)   out.ptrFetchedAt = r.ptrFetchedAt.toISOString();
    out.lastSeen  = r.lastSeen.toISOString();
    out.firstSeen = r.firstSeen.toISOString();
    return out;
  });
}

const ASSOCIATED_IP_SELECT = {
  ip: true, source: true, interfaceName: true, mac: true,
  ptrName: true, ptrTtl: true, ptrFetchedAt: true,
  lastSeen: true, firstSeen: true,
} as const;

// ─── Zod Schemas ─────────────────────────────────────────────────────────────

// Asset type is now a free-form string validated against the AssetTypeDef
// registry (eight built-ins + any operator-added custom types). The synchronous
// `isKnownAssetType` reads the in-memory cache populated at boot by
// assetTypeService.refreshCache(); until the cache loads it falls back to
// accepting the eight built-in names, which keeps early-boot writes legal.
const AssetTypeEnum = z.string().min(2).max(32).refine(
  (v) => isKnownAssetType(v),
  { message: "Unknown asset type. Add it under Assets → Manage asset types first." },
);

const AssetStatusEnum = z.enum([
  "active", "maintenance", "decommissioned", "storage", "disabled", "quarantined",
]);

const macRegex = /^([0-9A-Fa-f]{2}[:\-]){5}[0-9A-Fa-f]{2}$/;

const CreateAssetSchema = z.object({
  ipAddress:     z.string().min(1).optional(),
  macAddress:    z.string().regex(macRegex, "Invalid MAC address format (expected AA:BB:CC:DD:EE:FF)").optional(),
  hostname:      z.string().optional(),
  dnsName:       z.string().optional(),
  assetTag:      z.string().optional(),
  serialNumber:  z.string().optional(),
  manufacturer:  z.string().optional(),
  model:         z.string().optional(),
  assetType:     AssetTypeEnum.optional().default("other"),
  status:        AssetStatusEnum.optional().default("active"),
  location:      z.string().optional(),
  // Manual geo pin (decimal degrees). Travels as a pair — both numbers, both
  // null (clear), or both omitted; pair semantics enforced in the handlers
  // via manualCoordPatchError. Setting stamps coordSource="manual" so the
  // discovery-projected coords can't overwrite; clearing resets coordSource
  // so discovery may repopulate on its next cycle.
  latitude:      z.number().min(-90).max(90).nullable().optional(),
  longitude:     z.number().min(-180).max(180).nullable().optional(),
  department:    z.string().optional(),
  assignedTo:    z.string().optional(),
  os:            z.string().optional(),
  acquiredAt:    z.string().datetime().optional().or(z.literal("")).transform(v => v || undefined),
  warrantyExpiry:z.string().datetime().optional().or(z.literal("")).transform(v => v || undefined),
  purchaseOrder: z.string().optional(),
  notes:         z.string().optional(),
  // Operator-owned device description. On Fortinet assets whose originating
  // integration has `syncDescriptions` on, the PUT handler mirrors it to the
  // device (Polaris-primary; see descriptionSyncService). Device-side caps
  // are tighter for some targets (FortiGate alias ~35) — the push truncates.
  description:   z.string().max(255).optional(),
  tags:          z.array(z.string()).optional(),
});

// Mirrors PollingMethod in src/utils/pollingCompatibility.ts. Source-kind
// compatibility is enforced at resolution time, not here — the resolver
// silently falls through to the next tier when a per-asset override doesn't
// apply to the asset's source. Includes "disabled" (universally allowed
// opt-out) and "agent" (Polaris Agent; allowed on AD/Entra/WinServer/Manual
// sources, ignored on fortimanager/fortigate).
const PollingMethodEnum = z.enum(["rest_api", "snmp", "winrm", "ssh", "icmp", "disabled", "agent", "vcenter", "fortimanager"]);

const UpdateAssetSchema = CreateAssetSchema.partial().extend({
  // Unlike create (min(1)), update accepts "" — blanking the IP Address field
  // releases the operator IP pin (Asset.ipOverride) and reverts to the
  // discovery-projected address, mirroring the hostname-override clear path.
  ipAddress:             z.string().optional(),
  monitored:             z.boolean().optional(),
  monitorCredentialId:          z.string().uuid().nullable().optional(),
  responseTimeCredentialId:     z.string().uuid().nullable().optional(),
  cpuMemoryCredentialId:        z.string().uuid().nullable().optional(),
  temperatureCredentialId:      z.string().uuid().nullable().optional(),
  interfacesCredentialId:       z.string().uuid().nullable().optional(),
  lldpCredentialId:             z.string().uuid().nullable().optional(),
  // Per-stream MIB overrides ("std:<key>" | uploaded MIB UUID | null = inherit)
  responseTimeMibId:            z.string().nullable().optional(),
  cpuMemoryMibId:               z.string().nullable().optional(),
  temperatureMibId:             z.string().nullable().optional(),
  interfacesMibId:              z.string().nullable().optional(),
  lldpMibId:                    z.string().nullable().optional(),
  monitorIntervalSec:           z.number().int().min(5).max(86400).nullable().optional(),
  // Per-asset probe timeout override. 100..60000 ms; null inherits from the
  // resolved tier-3 setting. The frontend renders a soft warning at <500 ms.
  probeTimeoutMs:        z.number().int().min(100).max(60000).nullable().optional(),
  // Per-asset overrides for the heavy collectors. 1000..120000 ms; null = inherit.
  // Wider range than probeTimeoutMs — these scrapes pull dozens of OIDs or
  // multi-MB FortiOS payloads, and a too-tight ceiling false-fails the run.
  cpuMemoryTimeoutMs:    z.number().int().min(1000).max(120000).nullable().optional(),
  temperatureTimeoutMs:  z.number().int().min(1000).max(120000).nullable().optional(),
  systemInfoTimeoutMs:   z.number().int().min(1000).max(120000).nullable().optional(),
  // Per-stream polling-method overrides — top-tier override, falls through
  // to the class override / integration tier / source default. Compatibility
  // with the asset's source kind is enforced at PUT time below.
  responseTimePolling:   PollingMethodEnum.nullable().optional(),
  cpuMemoryPolling:      PollingMethodEnum.nullable().optional(),
  temperaturePolling:    PollingMethodEnum.nullable().optional(),
  interfacesPolling:     PollingMethodEnum.nullable().optional(),
  lldpPolling:           PollingMethodEnum.nullable().optional(),
  storagePolling:        PollingMethodEnum.nullable().optional(),
  // Per-asset request path for the "http" response-time check, overriding the
  // path used by an HTTP-check widget. Blank clears the override (see
  // the trim below) — it does NOT mean "/", so emptying the box returns the
  // device to the credential's path rather than repointing it at the web root.
  httpCheckPath:         z.string().max(1024).nullable().optional(),
  // Per-asset cadence overrides for the System tab. Null falls back to the
  // resolved tier-3 cadence (cpuMemory / temperature / system-info).
  cpuMemoryIntervalSec:   z.number().int().min(15).max(86400).nullable().optional(),
  temperatureIntervalSec: z.number().int().min(15).max(86400).nullable().optional(),
  systemInfoIntervalSec:  z.number().int().min(60).max(86400).nullable().optional(),
  // ifNames the operator pinned for fast-cadence polling on the System tab.
  // Cap at 64 so an accidental "select-all on a 200-port chassis" can't
  // saturate the device every probe interval.
  monitoredInterfaces:   z.array(z.string().min(1)).max(64).optional(),
  // hrStorage mountPaths pinned for fast-cadence polling. Same model + cap as
  // monitoredInterfaces — keeps a server with hundreds of mountpoints from
  // re-walking the full storage table once per minute by accident.
  monitoredStorage:      z.array(z.string().min(1)).max(64).optional(),
  // Phase-1 IPsec tunnel names pinned for fast-cadence polling. The full
  // /api/v2/monitor/vpn/ipsec endpoint can be slow on busy gateways so it's
  // skipped on the fast cadence by default; pinning issues a targeted scrape.
  monitoredIpsecTunnels: z.array(z.string().min(1)).max(64).optional(),
  // Process names pinned for per-minute CPU/RAM telemetry + log tailing
  // (Processes-tab "Monitor" checkbox). Same 64 cap.
  monitoredProcesses:    z.array(z.string().min(1)).max(64).optional(),
  // Process names flagged for future alerting (Processes-tab "Alert" checkbox).
  alertWatchedProcesses: z.array(z.string().min(1)).max(64).optional(),
  // Process names toggled for Application Map connection discovery
  // (Processes-tab "Map" checkbox). Same 64 cap; independent of the Monitor pin.
  mappedProcesses:       z.array(z.string().min(1)).max(64).optional(),
  // Service/unit names pinned for per-unit journalctl tailing (Services-tab
  // "Logs" checkbox) and Application Map connection attribution ("Map"
  // checkbox). Services-tab siblings of monitored/mappedProcesses.
  monitoredServices:     z.array(z.string().min(1)).max(64).optional(),
  mappedServices:        z.array(z.string().min(1)).max(64).optional(),
});

// Per-pinned-process log config (PUT /assets/:id/processes/:name/config).
const ProcessConfigSchema = z.object({
  logSource:   z.enum(["auto", "journald-unit", "file-glob"]).optional(),
  logPathGlob: z.string().max(1024).nullable().optional(),
  notes:       z.string().max(255).nullable().optional(),
});

/**
 * Apply Asset.monitored side-effects on save. The polling-method resolver is
 * the source of truth for HOW the asset gets probed — we don't re-validate
 * polling/credential consistency at write-time; the dispatcher reports
 * errors clearly when a missing credential surfaces during a probe.
 */
function clampMonitoredState(data: Record<string, unknown>): void {
  const monitored = data.monitored === undefined ? undefined : Boolean(data.monitored);
  if (monitored === false) {
    data.consecutiveFailures = 0;
  } else if (monitored === true) {
    // Reset probe state so the pill always starts at Recovering on re-enable
    // rather than carrying over stale Down/Missed from the previous session.
    data.monitorStatus = "recovering";
    data.consecutiveFailures = 0;
    data.consecutiveSuccesses = 0;
  }
}

/**
 * Refuse a write that would leave monitoring ON in a status that can't carry
 * it (business rule 10). The clamp in db.ts would silently rewrite
 * `monitored` to false, which is the right BACKSTOP but the wrong answer to an
 * operator who just ticked the box: the form would save "successfully" and
 * come back with the box clear and no explanation. So the two operator-facing
 * write paths (this one and POST /bulk-monitor) say why instead.
 */
function assertMonitorableStatus(monitored: unknown, status: unknown): void {
  if (monitored !== true) return;
  if (statusAllowsMonitoring(status)) return;
  throw new AppError(
    409,
    `A ${String(status)} asset cannot be monitored — ${UNMONITORABLE_STATUSES.join(" / ")} assets are not polled. ` +
      "Change the status first, then enable monitoring.",
  );
}

// ─── ipContext helpers ──────────────────────────────────────────────────────
//
// buildIpContexts + IpContext moved to subnetService (2026-08 audit): the
// most-specific-containing-subnet SQL now has a single implementation shared
// with the dns_resolved reconciler.

// ─── Asset list: server-side filter / sort / pagination ────────────────────
//
// The assets table runs TableSF in *server-side mode* (mirrors the Events page,
// see polaris-ui-canon → "Sortable + filterable data table (server-side mode)"):
// every filter + sort the operator sets on a column header is translated into
// query params here, and only one page of rows is shipped to the browser. This
// is what keeps the page fast at 12k+ assets — the prior frontend pulled the
// entire table into memory and filtered/sorted/paginated in JS.

// Sort whitelist — Prisma orderBy must never accept user-supplied strings
// unvalidated. Keys are the table's data-sf-key values; values are the real
// Asset column. `_monitor` → monitorStatus, `_server` → location (handled
// specially below so the learnedLocation fallback participates).
const ASSET_SORT_COLUMNS: Record<string, string> = {
  hostname: "hostname",
  ipAddress: "ipAddress",
  serialNumber: "serialNumber",
  assetType: "assetType",
  status: "status",
  _monitor: "monitorStatus",
  _server: "location",
  assetTag: "assetTag",
  manufacturer: "manufacturer",
  model: "model",
  os: "os",
  macAddress: "macAddress",
  assignedTo: "assignedTo",
  purchaseOrder: "purchaseOrder",
  dnsName: "dnsName",
  description: "description",
  latitude: "latitude",
  longitude: "longitude",
  lastSeen: "lastSeen",
  createdAt: "createdAt",
};

// Operator-aware text-filter columns (column key → Asset column). Every one is
// a nullable String on Asset, so empty / is_not_empty carry a null arm.
const ASSET_TEXT_COLUMNS: Record<string, string> = {
  hostname: "hostname",
  ipAddress: "ipAddress",
  serialNumber: "serialNumber",
  assetTag: "assetTag",
  manufacturer: "manufacturer",
  model: "model",
  os: "os",
  macAddress: "macAddress",
  assignedTo: "assignedTo",
  purchaseOrder: "purchaseOrder",
  dnsName: "dnsName",
  description: "description",
};

const ASSET_TEXT_OPS = TEXT_FILTER_OPS;

/** CSV → string[]; empty entries dropped; returns undefined for no value. */
const csvToArray = csvParam;

/**
 * Translate a text-filter op + value into a where fragment for a nullable
 * Asset string column, or undefined for a no-op. Where-level (not field-level)
 * because empty / is_not_empty need OR / AND composition; the caller ANDs the
 * fragments together.
 */
const buildAssetTextFilter = buildPrismaTextFilter;

/**
 * The `_server` column displays `location || learnedLocation`, so its filter
 * spans both columns: contains → match either, not_contains → match neither,
 * empty → both blank, is_not_empty → either set.
 */
function buildServerFilter(
  value: string | undefined,
  op: string | undefined,
): Record<string, unknown> | undefined {
  const operator = op && ASSET_TEXT_OPS.has(op) ? op : "contains";
  const cols = ["location", "learnedLocation"];
  if (operator === "empty") {
    return { AND: cols.map((c) => ({ OR: [{ [c]: null }, { [c]: "" }] })) };
  }
  if (operator === "is_not_empty") {
    return { OR: cols.map((c) => ({ AND: [{ [c]: { not: null } }, { [c]: { not: "" } }] })) };
  }
  const v = (value || "").trim();
  if (!v) return undefined;
  if (operator === "not_contains") {
    return { AND: cols.map((c) => ({ [c]: { not: { contains: v }, mode: "insensitive" } })) };
  }
  return { OR: cols.map((c) => ({ [c]: { contains: v, mode: "insensitive" } })) };
}

/**
 * Translate one `_monitor` synthetic-column chip into a where fragment. Mirrors
 * the client's `_mapAsset` mapping: "Monitored"/"Unmonitored" gate on the
 * `monitored` flag; "Dep. Down" is every dependency-suppressed monitored row
 * (regardless of the underlying probe state — matches the Status pill, which
 * gives suppression precedence over the five-state machine); the directional
 * chips pin monitorStatus and exclude suppressed rows so a row filters under
 * exactly the label its pill shows; "Pending" is everything monitored that
 * hasn't landed a directional status yet. Multiple selected chips are OR-ed
 * by the caller.
 */
function monitorClause(v: string): Record<string, unknown> | null {
  switch (v) {
    case "Unmonitored": return { monitored: false };
    case "Monitored":   return { monitored: true };
    case "Dep. Down":   return { monitored: true, dependencySuppressed: true };
    case "Up":          return { monitored: true, dependencySuppressed: false, monitorStatus: "up" };
    // "Warning" is the pre-2026-08 chip label, kept as an alias: it is persisted
    // verbatim inside SavedTableFilter.state and UserTableTabs rows, so dropping
    // it would silently turn every stored preset naming it into "no filter".
    case "Missed":
    case "Warning":     return { monitored: true, dependencySuppressed: false, monitorStatus: "warning" };
    case "Down":        return { monitored: true, dependencySuppressed: false, monitorStatus: "down" };
    case "Recovering":  return { monitored: true, dependencySuppressed: false, monitorStatus: "recovering" };
    case "Passive":     return { monitored: true, dependencySuppressed: false, monitorStatus: "passive" };
    // "Pending" is the catch-all for everything without its own chip, so every
    // named status must be excluded here or its rows filter under the wrong
    // label — the rule this file already states: a row filters under exactly
    // the label its pill shows.
    case "Pending":     return { monitored: true, dependencySuppressed: false, monitorStatus: { notIn: ["up", "warning", "down", "recovering", "passive"] } };
    default:            return null;
  }
}

// Shared list payload select. Omits heavy fields (notes, associatedUsers) and
// anything the list table + CSV/PDF export never reference; the single-asset
// GET /:id below still returns the full record for the view/edit modal.
const ASSET_LIST_SELECT = {
  id: true,
  hostname: true,
  // Operator hostname pin. The list needs it to mark the cell as overridden and
  // to know which rows to look up a discovered hostname for (enrichAssetList).
  hostnameOverride: true,
  dnsName: true,
  assetTag: true,
  ipAddress: true,
  macAddress: true,
  macAddressRows: { select: MAC_ROW_SELECT },
  associatedIpRows: { select: ASSOCIATED_IP_SELECT },
  serialNumber: true,
  manufacturer: true,
  model: true,
  os: true,
  osVersion: true,
  assignedTo: true,
  purchaseOrder: true,
  description: true,
  assetType: true,
  status: true,
  statusChangedAt: true,
  statusChangedBy: true,
  location: true,
  learnedLocation: true,
  // Latitude / Longitude list columns (hidden by default) — the geographic pin
  // that places a firewall on the Device Map.
  latitude: true,
  longitude: true,
  lastSeen: true,
  acquiredAt: true,
  createdAt: true,
  monitored: true,
  monitorStatus: true,
  lastMonitorAt: true,
  lastResponseTimeMs: true,
  discoveredByIntegrationId: true,
  // "Monitored Via" column: the resolved per-stream polling methods + agent
  // state are reduced to a compact `monitoringMethods` array by
  // computeMonitoringMethods() in enrichAssetList. The six *Polling scalars
  // feed the monitor-settings resolver; the discovering integration's type
  // supplies the source default; an active ManagedAgent short-circuits to
  // ["agent"] (the agent owns all streams).
  responseTimePolling: true,
  cpuMemoryPolling: true,
  temperaturePolling: true,
  interfacesPolling: true,
  lldpPolling: true,
  storagePolling: true,
  discoveredByIntegration: { select: { type: true } },
  managedAgent: { select: { installStatus: true } },
  dependencyLayer: true,
  dependencySuppressed: true,
  dependencyTestUntil: true,
  // Maintenance pill: the parked pre-window status shows in the tooltip and
  // is what the "End maintenance now" popover restores.
  maintenanceReturnStatus: true,
  // HA standby pill + cluster-IP display: selected only to feed the compact
  // `ha` projection (shapeHaInfo) — enrichAssetList strips the raw blob so
  // list rows never ship the full fortinetTopology JSON.
  fortinetTopology: true,
  // Row-menu Open HTTPS / Open SSH gate: the `allowaccess` list read during
  // FMG/FortiGate discovery. Reduced to four fields by shapeManagementAccess
  // so the list never ships the whole blob; null on every asset discovery has
  // never read an access list for, which is most of the fleet.
  managementAccess: true,
} as const;

const ASSET_LIST_DEFAULT_LIMIT = 50;
const ASSET_LIST_MAX_LIMIT = 10000;
// Defensive cap on the favorites-first id list (operator-curated; realistically
// dozens). Keeps the IN/NOT IN clause bounded if the localStorage set is huge.
const ASSET_FAVORITES_MAX = 5000;

const AssetListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(ASSET_LIST_MAX_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  // Multi-value enum filters (CSV). Single value → { equals }, many → { in }.
  status: z.string().optional(),
  assetType: z.string().optional(),
  monitor: z.string().optional(),
  // Existing scalar filters.
  department: z.string().optional(),
  createdBy: z.string().optional(),
  search: z.string().optional(),
  // lastSeen date range (YYYY-MM-DD from the date-column popover).
  lastSeenFrom: z.string().optional(),
  lastSeenTo: z.string().optional(),
  // Favorites-first ordering: the operator's starred asset ids (CSV).
  favoriteIds: z.string().optional(),
  // Sort whitelist; validated below.
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).optional(),
}).passthrough(); // per-column text filters (<col>, <col>Op) read off req.query

/**
 * Asset ids that match a filter term through their DISCOVERED hostname rather
 * than the `hostname` column — i.e. rows whose hostname is pinned, where the
 * list prints the discovered name as a second line under the pin. Typing
 * either of those two names has to find the row, and only the pin is in a
 * column, so the other half is resolved here (one indexed lookup per term-
 * bearing filter; nothing at all when neither filter carries a term).
 *
 * Deliberately NOT run for the `empty` / `is_not_empty` ops: those ask about
 * the Hostname cell's own value, which a pinned row always has.
 */
interface DiscoveredHostnameMatches {
  /** Hostname-column filter term hits, or null for "nothing to add". */
  hostnameIds: string[] | null;
  /** Free-text `search` param hits, or null. */
  searchIds: string[] | null;
}

const NO_DISCOVERED_MATCHES: DiscoveredHostnameMatches = { hostnameIds: null, searchIds: null };

async function resolveDiscoveredHostnameMatches(
  q: z.infer<typeof AssetListQuerySchema>,
  raw: Record<string, unknown>,
): Promise<DiscoveredHostnameMatches> {
  const rawOp = typeof raw["hostnameOp"] === "string" ? (raw["hostnameOp"] as string) : undefined;
  // Mirror buildPrismaTextFilter's op resolution exactly — an unrecognized op
  // falls back to `contains` there, so it must here too.
  const op = rawOp && ASSET_TEXT_OPS.has(rawOp) ? rawOp : "contains";
  const hostnameTerm = op === "contains" || op === "not_contains"
    ? (typeof raw["hostname"] === "string" ? (raw["hostname"] as string).trim() : "")
    : "";
  const searchTerm = (q.search ?? "").trim();
  if (!hostnameTerm && !searchTerm) return NO_DISCOVERED_MATCHES;

  const empty = new Map<string, string>();
  const [hostnameHits, searchHits] = await Promise.all([
    hostnameTerm ? findAssetIdsByDiscoveredHostname([hostnameTerm]) : Promise.resolve(empty),
    searchTerm ? findAssetIdsByDiscoveredHostname([searchTerm]) : Promise.resolve(empty),
  ]);
  return {
    hostnameIds: hostnameHits.size ? Array.from(hostnameHits.keys()) : null,
    searchIds: searchHits.size ? Array.from(searchHits.keys()) : null,
  };
}

/**
 * Build the Prisma `where` from validated list-query params. Shared by the list
 * endpoint and the "export filtered" path so both honor exactly the same
 * filters.
 */
function buildAssetListWhere(
  q: z.infer<typeof AssetListQuerySchema>,
  raw: Record<string, unknown>,
  sessionUsername: string | undefined,
  discovered: DiscoveredHostnameMatches = NO_DISCOVERED_MATCHES,
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const and: Record<string, unknown>[] = [];

  const statuses = csvToArray(q.status);
  if (statuses) where.status = statuses.length === 1 ? statuses[0] : { in: statuses };

  const assetTypes = csvToArray(q.assetType);
  if (assetTypes) where.assetType = assetTypes.length === 1 ? assetTypes[0] : { in: assetTypes };

  if (q.department) where.department = { contains: q.department, mode: "insensitive" };
  if (q.createdBy === "me") where.createdBy = sessionUsername ?? null;
  else if (q.createdBy) where.createdBy = q.createdBy;

  if (q.search) {
    where.OR = [
      { hostname:   { contains: q.search, mode: "insensitive" } },
      { dnsName:    { contains: q.search, mode: "insensitive" } },
      { ipAddress:  { contains: q.search, mode: "insensitive" } },
      { macAddress: { contains: q.search, mode: "insensitive" } },
      { assetTag:   { contains: q.search, mode: "insensitive" } },
      { assignedTo: { contains: q.search, mode: "insensitive" } },
    ];
    // Pinned rows whose DISCOVERED hostname matches — the `hostname` column
    // above only ever holds the pin.
    if (discovered.searchIds) {
      (where.OR as Record<string, unknown>[]).push({ id: { in: discovered.searchIds } });
    }
  }

  // Per-column operator-aware text filters.
  for (const [key, column] of Object.entries(ASSET_TEXT_COLUMNS)) {
    const value = typeof raw[key] === "string" ? (raw[key] as string) : undefined;
    const op = typeof raw[key + "Op"] === "string" ? (raw[key + "Op"] as string) : undefined;
    if (value == null && op == null) continue;
    const frag = buildAssetTextFilter(column, value, op);
    if (!frag) continue;
    // The Hostname cell shows two names on a pinned row (the pin, plus the
    // discovered name underneath), so its filter spans both: `contains` matches
    // either, `not_contains` has to reject the row if EITHER name matches.
    if (key === "hostname" && discovered.hostnameIds) {
      const isNot = op === "not_contains";
      and.push(isNot
        ? { AND: [frag, { id: { notIn: discovered.hostnameIds } }] }
        : { OR: [frag, { id: { in: discovered.hostnameIds } }] });
      continue;
    }
    and.push(frag);
  }
  // `_server` spans location + learnedLocation.
  const serverVal = typeof raw["server"] === "string" ? (raw["server"] as string) : undefined;
  const serverOp = typeof raw["serverOp"] === "string" ? (raw["serverOp"] as string) : undefined;
  if (serverVal != null || serverOp != null) {
    const frag = buildServerFilter(serverVal, serverOp);
    if (frag) and.push(frag);
  }

  // `_monitor` multi-select → OR of chip clauses.
  const monitorVals = csvToArray(q.monitor);
  if (monitorVals) {
    const clauses = monitorVals.map(monitorClause).filter((c): c is Record<string, unknown> => c !== null);
    if (clauses.length) and.push(clauses.length === 1 ? clauses[0] : { OR: clauses });
  }

  // lastSeen date range.
  if (q.lastSeenFrom || q.lastSeenTo) {
    const range: Record<string, Date> = {};
    if (q.lastSeenFrom) {
      const d = new Date(q.lastSeenFrom + "T00:00:00");
      if (!isNaN(+d)) range.gte = d;
    }
    if (q.lastSeenTo) {
      const d = new Date(q.lastSeenTo + "T23:59:59.999");
      if (!isNaN(+d)) range.lte = d;
    }
    if (range.gte || range.lte) where.lastSeen = range;
  }

  if (and.length) where.AND = and;
  return where;
}

/** Resolve a validated sort param into a Prisma orderBy. */
function buildAssetOrderBy(
  sortBy: string | undefined,
  sortDir: "asc" | "desc" | undefined,
): Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[] {
  if (!sortBy) return { createdAt: "desc" };
  if (!ASSET_SORT_COLUMNS[sortBy]) throw new AppError(400, `Invalid sortBy: ${sortBy}`);
  const dir: "asc" | "desc" = sortDir ?? "asc";
  // `_server` orders by location then its learnedLocation fallback.
  if (sortBy === "_server") return [{ location: dir }, { learnedLocation: dir }];
  return { [ASSET_SORT_COLUMNS[sortBy]]: dir };
}

// Compact HA projection for list rows. Non-null only for HA cluster members
// (fortinetTopology carrying haMode + haRole — stamped by the FMG/FortiGate
// firewall fan-out). `memberStatus` is the roster-reported member health
// ("up"/"down", absent when the roster carried no signal); `clusterIp` is the
// display-only cluster IP stamped on standby members (Asset.ipAddress stays
// null on the standby by design — see the fan-out comments in integrations.ts).
function shapeHaInfo(topo: unknown): { mode: string; role: string; memberStatus?: string; clusterIp?: string } | null {
  const t = topo as Record<string, unknown> | null;
  if (!t || typeof t !== "object") return null;
  const { haMode: mode, haRole: role, haMemberStatus: memberStatus, haClusterIp: clusterIp } = t;
  if (typeof mode !== "string" || mode === "standalone" || typeof role !== "string") return null;
  return {
    mode,
    role,
    ...(typeof memberStatus === "string" ? { memberStatus } : {}),
    ...(typeof clusterIp === "string" ? { clusterIp } : {}),
  };
}

/**
 * Reduce `Asset.managementAccess` to the four fields the Assets list needs to
 * decide whether a row's menu offers Open HTTPS / Open SSH (`_assetMgmtAccess`
 * in public/js/assets.js). The stored blob also carries source / interfaceName
 * / profileName / snmp / checkedAt, which only the slide-over reads — and the
 * slide-over loads the full asset from GET /assets/:id.
 *
 * `protocols` is passed through as a NULL-vs-not signal only: null means the
 * access list could not be read (the best-effort switch path) and the client
 * then offers both verbs optimistically, so collapsing it to a boolean here
 * would be collapsing the very distinction the client branches on.
 */
function shapeManagementAccess(ma: unknown): { mgmtIp: string | null; protocols: string[] | null; https: boolean; ssh: boolean } | null {
  return shapeManagementAccessForClient(ma);
}

// Reduce an asset's monitoring transports to the compact array the
// "Monitored Via" list column renders. Empty = not monitored / nothing to
// show. An active Polaris Agent owns all streams, so it short-circuits to
// ["agent"]. Otherwise the six per-stream polling methods are resolved through
// the monitor-settings hierarchy (cached tiers — no per-row DB hit) and de-
// duplicated. ICMP is reachability-only and pairs with every telemetry
// transport, so it's treated as subordinate: a device with any non-ICMP
// transport reports that transport (or "Multiple" when several differ), and
// ICMP surfaces only when it's the sole method (ping-only monitoring).
async function computeMonitoringMethods(a: {
  monitored?: boolean;
  assetType?: unknown;
  discoveredByIntegrationId?: unknown;
  discoveredByIntegration?: { type?: string | null } | null;
  managedAgent?: { installStatus?: string | null } | null;
  responseTimePolling?: unknown;
  cpuMemoryPolling?: unknown;
  temperaturePolling?: unknown;
  interfacesPolling?: unknown;
  lldpPolling?: unknown;
  storagePolling?: unknown;
}): Promise<string[]> {
  if (!a.monitored) return [];
  if (a.managedAgent?.installStatus === "active") return ["agent"];
  const resolved = await resolveMonitorSettings({
    assetType:                   typeof a.assetType === "string" ? a.assetType : "other",
    discoveredByIntegrationId:   typeof a.discoveredByIntegrationId === "string" ? a.discoveredByIntegrationId : null,
    discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
    monitorIntervalSec:     null,
    cpuMemoryIntervalSec:   null,
    temperatureIntervalSec: null,
    systemInfoIntervalSec:  null,
    probeTimeoutMs:         null,
    responseTimePolling: typeof a.responseTimePolling === "string" ? a.responseTimePolling : null,
    cpuMemoryPolling:    typeof a.cpuMemoryPolling    === "string" ? a.cpuMemoryPolling    : null,
    temperaturePolling:  typeof a.temperaturePolling  === "string" ? a.temperaturePolling  : null,
    interfacesPolling:   typeof a.interfacesPolling   === "string" ? a.interfacesPolling   : null,
    lldpPolling:         typeof a.lldpPolling         === "string" ? a.lldpPolling         : null,
    storagePolling:      typeof a.storagePolling      === "string" ? a.storagePolling      : null,
  });
  const all = [
    resolved.responseTimePolling,
    resolved.cpuMemoryPolling,
    resolved.temperaturePolling,
    resolved.interfacesPolling,
    resolved.lldpPolling,
    resolved.storagePolling,
  ].filter((m): m is PollingMethod => m != null && m !== "disabled");
  const nonIcmp = [...new Set<string>(all.filter((m) => m !== "icmp"))];
  if (nonIcmp.length > 0) return nonIcmp;
  return all.includes("icmp") ? ["icmp"] : [];
}

async function enrichAssetList(
  assets: Array<{ ipAddress: string | null; associatedIpRows: unknown; macAddressRows: unknown; fortinetTopology?: unknown; managementAccess?: unknown } & Record<string, unknown>>,
) {
  // `hostnameDiscovered` — what discovery says the hostname is, for the rows
  // where an operator pin is currently overriding it (the list renders it as a
  // second line under the pinned name). Only pinned rows are looked up, so a
  // page with no overrides pays no query at all.
  const overriddenIds = assets
    .filter((a) => typeof a.hostnameOverride === "string" && a.hostnameOverride)
    .map((a) => a.id as string);

  // The three page-level lookups depend only on the fetched rows, not on each
  // other — one Promise.all instead of three serialized round trips on the
  // hottest list endpoint. `activeAlert` is the Name column's alert indicator
  // (worst live alert per device; ONE query for the whole page, see
  // activeAlertSummaryByAsset).
  const [discoveredHostnames, alertSummaries, ipCtx] = await Promise.all([
    overriddenIds.length ? getDiscoveredHostnames(overriddenIds) : Promise.resolve(new Map<string, string | null>()),
    activeAlertSummaryByAsset(assets.map((a) => a.id as string)),
    buildIpContexts(assets.map((a) => a.ipAddress).filter(Boolean) as string[]),
  ]);

  return Promise.all(assets.map(async ({
    associatedIpRows, macAddressRows, fortinetTopology, managementAccess,
    // Strip the raw resolver inputs from the wire shape — only the reduced
    // `monitoringMethods` array is surfaced to the list.
    responseTimePolling, cpuMemoryPolling, temperaturePolling, interfacesPolling, lldpPolling, storagePolling,
    discoveredByIntegration, managedAgent,
    ...a
  }) => ({
    ...a,
    associatedIps: shapeAssociatedIps(associatedIpRows as never),
    macAddresses: shapeMacRows(macAddressRows as never),
    hostnameDiscovered: discoveredHostnames.get(a.id as string) ?? null,
    ipContext: a.ipAddress ? (ipCtx.get(a.ipAddress) || null) : null,
    ha: shapeHaInfo(fortinetTopology),
    managementAccess: shapeManagementAccess(managementAccess),
    activeAlert: alertSummaries.get(a.id as string) ?? null,
    monitoringMethods: await computeMonitoringMethods({
      monitored: a.monitored as boolean | undefined,
      assetType: a.assetType,
      discoveredByIntegrationId: a.discoveredByIntegrationId,
      discoveredByIntegration: discoveredByIntegration as { type?: string | null } | null,
      managedAgent: managedAgent as { installStatus?: string | null } | null,
      responseTimePolling, cpuMemoryPolling, temperaturePolling, interfacesPolling, lldpPolling, storagePolling,
    }),
  })));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/v1/assets — list assets (all authenticated users). Server-side
// filter / sort / pagination; favorites-first ordering when `favoriteIds` is
// supplied (operator's starred ids float to the top of the whole result set,
// not just the current page).
router.get("/", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const parsed = AssetListQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw new AppError(400, "Invalid query: " + parsed.error.issues[0].message);
    }
    const q = parsed.data;
    const limit = Math.min(q.limit ?? ASSET_LIST_DEFAULT_LIMIT, ASSET_LIST_MAX_LIMIT);
    const offset = q.offset ?? 0;

    const discovered = await resolveDiscoveredHostnameMatches(q, req.query as Record<string, unknown>);
    const where = buildAssetListWhere(q, req.query as Record<string, unknown>, requestActor(req), discovered);
    const orderBy = buildAssetOrderBy(q.sortBy, q.sortDir);

    let favoriteIds = csvToArray(q.favoriteIds);
    if (favoriteIds && favoriteIds.length > ASSET_FAVORITES_MAX) {
      favoriteIds = favoriteIds.slice(0, ASSET_FAVORITES_MAX);
    }

    let assets: Array<Record<string, unknown>>;
    let total: number;

    if (favoriteIds && favoriteIds.length) {
      // Two-bucket ordering: favorites (matching the active filters, sorted)
      // occupy virtual positions [0, favTotal); non-favorites follow. The
      // requested window may straddle the boundary, so query each bucket with
      // the appropriate skip/take and concatenate.
      const favWhere = { AND: [where, { id: { in: favoriteIds } }] };
      const nonFavWhere = { AND: [where, { id: { notIn: favoriteIds } }] };
      const [favTotal, totalCount] = await Promise.all([
        prisma.asset.count({ where: favWhere }),
        prisma.asset.count({ where }),
      ]);
      total = totalCount;
      const favPart = offset < favTotal
        ? await prisma.asset.findMany({ where: favWhere, orderBy, skip: offset, take: limit, select: ASSET_LIST_SELECT })
        : [];
      const remaining = limit - favPart.length;
      let nonFavPart: typeof favPart = [];
      if (remaining > 0) {
        const nonFavSkip = Math.max(0, offset - favTotal);
        nonFavPart = await prisma.asset.findMany({ where: nonFavWhere, orderBy, skip: nonFavSkip, take: remaining, select: ASSET_LIST_SELECT });
      }
      assets = [...favPart, ...nonFavPart];
    } else {
      const [rows, totalCount] = await Promise.all([
        prisma.asset.findMany({ where, orderBy, skip: offset, take: limit, select: ASSET_LIST_SELECT }),
        prisma.asset.count({ where }),
      ]);
      assets = rows;
      total = totalCount;
    }

    const enriched = await enrichAssetList(assets as never);
    res.json({ assets: enriched, total, limit, offset });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/ip-history-settings — get history retention settings (all authenticated users)
// Must be defined before /:id to avoid route shadowing.
router.get("/ip-history-settings", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    res.json(await getHistorySettings());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/tags — distinct tags across all assets, for autocomplete
// (notification-rule scope picker, etc.). One scan with a tight select.
router.get("/tags", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const rows = await prisma.asset.findMany({ where: { NOT: { tags: { isEmpty: true } } }, select: { tags: true } });
    const set = new Set<string>();
    for (const r of rows) for (const t of r.tags) set.add(t);
    res.json({ tags: Array.from(set).sort() });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/agent-signing-alert — the durable "last agent build
// shipped UNSIGNED Windows binaries" stamp (Setting `agent.signing.lastFailure`,
// written by agentBuildService's fail-open signing step; cleared by the next
// fully-signed build or by disabling signing). Drives the dismissable sidebar
// alert in app.js. Gated assets:write — the agent-DEPLOY permission (same gate
// as /:id/agent/install below) — deliberately NOT under /server-settings,
// whose router-level serverSettingsSystem gate only admin passes.
router.get("/agent-signing-alert", requirePermission("assets", "write"), async (_req, res, next) => {
  try {
    const { getSigningAlert } = await import("../../services/agentSigningService.js");
    res.json(await getSigningAlert());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/source-priority — the operator's Sources-column priority
// (which discovery source's learned location wins) plus the catalogue of what
// each source contributes, so the drag-and-drop list renders its labels and
// hints from the server rather than hardcoding them. Before /:id.
router.get("/source-priority", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const { getSourcePrioritySettings } = await import("../../services/assetSourcePriorityService.js");
    res.json(await getSourcePrioritySettings());
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/source-priority — reorder / toggle the integration-name
// prefix. assets:write, matching the other settings on the Assets → Settings
// modal; the service audits the change with the previous order.
router.put("/source-priority", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const body = z.object({
      order: z.array(z.string()).optional(),
      integrationPrefix: z.boolean().optional(),
    }).parse(req.body);
    const { saveSourceLocationPriority, getSourcePrioritySettings } =
      await import("../../services/assetSourcePriorityService.js");
    await saveSourceLocationPriority(body, requestActor(req));
    res.json(await getSourcePrioritySettings());
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/ip-context?ip=10.4.12.63 — everything Polaris already
// knows about one address, for the manual Add Asset form: the containing
// network, the lease/reservation sitting on it, the gate ARP caches and
// FortiGate sightings that have resolved it, the switch port its MAC shows up
// on, and any asset already carrying it. Read-only; creates nothing. Before
// /:id (a bare word would otherwise be captured as an asset id).
//
// Gated assets:read, with the two IPAM halves gated a second time on the
// caller's own subnets/reservations access — the dashboard precedent. Which
// sections were consulted rides back in `visibility`, so a role that can't see
// networks reads "not shown" rather than a confident "no network found".
router.get("/ip-context", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const ip = typeof req.query.ip === "string" ? req.query.ip : "";
    const { lookupIpContext } = await import("../../services/ipContextService.js");
    const result = await lookupIpContext(ip, {
      includeSubnets: hasPermission(req, "subnets", "read"),
      includeReservations: hasPermission(req, "reservations", "read"),
    });
    // A half-typed address is the normal case on a debounced keystroke, not an
    // error — answer 200 with nothing found rather than 400-ing per character.
    res.json(result ?? { ip: ip.trim(), unparseable: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/ip-history-settings — update retention settings (assets admin)
router.put("/ip-history-settings", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const { retentionDays } = z.object({ retentionDays: z.number().int().min(0).max(3650) }).parse(req.body);
    await updateHistorySettings({ retentionDays });
    const pruned = await pruneOldHistory();
    logEvent({ action: "asset.history_settings.updated", actor: requestActor(req), message: `IP history retention set to ${retentionDays} day(s)${pruned ? `; pruned ${pruned} old record(s)` : ""}` });
    res.json({ ok: true, pruned });
  } catch (err) {
    next(err);
  }
});

// Note: the legacy GET/PUT /monitor-settings routes were retired with the
// move to the four-tier hierarchy. Operators now use:
//   - /api/v1/monitor-settings/manual                → global manual tier
//   - /api/v1/monitor-settings/integration/:id       → per-integration tier
//   - /api/v1/monitor-settings/class-overrides       → (class + integration)
//   - PUT /api/v1/assets/:id  with monitorIntervalSec / probeTimeoutMs / etc.
//                                                    → per-asset overrides
// See src/api/routes/monitorSettings.ts.

// POST /api/v1/assets/bulk-monitor — enable/disable monitoring on a set of assets.
// Body: { ids, monitored, monitorCredentialId?, monitorIntervalSec?, probeTimeoutMs? }.
// On enable: applies the same credential + cadence overrides uniformly. The
// polling method comes from the resolver (per-asset overrides set via PUT,
// class overrides, integration-tier setting, source default) — the bulk
// endpoint isn't the place to choose a method, since one selection rarely
// fits a heterogeneous batch. Operators picking a method per-asset use the
// asset edit modal's Monitoring tab.
// Returns per-id error list for any rejected rows.
router.post("/bulk-monitor", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const body = z.object({
      ids:                 z.array(z.string().uuid()).min(1),
      monitored:           z.boolean(),
      monitorCredentialId: z.string().uuid().nullable().optional(),
      monitorIntervalSec:  z.number().int().min(5).max(86400).nullable().optional(),
      probeTimeoutMs:      z.number().int().min(100).max(60000).nullable().optional(),
    }).parse(req.body);

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
      select: { id: true, status: true },
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
    }

    logEvent({
      action: body.monitored ? "monitor.bulk_enabled" : "monitor.bulk_disabled",
      resourceType: "asset",
      actor: requestActor(req),
      message: `Bulk ${body.monitored ? "enabled" : "disabled"} monitoring on ${updatedCount} asset(s)` + (errors.length ? `; ${errors.length} error(s)` : ""),
      details: errors.length ? { errors } : undefined,
    });
    res.json({ updated: updatedCount, errors });
  } catch (err) { next(err); }
});

// ─── Mass Pinning (Assets → Settings → Mass Pinning section) ─────────────────
//
// Manual bulk pin/unpin of fast-cadence targets (interfaces incl. IPsec
// tunnels, storage mounts) across a condition-filtered device set. Three
// endpoints; business logic lives in services/massPinService.ts. The UI button
// is data-admin-only, but the endpoints are gated assets:read / assets:write
// for API-token parity (the bulk-monitor posture).

// The device-filter scope: the automations condition-tree vocabulary
// (SCOPE_FIELD_OPS), or the explicit all-assets flag. One of the two is
// required — a bare {} must never quietly mean "the whole fleet".
const MassPinScopeSchema = z.object({
  allAssets: z.boolean().optional(),
  condition: scopeConditionSchema.optional(),
}).refine((v) => v.allAssets === true || v.condition !== undefined, {
  message: "Provide a condition or allAssets: true",
});

// GET /api/v1/assets/pin-filter-schema — the condition builder's vocabulary +
// value suggestions for the Mass Pinning section. Its own route rather than
// /automations/schema + /scope-options because those are gated
// automationManagement:read, and pinning interfaces must not require
// permission to edit automations (the contacts /filter-schema precedent).
// Built from the same shared scopeConditionMeta so vocabularies can't drift —
// this one carries the NARROW automations field set, matching what the
// automation wizard's Devices step offers.
router.get("/pin-filter-schema", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const [options, assetTypes, tags] = await Promise.all([
      listScopeOptions(),
      listAssetTypes(),
      listAssetTags(),
    ]);
    res.json({
      scopeCondition: scopeConditionMeta(SCOPE_FIELD_OPS),
      options: {
        ...options,
        assetTypes: assetTypes.map((t) => ({ name: t.name, label: t.label || t.name })),
        tags,
      },
      maxAssets: MASS_PIN_MAX_ASSETS,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/pin-inventory — resolve the device filter server-side
// (the client never ships thousands of ids) and return the matched assets'
// facet inventory aggregated by name, with per-device pinned state so the
// client renders tri-state checkboxes from one call. mode:"count" is the
// cheap half the debounced filter preview uses. Matched sets over
// MASS_PIN_MAX_ASSETS refuse the full inventory (overCap) rather than
// truncating — a cut device list would make "pinned on ALL devices" a lie.
router.post("/pin-inventory", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const body = MassPinScopeSchema.and(z.object({
      facet: z.enum(["interfaces", "storage"]),
      mode:  z.enum(["count", "full"]).default("full"),
    })).parse(req.body);

    const ids = await loadScopeAssetIds(
      body.allAssets === true ? { allAssets: true } : { condition: body.condition as any },
    );
    if (body.mode === "count") {
      res.json({ matchedCount: ids.length });
      return;
    }
    if (ids.length > MASS_PIN_MAX_ASSETS) {
      res.json({ matchedCount: ids.length, overCap: true });
      return;
    }
    const inventory = await getPinInventoryForAssets(ids, body.facet);
    res.json({ matchedCount: ids.length, overCap: false, inventory });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/mass-pins — apply staged pin/unpin deltas. Deltas (not
// final arrays) so a concurrent hand-pin of an unrelated name on the same
// asset is never clobbered; the 64-per-array cap is re-enforced per asset in
// the service (overflow = per-asset skip with reason, never a batch 400).
router.post("/mass-pins", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const DeltaSchema = z.object({
      assetId: z.string().uuid(),
      name:    z.string().min(1).max(256),
      field:   z.enum(["interfaces", "ipsecTunnels", "storage"]),
    });
    const body = z.object({
      pin:   z.array(DeltaSchema).max(MASS_PIN_MAX_DELTAS).default([]),
      unpin: z.array(DeltaSchema).max(MASS_PIN_MAX_DELTAS).default([]),
    }).refine((b) => b.pin.length + b.unpin.length > 0, { message: "No pin changes supplied" })
      .parse(req.body);

    res.json(await applyMassPins(body, requestActor(req) ?? "unknown"));
  } catch (err) { next(err); }
});

// GET /api/v1/assets/agent-install-scripts — curated install-method catalog
// for the deploy modal's picker. MUST stay above GET /:id so the literal path
// isn't captured as an asset id. Read-only metadata (no secrets); gated read.
router.get("/agent-install-scripts", requirePermission("assets", "read"), async (_req, res, next) => {
  try {
    const { AGENT_INSTALL_SCRIPTS } = await import("../../services/agentInstallScripts.js");
    res.json({ scripts: AGENT_INSTALL_SCRIPTS });
  } catch (err) { next(err); }
});

// GET /api/v1/assets/quarantine-availability — is quarantine push configured
// on ANY enabled FortiManager / FortiGate integration? Drives whether the
// frontends offer the quarantine verbs at all (row menu, bulk bar, details
// tab): with the per-integration toggle off fleet-wide a push can only fail
// with "0/0 FortiGate(s) accepted the push". MUST stay above GET /:id so the
// literal path isn't captured as an asset id. Gated on the quarantine key at
// read level — the callers already hold `assetsQuarantine:write`, and the
// answer says nothing about any individual integration.
router.get(
  "/quarantine-availability",
  requirePermission("assetsQuarantine", "read"),
  async (_req, res, next) => {
    try {
      res.json(await getQuarantinePushAvailability());
    } catch (err) { next(err); }
  },
);

// GET|PUT /api/v1/assets/sighting-settings — the quarantine sighting max-age.
// MUST stay above GET /:id and PUT /:id (the quarantine-availability rule):
// these two literals sat BELOW the parameterized routes from the day they
// shipped, so Express captured them as id="sighting-settings" and both verbs
// answered 404 "Asset not found" — unreachable until 2026-09-02. Nothing in
// the UI calls them (the api.js wrappers are unused), so only external API
// callers ever hit the shadowing; found while authoring /api docs.
router.get("/sighting-settings", requirePermission("assetsQuarantine", "read"), async (_req, res, next) => {
  try {
    res.json(await getSightingSettings());
  } catch (err) {
    next(err);
  }
});

router.put("/sighting-settings", requirePermission("assetsQuarantine", "write"), async (req, res, next) => {
  try {
    const Schema = z.object({ sightingMaxAgeDays: z.number().int().min(0).max(3650) });
    const input = Schema.parse(req.body);
    await updateSightingSettings(input);
    logEvent({
      action: "asset.sighting_settings_updated",
      actor: requestActor(req),
      message: `Quarantine sighting max-age set to ${input.sightingMaxAgeDays} day(s)`,
    });
    res.json(input);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id — get single asset (all authenticated users)
router.get("/:id", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id as string },
      include: {
        discoveredByIntegration:  { select: { id: true, name: true, type: true, config: true } },
        monitorCredential:        { select: { id: true, name: true, type: true } },
        responseTimeCredential:   { select: { id: true, name: true, type: true } },
        cpuMemoryCredential:      { select: { id: true, name: true, type: true } },
        temperatureCredential:    { select: { id: true, name: true, type: true } },
        interfacesCredential:     { select: { id: true, name: true, type: true } },
        lldpCredential:           { select: { id: true, name: true, type: true } },
        associatedIpRows:         { select: ASSOCIATED_IP_SELECT },
        macAddressRows:           { select: MAC_ROW_SELECT },
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    const ipCtx = asset.ipAddress
      ? (await buildIpContexts([asset.ipAddress])).get(asset.ipAddress) || null
      : null;

    // Resolve the integration's response-time probe override so the details
    // panel can label the chart with the actual probe method (SNMP via the
    // override credential, vs. the default FortiOS REST API path). The
    // integration's full `config` is not safe to leak to the client (it
    // contains API tokens), so strip it after extracting the credential id
    // and the FMG `useProxy` toggle (the System tab badges need to know
    // whether REST API traffic rides FMG's `/sys/proxy/json` or hits the
    // FortiGate directly).
    let integrationMonitorCredential: { id: string; name: string; type: string } | null = null;
    let integrationUseProxy: boolean | null = null;
    let integrationSyncDescriptions: boolean | null = null;
    if (asset.discoveredByIntegration) {
      const cfg = (asset.discoveredByIntegration.config as Record<string, unknown> | null) || {};
      const credId = typeof cfg.monitorCredentialId === "string" ? cfg.monitorCredentialId : null;
      if (credId) {
        const cred = await prisma.credential.findUnique({
          where: { id: credId },
          select: { id: true, name: true, type: true },
        });
        if (cred) integrationMonitorCredential = cred;
      }
      // Only meaningful for FortiManager; standalone FortiGate is always direct.
      if (asset.discoveredByIntegration.type === "fortimanager") {
        integrationUseProxy = cfg.useProxy !== false;
      }
      // Description Sync is a FortiManager + standalone FortiGate toggle. Expose
      // a derived boolean (the raw config is stripped below — it holds API
      // tokens) so the asset edit form can cap the FortiAP Description at the
      // 35-char device `location` limit, but only when this AP's integration
      // actually syncs descriptions to the device.
      if (isFortinetIntegrationType(asset.discoveredByIntegration.type)) {
        integrationSyncDescriptions = cfg.syncDescriptions === true;
      }
    }
    const { config: _omit, ...integrationLite } = (asset.discoveredByIntegration as { config?: unknown } | null) || {};
    const { associatedIpRows, macAddressRows, ...assetRest } = asset;
    // Same second line as the list's hostname cell: what discovery says, for a
    // row whose hostname is currently pinned. Only queried when pinned.
    const hostnameDiscovered = asset.hostnameOverride
      ? await getDiscoveredHostname(asset.id)
      : null;
    const safeAsset = {
      ...assetRest,
      associatedIps: shapeAssociatedIps(associatedIpRows),
      macAddresses:  shapeMacRows(macAddressRows),
      hostnameDiscovered,
      discoveredByIntegration: asset.discoveredByIntegration
        ? { ...integrationLite, useProxy: integrationUseProxy, syncDescriptions: integrationSyncDescriptions }
        : null,
      integrationMonitorCredential,
    };

    res.json({ ...safeAsset, ipContext: ipCtx });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/effective-monitor-settings — fully-resolved monitor
// settings for one asset PLUS per-field tier provenance, so the asset edit
// modal can render "Asset / Class / Integration / Manual" badges next to
// each field. Read-open to any authenticated caller.
router.get("/:id/effective-monitor-settings", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        id:                         true,
        assetType:                  true,
        discoveredByIntegrationId:  true,
        discoveredByIntegration:    { select: { name: true, type: true, pollInterval: true } },
        monitorIntervalSec:         true,
        cpuMemoryIntervalSec:       true,
        temperatureIntervalSec:     true,
        systemInfoIntervalSec:      true,
        probeTimeoutMs:             true,
        cpuMemoryTimeoutMs:         true,
        temperatureTimeoutMs:       true,
        systemInfoTimeoutMs:        true,
        responseTimePolling:        true,
        cpuMemoryPolling:           true,
        temperaturePolling:         true,
        interfacesPolling:          true,
        lldpPolling:                true,
        storagePolling:             true,
        responseTimeMibId:          true,
        cpuMemoryMibId:             true,
        temperatureMibId:           true,
        interfacesMibId:            true,
        lldpMibId:                  true,
        responseTimeCredentialId:   true,
        cpuMemoryCredentialId:      true,
        temperatureCredentialId:    true,
        interfacesCredentialId:     true,
        lldpCredentialId:           true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    const result = await resolveMonitorSettingsWithProvenance({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    // mibLookup: every non-null MIB UUID across the five streams, mapped to
    // its moduleName so the frontend's monitoring chips can append a "MIB:
    // <module>" segment without a second round-trip. Standard MIB ids (the
    // `std:<key>` namespace, owned entirely by the frontend) are skipped —
    // those resolve through `_SNMP_STANDARD_MIBS` in assets.js.
    const mibIds = new Set<string>();
    for (const id of [
      result.resolved.responseTimeMibId,
      result.resolved.cpuMemoryMibId,
      result.resolved.temperatureMibId,
      result.resolved.interfacesMibId,
      result.resolved.lldpMibId,
    ]) {
      if (typeof id === "string" && id && !id.startsWith("std:")) mibIds.add(id);
    }
    const mibLookup: Record<string, { moduleName: string }> = {};
    if (mibIds.size > 0) {
      const rows = await prisma.mibFile.findMany({
        where:  { id: { in: [...mibIds] } },
        select: { id: true, moduleName: true },
      });
      for (const r of rows) mibLookup[r.id] = { moduleName: r.moduleName };
    }
    // Surface the integration's name + pollInterval alongside the resolved
    // settings so the frontend can render the "integrationPollInterval"
    // provenance badge as `Inherit: 14400s (4h, from <integration> discovery
    // cycle)` without a second /integrations/:id round-trip.
    const integrationInfo = asset.discoveredByIntegration
      ? {
          id:           asset.discoveredByIntegrationId,
          name:         asset.discoveredByIntegration.name,
          type:         asset.discoveredByIntegration.type,
          pollInterval: asset.discoveredByIntegration.pollInterval,
        }
      : null;
    // WHICH AUTOMATION DECIDES THIS DEVICE IS DOWN. The missed-poll count is no
    // longer a settings value (business rule 36), so the modal that used to
    // point operators at "the tier where it lives" has to point at the
    // automation instead — and for a device no automation covers, say that
    // plainly rather than rendering a threshold nobody applies. `passive: true`
    // is that case. Derived, never stored; the resolver reads its cached
    // snapshot so this costs no query in the steady state.
    const downCoverage = await describeDownDetectionFor(id);
    const downDetection = downCoverage
      ? {
          passive:      downCoverage.passive,
          missedPolls:  downCoverage.winner?.threshold ?? null,
          // The counterpart count: how many probes must ANSWER before the asset
          // reads `up` again. Resolved here rather than left to the client to
          // divide seconds by a cadence, so the intermittency strip's replay of
          // the state machine reads the same number the probe loop applied.
          recoveryPolls: downCoverage.winner
            ? recoveryPollsFor(downCoverage.winner, result.resolved.intervalSeconds)
            : null,
          automationId: downCoverage.winner?.ruleId ?? null,
          automationName: downCoverage.winner?.ruleName ?? null,
          // The colour every surface paints `down` in (business rule 36). Down
          // is not inherently red — red is what `critical` looks like, and it
          // is merely the default severity of a seeded down automation. Sent as
          // the severity NAME, not a colour: the palette belongs to the client
          // that is drawing (browser tokens vs the email's flat hex).
          severity: downCoverage.winner?.severity ?? null,
          // A tie is two equally-specific automations asking for different
          // counts on this device — surfaced so the modal can say which one
          // won rather than leaving the operator to guess.
          conflict:     downCoverage.conflict
            ? { ruleIds: downCoverage.conflict.ruleIds, counts: downCoverage.conflict.counts, chosen: downCoverage.conflict.chosen }
            : null,
        }
      : null;
    res.json({ ...result, mibLookup, integration: integrationInfo, downDetection });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/ip-history — IP address history for an asset (all authenticated users)
router.get("/:id/ip-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string }, select: { id: true } });
    if (!asset) throw new AppError(404, "Asset not found");
    res.json(await getIpHistory(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/alerts — active alerts for this asset + the enabled
// automations whose scope matches it (asset-details Alerts tab). The
// pre-rename /:id/notifications path stays as a deprecated alias.
router.get(["/:id/alerts", "/:id/notifications"], requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string }, select: { id: true } });
    if (!asset) throw new AppError(404, "Asset not found");
    res.json(await getAssetNotifications(req.params.id as string));
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/metric-thresholds?metric=hwSensorValue&sensorName=&sensorClass=
// The severity thresholds that would fire on this asset's charted metric, so a
// detail chart can shade its line with the engine's own numbers (severity bands
// included) instead of the client re-deriving them. Gated assets:read like
// every other per-asset chart feed.
router.get("/:id/metric-thresholds", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const metric = String(req.query.metric || "");
    if (!metric) throw new AppError(400, "metric is required");
    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!asset) throw new AppError(404, "Asset not found");
    const sensorName = req.query.sensorName ? String(req.query.sensorName) : undefined;
    const sensorClass = req.query.sensorClass ? String(req.query.sensorClass) : undefined;
    const dimension = sensorName || sensorClass ? { sensorName, sensorClass } : undefined;
    res.json({ metric, tiers: await getMetricSeverityTiers(id, metric, dimension) });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/monitor-history?range=1h|12h|24h|7d|30d OR ?from=ISO&to=ISO
router.get("/:id/monitor-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const fromQ = req.query.from ? String(req.query.from) : null;
    const toQ   = req.query.to   ? String(req.query.to)   : null;
    let since: Date;
    let until: Date;
    let rangeLabel: string;
    if (fromQ && toQ) {
      const f = new Date(fromQ), t = new Date(toQ);
      if (isNaN(+f) || isNaN(+t)) throw new AppError(400, "Invalid from/to date");
      if (+f >= +t) throw new AppError(400, "from must be before to");
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      if (+t - +f > oneYearMs) throw new AppError(400, "Custom range cannot exceed 1 year");
      since = f;
      until = t;
      rangeLabel = "custom";
    } else {
      const range = String(req.query.range || "24h");
      const windowMs =
        range === "1h"  ?  1 * 60 * 60 * 1000 :
        range === "12h" ? 12 * 60 * 60 * 1000 :
        range === "7d"  ?  7 * 24 * 60 * 60 * 1000 :
        range === "30d" ? 30 * 24 * 60 * 60 * 1000 :
                            24 * 60 * 60 * 1000;
      until = new Date();
      since = new Date(+until - windowMs);
      rangeLabel = range;
    }
    const pick = await pickSampleTierForAsset(id, "assets", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readMonitorHistory(id, since, until, pick.tier, fetchSince);
    // On a rollup tier every sample timestamp is a bucketStart, so the client
    // can't measure probe freshness from the series (a daily bucket is up to
    // 24h "old" the moment it's written). Hand it the real last-success
    // timestamp from the detail table instead — the stale banner reads this
    // when present. Detail tier needs no extra query: its own newest
    // successful sample already is the answer.
    const lastSuccessAt = pick.tier === "detail" ? null : await readLastMonitorSuccessAt(id, since);
    // WHICH MISSES ARE ALREADY A VERDICT. The chart replays the leaky bucket to
    // colour its dive (business rule 30 + 36): amber while the count is short
    // of the covering automation's `missedPolls`, red once it reaches it — the
    // same split the Last-30-min strip draws directly above it. It rides this
    // payload rather than a second request because the chart renders the moment
    // this resolves, and a threshold arriving later would repaint the outage
    // under the operator. `passive: true` means no automation covers the device,
    // so nothing may go red. Reads the resolver's cached index — no query in the
    // steady state — and degrades to null rather than failing the history.
    const downCoverage = await describeDownDetectionFor(id).catch(() => null);
    // The counterpart count: how many probes must ANSWER before the device
    // reads Up again (business rule 36). The chart needs it for the same reason
    // the strip does — the climb out of an outage stays purple until the run is
    // served, which is LONGER than the bucket's drain whenever the automation's
    // reset asks for more. Resolving it costs an asset read only when the
    // automation actually sets a reset hold; without one the answer is the
    // missed-poll count itself and no cadence is involved.
    let recoveryPolls: number | null = null;
    const downWinner = downCoverage?.winner ?? null;
    if (downWinner) {
      if (!downWinner.recoverySustainSec) {
        recoveryPolls = downWinner.threshold;
      } else {
        const ctx = await prisma.asset.findUnique({
          where: { id },
          select: {
            assetType: true, discoveredByIntegrationId: true, monitorIntervalSec: true,
            cpuMemoryIntervalSec: true, temperatureIntervalSec: true, systemInfoIntervalSec: true,
            probeTimeoutMs: true,
            discoveredByIntegration: { select: { type: true } },
          },
        });
        if (ctx) {
          const resolved = await resolveMonitorSettings({
            ...ctx,
            discoveredByIntegrationType: ctx.discoveredByIntegration?.type ?? null,
          });
          recoveryPolls = recoveryPollsFor(downWinner, resolved.intervalSeconds);
        }
      }
    }
    res.json({
      range: rangeLabel,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      lastSuccessAt,
      downDetection: downCoverage
        ? {
            passive: downCoverage.passive,
            missedPolls: downWinner?.threshold ?? null,
            recoveryPolls,
            // What the covering automation rated this outage — the colour the
            // response-time chart draws a `down` probe in. See business rule 36.
            severity: downWinner?.severity ?? null,
          }
        : null,
      samples: result.samples,
      stats: result.stats,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/probe-now — run a one-off probe immediately.
// Gated `assetsProbe=read`: probing dials the device and writes no Polaris
// state, so read IS the grant on that key (its ladder stops there).
// Triggers all three cadences (response-time, telemetry, system info) so the
// asset details panel refreshes everything at once instead of waiting for the
// scheduler to come around. Returns a per-stream status so the UI can tell
// the operator which streams refreshed and which failed (and why) — silent
// failures used to leave the System tab stale with no explanation.
router.post("/:id/probe-now", requirePermission("assetsProbe", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;

    // Honor the originating integration's deviceInclude/deviceExclude (or
    // ouInclude/ouExclude for AD). A refresh shouldn't pull data from a
    // device the next discovery sweep would skip — operators tighten these
    // filters precisely to keep the inventory off certain hosts. If the asset
    // is now out of scope we short-circuit before any probe traffic goes out.
    const filterAsset = await prisma.asset.findUnique({
      where: { id },
      select: {
        hostname: true,
        ipAddress: true,
        learnedLocation: true,
        assetType: true,
        discoveredByIntegration: { select: { id: true, type: true, config: true, name: true } },
      },
    });
    if (!filterAsset) throw new AppError(404, "Asset not found");
    if (filterAsset.discoveredByIntegration) {
      // For AD, prefer the source's own observed.ouPath over the merged
      // learnedLocation field (which other integrations can overwrite). The
      // lookup is cheap — one row, indexed by (sourceKind, externalId)'s
      // assetId index — and only runs on AD-discovered assets.
      let adOuPath: string | null = null;
      if (filterAsset.discoveredByIntegration.type === "activedirectory") {
        const adSource = await prisma.assetSource.findFirst({
          where: { assetId: id, sourceKind: "ad" },
          select: { observed: true },
        });
        const obs = (adSource?.observed as Record<string, unknown> | null) || null;
        if (obs && typeof obs.ouPath === "string") adOuPath = obs.ouPath;
      }
      // For vCenter, the vmInclude/vmExclude filters match the vCenter-side
      // VM name, which can differ from the merged hostname (guest hostname
      // wins projection) — same source-preferred pattern as AD's ouPath.
      let vmName: string | null = null;
      if (filterAsset.discoveredByIntegration.type === "vcenter") {
        const vmSource = await prisma.assetSource.findFirst({
          where: { assetId: id, sourceKind: "vcenter-vm" },
          select: { observed: true },
        });
        const obs = (vmSource?.observed as Record<string, unknown> | null) || null;
        if (obs && typeof obs.name === "string") vmName = obs.name;
      }
      const filt = assetMatchesIntegrationFilter({ ...filterAsset, adOuPath, vmName }, filterAsset.discoveredByIntegration);
      if (!filt.included) {
        const reason = filt.reason || "Excluded by integration filter";
        const label = filterAsset.hostname || filterAsset.ipAddress || id;
        logEvent({
          action: "asset.refresh",
          resourceType: "asset",
          resourceId: id,
          resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
          actor: requestActor(req),
          level: "warning",
          message: `Poll blocked: ${label} — ${reason}`,
          details: { integrationId: filterAsset.discoveredByIntegration.id, integrationType: filterAsset.discoveredByIntegration.type, reason },
        });
        res.status(409).json({
          success: false,
          responseTimeMs: 0,
          error: reason,
          telemetry:   { supported: true, collected: false, error: reason },
          temperature: { supported: true, collected: false, error: reason },
          systemInfo:  { supported: true, collected: false, error: reason },
        });
        return;
      }
    }

    // Keep flat response-time fields at the root for back-compat with anything
    // that still reads `success` / `responseTimeMs` directly.
    const probe = await probeAsset(id);
    await recordProbeResult(id, probe);

    // Telemetry (CPU/mem) and temperature dispatch independently — different
    // polling methods, credentials, MIBs, timeouts — so run them in parallel.
    // System-info is its own collector but also kicked off concurrently
    // because none of the three depend on each other's results. Each catch
    // returns a properly-typed CollectionResult so the union below has `data`
    // on every branch (TS narrowing was complaining otherwise).
    type TelResult  = Awaited<ReturnType<typeof collectTelemetry>>;
    type HwResult   = Awaited<ReturnType<typeof collectHardwareSensors>>;
    type SysResult  = Awaited<ReturnType<typeof collectSystemInfo>>;
    const tr_p:    Promise<TelResult>  = collectTelemetry(id).catch((err: any): TelResult  => ({ supported: true, error: err?.message || "Telemetry collection failed" }));
    const hwR_p:   Promise<HwResult>   = collectHardwareSensors(id).catch((err: any): HwResult => ({ supported: true, error: err?.message || "Hardware sensor collection failed" }));
    const sr_p:    Promise<SysResult>  = collectSystemInfo(id).catch((err: any): SysResult  => ({ supported: true, error: err?.message || "System info collection failed" }));
    const [tr, hwR, sr] = [await tr_p, await hwR_p, await sr_p];
    await Promise.all([
      recordTelemetryResult(id, tr),
      recordHardwareSensorResult(id, hwR),
      recordSystemInfoResult(id, sr),
    ]);
    const telemetry   = { supported: tr.supported,    collected: !!tr.data,                                       error: tr.error };
    // Hardware sensors are "collected" when the device actually returned sensor
    // rows. An empty array (sensor-less device) is supported-but-empty —
    // surfaced as n/a rather than failure so the toast doesn't nag on devices
    // that simply don't publish hardware sensors.
    const hwData      = Array.isArray(hwR.data) ? hwR.data : null;
    const hardware    = { supported: hwR.supported, collected: !!hwData && hwData.length > 0,                    error: hwR.error };
    const hwNoData    = !!(hwR.supported && hwData && hwData.length === 0);
    const systemInfo  = { supported: sr.supported,    collected: !!sr.data,                                       error: sr.error };

    // Audit the manual poll. The periodic monitorAssets job only writes
    // events on up/down transitions; this endpoint is operator-initiated, so
    // each click should leave a trace regardless of status change.
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { hostname: true, ipAddress: true },
    });
    const label = asset?.hostname || asset?.ipAddress || id;
    const ok = probe.success;
    // A SKIPPED probe is not a failed one — nothing was measured. Two sources:
    // the response-time stream is set to Disabled (the operator's own choice),
    // and vCenter itself being unreachable. Rendering either as
    // "failed: unknown" and stamping a warning Event told the operator their
    // device was broken when Polaris had simply not asked.
    const probeSkipped = probe.skipped === true;
    const streamSummary: string[] = [];
    streamSummary.push(
      `probe ${ok
        ? probe.responseTimeMs + " ms"
        : probeSkipped
          ? "n/a" + (probe.error ? ` (${probe.error})` : " (not polled)")
          : "failed: " + (probe.error || "unknown")}`,
    );
    streamSummary.push(`telemetry ${telemetry.collected ? "ok" : (telemetry.supported ? "failed: " + (telemetry.error || "no data") : "n/a")}`);
    streamSummary.push(`hardware ${hardware.collected ? "ok" : (hwNoData ? "n/a (no sensors)" : (hardware.supported ? "failed: " + (hardware.error || "no data") : "n/a"))}`);
    streamSummary.push(`interfaces ${systemInfo.collected ? "ok" : (systemInfo.supported ? "failed: " + (systemInfo.error || "no data") : "n/a")}`);
    const anyFail = (!ok && !probeSkipped) ||
      (telemetry.supported && !telemetry.collected) ||
      (hardware.supported  && !hardware.collected && !hwNoData) ||
      (systemInfo.supported && !systemInfo.collected);
    logEvent({
      action: "asset.refresh",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset?.hostname || asset?.ipAddress || undefined,
      actor: requestActor(req),
      level: anyFail ? "warning" : "info",
      message: `Poll: ${label} — ${streamSummary.join("; ")}`,
      details: { probe, telemetry, hardware, systemInfo },
    });

    res.json({ ...probe, telemetry, hardware, systemInfo });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/rediscover — run discovery scoped to ONE asset.
// Backs the asset details slide-in's "Discover Now" button.
//
// `resolveDiscoveryScopeForAsset` decides which integration runs and how the
// run is narrowed (see that module). For an FMG-owned FortiGate this queues a
// SCOPED run (triggerDiscovery { scopeDeviceName }): the full run machinery —
// DiscoveryRun row, progress, abort, pg-boss handoff — narrowed to the one
// roster device, with the finalize pass in "finalize-scoped" mode
// (per-controller switch/AP decommission only; no fleet sweeps). For a
// standalone-FortiGate asset the integration IS the single gate, so a plain
// full run is the exact equivalent.
//
// A FortiSwitch/FortiAP resolves to its CONTROLLER gate and scopes the run to
// that: a switch is only ever discovered as a by-product of its controller's
// pass, and "finalize-scoped" is precisely the per-gate ghost-switch/AP
// cleanup such an asset needs. The response says which device was targeted so
// the caller can tell the operator when it wasn't the asset they clicked.
//
// No request body. Gated assets:write (above Poll Now's read-only assetsProbe
// grant) because a discovery mutates inventory — creates/updates assets +
// reservations, decommissions vanished switches/APs, releases stale VIP /
// dhcp_reservation rows.
// HA note: fortinetTopology.deviceName resolves to the FMG cluster device, so
// re-discovering a standby member's asset re-discovers the whole cluster.
router.post("/:id/rediscover", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const resolution = await resolveDiscoveryScopeForAsset(id);
    if (!resolution.ok) {
      // A missing asset is the only 404; every other reason is a legitimate
      // "this asset has no re-runnable discovery" → 400 with the reason as the
      // message, so the operator is told why.
      throw new AppError(resolution.notFound ? 404 : 400, resolution.reason);
    }
    const { integration, scope, deviceName, filterAsset, viaController } = resolution.resolved;

    // Honor deviceInclude/deviceExclude, same as probe-now: a discovery must
    // not pull a device the next full sweep would skip. Checked against the
    // hostname (assetMatchesIntegrationFilter's match field) and the resolved
    // FMG device name — the filter patterns can target either. For a
    // switch/AP, filterAsset is already the controller gate.
    const filtHost = assetMatchesIntegrationFilter(filterAsset, integration);
    const filtDevice = deviceName
      ? assetMatchesIntegrationFilter({ ...filterAsset, hostname: deviceName }, integration)
      : filtHost;
    if (!filtHost.included && !filtDevice.included) {
      const reason = filtHost.reason || "Excluded by integration filter";
      logEvent({
        action: "asset.rediscover",
        resourceType: "asset",
        resourceId: id,
        resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
        actor: requestActor(req),
        level: "warning",
        message: `Discovery blocked: ${filterAsset.hostname || deviceName} — ${reason}`,
        details: { integrationId: integration.id, integrationType: integration.type, deviceName, reason },
      });
      res.status(409).json({ message: reason });
      return;
    }

    // Pre-check for a friendly message; triggerDiscovery's coalescing return
    // is the authoritative guard (closes the TOCTOU window).
    if (await isRunActive(integration.id)) {
      res.status(409).json({ message: `A discovery is already running for "${integration.name}" — try again when it finishes` });
      return;
    }
    // requestActor covers bearer-token callers ("api:<token name>") as well
    // as sessions — the actor string labels the run's start/complete Events.
    const actor = requestActor(req) ?? "";
    // `scopeLabel` gives the run row a name an operator recognises: the gate
    // name for FMG, the asset's hostname for a directory device (whose scope
    // identifier is an opaque GUID).
    const started = scope
      ? await triggerDiscovery(integration.id, actor, { scope, scopeLabel: deviceName })
      : await triggerDiscovery(integration.id, actor);
    if (!started) {
      res.status(409).json({ message: `A discovery is already running for "${integration.name}" — try again when it finishes` });
      return;
    }

    const target = deviceName || integration.name;
    logEvent({
      action: "asset.rediscover",
      resourceType: "asset",
      resourceId: id,
      resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
      actor: requestActor(req),
      message: viaController
        ? `Discovery requested via controller FortiGate "${target}" using "${integration.name}"`
        : `Discovery requested for FortiGate "${filterAsset.hostname || target}" via "${integration.name}"`,
      details: { integrationId: integration.id, integrationType: integration.type, deviceName, viaController },
    });
    res.status(202).json({
      message: viaController ? `Discovery started on controller ${target}` : "Discovery started",
      integrationId: integration.id,
      integrationName: integration.name,
      deviceName,
      viaController,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/assets/:id/snmp-walk — operator-driven SNMP walk used by the
// asset details "SNMP Walk" tab. Admin-only because the response includes raw
// device data that the integration filter doesn't touch (e.g. tunnel names,
// configured users) — read-only but high-fidelity. Walks `oid` against the
// asset's `ipAddress` using the supplied credentialId (any stored SNMP
// credential, not necessarily the asset's monitor credential), capped at
// `maxRows` (1..5000, default 500).
const SnmpWalkSchema = z.object({
  credentialId: z.string().uuid("credentialId must be a UUID"),
  oid:          z.string().regex(/^\d+(\.\d+)*$/, "OID must be numeric (e.g. 1.3.6.1.2.1.1)").optional().default("1.3.6.1.2.1.1"),
  maxRows:      z.number().int().min(1).max(5000).optional().default(500),
});

router.post("/:id/snmp-walk", requirePermission("assetsProbe", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const parsed = SnmpWalkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.issues.map(e => e.message).join("; "));
    }
    const { credentialId, oid, maxRows } = parsed.data;

    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, ipAddress: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    if (!asset.ipAddress) throw new AppError(400, "Asset has no IP address to walk");

    const cred = await getCredential(credentialId, { revealSecrets: true });
    if (cred.type !== "snmp") {
      throw new AppError(400, `Credential "${cred.name}" is type "${cred.type}", expected "snmp"`);
    }

    const label = asset.hostname || asset.ipAddress;
    try {
      const result = await snmpWalkRaw(asset.ipAddress, cred.config as Record<string, unknown>, oid, maxRows);
      logEvent({
        action: "asset.snmp_walk",
        resourceType: "asset",
        resourceId: id,
        resourceName: asset.hostname || asset.ipAddress || undefined,
        actor: requestActor(req),
        level: "info",
        message: `SNMP walk: ${label} — ${oid} → ${result.rows.length} row(s)${result.truncated ? " (truncated)" : ""}`,
        details: { oid, credentialName: cred.name, rows: result.rows.length, truncated: result.truncated, durationMs: result.durationMs },
      });
      res.json({ ...result, oid, host: asset.ipAddress });
    } catch (err: any) {
      const message = err?.message || "SNMP walk failed";
      logEvent({
        action: "asset.snmp_walk",
        resourceType: "asset",
        resourceId: id,
        resourceName: asset.hostname || asset.ipAddress || undefined,
        actor: requestActor(req),
        level: "warning",
        message: `SNMP walk failed: ${label} — ${oid} — ${message}`,
        details: { oid, credentialName: cred.name, error: message },
      });
      throw new AppError(502, message);
    }
  } catch (err) { next(err); }
});

// ─── System tab endpoints ──────────────────────────────────────────────────
//
// Telemetry, interface, and storage histories live on /assets/:id/... and
// share the same range/from-to query semantics as /monitor-history. BigInt
// columns are coerced to Number on the way out — interface octets up to
// 2^53-1 (≈9 PB) fit safely.

const RANGE_MS: Record<string, number> = {
  "1h":  1 * 60 * 60 * 1000,
  "12h": 12 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d":  7  * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

function resolveRange(req: any): { since: Date; until: Date; rangeLabel: string } {
  const fromQ = req.query.from ? String(req.query.from) : null;
  const toQ   = req.query.to   ? String(req.query.to)   : null;
  if (fromQ && toQ) {
    const f = new Date(fromQ), t = new Date(toQ);
    if (isNaN(+f) || isNaN(+t)) throw new AppError(400, "Invalid from/to date");
    if (+f >= +t) throw new AppError(400, "from must be before to");
    if (+t - +f > 365 * 24 * 60 * 60 * 1000) throw new AppError(400, "Custom range cannot exceed 1 year");
    return { since: f, until: t, rangeLabel: "custom" };
  }
  const range = String(req.query.range || "24h");
  const windowMs = RANGE_MS[range] ?? RANGE_MS["24h"];
  const until = new Date();
  return { since: new Date(+until - windowMs), until, rangeLabel: range };
}

/**
 * Extend `since` backwards by one bucket of lookback overflow so the chart
 * polyline has at least one sample BEFORE the visible window. The renderer
 * clips drawn content to `[since, until]` via SVG clipPath, so the extra
 * sample is hidden but its presence lets the line enter the chart from the
 * left edge instead of starting partway through. Stats stay scoped to the
 * visible window (filtered in the service). See the "Time-series chart
 * (SVG)" section of polaris-ui-canon.
 *
 *   - detail tier (bucketSeconds=0): 5-minute lookback — covers ~1-5 polls
 *     at 1m/2m/5m cadences without bloating the query.
 *   - hourly tier: one extra bucket (3600s).
 *   - daily tier:  one extra bucket (86400s).
 */
function extendSinceForLookback(since: Date, bucketSeconds: number): Date {
  const DETAIL_LOOKBACK_MS = 5 * 60 * 1000;
  const lookbackMs = bucketSeconds > 0 ? bucketSeconds * 1000 : DETAIL_LOOKBACK_MS;
  return new Date(+since - lookbackMs);
}

function bigIntToNumber(v: bigint | null | undefined): number | null {
  if (v == null) return null;
  return Number(v);
}

// GET /assets/:id/maintenance-windows?range=...|from=...&to=... — maintenance
// window rows overlapping the chart range. Fetched in parallel with the
// sample histories (same pattern as the polling-transition Event fetch) and
// rendered as labeled shaded bands on every asset-details chart.
router.get("/:id/maintenance-windows", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { since, until, rangeLabel } = resolveRange(req);
    const windows = await listAssetWindows(id, since, until);
    res.json({ range: rangeLabel, since, until, windows });
  } catch (err) { next(err); }
});

// GET /assets/:id/maintenance-info — current windows + covering schedules for
// the edit-modal Monitoring tab / slide-over.
router.get("/:id/maintenance-info", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await getAssetMaintenanceInfo(req.params.id as string));
  } catch (err) { next(err); }
});

// GET /assets/:id/contacts — the address-book entries RESPONSIBLE for this
// device (Contact.assetCondition ∪ Contact.assetIds), for the slide-over's
// Contacts row. Chained gate: reading it exposes address-book content, so the
// caller needs `contacts:read` on top of `assets:read`.
router.get(
  "/:id/contacts",
  requirePermission("assets", "read"),
  requirePermission("contacts", "read"),
  async (req, res, next) => {
    try {
      const contacts = await resolveContactsForAsset(req.params.id as string);
      res.json({
        contacts: contacts.map((c) => ({
          id: c.id,
          email: c.email,
          name: c.name,
          description: c.description,
          // Why this contact matched — a pin is an operator decision, a filter
          // match is a rule, and an operator chasing an unexpected recipient
          // needs to know which.
          via: c.assetIds.includes(req.params.id as string) ? "pinned" : "filter",
        })),
      });
    } catch (err) { next(err); }
  },
);

// GET /assets/:id/telemetry-history?range=...|from=...&to=... — CPU+memory time series
router.get("/:id/telemetry-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "cpuMem", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    // The telemetry cadence does not run while an asset is down, so a missed
    // poll leaves no row to mark. `outages` carries the response-time probe's
    // own failure record for the same window — the chart dives its line to the
    // baseline across each one instead of guessing at the outage from the size
    // of the hole. See services/probeOutageService.ts.
    const [result, outages] = await Promise.all([
      readTelemetryHistory(id, since, until, pick.tier, fetchSince),
      readProbeOutages(id, since, until),
    ]);
    res.json({
      range: rangeLabel,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      stats: result.stats,
      outages: serializeOutages(outages),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/system-info — latest interface + storage snapshot. Returns
// every interface row tied to the most-recent system-info scrape timestamp,
// plus the most-recent telemetry row. Used to populate the System tab grid
// without requiring the client to make three separate calls.
router.get("/:id/system-info", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true, monitored: true,
        lastTelemetryAt: true, lastSystemInfoAt: true,
        monitoredInterfaces: true,
        monitoredStorage: true,
        monitoredIpsecTunnels: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const [latestTelemetry, interfaces, latestStorageMeta, latestHwMeta, latestIpsecMeta, lldpNeighbors, wirelessStations, apRadios, inferredNeighbors] = await Promise.all([
      prisma.assetTelemetrySample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
      }),
      // Current-state interface inventory — one row per ifName, delete-replaced
      // per full scrape, so it needs no timestamp gate the way the sample
      // tables do (same shape as the physicalEntities read below).
      prisma.assetInterface.findMany({
        where: { assetId: id },
        orderBy: { ifName: "asc" },
      }),
      prisma.assetStorageSample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
      prisma.assetHardwareSensorSample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
      prisma.assetIpsecTunnelSample.findFirst({
        where: { assetId: id },
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
      // LLDP neighbors are current-state (one row per neighbor) rather than
      // a time-series, so we just return the entire set on every call. The
      // matched-asset relation lets the UI link from a neighbor row directly
      // to that asset's details modal.
      prisma.assetLldpNeighbor.findMany({
        where: { assetId: id },
        orderBy: [{ localIfName: "asc" }, { systemName: "asc" }],
        include: {
          matchedAsset: {
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          },
        },
      }),
      // Wireless stations connected to this AP (current-state, like LLDP).
      // Empty for non-AP assets — the table only carries rows when the
      // SNMP fapStationTable scrape ran on an `assetType="access_point"`
      // asset. matchedAsset cross-links to the connected endpoint when the
      // station's MAC resolved against the inventory.
      prisma.assetWirelessStation.findMany({
        where: { apAssetId: id },
        orderBy: [{ ssid: "asc" }, { staMacAddr: "asc" }],
        include: {
          matchedAsset: {
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          },
        },
      }),
      // The AP's radios with the SSIDs each one broadcasts nested inside —
      // the two levels above the wireless stations below, so the Stations tab
      // can render radio -> SSID -> station. Empty for every non-AP asset and
      // for any AP a discovery cycle has not reached yet.
      getApRadioInventory(id),
      // Peer-inferred neighbors synthesized from Asset.fortinetTopology
      // (managed FortiAPs reported via FortiGate, FortiSwitch FortiLink
      // uplinks, etc.). Real LLDP rows take precedence on collision —
      // dedupe by (localIfName, matchedAssetId) below.
      buildInferredNeighborsForAsset(id),
    ]);

    // `interfaces` now comes straight from the current-state table above. The
    // former lastSystemInfoAt anchor (and its clamp for the agent's
    // independent interface/storage pushes, which could leave the anchor at a
    // time with no interface rows and empty this table) existed only because a
    // hypertable has no notion of "current" — both are gone with it.

    // Merge inferred neighbors after the interface rows are loaded so an
    // inferred row on an aggregate (e.g. FortiLink) dedupes against a real
    // LLDP row learned on one of its member ports — same physical link.
    const mergedNeighbors = [
      ...lldpNeighbors,
      ...dedupeInferredNeighbors(lldpNeighbors, inferredNeighbors, aggregateMembershipMap(interfaces)),
    ];
    // Hardware inventory is current-state (delete-replaced per scrape), so it
    // needs no timestamp gate the way the sample tables do.
    const physicalEntities = await prisma.assetPhysicalEntity.findMany({
      where: { assetId: id },
      orderBy: [{ entClass: "asc" }, { entIndex: "asc" }],
    });
    const storage = latestStorageMeta
      ? await prisma.assetStorageSample.findMany({
          where: { assetId: id, timestamp: latestStorageMeta.timestamp },
          orderBy: { mountPath: "asc" },
        })
      : [];
    const hardwareSensors = latestHwMeta
      ? await prisma.assetHardwareSensorSample.findMany({
          where: { assetId: id, timestamp: latestHwMeta.timestamp },
          orderBy: [{ sensorClass: "asc" }, { sensorName: "asc" }],
        })
      : [];
    // Same full-pass anchor as the interfaces query above: the fast cadence
    // only writes PINNED tunnels, so taking the raw newest timestamp hides
    // every unpinned tunnel from the System tab within a minute of any fast
    // walk. Anchor to lastSystemInfoAt (the full pass writes all tunnels at
    // that exact timestamp), clamped down when it's ahead of the newest
    // ipsec row (e.g. the last full pass's ipsec collect failed).
    let ipsecTimestamp = asset.lastSystemInfoAt ?? latestIpsecMeta?.timestamp ?? null;
    if (ipsecTimestamp && latestIpsecMeta?.timestamp && ipsecTimestamp > latestIpsecMeta.timestamp) {
      ipsecTimestamp = latestIpsecMeta.timestamp;
    }
    let ipsecTunnels = latestIpsecMeta && ipsecTimestamp
      ? await prisma.assetIpsecTunnelSample.findMany({
          where: { assetId: id, timestamp: ipsecTimestamp },
          orderBy: { tunnelName: "asc" },
        })
      : [];
    // The anchor pass may have produced zero ipsec rows (transient collect
    // failure) while fast walks kept writing — fall back to the newest batch
    // (pinned subset) rather than rendering an empty tunnel table.
    if (ipsecTunnels.length === 0 && latestIpsecMeta && ipsecTimestamp?.getTime() !== latestIpsecMeta.timestamp.getTime()) {
      ipsecTunnels = await prisma.assetIpsecTunnelSample.findMany({
        where: { assetId: id, timestamp: latestIpsecMeta.timestamp },
        orderBy: { tunnelName: "asc" },
      });
    }

    res.json({
      monitored: asset.monitored,
      lastTelemetryAt: asset.lastTelemetryAt,
      lastTemperatureAt: latestHwMeta?.timestamp ?? null,
      lastSystemInfoAt: asset.lastSystemInfoAt,
      telemetry: latestTelemetry ? {
        timestamp:     latestTelemetry.timestamp,
        cpuPct:        latestTelemetry.cpuPct,
        memPct:        latestTelemetry.memPct,
        memUsedBytes:  bigIntToNumber(latestTelemetry.memUsedBytes),
        memTotalBytes: bigIntToNumber(latestTelemetry.memTotalBytes),
      } : null,
      interfaces: interfaces.map((i) => ({
        // Response shape is unchanged for the frontend: `timestamp` is now the
        // current-state row's lastSeen (the full-pass time it was observed),
        // which is exactly what the old per-sample timestamp carried.
        timestamp:   i.lastSeen,
        ifName:      i.ifName,
        adminStatus: i.adminStatus,
        operStatus:  i.operStatus,
        speedBps:    bigIntToNumber(i.speedBps),
        ipAddress:   i.ipAddress,
        macAddress:  i.macAddress,
        inOctets:    bigIntToNumber(i.inOctets),
        outOctets:   bigIntToNumber(i.outOctets),
        inErrors:    bigIntToNumber(i.inErrors),
        outErrors:   bigIntToNumber(i.outErrors),
        ifType:      i.ifType   ?? null,
        ifParent:    i.ifParent ?? null,
        vlanId:      i.vlanId   ?? null,
        nativeVlan:     i.nativeVlan  ?? null,
        taggedVlans:    i.taggedVlans ?? [],
        trunksAllVlans: i.trunksAllVlans === true,
        alias:       i.alias       ?? null,
        description: i.description ?? null,
        addressingMode: i.addressingMode ?? null,
        poeStatus:   i.poeStatus ?? null,
        poeClass:    i.poeClass  ?? null,
      })),
      physicalEntities: physicalEntities.map((e) => ({
        entIndex:    e.entIndex,
        entClass:    e.entClass,
        descr:       e.descr,
        name:        e.name,
        hardwareRev: e.hardwareRev,
        firmwareRev: e.firmwareRev,
        serialNum:   e.serialNum,
        mfgName:     e.mfgName,
        modelName:   e.modelName,
        isFru:       e.isFru,
        ifName:      e.ifName,
        firstSeen:   e.firstSeen,
      })),
      storage: storage.map((s) => ({
        timestamp:  s.timestamp,
        mountPath:  s.mountPath,
        totalBytes: bigIntToNumber(s.totalBytes),
        usedBytes:  bigIntToNumber(s.usedBytes),
      })),
      hardwareSensors: hardwareSensors.map((s) => ({
        timestamp:   s.timestamp,
        sensorName:  s.sensorName,
        sensorClass: s.sensorClass,
        value:       s.value,
        unit:        s.unit,
        alarmStatus: s.alarmStatus,
      })),
      ipsecTunnels: ipsecTunnels.map((t) => ({
        timestamp:       t.timestamp,
        tunnelName:      t.tunnelName,
        parentInterface: t.parentInterface,
        remoteGateway:   t.remoteGateway,
        status:          t.status,
        incomingBytes:   bigIntToNumber(t.incomingBytes),
        outgoingBytes:   bigIntToNumber(t.outgoingBytes),
        proxyIdCount:    t.proxyIdCount,
      })),
      lldpNeighbors: mergedNeighbors.map((n) => ({
        localIfName:        n.localIfName,
        chassisIdSubtype:   n.chassisIdSubtype,
        chassisId:          n.chassisId,
        portIdSubtype:      n.portIdSubtype,
        portId:             n.portId,
        portDescription:    n.portDescription,
        systemName:         n.systemName,
        systemDescription:  n.systemDescription,
        managementIp:       n.managementIp,
        capabilities:       n.capabilities,
        source:             n.source,
        firstSeen:          n.firstSeen,
        lastSeen:           n.lastSeen,
        matchedAsset:       n.matchedAsset
          ? {
              id:        n.matchedAsset.id,
              hostname:  n.matchedAsset.hostname,
              ipAddress: n.matchedAsset.ipAddress,
              assetType: n.matchedAsset.assetType,
            }
          : null,
      })),
      apRadios,
      wirelessStations: wirelessStations.map((w) => ({
        staMacAddr:     w.staMacAddr,
        staIpAddr:      w.staIpAddr,
        ssid:           w.ssid,
        radioId:        w.radioId,
        wlanId:         w.wlanId,
        band:           w.band,
        vlanId:         w.vlanId,
        bssid:          w.bssid,
        signalStrength: w.signalStrength,
        noise:          w.noise,
        bandwidthTx:    w.bandwidthTx,
        bandwidthRx:    w.bandwidthRx,
        idleSeconds:    w.idleSeconds,
        source:         w.source,
        firstSeen:      w.firstSeen,
        lastSeen:       w.lastSeen,
        matchedAsset:   w.matchedAsset
          ? {
              id:        w.matchedAsset.id,
              hostname:  w.matchedAsset.hostname,
              ipAddress: w.matchedAsset.ipAddress,
              assetType: w.matchedAsset.assetType,
            }
          : null,
      })),
      monitoredInterfaces:   (asset.monitoredInterfaces   ?? []) as string[],
      monitoredStorage:      (asset.monitoredStorage      ?? []) as string[],
      monitoredIpsecTunnels: (asset.monitoredIpsecTunnels ?? []) as string[],
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/processes — Processes tab: current-state process inventory
// (one row per program, aggregated by name) plus the operator's pin sets so the
// table can render the Monitor / Alert checkbox state without a second call.
// Ordered by summed CPU desc then name so the busiest programs surface first.
router.get("/:id/processes", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        monitoredProcesses: true, alertWatchedProcesses: true, mappedProcesses: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    const [rows, configs] = await Promise.all([
      prisma.assetProcess.findMany({
        where: { assetId: id },
        orderBy: [{ cpuPct: "desc" }, { name: "asc" }],
      }),
      prisma.assetProcessConfig.findMany({ where: { assetId: id } }),
    ]);
    // Per-program log config keyed by name, so the detail slide-in can pre-fill
    // the log-path field without a second call.
    const configsByName: Record<string, { logSource: string | null; logPathGlob: string | null; detectedUnit: string | null; notes: string | null }> = {};
    for (const c of configs) {
      configsByName[c.name] = { logSource: c.logSource, logPathGlob: c.logPathGlob, detectedUnit: c.detectedUnit, notes: c.notes };
    }
    res.json({
      processes: rows.map((p) => ({
        name:          p.name,
        instanceCount: p.instanceCount,
        cpuPct:        p.cpuPct,
        memRssBytes:   p.memRssBytes != null ? p.memRssBytes.toString() : null,
        exePath:       p.exePath,
        username:      p.username,
        startedAt:     p.startedAt,
        serviceUnit:   p.serviceUnit,
        controllable:  p.controllable,
      })),
      configs: configsByName,
      monitoredProcesses:    (asset.monitoredProcesses    ?? []) as string[],
      alertWatchedProcesses: (asset.alertWatchedProcesses ?? []) as string[],
      mappedProcesses:       (asset.mappedProcesses       ?? []) as string[],
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/services — current-state systemd unit / Windows service
// inventory for the Services tab. Mirrors /:id/processes: the current AssetService
// rows plus the two pin arrays (monitoredServices = journalctl tailing,
// mappedServices = Application Map connection attribution).
/**
 * GET /assets/:id/mac-table — the switch's layer-2 forwarding database.
 *
 * Current-state (delete-replaced per scrape), so there is no time window to
 * select. Returns the entries plus per-port MAC counts, which is the number
 * that separates an access port from an uplink and is far cheaper to compute
 * here than in the browser over a few thousand rows.
 */
router.get("/:id/mac-table", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const rows = await prisma.assetMacTableEntry.findMany({
      where: { assetId: id },
      orderBy: [{ ifName: "asc" }, { macAddress: "asc" }],
      include: {
        matchedAsset: { select: { id: true, hostname: true, ipAddress: true, assetType: true } },
      },
    });
    const portCounts: Record<string, number> = {};
    for (const r of rows) {
      if (r.status !== "learned" || !r.ifName) continue;
      portCounts[r.ifName] = (portCounts[r.ifName] ?? 0) + 1;
    }
    res.json({
      entries: rows.map((r) => ({
        macAddress: r.macAddress,
        vlanId:     r.vlanId,
        basePort:   r.basePort,
        ifName:     r.ifName,
        status:     r.status,
        firstSeen:  r.firstSeen,
        lastSeen:   r.lastSeen,
        matchedAsset: r.matchedAsset,
      })),
      portCounts,
      total: rows.length,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /assets/:id/arp-table — the FortiGate's layer-3 neighbour cache.
 *
 * Current-state (delete-replaced per discovery cycle), so there is no time
 * window to select. Returns the entries plus per-interface counts and the
 * single timestamp the whole table was collected at — the tab leads with that,
 * because an ARP cache is only meaningful next to its age.
 */
/**
 * The ARP Table tab's range selector. `current` is not a time window — it
 * means "whatever the last poll found", which is the newest lastSeen rather
 * than a fixed span, and is resolved client-side against `collectedAt`.
 */
const ARP_RANGE_SECONDS: Record<string, number | null> = {
  current: null,
  "1h":    60 * 60,
  "12h":   12 * 60 * 60,
  "24h":   24 * 60 * 60,
  "7d":    7 * 24 * 60 * 60,
  "30d":   30 * 24 * 60 * 60,
};

const ArpTableQuerySchema = z.object({
  range: z.enum(["current", "1h", "12h", "24h", "7d", "30d"]).optional().default("current"),
});

/**
 * How often THIS device's neighbour cache is actually refreshed, in seconds.
 *
 * Two cadences can write it and they differ by two orders of magnitude, so the
 * tab cannot state one number for the fleet: a monitored firewall refreshes on
 * the system-info pass (600 s by default), while an unmonitored one — or one
 * with system info off — only gets the rows discovery already reads on its
 * integration's pollInterval (12 h by default for both Fortinet types).
 *
 * Returns null when neither applies, which the tab renders as "on discovery
 * only" rather than inventing a figure.
 */
async function resolveArpPollIntervalSec(assetId: string): Promise<number | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true, assetType: true, monitored: true, status: true,
      discoveredByIntegrationId: true, monitorOverride: true,
      discoveredByIntegration: { select: { type: true, pollInterval: true } },
    },
  });
  if (!asset) return null;

  const discoverySec = asset.discoveredByIntegration?.pollInterval
    ? asset.discoveredByIntegration.pollInterval * 3600
    : null;
  // A device that isn't being polled can only be refreshed by discovery.
  if (!asset.monitored || asset.status === "decommissioned" || asset.status === "disabled") {
    return discoverySec;
  }
  try {
    const resolved = await resolveMonitorSettings({
      ...(asset as any),
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    } as any);
    const sec = (resolved as any)?.systemInfoIntervalSeconds;
    return typeof sec === "number" && sec > 0 ? sec : discoverySec;
  } catch {
    return discoverySec;
  }
}

router.get("/:id/arp-table", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const parsed = ArpTableQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, "Invalid range");
    const { range } = parsed.data;

    // Retention bounds what any range can actually reach, so it is reported
    // rather than assumed: offering "last 30 days" on an install that keeps 7
    // promises history that was pruned days ago.
    const retentionDays = await getArpEntryRetentionDays();
    const windowSec = ARP_RANGE_SECONDS[range];
    const since = windowSec == null ? null : new Date(Date.now() - windowSec * 1000);

    const rows = await prisma.assetArpEntry.findMany({
      where: { assetId: id, ...(since ? { lastSeen: { gte: since } } : {}) },
      // Final ordering is the browser's (numeric IP within interface); this
      // just keeps the payload stable.
      orderBy: [{ ifName: "asc" }, { ipAddress: "asc" }],
      include: {
        matchedAsset: { select: { id: true, hostname: true, ipAddress: true, assetType: true } },
      },
    });

    const interfaceCounts: Record<string, number> = {};
    let collectedAt: Date | null = null;
    for (const r of rows) {
      if (r.ifName) interfaceCounts[r.ifName] = (interfaceCounts[r.ifName] ?? 0) + 1;
      if (!collectedAt || r.lastSeen > collectedAt) collectedAt = r.lastSeen;
    }

    // How often this device's neighbour cache is actually refreshed. The tab
    // states it verbatim, because the poll interval is the whole reason a
    // short-lived entry can be missing and an operator has no other way to
    // know which cadence THIS device is on.
    const pollIntervalSec = await resolveArpPollIntervalSec(id);

    res.json({
      entries: rows.map((r) => ({
        ipAddress:  r.ipAddress,
        macAddress: r.macAddress,
        // "" is the storage sentinel for "the device attributed this to no
        // interface" (see the model comment); it never leaves the API as "".
        ifName:     r.ifName === "" ? null : r.ifName,
        ageSec:     r.ageSec,
        firstSeen:  r.firstSeen,
        lastSeen:   r.lastSeen,
        matchedAsset: r.matchedAsset,
      })),
      interfaceCounts,
      collectedAt,
      total: rows.length,
      range,
      retentionDays,
      pollIntervalSec,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/services", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        monitoredServices: true, mappedServices: true,
        // Presence of a ManagedAgent row is what makes per-unit socket
        // attribution possible — see `unitAttribution` below.
        managedAgent: { select: { id: true } },
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    const rows = await prisma.assetService.findMany({
      where: { assetId: id },
      orderBy: [{ unit: "asc" }],
    });
    res.json({
      services: rows.map((s) => ({
        unit:         s.unit,
        platform:     s.platform,
        displayName:  s.displayName,
        loadState:    s.loadState,
        activeState:  s.activeState,
        subState:     s.subState,
        enabledState: s.enabledState,
        mainPid:      s.mainPid,
        mainProcess:  s.mainProcess,
        memBytes:     s.memBytes != null ? s.memBytes.toString() : null,
        controllable: s.controllable,
      })),
      monitoredServices: (asset.monitoredServices ?? []) as string[],
      mappedServices:    (asset.mappedServices    ?? []) as string[],
      // Can a socket be attributed to a UNIT on this host? Only the Polaris
      // Agent resolves a PID's owning unit (cgroup on Linux, tasklist /svc on
      // Windows); the agentless SSH/WinRM processes cadence collects mapped
      // program names only and never stamps AssetProcessConnection.unit. Without
      // an agent, ticking Map on a service would silently collect nothing, so the
      // Services tab disables that checkbox and says why.
      unitAttribution: asset.managedAgent != null,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/process-connections?name=&unit= — Ports & Connections for the
// process detail slide-in AND the Services detail panel (Application Map data,
// per-asset view). Optional `name` filters to one process; optional `unit`
// (Phase 3) filters to one systemd unit / Windows service. Remote IPs are
// hydrated with the matched asset id + hostname via the bulk resolver.
router.get("/:id/process-connections", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const exists = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, "Asset not found");
    const name = typeof req.query.name === "string" && req.query.name ? req.query.name : undefined;
    const unit = typeof req.query.unit === "string" && req.query.unit ? req.query.unit : undefined;
    res.json(await getAssetProcessConnections(id, name, unit));
  } catch (err) { next(err); }
});

// GET /assets/:id/custom-widgets — Custom MIB tab data (Slice 7). Resolves
// the asset's manufacturer profile, filters widgets by optional modelPattern,
// and returns each widget's definition plus its latest sample (kind = "scalar"
// returns the most recent point; kind = "line" / "table" returns a window of
// recent samples that the gauge / chart / table renderer consumes directly).
// Empty array when the manufacturer has no widgets or the polling stream is
// resolved to "disabled" — the frontend hides the tab in that case.
router.get("/:id/custom-widgets", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where:  { id },
      select: {
        id: true, monitored: true, manufacturer: true, model: true,
        customWidgetPolling: true, lastCustomWidgetAt: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    // The DB-backed profile cache is keyed by canonical manufacturer.
    const { getProfileFor } = await import("../../services/manufacturerProfileService.js");
    const profile = getProfileFor(asset.manufacturer);
    if (!profile || profile.widgets.length === 0) {
      return res.json({
        manufacturer:    asset.manufacturer,
        profileId:       profile?.id ?? null,
        polling:         asset.customWidgetPolling ?? null,
        lastCustomWidgetAt: asset.lastCustomWidgetAt,
        widgets:         [],
      });
    }

    // Apply per-model gating. Empty modelPattern = applies to every asset
    // under the manufacturer; non-empty regex must match Asset.model.
    const modelStr = asset.model ?? "";
    const applicableWidgets = profile.widgets.filter((w) => {
      if (!w.modelPattern) return true;
      try { return new RegExp(w.modelPattern, "i").test(modelStr); }
      catch { return false; }
    });

    if (applicableWidgets.length === 0) {
      return res.json({
        manufacturer:    asset.manufacturer,
        profileId:       profile.id,
        polling:         asset.customWidgetPolling ?? null,
        lastCustomWidgetAt: asset.lastCustomWidgetAt,
        widgets:         [],
      });
    }

    // Bulk-fetch the last 60 samples per widget — line charts need a window;
    // gauges + tables grab the freshest. One query covering every applicable
    // widget id, then partition client-side.
    const ids = applicableWidgets.map((w) => w.id);
    const samples = await prisma.assetCustomWidgetSample.findMany({
      where: { assetId: id, widgetId: { in: ids } },
      orderBy: { timestamp: "desc" },
      take:    60 * ids.length,
      select:  { id: true, widgetId: true, timestamp: true, kind: true, value: true },
    });
    const byWidget = new Map<string, typeof samples>();
    for (const s of samples) {
      const arr = byWidget.get(s.widgetId) ?? [];
      if (arr.length < 60) arr.push(s);
      byWidget.set(s.widgetId, arr);
    }

    // State probes keep their 0/1 readings in asset_state_samples, one row per
    // probe row. The tab wants the CURRENT state of each row, so take the recent
    // rows newest-first and keep the first sighting of each (probeId, rowKey) —
    // one scrape writes a probe's whole row set at one timestamp, so the take cap
    // below covers several full snapshots even for a probe at the row cap.
    const stateProbeIds = applicableWidgets.filter((w) => w.widgetType === "state").map((w) => w.id);
    const latestState = new Map<string, Array<{ rowKey: string; rowLabel: string; value: number; rawValue: string | null; timestamp: Date }>>();
    if (stateProbeIds.length > 0) {
      const rows = await prisma.assetStateSample.findMany({
        where:   { assetId: id, probeId: { in: stateProbeIds } },
        orderBy: { timestamp: "desc" },
        take:    2000,
        select:  { probeId: true, rowKey: true, rowLabel: true, value: true, rawValue: true, timestamp: true },
      });
      const seen = new Set<string>();
      for (const r of rows) {
        const key = `${r.probeId}|${r.rowKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const arr = latestState.get(r.probeId) ?? [];
        arr.push({ rowKey: r.rowKey, rowLabel: r.rowLabel, value: r.value, rawValue: r.rawValue, timestamp: r.timestamp });
        latestState.set(r.probeId, arr);
      }
      // Problem rows first, then by name — an operator opening the tab is looking
      // for what's wrong, and a 60-row sensor table shouldn't need scanning.
      for (const [probeId, arr] of latestState) {
        const probe = applicableWidgets.find((w) => w.id === probeId);
        const trueIsProblem = probe?.stateMap?.trueIsProblem !== false;
        arr.sort((a, b) => {
          const pa = (a.value === 1) === trueIsProblem ? 0 : 1;
          const pb = (b.value === 1) === trueIsProblem ? 0 : 1;
          return pa - pb || a.rowLabel.localeCompare(b.rowLabel);
        });
      }
    }

    return res.json({
      manufacturer:    asset.manufacturer,
      profileId:       profile.id,
      polling:         asset.customWidgetPolling ?? null,
      lastCustomWidgetAt: asset.lastCustomWidgetAt,
      widgets: applicableWidgets.map((w) => {
        const window = byWidget.get(w.id) ?? [];
        // Reverse so caller gets oldest-first for charts.
        window.reverse();
        return {
          id:             w.id,
          name:           w.name,
          symbol:         w.symbol,
          mibId:          w.mibId,
          type:           w.type,
          widgetType:     w.widgetType,
          transform:      w.transform,
          displayOptions: w.displayOptions,
          order:          w.order,
          modelPattern:   w.modelPattern,
          samples:        window,
          latest:         window.length ? window[window.length - 1] : null,
          // State probes only: the mapping (for labels/colour) + current rows.
          stateMap:       w.stateMap,
          labelSymbol:    w.labelSymbol,
          stateRows:      w.widgetType === "state" ? (latestState.get(w.id) ?? []) : undefined,
        };
      }),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/interface-history?ifName=...&range=... — per-interface counters
router.get("/:id/interface-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const ifName = req.query.ifName ? String(req.query.ifName) : null;
    if (!ifName) throw new AppError(400, "ifName query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "interfaces", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    // Full system-info pass timestamp → the complete interface snapshot for
    // the aggregate-membership map (the fast cadence only writes pinned rows).
    const assetMeta = await prisma.asset.findUnique({
      where: { id },
      select: {
        lastSystemInfoAt: true,
        // Description-sync context: whether the originating integration syncs
        // interface comments to the device (drives the editor's badge copy).
        fortinetTopology: true,
        discoveredByIntegration: { select: { type: true, config: true } },
      },
    });

    // Samples come from the tier-aware reader. LLDP neighbors and the
    // operator-typed comment override are stream-independent — both fetch
    // in parallel against the asset directly, not against the rollup
    // tables. The reader's meta carries the discovered alias/description
    // from the latest sample inside the requested window so the slide-over
    // header reflects what was configured during that window; the
    // operator-typed override (Polaris-local) takes precedence for the
    // resolved `description` field shown in the UI.
    const [history, override, allNeighbors, inferredAll, interfaceMeta, outages] = await Promise.all([
      readInterfaceHistory(id, since, until, pick.tier, ifName, fetchSince),
      prisma.assetInterfaceOverride.findUnique({
        where: { assetId_ifName: { assetId: id, ifName } },
      }),
      // All real LLDP neighbors for the asset. We display only the rows on the
      // requested interface (filtered below), but the full set is needed for
      // dedupe: a row learned on an aggregate's member port must suppress an
      // inferred row emitted on the aggregate itself (FortiLink). Returned with
      // the matched-asset cross-link so the slide-over can surface a "Go to
      // <hostname>" button. Usually a handful of rows at branch-class sizes.
      prisma.assetLldpNeighbor.findMany({
        where: { assetId: id },
        orderBy: [{ localIfName: "asc" }, { systemName: "asc" }],
        include: {
          matchedAsset: {
            select: { id: true, hostname: true, ipAddress: true, assetType: true },
          },
        },
      }),
      // Peer-inferred neighbors for the whole asset, filtered to this
      // interface below. Cheap enough at branch-class fleet sizes that
      // a per-interface query isn't worth the extra surface area on the
      // service.
      buildInferredNeighborsForAsset(id),
      // Interface metadata (ifType/ifParent) → aggregate membership map for the
      // inferred-on-aggregate dedupe. Current-state, so this is a plain indexed
      // read with no snapshot-timestamp gate. It is also strictly MORE correct
      // than the sample-table version: the fast pinned re-walk writes
      // ifType/ifParent as NULL, so on a pinned aggregate the newest sample row
      // carried nulls and the membership map silently lost that aggregate.
      prisma.assetInterface.findMany({
        where: { assetId: id },
        select: { ifName: true, ifType: true, ifParent: true },
      }),
      // Response-time failures over the same window — the interface counters
      // carry no success flag of their own and the cadence doesn't run while
      // the asset is down, so this is what tells the chart where to dive. See
      // the note on telemetry-history.
      readProbeOutages(id, since, until),
    ]);
    const neighbors = allNeighbors.filter((n) => n.localIfName === ifName);
    const inferredForIf = inferredAll.filter((n) => n.localIfName === ifName);
    const mergedNeighbors = [
      ...neighbors,
      ...dedupeInferredNeighbors(allNeighbors, inferredForIf, aggregateMembershipMap(interfaceMeta)),
    ];
    const overrideDescription = override?.description ?? null;
    // Interface comments sync to the device only when the originating
    // integration's syncDescriptions toggle is on AND the asset is a synced
    // Fortinet role (FortiGate interface / FortiSwitch port — FortiAPs have
    // no per-interface description).
    const dsIntegration = assetMeta?.discoveredByIntegration ?? null;
    const dsRole = ((assetMeta?.fortinetTopology ?? {}) as { role?: string }).role;
    const descriptionSyncEnabled =
      (isFortinetIntegrationType(dsIntegration?.type)) &&
      (dsIntegration?.config as { syncDescriptions?: boolean } | null)?.syncDescriptions === true &&
      (dsRole === "fortigate" || dsRole === "fortiswitch");
    res.json({
      range: rangeLabel,
      ifName,
      alias:       history.meta.alias,
      description: overrideDescription ?? history.meta.discoveredDescription,
      discoveredDescription: history.meta.discoveredDescription,
      overrideDescription,
      descriptionSync: {
        enabled: descriptionSyncEnabled,
        status: override?.syncStatus ?? null,
        lastSyncAt: override?.lastSyncAt ?? null,
        error: override?.syncError ?? null,
      },
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: history.samples,
      outages: serializeOutages(outages),
      lldpNeighbors: mergedNeighbors.map((n) => ({
        chassisIdSubtype:  n.chassisIdSubtype,
        chassisId:         n.chassisId,
        portIdSubtype:     n.portIdSubtype,
        portId:            n.portId,
        portDescription:   n.portDescription,
        systemName:        n.systemName,
        systemDescription: n.systemDescription,
        managementIp:      n.managementIp,
        capabilities:      n.capabilities,
        source:            n.source,
        firstSeen:         n.firstSeen,
        lastSeen:          n.lastSeen,
        matchedAsset:      n.matchedAsset
          ? {
              id:        n.matchedAsset.id,
              hostname:  n.matchedAsset.hostname,
              ipAddress: n.matchedAsset.ipAddress,
              assetType: n.matchedAsset.assetType,
            }
          : null,
      })),
    });
  } catch (err) { next(err); }
});

// PUT /assets/:id/interfaces/:ifName/comment — operator-typed override for the
// interface's "Interface Comments" text box. Polaris-local by default; when
// the originating integration's `syncDescriptions` toggle is on, a saved
// comment is also pushed to the device (Polaris-primary — see
// descriptionSyncService). Empty string or null clears the override locally
// only (the device keeps its description; the discovered FortiOS CMDB
// description shows through again).
const InterfaceCommentSchema = z.object({
  description: z.string().max(255, "Interface Comments may be at most 255 characters").nullable().optional(),
});
router.put("/:id/interfaces/:ifName/comment", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const ifName = String(req.params.ifName || "");
    if (!ifName) throw new AppError(400, "ifName path parameter is required");

    const parsed = InterfaceCommentSchema.parse(req.body || {});
    const raw = parsed.description == null ? "" : String(parsed.description);
    const trimmed = raw.trim();
    const actor = requestActor(req);

    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, ipAddress: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    if (trimmed.length === 0) {
      // Clear override — fall back to discovered description
      await prisma.assetInterfaceOverride.deleteMany({ where: { assetId: id, ifName } });
    } else {
      await prisma.assetInterfaceOverride.upsert({
        where: { assetId_ifName: { assetId: id, ifName } },
        create: { assetId: id, ifName, description: trimmed, updatedBy: actor },
        update: { description: trimmed, updatedBy: actor },
      });
    }

    logEvent({
      action: "asset.interface.comment_updated",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor,
      level: "info",
      message: trimmed.length === 0
        ? `Cleared interface comment override on ${asset.hostname || asset.ipAddress || id} / ${ifName}`
        : `Updated interface comment override on ${asset.hostname || asset.ipAddress || id} / ${ifName}`,
      details: { ifName, length: trimmed.length },
    });

    // Description sync (Polaris-primary): mirror the saved comment to the
    // device when the originating integration opted in. No-op (attempted:
    // false) when the toggle is off / asset isn't a synced Fortinet role /
    // the override was cleared. Best-effort — the override row above is
    // already persisted either way; a failed push surfaces via `sync`.
    const sync = trimmed.length > 0
      ? await syncDescriptionsOnSave({ assetId: id, scope: "interface", ifName, actor })
      : { attempted: false as const };

    res.json({ ok: true, ifName, description: trimmed.length === 0 ? null : trimmed, sync });
  } catch (err) { next(err); }
});

// GET /assets/:id/hardware-history?range=... [&sensorName=...] — per-sensor hardware readings
router.get("/:id/hardware-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const sensorName = req.query.sensorName ? String(req.query.sensorName) : null;
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "hardware", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readHardwareSensorHistory(id, since, until, pick.tier, sensorName, fetchSince);
    res.json({
      range: rangeLabel,
      sensorName,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      stats: result.stats,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/ipsec-history?tunnelName=...&range=... — per-tunnel state + bytes
router.get("/:id/ipsec-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const tunnelName = req.query.tunnelName ? String(req.query.tunnelName) : null;
    if (!tunnelName) throw new AppError(400, "tunnelName query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "ipsec", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readIpsecHistory(id, since, until, pick.tier, tunnelName, fetchSince);
    res.json({
      range: rangeLabel,
      tunnelName,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/perf-sla-links — distinct (healthCheck, link) pairs seen in
// the perf-SLA detail window. Doubles as the "does SD-WAN data exist?" gate for
// the asset modal's SD-WAN tab and the source for its health-check/link selector.
router.get("/:id/perf-sla-links", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    // Latest sample per (healthCheck, link) so the SLA thresholds reflect the
    // current health-check config. DISTINCT ON keeps the newest row per pair.
    const rows = await prisma.$queryRawUnsafe<Array<{
      healthCheck: string; link: string;
      latencyThresholdMs: number | null; jitterThresholdMs: number | null; packetLossThreshold: number | null;
    }>>(
      `SELECT DISTINCT ON ("healthCheck", "link")
              "healthCheck", "link",
              "latencyThresholdMs", "jitterThresholdMs", "packetLossThreshold"
       FROM "asset_perf_sla_samples"
       WHERE "assetId" = $1
       ORDER BY "healthCheck" ASC, "link" ASC, "timestamp" DESC`,
      id,
    );
    res.json({ links: rows });
  } catch (err) { next(err); }
});

// GET /assets/:id/sdwan-members — per-WAN-member health summary (status, per
// health-check latency/jitter/loss, recent status strip, + IP/link/bytes from
// the latest interface sample). Drives the "SD-WAN Members" table.
router.get("/:id/sdwan-members", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const result = await readSdwanMembers(id);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /assets/:id/perf-sla-history?healthCheck=...&link=...&range=... — per-member
// latency/jitter/packet-loss gauges over time.
router.get("/:id/perf-sla-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const healthCheck = req.query.healthCheck ? String(req.query.healthCheck) : null;
    const link = req.query.link ? String(req.query.link) : null;
    if (!healthCheck) throw new AppError(400, "healthCheck query parameter is required");
    if (!link) throw new AppError(400, "link query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "perfSla", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readPerfSlaHistory(id, since, until, pick.tier, healthCheck, link, fetchSince);
    res.json({
      range: rangeLabel,
      healthCheck,
      link,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/sdwan-rules — current-state SD-WAN service rules (one row per
// rule, replaced per scrape by persistSdwanRules). The SD-WAN tab table + the
// "data exists?" gate. Ordered by the rule's FortiOS sequence (priority) so the
// table matches the device GUI ordering. No history — SD-WAN rules are
// current-state (only the SLA-metrics stream is a time-series).
router.get("/:id/sdwan-rules", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const rows = await prisma.assetSdwanRule.findMany({
      where: { assetId: id },
      orderBy: [{ seq: "asc" }, { ruleName: "asc" }],
      select: {
        ruleName: true, ruleId: true, seq: true, enabled: true, mode: true,
        criteria: true, healthChecks: true, dst: true, status: true,
        selectedMember: true, availableMembers: true, priorityZones: true,
      },
    });
    res.json({ rules: rows });
  } catch (err) { next(err); }
});

// GET /assets/:id/mclag-peers — current-state MCLAG ICL peers (one row per
// local ICL port, replaced per scrape by persistMclagPeers). FortiSwitch only;
// empty for switches not in an MCLAG pair. `matchedAsset` resolves the peer
// switch (by serial) for a clickable link in the asset detail / topology.
router.get("/:id/mclag-peers", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const rows = await prisma.assetMclagPeer.findMany({
      where: { assetId: id },
      orderBy: [{ localPort: "asc" }],
      select: {
        localPort: true, iclTrunk: true, peerSn: true, peerName: true, peerPort: true,
        matchedAsset: { select: { id: true, hostname: true } },
      },
    });
    res.json({ peers: rows });
  } catch (err) { next(err); }
});

// GET /assets/:id/upstream — the three upstream devices the General tab names
// (Last Seen Switch / AP / Firewall) resolved from display strings to the Asset
// rows behind them, so those rows can carry verbs (open the device, open its
// HTTPS UI, SSH to it) instead of being text an operator re-finds by hand.
//
// Resolution rides utils/fortinetParentKey.ts — never a hostname match (see
// assetUpstreamService). An unresolved name comes back with `asset: null` and
// is NOT an error: an unadopted switch and a gate another integration hasn't
// discovered yet both land there legitimately.
//
// The firewall half reads AssetFortigateSighting, which its own endpoint gates
// `assetsQuarantine:read` — so it is gated a second time here and the answer
// says which halves were consulted (`visibility`), the /ip-context precedent.
router.get("/:id/upstream", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const result = await resolveAssetUpstream(id, {
      includeFirewall: hasPermission(req, "assetsQuarantine", "read"),
    });
    if (!result) throw new AppError(404, "Asset not found");
    res.json(result);
  } catch (err) { next(err); }
});

// GET /assets/:id/virtualization — current-state vCenter facts for the
// asset-details Virtualization section. Assembled per role from the
// Asset.virtualization blob (single writer: syncVcenterDevices):
//   - VM:   the blob + the running host's asset link (clickable) + cluster
//           sibling hosts + per-disk datastore/backing labels.
//   - Host: the blob + mounted datastores (from the current-state
//           VcenterDatastore table) + the VMs currently placed on it.
// 404s stay reserved for a missing asset; an asset with no virtualization
// data returns { virtualization: null } so the UI can skip the section.
router.get("/:id/virtualization", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, virtualization: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    const v = asset.virtualization as Record<string, any> | null;
    if (!v || (v.role !== "vm" && v.role !== "host")) {
      res.json({ virtualization: null });
      return;
    }
    const integrationId = typeof v.vcenterIntegrationId === "string" ? v.vcenterIntegrationId : null;
    const bigintToString = (x: bigint | null): string | null => (x === null ? null : x.toString());

    if (v.role === "vm") {
      // Running host link (hostAssetId is re-resolved every discovery cycle).
      const hostAsset = typeof v.hostAssetId === "string" && v.hostAssetId
        ? await prisma.asset.findUnique({
            where: { id: v.hostAssetId },
            select: { id: true, hostname: true, monitorStatus: true, monitored: true },
          })
        : null;
      // Datastore names + backing labels for the disks table.
      const dsMorefs = [...new Set(
        (Array.isArray(v.disks) ? v.disks : [])
          .map((d: any) => (typeof d?.datastoreMoref === "string" ? d.datastoreMoref : null))
          .filter((m: string | null): m is string => !!m),
      )];
      const datastores = integrationId && dsMorefs.length > 0
        ? await prisma.vcenterDatastore.findMany({
            where: { integrationId, moref: { in: dsMorefs } },
            select: { moref: true, name: true, dsType: true, backingLabel: true },
          })
        : [];
      res.json({
        virtualization: v,
        hostAsset,
        diskDatastores: datastores,
      });
      return;
    }

    // role === "host"
    const hostMoref = typeof v.hostMoref === "string" ? v.hostMoref : null;
    const datastores = integrationId && hostMoref
      ? await prisma.vcenterDatastore.findMany({
          where: { integrationId, hostMorefs: { has: hostMoref } },
          orderBy: { name: "asc" },
        })
      : [];
    // VMs currently placed on this host — their virtualization blobs carry
    // hostAssetId (re-stamped every cycle), which indexes cheaper than a
    // JSON-path filter on hostMoref.
    const vms = await prisma.asset.findMany({
      where: {
        virtualization: { path: ["hostAssetId"], equals: id },
      },
      select: { id: true, hostname: true, monitorStatus: true, monitored: true, virtualization: true },
      take: 500,
    });
    res.json({
      virtualization: v,
      datastores: datastores.map((d) => ({
        moref: d.moref,
        name: d.name,
        dsType: d.dsType,
        capacityBytes: bigintToString(d.capacityBytes),
        freeBytes: bigintToString(d.freeBytes),
        provisionedBytes: bigintToString(d.provisionedBytes),
        accessible: d.accessible,
        backingLabel: d.backingLabel,
        backing: d.backing,
      })),
      vms: vms.map((vm) => ({
        id: vm.id,
        hostname: vm.hostname,
        monitorStatus: vm.monitorStatus,
        monitored: vm.monitored,
        powerState: (vm.virtualization as Record<string, any> | null)?.powerState ?? null,
      })),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/storage-history?mountPath=...&range=... — per-mountpoint usage
router.get("/:id/storage-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const mountPath = req.query.mountPath ? String(req.query.mountPath) : null;
    if (!mountPath) throw new AppError(400, "mountPath query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "storage", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    // See the note on telemetry-history: the storage cadence is skipped while
    // the asset is down, so the probe stream is what knows an outage happened.
    // This is also what lets storage be treated like every other stream — a
    // mount that is simply unmounted on a HEALTHY device sits inside no outage
    // window and draws no dive, which is the distinction the old gap heuristic
    // could not make.
    const [result, outages] = await Promise.all([
      readStorageHistory(id, since, until, pick.tier, mountPath, fetchSince),
      readProbeOutages(id, since, until),
    ]);
    res.json({
      range: rangeLabel,
      mountPath,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      outages: serializeOutages(outages),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/process-history?name=...&range=... — per-pinned-program
// CPU/RAM history, tier-routed (detail → hourly → daily) by the requested range.
router.get("/:id/process-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const name = req.query.name ? String(req.query.name) : null;
    if (!name) throw new AppError(400, "name query parameter is required");
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "process", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    const result = await readProcessHistory(id, since, until, pick.tier, name, fetchSince);
    res.json({
      range: rangeLabel,
      name,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/process-logs?name=...&since=...&limit=... — recent log lines
// for a pinned program (detail-only table, newest-first, capped).
router.get("/:id/process-logs", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const name = req.query.name ? String(req.query.name) : null;
    if (!name) throw new AppError(400, "name query parameter is required");
    const limit = Math.min(2000, Math.max(1, parseInt(String(req.query.limit ?? "500"), 10) || 500));
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const onlyFlagged = String(req.query.flagged ?? "") === "1";
    const rows = await prisma.assetProcessLogSample.findMany({
      where: { assetId: id, name, ...(since && !isNaN(since.getTime()) ? { timestamp: { gte: since } } : {}) },
      orderBy: { timestamp: "desc" },
      take: limit,
    });
    // Annotate each line with the operator-defined flag rules it matches
    // (read-time eval — see logFlagRuleService). ?flagged=1 returns only matches.
    const logs = await evaluateLogFlags(
      id,
      name,
      rows.map((r) => ({ timestamp: r.timestamp, level: r.level, message: r.message, source: r.source })),
      onlyFlagged,
    );
    res.json({ name, logs });
  } catch (err) { next(err); }
});

// GET /assets/:id/service-logs?unit=...&since=...&limit=...&flagged=1 — recent
// journalctl lines for a pinned unit (standalone table, newest-first, capped).
// Global/asset-scoped LogFlagRules apply (the unit is passed as the eval's
// process key, so a process-scoped rule named after the unit also matches).
router.get("/:id/service-logs", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const unit = req.query.unit ? String(req.query.unit) : null;
    if (!unit) throw new AppError(400, "unit query parameter is required");
    const limit = Math.min(2000, Math.max(1, parseInt(String(req.query.limit ?? "500"), 10) || 500));
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const onlyFlagged = String(req.query.flagged ?? "") === "1";
    const rows = await prisma.assetServiceLogSample.findMany({
      where: { assetId: id, unit, ...(since && !isNaN(since.getTime()) ? { timestamp: { gte: since } } : {}) },
      orderBy: { timestamp: "desc" },
      take: limit,
    });
    const logs = await evaluateLogFlags(
      id,
      unit,
      rows.map((r) => ({ timestamp: r.timestamp, level: r.level, message: r.message, source: r.source })),
      onlyFlagged,
    );
    res.json({ unit, logs });
  } catch (err) { next(err); }
});

// PUT /assets/:id/processes/:name/config — operator log-path config for a
// pinned program (log source + wildcard glob). Upserts AssetProcessConfig.
router.put("/:id/processes/:name/config", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const name = String(req.params.name);
    const body = ProcessConfigSchema.parse(req.body);
    const updated = await prisma.assetProcessConfig.upsert({
      where:  { assetId_name: { assetId: id, name } },
      update: { logSource: body.logSource, logPathGlob: body.logPathGlob ?? null, notes: body.notes ?? null, updatedBy: requestActor(req) ?? null },
      create: { assetId: id, name, logSource: body.logSource ?? "auto", logPathGlob: body.logPathGlob ?? null, notes: body.notes ?? null, updatedBy: requestActor(req) ?? null },
    });
    logEvent({
      action: "asset.process.log_config_set",
      resourceType: "asset",
      resourceId: id,
      actor: requestActor(req),
      message: `Log config set for process "${name}"`,
      details: { name, logSource: updated.logSource, logPathGlob: updated.logPathGlob },
    });
    res.json({ config: { name: updated.name, logSource: updated.logSource, logPathGlob: updated.logPathGlob, detectedUnit: updated.detectedUnit, notes: updated.notes } });
  } catch (err) { next(err); }
});

// NOTE: process/service start/stop/restart control was removed (Satellite-posture
// change). The former POST /:id/processes/:name/control, POST /:id/services/:unit/
// control, and GET /:id/process-command/:commandId routes no longer exist; the
// agent no longer accepts control actions. Automation script runs stay (they ride
// the AgentCommand queue with action="run_script").

// POST /api/v1/assets — create (assets admin)
router.post("/", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const input = CreateAssetSchema.parse(req.body);
    const coordErr = manualCoordPatchError(input.latitude, input.longitude);
    if (coordErr) throw new AppError(400, coordErr);
    const data: Record<string, unknown> = { ...input };
    if (input.macAddress) data.macAddress = input.macAddress.toUpperCase().replace(/-/g, ":");
    // Description: empty string clears to null (an empty Polaris description
    // is re-seeded from the device on the next discovery when the
    // integration's syncDescriptions toggle is on).
    if (typeof input.description === "string") data.description = input.description.trim() || null;
    // Hostname: trim; an empty box means "not provided", not "" (the edit
    // form now always sends the field, including blank).
    if (typeof input.hostname === "string") data.hostname = input.hostname.trim() || null;
    if (input.acquiredAt) data.acquiredAt = new Date(input.acquiredAt);
    if (input.warrantyExpiry) data.warrantyExpiry = new Date(input.warrantyExpiry);
    if (input.ipAddress) data.ipSource = "manual";
    if (typeof input.latitude === "number") data.coordSource = "manual";
    // Always stamp status tracking on creation (status is always set here)
    data.statusChangedAt = new Date();
    data.statusChangedBy = requestActor(req) ?? "manual";
    data.createdBy = requestActor(req) ?? null;
    clampAcquiredToLastSeen(data);
    const asset = await prisma.asset.create({ data: data as any });
    logEvent({ action: "asset.created", resourceType: "asset", resourceId: asset.id, resourceName: input.hostname || input.ipAddress, actor: requestActor(req), message: `Asset "${input.hostname || input.ipAddress || "unknown"}" created` });
    // Apply any criteria-based auto-tags to the new asset (best-effort).
    reconcileTagsForAsset(asset.id).catch(() => {});
    // Manual coords on a firewall may move it into/out of a map region —
    // refresh membership now instead of waiting for the periodic job.
    if (asset.assetType === "firewall" && typeof input.latitude === "number") {
      reconcileMapRegions().catch(() => {});
    }
    res.status(201).json(asset);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/assets/:id — update (assets admin)
// ─── PUT /:id phases (split 2026-08 — the contract tests in
// tests/integration/assetPutContract.test.ts pin the guards, the pin/override
// semantics, the status stamps, and the unmap side effect). requestActor is
// resolved once in the handler and threaded down.

type UpdateAssetInput = z.infer<typeof UpdateAssetSchema>;

async function loadAssetForUpdate(id: string) {
  return prisma.asset.findUnique({
    where:   { id },
    include: { discoveredByIntegration: { select: { type: true } } },
  });
}
type ExistingAssetForUpdate = NonNullable<Awaited<ReturnType<typeof loadAssetForUpdate>>>;

// Phase 1 — request-level guards that must 400 before anything is staged.
async function validateAssetUpdate(id: string, existing: ExistingAssetForUpdate, input: UpdateAssetInput): Promise<void> {
  // Per-asset polling overrides must be valid for the asset's source kind.
  // Falling through silently at the resolver would leave the operator
  // confused about why their selection didn't take.
  {
    const sourceKind = assetSourceKindFromIntegrationType(existing.discoveredByIntegration?.type ?? null);
    const fields: Array<["responseTimePolling" | "cpuMemoryPolling" | "temperaturePolling" | "interfacesPolling" | "lldpPolling" | "storagePolling", PollingMethod | null | undefined]> = [
      ["responseTimePolling", input.responseTimePolling],
      ["cpuMemoryPolling",    input.cpuMemoryPolling],
      ["temperaturePolling",  input.temperaturePolling],
      ["interfacesPolling",   input.interfacesPolling],
      ["lldpPolling",         input.lldpPolling],
      ["storagePolling",      input.storagePolling],
    ];
    for (const [name, value] of fields) {
      if (!value) continue;
      if (!isPollingMethodCompatible(sourceKind, value)) {
        throw new AppError(
          400,
          `${pollingMethodLabel(value)} polling is not supported for ${sourceKind} assets (field: ${name})`,
        );
      }
      // "vcenter" reads the vCenter server's batched per-integration fetch, so
      // it covers only the streams that fetch can answer (VCENTER_STREAMS:
      // responseTime / cpuMemory / interfaces / storage) AND requires a vCenter
      // AssetSource to resolve the integration through. The matrix allows the
      // method on the directory source kinds (merged VMs); this is the precise
      // check.
      // NOTE: the "http" polling method was retired (2026-08) — the HTTP check
      // it performed is now a manufacturer custom widget, so there is no
      // per-stream guard for it here any more. The schema enum rejects the
      // value outright.
      if (value === "vcenter") {
        const stream = name.replace(/Polling$/, "") as Stream;
        if (!isMethodValidForStream(stream, "vcenter")) {
          throw new AppError(400, `vCenter polling does not apply to the ${stream} stream (field: ${name})`);
        }
        // Either role: a VM's stats come from the VirtualMachine fetch, an ESXi
        // host's from the HostSystem fetch. Both resolve the integration the
        // same way.
        const vcSource = await prisma.assetSource.findFirst({
          where: { assetId: id, sourceKind: { in: ["vcenter-vm", "vcenter-host"] } },
          select: { id: true },
        });
        if (!vcSource) {
          throw new AppError(400, "vCenter polling requires this asset to be a vCenter-discovered VM or ESXi host (no vCenter source on file)");
        }
      }
      // "fortimanager" reads FMG's own device roster — reachability and nothing
      // else — so it covers response time only, and needs an actual
      // FortiManager to ask. The source-kind check above already rejects it on
      // a standalone FortiGate; this catches the stream half, plus the asset
      // having a serial to join the roster on (the probe identifies a chassis
      // by serial, never by name).
      if (value === "fortimanager") {
        const stream = name.replace(/Polling$/, "") as Stream;
        if (!isMethodValidForStream(stream, "fortimanager")) {
          throw new AppError(
            400,
            `FortiManager polling only applies to the response-time stream — FortiManager's database carries reachability, not metrics (field: ${name})`,
          );
        }
        if (!existing.serialNumber) {
          throw new AppError(400, "FortiManager polling identifies the device by serial number, and this asset has none recorded");
        }
      }
      const stream = name.replace(/Polling$/, "") as Stream;
      // ICMP carries no payload, so it can only answer a response-time probe.
      // The integration-tier and class-override validators have always refused
      // this; the per-asset path never did, so `PUT /assets/:id` accepted it,
      // the resolver adopted it, and the stream then fell into its
      // `{supported:false}` branch forever.
      if (value === "icmp" && stream !== "responseTime") {
        throw new AppError(400, `ICMP polling is only valid for the response-time stream (field: ${name})`);
      }
      // Warn — don't refuse — when no collector exists. Refusing would break an
      // operator merely re-saving an asset that already holds the value.
      const cap = collectorCapability(sourceKind, stream, value, { assetType: existing.assetType });
      if (!cap.implemented) {
        logger.warn(
          { assetId: id, sourceKind, stream, method: value, reason: cap.reason },
          `Asset update accepted a polling method with no collector — this stream will silently collect nothing: ${cap.reason}`,
        );
      }
    }
  }
  // Lock assetType on Fortinet infrastructure discovered via an integration.
  // The next discovery cycle would re-stamp the asset anyway, so accepting
  // the change just to revert it is misleading.
  if (
    input.assetType !== undefined &&
    input.assetType !== existing.assetType &&
    existing.discoveredByIntegrationId &&
    (existing.assetType === "firewall" || existing.assetType === "switch" || existing.assetType === "access_point")
  ) {
    throw new AppError(400, `Asset type is locked — discovered as ${existing.assetType} by an integration`);
  }
  // Quarantine status is owned by the dedicated quarantine endpoints —
  // setting it via the generic asset PUT would skip the FortiGate push
  // (or skip the device-side unpush on release), creating divergence
  // between Polaris's view and the FortiGate's enforcement state.
  if (input.status === "quarantined" && existing.status !== "quarantined") {
    throw new AppError(400, "Use POST /assets/:id/quarantine to quarantine an asset");
  }
  if (input.status !== undefined && input.status !== "quarantined" && existing.status === "quarantined") {
    throw new AppError(400, "Use DELETE /assets/:id/quarantine to release the quarantine before changing status");
  }
  const coordErr = manualCoordPatchError(input.latitude, input.longitude);
  if (coordErr) throw new AppError(400, coordErr);
}

// Phase 2 — stage the update patch: field normalization, the hostname/IP
// operator pins (set / echo / clear semantics), date coercion, the manual-
// coordinate pin, status stamps (+ the operator-wins maintenance release),
// and the monitored/acquiredAt clamps. Returns the patch plus the flags the
// post-write side effects branch on.
async function buildAssetUpdatePatch(
  id: string,
  existing: ExistingAssetForUpdate,
  input: UpdateAssetInput,
  actor: string | undefined,
): Promise<{ data: Record<string, unknown>; ipOverrideTouched: boolean; coordChanged: boolean }> {
  const data: Record<string, unknown> = { ...input };
  if (input.macAddress) data.macAddress = input.macAddress.toUpperCase().replace(/-/g, ":");
  // Description: empty string clears to null (an empty Polaris description
  // is re-seeded from the device on the next discovery when the
  // integration's syncDescriptions toggle is on).
  if (typeof input.description === "string") data.description = input.description.trim() || null;
  // Notes: empty string clears to null (notes are operator-only — an
  // emptied box is an intentional clear, not "not provided").
  if (typeof input.notes === "string") data.notes = input.notes.trim() || null;
  // HTTP-check path override: empty string clears to null. Stored null rather
  // than "" so "no override" has one representation in the column — the probe's
  // resolveHttpTarget treats both as absent, but a column carrying "" would
  // read as a configured value in exports and the edit form alike.
  if (typeof input.httpCheckPath === "string") data.httpCheckPath = input.httpCheckPath.trim() || null;
  // Discovery projection (lazy, computed at most once) — needed when a
  // pin-clear reverts hostname or ipAddress to the projected value.
  let _projection: ReturnType<typeof projectAssetFromSources> | null = null;
  const loadProjection = async () => {
    if (!_projection) {
      const overrideSources = await prisma.assetSource.findMany({
        where: { assetId: id },
        select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
      });
      _projection = projectAssetFromSources(
        overrideSources.map((s) => ({
          sourceKind: s.sourceKind,
          inferred: s.inferred,
          observed: s.observed as Record<string, unknown> | null,
          lastSeen: s.lastSeen,
        })),
      );
    }
    return _projection;
  };
  // Hostname: an edit-time write is an operator override (coordSource-style
  // pin — the db.ts extension re-asserts it over discovery projection
  // writes). Only a real change pins, since the edit form echoes the
  // current hostname back on every save. Clearing (empty string) releases
  // the pin and reverts hostname to the discovery-projected value (null
  // when no source has an opinion, e.g. manually-created assets).
  if (input.hostname !== undefined) {
    const trimmed = input.hostname.trim();
    if (!trimmed) {
      data.hostnameOverride = null;
      data.hostname = (await loadProjection()).projected.hostname;
    } else if (trimmed !== existing.hostname) {
      data.hostname = trimmed;
      data.hostnameOverride = trimmed;
    } else {
      delete data.hostname;
    }
  }
  // IP Address: same operator-override pattern as Hostname, with
  // discovery-gets-a-vote semantics on later writes (see Asset.ipOverride
  // in schema.prisma: discovery reporting the pinned IP releases the pin;
  // a different IP re-asserts it and raises an ip-override Conflict).
  // Only a real change pins; clearing (empty string) releases the pin and
  // reverts to the discovery-projected address. Any set/clear here also
  // closes the asset's pending ip-override conflict — the operator just
  // made the call the conflict was asking about.
  let ipOverrideTouched = false;
  if (input.ipAddress !== undefined) {
    const trimmed = input.ipAddress.trim();
    if (!trimmed) {
      data.ipOverride = null;
      const { projected, provenance } = await loadProjection();
      data.ipAddress = projected.ipAddress;
      data.ipSource = projected.ipAddress ? (provenance.ipAddress ?? "discovery") : null;
      ipOverrideTouched = !!existing.ipOverride;
    } else if (trimmed !== existing.ipAddress) {
      data.ipAddress = trimmed;
      data.ipOverride = trimmed;
      data.ipSource = "manual";
      ipOverrideTouched = true;
    } else {
      delete data.ipAddress;
    }
  }
  if (input.acquiredAt) data.acquiredAt = new Date(input.acquiredAt);
  else if (input.acquiredAt === undefined) delete data.acquiredAt;
  if (input.warrantyExpiry) data.warrantyExpiry = new Date(input.warrantyExpiry);
  else if (input.warrantyExpiry === undefined) delete data.warrantyExpiry;
  // Manual coordinates: only a real change stamps coordSource — the edit
  // form echoes the current values back on every save, and silently pinning
  // discovery-stamped coords as "manual" would freeze discovery updates for
  // the asset. Clearing (null pair) releases the pin so discovery may
  // repopulate on its next cycle.
  let coordChanged = false;
  if (input.latitude !== undefined) {
    coordChanged = input.latitude !== existing.latitude || input.longitude !== existing.longitude;
    if (coordChanged) {
      data.coordSource = input.latitude === null ? null : "manual";
    } else {
      delete data.latitude;
      delete data.longitude;
    }
  }
  if (input.status !== undefined) {
    data.statusChangedAt = new Date();
    data.statusChangedBy = actor ?? "manual";
  }
  // Operator moves status OFF "maintenance" while maintenance windows are
  // open: the operator wins. Close the windows first (endReason "operator"
  // — suppresses scheduler re-entry for each schedule's current occurrence)
  // so the reconcile can't re-flip this write.
  if (
    input.status !== undefined &&
    input.status !== "maintenance" &&
    existing.status === "maintenance"
  ) {
    await operatorReleaseAsset(id, actor);
  }
  // Effective status after this write — the edit form can flip status and
  // monitoring in the same save, and it's the RESULT that has to be legal.
  assertMonitorableStatus(data.monitored, input.status ?? existing.status);
  clampMonitoredState(data);
  clampAcquiredToLastSeen(data, existing);
  return { data, ipOverrideTouched, coordChanged };
}

// Phase 3 — post-write side effects: monitor-override recompute, the
// unmap-deletes-connections cleanups, pin-flip auto-rule bookkeeping,
// pending ip-override conflict resolution, the audit Event, description
// sync, tag reconcile, and the map-region refresh.
async function applyAssetUpdateSideEffects(
  id: string,
  existing: ExistingAssetForUpdate,
  asset: Awaited<ReturnType<typeof prisma.asset.update>>,
  input: UpdateAssetInput,
  actor: string | undefined,
  flags: { ipOverrideTouched: boolean; coordChanged: boolean },
): Promise<void> {
  // When the operator's `monitored` choice changes (or assetType changes,
  // which moves the asset into a different per-class block), recompute
  // monitorOverride against the discovering integration's addAsMonitored.
  // A single SQL UPDATE handles the JSON-path lookup in one round-trip.
  if (input.monitored !== undefined || input.assetType !== undefined) {
    await recomputeMonitorOverrideForAssets(prisma, [id]);
  }
  // An operator decommissioning a managed FortiSwitch/FortiAP gives its address
  // back, same as the discovery-side sweeps do. Scoped to the two infra types on
  // purpose: a server carrying an operator-pushed reservation is not something a
  // status change should quietly unpush. Post-write so it reads the row's
  // committed state; never throws.
  if (
    input.status === "decommissioned" &&
    existing.status !== "decommissioned" &&
    (asset.assetType === "switch" || asset.assetType === "access_point")
  ) {
    await releaseInfraReservationsForAssets([id], {
      reason: "decommissioned by operator",
      actor,
    });
  }
  // Unmapping a process removes its accumulated connection rows immediately —
  // the Application Map must not keep drawing edges for up to the retention
  // window after the operator opted the process out.
  if (input.mappedProcesses !== undefined) {
    const kept = new Set(input.mappedProcesses);
    const removed = (existing.mappedProcesses ?? []).filter((n) => !kept.has(n));
    if (removed.length > 0) {
      await prisma.assetProcessConnection.deleteMany({
        where: { assetId: id, processName: { in: removed } },
      });
    }
  }
  // Unmapping a UNIT likewise drops its accumulated connection rows now
  // (Phase 3) — rows carry the owning unit, so delete by unit.
  if (input.mappedServices !== undefined) {
    const kept = new Set(input.mappedServices);
    const removed = (existing.mappedServices ?? []).filter((u) => !kept.has(u));
    if (removed.length > 0) {
      await prisma.assetProcessConnection.deleteMany({
        where: { assetId: id, unit: { in: removed } },
      });
    }
  }
  // Pin flips become AUTO discovery rules (Integrations → Polaris Agent):
  // ticking Monitor/Map on this asset mints (or consolidates into) a
  // single-item auto rule targeting it; un-ticking takes the asset off the
  // matching auto rules so the reconcile can't re-pin what was just removed.
  // Fire-and-forget: the pin already landed on the asset row above, and rule
  // bookkeeping must not fail or slow the operator's save.
  {
    const pinChanges: OperatorPinChange[] = [];
    const diffPins = (
      field: "monitoredProcesses" | "mappedProcesses" | "monitoredServices" | "mappedServices",
      kind: "process" | "service",
      surface: "monitor" | "map",
    ) => {
      const posted = (input as any)[field] as string[] | undefined;
      if (posted === undefined) return;
      const was = new Set(((existing as any)[field] ?? []) as string[]);
      const now = new Set(posted);
      for (const n of now) if (!was.has(n)) pinChanges.push({ assetId: id, kind, name: n, surface, action: "added" });
      for (const n of was) if (!now.has(n)) pinChanges.push({ assetId: id, kind, name: n, surface, action: "removed" });
    };
    diffPins("monitoredProcesses", "process", "monitor");
    diffPins("mappedProcesses", "process", "map");
    diffPins("monitoredServices", "service", "monitor");
    diffPins("mappedServices", "service", "map");
    if (pinChanges.length > 0) {
      const hostLabel = asset.hostname || asset.ipAddress || id;
      recordOperatorPinChanges(pinChanges)
        .then((outcome) => {
          if (!outcome || !outcome.changed) return;
          const bits: string[] = [];
          if (outcome.createdRules.length) bits.push(`created ${outcome.createdRules.join(", ")}`);
          if (outcome.updatedRules.length) bits.push(`added ${hostLabel} to ${outcome.updatedRules.join(", ")}`);
          if (outcome.trimmedRules.length) bits.push(`removed ${hostLabel} from ${outcome.trimmedRules.join(", ")}`);
          if (outcome.prunedRules.length) bits.push(`deleted ${outcome.prunedRules.join(", ")}`);
          logEvent({
            action: "application_map.autorule.synced",
            resourceType: "application_map",
            resourceId: "discovery",
            actor,
            message: `Discovery auto-rules updated from pins on "${hostLabel}": ${bits.join("; ")}`,
            details: { assetId: id, changes: pinChanges, outcome } as any,
          });
        })
        .catch(() => {});
    }
  }
  // Operator set/cleared the IP pin: any pending ip-override conflict is
  // now moot (best-effort — a leftover pending row would only linger until
  // the next discovery cycle refreshes or re-raises it).
  if (flags.ipOverrideTouched) {
    resolvePendingIpOverrideConflicts(id, actor ?? "manual").catch(() => {});
  }
  // `os` is in the tracked set; `osVersion` deliberately isn't, because
  // UpdateAssetSchema doesn't accept it — firmware is discovery/agent-owned.
  const trackFields = ["hostname", "hostnameOverride", "ipAddress", "ipOverride", "macAddress", "manufacturer", "model", "serialNumber", "assetType", "status", "location", "latitude", "longitude", "notes", "description", "dnsName", "os"] as const;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const f of trackFields) { before[f] = (existing as any)[f]; after[f] = (asset as any)[f]; }
  const changes = buildChanges(before, after);
  logEvent({ action: "asset.updated", resourceType: "asset", resourceId: id, resourceName: asset.hostname || asset.ipAddress || undefined, actor, message: `Asset "${asset.hostname || asset.ipAddress || "unknown"}" updated`, details: changes ? { changes } : undefined });
  // An operator retyping the OS is a firmware change like any other — same
  // action string, so one automation covers operator and discovery edits alike.
  if (input.os !== undefined) {
    const firmwareEvent = buildFirmwareChangedEvent(
      {
        assetId: id,
        assetName: asset.hostname || asset.ipAddress || null,
        actor: actor ?? "manual",
        source: "operator",
      },
      { os: (existing as any).os },
      { os: (asset as any).os },
    );
    if (firmwareEvent) void logEvent(firmwareEvent);
  }
  // Description sync (Polaris-primary): a changed device description on a
  // Fortinet asset whose integration opted in is mirrored to the device.
  // Fire-and-forget — the Polaris row is authoritative and already saved;
  // failures stamp Asset.descriptionSync + a warning Event inside the
  // service, and the per-discovery reconcile self-heals.
  if (input.description !== undefined && (existing as any).description !== asset.description) {
    syncDescriptionsOnSave({ assetId: id, scope: "device", actor }).catch(() => {});
  }
  // Re-evaluate criteria-based auto-tags when a criteria-relevant field changed
  // (best-effort; the periodic job is the safety net).
  const TAG_CRITERIA_FIELDS = ["manufacturer", "model", "os", "osVersion", "hostname", "department", "location", "assetType", "status", "ipAddress"] as const;
  if (TAG_CRITERIA_FIELDS.some((f) => (input as any)[f] !== undefined)) {
    reconcileTagsForAsset(id).catch(() => {});
  }
  // A firewall's coords drive map-region membership (region: tags) —
  // refresh now instead of waiting for the periodic reconcile job.
  if (flags.coordChanged && asset.assetType === "firewall") {
    reconcileMapRegions().catch(() => {});
  }
}

router.put("/:id", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await loadAssetForUpdate(id);
    if (!existing) throw new AppError(404, "Asset not found");
    const input = UpdateAssetSchema.parse(req.body);
    await validateAssetUpdate(id, existing, input);
    const actor = requestActor(req);
    const { data, ipOverrideTouched, coordChanged } = await buildAssetUpdatePatch(id, existing, input, actor);
    const asset = await prisma.asset.update({ where: { id }, data: data as any });
    await applyAssetUpdateSideEffects(id, existing, asset, input, actor, { ipOverrideTouched, coordChanged });
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/monitor-override/reset — clear an explicit
// monitor-override pin and realign the asset to its discovering integration's
// per-class Auto-Monitor default. Sets `monitored = <addAsMonitored flag>`
// and `monitorOverride = false`, so discovery resumes auto-managing the asset
// on the next cycle. This is the operator's escape hatch for an asset that
// shows the "Asset Override" badge but shouldn't be pinned.
router.post("/:id/monitor-override/reset", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true,
        hostname: true,
        ipAddress: true,
        assetType: true,
        monitored: true,
        monitorOverride: true,
        discoveredByIntegrationId: true,
        fortinetTopology: true,
      },
    });
    if (!existing) throw new AppError(404, "Asset not found");
    if (!existing.discoveredByIntegrationId) {
      throw new AppError(400, "Asset has no discovering integration — there is no Auto-Monitor default to reset to");
    }
    const integration = await prisma.integration.findUnique({
      where: { id: existing.discoveredByIntegrationId },
      select: { type: true, config: true },
    });
    let flag = getAddAsMonitoredFromConfig(
      integration?.type ?? null,
      (integration?.config as Record<string, unknown> | null) ?? null,
      existing.assetType,
    );
    if (flag === null) {
      throw new AppError(400, "Asset type is not subject to integration Auto-Monitor — nothing to reset");
    }
    // HA standby firewall: the effective integration default is always "not
    // monitored" (the cluster IP routes to the active member), regardless of
    // the firewall class flag — mirrors recomputeMonitorOverrideForAssets /
    // sweepMonitoredForIntegration and the discovery flip-off sweep.
    if (
      existing.assetType === "firewall" &&
      ((existing.fortinetTopology as Record<string, unknown> | null)?.haRole === "secondary")
    ) {
      flag = false;
    }
    // Realign to the flag and drop the pin. The DB-layer clamp still forces
    // monitored=false for decommissioned/disabled assets; that's fine — the
    // override is cleared either way and discovery won't monitor them.
    const asset = await prisma.asset.update({
      where: { id },
      data: { monitored: flag, monitorOverride: false },
    });
    logEvent({
      action: "monitor.override_reset",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor: requestActor(req),
      message: `Reset monitor override on "${asset.hostname || asset.ipAddress || "unknown"}" to integration default (monitored=${flag})`,
    });
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// Fallback TTL (seconds) when the resolver can't return one (standard mode).
// Used for both positive results and negative caching (no PTR record found).
const DEFAULT_PTR_TTL_S = 3600;

function isPtrExpired(fetchedAt: Date | string | null | undefined, ttlSeconds: number | null | undefined, now: number): boolean {
  if (!fetchedAt) return true;
  const fetched = typeof fetchedAt === "string" ? new Date(fetchedAt).getTime() : (fetchedAt as Date).getTime();
  const ttlMs = (ttlSeconds ?? DEFAULT_PTR_TTL_S) * 1000;
  return (now - fetched) > ttlMs;
}

// Fleet-wide DNS sweep tuning.
//
// The sweep used to run one `await resolver.reverse()` followed by one
// `await prisma.*.update()` per row, strictly serially, inside the request
// handler. At the 2000-asset fleet size CLAUDE.md requires every change to be
// reasoned about, that is thousands of serial DNS round trips plus thousands of
// individual UPDATE round trips in one HTTP request: it outlives any nginx
// proxy_read_timeout, and a slow resolver multiplies the whole thing by the
// per-lookup timeout.
//
// Now: lookups run through a bounded pool, and the writes are collected and
// applied in batched transactions (the same shape the per-asset sibling route
// below already used). DNS_SWEEP_LOOKUP_CONCURRENCY is deliberately modest —
// the target is usually a single corporate resolver pair, and a wide fan-out
// there looks like a flood rather than a sweep.
const DNS_SWEEP_LOOKUP_CONCURRENCY = 16;
const DNS_SWEEP_WRITE_CHUNK = 250;

/**
 * Apply collected per-row updates in bounded transactions. One transaction per
 * chunk keeps each statement batch small enough that it cannot hold locks or a
 * pool connection for the length of the whole sweep.
 */
async function applyDnsUpdatesChunked(
  updates: Array<{ table: "asset" | "assetAssociatedIp"; id: string; data: Record<string, unknown> }>,
): Promise<void> {
  for (let i = 0; i < updates.length; i += DNS_SWEEP_WRITE_CHUNK) {
    const chunk = updates.slice(i, i + DNS_SWEEP_WRITE_CHUNK);
    await prisma.$transaction(
      chunk.map((u) =>
        u.table === "asset"
          ? prisma.asset.update({ where: { id: u.id }, data: u.data as any })
          : prisma.assetAssociatedIp.update({ where: { id: u.id }, data: u.data as any }),
      ),
    );
  }
}

// POST /api/v1/assets/dns-lookup — bulk PTR lookup; skips IPs whose cached result is within TTL
router.post("/dns-lookup", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const now = Date.now();
    const resolver = await getConfiguredResolver();

    // ── Primary IPs ──────────────────────────────────────────────────────────
    const primaryAssets = await prisma.asset.findMany({
      where: { ipAddress: { not: null }, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: { id: true, ipAddress: true, hostname: true, dnsName: true, dnsNameFetchedAt: true, dnsNameTtl: true },
    });

    // Only query IPs whose cached PTR has expired (or was never fetched)
    const needsPrimary = primaryAssets.filter((a) => isPtrExpired(a.dnsNameFetchedAt, a.dnsNameTtl, now));
    const skippedPrimary = primaryAssets.length - needsPrimary.length;

    let resolved = 0;
    let failed = 0;
    const results: Array<{ id: string; ip: string; dnsName: string }> = [];
    // One collected list for BOTH passes, applied in batched transactions after
    // the lookups finish. Nothing here reads a value another row's update wrote,
    // so deferring the writes changes no outcome.
    const updates: Array<{ table: "asset" | "assetAssociatedIp"; id: string; data: Record<string, unknown> }> = [];

    await mapWithConcurrency(needsPrimary, DNS_SWEEP_LOOKUP_CONCURRENCY, async (asset) => {
      if (!asset.ipAddress) return;
      const fetchedAt = new Date();
      try {
        const records = await resolver.reverse(asset.ipAddress);
        if (records.length > 0) {
          const { name: dnsName, ttl } = records[0];
          updates.push({ table: "asset", id: asset.id, data: { dnsName, dnsNameFetchedAt: fetchedAt, dnsNameTtl: ttl } });
          results.push({ id: asset.id, ip: asset.ipAddress, dnsName });
          resolved++;
          return;
        }
        // Negative cache: record the attempt so we don't retry until TTL expires
        updates.push({ table: "asset", id: asset.id, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
        failed++;
      } catch {
        updates.push({ table: "asset", id: asset.id, data: { dnsNameFetchedAt: fetchedAt, dnsNameTtl: null } });
        failed++;
      }
    });

    // ── Associated IPs ───────────────────────────────────────────────────────
    // Iterate every active asset_associated_ips row directly (the side table is
    // smaller than the asset table, so this is cheaper than the per-asset
    // findMany + array merge loop the JSONB version did). Per-row PTR refresh
    // hits an `update` only when something actually changed; ON CONFLICT
    // semantics aren't relevant here because each row already has a stable id.
    const assocRows = await prisma.assetAssociatedIp.findMany({
      where: { asset: { status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } } },
      select: { id: true, ip: true, ptrName: true, ptrTtl: true, ptrFetchedAt: true },
    });

    let assocResolved = 0;
    let assocSkipped = 0;
    const assocNeedsLookup = assocRows.filter((row) => {
      if (!row.ip) return false;
      const fetchedAtIso = row.ptrFetchedAt ? row.ptrFetchedAt.toISOString() : null;
      if (!isPtrExpired(fetchedAtIso, row.ptrTtl, now)) { assocSkipped++; return false; }
      return true;
    });

    await mapWithConcurrency(assocNeedsLookup, DNS_SWEEP_LOOKUP_CONCURRENCY, async (row) => {
      const ptrFetchedAt = new Date();
      try {
        const records = await resolver.reverse(row.ip!);
        if (records.length > 0) {
          assocResolved++;
          updates.push({
            table: "assetAssociatedIp",
            id: row.id,
            data: { ptrName: records[0].name, ptrTtl: records[0].ttl, ptrFetchedAt },
          });
          return;
        }
      } catch { /* fall through to the negative cache below */ }
      // Negative cache — preserve any existing ptrName, clear ttl, stamp fetchedAt
      updates.push({ table: "assetAssociatedIp", id: row.id, data: { ptrTtl: null, ptrFetchedAt } });
    });

    await applyDnsUpdatesChunked(updates);

    logEvent({
      action: "asset.dns.bulk", resourceType: "asset", actor: requestActor(req),
      message: `Bulk DNS lookup: ${resolved} resolved, ${failed} failed, ${skippedPrimary} skipped (TTL); ${assocResolved} associated IP PTR(s) resolved, ${assocSkipped} skipped`,
    });
    res.json({ total: needsPrimary.length, skipped: skippedPrimary, resolved, failed, assocResolved, assocSkipped, results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/dns-lookup — PTR lookup for a single asset; always queries (user-triggered)
router.post("/:id/dns-lookup", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: req.params.id as string },
      include: { associatedIpRows: { select: { id: true, ip: true, ptrName: true } } },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const assocRows = asset.associatedIpRows;
    if (!asset.ipAddress && assocRows.length === 0) throw new AppError(400, "Asset has no IP address");

    const resolver = await getConfiguredResolver();
    let dnsName: string | null = asset.dnsName;
    let dnsNameTtl: number | null = null;
    const fetchedAt = new Date();

    if (asset.ipAddress) {
      try {
        const records = await resolver.reverse(asset.ipAddress);
        if (records.length > 0) { dnsName = records[0].name; dnsNameTtl = records[0].ttl; }
        else dnsName = null;
      } catch {
        dnsName = null;
      }
    }

    // PTR for each associated IP — always re-query on single-asset lookup.
    // One DB write per row (small batches; this is a manual-action endpoint
    // so we're not in a hot path). $transaction packs the per-row updates
    // into a single round-trip so the cost stays low even for assets with
    // dozens of associated IPs.
    let assocResolved = 0;
    const assocUpdates: Array<{ id: string; data: Record<string, unknown> }> = [];
    for (const row of assocRows) {
      if (!row.ip) continue;
      const ptrFetchedAt = new Date();
      try {
        const records = await resolver.reverse(row.ip);
        if (records.length > 0) {
          assocResolved++;
          assocUpdates.push({ id: row.id, data: { ptrName: records[0].name, ptrTtl: records[0].ttl, ptrFetchedAt } });
          continue;
        }
      } catch {}
      assocUpdates.push({ id: row.id, data: { ptrTtl: null, ptrFetchedAt } });
    }
    if (assocUpdates.length > 0) {
      await prisma.$transaction(assocUpdates.map((u) =>
        prisma.assetAssociatedIp.update({ where: { id: u.id }, data: u.data }),
      ));
    }

    const updateData: Record<string, unknown> = {
      dnsName,
      dnsNameFetchedAt: fetchedAt,
      dnsNameTtl,
    };
    await prisma.asset.update({ where: { id: asset.id }, data: updateData });

    if (!dnsName && assocResolved === 0) {
      const testedIp = asset.ipAddress || assocRows[0]?.ip;
      return res.json({ ok: false, message: `No PTR records found for ${testedIp}${assocRows.length > 1 ? " or its associated IPs" : ""}` });
    }

    const parts: string[] = [];
    if (dnsName) parts.push(`${asset.ipAddress} → ${dnsName}${dnsNameTtl != null ? ` (TTL ${dnsNameTtl}s)` : ""}`);
    if (assocResolved > 0) parts.push(`${assocResolved} associated IP PTR(s) resolved`);
    const message = parts.join("; ");

    logEvent({ action: "asset.dns.resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.ipAddress || undefined, actor: requestActor(req), message: `DNS resolved: ${message}` });
    res.json({ ok: true, dnsName, dnsNameTtl, assocResolved, message });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/forward-lookup — A/AAAA lookup from hostname/dnsName → fills ipAddress
router.post("/:id/forward-lookup", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string } });
    if (!asset) throw new AppError(404, "Asset not found");
    if (asset.ipAddress) throw new AppError(400, "Asset already has an IP address");
    const lookupName = asset.dnsName || asset.hostname;
    if (!lookupName) throw new AppError(400, "Asset has no hostname or DNS name to look up");

    const resolver = await getConfiguredResolver();
    const start = Date.now();
    const records = await resolver.lookup(lookupName);
    const elapsed = Date.now() - start;

    if (records.length === 0) {
      return res.json({ ok: false, message: `No A/AAAA records found for ${lookupName}` });
    }

    const ip = records[0].address;
    await prisma.asset.update({ where: { id: asset.id }, data: { ipAddress: ip, ipSource: "dns" } });

    logEvent({ action: "asset.dns.forward_resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.dnsName || undefined, actor: requestActor(req), message: `Forward DNS: ${lookupName} → ${ip} in ${elapsed}ms` });
    res.json({ ok: true, ipAddress: ip, message: `${lookupName} → ${ip} in ${elapsed}ms` });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/oui-lookup — bulk OUI manufacturer lookup
router.post("/oui-lookup", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const assets = await prisma.asset.findMany({
      where: { macAddress: { not: null }, manufacturer: null, status: { notIn: EXCLUDED_LIFECYCLE_STATUSES } },
      select: { id: true, macAddress: true, hostname: true, ipAddress: true },
    });

    let resolved = 0;
    let failed = 0;
    const results: Array<{ id: string; mac: string; manufacturer: string }> = [];

    // Resolve first (lookupOui / lookupOuiOverride are in-memory), then write
    // GROUPED: manufacturer+model is low-cardinality by nature — an OUI names
    // a vendor, and a fleet has tens of vendors, not thousands — so the
    // per-asset update this replaces meant ~1000 statements to write ~50
    // distinct values over an unbounded, unpaginated candidate set. The
    // discovery engine already does the batched form of this exact operation
    // (batchSettled over assetsNeedingOui).
    const byVendor = new Map<string, { data: { manufacturer: string; model?: string }; ids: string[] }>();
    for (const asset of assets) {
      if (!asset.macAddress) continue;
      const vendor = await lookupOui(asset.macAddress);
      if (!vendor) { failed++; continue; }
      const override = await lookupOuiOverride(asset.macAddress);
      const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
      if (override?.device) data.model = override.device;
      const key = JSON.stringify([vendor, data.model ?? ""]);
      const slot = byVendor.get(key);
      if (slot) slot.ids.push(asset.id);
      else byVendor.set(key, { data, ids: [asset.id] });
      results.push({ id: asset.id, mac: asset.macAddress, manufacturer: vendor });
      resolved++;
    }

    for (const { data, ids } of byVendor.values()) {
      await prisma.asset.updateMany({ where: { id: { in: ids } }, data });
    }

    logEvent({ action: "asset.oui.bulk", resourceType: "asset", message: `Bulk OUI lookup: ${resolved} resolved, ${failed} unmatched out of ${assets.length} assets`, actor: requestActor(req) });
    res.json({ total: assets.length, resolved, failed, results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/oui-lookup — OUI manufacturer lookup for a single asset
router.post("/:id/oui-lookup", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const asset = await prisma.asset.findUnique({ where: { id: req.params.id as string } });
    if (!asset) throw new AppError(404, "Asset not found");
    if (!asset.macAddress) throw new AppError(400, "Asset has no MAC address");

    const vendor = await lookupOui(asset.macAddress);
    if (!vendor) {
      return res.json({ ok: false, message: `No OUI match for ${asset.macAddress}` });
    }

    const override = await lookupOuiOverride(asset.macAddress);
    const data: { manufacturer: string; model?: string } = { manufacturer: vendor };
    if (override?.device) data.model = override.device;
    await prisma.asset.update({ where: { id: asset.id }, data });
    const msg = data.model
      ? `OUI resolved: ${asset.macAddress} → ${vendor} / ${data.model}`
      : `OUI resolved: ${asset.macAddress} → ${vendor}`;
    logEvent({ action: "asset.oui.resolved", resourceType: "asset", resourceId: asset.id, resourceName: asset.hostname || asset.ipAddress || undefined, actor: requestActor(req), message: msg });
    res.json({ ok: true, manufacturer: vendor, model: data.model, message: msg });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/import — CSV import: backdate createdAt from serial+date rows (assets admin)
router.post("/import", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const { rows, dryRun } = req.body as { rows?: unknown; dryRun?: boolean };
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(400, "rows must be a non-empty array");

    const preview: Array<{ serialNumber: string; hostname: string | null; currentFirstSeen: string; importDate: string; willUpdate: boolean }> = [];
    let updated = 0;
    let notFound = 0;

    // Parse first, then resolve every serial in ONE read. The loop used to do
    // a findFirst per row and an update per match — serialNumber is indexed,
    // so the cost was pure round-trip latency, but a 2000-row import still
    // meant ~4000 serialized queries and this is the request most likely to
    // hit a proxy timeout. (The /import-pdf handler below already batches its
    // audit events for the same reason; its DB writes just weren't given the
    // same treatment.)
    const parsed: Array<{ serial: string; importDate: Date }> = [];
    for (const row of rows as any[]) {
      const serial = String(row.serialNumber || "").trim();
      const rawDate = String(row.date || "").trim();
      if (!serial || !rawDate) continue;
      const importDate = new Date(rawDate);
      if (isNaN(importDate.getTime())) continue;
      parsed.push({ serial, importDate });
    }

    // First row wins per serial, matching findFirst's behavior on a duplicate.
    const bySerial = new Map<string, { id: string; hostname: string | null; createdAt: Date }>();
    if (parsed.length > 0) {
      const found = await prisma.asset.findMany({
        where: { serialNumber: { in: [...new Set(parsed.map((p) => p.serial))] } },
        select: { id: true, serialNumber: true, hostname: true, createdAt: true },
      });
      for (const a of found) {
        if (a.serialNumber && !bySerial.has(a.serialNumber)) {
          bySerial.set(a.serialNumber, { id: a.id, hostname: a.hostname, createdAt: a.createdAt });
        }
      }
    }

    const backdates: Array<{ id: string; createdAt: Date }> = [];
    for (const { serial, importDate } of parsed) {
      const asset = bySerial.get(serial);
      if (!asset) { notFound++; continue; }

      const willUpdate = importDate < asset.createdAt;
      preview.push({
        serialNumber: serial,
        hostname: asset.hostname,
        currentFirstSeen: asset.createdAt.toISOString(),
        importDate: importDate.toISOString(),
        willUpdate,
      });

      if (willUpdate && !dryRun) {
        backdates.push({ id: asset.id, createdAt: importDate });
        updated++;
      }
    }

    // Chunked so one transaction never spans a whole spreadsheet.
    const IMPORT_CHUNK = 200;
    for (let i = 0; i < backdates.length; i += IMPORT_CHUNK) {
      await prisma.$transaction(
        backdates.slice(i, i + IMPORT_CHUNK).map((b) =>
          prisma.asset.update({ where: { id: b.id }, data: { createdAt: b.createdAt } }),
        ),
      );
    }

    if (!dryRun && updated > 0) {
      logEvent({ action: "asset.import", resourceType: "asset", actor: requestActor(req), message: `CSV import: updated first-seen date for ${updated} asset(s)` });
    }

    res.json({ preview, updated, notFound, dryRun: !!dryRun });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/import-pdf — create/update assets from extracted PDF invoice data (assets admin)
router.post("/import-pdf", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const { assets: rows, dryRun } = req.body as { assets?: unknown; dryRun?: boolean };
    if (!Array.isArray(rows) || rows.length === 0) throw new AppError(400, "assets must be a non-empty array");

    type PreviewRow = {
      action: "create" | "update";
      serialNumber: string | null;
      hostname: string | null;
      fields: Record<string, string>;
      existingHostname?: string | null;
    };
    const preview: PreviewRow[] = [];
    let created = 0;
    let updated = 0;
    // Accumulated so the loop makes one batched audit write rather than an
    // awaited logEvent per imported row.
    const firmwareEvents: LogEventInput[] = [];

    for (const row of rows as any[]) {
      const serial = row.serialNumber ? String(row.serialNumber).trim() : null;
      const existing = serial ? await prisma.asset.findFirst({ where: { serialNumber: serial } }) : null;

      const updateData: Record<string, unknown> = {};
      const allowedFields = ["hostname", "ipAddress", "macAddress", "assetType", "status", "manufacturer", "model", "serialNumber", "location", "department", "assignedTo", "os", "notes", "assetTag"] as const;
      for (const f of allowedFields) {
        if (row[f] !== undefined && row[f] !== "") updateData[f] = String(row[f]).trim();
      }
      if (updateData.macAddress) updateData.macAddress = String(updateData.macAddress).toUpperCase().replace(/-/g, ":");

      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(updateData)) fields[k] = String(v);

      if (existing) {
        preview.push({ action: "update", serialNumber: serial, hostname: row.hostname || null, existingHostname: existing.hostname, fields });
        if (!dryRun) {
          const importUpdateData: Record<string, unknown> = { ...updateData };
          if (importUpdateData.status !== undefined) {
            importUpdateData.statusChangedAt = new Date();
            importUpdateData.statusChangedBy = requestActor(req) ?? "manual";
          }
          await prisma.asset.update({ where: { id: existing.id }, data: importUpdateData as any });
          updated++;
          const firmwareEvent = buildFirmwareChangedEvent(
            {
              assetId: existing.id,
              assetName: existing.hostname || existing.ipAddress || null,
              actor: requestActor(req) ?? "manual",
              source: "pdf-import",
            },
            { os: existing.os },
            updateData,
          );
          if (firmwareEvent) firmwareEvents.push(firmwareEvent);
        }
      } else {
        preview.push({ action: "create", serialNumber: serial, hostname: row.hostname || null, fields });
        if (!dryRun) {
          await prisma.asset.create({ data: { assetType: "other", status: "storage", statusChangedAt: new Date(), statusChangedBy: requestActor(req) ?? "manual", ...updateData } as any });
          created++;
        }
      }
    }

    if (!dryRun && (created + updated) > 0) {
      logEvent({ action: "asset.import_pdf", resourceType: "asset", actor: requestActor(req), message: `PDF import: created ${created}, updated ${updated} asset(s)` });
    }
    if (firmwareEvents.length > 0) void logEventsBatch(firmwareEvents);

    res.json({ preview, created, updated, dryRun: !!dryRun });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id/macs/:mac — remove a MAC from an asset's history (network admin)
router.delete("/:id/macs/:mac", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const normalized = String(req.params.mac || "").toUpperCase().replace(/-/g, ":");

    const existing = await prisma.asset.findUnique({
      where: { id },
      include: { macAddressRows: { select: MAC_ROW_SELECT } },
    });
    if (!existing) throw new AppError(404, "Asset not found");

    const allRows = existing.macAddressRows;
    const target = allRows.find((m) => m.mac.toUpperCase().replace(/-/g, ":") === normalized);
    if (!target) {
      throw new AppError(404, "MAC address not found on this asset");
    }

    // Compute the new primary `Asset.macAddress` scalar after removal:
    // most-recently-seen surviving MAC, or null if the deleted MAC was the
    // last one. Side-table delete + scalar-column update run as a single
    // transaction so the asset never points at a MAC that no longer exists.
    let primary = existing.macAddress;
    if (primary && primary.toUpperCase().replace(/-/g, ":") === normalized) {
      const survivors = allRows.filter((m) => m.mac !== target.mac);
      survivors.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
      primary = survivors[0]?.mac ?? null;
    }

    const [, updated] = await prisma.$transaction([
      prisma.assetMacAddress.deleteMany({
        where: { assetId: id, mac: target.mac },
      }),
      prisma.asset.update({
        where: { id },
        data: { macAddress: primary },
      }),
    ]);

    logEvent({
      action: "asset.mac_removed",
      resourceType: "asset",
      resourceId: id,
      resourceName: updated.hostname || updated.ipAddress || undefined,
      actor: requestActor(req),
      message: `Removed MAC ${normalized} from asset "${updated.hostname || updated.ipAddress || "unknown"}"`,
    });

    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets — bulk delete (assets admin)
router.delete("/", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const { ids } = req.body as { ids?: unknown };
    if (!Array.isArray(ids) || ids.length === 0) throw new AppError(400, "ids must be a non-empty array");
    if (ids.some((id) => typeof id !== "string")) throw new AppError(400, "All ids must be strings");
    // ONE read answers both questions about this id set — which rows are
    // quarantined (refuse the delete) and which are managed infra (release
    // their reservations first). They used to be two findMany calls over the
    // same ids.
    const targets = await prisma.asset.findMany({
      where: { id: { in: ids as string[] } },
      select: { id: true, hostname: true, ipAddress: true, status: true, assetType: true },
    });
    // Refuse to bulk-delete any quarantined asset — the operator must release
    // the quarantine first so the device-side targets get cleaned up.
    const quarantined = targets.filter((a) => a.status === "quarantined");
    if (quarantined.length > 0) {
      const names = quarantined.map((a) => a.hostname || a.ipAddress || a.id).slice(0, 5);
      const more = quarantined.length > 5 ? ` (+${quarantined.length - 5} more)` : "";
      throw new AppError(409, `Cannot delete quarantined asset(s): ${names.join(", ")}${more}. Release the quarantine first.`);
    }
    // Same as the single delete: release before the rows go away, and only for
    // the managed-infra types.
    const infraIds = targets
      .filter((a) => a.assetType === "switch" || a.assetType === "access_point")
      .map((a) => a.id);
    if (infraIds.length > 0) {
      await releaseInfraReservationsForAssets(infraIds, { reason: "asset deleted", actor: requestActor(req) });
    }
    const { count } = await prisma.asset.deleteMany({ where: { id: { in: ids as string[] } } });
    logEvent({ action: "asset.bulk_deleted", resourceType: "asset", actor: requestActor(req), message: `Bulk deleted ${count} asset(s)` });
    res.json({ deleted: count });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id — delete (assets admin)
router.delete("/:id", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const existing = await prisma.asset.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, "Asset not found");
    if (existing.status === "quarantined") {
      throw new AppError(409, `Cannot delete quarantined asset "${existing.hostname || existing.ipAddress || id}". Release the quarantine first.`);
    }
    // Give the address back BEFORE the row goes away — the release resolves the
    // reservation from the asset's ipAddress, which is unreadable once deleted.
    if (existing.assetType === "switch" || existing.assetType === "access_point") {
      await releaseInfraReservationsForAssets([id], { reason: "asset deleted", actor: requestActor(req) });
    }
    await prisma.asset.delete({ where: { id } });
    logEvent({ action: "asset.deleted", resourceType: "asset", resourceId: id, resourceName: existing.hostname || existing.ipAddress || undefined, actor: requestActor(req), message: `Asset "${existing.hostname || existing.ipAddress || "unknown"}" deleted` });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── Quarantine + sightings ─────────────────────────────────────────────

// GET /api/v1/assets/:id/sightings — DHCP sighting history (any auth user)
// Each sighting is decorated with subnet name + VLAN resolved from the stored
// IP against subnets discovered on the same FortiGate, so the Quarantine tab
// can show "what was seen and on which VLAN" without a second round-trip.
router.get("/:id/sightings", requirePermission("assetsQuarantine", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const exists = await prisma.asset.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new AppError(404, "Asset not found");
    const sightings = await getSightingsForAsset(id);

    const devices = Array.from(
      new Set(sightings.map((s) => s.fortigateDevice).filter(Boolean)),
    );
    const subnets = devices.length
      ? await prisma.subnet.findMany({
          where: { fortigateDevice: { in: devices } },
          select: { cidr: true, name: true, vlan: true, fortigateDevice: true },
        })
      : [];

    const enriched = sightings.map((s) => {
      let subnetName: string | null = null;
      let vlan: number | null = null;
      if (s.ipAddress) {
        const match = subnets.find(
          (sub) =>
            sub.fortigateDevice === s.fortigateDevice &&
            cidrContains(sub.cidr, `${s.ipAddress}/32`),
        );
        if (match) {
          subnetName = match.name ?? null;
          vlan = match.vlan ?? null;
        }
      }
      return { ...s, subnetName, vlan };
    });

    res.json(enriched);
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
router.post("/:id/sources/:sourceId/split", requirePermission("assets", "write"), async (req, res, next) => {
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
    let assetType: "firewall" | "switch" | "access_point" | "workstation" | "server" | "hypervisor" | "other" = "other";
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
router.post("/:id/merge", requirePermission("assets", "write"), async (req, res, next) => {
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
      prisma.asset.findUnique({ where: { id: ghostId }, select: { id: true, hostname: true } }),
    ]);
    if (!survivorBefore) throw new AppError(404, "Survivor asset not found");
    if (!absorbedBefore) throw new AppError(404, "Absorbed asset not found");

    const result = await mergeAssets({
      canonicalId,
      ghostId,
      fieldWinners: resolvedWinners,
      dependencyWinner: resolvedDependencyWinner,
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

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─── Dependency-aware monitoring suppression ────────────────────────────────
//
// Three endpoints over `AssetDependencyParent`:
//   GET    /:id/dependencies                — read effective + computed
//                                             parents, layer, suppressed flag
//   PUT    /:id/dependencies/override       — admin: replace source="override"
//                                             rows; empty array = explicit
//                                             "no parents" pin
//   DELETE /:id/dependencies/override       — admin: clear all overrides;
//                                             computed set takes effect
//
// Effective-parents resolution: if any source="override" rows exist for an
// asset, the override set is its effective parents and the computed set is
// ignored. Empty override set is a deliberate pin (asset opts out of
// suppression entirely) and is distinct from "no override at all" — we
// represent it by writing zero override rows but stamping a marker. To keep
// the data model simple we don't use a separate marker column; instead the
// override endpoint is the SOLE way to write "0 overrides" without computed
// fallback. So the resolution rule is "if the operator most recently called
// PUT /override, the override set wins (even if empty)". The DELETE endpoint
// reverts to computed.
//
// Cycles are rejected at write time: walking back through every proposed
// parent's existing parents must never reach the asset itself.

const dependencyOverrideBodySchema = z.object({
  parentAssetIds: z.array(z.string().min(1)).max(20),
});

// ─── GET /:id/dependencies phases (split 2026-08 — the contract tests in
// tests/integration/assetDependenciesContract.test.ts pin the override-wins
// rule, the per-child binding filter, the grandchild layer, the ordering,
// and the HA-peer block). The child and grandchild blocks were near-duplicate
// inline copies of the same binding-rule walk; they now share
// loadBoundChildRows.

// Payload caps for the asset-details tree, which feeds a modal. Both layers of
// the downward view are infra-only, so these bound a controller FortiGate with
// hundreds of managed switches and APs — not the endpoint half, which is
// filtered out of the children read entirely.
const DEP_INFRA_CHILD_CAP = 300;
const DEP_GRANDCHILD_CAP = 500;

// Stable display order: type (firewall→switch→ap→other), then hostname.
const DEP_TYPE_ORDER: Record<string, number> = { firewall: 1, switch: 2, access_point: 3 };
function byDepTypeThenHostname(a: { assetType: string; hostname: string | null }, b: { assetType: string; hostname: string | null }): number {
  const ta = DEP_TYPE_ORDER[a.assetType] ?? 99;
  const tb = DEP_TYPE_ORDER[b.assetType] ?? 99;
  if (ta !== tb) return ta - tb;
  return (a.hostname || "").localeCompare(b.hostname || "");
}

interface BoundChildRow {
  parentAssetId: string;
  id: string;
  hostname: string | null;
  assetType: string;
  dependencyLayer: number | null;
  monitorStatus: string | null;
  monitored: boolean;
  dependencySuppressed: boolean;
  dependencyTestUntil: Date | null;
  source: string;
  detectedVia: string | null;
}

/**
 * Every asset BOUND to one of `parentIds` as a dependency child. Binding
 * resolution per child: if the child has ANY override row, only its override
 * rows count; otherwise every NON-override row counts — the same rule
 * `loadEffectiveParents` applies in the reconciler. (It used to test
 * `source === "computed"` literally, which silently hid the two other
 * discovery-written sources from the tree: `vcenter` VM→host edges and, since
 * 2026-08, the `endpoint` half.) Rows come back in (source asc, createdAt asc)
 * order; callers own dedupe/grouping/sorting.
 *
 * `opts.assetTypes` narrows the child types and `opts.take` caps the read. Both
 * exist because the endpoint half made a FortiGate's child set fleet-sized — a
 * site gate is the last-seen device for every endpoint at the site, and the
 * asset-details tree is a summary of the infra chain, not a browsable inventory.
 * Note `take` applies BEFORE the per-child binding filter below, so a caller
 * wanting a specific slice must express it in the where.
 */
async function loadBoundChildRows(
  parentIds: string[],
  opts?: { assetTypes?: string[]; take?: number },
): Promise<BoundChildRow[]> {
  if (parentIds.length === 0) return [];
  const rows = await prisma.assetDependencyParent.findMany({
    where: {
      parentAssetId: { in: parentIds },
      ...(opts?.assetTypes ? { asset: { assetType: { in: opts.assetTypes } } } : {}),
    },
    ...(opts?.take ? { take: opts.take } : {}),
    include: {
      asset: {
        select: {
          id: true,
          hostname: true,
          assetType: true,
          dependencyLayer: true,
          monitorStatus: true,
          monitored: true,
          dependencySuppressed: true,
          dependencyTestUntil: true,
        },
      },
    },
    orderBy: [{ source: "asc" }, { createdAt: "asc" }],
  });
  const ids = [...new Set(rows.map((r) => r.assetId))];
  const overrideMap = new Map<string, boolean>();
  if (ids.length > 0) {
    const overrides = await prisma.assetDependencyParent.findMany({
      where: { assetId: { in: ids }, source: "override" },
      select: { assetId: true },
    });
    for (const r of overrides) overrideMap.set(r.assetId, true);
  }
  const out: BoundChildRow[] = [];
  for (const r of rows) {
    const childHasOverride = overrideMap.get(r.assetId) === true;
    const isBinding = childHasOverride ? r.source === "override" : r.source !== "override";
    if (!isBinding) continue;
    out.push({
      parentAssetId:        r.parentAssetId,
      id:                   r.asset.id,
      hostname:             r.asset.hostname,
      assetType:            r.asset.assetType,
      dependencyLayer:      r.asset.dependencyLayer,
      monitorStatus:        r.asset.monitorStatus,
      monitored:            r.asset.monitored,
      dependencySuppressed: r.asset.dependencySuppressed,
      dependencyTestUntil:  r.asset.dependencyTestUntil,
      source:               r.source,
      detectedVia:          r.detectedVia,
    });
  }
  return out;
}

/**
 * HA peer (firewalls only) — the other member of this asset's HA cluster,
 * resolved via the fortinetTopology.haPeerSerial stamp. The dependency DAG
 * deliberately has NO edge between HA members (both are layer-1 roots;
 * member↔member LLDP edges are same-layer and pruned), so without this the
 * tree panel can never show the cluster's second box. Display-only — it is
 * NOT a parent or child.
 */
async function loadDependencyHaPeer(asset: { assetType: string; fortinetTopology: unknown }) {
  const selfTopo = (asset.fortinetTopology as Record<string, unknown> | null) ?? null;
  const peerSerial = typeof selfTopo?.haPeerSerial === "string" ? selfTopo.haPeerSerial : null;
  if (asset.assetType !== "firewall" || !peerSerial) return null;
  const peer = await prisma.asset.findFirst({
    where: { serialNumber: { equals: peerSerial, mode: "insensitive" } },
    select: {
      id: true, hostname: true, assetType: true, dependencyLayer: true,
      monitorStatus: true, monitored: true, fortinetTopology: true,
    },
  });
  if (!peer) return null;
  const peerTopo = (peer.fortinetTopology as Record<string, unknown> | null) ?? null;
  return {
    id: peer.id,
    hostname: peer.hostname,
    assetType: peer.assetType,
    dependencyLayer: peer.dependencyLayer,
    monitorStatus: peer.monitorStatus,
    monitored: peer.monitored,
    haRole: typeof peerTopo?.haRole === "string" ? peerTopo.haRole : null,
  };
}

router.get("/:id/dependencies", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true,
        hostname: true,
        assetType: true,
        monitorStatus: true,
        monitored: true,
        dependencyLayer: true,
        dependencySuppressed: true,
        dependencySuppressedAt: true,
        dependencyTestUntil: true,
        dependencyTestStartedBy: true,
        fortinetTopology: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    const haPeer = await loadDependencyHaPeer(asset);

    const rows = await prisma.assetDependencyParent.findMany({
      where: { assetId: id },
      include: {
        parent: {
          select: {
            id: true,
            hostname: true,
            assetType: true,
            dependencyLayer: true,
            monitorStatus: true,
            monitored: true,
            dependencyTestUntil: true,
          },
        },
      },
      orderBy: [{ source: "asc" }, { createdAt: "asc" }],
    });

    function shape(r: (typeof rows)[number]) {
      return {
        id: r.id,
        parent: r.parent
          ? {
              id:                  r.parent.id,
              hostname:            r.parent.hostname,
              assetType:           r.parent.assetType,
              dependencyLayer:     r.parent.dependencyLayer,
              monitorStatus:       r.parent.monitorStatus,
              monitored:           r.parent.monitored,
              dependencyTestUntil: r.parent.dependencyTestUntil,
            }
          : null,
        source:      r.source,
        detectedVia: r.detectedVia,
      };
    }

    // Every non-override source is part of the computed set — `computed` (the
    // Fortinet infra half), `endpoint` (the leaf edge an endpoint hangs off its
    // last-seen switch / AP / FortiGate by) and `vcenter` (VM→ESXi placement).
    // Filtering on the literal "computed" hid the other two from the tree even
    // though the reconciler was suppressing on them.
    const computedParents = rows.filter(r => r.source !== "override").map(shape);
    const overrideParents = rows.filter(r => r.source === "override").map(shape);
    // When at least one override row exists, the override set is the effective
    // set (even if it ends up filtering down to the same parents as computed).
    const hasOverride = overrideParents.length > 0;
    const effectiveParents = hasOverride ? overrideParents : computedParents;

    // Direct children — every asset bound to THIS asset as an effective
    // parent (loadBoundChildRows applies the override-wins binding rule per
    // child). Dedupe by child id keeping the first binding row.
    //
    // **INFRA ONLY, both layers.** The endpoint half of the DAG made endpoints
    // children of the switch / AP / gate that last saw them, and briefly they
    // rendered here too — but the downward view exists to show the infra chain
    // (firewall → switch → AP), and a site gate is the last-seen device for
    // every workstation, printer and server at the site, so admitting them
    // buries the two or three rows an operator opened the tree to read. An
    // endpoint's dependency still shows on its OWN General tab, as the parent
    // above it, which is where the suppression it drives is worth explaining.
    // Type-filtered in SQL, not in memory: `take` applies before any in-memory
    // filter, so a gate with 300 switch children would otherwise fill the read
    // and report nothing.
    const boundInfraChildren = await loadBoundChildRows([id], {
      assetTypes: [...FORTINET_INFRA_ASSET_TYPES],
      take: DEP_INFRA_CHILD_CAP + 1,
    });
    const boundChildren = boundInfraChildren.slice(0, DEP_INFRA_CHILD_CAP);
    const childrenTruncated = boundInfraChildren.length > DEP_INFRA_CHILD_CAP;
    const seenChildIds = new Set<string>();
    const children: Array<Omit<BoundChildRow, "parentAssetId">> = [];
    for (const r of boundChildren) {
      if (seenChildIds.has(r.id)) continue; // dedupe if a child pins us via both computed AND override
      seenChildIds.add(r.id);
      const { parentAssetId: _p, ...child } = r;
      children.push(child);
    }
    children.sort(byDepTypeThenHostname);

    // One additional layer down (grandchildren) so the asset details modal can
    // render firewall → switch → AP without click-through. Same binding rule;
    // dedupe per (parentId, childId) so an MCLAG pair doesn't render twice
    // under one parent.
    //
    // INFRA-ONLY, which is exactly what this returned before the endpoint half
    // existed: a firewall's grandchildren are its switches' APs. Letting
    // endpoints in would multiply the payload by every endpoint on every switch
    // at the site for a row nobody reads two levels down.
    const grandchildrenByParent = new Map<string, Array<Omit<BoundChildRow, "parentAssetId">>>();
    const boundGrandchildren = await loadBoundChildRows(children.map(c => c.id), {
      assetTypes: [...FORTINET_INFRA_ASSET_TYPES],
      take: DEP_GRANDCHILD_CAP,
    });
    const seenGc = new Set<string>();
    for (const r of boundGrandchildren) {
      const dedupeKey = r.parentAssetId + "|" + r.id;
      if (seenGc.has(dedupeKey)) continue;
      seenGc.add(dedupeKey);
      const { parentAssetId, ...gc } = r;
      const list = grandchildrenByParent.get(parentAssetId) ?? [];
      list.push(gc);
      grandchildrenByParent.set(parentAssetId, list);
    }
    for (const list of grandchildrenByParent.values()) {
      list.sort(byDepTypeThenHostname);
    }

    // INFRA child count per rendered child + for this asset itself, so the tree
    // can say "+N more" instead of implying the capped list is everything.
    // Counting infra only is what keeps that hint consistent with what the tree
    // shows — a raw count would make "+312" on a switch row an endpoint tally,
    // which is precisely the noise the type filter above exists to remove.
    // Hence a findMany over the (indexed) parentAssetId with the relation type
    // filter rather than a groupBy, which can't filter on a relation field.
    const countScopeIds = [id, ...children.map(c => c.id)];
    const childCountRows = await prisma.assetDependencyParent.findMany({
      where: {
        parentAssetId: { in: countScopeIds },
        source: { not: "override" },
        asset: { assetType: { in: [...FORTINET_INFRA_ASSET_TYPES] } },
      },
      select: { parentAssetId: true, assetId: true },
    });
    const childCountByParent = new Map<string, number>();
    const countedPairs = new Set<string>();
    for (const r of childCountRows) {
      // A pair can carry rows under several sources; count the child once.
      const pair = r.parentAssetId + "|" + r.assetId;
      if (countedPairs.has(pair)) continue;
      countedPairs.add(pair);
      childCountByParent.set(r.parentAssetId, (childCountByParent.get(r.parentAssetId) ?? 0) + 1);
    }

    const childrenWithGrandchildren = children.map(c => ({
      ...c,
      grandchildren: grandchildrenByParent.get(c.id) ?? [],
      childCount:    childCountByParent.get(c.id) ?? 0,
    }));

    res.json({
      asset: {
        id:                      asset.id,
        hostname:                asset.hostname,
        assetType:               asset.assetType,
        monitorStatus:           asset.monitorStatus,
        monitored:               asset.monitored,
        dependencyLayer:         asset.dependencyLayer,
        dependencySuppressed:    asset.dependencySuppressed,
        dependencySuppressedAt:  asset.dependencySuppressedAt,
        dependencyTestUntil:     asset.dependencyTestUntil,
        dependencyTestStartedBy: asset.dependencyTestStartedBy,
      },
      effectiveParents,
      computedParents,
      overrideParents,
      hasOverride,
      children: childrenWithGrandchildren,
      childrenTruncated,
      childCount: childCountByParent.get(id) ?? 0,
      haPeer,
    });
  } catch (err) {
    next(err);
  }
});

router.put("/:id/dependencies/override", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const body = dependencyOverrideBodySchema.parse(req.body);

    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true, hostname: true } });
    if (!asset) throw new AppError(404, "Asset not found");

    const proposedParentIds = [...new Set(body.parentAssetIds)];

    // Reject self-reference up front.
    if (proposedParentIds.includes(id)) {
      throw new AppError(400, "An asset cannot be its own dependency parent");
    }

    // Validate every proposed parent exists and is a Fortinet infra asset
    // (firewall / switch / access_point) — anything else doesn't belong in the
    // dependency tree.
    if (proposedParentIds.length > 0) {
      const proposed = await prisma.asset.findMany({
        where: { id: { in: proposedParentIds } },
        select: { id: true, assetType: true, hostname: true },
      });
      if (proposed.length !== proposedParentIds.length) {
        throw new AppError(400, "One or more proposed parent assets not found");
      }
      const wrongType = proposed.filter(p => !["firewall", "switch", "access_point"].includes(p.assetType));
      if (wrongType.length > 0) {
        throw new AppError(
          400,
          `Dependency parents must be firewall/switch/access_point: ${wrongType.map(p => p.hostname || p.id).join(", ")}`,
        );
      }

      // Cycle check: from each proposed parent, walk UP through that parent's
      // existing effective parents. If we ever reach `id`, the override would
      // form a cycle.
      const allEdges = await prisma.assetDependencyParent.findMany({
        select: { assetId: true, parentAssetId: true, source: true },
      });
      // Bucket override vs computed; the asset whose parents we walk uses its
      // own override set when present, otherwise the computed set — same as
      // the runtime resolver.
      const overrideByChild = new Map<string, string[]>();
      const computedByChild = new Map<string, string[]>();
      for (const e of allEdges) {
        const m = e.source === "override" ? overrideByChild : computedByChild;
        const cur = m.get(e.assetId);
        if (cur) cur.push(e.parentAssetId);
        else m.set(e.assetId, [e.parentAssetId]);
      }
      function effectiveParentsOf(child: string): string[] {
        const o = overrideByChild.get(child);
        if (o) return o;
        return computedByChild.get(child) ?? [];
      }
      const visited = new Set<string>();
      const queue = [...proposedParentIds];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (cur === id) {
          throw new AppError(400, "Proposed override would form a dependency cycle");
        }
        if (visited.has(cur)) continue;
        visited.add(cur);
        // Climb. NOTE: we walk current effective parents, treating this asset's
        // proposed override as not-yet-applied; since cur cannot equal `id`
        // (we just checked), we never need the proposed set itself in the walk.
        const climb = effectiveParentsOf(cur);
        for (const p of climb) queue.push(p);
      }
    }

    // Atomic replace: delete current override rows for this child, then insert
    // the new set. createMany skipDuplicates handles the case where one of the
    // proposed parents already shows up in the computed set.
    await prisma.$transaction(async (tx) => {
      await tx.assetDependencyParent.deleteMany({
        where: { assetId: id, source: "override" },
      });
      if (proposedParentIds.length > 0) {
        await tx.assetDependencyParent.createMany({
          data: proposedParentIds.map(parentId => ({
            assetId:       id,
            parentAssetId: parentId,
            source:        "override",
            detectedVia:   "manual",
          })),
          skipDuplicates: true,
        });
      }
    });

    logEvent({
      action:       "asset.dependency.override_set",
      resourceType: "asset",
      resourceId:   id,
      resourceName: asset.hostname || undefined,
      level:        "info",
      message:      `Dependency override set on ${asset.hostname || id} (${proposedParentIds.length} parent${proposedParentIds.length === 1 ? "" : "s"})`,
      details:      { parentAssetIds: proposedParentIds },
    });

    res.json({ ok: true, parentAssetIds: proposedParentIds });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/dependencies/override", requirePermission("assets", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({ where: { id }, select: { id: true, hostname: true } });
    if (!asset) throw new AppError(404, "Asset not found");

    const result = await prisma.assetDependencyParent.deleteMany({
      where: { assetId: id, source: "override" },
    });

    if (result.count > 0) {
      logEvent({
        action:       "asset.dependency.override_cleared",
        resourceType: "asset",
        resourceId:   id,
        resourceName: asset.hostname || undefined,
        level:        "info",
        message:      `Dependency override cleared on ${asset.hostname || id} — computed parents now apply`,
        details:      { removed: result.count },
      });
    }

    res.json({ ok: true, removed: result.count });
  } catch (err) {
    next(err);
  }
});

// ─── Dependency Test (admin-only simulation) ────────────────────────────────
//
// Admin-only "simulate this asset going down to see how children react."
// Sets Asset.dependencyTestUntil to a TTL deadline; the dependency reconciler
// then treats the asset as confirmed-down for child suppression evaluation.
// Real probes keep running and updating monitorStatus / lastResponseTimeMs
// normally — this is a what-if overlay, not a probe pause. Auto-expires at
// the deadline; reconciler clears the field and writes
// `asset.dependency_test.expired`. Manual clear via DELETE writes
// `asset.dependency_test.cleared`.
//
// Gated `assetMonitorSettings=fullwrite` — admin-only in every built-in
// role. The simulation can briefly mask a real outage (any monitored child of
// the test target gets marked dependencySuppressed even if it's also
// genuinely failing), so we keep the privilege narrow. It used to sit on
// `assetsProbe=write`, which did NOT deliver that: network-admin,
// assets-admin and even the plain `user` role all hold that level. And when
// `assetsProbe` became a read-only key (a probe writes nothing; this does —
// it stamps `dependencyTestUntil`) there was no level left there to express
// "admin only" at all.

const dependencyTestSchema = z.object({
  durationMinutes: z.number().int().min(1).max(240).default(30),
});

router.post("/:id/dependency-test", requirePermission("assetMonitorSettings", "fullwrite"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { durationMinutes } = dependencyTestSchema.parse(req.body ?? {});

    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, assetType: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    // Only Fortinet infra assets sit in the dependency tree. Refusing the
    // call on workstations / printers / etc. surfaces the misconception
    // early instead of letting the operator wait for a no-op.
    if (!["firewall", "switch", "access_point"].includes(asset.assetType)) {
      throw new AppError(400, "Dependency Test only applies to firewall / switch / access_point assets");
    }

    const until = new Date(Date.now() + durationMinutes * 60_000);
    const startedBy = requestActor(req) || "unknown";

    await prisma.asset.update({
      where: { id },
      data:  { dependencyTestUntil: until, dependencyTestStartedBy: startedBy },
    });

    // Fire the reconciler so children flip to dependencySuppressed within
    // this request rather than waiting up to 60 s for the next tick. Same
    // hook the probe-result path uses for genuine status changes.
    await propagateAfterStatusChange(id);

    logEvent({
      action:       "asset.dependency_test.started",
      resourceType: "asset",
      resourceId:   id,
      resourceName: asset.hostname || undefined,
      actor:        requestActor(req),
      level:        "info",
      message:      `Dependency Test started on ${asset.hostname || id} for ${durationMinutes} min (auto-expires ${until.toISOString()})`,
      details:      { durationMinutes, dependencyTestUntil: until },
    });

    res.json({ ok: true, dependencyTestUntil: until, dependencyTestStartedBy: startedBy });
  } catch (err) {
    next(err);
  }
});

router.delete("/:id/dependency-test", requirePermission("assetMonitorSettings", "fullwrite"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: { id: true, hostname: true, dependencyTestUntil: true, dependencyTestStartedBy: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    if (!asset.dependencyTestUntil) {
      // Idempotent — already cleared. No event, no reconciler hit.
      return res.json({ ok: true, alreadyCleared: true });
    }

    await prisma.asset.update({
      where: { id },
      data:  { dependencyTestUntil: null, dependencyTestStartedBy: null },
    });
    await propagateAfterStatusChange(id);

    logEvent({
      action:       "asset.dependency_test.cleared",
      resourceType: "asset",
      resourceId:   id,
      resourceName: asset.hostname || undefined,
      actor:        requestActor(req),
      level:        "info",
      message:      `Dependency Test cleared on ${asset.hostname || id}`,
      details:      { startedBy: asset.dependencyTestStartedBy, scheduledUntil: asset.dependencyTestUntil },
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/connection-path — endpoint → switch → … → FortiGate
//
// Returns the upward chain from this asset to its upstream FortiGate, used by
// the Device Map topology overlay to dim everything off-path. See
// connectionPathService for the resolution rules. Open to any authenticated
// caller (read-only; same scope as the existing /:id/dependencies endpoint).
router.get("/:id/connection-path", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const path = await resolveConnectionPath(id);
    if (!path) throw new AppError(404, "Asset not found");
    res.json(path);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/assets/:id/quarantine-status — current quarantine state + recorded targets
router.get("/:id/quarantine-status", requirePermission("assetsQuarantine", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const asset = await prisma.asset.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        statusBeforeQuarantine: true,
        quarantineReason: true,
        quarantinedAt: true,
        quarantinedBy: true,
        quarantineTargets: true,
      },
    });
    if (!asset) throw new AppError(404, "Asset not found");
    res.json(asset);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/quarantine — admin, assets admin, or token with assets:quarantine scope
router.post("/:id/quarantine", requirePermission("assetsQuarantine", "write"), async (req, res, next) => {
  try {
    const Schema = z.object({ reason: z.string().max(500).optional() });
    const input = Schema.parse(req.body ?? {});
    const id = req.params.id as string;
    const actor = requestActor(req) || "unknown";
    const result = await quarantineAsset({
      assetId: id,
      actor,
      reason: input.reason,
      tokenIntegrationIds: req.apiToken?.integrationIds,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/assets/:id/quarantine — admin, assets admin, or token with assets:quarantine scope
router.delete("/:id/quarantine", requirePermission("assetsQuarantine", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const actor = requestActor(req) || "unknown";
    const result = await releaseQuarantine({
      assetId: id,
      actor,
      tokenIntegrationIds: req.apiToken?.integrationIds,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/:id/quarantine/verify — read-back drift check (admin, assets admin, or token)
router.post("/:id/quarantine/verify", machineApiLimiter, requirePermission("assetsQuarantine", "write"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const verifyResult = await verifyAssetQuarantine(id, req.apiToken?.integrationIds);
    if (verifyResult.driftDetected) {
      // Persist the drift flip + log the event so the operator has an audit trail.
      await prisma.asset.update({
        where: { id },
        data: { quarantineTargets: verifyResult.targets as any },
      });
      const asset = await prisma.asset.findUnique({ where: { id }, select: { hostname: true, ipAddress: true } });
      const actor = requestActor(req);
      logEvent({
        action: "asset.quarantine.drift_detected",
        resourceType: "asset",
        resourceId: id,
        resourceName: asset?.hostname || asset?.ipAddress || undefined,
        actor,
        level: "warning",
        message: `Quarantine drift detected on ${asset?.hostname || id} — one or more FortiGate targets are missing or incomplete`,
        details: { targets: verifyResult.targets },
      });
    }
    res.json(verifyResult);
  } catch (err) {
    next(err);
  }
});

// Bulk-quarantine batching.
//
// Every id in the batch drives live FortiGate device I/O (push a MAC into the
// quarantine table, or release it). These routes used to take an UNBOUNDED id
// array and walk it strictly serially, so a 2000-asset selection meant 2000
// serial device writes held inside one HTTP request — past any proxy timeout,
// with the operator left unsure what actually landed. Sibling precedent:
// bulk-monitor collapsed its per-asset loop into one updateMany, and
// bulk-agent-install caps at 200 ids and drains through a bounded pool.
//
// The cap makes an oversized request a clean 400 instead of a hung one; the
// pool keeps the fan-out at the gates modest (each push is a REST call plus a
// read-back, and a wide fan-out at one FortiGate is how you get rate-limited).
const BULK_QUARANTINE_MAX_IDS = 500;
const BULK_QUARANTINE_POOL = 8;

// POST /api/v1/assets/bulk-quarantine — admin, assets admin, or token with assets:quarantine scope
router.post("/bulk-quarantine", requirePermission("assetsQuarantine", "write"), async (req, res, next) => {
  try {
    const Schema = z.object({
      ids: z.array(z.string()).min(1).max(BULK_QUARANTINE_MAX_IDS),
      reason: z.string().max(500).optional(),
    });
    const input = Schema.parse(req.body);
    const actor = requestActor(req) || "unknown";
    // Per-item ok/message shape preserved — a single bad asset must not fail the
    // batch. mapWithConcurrency keeps results in input order.
    const results = await mapWithConcurrency(input.ids, BULK_QUARANTINE_POOL, async (id) => {
      try {
        const r = await quarantineAsset({ assetId: id, actor, reason: input.reason, tokenIntegrationIds: req.apiToken?.integrationIds });
        return { id, ok: true, message: r.message, succeededCount: r.succeededCount, failedCount: r.failedCount };
      } catch (err: any) {
        return { id, ok: false, message: err?.message || "Quarantine failed" };
      }
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/bulk-quarantine/release — admin, assets admin, or token with assets:quarantine scope
router.post("/bulk-quarantine/release", requirePermission("assetsQuarantine", "write"), async (req, res, next) => {
  try {
    const Schema = z.object({ ids: z.array(z.string()).min(1).max(BULK_QUARANTINE_MAX_IDS) });
    const input = Schema.parse(req.body);
    const actor = requestActor(req) || "unknown";
    const results = await mapWithConcurrency(input.ids, BULK_QUARANTINE_POOL, async (id) => {
      try {
        const r = await releaseQuarantine({ assetId: id, actor, tokenIntegrationIds: req.apiToken?.integrationIds });
        return { id, ok: true, message: r.message };
      } catch (err: any) {
        return { id, ok: false, message: err?.message || "Release failed" };
      }
    });
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/assets/bulk-agent-install — kick off Polaris Agent installs on
// every selected asset at once (assets-page bulk bar "Deploy Agent"). OS
// platform + transport are resolved per asset the way discovery auto-deploy
// does (inferAgentPlatform: Windows → WinRM credential with SSH fallback,
// everything else → SSH); ineligible assets (existing agent, hypervisor,
// Fortinet source, unreachable, no matching credential) come back as skipped
// with a reason instead of failing the batch. Remote installs run in a
// bounded background pool — the response returns immediately and the UI
// watches per-asset installStatus.
const BulkAgentInstallSchema = z.object({
  ids:               z.array(z.string()).min(1).max(200),
  sshCredentialId:   z.string().uuid().optional(),
  winrmCredentialId: z.string().uuid().optional(),
  arch:              z.enum(["amd64", "arm64"]).default("amd64"),
  // Per-OS install-method variant (bulk spans mixed OSes; the service applies
  // each per an asset's inferred platform). Omitted keys use the per-OS
  // default. OS-locked server-side by bulkInstallAgents.
  scriptIds:         z.object({
    linux:   z.string().max(100).optional(),
    darwin:  z.string().max(100).optional(),
    windows: z.string().max(100).optional(),
  }).partial().optional(),
  // Linux privilege tier (ignored for Windows/darwin). "ptrace" grants
  // CAP_SYS_PTRACE for Application Map connection attribution. Applies to every
  // Linux host in the selection. Full root is no longer selectable.
  privilegeTier:     z.enum(["unprivileged", "ptrace"]).optional(),
}).refine((b) => b.sshCredentialId || b.winrmCredentialId, {
  message: "Provide at least one credential (SSH and/or WinRM)",
});
// ─── Polaris Agent deployment (assets=fullwrite) ─────────────────────────
//
// Every verb that PUSHES, REPLACES or REMOVES the agent on a host is gated
// one notch above the rest of this router: `assets=fullwrite`, not `write`.
// Deploying the agent runs an installer on someone else's machine over a
// stored SSH / WinRM credential and leaves a service behind — a materially
// different act from editing an inventory record, and the one action on the
// assets key that reaches outside Polaris to change a host. Built-in roles:
// admin only (assets=fullwrite); `assetsadmin` keeps full inventory editing
// at `write` and no longer reaches deployment. Reads (GET /:id/agent, GET
// /agent-install-scripts) stay at `read` — an operator who cannot deploy can
// still see what is installed. The client hides these controls behind
// canDeployAgent() in public/js/app.js; keep the two in lockstep.

router.post("/bulk-agent-install", requirePermission("assets", "fullwrite"), async (req, res, next) => {
  try {
    const input = BulkAgentInstallSchema.parse(req.body);
    const actor = requestActor(req) || "unknown";
    const { bulkInstallAgents } = await import("../../services/agentInstallService.js");
    const result = await bulkInstallAgents({
      assetIds:          input.ids,
      sshCredentialId:   input.sshCredentialId ?? null,
      winrmCredentialId: input.winrmCredentialId ?? null,
      arch:              input.arch,
      scriptIds:         input.scriptIds,
      privilegeTier:     input.privilegeTier,
      actor,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Polaris Agent — operator-facing routes ──────────────────────────────────
//
// Phase 2 surface: stubs the actual remote install (which lives in
// agentInstallService — Phase 4) by just creating the ManagedAgent row
// and minting a one-shot enrollment token. End-to-end testable with curl:
// hit POST /install to get a managedAgentId + check the row, then have
// the agent (or curl-as-agent) POST /api/v1/agents/enroll with the
// enrollment token to swap it for a bearer. Phase 4 wires the SSH/WinRM
// file upload + remote service start that automates the agent-side work.

const AgentInstallSchema = z.object({
  credentialId: z.string().uuid("credentialId must be a UUID"),
  osPlatform:   z.enum(["linux", "darwin", "windows"]),
  arch:         z.enum(["amd64", "arm64"]),
  // Remote transport. Optional for backward-compat with older clients; when
  // omitted we default linux/darwin → ssh, windows → winrm (the pre-change
  // behavior). Operators installing the agent on a Windows host that has
  // OpenSSH Server enabled can pick "ssh" to use an SSH credential instead.
  transport:    z.enum(["ssh", "winrm"]).optional(),
  // Curated install-method variant id (see agentInstallScripts catalog).
  // Optional — omitted uses the per-OS default. OS-locked server-side.
  scriptId:     z.string().max(100).optional(),
  // Linux privilege tier: "unprivileged" (default, hardened DynamicUser unit) or
  // "ptrace" (unprivileged + CAP_SYS_PTRACE, enabling Application Map connection
  // attribution without full root). Ignored on Windows (LocalSystem) / darwin
  // (LaunchDaemon runs as root). Full root is no longer selectable.
  privilegeTier: z.enum(["unprivileged", "ptrace"]).optional(),
});

router.get("/:id/agent", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) return res.status(404).json({ error: "No agent installed for this asset" });
    // Strip secret-bearing fields before serializing.
    const {
      enrollmentTokenHash: _eh, enrollmentTokenPrefix: _ep,
      bearerHash: _bh,
      ...safe
    } = row;
    // Decoded verified-capability state (null = not reported yet). The
    // System-tab Privileges row renders from this when present so a
    // pre-DAC-fix ptrace unit reads as broken instead of healthy.
    const { decodeCapEff } = await import("../../utils/capEff.js");
    res.json({ ...safe, caps: decodeCapEff(row.reportedCapEff) });
  } catch (err) { next(err); }
});

router.post("/:id/agent/install", requirePermission("assets", "fullwrite"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const body = AgentInstallSchema.parse(req.body);
    const actor = requestActor(req) || "unknown";

    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { discoveredByIntegration: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    // Compatibility check: agent is incompatible with Fortinet appliance
    // sources. The Zod validator + the resolver would reject the polling
    // method itself, but install kickoff has its own check because the
    // operator might click Install before flipping any stream to "agent".
    const sourceKind = assetSourceKindFromIntegrationType(asset.discoveredByIntegration?.type ?? null);
    if (!isPollingMethodCompatible(sourceKind, "agent")) {
      throw new AppError(400,
        `Polaris Agent is not compatible with ${sourceKind} sources. Compatible: manual, activedirectory, entraid, windowsserver, vcenter (VMs).`);
    }
    // vCenter VMs are guest OSes and take the agent fine — but ESXi hosts
    // can't run third-party binaries. Gate on the asset's class, not the
    // integration type (the vcenter source matrix must allow "agent" for VMs).
    if (asset.assetType === "hypervisor") {
      throw new AppError(400, "Polaris Agent cannot be installed on a hypervisor (ESXi) host.");
    }

    // Resolve transport: explicit body value wins; otherwise default by
    // osPlatform (linux/darwin → ssh; windows → winrm). Linux + macOS only
    // support SSH — refuse a winrm pick there.
    const transport = body.transport ?? (body.osPlatform === "windows" ? "winrm" : "ssh");
    if (transport === "winrm" && body.osPlatform !== "windows") {
      throw new AppError(400,
        `WinRM transport is only valid for Windows hosts — osPlatform=${body.osPlatform}`);
    }

    // Validate the chosen install-method variant against the target OS (the
    // OS-lock). Throws 400 on unknown id or OS mismatch; returns the concrete
    // id to persist (the per-OS default when none was picked).
    const { resolveInstallScriptId } = await import("../../services/agentInstallScripts.js");
    resolveInstallScriptId(body.osPlatform, body.scriptId);

    // Credential type must match the transport (ssh-typed cred for SSH,
    // winrm-typed cred for WinRM). Both transports are available for
    // Windows; only SSH is available for linux/darwin.
    const cred = await getCredential(body.credentialId).catch(() => null);
    if (!cred) throw new AppError(400, `Credential ${body.credentialId} not found`);
    if (cred.type !== transport) {
      throw new AppError(400,
        `Credential type "${cred.type}" doesn't match transport "${transport}" — need a "${transport}" credential`);
    }

    // 409 if a row already exists. Operator uses /reinstall to wipe + retry.
    const existing = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (existing) {
      throw new AppError(409,
        `Agent already installed (status=${existing.installStatus}). Use reinstall to start over.`);
    }

    // Cert pin: we capture the SHA-256 of the running Polaris leaf cert
    // at this moment and bake it into the agent's config at install. If
    // HTTPS isn't running, there's no cert to pin and no encrypted
    // transport — refuse the install with a clear error rather than
    // silently issuing a bearer that the agent won't be able to use.
    const { getServerCertFingerprint } = await import("../../services/certInfo.js");
    const fingerprint = getServerCertFingerprint();
    if (!fingerprint) {
      throw new AppError(400,
        "HTTPS is not running on this Polaris server — agent install requires TLS for the cert pin. " +
        "Enable HTTPS in Server Settings → HTTPS first.");
    }

    // The remote agent must be able to call back to Polaris. agent.conf's
    // server_url gets stamped via inferOwnServerUrl() which prefers (in
    // order) POLARIS_PUBLIC_URL → the running cert's first DNS SAN →
    // the cert's CN → an IP SAN → POLARIS_PUBLIC_HOST → localhost. The
    // final localhost fallback only works for same-box installs; on
    // every remote install it produces an agent that connection-refuses
    // against its own loopback. Refuse early when ALL the above sources
    // fail for a remote-host install.
    if (!process.env.POLARIS_PUBLIC_URL && !process.env.POLARIS_PUBLIC_HOST) {
      const targetHost = asset.ipAddress || asset.dnsName || asset.hostname || "";
      const isSameBox = targetHost === "127.0.0.1" || targetHost === "::1" ||
                        targetHost === "localhost" || targetHost.toLowerCase() === "localhost.localdomain";
      if (!isSameBox) {
        // Check whether the cert can supply a hostname before bailing.
        const { getServerCertHostnames } = await import("../../services/certInfo.js");
        const hosts = getServerCertHostnames();
        const certHost = hosts?.dnsSans[0] || hosts?.cn || hosts?.ipSans[0] || null;
        if (!certHost || certHost === "localhost" || certHost === "127.0.0.1" || certHost === "::1") {
          throw new AppError(400,
            "Polaris doesn't know what URL to embed in the remote agent's agent.conf. " +
            "Set POLARIS_PUBLIC_URL in /opt/polaris/.env to your Polaris server's public URL " +
            "(e.g. https://polaris.example.com:3000) and restart Polaris, OR regenerate the " +
            "HTTPS cert under Server Settings → Web Server with a CN/SAN matching the " +
            "hostname remote hosts use to reach Polaris (the agent install path picks the " +
            "URL up from there automatically). Then retry the install.");
        }
      }
    }

    const row = await prisma.managedAgent.create({
      data: {
        assetId,
        osPlatform:            body.osPlatform,
        arch:                  body.arch,
        installedBy:           actor,
        installStatus:         "pending",
        serverCertFingerprint: fingerprint,
        installCredentialId:   body.credentialId,
        installTransport:      transport,
        installScriptId:       body.scriptId ?? null,
        // Privilege tier is a Linux-only concept; other OSes stay "unprivileged".
        privilegeTier:         body.osPlatform === "linux" ? (body.privilegeTier ?? "unprivileged") : "unprivileged",
      },
    });

    await logEvent({
      action:       "agent.install_kickoff",
      resourceType: "asset",
      resourceId:   assetId,
      actor,
      level:        "info",
      message:      `Polaris Agent install kicked off (${body.osPlatform}/${body.arch}, ${transport})`,
      details:      { managedAgentId: row.id, credentialId: body.credentialId, transport, scriptId: body.scriptId ?? null },
    });

    // Fire the async install. The service mints its own enrollment token,
    // SFTPs the binary + agent.conf, runs the installer, and transitions
    // installStatus as it goes. The UI polls GET /:id/agent to watch
    // progress; failure lands as installStatus="failed" + installError.
    const { startInstall } = await import("../../services/agentInstallService.js");
    await startInstall({ managedAgentId: row.id, credentialId: body.credentialId });

    res.json({
      managedAgentId:        row.id,
      installStatus:         row.installStatus,
      serverCertFingerprint: fingerprint,
    });
  } catch (err) { next(err); }
});

router.post("/:id/agent/retry", requirePermission("assets", "fullwrite"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = requestActor(req) || "unknown";

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent row to retry for this asset");
    if (row.installStatus !== "failed") {
      throw new AppError(409,
        `Agent installStatus is "${row.installStatus}"; only failed installs can be retried.`);
    }
    if (!row.installCredentialId) {
      throw new AppError(400,
        "No install credential on file (credential was deleted). " +
        "Force-remove the agent and start a fresh install.");
    }

    // Make sure the credential still exists before we reset the row —
    // otherwise startInstall would flip us right back to "failed" with
    // a less actionable error.
    const cred = await getCredential(row.installCredentialId).catch(() => null);
    if (!cred) {
      throw new AppError(400,
        "Original install credential no longer exists. " +
        "Force-remove the agent and start a fresh install.");
    }

    await prisma.managedAgent.update({
      where: { id: row.id },
      data:  { installStatus: "pending", installError: null },
    });

    await logEvent({
      action:       "agent.install_retry",
      resourceType: "asset",
      resourceId:   assetId,
      actor,
      level:        "info",
      message:      `Polaris Agent install retried (${row.osPlatform}/${row.arch})`,
      details:      { managedAgentId: row.id, credentialId: row.installCredentialId },
    });

    const { startInstall } = await import("../../services/agentInstallService.js");
    await startInstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

    res.json({
      managedAgentId: row.id,
      installStatus:  "pending",
    });
  } catch (err) { next(err); }
});

// Reinstall = "start over" against the same host with the stored install
// params, regardless of current installStatus (unlike /retry, which only
// resets a "failed" row). Reuses the row's installCredentialId, osPlatform,
// arch, and transport; revokes the old bearer up front (runInstall mints a
// fresh enrollment token + bearer on re-enroll) and re-runs startInstall,
// which re-pushes the binary + agent.conf and re-runs the installer. The
// ManagedAgent row and the asset's per-stream *Polling config are kept — an
// operator wanting a truly clean slate uses force-remove + a fresh install.
router.post("/:id/agent/reinstall", requirePermission("assets", "fullwrite"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = requestActor(req) || "unknown";

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent installed for this asset");
    if (!row.installCredentialId) {
      throw new AppError(400,
        "No install credential on file (credential was deleted). " +
        "Force-remove the agent and start a fresh install.");
    }

    // Make sure the credential still exists before we reset the row —
    // otherwise startInstall would flip us right back to "failed".
    const cred = await getCredential(row.installCredentialId).catch(() => null);
    if (!cred) {
      throw new AppError(400,
        "Original install credential no longer exists. " +
        "Force-remove the agent and start a fresh install.");
    }

    // Kill the current bearer immediately — the re-enroll issues a fresh
    // one. Anything the old agent process does before it re-enrolls is
    // rejected, which is what we want during a reinstall.
    const { revokeBearer } = await import("../../services/agentTokenService.js");
    await revokeBearer(row.id);

    // Optional privilege change on reinstall (Linux only). A reinstall can only
    // produce the unprivileged or ptrace unit — full root is retired, so a legacy
    // "root" agent DOWNGRADES to unprivileged unless the operator explicitly
    // picks a tier. Ignored on Windows (LocalSystem).
    const bodyTier: "unprivileged" | "ptrace" | undefined =
      (req.body?.privilegeTier === "unprivileged" || req.body?.privilegeTier === "ptrace")
        ? req.body.privilegeTier : undefined;
    const nextTier: "unprivileged" | "ptrace" =
      row.osPlatform !== "linux" ? "unprivileged"
      : bodyTier !== undefined ? bodyTier
      : row.privilegeTier === "ptrace" ? "ptrace"
      : "unprivileged"; // legacy "root" (or already unprivileged) → unprivileged

    await prisma.managedAgent.update({
      where: { id: row.id },
      data:  { installStatus: "pending", installError: null, privilegeTier: nextTier },
    });

    await logEvent({
      action:       "agent.reinstall_kickoff",
      resourceType: "asset",
      resourceId:   assetId,
      actor,
      level:        "info",
      message:      `Polaris Agent reinstall kicked off (${row.osPlatform}/${row.arch}, ${row.installTransport}${row.osPlatform === "linux" ? ", " + nextTier : ""})`,
      details:      { managedAgentId: row.id, credentialId: row.installCredentialId, privilegeTier: nextTier },
    });

    const { startInstall } = await import("../../services/agentInstallService.js");
    await startInstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

    res.json({
      managedAgentId: row.id,
      installStatus:  "pending",
    });
  } catch (err) { next(err); }
});

const AgentUpgradeSchema = z.object({
  credentialId: z.string().uuid().optional(),
});

router.post("/:id/agent/upgrade", requirePermission("assets", "fullwrite"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const body = AgentUpgradeSchema.parse(req.body ?? {});
    const actor = requestActor(req) || "unknown";

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent installed for this asset");

    const { startUpgrade } = await import("../../services/agentInstallService.js");
    // startUpgrade does its own AppError on no-credential / already-current /
    // missing manifest; let those propagate to the global error handler so
    // the operator sees the message inline.
    const result = await startUpgrade({
      managedAgentId: row.id,
      credentialId:   body.credentialId,
      actor,
    });
    res.json({
      managedAgentId: row.id,
      fromVersion:    result.fromVersion,
      toVersion:      result.toVersion,
      installStatus:  "upgrading",
    });
  } catch (err) { next(err); }
});

router.delete("/:id/agent", requirePermission("assets", "fullwrite"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = requestActor(req) || "unknown";
    const force = String(req.query.force ?? "").toLowerCase() === "true";

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent installed for this asset");

    // Phase 1 of the two-phase DELETE: synchronous revoke. The bearer
    // stops working immediately regardless of whether the host can be
    // reached. Phase 4 will add the async remote-uninstall pass.
    const { revokeBearer } = await import("../../services/agentTokenService.js");
    await revokeBearer(row.id);

    if (force) {
      // Hard-delete the local row. Orphan binary remains on the host
      // (operator's choice when ?force=true); the bearer is dead so it
      // can't talk to Polaris. Also clear the *Polling fields back to
      // null so the periodic puller resumes per the source default —
      // mirrors what runUninstall does on the non-force path. Removing the
      // agent also tears the host off the Application Map: clear the map
      // pins + delete its connection facts (nothing collects them anymore,
      // and the pinned child nodes would otherwise render forever).
      await prisma.$transaction([
        prisma.managedAgent.delete({ where: { id: row.id } }),
        prisma.asset.update({
          where: { id: assetId },
          data: {
            responseTimePolling: null,
            cpuMemoryPolling:    null,
            temperaturePolling:  null,
            interfacesPolling:   null,
            lldpPolling:         null,
            storagePolling:      null,
            processesPolling:    null,
            mappedProcesses:     [],
            mappedServices:      [],
          },
        }),
        prisma.assetProcessConnection.deleteMany({ where: { assetId } }),
      ]);
      await logEvent({
        action:       "agent.force_removed",
        resourceType: "asset",
        resourceId:   assetId,
        actor,
        level:        "warning",
        message:      `Polaris Agent force-removed; bearer revoked, remote uninstall skipped`,
        details:      { managedAgentId: row.id },
      });
      res.json({ ok: true, forced: true });
      return;
    }

    // Default DELETE path: revoke + async remote uninstall using the
    // credential stored at install time. On success, startUninstall
    // hard-deletes the row and emits agent.uninstalled; on failure it
    // transitions to installStatus="uninstall_failed" and emits
    // agent.uninstall_failed (warning) — operator can retry or fall
    // back to ?force=true.
    //
    // Emit the bearer-revoke event before kicking off the remote work
    // so the audit trail captures the synchronous half regardless of
    // what happens to the remote side. Bearer is already dead.
    await logEvent({
      action:       "agent.revoked",
      resourceType: "asset",
      resourceId:   assetId,
      actor,
      level:        "warning",
      message:      "Polaris Agent bearer revoked",
      details:      { managedAgentId: row.id },
    });

    if (!row.installCredentialId) {
      // No credential on file (e.g. it was deleted; SetNull cascade
      // cleared the FK). Operator can either delete the credential
      // back into existence then DELETE again, or use ?force=true.
      // Leave the row in "revoked" — bearer is dead, host has an orphan
      // binary, but Polaris won't keep retrying with no credential.
      await prisma.managedAgent.update({
        where: { id: row.id },
        data: { installStatus: "revoked" },
      });
      res.json({
        ok: true,
        forced: false,
        installStatus: "revoked",
        warning: "No install credential on file — remote uninstall skipped. " +
                 "Use ?force=true to drop the local row entirely, or restore the credential and DELETE again.",
      });
      return;
    }

    const { startUninstall } = await import("../../services/agentInstallService.js");
    await startUninstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

    res.json({ ok: true, forced: false, installStatus: "uninstalling" });
  } catch (err) { next(err); }
});

export default router;
