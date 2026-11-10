/**
 * src/services/monitoring/streamCollection.ts — per-stream collection dispatch (CQ-B061, moved verbatim from monitoringService.ts):
 * collectTelemetry / collectFastFiltered / collectSystemInfo pick the collector for an
 * asset's resolved polling method and lay the overlays over its result — wireless-station
 * signal, FortiSwitch port VLANs and trunks, the FortiAP REST readings, the IPsec-only
 * pass, the HTTP probe. The pass orchestration in monitoringService.ts calls these.
 */

import { prisma } from "../../db.js";
import { collectHostSsh, collectHostWinrm } from "../agentlessHostService.js";
import { AppError } from "../../utils/errors.js";
import { splitInterfaceAddresses } from "../../utils/interfaceAddress.js";
import { ipv6Enabled } from "../ipv6GateService.js";
import { loadInterfaceIdentity } from "../interfaceInventoryService.js";
import { canonicalizeInterfaceRows } from "../../utils/interfaceIdentity.js";
import { buildFortiswitchTrunkMembers, parseFortiswitchMclagPeers, parseFortiswitchPortDescriptions, parseFortiswitchPortVlan, fortiosVlanIdByName, FORTISWITCH_MONITOR_PORT_FORMAT, type FortiswitchMclagPeer, type FortiswitchPortVlan } from "../../utils/fortiswitchCmdb.js";
import { logger } from "../../utils/logger.js";
import { adBindFallbackIntegration } from "../../utils/adBindFallback.js";
import { ensureRegistryLoaded, type ResolveScope } from "../oidRegistry.js";
import { pickDbProfile } from "../profileResolver.js";
import { enqueueInterfaceSamples, enqueueStorageSamples, enqueueIpsecTunnelSamples, type InterfaceSampleRow } from "../sampleWriteBuffer.js";
import { recordInterfaceLinkEvents } from "../interfaceLinkEventService.js";
import { isFortinetIntegrationType, isWorkloadPollingMethod } from "../../utils/pollingCompatibility.js";
import { collectHardwareSensorsWorkload, collectSystemInfoWorkload, collectTelemetryWorkload } from "../workloadMonitorService.js";
import { collectHardwareSensorsGenericApi, collectSystemInfoGenericApi, collectTelemetryGenericApi } from "../genericApiMonitorService.js";
import { pickRestApiCredential, type CredentialLike } from "../../utils/fortinetRestCredential.js";
import { dial } from "./dial.js";
import { PROBE_ASSET_OMIT, resolveMonitorSettings, resolveSnmpConfigForStream, resolveAgentlessCredConfig, winrmConnFrom } from "./monitorSettings.js";
import { TelemetrySample, HardwareSensorSample, SystemInfoSample, CollectionResult } from "./types.js";
import { startPhase } from "./common.js";
import { withSnmpSession } from "./snmpCore.js";
import { overlayFortiswitchTrunkMembers } from "./fortiswitchTrunks.js";
import { profileSubjectFor, collectTelemetrySnmp, collectHardwareSensorsSnmp, collectSystemInfoSnmp, collectFastFilteredSnmp, collectLldpOnlySnmp } from "./snmpCollectors.js";
import { buildFortinetConfig, collectTelemetryFortinet, collectHardwareSensorsFortinet, collectSystemInfoFortinet, collectLldpOnlyFortinet, fetchFortilinkInterfaceSet, FortiIpsecCollection, collectIpsecFortinet, applyFortiInterfaceFilter } from "./fortiosCollectors.js";
import { FORTINET_CONTROLLER_CACHE_TTL_MS, fetchViaFortinetTransport, unwrapFortiosRows, fetchFortinetControllerInventory } from "./fortinetControllers.js";
import { readVcenterAsset, collectTelemetryVcenter, buildVcenterSystemInfo, collectSystemInfoVcenter } from "./vcenterFmgCollectors.js";

/**
 * Pull only IPsec tunnels from FortiOS REST. Used when the interfaces
 * transport is "snmp" but we still want IPsec history on the System tab.
 * Best-effort: returns undefined on any failure so the SNMP-path system-info
 * still succeeds without IPsec.
 */
async function collectIpsecOnlyFortinetSafe(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  timeoutMs?: number,
  credential?: CredentialLike | null,
  opts: { includeSslVpn?: boolean } = {},
): Promise<FortiIpsecCollection | undefined> {
  try {
    const fg = buildFortinetConfig(host, integration, credential);
    if ("error" in fg) return undefined;
    return await collectIpsecFortinet(fg, timeoutMs, opts);
  } catch {
    return undefined;
  }
}

// ─── Wireless-station signal overlay ──────────────────────────────────────
//
// The SNMP fapStationTable carries no per-client RSSI — signal/noise live only
// on the WiFi controller (FortiGate), exposed at /api/v2/monitor/wifi/client.
// One call returns every client on the controller, so we cache it per
// (integration, controller) with the same 30s TTL + inflight-coalescing the
// inventory fetcher uses and let every AP on that controller share it. At 2000
// assets this is one REST call per controller per scrape window, not one per
// AP. Best-effort: any failure leaves signal/noise null and the SNMP-sourced
// station rows persist unchanged. Stations are matched by normalized client
// MAC (a client associates to one AP at a time, so MAC alone scopes correctly).

interface WifiClientSignal {
  signalStrength: number | null;
  noise: number | null;
}

// normalized client MAC (colon-uppercase) → signal
type WifiClientSignalMap = Map<string, WifiClientSignal>;

interface WifiClientCacheEntry {
  fetchedAt: number;
  clients: WifiClientSignalMap;
}

const fortinetWifiClientCache = new Map<string, WifiClientCacheEntry>();

const inflightWifiClientFetch = new Map<string, Promise<WifiClientSignalMap>>();

function wifiClientCacheKey(integrationId: string, deviceName: string): string {
  return `${integrationId}::${deviceName}::wifi-clients`;
}

function wifiClientNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

async function fetchFortinetWifiClients(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  timeoutMs: number,
): Promise<WifiClientSignalMap> {
  const cacheKey = wifiClientCacheKey(integration.id, deviceName);
  const cached = fortinetWifiClientCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return cached.clients;
  }
  const inflight = inflightWifiClientFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<WifiClientSignalMap> => {
    try {
      const path = "/api/v2/monitor/wifi/client";
      const rawRows = await fetchViaFortinetTransport(integration, deviceName, path, timeoutMs, "wifi/client fetch");
      const rows = unwrapFortiosRows(rawRows);
      const clients: WifiClientSignalMap = new Map();
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        const macRaw = String(r.mac ?? r.sta_mac ?? r.station_mac ?? "").trim();
        if (!macRaw) continue;
        const mac = macRaw.toUpperCase().replace(/-/g, ":");
        if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) continue;
        clients.set(mac, {
          signalStrength: wifiClientNum(r.signal ?? r.signal_strength ?? r.rssi),
          noise:          wifiClientNum(r.noise),
        });
      }

      fortinetWifiClientCache.set(cacheKey, { fetchedAt: Date.now(), clients });
      return clients;
    } finally {
      inflightWifiClientFetch.delete(cacheKey);
    }
  })();

  inflightWifiClientFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// ─── FortiSwitch port VLAN overlay ────────────────────────────────────────
//
// Managed FortiSwitches expose interface counters via SNMP IF-MIB, but the
// per-port VLAN config (native PVID + tagged allow-list) lives only on the
// parent FortiGate's CMDB at /api/v2/cmdb/switch-controller/managed-switch.
// Read per controller as: the switch list (serials only), each switch's
// `ports` child table with only the parsed attributes, and the gate's VLAN
// interfaces (name → id). Cached per (integration, controller) with the same
// 30s TTL the inventory fetcher uses. Best-effort — overlay failures never
// break the interface scrape. SNMP-monitored non-Fortinet switches don't get
// VLAN data here (they get Q-BRIDGE-MIB, collectPortVlansSnmp).

// Per-switch view of the controller's managed-switch CMDB: per-port VLAN
// config plus the trunk → physical-member-ports map. The trunk map is the
// authoritative equivalent of the FortiSwitch's own `config switch trunk`
// (auto-ISL FortiLink uplinks are auto-named after the switch serial and
// carry exactly one member); the controller exposes it on the same payload
// the VLAN overlay already reads, so it costs no extra query.
interface FortiswitchSwitchPorts {
  // portName → vlan config
  vlanByPort: Map<string, FortiswitchPortVlan>;
  // trunkName → physical member port names (in CMDB order)
  trunkMembers: Map<string, string[]>;
  // MCLAG ICL legs to the peer switch (one per local mclag-icl-port). Empty on
  // switches not in an MCLAG pair. Read from the same payload the VLAN/trunk
  // maps already parse, so it costs no extra query.
  mclagPeers: FortiswitchMclagPeer[];
  // portName → operator-set port description from the controller CMDB. SNMP
  // IF-MIB has no equivalent, so this overlay is the only way switch-port
  // rows get a discovered `description` (display fallback for interface
  // comments + the read side of description sync). Same free payload.
  descriptionByPort: Map<string, string>;
}

// switchSerialUpper → per-switch ports view
type FortiswitchControllerPortsMap = Map<string, FortiswitchSwitchPorts>;

interface FortiswitchControllerPortsCacheEntry {
  fetchedAt: number;
  ports: FortiswitchControllerPortsMap;
}

const fortiswitchControllerPortsCache = new Map<string, FortiswitchControllerPortsCacheEntry>();

const inflightFortiswitchPortsFetch = new Map<string, Promise<FortiswitchControllerPortsMap>>();

function fortiswitchPortsCacheKey(integrationId: string, deviceName: string): string {
  return `${integrationId}::${deviceName}::fsw-ports`;
}

// VLAN parsing (names → ids, ranges, the "all" sentinel) lives in
// utils/fortiswitchCmdb.ts → parseFortiswitchPortVlan.

/**
 * Turn the per-switch reads into the per-switch ports view. Pure, exported for
 * tests: `switches` are the managed-switch rows (serial keys only), `portsBySwitchId`
 * each switch's `ports` child table, keyed by its `switch-id`, and
 * `vlanIdByName` the controller's VLAN interfaces (fortiosVlanIdByName). A
 * switch whose ports read failed is absent from `portsBySwitchId` and is left
 * out of the result, as a switch with no `ports` always was.
 */
export function buildFortiswitchControllerPortsMap(
  switches: unknown[],
  portsBySwitchId: ReadonlyMap<string, unknown[]>,
  vlanIdByName: ReadonlyMap<string, number>,
): FortiswitchControllerPortsMap {
  const map: FortiswitchControllerPortsMap = new Map();
  for (const row of switches) {
    const r = (row ?? {}) as Record<string, unknown>;
    const serial = String(r.sn || r["switch-id"] || r.name || "").trim();
    const portsRaw = portsBySwitchId.get(String(r["switch-id"] ?? ""));
    if (!serial || !Array.isArray(portsRaw)) continue;
    const portMap = new Map<string, FortiswitchPortVlan>();
    for (const p of portsRaw) {
      const portName = String((p as Record<string, unknown>)?.["port-name"] ?? "").trim();
      if (!portName) continue;
      portMap.set(portName, parseFortiswitchPortVlan(p, vlanIdByName));
    }
    // Trunk → physical-member map: operator LACP bundles (`members`) +
    // FortiLink auto-ISL uplinks (`isl-local-trunk-name` on each physical
    // member). The interface overlay uses this to back-fill ifParent so
    // the topology renderer swaps the opaque trunk name for the real
    // physical port. See buildFortiswitchTrunkMembers. (The child read lists
    // trunk rows first rather than last; physical ports keep their order, and
    // the ISL members are physical ports, so the map is unchanged.)
    const trunkMembers = buildFortiswitchTrunkMembers(portsRaw);
    const mclagPeers = parseFortiswitchMclagPeers(portsRaw);
    const descriptionByPort = parseFortiswitchPortDescriptions(portsRaw);
    map.set(serial.toUpperCase(), { vlanByPort: portMap, trunkMembers, mclagPeers, descriptionByPort });
  }
  return map;
}

async function fetchFortiswitchControllerPortsCmdb(
  integration: { id: string; type: string; config: Record<string, unknown> },
  deviceName: string,
  timeoutMs: number,
): Promise<FortiswitchControllerPortsMap> {
  const cacheKey = fortiswitchPortsCacheKey(integration.id, deviceName);
  const cached = fortiswitchControllerPortsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < FORTINET_CONTROLLER_CACHE_TTL_MS) {
    return cached.ports;
  }
  const inflight = inflightFortiswitchPortsFetch.get(cacheKey);
  if (inflight) return inflight;

  const fetchPromise = (async (): Promise<FortiswitchControllerPortsMap> => {
    try {
      // Three reads instead of one whole-table read (HUB1-a, two 48-port
      // switches: 342 KB → 57 KB, faster too). `format=` cannot reach inside
      // the parent's `ports` (~106 attributes a port); addressing each
      // switch's `ports` child table lets it. No `datasource=1`: on a
      // FortiLink switch it expands nothing — the VLAN fields are interface
      // NAMES with or without it — so the names are resolved here instead.
      //   1. the switch list, serial keys only (throws as the old read did);
      const switchRows = unwrapFortiosRows(await fetchViaFortinetTransport(
        integration, deviceName, "/api/v2/cmdb/switch-controller/managed-switch?format=switch-id|sn|name",
        timeoutMs, "FortiSwitch CMDB list fetch"));
      //   2. each switch's ports, only the attributes the parsers read — a
      //      failed switch is left out rather than failing the controller;
      //   3. the gate's VLAN interfaces, name → id (best-effort: without it
      //      only numeric VLAN references resolve, as before).
      const [portsBySwitchId, vlanIdByName] = await Promise.all([
        Promise.all(switchRows.map(async (row) => {
          const id = String((row as Record<string, unknown>)?.["switch-id"] ?? "").trim();
          if (!id) return null;
          try {
            const raw = await fetchViaFortinetTransport(integration, deviceName,
              `/api/v2/cmdb/switch-controller/managed-switch/${encodeURIComponent(id)}/ports?format=${FORTISWITCH_MONITOR_PORT_FORMAT}`,
              timeoutMs, "FortiSwitch CMDB ports fetch");
            return [id, unwrapFortiosRows(raw)] as const;
          } catch (err) {
            logger.debug({ err, deviceName, switchId: id }, "FortiSwitch ports read failed — that switch gets no CMDB overlay this pass");
            return null;
          }
        })).then((pairs) => new Map(pairs.filter((p): p is readonly [string, unknown[]] => p !== null))),
        fetchViaFortinetTransport(integration, deviceName, "/api/v2/cmdb/system/interface?format=name|vlanid",
          timeoutMs, "FortiGate VLAN interface fetch")
          .then((raw) => fortiosVlanIdByName(unwrapFortiosRows(raw)))
          .catch(() => new Map<string, number>()),
      ]);
      const map = buildFortiswitchControllerPortsMap(switchRows, portsBySwitchId, vlanIdByName);

      fortiswitchControllerPortsCache.set(cacheKey, { fetchedAt: Date.now(), ports: map });
      return map;
    } finally {
      inflightFortiswitchPortsFetch.delete(cacheKey);
    }
  })();

  inflightFortiswitchPortsFetch.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * REST-based CPU/memory collector for managed FortiAPs. The AP itself
 * isn't directly REST-able (no FortiOS REST server on the AP), so we
 * piggyback on the parent FortiGate's /api/v2/monitor/wifi/managed_ap
 * response — it carries `cpu_usage`, `mem_free`, and `mem_total` per
 * AP row. fetchFortinetControllerInventory has already parsed the
 * snapshot into entry.apTelemetry on the controller-cache hit path,
 * so all we do here is fetch (cache or upstream) and project the
 * snapshot into the TelemetrySample shape.
 *
 * Memory: FortiAP reports `mem_free` / `mem_total` in MB. We convert
 * to bytes for the AssetTelemetrySample columns and compute memUsedBytes
 * = (total − free) × 1024 × 1024. memPct is left null since the bytes
 * form is more useful for charts (a 256-MB AP at 90% looks the same as
 * a 1-GB AP at 90% otherwise).
 */
async function collectTelemetryFortiapRest(
  asset: { id: string; serialNumber: string | null; fortinetTopology: unknown },
  integration: { id: string; type: string; config: Record<string, unknown> },
  timeoutMs: number,
): Promise<CollectionResult<TelemetrySample>> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) return { supported: true, error: "FortiAP has no serial number recorded" };

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  if (!deviceName && integration.type === "fortigate") {
    deviceName = String((integration.config as Record<string, unknown>).host || "");
  }
  if (!deviceName) return { supported: true, error: "FortiAP has no controller FortiGate recorded" };

  try {
    const { inventory } = await fetchFortinetControllerInventory(integration, deviceName, "aps", timeoutMs);
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) return { supported: true, error: `FortiAP not present in ${deviceName}'s managed-AP table` };
    const snap = entry.apTelemetry;
    if (!snap) {
      // Controller returned the AP row but with no cpu/mem fields — older
      // FortiOS or feature-licensed install. Caller surfaces this as a
      // collected-with-no-data condition rather than an outright failure.
      return { supported: true, data: { cpuPct: null, memPct: null, memUsedBytes: null, memTotalBytes: null } };
    }
    const memTotalBytes = snap.memTotalMb !== undefined ? snap.memTotalMb * 1024 * 1024 : null;
    const memFreeBytes  = snap.memFreeMb  !== undefined ? snap.memFreeMb  * 1024 * 1024 : null;
    const memUsedBytes  = (memTotalBytes !== null && memFreeBytes !== null) ? memTotalBytes - memFreeBytes : null;
    return {
      supported: true,
      data: {
        cpuPct:        snap.cpuPct ?? null,
        memPct:        null,
        memUsedBytes,
        memTotalBytes,
      },
    };
  } catch (err: any) {
    return { supported: true, error: err?.message || "FortiAP controller query failed" };
  }
}

/**
 * REST-based temperature collector for managed FortiAPs. Same controller-
 * cache as collectTelemetryFortiapRest — `sensors_temperatures` is parsed
 * off the same managed_ap row into entry.apTelemetry.sensorTemperatures.
 */
async function collectHardwareSensorsFortiapRest(
  asset: { id: string; serialNumber: string | null; fortinetTopology: unknown },
  integration: { id: string; type: string; config: Record<string, unknown> },
  timeoutMs: number,
): Promise<CollectionResult<HardwareSensorSample[]>> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) return { supported: true, error: "FortiAP has no serial number recorded" };

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  if (!deviceName && integration.type === "fortigate") {
    deviceName = String((integration.config as Record<string, unknown>).host || "");
  }
  if (!deviceName) return { supported: true, error: "FortiAP has no controller FortiGate recorded" };

  try {
    const { inventory } = await fetchFortinetControllerInventory(integration, deviceName, "aps", timeoutMs);
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) return { supported: true, error: `FortiAP not present in ${deviceName}'s managed-AP table` };
    const sensors = entry.apTelemetry?.sensorTemperatures;
    if (!sensors || sensors.length === 0) {
      // No sensor fields on the row — FortiAP model that doesn't publish
      // temperatures (older indoor models). Return an empty data array so
      // the System tab shows "no sensors" rather than an error.
      return { supported: true, data: [] };
    }
    // The controller cache only exposes temperature sensors for FortiAPs.
    return {
      supported: true,
      data: sensors.map((s) => ({
        sensorName:  s.name,
        sensorClass: "temperature",
        value:       s.celsius,
        unit:        "°C",
        alarmStatus: null,
      })),
    };
  } catch (err: any) {
    return { supported: true, error: err?.message || "FortiAP controller query failed" };
  }
}

/**
 * The asset shape the three telemetry-cadence collectors need, as ONE load.
 *
 * They ran a `findUnique` each — same row, three times, two of them
 * concurrently (runTelemetryFor's Promise.all) — and Asset is the widest
 * table in the schema at ~170 columns including six JSON blobs
 * (fortinetTopology, virtualization, managementAccess, quarantineTargets,
 * associatedUsers, descriptionSync), none of which a collector reads. The
 * include is the UNION of what the three needed, so a standalone caller
 * trades one or two extra credential joins for the same asset payload, and
 * the cadence pass drops from three wide reads to one.
 */
const TELEMETRY_ASSET_INCLUDE = {
  monitorCredential:       true,
  cpuMemoryCredential:     true,
  temperatureCredential:   true,
  customWidgetCredential:  true,
  discoveredByIntegration: true,
} as const;

export function loadTelemetryAsset(assetId: string) {
  return prisma.asset.findUnique({ where: { id: assetId }, omit: PROBE_ASSET_OMIT, include: TELEMETRY_ASSET_INCLUDE });
}

/** One row of TELEMETRY_ASSET_INCLUDE — what the collectors accept preloaded. */
export type TelemetryAssetRow = Awaited<ReturnType<typeof loadTelemetryAsset>>;

export async function collectTelemetry(assetId: string, preloaded?: TelemetryAssetRow): Promise<CollectionResult<TelemetrySample>> {
  const asset = preloaded !== undefined ? preloaded : await loadTelemetryAsset(assetId);
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  // Resolve the per-stream polling method. Source-default fallback gives us
  // a value (rest_api on Fortinet, null on AD/Entra/Win/Manual since the
  // telemetry stream isn't delivered there by default).
  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  // CPU/memory dispatch. Hardware sensors are collected separately by
  // `collectHardwareSensors` so operators can run CPU/memory over REST while
  // the hardware-sensor scrape uses SNMP (branch-class FortiGate workaround
  // when /api/v2/monitor/system/sensor-info is unreliable). The two streams
  // share the telemetry cadence today; an independent temperatureIntervalSeconds
  // timer can land in a follow-up.
  const polling = effective.cpuMemoryPolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes telemetry via
  // POST /api/v1/agents/samples on its own schedule. Periodic puller stays
  // out of the way — `recordTelemetryResult` already no-ops on supported=false.
  if (polling === "agent") return { supported: false };
  const telemetryTimeout = effective.cpuMemoryTimeoutMs;

  // vCenter quickStats need no asset IP (the vCenter server is the target),
  // so this dispatches BEFORE the IP guard below. The collector resolves the
  // integration via the asset's vcenter-vm AssetSource row.
  if (polling === "vcenter") {
    return await collectTelemetryVcenter(assetId);
  }
  if (isWorkloadPollingMethod(polling)) {
    return await collectTelemetryWorkload(assetId);
  }
  if (polling === "genericapi") {
    return await collectTelemetryGenericApi(assetId);
  }

  // FQDN fallback for credentialed methods that resolve hostnames natively.
  const targetIp =
    dial(asset) ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = isFortinetIntegrationType(integration?.type);

  try {
    if (polling === "rest_api") {
      // Telemetry over REST API is FortiOS-specific. Manual REST API
      // credentials don't yet have a telemetry shape — `{ supported: false }`
      // until that lands.
      if (!isFortinetSrc || !integration) return { supported: false };
      // Managed FortiSwitches aren't directly REST-able — they don't speak
      // FortiOS REST and the integration's API token isn't valid against
      // them. The probe path redirects to the parent FortiGate's
      // controller-status table, but there's no controller-side endpoint
      // that exposes CPU / memory for a managed switch. Operators who want
      // switch telemetry flip to SNMP. **Managed FortiAPs are different**:
      // /api/v2/monitor/wifi/managed_ap returns cpu_usage + mem_free +
      // mem_total + sensors_temperatures per AP, so the controller-cache
      // doubles as a telemetry source. See collectTelemetryFortiapRest.
      if (asset.assetType === "switch") return { supported: false };
      if (asset.assetType === "access_point") {
        return await collectTelemetryFortiapRest(asset, integration as any, telemetryTimeout);
      }
      // Per-gate token, when the operator selected one on this stream. The
      // FortiAP branch above deliberately gets none: that read goes to the
      // PARENT gate controller table, so it authenticates as the parent.
      const data = await collectTelemetryFortinet(
        targetIp,
        integration as any,
        telemetryTimeout,
        pickRestApiCredential(asset.cpuMemoryCredential, asset.monitorCredential),
      );
      return { supported: true, data };
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback. CPU/memory reads from
      // cpuMemoryCredential — hardware sensors have their own credential resolved
      // inside `collectHardwareSensors` so the two streams can authenticate
      // independently when an operator points each at a different community.
      const effectiveTelemetryCred = asset.cpuMemoryCredential ?? asset.monitorCredential;
      const resolvedTelemetryCfg = await resolveSnmpConfigForStream(effectiveTelemetryCred, effective.cpuMemoryCredentialId, isFortinetSrc, integration);
      if (resolvedTelemetryCfg.error !== undefined) {
        return { supported: true, error: resolvedTelemetryCfg.error };
      }
      const snmpCfg = resolvedTelemetryCfg.cfg;
      const data = await collectTelemetrySnmp(
        targetIp,
        snmpCfg,
        asset.manufacturer,
        asset.model,
        asset.os,
        telemetryTimeout,
        effective.cpuMemoryMibId,
        asset.assetType,
      );
      return { supported: true, data };
    }
    // Agentless CPU/memory over SSH (Linux /proc) or WinRM (CIM). These
    // silently returned {supported:false} until 2026-08-28 — accepted at every
    // validator, recorded as a healthy tick, collecting nothing.
    if (polling === "ssh" || polling === "winrm") {
      const cred = await resolveAgentlessCredConfig(
        asset.cpuMemoryCredential ?? asset.monitorCredential,
        effective.cpuMemoryCredentialId,
        polling,
        adBindFallbackIntegration(asset, integration),
      );
      if (!cred) return { supported: true, error: `No ${polling === "ssh" ? "SSH" : "WinRM"} credential selected` };
      const res = polling === "ssh"
        ? await collectHostSsh(targetIp, cred, { telemetry: true, interfaces: false, storage: false, timeoutMs: telemetryTimeout })
        : await collectHostWinrm(winrmConnFrom(targetIp, cred, telemetryTimeout), { telemetry: true, interfaces: false, storage: false, timeoutMs: telemetryTimeout });
      if (!res.telemetry) return { supported: true, error: "Host returned no CPU/memory reading" };
      return { supported: true, data: res.telemetry };
    }
    // icmp carries no payload.
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Telemetry collection failed" };
  }
}

/**
 * Temperature scrape for one asset. Dispatches on `temperaturePolling` —
 * deliberately separate from `cpuMemoryPolling` so an operator can run
 * CPU/memory over REST while temperature scrapes over SNMP (the common
 * branch-class FortiGate workaround when /api/v2/monitor/system/sensor-info
 * is unreliable on the platform's FortiOS build). Uses the temperature-
 * specific credential / MIB / timeout returned by the four-tier resolver.
 *
 * Cadence note: today temperature shares the telemetry cadence trigger
 * (cpuMemoryIntervalSeconds drives when `runTelemetryFor` fires both
 * streams). An independent temperatureIntervalSeconds timer is a future
 * follow-up — see `temperatureIntervalSec` on the schema.
 */
export async function collectHardwareSensors(assetId: string, preloaded?: TelemetryAssetRow): Promise<CollectionResult<HardwareSensorSample[]>> {
  const asset = preloaded !== undefined ? preloaded : await loadTelemetryAsset(assetId);
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const polling = effective.temperaturePolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes temperature samples
  // alongside its telemetry stream via POST /api/v1/agents/samples on its
  // own schedule. Periodic puller stays out of the way.
  if (polling === "agent") return { supported: false };
  const timeoutMs = effective.temperatureTimeoutMs;
  // Unraid / TrueNAS: the host's disk temperatures, from the cached snapshot.
  if (isWorkloadPollingMethod(polling)) {
    return await collectHardwareSensorsWorkload(assetId);
  }
  if (polling === "genericapi") {
    return await collectHardwareSensorsGenericApi(assetId);
  }

  const targetIp =
    dial(asset) ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration         = asset.discoveredByIntegration ?? null;
  const isFortinetSrc       = isFortinetIntegrationType(integration?.type);

  try {
    if (polling === "rest_api") {
      // Temperature over REST API is FortiOS-specific (sensor-info endpoint).
      // Managed FortiSwitches aren't directly REST-able. Managed FortiAPs
      // expose temperatures via /api/v2/monitor/wifi/managed_ap → handled
      // by collectTemperaturesFortiapRest (controller cache).
      if (!isFortinetSrc || !integration) return { supported: false };
      if (asset.assetType === "switch")   return { supported: false };
      if (asset.assetType === "access_point") {
        return await collectHardwareSensorsFortiapRest(asset, integration as any, timeoutMs);
      }
      const fg = buildFortinetConfig(
        targetIp,
        integration as any,
        pickRestApiCredential(asset.temperatureCredential, asset.monitorCredential),
      );
      if ("error" in fg) throw new AppError(409, fg.error);
      const data = await collectHardwareSensorsFortinet(fg, timeoutMs);
      return { supported: true, data };
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback. Same priority chain
      // as cpuMemoryCredential but resolved against the temperature-stream
      // columns so the two streams can authenticate independently.
      const effectiveTempCred = asset.temperatureCredential ?? asset.monitorCredential;
      const resolvedTempCfg = await resolveSnmpConfigForStream(effectiveTempCred, effective.temperatureCredentialId, isFortinetSrc, integration);
      if (resolvedTempCfg.error !== undefined) {
        return { supported: true, error: resolvedTempCfg.error };
      }
      const snmpCfg = resolvedTempCfg.cfg;
      const data = await collectHardwareSensorsViaSnmpSession(
        targetIp,
        snmpCfg,
        asset.manufacturer,
        asset.model,
        asset.os,
        timeoutMs,
        effective.temperatureMibId,
        asset.assetType,
      );
      return { supported: true, data };
    }
    // winrm / ssh / icmp don't deliver hardware-sensor data.
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Hardware sensor collection failed" };
  }
}

/**
 * Open an SNMP session and run the collectHardwareSensorsSnmp walk inside it.
 * Shares collectTelemetrySnmp's MIB-pin handling (`profileSubjectFor`), so
 * pinning an uploaded MIB on the temperature stream feeds the right
 * manufacturer / module name / model into `pickDbProfile`.
 */
async function collectHardwareSensorsViaSnmpSession(
  host: string,
  config: Record<string, unknown>,
  manufacturer?: string | null,
  model?: string | null,
  os?: string | null,
  timeoutMs?: number,
  temperatureMibId?: string | null,
  assetType?: string | null,
): Promise<HardwareSensorSample[]> {
  await ensureRegistryLoaded();
  const profile = pickDbProfile(
    await profileSubjectFor({ manufacturer, model, os, assetType, pinnedMibId: temperatureMibId }),
  );
  // The asset's own scope, then the governing profile's (business rule 131).
  const scope: ResolveScope = { manufacturer, model, profileManufacturer: profile?.profileManufacturer };
  return await withSnmpSession(host, config, async (session) => {
    return await collectHardwareSensorsSnmp(session, profile, scope);
  }, timeoutMs);
}

/**
 * Light variant of collectSystemInfo that only returns the interfaces, storage
 * mountpoints, and IPsec tunnels the operator pinned for fast-cadence polling
 * (Asset.monitoredInterfaces / monitoredStorage / monitoredIpsecTunnels). The
 * underlying fetch still walks the full set on each protocol (one SNMP session
 * or one FortiOS round-trip), but the filter keeps us from writing noisy rows
 * for everything else once per minute. IPsec is only fetched from FortiOS when
 * tunnels are pinned — the endpoint can be slow on busy gateways and we don't
 * want to hammer it from the fast cadence unless asked.
 */
export async function collectFastFiltered(assetId: string): Promise<CollectionResult<SystemInfoSample>> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    omit: PROBE_ASSET_OMIT,
    include: { monitorCredential: true, interfacesCredential: true, discoveredByIntegration: true },
  });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };
  const wantedIfaces  = (asset.monitoredInterfaces   || []) as string[];
  const wantedStorage = (asset.monitoredStorage      || []) as string[];
  const wantedTunnels = (asset.monitoredIpsecTunnels || []) as string[];
  if (wantedIfaces.length === 0 && wantedStorage.length === 0 && wantedTunnels.length === 0) {
    return { supported: false };
  }

  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const polling = effective.interfacesPolling;
  if (!polling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes interface/storage/tunnel
  // samples on its own schedule via POST /api/v1/agents/samples.
  if (polling === "agent") return { supported: false };
  const sysInfoTimeout = effective.systemInfoTimeoutMs;

  // vCenter: the pinned subset is filtered out of the same warm-cache reading
  // the full pass uses, so the fast cadence costs a Map lookup and gives pinned
  // vNICs / guest mounts per-minute resolution. No asset IP needed.
  if (polling === "vcenter") {
    const vcReading = await readVcenterAsset(assetId);
    if (vcReading.kind === "absent" || vcReading.kind === "unreachable") {
      return { supported: true, error: vcReading.error };
    }
    const vcFull = buildVcenterSystemInfo(vcReading);
    const wantIfVc = new Set(wantedIfaces);
    const wantStVc = new Set(wantedStorage);
    return {
      supported: true,
      data: {
        interfaces: wantedIfaces.length ? vcFull.interfaces.filter((i) => wantIfVc.has(i.ifName)) : [],
        storage: (wantedStorage.length && effective.storagePolling === "vcenter")
          ? vcFull.storage.filter((s) => wantStVc.has(s.mountPath))
          : [],
      },
    };
  }

  // Unraid / TrueNAS: the pinned subset of the same cached snapshot.
  if (isWorkloadPollingMethod(polling)) {
    return await collectSystemInfoWorkload(assetId, effective, { interfaces: wantedIfaces, storage: wantedStorage });
  }
  if (polling === "genericapi" || effective.storagePolling === "genericapi") {
    return await collectSystemInfoGenericApi(assetId, effective, { interfaces: wantedIfaces, storage: wantedStorage });
  }

  const targetIp =
    dial(asset) ||
    ((polling === "winrm" || polling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = isFortinetIntegrationType(integration?.type);
  const isManagedSwitchOrAp = asset.assetType === "switch" || asset.assetType === "access_point";

  try {
    let full: SystemInfoSample;
    if (polling === "rest_api") {
      if (!isFortinetSrc || !integration) return { supported: false };
      // Managed FortiSwitches / FortiAPs aren't directly REST-able; the
      // parent FortiGate's controller-status table doesn't expose per-port
      // counters or storage. Operators flip the integration's
      // FortiSwitches / FortiAPs subtab to direct SNMP polling to enable
      // this stream. Same guard as collectTelemetry.
      if (isManagedSwitchOrAp) return { supported: false };
      // Only ask FortiOS for IPsec when a tunnel is actually pinned —
      // /api/v2/monitor/vpn/ipsec is the slow endpoint we want to avoid on
      // the fast cadence. Fast cadence always skips LLDP — neighbors don't
      // change between full system-info passes often enough to merit
      // re-walking the table once a minute.
      full = await collectSystemInfoFortinet(targetIp, integration as any, {
        includeIpsec: wantedTunnels.length > 0,
        includeLldp:  false,
        timeoutMs:    sysInfoTimeout,
      }, pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential));
    } else if (polling === "snmp") {
      const effectiveIfacesCred = asset.interfacesCredential ?? asset.monitorCredential;
      const resolvedIfCfg = await resolveSnmpConfigForStream(effectiveIfacesCred, effective.interfacesCredentialId, isFortinetSrc, integration);
      if (resolvedIfCfg.error !== undefined) {
        return { supported: true, error: resolvedIfCfg.error };
      }
      const snmpCfg = resolvedIfCfg.cfg;
      // Wire-level filtered scrape: pulls only the columns/rows we actually
      // need (pinned ifNames + pinned mountPaths) instead of walking the full
      // IF-MIB / hrStorage subtrees. On a 48-port switch with one pinned
      // interface this is ~13 OIDs in one PDU vs. ~770 OID-fetches across 16
      // column walks under the legacy path — drops fast-cadence p90 from
      // multi-second to sub-second on busy fleets. See `collectFastFilteredSnmp`
      // for the three-phase rationale (discovery walks → multi-GET → assembly).
      full = await collectFastFilteredSnmp(targetIp, snmpCfg, {
        wantedIfaces:  wantedIfaces,
        wantedStorage: wantedStorage,
        timeoutMs:     sysInfoTimeout,
      });
      // Fortinet-discovered firewalls running SNMP still benefit from the
      // integration's interface filter (CMDB blocklist) and from the FortiOS
      // IPsec overlay — the two endpoints are independent of the SNMP path.
      // The CMDB filter is a no-op when the SNMP scrape already filtered to
      // the operator-pinned set (operators don't pin interfaces they've also
      // filtered out), but we keep the call to preserve the same defense-in-
      // depth behavior as the heavy cadence.
      if (isFortinetSrc && integration) {
        applyFortiInterfaceFilter(full.interfaces, integration as any);
        // Skip managed FortiSwitches / FortiAPs — not directly REST-able, no IPsec.
        // See the matching guard + rationale in collectSystemInfo.
        if (!isManagedSwitchOrAp && wantedTunnels.length > 0) {
          const ipsec = await collectIpsecOnlyFortinetSafe(targetIp, integration as any, sysInfoTimeout, pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential));
          // Tunnels only: the connection rows are the full pass's to write.
          if (ipsec !== undefined) full.ipsecTunnels = ipsec.tunnels;
        }
      }
    } else {
      // winrm / ssh / icmp don't yet deliver interfaces / storage. Same
      // story as collectTelemetry.
      return { supported: false };
    }
    const wantIf = new Set(wantedIfaces);
    const wantSt = new Set(wantedStorage);
    const wantTn = new Set(wantedTunnels);
    const interfaces = wantedIfaces.length  ? full.interfaces.filter((i) => wantIf.has(i.ifName)) : [];
    // Storage is its own stream — drop pinned-storage scrapes when the resolved
    // storagePolling isn't SNMP. Same independence rule as the full systemInfo
    // pass above.
    const storage    = (wantedStorage.length && effective.storagePolling === "snmp")
      ? full.storage.filter((s) => wantSt.has(s.mountPath))
      : [];
    const ipsecTunnels = (wantedTunnels.length && Array.isArray(full.ipsecTunnels))
      ? full.ipsecTunnels.filter((t) => wantTn.has(t.tunnelName))
      : undefined;
    return { supported: true, data: { interfaces, storage, ipsecTunnels } };
  } catch (err: any) {
    return { supported: true, error: err?.message || "Fast-cadence scrape failed" };
  }
}

/**
 * Persist a fast-cadence scrape. Mirrors recordSystemInfoResult for the three
 * sample tables, but does NOT touch Asset.associatedIps (that is owned by the
 * full system-info pass) and does NOT advance lastSystemInfoAt — the fast pass
 * is supplementary and the next full scrape is still gated on its own cadence.
 */
export async function recordFastFilteredResult(assetId: string, result: CollectionResult<SystemInfoSample>): Promise<void> {
  if (!result.supported || !result.data) return;
  const d = result.data;
  const now = new Date();
  // Same reconciliation as the full pass, and this is the path that actually
  // produced the bad alert: the fast pass resolves PINNED names against the
  // device, so a pin left behind by a description-named scrape keeps drawing
  // samples under that description — which then becomes the alert's dimension
  // ("Interface PoE status on MORGAN-221E-1 is fault"). It does NOT repair
  // pins: this pass never writes the inventory it would have to reconcile
  // against (see interfaceInventoryService's single-writer note).
  if (d.interfaces.length > 0) {
    const identity = await loadInterfaceIdentity(assetId);
    const canon = canonicalizeInterfaceRows(d.interfaces, identity);
    if (canon.renamed.length > 0 || canon.dropped > 0) {
      logger.warn(
        { assetId, ports: canon.renamed.slice(0, 5).map((r) => r.to), renamedCount: canon.renamed.length, dropped: canon.dropped },
        "fast interface scrape named ports by their description — mapped back to the port name",
      );
      d.interfaces = canon.rows;
    }
  }
  if (d.interfaces.length > 0) {
    const ifaceRows: InterfaceSampleRow[] = d.interfaces.map((i) => ({
      assetId,
      timestamp: now,
      cadence:     "fast" as const,
      ifName:      i.ifName,
      adminStatus: i.adminStatus ?? null,
      operStatus:  i.operStatus ?? null,
      speedBps:    i.speedBps != null ? BigInt(Math.round(i.speedBps)) : null,
      duplex:      i.duplex ?? null,
      // ipAddress + ipv6Address, normalised (business rule 126).
      ...splitInterfaceAddresses(i.ipAddress, i.ipv6Address, ipv6Enabled()),
      macAddress:  i.macAddress ?? null,
      inOctets:    i.inOctets  != null ? BigInt(Math.round(i.inOctets))  : null,
      outOctets:   i.outOctets != null ? BigInt(Math.round(i.outOctets)) : null,
      inErrors:    i.inErrors  != null ? BigInt(Math.round(i.inErrors))  : null,
      outErrors:   i.outErrors != null ? BigInt(Math.round(i.outErrors)) : null,
      ifType:      null,
      ifParent:    null,
      vlanId:      null,
      nativeVlan:  i.nativeVlan ?? null,
      taggedVlans: i.taggedVlans ?? [],
      trunksAllVlans: i.trunksAllVlans === true,
      alias:       i.alias       ?? null,
      description: i.description ?? null,
      addressingMode: null,
      // Passed through, NOT nulled: the fast SNMP path collects PoE so a
      // port fault is alertable on the per-minute cadence rather than
      // waiting for the next heavy scrape.
      poeStatus:   i.poeStatus ?? null,
      poeClass:    i.poeClass  ?? null,
    }));
    enqueueInterfaceSamples(ifaceRows);
    void recordInterfaceLinkEvents(ifaceRows);
  }
  if (d.storage.length > 0) {
    enqueueStorageSamples(
      d.storage.map((s) => ({
        assetId,
        timestamp: now,
        cadence:    "fast" as const,
        mountPath:  s.mountPath,
        totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
        usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
      })),
    );
  }
  if (Array.isArray(d.ipsecTunnels) && d.ipsecTunnels.length > 0) {
    enqueueIpsecTunnelSamples(
      d.ipsecTunnels.map((t) => ({
        assetId,
        timestamp: now,
        cadence:         "fast" as const,
        tunnelName:      t.tunnelName,
        parentInterface: t.parentInterface,
        remoteGateway:   t.remoteGateway,
        status:          t.status,
        incomingBytes:   t.incomingBytes != null ? BigInt(Math.round(t.incomingBytes)) : null,
        outgoingBytes:   t.outgoingBytes != null ? BigInt(Math.round(t.outgoingBytes)) : null,
        proxyIdCount:    t.proxyIdCount,
      })),
    );
  }
}

// ─── collectSystemInfo overlay helpers (split 2026-08 — the dispatch gates
// are pinned in tests/integration/collectSystemInfoGates.test.ts; each
// overlay below is a best-effort enrichment of the in-memory SystemInfoSample
// and never fails the scrape).

/**
 * Resolve the parent-FortiGate controller name for a managed FortiSwitch /
 * FortiAP: the fortinetTopology.controllerFortigate stamp discovery wrote,
 * falling back to the standalone-FortiGate integration's host. "" = unknown.
 */
function fortinetControllerNameOf(
  asset: { fortinetTopology: unknown },
  integration: { type: string; config: unknown },
): string {
  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  const stamped = typeof topology.controllerFortigate === "string"
    ? topology.controllerFortigate.trim()
    : "";
  if (stamped) return stamped;
  if (integration.type === "fortigate") {
    return String((integration.config as Record<string, unknown>).host || "");
  }
  return "";
}

/**
 * FortiSwitch port-VLAN + trunk-member overlay (SNMP interfaces path). SNMP
 * IF-MIB gives us per-port counters but neither VLAN membership nor the
 * trunk→physical-member mapping; the parent FortiGate's switch-controller
 * CMDB carries both. One cached call per controller per 30s, keyed by
 * serial, joined onto the in-memory InterfaceSample list by port-name ==
 * ifName. Also stamps MCLAG ICL peers (definitive when the switch is in
 * CMDB; left undefined otherwise so stored rows survive — the LLDP
 * undefined-vs-[] convention). Best-effort: any failure leaves the VLAN
 * fields null on every row and the interface scrape proceeds.
 */
async function overlayFortiswitchCmdbOntoSnmp(
  asset: { assetType: string; serialNumber: string | null; fortinetTopology: unknown },
  integration: { type: string; config: unknown },
  data: SystemInfoSample,
  sysInfoTimeout: number,
): Promise<void> {
  if (asset.assetType !== "switch" || !asset.serialNumber) return;
  const controllerName = fortinetControllerNameOf(asset, integration);
  if (!controllerName) return;
  const endVlan = startPhase("systeminfo.snmp.fortiswitch_vlan_overlay");
  try {
    const portsMap = await fetchFortiswitchControllerPortsCmdb(
      integration as any,
      controllerName,
      sysInfoTimeout,
    );
    const portsForSwitch = portsMap.get(asset.serialNumber.toUpperCase());
    // When the switch is present in the controller CMDB we know its
    // MCLAG state definitively — stamp it (empty array = wipe stale
    // ICL rows) even if the VLAN map is empty. Leaving it undefined
    // when the switch isn't in CMDB preserves stored rows (no-wipe),
    // matching the LLDP undefined-vs-[] convention.
    if (portsForSwitch) {
      data.mclagPeers = portsForSwitch.mclagPeers;
    }
    if (portsForSwitch && portsForSwitch.vlanByPort.size > 0) {
      let overlaid = 0;
      for (const iface of data.interfaces) {
        // Port description comes from the same CMDB payload; SNMP
        // leaves description null on every switch-port row, so
        // this overlay is its only source.
        const desc = portsForSwitch.descriptionByPort.get(iface.ifName);
        if (desc && !iface.description) iface.description = desc;
        const cfg = portsForSwitch.vlanByPort.get(iface.ifName);
        if (!cfg) continue;
        // Config truth wins over the SNMP-derived values -- but only where it
        // actually says something. A port the controller lists with no native
        // VLAN and no allow-list must not blank out what dot1qPvid reported;
        // that is the difference between "the CMDB disagrees" and "the CMDB is
        // silent about this port".
        if (cfg.nativeVlan != null) iface.nativeVlan = cfg.nativeVlan;
        if (cfg.taggedVlans.length > 0 || cfg.trunksAllVlans) iface.taggedVlans = cfg.taggedVlans;
        iface.trunksAllVlans = cfg.trunksAllVlans;
        overlaid++;
      }
      const trunkOverlaid = overlayFortiswitchTrunkMembers(
        data.interfaces,
        portsForSwitch.trunkMembers,
      );
      endVlan({ overlaid, total: data.interfaces.length, trunkLinks: trunkOverlaid, mclagPeers: portsForSwitch.mclagPeers.length });
    } else {
      endVlan({ overlaid: 0, total: data.interfaces.length, reason: "switch_not_in_cmdb" });
    }
  } catch (err: any) {
    endVlan({ overlaid: 0, total: data.interfaces.length, error: err?.message || String(err) });
  }
}

/**
 * FortiAP wireless-station signal overlay (SNMP interfaces path).
 * fapStationTable (SNMP) gives us the connected clients + band, but
 * per-client RSSI lives only on the controller's /api/v2/monitor/wifi/client.
 * One cached call per controller, joined onto the in-memory station list by
 * normalized MAC. Best-effort: any failure leaves signal/noise null.
 */
async function overlayFortiapStationSignals(
  asset: { assetType: string; fortinetTopology: unknown },
  integration: { type: string; config: unknown },
  data: SystemInfoSample,
  sysInfoTimeout: number,
): Promise<void> {
  if (asset.assetType !== "access_point") return;
  if (!Array.isArray(data.wirelessStations) || data.wirelessStations.length === 0) return;
  const controllerName = fortinetControllerNameOf(asset, integration);
  if (!controllerName) return;
  const endSignal = startPhase("systeminfo.snmp.wifi_signal_overlay_rest");
  try {
    const signals = await fetchFortinetWifiClients(integration as any, controllerName, sysInfoTimeout);
    let overlaid = 0;
    for (const st of data.wirelessStations) {
      const sig = signals.get(st.staMacAddr.toUpperCase());
      if (!sig) continue;
      st.signalStrength = sig.signalStrength;
      st.noise          = sig.noise;
      overlaid++;
    }
    endSignal({ overlaid, total: data.wirelessStations.length });
  } catch (err: any) {
    endSignal({ overlaid: 0, total: data.wirelessStations.length, error: err?.message || String(err) });
  }
}

/**
 * Cross-transport LLDP overlay: when the chosen LLDP source differs from the
 * interfaces transport the collection above already used, fetch the neighbor
 * list over LLDP's own transport and stamp it (with its source) onto the
 * sample. No-op when the transports agree or the overlay isn't applicable.
 */
async function overlayCrossTransportLldp(
  data: SystemInfoSample,
  opts: {
    targetIp: string;
    integration: { type: string; config: unknown } | null;
    interfacesPolling: string;
    lldpPolling: string | null;
    lldpSnmpCfg: Record<string, unknown> | null;
    isFortinetSrc: boolean;
    isManagedSwitchOrAp: boolean;
    sysInfoTimeout: number;
    /** The LLDP stream own per-gate REST token, when one is selected. */
    restCredential?: CredentialLike | null;
  },
): Promise<void> {
  const { targetIp, integration, interfacesPolling, lldpPolling, lldpSnmpCfg, isFortinetSrc, isManagedSwitchOrAp, sysInfoTimeout } = opts;
  if (lldpPolling === "snmp" && interfacesPolling === "rest_api" && lldpSnmpCfg) {
    const endOverlay = startPhase("systeminfo.lldp_overlay_snmp");
    const neighbors = await collectLldpOnlySnmp(targetIp, lldpSnmpCfg, sysInfoTimeout).catch(() => undefined);
    endOverlay({ neighbors: neighbors?.length ?? null });
    if (neighbors !== undefined) {
      data.lldpNeighbors = neighbors;
      data.lldpSource    = "snmp";
    }
  } else if (lldpPolling === "rest_api" && interfacesPolling === "snmp" && isFortinetSrc && integration && !isManagedSwitchOrAp) {
    const endOverlay = startPhase("systeminfo.lldp_overlay_rest");
    const neighbors = await collectLldpOnlyFortinet(targetIp, integration as any, sysInfoTimeout, opts.restCredential).catch(() => undefined);
    endOverlay({ neighbors: neighbors?.length ?? null });
    if (neighbors !== undefined) {
      data.lldpNeighbors = neighbors;
      data.lldpSource    = "fortios";
    }
  }
}

/**
 * FortiLink LLDP exclusion (opt-in per integration, default off). Drop LLDP
 * neighbors learned on FortiLink-enabled interfaces — the fortilink aggregate
 * + its member ports — so internal FortiGate↔FortiSwitch links don't clutter
 * the Neighbor column. Authoritative source is the CMDB `fortilink` flag.
 * FortiGate firewalls only (the CMDB query targets the polled device; managed
 * switches/APs carry no FortiGate CMDB here). The REST-interfaces path
 * already fetched CMDB (data.fortilinkInterfaces is set, possibly []); the
 * SNMP-interfaces path didn't, so we make one gated CMDB call. Peer-inferred
 * FortiLink rows are unaffected — they're synthesized from topology, not LLDP.
 */
async function applyFortilinkLldpExclusion(
  data: SystemInfoSample,
  opts: {
    targetIp: string;
    integration: { type: string; config: unknown } | null;
    isFortinetSrc: boolean;
    isManagedSwitchOrAp: boolean;
    sysInfoTimeout: number;
    /** The interfaces stream own per-gate REST token, when one is selected. */
    restCredential?: CredentialLike | null;
  },
): Promise<void> {
  const { targetIp, integration, isFortinetSrc, isManagedSwitchOrAp, sysInfoTimeout } = opts;
  if (
    !isFortinetSrc || !integration || isManagedSwitchOrAp ||
    ((integration as any).config as any)?.excludeFortilinkLldp !== true ||
    !Array.isArray(data.lldpNeighbors) || data.lldpNeighbors.length === 0
  ) {
    return;
  }
  const endFl = startPhase("systeminfo.lldp_fortilink_exclude");
  let fortilinkSet: Set<string> | null =
    data.fortilinkInterfaces !== undefined ? new Set(data.fortilinkInterfaces) : null;
  if (fortilinkSet === null) {
    const fg = buildFortinetConfig(targetIp, integration as any, opts.restCredential);
    fortilinkSet = "error" in fg ? new Set() : await fetchFortilinkInterfaceSet(fg, sysInfoTimeout).catch(() => new Set<string>());
  }
  const before = data.lldpNeighbors.length;
  if (fortilinkSet.size > 0) {
    data.lldpNeighbors = data.lldpNeighbors.filter((n) => !fortilinkSet!.has(n.localIfName));
  }
  endFl({ excluded: before - data.lldpNeighbors.length, fortilinkIfs: fortilinkSet.size });
}

export async function collectSystemInfo(assetId: string): Promise<CollectionResult<SystemInfoSample>> {
  const endLoad = startPhase("systeminfo.load_asset");
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    omit: PROBE_ASSET_OMIT,
    include: { monitorCredential: true, interfacesCredential: true, lldpCredential: true, discoveredByIntegration: true },
  });
  endLoad({ found: !!asset });
  if (!asset)            return { supported: false, error: "Asset not found" };
  if (!asset.monitored)  return { supported: false };

  const endResolve = startPhase("systeminfo.resolve_settings");
  const effective = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  endResolve();
  const interfacesPolling = effective.interfacesPolling;
  const lldpPolling       = effective.lldpPolling;
  // No interfaces stream → no system-info to collect. LLDP-only without an
  // interfaces context isn't meaningful (we'd have nothing to attach the
  // neighbors to in the System tab table).
  if (!interfacesPolling) return { supported: false };
  // Agent-mode: the Polaris Agent on the host pushes interface + storage +
  // LLDP samples on its own schedule. Periodic puller stays out of the way.
  if (interfacesPolling === "agent") return { supported: false };
  const sysInfoTimeout = effective.systemInfoTimeoutMs;

  // vCenter serves interfaces + storage out of the per-integration warm cache
  // and needs no asset IP — same reason the probe dispatches early. Dispatches
  // when EITHER stream is on the method: one reading answers both, so an
  // operator who routes interfaces elsewhere (or off) and leaves storage on
  // vCenter still gets their mounts, and the branch gates each stream on its
  // own resolved method.
  if (interfacesPolling === "vcenter" || effective.storagePolling === "vcenter") {
    return await collectSystemInfoVcenter(assetId, effective);
  }
  if (isWorkloadPollingMethod(interfacesPolling) || isWorkloadPollingMethod(effective.storagePolling)) {
    return await collectSystemInfoWorkload(assetId, effective);
  }
  // Generic API: each of interfaces / storage / LLDP from its own monitor
  // query, for whichever of them resolves to the method (rule 100(i)).
  if (interfacesPolling === "genericapi" || effective.storagePolling === "genericapi" || lldpPolling === "genericapi") {
    return await collectSystemInfoGenericApi(assetId, effective);
  }

  const targetIp =
    dial(asset) ||
    ((interfacesPolling === "winrm" || interfacesPolling === "ssh") ? (asset.dnsName || asset.hostname) : null);
  if (!targetIp) return { supported: false, error: "Asset has no IP address" };

  const integration   = asset.discoveredByIntegration ?? null;
  const isFortinetSrc = isFortinetIntegrationType(integration?.type);
  const isManagedSwitchOrAp = asset.assetType === "switch" || asset.assetType === "access_point";

  try {
    if (interfacesPolling === "rest_api" || interfacesPolling === "snmp") {
      // Mixed-transport branch: interfaces and LLDP can independently be
      // REST or SNMP. Per-stream credential wins, then asset default, then
      // integration fallback. Pre-load credentials for whichever streams need SNMP.
      const effectiveIfacesCred = asset.interfacesCredential ?? asset.monitorCredential;
      const effectiveLldpCred   = asset.lldpCredential        ?? asset.monitorCredential;
      let snmpCfg: Record<string, unknown> | null = null;     // for the shared session (interfaces SNMP path)
      let lldpSnmpCfg: Record<string, unknown> | null = null; // for LLDP-only cross-transport overlay
      if (interfacesPolling === "snmp") {
        const resolvedIf = await resolveSnmpConfigForStream(effectiveIfacesCred, effective.interfacesCredentialId, isFortinetSrc, integration);
        if (resolvedIf.error !== undefined) {
          return { supported: true, error: resolvedIf.error };
        }
        snmpCfg = resolvedIf.cfg;
      }
      if (lldpPolling === "snmp") {
        if (interfacesPolling === "snmp") {
          // Same SNMP session covers LLDP; lldpSnmpCfg stays null (snmpCfg is used).
        } else {
          // Cross-transport: LLDP needs its own session with the LLDP credential.
          const resolvedLldp = await resolveSnmpConfigForStream(effectiveLldpCred, effective.lldpCredentialId, isFortinetSrc, integration, "No SNMP credential selected for LLDP stream");
          if (resolvedLldp.error !== undefined) {
            return { supported: true, error: resolvedLldp.error };
          }
          lldpSnmpCfg = resolvedLldp.cfg;
        }
      }
      // REST API for interfaces requires a Fortinet integration.
      if (interfacesPolling === "rest_api" && (!isFortinetSrc || !integration)) {
        return { supported: false };
      }
      // Managed FortiSwitches / FortiAPs aren't directly REST-able. Same
      // guard as collectTelemetry / collectFastFiltered — operators flip the
      // integration's FortiSwitches / FortiAPs subtab to direct SNMP polling
      // (which sets interfacesPolling to "snmp" via the integration tier or
      // a class override) to enable this stream on those asset types.
      if (interfacesPolling === "rest_api" && isManagedSwitchOrAp) {
        return { supported: false };
      }

      let data: SystemInfoSample;
      if (interfacesPolling === "snmp") {
        // SNMP-path interfaces+storage. Fetch LLDP via the same session iff
        // the LLDP polling agrees; otherwise leave it out and overlay below.
        const endSnmp = startPhase("systeminfo.snmp.session");
        data = await collectSystemInfoSnmp(targetIp, snmpCfg!, {
          includeLldp:  lldpPolling === "snmp",
          timeoutMs:    sysInfoTimeout,
          manufacturer: asset.manufacturer,
          model:        asset.model,
          os:           asset.os,
          assetType:    asset.assetType,
        });
        endSnmp({ interfaces: data.interfaces.length, storage: data.storage.length, lldp: data.lldpNeighbors?.length ?? null });
        if (isFortinetSrc && integration) {
          applyFortiInterfaceFilter(data.interfaces, integration as any);
          // IPsec always via REST when the source is Fortinet — SNMP has no equivalent.
          // BUT skip managed FortiSwitches / FortiAPs: they aren't directly REST-able
          // (their telemetry / system-info lives on the parent FortiGate) and they have
          // no IPsec. Without this guard the overlay fires a FortiOS REST call straight
          // at the switch/AP's own IP:443 every system-info pass — a standalone GUI
          // listener accepts the TCP/TLS handshake but never answers the API call,
          // leaving idle sockets and hammering the device's weak management CPU
          // (prod incident: FortiSwitch ICMP packet loss). Same !isManagedSwitchOrAp
          // guard the REST telemetry / system-info / fast-filtered paths already use.
          if (!isManagedSwitchOrAp) {
            const endIpsec = startPhase("systeminfo.snmp.ipsec_overlay_rest");
            const ipsec = await collectIpsecOnlyFortinetSafe(
              targetIp, integration as any, sysInfoTimeout,
              pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential),
              { includeSslVpn: asset.assetType === "firewall" },
            );
            endIpsec({ tunnels: ipsec?.tunnels.length ?? null, connections: ipsec?.connections?.length ?? null });
            if (ipsec !== undefined) {
              data.ipsecTunnels     = ipsec.tunnels;
              data.ipsecConnections = ipsec.connections;
              data.sslVpnSessions   = ipsec.sslVpnSessions;
            }
          }
          await overlayFortiswitchCmdbOntoSnmp(asset, integration, data, sysInfoTimeout);
          await overlayFortiapStationSignals(asset, integration, data, sysInfoTimeout);
        }
      } else {
        // FortiOS REST path. Skip the FortiOS LLDP call when LLDP is on SNMP.
        const endRest = startPhase("systeminfo.rest.fortinet");
        data = await collectSystemInfoFortinet(targetIp, integration as any, {
          includeIpsec: true,
          includeLldp:  lldpPolling === "rest_api",
          // SD-WAN is NOT collected here any more: it has its own cadence
          // (runSdwanFor, default 60s) so SLA readings no longer wait on the
          // interface scrape's 10-minute default.
          // Firewall-class only, matching where the SNMP branch gates it.
          includeArp:   asset.assetType === "firewall",
          // Remote-access users only exist on a gate.
          includeSslVpn: asset.assetType === "firewall",
          timeoutMs:    sysInfoTimeout,
        }, pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential));
        endRest({ interfaces: data.interfaces.length, ipsec: data.ipsecTunnels?.length ?? null, lldp: data.lldpNeighbors?.length ?? null });
      }

      await overlayCrossTransportLldp(data, {
        targetIp, integration, interfacesPolling, lldpPolling, lldpSnmpCfg,
        isFortinetSrc, isManagedSwitchOrAp, sysInfoTimeout,
        restCredential: pickRestApiCredential(asset.lldpCredential, asset.monitorCredential),
      });
      // Storage stream is independent of interfaces. Storage rows only come
      // from the SNMP path (HOST-RESOURCES-MIB + vendor disk fallback); when
      // the operator has storage routed anywhere but SNMP — including the
      // FMG/FortiGate source default of "disabled" — drop the rows the SNMP
      // walk produced as a side effect of the interfaces query.
      if (effective.storagePolling !== "snmp") {
        data.storage = [];
      }
      await applyFortilinkLldpExclusion(data, {
        targetIp, integration, isFortinetSrc, isManagedSwitchOrAp, sysInfoTimeout,
        restCredential: pickRestApiCredential(asset.interfacesCredential, asset.monitorCredential),
      });
      return { supported: true, data };
    }
    // Agentless interfaces + storage over SSH (sysfs / df) or WinRM
    // (Get-NetAdapter / Get-Volume). Both streams ride ONE connection, which is
    // the whole point at fleet scale — the handshake dominates, not the parse.
    // Storage is gated on its own resolved method, like every other path here.
    if (interfacesPolling === "ssh" || interfacesPolling === "winrm") {
      const method = interfacesPolling;
      const cred = await resolveAgentlessCredConfig(
        asset.interfacesCredential ?? asset.monitorCredential,
        effective.interfacesCredentialId,
        method,
        adBindFallbackIntegration(asset, integration),
      );
      if (!cred) return { supported: true, error: `No ${method === "ssh" ? "SSH" : "WinRM"} credential selected` };
      const wantStorage = effective.storagePolling === method;
      const opts = { telemetry: false, interfaces: true, storage: wantStorage, timeoutMs: sysInfoTimeout };
      const res = method === "ssh"
        ? await collectHostSsh(targetIp, cred, opts)
        : await collectHostWinrm(winrmConnFrom(targetIp, cred, sysInfoTimeout), opts);
      // `undefined` from a failed command means "leave stored rows alone";
      // only an empty ARRAY is a successful scrape that found nothing.
      return {
        supported: true,
        data: {
          interfaces: res.interfaces ?? [],
          storage: wantStorage ? (res.storage ?? []) : [],
        },
      };
    }
    // icmp — no payload to gather.
    return { supported: false };
  } catch (err: any) {
    return { supported: true, error: err?.message || "System info collection failed" };
  }
}
