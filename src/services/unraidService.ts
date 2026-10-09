/**
 * src/services/unraidService.ts
 *
 * Unraid integration — the host, its VMs and its Docker containers, read
 * through the GraphQL API built into Unraid 7.2+ (`/graphql`, an API key in the
 * `x-api-key` header; create one under Settings → Management Access → API Keys
 * with the VIEWER role, plus DOCKER:UPDATE_ANY and VMS:UPDATE_ANY — the
 * permissions the API's start / stop / restart / update resolvers check —
 * when the workload actions are wanted).
 *
 * One query answers the inventory and the host's live usage. Per-container
 * CPU / memory is the exception: Unraid publishes it only as the
 * `dockerContainerStats` SUBSCRIPTION (docker-stats shaped, one event per
 * running container per interval), so `fetchUnraidSnapshot` opens a
 * graphql-transport-ws socket, collects one reading per container for a short
 * window, and closes it. The snapshot is warm-cached per integration by the
 * caller, so that window is paid at most once per cache period.
 *
 * VMs: the API publishes identity and power state only — no vCPU / memory /
 * guest IP — so a VM gets up/down from here and its usage from an agent or a
 * guest transport, if any.
 *
 * Output is the shared WorkloadDiscoveryResult / WorkloadSnapshot shape
 * (services/discovery/workloadSync.ts); this file knows Unraid, nothing else.
 */

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { normalizeWorkloadState } from "../utils/workloadSources.js";
import type {
  WorkloadContainer,
  WorkloadDisk,
  WorkloadDiscoveryResult,
  WorkloadHost,
  WorkloadInterfaceReading,
  WorkloadPool,
  WorkloadPoolMember,
  WorkloadSnapshot,
  WorkloadUsage,
  WorkloadVm,
} from "./discovery/workloadSync.js";

export interface UnraidConfig {
  host: string;
  port?: number;
  /** HTTPS (default) or plain HTTP — Unraid serves both, depending on its "Use SSL/TLS" setting. */
  useTls?: boolean;
  verifyTls?: boolean;
  /** The Unraid API key (stored under the sealed `apiToken` config key). */
  apiToken: string;
  vmInclude?: string[];
  vmExclude?: string[];
  containerInclude?: string[];
  containerExclude?: string[];
  /** How long to collect dockerContainerStats events per snapshot (ms). */
  statsWindowMs?: number;
}

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_STATS_WINDOW_MS = 4_000;
const MAX_STATS_WINDOW_MS = 15_000;

function defaultPort(config: UnraidConfig): number {
  return config.port || (config.useTls === false ? 80 : 443);
}

// ─── Transport ───────────────────────────────────────────────────────────────

function translateNetworkError(err: any, config: UnraidConfig): AppError {
  const code = err?.code;
  const where = `${config.host}:${defaultPort(config)}`;
  if (code === "ECONNREFUSED") return new AppError(502, `Connection refused — ${where}`);
  if (code === "ENOTFOUND") return new AppError(502, `Host not found — ${config.host}`);
  if (code === "ETIMEDOUT") return new AppError(504, `Connection timed out — ${where}`);
  if (code === "EPROTO" || code === "ERR_SSL_WRONG_VERSION_NUMBER") {
    return new AppError(502, `TLS handshake failed — ${where} may be serving plain HTTP; try turning HTTPS off`);
  }
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID"
  ) {
    return new AppError(502, `TLS certificate error (${code}) — try disabling TLS verification`);
  }
  return new AppError(502, err?.message || "Unraid connection error");
}

/**
 * One GraphQL POST. Throws AppError on transport failure, a non-2xx answer, or
 * a response whose `data` is missing entirely; partial `errors` alongside data
 * are returned to the caller (a field the key's role may not read should not
 * fail the whole inventory).
 */
export async function unraidGraphql<T = any>(
  config: UnraidConfig,
  query: string,
  variables?: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ data: T; errors: Array<{ message: string; path?: unknown }> }> {
  const body = JSON.stringify({ query, variables: variables ?? {} });
  const useTls = config.useTls !== false;
  const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new AppError(499, "Aborted"));
    const reqFn = useTls ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        hostname: config.host,
        port: defaultPort(config),
        path: "/graphql",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
          "x-api-key": config.apiToken,
        },
        ...(useTls ? { rejectUnauthorized: config.verifyTls !== false } : {}),
        timeout: opts.timeoutMs ?? REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    const onAbort = () => { try { req.destroy(); } catch { /* noop */ } reject(new AppError(499, "Aborted")); };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => { try { req.destroy(); } catch { /* noop */ } reject(new AppError(504, "Unraid API request timed out")); });
    req.on("error", (err) => reject(translateNetworkError(err, config)));
    req.on("close", () => opts.signal?.removeEventListener("abort", onAbort));
    req.write(body);
    req.end();
  });
  if (raw.status === 401 || raw.status === 403) {
    throw new AppError(502, `Unraid rejected the API key (HTTP ${raw.status}) — check the key and its role`);
  }
  if (raw.status === 404) {
    throw new AppError(502, "No /graphql endpoint — the Unraid API needs Unraid 7.2 or later (or the Unraid Connect plugin)");
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw.body);
  } catch {
    throw new AppError(502, `Unraid answered HTTP ${raw.status} with a non-JSON body`);
  }
  const errors: Array<{ message: string; path?: unknown }> = Array.isArray(parsed?.errors) ? parsed.errors : [];
  if (!parsed?.data) {
    const first = errors[0]?.message || `HTTP ${raw.status}`;
    throw new AppError(502, `Unraid API error — ${first}`);
  }
  return { data: parsed.data as T, errors };
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const DISK_FIELDS = "name device size status temp fsSize fsUsed fsFree type";

/** Inventory + host usage, one round trip. Exported for the Query API modal's default. */
export const UNRAID_INVENTORY_QUERY = `query PolarisInventory {
  info {
    os { hostname release distro uptime }
    system { manufacturer model serial uuid }
    baseboard { manufacturer model serial }
    cpu { cores threads }
    versions { core { unraid } }
  }
  metrics {
    cpu { percentTotal cpus { percentTotal } }
    memory { total used available }
    network { name operstate bytesReceived bytesSent receiveErrors transmitErrors receiveDropped transmitDropped }
  }
  array {
    state
    capacity { kilobytes { total used free } }
    parities { ${DISK_FIELDS} }
    disks { ${DISK_FIELDS} }
    caches { ${DISK_FIELDS} }
  }
  docker {
    containers { id names image state status autoStart isUpdateAvailable lanIpPorts hostConfig { networkMode } networkSettings }
  }
  vms { domains { id name state } }
}`;

/**
 * The storage LAYOUT — per-disk health, errors and filesystem, the parity
 * check, each disk's SMART verdict. A query of its own, not part of the
 * inventory read: these fields arrived across Unraid API releases, and a
 * GraphQL validation error fails the WHOLE query, so a host on an older API
 * must lose only this, never the inventory.
 */
const ARRAY_DISK_LAYOUT_FIELDS = "name device size status temp numErrors fsType rotational type";
export const UNRAID_STORAGE_QUERY = `query PolarisStorage {
  array {
    parityCheckStatus { status date errors progress running paused }
    parities { ${ARRAY_DISK_LAYOUT_FIELDS} }
    disks { ${ARRAY_DISK_LAYOUT_FIELDS} }
    caches { ${ARRAY_DISK_LAYOUT_FIELDS} fsSize }
  }
  disks { device name serialNum smartStatus interfaceType }
}`;

const CONTAINER_STATS_SUBSCRIPTION =`subscription PolarisContainerStats {
  dockerContainerStats { id cpuPercent memUsage memPercent netIO }
}`;

// ─── Parsing (pure; exported for tests) ──────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** A PrefixedID is `<server>:<id>`; mutations take it whole, identity wants the tail. */
export function unprefixId(id: unknown): string {
  const s = String(id ?? "");
  const i = s.lastIndexOf(":");
  return i >= 0 ? s.slice(i + 1) : s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse docker-stats' human size ("1.25GiB", "512MiB", "3.2kB") to bytes.
 * Binary suffixes are powers of 1024, decimal ones powers of 1000 — docker
 * prints both depending on the field.
 */
export function parseDockerSize(s: string | null | undefined): number | null {
  const m = String(s ?? "").trim().match(/^([\d.]+)\s*([kKMGTP]?i?B)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  const binary = unit.includes("i");
  const base = binary ? 1024 : 1000;
  const exp = { B: 0, K: 1, k: 1, M: 2, G: 3, T: 4, P: 5 }[unit[0] === "B" ? "B" : unit[0]] ?? 0;
  return Math.round(n * Math.pow(base, exp));
}

/** "1.2GiB / 31.3GiB" → used + limit bytes. */
export function parseDockerMemUsage(s: string | null | undefined): { used: number | null; limit: number | null } {
  const [a, b] = String(s ?? "").split("/");
  return { used: parseDockerSize(a), limit: parseDockerSize(b) };
}

/**
 * Unraid's LAN-attached custom networks (macvlan / ipvlan on a host
 * interface): `br0`, `eth0`, `bond0`, `wg0`, and their VLAN children
 * (`br0.20`). An address on one of these is on the LAN, reachable from
 * Polaris.
 */
const UNRAID_LAN_NETWORK_RE = /^(br|eth|bond|wg)\d+(\.\d+)?$/i;

/**
 * A container's own, REACHABLE address — or null when it has none and answers
 * on its host's (two assets must not claim one IP, and ICMP to a NATed
 * address would call a running container down).
 *
 *   host / none / container:<x>  share another stack — none.
 *   bridge (docker's default)    NATed behind the host — none.
 *   a user-defined bridge        ALSO NATed (a 172.x address on a Linux
 *                                bridge inside the host), and indistinguishable
 *                                by name from a custom macvlan — so its address
 *                                counts only when Unraid lists it among the
 *                                container's LAN ports.
 *   br0 / eth0 / bond0 / wg0 (+ .vlan)  on the LAN — its address.
 */
export function containerOwnIp(networkMode: string | null, networkSettings: unknown, lanIpPorts: readonly string[] = []): string | null {
  const mode = (networkMode ?? "").toLowerCase();
  if (mode === "host" || mode === "none" || mode.startsWith("container:")) return null;
  const nets = (networkSettings as any)?.Networks ?? (networkSettings as any)?.networks;
  if (!nets || typeof nets !== "object") return null;
  const lanIps = new Set(lanIpPorts.map((p) => String(p).replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1")));
  for (const [name, n] of Object.entries(nets as Record<string, any>)) {
    if (name === "bridge" || name === "host") continue;
    const ip = str(n?.IPAddress ?? n?.ipAddress);
    if (ip && (UNRAID_LAN_NETWORK_RE.test(name) || lanIps.has(ip))) return ip;
  }
  return null;
}

function kbToBytes(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n * 1024;
}

/** Pools: the parity array as one, and each cache / named pool disk with a filesystem. */
export function parseUnraidPools(array: any): WorkloadPool[] {
  if (!array) return [];
  const pools: WorkloadPool[] = [];
  const cap = array.capacity?.kilobytes;
  if (cap) {
    pools.push({
      name: "array",
      kind: "array",
      totalBytes: kbToBytes(cap.total),
      usedBytes: kbToBytes(cap.used),
      health: str(array.state),
    });
  }
  for (const d of (array.caches ?? []) as any[]) {
    const total = kbToBytes(d?.fsSize);
    if (!total) continue; // a secondary member of a multi-device pool reports no filesystem
    pools.push({
      name: str(d.name) ?? "cache",
      kind: "pool",
      totalBytes: total,
      usedBytes: kbToBytes(d.fsUsed),
      health: str(d.status),
    });
  }
  return pools;
}

/** "/dev/sdb" / "sdb" → "sdb". */
function devBase(v: unknown): string | null {
  const s = str(v);
  return s ? s.replace(/^\/dev\//, "") : null;
}

function unraidMember(d: any, physical: ReadonlyMap<string, any>): WorkloadPoolMember {
  const dev = devBase(d?.device);
  const p = dev ? physical.get(dev) : undefined;
  const t = num(d?.temp);
  const iface = str(p?.interfaceType)?.toUpperCase() ?? null;
  return {
    name: str(d?.name) ?? dev ?? "?",
    device: dev,
    serial: str(p?.serialNum),
    model: str(p?.name),
    health: str(d?.status),
    // ArrayDisk sizes are KiB, like fsSize.
    sizeBytes: kbToBytes(d?.size),
    readErrors: null,
    writeErrors: null,
    checksumErrors: null,
    errors: num(d?.numErrors),
    temperatureC: t !== null && t > 0 ? t : null,
    filesystem: str(d?.fsType),
    mediaType: iface === "PCIE" || /^nvme/i.test(dev ?? "") ? "NVMe" : d?.rotational === false ? "SSD" : d?.rotational === true ? "HDD" : null,
    smart: str(p?.smartStatus),
  };
}

/**
 * Lay out Unraid's pools from UNRAID_STORAGE_QUERY. Unraid publishes no vdev
 * tree — even a ZFS pool is a flat member list — so the groups are what it
 * does publish:
 *
 *   array        parity disks + data disks, each data disk its own filesystem
 *                (xfs / btrfs / zfs) behind dedicated parity; the parity check
 *                is its scan.
 *   named pools  one member group. Members are named `<pool>`, `<pool>2`,
 *                `<pool>3`…, and only the first reports the filesystem size,
 *                so a member belongs to the longest pool name it extends with
 *                digits.
 *
 * Returns the pools enriched; one the layout answer does not mention is left
 * exactly as it was.
 */
export function applyUnraidStorageLayout(pools: WorkloadPool[], data: any): WorkloadPool[] {
  const array = data?.array;
  if (!array) return pools;
  const physical = new Map<string, any>();
  for (const p of (data?.disks ?? []) as any[]) {
    const dev = devBase(p?.device);
    if (dev) physical.set(dev, p);
  }
  const member = (d: any) => unraidMember(d, physical);
  const parities = ((array.parities ?? []) as any[]).filter((d) => str(d?.status) !== "DISK_NP");
  const dataDisks = ((array.disks ?? []) as any[]).filter((d) => str(d?.status) !== "DISK_NP");
  const caches = (array.caches ?? []) as any[];
  const pc = array.parityCheckStatus;
  const fsTypes = [...new Set(dataDisks.map((d) => str(d?.fsType)).filter((f): f is string => !!f))];

  return pools.map((pool) => {
    if (pool.kind === "array") {
      return {
        ...pool,
        filesystem: fsTypes.length > 0 ? `unraid-array (${fsTypes.join(", ")})` : "unraid-array",
        scan: pc ? {
          kind: "parity-check",
          state: pc.running === true ? (pc.paused === true ? "paused" : "running") : (str(pc.status)?.toLowerCase() ?? null),
          at: str(pc.date) ? new Date(String(pc.date)).toISOString() : null,
          percent: pc.running === true ? num(pc.progress) : null,
          errors: num(pc.errors),
        } : null,
        groups: [
          ...(parities.length > 0 ? [{ role: "parity", layout: null, name: null, health: null, members: parities.map(member) }] : []),
          { role: "data", layout: null, name: null, health: null, members: dataDisks.map(member) },
        ],
      };
    }
    const members = caches.filter((d) => {
      const name = str(d?.name);
      if (!name) return false;
      if (name === pool.name) return true;
      if (!new RegExp(`^${pool.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+$`).test(name)) return false;
      // A longer pool name that this member also extends wins ("cache" vs "cache_nvme").
      return !pools.some((o) => o.name.length > pool.name.length && name.startsWith(o.name));
    });
    if (members.length === 0) return pool;
    const lead = members.find((d) => str(d?.name) === pool.name) ?? members[0];
    return {
      ...pool,
      filesystem: str(lead?.fsType),
      groups: [{ role: "data", layout: null, name: null, health: null, members: members.map(member) }],
    };
  });
}

export function parseUnraidDisks(array: any): WorkloadDisk[] {
  if (!array) return [];
  const out: WorkloadDisk[] = [];
  const add = (list: any[], pool: string | null) => {
    for (const d of list ?? []) {
      const name = str(d?.name) ?? str(d?.device);
      if (!name) continue;
      const t = num(d?.temp);
      out.push({ name, serial: str(d?.device), temperatureC: t !== null && t > 0 ? t : null, pool });
    }
  };
  add(array.parities, "array");
  add(array.disks, "array");
  add(array.caches, null);
  return out;
}

/** Inventory half of the query result → the shared shape (usage is separate). */
export function parseUnraidInventory(
  data: any,
  config: Pick<UnraidConfig, "host">,
  partial: { dockerFailed: boolean; vmsFailed: boolean },
): WorkloadDiscoveryResult {
  const info = data?.info ?? {};
  const os = info.os ?? {};
  const sys = info.system ?? {};
  const board = info.baseboard ?? {};
  // A whitebox's SMBIOS system block is often "To Be Filled By O.E.M.";
  // the baseboard carries the real maker then. The projection's serial rule
  // refuses placeholders either way (rule 84).
  const pick = (a: unknown, b: unknown) => {
    const x = str(a);
    return x && !/to be filled|default string|system (manufacturer|product name|serial)/i.test(x) ? x : str(b);
  };
  const memTotal = num(data?.metrics?.memory?.total);
  const host: WorkloadHost = {
    hostname: str(os.hostname),
    os: "Unraid",
    osVersion: str(info.versions?.core?.unraid) ?? str(os.release),
    ip: config.host,
    serial: pick(sys.serial, board.serial),
    manufacturer: pick(sys.manufacturer, board.manufacturer),
    model: pick(sys.model, board.model),
    cpuCount: num(info.cpu?.threads) ?? num(info.cpu?.cores),
    memTotalBytes: memTotal,
    uptimeSeconds: uptimeSecondsFrom(os.uptime),
    pools: parseUnraidPools(data?.array),
    disks: parseUnraidDisks(data?.array),
  };

  const vms: WorkloadVm[] = ((data?.vms?.domains ?? []) as any[]).map((d) => {
    const tail = unprefixId(d?.id);
    return {
      platformId: String(d?.id ?? ""),
      name: str(d?.name) ?? tail,
      uuid: UUID_RE.test(tail) ? tail.toLowerCase() : null,
      state: normalizeWorkloadState(d?.state),
      rawState: str(d?.state),
      cpuCount: null,
      memoryBytes: null,
      ip: null,
      macs: [],
      autostart: null,
    };
  }).filter((v) => v.platformId !== "");

  const containers: WorkloadContainer[] = ((data?.docker?.containers ?? []) as any[]).map((c) => {
    const name = String(((c?.names ?? []) as string[])[0] ?? "").replace(/^\//, "") || unprefixId(c?.id);
    return {
      platformId: String(c?.id ?? ""),
      name,
      image: str(c?.image),
      state: normalizeWorkloadState(c?.state),
      rawState: str(c?.status) ?? str(c?.state),
      ip: containerOwnIp(
        str(c?.hostConfig?.networkMode),
        c?.networkSettings,
        Array.isArray(c?.lanIpPorts) ? c.lanIpPorts.filter((p: unknown): p is string => typeof p === "string") : [],
      ),
      networkMode: str(c?.hostConfig?.networkMode),
      updateAvailable: typeof c?.isUpdateAvailable === "boolean" ? c.isUpdateAvailable : null,
      version: null,
      latestVersion: null,
      memberCount: 1,
      ports: Array.isArray(c?.lanIpPorts) ? c.lanIpPorts.filter((p: unknown) => typeof p === "string") : [],
      autostart: typeof c?.autoStart === "boolean" ? c.autoStart : null,
    };
  }).filter((c) => c.platformId !== "" && c.name !== "");

  return {
    platform: "unraid",
    host,
    vms,
    containers,
    inventoryComplete: !partial.dockerFailed && !partial.vmsFailed,
    presentVmNames: vms.map((v) => v.name),
    presentContainerNames: containers.map((c) => c.name),
  };
}

/** InfoOs.uptime is the boot time (ISO) on current releases; tolerate seconds too. */
function uptimeSecondsFrom(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n;
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null;
}

export function parseUnraidHostUsage(data: any): WorkloadUsage & { interfaces: WorkloadInterfaceReading[] } {
  const cpu = data?.metrics?.cpu;
  const mem = data?.metrics?.memory;
  const total = num(mem?.total);
  // `available` excludes reclaimable cache; used = total − available is what
  // an operator means by "memory in use" (Unraid's own `used` counts cache).
  const avail = num(mem?.available);
  const used = total !== null && avail !== null ? Math.max(0, total - avail) : num(mem?.used);
  const interfaces: WorkloadInterfaceReading[] = ((data?.metrics?.network ?? []) as any[])
    .filter((n) => str(n?.name))
    .map((n) => ({
      name: String(n.name),
      operUp: typeof n?.operstate === "string" ? n.operstate.toLowerCase() === "up" : null,
      rxBytes: num(n?.bytesReceived),
      txBytes: num(n?.bytesSent),
      rxErrors: num(n?.receiveErrors),
      txErrors: num(n?.transmitErrors),
      rxDrops: num(n?.receiveDropped),
      txDrops: num(n?.transmitDropped),
      speedMbps: null,
    }));
  return {
    cpuPct: num(cpu?.percentTotal),
    perCorePct: Array.isArray(cpu?.cpus) ? cpu.cpus.map((c: any) => num(c?.percentTotal) ?? 0) : null,
    memUsedBytes: used,
    memTotalBytes: total,
    interfaces,
  };
}

// ─── Interface addressing ────────────────────────────────────────────────────

/**
 * `metrics.network` is traffic only — no address, MAC or speed. Addressing
 * lives in `info.networkInterfaces` (current API) or, MAC + speed only, the
 * older `info.devices.network`. Read on its own, never folded into the
 * inventory query: a field the host's API does not know fails the WHOLE
 * GraphQL query, and this must cost at most the addressing.
 */
export const UNRAID_IFACE_QUERIES = [
  `query PolarisIfaces { info { networkInterfaces { name macAddress speed vlanId ipAddress ipv4Addresses { address } } } }`,
  `query PolarisIfacesLegacy { info { devices { network { iface mac speed } } } }`,
] as const;

/** One row of addressing, keyed by interface name. */
export interface UnraidIfaceAddressing {
  ipAddress: string | null;
  macAddress: string | null;
  speedMbps: number | null;
  vlanId: number | null;
}

/**
 * Interfaces whose address is private to the host's Docker / libvirt plumbing:
 * docker0 (172.17.0.1 on EVERY Docker host), user bridges (br-<id>), veth
 * pairs, libvirt's virbr / vnet, and the macvlan `shim-` interfaces that mirror
 * the host's own address. Their MAC still shows; their address is not
 * recorded — an interface IP becomes an associated IP (IP history, path-check
 * hop resolution, the application map, search), and one shared 172.17.0.1
 * would tie every Unraid server in the fleet to the same address.
 */
const HOST_INTERNAL_IFACE_RE = /^(docker\d+|br-[0-9a-f]+|veth|virbr\d+|vnet\d+|shim-|vhost|tunl\d+)/i;

function reportableIpv4(name: string, ip: string | null): string | null {
  if (!ip || HOST_INTERNAL_IFACE_RE.test(name)) return null;
  if (/^(127\.|169\.254\.|0\.)/.test(ip)) return null;
  return ip;
}

/** Either query's answer → addressing by interface name. */
export function parseUnraidIfaceAddressing(data: any): Map<string, UnraidIfaceAddressing> {
  const out = new Map<string, UnraidIfaceAddressing>();
  const mac = (v: unknown) => {
    const s = str(v);
    return s && !/^0{2}([:-]?0{2}){5}$/.test(s) ? s.toUpperCase().replace(/-/g, ":") : null;
  };
  const speed = (v: unknown) => {
    const n = num(v);
    return n !== null && n > 0 ? n : null; // -1 / 0 = no link or not reported
  };
  for (const i of (data?.info?.networkInterfaces ?? []) as any[]) {
    const name = str(i?.name);
    if (!name) continue;
    const listed = ((i?.ipv4Addresses ?? []) as any[]).map((a) => str(a?.address)).find((a): a is string => !!a);
    out.set(name, {
      ipAddress: reportableIpv4(name, listed ?? str(i?.ipAddress)),
      macAddress: mac(i?.macAddress),
      speedMbps: speed(i?.speed),
      vlanId: num(i?.vlanId),
    });
  }
  for (const d of (data?.info?.devices?.network ?? []) as any[]) {
    const name = str(d?.iface);
    if (!name || out.has(name)) continue;
    out.set(name, { ipAddress: null, macAddress: mac(d?.mac), speedMbps: speed(d?.speed), vlanId: null });
  }
  return out;
}

/** Fill the metrics rows' addressing; a row the addressing does not name is left as it was. */
export function applyUnraidIfaceAddressing(
  interfaces: WorkloadInterfaceReading[],
  addressing: ReadonlyMap<string, UnraidIfaceAddressing>,
): WorkloadInterfaceReading[] {
  return interfaces.map((i) => {
    const a = addressing.get(i.name);
    if (!a) return i;
    return {
      ...i,
      speedMbps: i.speedMbps ?? a.speedMbps,
      ipAddress: a.ipAddress,
      macAddress: a.macAddress,
      vlanId: a.vlanId,
    };
  });
}

/**
 * Which of UNRAID_IFACE_QUERIES each host answers, remembered so an older API
 * is not sent a refused query every 30 s. Re-probed after IFACE_TIER_RETRY_MS
 * so an Unraid upgrade is picked up without a restart. -1 = neither works.
 */
const IFACE_TIER_RETRY_MS = 6 * 60 * 60_000;
const ifaceTierByHost = new Map<string, { tier: number; at: number }>();

async function readUnraidIfaceAddressing(config: UnraidConfig): Promise<Map<string, UnraidIfaceAddressing>> {
  const known = ifaceTierByHost.get(config.host);
  const fresh = known && Date.now() - known.at < IFACE_TIER_RETRY_MS;
  if (fresh && known.tier < 0) return new Map();
  const tiers = fresh ? [known.tier] : UNRAID_IFACE_QUERIES.map((_, i) => i);
  for (const tier of tiers) {
    try {
      const { data } = await unraidGraphql<any>(config, UNRAID_IFACE_QUERIES[tier]);
      if (!fresh) ifaceTierByHost.set(config.host, { tier, at: Date.now() });
      return parseUnraidIfaceAddressing(data);
    } catch (err: any) {
      logger.debug({ host: config.host, tier, err: err?.message }, "unraid: interface addressing query failed");
      // Only a REFUSAL (the API answered with errors and no data — an unknown
      // field) says this tier does not work here. A timeout or a dropped
      // connection says nothing about the schema: give up this tick without
      // remembering anything, or one blip would pin the legacy tier for hours.
      if (!/^Unraid API error/.test(String(err?.message ?? ""))) return new Map();
      // A remembered tier that is now refused (the API changed under us) re-probes next time.
      if (fresh) { ifaceTierByHost.delete(config.host); return new Map(); }
    }
  }
  ifaceTierByHost.set(config.host, { tier: -1, at: Date.now() });
  return new Map();
}

/** Which top-level fields came back as errors (the key's role may hide some). */
function failedRoots(errors: Array<{ path?: unknown }>): Set<string> {
  const out = new Set<string>();
  for (const e of errors) {
    const p = Array.isArray(e.path) ? e.path : [];
    if (typeof p[0] === "string") out.add(p[0]);
  }
  return out;
}

// ─── Container stats subscription ────────────────────────────────────────────

/** One dockerContainerStats event, as docker printed it (CPU per CORE). */
export interface UnraidContainerStat {
  cpuPct: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

/** Network modes in which a container has no network stack of its own. */
function sharesHostStack(networkMode: string | null): boolean {
  const m = (networkMode ?? "").toLowerCase();
  return m === "host" || m === "none" || m.startsWith("container:");
}

/**
 * docker stats → the shared WorkloadUsage.
 *
 * CPU: docker's CPUPerc counts 100 % per CORE (a container busy on two
 * threads reads 200 %), and Unraid's API passes it through unchanged. The
 * chart and the alerts read a share of the host, so it is divided by the
 * host's thread count — what Unraid's own Docker page shows. A host that did
 * not report its thread count leaves the figure as docker printed it.
 *
 * Network: one row named after the container's network. A container on the
 * host's stack gets none — docker reports 0 / 0 for it, and its traffic is
 * the host's.
 */
export function normalizeUnraidContainerUsage(
  stats: ReadonlyMap<string, UnraidContainerStat>,
  containers: ReadonlyArray<Pick<WorkloadContainer, "platformId" | "networkMode">>,
  hostThreads: number | null,
): Map<string, WorkloadUsage> {
  const modeById = new Map(containers.map((c) => [c.platformId, c.networkMode]));
  const out = new Map<string, WorkloadUsage>();
  for (const [id, s] of stats) {
    const mode = modeById.get(id) ?? null;
    const usage: WorkloadUsage = {
      cpuPct: s.cpuPct !== null && hostThreads && hostThreads > 0 ? s.cpuPct / hostThreads : s.cpuPct,
      memUsedBytes: s.memUsedBytes,
      memTotalBytes: s.memTotalBytes,
    };
    if (!sharesHostStack(mode) && (s.netRxBytes !== null || s.netTxBytes !== null)) {
      usage.interfaces = [{
        name: mode || "eth0",
        operUp: true,
        rxBytes: s.netRxBytes,
        txBytes: s.netTxBytes,
        rxErrors: null,
        txErrors: null,
        rxDrops: null,
        txDrops: null,
        speedMbps: null,
      }];
    }
    out.set(id, usage);
  }
  return out;
}

/**
 * Collect one dockerContainerStats reading per running container over a short
 * window. Resolves early once every expected container has reported. Never
 * rejects: a failed socket yields an empty map (containers then simply carry
 * no CPU / memory this tick) and is logged at debug.
 */
export async function sampleUnraidContainerStats(
  config: UnraidConfig,
  expectedIds: ReadonlySet<string>,
  windowMs = DEFAULT_STATS_WINDOW_MS,
): Promise<Map<string, UnraidContainerStat>> {
  const out = new Map<string, UnraidContainerStat>();
  if (expectedIds.size === 0) return out;
  const useTls = config.useTls !== false;
  const url = `${useTls ? "wss" : "ws"}://${config.host}:${defaultPort(config)}/graphql`;
  const wait = Math.min(Math.max(windowMs, 1000), MAX_STATS_WINDOW_MS);
  return await new Promise<Map<string, UnraidContainerStat>>((resolve) => {
    let done = false;
    let ws: WebSocket | null = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.send(JSON.stringify({ id: "1", type: "complete" })); } catch { /* noop */ }
      try { ws?.close(); } catch { /* noop */ }
      resolve(out);
    };
    const timer = setTimeout(finish, wait + 2000);
    try {
      ws = new WebSocket(url, "graphql-transport-ws", {
        headers: { "x-api-key": config.apiToken },
        ...(useTls ? { rejectUnauthorized: config.verifyTls !== false } : {}),
        handshakeTimeout: 5000,
      });
    } catch (err: any) {
      logger.debug({ err: err?.message }, "unraid: container stats socket failed to open");
      finish();
      return;
    }
    ws.on("open", () => {
      ws!.send(JSON.stringify({ type: "connection_init", payload: { "x-api-key": config.apiToken } }));
    });
    ws.on("message", (buf) => {
      let msg: any;
      try { msg = JSON.parse(String(buf)); } catch { return; }
      if (msg.type === "connection_ack") {
        ws!.send(JSON.stringify({ id: "1", type: "subscribe", payload: { query: CONTAINER_STATS_SUBSCRIPTION } }));
        setTimeout(finish, wait);
        return;
      }
      if (msg.type === "ping") { try { ws!.send(JSON.stringify({ type: "pong" })); } catch { /* noop */ } return; }
      if (msg.type === "next") {
        const s = msg.payload?.data?.dockerContainerStats;
        if (!s?.id) return;
        const id = String(s.id);
        const mem = parseDockerMemUsage(s.memUsage);
        // NetIO is "received / sent", cumulative since the container started —
        // the same "a / b" shape as MemUsage.
        const net = parseDockerMemUsage(s.netIO);
        out.set(id, { cpuPct: num(s.cpuPercent), memUsedBytes: mem.used, memTotalBytes: mem.limit, netRxBytes: net.used, netTxBytes: net.limit });
        if ([...expectedIds].every((x) => out.has(x))) finish();
        return;
      }
      if (msg.type === "error" || msg.type === "complete") finish();
    });
    ws.on("error", (err: any) => {
      logger.debug({ err: err?.message }, "unraid: container stats socket error");
      finish();
    });
    ws.on("close", finish);
  });
}

// ─── Public surface ──────────────────────────────────────────────────────────

function requireConfig(config: UnraidConfig): void {
  if (!config?.host) throw new AppError(400, "Host is required");
  if (!config.apiToken) throw new AppError(400, "API key is required");
}

export async function testConnection(config: UnraidConfig): Promise<{ ok: boolean; message: string }> {
  try {
    requireConfig(config);
    const { data, errors } = await unraidGraphql<any>(
      config,
      `query { info { os { hostname } versions { core { unraid } } } docker { containers { id } } vms { domains { id } } }`,
    );
    const failed = failedRoots(errors);
    const host = data?.info?.os?.hostname || config.host;
    const version = data?.info?.versions?.core?.unraid;
    const ctr = failed.has("docker") ? "containers unreadable (Docker stopped, or the key's role lacks it)" : `${(data?.docker?.containers ?? []).length} container(s)`;
    const vm = failed.has("vms") ? "VMs unreadable (VM manager stopped, or the key's role lacks it)" : `${(data?.vms?.domains ?? []).length} VM(s)`;
    return { ok: true, message: `Connected to ${host}${version ? ` (Unraid ${version})` : ""} — ${ctr}, ${vm}` };
  } catch (err: any) {
    return { ok: false, message: err instanceof AppError ? err.message : err?.message || "Unknown error" };
  }
}

async function readInventory(config: UnraidConfig, signal?: AbortSignal): Promise<{ data: any; failed: Set<string> }> {
  requireConfig(config);
  const { data, errors } = await unraidGraphql<any>(config, UNRAID_INVENTORY_QUERY, undefined, { signal });
  const failed = failedRoots(errors);
  if (failed.size > 0) {
    logger.debug({ host: config.host, failed: [...failed] }, "unraid: some inventory fields came back with errors");
  }
  return { data, failed };
}

/**
 * Discovery read. A Docker service that is stopped (or a VM manager that is
 * off) answers as a field error: the result is marked incomplete so the sweep
 * cannot read "Docker is off" as "every container was deleted".
 */
export async function discoverInventory(config: UnraidConfig, signal?: AbortSignal): Promise<WorkloadDiscoveryResult> {
  const { data, failed } = await readInventory(config, signal);
  const result = parseUnraidInventory(data, config, {
    dockerFailed: failed.has("docker") || !data?.docker,
    vmsFailed: failed.has("vms") || !data?.vms,
  });
  // The layout is best-effort: an older API that refuses a field costs the
  // pool details, never the inventory.
  try {
    const { data: storage } = await unraidGraphql<any>(config, UNRAID_STORAGE_QUERY, undefined, { signal });
    result.host.pools = applyUnraidStorageLayout(result.host.pools, storage);
  } catch (err: any) {
    if (signal?.aborted) throw err;
    logger.debug({ host: config.host, err: err?.message }, "unraid: storage layout read failed — pools keep their summary only");
  }
  return result;
}

/** One monitor tick's worth: inventory + host usage + per-container stats. */
export async function fetchUnraidSnapshot(config: UnraidConfig): Promise<WorkloadSnapshot> {
  const started = Date.now();
  const { data, failed } = await readInventory(config);
  const durationMs = Date.now() - started;
  const inventory = parseUnraidInventory(data, config, {
    dockerFailed: failed.has("docker") || !data?.docker,
    vmsFailed: failed.has("vms") || !data?.vms,
  });
  const running = new Set(inventory.containers.filter((c) => c.state === "running").map((c) => c.platformId));
  // The addressing read rides the stats window's wait — it adds no time to
  // the tick, and it never rejects.
  const [stats, addressing] = await Promise.all([
    sampleUnraidContainerStats(config, running, config.statsWindowMs),
    readUnraidIfaceAddressing(config).catch(() => new Map<string, UnraidIfaceAddressing>()),
  ]);
  const host = parseUnraidHostUsage(data);
  host.interfaces = applyUnraidIfaceAddressing(host.interfaces, addressing);
  return {
    fetchedAt: Date.now(),
    durationMs,
    inventory,
    host,
    vmUsage: new Map(),
    containerUsage: normalizeUnraidContainerUsage(stats, inventory.containers, inventory.host.cpuCount),
  };
}

/**
 * Backs the Query API modal: run an arbitrary GraphQL QUERY with the stored
 * key. Mutations and subscriptions are refused — the modal is a read tool.
 */
export async function proxyQuery(config: UnraidConfig, query: string, variables?: Record<string, unknown>): Promise<unknown> {
  requireConfig(config);
  const q = String(query ?? "").replace(/#[^\n]*/g, "").trim();
  if (!q) throw new AppError(400, "Query is required");
  if (/^\s*(mutation|subscription)\b/i.test(q)) {
    throw new AppError(400, "Only queries can be run here — mutations and subscriptions are refused");
  }
  const { data, errors } = await unraidGraphql<unknown>(config, q, variables);
  return errors.length > 0 ? { data, errors } : data;
}

// ─── Actions (Phase: workload control) ───────────────────────────────────────

export type UnraidContainerVerb = "start" | "stop" | "restart" | "update";
export type UnraidVmVerb = "start" | "stop" | "restart";

/** Start / stop / restart / update one container. `id` is the PrefixedID. */
export async function containerAction(config: UnraidConfig, id: string, verb: UnraidContainerVerb): Promise<void> {
  requireConfig(config);
  const field = verb === "update" ? "updateContainer" : verb;
  const { errors } = await unraidGraphql<any>(
    config,
    `mutation ($id: PrefixedID!) { docker { ${field}(id: $id) { id state } } }`,
    { id },
    // An image pull can take minutes.
    { timeoutMs: verb === "update" ? 600_000 : 120_000 },
  );
  if (errors.length > 0) throw new AppError(502, `Unraid refused to ${verb} the container — ${errors[0].message}`);
}

/** Start / stop / restart one VM. A stop is a graceful ACPI shutdown. */
export async function vmAction(config: UnraidConfig, id: string, verb: UnraidVmVerb): Promise<void> {
  requireConfig(config);
  const field = verb === "restart" ? "reboot" : verb;
  const { data, errors } = await unraidGraphql<any>(
    config,
    `mutation ($id: PrefixedID!) { vm { ${field}(id: $id) } }`,
    { id },
    { timeoutMs: 120_000 },
  );
  if (errors.length > 0) throw new AppError(502, `Unraid refused to ${verb} the VM — ${errors[0].message}`);
  if (data?.vm?.[field] === false) throw new AppError(502, `Unraid reported the VM ${verb} as unsuccessful`);
}

/** Ask Unraid to re-check image digests (the update-available flags). */
export async function refreshUpdateChecks(config: UnraidConfig): Promise<void> {
  requireConfig(config);
  const { errors } = await unraidGraphql<any>(config, `mutation { refreshDockerDigests }`, undefined, { timeoutMs: 120_000 });
  if (errors.length > 0) throw new AppError(502, `Unraid could not refresh update checks — ${errors[0].message}`);
}
