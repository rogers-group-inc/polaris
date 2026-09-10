/**
 * src/services/fortimanagerService.ts — FortiManager JSON RPC API client
 *
 * Authenticates via bearer token (API key) rather than session-based login.
 */

import { Netmask } from "netmask";
import { AppError } from "../utils/errors.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { tlsFetch } from "../utils/tlsDispatcher.js";
import { logger } from "../utils/logger.js";
import { normalizeMacOrNull, normalizeMacsDistinct } from "../utils/mac.js";
import { parseRangeFirstIp, isValidIpv4 } from "../utils/cidr.js";
import { parseFortiapMonitorRow, FORTIAP_MONITOR_FORMAT } from "../utils/fortiapMonitorRow.js";
import { inventorySwitchAttribution, INVENTORY_QUERY_FORMAT } from "../utils/inventoryLocality.js";
import type { ApLldpNeighborSample } from "../utils/fortiapLldp.js";
import { findFortiswitchUplinkPorts, readManagedSwitchCmdbSerial } from "../utils/fortiswitchCmdb.js";
import { processDetectedDeviceRows, processArpRows } from "../utils/fortinetDetectedDevice.js";
import { getFmgWorker } from "./fmgWorker.js";
import { primeArpCache, ARP_SETTLE_MS } from "./arpPrimeService.js";
import {
  discoverDhcpSubnets as discoverViaFortigate,
  testConnection as fgTestConnection,
  proxyQuery as fgProxyQuery,
  type FortiGateConfig,
} from "./fortigateService.js";

// FMG-side device names and FortiOS system-status hostnames can disagree in
// case (e.g. FMG stores "evansville-fw-1" while the device returns
// "EVANSVILLE-FW-1" via /api/v2/cmdb/system/global). Every in-memory Map/Set
// that keys by "FortiGate device name" must lowercase the key so writes from
// either source land in the same bucket; original casing is preserved on the
// raw device object and the asset row for logging and Event messages.
export const fmgNameKey = (n: string | null | undefined): string =>
  String(n ?? "").toLowerCase();

export interface FortiManagerConfig {
  host: string;
  port?: number;
  apiUser: string;          // API user name (required by newer FMG versions)
  apiToken: string;         // Bearer token for authentication
  adom?: string;            // Administrative Domain (default: "root")
  verifySsl?: boolean;      // Skip TLS verification (default: false)
  mgmtInterface?: string;
  interfaceInclude?: string[];  // Interfaces to include for interface IP discovery
  interfaceExclude?: string[];  // Interfaces to exclude from interface IP discovery. Ignored if interfaceInclude is non-empty.
  dhcpInclude?: string[];       // Interfaces to include for DHCP subnet discovery
  dhcpExclude?: string[];       // Interfaces to exclude from DHCP subnet discovery. Ignored if dhcpInclude is non-empty.
  inventoryExcludeInterfaces?: string[];
  inventoryIncludeInterfaces?: string[];
  deviceInclude?: string[];   // FortiGate device names to include (wildcards ok). Matched against name/hostname.
  deviceExclude?: string[];   // FortiGate device names to exclude. Ignored if deviceInclude is non-empty.
  discoveryParallelism?: number; // Max concurrent FortiGates during discovery (default 5). Forced to 1 when useProxy is true.
  useProxy?: boolean;         // If true (default), all per-device queries go through FMG's /sys/proxy/json and /pm/config. If false, queries go direct to each FortiGate's management IP using fortigateApiUser + fortigateApiToken.
  fortigateApiUser?: string;  // Only used when useProxy is false — REST API admin username configured on each managed FortiGate.
  fortigateApiToken?: string; // Only used when useProxy is false — Bearer token for the REST API admin on each managed FortiGate.
  fortigateVerifySsl?: boolean; // Only used when useProxy is false — whether to verify TLS certs on direct FortiGate connections (default false).
  // FortiGate-class monitor block. Only the metavar-name subfields are read by
  // this service (to name the per-device coord / address metavars during the
  // device-list read); the rest of the block is consumed in integrations.ts.
  fortigateMonitor?: {
    latitudeMetavar?: string;
    longitudeMetavar?: string;
    addressMetavar?: string;
  };
}

interface JsonRpcRequest {
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  id: number;
  result: Array<{
    status: { code: number; message: string };
    url: string;
    data?: unknown;
  }>;
}

/**
 * Test connectivity to a FortiManager using bearer token auth.
 * Calls /sys/status to verify access and retrieve version info.
 */
export async function testConnection(
  config: FortiManagerConfig,
  integrationId?: string,
): Promise<{
  ok: boolean;
  message: string;
  version?: string;
}> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;

  try {
    const statusPayload: JsonRpcRequest = {
      id: 1,
      method: "get",
      params: [{ url: "/sys/status" }],
    };

    const statusRes = await rpc(baseUrl, statusPayload, config.apiUser, config.apiToken, config.verifySsl, undefined, integrationId);

    const code = statusRes.result?.[0]?.status?.code;
    if (code !== 0) {
      const msg = statusRes.result?.[0]?.status?.message || "Request failed";
      if (code === -11) {
        return { ok: false, message: "Invalid or expired API token" };
      }
      return { ok: false, message: msg };
    }

    const data = statusRes.result?.[0]?.data as Record<string, unknown> | undefined;
    const version = data?.Version ? String(data.Version) : undefined;

    return {
      ok: true,
      message: version ? `Connected — FortiManager ${version}` : "Connected successfully",
      version,
    };
  } catch (err: any) {
    if (err.cause?.code === "ECONNREFUSED") {
      return { ok: false, message: `Connection refused — ${config.host}:${config.port || 443}` };
    }
    if (err.cause?.code === "ENOTFOUND") {
      return { ok: false, message: `Host not found — ${config.host}` };
    }
    if (err.cause?.code === "ETIMEDOUT" || err.name === "TimeoutError") {
      return { ok: false, message: `Connection timed out — ${config.host}:${config.port || 443}` };
    }
    if (err.message === "fetch failed" && err.cause) {
      const code = err.cause?.code;
      if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID") {
        return { ok: false, message: `TLS certificate error (${code}) — try disabling SSL verification` };
      }
      return { ok: false, message: err.cause?.message || err.message };
    }
    return { ok: false, message: err.message || "Unknown error" };
  }
}

/**
 * No /sys/logout. Polaris authenticates to FortiManager with a predefined
 * REST API Admin api-key (bearer). Per the FortiManager API Best Practices
 * Guide, that key is permanent: "the same user account will always share the
 * same session and you do not need to use the login/logout endpoints." The
 * logout-to-free-slots advice applies only to session-based auth. A prior
 * hourly /sys/logout (commit 3e70476) tore down the shared session out from
 * under the split-role monitor/discovery processes that reuse it, producing
 * RPC -11 "no valid session" churn — removed deliberately. If FMG ever reaps
 * the session at its hard lifetime, the next bearer call re-establishes it.
 */

/**
 * Resolve a FortiGate's real management-interface IP via FMG.
 *
 * FMG's own `device.ip` field is FMG's view of the gate — frequently a
 * FortiLink/mgmt-tunnel address that isn't reachable from outside the
 * FMG↔FortiGate path. For direct transport we need the IP the gate
 * actually listens on for REST API traffic, which lives in the
 * interface config.
 *
 * Strategy: try a filtered `filter: [["name","==",mgmt]]` query first
 * (small response). FMG's filter evaluator sporadically returns an
 * empty array even when the interface exists — so if the filtered
 * response comes back empty, fall back to fetching the full interface
 * list and matching client-side. Returns null only if the interface
 * genuinely has no usable v4 IP configured on either pass.
 */
function _extractV4(raw: unknown): string | null {
  const ip = Array.isArray(raw) ? raw[0] : (raw as string | null | undefined);
  if (!ip || ip === "0.0.0.0" || !isValidIpv4(ip)) return null;
  return ip;
}

/**
 * Resolve the management IP of a managed FortiGate by reading its interface
 * config through FMG. Returns the IP that direct-mode REST calls should
 * target, or null if the configured management interface has no usable IP.
 *
 * Exposed so reservationPushService can build a per-device FortiGateConfig
 * when the integration is in direct (`useProxy=false`) mode.
 */
export async function resolveDeviceMgmtIpViaFmg(
  config: FortiManagerConfig,
  deviceName: string,
  signal?: AbortSignal,
  integrationId?: string,
): Promise<string | null> {
  const mgmtIfaceName = config.mgmtInterface?.trim();
  if (!mgmtIfaceName) return null;
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  return resolveDeviceMgmtIp(baseUrl, config, deviceName, mgmtIfaceName, signal, integrationId);
}

async function resolveDeviceMgmtIp(
  baseUrl: string,
  config: FortiManagerConfig,
  deviceName: string,
  mgmtIfaceName: string,
  signal?: AbortSignal,
  integrationId?: string,
): Promise<string | null> {
  const url = `/pm/config/device/${deviceName}/global/system/interface`;

  // Fast path — filtered query.
  try {
    const filteredRes = await rpc(
      baseUrl,
      { id: 2, method: "get", params: [{ url, filter: [["name", "==", mgmtIfaceName]], fields: ["name", "ip"], loadsub: 0 }] },
      config.apiUser, config.apiToken, config.verifySsl, signal, integrationId,
    );
    const list = filteredRes.result?.[0]?.data;
    if (Array.isArray(list) && list.length > 0) {
      const found = (list as any[]).find((i) => i.name === mgmtIfaceName);
      const ip = found ? _extractV4(found.ip) : null;
      if (ip) return ip;
    }
  } catch { /* fall through to unfiltered fetch */ }

  // Fallback — unfiltered fetch, client-side match. FMG's filter evaluator
  // sometimes returns an empty list under load even when the interface
  // exists; pulling every interface avoids that failure mode at the cost
  // of one larger response.
  const fullRes = await rpc(
    baseUrl,
    { id: 2, method: "get", params: [{ url, fields: ["name", "ip"], loadsub: 0 }] },
    config.apiUser, config.apiToken, config.verifySsl, signal, integrationId,
  );
  const all = fullRes.result?.[0]?.data;
  if (!Array.isArray(all)) return null;
  const match = (all as any[]).find((i) => i.name === mgmtIfaceName);
  return match ? _extractV4(match.ip) : null;
}

/**
 * Pick a random managed FortiGate from the FMG device list and run a
 * FortiGate-side connection test against it using the direct-transport
 * credentials. Exposed as a standalone call so the UI can stream its
 * result independently of the FMG connection test.
 *
 * Retries with a different random gate (a "backup pick") if the first pick
 * fails — so a single offline/in-maintenance gate doesn't fail the whole
 * test when the rest of the fleet is healthy. Total attempts capped at
 * MAX_RANDOM_FORTIGATE_ATTEMPTS; FMG-level failures (device list fetch,
 * empty/filtered-out ADOM, missing mgmt interface) are not retried because
 * they aren't gate-specific.
 */
const MAX_RANDOM_FORTIGATE_ATTEMPTS = 2;

export async function testRandomFortiGate(
  config: FortiManagerConfig,
  integrationId?: string,
): Promise<{
  ok: boolean;
  message: string;
  deviceName: string;
  version?: string;
  attempts?: string[];
}> {
  if (!config.fortigateApiToken) {
    return {
      ok: false,
      message: 'FortiGate API Token is required when the FortiManager proxy is disabled',
      deviceName: "(none)",
    };
  }

  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const devicesPayload: JsonRpcRequest = {
    id: 1,
    method: "get",
    params: [{ url: `/dvmdb/adom/${adom}/device`, fields: ["name", "hostname", "ip"], loadsub: 0 }],
  };

  let devicesRes: JsonRpcResponse;
  try {
    devicesRes = await rpc(baseUrl, devicesPayload, config.apiUser, config.apiToken, config.verifySsl, undefined, integrationId);
  } catch (err: any) {
    return { ok: false, message: `Failed to fetch device list from FMG: ${err.message || "Unknown error"}`, deviceName: "(none)" };
  }

  const raw = devicesRes.result?.[0]?.data;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: `No managed devices found in ADOM "${adom}"`, deviceName: "(none)" };
  }

  // Apply the same include/exclude filters the discovery run would use. We
  // don't require FMG's `device.ip` here — that field is FMG's own view of
  // the gate (often a FortiLink/mgmt-tunnel address) and isn't reachable
  // from Polaris. The real management IP comes from the gate's interface
  // config, resolved below.
  const filtered = filterDevices(raw as any[], config.deviceInclude, config.deviceExclude);

  if (filtered.length === 0) {
    return {
      ok: false,
      message: "No managed FortiGate is available to test against — adjust device include/exclude or make sure at least one gate is online in FMG",
      deviceName: "(none)",
    };
  }

  const mgmtIfaceName = config.mgmtInterface?.trim();
  if (!mgmtIfaceName) {
    return {
      ok: false,
      message: 'FortiGate mgmt interface is not configured on the integration — set "Management Interface" before testing direct transport',
      deviceName: "(none)",
    };
  }

  // Fisher-Yates shuffle of the filtered list, then walk the first N entries.
  // Shuffling (instead of repeated `Math.random()` index picks) guarantees we
  // never re-test the same gate when the filtered list has ≥2 entries.
  const shuffled = filtered.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const maxAttempts = Math.min(MAX_RANDOM_FORTIGATE_ATTEMPTS, shuffled.length);

  const attemptLog: string[] = [];
  let lastResult: {
    ok: boolean;
    message: string;
    deviceName: string;
    version?: string;
  } | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const pick = shuffled[attempt];
    const deviceName = String(pick.name || pick.hostname || pick.ip || "(unknown)");

    let mgmtIp: string | null;
    try {
      mgmtIp = await resolveDeviceMgmtIp(baseUrl, config, deviceName, mgmtIfaceName, undefined, integrationId);
    } catch (err: any) {
      lastResult = {
        ok: false,
        message: `Failed to resolve management IP for "${deviceName}" via FMG (${mgmtIfaceName}): ${err.message || "Unknown error"}`,
        deviceName,
      };
      attemptLog.push(deviceName);
      continue;
    }

    if (!mgmtIp) {
      lastResult = {
        ok: false,
        message: `Could not resolve a management IP for "${deviceName}" on interface "${mgmtIfaceName}"`,
        deviceName,
      };
      attemptLog.push(deviceName);
      continue;
    }

    const fgConfig: FortiGateConfig = {
      host: mgmtIp,
      port: 443,
      apiUser: config.fortigateApiUser || "",
      apiToken: config.fortigateApiToken,
      vdom: "root",
      verifySsl: config.fortigateVerifySsl === true,
      mgmtInterface: mgmtIfaceName,
    };

    const fgResult = await fgTestConnection(fgConfig);
    attemptLog.push(deviceName);
    if (fgResult.ok) {
      return {
        ok: true,
        message: fgResult.message,
        version: fgResult.version,
        deviceName,
        attempts: attemptLog,
      };
    }
    lastResult = { ok: false, message: fgResult.message, version: fgResult.version, deviceName };
  }

  // All attempts failed. Surface the last failure, but include the full list
  // of attempted device names in the message so the operator can see which
  // gates were tried and rule out an unlucky single-pick fluke.
  const lr = lastResult ?? {
    ok: false,
    message: "No FortiGate could be tested",
    deviceName: "(none)",
  };
  const message = attemptLog.length > 1
    ? `${lr.message} (also tried: ${attemptLog.filter((n) => n !== lr.deviceName).join(", ")})`
    : lr.message;
  return { ok: false, message, deviceName: lr.deviceName, version: lr.version, attempts: attemptLog };
}

/** True when this JSON-RPC payload targets FMG's `/sys/proxy/json` passthrough
 *  (i.e. forwards a call through to a managed FortiGate). FMG drops parallel
 *  proxy connections past 1-2 so these go through the FmgWorker's strict
 *  proxy lane; everything else (CMDB, dvmdb, auth) goes through the unbounded
 *  native lane. */
function rpcPayloadIsProxy(payload: JsonRpcRequest): boolean {
  const params = payload.params;
  if (!Array.isArray(params)) return false;
  for (const p of params) {
    const url = (p as { url?: string } | undefined)?.url;
    if (typeof url === "string" && url === "/sys/proxy/json") return true;
  }
  return false;
}

/**
 * Low-level JSON RPC call to FortiManager with bearer token auth.
 *
 * When `integrationId` is provided, the call funnels through the
 * per-integration FmgWorker. The worker has two lanes:
 *
 *   • Proxy lane (strict concurrency=1) — every `/sys/proxy/json` call.
 *     FortiManager drops parallel proxy connections past 1-2, so these stay
 *     serialized by design.
 *   • Native lane (unbounded) — every other call (CMDB, dvmdb, auth, etc.).
 *     Native endpoints hit FMG's own database and don't share the proxy
 *     concurrency constraint, so they parallelize freely.
 *
 * When `integrationId` is omitted (e.g. test-connection on an unsaved
 * integration where no id exists yet), the call runs direct — there's no
 * other code talking to that FMG instance, so contention is impossible.
 */
async function rpc(
  url: string,
  payload: JsonRpcRequest,
  apiUser: string,
  apiToken: string,
  verifySsl?: boolean,
  externalSignal?: AbortSignal,
  integrationId?: string,
): Promise<JsonRpcResponse> {
  const inner = () => rpcInner(url, payload, apiUser, apiToken, verifySsl, externalSignal);
  if (!integrationId) return inner();
  const label = `fmg.${payload.method}:${describeRpcParams(payload)}`;
  const worker = getFmgWorker(integrationId);
  return rpcPayloadIsProxy(payload)
    ? worker.submitProxy(label, inner, externalSignal)
    : worker.submitNative(label, inner, externalSignal);
}

function describeRpcParams(payload: JsonRpcRequest): string {
  const first = payload.params?.[0] as { url?: string; data?: { resource?: string; target?: string[] } } | undefined;
  if (!first) return "?";
  // /sys/proxy/json wraps the real path in data.resource + data.target[0]
  if (first.url === "/sys/proxy/json" && first.data) {
    const tgt = first.data.target?.[0] ?? "?";
    const res = first.data.resource ?? "?";
    return `${tgt}:${res}`;
  }
  return first.url ?? "?";
}

// Bounded retry for transient FortiManager faults. Per the FortiManager API
// Best Practices Guide ("implement retry logic with exponential backoff for
// transient errors"), only TRANSIENT failures are retried — HTTP 5xx and
// network-layer faults (timeout / connection reset). PERMANENT failures
// (HTTP 401/403/404/405, and the FMG RPC -11 surfaced by callers) are thrown
// immediately. Retries run INSIDE the caller's FmgWorker lane slot, so the
// proxy lane stays serialized (concurrency=1) and a struggling FMG isn't piled
// on. The outward AppError.httpStatus stays 502 for every transport failure
// (unchanged) — the upstream HTTP code is encoded in the message and used only
// to decide retryability, never re-exposed to Polaris's own clients (a raw 401
// would otherwise trip the frontend's session-expired logout).
const RPC_MAX_ATTEMPTS = 3;        // 1 initial + 2 retries
const RPC_RETRY_BASE_MS = 500;     // backoff: 500ms then 1500ms

function markRetryable<E extends object>(err: E): E {
  (err as { retryable?: boolean }).retryable = true;
  return err;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

async function rpcInner(
  url: string,
  payload: JsonRpcRequest,
  apiUser: string,
  apiToken: string,
  verifySsl?: boolean,
  externalSignal?: AbortSignal,
): Promise<JsonRpcResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RPC_MAX_ATTEMPTS; attempt++) {
    if (externalSignal?.aborted) break;
    try {
      return await rpcAttempt(url, payload, apiUser, apiToken, verifySsl, externalSignal);
    } catch (err) {
      lastErr = err;
      const retryable = (err as { retryable?: boolean })?.retryable === true;
      if (!retryable || externalSignal?.aborted || attempt === RPC_MAX_ATTEMPTS - 1) throw err;
      const backoffMs = RPC_RETRY_BASE_MS * (attempt * 2 + 1); // 500ms, then 1500ms
      logger.debug(
        { url: describeRpcParams(payload), attempt: attempt + 1, backoffMs, message: (err as Error)?.message },
        "fmg rpc: transient failure — backing off then retrying",
      );
      await sleepWithAbort(backoffMs, externalSignal);
    }
  }
  throw lastErr;
}

async function rpcAttempt(
  url: string,
  payload: JsonRpcRequest,
  apiUser: string,
  apiToken: string,
  verifySsl?: boolean,
  externalSignal?: AbortSignal,
): Promise<JsonRpcResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 10_000);

  // If an external signal fires (e.g. integration re-saved), abort this request too
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiToken}`,
    };
    if (apiUser) headers["access_user"] = apiUser;

    let res: Awaited<ReturnType<typeof tlsFetch>>;
    try {
      // verifySsl=false relaxes TLS for THIS connection only (an undici
      // dispatcher scoped to this request) — never via the process-global env
      // flip, which raced concurrent requests. tlsFetch owns the pairing: a
      // dispatcher is only valid to the undici copy that created it, so the
      // fetch must not be Node's global one. See src/utils/tlsDispatcher.ts.
      res = await tlsFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      }, verifySsl);
    } catch (err: any) {
      // Intentional external abort (integration re-saved) — propagate as-is, never retry.
      if (externalSignal?.aborted && !timedOut) throw err;
      // Timeout or transient connection fault — retryable.
      const detail = timedOut ? "timed out after 10s" : (err?.cause?.code || err?.message || "fetch failed");
      throw markRetryable(new AppError(502, `FortiManager connection error — ${detail}`));
    }

    // Permanent (never retry): auth, permission, missing resource, bad method.
    if (res.status === 401) throw new AppError(502, "FortiManager auth failed (HTTP 401) — invalid or expired API token/session");
    if (res.status === 403) throw new AppError(502, "FortiManager permission denied (HTTP 403) — check the API user's admin profile");
    if (res.status === 404) throw new AppError(502, "FortiManager endpoint not found (HTTP 404)");
    if (res.status === 405) throw new AppError(502, "FortiManager method not allowed (HTTP 405)");
    // Transient (retry): server-side 5xx.
    if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
      throw markRetryable(new AppError(502, `FortiManager returned HTTP ${res.status}`));
    }
    if (!res.ok) throw new AppError(502, `FortiManager returned HTTP ${res.status}`);

    return (await res.json()) as JsonRpcResponse;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Proxy an arbitrary JSON-RPC call to FortiManager using stored credentials.
 * Used by the manual API query tool in the UI.
 */
export async function proxyQuery(
  config: FortiManagerConfig,
  method: string,
  params: unknown[],
  integrationId?: string,
): Promise<unknown> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  return rpc(baseUrl, { id: 1, method, params }, config.apiUser, config.apiToken, config.verifySsl, undefined, integrationId);
}

export interface CentralManagementDetection {
  wtp: boolean;
  fsw: boolean;
  /** Row counts from the ADOM tables (null = table absent / per-device). */
  wtpCount: number | null;
  fswCount: number | null;
  detectedAt: string;
}

/**
 * Decode the ADOM's central-management state from its dvmdb `flags` value.
 * Central is the DEFAULT — per-device mode is expressed as explicit
 * `per_device_wtp` / `per_device_fsw` flags (confirmed against a live FMG
 * 7.x: the /dvmdb/adom syntax dump lists per_device_wtp=1024,
 * per_device_fsw=65536, and an ADOM with switches per-device + APs central
 * carried exactly the per_device_fsw bit). The bit values are read from the
 * caller-supplied `opts` map (the syntax dump) rather than hardcoded, so a
 * version that renumbers the enum can't flip the decode. Returns null for a
 * class whose per-device flag isn't in `opts` (build predates per-device
 * support for it — the caller falls back to the table probe).
 *
 * `flags` arrives as a uint32 bitmask on current builds; verbose builds may
 * render it as a string array — both are handled. Exported for unit tests.
 */
export function decodeCentralManagementFlags(
  flags: unknown,
  opts: Record<string, unknown>,
): { wtp: boolean | null; fsw: boolean | null } {
  const decode = (flagName: string): boolean | null => {
    if (Array.isArray(flags)) return !flags.map(String).includes(flagName);
    const bit = opts[flagName];
    if (typeof flags !== "number" || typeof bit !== "number") return null;
    return (flags & bit) === 0; // per-device flag ABSENT = central
  };
  return { wtp: decode("per_device_wtp"), fsw: decode("per_device_fsw") };
}

/**
 * Detect whether this ADOM centrally manages FortiAPs (AP Manager) and/or
 * FortiSwitches (FortiSwitch Manager).
 *
 * Primary signal: the ADOM's dvmdb `flags` (see
 * decodeCentralManagementFlags) — authoritative and immune to the
 * empty-table edge. The per-class row counts still come from probing the
 * ADOM-level object table each central pane owns —
 *   APs:      /pm/config/adom/<adom>/obj/wireless-controller/wtp
 *   Switches: /pm/config/adom/<adom>/obj/fsp/managed-switch
 * — for the integrations-page display, and the probe ("table readable AND
 * holds rows") doubles as the fallback verdict when the flags path is
 * unavailable (older builds, restricted admin). Returns null on transport
 * failure so the caller keeps the previous stamp. Runs at FMG discovery
 * start (runDiscovery) and lands on `Integration.config.centralManagement`
 * (system-owned key — the PUT handler's config merge preserves it across
 * operator edits).
 */
export async function detectCentralManagement(
  config: FortiManagerConfig,
  integrationId?: string,
): Promise<CentralManagementDetection | null> {
  const adom = config.adom || "root";
  // Row count, or null when FMG rejects the URL (class managed per-device).
  const probe = async (url: string): Promise<number | null> => {
    const res = (await proxyQuery(config, "get", [{ url }], integrationId)) as {
      result?: Array<{ status?: { code?: number }; data?: unknown }>;
    };
    const r = res?.result?.[0];
    if (r?.status?.code !== 0) return null;
    return Array.isArray(r.data) ? r.data.length : null;
  };
  // ADOM flags verdict, or nulls when any piece is unavailable. The mkey-get
  // form rejects extra attributes on some builds, so both reads use the
  // table form (filter / option are table-level attributes).
  const flagsVerdict = async (): Promise<{ wtp: boolean | null; fsw: boolean | null }> => {
    try {
      const [syntaxRes, rowRes] = await Promise.all([
        proxyQuery(config, "get", [{ url: "/dvmdb/adom", option: ["syntax"] }], integrationId),
        proxyQuery(config, "get", [{ url: "/dvmdb/adom", filter: ["name", "==", adom], fields: ["name", "flags"] }], integrationId),
      ]);
      const opts = (syntaxRes as any)?.result?.[0]?.data?.adom?.attr?.flags?.opts;
      const rows = (rowRes as any)?.result?.[0]?.data;
      const row = Array.isArray(rows) ? rows.find((r: any) => r?.name === adom) : null;
      if (!opts || typeof opts !== "object" || !row) return { wtp: null, fsw: null };
      return decodeCentralManagementFlags(row.flags, opts as Record<string, unknown>);
    } catch {
      return { wtp: null, fsw: null };
    }
  };
  try {
    const [verdict, wtpCount, fswCount] = await Promise.all([
      flagsVerdict(),
      probe(`/pm/config/adom/${adom}/obj/wireless-controller/wtp`),
      probe(`/pm/config/adom/${adom}/obj/fsp/managed-switch`),
    ]);
    return {
      wtp: verdict.wtp ?? (wtpCount ?? 0) > 0,
      fsw: verdict.fsw ?? (fswCount ?? 0) > 0,
      wtpCount,
      fswCount,
      detectedAt: new Date().toISOString(),
    };
  } catch {
    return null; // FMG unreachable — keep the previous stamp
  }
}

/**
 * Run an arbitrary FortiOS REST call against a managed FortiGate by wrapping
 * it in FortiManager's `/sys/proxy/json` endpoint. Used by the reservation
 * push path when the integration has `useProxy=true` — the call lands on the
 * FortiGate's running config in real time, with FortiManager forwarding using
 * its own stored device credentials.
 *
 * `method` maps to the proxy `action`: "GET" → "get", "POST" → "post", etc.
 * `body` is forwarded as the proxy `payload` for POST/PUT.
 *
 * Returns the FortiOS body's `results` field on success. The wrapper unpacks
 * both the FMG-level status (`result[0].status.code === 0`) and the
 * FortiOS-level HTTP status (`data[0].status.code` 2xx); either non-success
 * throws AppError(502).
 */
export async function fmgProxyRest<T = unknown>(
  config: FortiManagerConfig,
  deviceName: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  resource: string,
  opts: { body?: unknown; signal?: AbortSignal; integrationId?: string } = {},
): Promise<T> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const action = method.toLowerCase();

  const data: Record<string, unknown> = {
    target: [`/adom/${adom}/device/${deviceName}`],
    action,
    resource,
  };
  if (opts.body !== undefined && (method === "POST" || method === "PUT")) {
    data.payload = opts.body;
  }

  const payload: JsonRpcRequest = {
    id: 1,
    method: "exec",
    params: [{ url: "/sys/proxy/json", data }],
  };

  const res = await rpc(baseUrl, payload, config.apiUser, config.apiToken, config.verifySsl, opts.signal, opts.integrationId);

  const fmgCode = res.result?.[0]?.status?.code;
  if (fmgCode !== 0) {
    const msg = res.result?.[0]?.status?.message || "FortiManager rejected the request";
    if (fmgCode === -11) throw new AppError(502, "FortiManager: invalid or expired API token");
    throw new AppError(502, `FortiManager proxy error: ${msg}`);
  }

  // The proxy response wraps each target's reply. Single target → single entry.
  const proxyData = res.result?.[0]?.data as any;
  const entry = Array.isArray(proxyData) ? proxyData[0] : proxyData;
  if (!entry) throw new AppError(502, "FortiManager proxy returned no response payload");

  // FortiOS HTTP status (separate from the FMG envelope status above)
  const httpStatus =
    entry?.status?.code ??
    entry?.http_status ??
    entry?.response?.http_status ??
    200;
  if (httpStatus < 200 || httpStatus >= 300) {
    const msg =
      entry?.status?.message ||
      entry?.response?.error ||
      entry?.response?.message ||
      `FortiGate returned HTTP ${httpStatus}`;
    throw new AppError(502, `FortiGate (via FMG proxy) error: ${msg}`);
  }

  // FortiOS REST envelope wraps real data under `response.results`. Some
  // monitor endpoints set the body directly on `response`; CMDB writes
  // typically echo `mkey` at the top level of the response.
  const inner = entry?.response ?? entry;
  return (inner?.results ?? inner) as T;
}

// ─── Native FMG write helpers (no /sys/proxy/json) ─────────────────────────

/**
 * Write a managed FortiGate's `gui-device-latitude` / `gui-device-longitude`
 * via FMG's CMDB tree. Same path the discovery geo fetcher reads from.
 *
 * Native FMG `update` on `/pm/config/device/<deviceName>/global/system/global`
 * — does NOT trigger an FMG install, so the change stays in FMG's CMDB until
 * an operator clicks Install Device Configuration. UI text on the write-back
 * toggle surfaces this caveat for operators.
 *
 * FortiOS stores these fields as strings; values are formatted via `.toFixed(6)`
 * to match FMG's serialized form.
 */
export async function setFmgDeviceCmdbGuiCoords(
  config: FortiManagerConfig,
  deviceName: string,
  latitude: number,
  longitude: number,
  integrationId?: string,
): Promise<void> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const payload: JsonRpcRequest = {
    id: 1,
    method: "update",
    params: [{
      url: `/pm/config/device/${deviceName}/global/system/global`,
      data: {
        "gui-device-latitude": latitude.toFixed(6),
        "gui-device-longitude": longitude.toFixed(6),
      },
    }],
  };
  const res = await rpc(baseUrl, payload, config.apiUser, config.apiToken, config.verifySsl, undefined, integrationId);
  const code = res.result?.[0]?.status?.code;
  if (code !== 0) {
    const msg = res.result?.[0]?.status?.message || "FortiManager rejected CMDB coord update";
    throw new AppError(502, `FortiManager CMDB coord write failed: ${msg}`);
  }
}

/**
 * Write per-device coordinate values into FMG's Policy & Objects metadata
 * variables (Object Configurations → Advanced → Metadata Variables) — the
 * modern FMG home for operator metavariables, where per-device values live as
 * `dynamic_mapping` entries scoped by device name. This is NOT the legacy
 * `dvmdb` device "meta fields" location (which `setFmgDeviceMetaFields` writes
 * and which returns -10/-3 on installs that moved metavars to Policy &
 * Objects). Used by the FortiGate coord write-back path.
 *
 * One JSON-RPC request, one `set` param per coordinate variable. `set` on the
 * `.../dynamic_mapping` sub-path UPSERTS only the entry matching this device's
 * `_scope` — it does NOT replace the whole mapping list (verified on a live
 * FMG), and unlike `update` it does not require the entry to pre-exist
 * (`update` fails with -3 when the device has no entry yet). `oid` is
 * FMG-assigned and deliberately omitted.
 *
 * The coordinate variables themselves must already be defined on the ADOM; an
 * undefined variable surfaces as a non-zero per-param status which throws.
 *
 * vdom is "global" — these system-level coordinate metavariables are not
 * per-VDOM (matches the `_scope` shape FMG returns for them).
 */
export async function setFmgDeviceMetavarCoords(
  config: FortiManagerConfig,
  deviceName: string,
  latitude: number,
  longitude: number,
  latMetavar = "Latitude",
  lngMetavar = "Longitude",
  integrationId?: string,
): Promise<void> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const latKey = latMetavar.trim() || "Latitude";
  const lngKey = lngMetavar.trim() || "Longitude";
  const mkEntry = (value: string) => [{ _scope: [{ name: deviceName, vdom: "global" }], value }];

  const payload: JsonRpcRequest = {
    id: 1,
    method: "set",
    params: [
      { url: `/pm/config/adom/${adom}/obj/fmg/variable/${latKey}/dynamic_mapping`, data: mkEntry(latitude.toFixed(6)) },
      { url: `/pm/config/adom/${adom}/obj/fmg/variable/${lngKey}/dynamic_mapping`, data: mkEntry(longitude.toFixed(6)) },
    ],
  };
  const res = await rpc(baseUrl, payload, config.apiUser, config.apiToken, config.verifySsl, undefined, integrationId);
  const failures: string[] = [];
  [latKey, lngKey].forEach((name, i) => {
    const code = res.result?.[i]?.status?.code;
    if (code !== 0) {
      const msg = res.result?.[i]?.status?.message || "rejected";
      failures.push(`${name}: ${msg}${code !== undefined ? ` (code ${code})` : ""}`);
    }
  });
  if (failures.length > 0) {
    throw new AppError(502, `FortiManager metavar coord write failed — ${failures.join("; ")}`);
  }
}

/**
 * Proxy an arbitrary REST call directly to a managed FortiGate, bypassing FMG.
 * Used by the manual API query tool when the user picks "Direct to FortiGate".
 * FMG is still consulted to resolve the gate's real management-interface IP.
 */
export async function proxyQueryViaFortigate(
  config: FortiManagerConfig,
  deviceName: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  query?: Record<string, string>,
  integrationId?: string,
  body?: unknown,
): Promise<unknown> {
  if (!config.fortigateApiToken) {
    throw new AppError(400, 'Direct mode requires "FortiGate API Token" to be set on this integration');
  }
  const mgmtIfaceName = config.mgmtInterface?.trim();
  if (!mgmtIfaceName) {
    throw new AppError(400, 'Direct mode requires "Management Interface" to be set on this integration');
  }

  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const mgmtIp = await resolveDeviceMgmtIp(baseUrl, config, deviceName, mgmtIfaceName, undefined, integrationId);
  if (!mgmtIp) {
    throw new AppError(502, `Could not resolve a management IP for "${deviceName}" on interface "${mgmtIfaceName}"`);
  }

  const fgConfig: FortiGateConfig = {
    host: mgmtIp,
    port: 443,
    apiUser: config.fortigateApiUser || "",
    apiToken: config.fortigateApiToken,
    vdom: "root",
    verifySsl: config.fortigateVerifySsl === true,
    mgmtInterface: mgmtIfaceName,
  };

  return fgProxyQuery(fgConfig, method, path, query, body);
}

// ─── DHCP Discovery ─────────────────────────────────────────────────────────

export interface DiscoveredSubnet {
  cidr: string;
  name: string;           // DHCP server interface name
  fortigateDevice: string;
  // Chassis serial of the gate that reported this subnet. `fortigateDevice` is
  // a NAME and names get changed; the serial is chassis identity and never
  // does, which is what lets syncDhcpSubnets tell a rename (re-point quietly)
  // from a replacement (raise the `chassis-replaced` conflict). Business rule
  // 41. Optional because it must stay TRI-STATE end to end: a source that
  // could not read a serial reports UNKNOWN, never "different" — one failed
  // CMDB read would otherwise declare every subnet on the fleet replaced.
  fortigateSerial?: string;
  dhcpServerId: string;
  vlan?: number;          // 802.1Q VLAN ID from the interface, if present
}

export interface DiscoveredDevice {
  name: string;           // device name in FortiManager
  hostname: string;
  serial: string;
  model: string;
  mgmtIp: string;        // management IP from device list
  // MAC address of the firewall's management interface, read from
  // `/api/v2/cmdb/system/interface` (the `macaddr` field) on the same query
  // that resolves mgmtIp. Colon-separated uppercase, or omitted when the
  // interface reports no / an all-zero MAC. Consumed by
  // buildFortigateFirewallObservedBlob + written directly onto Asset.macAddress
  // (NOT projection-owned) so the firewall is found by MAC in discovery's
  // in-memory index, preventing a duplicate `fortigate-endpoint` ghost asset
  // when the firewall's own mgmt MAC is later learned via DHCP/ARP/inventory.
  // Reflects the currently-active HA member (the box REST reaches via the
  // cluster IP); only stamped on the primary member's Asset.
  mgmtMac?: string;
  // EVERY physical interface MAC on the firewall (deduped, all-zero dropped),
  // from the same `/api/v2/cmdb/system/interface` read. A peer FortiGate can
  // sight this firewall on ANY interface (not just the one bearing the mgmt
  // IP), so the firewall Asset is indexed by all of these to reliably prevent
  // a duplicate `fortigate-endpoint` ghost. Primary HA member only.
  interfaceMacs?: string[];
  // FortiOS firmware version. FMG: built from `os_ver` + `mr` + `patch` on the
  // device-list record (e.g. "7.4.5"). Standalone FortiGate: `version` field
  // from /api/v2/monitor/system/status. Consumed by buildFortigateFirewallObservedBlob
  // in integrations.ts → projected onto Asset.osVersion via projectAssetFromSources.
  osVersion?: string;
  latitude?: number;     // decimal degrees, from config system global (Device Map)
  longitude?: number;    // decimal degrees
  // FMG per-device metavariables `Latitude` / `Longitude`. Operator-managed
  // convention; pre-existing FMG installs commonly use these to track site
  // coords independently of the FortiGate's `gui-device-*` CMDB fields.
  // Highest-priority lat/lng source — beats `latitude`/`longitude` above in
  // syncDhcpSubnets Phase 11.5. Populated by the device-list query, which
  // adds `option: ["get meta"]` so FMG includes `meta fields` per device.
  // SNMP sysLocation (when enabled) is pulled separately in integrations.ts
  // Phase 11.5 — kept out of the discovery service to avoid a cycle with
  // monitoringService (which the SNMP helper uses for session infrastructure).
  metavarLatitude?: number;
  metavarLongitude?: number;
  // FMG per-device metavariable holding a street address (operator-named via
  // `fortigateMonitor.addressMetavar`). When present, syncDhcpSubnets Phase 11.5
  // geocodes this string in preference to SNMP sysLocation. FMG-only; undefined
  // on standalone-FortiGate-discovered firewalls and when no address metavar is
  // configured / populated.
  metavarAddress?: string;
  // HA cluster awareness. `haMembers` lists every physical unit in the cluster
  // (including the current primary), each keyed on its own stable serial. The
  // top-level fields (`serial`, `hostname`, `mgmtIp`) reflect whichever member
  // is currently active — FortiOS REST against the cluster IP always reaches
  // that one, and FMG's device record flips on failover. The standby member's
  // identity lives only in `haMembers`, so the sync pipeline keys per-member
  // Asset writes off this array to stay stable across failover. Omitted or
  // empty `haMembers` means standalone.
  haMode?: "standalone" | "a-p" | "a-a";
  haMembers?: Array<{
    serial: string;
    name?: string;       // member hostname (FortiOS sys_name / FMG ha_slave[].name)
    priority?: number;
    isPrimary: boolean;
    // Per-member health from FMG's ha_slave[].status (1=up, 0=down —
    // verify-on-real-FMG; unknown encodings stay undefined). This is the only
    // live health signal for a STANDBY member: probes against the cluster IP
    // always reach the active member, so the sync pipeline stamps this onto
    // the standby Asset's fortinetTopology and alerts on up→down flips.
    // Standalone-FortiGate discovery stamps "up" for members listed by
    // /monitor/system/ha-peer (a dead member drops out of that roster).
    status?: "up" | "down";
  }>;
  // True when this device was OFFLINE in FMG (conn_status !== 1) and its config
  // was read from FMG's cached CMDB rather than a live query. Config-only: the
  // sync must NOT advance Asset.lastSeen or resurrect a decommissioned firewall
  // from an offline read (business rule #12 — lastSeen = verified presence).
  offline?: boolean;
}

export interface DiscoveredInterfaceIp {
  device: string;         // FortiGate device name
  interfaceName: string;  // interface name (e.g. "port5")
  ipAddress: string;      // IP address of the interface
  role: string;           // "interface" or "management"
}

export interface DiscoveredDhcpEntry {
  device: string;           // FortiGate device name
  interfaceName: string;    // DHCP server interface
  ipAddress: string;        // Leased or reserved IP
  macAddress: string;       // Client MAC address
  hostname: string;         // Client hostname (if available)
  type: "dhcp-reservation" | "dhcp-lease"; // Static reservation vs dynamic lease
  expireTime?: number;      // Unix timestamp from expire_time (dynamic leases only)
  accessPoint?: string;     // AP name for wireless leases
  ssid?: string;            // SSID for wireless leases
  vci?: string;             // Vendor class identifier (e.g. "FortiSwitch-108F-FPOE")
  // FortiOS CMDB pointers — populated only for static dhcp-reservation
  // entries (the live monitor / lease side doesn't carry CMDB ids). Used
  // by the queued-push fast-path-adopt logic in syncDhcpSubnets: when a
  // pending Polaris reservation's MAC matches a freshly-discovered static
  // reservation, we promote in place and pin the device-side row via these
  // ids so a future unpush hits the exact entry without re-resolving by IP.
  scopeId?: number;
  entryId?: number;
  // True when /api/v2/monitor/system/dhcp confirmed this IP is currently
  // being actively leased by a client — set on dhcp-lease entries (always)
  // and on dhcp-reservation entries whose target client is online holding
  // the lease. Used by the sync to stamp Reservation.lastSeenLeased so the
  // stale-reservation job can detect static reservations whose target has
  // never been (or hasn't been recently) seen actively online.
  seenLeased?: boolean;
}

export interface DiscoveredInventoryDevice {
  device: string;           // FortiGate that detected this client
  macAddress: string;
  ipAddress: string;
  hostname: string;
  os: string;               // Detected OS (e.g. "Windows", "Linux", "macOS")
  osVersion: string;        // Detailed version (e.g. "Windows 11 23H2")
  hardwareVendor: string;   // NIC / device manufacturer
  interfaceName: string;    // FortiGate interface the device is on
  switchName: string;       // FortiSwitch name (if behind a managed switch)
  switchPort: string;       // FortiSwitch port (if behind a managed switch)
  apName: string;           // FortiAP name (if connected wirelessly)
  user: string;             // Logged-in / registered user (if available)
  isOnline: boolean;
  lastSeen: string;         // ISO timestamp
}

export interface DiscoveredFortiSwitch {
  device: string;       // FortiGate controller name
  // Serial of the controller FortiGate (FMG device-list `serial` / the
  // standalone gate's own serial). The DEFINITIVE controller identity: FMG's
  // device NAME is operator-assigned inside FMG and routinely differs from the
  // gate's configured `system global hostname`, which is what lands on
  // Asset.hostname — so name-based parent resolution silently drops the edge on
  // any install where the two diverge (prod 2026-08-12: dependency suppression,
  // Device Map site membership, region assignment and interface auto-monitor all
  // failed for one gate's switches). Stamped onto
  // fortinetTopology.controllerSerial; consumers resolve serial-first and fall
  // back to the name. Optional because a pre-upgrade cached row may lack it.
  deviceSerial?: string;
  name: string;         // switch-id
  serial: string;
  ipAddress: string;    // connecting_from
  fgtInterface: string; // fgt_peer_intf_name (FortiLink interface on FortiGate)
  osVersion: string;
  joinTime?: number;    // join_time (Unix timestamp — when first authorized)
  state: string;        // "Authorized" | "Unauthorized"
  connected: boolean;   // status === "Connected"
  // Management MAC of the switch's FortiLink-peer interface, normalized to
  // colon-uppercase. Cross-joined from the detected-device MAC table where
  // `is_fortilink_peer===true` and `switch_id === <this switch's switch-id>`.
  // Used by the sync layer to dedup against DHCP/ARP-discovered orphan
  // endpoint assets at the switch's mgmt IP — without it, the switch's own
  // management MAC creates a phantom "fortigate-endpoint" asset alongside
  // the authoritative "fortiswitch" asset.
  baseMac?: string;
  // The switch's PHYSICAL uplink port to its controller FortiGate (e.g.
  // "port47"), resolved from the switch-controller managed-switch CMDB
  // (`findFortiswitchUplinkPorts`). Distinct from `fgtInterface`, which is the
  // FortiGate-side logical "fortilink" interface. Only set when the switch has
  // exactly one directly-cabled uplink port (chain-head switches); null for
  // switches chained behind another FortiSwitch over an ISL trunk, or when the
  // CMDB read was unavailable. Stamped onto Asset.fortinetTopology.uplinkPhysicalPort
  // so the Device Map labels the FortiGate↔switch edge's switch side with the
  // real port instead of the opaque "fortilink".
  uplinkPhysicalPort?: string | null;
  // Operator-set admin description from the managed-switch CMDB row. Carries
  // physical-location codes (a:/b:/f:/r:/jb: — see utils/locationCodes.ts) that
  // drive Device Map grouping. Stamped onto fortinetTopology.deviceDescription
  // and synced into Asset.notes by the sync layer. null = CMDB read
  // unavailable or the device has no description.
  description?: string | null;
}

export interface DiscoveredFortiAP {
  device: string;      // FortiGate controller name
  // Serial of the controller FortiGate — the definitive controller identity.
  // See DiscoveredFortiSwitch.deviceSerial for why the name isn't.
  deviceSerial?: string;
  name: string;
  serial: string;
  model: string;
  ipAddress: string;
  baseMac: string;
  status: string;
  // Controller admission state from managed_ap's `state` field ("authorized"
  // / "discovered" / ...). Distinct from `status` (connectivity). Stamped
  // onto fortinetTopology.state + the fortiap observed blob; drives the
  // Authorization row on the asset details General tab. Empty when the
  // firmware omits the field.
  authorizationState: string;
  // AP profile the WTP is bound to on the controller (`wtp_profile`).
  // Stamped onto fortinetTopology.profile + the fortiap observed blob;
  // drives the AP Profile row on the asset details General tab. Empty when
  // the firmware omits the field.
  profile: string;
  // Radio inventory + the SSIDs each radio broadcasts, off the same
  // managed_ap row. Absent when the firmware published no `radio` array —
  // "unknown, do not wipe", the same contract as lldpNeighbors.
  radios?: import("../utils/fortiapMonitorRow.js").ApRadioSample[];
  osVersion: string;
  // Wired uplink to the controller. peerSource records HOW we learned it:
  //   "lldp"            — from the AP's own LLDP table (system_description starts with "FortiSwitch-")
  //   "detected-device" — from the FortiSwitch's detected-device MAC table (legacy fallback)
  // LLDP wins when both are available — it's authoritative (the AP itself
  // reports its uplink) and works even when FortiOS filters managed-AP MACs
  // out of detected-device.
  peerSwitch?: string; // FortiSwitch name this AP is uplinked to
  peerPort?: string;   // Port on peerSwitch (e.g. "port9")
  peerVlan?: number;   // VLAN tag (detected-device only — LLDP path doesn't carry it)
  peerSource?: "lldp" | "detected-device";
  // Mesh topology. parent_wtp_id from the FortiOS payload identifies the
  // parent FortiAP serial when this AP is a mesh leaf (mesh_uplink = "mesh").
  // Drives the topology graph's wireless-mesh edge — without it, a mesh
  // leaf would render hanging off the FortiGate or its detected-device
  // resolved switch instead of its actual mesh parent.
  meshUplink?: "ethernet" | "mesh";
  parentApSerial?: string;
  // AP's own local port that uplinks to the FortiSwitch (or the FortiGate
  // when no managed switch sits between them). Captured from
  // `wan_status[].interface` first — authoritative — falling back to the
  // matching LLDP entry's `local_port`. `lan*` are physical Ethernet
  // ports, `wbh*` are virtual wireless bridge interfaces. Drives the
  // FortiAP-side label on the topology edge.
  apUplinkInterface?: string;
  // Full LLDP neighbor table from the managed_ap row — every entry (the
  // FortiSwitch uplink, wireless-mesh FortiAP peers, non-Fortinet gear),
  // not just the single-uplink summary the peer* fields above distill.
  // The sync layer persists these as real AssetLldpNeighbor rows (source
  // "managed-ap") via monitoringService.persistManagedApLldpNeighbors so
  // the asset-details LLDP section and Device Map show the AP's exact
  // neighbors instead of peer-inferred ones. `undefined` = the row carried
  // no `lldp` array (firmware variance) — the sync layer must not wipe
  // existing rows; `[]` = a real "no neighbors" scrape.
  lldpNeighbors?: ApLldpNeighborSample[];
  // Live telemetry snapshot pulled from /api/v2/monitor/wifi/managed_ap
  // during discovery. None of these write to AssetTelemetrySample from
  // discovery — they ride along in the AssetSource observed blob so the
  // Sources tab can show "as of last discovery" values, and the
  // monitoring path (runTelemetryFor) re-queries the same endpoint on
  // its own cadence to populate sample tables.
  cpuPct?: number;
  memFreeMb?: number;
  memTotalMb?: number;
  sensorTemperatures?: Array<{ name: string; celsius: number }>;
  // Operator-set admin description from the wireless-controller wtp CMDB row
  // (`location` field — AP Manager's field, the description-sync surface —
  // with `comment` as fallback; the monitor endpoint carries neither). Same
  // role as DiscoveredFortiSwitch.description: physical-location codes for
  // Device Map grouping, stamped onto fortinetTopology.deviceDescription.
  // null = roster read unavailable or no location/comment set.
  description?: string | null;
}

export interface DiscoveredVip {
  device: string;      // FortiGate device name
  name: string;        // VIP object name (used as hostname on reservations)
  extip: string;       // External IP address
  mappedips: string[]; // Internal mapped IP addresses
  extintf: string;     // External interface name
  // FortiOS load-balance Virtual Servers live in the same firewall/vip CMDB
  // table (`type: server-load-balance`). Their backend pool is the
  // `realservers` child table (not `mappedip`), so they get their own array
  // and a flag the sync phase uses to label reservations "fortimanager-vs"
  // instead of "fortimanager-vip". Detection is structural-first (non-empty
  // realservers) with the type string as confirmation — FMG encodes CMDB
  // enums inconsistently across releases, so we never rely on type alone.
  isVirtualServer: boolean;
  realservers: string[]; // Virtual-server backend pool member IPs
}

// Classify a raw firewall/vip row as a load-balance Virtual Server and
// extract its realserver pool IPs. Shared by the FMG proxy path and the
// standalone FortiGate REST path (fortigateService imports it) so the two
// transports can't drift on field handling. FortiOS REST returns `type` as
// a string; FMG JSON-RPC has returned CMDB enums as integers on some
// releases, so a non-empty realservers pool is the primary signal and the
// string match only catches VSes whose pool is currently empty. Pool
// members sharing one IP on different ports collapse to a single entry.
export function parseVipServerInfo(vip: any): { isVirtualServer: boolean; realservers: string[] } {
  const realservers: string[] = [];
  if (Array.isArray(vip?.realservers)) {
    for (const rs of vip.realservers) {
      const raw = Array.isArray(rs?.ip) ? rs.ip[0] : rs?.ip;
      const ip = parseRangeFirstIp(String(raw || ""));
      if (ip && !realservers.includes(ip)) realservers.push(ip);
    }
  }
  const isVirtualServer = realservers.length > 0 || String(vip?.type || "") === "server-load-balance";
  return { isVirtualServer, realservers };
}

// Per-port MAC learnings from each managed FortiSwitch under this FortiGate's
// switch-controller (`/api/v2/monitor/switch-controller/detected-device`).
// One row per (switch, port, MAC) entry. Captures the full FortiSwitch L2
// view, not just FortiAP MACs — so endpoint assets (workstations, printers,
// servers) can be attributed to their access port.
//
// Device Detection-derived fields (ipv4Address, deviceName, deviceType,
// osName, hostSrc) are populated only when `config switch-controller
// network-monitor-settings` has device detection enabled on the FortiSwitch
// — they may be empty even when MAC + switch + port are known.
export interface DiscoveredSwitchMacEntry {
  fortigateDevice: string;
  switchId: string;
  portName: string;
  mac: string;                 // Normalized: uppercase, colon-separated
  vlanId?: number;
  lastSeen?: number;           // FortiOS Unix epoch
  ipv4Address?: string;
  ipv6Address?: string;
  deviceName?: string;
  deviceType?: string;
  osName?: string;
  hostSrc?: string;
  isFortilinkPeer?: boolean;
}

// FortiGate ARP entries (`/api/v2/monitor/network/arp`). Authoritative L3
// MAC↔IP binding per FortiGate-managed subnet. Used to enrich endpoint
// asset records when discovery sees a known MAC but a fresher IP than
// what's currently on the asset row.
export interface DiscoveredArpEntry {
  fortigateDevice: string;
  ip: string;
  mac: string;                 // Normalized: uppercase, colon-separated
  interface: string;           // FortiGate interface name (e.g. "internal3")
  age?: number;                // seconds (when FortiOS exposes it)
}

export interface DiscoveryResult {
  subnets: DiscoveredSubnet[];
  devices: DiscoveredDevice[];
  interfaceIps: DiscoveredInterfaceIp[];
  dhcpEntries: DiscoveredDhcpEntry[];
  deviceInventory: DiscoveredInventoryDevice[];
  // FortiGates whose inventory query succeeded this run (may be empty-result).
  // Used to scope stale-device sweep: MAC stamps pointing to devices NOT in this
  // list are left alone (we didn't get a fresh answer).
  inventoryDevices: string[];
  // All FortiGates configured in FortiManager, regardless of conn_status or
  // include/exclude filter. A subnet's fortigateDevice missing from this set
  // means the device was removed from FMG — safe to deprecate. An offline but
  // still-configured device remains here, so its subnets are left alone.
  // HA cluster members ride this list too: a standby's hostname never appears
  // at the top-level device name, only inside `ha_slave[]`, and it is just as
  // "still configured" as the member currently holding the cluster IP.
  knownDeviceNames: string[];
  // The serial sibling of `knownDeviceNames` — every FortiGate CHASSIS the
  // upstream knows, captured from the same raw roster (pre-filter, any
  // conn_status) and including every `ha_slave[]` member. This is the ONLY
  // place an HA standby's identity can come from, which is why it is roster-
  // sourced rather than collected from the devices that happened to process
  // successfully: a gate that failed, was skipped for a missing management IP
  // or was filtered out keeps its primary (still in the roster by name) and
  // would otherwise lose its standby to the Phase 2a stale-firewall sweep.
  knownDeviceSerials: string[];
  fortiSwitches: DiscoveredFortiSwitch[];
  fortiAps: DiscoveredFortiAP[];
  vips: DiscoveredVip[];
  // Full per-port MAC table from every managed FortiSwitch's
  // detected-device endpoint, plus the FortiGate's own ARP table. Used by
  // the sync pipeline to enrich existing assets with their L2 location
  // (lastSeenSwitch) and a fresh IP from L3 ARP. The legacy AP→switch
  // attribution loop (now LLDP-first) still consumes the raw rows
  // internally; these arrays expose the same data to the sync layer.
  switchMacTable: DiscoveredSwitchMacEntry[];
  arpTable: DiscoveredArpEntry[];
  // FortiGates whose ARP query ANSWERED this cycle (status 0 + a results
  // array), regardless of how many rows came back. Persisting the ARP table is
  // a delete-replace, so this is what separates "the neighbour cache is empty"
  // from "the read failed": an offline gate, a missing monitor scope or an
  // aborted run all return nothing, and wiping on that would blank a healthy
  // gate's table. Same contract as `inventoryDevices` / AssetLldpNeighbor.
  arpQueriedDevices: string[];
  // CMDB-known managed-switch / FortiAP rosters per FortiGate, queried
  // natively from FMG's CMDB (not via /sys/proxy/json — bypasses the
  // proxy-mode concurrency=1 throttle). Defensive: a switch/AP that's
  // configured at FMG but currently offline / in a brief post-config-push
  // window may be missing from the live monitor query; surfacing the
  // CMDB-known serials lets the decommission sweep treat them as "still
  // known" rather than declaring them stale. Each entry carries the
  // FortiGate it was read from so the sweep can scope the protection
  // per-controller: an FMG-offline gate's CACHED roster must only protect
  // devices whose recorded controller IS that gate, never vouch fleet-wide
  // (prod 2026-07: a retired-but-still-in-FMG gate's stale cached wtp
  // roster listed another site's full AP fleet and shielded ghost APs from
  // the sweep forever). Duplicates across FortiGates are possible if a
  // misconfigured switch is authorized on two controllers.
  cmdbSwitchSerials: Array<{ device: string; serial: string }>;
  cmdbApSerials: Array<{ device: string; serial: string }>;
  // Devices whose managed-switch query returned successfully (including
  // empty results, which mean "no managed switches" rather than "query
  // failed"). Used by the sync pass to decommission switches whose
  // controller was reachable but no longer reports them — we never
  // decommission switches behind an offline controller.
  switchInventoriedDevices?: string[];
  // Same as above, for the FortiAP managed_ap query.
  apInventoriedDevices?: string[];
  // Per-gate managed-device MEMBERSHIP, read from the controller own CMDB.
  // Answers "which switches / APs COULD hang off this gate", which is what
  // bounds the dependency graph (dependencyTreeService). Deliberately its own
  // field rather than a second reading of cmdbSwitchSerials: those exist to
  // PROTECT assets from the decommission sweep, and membership must never
  // influence any sweep. Optional by design -- absent = unknown = no
  // constraint, which is what every pre-existing construction site means.
  managedMembership?: {
    switches: Array<{ device: string; serial: string }>;
    aps: Array<{ device: string; serial: string }>;
    // Gates whose roster read ANSWERED (incl. zero rows). Only for these is an
    // empty member list the real answer "manages none" rather than "unknown".
    switchDevices: string[];
    apDevices: string[];
  };
  // Devices whose firewall/vip query returned successfully (incl. empty
  // results). Used by syncDhcpSubnets Phase 5b to release stale VIP
  // reservations: a VIP row whose vipInfo.device is in this set but whose
  // IP isn't reported in result.vips this cycle means the operator
  // deleted the VIP on the FortiGate. VIPs whose source FortiGate's
  // query FAILED are left alone — we didn't get a fresh answer.
  vipInventoriedDevices?: string[];
  // Devices whose CMDB DHCP-server query returned successfully. Used by
  // Phase 5b to release stale dhcp_reservation rows — a CMDB entry
  // missing from a successful query means an operator deleted the
  // reservation on the FortiGate (the gate is the authoritative source
  // for static DHCP reservations). Polaris-pushed manual reservations
  // that have flipped to sourceType="dhcp_reservation" follow the same
  // rule once their target entry disappears.
  dhcpReservationsInventoriedDevices?: string[];
  // Devices whose live DHCP-monitor query returned successfully. Not
  // currently consumed by Phase 5b — dhcp_lease rows age out via the
  // expireReservations job and the stale-reservation alert system, so
  // a single missed monitor scrape shouldn't wipe history. Surfaced for
  // future use / observability.
  dhcpLeasesInventoriedDevices?: string[];
}

export type DiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
  device?: string,
) => void;

/**
 * Every identity the FMG device roster knows, from the RAW `/dvmdb/adom/<adom>
 * /device` payload — pre-filter, any conn_status, HA members included.
 *
 * The HA half is the point. A cluster's standby never appears at the top-level
 * `name`/`sn`; its identity lives only inside `ha_slave[]`. Collecting member
 * identities from the PROCESSED devices instead (which is what the sync layer
 * used to do) tied a standby's survival to its cluster being reachable: one
 * gate that failed its direct read, was skipped for an unresolved management
 * IP, or was dropped by the include/exclude filter still contributed its
 * top-level name — so the primary asset matched the roster and lived, while
 * the standby matched nothing and was decommissioned by the Phase 2a stale-
 * firewall sweep. Roster membership is config truth for every member of every
 * cluster, online or not, so it is captured in one place, once.
 *
 * `ha_mode` is deliberately NOT consulted: a member listed in `ha_slave[]` is
 * a configured chassis whatever the mode field says, and this function answers
 * "does the upstream still know this box", not "what shape is the cluster".
 * Duplicates are possible (the primary appears both at top level and in
 * `ha_slave[]`) and harmless — both consumers build Sets.
 */
export function extractRosterIdentities(devicesRaw: any[]): { names: string[]; serials: string[] } {
  const names: string[] = [];
  const serials: string[] = [];
  const pushName = (v: unknown) => { if (typeof v === "string" && v.length > 0) names.push(v); };
  const pushSerial = (v: unknown) => { if (typeof v === "string" && v.length > 0) serials.push(v); };
  for (const d of Array.isArray(devicesRaw) ? devicesRaw : []) {
    pushName(d?.name || d?.hostname);
    pushSerial(d?.sn);
    for (const m of Array.isArray(d?.ha_slave) ? d.ha_slave : []) {
      pushName(m?.name);
      pushSerial(m?.sn);
    }
  }
  return { names, serials };
}

/** One chassis's reachability as FortiManager currently understands it. */
export interface RosterDeviceStatus {
  /** FMG device name (top level), or the `ha_slave[]` member name. */
  name: string;
  /** Serial, upper-cased — the join key. */
  serial: string;
  connected: boolean;
  /** Raw signal, surfaced verbatim in probe errors so an operator can see what FMG said. */
  raw: string;
  /** True when the row came from `ha_slave[]` rather than the top level. */
  haMember: boolean;
}

/**
 * Reachability for every chassis in the RAW `/dvmdb/adom/<adom>/device` payload
 * — the status sibling of `extractRosterIdentities`, walking the same rows and
 * the same `ha_slave[]` members so the two cannot disagree about which serials
 * exist.
 *
 * This is FortiManager's OWN view, refreshed on FMG's check-in cadence rather
 * than by Polaris touching the device. It is therefore lagged, and it is
 * second-hand — but it is free (a native `/dvmdb` read, outside the
 * `/sys/proxy/json` concurrency-1 lane) and it covers the whole fleet in one
 * call, which is exactly what the `fortimanager` polling method trades for.
 *
 * Two encodings, both matching how discovery already reads them:
 *  - top level `conn_status`: 1 = connected. **Absent counts as connected**,
 *    the same "unknown is not down" reading `processDevice` uses to decide
 *    whether a gate is offline — an FMG that stopped reporting the field must
 *    not mass-down a fleet.
 *  - `ha_slave[].status`: 1 = member up, 0 = down. Flagged
 *    verify-on-real-FMG where it is first read (`parseHaCluster`); the same
 *    caveat applies here.
 *
 * Serials are upper-cased because every Fortinet serial join in this codebase
 * folds case on both sides.
 */
export function extractRosterConnectivity(devicesRaw: any[]): RosterDeviceStatus[] {
  const out: RosterDeviceStatus[] = [];
  for (const d of Array.isArray(devicesRaw) ? devicesRaw : []) {
    const sn = typeof d?.sn === "string" ? d.sn.trim() : "";
    if (sn) {
      const cs = d?.conn_status;
      out.push({
        name: String(d?.name || d?.hostname || ""),
        serial: sn.toUpperCase(),
        connected: cs === undefined || cs === null || cs === 1,
        raw: cs === undefined || cs === null ? "unreported" : `conn_status=${String(cs)}`,
        haMember: false,
      });
    }
    for (const m of Array.isArray(d?.ha_slave) ? d.ha_slave : []) {
      const msn = typeof m?.sn === "string" ? m.sn.trim() : "";
      if (!msn) continue;
      const st = m?.status;
      out.push({
        name: String(m?.name || ""),
        serial: msn.toUpperCase(),
        connected: st === undefined || st === null || st === 1,
        raw: st === undefined || st === null ? "unreported" : `ha_slave.status=${String(st)}`,
        haMember: true,
      });
    }
  }
  return out;
}

/**
 * Fetch the ADOM device roster and project it to per-serial reachability.
 *
 * Native `/dvmdb` read: NOT subject to FMG's `/sys/proxy/json` concurrency-1
 * throttle, and one call covers every managed gate — which is what lets the
 * monitor role poll a whole fleet's up/down for the price of a single request.
 * The monitor process cannot reuse discovery's copy of this payload (separate
 * process in the split-role layout), so it issues its own.
 */
export async function fetchRosterConnectivity(
  config: FortiManagerConfig,
  signal?: AbortSignal,
  integrationId?: string,
): Promise<RosterDeviceStatus[]> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const { apiUser, apiToken, verifySsl } = config;
  // No `fields` list, deliberately: naming fields makes FMG authorize each one
  // individually and fail the whole query with -11 when the API user's profile
  // doesn't grant one of them. See the roster fetch in discoverDhcpSubnets.
  const res = await rpc(
    baseUrl,
    { id: 1, method: "get", params: [{ url: `/dvmdb/adom/${adom}/device` }] },
    apiUser,
    apiToken,
    verifySsl,
    signal,
    integrationId,
  );
  return extractRosterConnectivity(res.result?.[0]?.data as any[]);
}

/**
 * Extract HA cluster info from a raw FMG `/dvmdb/adom/<adom>/device` record.
 * FMG exposes `ha_mode` + `ha_slave[]` directly on the device record — no
 * extra calls needed. The "current primary" is the ha_slave entry whose `sn`
 * matches the top-level `sn`; FMG keeps these in sync across failover. When
 * the device is standalone (ha_mode missing/zero or ha_slave empty), returns
 * `{ haMode: "standalone" }` so downstream code has a single branch.
 *
 * FMG encodes `ha_mode` as either a string ("standalone"|"a-p"|"a-a") or an
 * integer (0=standalone, 1=a-p, 2=a-a). Both are normalized here.
 */
export function extractHaFromFmgDevice(
  raw: any,
): { haMode: "standalone" | "a-p" | "a-a"; haMembers: NonNullable<DiscoveredDevice["haMembers"]> } {
  const slaves: any[] = Array.isArray(raw?.ha_slave) ? raw.ha_slave : [];
  const rawMode = raw?.ha_mode;
  let mode: "standalone" | "a-p" | "a-a" = "standalone";
  if (typeof rawMode === "string") {
    const norm = rawMode.toLowerCase();
    if (norm === "a-p" || norm === "ap" || norm === "active-passive") mode = "a-p";
    else if (norm === "a-a" || norm === "aa" || norm === "active-active") mode = "a-a";
    else mode = "standalone";
  } else if (typeof rawMode === "number") {
    if (rawMode === 1) mode = "a-p";
    else if (rawMode === 2) mode = "a-a";
    else mode = "standalone";
  }
  // Standalone OR empty roster — nothing useful to project.
  if (mode === "standalone" || slaves.length === 0) {
    return { haMode: "standalone", haMembers: [] };
  }
  const primarySerial: string = String(raw?.sn || "");
  // First pass: map each ha_slave row to a member with isPrimary determined
  // ONLY by the sn match. We never let idx===0 win when primarySerial is
  // known — otherwise post-failover, where device.sn now points at the
  // formerly-secondary, the idx=0 entry (still the original primary)
  // would falsely claim primary alongside the real one.
  const members: NonNullable<DiscoveredDevice["haMembers"]> = slaves
    .map((s) => {
      const sn = String(s?.sn || "");
      if (!sn) return null;
      const isPrimary = primarySerial.length > 0 && sn === primarySerial;
      const name = typeof s?.name === "string" && s.name.length > 0 ? s.name : undefined;
      const prio = Number.isFinite(s?.prio) ? Number(s.prio) : undefined;
      // ha_slave[].status: 1 = member up, 0 = member down (verify-on-real-FMG;
      // string-encoded numbers normalized, anything else → undefined so a
      // firmware that omits/renames the field degrades to "no health signal"
      // rather than a false alarm).
      const rawStatus = typeof s?.status === "string" ? Number(s.status) : s?.status;
      const status: "up" | "down" | undefined =
        rawStatus === 1 ? "up" : rawStatus === 0 ? "down" : undefined;
      return { serial: sn, name, priority: prio, isPrimary, ...(status ? { status } : {}) };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);
  // Second pass: when no member matched device.sn (primarySerial empty or
  // FMG roster out of sync), fall back to FMG's `idx === 0` convention OR
  // first member by array position. This is the only path where idx wins.
  if (members.length > 0 && !members.some((m) => m.isPrimary)) {
    const idxZero = slaves.findIndex((s) => Number.isFinite(s?.idx) && Number(s.idx) === 0 && String(s?.sn || ""));
    if (idxZero >= 0) {
      const idxZeroSerial = String(slaves[idxZero]?.sn || "");
      const target = members.find((m) => m.serial === idxZeroSerial);
      if (target) target.isPrimary = true;
      else members[0].isPrimary = true;
    } else {
      members[0].isPrimary = true;
    }
  }
  return { haMode: mode, haMembers: members };
}

/**
 * Extract FMG per-device metavariables `Latitude` / `Longitude` from a raw
 * `/dvmdb/adom/<adom>/device` record (requires `option: ["get meta"]` on the
 * device list query). Operators using FMG's pre-existing convention for
 * tracking site coords get those values surfaced as the highest-priority
 * fallback after SNMP-geocoded coords in syncDhcpSubnets Phase 11.5.
 *
 * The metavar name lookup is case-insensitive (FMG stores keys as the
 * operator typed them — `Latitude`, `latitude`, `LATITUDE` all map to the
 * same value here). The names default to the common `Latitude` / `Longitude`
 * convention but operators can rename them per integration; `addrName` (the
 * optional address metavar) is blank-disabled by default. Returns undefined
 * for missing / unparseable values; the coord resolver downstream validates
 * the (lat, lng) pair via isValidGeoCoord before trusting either half, and the
 * address string is geocoded in Phase 11.5.
 */
export function extractMetavarCoordsFromFmgDevice(
  raw: any,
  latName = "Latitude",
  lngName = "Longitude",
  addrName = "",
): { latitude?: number; longitude?: number; address?: string } {
  const meta = raw?.["meta fields"];
  if (!meta || typeof meta !== "object") return {};
  const findKey = (target: string): unknown => {
    const t = target.toLowerCase();
    for (const k of Object.keys(meta)) {
      if (k.toLowerCase() === t) return (meta as Record<string, unknown>)[k];
    }
    return undefined;
  };
  const latRaw = findKey(latName);
  const lngRaw = findKey(lngName);
  const lat = latRaw === undefined || latRaw === null || latRaw === "" ? NaN : Number(latRaw);
  const lng = lngRaw === undefined || lngRaw === null || lngRaw === "" ? NaN : Number(lngRaw);
  const out: { latitude?: number; longitude?: number; address?: string } = {};
  if (Number.isFinite(lat)) out.latitude = lat;
  if (Number.isFinite(lng)) out.longitude = lng;
  if (addrName) {
    const addrRaw = findKey(addrName);
    if (typeof addrRaw === "string" && addrRaw.trim()) out.address = addrRaw.trim();
  }
  return out;
}

/**
 * Parse a single FMG metadata-variable object (the `data` from
 * `GET /pm/config/adom/<adom>/obj/fmg/variable/<name>`) into a per-device
 * value map keyed by the LOWERCASED FMG device name found in each
 * `dynamic_mapping` entry's `_scope`. Modern FMG (Policy & Objects → Object
 * Configurations → Advanced → Metadata Variables) stores per-device metavar
 * values here, not in `dvmdb` device "meta fields".
 *
 * The top-level `value` (the ADOM-wide default) is deliberately NOT applied
 * per-device — it's the same point for every firewall and would pin the whole
 * fleet to one coordinate. Only explicit per-device `dynamic_mapping` entries
 * are surfaced.
 */
export function parseFmgVariableDynamicMapping(varData: any): Map<string, string> {
  const out = new Map<string, string>();
  const mappings = varData?.dynamic_mapping;
  if (!Array.isArray(mappings)) return out;
  for (const m of mappings) {
    const value = m?.value;
    if (typeof value !== "string" || value === "") continue;
    const scopes = Array.isArray(m?._scope) ? m._scope : [];
    for (const s of scopes) {
      const name = s?.name;
      if (typeof name === "string" && name) out.set(name.toLowerCase(), value);
    }
  }
  return out;
}

/**
 * Fetch operator-defined coordinate metadata variables from FMG's Policy &
 * Objects object DB and build a per-device coord map keyed by lowercased FMG
 * device name. This is the PRIMARY source for the Phase 11.5 coord resolution
 * chain on modern FMG installs; `extractMetavarCoordsFromFmgDevice` (legacy
 * `dvmdb` device "meta fields") remains a per-device fallback.
 *
 * One JSON-RPC `get` request, one param per defined coord variable (lat/lng,
 * plus the optional address variable when configured). A per-param status of
 * -3 ("object does not exist") is tolerated — that variable simply isn't
 * defined on this ADOM. Best-effort: any RPC/parse failure yields an empty map
 * so discovery proceeds with the existing fallbacks. Never throws.
 */
export async function fetchFmgMetavarCoordMap(
  config: FortiManagerConfig,
  latMetavar: string,
  lngMetavar: string,
  addrMetavar: string,
  signal?: AbortSignal,
  integrationId?: string,
): Promise<Map<string, { latitude?: number; longitude?: number; address?: string }>> {
  const out = new Map<string, { latitude?: number; longitude?: number; address?: string }>();
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";

  const wanted: Array<{ key: "latitude" | "longitude" | "address"; name: string }> = [
    { key: "latitude", name: latMetavar.trim() || "Latitude" },
    { key: "longitude", name: lngMetavar.trim() || "Longitude" },
  ];
  if (addrMetavar.trim()) wanted.push({ key: "address", name: addrMetavar.trim() });

  // FMG expects the raw (un-encoded) name in the JSON `url` field, matching
  // every other URL built in this file.
  const params = wanted.map((w) => ({ url: `/pm/config/adom/${adom}/obj/fmg/variable/${w.name}` }));

  let res: JsonRpcResponse;
  try {
    res = await rpc(baseUrl, { id: 1, method: "get", params }, config.apiUser, config.apiToken, config.verifySsl, signal, integrationId);
  } catch (err: any) {
    logger.warn({ integrationId, err: err?.message }, "fmg_metavar_coords.fetch_failed");
    return out;
  }

  wanted.forEach((w, i) => {
    const entry = res.result?.[i];
    if (!entry || entry.status?.code !== 0) return;
    const perDevice = parseFmgVariableDynamicMapping(entry.data);
    for (const [name, valueStr] of perDevice) {
      const rec = out.get(name) || {};
      if (w.key === "address") {
        const trimmed = valueStr.trim();
        if (trimmed) rec.address = trimmed;
      } else {
        const num = Number(valueStr);
        if (Number.isFinite(num)) rec[w.key] = num;
      }
      out.set(name, rec);
    }
  });

  return out;
}

/**
 * Build a FortiOS version string ("7.4.5") from a raw FMG `/dvmdb/adom/<adom>/device`
 * record. FMG splits the version across three integer fields: `os_ver` (major),
 * `mr` (minor release), `patch`. Returns "" when the major version is missing
 * or unparseable so the caller can fall back to other sources.
 */
export function buildFmgOsVersion(raw: any): string {
  const major = Number(raw?.os_ver);
  if (!Number.isFinite(major) || major <= 0) return "";
  const mr = Number(raw?.mr);
  const patch = Number(raw?.patch);
  const parts: number[] = [major];
  if (Number.isFinite(mr) && mr >= 0) parts.push(mr);
  if (Number.isFinite(patch) && patch >= 0) parts.push(patch);
  return parts.join(".");
}

/**
 * Query FortiManager for DHCP servers across all managed FortiGate devices.
 * Returns discovered subnets, device metadata (for asset creation),
 * and interface IPs (for reservation creation).
 */
// --- FMG per-device discovery steps (split 2026-08, template: the FGT chain
// conversion in fortigateService.ts) --- each numbered step is a named
// function over one per-device context. Accumulator arrays mutate in place
// through the context references; the query-landed booleans the sync's
// decommission / Phase 5b sweeps consume live in ctx.flags (an object, so
// writes propagate across the function boundary). Bodies are verbatim from
// the pre-split processDevice except the flags.* prefix and the offline
// gates hoisted to early returns.
interface FmgDeviceCtx {
  config: FortiManagerConfig;
  baseUrl: string;
  adom: string;
  apiUser: FortiManagerConfig["apiUser"];
  apiToken: FortiManagerConfig["apiToken"];
  verifySsl: FortiManagerConfig["verifySsl"];
  signal: AbortSignal | undefined;
  integrationId: string | undefined;
  log: DiscoveryProgressCallback;
  mgmtIfaceName: string;
  inventoryMaxAgeHours: number;
  arpSweepTargets: Map<string, string[]> | undefined;
  deviceName: string;
  offline: boolean;
  localDevice: DiscoveredDevice;
  localSubnets: DiscoveredSubnet[];
  localInterfaceIps: DiscoveredInterfaceIp[];
  localDhcpEntries: DiscoveredDhcpEntry[];
  localInventory: DiscoveredInventoryDevice[];
  localSwitches: DiscoveredFortiSwitch[];
  localAps: DiscoveredFortiAP[];
  localSwitchMacTable: DiscoveredSwitchMacEntry[];
  localArpTable: DiscoveredArpEntry[];
  localCmdbSwitchSerials: Array<{ device: string; serial: string }>;
  localCmdbApSerials: Array<{ device: string; serial: string }>;
  localVips: DiscoveredVip[];
  flags: {
    didInventory: boolean;
    didSwitchQuery: boolean;
    didApQuery: boolean;
    didVipQuery: boolean;
    didDhcpReservationsQuery: boolean;
    didDhcpLeasesQuery: boolean;
    // Set only when the live /monitor/network/arp read came back clean. Kept
    // separate from the row count so an empty-but-real neighbour cache still
    // replaces the stored table.
    didArpQuery: boolean;
    // Whether each native CMDB roster read ANSWERED. Distinct from the row
    // count on purpose: cmdbSwitchSerials/cmdbApSerials are empty both when the
    // read failed and when the gate genuinely manages none, and the dependency
    // membership constraint has to tell those apart -- an unreadable roster
    // must mean unknown, never "manages nothing".
    didSwitchCmdbRoster: boolean;
    didApCmdbRoster: boolean;
  };
}

// Step 1: resolve the management-interface IP + MACs from FMG's device CMDB.
async function fmgStepMgmtIp(ctx: FmgDeviceCtx): Promise<void> {
  const { baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, mgmtIfaceName, localDevice, localInterfaceIps } = ctx;
    // Step 1: Resolve management interface IP from device config
    try {
      const mgmtIfacePayload: JsonRpcRequest = {
        id: 6,
        method: "get",
        // No name filter — fetch ALL interfaces so we capture every physical
        // MAC (see DiscoveredDevice.interfaceMacs), not just the mgmt one.
        params: [{ url: `/pm/config/device/${deviceName}/global/system/interface`, fields: ["name", "ip", "macaddr"], loadsub: 0 }],
      };
      const mgmtIfaceRes = await rpc(baseUrl, mgmtIfacePayload, apiUser, apiToken, verifySsl, signal, integrationId);
      const ifaceList = mgmtIfaceRes.result?.[0]?.data;
      if (Array.isArray(ifaceList)) {
        const found = (ifaceList as any[]).find((i) => i.name === mgmtIfaceName);
        const rawIp = found
          ? (Array.isArray(found.ip) ? found.ip[0] : (found.ip as string | null))
          : null;
        if (rawIp && rawIp !== "0.0.0.0" && isValidIpv4(rawIp)) {
          localDevice.mgmtIp = rawIp;
          const ifEntry = localInterfaceIps.find((e) => e.role === "management");
          if (ifEntry) ifEntry.ipAddress = rawIp;
          else localInterfaceIps.push({ device: deviceName, interfaceName: mgmtIfaceName, ipAddress: rawIp, role: "management" });
          log("discover.device.mgmtip", "info", `${deviceName}: Resolved management IP from ${mgmtIfaceName}: ${rawIp}`, deviceName);
        }
        // mgmt-interface MAC (scalar identity) + every physical interface MAC
        // (see DiscoveredDevice.mgmtMac / interfaceMacs).
        const macNorm = normalizeMacOrNull(found && typeof found.macaddr === "string" ? found.macaddr : null);
        if (macNorm) localDevice.mgmtMac = macNorm;
        const ifaceMacs = normalizeMacsDistinct((ifaceList as any[]).map((i) => (typeof i?.macaddr === "string" ? i.macaddr : null)));
        if (ifaceMacs.length) localDevice.interfaceMacs = ifaceMacs;
      }
    } catch { /* best-effort; keep device.ip as fallback */ }
}

// Step 2: DHCP server config -- subnets and static reservations.
async function fmgStepDhcpConfig(ctx: FmgDeviceCtx): Promise<void> {
  const { baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, localSubnets, localDhcpEntries, flags } = ctx;
    try {
      // Step 2: DHCP server config — subnets and static reservations
      const dhcpPayload: JsonRpcRequest = {
        id: 2,
        method: "get",
        params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/dhcp/server` }],
      };
      const dhcpRes = await rpc(baseUrl, dhcpPayload, apiUser, apiToken, verifySsl, signal, integrationId);
      const dhcpData = dhcpRes.result?.[0]?.data;
      if (!Array.isArray(dhcpData)) {
        const dhcpStatus = dhcpRes.result?.[0]?.status;
        if (dhcpStatus && dhcpStatus.code !== undefined && dhcpStatus.code !== 0) {
          log("discover.dhcp", "error", `${deviceName}: DHCP server query returned status ${dhcpStatus.code}: ${dhcpStatus.message || "(no message)"}`, deviceName);
        } else {
          // Empty-result success — the gate has no DHCP servers configured.
          // Treat as "queried successfully" so Phase 5b can release stale
          // dhcp_reservation rows that survived after operator config wipes.
          flags.didDhcpReservationsQuery = true;
          log("discover.dhcp", "info", `${deviceName}: No DHCP servers configured`, deviceName);
        }
      } else {
        flags.didDhcpReservationsQuery = true;
        let deviceSubnetCount = 0;
        let deviceReservationCount = 0;
        for (const server of dhcpData) {
          const iface = typeof server.interface === "string" ? server.interface : String(server.interface ?? "");
          const serverId = String(server.id || iface);
          const netmaskStr = server.netmask;
          const ranges = server["ip-range"];
          if (!netmaskStr || !Array.isArray(ranges) || ranges.length === 0) continue;
          const startIp = ranges[0]["start-ip"];
          if (!startIp) continue;
          try {
            const block = new Netmask(`${startIp}/${netmaskStr}`);
            const cidr = `${block.base}/${block.bitmask}`;
            // localDevice is fully built (serial from the roster's `sn`, HA
            // members from extractHaFromFmgDevice) before the ctx this step
            // receives, so the serial is available here rather than only at
            // the end of the run.
            localSubnets.push({ cidr, name: iface || `dhcp-${serverId}`, fortigateDevice: deviceName, fortigateSerial: ctx.localDevice.serial || undefined, dhcpServerId: serverId });
            deviceSubnetCount++;
          } catch { /* skip invalid netmask/IP */ }

          const reservedAddrs = server["reserved-address"];
          if (Array.isArray(reservedAddrs)) {
            for (const entry of reservedAddrs) {
              const rIp = entry.ip;
              const rMac = entry.mac || "";
              if (!rIp || rIp === "0.0.0.0") continue;
              const numericScopeId = typeof server.id === "number" ? server.id : Number(server.id);
              const numericEntryId = typeof entry.id === "number" ? entry.id : Number(entry.id);
              localDhcpEntries.push({
                device: deviceName,
                interfaceName: iface || `dhcp-${serverId}`,
                ipAddress: rIp,
                macAddress: rMac,
                hostname: entry.description || entry.action === 6 ? (entry.description || "") : "",
                type: "dhcp-reservation",
                scopeId: Number.isFinite(numericScopeId) ? numericScopeId : undefined,
                entryId: Number.isFinite(numericEntryId) ? numericEntryId : undefined,
              });
              deviceReservationCount++;
            }
          }
        }
        log("discover.dhcp", "info", `${deviceName}: Found ${deviceSubnetCount} DHCP subnet(s) and ${deviceReservationCount} static reservation(s)`, deviceName);
      }
    } catch (err: any) {
      log("discover.dhcp", "error", `${deviceName}: Failed to query DHCP server config — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3a: live DHCP monitor (merges INTO the CMDB list). Offline gates skip.
async function fmgStepDhcpMonitor(ctx: FmgDeviceCtx): Promise<void> {
  const { adom, baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, offline, localSubnets, localDhcpEntries, flags } = ctx;
    // Step 3a: Live DHCP monitor — replaces config-based reservation fallback if successful.
    // Skipped for offline gates (device unreachable → /sys/proxy/json fails).
  if (offline) return;
    try {
      const leasePayload: JsonRpcRequest = {
        id: 4,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: "/api/v2/monitor/system/dhcp?format=ip|mac|hostname|interface|reserved|expire_time|access_point|ssid|vci",
          },
        }],
      };
      const leaseRes = await rpc(baseUrl, leasePayload, apiUser, apiToken, verifySsl, signal, integrationId);
      flags.didDhcpLeasesQuery = true;
      const leaseData = leaseRes.result?.[0]?.data;
      const monitorStatus = Array.isArray(leaseData) ? leaseData[0]?.status?.code : undefined;
      const rawResults = Array.isArray(leaseData)
        ? leaseData[0]?.response?.results
        : (leaseData as any)?.response?.results;

      let resultsArray: any[] = [];
      if (Array.isArray(rawResults)) resultsArray = rawResults;
      else if (rawResults && typeof rawResults === "object") resultsArray = Object.values(rawResults);

      const flatLeases: any[] = [];
      for (const entry of resultsArray) {
        if (Array.isArray(entry.leases)) {
          const serverIface = String(entry.server_interface || entry.interface || "");
          for (const lease of entry.leases) flatLeases.push({ ...lease, _serverIface: serverIface });
        } else if (entry.ip) {
          flatLeases.push(entry);
        }
      }
      log("discover.leases", "info", `${deviceName}: Raw DHCP entries from monitor: ${flatLeases.length}`, deviceName);

      // Merge monitor data INTO the CMDB-derived list rather than wiping it.
      // /api/v2/monitor/system/dhcp only returns reservations whose target
      // client is currently online and holding a lease — a static reservation
      // for a device that's powered off doesn't appear in the monitor results.
      // Wiping CMDB and trusting only monitor would silently drop those
      // offline-target reservations from discovery. Now: CMDB is the base set,
      // and the monitor pass below adds anything not already covered (live
      // leases for IPs CMDB doesn't have a static reservation for). The dedup
      // by-ip below means CMDB wins on overlap, which is the right call for
      // static reservations — CMDB is the configured truth.

      let deviceEntryCount = 0;
      for (const lease of flatLeases) {
        const leaseIp = lease.ip;
        const leaseMac = lease.mac || "";
        let leaseIface = lease.interface || lease._serverIface || "";
        if (!leaseIp || leaseIp === "0.0.0.0") continue;

        // CMDB already has this static reservation — mark it as currently
        // leased so the stale-reservation job knows the target has been
        // seen actively holding its IP. CMDB wins on field overlap; we just
        // annotate the seen-leased signal.
        const existingIdx = localDhcpEntries.findIndex((e) => e.ipAddress === leaseIp);
        if (existingIdx >= 0) {
          localDhcpEntries[existingIdx].seenLeased = true;
          continue;
        }
        if (!leaseIface) {
          const matched = localSubnets.find((s) => {
            try { return new Netmask(s.cidr).contains(leaseIp); } catch { return false; }
          });
          leaseIface = matched?.name || "";
        }
        localDhcpEntries.push({
          device: deviceName,
          interfaceName: leaseIface || "unknown",
          ipAddress: leaseIp,
          macAddress: leaseMac,
          hostname: lease.hostname || "",
          type: lease.reserved === true ? "dhcp-reservation" : "dhcp-lease",
          expireTime: lease.expire_time || undefined,
          accessPoint: lease.access_point || undefined,
          ssid: lease.ssid || undefined,
          vci: lease.vci || undefined,
          // Monitor confirms the IP is actively leased right now — feeds the
          // stale-reservation job's "still online" signal.
          seenLeased: true,
        });
        deviceEntryCount++;
      }
      log("discover.leases", "info", `${deviceName}: Found ${deviceEntryCount} DHCP entry/entries from monitor`, deviceName);
    } catch (err: any) {
      log("discover.leases", "error", `${deviceName}: Failed to query DHCP monitor — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3: interface IPs + VLAN backfill onto this device's subnets.
async function fmgStepInterfaceIps(ctx: FmgDeviceCtx): Promise<void> {
  const { config, baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, mgmtIfaceName, localSubnets, localInterfaceIps } = ctx;
    // Step 3: Interface IPs + VLAN backfill onto local subnets
    try {
      const ifacePayload: JsonRpcRequest = {
        id: 3,
        method: "get",
        // secondary-ip is a child mkey table on system/interface — each row
        // carries its own `ip` (in "x.x.x.x y.y.y.y" form). Asking for the
        // parent field returns the whole nested array as embedded JSON.
        params: [{ url: `/pm/config/device/${deviceName}/vdom/root/system/interface`, fields: ["name", "ip", "vlanid", "switch-controller-mgmt-vlan", "secondary-ip"] }],
      };
      const ifaceRes = await rpc(baseUrl, ifacePayload, apiUser, apiToken, verifySsl, signal, integrationId);
      const ifaceData = ifaceRes.result?.[0]?.data;
      const ifaceVlanMap = new Map<string, number>();
      let ifaceIpCount = 0;
      let secondaryIpCount = 0;
      if (Array.isArray(ifaceData)) {
        for (const iface of ifaceData) {
          const ifaceName = iface.name || "";
          const parseVid = (v: unknown): number => {
            const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
            return !isNaN(n) && n > 0 ? n : 0;
          };
          const vid = parseVid(iface.vlanid) || parseVid(iface["switch-controller-mgmt-vlan"]);
          if (vid > 0) ifaceVlanMap.set(ifaceName, vid);
          if (ifaceName === mgmtIfaceName) continue;
          if (!matchesInterfaceFilter(ifaceName, config)) continue;
          const ipArr = iface.ip;
          if (Array.isArray(ipArr) && ipArr.length >= 1 && ipArr[0] && ipArr[0] !== "0.0.0.0") {
            localInterfaceIps.push({ device: deviceName, interfaceName: ifaceName, ipAddress: ipArr[0], role: "interface" });
            ifaceIpCount++;
          }
          // Secondary IPs: nested table on the interface. Each row has its own
          // `ip` in either "x.x.x.x y.y.y.y" (IP + mask) string form or as a
          // [ip, mask] array. Strip to the dotted-quad and push as
          // role="secondary" so Phase 4 can label the reservation appropriately.
          const secondaries = iface["secondary-ip"];
          if (Array.isArray(secondaries)) {
            for (const sec of secondaries) {
              const rawSec = Array.isArray(sec?.ip)
                ? (sec.ip[0] || "")
                : (typeof sec?.ip === "string" ? sec.ip.split(" ")[0] : "");
              if (rawSec && rawSec !== "0.0.0.0" && isValidIpv4(rawSec)) {
                localInterfaceIps.push({ device: deviceName, interfaceName: ifaceName, ipAddress: rawSec, role: "secondary" });
                secondaryIpCount++;
              }
            }
          }
        }
      }
      for (const sub of localSubnets) {
        const vid = ifaceVlanMap.get(sub.name);
        if (vid) sub.vlan = vid;
      }
      log("discover.interfaces", "info", `${deviceName}: Resolved ${ifaceIpCount} interface IP(s)${secondaryIpCount > 0 ? ` + ${secondaryIpCount} secondary IP(s)` : ""}`, deviceName);
    } catch (err: any) {
      log("discover.interfaces", "error", `${deviceName}: Failed to query interfaces — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3b: device inventory (detected clients). Offline gates skip.
async function fmgStepInventory(ctx: FmgDeviceCtx): Promise<void> {
  const { adom, baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, offline, inventoryMaxAgeHours, localInventory, flags } = ctx;
    // Step 3b: Device inventory. Skipped for offline gates (live monitor query).
  if (offline) return;
    try {
      const inventoryPayload: JsonRpcRequest = {
        id: 5,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: `/api/v2/monitor/user/device/query?format=${INVENTORY_QUERY_FORMAT}`,
          },
        }],
      };
      const inventoryRes = await rpc(baseUrl, inventoryPayload, apiUser, apiToken, verifySsl, signal, integrationId);
      const inventoryData = inventoryRes.result?.[0]?.data;
      const results = Array.isArray(inventoryData)
        ? inventoryData[0]?.response?.results
        : (inventoryData as any)?.response?.results;
      const inventoryCutoffMs = Date.now() - inventoryMaxAgeHours * 60 * 60 * 1000;
      let inventoryCount = 0;
      if (Array.isArray(results)) {
        for (const client of results) {
          const mac = client.mac || "";
          const ip = client.ip || "";
          if (!mac && !ip) continue;
          if (!client.last_seen || client.last_seen * 1000 < inventoryCutoffMs) continue;
          localInventory.push({
            device: deviceName,
            macAddress: mac,
            ipAddress: ip,
            hostname: client.hostname || client.host || "",
            os: client.os || client.type || "",
            osVersion: client.os_version || "",
            hardwareVendor: client.hardware_vendor || "",
            interfaceName: client.interface || "",
            ...inventorySwitchAttribution(client),
            apName: client.ap_name || client.fortiap || "",
            user: client.user || client.detected_user || "",
            isOnline: !!client.is_online,
            lastSeen: new Date(client.last_seen * 1000).toISOString(),
          });
          inventoryCount++;
        }
      }
      flags.didInventory = true;
      log("discover.inventory", "info", `${deviceName}: Found ${inventoryCount} device inventory client(s)`, deviceName);
    } catch (err: any) {
      log("discover.inventory", "error", `${deviceName}: Failed to query device inventory — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3c: managed FortiSwitches (live status + CMDB uplink/description join). Offline gates skip.
async function fmgStepSwitches(ctx: FmgDeviceCtx): Promise<void> {
  const { adom, baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, offline, localDevice, localSwitches, flags } = ctx;
    // Step 3c: Managed FortiSwitches (live status). Skipped for offline gates —
    // this whole block, including the nested /sys/proxy/json CMDB-uplink read,
    // requires the device to be reachable. The native CMDB switch roster in
    // Step 3c.5 below still runs offline (decommission protection only).
  if (offline) return;
    try {
      const switchPayload: JsonRpcRequest = {
        id: 8,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: "/api/v2/monitor/switch-controller/managed-switch/status?format=connecting_from|fgt_peer_intf_name|join_time|os_version|serial|switch-id|state|status",
          },
        }],
      };
      const switchRes = await rpc(baseUrl, switchPayload, apiUser, apiToken, verifySsl, signal, integrationId);
      const switchData = switchRes.result?.[0]?.data;
      const switchProxyEntry = Array.isArray(switchData) ? switchData[0] : switchData as any;
      const switchProxyStatus = switchProxyEntry?.status?.code ?? 0;
      const switchHttpStatus = switchProxyEntry?.response?.http_status ?? 200;
      const switchResults = switchProxyEntry?.response?.results;
      let switchCount = 0;
      if (switchProxyStatus !== 0 || switchHttpStatus === 404) {
        // 404 = switch-controller feature not licensed/enabled, which is the
        // same as "controller has zero managed switches." Mark the query as
        // inventoried so any pre-existing switches behind this gate get
        // decommissioned (the controller is reachable, just not managing them).
        flags.didSwitchQuery = true;
        log("discover.fortiswitches", "info", `${deviceName}: switch-controller not available (proxy status ${switchProxyStatus}, HTTP ${switchHttpStatus}) — skipping`, deviceName);
      } else if (Array.isArray(switchResults)) {
        flags.didSwitchQuery = true;
        // Switch-side physical uplink ports come from the managed-switch CMDB
        // (the status query above only carries fgt_peer_intf_name = "fortilink").
        // One extra proxy read per controller; serial → single uplink port
        // (chained / dual-homed switches are omitted, leaving the FG↔switch
        // edge label to LLDP). Best-effort — a failure just leaves it null.
        // Mirrors fetchFortiswitchUplinkPorts in fortigateService (direct path).
        const uplinkBySerial = new Map<string, string>();
        // Admin description from the same CMDB rows (already fetched in
        // full) — carries a:/b:/f:/r:/jb: location codes for the Device Map.
        const descriptionBySerial = new Map<string, string>();
        try {
          const cmdbPayload: JsonRpcRequest = {
            id: 9,
            method: "exec",
            params: [{
              url: `/sys/proxy/json`,
              data: {
                target: [`/adom/${adom}/device/${deviceName}`],
                action: "get",
                resource: "/api/v2/cmdb/switch-controller/managed-switch?datasource=1",
              },
            }],
          };
          const cmdbRes = await rpc(baseUrl, cmdbPayload, apiUser, apiToken, verifySsl, signal, integrationId);
          const cmdbData = cmdbRes.result?.[0]?.data;
          const cmdbEntry = Array.isArray(cmdbData) ? cmdbData[0] : cmdbData as any;
          const cmdbRows = cmdbEntry?.response?.results;
          if (Array.isArray(cmdbRows)) {
            for (const row of cmdbRows) {
              const serial = String(row?.sn || row?.["switch-id"] || row?.name || "").trim();
              if (!serial) continue;
              const uplinks = findFortiswitchUplinkPorts(row?.ports);
              if (uplinks.length === 1) uplinkBySerial.set(serial.toUpperCase(), uplinks[0]);
              const desc = typeof row?.description === "string" ? row.description.trim() : "";
              if (desc) descriptionBySerial.set(serial.toUpperCase(), desc);
            }
          }
        } catch { /* best-effort — fall back to LLDP for the switch-side label */ }
        for (const sw of switchResults) {
          localSwitches.push({
            device: deviceName,
            deviceSerial: localDevice.serial || "",
            name: sw["switch-id"] || "",
            serial: sw.serial || "",
            ipAddress: sw.connecting_from || "",
            fgtInterface: sw.fgt_peer_intf_name || "",
            osVersion: sw.os_version || "",
            joinTime: Number.isFinite(sw.join_time) && sw.join_time > 0 ? sw.join_time : undefined,
            state: sw.state || "",
            connected: sw.status === "Connected",
            uplinkPhysicalPort: uplinkBySerial.get((sw.serial || "").toUpperCase()) ?? null,
            description: descriptionBySerial.get((sw.serial || "").toUpperCase()) ?? null,
          });
          switchCount++;
        }
        log("discover.fortiswitches", "info", `${deviceName}: Found ${switchCount} managed FortiSwitch(es)`, deviceName);
      } else {
        log("discover.fortiswitches", "info", `${deviceName}: Found 0 managed FortiSwitch(es)`, deviceName);
      }
    } catch (err: any) {
      log("discover.fortiswitches", "error", `${deviceName}: Failed to query managed FortiSwitches — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3c.5: native-CMDB roster of configured FortiSwitches (decommission protection; runs offline too).
async function fmgStepSwitchCmdbRoster(ctx: FmgDeviceCtx): Promise<void> {
  const { baseUrl, apiUser, apiToken, verifySsl, signal, log, deviceName, localCmdbSwitchSerials, flags } = ctx;
    // Step 3c.5: CMDB roster of configured FortiSwitches for this device.
    // Native FMG CMDB read — no /sys/proxy/json wrapper, parallelizes
    // freely. Defensive: a switch that's authorized at FMG but currently
    // offline / in a brief post-config-push window may be missing from
    // the live status query above; the decommission sweep treats serials
    // surfaced here as "still known" so they're not declared stale.
    // Best-effort: failures swallow (we still have the live answer).
    try {
      const swCmdbRes = await rpc(
        baseUrl,
        {
          id: 16,
          method: "get",
          params: [{
            url: `/pm/config/device/${deviceName}/global/switch-controller/managed-switch`,
            fields: ["switch-id", "sn", "name"],
            loadsub: 0,
          }],
        },
        apiUser, apiToken, verifySsl, signal,
      );
      const swCmdbList = swCmdbRes.result?.[0]?.data;
      if (Array.isArray(swCmdbList)) {
        // The roster ANSWERED. Zero rows now means "manages no switches",
        // which is a real answer; a throw below leaves this false = unknown.
        flags.didSwitchCmdbRoster = true;
        for (const sw of swCmdbList) {
          // The mkey `switch-id` only DEFAULTS to the serial -- FortiLink setups
          // frequently rename it to the hostname, in which case reading it alone
          // collects hostnames and the decommission protection below silently
          // stops matching. `sn` carries the real serial; see
          // readManagedSwitchCmdbSerial for the full note. `name` is the
          // operator-set display label and is never a serial.
          const serial = readManagedSwitchCmdbSerial(sw);
          if (serial) localCmdbSwitchSerials.push({ device: deviceName, serial });
        }
      }
    } catch (err: any) {
      log("discover.fortiswitches.cmdb", "info", `${deviceName}: CMDB managed-switch roster lookup skipped — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3d: managed FortiAPs (live status). Offline gates skip.
async function fmgStepAps(ctx: FmgDeviceCtx): Promise<void> {
  const { adom, baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, offline, localDevice, localAps, flags } = ctx;
    // Step 3d: Managed FortiAPs (live status). Skipped for offline gates; the
    // native CMDB AP roster in Step 3d.4 below still runs offline.
  if (offline) return;
    try {
      const apPayload: JsonRpcRequest = {
        id: 9,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: `/api/v2/monitor/wifi/managed_ap?format=${FORTIAP_MONITOR_FORMAT}`,
          },
        }],
      };
      const apRes = await rpc(baseUrl, apPayload, apiUser, apiToken, verifySsl, signal, integrationId);
      const apData = apRes.result?.[0]?.data;
      const apProxyEntry = Array.isArray(apData) ? apData[0] : apData as any;
      const apProxyStatus = apProxyEntry?.status?.code ?? 0;
      const apHttpStatus = apProxyEntry?.response?.http_status ?? 200;
      const apResults = apProxyEntry?.response?.results;
      let apCount = 0;
      if (apProxyStatus !== 0 || apHttpStatus === 404) {
        // Same reasoning as the switch path: 404 here means wireless-controller
        // is not licensed/enabled. The controller is reachable, so the
        // decommission sweep can act on stale APs behind it.
        flags.didApQuery = true;
        log("discover.fortiaps", "info", `${deviceName}: wifi/managed_ap not available (proxy status ${apProxyStatus}, HTTP ${apHttpStatus}) — skipping`, deviceName);
      } else if (Array.isArray(apResults)) {
        flags.didApQuery = true;
        for (const ap of apResults) {
          // Shared parser — same shape across FMG proxy and standalone
          // FortiGate REST paths. See utils/fortiapMonitorRow.ts.
          const parsed = parseFortiapMonitorRow(ap as Record<string, unknown>);
          localAps.push({ device: deviceName, deviceSerial: localDevice.serial || "", ...parsed });
          apCount++;
        }
        log("discover.fortiaps", "info", `${deviceName}: Found ${apCount} managed FortiAP(s)`, deviceName);
      } else {
        log("discover.fortiaps", "info", `${deviceName}: Found 0 managed FortiAP(s)`, deviceName);
      }
    } catch (err: any) {
      log("discover.fortiaps", "error", `${deviceName}: Failed to query managed FortiAPs — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3d.4: native-CMDB WTP roster (decommission protection + the AP admin-description join; runs offline too).
async function fmgStepApCmdbRoster(ctx: FmgDeviceCtx): Promise<void> {
  const { baseUrl, apiUser, apiToken, verifySsl, signal, log, deviceName, localCmdbApSerials, localAps, flags } = ctx;
    // Step 3d.4: CMDB roster of configured FortiAPs (WTPs) for this device.
    // Mirror of Step 3c.5 — native FMG CMDB read, decommission protection
    // for configured-but-currently-offline APs. Best-effort. Also the only
    // place the AP admin description lives: the monitor endpoint in Step 3d
    // doesn't carry it, so it's joined onto localAps here (location codes
    // for the Device Map — see utils/locationCodes.ts). The description
    // surface is the wtp `location` field (AP Manager's field, 35-char cap —
    // FMG's device-DB copy carries `location` but no `comment` at all when
    // APs are centrally managed, so a comment-only read comes back empty);
    // `comment` is still requested as a fallback for per-device-managed
    // ADOMs whose copy retains it.
    try {
      const apCmdbRes = await rpc(
        baseUrl,
        {
          id: 17,
          method: "get",
          params: [{
            url: `/pm/config/device/${deviceName}/vdom/root/wireless-controller/wtp`,
            fields: ["wtp-id", "name", "location", "comment"],
            loadsub: 0,
          }],
        },
        apiUser, apiToken, verifySsl, signal,
      );
      const apCmdbList = apCmdbRes.result?.[0]?.data;
      if (Array.isArray(apCmdbList)) {
        flags.didApCmdbRoster = true;
        const descriptionBySerial = new Map<string, string>();
        for (const ap of apCmdbList) {
          // FortiAPs are keyed by serial as `wtp-id` in CMDB (matches what
          // the live monitor query reports as `wtp_id` / `serial`).
          const serial = typeof ap["wtp-id"] === "string" ? ap["wtp-id"].trim() : "";
          if (!serial) continue;
          localCmdbApSerials.push({ device: deviceName, serial });
          const location = typeof ap.location === "string" ? ap.location.trim() : "";
          const comment = typeof ap.comment === "string" ? ap.comment.trim() : "";
          const description = location || comment;
          if (description) descriptionBySerial.set(serial.toUpperCase(), description);
        }
        for (const ap of localAps) {
          if (ap.device !== deviceName) continue;
          ap.description = descriptionBySerial.get((ap.serial || "").toUpperCase()) ?? null;
        }
      }
    } catch (err: any) {
      log("discover.fortiaps.cmdb", "info", `${deviceName}: CMDB WTP roster lookup skipped — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3d.5: FortiAP -> FortiSwitch port mapping via the detected-device MAC table. Offline gates skip.
async function fmgStepApPortMap(ctx: FmgDeviceCtx): Promise<void> {
  const { adom, baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, offline, localAps, localSwitches, localSwitchMacTable } = ctx;
    // Step 3d.5: FortiAP → FortiSwitch port mapping via detected-device MAC table
    // Pulls all switch port MAC learnings in one shot and matches each AP's base_mac
    // to its switch + port. APs not seen on any managed switch stay un-peered and
    // will render as hanging off the FortiGate directly in the topology graph.
    // Skipped for offline gates (live monitor query).
  if (offline) return;
    try {
      const detectedPayload: JsonRpcRequest = {
        id: 12,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: "/api/v2/monitor/switch-controller/detected-device?format=mac|switch_id|port_name|vlan_id|last_seen|ipv4_address|ipv6_address|device_name|host_src|device_type|os_name|is_fortilink_peer",
          },
        }],
      };
      const detRes = await rpc(baseUrl, detectedPayload, apiUser, apiToken, verifySsl, signal, integrationId);
      const detData = detRes.result?.[0]?.data;
      const detEntry = Array.isArray(detData) ? detData[0] : detData as any;
      const detStatus = detEntry?.status?.code ?? 0;
      const detResults = detEntry?.response?.results;
      if (detStatus === 0 && Array.isArray(detResults)) {
        // Shared post-fetch processing (utils/fortinetDetectedDevice) —
        // identical to the direct-REST path by requirement.
        processDetectedDeviceRows({
          rows: detResults,
          deviceName,
          displayName: deviceName,
          aps: localAps,
          switches: localSwitches,
          macTable: localSwitchMacTable,
          log,
        });
      }
    } catch (err: any) {
      log("discover.ap-uplinks", "info", `${deviceName}: detected-device query skipped — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Steps 3d.54 + 3d.55: opt-in ARP presence sweep, then the ARP table read. Offline gates skip.
async function fmgStepArp(ctx: FmgDeviceCtx): Promise<void> {
  const { adom, baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, offline, arpSweepTargets, localArpTable, flags } = ctx;
    // Step 3d.55: FortiGate ARP table. Authoritative IP↔MAC binding for any
    // subnet the FortiGate routes for. Pairs with the macmap above —
    // detected-device tells us "MAC X is on FortiSwitch Y / port Z," ARP
    // tells us "MAC X has IP A right now." Together they let the sync
    // pipeline enrich existing endpoint assets with both location + IP.
    // Skipped for offline gates (live monitor query).
  if (offline) return;
    try {
      // Step 3d.54: ARP presence sweep (opt-in — targets prebuilt by the
      // caller from this device's active dhcp_reservation rows). Fire the
      // UDP sweep, settle briefly, THEN read the table, so every live
      // reserved IP resolves into a fresh neighbor-cache entry first.
      const sweepIps = arpSweepTargets?.get(fmgNameKey(deviceName));
      if (sweepIps?.length && !signal?.aborted) {
        const { sent, dropped } = await primeArpCache(sweepIps);
        if (sent > 0) {
          log("discover.arp", "info", `${deviceName}: ARP presence sweep — probed ${sent} reserved IP(s)${dropped > 0 ? ` (${dropped} over cap, skipped)` : ""}`, deviceName);
          await sleepWithAbort(ARP_SETTLE_MS, signal);
        }
      }
      const arpPayload: JsonRpcRequest = {
        id: 14,
        method: "exec",
        params: [{
          url: `/sys/proxy/json`,
          data: {
            target: [`/adom/${adom}/device/${deviceName}`],
            action: "get",
            resource: "/api/v2/monitor/network/arp",
          },
        }],
      };
      const arpRes = await rpc(baseUrl, arpPayload, apiUser, apiToken, verifySsl, signal, integrationId);
      const arpData = arpRes.result?.[0]?.data;
      const arpEntry = Array.isArray(arpData) ? arpData[0] : arpData as any;
      const arpStatus = arpEntry?.status?.code ?? 0;
      const arpResults = arpEntry?.response?.results;
      if (arpStatus === 0 && Array.isArray(arpResults)) {
        // Shared row parse (utils/fortinetDetectedDevice) — identical to the
        // direct-REST path by requirement.
        processArpRows({ rows: arpResults, deviceName, displayName: deviceName, arpTable: localArpTable, log });
        // Marked BEFORE the row count is known: a gate that genuinely holds no
        // neighbours still answered, and the ARP-table writer needs to tell
        // that apart from the read failing.
        flags.didArpQuery = true;
      }
    } catch (err: any) {
      log("discover.arp", "info", `${deviceName}: ARP query skipped — ${err.message || "Unknown error"}`, deviceName);
    }
}

// Step 3d.6: geo-coordinate fallback from FMG's CMDB copy of system/global (self-gated on missing coords).
async function fmgStepGeoFallback(ctx: FmgDeviceCtx): Promise<void> {
  const { baseUrl, apiUser, apiToken, verifySsl, signal, log, deviceName, localDevice } = ctx;
    // Step 3d.6: Geo coordinates fallback — only runs when FMG's device record
    // didn't already provide coords (see `fmgCoordsOk` above). Reads the
    // FortiGate's `config system global` from FMG's CMDB **natively**
    // (`/pm/config/device/<name>/global/system/global`) — no `/sys/proxy/json`
    // wrapper. config system global is a CMDB object so FMG already has it
    // in sync with the device; querying natively avoids the proxy mode's
    // forced concurrency=1 and removes one round-trip per device per
    // discovery cycle.
    if (localDevice.latitude === undefined || localDevice.longitude === undefined) {
      try {
        const geoRes = await rpc(
          baseUrl,
          {
            id: 13,
            method: "get",
            params: [{
              url: `/pm/config/device/${deviceName}/global/system/global`,
              fields: ["gui-device-latitude", "gui-device-longitude", "latitude", "longitude"],
              loadsub: 0,
            }],
          },
          apiUser, apiToken, verifySsl, signal,
        );
        const geoResults = geoRes.result?.[0]?.data;
        if (geoResults && typeof geoResults === "object" && !Array.isArray(geoResults)) {
          const lat = parseFloat(String((geoResults as any)["gui-device-latitude"] ?? (geoResults as any).latitude ?? ""));
          const lng = parseFloat(String((geoResults as any)["gui-device-longitude"] ?? (geoResults as any).longitude ?? ""));
          if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
            localDevice.latitude = lat;
            localDevice.longitude = lng;
            log("discover.geo", "info", `${deviceName}: Resolved coordinates from FMG CMDB: ${lat.toFixed(4)}, ${lng.toFixed(4)}`, deviceName);
          } else {
            // Surface where coords are (or aren't) so the operator can locate them
            const keys = Object.keys(geoResults).slice(0, 30).join(", ");
            log("discover.geo", "info", `${deviceName}: No latitude/longitude in FMG CMDB system/global (keys: ${keys || "(empty)"})`, deviceName);
          }
        } else {
          log("discover.geo", "info", `${deviceName}: FMG CMDB system/global returned no usable result — check FMG's CMDB sync state for this device`, deviceName);
        }
      } catch (err: any) {
        log("discover.geo", "info", `${deviceName}: Geo lookup skipped — ${err.message || "Unknown error"}`, deviceName);
      }
    }
}

// Step 3e: firewall VIPs.
async function fmgStepVips(ctx: FmgDeviceCtx): Promise<void> {
  const { baseUrl, apiUser, apiToken, verifySsl, signal, integrationId, log, deviceName, localVips, flags } = ctx;
    // Step 3e: Firewall VIPs
    try {
      const vipPayload: JsonRpcRequest = {
        id: 11,
        method: "get",
        params: [{ url: `/pm/config/device/${deviceName}/vdom/root/firewall/vip`, fields: ["name", "extip", "mappedip", "extintf", "type", "realservers"] }],
      };
      const vipRes = await rpc(baseUrl, vipPayload, apiUser, apiToken, verifySsl, signal, integrationId);
      flags.didVipQuery = true;
      const vipData = vipRes.result?.[0]?.data;
      let vipCount = 0;
      if (Array.isArray(vipData)) {
        for (const vip of vipData) {
          const name = vip.name || "";
          if (!name) continue;
          // FMG's fields-projected get flattens extip/extintf to
          // single-element string arrays and the mappedip child table to
          // flat range strings (verified against FMG 7.x / FortiOS 7.x);
          // the FortiOS-REST encoding is plain strings + { range } objects.
          // Handle both — the { range } form was the only one parsed
          // historically, which silently dropped mapped IPs in proxy mode.
          const extipRaw = Array.isArray(vip.extip) ? vip.extip[0] : vip.extip;
          const extip = parseRangeFirstIp(String(extipRaw || ""));
          if (!extip) continue;
          const mappedips: string[] = [];
          if (Array.isArray(vip.mappedip)) {
            for (const m of vip.mappedip) {
              const ip = parseRangeFirstIp(String((typeof m === "string" ? m : m?.range) || ""));
              if (ip) mappedips.push(ip);
            }
          }
          const extintfRaw = Array.isArray(vip.extintf) ? vip.extintf[0] : vip.extintf;
          const { isVirtualServer, realservers } = parseVipServerInfo(vip);
          localVips.push({ device: deviceName, name, extip, mappedips, extintf: String(extintfRaw || ""), isVirtualServer, realservers });
          vipCount++;
        }
      }
      log("discover.vips", "info", `${deviceName}: Found ${vipCount} firewall VIP(s)`, deviceName);
    } catch (err: any) {
      log("discover.vips", "error", `${deviceName}: Failed to query firewall VIPs — ${err.message || "Unknown error"}`, deviceName);
    }
}

export async function discoverDhcpSubnets(
  config: FortiManagerConfig,
  signal?: AbortSignal,
  onProgress?: DiscoveryProgressCallback,
  inventoryMaxAgeHours = 24,
  onDeviceComplete?: (result: DiscoveryResult) => Promise<void>,
  integrationId?: string,
  // Warm cache: deviceName → cached management IP. Populated by the caller
  // from the firewall Asset rows that were monitor-up at discovery start.
  // Direct mode dispatches these to processDevice immediately (no FMG round
  // trip) while the cache-cold + new FortiGates flow serially through the
  // FMG worker. Cache-miss fallback inside processDevice handles the case
  // where a cached IP turned stale. Proxy mode ignores this map (every
  // per-device call is FMG-bound anyway).
  warmCacheIps?: Map<string, string>,
  // ARP presence sweep targets: fmgNameKey(deviceName) → reserved IPs on
  // that FortiGate's subnets (built by the caller from active
  // dhcp_reservation rows when Integration.config.arpPresenceSweep is on;
  // empty/undefined = sweep disabled). Each device's list is swept
  // fire-and-forget right before ITS ARP-table read — per-gate, never a
  // fleet-wide blast — so fresh resolutions land inside the FortiOS
  // neighbor-cache GC window. See arpPrimeService.ts.
  arpSweepTargets?: Map<string, string[]>,
  // Single-FortiGate scoped re-discovery: when set, only the roster device
  // whose name/hostname matches (case-insensitive, fmgNameKey semantics) is
  // processed. `knownDeviceNames` still carries the FULL raw roster so the
  // caller's sweep phases keep their fleet view — though a scoped run's
  // finalize pass ("finalize-scoped") never runs the roster-based sweeps
  // anyway. No roster match (missing, or excluded by deviceInclude/Exclude)
  // throws — the failure surfaces on the DiscoveryRun row + error Event.
  scopeDeviceName?: string,
): Promise<DiscoveryResult> {
  const baseUrl = `https://${config.host}:${config.port || 443}/jsonrpc`;
  const adom = config.adom || "root";
  const { apiUser, apiToken, verifySsl } = config;
  const log = onProgress || (() => {});
  // Operator-named coord / address metavars (FMG convention). Resolved once so
  // the per-device metavar extraction uses the configured names.
  const latMetavar = config.fortigateMonitor?.latitudeMetavar?.trim() || "Latitude";
  const lngMetavar = config.fortigateMonitor?.longitudeMetavar?.trim() || "Longitude";
  const addrMetavar = config.fortigateMonitor?.addressMetavar?.trim() || "";

  // Per-device coord metavars live in FMG's Policy & Objects metadata variables
  // (dynamic_mapping), not `dvmdb` device "meta fields". Fetch the whole fleet's
  // map once per run (best-effort — empty on any failure) and prefer it, falling
  // back to the legacy dvmdb meta-fields read per device for backward compat.
  const metavarCoordMap = await fetchFmgMetavarCoordMap(config, latMetavar, lngMetavar, addrMetavar, signal, integrationId);
  const resolveMetavarCoords = (rawDevice: any, deviceName: string): { latitude?: number; longitude?: number; address?: string } => {
    const dyn = metavarCoordMap.get(deviceName.toLowerCase()) || {};
    const legacy = extractMetavarCoordsFromFmgDevice(rawDevice, latMetavar, lngMetavar, addrMetavar);
    return {
      latitude: dyn.latitude ?? legacy.latitude,
      longitude: dyn.longitude ?? legacy.longitude,
      address: dyn.address ?? legacy.address,
    };
  };

  // Step 1: List managed devices in the ADOM. We deliberately do NOT filter on
  // conn_status server-side — we need the full roster (online + offline) so the
  // stale-subnet sweep can distinguish "device offline" from "device removed."
  const devicesPayload: JsonRpcRequest = {
    id: 1,
    method: "get",
    // Ask FMG for the full device record instead of a hand-picked `fields`
    // list. Explicitly naming fields like `latitude`/`longitude` causes FMG
    // to authorize each one individually and fail the entire query with
    // status -11 ("No permission for the resource") when the API user's
    // profile doesn't grant a specific field — which happens on older FMG
    // versions that don't expose coords at all. Without a filter the query
    // returns whatever the user already has access to, so lat/lng show up
    // when they exist and are silently absent otherwise (the per-device
    // CMDB fallback picks them up from the FortiGate itself in that case).
    //
    // `option: ["get meta"]` asks FMG to include per-device metavariables
    // ("meta fields") in the response. Operators using the existing
    // `Latitude` / `Longitude` metavar convention get those values surfaced
    // on `DiscoveredDevice.metavarLatitude / Longitude` for the coord
    // resolution chain in syncDhcpSubnets Phase 11.5. The option is additive
    // — FMG returns whatever metavars are defined and the API user can read;
    // older FMG versions that don't recognize the option simply ignore it.
    params: [{ url: `/dvmdb/adom/${adom}/device`, option: ["get meta"] }],
  };

  let devicesRes: JsonRpcResponse;
  try {
    devicesRes = await rpc(baseUrl, devicesPayload, apiUser, apiToken, verifySsl, signal, integrationId);
  } catch (err: any) {
    log("discover.devices", "error", `Failed to list managed devices: ${err.message || "Unknown error"}`);
    throw err;
  }
  const devicesDataRaw = devicesRes.result?.[0]?.data;
  if (!Array.isArray(devicesDataRaw) || devicesDataRaw.length === 0) {
    const status = devicesRes.result?.[0]?.status;
    if (status && status.code !== undefined && status.code !== 0) {
      log("discover.devices", "error", `Device list query returned status ${status.code}: ${status.message || "(no message)"} for ADOM "${adom}" — check that the ADOM name is exact and the API user has read access to /dvmdb/adom/${adom}/device`);
    } else {
      log("discover.devices", "info", `No managed devices found in ADOM "${adom}"`);
    }
    return { subnets: [], devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames: [], knownDeviceSerials: [], fortiSwitches: [], fortiAps: [], vips: [], switchMacTable: [], arpTable: [], arpQueriedDevices: [], cmdbSwitchSerials: [], cmdbApSerials: [], switchInventoriedDevices: [], apInventoriedDevices: [], vipInventoriedDevices: [], dhcpReservationsInventoriedDevices: [], dhcpLeasesInventoriedDevices: [] };
  }

  // Capture the full roster of configured devices (pre-filter, any conn_status).
  // Subnets whose fortigateDevice is NOT in this set were discovered from a
  // device that has since been deleted from FMG — those are the ones to deprecate.
  // HA members are captured HERE, from the raw roster, and deliberately not
  // from the devices that processed successfully — see extractRosterIdentities.
  const { names: knownDeviceNames, serials: knownDeviceSerials } =
    extractRosterIdentities(devicesDataRaw as any[]);

  // Apply device-level include/exclude filter (FortiGate names or hostnames).
  // Include wins over exclude when both are set.
  let devicesData = filterDevices(devicesDataRaw, config.deviceInclude, config.deviceExclude);
  if (scopeDeviceName) {
    // Scoped re-discovery: narrow to the one device AFTER the include/exclude
    // filter (a filtered-out gate stays un-discoverable) and AFTER the raw
    // roster was captured into knownDeviceNames (same protection the device
    // filter gets — nothing outside the scope can ever look "removed").
    const scopeKey = fmgNameKey(scopeDeviceName);
    const matchesScope = (d: any) => fmgNameKey(d.name) === scopeKey || fmgNameKey(d.hostname) === scopeKey;
    const inRoster = (devicesDataRaw as any[]).some(matchesScope);
    devicesData = devicesData.filter(matchesScope);
    if (devicesData.length === 0) {
      const why = inRoster
        ? `"${scopeDeviceName}" is excluded by the integration's device include/exclude filter`
        : `"${scopeDeviceName}" was not found in the ADOM "${adom}" device roster`;
      log("discover.devices", "error", `Scoped re-discovery failed: ${why}`);
      throw new Error(`Scoped re-discovery failed: ${why}`);
    }
    // Phrasing matters: the run accumulator parses "Found <n> managed device"
    // out of this progress message to set totalDevices.
    log("discover.devices", "info", `Found 1 managed device(s) — scoped re-discovery of "${scopeDeviceName}" (${devicesDataRaw.length} in ADOM "${adom}" roster)`);
  } else {
    const filteredOut = devicesDataRaw.length - devicesData.length;
    if (filteredOut > 0) {
      log("discover.devices", "info", `Found ${devicesDataRaw.length} managed device(s) in ADOM "${adom}" — ${devicesData.length} included, ${filteredOut} filtered by device include/exclude`);
    } else {
      log("discover.devices", "info", `Found ${devicesData.length} managed device(s) in ADOM "${adom}"`);
    }
  }
  if (devicesData.length === 0) {
    return { subnets: [], devices: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [], inventoryDevices: [], knownDeviceNames, knownDeviceSerials, fortiSwitches: [], fortiAps: [], vips: [], switchMacTable: [], arpTable: [], arpQueriedDevices: [], cmdbSwitchSerials: [], cmdbApSerials: [], switchInventoriedDevices: [], apInventoriedDevices: [], vipInventoriedDevices: [], dhcpReservationsInventoriedDevices: [], dhcpLeasesInventoriedDevices: [] };
  }

  const discovered: DiscoveredSubnet[] = [];
  const devices: DiscoveredDevice[] = [];
  const interfaceIps: DiscoveredInterfaceIp[] = [];
  const dhcpEntries: DiscoveredDhcpEntry[] = [];
  const deviceInventory: DiscoveredInventoryDevice[] = [];
  const inventoryDevices = new Set<string>();
  // Gates whose live ARP read answered — the delete-replace scope for
  // persistFortigateArpTables. See DiscoveryResult.arpQueriedDevices.
  const arpQueriedDevices = new Set<string>();
  // Devices whose native CMDB roster read ANSWERED this run. Membership for the
  // dependency graph is only authoritative for these -- a gate absent here has
  // an unknown member list, which must never be read as "manages nothing".
  const cmdbSwitchRosterDevices = new Set<string>();
  const cmdbApRosterDevices = new Set<string>();
  const fortiSwitches: DiscoveredFortiSwitch[] = [];
  const fortiAps: DiscoveredFortiAP[] = [];
  const vips: DiscoveredVip[] = [];
  const switchMacTable: DiscoveredSwitchMacEntry[] = [];
  const arpTable: DiscoveredArpEntry[] = [];
  const cmdbSwitchSerials: Array<{ device: string; serial: string }> = [];
  const cmdbApSerials: Array<{ device: string; serial: string }> = [];

  type DeviceChunk = {
    device: DiscoveredDevice;
    subnets: DiscoveredSubnet[];
    interfaceIps: DiscoveredInterfaceIp[];
    dhcpEntries: DiscoveredDhcpEntry[];
    deviceInventory: DiscoveredInventoryDevice[];
    didInventory: boolean;
    fortiSwitches: DiscoveredFortiSwitch[];
    fortiAps: DiscoveredFortiAP[];
    vips: DiscoveredVip[];
    switchMacTable: DiscoveredSwitchMacEntry[];
    arpTable: DiscoveredArpEntry[];
    cmdbSwitchSerials: Array<{ device: string; serial: string }>;
    cmdbApSerials: Array<{ device: string; serial: string }>;
    // Whether each per-device inventory query returned a usable response.
    // The decommission sweep keys off these flags so a controller whose
    // switch-controller endpoint timed out doesn't take its switches down
    // with it.
    didSwitchQuery: boolean;
    didApQuery: boolean;
    // Whether each per-device authoritative-source query returned a usable
    // response. Phase 5b in syncDhcpSubnets uses these to scope the
    // stale-row sweep — we never release rows for a device whose source
    // query failed this cycle.
    didVipQuery: boolean;
    didDhcpReservationsQuery: boolean;
    didDhcpLeasesQuery: boolean;
    didArpQuery: boolean;
    // Did the native CMDB roster read answer? See the FmgDeviceCtx note.
    didSwitchCmdbRoster: boolean;
    didApCmdbRoster: boolean;
  };
  // Top-level aggregates used by syncDhcpSubnets to decommission stale
  // switches/APs only when their controller was reachable.
  const switchInventoriedDevices = new Set<string>();
  const apInventoriedDevices = new Set<string>();
  // Top-level aggregates used by syncDhcpSubnets Phase 5b to release stale
  // VIP / dhcp_reservation rows only when their source device's query
  // succeeded this cycle.
  const vipInventoriedDevices = new Set<string>();
  const dhcpReservationsInventoriedDevices = new Set<string>();
  const dhcpLeasesInventoriedDevices = new Set<string>();

  const mgmtIfaceName = config.mgmtInterface || "mgmt";
  const useProxy = config.useProxy !== false; // default true

  // Direct-mode dispatch runs two producers concurrently feeding one shared
  // worker pool gated at `discoveryParallelism`:
  //
  //   • **Warm-cache producer** — for each FortiGate whose firewall Asset row
  //     was monitor-up at discovery start, dispatch immediately using the
  //     cached management IP. No FMG round-trip; the pool fills from t=0.
  //   • **Verify producer** — for the rest (cache-cold or new), serially
  //     resolve each mgmt IP through the FMG worker (FMG drops parallel
  //     calls past 1-2 for this API user, so the resolver itself stays
  //     strictly serial), then dispatch as each IP lands.
  //
  // Cache-miss fallback inside processDevice covers the case where a cached
  // IP went stale (FortiGate was renumbered between discoveries): the first
  // direct REST call fails, we re-resolve via the FMG worker, and retry once
  // at the new address. Self-healing without a second discovery cycle.
  //
  // Proxy mode (useProxy=true) ignores the warm cache entirely — every
  // per-device call funnels through `/sys/proxy/json` which is FMG-bound, so
  // the cache offers no speedup. concurrency is forced to 1 to match FMG's
  // proxy-connection limit.
  const mgmtIpByDevice = new Map<string, string>();

  // Pre-populate from the warm cache (direct mode only). cachedNames tracks
  // which entries came from the cache so the cache-miss fallback knows
  // whether to retry on direct-call failure. Keys are lowercased via
  // fmgNameKey because the warm cache is built from Asset.hostname (which
  // can be FortiOS-cased upper) while FMG roster names may be operator-set
  // lowercase — same device, different casing.
  const cachedNames = new Set<string>();
  if (!useProxy && warmCacheIps && warmCacheIps.size > 0) {
    for (const [name, ip] of warmCacheIps) {
      const key = fmgNameKey(name);
      mgmtIpByDevice.set(key, ip);
      cachedNames.add(key);
    }
  }

  // Per-device discovery: runs all 8 RPC steps and returns local result arrays.
  // Isolated from shared state — safe to run concurrently across devices.
  async function processDevice(rawDevice: any): Promise<DeviceChunk | null> {
    const deviceName: string = rawDevice.name || rawDevice.hostname;
    if (!deviceName) return null;

    // Offline in FMG (conn_status !== 1): the device's live-monitor queries
    // (/sys/proxy/json → /api/v2/monitor/*) will fail, but FMG still holds a
    // cached copy of its config in CMDB (/pm/config/device/<name>/...) that
    // reads fine offline. Instead of skipping the device entirely, we pull the
    // CMDB config-derived IP info (subnets, static reservations, interface IPs,
    // VIPs) and skip only the live-monitor blocks. Config-only: an offline pull
    // must never advance lastSeen or drive decommission (see the `offline`
    // guards below + the flag-force before this function returns).
    const offline = rawDevice.conn_status !== undefined && rawDevice.conn_status !== 1;
    if (offline) {
      log("discover.device.offline", "info", `${deviceName} is offline in FortiManager (conn_status=${rawDevice.conn_status}) — pulling cached CMDB config only (no live leases/inventory/switch/AP/ARP)`, deviceName);
    }
    if (signal?.aborted) return null;

    log("discover.device.start", "info", `Starting discovery for ${deviceName}`, deviceName);
    const devStartMs = Date.now();

    // Direct mode: skip FMG entirely for per-device calls. Use the FortiGate's
    // real management-interface IP (resolved through FMG's interface config —
    // NOT FMG's own device.ip, which is often a FortiLink/mgmt-tunnel address
    // we can't reach). All discovery steps are handled by
    // fortigateService.discoverDhcpSubnets so there's a single source of truth
    // for the FortiGate-side discovery shape.
    //
    // Offline gates skip this branch even in direct mode: the device is
    // unreachable at its mgmt IP, so we fall through to the FMG-native CMDB
    // path below (FMG's cache is the only available source of its config).
    if (!useProxy && !offline) {
      if (!config.fortigateApiToken) {
        log("discover.device.skip", "error", `Skipping ${deviceName} — direct mode requires "FortiGate API Token" to be set on the integration`, deviceName);
        return null;
      }

      // Direct mode uses the management IP populated up front — either from
      // the warm cache (Producer A) or the FMG-serial resolve pass (Producer
      // B). Both write to mgmtIpByDevice before dispatching this function;
      // we must NOT call resolveDeviceMgmtIp synchronously here because
      // multiple workers can be running in parallel and FMG only serves one
      // request at a time on the resolver path.
      const deviceKey = fmgNameKey(deviceName);
      let directHost = mgmtIpByDevice.get(deviceKey) ?? null;
      if (!directHost) {
        log("discover.device.skip", "error", `Skipping ${deviceName} — no management IP configured on interface "${mgmtIfaceName}" (pre-resolve missed or failed)`, deviceName);
        return null;
      }

      const buildFgConfig = (host: string): FortiGateConfig => ({
        host,
        port: 443,
        apiUser: config.fortigateApiUser || "",
        apiToken: config.fortigateApiToken!,
        vdom: "root",
        verifySsl: config.fortigateVerifySsl === true,
        mgmtInterface: config.mgmtInterface,
        interfaceInclude: config.interfaceInclude,
        interfaceExclude: config.interfaceExclude,
        dhcpInclude: config.dhcpInclude,
        dhcpExclude: config.dhcpExclude,
        inventoryIncludeInterfaces: config.inventoryIncludeInterfaces,
        inventoryExcludeInterfaces: config.inventoryExcludeInterfaces,
        // Direct mode delegates the ARP step to fortigateService — hand it
        // this device's presence-sweep targets so Chain D primes the cache
        // before its table read, same as the proxy path below.
        arpSweepIps: arpSweepTargets?.get(fmgNameKey(deviceName)),
      });
      let fgConfig = buildFgConfig(directHost);

      // Retry-once loop: if the FIRST attempt's IP came from the warm cache
      // and the call fails, re-resolve via the FMG worker and retry. Any
      // subsequent failure is treated as a real outage.
       
      while (true) {
        try {
          const fgResult = await discoverViaFortigate(fgConfig, signal, log, inventoryMaxAgeHours, undefined, true);
          // fortigateService reports one "device" keyed by the FortiGate's own
          // hostname/serial. Remap every cross-reference to FMG's canonical
          // deviceName so the downstream sync pipeline treats this as one device
          // belonging to the FMG integration.
          const fgDeviceName = fgResult.devices[0]?.name || rawDevice.ip;
          for (const s of fgResult.subnets)         s.fortigateDevice = s.fortigateDevice === fgDeviceName ? deviceName : s.fortigateDevice;
          for (const i of fgResult.interfaceIps)    i.device          = i.device === fgDeviceName ? deviceName : i.device;
          for (const e of fgResult.dhcpEntries)     e.device          = e.device === fgDeviceName ? deviceName : e.device;
          for (const v of fgResult.vips)            v.device          = v.device === fgDeviceName ? deviceName : v.device;
          for (const sw of fgResult.fortiSwitches)  sw.device         = sw.device === fgDeviceName ? deviceName : sw.device;
          for (const ap of fgResult.fortiAps)       ap.device         = ap.device === fgDeviceName ? deviceName : ap.device;
          for (const inv of fgResult.deviceInventory) inv.device      = inv.device === fgDeviceName ? deviceName : inv.device;

          // Prefer FMG-configured coordinates (Device Manager → Geographical
          // Location) and fall back to whatever the FortiGate itself returned
          // via /api/v2/cmdb/system/global.
          const fmgLat = parseFloat(String(rawDevice.latitude ?? ""));
          const fmgLng = parseFloat(String(rawDevice.longitude ?? ""));
          const fmgCoordsOk = Number.isFinite(fmgLat) && Number.isFinite(fmgLng) && !(fmgLat === 0 && fmgLng === 0);
          // HA roster comes from FMG (authoritative across failover — FMG's
          // ha_slave[] is stable while fortigateService's ha-peer query
          // reflects whichever physical box is currently active). Prefer FMG's
          // view; fall back to fortigateService's ha-peer-derived view only
          // when FMG didn't surface one (older FMG releases, missing perms).
          const fmgHa = extractHaFromFmgDevice(rawDevice);
          const haFromFmg = fmgHa.haMembers.length > 0;
          const mv = resolveMetavarCoords(rawDevice, deviceName);
          const localDev: DiscoveredDevice = {
            name: deviceName,
            hostname: rawDevice.hostname || deviceName,
            serial:   rawDevice.sn || fgResult.devices[0]?.serial || "",
            model:    rawDevice.platform_str || fgResult.devices[0]?.model || "",
            mgmtIp:   directHost,
            // FortiOS version: prefer fortigateService's live read of /system/status
            // (canonical FortiOS version string); fall back to FMG's os_ver/mr/patch
            // when the direct call didn't surface one.
            osVersion: fgResult.devices[0]?.osVersion || buildFmgOsVersion(rawDevice) || "",
            // mgmt MAC + all interface MACs come only from fortigateService's
            // direct CMDB read — FMG's device-list record doesn't carry them.
            ...(fgResult.devices[0]?.mgmtMac ? { mgmtMac: fgResult.devices[0].mgmtMac } : {}),
            ...(fgResult.devices[0]?.interfaceMacs?.length ? { interfaceMacs: fgResult.devices[0].interfaceMacs } : {}),
            latitude:  fmgCoordsOk ? fmgLat : fgResult.devices[0]?.latitude,
            longitude: fmgCoordsOk ? fmgLng : fgResult.devices[0]?.longitude,
            ...(mv.latitude !== undefined ? { metavarLatitude: mv.latitude } : {}),
            ...(mv.longitude !== undefined ? { metavarLongitude: mv.longitude } : {}),
            ...(mv.address !== undefined ? { metavarAddress: mv.address } : {}),
            ...(haFromFmg
              ? { haMode: fmgHa.haMode, haMembers: fmgHa.haMembers }
              : (fgResult.devices[0]?.haMembers && fgResult.devices[0].haMembers.length > 0
                  ? { haMode: fgResult.devices[0].haMode, haMembers: fgResult.devices[0].haMembers }
                  : { haMode: "standalone" as const })),
          };
          if (haFromFmg) {
            log("discover.ha", "info", `${deviceName}: HA cluster from FMG — mode=${fmgHa.haMode}, ${fmgHa.haMembers.length} member(s)`, deviceName);
          }
          if (fmgCoordsOk) {
            log("discover.geo", "info", `${deviceName}: Using FMG-configured coordinates ${fmgLat.toFixed(4)}, ${fmgLng.toFixed(4)}`, deviceName);
          }

          return {
            device: localDev,
            subnets: fgResult.subnets,
            interfaceIps: fgResult.interfaceIps,
            dhcpEntries: fgResult.dhcpEntries,
            deviceInventory: fgResult.deviceInventory,
            didInventory: fgResult.inventoryDevices.length > 0,
            fortiSwitches: fgResult.fortiSwitches,
            fortiAps: fgResult.fortiAps,
            vips: fgResult.vips,
            switchMacTable: fgResult.switchMacTable,
            arpTable: fgResult.arpTable,
            cmdbSwitchSerials: fgResult.cmdbSwitchSerials,
            cmdbApSerials: fgResult.cmdbApSerials,
            // Direct mode reads the gate itself, so its roster knowledge is
            // whatever fortigateService reported -- carried through rather than
            // re-derived, so membership means the same thing on both transports.
            didSwitchCmdbRoster: (fgResult.managedMembership?.switchDevices.length ?? 0) > 0,
            didApCmdbRoster: (fgResult.managedMembership?.apDevices.length ?? 0) > 0,
            // Direct mode delegates inventory to fortigateService — surface the
            // same per-device "did this query succeed" flags it returns so the
            // decommission sweep behaves identically across transport modes.
            didSwitchQuery: !!fgResult.switchInventoriedDevices && fgResult.switchInventoriedDevices.length > 0,
            didApQuery:     !!fgResult.apInventoriedDevices     && fgResult.apInventoriedDevices.length     > 0,
            didVipQuery:                 !!fgResult.vipInventoriedDevices                 && fgResult.vipInventoriedDevices.length                 > 0,
            didDhcpReservationsQuery:    !!fgResult.dhcpReservationsInventoriedDevices    && fgResult.dhcpReservationsInventoriedDevices.length    > 0,
            didDhcpLeasesQuery:          !!fgResult.dhcpLeasesInventoriedDevices          && fgResult.dhcpLeasesInventoriedDevices.length          > 0,
            didArpQuery:                 !!fgResult.arpQueriedDevices                     && fgResult.arpQueriedDevices.length                     > 0,
          };
        } catch (err: any) {
          // Cache-miss fallback: only retry when the IP came from the warm
          // cache. cachedNames is cleared on first attempt so we never loop
          // a second time.
          if (!cachedNames.has(deviceKey)) {
            log("discover.device", "error", `${deviceName}: Direct discovery failed — ${err.message || "Unknown error"}`, deviceName);
            return null;
          }
          cachedNames.delete(deviceKey);
          log("discover.device.cache_miss", "info", `${deviceName}: Cached management IP ${directHost} unreachable — re-resolving via FortiManager (${err.message || "unknown error"})`, deviceName);
          let newIp: string | null;
          try {
            newIp = await resolveDeviceMgmtIp(baseUrl, config, deviceName, mgmtIfaceName, signal, integrationId);
          } catch (resolveErr: any) {
            log("discover.device", "error", `${deviceName}: Direct discovery failed and FMG re-resolve failed — ${resolveErr.message || "unknown error"} (original: ${err.message || "unknown error"})`, deviceName);
            return null;
          }
          if (!newIp) {
            log("discover.device", "error", `${deviceName}: Direct discovery failed; FortiManager returned no management IP on re-resolve. Original: ${err.message || "unknown error"}`, deviceName);
            return null;
          }
          if (newIp === directHost) {
            log("discover.device", "error", `${deviceName}: Direct discovery failed; FMG re-resolve returned the same IP (${directHost}) — FortiGate appears unreachable. Original: ${err.message || "unknown error"}`, deviceName);
            return null;
          }
          // Fresh IP — update the in-memory map (so any later code in this
          // run sees the new IP) and retry once at the new address.
          mgmtIpByDevice.set(deviceKey, newIp);
          directHost = newIp;
          fgConfig = buildFgConfig(newIp);
          // continue while loop → retry once at newIp
        }
      }
    }

    // Seed coordinates from FMG's device record (Device Manager → Geographical
    // Location). These are the authoritative source when the operator set the
    // site location in FortiManager. The CMDB `system/global` fallback below
    // only fires when FMG has no coords for this device.
    const fmgLat = parseFloat(String(rawDevice.latitude ?? ""));
    const fmgLng = parseFloat(String(rawDevice.longitude ?? ""));
    const fmgCoordsOk = Number.isFinite(fmgLat) && Number.isFinite(fmgLng) && !(fmgLat === 0 && fmgLng === 0);
    // HA roster from FMG's device record (ha_mode + ha_slave[]). Proxy mode
    // has no per-device fortigateService call to fall back on, so this is
    // the only source. Standalone or missing → haMode: "standalone".
    const fmgHa = extractHaFromFmgDevice(rawDevice);
    const mv = resolveMetavarCoords(rawDevice, deviceName);
    const localDevice: DiscoveredDevice = {
      name: deviceName,
      hostname: rawDevice.hostname || deviceName,
      serial: rawDevice.sn || "",
      model: rawDevice.platform_str || "",
      mgmtIp: rawDevice.ip || "",
      osVersion: buildFmgOsVersion(rawDevice) || "",
      ...(fmgCoordsOk ? { latitude: fmgLat, longitude: fmgLng } : {}),
      ...(mv.latitude !== undefined ? { metavarLatitude: mv.latitude } : {}),
      ...(mv.longitude !== undefined ? { metavarLongitude: mv.longitude } : {}),
      ...(mv.address !== undefined ? { metavarAddress: mv.address } : {}),
      ...(fmgHa.haMembers.length > 0
        ? { haMode: fmgHa.haMode, haMembers: fmgHa.haMembers }
        : { haMode: "standalone" as const }),
      ...(offline ? { offline: true } : {}),
    };
    if (fmgHa.haMembers.length > 0) {
      log("discover.ha", "info", `${deviceName}: HA cluster from FMG — mode=${fmgHa.haMode}, ${fmgHa.haMembers.length} member(s)`, deviceName);
    }
    if (fmgCoordsOk) {
      log("discover.geo", "info", `${deviceName}: Using FMG-configured coordinates ${fmgLat.toFixed(4)}, ${fmgLng.toFixed(4)}`, deviceName);
    }
    const ctx: FmgDeviceCtx = {
      config, baseUrl, adom, apiUser, apiToken, verifySsl, signal, integrationId, log,
      mgmtIfaceName, inventoryMaxAgeHours, arpSweepTargets,
      deviceName, offline, localDevice,
      localSubnets: [], localInterfaceIps: [], localDhcpEntries: [], localInventory: [],
      localSwitches: [], localAps: [], localSwitchMacTable: [], localArpTable: [],
      localCmdbSwitchSerials: [], localCmdbApSerials: [], localVips: [],
      // Track whether each inventory query returned a usable response so the
      // sync's decommission pass can distinguish "controller offline" (don't
      // decommission its switches/APs) from "controller responded but no
      // longer reports this device" (do decommission). Same pattern for the
      // authoritative-source queries Phase 5b consumes -- a failed VIP or
      // DHCP CMDB query must NOT cause Polaris to wipe rows we haven't
      // actually heard the gate disclaim.
      flags: {
        didInventory: false, didSwitchQuery: false, didApQuery: false,
        didSwitchCmdbRoster: false, didApCmdbRoster: false,
        didVipQuery: false, didDhcpReservationsQuery: false, didDhcpLeasesQuery: false,
        didArpQuery: false,
      },
    };
    const { localSubnets, localInterfaceIps, localDhcpEntries, localInventory, localSwitches, localAps, localSwitchMacTable, localArpTable, localCmdbSwitchSerials, localCmdbApSerials, localVips, flags } = ctx;

    if (localDevice.mgmtIp && isValidIpv4(localDevice.mgmtIp)) {
      localInterfaceIps.push({ device: deviceName, interfaceName: mgmtIfaceName, ipAddress: localDevice.mgmtIp, role: "management" });
    }

    await fmgStepMgmtIp(ctx);
    await fmgStepDhcpConfig(ctx);
    await fmgStepDhcpMonitor(ctx);
    await fmgStepInterfaceIps(ctx);
    await fmgStepInventory(ctx);
    await fmgStepSwitches(ctx);
    await fmgStepSwitchCmdbRoster(ctx);
    await fmgStepAps(ctx);
    await fmgStepApCmdbRoster(ctx);
    await fmgStepApPortMap(ctx);
    await fmgStepArp(ctx);
    await fmgStepGeoFallback(ctx);
    await fmgStepVips(ctx);

    // Enrich inventory: fill blank interfaceNames from this device's own DHCP data
    const macToIface = new Map<string, string>();
    for (const e of localDhcpEntries) {
      if (e.macAddress && e.interfaceName) {
        const norm = e.macAddress.toUpperCase().replace(/-/g, ":");
        if (!macToIface.has(norm)) macToIface.set(norm, e.interfaceName);
      }
    }
    for (const inv of localInventory) {
      if (!inv.interfaceName && inv.macAddress) {
        const norm = inv.macAddress.toUpperCase().replace(/-/g, ":");
        const iface = macToIface.get(norm);
        if (iface) inv.interfaceName = iface;
      }
    }

    // Offline gates: the CMDB steps above set didDhcpReservationsQuery /
    // didVipQuery true, but an offline device's cache may predate operator
    // changes (a VIP/reservation added after it went offline won't be in the
    // cache). Force every "did-query" flag false so the offline pull is purely
    // additive/refresh — it can create/refresh rows but can NEVER drive a
    // release or decommission in the sync's Phase 2b / Phase 5b sweeps.
    // cmdbSwitchSerials/cmdbApSerials stay populated — they only protect
    // configured-but-offline switches/APs from decommission, never trigger it.
    // Each entry carries this device's name, and the sync scopes the
    // protection to assets whose recorded controller IS this gate — an
    // offline gate's cached roster (or a staged replacement gate's cloned
    // config) must never vouch for devices owned by other controllers.
    // NOT cleared here, deliberately: didSwitchCmdbRoster / didApCmdbRoster.
    // Those describe whether FMG's own config DB answered, which does not depend
    // on the device being reachable -- the roster steps run for offline gates
    // precisely so an unreachable gate still has a known member list. They feed
    // the dependency membership constraint ONLY and can never authorize a
    // decommission; the flags that can (didSwitchQuery / didApQuery) are cleared
    // right below. An offline gate's roster may be stale, but a stale roster
    // over- or under-lists members, and over-listing merely PERMITS an edge
    // rather than creating one.
    if (offline) {
      flags.didInventory = false;
      flags.didSwitchQuery = false;
      flags.didApQuery = false;
      flags.didVipQuery = false;
      flags.didDhcpReservationsQuery = false;
      flags.didDhcpLeasesQuery = false;
      // The ARP read is a LIVE monitor call, so an offline gate should never
      // have set this in the first place — cleared anyway so the delete-replace
      // in persistFortigateArpTables can only ever be driven by a gate that
      // genuinely answered.
      flags.didArpQuery = false;
    }

    return { device: localDevice, subnets: localSubnets, interfaceIps: localInterfaceIps, dhcpEntries: localDhcpEntries, deviceInventory: localInventory, didInventory: flags.didInventory, fortiSwitches: localSwitches, fortiAps: localAps, vips: localVips, switchMacTable: localSwitchMacTable, arpTable: localArpTable, cmdbSwitchSerials: localCmdbSwitchSerials, cmdbApSerials: localCmdbApSerials, didSwitchQuery: flags.didSwitchQuery, didApQuery: flags.didApQuery, didVipQuery: flags.didVipQuery, didDhcpReservationsQuery: flags.didDhcpReservationsQuery, didDhcpLeasesQuery: flags.didDhcpLeasesQuery, didArpQuery: flags.didArpQuery, didSwitchCmdbRoster: flags.didSwitchCmdbRoster, didApCmdbRoster: flags.didApCmdbRoster };
  }

  // Process up to `concurrency` FortiGates in parallel.
  // Merging into shared arrays is a synchronous block — no interleaving possible.
  // When useProxy is true (default), all per-device calls funnel through FMG and
  // concurrency is forced to 1 — FMG drops parallel /sys/proxy/json connections
  // past very low parallelism, producing sporadic `fetch failed` errors. Direct
  // mode talks to each FortiGate independently so parallelism is safe there.
  const concurrency = useProxy ? 1 : Math.max(1, config.discoveryParallelism ?? 5);
  const executing = new Set<Promise<void>>();

  // Per-FortiGate dispatch into the worker pool. Two producers (warm-cache and
  // FMG-verify) call this concurrently; the semaphore (executing.size cap)
  // gates the actual concurrency. The `while` loop is load-bearing: when a
  // task completes, every awaiter of Promise.race(executing) resolves at the
  // same time, so each woken producer must re-check the size before claiming
  // a slot — otherwise N concurrent awaiters all add tasks on a single
  // completion and the effective concurrency drifts upward without bound.
  async function dispatchDevice(rawDevice: any): Promise<void> {
    if (signal?.aborted) return;
    while (executing.size >= concurrency) {
      await Promise.race(executing);
      if (signal?.aborted) return;
    }

    const task: Promise<void> = (async () => {
      // Time the whole per-device cycle including the DB sync (onDeviceComplete).
      // `discover.device.complete` is what clears the device from activeDevices
      // in the UI; emitting it from inside processDevice (which used to be the
      // case) made the device disappear the moment network scrape finished,
      // even though the DB writes were still in progress and the worker slot
      // was still held. Emitting after onDeviceComplete keeps the UI honest.
      const devStartMs = Date.now();
      const chunk = await processDevice(rawDevice);
      // processDevice emits its own terminal event (skip / error) on the
      // null-return paths — nothing more to do here in that case.
      if (!chunk) return;

      const filteredDevSubnets = filterDhcpResults(
        chunk.subnets,
        config.dhcpInclude,
        config.dhcpExclude,
      );
      const excludedDevIfaces = new Set(
        chunk.subnets
          .filter((s) => !filteredDevSubnets.includes(s))
          .map((s) => `${s.fortigateDevice}/${s.name}`)
      );
      const filteredDevInventory = chunk.deviceInventory.filter(
        (d) => !excludedDevIfaces.has(`${d.device}/${d.interfaceName}`) &&
                matchesInventoryFilter(d.interfaceName, config)
      );

      // Atomic merge into shared arrays (synchronous — no await between here and end of block)
      discovered.push(...filteredDevSubnets);
      devices.push(chunk.device);
      interfaceIps.push(...chunk.interfaceIps);
      dhcpEntries.push(...chunk.dhcpEntries);
      deviceInventory.push(...filteredDevInventory);
      if (chunk.didInventory) inventoryDevices.add(chunk.device.name);
      fortiSwitches.push(...chunk.fortiSwitches);
      fortiAps.push(...chunk.fortiAps);
      vips.push(...chunk.vips);
      switchMacTable.push(...chunk.switchMacTable);
      arpTable.push(...chunk.arpTable);
      cmdbSwitchSerials.push(...chunk.cmdbSwitchSerials);
      cmdbApSerials.push(...chunk.cmdbApSerials);
      if (chunk.didSwitchQuery) switchInventoriedDevices.add(chunk.device.name);
      if (chunk.didApQuery)     apInventoriedDevices.add(chunk.device.name);
      if (chunk.didVipQuery)                 vipInventoriedDevices.add(chunk.device.name);
      if (chunk.didDhcpReservationsQuery)    dhcpReservationsInventoriedDevices.add(chunk.device.name);
      if (chunk.didDhcpLeasesQuery)          dhcpLeasesInventoriedDevices.add(chunk.device.name);
      if (chunk.didArpQuery)                 arpQueriedDevices.add(chunk.device.name);
      if (chunk.didSwitchCmdbRoster)         cmdbSwitchRosterDevices.add(chunk.device.name);
      if (chunk.didApCmdbRoster)             cmdbApRosterDevices.add(chunk.device.name);

      if (onDeviceComplete) {
        try {
          await onDeviceComplete({
            subnets: filteredDevSubnets,
            devices: [chunk.device],
            interfaceIps: chunk.interfaceIps,
            dhcpEntries: chunk.dhcpEntries,
            deviceInventory: filteredDevInventory,
            inventoryDevices: chunk.didInventory ? [chunk.device.name] : [],
            knownDeviceNames: [],
            knownDeviceSerials: [],
            fortiSwitches: chunk.fortiSwitches,
            fortiAps: chunk.fortiAps,
            vips: chunk.vips,
            switchMacTable: chunk.switchMacTable,
            arpTable: chunk.arpTable,
            arpQueriedDevices: chunk.didArpQuery ? [chunk.device.name] : [],
            cmdbSwitchSerials: chunk.cmdbSwitchSerials,
            cmdbApSerials: chunk.cmdbApSerials,
            switchInventoriedDevices: chunk.didSwitchQuery ? [chunk.device.name] : [],
            apInventoriedDevices:     chunk.didApQuery     ? [chunk.device.name] : [],
            vipInventoriedDevices:                 chunk.didVipQuery                 ? [chunk.device.name] : [],
            dhcpReservationsInventoriedDevices:    chunk.didDhcpReservationsQuery    ? [chunk.device.name] : [],
            dhcpLeasesInventoriedDevices:          chunk.didDhcpLeasesQuery          ? [chunk.device.name] : [],
          });
        } catch (err: any) {
          if (err?.name === "AbortError") {
            // Operator cancel landed mid-sync (syncDhcpSubnets' phase-boundary
            // check threw) — not a device failure. `discover.device.abort` is
            // terminal for the activeDevices UI but deliberately increments no
            // skip counter; the run-level abort accounting covers it.
            log("discover.device.abort", "info", `${chunk.device.name}: Per-device sync stopped by cancel — ${err.message || "aborted"}`, chunk.device.name);
            return;
          }
          log("discover.device", "error", `${chunk.device.name}: Per-device sync failed — ${err.message || "Unknown error"}`, chunk.device.name);
          return; // terminal event already emitted — skip the complete log
        }
      }

      log("discover.device.complete", "info", `Completed discovery for ${chunk.device.name} in ${Date.now() - devStartMs}ms`, chunk.device.name);
    })().catch(() => {});

    executing.add(task);
    task.then(() => executing.delete(task), () => executing.delete(task));
  }

  // Index FMG roster devices by name for O(1) lookup from the warm-cache
  // producer. Keys are lowercased so warm-cache hostnames (which can be
  // FortiOS-cased) match FMG-roster names that differ only in case.
  const devicesByName = new Map<string, any>();
  for (const d of devicesData) {
    const n = d.name || d.hostname;
    if (typeof n === "string" && n.length > 0) devicesByName.set(fmgNameKey(n), d);
  }

  // Producer A — warm-cache: dispatch every monitor-up FortiGate immediately
  // using its cached management IP. No FMG round-trip. Skipped in proxy mode
  // (FMG is in front of every per-device call there anyway).
  //
  // `warmDispatched` is populated SYNCHRONOUSLY here, before either producer
  // IIFE runs, so verifyTask sees the final exclusion set when it computes
  // verifyTargets. Populating it inside the warm loop would race with
  // verifyTask's synchronous startup: only the first cached name would be in
  // the set at the moment verifyTargets is computed, and the verify producer
  // would redundantly dispatch every other warm-cache device.
  // warmDispatched holds lowercased keys; cachedNames and devicesByName are
  // both lowercased so .has() membership and the verify producer's
  // !warmDispatched.has(...) exclusion all align on the same canonical key.
  const warmDispatched = new Set<string>();
  if (!useProxy) {
    for (const key of cachedNames) {
      if (devicesByName.has(key)) warmDispatched.add(key);
    }
  }
  const warmCacheTask: Promise<void> = (async () => {
    if (useProxy || warmDispatched.size === 0) return;
    let dispatched = 0;
    for (const key of warmDispatched) {
      if (signal?.aborted) return;
      const raw = devicesByName.get(key);
      if (!raw) continue; // defensive — populated synchronously above
      // If FMG says the device is disconnected, processDevice skips the direct
      // call and pulls its cached CMDB config from FMG instead (config-only).
      await dispatchDevice(raw);
      dispatched++;
    }
    if (dispatched > 0) {
      log("discover.warmcache", "info", `Dispatched ${dispatched} FortiGate(s) from warm cache (no FMG mgmt-IP resolve required)`);
    }
  })();

  // Producer B — FMG-verify: dispatch the remaining devices, serially
  // resolving each mgmt IP through the FMG worker. In proxy mode this
  // dispatches every device with no resolves (the existing behavior).
  //
  // Devices are sorted alphabetically by name (case-insensitive, natural-
  // numeric so FW-2 precedes FW-10) so the dispatch order matches the warm
  // cache producer's order and gives operators a predictable view in live
  // discovery logs. Same comparator as buildFmgWarmCacheIps in integrations.ts.
  const sortDevicesByName = (arr: any[]): any[] =>
    [...arr].sort((a, b) =>
      String(a.name || a.hostname || "").localeCompare(
        String(b.name || b.hostname || ""),
        undefined,
        { sensitivity: "base", numeric: true },
      ),
    );

  const verifyTask: Promise<void> = (async () => {
    if (useProxy) {
      for (const raw of sortDevicesByName(devicesData)) {
        if (signal?.aborted) return;
        await dispatchDevice(raw);
      }
      return;
    }

    const verifyTargets = sortDevicesByName(devicesData.filter((d) => {
      const n = d.name || d.hostname;
      return typeof n === "string" && !warmDispatched.has(fmgNameKey(n));
    }));
    const connectedVerifyCount = verifyTargets.filter(
      (d) => d.conn_status === undefined || d.conn_status === 1,
    ).length;
    if (connectedVerifyCount > 0) {
      log("discover.mgmtip.pre", "info", `Streaming mgmt-IP resolution for ${connectedVerifyCount} cache-cold device(s); FortiGate workers will start as IPs land`);
    }
    let resolved = 0;
    let failed = 0;
    for (const raw of verifyTargets) {
      if (signal?.aborted) return;
      const isConnected = raw.conn_status === undefined || raw.conn_status === 1;
      const name: string = raw.name || raw.hostname;
      if (isConnected && name) {
        try {
          const ip = await resolveDeviceMgmtIp(baseUrl, config, name, mgmtIfaceName, signal, integrationId);
          if (ip) {
            mgmtIpByDevice.set(fmgNameKey(name), ip);
            resolved++;
          } else {
            failed++;
          }
        } catch (err: any) {
          failed++;
          log("discover.mgmtip.pre", "error", `${name}: Failed to resolve management IP — ${err.message || "Unknown error"}`, name);
        }
      }
      // Dispatch disconnected devices and resolve-failures too: disconnected
      // devices get their cached CMDB config pulled from FMG (no mgmt-IP resolve
      // needed); resolve-failures emit processDevice's standard error.
      await dispatchDevice(raw);
    }
    if (connectedVerifyCount > 0) {
      log("discover.mgmtip.pre", "info", `mgmt-IP resolution complete: ${resolved} resolved, ${failed} failed`);
    }
  })();

  await Promise.all([warmCacheTask, verifyTask]);
  await Promise.all(executing);

  // Step 4: Filtering was applied per-device during collection; log summary and return.
  log("discover.filter", "info", `Filter complete: ${discovered.length} subnet(s) included, ${dhcpEntries.length} DHCP entries, ${deviceInventory.length} inventory device(s)`);

  return {
    subnets: discovered,
    devices,
    interfaceIps,
    dhcpEntries,
    deviceInventory,
    inventoryDevices: [...inventoryDevices],
    knownDeviceNames,
    knownDeviceSerials,
    fortiSwitches,
    fortiAps,
    vips,
    switchMacTable,
    arpTable,
    arpQueriedDevices: [...arpQueriedDevices],
    managedMembership: {
      switches: cmdbSwitchSerials,
      aps: cmdbApSerials,
      switchDevices: [...cmdbSwitchRosterDevices],
      apDevices: [...cmdbApRosterDevices],
    },
    cmdbSwitchSerials,
    cmdbApSerials,
    switchInventoriedDevices: [...switchInventoriedDevices],
    apInventoriedDevices:     [...apInventoriedDevices],
    vipInventoriedDevices:                 [...vipInventoriedDevices],
    dhcpReservationsInventoriedDevices:    [...dhcpReservationsInventoriedDevices],
    dhcpLeasesInventoriedDevices:          [...dhcpLeasesInventoriedDevices],
  };
}


// matchesWildcard is imported from ../utils/integrationFilter.js — the
// canonical glob-lite matcher shared by every device/VM/interface filter.

function matchesInterfaceFilter(interfaceName: string, config: FortiManagerConfig): boolean {
  const includeList = config.interfaceInclude ?? [];
  const excludeList = config.interfaceExclude ?? [];
  if (includeList.length > 0) return includeList.some((p) => matchesWildcard(p, interfaceName));
  if (excludeList.length > 0) return !excludeList.some((p) => matchesWildcard(p, interfaceName));
  return true;
}

function matchesInventoryFilter(interfaceName: string, config: FortiManagerConfig): boolean {
  const includeList = config.inventoryIncludeInterfaces ?? [];
  const excludeList = config.inventoryExcludeInterfaces ?? [];

  // Plain patterns (no wildcards) also match VLAN sub-interfaces:
  // "AcmeGuest" matches "AcmeGuest.100", "dmz" matches "dmz.10"
  function matches(pattern: string, iface: string): boolean {
    if (matchesWildcard(pattern, iface)) return true;
    if (!pattern.includes("*") && iface.toLowerCase().startsWith(pattern.toLowerCase() + ".")) return true;
    return false;
  }

  if (includeList.length > 0) return includeList.some((p) => matches(p, interfaceName));
  if (excludeList.length > 0) return !excludeList.some((p) => matches(p, interfaceName));
  return true;
}

function filterDevices(
  devices: any[],
  include?: string[],
  exclude?: string[],
): any[] {
  const matchDevice = (d: any, pattern: string): boolean => {
    const name = String(d.name ?? "");
    const hostname = String(d.hostname ?? "");
    return matchesWildcard(pattern, name) || (hostname !== "" && matchesWildcard(pattern, hostname));
  };

  if (include && include.length > 0) {
    return devices.filter((d) => include.some((p) => matchDevice(d, p)));
  }
  if (exclude && exclude.length > 0) {
    return devices.filter((d) => !exclude.some((p) => matchDevice(d, p)));
  }
  return devices;
}

function filterDhcpResults(
  subnets: DiscoveredSubnet[],
  include?: string[],
  exclude?: string[],
): DiscoveredSubnet[] {
  let result = subnets;

  if (include && include.length > 0) {
    result = result.filter((s) =>
      include.some((pattern) =>
        matchesWildcard(pattern, String(s.name)) ||
        matchesWildcard(pattern, String(s.dhcpServerId))
      )
    );
  }

  if (exclude && exclude.length > 0) {
    result = result.filter((s) =>
      !exclude.some((pattern) =>
        matchesWildcard(pattern, String(s.name)) ||
        matchesWildcard(pattern, String(s.dhcpServerId))
      )
    );
  }

  return result;
}
