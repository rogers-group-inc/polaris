/**
 * src/services/truenasService.ts
 *
 * TrueNAS SCALE integration — the host, its VMs and its Apps, read through the
 * versioned JSON-RPC 2.0 over WebSocket API (`wss://<host>/api/current`,
 * TrueNAS 25.04+; the REST API is deprecated in 25.10 and removed in 26.04).
 * Authenticated with `auth.login_with_api_key`. A key carries the permissions
 * of the user it belongs to: a "Readonly Admin" user is enough for discovery
 * and monitoring; the workload actions need APPS_WRITE / VM_WRITE ("Full
 * Admin"). Setup steps: the General-tab tip in public/js/integrations.js and
 * docs/wiki/Integration-TrueNAS.md.
 *
 * A TrueNAS "container" asset is an APP: a compose project that may run
 * several Docker containers, and the unit TrueNAS itself starts, stops and
 * upgrades. Its usage is the `app.stats` event's per-app figure.
 *
 * Live usage comes from two EVENT sources rather than methods —
 * `reporting.realtime` (host CPU per core, memory, interface link state) and
 * `app.stats` (per-app CPU / memory) — so a snapshot subscribes to both,
 * takes the first event of each, and closes. Every call in one discovery or
 * snapshot rides ONE socket and ONE login.
 *
 * Long-running actions (app.start / stop / upgrade, vm.start / stop) are
 * JOBS: the call returns a job id, and `waitForJob` polls `core.get_jobs`
 * until it settles.
 *
 * Output is the shared WorkloadDiscoveryResult / WorkloadSnapshot shape
 * (services/discovery/workloadSync.ts); this file knows TrueNAS, nothing else.
 */

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
  WorkloadPoolGroup,
  WorkloadPoolMember,
  WorkloadPoolScan,
  WorkloadSnapshot,
  WorkloadUsage,
  WorkloadVm,
} from "./discovery/workloadSync.js";

export interface TrueNasConfig {
  host: string;
  port?: number;
  /** wss:// (default) or ws:// — TrueNAS redirects HTTP to HTTPS unless told otherwise. */
  useTls?: boolean;
  verifyTls?: boolean;
  /** The TrueNAS API key (stored under the sealed `apiToken` config key). */
  apiToken: string;
  vmInclude?: string[];
  vmExclude?: string[];
  containerInclude?: string[];
  containerExclude?: string[];
}

const CALL_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;
const EVENT_WINDOW_MS = 6_000;
const JOB_POLL_MS = 2_000;

function defaultPort(config: TrueNasConfig): number {
  return config.port || (config.useTls === false ? 80 : 443);
}

// ─── Session ─────────────────────────────────────────────────────────────────

function translateSocketError(err: any, config: TrueNasConfig): AppError {
  const code = err?.code;
  const where = `${config.host}:${defaultPort(config)}`;
  if (code === "ECONNREFUSED") return new AppError(502, `Connection refused — ${where}`);
  if (code === "ENOTFOUND") return new AppError(502, `Host not found — ${config.host}`);
  if (code === "ETIMEDOUT") return new AppError(504, `Connection timed out — ${where}`);
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" || code === "CERT_HAS_EXPIRED" || code === "ERR_TLS_CERT_ALTNAME_INVALID"
  ) {
    return new AppError(502, `TLS certificate error (${code}) — try disabling TLS verification`);
  }
  if (/Unexpected server response: 404/.test(String(err?.message))) {
    return new AppError(502, "No /api/current endpoint — the JSON-RPC API needs TrueNAS SCALE 25.04 or later");
  }
  return new AppError(502, err?.message || "TrueNAS connection error");
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/**
 * One authenticated JSON-RPC socket. Not reused across ticks: every caller
 * opens one, does its work, and closes it in `finally` — the snapshot cache
 * above it is what bounds how often that happens.
 */
export class TrueNasSession {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Array<(fields: any) => void>>();
  private closedErr: Error | null = null;

  constructor(private readonly config: TrueNasConfig) {}

  async open(): Promise<void> {
    const useTls = this.config.useTls !== false;
    const url = `${useTls ? "wss" : "ws"}://${this.config.host}:${defaultPort(this.config)}/api/current`;
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        ...(useTls ? { rejectUnauthorized: this.config.verifyTls !== false } : {}),
        handshakeTimeout: CONNECT_TIMEOUT_MS,
      });
      this.ws = ws;
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(translateSocketError(err, this.config)));
      ws.on("message", (buf) => this.onMessage(String(buf)));
      ws.on("close", () => {
        this.closedErr = new AppError(502, "TrueNAS closed the connection");
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(this.closedErr); }
        this.pending.clear();
      });
    });
    let ok: unknown;
    try {
      ok = await this.call("auth.login_with_api_key", [this.config.apiToken]);
    } catch (err: any) {
      throw new AppError(502, `TrueNAS rejected the API key — ${err?.message || "login failed"}`);
    }
    if (ok !== true) {
      throw new AppError(502, "TrueNAS rejected the API key (revoked, expired, or sent over plain HTTP — TrueNAS revokes a key used without TLS)");
    }
  }

  private onMessage(raw: string): void {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.method === "collection_update") {
      const coll = String(msg.params?.collection ?? "");
      for (const fn of this.listeners.get(coll) ?? []) fn(msg.params?.fields);
      return;
    }
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const reason = msg.error?.data?.reason || msg.error?.message || "method call error";
      p.reject(new AppError(502, String(reason).trim()));
    } else {
      p.resolve(msg.result);
    }
  }

  call<T = any>(method: string, params: unknown[] = [], timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new AppError(502, "TrueNAS socket is not open"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError(504, `TrueNAS call timed out (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  /**
   * Subscribe to an event source and resolve with its first payload, or null
   * when nothing arrives inside the window (the source is then simply absent
   * from this snapshot — never an error).
   */
  async firstEvent(name: string, windowMs = EVENT_WINDOW_MS): Promise<any | null> {
    const collection = name.split(":")[0];
    return await new Promise<any | null>((resolve) => {
      let settled = false;
      const settle = (v: any | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.listeners.set(collection, (this.listeners.get(collection) ?? []).filter((f) => f !== listener));
        resolve(v);
      };
      const listener = (fields: any) => settle(fields ?? null);
      const timer = setTimeout(() => settle(null), windowMs);
      this.listeners.set(collection, [...(this.listeners.get(collection) ?? []), listener]);
      this.call("core.subscribe", [name]).catch((err) => {
        logger.debug({ err: err?.message, name }, "truenas: subscribe failed");
        settle(null);
      });
    });
  }

  /** Poll a job to completion; resolves with its result, rejects with its error. */
  async waitForJob(jobId: number, timeoutMs: number): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await this.call<any[]>("core.get_jobs", [[["id", "=", jobId]]]);
      const job = rows?.[0];
      const state = String(job?.state ?? "");
      if (state === "SUCCESS") return job.result;
      if (state === "FAILED" || state === "ABORTED") {
        throw new AppError(502, String(job?.error || job?.exception || `job ${state.toLowerCase()}`).split("\n")[0]);
      }
      await new Promise((r) => setTimeout(r, JOB_POLL_MS));
    }
    throw new AppError(504, `TrueNAS job ${jobId} did not finish in ${Math.round(timeoutMs / 1000)}s — it may still be running on the host`);
  }

  close(): void {
    try { this.ws?.close(); } catch { /* noop */ }
    this.ws = null;
  }
}

async function withSession<T>(config: TrueNasConfig, fn: (s: TrueNasSession) => Promise<T>): Promise<T> {
  if (!config?.host) throw new AppError(400, "Host is required");
  if (!config.apiToken) throw new AppError(400, "API key is required");
  const session = new TrueNasSession(config);
  try {
    await session.open();
    return await fn(session);
  } finally {
    session.close();
  }
}

// ─── Parsing (pure; exported for tests) ──────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** "TrueNAS-SCALE-25.10.1" / "25.10.1" → "25.10.1". */
export function truenasVersion(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = s.match(/(\d+\.\d+(?:\.\d+)*(?:[-.]\w+)?)$/);
  return m ? m[1] : s;
}

export function parseTrueNasHost(
  info: any,
  pools: any[],
  temps: Record<string, unknown> | null,
  disks: any[],
  config: Pick<TrueNasConfig, "host">,
): WorkloadHost {
  const product = str(info?.system_product);
  return {
    hostname: str(info?.hostname),
    os: "TrueNAS SCALE",
    osVersion: truenasVersion(info?.version),
    ip: config.host,
    serial: str(info?.system_serial),
    manufacturer: str(info?.system_manufacturer),
    // `model` on system.info is the CPU model; the machine is system_product.
    model: product,
    cpuCount: num(info?.cores),
    memTotalBytes: num(info?.physmem),
    uptimeSeconds: num(info?.uptime_seconds),
    pools: parseTrueNasPools(pools, trueNasDiskFacts(temps, disks)),
    disks: parseTrueNasDisks(temps, disks),
  };
}

/** Per-disk facts from disk.query / disk.temperatures, keyed by disk name ("sda"). */
export interface TrueNasDiskFacts {
  serial: string | null;
  model: string | null;
  sizeBytes: number | null;
  mediaType: string | null;
  temperatureC: number | null;
}

const ZFS_GROUP_ROLES = ["data", "special", "dedup", "log", "cache", "spare"] as const;

/** ZFS's `{ $date: ms }` / ISO / epoch-seconds times → ISO. */
function zfsTime(v: unknown): string | null {
  const raw = v && typeof v === "object" && "$date" in (v as any) ? (v as any).$date : v;
  const n = num(raw);
  if (n !== null) return new Date(n > 1e12 ? n : n * 1000).toISOString();
  const s = str(raw);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function zfsScan(scan: any): WorkloadPoolScan | null {
  if (!scan || typeof scan !== "object") return null;
  const kind = str(scan.function)?.toLowerCase() ?? null;
  const state = str(scan.state)?.toLowerCase() ?? null;
  if (!kind && !state) return null;
  const running = state === "scanning";
  return {
    kind,
    state: running ? "running" : state,
    at: zfsTime(running ? scan.start_time : (scan.end_time ?? scan.start_time)),
    percent: running ? num(scan.percentage) : null,
    errors: num(scan.errors),
  };
}

/** One leaf (a disk) of a vdev. `disk` is the whole-disk name, `device` the partition ZFS uses. */
function zfsMember(leaf: any, facts: ReadonlyMap<string, TrueNasDiskFacts>): WorkloadPoolMember {
  const diskName = str(leaf?.disk);
  const f = diskName ? facts.get(diskName) : undefined;
  const st = leaf?.stats ?? {};
  return {
    name: diskName ?? str(leaf?.unavail_disk?.name) ?? str(leaf?.name) ?? "?",
    device: str(leaf?.device),
    serial: f?.serial ?? null,
    model: f?.model ?? null,
    health: str(leaf?.status),
    sizeBytes: f?.sizeBytes ?? num(st.size),
    readErrors: num(st.read_errors),
    writeErrors: num(st.write_errors),
    checksumErrors: num(st.checksum_errors),
    errors: null,
    temperatureC: f?.temperatureC ?? null,
    filesystem: null,
    mediaType: f?.mediaType ?? null,
    smart: null,
  };
}

/**
 * pool.query `topology` → groups. A top-level entry of type DISK is a vdev of
 * one disk (no redundancy — "stripe"); MIRROR / RAIDZn / DRAID carry their
 * disks as children.
 */
export function parseZfsTopology(topology: any, facts: ReadonlyMap<string, TrueNasDiskFacts> = new Map()): WorkloadPoolGroup[] {
  if (!topology || typeof topology !== "object") return [];
  const groups: WorkloadPoolGroup[] = [];
  for (const role of ZFS_GROUP_ROLES) {
    for (const vdev of (Array.isArray(topology[role]) ? topology[role] : []) as any[]) {
      const type = (str(vdev?.type) ?? "").toUpperCase();
      const children = Array.isArray(vdev?.children) ? vdev.children : [];
      const isLeaf = type === "DISK" || children.length === 0;
      groups.push({
        role,
        layout: isLeaf ? (role === "data" ? "stripe" : null) : type.toLowerCase(),
        name: isLeaf ? null : str(vdev?.name),
        health: str(vdev?.status),
        members: (isLeaf ? [vdev] : children).map((c: any) => zfsMember(c, facts)),
      });
    }
  }
  return groups;
}

export function parseTrueNasPools(pools: any[], facts: ReadonlyMap<string, TrueNasDiskFacts> = new Map()): WorkloadPool[] {
  return (pools ?? [])
    .filter((p) => str(p?.name))
    .map((p) => {
      const pool: WorkloadPool = {
        name: String(p.name),
        kind: "zfs",
        totalBytes: num(p?.size),
        usedBytes: num(p?.allocated),
        health: str(p?.status),
      };
      // Layout only when the answer carried a topology — an older or trimmed
      // answer leaves the pool as it always was.
      if (p?.topology && typeof p.topology === "object") {
        pool.filesystem = "zfs";
        pool.healthDetail = str(p?.status_detail);
        pool.scan = zfsScan(p?.scan);
        pool.groups = parseZfsTopology(p.topology, facts);
      }
      return pool;
    });
}

/** disk.query rows + disk.temperatures → facts keyed by disk name. */
export function trueNasDiskFacts(temps: Record<string, unknown> | null, disks: any[]): Map<string, TrueNasDiskFacts> {
  const out = new Map<string, TrueNasDiskFacts>();
  for (const d of parseTrueNasDisks(temps, disks)) {
    const row = (disks ?? []).find((x) => str(x?.name) === d.name);
    const type = str(row?.type)?.toUpperCase() ?? null;
    out.set(d.name, {
      serial: d.serial,
      model: str(row?.model),
      sizeBytes: num(row?.size),
      mediaType: type === "SSD" && /^nvme/i.test(d.name) ? "NVMe" : type,
      temperatureC: d.temperatureC,
    });
  }
  return out;
}

/**
 * disk.temperatures answers `{ sda: 34 }` or, with thresholds,
 * `{ sda: { temperature: 34, ... } }`; tolerate both. disk.query supplies the
 * serial and pool when it was readable.
 */
export function parseTrueNasDisks(temps: Record<string, unknown> | null, disks: any[]): WorkloadDisk[] {
  const byName = new Map<string, any>((disks ?? []).filter((d) => str(d?.name)).map((d) => [String(d.name), d]));
  const names = new Set<string>([...Object.keys(temps ?? {}), ...byName.keys()]);
  const out: WorkloadDisk[] = [];
  for (const name of names) {
    const raw = (temps ?? {})[name];
    const t = typeof raw === "object" && raw !== null ? num((raw as any).temperature) : num(raw);
    const d = byName.get(name);
    out.push({ name, serial: str(d?.serial), temperatureC: t !== null && t > 0 ? t : null, pool: str(d?.pool) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseTrueNasVms(vms: any[]): WorkloadVm[] {
  return (vms ?? [])
    .filter((v) => v?.id !== undefined && v?.id !== null && str(v?.name))
    .map((v) => {
      const macs = ((v.devices ?? []) as any[])
        .filter((d) => String(d?.attributes?.dtype ?? d?.dtype ?? "").toUpperCase() === "NIC")
        .map((d) => str(d?.attributes?.mac))
        .filter((m): m is string => !!m);
      const memMiB = num(v.memory);
      const raw = str(v.status?.state);
      return {
        platformId: String(v.id),
        name: String(v.name),
        uuid: str(v.uuid)?.toLowerCase() ?? null,
        state: normalizeWorkloadState(raw),
        rawState: raw,
        cpuCount: (num(v.vcpus) ?? 1) * (num(v.cores) ?? 1) * (num(v.threads) ?? 1),
        memoryBytes: memMiB === null ? null : memMiB * 1024 * 1024,
        ip: null,
        macs,
        autostart: typeof v.autostart === "boolean" ? v.autostart : null,
      };
    });
}

/**
 * active_workloads.networks is docker's own network objects, passed through.
 * Compose's per-project "<app>_default" network is noise next to a named one,
 * but it is still the App's network when it is the only one.
 */
export function appNetworkNames(networks: unknown): string | null {
  const names = (Array.isArray(networks) ? networks : [])
    .map((n: any) => str(n?.Name ?? n?.name))
    .filter((n): n is string => !!n);
  if (names.length === 0) return null;
  const named = names.filter((n) => !/_default$/.test(n));
  return [...new Set(named.length > 0 ? named : names)].join(", ");
}

export function parseTrueNasApps(apps: any[]): WorkloadContainer[] {
  return (apps ?? [])
    .filter((a) => str(a?.name))
    .map((a) => {
      const wl = a.active_workloads ?? {};
      const details = (wl.container_details ?? []) as any[];
      const images = ((wl.images ?? []) as unknown[]).filter((i): i is string => typeof i === "string");
      const ports: string[] = [];
      for (const p of (wl.used_ports ?? []) as any[]) {
        for (const hp of (p?.host_ports ?? []) as any[]) {
          if (hp?.host_port) ports.push(`${hp.host_ip && hp.host_ip !== "0.0.0.0" ? hp.host_ip : "*"}:${hp.host_port}`);
        }
      }
      const raw = str(a.state);
      // A catalog app reports upgrade_available; a custom app only ever
      // image_updates_available. Either is "an update is waiting".
      const updateAvailable = a.upgrade_available === true || a.image_updates_available === true
        ? true
        : (typeof a.upgrade_available === "boolean" || typeof a.image_updates_available === "boolean") ? false : null;
      return {
        platformId: String(a.name),
        name: String(a.name),
        image: str(details[0]?.image) ?? images[0] ?? null,
        state: normalizeWorkloadState(raw),
        rawState: raw,
        ip: null,
        networkMode: appNetworkNames(wl.networks),
        updateAvailable,
        version: str(a.human_version) ?? str(a.version),
        latestVersion: str(a.latest_version),
        memberCount: num(wl.containers) ?? (details.length || null),
        ports: [...new Set(ports)],
        autostart: null,
      };
    });
}

/**
 * reporting.realtime → host usage.
 *
 * Interfaces: TrueNAS publishes link state, speed and `received_bytes_rate` /
 * `sent_bytes_rate` (bytes per second) — no counters, no errors, no drops.
 * With `counters` the rates are integrated into running byte counters (see
 * RateCounters), which is the shape the interface pipeline charts; without
 * them the traffic columns stay null. Errors and drops are null: TrueNAS does
 * not report them, and null is "not reported", not zero.
 *
 * Memory is split the way TrueNAS's own dashboard splits it: ZFS Cache is the
 * ARC (`arc_size`), Free is `physical_memory_available`, and Services is the
 * rest. Linux does not count the ARC as available, so total − available alone
 * read every NAS as nearly full — "used" here excludes the ARC, which is
 * reclaimable, and it rides the separate `cached` band instead.
 */
export function parseTrueNasRealtime(
  fields: any,
  counters?: RateCounters,
  nowMs: number = Date.now(),
): WorkloadUsage & { interfaces: WorkloadInterfaceReading[] } {
  const cpu = fields?.cpu ?? {};
  const cores = Object.keys(cpu)
    .filter((k) => /^cpu\d+$/.test(k))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    .map((k) => num(cpu[k]?.usage) ?? 0);
  const total = num(fields?.memory?.physical_memory_total);
  const avail = num(fields?.memory?.physical_memory_available);
  const arc = num(fields?.memory?.arc_size);
  const interfaces: WorkloadInterfaceReading[] = Object.entries((fields?.interfaces ?? {}) as Record<string, any>).map(([name, i]) => ({
    name,
    operUp: i?.link_state === "LINK_STATE_UP" ? true : i?.link_state === "LINK_STATE_DOWN" ? false : null,
    rxBytes: counters ? counters.advance(`host|${name}|rx`, num(i?.received_bytes_rate), nowMs) : null,
    txBytes: counters ? counters.advance(`host|${name}|tx`, num(i?.sent_bytes_rate), nowMs) : null,
    rxErrors: null,
    txErrors: null,
    rxDrops: null,
    txDrops: null,
    speedMbps: num(i?.speed),
  }));
  let memUsedBytes: number | null = null;
  let memCachedBytes: number | null = null;
  let memFreeBytes: number | null = null;
  if (total !== null && avail !== null) {
    const free = Math.min(total, Math.max(0, avail));
    const cache = arc !== null ? Math.min(total - free, Math.max(0, arc)) : null;
    memUsedBytes = total - free - (cache ?? 0);
    if (cache !== null) {
      memCachedBytes = cache;
      memFreeBytes = free;
    }
  }
  return {
    cpuPct: num(cpu.cpu?.usage),
    perCorePct: cores.length > 0 ? cores : null,
    memUsedBytes,
    memTotalBytes: total,
    memCachedBytes,
    memFreeBytes,
    interfaces,
  };
}

/**
 * app.stats `fields` (an array of per-app rows) → usage keyed by app name.
 *
 * `cpu_usage` is already a share of the whole host — TrueNAS divides by its
 * core count — so it is NOT divided again (Unraid's docker figure is).
 *
 * `networks[]` carries `rx_bytes` / `tx_bytes` as bytes PER SECOND over
 * TrueNAS's own sampling interval, not counters. The interface pipeline
 * derives rates from cumulative counters, so each rate is integrated into a
 * running counter (`counters`, kept by the caller across ticks): the rate
 * Polaris then derives between two ticks is the rate TrueNAS reported at the
 * later one.
 */
export function parseTrueNasAppStats(
  fields: any,
  counters?: RateCounters,
  nowMs: number = Date.now(),
): Map<string, WorkloadUsage> {
  const out = new Map<string, WorkloadUsage>();
  const rows = Array.isArray(fields) ? fields : Array.isArray(fields?.fields) ? fields.fields : [];
  for (const r of rows) {
    const name = str(r?.app_name);
    if (!name) continue;
    const usage: WorkloadUsage = { cpuPct: num(r?.cpu_usage), memUsedBytes: num(r?.memory), memTotalBytes: null };
    if (counters && Array.isArray(r?.networks) && r.networks.length > 0) {
      usage.interfaces = (r.networks as any[])
        .filter((n) => str(n?.interface_name))
        .map((n) => {
          const iface = String(n.interface_name);
          return {
            name: iface,
            operUp: true,
            rxBytes: counters.advance(`${name}|${iface}|rx`, num(n?.rx_bytes), nowMs),
            txBytes: counters.advance(`${name}|${iface}|tx`, num(n?.tx_bytes), nowMs),
            rxErrors: null,
            txErrors: null,
            rxDrops: null,
            txDrops: null,
            speedMbps: null,
          };
        });
    }
    out.set(name, usage);
  }
  return out;
}

/** Past this gap a counter restarts at 0 rather than invent the traffic in between. */
const RATE_COUNTER_MAX_GAP_MS = 5 * 60_000;

/**
 * Integrates per-second rates into cumulative counters, per key. A gap longer
 * than RATE_COUNTER_MAX_GAP_MS (the monitor was down, the App was stopped)
 * restarts the counter at 0, which the interface pipeline reads as a counter
 * reset — a missing point, never a spike.
 */
export class RateCounters {
  private readonly state = new Map<string, { total: number; at: number }>();

  advance(key: string, ratePerSec: number | null, nowMs: number): number | null {
    if (ratePerSec === null || ratePerSec < 0) return null;
    const prev = this.state.get(key);
    const elapsed = prev ? nowMs - prev.at : 0;
    const total = prev && elapsed > 0 && elapsed <= RATE_COUNTER_MAX_GAP_MS
      ? prev.total + Math.round(ratePerSec * (elapsed / 1000))
      : 0;
    this.state.set(key, { total, at: nowMs });
    return total;
  }

  /** Forget keys not advanced since `cutoffMs` (Apps that went away). */
  prune(cutoffMs: number): void {
    for (const [k, v] of this.state) if (v.at < cutoffMs) this.state.delete(k);
  }
}

/**
 * One RateCounters per TrueNAS host (its interfaces and its Apps' networks),
 * for the life of the process — only the monitor role takes snapshots.
 */
const rateCountersByHost = new Map<string, RateCounters>();

function countersFor(host: string): RateCounters {
  let counters = rateCountersByHost.get(host);
  if (!counters) { counters = new RateCounters(); rateCountersByHost.set(host, counters); }
  counters.prune(Date.now() - RATE_COUNTER_MAX_GAP_MS);
  return counters;
}

function appUsageWithCounters(host: string, appStats: unknown): Map<string, WorkloadUsage> {
  return parseTrueNasAppStats(appStats, countersFor(host), Date.now());
}

// ─── Reads ───────────────────────────────────────────────────────────────────

interface RawRead {
  info: any;
  pools: any[];
  apps: any[];
  vms: any[];
  temps: Record<string, unknown> | null;
  disks: any[];
  appsFailed: boolean;
  vmsFailed: boolean;
}

/**
 * The inventory read. system.info is required (it IS the connection check);
 * everything else degrades on its own. Apps or VMs that fail to read mark the
 * inventory incomplete — an Apps service that is unconfigured (no pool chosen)
 * answers with an error, and that must not read as "every App was deleted".
 */
async function readRaw(s: TrueNasSession): Promise<RawRead> {
  const info = await s.call("system.info");
  const soft = async <T>(method: string, params: unknown[], fallback: T): Promise<{ v: T; failed: boolean }> => {
    try {
      return { v: (await s.call<T>(method, params)) ?? fallback, failed: false };
    } catch (err: any) {
      logger.debug({ err: err?.message, method }, "truenas: soft read failed");
      return { v: fallback, failed: true };
    }
  };
  const [pools, apps, vms, temps, disks] = await Promise.all([
    soft<any[]>("pool.query", [], []),
    soft<any[]>("app.query", [], []),
    soft<any[]>("vm.query", [], []),
    soft<Record<string, unknown> | null>("disk.temperatures", [[]], null),
    soft<any[]>("disk.query", [[], { select: ["name", "serial", "pool", "model", "size", "type"] }], []),
  ]);
  return {
    info, pools: pools.v, apps: apps.v, vms: vms.v, temps: temps.v, disks: disks.v,
    appsFailed: apps.failed, vmsFailed: vms.failed,
  };
}

function toResult(raw: RawRead, config: TrueNasConfig): WorkloadDiscoveryResult {
  const vms = parseTrueNasVms(raw.vms);
  const containers = parseTrueNasApps(raw.apps);
  return {
    platform: "truenas",
    host: parseTrueNasHost(raw.info, raw.pools, raw.temps, raw.disks, config),
    vms,
    containers,
    inventoryComplete: !raw.appsFailed && !raw.vmsFailed,
    presentVmNames: vms.map((v) => v.name),
    presentContainerNames: containers.map((c) => c.name),
  };
}

// ─── Public surface ──────────────────────────────────────────────────────────

export async function testConnection(config: TrueNasConfig): Promise<{ ok: boolean; message: string }> {
  try {
    return await withSession(config, async (s) => {
      const raw = await readRaw(s);
      const host = raw.info?.hostname || config.host;
      const version = truenasVersion(raw.info?.version);
      const apps = raw.appsFailed ? "Apps unreadable (Apps not configured, or the key lacks APPS_READ)" : `${raw.apps.length} App(s)`;
      const vms = raw.vmsFailed ? "VMs unreadable (the key lacks VM_READ)" : `${raw.vms.length} VM(s)`;
      return { ok: true, message: `Connected to ${host}${version ? ` (TrueNAS ${version})` : ""} — ${apps}, ${vms}, ${raw.pools.length} pool(s)` };
    });
  } catch (err: any) {
    return { ok: false, message: err instanceof AppError ? err.message : err?.message || "Unknown error" };
  }
}

export async function discoverInventory(config: TrueNasConfig): Promise<WorkloadDiscoveryResult> {
  return withSession(config, async (s) => toResult(await readRaw(s), config));
}

/** One monitor tick's worth: inventory + host usage + per-App usage, one socket. */
export async function fetchTrueNasSnapshot(config: TrueNasConfig): Promise<WorkloadSnapshot> {
  return withSession(config, async (s) => {
    const started = Date.now();
    const raw = await readRaw(s);
    const durationMs = Date.now() - started;
    const [realtime, appStats] = await Promise.all([
      s.firstEvent("reporting.realtime"),
      raw.apps.length > 0 ? s.firstEvent("app.stats") : Promise.resolve(null),
    ]);
    const vmUsage = new Map<string, WorkloadUsage>();
    return {
      fetchedAt: Date.now(),
      durationMs,
      inventory: toResult(raw, config),
      host: realtime
        ? parseTrueNasRealtime(realtime, countersFor(config.host), Date.now())
        : { cpuPct: null, perCorePct: null, memUsedBytes: null, memTotalBytes: num(raw.info?.physmem), interfaces: [] },
      vmUsage,
      containerUsage: appStats ? appUsageWithCounters(config.host, appStats) : new Map(),
    };
  });
}

/**
 * Read-only method allow-list for the Query API modal. TrueNAS has no
 * read/write split in its method names beyond convention, so the modal gets
 * the conventional read verbs and an explicit list, never an arbitrary call.
 */
const PROXY_READ_SUFFIXES = [".query", ".get_instance", ".config", ".info", ".status", ".upgrade_summary", ".temperatures"];
const PROXY_READ_METHODS = new Set(["system.info", "system.version", "system.host_id", "disk.temperatures", "core.get_jobs", "auth.me"]);

export function isProxyReadMethod(method: string): boolean {
  if (PROXY_READ_METHODS.has(method)) return true;
  return PROXY_READ_SUFFIXES.some((s) => method.endsWith(s));
}

export async function proxyQuery(config: TrueNasConfig, method: string, params: unknown[] = []): Promise<unknown> {
  const m = String(method ?? "").trim();
  if (!/^[a-z0-9_.]+$/i.test(m)) throw new AppError(400, "Method must be a TrueNAS method name, e.g. app.query");
  if (!isProxyReadMethod(m)) {
    throw new AppError(400, `Only read methods can be run here (…${PROXY_READ_SUFFIXES.join(", …")}) — "${m}" is refused`);
  }
  if (!Array.isArray(params)) throw new AppError(400, "Params must be a JSON array");
  return withSession(config, (s) => s.call(m, params));
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export type TrueNasAppVerb = "start" | "stop" | "restart" | "update";
export type TrueNasVmVerb = "start" | "stop" | "restart";

const APP_JOB_TIMEOUT_MS = 15 * 60_000;
const VM_JOB_TIMEOUT_MS = 5 * 60_000;

async function runJob(s: TrueNasSession, method: string, params: unknown[], timeoutMs: number): Promise<void> {
  const jobId = await s.call<number>(method, params);
  if (typeof jobId === "number") await s.waitForJob(jobId, timeoutMs);
}

/**
 * Start / stop / restart / update one App. Restart is `app.redeploy` (TrueNAS
 * has no restart verb; redeploy recreates the App's containers). Update is
 * `app.upgrade` to the latest catalog version when one is offered, else
 * `app.pull_images` with redeploy — a custom App only ever has image updates.
 */
export async function appAction(config: TrueNasConfig, appName: string, verb: TrueNasAppVerb): Promise<void> {
  await withSession(config, async (s) => {
    if (verb === "start") return runJob(s, "app.start", [appName], APP_JOB_TIMEOUT_MS);
    if (verb === "stop") return runJob(s, "app.stop", [appName], APP_JOB_TIMEOUT_MS);
    if (verb === "restart") return runJob(s, "app.redeploy", [appName], APP_JOB_TIMEOUT_MS);
    const rows = await s.call<any[]>("app.query", [[["name", "=", appName]]]);
    const app = rows?.[0];
    if (!app) throw new AppError(404, `TrueNAS has no App named "${appName}"`);
    if (app.upgrade_available === true) {
      return runJob(s, "app.upgrade", [appName, { app_version: "latest" }], APP_JOB_TIMEOUT_MS);
    }
    if (app.image_updates_available === true) {
      return runJob(s, "app.pull_images", [appName, { redeploy: true }], APP_JOB_TIMEOUT_MS);
    }
    throw new AppError(409, `"${appName}" has no update available`);
  });
}

/** Start / stop / restart one VM (`id` = the numeric VM id as a string). A stop is graceful. */
export async function vmAction(config: TrueNasConfig, id: string, verb: TrueNasVmVerb): Promise<void> {
  const vmId = Number(id);
  if (!Number.isInteger(vmId)) throw new AppError(400, `Invalid TrueNAS VM id "${id}"`);
  await withSession(config, async (s) => {
    if (verb === "start") {
      // vm.start is a plain method in some releases and a job in others.
      const r = await s.call("vm.start", [vmId], VM_JOB_TIMEOUT_MS);
      if (typeof r === "number") await s.waitForJob(r, VM_JOB_TIMEOUT_MS);
      return;
    }
    if (verb === "stop") return runJob(s, "vm.stop", [vmId, { force: false, force_after_timeout: true }], VM_JOB_TIMEOUT_MS);
    return runJob(s, "vm.restart", [vmId], VM_JOB_TIMEOUT_MS);
  });
}

/** Re-read update availability (TrueNAS re-checks the catalog / image digests itself). */
export async function refreshUpdateChecks(config: TrueNasConfig): Promise<void> {
  await withSession(config, async (s) => {
    try {
      await runJob(s, "catalog.sync", [], APP_JOB_TIMEOUT_MS);
    } catch (err: any) {
      // A key without CATALOG_WRITE cannot sync; the App list still carries
      // TrueNAS's own last check, which is what discovery reads.
      logger.debug({ err: err?.message }, "truenas: catalog.sync refused");
    }
  });
}
