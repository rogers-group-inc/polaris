/**
 * src/services/monitoring/monitorSettings.ts — the monitor settings hierarchy and resolver (CQ-B061, moved verbatim from
 * monitoringService.ts): the per-tier settings shape, the integration / asset-type /
 * asset cascade with its cache and invalidation, per-source polling defaults, the
 * SD-WAN cadence, fleetCadences, and resolveMonitorSettings[WithProvenance].
 * monitoringService.ts re-exports every public name, so importers are unchanged.
 */

import { toNonNegativeInt } from "../../utils/num.js";
import { prisma } from "../../db.js";
import type { WinRmConnection } from "../../utils/winrm.js";
import { AppError } from "../../utils/errors.js";
import { type PollingMethod, type AssetSourceKind, type Stream, isPollingMethod, isPollingMethodCompatible, isMethodValidForStream, assetSourceKindFromIntegrationType, isFortinetIntegrationType } from "../../utils/pollingCompatibility.js";
import { isWorkloadPlatform } from "../../utils/workloadSources.js";
import { dial } from "./dial.js";

// ─── Monitor settings hierarchy ─────────────────────────────────────────────
//
// Resolution order (most-specific wins):
//
//   per-asset override  →  (assetType + integration) class override
//                       →  integration tier   (for integration-discovered assets)
//                          OR manual tier     (for orphan assets)
//                       →  hardcoded floor    (final safety net; never user-visible)
//
// Tier-3 ("integration tier" / "manual tier") storage:
//   - integration tier → Integration.config.monitorSettings JSON blob
//   - manual tier      → Setting row keyed "manualMonitorSettings"
//
// Tier-2 ("class override") storage: MonitorClassOverride table, one row per
//   (integrationId, assetType). Null integrationId = override for orphan assets.
//
// Tier-1 ("per-asset") storage: individual columns on Asset
//   (monitorIntervalSec, telemetryIntervalSec, systemInfoIntervalSec,
//    probeTimeoutMs). null = inherit.
//
// Probe timeout note: there is no asset-level override for `failureThreshold`
// or any retention field. Those cascade only down to tier-2.
//
// `MonitorTierSettings` is the canonical "all eight settings populated" shape
// used at every level of the resolver after merging. `MonitorOverrideSettings`
// is the partial shape used at tier-1 / tier-2 (null = inherit).

export interface MonitorTierSettings {
  intervalSeconds:           number;
  failureThreshold:          number;
  /**
   * Re-probe spacing (seconds) while a failure or recovery run is being
   * confirmed — the fast-confirm cadence of business rule 30. Default 10
   * (SolarWinds NPM's rapid re-poll default). Range 5..300, and the resolver
   * additionally floors it at the probe's own timeout + the probe loop's tick,
   * so a value below either is raised rather than silently ignored. Like
   * `failureThreshold` it lives at tier-2 and above — there is no per-asset
   * column, because the pair are read together and one asset wanting its own
   * confirmation policy is a class, not an exception.
   */
  fastConfirmIntervalSec:    number;
  /** Probe TCP/UDP/HTTP timeout in milliseconds. Default 5000. Range 100..60000. */
  probeTimeoutMs:            number;
  /**
   * Per-request timeout (ms) for the CPU+memory collector. Applied to
   * FortiOS REST + SNMP sessions inside collectCpuMemory. Default 10000.
   * Range 1000..120000.
   */
  cpuMemoryTimeoutMs:        number;
  /**
   * Per-request timeout (ms) for the temperature collector. Applied to
   * FortiOS REST + SNMP sessions inside collectTemperature (ENTITY-SENSOR-MIB
   * walk, Fortinet sensor-name heuristic, FortiAP scalar fallback). Default
   * 10000. Range 1000..120000.
   */
  temperatureTimeoutMs:      number;
  /**
   * Per-request timeout (ms) for the interface / storage / LLDP collector.
   * Applied to FortiOS REST + SNMP sessions inside collectSystemInfo +
   * collectFastFiltered. Default 10000. Range 1000..120000.
   */
  systemInfoTimeoutMs:       number;
  cpuMemoryIntervalSeconds:  number;
  temperatureIntervalSeconds: number;
  systemInfoIntervalSeconds: number;
  /**
   * Phase 2 carve-out — LLDP rides its own pg-boss queue
   * (polaris-monitor-lldp) and its own cadence. Defaults to the systemInfo
   * cadence at the floor; operators can set it slower (e.g. once an hour
   * while interfaces scrape every 10 min) to cut LLDP-MIB walk pressure
   * on big fleets.
   */
  lldpIntervalSeconds:       number;
  /** Per-request timeout (ms) for the LLDP collector. Default 10000. */
  lldpTimeoutMs:             number;
  /**
   * Phase 2 carve-out — Storage rides its own pg-boss queue
   * (polaris-monitor-storage) and its own cadence. Same shape as
   * lldpIntervalSeconds / lldpTimeoutMs.
   */
  storageIntervalSeconds:    number;
  storageTimeoutMs:          number;
  /**
   * Cross-transport streams (agent / SNMP / SSH / WinRM / REST). Each rides its
   * own cadence + timeout like LLDP / Storage. processes = running-program
   * inventory + per-program CPU/RAM; eventLog = curated OS event-log entries
   * folded into the audit Event table. Method sets enforced by
   * utils/pollingCompatibility STREAM_METHODS.
   */
  processesIntervalSeconds:  number;
  processesTimeoutMs:        number;
  eventLogIntervalSeconds:   number;
  eventLogTimeoutMs:         number;
  sampleRetentionDays:       number;
  /**
   * Single retention setting shared by AssetTelemetrySample (CPU/memory)
   * AND AssetHardwareSensorSample. The stream split affects polling method /
   * cadence / credential / MIB / timeout — sample retention is table-level
   * so one knob covers both sample tables.
   */
  telemetryRetentionDays:    number;
  systemInfoRetentionDays:   number;
  /**
   * Per-stream polling method. null at this tier = "no operator preference,
   * fall back to the source default". The resolver checks compatibility
   * against the asset's source via utils/pollingCompatibility and silently
   * skips an incompatible value (e.g. an integration tier with REST API
   * doesn't apply to an Active Directory asset since AD can't speak REST API).
   */
  responseTimePolling:       PollingMethod | null;
  cpuMemoryPolling:          PollingMethod | null;
  temperaturePolling:        PollingMethod | null;
  interfacesPolling:         PollingMethod | null;
  lldpPolling:               PollingMethod | null;
  processesPolling:          PollingMethod | null;
  eventLogPolling:           PollingMethod | null;
  /**
   * Storage stream — SNMP-only when enabled (HOST-RESOURCES-MIB hrStorageTable
   * plus vendor disk fallbacks). Independent of `interfacesPolling` so
   * operators can disable storage on FMG/FortiGate firewalls (which don't
   * expose meaningful mountpoints) without losing interface scrapes. Source
   * defaults: FMG/FortiGate → "disabled"; every other source → null (= not
   * delivered). Operators opt in by picking SNMP at any tier.
   */
  storagePolling:            PollingMethod | null;
  /**
   * Per-stream MIB identifier hint. Either `"std:<key>"` referencing a
   * built-in standard MIB (used by the asset-detail SNMP Walk tab UI for
   * symbol resolution; ignored by the telemetry collector), or the UUID of
   * an uploaded MibFile row. null at any tier = inherit from below.
   *
   * Consumed by `collectCpuMemorySnmp` / `collectTemperatureSnmp` to override
   * vendor-profile selection when an uploaded MIB is set — useful for assets
   * whose `manufacturer + model` would otherwise fall into the wrong profile
   * (the canonical case being FortiSwitches that pre-Phase-4d landed under
   * the generic Fortinet profile and queried FortiGate-only OIDs).
   */
  responseTimeMibId:         string | null;
  cpuMemoryMibId:            string | null;
  temperatureMibId:          string | null;
  interfacesMibId:           string | null;
  lldpMibId:                 string | null;
  processesMibId:            string | null;
  /**
   * Per-stream Credential FK ids. Only the class-override tier (tier-2) stores
   * these — tier-3 (integration / manual) keeps its credential out-of-band on
   * `Integration.config.monitorCredentialId`, and tier-1 (per-asset) goes
   * through Prisma `include` on the asset row. Resolved value reflects the
   * class override; dispatchers check resolved-vs-per-asset to pick the
   * credential record actually used at probe time.
   */
  responseTimeCredentialId:  string | null;
  cpuMemoryCredentialId:     string | null;
  temperatureCredentialId:   string | null;
  interfacesCredentialId:    string | null;
  lldpCredentialId:          string | null;
  processesCredentialId:     string | null;
  eventLogCredentialId:      string | null;
}

type MonitorOverrideSettings = Partial<MonitorTierSettings>;

/** Final per-asset shape after the resolver walks all four tiers. */
export type ResolvedMonitorSettings = MonitorTierSettings;

/**
 * Hardcoded floor — final fallback when the integration / manual tier hasn't
 * been seeded yet (e.g. fresh install before the migration job runs, or an
 * orphan asset and no operator has touched the manual tier). Operators never
 * see this value in any UI; it just keeps the system running.
 */
export const HARDCODED_FLOOR: MonitorTierSettings = {
  intervalSeconds:           60,
  failureThreshold:          3,
  fastConfirmIntervalSec:    10,
  probeTimeoutMs:            5000,
  cpuMemoryTimeoutMs:        10_000,
  temperatureTimeoutMs:      10_000,
  systemInfoTimeoutMs:       10_000,
  cpuMemoryIntervalSeconds:  60,
  temperatureIntervalSeconds: 60,
  systemInfoIntervalSeconds: 600,
  // Phase 2: LLDP + Storage default to the same baseline as systemInfo so
  // existing fleets see no behavior change at the floor; operators can
  // tune each independently from the per-class subtabs.
  lldpIntervalSeconds:       600,
  lldpTimeoutMs:             10_000,
  storageIntervalSeconds:    600,
  storageTimeoutMs:          10_000,
  // Cross-transport streams default to the system-info baseline cadence at the
  // floor. They resolve to "disabled" until an operator opts in at some tier,
  // so the cadence only matters once a method is selected.
  processesIntervalSeconds:  600,
  processesTimeoutMs:        10_000,
  eventLogIntervalSeconds:   600,
  eventLogTimeoutMs:         10_000,
  sampleRetentionDays:       30,
  telemetryRetentionDays:    30,
  systemInfoRetentionDays:   30,
  // Polling fields default to null at every tier. Source-aware defaults
  // (FMG/FortiGate -> rest_api, AD/Entra/Win -> icmp, manual -> icmp for
  // responseTime + null for the other streams) are applied by the resolver
  // via defaultPollingForSource().
  responseTimePolling:       null,
  cpuMemoryPolling:          null,
  temperaturePolling:        null,
  interfacesPolling:         null,
  lldpPolling:               null,
  storagePolling:            null,
  processesPolling:          null,
  eventLogPolling:           null,
  // MIB ID hints default to null at the floor — vendor profile selection
  // uses the asset's own manufacturer/model when no tier supplies a MIB.
  responseTimeMibId:         null,
  cpuMemoryMibId:            null,
  temperatureMibId:          null,
  interfacesMibId:           null,
  lldpMibId:                 null,
  processesMibId:            null,
  // Per-stream credential IDs only exist on the class-override tier; tier-3
  // and the floor always carry null and dispatchers fall through.
  responseTimeCredentialId:  null,
  cpuMemoryCredentialId:     null,
  temperatureCredentialId:   null,
  interfacesCredentialId:    null,
  lldpCredentialId:          null,
  processesCredentialId:     null,
  eventLogCredentialId:      null,
};

// The pre-hierarchy single-row `monitorSettings` Setting (and its two
// deprecated legacy types) was retired 2026-11-06
// (CQ-B012), and the boot job that converted and deleted it was retired
// 2026-11-09 (CQ-B013). Nothing at runtime reads it; capacity projections use
// fleetCadences() below — the cadences operators actually configured.
const MANUAL_SETTING_KEY = "manualMonitorSettings";

export const sysUpTimeOid = "1.3.6.1.2.1.1.3.0";

// Per-request timeout for SNMP sessions / FortiOS REST calls inside the
// HEAVY-cadence collectors (collectTelemetry / collectSystemInfo / SNMP walks).
// These walks issue many requests and we want each individual request to fail
// fast on a wedged peer rather than burn the entire walk budget on one OID.
//
// NOT used by the response-time probes — those resolve their timeout through
// `resolveMonitorSettings(asset).probeTimeoutMs` per asset (default 5000ms,
// range 100..60000) and pass it down via the `timeoutMs` argument on every
// probe function.
export const COLLECTOR_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Decide which protocol the AD-locked monitor should use for a given asset OS.
 * Returns null when the OS isn't realm-monitorable, in which case the AD sync
 * leaves the asset unlocked and the operator picks ICMP/SNMP manually.
 *
 * Exported so the AD sync (in integrations.ts) can apply the same lock policy
 * at discovery time as the probe applies at run time.
 */
export function getAdMonitorProtocol(os: string | null | undefined): "winrm" | "ssh" | null {
  if (!os) return null;
  const lower = os.toLowerCase();
  if (lower.includes("windows")) return "winrm";
  if (lower.includes("linux")) return "ssh";
  return null;
}

// ─── Monitor settings resolver ──────────────────────────────────────────────
//
// `resolveMonitorSettings(asset)` is the runtime entry point that walks the
// hierarchy and returns the effective settings for one asset. Tier-3 readers
// (`loadIntegrationTierSettings` / `loadManualTierSettings`) and the class
// override loader memoize their results in module-local Maps, so the hot
// monitor loop can resolve hundreds of assets per pass with only one DB hit
// per (integration/manual) tuple plus one per (tier, assetType) pair.
//
// Cache invalidation is the responsibility of any code that writes to the
// underlying storage — call `invalidateMonitorSettingsCache(scope)` after
// upserting an Integration.config.monitorSettings, the manualMonitorSettings
// row, or a MonitorClassOverride row. The migration job (step 5) calls
// `invalidateMonitorSettingsCache()` (no scope = full clear) at the end.
//
// A tier with no stored settings resolves to HARDCODED_FLOOR (a fresh
// integration before an operator sets its cadences, a fresh install's manual
// tier). The pre-hierarchy legacy row is not consulted: the startup migration
// converts and deletes it, and invalidates this cache when it does.

const MANUAL_TIER_CACHE_KEY = "__manual__";

const tierCache = new Map<string, MonitorTierSettings>();

const classOverrideCache = new Map<string, MonitorOverrideSettings | null>();

/**
 * How long a cached tier or class override is trusted before it is re-read
 * (business rule 176). `invalidateMonitorSettingsCache` only reaches the
 * process that made the change — and on a production install that is the web
 * role, while the resolver that matters runs in the monitor and discovery
 * roles, which are separate processes. Without an expiry a cadence, a polling
 * method or a credential saved in the UI was not applied by the monitor until
 * it restarted, and a deleted integration's settings were never forgotten.
 *
 * An entry is REFRESHED IN PLACE, never dropped: the sidecars below are read
 * synchronously after a resolve, and an expiry that cleared them could make a
 * reader see "no SD-WAN interval" for a moment — which the SD-WAN alert sweep
 * (rule 174) would act on. So a stale entry keeps serving until its reload
 * has overwritten it.
 */
export const MONITOR_SETTINGS_CACHE_TTL_MS = 30_000;

/** When each cache key was last loaded, or claimed for a reload. */
const cacheLoadedAt = new Map<string, number>();

/**
 * Is this key due for a reload? Marks it loaded as it answers "yes", so of
 * many concurrent resolves of one stale key (a monitor pass resolves hundreds
 * of assets at once) exactly one reloads and the rest are served the cached
 * value in the meantime.
 */
function claimReloadIfStale(key: string): boolean {
  const now = Date.now();
  const at = cacheLoadedAt.get(key);
  if (at !== undefined && now - at < MONITOR_SETTINGS_CACHE_TTL_MS) return false;
  cacheLoadedAt.set(key, now);
  return true;
}

// Sidecar: did the cached integration tier-3 derive systemInfoIntervalSeconds
// from Integration.pollInterval (true) or read it from an explicit tier-3
// JSON value (false)? Drives the "integrationPollInterval" provenance label
// in resolveMonitorSettingsWithProvenance so the UI can render
// `Inherit: 14400s (4h, from <integration> discovery cycle)` instead of a
// generic integration-tier badge. Manual-tier rows are not eligible (no
// pollInterval to inherit from).
const tierSystemInfoFromPollIntervalCache = new Map<string, boolean>();

// Sidecar: can this integration make a FortiOS REST call to the device at all?
// Populated by the same load that already reads Integration.config, so the hot
// resolver pays no extra query.
//
// True only for a FortiManager on the PROXY transport with NO FortiGate API
// token configured. That pairing is the one where `rest_api` cannot possibly
// succeed: every FortiOS collector builds its config via buildFortinetConfig(),
// which has no useProxy branch — it dials the asset's own IP and requires
// fortigateApiToken — so the call throws "FortiManager direct-mode API token
// not configured" on every tick.
//
// Note this is NOT simply "proxy mode". A proxy-mode integration WITH a token
// is a legitimate configuration — discovery and writes ride FMG, monitoring
// reaches the gates directly — and its REST streams work fine. Gating on the
// transport alone would break that, and would undo the change that made the
// token reachable in proxy mode in the first place.
const tierFortiosRestUnavailableCache = new Map<string, boolean>();

// Sidecar: the SD-WAN cadence for this (integration, class) — the resolved
// interval in seconds when the integration pulls SD-WAN at all, else null.
// Populated by the same load that reads Integration.config, like the two
// sidecars above, so the due-check on every light tick costs no query.
const tierSdwanIntervalCache = new Map<string, number | null>();

/** SD-WAN cadence bounds. 60s floor: the light loop cannot honour anything
 *  shorter in practice, and a FortiOS health-check reading is itself a
 *  moving average over the probe interval configured on the gate. */
export const SDWAN_INTERVAL_DEFAULT_SEC = 60;

export const SDWAN_INTERVAL_MIN_SEC     = 60;

export const SDWAN_INTERVAL_MAX_SEC     = 86_400;

/**
 * The SD-WAN interval an integration config asks for, or null when it doesn't
 * pull SD-WAN. Only FortiManager / FortiGate carry the stream, and a
 * FortiManager on proxy with no FortiGate token has no REST path to the gate
 * (see tierFortiosRestUnavailableCache) — both read as "not pulled". Pure;
 * exported for unit testing.
 */
export function sdwanIntervalFromConfig(
  type: string | null | undefined,
  cfg: Record<string, unknown>,
  fortiosRestUnavailable: boolean,
): number | null {
  if (!isFortinetIntegrationType(type)) return null;
  if (cfg.pullSdwan !== true) return null;
  if (fortiosRestUnavailable) return null;
  const raw = Number(cfg.sdwanIntervalSeconds);
  if (!Number.isFinite(raw) || raw <= 0) return SDWAN_INTERVAL_DEFAULT_SEC;
  return Math.max(SDWAN_INTERVAL_MIN_SEC, Math.min(SDWAN_INTERVAL_MAX_SEC, Math.floor(raw)));
}

/**
 * The SD-WAN cadence for one asset, read from the sidecar the tier load
 * populated. Call AFTER resolveMonitorSettings for the same asset (both due
 * paths do) — before it, the sidecar may be cold and this reads null. Null =
 * no SD-WAN cadence for this asset: orphan assets, non-Fortinet sources, or
 * the integration's pullSdwan toggle off.
 */
export function resolveSdwanIntervalSec(asset: { discoveredByIntegrationId: string | null; assetType: string }): number | null {
  if (!asset.discoveredByIntegrationId) return null;
  return tierSdwanIntervalCache.get(`${asset.discoveredByIntegrationId}:${asset.assetType}`) ?? null;
}

function classCacheKey(integrationId: string | null, assetType: string): string {
  return `${integrationId ?? MANUAL_TIER_CACHE_KEY}:${assetType}`;
}

/**
 * Drop cached resolver state. Call this whenever the underlying storage
 * changes (integration save, manual-tier save, class-override CRUD,
 * migration job). Without a scope, clears everything.
 */
export function invalidateMonitorSettingsCache(scope?: {
  integrationId?: string | null;
  assetType?: string;
}): void {
  if (!scope) {
    cacheLoadedAt.clear();
    tierCache.clear();
    classOverrideCache.clear();
    tierSystemInfoFromPollIntervalCache.clear();
    tierFortiosRestUnavailableCache.clear();
    tierSdwanIntervalCache.clear();
    return;
  }
  const tierKey = scope.integrationId === null ? MANUAL_TIER_CACHE_KEY : scope.integrationId;
  if (tierKey != null) {
    if (tierKey === MANUAL_TIER_CACHE_KEY) {
      // Manual tier is a single cached entry (no per-class branches), so the
      // legacy key clear still works.
      tierCache.delete(MANUAL_TIER_CACHE_KEY);
      tierSystemInfoFromPollIntervalCache.delete(MANUAL_TIER_CACHE_KEY);
      tierFortiosRestUnavailableCache.delete(MANUAL_TIER_CACHE_KEY);
    } else if (scope.assetType) {
      // Per-class evict — Phase 2 cache key is `${integrationId}:${assetType}`.
      const k = `${tierKey}:${scope.assetType}`;
      tierCache.delete(k);
      tierSystemInfoFromPollIntervalCache.delete(k);
      tierFortiosRestUnavailableCache.delete(k);
      tierSdwanIntervalCache.delete(k);
    } else {
      // Whole-integration evict — walk every `<integrationId>:<assetType>`
      // entry. Integration config writes (PUT /integrations/:id, per-class
      // streams edits) hit this path so every assetType variant refreshes.
      for (const k of Array.from(tierCache.keys())) {
        if (k.startsWith(`${tierKey}:`)) {
          tierCache.delete(k);
          tierSystemInfoFromPollIntervalCache.delete(k);
          tierFortiosRestUnavailableCache.delete(k);
          tierSdwanIntervalCache.delete(k);
        }
      }
    }
    if (scope.assetType) {
      classOverrideCache.delete(`${tierKey}:${scope.assetType}`);
    } else {
      for (const k of Array.from(classOverrideCache.keys())) {
        if (k.startsWith(`${tierKey}:`)) classOverrideCache.delete(k);
      }
    }
  } else {
    // No tier identified — fall back to a full class-cache clear.
    classOverrideCache.clear();
  }
}

function readPollingFromJson(v: Record<string, unknown> | undefined, key: string): PollingMethod | null {
  if (!v) return null;
  const raw = v[key];
  return isPollingMethod(raw) ? raw : null;
}

function tierFromJson(v: Record<string, unknown> | null | undefined): MonitorTierSettings {
  const o = v ?? {};
  // Per-stream polling may be stored in one of two shapes depending on which
  // code path wrote it:
  //   nested (original design): { polling: { responseTime, telemetry, interfaces, lldp } }
  //   flat   (route writes):    { responseTimePolling, telemetryPolling, ... }
  // Try nested first; fall back to the flat key so both formats work.
  const pollingBlock = (o.polling as Record<string, unknown> | undefined) ?? undefined;
  const flat = o as Record<string, unknown>;
  // Stream-split migration compatibility: tier-3 JSON written before the
  // split carried `telemetryIntervalSeconds` / `telemetryTimeoutMs` /
  // `telemetryPolling` / `telemetryMibId`. The migration SQL rewrites those
  // keys in-place, but a fresh install booting against an older row (e.g.
  // recovery / replay) needs the fallback so existing operator selections
  // carry forward identically.
  const legacyInterval = toPositiveIntOr(o.telemetryIntervalSeconds, null);
  const legacyTimeout  = toPositiveIntOr(o.telemetryTimeoutMs,        null);
  return {
    intervalSeconds:            toNonNegativeInt(o.intervalSeconds,           HARDCODED_FLOOR.intervalSeconds),
    failureThreshold:           toNonNegativeInt(o.failureThreshold,          HARDCODED_FLOOR.failureThreshold),
    fastConfirmIntervalSec:     toNonNegativeInt(o.fastConfirmIntervalSec,    HARDCODED_FLOOR.fastConfirmIntervalSec),
    probeTimeoutMs:             toNonNegativeInt(o.probeTimeoutMs,            HARDCODED_FLOOR.probeTimeoutMs),
    cpuMemoryTimeoutMs:         toNonNegativeInt(o.cpuMemoryTimeoutMs,        legacyTimeout  ?? HARDCODED_FLOOR.cpuMemoryTimeoutMs),
    temperatureTimeoutMs:       toNonNegativeInt(o.temperatureTimeoutMs,      legacyTimeout  ?? HARDCODED_FLOOR.temperatureTimeoutMs),
    systemInfoTimeoutMs:        toNonNegativeInt(o.systemInfoTimeoutMs,       HARDCODED_FLOOR.systemInfoTimeoutMs),
    cpuMemoryIntervalSeconds:   toNonNegativeInt(o.cpuMemoryIntervalSeconds,  legacyInterval ?? HARDCODED_FLOOR.cpuMemoryIntervalSeconds),
    temperatureIntervalSeconds: toNonNegativeInt(o.temperatureIntervalSeconds, legacyInterval ?? HARDCODED_FLOOR.temperatureIntervalSeconds),
    systemInfoIntervalSeconds:  toNonNegativeInt(o.systemInfoIntervalSeconds, HARDCODED_FLOOR.systemInfoIntervalSeconds),
    // Phase 1 wrote lldpIntervalSeconds / lldpTimeoutMs / storageIntervalSeconds
    // / storageTimeoutMs as additive flat keys on the integration-tier JSON
    // before the per-class streams blocks existed. Continue to read them here
    // as the integration-tier default; per-class streams entries override at
    // dispatch time via loadIntegrationTierSettings(.., assetType).
    lldpIntervalSeconds:        toNonNegativeInt(o.lldpIntervalSeconds,       HARDCODED_FLOOR.lldpIntervalSeconds),
    lldpTimeoutMs:              toNonNegativeInt(o.lldpTimeoutMs,             HARDCODED_FLOOR.lldpTimeoutMs),
    storageIntervalSeconds:     toNonNegativeInt(o.storageIntervalSeconds,    HARDCODED_FLOOR.storageIntervalSeconds),
    storageTimeoutMs:           toNonNegativeInt(o.storageTimeoutMs,          HARDCODED_FLOOR.storageTimeoutMs),
    processesIntervalSeconds:   toNonNegativeInt(o.processesIntervalSeconds,  HARDCODED_FLOOR.processesIntervalSeconds),
    processesTimeoutMs:         toNonNegativeInt(o.processesTimeoutMs,        HARDCODED_FLOOR.processesTimeoutMs),
    eventLogIntervalSeconds:    toNonNegativeInt(o.eventLogIntervalSeconds,   HARDCODED_FLOOR.eventLogIntervalSeconds),
    eventLogTimeoutMs:          toNonNegativeInt(o.eventLogTimeoutMs,         HARDCODED_FLOOR.eventLogTimeoutMs),
    sampleRetentionDays:        toNonNegativeInt(o.sampleRetentionDays,       HARDCODED_FLOOR.sampleRetentionDays),
    telemetryRetentionDays:     toNonNegativeInt(o.telemetryRetentionDays,    HARDCODED_FLOOR.telemetryRetentionDays),
    systemInfoRetentionDays:    toNonNegativeInt(o.systemInfoRetentionDays,   HARDCODED_FLOOR.systemInfoRetentionDays),
    responseTimePolling:        readPollingFromJson(pollingBlock, "responseTime") ?? readPollingFromJson(flat, "responseTimePolling"),
    cpuMemoryPolling:           readPollingFromJson(pollingBlock, "cpuMemory")    ?? readPollingFromJson(flat, "cpuMemoryPolling")    ?? readPollingFromJson(pollingBlock, "telemetry") ?? readPollingFromJson(flat, "telemetryPolling"),
    temperaturePolling:         readPollingFromJson(pollingBlock, "temperature")  ?? readPollingFromJson(flat, "temperaturePolling")  ?? readPollingFromJson(pollingBlock, "telemetry") ?? readPollingFromJson(flat, "telemetryPolling"),
    interfacesPolling:          readPollingFromJson(pollingBlock, "interfaces")   ?? readPollingFromJson(flat, "interfacesPolling"),
    lldpPolling:                readPollingFromJson(pollingBlock, "lldp")         ?? readPollingFromJson(flat, "lldpPolling"),
    storagePolling:             readPollingFromJson(pollingBlock, "storage")      ?? readPollingFromJson(flat, "storagePolling"),
    processesPolling:           readPollingFromJson(pollingBlock, "processes")    ?? readPollingFromJson(flat, "processesPolling"),
    eventLogPolling:            readPollingFromJson(pollingBlock, "eventLog")     ?? readPollingFromJson(flat, "eventLogPolling"),
    responseTimeMibId:          readMibIdFromJson(flat.responseTimeMibId),
    cpuMemoryMibId:             readMibIdFromJson(flat.cpuMemoryMibId)   ?? readMibIdFromJson(flat.telemetryMibId),
    temperatureMibId:           readMibIdFromJson(flat.temperatureMibId) ?? readMibIdFromJson(flat.telemetryMibId),
    interfacesMibId:            readMibIdFromJson(flat.interfacesMibId),
    lldpMibId:                  readMibIdFromJson(flat.lldpMibId),
    processesMibId:             readMibIdFromJson(flat.processesMibId),
    // Tier-3 storage doesn't carry per-stream credentials — they only live
    // on the class-override row (tier-2). Always null here; loadClassOverride
    // surfaces the real values, and resolveMonitorSettings merges them onto
    // the final resolved object.
    responseTimeCredentialId:   null,
    cpuMemoryCredentialId:      null,
    temperatureCredentialId:    null,
    interfacesCredentialId:     null,
    lldpCredentialId:           null,
    processesCredentialId:      null,
    eventLogCredentialId:       null,
  };
}

// Like toPositiveInt but returns the fallback as-is (including null) when
// the input isn't a positive integer. Used by the stream-split tierFromJson
// to chain legacy-key fallback before defaulting to the hardcoded floor.
function toPositiveIntOr(v: unknown, fallback: number | null): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return Math.trunc(v);
  return fallback;
}

function readMibIdFromJson(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * Source-default polling method per stream. Used when no tier (integration,
 * class, asset) supplies a value and we need *something* to start with.
 *
 * - FMG / FortiGate: REST API for every stream — the integration's stored
 *   API token covers all four.
 * - AD / Entra / Windows Server: only the response-time stream is supported
 *   on these hosts, and ICMP is the safest "everything works" baseline. The
 *   other three streams default to null so the System tab politely says
 *   "not delivered for this asset".
 * - Manual: ICMP for response-time only — operator must explicitly pick a
 *   credentialed method (and a credential) to enable telemetry/interfaces
 *   on a manually-created asset.
 */
/**
 * When a FortiOS REST call cannot be assembled (FMG on the proxy transport with
 * no FortiGate API token), which (stream, assetType) pairs can STILL ride
 * `rest_api`?
 *
 * Exactly one: response time for a managed FortiSwitch or FortiAP. That read
 * goes to the PARENT gate's controller table through fetchViaFortinetTransport,
 * which is the one monitoring path that honours `useProxy` and therefore works
 * with FMG's own credential. Everything else — including a firewall's own
 * response-time probe — goes through buildFortinetConfig() and needs the direct
 * token.
 *
 * Shared by the source default and the resolver's validity gate so the two
 * cannot disagree about what is collectable.
 */
function fortiosRestUsable(stream: Stream, assetType: string | null | undefined): boolean {
  const isManagedChild = assetType === "switch" || assetType === "access_point";
  return stream === "responseTime" && isManagedChild;
}

export function defaultPollingForSource(
  source: AssetSourceKind,
  stream: Stream,
  opts?: { assetType?: string | null; fortiosRestUnavailable?: boolean; hasIp?: boolean },
): PollingMethod | null {
  // Cross-transport streams default to "disabled" everywhere — they're opt-in
  // (operator picks agent / SNMP / SSH / WinRM, or REST for eventLog on a
  // FortiGate). Keeping them off by default means no behavior change for
  // existing fleets until an operator turns them on at some tier.
  if (stream === "processes" || stream === "eventLog") return "disabled";

  // ── FortiManager proxy transport with no FortiGate API token ─────────────
  // The REST defaults below assume Polaris can make a FortiOS call to the
  // device. On an FMG in proxy mode with no direct token that is impossible:
  // every FortiOS collector builds its config via buildFortinetConfig(), which
  // has no useProxy branch — it dials the asset's own IP and requires
  // fortigateApiToken. So `rest_api` on cpuMemory / temperature / interfaces
  // meant a 409 every tick, forever, on an integration left at its defaults.
  //
  // `disabled` is the honest state: Polaris is not collecting these, and now
  // says so instead of failing repeatedly. Supplying the token flips this
  // condition off and the normal REST defaults return — so this narrows what
  // Polaris CLAIMS, never what it can do.
  //
  // Response time is deliberately UNCHANGED (icmp). Pointing it elsewhere would
  // silently change how up/down is decided for every gate on every affected
  // install, which is not a default's business.
  //
  // Managed switches and APs are the exception: their responseTime rides the
  // parent gate's controller table via fetchViaFortinetTransport, which IS
  // transport-aware and genuinely works through the proxy with no direct token.
  // That is the one FortiOS read proxy mode serves by itself, so it stays on
  // rest_api — downgrading it to icmp would be a real regression, since plenty
  // of FortiLink-managed devices are not directly pingable.
  if (opts?.fortiosRestUnavailable && source === "fortimanager") {
    if (fortiosRestUsable(stream, opts.assetType)) return "rest_api";
    if (stream === "responseTime") return "icmp";
    return "disabled";
  }

  if (isFortinetIntegrationType(source)) {
    // FortiOS exposes lldp-neighbors but most fleets don't enable LLDP per
    // interface, so the endpoint returns nothing on every probe. Default
    // off; operators flip to rest_api when their fleet actually has it.
    if (stream === "lldp") return "disabled";
    // FortiOS appliances don't expose meaningful mountable storage; default
    // off so the SNMP storage walk doesn't run wasted scrapes against every
    // FortiGate / FortiSwitch / FortiAP. Operators opt in by picking SNMP.
    if (stream === "storage") return "disabled";
    // Response Time is the cheapest probe — ICMP is the universal default
    // for routable devices. CPU/mem/interfaces/temperature still default to
    // REST API because that's where the data actually is.
    if (stream === "responseTime") return "icmp";
    return "rest_api";
  }
  // Azure Arc rides the directory defaults: an Arc-enabled machine is an
  // ordinary Windows/Linux host, and the Connected Machine agent is a cloud
  // control-plane link Polaris can't poll through.
  if (source === "activedirectory" || source === "entraid" || source === "windowsserver" || source === "azurearc") {
    return stream === "responseTime" ? "icmp" : null;
  }
  if (source === "vcenter") {
    // Everything vCenter can answer for, it answers for. Response time
    // (power / connection state), CPU/memory, interfaces and storage all come
    // out of ONE batched fetch per integration per tick — no credential on the
    // device, no SNMP to enable on ESXi, and for a VM no reachable guest IP.
    // ICMP was the response-time default until 2026-08 and was the wrong
    // question twice over: it needs an IP the guest may not expose to Polaris,
    // and it answers "did a packet come back" when the operator is asking
    // "is this VM running".
    //
    // Temperature and LLDP stay null: ESXi numeric sensors are not collected
    // yet, and neither role publishes LLDP.
    if (stream === "responseTime" || stream === "cpuMemory"
        || stream === "interfaces" || stream === "storage") return "vcenter";
    return null;
  }
  if (source === "unraid" || source === "truenas" || source === "proxmox") {
    // Response time is ICMP whenever there is an address to ping (operator
    // decision 2026-10-07): the API-state probe's "response time" was the
    // whole host-API round trip — hundreds of ms of GraphQL / JSON-RPC, not
    // the workload. A workload with no address of its own (a bridged
    // container, a VM whose guest IP the platform does not publish) keeps the
    // platform's state check — ICMP there would fail every probe and call a
    // running container down. That probe reports 0 ms (probeWorkload).
    if (stream === "responseTime") return opts?.hasIp ? "icmp" : source;
    // A container / App: CPU / memory and its own network's traffic. It has
    // no disks or sensors of its own — those are its host's — so storage and
    // temperature are left uncollected rather than asked and answered empty.
    if (opts?.assetType === "container") {
      return stream === "cpuMemory" || stream === "interfaces" ? source : null;
    }
    // Everything else the host's API answers for, it answers for, out of ONE
    // cached read per integration per tick. Temperature too — a NAS reports
    // its disks' temperatures, which land on the host as `sensorClass:
    // "disk"` readings — on Unraid / TrueNAS; Proxmox publishes no sensors
    // (PROXMOX_STREAMS). LLDP is never published.
    if (stream === "cpuMemory" || stream === "interfaces" || stream === "storage") return source;
    if (stream === "temperature") return source === "proxmox" ? null : source;
    return null;
  }
  // manual — and genericapi, deliberately: a Generic API record can be any
  // device, so nothing beyond the ICMP response time is collected until an
  // operator picks a transport and a credential for it.
  return stream === "responseTime" ? "icmp" : null;
}

/**
 * Picks the per-class streams block on the integration config for the given
 * assetType. FMG / FortiGate route firewall→fortigateMonitor, switch→
 * fortiswitchMonitor, access_point→fortiapMonitor; AD / Entra / Windows
 * Server / Azure Arc route workstation→workstationMonitor, server→
 * serverMonitor (Arc deliberately reuses the directory block names). Every
 * other (assetType, integration-type) pair returns undefined so the resolver
 * falls back to the flat `monitorSettings` JSON for that asset class.
 */
function pickClassStreamsBlock(
  integrationType: string | null,
  cfg: Record<string, unknown>,
  assetType: string,
): Record<string, unknown> | undefined {
  if (isFortinetIntegrationType(integrationType)) {
    let block: Record<string, unknown> | undefined;
    if (assetType === "firewall")          block = cfg.fortigateMonitor   as Record<string, unknown> | undefined;
    else if (assetType === "switch")       block = cfg.fortiswitchMonitor as Record<string, unknown> | undefined;
    else if (assetType === "access_point") block = cfg.fortiapMonitor     as Record<string, unknown> | undefined;
    if (!block) return undefined;
    const streams = block.streams as Record<string, unknown> | undefined;
    return streams && typeof streams === "object" ? streams : undefined;
  }
  // Azure Arc clusters are the one Arc class that isn't workstation/server
  // shaped, so they get their own reduced block (no agent, no interface or
  // storage auto-monitor) — same posture as vCenter's hostMonitor.
  if (integrationType === "azurearc" && assetType === "kubernetes_cluster") {
    const block = cfg.k8sMonitor as Record<string, unknown> | undefined;
    if (!block) return undefined;
    const streams = block.streams as Record<string, unknown> | undefined;
    return streams && typeof streams === "object" ? streams : undefined;
  }
  if (integrationType === "activedirectory" || integrationType === "entraid"
      || integrationType === "windowsserver" || integrationType === "azurearc") {
    let block: Record<string, unknown> | undefined;
    if (assetType === "workstation") block = cfg.workstationMonitor as Record<string, unknown> | undefined;
    else if (assetType === "server")  block = cfg.serverMonitor      as Record<string, unknown> | undefined;
    if (!block) return undefined;
    const streams = block.streams as Record<string, unknown> | undefined;
    return streams && typeof streams === "object" ? streams : undefined;
  }
  if (isWorkloadPlatform(integrationType)) {
    // vCenter's block names plus containerMonitor (monitorOverrideService).
    let block: Record<string, unknown> | undefined;
    if (assetType === "server")          block = cfg.vmMonitor        as Record<string, unknown> | undefined;
    else if (assetType === "hypervisor") block = cfg.hostMonitor      as Record<string, unknown> | undefined;
    else if (assetType === "container")  block = cfg.containerMonitor as Record<string, unknown> | undefined;
    if (!block) return undefined;
    const streams = block.streams as Record<string, unknown> | undefined;
    return streams && typeof streams === "object" ? streams : undefined;
  }
  if (integrationType === "vcenter") {
    // vCenter VMs are typed "server" (the virtual_machine built-in was
    // retired 2026-07); the class block kept its vmMonitor name.
    let block: Record<string, unknown> | undefined;
    if (assetType === "server")            block = cfg.vmMonitor   as Record<string, unknown> | undefined;
    else if (assetType === "hypervisor")   block = cfg.hostMonitor as Record<string, unknown> | undefined;
    if (!block) return undefined;
    const streams = block.streams as Record<string, unknown> | undefined;
    return streams && typeof streams === "object" ? streams : undefined;
  }
  return undefined;
}

/**
 * Overlay a per-class streams block onto a tier-3 baseline. Each stream
 * carries up to 6 fields (polling / credentialId / intervalSeconds /
 * timeoutMs / failureThreshold / mibId); non-null values win over the
 * baseline, null/undefined leaves the baseline in place. Mutates `base`
 * in place and returns it for chaining convenience.
 */
// The 8-stream → MonitorTierSettings field-name map, declared ONCE and walked
// by both the value applier (applyClassStreamsOverlay) and the provenance
// detector (detectPerClassFieldOrigins) so the two can never disagree on
// which cell a stream field lands in. `failureThreshold` exists only on
// responseTime (the only stream with a failure counter); `mibId` is absent
// where the stream has no MIB selector.
type ClassStreamKey = "responseTime" | "cpuMemory" | "temperature" | "interfaces" | "lldp" | "storage" | "processes" | "eventLog";

type ClassStreamCells = {
  polling:           keyof MonitorTierSettings;
  credentialId:      keyof MonitorTierSettings;
  intervalSeconds:   keyof MonitorTierSettings;
  timeoutMs:         keyof MonitorTierSettings;
  mibId?:            keyof MonitorTierSettings;
  failureThreshold?: keyof MonitorTierSettings;
  fastConfirmIntervalSec?: keyof MonitorTierSettings;
};

const CLASS_STREAM_FIELD_MAP: Record<ClassStreamKey, ClassStreamCells> = {
  responseTime: { polling: "responseTimePolling", credentialId: "responseTimeCredentialId", intervalSeconds: "intervalSeconds",            timeoutMs: "probeTimeoutMs",        mibId: "responseTimeMibId", failureThreshold: "failureThreshold", fastConfirmIntervalSec: "fastConfirmIntervalSec" },
  cpuMemory:    { polling: "cpuMemoryPolling",    credentialId: "cpuMemoryCredentialId",    intervalSeconds: "cpuMemoryIntervalSeconds",   timeoutMs: "cpuMemoryTimeoutMs",    mibId: "cpuMemoryMibId" },
  temperature:  { polling: "temperaturePolling",  credentialId: "temperatureCredentialId",  intervalSeconds: "temperatureIntervalSeconds", timeoutMs: "temperatureTimeoutMs",  mibId: "temperatureMibId" },
  interfaces:   { polling: "interfacesPolling",   credentialId: "interfacesCredentialId",   intervalSeconds: "systemInfoIntervalSeconds",  timeoutMs: "systemInfoTimeoutMs",   mibId: "interfacesMibId" },
  lldp:         { polling: "lldpPolling",         credentialId: "lldpCredentialId",         intervalSeconds: "lldpIntervalSeconds",        timeoutMs: "lldpTimeoutMs",         mibId: "lldpMibId" },
  storage:      { polling: "storagePolling",      credentialId: "interfacesCredentialId",   intervalSeconds: "storageIntervalSeconds",     timeoutMs: "storageTimeoutMs" },
  processes:    { polling: "processesPolling",    credentialId: "processesCredentialId",    intervalSeconds: "processesIntervalSeconds",   timeoutMs: "processesTimeoutMs",    mibId: "processesMibId" },
  eventLog:     { polling: "eventLogPolling",     credentialId: "eventLogCredentialId",     intervalSeconds: "eventLogIntervalSeconds",    timeoutMs: "eventLogTimeoutMs" },
};

/**
 * Walk a per-class streams block, calling `visit(tierField, value)` for every
 * populated (validity-checked) stream field. The applier assigns, the
 * provenance detector marks — same guards, one walker.
 */
function walkClassStreams(
  streams: Record<string, unknown>,
  visit: (field: keyof MonitorTierSettings, value: unknown) => void,
): void {
  for (const key of Object.keys(CLASS_STREAM_FIELD_MAP) as ClassStreamKey[]) {
    const stream = streams[key] as Record<string, unknown> | null | undefined;
    if (!stream || typeof stream !== "object") continue;
    const cells = CLASS_STREAM_FIELD_MAP[key];
    if ("polling" in stream && isPollingMethod(stream.polling)) visit(cells.polling, stream.polling);
    if ("credentialId" in stream && typeof stream.credentialId === "string" && stream.credentialId.length > 0) visit(cells.credentialId, stream.credentialId);
    if ("intervalSeconds" in stream && typeof stream.intervalSeconds === "number" && stream.intervalSeconds > 0) visit(cells.intervalSeconds, stream.intervalSeconds);
    if ("timeoutMs" in stream && typeof stream.timeoutMs === "number" && stream.timeoutMs > 0) visit(cells.timeoutMs, stream.timeoutMs);
    if (cells.mibId && "mibId" in stream && typeof stream.mibId === "string" && stream.mibId.length > 0) visit(cells.mibId, stream.mibId);
    if (cells.failureThreshold && "failureThreshold" in stream && typeof stream.failureThreshold === "number" && stream.failureThreshold > 0) visit(cells.failureThreshold, stream.failureThreshold);
    if (cells.fastConfirmIntervalSec && "fastConfirmIntervalSec" in stream && typeof stream.fastConfirmIntervalSec === "number" && stream.fastConfirmIntervalSec > 0) visit(cells.fastConfirmIntervalSec, stream.fastConfirmIntervalSec);
  }
}

function applyClassStreamsOverlay(
  base: MonitorTierSettings,
  streams: Record<string, unknown> | undefined,
): MonitorTierSettings {
  if (!streams) return base;
  walkClassStreams(streams, (field, value) => {
    (base as any)[field] = value;
  });
  return base;
}

/**
 * Walk a per-class streams block and report which MonitorTierSettings fields
 * the block actually populates. Used by resolveMonitorSettingsWithProvenance
 * to label per-class-contributed fields as "integration-class" provenance.
 * Returns a partial map (field → true) — fields the block left null/missing
 * are absent from the result.
 */
function detectPerClassFieldOrigins(
  streams: Record<string, unknown>,
): Partial<Record<keyof MonitorTierSettings, true>> {
  const out: Partial<Record<keyof MonitorTierSettings, true>> = {};
  walkClassStreams(streams, (field) => {
    out[field] = true;
  });
  return out;
}

/**
 * Tier-3 loader. `assetType` selects which per-class streams block applies
 * on top of the flat `monitorSettings` baseline:
 *   - fortimanager / fortigate: firewall→fortigateMonitor.streams,
 *     switch→fortiswitchMonitor.streams, access_point→fortiapMonitor.streams.
 *     Other asset types (endpoint workstation / server / printer / router /
 *     other discovered via FortiGate DHCP) fall back to the flat baseline.
 *   - activedirectory / entraid / windowsserver: workstation→
 *     workstationMonitor.streams, server→serverMonitor.streams. Other types
 *     fall back to the flat baseline.
 *   - any other integration type: flat baseline only.
 * Cached keyed on `${integrationId}:${assetType}`, so each (integration, class)
 * pair is read at most once per MONITOR_SETTINGS_CACHE_TTL_MS; a write in this
 * process routes through invalidateMonitorSettingsCache and is seen at once,
 * a write in another process within the TTL (rule 176).
 */
async function loadIntegrationTierSettings(integrationId: string, assetType: string): Promise<MonitorTierSettings> {
  const cacheKey = `${integrationId}:${assetType}`;
  const cached = tierCache.get(cacheKey);
  if (cached && !claimReloadIfStale(`tier:${cacheKey}`)) return cached;
  const integration = await prisma.integration.findUnique({
    where:  { id: integrationId },
    select: { config: true, pollInterval: true, type: true },
  });
  const cfg = (integration?.config as Record<string, unknown> | null) ?? {};
  const ms  = cfg.monitorSettings as Record<string, unknown> | undefined;
  let result: MonitorTierSettings;
  if (ms) {
    result = tierFromJson(ms);
  } else {
    // Nothing stored for this tier yet: the hard-coded floor.
    result = { ...HARDCODED_FLOOR };
  }
  // Per-class streams overlay. Phase 2: when the integration config carries a
  // class-specific streams block for this asset's assetType, its per-stream
  // values win over the flat baseline.
  const classStreams = pickClassStreamsBlock(integration?.type ?? null, cfg, assetType);
  applyClassStreamsOverlay(result, classStreams);
  // systemInfo cadence linkage: when the integration tier doesn't explicitly
  // set systemInfoIntervalSeconds, derive it from the integration's discovery
  // pollInterval. Keeps interface / LLDP / storage / IPsec collection on the
  // same schedule as discovery, slashing interface-sample volume by 24× at
  // the default 4h pollInterval. Explicit class / per-asset overrides still
  // win — this only affects the tier-3 baseline.
  //   - ms missing                → derive (tier-3 not yet seeded)
  //   - ms.systemInfoIntervalSeconds is number > 0  → respect operator value
  //   - ms.systemInfoIntervalSeconds is null / missing / non-positive → derive
  // Also respects an explicit per-class streams override — when the per-class
  // interfaces.intervalSeconds is set, the overlay above already moved the
  // value into result.systemInfoIntervalSeconds. We detect that by comparing
  // against the pre-overlay tier value.
  const classInterfacesInterval = (classStreams?.interfaces as Record<string, unknown> | undefined)?.intervalSeconds;
  const hasExplicitClassInterfaces = typeof classInterfacesInterval === "number" && classInterfacesInterval > 0;
  const rawSysInfo = ms ? (ms as Record<string, unknown>).systemInfoIntervalSeconds : undefined;
  const explicitTierSystemInfo = typeof rawSysInfo === "number" && rawSysInfo > 0;
  let systemInfoFromPollInterval = false;
  if (!hasExplicitClassInterfaces && !explicitTierSystemInfo && integration?.pollInterval != null && integration.pollInterval > 0) {
    const derived = Math.max(60, Math.min(86400, integration.pollInterval * 3600));
    result.systemInfoIntervalSeconds = derived;
    systemInfoFromPollInterval = true;
  }
  tierCache.set(cacheKey, result);
  cacheLoadedAt.set(`tier:${cacheKey}`, Date.now());
  tierSystemInfoFromPollIntervalCache.set(cacheKey, systemInfoFromPollInterval);
  // Proxy is the DEFAULT on a FortiManager integration, so an absent flag is
  // proxy — the same `!== false` reading every other consumer uses. Presence of
  // the token is what decides whether REST is reachable at all; its value is
  // never needed here.
  const fortiosRestUnavailable =
    integration?.type === "fortimanager" &&
    cfg.useProxy !== false &&
    !String(cfg.fortigateApiToken || "").trim();
  tierFortiosRestUnavailableCache.set(cacheKey, fortiosRestUnavailable);
  tierSdwanIntervalCache.set(cacheKey, sdwanIntervalFromConfig(integration?.type, cfg, fortiosRestUnavailable));
  return result;
}

async function loadManualTierSettings(): Promise<MonitorTierSettings> {
  // Manual tier has no per-class blocks — one Setting row covers every asset
  // class. Keep the legacy sentinel cache key so the existing
  // invalidateMonitorSettingsCache({integrationId: null}) clear stays
  // single-key (instead of the per-class prefix-walk it does for integrations).
  const cached = tierCache.get(MANUAL_TIER_CACHE_KEY);
  if (cached && !claimReloadIfStale(`tier:${MANUAL_TIER_CACHE_KEY}`)) return cached;
  const row = await prisma.setting.findUnique({ where: { key: MANUAL_SETTING_KEY } });
  let result: MonitorTierSettings;
  if (row?.value) {
    result = tierFromJson(row.value as Record<string, unknown>);
  } else {
    // Nothing stored for this tier yet: the hard-coded floor.
    result = { ...HARDCODED_FLOOR };
  }
  tierCache.set(MANUAL_TIER_CACHE_KEY, result);
  cacheLoadedAt.set(`tier:${MANUAL_TIER_CACHE_KEY}`, Date.now());
  return result;
}

async function loadClassOverride(
  integrationId: string | null,
  assetType: string,
): Promise<MonitorOverrideSettings | null> {
  const key = classCacheKey(integrationId, assetType);
  if (classOverrideCache.has(key) && !claimReloadIfStale(`class:${key}`)) return classOverrideCache.get(key) ?? null;
  const row = await prisma.monitorClassOverride.findFirst({
    where: { integrationId, assetType },
    select: {
      intervalSeconds:            true,
      failureThreshold:           true,
      fastConfirmIntervalSec:     true,
      probeTimeoutMs:             true,
      cpuMemoryTimeoutMs:         true,
      temperatureTimeoutMs:       true,
      systemInfoTimeoutMs:        true,
      cpuMemoryIntervalSeconds:   true,
      temperatureIntervalSeconds: true,
      systemInfoIntervalSeconds:  true,
      sampleRetentionDays:        true,
      telemetryRetentionDays:     true,
      systemInfoRetentionDays:    true,
      responseTimePolling:        true,
      cpuMemoryPolling:           true,
      temperaturePolling:         true,
      interfacesPolling:          true,
      lldpPolling:                true,
      storagePolling:             true,
      processesPolling:           true,
      eventLogPolling:            true,
      responseTimeMibId:          true,
      cpuMemoryMibId:             true,
      temperatureMibId:           true,
      interfacesMibId:            true,
      lldpMibId:                  true,
      processesMibId:             true,
      responseTimeCredentialId:   true,
      cpuMemoryCredentialId:      true,
      temperatureCredentialId:    true,
      interfacesCredentialId:     true,
      lldpCredentialId:           true,
      processesCredentialId:      true,
      eventLogCredentialId:       true,
      processesIntervalSeconds:   true,
      eventLogIntervalSeconds:    true,
      processesTimeoutMs:         true,
      eventLogTimeoutMs:          true,
    },
  });
  let result: MonitorOverrideSettings | null = null;
  if (row) {
    result = {};
    if (row.intervalSeconds            != null) result.intervalSeconds            = row.intervalSeconds;
    if (row.failureThreshold           != null) result.failureThreshold           = row.failureThreshold;
    if (row.fastConfirmIntervalSec     != null) result.fastConfirmIntervalSec     = row.fastConfirmIntervalSec;
    if (row.probeTimeoutMs             != null) result.probeTimeoutMs             = row.probeTimeoutMs;
    if (row.cpuMemoryTimeoutMs         != null) result.cpuMemoryTimeoutMs         = row.cpuMemoryTimeoutMs;
    if (row.temperatureTimeoutMs       != null) result.temperatureTimeoutMs       = row.temperatureTimeoutMs;
    if (row.systemInfoTimeoutMs        != null) result.systemInfoTimeoutMs        = row.systemInfoTimeoutMs;
    if (row.cpuMemoryIntervalSeconds   != null) result.cpuMemoryIntervalSeconds   = row.cpuMemoryIntervalSeconds;
    if (row.temperatureIntervalSeconds != null) result.temperatureIntervalSeconds = row.temperatureIntervalSeconds;
    if (row.systemInfoIntervalSeconds  != null) result.systemInfoIntervalSeconds  = row.systemInfoIntervalSeconds;
    if (row.sampleRetentionDays        != null) result.sampleRetentionDays        = row.sampleRetentionDays;
    if (row.telemetryRetentionDays     != null) result.telemetryRetentionDays     = row.telemetryRetentionDays;
    if (row.systemInfoRetentionDays    != null) result.systemInfoRetentionDays    = row.systemInfoRetentionDays;
    // Polling columns are nullable strings; only adopt them when they pass
    // the type guard so a stale legacy value (e.g. "rest") in the DB doesn't
    // smuggle through as a typed PollingMethod here. Bad values are silently
    // dropped — the resolver falls through to the next tier.
    if (isPollingMethod(row.responseTimePolling)) result.responseTimePolling = row.responseTimePolling;
    if (isPollingMethod(row.cpuMemoryPolling))    result.cpuMemoryPolling    = row.cpuMemoryPolling;
    if (isPollingMethod(row.temperaturePolling))  result.temperaturePolling  = row.temperaturePolling;
    if (isPollingMethod(row.interfacesPolling))   result.interfacesPolling   = row.interfacesPolling;
    if (isPollingMethod(row.lldpPolling))         result.lldpPolling         = row.lldpPolling;
    if (isPollingMethod(row.storagePolling))      result.storagePolling      = row.storagePolling;
    if (isPollingMethod(row.processesPolling))    result.processesPolling    = row.processesPolling;
    if (isPollingMethod(row.eventLogPolling))     result.eventLogPolling     = row.eventLogPolling;
    if (row.responseTimeMibId)                    result.responseTimeMibId   = row.responseTimeMibId;
    if (row.cpuMemoryMibId)                       result.cpuMemoryMibId      = row.cpuMemoryMibId;
    if (row.temperatureMibId)                     result.temperatureMibId    = row.temperatureMibId;
    if (row.interfacesMibId)                      result.interfacesMibId     = row.interfacesMibId;
    if (row.lldpMibId)                            result.lldpMibId           = row.lldpMibId;
    if (row.processesMibId)                       result.processesMibId      = row.processesMibId;
    if (row.responseTimeCredentialId)             result.responseTimeCredentialId  = row.responseTimeCredentialId;
    if (row.cpuMemoryCredentialId)                result.cpuMemoryCredentialId     = row.cpuMemoryCredentialId;
    if (row.temperatureCredentialId)              result.temperatureCredentialId   = row.temperatureCredentialId;
    if (row.interfacesCredentialId)               result.interfacesCredentialId    = row.interfacesCredentialId;
    if (row.lldpCredentialId)                     result.lldpCredentialId          = row.lldpCredentialId;
    if (row.processesCredentialId)                result.processesCredentialId     = row.processesCredentialId;
    if (row.eventLogCredentialId)                 result.eventLogCredentialId      = row.eventLogCredentialId;
    if (row.processesIntervalSeconds   != null)   result.processesIntervalSeconds  = row.processesIntervalSeconds;
    if (row.eventLogIntervalSeconds    != null)   result.eventLogIntervalSeconds   = row.eventLogIntervalSeconds;
    if (row.processesTimeoutMs         != null)   result.processesTimeoutMs        = row.processesTimeoutMs;
    if (row.eventLogTimeoutMs          != null)   result.eventLogTimeoutMs         = row.eventLogTimeoutMs;
  }
  classOverrideCache.set(key, result);
  cacheLoadedAt.set(`class:${key}`, Date.now());
  return result;
}

/**
 * The Asset columns a probe or collector load leaves out (CQ-B051). Asset is
 * the widest table in the schema (~170 columns); these five JSON blobs are the
 * bulk of a row and nothing on the probe / collector path reads them —
 * typecheck proves it: every load below carries `omit: PROBE_ASSET_OMIT`, so a
 * collector that starts reading one fails to compile instead of silently
 * getting undefined. That is why this is an OMIT and not a hand-listed
 * `select`: a forgotten column in a select reads as "inherit" at run time
 * (2026-09 audit), a wrongly omitted one here is a type error.
 *
 * `fortinetTopology` is NOT omitted: the FortiSwitch / FortiAP collectors read
 * their controller gate from it (resolveFortinetParent and friends).
 */
export const PROBE_ASSET_OMIT = {
  associatedUsers:   true,
  virtualization:    true,
  descriptionSync:   true,
  managementAccess:  true,
  quarantineTargets: true,
} as const;

/** Minimal asset shape the resolver needs. */
export interface AssetMonitorContext {
  assetType:                 string;
  /**
   * The asset's address. Read by ONE source default only: an Unraid / TrueNAS
   * asset's response time defaults to ICMP when it has an address to ping and
   * to the platform's API state otherwise (a bridged container or a VM whose
   * guest IP the platform does not report). Callers that spread an asset row
   * carry it already; a hand-built context that omits it resolves as "no
   * address", which is the safe answer (never a ping at nothing).
   */
  ipAddress?:                string | null;
  discoveredByIntegrationId: string | null;
  /**
   * Type of the discovering integration. Drives the source-default
   * polling method and the compatibility matrix. Pass null/undefined for
   * orphan / manually-created assets — the resolver maps it to the
   * "manual" source kind.
   */
  discoveredByIntegrationType?: string | null;
  monitorIntervalSec:        number | null;
  cpuMemoryIntervalSec:      number | null;
  temperatureIntervalSec:    number | null;
  systemInfoIntervalSec:     number | null;
  /** Phase 2 — per-asset LLDP cadence override (sec). null = inherit. */
  lldpIntervalSec?:          number | null;
  /** Phase 2 — per-asset Storage cadence override (sec). null = inherit. */
  storageIntervalSec?:       number | null;
  /** Per-asset cross-transport cadence overrides (sec). null = inherit. */
  processesIntervalSec?:     number | null;
  eventLogIntervalSec?:      number | null;
  probeTimeoutMs:            number | null;
  /** Per-asset CPU+memory collector timeout override (ms). null = inherit. */
  cpuMemoryTimeoutMs?:       number | null;
  /** Per-asset temperature collector timeout override (ms). null = inherit. */
  temperatureTimeoutMs?:     number | null;
  /** Per-asset interface/storage/LLDP collector timeout override (ms). null = inherit. */
  systemInfoTimeoutMs?:      number | null;
  /** Per-asset cross-transport collector timeout overrides (ms). null = inherit. */
  processesTimeoutMs?:       number | null;
  eventLogTimeoutMs?:        number | null;
  // Per-stream polling overrides on the asset itself. null = inherit.
  // String? on disk so legacy values can sit alongside; resolver adopts
  // them only when they pass isPollingMethod().
  responseTimePolling?:      string | null;
  cpuMemoryPolling?:         string | null;
  temperaturePolling?:       string | null;
  interfacesPolling?:        string | null;
  lldpPolling?:              string | null;
  storagePolling?:           string | null;
  processesPolling?:         string | null;
  eventLogPolling?:          string | null;
  // Per-stream MIB id overrides on the asset itself. null = inherit.
  // Either `"std:<key>"` (UI hint only) or an uploaded MibFile UUID
  // (consumed by `collectCpuMemorySnmp` / `collectTemperatureSnmp` to override
  // vendor-profile selection).
  responseTimeMibId?:        string | null;
  cpuMemoryMibId?:           string | null;
  temperatureMibId?:         string | null;
  interfacesMibId?:          string | null;
  lldpMibId?:                string | null;
  processesMibId?:           string | null;
  // Per-stream credential ids on the asset itself. The resolver reads these
  // for ONE decision: whether a `rest_api` it would otherwise discard as
  // unreachable has its own token to authenticate with. Which credential the
  // collectors actually USE is resolved from the loaded relations, not here.
  responseTimeCredentialId?: string | null;
  cpuMemoryCredentialId?:    string | null;
  temperatureCredentialId?:  string | null;
  interfacesCredentialId?:   string | null;
  lldpCredentialId?:         string | null;
}

/**
 * Walk the four-tier monitor settings hierarchy and return the effective
 * values for one asset. Reads through the resolver caches; one cold call hits
 * 1-2 DB rows, every subsequent call for assets in the same tier/class group
 * is in-memory.
 *
 * Per-stream polling resolution:
 *   1. Source default (FMG/FortiGate→rest_api, AD/Entra/Win→icmp+null,
 *      manual→icmp+null) sets the baseline for each of the four streams.
 *   2. Tier-3 (integration or manual) value overrides if present AND
 *      compatible with the asset's source per
 *      utils/pollingCompatibility.isPollingMethodCompatible. Incompatible
 *      values are silently ignored — the resolver leaves the layer below
 *      in place.
 *   3. Class override applies the same compatible-or-skip rule.
 *   4. Per-asset value applies the same rule.
 *
 * SINGLE IMPLEMENTATION (2026-08 fold): this wrapper and
 * `resolveMonitorSettingsWithProvenance` both derive from
 * `resolveMonitorSettingsCore`, so the values the UI labels are BY
 * CONSTRUCTION the values the monitor runtime uses. The previous parallel
 * implementation let the provenance path adopt tier-3/class polling methods
 * ungated, so the asset modal could display a method the runtime silently
 * ignored.
 */
/** The three fleet-wide cadences the capacity model takes (seconds). */
export interface FleetCadences {
  intervalSeconds:           number;
  telemetryIntervalSeconds:  number;
  systemInfoIntervalSeconds: number;
}

/**
 * The cadences the monitored fleet actually runs at, for capacity projection
 * (CQ-B012). Resolved through resolveMonitorSettings per configuration — assets
 * sharing (integration, type, per-asset overrides) resolve once — and combined
 * as the RATE-weighted mean: N / Σ(1/interval), so N assets at that one interval
 * produce the fleet's sample rate, which is how the model multiplies it —
 * rounded to whole seconds (never below 1).
 * A stream an asset has turned off (interval 0) adds no rate. No monitored
 * asset, or every one off for a stream → that stream's hard-coded floor.
 *
 * Before this, capacity read the pre-hierarchy legacy Setting row; the startup
 * migration deletes that row, so projections had silently used the floor
 * defaults whatever the operator configured.
 *
 * Scale: one findMany of the monitored assets (a narrow select), then one
 * resolve per distinct configuration — a handful, not one per asset.
 */
export async function fleetCadences(): Promise<FleetCadences> {
  const rows = await prisma.asset.findMany({
    where: { monitored: true },
    select: {
      assetType: true, discoveredByIntegrationId: true,
      discoveredByIntegration: { select: { type: true } },
      monitorIntervalSec: true, cpuMemoryIntervalSec: true, temperatureIntervalSec: true,
      systemInfoIntervalSec: true, lldpIntervalSec: true, storageIntervalSec: true,
      probeTimeoutMs: true,
    },
  });
  const groups = new Map<string, { ctx: AssetMonitorContext; count: number }>();
  for (const a of rows) {
    const ctx = {
      assetType: a.assetType,
      discoveredByIntegrationId: a.discoveredByIntegrationId,
      discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
      monitorIntervalSec: a.monitorIntervalSec,
      cpuMemoryIntervalSec: a.cpuMemoryIntervalSec,
      temperatureIntervalSec: a.temperatureIntervalSec,
      systemInfoIntervalSec: a.systemInfoIntervalSec,
      lldpIntervalSec: a.lldpIntervalSec,
      storageIntervalSec: a.storageIntervalSec,
      probeTimeoutMs: a.probeTimeoutMs,
    } as AssetMonitorContext;
    const key = JSON.stringify(ctx);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { ctx, count: 1 });
  }
  const acc = {
    intervalSeconds:           { n: 0, rate: 0 },
    telemetryIntervalSeconds:  { n: 0, rate: 0 },
    systemInfoIntervalSeconds: { n: 0, rate: 0 },
  };
  for (const { ctx, count } of groups.values()) {
    const eff = await resolveMonitorSettings(ctx);
    const add = (k: keyof typeof acc, sec: number) => {
      if (sec > 0) { acc[k].n += count; acc[k].rate += count / sec; }
    };
    add("intervalSeconds", eff.intervalSeconds);
    add("telemetryIntervalSeconds", eff.cpuMemoryIntervalSeconds);
    add("systemInfoIntervalSeconds", eff.systemInfoIntervalSeconds);
  }
  // Whole seconds (operator decision 2026-11-09): the exact mean carries float
  // noise even for a uniform fleet (60.000000000000014) and a fraction for a
  // mixed one, and the rounding moves the projection by under 1 %.
  const mean = (k: keyof typeof acc, floor: number) =>
    (acc[k].rate > 0 ? Math.max(1, Math.round(acc[k].n / acc[k].rate)) : floor);
  return {
    intervalSeconds:           mean("intervalSeconds", HARDCODED_FLOOR.intervalSeconds),
    telemetryIntervalSeconds:  mean("telemetryIntervalSeconds", HARDCODED_FLOOR.cpuMemoryIntervalSeconds),
    systemInfoIntervalSeconds: mean("systemInfoIntervalSeconds", HARDCODED_FLOOR.systemInfoIntervalSeconds),
  };
}

export async function resolveMonitorSettings(asset: AssetMonitorContext): Promise<ResolvedMonitorSettings> {
  return (await resolveMonitorSettingsCore(asset)).resolved;
}

/**
 * Provenance label tier names:
 *   - "asset"             — per-asset column on Asset
 *   - "class"             — MonitorClassOverride row
 *   - "integration"       — integration's flat `config.monitorSettings`
 *   - "integration-class" — integration's per-class streams block
 *                           (`config.<klass>Monitor.streams.<stream>`).
 *                           Phase 2 sub-label of the integration tier so the
 *                           asset modal can render "FortiSwitch subtab"
 *                           instead of generic "FortiManager".
 *   - "manual"            — manualMonitorSettings Setting
 *   - "integrationPollInterval" — systemInfoIntervalSeconds derived from the
 *                           integration's discovery pollInterval
 *   - "default"           — polling fields only: no tier supplied a
 *                           compatible method, so the runtime source default
 *                           applies (may itself be null = stream not
 *                           delivered for this source kind)
 */
type ProvenanceTier = "asset" | "class" | "integration" | "integration-class" | "manual" | "integrationPollInterval" | "default";

export interface ResolvedSettingsWithProvenance {
  resolved:        ResolvedMonitorSettings;
  /** One label per resolved field naming which tier provided the final value. */
  provenance:      Record<keyof MonitorTierSettings, ProvenanceTier>;
  /** Which tier-3 storage holds this asset's baseline. UI uses this to label the badge. */
  tier3Source:     "integration" | "manual";
  /** When a class override applies, the row id so the UI can deep-link to its edit form. */
  classOverrideId: string | null;
  /**
   * Per-stream polling methods AS RESOLVED WITHOUT the per-asset tier — the
   * value an operator would get by selecting "Inherit". Snapshotted just
   * before the asset overlay so the edit modal's Inherit option can preview
   * the fallback even when the asset currently carries its own override.
   * Provenance "default" = no tier sets a compatible method and the runtime
   * source default applies (the value carries that default, which may be
   * null when the stream isn't delivered for the source kind).
   */
  inheritPolling: {
    values:     Partial<Record<PollingField, string | null>>;
    provenance: Partial<Record<PollingField, ProvenanceTier>>;
  };
}

type PollingField =
  | "responseTimePolling" | "cpuMemoryPolling" | "temperaturePolling"
  | "interfacesPolling" | "lldpPolling" | "storagePolling"
  | "processesPolling" | "eventLogPolling";

/**
 * The per-asset credential id belonging to one polling field, if that stream
 * has one. Explicit switch rather than string surgery on the field name so a
 * renamed column fails the type check instead of silently resolving to null.
 */
function assetStreamCredentialId(asset: AssetMonitorContext, field: PollingField): string | null {
  switch (field) {
    case "responseTimePolling": return asset.responseTimeCredentialId ?? null;
    case "cpuMemoryPolling":    return asset.cpuMemoryCredentialId    ?? null;
    case "temperaturePolling":  return asset.temperatureCredentialId  ?? null;
    case "interfacesPolling":   return asset.interfacesCredentialId   ?? null;
    case "lldpPolling":         return asset.lldpCredentialId         ?? null;
    default:                    return null;
  }
}

const POLLING_FIELDS: PollingField[] = [
  "responseTimePolling", "cpuMemoryPolling", "temperaturePolling",
  "interfacesPolling", "lldpPolling", "storagePolling",
  "processesPolling", "eventLogPolling",
];

interface ResolvedCore {
  resolved:       ResolvedMonitorSettings;
  provenance:     Record<keyof MonitorTierSettings, ProvenanceTier>;
  inheritPolling: ResolvedSettingsWithProvenance["inheritPolling"];
}

/**
 * The one four-tier merge. Values follow RUNTIME semantics exactly — the
 * compatibility-gated polling fallthrough, class-override-only credentials,
 * truthy MIB adoption — and every adoption stamps the provenance label of the
 * tier that actually won. Only the resolver caches are consulted (tier-3 +
 * class override), so this is safe on the monitor hot path; the UI-only
 * extras (per-class origin sub-labels, class-override row id) live in
 * `resolveMonitorSettingsWithProvenance`.
 */
async function resolveMonitorSettingsCore(asset: AssetMonitorContext): Promise<ResolvedCore> {
  const tier3Source: "integration" | "manual" = asset.discoveredByIntegrationId ? "integration" : "manual";
  // Tier 3 (integration-tier or manual-tier). Per-class streams overlay is
  // applied inside loadIntegrationTierSettings when the integration carries
  // a matching `<klass>Monitor.streams` block for asset.assetType.
  const tier3 = asset.discoveredByIntegrationId
    ? await loadIntegrationTierSettings(asset.discoveredByIntegrationId, asset.assetType)
    : await loadManualTierSettings();

  // Tier 2 (class override scoped to the same tier-3 source).
  const classOverride = await loadClassOverride(
    asset.discoveredByIntegrationId,
    asset.assetType,
  );

  // Resolve the asset's source kind once — drives both the polling default
  // and the compatibility check at every layer.
  const sourceKind = assetSourceKindFromIntegrationType(asset.discoveredByIntegrationType ?? null);
  // Read from the sidecar the tier load above just populated — no extra query.
  // Only meaningful for an integration-backed asset; manual-tier assets have no
  // transport to be on.
  const fortiosRestUnavailable = asset.discoveredByIntegrationId
    ? tierFortiosRestUnavailableCache.get(`${asset.discoveredByIntegrationId}:${asset.assetType}`) === true
    : false;

  const merged: ResolvedMonitorSettings = { ...tier3 };
  // Every field starts attributed to tier 3; each adopting layer below
  // overwrites its label. Listing the keys explicitly keeps the type checker
  // happy (Record<keyof X, ...>) without an Object.fromEntries dance.
  const provenance: Record<keyof MonitorTierSettings, ProvenanceTier> = {
    intervalSeconds:            tier3Source,
    failureThreshold:           tier3Source,
    fastConfirmIntervalSec:     tier3Source,
    probeTimeoutMs:             tier3Source,
    cpuMemoryTimeoutMs:         tier3Source,
    temperatureTimeoutMs:       tier3Source,
    systemInfoTimeoutMs:        tier3Source,
    cpuMemoryIntervalSeconds:   tier3Source,
    temperatureIntervalSeconds: tier3Source,
    systemInfoIntervalSeconds:  tier3Source,
    lldpIntervalSeconds:        tier3Source,
    lldpTimeoutMs:              tier3Source,
    storageIntervalSeconds:     tier3Source,
    storageTimeoutMs:           tier3Source,
    processesIntervalSeconds:   tier3Source,
    processesTimeoutMs:         tier3Source,
    eventLogIntervalSeconds:    tier3Source,
    eventLogTimeoutMs:          tier3Source,
    sampleRetentionDays:        tier3Source,
    telemetryRetentionDays:     tier3Source,
    systemInfoRetentionDays:    tier3Source,
    responseTimePolling:        tier3Source,
    cpuMemoryPolling:           tier3Source,
    temperaturePolling:         tier3Source,
    interfacesPolling:          tier3Source,
    lldpPolling:                tier3Source,
    storagePolling:             tier3Source,
    processesPolling:           tier3Source,
    eventLogPolling:            tier3Source,
    responseTimeMibId:          tier3Source,
    cpuMemoryMibId:             tier3Source,
    temperatureMibId:           tier3Source,
    interfacesMibId:            tier3Source,
    lldpMibId:                  tier3Source,
    processesMibId:             tier3Source,
    // Credential IDs are class-override only at runtime; the label flips to
    // "class" when one is set and the tier-3 label on a null value is inert.
    responseTimeCredentialId:   tier3Source,
    cpuMemoryCredentialId:      tier3Source,
    temperatureCredentialId:    tier3Source,
    interfacesCredentialId:     tier3Source,
    lldpCredentialId:           tier3Source,
    processesCredentialId:      tier3Source,
    eventLogCredentialId:       tier3Source,
  };

  // Compose tier 3 → tier 2 for the cadence/retention fields. Polling fields
  // are resolved separately below with the compatibility-aware fallthrough.
  if (classOverride) {
    if (classOverride.intervalSeconds            != null) { merged.intervalSeconds            = classOverride.intervalSeconds;            provenance.intervalSeconds            = "class"; }
    if (classOverride.failureThreshold           != null) { merged.failureThreshold           = classOverride.failureThreshold;           provenance.failureThreshold           = "class"; }
    if (classOverride.fastConfirmIntervalSec     != null) { merged.fastConfirmIntervalSec     = classOverride.fastConfirmIntervalSec;     provenance.fastConfirmIntervalSec     = "class"; }
    if (classOverride.probeTimeoutMs             != null) { merged.probeTimeoutMs             = classOverride.probeTimeoutMs;             provenance.probeTimeoutMs             = "class"; }
    if (classOverride.cpuMemoryTimeoutMs         != null) { merged.cpuMemoryTimeoutMs         = classOverride.cpuMemoryTimeoutMs;         provenance.cpuMemoryTimeoutMs         = "class"; }
    if (classOverride.temperatureTimeoutMs       != null) { merged.temperatureTimeoutMs       = classOverride.temperatureTimeoutMs;       provenance.temperatureTimeoutMs       = "class"; }
    if (classOverride.systemInfoTimeoutMs        != null) { merged.systemInfoTimeoutMs        = classOverride.systemInfoTimeoutMs;        provenance.systemInfoTimeoutMs        = "class"; }
    if (classOverride.cpuMemoryIntervalSeconds   != null) { merged.cpuMemoryIntervalSeconds   = classOverride.cpuMemoryIntervalSeconds;   provenance.cpuMemoryIntervalSeconds   = "class"; }
    if (classOverride.temperatureIntervalSeconds != null) { merged.temperatureIntervalSeconds = classOverride.temperatureIntervalSeconds; provenance.temperatureIntervalSeconds = "class"; }
    if (classOverride.systemInfoIntervalSeconds  != null) { merged.systemInfoIntervalSeconds  = classOverride.systemInfoIntervalSeconds;  provenance.systemInfoIntervalSeconds  = "class"; }
    if (classOverride.sampleRetentionDays        != null) { merged.sampleRetentionDays        = classOverride.sampleRetentionDays;        provenance.sampleRetentionDays        = "class"; }
    if (classOverride.telemetryRetentionDays     != null) { merged.telemetryRetentionDays     = classOverride.telemetryRetentionDays;     provenance.telemetryRetentionDays     = "class"; }
    if (classOverride.systemInfoRetentionDays    != null) { merged.systemInfoRetentionDays    = classOverride.systemInfoRetentionDays;    provenance.systemInfoRetentionDays    = "class"; }
  }

  // Tier 1 (per-asset cadence / timeout overrides).
  if (asset.monitorIntervalSec     != null) { merged.intervalSeconds            = asset.monitorIntervalSec;     provenance.intervalSeconds            = "asset"; }
  if (asset.cpuMemoryIntervalSec   != null) { merged.cpuMemoryIntervalSeconds   = asset.cpuMemoryIntervalSec;   provenance.cpuMemoryIntervalSeconds   = "asset"; }
  if (asset.temperatureIntervalSec != null) { merged.temperatureIntervalSeconds = asset.temperatureIntervalSec; provenance.temperatureIntervalSeconds = "asset"; }
  if (asset.systemInfoIntervalSec  != null) { merged.systemInfoIntervalSeconds  = asset.systemInfoIntervalSec;  provenance.systemInfoIntervalSeconds  = "asset"; }
  if (asset.lldpIntervalSec        != null) { merged.lldpIntervalSeconds        = asset.lldpIntervalSec;        provenance.lldpIntervalSeconds        = "asset"; }
  if (asset.storageIntervalSec     != null) { merged.storageIntervalSeconds     = asset.storageIntervalSec;     provenance.storageIntervalSeconds     = "asset"; }
  if (asset.probeTimeoutMs         != null) { merged.probeTimeoutMs             = asset.probeTimeoutMs;         provenance.probeTimeoutMs             = "asset"; }
  if (asset.cpuMemoryTimeoutMs     != null) { merged.cpuMemoryTimeoutMs         = asset.cpuMemoryTimeoutMs;     provenance.cpuMemoryTimeoutMs         = "asset"; }
  if (asset.temperatureTimeoutMs   != null) { merged.temperatureTimeoutMs       = asset.temperatureTimeoutMs;   provenance.temperatureTimeoutMs       = "asset"; }
  if (asset.systemInfoTimeoutMs    != null) { merged.systemInfoTimeoutMs        = asset.systemInfoTimeoutMs;    provenance.systemInfoTimeoutMs        = "asset"; }

  // Per-stream polling resolution — see resolveMonitorSettings header for the
  // rules. A tier's method is adopted only when it's valid for BOTH the
  // asset's source (compatibility matrix) AND the stream (cross-transport
  // streams restrict the method set — e.g. eventLog can't ride SNMP,
  // processes can't ride REST). Incompatible values are silently skipped —
  // the layer below stays in place. The pre-asset snapshot feeds the edit
  // modal's Inherit preview.
  const inheritPolling: ResolvedSettingsWithProvenance["inheritPolling"] = { values: {}, provenance: {} };
  function resolveStream(
    field: PollingField,
    stream: Stream,
    tierVal: PollingMethod | null,
    classVal: PollingMethod | null | undefined,
    assetVal: string | null | undefined,
  ): void {
    // A stored `rest_api` on an FMG that cannot make a FortiOS call is skipped
    // like any other incompatible value — the layer below stays, which is how
    // the resolver has always handled a method the asset's source can't use.
    // Without this, a per-class stream authored while the direct token was set
    // (or while the integration was in bypass mode) keeps overriding the
    // default and keeps throwing 409 on every tick, invisibly. Non-destructive:
    // the stored value is untouched and returns the moment REST is reachable
    // again.
    // ...unless the stream carries its OWN REST API credential. A per-asset
    // token is precisely what makes a FortiOS call possible where the
    // integration fleet-wide one is absent, so discarding the method here
    // would throw away the operator fix for the very condition being
    // detected — and do it silently, which is what this skip was added to
    // stop happening. The credential type is not known without a DB read
    // (the resolver is on the hot path and takes none), so a wrongly-typed
    // credential surfaces as a collection error naming the missing token
    // rather than as a stream that quietly resolves elsewhere.
    const ownRestToken = assetStreamCredentialId(asset, field) != null;
    const ok = (m: PollingMethod) => {
      if (!isPollingMethodCompatible(sourceKind, m)) return false;
      if (!isMethodValidForStream(stream, m)) return false;
      if (m === "rest_api" && fortiosRestUnavailable && !ownRestToken && !fortiosRestUsable(stream, asset.assetType)) return false;
      return true;
    };
    let resolved: PollingMethod | null = defaultPollingForSource(sourceKind, stream, {
      assetType: asset.assetType,
      fortiosRestUnavailable,
      hasIp: dial(asset) !== null, // an IPv6-only asset counts (rule 128)
    });
    let tier: ProvenanceTier = "default";
    if (tierVal && ok(tierVal)) {
      resolved = tierVal;
      tier = tier3Source;
    }
    if (classVal && ok(classVal)) {
      resolved = classVal;
      tier = "class";
    }
    inheritPolling.values[field] = resolved;
    inheritPolling.provenance[field] = tier;
    if (isPollingMethod(assetVal) && ok(assetVal)) {
      resolved = assetVal;
      tier = "asset";
    }
    merged[field] = resolved;
    provenance[field] = tier;
  }

  resolveStream("responseTimePolling", "responseTime", tier3.responseTimePolling, classOverride?.responseTimePolling ?? null, asset.responseTimePolling);
  resolveStream("cpuMemoryPolling",    "cpuMemory",    tier3.cpuMemoryPolling,    classOverride?.cpuMemoryPolling    ?? null, asset.cpuMemoryPolling);
  resolveStream("temperaturePolling",  "temperature",  tier3.temperaturePolling,  classOverride?.temperaturePolling  ?? null, asset.temperaturePolling);
  resolveStream("interfacesPolling",   "interfaces",   tier3.interfacesPolling,   classOverride?.interfacesPolling   ?? null, asset.interfacesPolling);
  resolveStream("lldpPolling",         "lldp",         tier3.lldpPolling,         classOverride?.lldpPolling         ?? null, asset.lldpPolling);
  resolveStream("storagePolling",      "storage",      tier3.storagePolling,      classOverride?.storagePolling      ?? null, asset.storagePolling);
  resolveStream("processesPolling",    "processes",    tier3.processesPolling,    classOverride?.processesPolling    ?? null, asset.processesPolling);
  resolveStream("eventLogPolling",     "eventLog",     tier3.eventLogPolling,     classOverride?.eventLogPolling     ?? null, asset.eventLogPolling);

  // Cross-transport cadences/timeouts: tier-3 baseline → class override →
  // per-asset, mirroring LLDP/Storage.
  if (classOverride?.processesIntervalSeconds != null) { merged.processesIntervalSeconds = classOverride.processesIntervalSeconds; provenance.processesIntervalSeconds = "class"; }
  if (classOverride?.eventLogIntervalSeconds  != null) { merged.eventLogIntervalSeconds  = classOverride.eventLogIntervalSeconds;  provenance.eventLogIntervalSeconds  = "class"; }
  if (classOverride?.processesTimeoutMs       != null) { merged.processesTimeoutMs       = classOverride.processesTimeoutMs;       provenance.processesTimeoutMs       = "class"; }
  if (classOverride?.eventLogTimeoutMs        != null) { merged.eventLogTimeoutMs        = classOverride.eventLogTimeoutMs;        provenance.eventLogTimeoutMs        = "class"; }
  if (asset.processesIntervalSec != null) { merged.processesIntervalSeconds = asset.processesIntervalSec; provenance.processesIntervalSeconds = "asset"; }
  if (asset.eventLogIntervalSec  != null) { merged.eventLogIntervalSeconds  = asset.eventLogIntervalSec;  provenance.eventLogIntervalSeconds  = "asset"; }
  if (asset.processesTimeoutMs   != null) { merged.processesTimeoutMs       = asset.processesTimeoutMs;   provenance.processesTimeoutMs       = "asset"; }
  if (asset.eventLogTimeoutMs    != null) { merged.eventLogTimeoutMs        = asset.eventLogTimeoutMs;    provenance.eventLogTimeoutMs        = "asset"; }

  // Per-stream MIB pins are retired (business rule 173): no tier's value is
  // resolved, so every `*MibId` reads null whatever an old row or an API
  // client still holds. The fields stay on the shape (and the columns in the
  // schema) for one release so a rollback finds them; nothing consumes them.
  for (const field of ["responseTimeMibId", "cpuMemoryMibId", "temperatureMibId", "interfacesMibId", "lldpMibId", "processesMibId"] as const) {
    merged[field] = null;
    provenance[field] = tier3Source;
  }

  // Per-stream credential IDs from the class override. Per-asset overrides
  // come from the Prisma `include` on each dispatcher, not the resolver.
  merged.responseTimeCredentialId = classOverride?.responseTimeCredentialId ?? null;
  merged.cpuMemoryCredentialId    = classOverride?.cpuMemoryCredentialId    ?? null;
  merged.temperatureCredentialId  = classOverride?.temperatureCredentialId  ?? null;
  merged.interfacesCredentialId   = classOverride?.interfacesCredentialId   ?? null;
  merged.lldpCredentialId         = classOverride?.lldpCredentialId         ?? null;
  merged.processesCredentialId    = classOverride?.processesCredentialId    ?? null;
  merged.eventLogCredentialId     = classOverride?.eventLogCredentialId     ?? null;
  if (merged.responseTimeCredentialId) provenance.responseTimeCredentialId = "class";
  if (merged.cpuMemoryCredentialId)    provenance.cpuMemoryCredentialId    = "class";
  if (merged.temperatureCredentialId)  provenance.temperatureCredentialId  = "class";
  if (merged.interfacesCredentialId)   provenance.interfacesCredentialId   = "class";
  if (merged.lldpCredentialId)         provenance.lldpCredentialId         = "class";
  if (merged.processesCredentialId)    provenance.processesCredentialId    = "class";
  if (merged.eventLogCredentialId)     provenance.eventLogCredentialId     = "class";

  return { resolved: merged, provenance, inheritPolling };
}

/**
 * Resolve effective settings for one asset AND report which tier supplied
 * each field. Values come from the SAME core as `resolveMonitorSettings`, so
 * the badges always describe what the runtime actually does; this wrapper
 * only adds the UI sub-labels ("integration-class", "integrationPollInterval")
 * and the class-override row id. Slower than the plain resolver (up to two
 * extra DB lookups) — intended for one-shot UI loads, not the hot monitor
 * loop.
 */
export async function resolveMonitorSettingsWithProvenance(
  asset: AssetMonitorContext,
): Promise<ResolvedSettingsWithProvenance> {
  const tier3Source: "integration" | "manual" = asset.discoveredByIntegrationId ? "integration" : "manual";
  const { resolved, provenance, inheritPolling } = await resolveMonitorSettingsCore(asset);

  // Per-class streams block detection (Phase 2). When this asset's integration
  // carries a per-class streams block for asset.assetType AND that block sets
  // a non-null value on a stream, the corresponding tier-3 field originated
  // at the class level rather than the flat baseline — relabel every field
  // the core attributed to the integration tier as "integration-class" so
  // the asset modal can render "FortiSwitch subtab" instead of generic
  // "FortiManager". Fields won by a lower layer (class/asset) or by the
  // source default keep their accurate label. Cheap extra lookup (one
  // integration row, already-cached config blob); skipped for manual-tier
  // assets which never have per-class streams.
  if (asset.discoveredByIntegrationId) {
    const intRow = await prisma.integration.findUnique({
      where:  { id: asset.discoveredByIntegrationId },
      select: { config: true, type: true },
    });
    const cfg = (intRow?.config as Record<string, unknown> | null) ?? {};
    const streams = pickClassStreamsBlock(intRow?.type ?? null, cfg, asset.assetType);
    if (streams) {
      const origins = detectPerClassFieldOrigins(streams);
      for (const field of Object.keys(origins) as Array<keyof MonitorTierSettings>) {
        if (provenance[field] === "integration") provenance[field] = "integration-class";
        if ((POLLING_FIELDS as readonly string[]).includes(field) && inheritPolling.provenance[field as PollingField] === "integration") {
          inheritPolling.provenance[field as PollingField] = "integration-class";
        }
      }
    }
  }

  // systemInfoIntervalSeconds carries a sub-label: when the integration tier
  // derived the value from Integration.pollInterval (rather than an explicit
  // tier-3 JSON entry), provenance reads "integrationPollInterval" so the UI
  // can render a discovery-cycle-aware hint. Only applies when the
  // integration tier actually won the field — manual-tier orphan assets and
  // class/asset-overridden values keep their literal label.
  if (
    provenance.systemInfoIntervalSeconds === "integration"
    && asset.discoveredByIntegrationId != null
    && tierSystemInfoFromPollIntervalCache.get(`${asset.discoveredByIntegrationId}:${asset.assetType}`) === true
  ) {
    provenance.systemInfoIntervalSeconds = "integrationPollInterval";
  }

  // Class-override row id (extra lookup; only needed by this provenance API).
  let classOverrideId: string | null = null;
  const classOverride = await loadClassOverride(asset.discoveredByIntegrationId, asset.assetType);
  if (classOverride) {
    const row = await prisma.monitorClassOverride.findFirst({
      where:  { integrationId: asset.discoveredByIntegrationId, assetType: asset.assetType },
      select: { id: true },
    });
    classOverrideId = row?.id ?? null;
  }

  return { resolved, provenance, tier3Source, classOverrideId, inheritPolling };
}

/**
 * Resolve the SNMP credential config to use when an FMG/FortiGate-typed asset
 * has a transport toggle flipped to "snmp". The `effectiveCred` is already the
 * resolved per-stream credential (stream-specific wins, then asset default);
 * here we only need to fall back to the integration's `monitorCredentialId`
 * when neither is an SNMP credential. Throws on missing/wrong-type credentials
 * so the caller can surface the reason in the System tab error toast.
 */
/**
 * Resolve the credential to use for one stream when the per-asset slot
 * didn't supply a usable one. Looks up the class-override-tier credential id
 * (resolved by `resolveMonitorSettings` onto the `*CredentialId` fields of
 * `ResolvedMonitorSettings`) and returns the matching Credential row when its
 * type matches what the polling method needs. Returns null otherwise so the
 * caller falls through to the integration-tier credential.
 */
export async function loadClassOverrideStreamCredential(
  credentialId: string | null,
  expectedType: "snmp" | "winrm" | "ssh" | "restapi" | "http",
): Promise<{ type: string; config: unknown } | null> {
  if (!credentialId) return null;
  const cred = await prisma.credential.findUnique({ where: { id: credentialId } });
  if (!cred) return null;
  if (cred.type !== expectedType) return null;
  return cred;
}

/**
 * Resolve the SNMP config for one monitoring stream through the shared
 * four-tier credential chain: the stream's effective asset credential
 * (per-stream ?? asset default — the caller passes it already resolved),
 * then the stream's class-override credential, then the Fortinet
 * integration fallback (fortimanager/fortigate-sourced assets only), else
 * `{ error }` with the given label. The Fortinet lookup may THROW — the
 * probe path surfaces that as its own failure message and the soft LLDP/
 * storage runners catch it to null. Previously copy-pasted at seven
 * collector/runner sites with drifting error text (2026-08 audit).
 */
export async function resolveSnmpConfigForStream(
  streamCred: { type: string; config: unknown } | null | undefined,
  classCredentialId: string | null,
  isFortinetSrc: boolean,
  integration: { config?: unknown } | null | undefined,
  errorLabel = "No SNMP credential selected",
): Promise<{ cfg: Record<string, unknown>; error?: undefined } | { cfg?: undefined; error: string }> {
  if (streamCred?.type === "snmp") {
    return { cfg: streamCred.config as Record<string, unknown> };
  }
  const classCred = await loadClassOverrideStreamCredential(classCredentialId, "snmp");
  if (classCred) {
    return { cfg: classCred.config as Record<string, unknown> };
  }
  if (isFortinetSrc && integration) {
    return { cfg: await loadSnmpCredentialConfigForFortinetAsset(streamCred, integration) };
  }
  return { error: errorLabel };
}

/**
 * Credential chain for an agentless SSH / WinRM collector: the stream's
 * effective asset credential → the class-override credential → the AD bind
 * fallback. Lifted out of `runProcessesFor`, which had the only copy, so the
 * cpuMemory / interfaces / storage collectors resolve identically — three
 * hand-copies of a four-step chain is how they drift.
 */
export async function resolveAgentlessCredConfig(
  streamCred: { type: string; config: unknown } | null | undefined,
  classCredentialId: string | null,
  method: "ssh" | "winrm",
  integration: { type: string; config: unknown } | null | undefined,
): Promise<Record<string, unknown> | null> {
  if (streamCred?.type === method) return (streamCred.config as Record<string, unknown>) || {};
  const classCred = await loadClassOverrideStreamCredential(classCredentialId, method);
  if (classCred) return (classCred.config as Record<string, unknown>) || {};
  const isAdSrc = assetSourceKindFromIntegrationType(integration?.type ?? null) === "activedirectory";
  if (isAdSrc && integration) {
    const cfg = (integration.config as Record<string, unknown>) || {};
    const username = String(cfg.bindDn || "");
    const password = String(cfg.bindPassword || "");
    if (username && password) {
      return method === "winrm"
        ? { username, password, useHttps: true, port: 5986 }
        : { username, password, port: 22 };
    }
  }
  return null;
}

/** Project a resolved SSH/WinRM credential into the WinRM connection shape. */
export function winrmConnFrom(host: string, credConfig: Record<string, unknown>, timeoutMs: number): WinRmConnection {
  return {
    host,
    username:  String(credConfig.username || ""),
    password:  String(credConfig.password || ""),
    useHttps:  credConfig.useHttps !== false,
    port:      typeof credConfig.port === "number" ? credConfig.port : undefined,
    verifyTls: credConfig.verifyTls === true,
    // PowerShell cold-start plus the WinRS Receive poll loop realistically need
    // more headroom than a stream's default timeout — same floor runProcessesFor
    // applies.
    timeoutMs: Math.max(timeoutMs, 30_000),
  };
}

export async function loadSnmpCredentialConfigForFortinetAsset(
  effectiveCred: { type: string; config: unknown } | null | undefined,
  integration: { config?: unknown } | null | undefined,
): Promise<Record<string, unknown>> {
  if (effectiveCred && effectiveCred.type === "snmp") {
    return (effectiveCred.config as Record<string, unknown>) || {};
  }
  const intCfg = (integration?.config && typeof integration.config === "object")
    ? (integration.config as Record<string, unknown>)
    : {};
  const credId = typeof intCfg.monitorCredentialId === "string" ? intCfg.monitorCredentialId : null;
  if (!credId) throw new AppError(409, "Transport set to SNMP but no SNMP credential is configured on the asset or integration");
  const cred = await prisma.credential.findUnique({ where: { id: credId } });
  if (!cred) throw new AppError(404, "Integration's monitor credential not found");
  if (cred.type !== "snmp") throw new AppError(409, `Integration's monitor credential must be SNMP (got "${cred.type}")`);
  return (cred.config as Record<string, unknown>) || {};
}

/**
 * How often THIS device's current-state tables are actually refreshed, in
 * seconds — the figure the ARP Table, MAC Table and Wireless tabs state next
 * to their data, and the threshold they turn amber past.
 *
 * The system-info pass is the writer, so its resolved per-asset cadence is the
 * answer for a monitored device. `discoveryFallback` covers the one table
 * discovery ALSO writes: an unmonitored firewall — or one with system info off
 * — still gets ARP rows on its integration's pollInterval (12 h by default for
 * both Fortinet types), two orders of magnitude apart from the monitor
 * cadence, which is exactly why the tab cannot state one number for the fleet.
 * The forwarding database has no such second writer, so the MAC Table passes
 * `false` and gets null — "not being collected" rather than a cadence
 * borrowed from a pass that does not touch it.
 *
 * Returns null when nothing refreshes it, which the tab renders as "on
 * discovery only" / "not polled" rather than inventing a figure.
 */
export async function resolveCurrentStateIntervalSec(
  assetId: string,
  opts: { discoveryFallback: boolean },
): Promise<number | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true, assetType: true, monitored: true, status: true,
      discoveredByIntegrationId: true, monitorOverride: true,
      discoveredByIntegration: { select: { type: true, pollInterval: true } },
    },
  });
  if (!asset) return null;

  const discoverySec = opts.discoveryFallback && asset.discoveredByIntegration?.pollInterval
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
