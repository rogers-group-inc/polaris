/**
 * src/services/unraidService.ts
 *
 * Unraid integration — the host, its VMs and its Docker containers, read
 * through the GraphQL API built into Unraid 7.2+ (`/graphql`, an API key in the
 * `x-api-key` header; create one under Settings → Management Access → API Keys
 * with the Viewer role, or a role that may start / stop / update containers
 * and VMs when the workload actions are wanted).
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

const CONTAINER_STATS_SUBSCRIPTION = `subscription PolarisContainerStats {
  dockerContainerStats { id cpuPercent memUsage memPercent }
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
 * A container's own address: the first IP on a network that is not the
 * shared bridge / host stack. A bridged container answers on its host's
 * address, so it gets none (two assets must not claim one IP).
 */
export function containerOwnIp(networkMode: string | null, networkSettings: unknown): string | null {
  const mode = (networkMode ?? "").toLowerCase();
  if (mode === "host" || mode === "none" || mode.startsWith("container:")) return null;
  const nets = (networkSettings as any)?.Networks ?? (networkSettings as any)?.networks;
  if (!nets || typeof nets !== "object") return null;
  for (const [name, n] of Object.entries(nets as Record<string, any>)) {
    if (name === "bridge" || name === "host") continue;
    const ip = str(n?.IPAddress ?? n?.ipAddress);
    if (ip) return ip;
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
      ip: containerOwnIp(str(c?.hostConfig?.networkMode), c?.networkSettings),
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
): Promise<Map<string, WorkloadUsage>> {
  const out = new Map<string, WorkloadUsage>();
  if (expectedIds.size === 0) return out;
  const useTls = config.useTls !== false;
  const url = `${useTls ? "wss" : "ws"}://${config.host}:${defaultPort(config)}/graphql`;
  const wait = Math.min(Math.max(windowMs, 1000), MAX_STATS_WINDOW_MS);
  return await new Promise<Map<string, WorkloadUsage>>((resolve) => {
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
        out.set(id, { cpuPct: num(s.cpuPercent), memUsedBytes: mem.used, memTotalBytes: mem.limit });
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
  return parseUnraidInventory(data, config, {
    dockerFailed: failed.has("docker") || !data?.docker,
    vmsFailed: failed.has("vms") || !data?.vms,
  });
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
  const containerUsage = await sampleUnraidContainerStats(config, running, config.statsWindowMs);
  return {
    fetchedAt: Date.now(),
    durationMs,
    inventory,
    host: parseUnraidHostUsage(data),
    vmUsage: new Map(),
    containerUsage,
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
