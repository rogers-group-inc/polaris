/**
 * src/services/monitoring/fortinetControllers.ts — the Fortinet controller-status probe (CQ-B061, moved verbatim from
 * monitoringService.ts): a FortiGate's managed FortiSwitch / FortiAP inventory, cached per
 * controller, and the probe that reads a managed device's state from it.
 */

import { performance } from "node:perf_hooks";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { fgRequest, type FortiGateConfig } from "../fortigateService.js";
import { fmgProxyRest, resolveDeviceMgmtIpViaFmg, type FortiManagerConfig } from "../fortimanagerService.js";
import { parseFortiapTelemetrySnapshot, isCanonicalFortiapVersion } from "../../utils/fortiapMonitorRow.js";

// ─── Fortinet controller-status probe (managed switches & APs) ──────────────
//
// Managed FortiSwitches and FortiAPs aren't directly REST-able — they're
// proxied through the parent FortiGate's switch-controller / wireless-
// controller subsystems. The authoritative up/down signal for them is the
// controller's `managed-switch/status` or `wifi/managed_ap` table.
//
// The probe fetches the controller's full inventory in one call and looks
// up the asset by its serial number. Multiple switches/APs on the same
// controller share one inventory call within a short TTL window so the
// probe rate stays bounded by controller-count, not device-count — important
// for FMG proxy mode (concurrency = 1).

interface FortinetControllerEntry {
  /** True when the controller reports this device as currently online. */
  connected: boolean;
  /** Raw status string the controller reported, surfaced in failure errors. */
  status: string;
  /**
   * For `kind="aps"` rows only: telemetry snapshot parsed off the same
   * managed_ap row. Lets the AP telemetry + temperature collectors reuse
   * the controller-cache fetch instead of issuing their own /wifi/managed_ap
   * call. Undefined on switches and on AP rows where FortiOS didn't return
   * the relevant fields.
   */
  apTelemetry?: import("../../utils/fortiapMonitorRow.js").FortiapTelemetrySnapshot;
  /**
   * The firmware the device is running, as the controller reports it — the
   * same `os_version` string discovery stores on the fortiswitch / fortiap
   * source, so the live-version reconcile (fortinetLinkStateService →
   * fortinetLiveVersionService) compares like with like. Undefined when the
   * row carried no usable version.
   */
  osVersion?: string;
}

export interface FortinetControllerFetchResult {
  inventory: Map<string, FortinetControllerEntry>;
  /**
   * Wall-clock duration of the upstream call that produced this inventory.
   * Reported as the RTT for every probe that consumes this result — the
   * fresh fetcher, every concurrent in-flight waiter, and every cache hit
   * within the TTL window — so all switches/APs under one parent FortiGate
   * show a consistent RTT instead of the lead-worker eating ~650 ms while
   * its peers report a misleading ~2 ms (the in-process cache-lookup time).
   */
  fetchDurationMs: number;
}

interface FortinetControllerCacheEntry {
  fetchedAt: number;
  fetchDurationMs: number;
  inventory: Map<string, FortinetControllerEntry>;
}

export const FORTINET_CONTROLLER_CACHE_TTL_MS = 30_000;

const fortinetControllerCache = new Map<string, FortinetControllerCacheEntry>();

// Cache of (integrationId::deviceName) → management IP for the parent FortiGate.
// Populated from Asset.ipAddress (set during discovery) so the probe path
// never needs to hit FMG's CMDB just to learn an IP we already know. TTL is
// intentionally long — management IPs change only when the operator
// reconfigures the device, and a stale entry self-heals on the next discovery
// run which re-stamps Asset.ipAddress. Falls back to resolveDeviceMgmtIpViaFmg
// only when the FortiGate asset hasn't been discovered yet or has no IP set.
const CONTROLLER_MGMT_IP_CACHE_TTL_MS = 5 * 60_000;
 // 5 minutes
interface ControllerMgmtIpEntry { ip: string; cachedAt: number; }

const controllerMgmtIpCache = new Map<string, ControllerMgmtIpEntry>();

/** Exported for tests (rule 111): where a managed switch's / AP's controller token is sent. */
export async function resolveControllerMgmtIp(
  integrationId: string,
  deviceName: string,
  fmgConfig: FortiManagerConfig,
): Promise<string | null> {
  const cacheKey = `${integrationId}::${deviceName}`;
  const cached = controllerMgmtIpCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CONTROLLER_MGMT_IP_CACHE_TTL_MS) {
    return cached.ip;
  }

  // Primary: look up the FortiGate's already-discovered Asset.ipAddress.
  // This is the same IP that discovery resolved via resolveDeviceMgmtIpViaFmg
  // and stamped on the asset — no need to hit FMG again. Use case-insensitive
  // hostname matching because FortiOS device names can be stored in different
  // case than what ends up in the topology blob's controllerFortigate field.
  // Only a firewall THIS integration manages: the answer is where the
  // integration's FortiGate token is sent, so a hand-made "firewall" asset
  // with a matching name must never qualify (rule 111). A gate whose
  // discoveredByIntegrationId was cleared (integration delete + recreate)
  // falls through to the FMG CMDB lookup below instead.
  const fgAsset = await prisma.asset.findFirst({
    where: {
      hostname: { equals: deviceName, mode: "insensitive" },
      assetType: "firewall",
      discoveredByIntegrationId: integrationId,
    },
    select: { ipAddress: true },
  });
  if (fgAsset?.ipAddress) {
    controllerMgmtIpCache.set(cacheKey, { ip: fgAsset.ipAddress, cachedAt: Date.now() });
    return fgAsset.ipAddress;
  }

  // Fallback: FortiGate not yet discovered as an asset (or has no IP stamped).
  // Hit FMG CMDB the old way so fresh installs and edge cases still work.
  const ip = await resolveDeviceMgmtIpViaFmg(fmgConfig, deviceName, undefined, integrationId);
  if (ip) {
    controllerMgmtIpCache.set(cacheKey, { ip, cachedAt: Date.now() });
  }
  return ip;
}

// Coalesce concurrent inventory fetches against the same controller. Without
// this, every worker that wakes up on the same 60s tick races past the
// cache-miss check and fires its own fmgProxyRest call — N workers × 1
// upstream request, hammering FMG (which drops parallel sessions above
// ~1–2 in the reference deployment, surfacing as code -11 = "permission
// denied / session limit"). The promise-singleton pattern below funnels N
// concurrent callers into one upstream call; the cache then absorbs
// follow-on calls within the 30 s TTL.
const inflightControllerFetch = new Map<string, Promise<FortinetControllerFetchResult>>();

function controllerCacheKey(integrationId: string, deviceName: string, kind: "switches" | "aps"): string {
  return `${integrationId}::${deviceName}::${kind}`;
}

/**
 * Fetch a FortiOS REST path from a controller FortiGate through whichever
 * transport the integration prescribes. One home for the dispatch the three
 * controller fetchers (inventory / wifi clients / switch-ports CMDB) each
 * carried a private copy of until the 2026-08 audit:
 *
 *  - fortimanager + useProxy=false → STRICT bypass: direct REST against the
 *    device's mgmt IP (resolveControllerMgmtIp). Polaris never silently
 *    falls back to proxy — if the direct path can't be assembled (missing
 *    token / mgmt interface / unresolvable mgmt IP) the call fails with a
 *    precondition-specific error so the operator sees what's misconfigured.
 *    A silent fallback would turn "I disabled proxy" into "…except when
 *    something else is wrong, in which case it re-enables itself and
 *    overruns FMG's parallel-session limit."
 *  - fortimanager (proxy, default) → /sys/proxy/json via fmgProxyRest, with
 *    an AbortController-backed timeout.
 *  - fortigate → direct REST with the integration's own config.
 *
 * `label` names the caller in the unsupported-type error.
 */
export async function fetchViaFortinetTransport(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  path: string,
  timeoutMs: number,
  label: string,
): Promise<unknown> {
  if (integration.type === "fortimanager") {
    const fmgConfig = integration.config as unknown as FortiManagerConfig;
    if (fmgConfig.useProxy === false) {
      if (!fmgConfig.fortigateApiToken) {
        throw new AppError(
          409,
          "Direct mode is enabled (useProxy=false) but no FortiGate API token is configured on the integration. " +
          "Set fortigateApiToken on the integration's Settings tab, or re-enable proxy mode.",
        );
      }
      if (!fmgConfig.mgmtInterface?.trim()) {
        throw new AppError(
          409,
          "Direct mode is enabled (useProxy=false) but mgmtInterface is empty. " +
          "Set the FortiGate management interface name (e.g. \"mgmt\", \"port1\") on the integration's Settings tab.",
        );
      }
      const mgmtIp = await resolveControllerMgmtIp(integration.id, deviceName, fmgConfig);
      if (!mgmtIp) {
        throw new AppError(
          502,
          `Direct mode: could not resolve ${deviceName}'s management IP ` +
          `(not found in Polaris asset inventory or FMG CMDB interface "${fmgConfig.mgmtInterface || "mgmt"}").`,
        );
      }
      const directConfig: FortiGateConfig = {
        host: mgmtIp,
        port: 443,
        apiUser: fmgConfig.fortigateApiUser || "",
        apiToken: fmgConfig.fortigateApiToken,
        verifySsl: fmgConfig.fortigateVerifySsl === true,
      };
      return fgRequest<unknown>(directConfig, "GET", path, { timeoutMs });
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fmgProxyRest<unknown>(fmgConfig, deviceName, "GET", path, { signal: ac.signal, integrationId: integration.id });
    } finally {
      clearTimeout(timer);
    }
  }
  if (integration.type === "fortigate") {
    return fgRequest<unknown>(integration.config as unknown as FortiGateConfig, "GET", path, { timeoutMs });
  }
  throw new AppError(500, `Unsupported integration type for ${label}: ${integration.type}`);
}

/** FortiOS responses arrive either as a bare array or `{ results: [...] }`. */
export function unwrapFortiosRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  return Array.isArray((raw as any)?.results) ? (raw as any).results : [];
}

/**
 * Exported for `fortinetLinkStateService`, which sweeps the same two
 * controller tables for every FortiGate-managed switch/AP — not just the ones
 * whose `responseTimePolling` resolves to `rest_api`. Sharing this function
 * (rather than the service issuing its own call) is what lets the sweep ride
 * the probe path's reads where both are running: they land on the same 30s
 * cache entry whenever their independent 60s timers fall in one window, which
 * is some of the time, not all of it. The point is the CEILING either way —
 * two calls per controller per tick regardless of how many devices hang off
 * it.
 *
 * Keep the cache module-local to monitoringService: a second cache in the
 * other service would double the upstream rate it exists to bound.
 */
export async function fetchFortinetControllerInventory(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  kind: "switches" | "aps",
  timeoutMs: number,
): Promise<FortinetControllerFetchResult> {
  const cacheKey = controllerCacheKey(integration.id, deviceName, kind);
  const cached = fortinetControllerCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return { inventory: cached.inventory, fetchDurationMs: cached.fetchDurationMs };
  }
  // If another worker already kicked off the fetch for this controller +
  // kind, wait on its promise instead of firing our own. Critical at scale
  // — the alternative is N concurrent upstream calls per controller per
  // 60s tick. In proxy mode that hits FMG's parallel-session limit (code
  // -11 "invalid or expired API token"); in direct mode it hits the
  // FortiGate's REST-admin session limit (token lockouts). The promise-
  // singleton below funnels N concurrent callers into one outbound call
  // regardless of mode; the 30s cache absorbs follow-on calls.
  const inflight = inflightControllerFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<FortinetControllerFetchResult> => {
    const fetchStartedAt = performance.now();
    try {
      const path = kind === "switches"
        ? "/api/v2/monitor/switch-controller/managed-switch/status"
        : "/api/v2/monitor/wifi/managed_ap";
      const rawRows = await fetchViaFortinetTransport(integration, deviceName, path, timeoutMs, "Fortinet controller probe");
      const rows = unwrapFortiosRows(rawRows);
      const inventory = new Map<string, FortinetControllerEntry>();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const serial = String(r.serial || r.sn || r.wtp_id || "").trim();
        if (!serial) continue;
        const status = String(r.status || r.state || "");
        const connected = kind === "switches"
          // Managed switch reports `status: "Connected" | "Disconnected"`.
          ? status === "Connected"
          // Managed APs report `status: "online" | "offline" | "discovered" | ...`
          // — only "online"/"connected" count as up.
          : (status === "online" || status === "connected");
        const entry: FortinetControllerEntry = { connected, status };
        // APs: os_version is live; the cached version/firmware_version fields
        // lag upgrades and are trusted only in the canonical shape — the same
        // pick parseFortiapMonitorRow makes for discovery.
        const osVersion = kind === "switches"
          ? String(r.os_version || "").trim()
          : (String(r.os_version || "").trim()
              || [String(r.version || ""), String(r.firmware_version || "")].find(isCanonicalFortiapVersion)
              || "");
        if (osVersion) entry.osVersion = osVersion;
        if (kind === "aps") {
          // Parse the AP-row telemetry snapshot once at fetch time so the
          // cache absorbs both probe + telemetry + temperature consumers.
          const snap = parseFortiapTelemetrySnapshot(r);
          if (snap.cpuPct !== undefined || snap.memTotalMb !== undefined || snap.sensorTemperatures) {
            entry.apTelemetry = snap;
          }
        }
        inventory.set(serial.toUpperCase(), entry);
      }

      const fetchDurationMs = Math.max(0, Math.round(performance.now() - fetchStartedAt));
      fortinetControllerCache.set(cacheKey, { fetchedAt: Date.now(), fetchDurationMs, inventory });
      return { inventory, fetchDurationMs };
    } finally {
      // Always clear the inflight entry — successful fetches are now in the
      // cache; failed fetches need a clean slate so the next call can retry
      // without waiting on a rejected promise.
      inflightControllerFetch.delete(cacheKey);
    }
  })();

  inflightControllerFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}
