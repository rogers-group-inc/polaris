/**
 * src/services/proxmoxService.ts
 *
 * Proxmox VE integration — every node of a cluster, its QEMU VMs and its LXC
 * containers, read through the REST API (`/api2/json`) with an API token.
 * The third workload platform beside Unraid and TrueNAS SCALE, and the first
 * with more than one host per integration: each node is a host
 * (`WorkloadHost.key` = node name), each guest names the node it runs on
 * (`hostKey`), and the shared sync (services/discovery/workloadSync.ts) moves
 * a guest's placement edge when it migrates.
 *
 * Read-only by design: the documented token is a PVEAuditor, so Polaris
 * offers no start / stop here (workloadActionService.platformHasActions).
 *
 * One read answers for the whole cluster: `/cluster/resources` carries every
 * node's and guest's state, CPU, memory and network counters, so a monitor
 * tick costs that call, `/cluster/status`, and two calls per ONLINE node
 * (status + the last RRD row, for ARC and node traffic) — never a call per
 * guest. Per-guest detail (the SMBIOS UUID a VM's identity is built from, its
 * MACs and guest-agent addresses) is read at discovery and cached, so the
 * tick can key VMs the way the sync did without re-reading every config.
 *
 * Any node answers for the cluster, so the integration takes a list of
 * addresses: the first that answers is used, and the last one that worked is
 * tried first next time. A node that is down is then reported by its peers as
 * `online: false` — its host asset probes down and its guests are dependency-
 * suppressed, rather than the whole integration going dark.
 */

import { request as httpsRequest } from "node:https";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { normalizeWorkloadState, workloadHostUsageKey } from "../utils/workloadSources.js";
import { RateCounters } from "./truenasService.js";
import type {
  WorkloadContainer,
  WorkloadDiscoveryResult,
  WorkloadDisk,
  WorkloadHost,
  WorkloadHostUsage,
  WorkloadInterfaceReading,
  WorkloadPool,
  WorkloadPoolGroup,
  WorkloadPoolMember,
  WorkloadSnapshot,
  WorkloadUsage,
  WorkloadVm,
} from "./discovery/workloadSync.js";

export interface ProxmoxConfig {
  /** The first node address to try. */
  host: string;
  /** More node addresses, tried in order when the first does not answer. */
  fallbackHosts?: string[];
  port?: number;
  verifyTls?: boolean;
  /** `user@realm!tokenname`. */
  tokenId: string;
  /** The token's secret (stored under the sealed `apiToken` config key). */
  apiToken: string;
  vmInclude?: string[];
  vmExclude?: string[];
  containerInclude?: string[];
  containerExclude?: string[];
}

const DEFAULT_PORT = 8006;
const REQUEST_TIMEOUT_MS = 15_000;
/** Per-node and per-guest reads in flight at once (one integration). */
const READ_CONCURRENCY = 6;
/** How long a guest's config detail (UUID, MACs, addresses) is trusted between discoveries. */
const GUEST_DETAIL_TTL_MS = 30 * 60_000;

// ─── Transport ───────────────────────────────────────────────────────────────

/** Every address configured, deduplicated, in order. */
export function proxmoxEndpoints(config: Pick<ProxmoxConfig, "host" | "fallbackHosts">): string[] {
  const all = [config.host, ...(config.fallbackHosts ?? [])].map((h) => String(h ?? "").trim()).filter(Boolean);
  return [...new Set(all)];
}

/** The address that answered last, per integration config (process lifetime). */
const lastGoodEndpoint = new Map<string, string>();
const endpointKey = (config: ProxmoxConfig) => `${proxmoxEndpoints(config).join(",")}|${config.tokenId}`;

/** A failure that says nothing about the cluster — try the next address. */
class EndpointUnreachable extends AppError {}

function translateNetworkError(err: any, host: string, port: number): AppError {
  const code = err?.code;
  const where = `${host}:${port}`;
  if (code === "ECONNREFUSED") return new EndpointUnreachable(502, `Connection refused — ${where}`);
  if (code === "ENOTFOUND") return new EndpointUnreachable(502, `Host not found — ${host}`);
  if (code === "ETIMEDOUT" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return new EndpointUnreachable(504, `Connection timed out — ${where}`);
  }
  if (code === "EPROTO" || code === "ERR_SSL_WRONG_VERSION_NUMBER") {
    return new AppError(502, `TLS handshake failed — ${where} is not serving the Proxmox API (default port 8006)`);
  }
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID"
  ) {
    return new AppError(502, `TLS certificate error (${code}) — Proxmox ships a self-signed certificate; install a trusted one or disable TLS verification`);
  }
  return new EndpointUnreachable(502, err?.message || "Proxmox connection error");
}

/** An API answer that is about the request, not the connection. */
export class ProxmoxApiError extends AppError {
  constructor(httpStatus: number, message: string, readonly pveStatus: number) {
    super(httpStatus, message);
  }
}

async function getOnce(config: ProxmoxConfig, host: string, path: string): Promise<unknown> {
  const port = config.port || DEFAULT_PORT;
  const raw = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: host.replace(/^\[(.*)\]$/, "$1"),
        port,
        path: `/api2/json${path}`,
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `PVEAPIToken=${config.tokenId}=${config.apiToken}`,
        },
        rejectUnauthorized: config.verifyTls !== false,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("timeout", () => { try { req.destroy(); } catch { /* noop */ } reject(new EndpointUnreachable(504, `Proxmox API request timed out — ${host}:${port}`)); });
    req.on("error", (err) => reject(translateNetworkError(err, host, port)));
    req.end();
  });
  if (raw.status === 401) {
    throw new AppError(502, "Proxmox rejected the API token (HTTP 401) — check the token ID and secret");
  }
  let parsed: any = null;
  try { parsed = JSON.parse(raw.body); } catch { /* handled below */ }
  if (raw.status < 200 || raw.status >= 300) {
    // Proxmox puts the reason in the status line and, for most errors, a
    // `message` field; 595 is its "the node you proxied to did not answer".
    const msg = String(parsed?.message ?? "").trim() || `HTTP ${raw.status}`;
    throw new ProxmoxApiError(502, `Proxmox ${path}: ${msg}`, raw.status);
  }
  if (!parsed || typeof parsed !== "object") throw new AppError(502, `Proxmox ${path}: a non-JSON answer`);
  return parsed.data;
}

/**
 * GET one API path, trying each configured node address until one answers.
 * Only connection-level failures move on to the next address: an answer —
 * even a 403 or a 500 — came from the cluster and is returned as is.
 */
export async function proxmoxGet<T = any>(config: ProxmoxConfig, path: string): Promise<T> {
  const endpoints = proxmoxEndpoints(config);
  if (endpoints.length === 0) throw new AppError(400, "No Proxmox host is configured");
  const key = endpointKey(config);
  const preferred = lastGoodEndpoint.get(key);
  const order = preferred && endpoints.includes(preferred) ? [preferred, ...endpoints.filter((e) => e !== preferred)] : endpoints;
  const failures: AppError[] = [];
  for (const host of order) {
    try {
      const data = await getOnce(config, host, path);
      lastGoodEndpoint.set(key, host);
      return data as T;
    } catch (err) {
      if (!(err instanceof EndpointUnreachable)) throw err;
      failures.push(err);
      logger.debug({ host, path, err: err.message }, "proxmox: address did not answer — trying the next one");
    }
  }
  if (failures.length === 1) throw failures[0]!;
  throw new AppError(502, `No configured Proxmox address answered — ${failures.map((f) => f.message).join("; ")}`);
}

// ─── Pure parsers (exported for tests) ───────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};

export interface ProxmoxClusterNode {
  name: string;
  online: boolean;
  ip: string | null;
}

export interface ProxmoxClusterStatus {
  /** The cluster's name, or null for a standalone node. */
  clusterName: string | null;
  /** null for a standalone node (no quorum to speak of). */
  quorate: boolean | null;
  nodes: ProxmoxClusterNode[];
}

/** `/cluster/status`: a `cluster` row (absent on a standalone node) plus one `node` row per member. */
export function parseProxmoxClusterStatus(data: unknown): ProxmoxClusterStatus {
  const rows = Array.isArray(data) ? data : [];
  const cluster = rows.find((r: any) => r?.type === "cluster");
  const nodes = rows
    .filter((r: any) => r?.type === "node" && str(r?.name))
    .map((r: any): ProxmoxClusterNode => ({ name: str(r.name)!, online: num(r.online) === 1, ip: str(r.ip) }));
  return {
    clusterName: str(cluster?.name),
    quorate: cluster ? num(cluster.quorate) === 1 : null,
    nodes,
  };
}

export interface ProxmoxResourceNode {
  name: string;
  online: boolean;
  cpu: number | null;
  maxcpu: number | null;
  mem: number | null;
  maxmem: number | null;
  uptime: number | null;
}

export interface ProxmoxResourceGuest {
  type: "qemu" | "lxc";
  vmid: number;
  name: string;
  node: string;
  status: string | null;
  /** Fraction (0-1) of the guest's own vCPU allotment. */
  cpu: number | null;
  maxcpu: number | null;
  mem: number | null;
  maxmem: number | null;
  /** Cumulative bytes since the guest started. */
  netin: number | null;
  netout: number | null;
  uptime: number | null;
}

/** `/cluster/resources`: nodes and guests (templates dropped — they never run). */
export function parseProxmoxResources(data: unknown): { nodes: ProxmoxResourceNode[]; guests: ProxmoxResourceGuest[] } {
  const rows = Array.isArray(data) ? data : [];
  const nodes: ProxmoxResourceNode[] = [];
  const guests: ProxmoxResourceGuest[] = [];
  for (const r of rows as any[]) {
    if (r?.type === "node" && str(r?.node)) {
      nodes.push({
        name: str(r.node)!, online: r.status === "online",
        cpu: num(r.cpu), maxcpu: num(r.maxcpu), mem: num(r.mem), maxmem: num(r.maxmem), uptime: num(r.uptime),
      });
    } else if ((r?.type === "qemu" || r?.type === "lxc") && num(r?.vmid) !== null && num(r?.template) !== 1) {
      const vmid = num(r.vmid)!;
      guests.push({
        type: r.type, vmid, name: str(r.name) ?? String(vmid), node: str(r.node) ?? "",
        status: str(r.status), cpu: num(r.cpu), maxcpu: num(r.maxcpu), mem: num(r.mem), maxmem: num(r.maxmem),
        netin: num(r.netin), netout: num(r.netout), uptime: num(r.uptime),
      });
    }
  }
  return { nodes, guests };
}

/** `virtio=BC:24:11:..,bridge=vmbr0` (QEMU) / `name=eth0,hwaddr=BC:..,ip=10.0.0.5/24` (LXC) → its parts. */
export function parseProxmoxNetConfig(value: unknown): { mac: string | null; bridge: string | null; ip: string | null } {
  const s = str(value);
  if (!s) return { mac: null, bridge: null, ip: null };
  const parts = new Map<string, string>();
  for (const kv of s.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts.set(kv.slice(0, i).trim().toLowerCase(), kv.slice(i + 1).trim());
  }
  // QEMU names the MAC by its NIC model (virtio=, e1000=, vmxnet3=, rtl8139=…).
  let mac = parts.get("hwaddr") ?? parts.get("macaddr") ?? null;
  if (!mac) for (const v of parts.values()) if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(v)) { mac = v; break; }
  const rawIp = parts.get("ip") ?? null;
  const ip = rawIp && rawIp !== "dhcp" && rawIp !== "manual" ? rawIp.replace(/\/\d+$/, "") : null;
  return { mac: mac ? mac.toUpperCase() : null, bridge: parts.get("bridge") ?? null, ip };
}

/** All `netN` (and QEMU `ipconfigN`) keys of a guest config, in index order. */
function netKeys(cfg: Record<string, unknown>, prefix: string): string[] {
  return Object.keys(cfg).filter((k) => new RegExp(`^${prefix}\\d+$`).test(k))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
}

const isUsableIpv4 = (ip: string | null | undefined): ip is string =>
  !!ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && !ip.startsWith("127.") && !ip.startsWith("169.254.");

/** The first usable IPv4 a guest reports (QEMU guest agent `network-get-interfaces` / LXC `interfaces`). */
export function firstGuestIpv4(ifaces: unknown): string | null {
  const list = Array.isArray(ifaces) ? ifaces : Array.isArray((ifaces as any)?.result) ? (ifaces as any).result : [];
  for (const i of list as any[]) {
    if (str(i?.name) === "lo") continue;
    for (const a of (Array.isArray(i?.["ip-addresses"]) ? i["ip-addresses"] : []) as any[]) {
      const ip = str(a?.["ip-address"]);
      if ((a?.["ip-address-type"] === "ipv4" || a?.["ip-address-type"] === "inet") && isUsableIpv4(ip)) return ip;
    }
  }
  return null;
}

/** What discovery learns about one guest beyond `/cluster/resources`. */
export interface ProxmoxGuestDetail {
  uuid: string | null;
  macs: string[];
  ip: string | null;
  bridge: string | null;
  ostype: string | null;
  autostart: boolean | null;
}

/** A guest's config (+ its live interfaces, when they could be read) → the detail the sync keys on. */
export function parseProxmoxGuestDetail(type: "qemu" | "lxc", config: unknown, liveIfaces: unknown): ProxmoxGuestDetail {
  const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const nets = netKeys(cfg, "net").map((k) => parseProxmoxNetConfig(cfg[k]));
  const smbios = str(cfg.smbios1);
  const uuid = type === "qemu" ? (smbios?.match(/(?:^|,)uuid=([0-9a-f-]{36})/i)?.[1]?.toLowerCase() ?? null) : null;
  // A static address in the config (LXC `ip=`, QEMU cloud-init `ipconfigN`)
  // is a fallback for a guest the agent cannot be asked about.
  const staticIp = type === "lxc"
    ? nets.map((n) => n.ip).find(isUsableIpv4) ?? null
    : netKeys(cfg, "ipconfig").map((k) => parseProxmoxNetConfig(cfg[k]).ip).find(isUsableIpv4) ?? null;
  return {
    uuid,
    macs: nets.map((n) => n.mac).filter((m): m is string => !!m),
    ip: firstGuestIpv4(liveIfaces) ?? staticIp,
    bridge: nets[0]?.bridge ?? null,
    ostype: str(cfg.ostype),
    autostart: cfg.onboot === undefined ? null : num(cfg.onboot) === 1,
  };
}

const ZFS_GROUP_NAMES = new Set(["logs", "cache", "spares", "special", "dedup"]);

function vdevLayout(name: string): string {
  const m = name.toLowerCase().match(/^(mirror|raidz[123]?|draid[123]?)/);
  return m ? (m[1] === "raidz" ? "raidz1" : m[1]!) : "stripe";
}

function zfsMember(d: any): WorkloadPoolMember {
  const name = str(d?.name) ?? "?";
  return {
    name: name.replace(/^\/dev\//, ""),
    device: name.startsWith("/dev/") ? name.slice(5) : null,
    serial: null, model: null,
    health: str(d?.state),
    sizeBytes: null,
    readErrors: num(d?.read), writeErrors: num(d?.write), checksumErrors: num(d?.cksum),
    errors: null, temperatureC: null, filesystem: null, mediaType: null, smart: null,
  };
}

/**
 * `/nodes/{n}/disks/zfs/{pool}` → the pool's vdev groups. Proxmox renders
 * `zpool status` as a tree: the pool's row holds its data vdevs (a mirror /
 * raidz row with disk leaves, or a bare disk leaf for a stripe); `logs`,
 * `cache`, `spares` … appear as sibling rows of the pool.
 */
export function parseProxmoxZfsGroups(detail: unknown): WorkloadPoolGroup[] {
  const root = detail as any;
  const tops = (Array.isArray(root?.children) ? root.children : []) as any[];
  const groups: WorkloadPoolGroup[] = [];
  const addVdevs = (role: string, vdevs: any[]) => {
    const stripe: WorkloadPoolMember[] = [];
    for (const v of vdevs) {
      const kids = Array.isArray(v?.children) ? v.children : [];
      if (num(v?.leaf) === 1 || kids.length === 0) { stripe.push(zfsMember(v)); continue; }
      groups.push({ role, layout: vdevLayout(str(v?.name) ?? ""), name: str(v?.name), health: str(v?.state), members: kids.map(zfsMember) });
    }
    if (stripe.length > 0) groups.push({ role, layout: role === "data" ? "stripe" : null, name: null, health: null, members: stripe });
  };
  for (const t of tops) {
    const name = str(t?.name) ?? "";
    const role = ZFS_GROUP_NAMES.has(name) ? (name === "logs" ? "log" : name === "spares" ? "spare" : name) : "data";
    addVdevs(role, Array.isArray(t?.children) ? t.children : []);
  }
  return groups;
}

/** `scan:` line of a ZFS detail ("scrub repaired 0B in 00:00:01 with 0 errors on Sun …") → the pool's last pass. */
export function parseProxmoxZfsScan(scan: unknown): WorkloadPool["scan"] {
  const s = str(scan);
  if (!s || /^none requested/i.test(s)) return null;
  const kind = /resilver/i.test(s) ? "resilver" : /scrub/i.test(s) ? "scrub" : null;
  const running = /in progress/i.test(s);
  const pct = s.match(/([\d.]+)%\s+done/i);
  const errs = s.match(/with (\d+) errors/i);
  const on = s.match(/ on (.+)$/i);
  return {
    kind,
    state: running ? "running" : /canceled/i.test(s) ? "canceled" : "finished",
    at: on ? (Number.isFinite(Date.parse(on[1]!)) ? new Date(on[1]!).toISOString() : null) : null,
    percent: pct ? Number(pct[1]) : null,
    errors: errs ? Number(errs[1]) : null,
  };
}

/** Ceph's overall health word (`HEALTH_OK` / `HEALTH_WARN` / `HEALTH_ERR`) and its first check summaries. */
export function parseProxmoxCephHealth(status: unknown): { health: string; detail: string | null } | null {
  const h = (status as any)?.health;
  const word = str(h?.status);
  if (!word) return null;
  const checks = h?.checks && typeof h.checks === "object" ? Object.values(h.checks) as any[] : [];
  const detail = checks.map((c) => str(c?.summary?.message)).filter(Boolean).slice(0, 3).join("; ");
  return { health: word, detail: detail || null };
}

const CEPH_STORAGE_TYPES = new Set(["rbd", "cephfs"]);

/**
 * A node's pools: each ZFS pool (with its health and vdev layout), plus every
 * other ACTIVE storage the node mounts (dir, LVM-thin, NFS, Ceph RBD …) as a
 * capacity row. A `zfspool` storage is the ZFS pool already listed, so it is
 * not repeated. Shared storage appears on every node that mounts it — the
 * same datastore-per-host view vCenter gives.
 */
export function parseProxmoxPools(
  storages: unknown,
  zfsPools: unknown,
  zfsDetails: ReadonlyMap<string, unknown>,
  ceph: { health: string; detail: string | null } | null,
): WorkloadPool[] {
  const pools: WorkloadPool[] = [];
  for (const z of (Array.isArray(zfsPools) ? zfsPools : []) as any[]) {
    const name = str(z?.name);
    if (!name) continue;
    const detail = zfsDetails.get(name) as any;
    const size = num(z?.size);
    const free = num(z?.free);
    pools.push({
      name,
      kind: "zfs",
      filesystem: "zfs",
      totalBytes: size,
      usedBytes: num(z?.alloc) ?? (size !== null && free !== null ? size - free : null),
      health: str(detail?.state) ?? str(z?.health),
      healthDetail: str(detail?.status) ?? (str(detail?.errors) && !/no known data errors/i.test(detail.errors) ? str(detail.errors) : null),
      scan: parseProxmoxZfsScan(detail?.scan),
      groups: detail ? parseProxmoxZfsGroups(detail) : undefined,
    });
  }
  for (const s of (Array.isArray(storages) ? storages : []) as any[]) {
    const name = str(s?.storage);
    const type = str(s?.type);
    if (!name || !type || type === "zfspool" || type === "zfs") continue;
    if (num(s?.active) !== 1 || num(s?.enabled) === 0) continue;
    const isCeph = CEPH_STORAGE_TYPES.has(type);
    pools.push({
      name,
      kind: type,
      filesystem: null,
      totalBytes: num(s?.total),
      usedBytes: num(s?.used),
      health: isCeph ? ceph?.health ?? null : null,
      healthDetail: isCeph ? ceph?.detail ?? null : null,
    });
  }
  return pools;
}

/** `/nodes/{n}/disks/list` → disks for the hardware view (no temperatures — the API publishes none). */
export function parseProxmoxDisks(list: unknown): WorkloadDisk[] {
  return ((Array.isArray(list) ? list : []) as any[]).map((d) => {
    const serial = str(d?.serial);
    return {
      name: (str(d?.devpath) ?? "?").replace(/^\/dev\//, ""),
      serial: serial && serial.toLowerCase() !== "unknown" ? serial : null,
      temperatureC: null,
      pool: null,
    };
  });
}

/** `pve-manager/9.2.2/b998…` → `9.2.2`. */
export function proxmoxVersion(pveversion: unknown): string | null {
  return str(pveversion)?.match(/pve-manager\/([\d.]+)/)?.[1] ?? null;
}

/** The last RRD row that carries data (the newest row is often still filling). */
export function lastRrdRow(rows: unknown): Record<string, number> | null {
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i] as any;
    if (r && num(r.cpu) !== null) return r as Record<string, number>;
  }
  return null;
}

/**
 * A node's live usage. CPU is the node's share of its own threads; memory is
 * split the way the agent's bands are: `used` from Proxmox counts the ZFS ARC
 * (it is total − available, and ARC is not "available"), so the ARC is carved
 * out into the cached band — used + cached + free = total.
 */
export function proxmoxNodeUsage(
  node: ProxmoxResourceNode | undefined,
  status: any,
  rrd: Record<string, number> | null,
  counters: RateCounters,
  nodeName: string,
  nowMs: number,
): WorkloadHostUsage {
  const total = num(status?.memory?.total) ?? node?.maxmem ?? null;
  const used = num(status?.memory?.used) ?? node?.mem ?? null;
  // RRD rows are per-minute averages — whole bytes only.
  const rawArc = num(rrd?.arcsize);
  const arc = rawArc === null ? null : Math.round(rawArc);
  const split = total !== null && used !== null && arc !== null && arc > 0 && arc <= used;
  const cpuFrac = node?.cpu ?? num(status?.cpu);
  // The API keeps no per-NIC counters for a node — only the RRD's node-wide
  // rate. Integrated into one cumulative row so the interface pipeline can
  // chart the node's traffic like any other interface.
  const rx = counters.advance(`${nodeName}:rx`, num(rrd?.netin), nowMs);
  const tx = counters.advance(`${nodeName}:tx`, num(rrd?.netout), nowMs);
  const interfaces: WorkloadInterfaceReading[] = rx === null && tx === null ? [] : [{
    name: "all interfaces", operUp: true, rxBytes: rx, txBytes: tx,
    rxErrors: null, txErrors: null, rxDrops: null, txDrops: null, speedMbps: null,
  }];
  return {
    cpuPct: cpuFrac === null ? null : cpuFrac * 100,
    perCorePct: null,
    memUsedBytes: split ? used! - arc! : used,
    memTotalBytes: total,
    ...(split ? { memCachedBytes: arc!, memFreeBytes: Math.max(0, total! - used!) } : {}),
    interfaces,
  };
}

/**
 * A guest's usage. CPU is its share of its own vCPU allotment (`maxcpu`) — a
 * VM's or a CPU-limited LXC's natural 0-100, the figure the guest itself
 * would report. Network is one cumulative row (the guest's NICs summed);
 * a guest that is not running reports none.
 */
export function proxmoxGuestUsage(g: ProxmoxResourceGuest): WorkloadUsage {
  const running = g.status === "running";
  return {
    cpuPct: g.cpu === null ? null : g.cpu * 100,
    memUsedBytes: g.mem,
    memTotalBytes: g.maxmem,
    interfaces: running && (g.netin !== null || g.netout !== null) ? [{
      name: "all interfaces", operUp: true, rxBytes: g.netin, txBytes: g.netout,
      rxErrors: null, txErrors: null, rxDrops: null, txDrops: null, speedMbps: null,
    }] : [],
  };
}

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Per-integration cache of guest detail, keyed by `${type}/${vmid}`. */
const guestDetailCache = new Map<string, Map<string, { at: number; detail: ProxmoxGuestDetail }>>();

function detailCacheFor(config: ProxmoxConfig): Map<string, { at: number; detail: ProxmoxGuestDetail }> {
  const key = endpointKey(config);
  let m = guestDetailCache.get(key);
  if (!m) { m = new Map(); guestDetailCache.set(key, m); }
  return m;
}

const enc = encodeURIComponent;

async function readGuestDetail(config: ProxmoxConfig, g: ProxmoxResourceGuest): Promise<ProxmoxGuestDetail> {
  const base = `/nodes/${enc(g.node)}/${g.type}/${g.vmid}`;
  const cfg = await proxmoxGet(config, `${base}/config`);
  let live: unknown = null;
  if (g.status === "running") {
    const agentOn = g.type === "lxc" || /(^|,)\s*(enabled=)?1\b/.test(String((cfg as any)?.agent ?? ""));
    if (agentOn) {
      try {
        live = await proxmoxGet(config, g.type === "lxc" ? `${base}/interfaces` : `${base}/agent/network-get-interfaces`);
      } catch (err: any) {
        // A guest agent that is configured but not running answers 500 — the
        // config's static address (if any) stands in.
        logger.debug({ vmid: g.vmid, err: err?.message }, "proxmox: guest interfaces unreadable");
      }
    }
  }
  return parseProxmoxGuestDetail(g.type, cfg, live);
}

/**
 * Guest detail for every guest: fresh reads when `refresh` (discovery) or for
 * a guest the cache has not seen / has let go stale (a monitor tick only pays
 * for new guests). A guest whose config cannot be read keeps its last detail.
 */
async function guestDetails(config: ProxmoxConfig, guests: ProxmoxResourceGuest[], refresh: boolean): Promise<{ details: Map<string, ProxmoxGuestDetail>; failed: number }> {
  const cache = detailCacheFor(config);
  const now = Date.now();
  let failed = 0;
  const todo = guests.filter((g) => {
    const hit = cache.get(`${g.type}/${g.vmid}`);
    return refresh || !hit || now - hit.at > GUEST_DETAIL_TTL_MS;
  });
  await mapWithConcurrency(todo, READ_CONCURRENCY, async (g) => {
    try {
      cache.set(`${g.type}/${g.vmid}`, { at: now, detail: await readGuestDetail(config, g) });
    } catch (err: any) {
      failed++;
      logger.debug({ vmid: g.vmid, err: err?.message }, "proxmox: guest config unreadable");
    }
  });
  const present = new Set(guests.map((g) => `${g.type}/${g.vmid}`));
  for (const k of cache.keys()) if (!present.has(k)) cache.delete(k);
  const details = new Map<string, ProxmoxGuestDetail>();
  for (const g of guests) {
    const hit = cache.get(`${g.type}/${g.vmid}`);
    if (hit) details.set(`${g.type}/${g.vmid}`, hit.detail);
  }
  return { details, failed };
}

const EMPTY_DETAIL: ProxmoxGuestDetail = { uuid: null, macs: [], ip: null, bridge: null, ostype: null, autostart: null };

/** Normalized guests from the resource list + their detail. */
export function buildProxmoxGuests(
  guests: ProxmoxResourceGuest[],
  details: ReadonlyMap<string, ProxmoxGuestDetail>,
): { vms: WorkloadVm[]; containers: WorkloadContainer[] } {
  const vms: WorkloadVm[] = [];
  const containers: WorkloadContainer[] = [];
  for (const g of guests) {
    const d = details.get(`${g.type}/${g.vmid}`) ?? EMPTY_DETAIL;
    if (g.type === "qemu") {
      vms.push({
        platformId: String(g.vmid), name: g.name, uuid: d.uuid,
        state: normalizeWorkloadState(g.status), rawState: g.status,
        cpuCount: g.maxcpu, memoryBytes: g.maxmem, ip: d.ip, macs: d.macs, autostart: d.autostart,
        hostKey: g.node,
      });
    } else {
      containers.push({
        platformId: String(g.vmid), name: g.name,
        // LXC hostnames need not be unique across a cluster; the VMID is.
        identityKey: String(g.vmid),
        image: d.ostype, state: normalizeWorkloadState(g.status), rawState: g.status,
        ip: d.ip, networkMode: d.bridge, updateAvailable: null, version: null, latestVersion: null,
        memberCount: 1, ports: [], autostart: d.autostart,
        hostKey: g.node,
      });
    }
  }
  return { vms, containers };
}

interface NodeRead {
  status: any;
  rrd: Record<string, number> | null;
  pools: WorkloadPool[];
  disks: WorkloadDisk[];
}

/** One node's reads. `withStorage` = discovery (pools + disks); a monitor tick needs status + RRD only. */
async function readNode(config: ProxmoxConfig, node: string, withStorage: boolean, ceph: { health: string; detail: string | null } | null): Promise<NodeRead> {
  const base = `/nodes/${enc(node)}`;
  const [status, rrdRows] = await Promise.all([
    proxmoxGet(config, `${base}/status`),
    proxmoxGet(config, `${base}/rrddata?timeframe=hour&cf=AVERAGE`).catch(() => null),
  ]);
  if (!withStorage) return { status, rrd: lastRrdRow(rrdRows), pools: [], disks: [] };
  const [storages, zfs, disks] = await Promise.all([
    proxmoxGet<any[]>(config, `${base}/storage`).catch(() => []),
    proxmoxGet<any[]>(config, `${base}/disks/zfs`).catch(() => []),
    proxmoxGet<any[]>(config, `${base}/disks/list`).catch(() => []),
  ]);
  const zfsDetails = new Map<string, unknown>();
  await Promise.all((Array.isArray(zfs) ? zfs : []).map(async (z: any) => {
    const name = str(z?.name);
    if (!name) return;
    zfsDetails.set(name, await proxmoxGet(config, `${base}/disks/zfs/${enc(name)}`).catch(() => null));
  }));
  return { status, rrd: lastRrdRow(rrdRows), pools: parseProxmoxPools(storages, zfs, zfsDetails, ceph), disks: parseProxmoxDisks(disks) };
}

/** A node as a host. Hardware identity is not in the API, so serial / maker / model stay null. */
export function buildProxmoxHost(
  node: ProxmoxClusterNode,
  res: ProxmoxResourceNode | undefined,
  read: NodeRead | null,
): WorkloadHost {
  const st = read?.status;
  return {
    key: node.name,
    online: node.online && (res?.online ?? true),
    hostname: node.name,
    os: "Proxmox VE",
    osVersion: proxmoxVersion(st?.pveversion),
    ip: node.ip,
    serial: null,
    manufacturer: null,
    model: str(st?.cpuinfo?.model),
    cpuCount: num(st?.cpuinfo?.cpus) ?? res?.maxcpu ?? null,
    memTotalBytes: num(st?.memory?.total) ?? res?.maxmem ?? null,
    uptimeSeconds: num(st?.uptime) ?? res?.uptime ?? null,
    pools: read?.pools ?? [],
    disks: read?.disks ?? [],
  };
}

interface ClusterRead {
  cluster: ProxmoxClusterStatus;
  resources: { nodes: ProxmoxResourceNode[]; guests: ProxmoxResourceGuest[] };
  nodeReads: Map<string, NodeRead>;
  details: Map<string, ProxmoxGuestDetail>;
  detailFailures: number;
  durationMs: number;
}

async function readCluster(config: ProxmoxConfig, opts: { withStorage: boolean; refreshGuests: boolean }): Promise<ClusterRead> {
  const started = Date.now();
  const [statusRows, resourceRows] = await Promise.all([
    proxmoxGet(config, "/cluster/status"),
    proxmoxGet(config, "/cluster/resources"),
  ]);
  const durationMs = Date.now() - started;
  const cluster = parseProxmoxClusterStatus(statusRows);
  const resources = parseProxmoxResources(resourceRows);
  // A standalone node may list itself only in /cluster/resources.
  for (const n of resources.nodes) {
    if (!cluster.nodes.some((c) => c.name === n.name)) cluster.nodes.push({ name: n.name, online: n.online, ip: null });
  }
  // Ceph health is cluster-wide; a cluster without Ceph answers an error, which is "no Ceph".
  const ceph = opts.withStorage
    ? parseProxmoxCephHealth(await proxmoxGet(config, "/cluster/ceph/status").catch(() => null))
    : null;
  const nodeReads = new Map<string, NodeRead>();
  const online = cluster.nodes.filter((n) => n.online);
  await mapWithConcurrency(online, READ_CONCURRENCY, async (n) => {
    try {
      nodeReads.set(n.name, await readNode(config, n.name, opts.withStorage, ceph));
    } catch (err: any) {
      // Online a moment ago and now not answering through its peer: the host
      // keeps its inventory figures from /cluster/resources this pass.
      logger.debug({ node: n.name, err: err?.message }, "proxmox: node read failed");
    }
  });
  const { details, failed } = await guestDetails(config, resources.guests, opts.refreshGuests);
  return { cluster, resources, nodeReads, details, detailFailures: failed, durationMs };
}

function toResult(read: ClusterRead): WorkloadDiscoveryResult {
  const resByName = new Map(read.resources.nodes.map((n) => [n.name, n]));
  const hosts = read.cluster.nodes.map((n) => buildProxmoxHost(n, resByName.get(n.name), read.nodeReads.get(n.name) ?? null));
  const { vms, containers } = buildProxmoxGuests(read.resources.guests, read.details);
  return {
    platform: "proxmox",
    hosts,
    vms,
    containers,
    // /cluster/resources lists every guest on every node — online or not — so
    // the guest list itself is complete whenever that call answered. A guest
    // whose config could not be read is still listed (its identity may fall
    // back to its name), so a partial detail read blocks the sweep instead.
    inventoryComplete: read.detailFailures === 0,
    presentVmNames: vms.map((v) => v.name),
    presentContainerNames: containers.map((c) => c.name),
  };
}

// ─── Rate counters (node traffic) ─────────────────────────────────────────────

const rateCountersByIntegration = new Map<string, RateCounters>();

function countersFor(config: ProxmoxConfig): RateCounters {
  const key = endpointKey(config);
  let c = rateCountersByIntegration.get(key);
  if (!c) { c = new RateCounters(); rateCountersByIntegration.set(key, c); }
  c.prune(Date.now() - 5 * 60_000);
  return c;
}

// ─── Public surface ──────────────────────────────────────────────────────────

export async function testConnection(config: ProxmoxConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const [version, statusRows, resourceRows] = await Promise.all([
      proxmoxGet(config, "/version"),
      proxmoxGet(config, "/cluster/status"),
      proxmoxGet(config, "/cluster/resources"),
    ]);
    const cluster = parseProxmoxClusterStatus(statusRows);
    const res = parseProxmoxResources(resourceRows);
    const nodes = Math.max(cluster.nodes.length, res.nodes.length);
    const offline = cluster.nodes.filter((n) => !n.online).length;
    const vms = res.guests.filter((g) => g.type === "qemu").length;
    const cts = res.guests.length - vms;
    const v = str((version as any)?.version);
    const where = cluster.clusterName ? `cluster "${cluster.clusterName}"` : "standalone node";
    // A token without VM.Audit / Sys.Audit still answers — with an empty list.
    const empty = nodes === 0 ? " — no nodes visible: the token needs the PVEAuditor role on /" : "";
    const quorum = cluster.quorate === false ? " — cluster has NO quorum" : "";
    return {
      ok: nodes > 0,
      message: `Connected to ${where}${v ? ` (Proxmox VE ${v})` : ""} — ${nodes} node(s)${offline ? ` (${offline} offline)` : ""}, ${vms} VM(s), ${cts} container(s)${quorum}${empty}`,
    };
  } catch (err: any) {
    return { ok: false, message: err instanceof AppError ? err.message : err?.message || "Unknown error" };
  }
}

// ─── Pools between discoveries ────────────────────────────────────────────────
// The storage stream reads pools off the host, but walking every node's
// storage and ZFS detail every 30 s would be most of the tick's cost. So a
// tick reads storage only when the last read is older than
// STORAGE_REFRESH_MS, and every other tick reuses that read.

const STORAGE_REFRESH_MS = 5 * 60_000;
const poolsByIntegration = new Map<string, { at: number; byNode: Map<string, WorkloadPool[]> }>();

function rememberPools(config: ProxmoxConfig, hosts: WorkloadHost[]): void {
  const byNode = new Map<string, WorkloadPool[]>();
  for (const h of hosts) if (h.key) byNode.set(h.key, h.pools);
  poolsByIntegration.set(endpointKey(config), { at: Date.now(), byNode });
}

export async function discoverInventory(config: ProxmoxConfig): Promise<WorkloadDiscoveryResult> {
  const result = toResult(await readCluster(config, { withStorage: true, refreshGuests: true }));
  rememberPools(config, result.hosts);
  return result;
}

/** One monitor tick: inventory (states + cached guest identity) and live usage for every node and guest. */
export async function fetchProxmoxSnapshot(config: ProxmoxConfig): Promise<WorkloadSnapshot> {
  const remembered = poolsByIntegration.get(endpointKey(config));
  const withStorage = !remembered || Date.now() - remembered.at > STORAGE_REFRESH_MS;
  const read = await readCluster(config, { withStorage, refreshGuests: false });
  const inventory = toResult(read);
  if (withStorage) rememberPools(config, inventory.hosts);
  else for (const h of inventory.hosts) if (h.key) h.pools = remembered!.byNode.get(h.key) ?? [];
  const counters = countersFor(config);
  const now = Date.now();
  const resByName = new Map(read.resources.nodes.map((n) => [n.name, n]));
  const hosts = new Map<string, WorkloadHostUsage>();
  for (const n of read.cluster.nodes) {
    if (!n.online) continue;
    const nr = read.nodeReads.get(n.name);
    hosts.set(workloadHostUsageKey(n.name), proxmoxNodeUsage(resByName.get(n.name), nr?.status, nr?.rrd ?? null, counters, n.name, now));
  }
  const vmUsage = new Map<string, WorkloadUsage>();
  const containerUsage = new Map<string, WorkloadUsage>();
  for (const g of read.resources.guests) {
    (g.type === "qemu" ? vmUsage : containerUsage).set(String(g.vmid), proxmoxGuestUsage(g));
  }
  return { fetchedAt: now, durationMs: read.durationMs, inventory, hosts, vmUsage, containerUsage };
}

/**
 * Read-only path allow-list for the Query API modal: GETs under the prefixes
 * an operator needs to answer "why wasn't X discovered", never anything else
 * (the transport only issues GET, so this bounds WHAT is read, not how).
 */
const PROXY_PATH_RE = /^\/(version|cluster\/(status|resources|ha\/status\/current|ceph\/status)|nodes(\/[A-Za-z0-9._-]+(\/(status|network|storage|disks\/(list|zfs(\/[A-Za-z0-9._-]+)?)|rrddata|(qemu|lxc)(\/\d+(\/(config|status\/current|interfaces|agent\/network-get-interfaces|agent\/get-osinfo))?)?))?)?)(\?[A-Za-z0-9=&_.-]*)?$/;

export function isProxyReadPath(path: string): boolean {
  return PROXY_PATH_RE.test(path);
}

export async function proxyQuery(config: ProxmoxConfig, path: string): Promise<unknown> {
  const p = path.startsWith("/") ? path : `/${path}`;
  if (!isProxyReadPath(p)) throw new AppError(400, `Not an allowed read path: ${p}`);
  return proxmoxGet(config, p);
}
