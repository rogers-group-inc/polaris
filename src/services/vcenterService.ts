/**
 * src/services/vcenterService.ts — VMware vCenter discovery + telemetry client
 *
 * Discovers virtual machines, ESXi hosts, and datastores from a vCenter
 * server. Produces assets only — no subnets, reservations, or VIPs (the
 * AD/Entra "assets-only" pathway; syncVcenterDevices in integrations.ts
 * consumes the result).
 *
 * Two transports against the same vCenter:
 *
 *  - vSphere Automation REST (`/api/...`, vCenter 7.0U2+): session auth via
 *    POST /api/session (Basic) → `vmware-api-session-id` header. Used for
 *    inventory (clusters, hosts, per-host VM lists, per-VM detail + VMware
 *    Tools guest identity/networking/filesystems) and the Query API modal.
 *
 *  - Narrow SOAP property-collector calls (`/sdk`, vim25) for the data the
 *    REST surface does not expose (WinRM-Identify hand-rolled-envelope
 *    precedent; no XML dependency — targeted regex parsing of a shape we
 *    request ourselves):
 *      1. VM quickStats — CPU MHz / RAM usage for EVERY VM in one batched
 *         call. Feeds discovery snapshots AND the per-minute cpuMemory
 *         telemetry warm cache (fetchVcenterQuickStats).
 *      2. Datastore facts — summary capacity/free/uncommitted, host mount
 *         list (the REST datastore list can't filter by host), and backing
 *         info (VMFS extent NAA device ids → array vendor via vendorFromNaa,
 *         NFS remote host/path).
 *    Every SOAP surface degrades to nulls independently — a vCenter that
 *    blocks /sdk still yields full REST inventory.
 *
 * VM identity: instanceUuid (survives vMotion and host moves; unique per
 * vCenter) with a `${integrationId}:${moref}` fallback — see pickVmExternalId.
 */

import { request as httpsRequest } from "node:https";
import { AppError } from "../utils/errors.js";
import { xmlEscape } from "../utils/winrm.js";
import { matchesWildcard } from "../utils/integrationFilter.js";
import { getConfiguredResolver } from "./dnsService.js";
import { logger } from "../utils/logger.js";

export interface VcenterConfig {
  host: string;
  port?: number;
  verifyTls?: boolean;
  username: string;
  password: string;
  vmInclude?: string[]; // Wildcards matched against the VM name (e.g. "prod-*")
  vmExclude?: string[]; // Ignored when vmInclude is non-empty
}

export interface DiscoveredVcenterCluster {
  moref: string; // "domain-c8"
  name: string;
}

export interface DiscoveredVcenterHost {
  moref: string; // "host-12"
  name: string; // usually the FQDN the host was added by
  connectionState: string; // CONNECTED | DISCONNECTED | NOT_RESPONDING
  powerState: string; // POWERED_ON | POWERED_OFF | STANDBY
  clusterMoref: string | null;
  clusterName: string | null;
  datastoreMorefs: string[]; // filled from the SOAP datastore host-mount list
  resolvedIp: string | null; // DNS-resolved from `name` (REST exposes no mgmt IP)
  // Virtual networking, merged in from the SOAP host fetch. `null` = the fetch
  // failed or the host published no config; the General-tab section then
  // renders nothing rather than claiming the host has no vSwitches.
  vswitches: VcenterHostVswitch[] | null;
  portgroups: VcenterHostPortgroup[] | null;
}

export interface VcenterVmDisk {
  key: string; // hardware device key, e.g. "2000"
  label: string; // "Hard disk 1"
  capacityBytes: number | null;
  datastoreMoref: string | null;
  datastoreName: string | null; // parsed from the "[datastore] path.vmdk" backing file
}

export interface VcenterGuestFilesystem {
  path: string; // mount point ("/", "C:\\")
  capacityBytes: number | null;
  freeBytes: number | null;
}

export interface DiscoveredVcenterVm {
  moref: string; // "vm-123"
  instanceUuid: string | null;
  biosUuid: string | null;
  name: string;
  powerState: string; // POWERED_ON | POWERED_OFF | SUSPENDED
  hostMoref: string; // placement at discovery time
  guestHostname: string | null; // VMware Tools guest identity
  guestIp: string | null;
  guestOsFullName: string | null;
  toolsRunState: string | null; // RUNNING | NOT_RUNNING | EXECUTING_SCRIPTS
  toolsVersionStatus: string | null;
  cpuCount: number | null;
  memoryMiB: number | null;
  // SOAP quickStats snapshot (null when the SOAP surface is unavailable):
  cpuUsageMhz: number | null;
  cpuMaxMhz: number | null;
  memUsedBytes: number | null;
  nicMacs: Array<{ mac: string; connected: boolean }>;
  disks: VcenterVmDisk[];
}

export interface VcenterDatastoreBacking {
  vmfs?: Array<{ diskName: string; vendor: string | null }>;
  nas?: { remoteHost: string; remotePath: string };
}

export interface DiscoveredVcenterDatastore {
  moref: string; // "datastore-45"
  name: string;
  dsType: string | null; // VMFS | NFS | NFS41 | vsan | VVOL
  capacityBytes: number | null;
  freeBytes: number | null;
  provisionedBytes: number | null; // capacity - free + uncommitted (SOAP only)
  accessible: boolean | null;
  hostMorefs: string[];
  backing: VcenterDatastoreBacking | null;
  backingLabel: string | null; // "Pure Storage", "NFS: filer01", ...
}

export interface VcenterDiscoveryResult {
  clusters: DiscoveredVcenterCluster[];
  hosts: DiscoveredVcenterHost[];
  vms: DiscoveredVcenterVm[];
  datastores: DiscoveredVcenterDatastore[];
  /**
   * Every VM moref the per-host listing returned, BEFORE the name filter and
   * before the per-VM detail fan-out. `vms` is the survivors of both; this is
   * the raw "vCenter still has this VM" set, and it's what keeps a filter
   * change or a single failed detail call from reading as a deleted VM in the
   * disappearance sweep (syncVcenterDevices).
   */
  presentVmMorefs: string[];
  /**
   * False when any per-host VM list call failed (each is caught + logged so one
   * unreachable host can't fail the run). A partial inventory can't distinguish
   * "deleted" from "not asked", so the sweep refuses to act on it.
   */
  inventoryComplete: boolean;
  /**
   * True when the run was narrowed to a single VM or host (the asset slide-in's
   * Discover Now). Every absence-based pass in `syncVcenterDevices` must refuse
   * to act on such a result: the fleet is not missing, it was never asked for.
   */
  scoped?: boolean;
}

export type VcenterDiscoveryProgressCallback = (
  step: string,
  level: "info" | "error",
  message: string,
) => void;

// Per-VM guest-detail fan-out concurrency (≤5 REST calls per VM). Bounded so
// a 2000-VM inventory doesn't open thousands of sockets against vCenter.
const VM_DETAIL_CONCURRENCY = 8;
const REST_TIMEOUT_MS = 20_000;
const SOAP_TIMEOUT_MS = 45_000; // batched property fetches return large bodies

// ─── Low-level HTTPS ────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function rawRequest(
  config: VcenterConfig,
  method: string,
  path: string,
  opts: {
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new AppError(499, "Aborted"));
    const req = httpsRequest(
      {
        hostname: config.host,
        port: config.port || 443,
        path,
        method,
        headers: {
          Accept: "application/json",
          ...(opts.body !== undefined
            ? { "Content-Length": Buffer.byteLength(opts.body).toString() }
            : {}),
          ...(opts.headers || {}),
        },
        rejectUnauthorized: config.verifyTls !== false,
        timeout: opts.timeoutMs ?? REST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    const onAbort = () => {
      try { req.destroy(); } catch { /* noop */ }
      reject(new AppError(499, "Aborted"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    req.on("timeout", () => {
      try { req.destroy(); } catch { /* noop */ }
      reject(new AppError(504, `vCenter request timed out (${method} ${path.split("?")[0]})`));
    });
    req.on("error", (err: any) => {
      opts.signal?.removeEventListener("abort", onAbort);
      reject(translateNetworkError(err, config));
    });
    req.on("close", () => opts.signal?.removeEventListener("abort", onAbort));
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function translateNetworkError(err: any, config: VcenterConfig): AppError {
  const code = err?.code;
  if (code === "ECONNREFUSED") return new AppError(502, `Connection refused — ${config.host}:${config.port || 443}`);
  if (code === "ENOTFOUND") return new AppError(502, `Host not found — ${config.host}`);
  if (code === "ETIMEDOUT") return new AppError(504, `Connection timed out — ${config.host}:${config.port || 443}`);
  if (
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    code === "CERT_HAS_EXPIRED" ||
    code === "ERR_TLS_CERT_ALTNAME_INVALID"
  ) {
    return new AppError(502, `TLS certificate error (${code}) — try disabling TLS verification`);
  }
  return new AppError(502, err?.message || "vCenter connection error");
}

// ─── REST session ───────────────────────────────────────────────────────────

/**
 * vSphere Automation REST session. Login once, re-auth at most once on a
 * mid-run 401 (vCenter sessions idle out at ~5 min inactivity), logout in
 * the caller's `finally` — unlike FMG api-key sessions, vCenter sessions are
 * per-login and DELETE /api/session is the correct hygiene.
 */
class VcenterRestSession {
  private token: string | null = null;
  private reauthed = false;

  constructor(private readonly config: VcenterConfig) {}

  async login(signal?: AbortSignal): Promise<void> {
    const basic = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
    const res = await rawRequest(this.config, "POST", "/api/session", {
      headers: { Authorization: `Basic ${basic}` },
      body: "",
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, "vCenter authentication failed — check username and password");
    }
    if (res.status !== 200 && res.status !== 201) {
      throw new AppError(502, `vCenter session create returned HTTP ${res.status}${vcErrorDetail(res.body)}`);
    }
    // Body is the bare JSON-encoded session id string: "abc123..."
    try {
      this.token = JSON.parse(res.body);
    } catch {
      this.token = res.body.replace(/^"|"$/g, "").trim();
    }
    if (!this.token) throw new AppError(502, "vCenter session create returned an empty token");
  }

  async request<T>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | string[]>; body?: unknown; signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.token) await this.login(opts.signal);

    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query || {})) {
      if (Array.isArray(v)) for (const item of v) qs.append(k, item);
      else qs.append(k, v);
    }
    const fullPath = `${path}${qs.toString() ? (path.includes("?") ? "&" : "?") + qs.toString() : ""}`;

    const doCall = () =>
      rawRequest(this.config, method, fullPath, {
        headers: {
          "vmware-api-session-id": this.token!,
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
        timeoutMs: opts.timeoutMs,
      });

    let res = await doCall();
    if (res.status === 401 && !this.reauthed) {
      // Session idled out mid-run — re-auth exactly once, then fail fast.
      this.reauthed = true;
      this.token = null;
      await this.login(opts.signal);
      res = await doCall();
    }
    if (res.status === 401 || res.status === 403) {
      throw new AppError(502, `vCenter rejected the session (HTTP ${res.status})${vcErrorDetail(res.body)}`);
    }
    if (res.status === 404) {
      throw new AppError(404, `vCenter endpoint not found: ${path}`);
    }
    if (res.status === 503) {
      // Guest-ops endpoints return 503 SERVICE_UNAVAILABLE when VMware Tools
      // isn't running — callers catch this per-call and degrade to null.
      throw new AppError(503, `vCenter service unavailable for ${path}${vcErrorDetail(res.body)}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new AppError(502, `vCenter returned HTTP ${res.status} for ${path}${vcErrorDetail(res.body)}`);
    }
    if (!res.body) return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw new AppError(502, `vCenter returned a non-JSON body for ${path}`);
    }
  }

  async logout(): Promise<void> {
    if (!this.token) return;
    try {
      await rawRequest(this.config, "DELETE", "/api/session", {
        headers: { "vmware-api-session-id": this.token },
      });
    } catch {
      // Best-effort — the session idles out server-side regardless.
    }
    this.token = null;
  }
}

/** Pull the vCenter structured-error `default_message` out of a response body. */
function vcErrorDetail(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    const msg =
      parsed?.messages?.[0]?.default_message ??
      parsed?.value?.messages?.[0]?.default_message ??
      parsed?.error_type;
    return msg ? ` — ${String(msg)}` : "";
  } catch {
    return "";
  }
}

// ─── Connection test ────────────────────────────────────────────────────────

export async function testConnection(config: VcenterConfig): Promise<{ ok: boolean; message: string }> {
  if (!config.host) return { ok: false, message: "Host is required" };
  if (!config.username) return { ok: false, message: "Username is required" };
  if (!config.password) return { ok: false, message: "Password is required" };

  const session = new VcenterRestSession(config);
  try {
    await session.login();
    const hosts = await session.request<Array<{ host: string; name: string }>>("GET", "/api/vcenter/host");
    const vms = await session.request<Array<{ vm: string }>>("GET", "/api/vcenter/vm");
    return {
      ok: true,
      message: `Connected — ${hosts.length} ESXi host(s), ${vms.length} VM(s) visible`,
    };
  } catch (err: any) {
    return { ok: false, message: err instanceof AppError ? err.message : err?.message || "Unknown error" };
  } finally {
    await session.logout();
  }
}

// ─── Manual query (UI tool) ─────────────────────────────────────────────────

/**
 * Proxy an arbitrary vSphere Automation REST call using stored credentials.
 * Backs the Query API modal. REST surface only — the path must start with
 * "/api/" (the SOAP /sdk endpoint is not exposed to the modal).
 */
export async function proxyQuery(
  config: VcenterConfig,
  method: "GET" | "POST",
  path: string,
  query?: Record<string, string>,
): Promise<unknown> {
  if (!path.startsWith("/api/")) {
    throw new AppError(400, 'Path must start with "/api/" (vSphere Automation REST surface)');
  }
  const session = new VcenterRestSession(config);
  try {
    await session.login();
    return await session.request<unknown>(method, path, { query });
  } finally {
    await session.logout();
  }
}

// ─── SOAP (vim25) property collector ────────────────────────────────────────

interface SoapSession {
  cookie: string;
  rootFolder: string;
  propertyCollector: string;
  viewManager: string;
}

function soapEnvelope(inner: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:xsd="http://www.w3.org/2001/XMLSchema" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
    `xmlns:vim25="urn:vim25">` +
    `<soapenv:Body>${inner}</soapenv:Body></soapenv:Envelope>`
  );
}

async function soapCall(
  config: VcenterConfig,
  inner: string,
  opts: { cookie?: string; signal?: AbortSignal } = {},
): Promise<RawResponse> {
  const body = soapEnvelope(inner);
  const res = await rawRequest(config, "POST", "/sdk", {
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      SOAPAction: "urn:vim25/8.0.0.0",
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
    },
    body,
    timeoutMs: SOAP_TIMEOUT_MS,
    signal: opts.signal,
  });
  if (res.status !== 200) {
    const fault = res.body.match(/<faultstring>([\s\S]*?)<\/faultstring>/)?.[1]?.trim();
    throw new AppError(502, `vCenter SOAP call failed (HTTP ${res.status})${fault ? ` — ${fault}` : ""}`);
  }
  return res;
}

/** Login to /sdk. Resolves service-content morefs first (rootFolder can differ per install). */
async function soapLogin(config: VcenterConfig, signal?: AbortSignal): Promise<SoapSession> {
  const scRes = await soapCall(
    config,
    `<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>`,
    { signal },
  );
  const rootFolder = scRes.body.match(/<rootFolder[^>]*>([^<]+)<\/rootFolder>/)?.[1];
  const propertyCollector = scRes.body.match(/<propertyCollector[^>]*>([^<]+)<\/propertyCollector>/)?.[1];
  const viewManager = scRes.body.match(/<viewManager[^>]*>([^<]+)<\/viewManager>/)?.[1];
  const sessionManager = scRes.body.match(/<sessionManager[^>]*>([^<]+)<\/sessionManager>/)?.[1];
  if (!rootFolder || !propertyCollector || !viewManager || !sessionManager) {
    throw new AppError(502, "vCenter SOAP service content missing expected manager references");
  }

  const loginRes = await soapCall(
    config,
    `<vim25:Login><vim25:_this type="SessionManager">${xmlEscape(sessionManager)}</vim25:_this>` +
      `<vim25:userName>${xmlEscape(config.username)}</vim25:userName>` +
      `<vim25:password>${xmlEscape(config.password)}</vim25:password></vim25:Login>`,
    { signal },
  );
  const setCookie = loginRes.headers["set-cookie"];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = cookieHeader?.match(/vmware_soap_session="?[^";]+"?/)?.[0];
  if (!cookie) throw new AppError(502, "vCenter SOAP login did not return a session cookie");
  return { cookie, rootFolder, propertyCollector, viewManager };
}

async function soapLogout(config: VcenterConfig, session: SoapSession): Promise<void> {
  try {
    await soapCall(
      config,
      `<vim25:Logout><vim25:_this type="SessionManager">SessionManager</vim25:_this></vim25:Logout>`,
      { cookie: session.cookie },
    );
  } catch {
    // Best-effort.
  }
}

/**
 * RetrievePropertiesEx over a ContainerView of `objType` for the given
 * property paths, following the continuation token until drained. Returns
 * the raw `<objects>…</objects>` XML blocks (one per managed object).
 */
async function retrieveAllProperties(
  config: VcenterConfig,
  session: SoapSession,
  objType: "VirtualMachine" | "Datastore" | "HostSystem",
  pathSet: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const viewRes = await soapCall(
    config,
    `<vim25:CreateContainerView><vim25:_this type="ViewManager">${xmlEscape(session.viewManager)}</vim25:_this>` +
      `<vim25:container type="Folder">${xmlEscape(session.rootFolder)}</vim25:container>` +
      `<vim25:type>${objType}</vim25:type><vim25:recursive>true</vim25:recursive></vim25:CreateContainerView>`,
    { cookie: session.cookie, signal },
  );
  const view = viewRes.body.match(/<returnval[^>]*>([^<]+)<\/returnval>/)?.[1];
  if (!view) throw new AppError(502, "vCenter SOAP CreateContainerView returned no view");

  const paths = pathSet.map((p) => `<vim25:pathSet>${xmlEscape(p)}</vim25:pathSet>`).join("");
  const retrieveBody =
    `<vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">${xmlEscape(session.propertyCollector)}</vim25:_this>` +
    `<vim25:specSet>` +
    `<vim25:propSet><vim25:type>${objType}</vim25:type>${paths}</vim25:propSet>` +
    `<vim25:objectSet><vim25:obj type="ContainerView">${xmlEscape(view)}</vim25:obj><vim25:skip>true</vim25:skip>` +
    `<vim25:selectSet xsi:type="vim25:TraversalSpec"><vim25:name>view</vim25:name><vim25:type>ContainerView</vim25:type>` +
    `<vim25:path>view</vim25:path><vim25:skip>false</vim25:skip></vim25:selectSet>` +
    `</vim25:objectSet></vim25:specSet><vim25:options/></vim25:RetrievePropertiesEx>`;

  const blocks: string[] = [];
  let res = await soapCall(config, retrieveBody, { cookie: session.cookie, signal });
  for (;;) {
    blocks.push(...extractObjectBlocks(res.body));
    const token = res.body.match(/<token>([^<]+)<\/token>/)?.[1];
    if (!token) break;
    res = await soapCall(
      config,
      `<vim25:ContinueRetrievePropertiesEx><vim25:_this type="PropertyCollector">${xmlEscape(session.propertyCollector)}</vim25:_this>` +
        `<vim25:token>${xmlEscape(token)}</vim25:token></vim25:ContinueRetrievePropertiesEx>`,
      { cookie: session.cookie, signal },
    );
  }
  // The view is session-scoped; destroy it so long-lived sessions don't leak.
  try {
    await soapCall(
      config,
      `<vim25:DestroyView><vim25:_this type="ContainerView">${xmlEscape(view)}</vim25:_this></vim25:DestroyView>`,
      { cookie: session.cookie },
    );
  } catch { /* best-effort */ }
  return blocks;
}

/** Split a RetrievePropertiesEx response into per-object XML blocks. Exported for tests. */
export function extractObjectBlocks(xml: string): string[] {
  const out: string[] = [];
  const re = /<objects>([\s\S]*?)<\/objects>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

/** Read the managed-object reference id (`<obj type="X">id</obj>`) from an object block. Exported for tests. */
export function parseObjRef(block: string): string | null {
  return block.match(/<obj [^>]*>([^<]+)<\/obj>/)?.[1] ?? null;
}

/** Read a scalar propSet value by property name from an object block. Exported for tests. */
export function parsePropValue(block: string, name: string): string | null {
  const re = new RegExp(
    `<propSet><name>${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</name><val[^>]*>([\\s\\S]*?)</val></propSet>`,
  );
  return block.match(re)?.[1]?.trim() ?? null;
}

function parsePropNumber(block: string, name: string): number | null {
  const raw = parsePropValue(block, name);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The raw propSet XML (nested values like `host` mounts or `info`) by property name. */
function parsePropXml(block: string, name: string): string | null {
  const re = new RegExp(
    `<propSet><name>${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</name><val[^>]*>([\\s\\S]*?)</val></propSet>`,
  );
  return block.match(re)?.[1] ?? null;
}

// ─── SOAP: VM quickStats ────────────────────────────────────────────────────

export interface VcenterVmQuickStats {
  moref: string;
  instanceUuid: string | null;
  cpuUsageMhz: number | null;
  cpuMaxMhz: number | null;
  guestMemUsageMB: number | null;
  hostMemUsageMB: number | null;
  memTotalMB: number | null;
  powerState: string | null;
  /** Guest uptime in whole seconds (VMware Tools); null when Tools is absent. */
  uptimeSec: number | null;
  /**
   * Guest filesystems as VMware Tools reports them. `null` means Tools did not
   * answer (absent / not running / VM powered off) — deliberately NOT `[]`,
   * which would claim the guest genuinely has no mounts. Every consumer must
   * treat null as "no reading", never as a wipe.
   */
  guestDisks: VcenterGuestFilesystem[] | null;
  /** Guest vNICs as Tools reports them. Same null-vs-empty contract as `guestDisks`. */
  guestNics: VcenterGuestNic[] | null;
}

/** One guest-visible vNIC from `guest.net` (GuestNicInfo). */
export interface VcenterGuestNic {
  /** Hardware device key — 4000 + adapter index by VMware convention. */
  deviceConfigId: number | null;
  /** "Network adapter 1" derived from deviceConfigId; falls back to the portgroup. */
  label: string;
  /** Portgroup the adapter is attached to; null when the guest can't see it. */
  network: string | null;
  macAddress: string | null;
  connected: boolean | null;
  /** First IPv4 the guest reports on this adapter. */
  ipAddress: string | null;
}

const QUICKSTATS_PATHS = [
  "config.instanceUuid",
  "config.hardware.memoryMB",
  "runtime.powerState",
  "summary.quickStats.overallCpuUsage",
  "summary.quickStats.guestMemoryUsage",
  "summary.quickStats.hostMemoryUsage",
  "summary.quickStats.uptimeSeconds",
  "summary.runtime.maxCpuUsage",
  // Guest-reported inventory. Both ride the SAME batched fetch the CPU/RAM
  // figures come from — the monitor loop needs no per-VM call to fill the
  // System tab's interface + storage tables.
  "guest.disk",
  "guest.net",
];

/**
 * Guest filesystems out of a `guest.disk` propSet value (ArrayOfGuestDiskInfo).
 * Returns null when the property is absent — VMware Tools did not answer, which
 * is not the same claim as "this guest has no mounts". Exported for tests.
 */
export function parseGuestDisks(block: string): VcenterGuestFilesystem[] | null {
  const xml = parsePropXml(block, "guest.disk");
  if (xml === null) return null;
  const out: VcenterGuestFilesystem[] = [];
  const re = /<GuestDiskInfo>([\s\S]*?)<\/GuestDiskInfo>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const entry = m[1];
    const path = entry.match(/<diskPath>([^<]*)<\/diskPath>/)?.[1];
    if (!path) continue;
    const cap = Number(entry.match(/<capacity>([^<]+)<\/capacity>/)?.[1]);
    const free = Number(entry.match(/<freeSpace>([^<]+)<\/freeSpace>/)?.[1]);
    out.push({
      path,
      capacityBytes: Number.isFinite(cap) ? cap : null,
      freeBytes: Number.isFinite(free) ? free : null,
    });
  }
  return out;
}

/**
 * Guest vNICs out of a `guest.net` propSet value (ArrayOfGuestNicInfo). Same
 * null-vs-empty contract as parseGuestDisks. Exported for tests.
 *
 * The adapter LABEL is derived from `deviceConfigId`: VMware numbers virtual
 * ethernet devices from key 4000, so 4000 is "Network adapter 1". The portgroup
 * name is deliberately not the identity — two adapters on the same portgroup
 * would collide in AssetInterface's (asset, ifName) key.
 */
export function parseGuestNics(block: string): VcenterGuestNic[] | null {
  const xml = parsePropXml(block, "guest.net");
  if (xml === null) return null;
  const out: VcenterGuestNic[] = [];
  const re = /<GuestNicInfo>([\s\S]*?)<\/GuestNicInfo>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const entry = m[1];
    const keyRaw = Number(entry.match(/<deviceConfigId>(-?\d+)<\/deviceConfigId>/)?.[1]);
    const deviceConfigId = Number.isFinite(keyRaw) ? keyRaw : null;
    const network = entry.match(/<network>([^<]*)<\/network>/)?.[1] || null;
    const label =
      deviceConfigId !== null && deviceConfigId >= 4000
        ? `Network adapter ${deviceConfigId - 4000 + 1}`
        : network || (deviceConfigId !== null ? `vNIC ${deviceConfigId}` : "vNIC");
    // Every <ipAddress> in the block — the bare guest-reported list and the
    // ipConfig entries both use that tag. First IPv4 wins.
    let ipAddress: string | null = null;
    const ipRe = /<ipAddress>([^<]+)<\/ipAddress>/g;
    let ipm: RegExpExecArray | null;
    while ((ipm = ipRe.exec(entry)) !== null) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ipm[1])) { ipAddress = ipm[1]; break; }
    }
    const connectedRaw = entry.match(/<connected>([^<]+)<\/connected>/)?.[1];
    out.push({
      deviceConfigId,
      label,
      network,
      macAddress: entry.match(/<macAddress>([^<]+)<\/macAddress>/)?.[1] || null,
      connected: connectedRaw === undefined ? null : connectedRaw === "true" || connectedRaw === "1",
      ipAddress,
    });
  }
  return out;
}

/** Parse one RetrievePropertiesEx object block into quickStats. Exported for tests. */
export function parseQuickStatsBlock(block: string): VcenterVmQuickStats | null {
  const moref = parseObjRef(block);
  if (!moref) return null;
  return {
    moref,
    instanceUuid: parsePropValue(block, "config.instanceUuid"),
    cpuUsageMhz: parsePropNumber(block, "summary.quickStats.overallCpuUsage"),
    cpuMaxMhz: parsePropNumber(block, "summary.runtime.maxCpuUsage"),
    guestMemUsageMB: parsePropNumber(block, "summary.quickStats.guestMemoryUsage"),
    hostMemUsageMB: parsePropNumber(block, "summary.quickStats.hostMemoryUsage"),
    memTotalMB: parsePropNumber(block, "config.hardware.memoryMB"),
    powerState: parsePropValue(block, "runtime.powerState"),
    uptimeSec: parsePropNumber(block, "summary.quickStats.uptimeSeconds"),
    guestDisks: parseGuestDisks(block),
    guestNics: parseGuestNics(block),
  };
}

/**
 * ONE batched SOAP call returning quickStats for every VM in the vCenter.
 * Used by discovery (usage snapshot) and by the telemetry warm cache in
 * monitoringService (per-minute cpuMemory stream) — the cache layer keys
 * results by instanceUuid AND moref so both lookups hit.
 */
export async function fetchVcenterQuickStats(
  config: VcenterConfig,
  signal?: AbortSignal,
): Promise<VcenterVmQuickStats[]> {
  const session = await soapLogin(config, signal);
  try {
    const blocks = await retrieveAllProperties(config, session, "VirtualMachine", QUICKSTATS_PATHS, signal);
    const out: VcenterVmQuickStats[] = [];
    for (const block of blocks) {
      const parsed = parseQuickStatsBlock(block);
      if (parsed) out.push(parsed);
    }
    return out;
  } finally {
    await soapLogout(config, session);
  }
}

// ─── SOAP: datastore facts ──────────────────────────────────────────────────

const DATASTORE_PATHS = [
  "name",
  "summary.type",
  "summary.capacity",
  "summary.freeSpace",
  "summary.uncommitted",
  "summary.accessible",
  "host",
  "info",
];

/** Parse one datastore object block. Exported for tests. */
export function parseDatastoreBlock(block: string): DiscoveredVcenterDatastore | null {
  const moref = parseObjRef(block);
  if (!moref) return null;
  const name = parsePropValue(block, "name") || moref;
  const capacity = parsePropNumber(block, "summary.capacity");
  const free = parsePropNumber(block, "summary.freeSpace");
  const uncommitted = parsePropNumber(block, "summary.uncommitted");
  const accessibleRaw = parsePropValue(block, "summary.accessible");

  // Host mounts: <val ...><DatastoreHostMount><key type="HostSystem">host-12</key>…
  const hostMorefs: string[] = [];
  const hostXml = parsePropXml(block, "host");
  if (hostXml) {
    const re = /<key[^>]*type="HostSystem"[^>]*>([^<]+)<\/key>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(hostXml)) !== null) hostMorefs.push(m[1]);
  }

  // Backing: VmfsDatastoreInfo extents / NasDatastoreInfo remote host+path.
  let backing: VcenterDatastoreBacking | null = null;
  const infoXml = parsePropXml(block, "info");
  if (infoXml) {
    const diskNames: string[] = [];
    const extentRe = /<extent>[\s\S]*?<diskName>([^<]+)<\/diskName>[\s\S]*?<\/extent>/g;
    let m: RegExpExecArray | null;
    while ((m = extentRe.exec(infoXml)) !== null) diskNames.push(m[1]);
    const remoteHost = infoXml.match(/<remoteHost>([^<]+)<\/remoteHost>/)?.[1];
    const remotePath = infoXml.match(/<remotePath>([^<]+)<\/remotePath>/)?.[1];
    if (diskNames.length > 0) {
      backing = { vmfs: diskNames.map((d) => ({ diskName: d, vendor: vendorFromNaa(d) })) };
    } else if (remoteHost && remotePath) {
      backing = { nas: { remoteHost, remotePath } };
    }
  }

  // Provisioned = used + all thin allocations not yet written:
  //   capacity - freeSpace + uncommitted. Only meaningful when all three exist.
  const provisioned =
    capacity !== null && free !== null && uncommitted !== null ? capacity - free + uncommitted : null;

  return {
    moref,
    name,
    dsType: parsePropValue(block, "summary.type"),
    capacityBytes: capacity,
    freeBytes: free,
    provisionedBytes: provisioned,
    accessible: accessibleRaw === null ? null : accessibleRaw === "true" || accessibleRaw === "1",
    hostMorefs,
    backing,
    backingLabel: backingLabelFor(backing),
  };
}

// ─── SOAP: ESXi host stats ─────────────────────────────────────────────────
//
// The monitoring counterpart to the VM quickStats fetch above: ONE batched
// RetrievePropertiesEx over HostSystem serves every ESXi host in the vCenter.
// It carries CPU/RAM usage, uptime, connection/power state, and the physical +
// VMkernel NIC inventory — everything the "vcenter" polling method needs to
// drive an ESXi host's response-time, cpuMemory and interfaces streams without
// SNMP enabled on the host itself.
//
// Host STORAGE rides the datastore fetch (fetchVcenterHostSnapshot pairs the
// two in one SOAP session): a host's mounted datastores are the capacity
// figures an operator acts on, and the Datastore managed object already
// publishes the host-mount list. Host-local volumes backing no datastore (the
// ESXi boot bank) are deliberately not reported.

export interface VcenterHostPnic {
  device: string;              // "vmnic0"
  macAddress: string | null;
  /** Live negotiated speed. NULL means the link is DOWN — ESXi omits linkSpeed entirely. */
  speedMb: number | null;
  duplex: boolean | null;
  driver: string | null;
}

export interface VcenterHostVnic {
  device: string;              // "vmk0"
  portgroup: string | null;
  macAddress: string | null;
  ipAddress: string | null;
  mtu: number | null;
}

/**
 * One virtual switch as the HOST sees it. Covers both kinds behind one shape:
 * a standard vSwitch (`config.network.vswitch`) and this host's membership in a
 * distributed switch (`config.network.proxySwitch`). A DVS's own configuration
 * — its port groups, their VLANs, how many hosts it spans — is NOT here: that
 * is a per-vCenter object, not a host fact, and it needs its own container view.
 */
export interface VcenterHostVswitch {
  name: string;                     // "vSwitch0", or the DVS name
  distributed: boolean;
  dvsUuid: string | null;           // distributed only
  mtu: number | null;
  numPorts: number | null;
  numPortsAvailable: number | null; // standard only
  /**
   * Uplink pNIC DEVICE names ("vmnic0"). Read from the SPEC — `vswitch.pnic[]`
   * and `proxySwitch.pnic[]` hold opaque keys
   * (`key-vim.host.PhysicalNic-vmnic0`), while `spec.bridge.nicDevice[]` and
   * `spec.backing.pnicSpec[].pnicDevice` carry the names directly, so the join
   * onto the interface rows needs no key-mapping table.
   */
  uplinks: string[];
  /** NIC-teaming policy ("loadbalance_srcid", "failover_explicit", …). Standard only. */
  teamingPolicy: string | null;
}

/** One port group on a standard vSwitch. `vlanId` is raw: 0 = untagged, 4095 = VGT. */
export interface VcenterHostPortgroup {
  name: string;
  vswitchName: string | null;
  vlanId: number | null;
}

export interface VcenterHostStats {
  moref: string;
  name: string | null;
  connectionState: string | null;   // connected | notResponding | disconnected
  powerState: string | null;        // poweredOn | poweredOff | standBy
  inMaintenanceMode: boolean | null;
  uptimeSec: number | null;
  cpuUsageMhz: number | null;
  /** cpuMhz × numCpuCores — the denominator for a usage percentage. */
  cpuTotalMhz: number | null;
  memUsageBytes: number | null;
  memTotalBytes: number | null;
  /**
   * Physical + VMkernel NICs. `null` means the property was absent — a
   * disconnected host publishes no config — and must never be read as "this
   * host has no interfaces".
   */
  pnics: VcenterHostPnic[] | null;
  vnics: VcenterHostVnic[] | null;
  /**
   * Virtual switches (standard + this host's DVS memberships) and the standard
   * switches' port groups. Same null-vs-empty contract as the NIC lists.
   */
  vswitches: VcenterHostVswitch[] | null;
  portgroups: VcenterHostPortgroup[] | null;
}

const HOST_STATS_PATHS = [
  "name",
  "runtime.connectionState",
  "runtime.powerState",
  "runtime.inMaintenanceMode",
  "summary.quickStats.overallCpuUsage",
  "summary.quickStats.overallMemoryUsage",
  "summary.quickStats.uptime",
  "summary.hardware.cpuMhz",
  "summary.hardware.numCpuCores",
  "summary.hardware.memorySize",
  "config.network.pnic",
  "config.network.vnic",
  "config.network.vswitch",
  "config.network.proxySwitch",
  "config.network.portgroup",
];

/**
 * Split one managed-object entry at its `<spec>`. VIM emits a data object's
 * declared properties first and the spec last, and several scalars appear in
 * BOTH (`numPorts`, `mtu`) — so scalars are read from the head and structural
 * detail (bridge uplinks, teaming policy, port-group name/VLAN) from the spec.
 * The same reason parseHostPnics reads `<linkSpeed>` from its prefix only.
 */
function splitAtSpec(entry: string): { head: string; spec: string } {
  const i = entry.indexOf("<spec>");
  return i === -1 ? { head: entry, spec: "" } : { head: entry.slice(0, i), spec: entry.slice(i) };
}

function intOrNull(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Physical NICs out of a `config.network.pnic` propSet value. Exported for tests.
 *
 * The live `<linkSpeed>` is read from the entry PREFIX only. VIM emits
 * PhysicalNic properties in declaration order — linkSpeed, then
 * validLinkSpecification, then spec — and the latter two carry `<speedMb>`
 * elements of their own (the speeds the NIC *supports* / is *configured* for).
 * A down link omits linkSpeed entirely, so a whole-entry match would report a
 * supported speed as though the port were up.
 */
export function parseHostPnics(block: string): VcenterHostPnic[] | null {
  const xml = parsePropXml(block, "config.network.pnic");
  if (xml === null) return null;
  const out: VcenterHostPnic[] = [];
  const re = /<PhysicalNic>([\s\S]*?)<\/PhysicalNic>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const entry = m[1];
    const device = entry.match(/<device>([^<]+)<\/device>/)?.[1];
    if (!device) continue;
    const head = entry.split(/<validLinkSpecification>|<spec>/)[0];
    const link = head.match(/<linkSpeed>([\s\S]*?)<\/linkSpeed>/)?.[1] ?? "";
    const speed = Number(link.match(/<speedMb>(\d+)<\/speedMb>/)?.[1]);
    const duplexRaw = link.match(/<duplex>([^<]+)<\/duplex>/)?.[1];
    out.push({
      device,
      macAddress: entry.match(/<mac>([^<]+)<\/mac>/)?.[1] || null,
      speedMb: Number.isFinite(speed) ? speed : null,
      duplex: duplexRaw === undefined ? null : duplexRaw === "true" || duplexRaw === "1",
      driver: entry.match(/<driver>([^<]+)<\/driver>/)?.[1] || null,
    });
  }
  return out;
}

/** VMkernel NICs out of a `config.network.vnic` propSet value. Exported for tests. */
export function parseHostVnics(block: string): VcenterHostVnic[] | null {
  const xml = parsePropXml(block, "config.network.vnic");
  if (xml === null) return null;
  const out: VcenterHostVnic[] = [];
  const re = /<HostVirtualNic>([\s\S]*?)<\/HostVirtualNic>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const entry = m[1];
    const device = entry.match(/<device>([^<]+)<\/device>/)?.[1];
    if (!device) continue;
    const mtu = Number(entry.match(/<mtu>(\d+)<\/mtu>/)?.[1]);
    out.push({
      device,
      portgroup: entry.match(/<portgroup>([^<]*)<\/portgroup>/)?.[1] || null,
      macAddress: entry.match(/<mac>([^<]+)<\/mac>/)?.[1] || null,
      ipAddress: entry.match(/<ipAddress>([^<]+)<\/ipAddress>/)?.[1] || null,
      mtu: Number.isFinite(mtu) ? mtu : null,
    });
  }
  return out;
}

/** Standard vSwitches out of a `config.network.vswitch` propSet value. Exported for tests. */
export function parseHostVswitches(block: string): VcenterHostVswitch[] | null {
  const xml = parsePropXml(block, "config.network.vswitch");
  if (xml === null) return null;
  const out: VcenterHostVswitch[] = [];
  const re = /<HostVirtualSwitch>([\s\S]*?)<\/HostVirtualSwitch>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const { head, spec } = splitAtSpec(m[1]);
    const name = head.match(/<name>([^<]+)<\/name>/)?.[1];
    if (!name) continue;
    // Uplinks live on the bridge. A vSwitch with no uplinks (internal-only) has
    // no bridge element at all, which is a legitimate state, not a parse miss.
    const uplinks: string[] = [];
    const nicRe = /<nicDevice>([^<]+)<\/nicDevice>/g;
    let nm: RegExpExecArray | null;
    while ((nm = nicRe.exec(spec)) !== null) uplinks.push(nm[1]);
    // Read the teaming policy from INSIDE <nicTeaming>: `spec.policy` is also
    // an element named `policy`, and only the teaming one has a text value.
    const teaming = spec.match(/<nicTeaming>([\s\S]*?)<\/nicTeaming>/)?.[1] ?? "";
    out.push({
      name,
      distributed: false,
      dvsUuid: null,
      mtu: intOrNull(head.match(/<mtu>(\d+)<\/mtu>/)?.[1]),
      numPorts: intOrNull(head.match(/<numPorts>(\d+)<\/numPorts>/)?.[1]),
      numPortsAvailable: intOrNull(head.match(/<numPortsAvailable>(\d+)<\/numPortsAvailable>/)?.[1]),
      uplinks,
      teamingPolicy: teaming.match(/<policy>([^<]+)<\/policy>/)?.[1] || null,
    });
  }
  return out;
}

/**
 * This host's distributed-switch memberships out of a
 * `config.network.proxySwitch` propSet value. Exported for tests.
 *
 * A proxy switch is the host's END of a DVS, so what it can tell us is the DVS
 * name/uuid and which of THIS host's pNICs uplink to it — which is exactly what
 * the interface nesting needs. Teaming and port groups belong to the DVS
 * object itself and are deliberately left null here rather than guessed.
 */
export function parseHostProxySwitches(block: string): VcenterHostVswitch[] | null {
  const xml = parsePropXml(block, "config.network.proxySwitch");
  if (xml === null) return null;
  const out: VcenterHostVswitch[] = [];
  const re = /<HostProxySwitch>([\s\S]*?)<\/HostProxySwitch>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const { head, spec } = splitAtSpec(m[1]);
    const name = head.match(/<dvsName>([^<]*)<\/dvsName>/)?.[1];
    if (!name) continue;
    const uplinks: string[] = [];
    const nicRe = /<pnicDevice>([^<]+)<\/pnicDevice>/g;
    let nm: RegExpExecArray | null;
    while ((nm = nicRe.exec(spec)) !== null) uplinks.push(nm[1]);
    out.push({
      name,
      distributed: true,
      dvsUuid: head.match(/<dvsUuid>([^<]*)<\/dvsUuid>/)?.[1] || null,
      mtu: intOrNull(head.match(/<mtu>(\d+)<\/mtu>/)?.[1]),
      numPorts: intOrNull(head.match(/<numPorts>(\d+)<\/numPorts>/)?.[1]),
      numPortsAvailable: null,
      uplinks,
      teamingPolicy: null,
    });
  }
  return out;
}

/** Port groups out of a `config.network.portgroup` propSet value. Exported for tests. */
export function parseHostPortgroups(block: string): VcenterHostPortgroup[] | null {
  const xml = parsePropXml(block, "config.network.portgroup");
  if (xml === null) return null;
  const out: VcenterHostPortgroup[] = [];
  const re = /<HostPortGroup>([\s\S]*?)<\/HostPortGroup>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    // name / vlanId / vswitchName are spec fields; the head carries the opaque
    // key, the port list and computedPolicy.
    const { spec } = splitAtSpec(m[1]);
    const name = spec.match(/<name>([^<]*)<\/name>/)?.[1];
    if (!name) continue;
    out.push({
      name,
      vswitchName: spec.match(/<vswitchName>([^<]*)<\/vswitchName>/)?.[1] || null,
      vlanId: intOrNull(spec.match(/<vlanId>(-?\d+)<\/vlanId>/)?.[1]),
    });
  }
  return out;
}

/** Parse one HostSystem object block into host stats. Exported for tests. */
export function parseHostStatsBlock(block: string): VcenterHostStats | null {
  const moref = parseObjRef(block);
  if (!moref) return null;
  const cpuMhz = parsePropNumber(block, "summary.hardware.cpuMhz");
  const cores = parsePropNumber(block, "summary.hardware.numCpuCores");
  const memUsageMB = parsePropNumber(block, "summary.quickStats.overallMemoryUsage");
  const maintRaw = parsePropValue(block, "runtime.inMaintenanceMode");
  return {
    moref,
    name: parsePropValue(block, "name"),
    connectionState: parsePropValue(block, "runtime.connectionState"),
    powerState: parsePropValue(block, "runtime.powerState"),
    inMaintenanceMode: maintRaw === null ? null : maintRaw === "true" || maintRaw === "1",
    uptimeSec: parsePropNumber(block, "summary.quickStats.uptime"),
    cpuUsageMhz: parsePropNumber(block, "summary.quickStats.overallCpuUsage"),
    cpuTotalMhz: cpuMhz !== null && cores !== null ? cpuMhz * cores : null,
    memUsageBytes: memUsageMB !== null ? memUsageMB * 1024 * 1024 : null,
    memTotalBytes: parsePropNumber(block, "summary.hardware.memorySize"),
    pnics: parseHostPnics(block),
    vnics: parseHostVnics(block),
    vswitches: mergeVswitchLists(parseHostVswitches(block), parseHostProxySwitches(block)),
    portgroups: parseHostPortgroups(block),
  };
}

/**
 * Standard + distributed switches as one list. `null` only when NEITHER
 * property was published (a disconnected host) — a host with standard switches
 * and no DVS, or the reverse, is a normal fleet and must not read as "unknown".
 */
function mergeVswitchLists(
  standard: VcenterHostVswitch[] | null,
  distributed: VcenterHostVswitch[] | null,
): VcenterHostVswitch[] | null {
  if (standard === null && distributed === null) return null;
  return [...(standard ?? []), ...(distributed ?? [])];
}

export interface VcenterHostSnapshot {
  hosts: VcenterHostStats[];
  datastores: DiscoveredVcenterDatastore[];
  /**
   * Per-half failure. The two property fetches share a session but NOT a fate:
   * a vCenter role that can read hosts but not datastores (or the reverse) is a
   * real permission shape on this API, and collapsing both into one throw
   * would let a host-property gap silently cost discovery its datastore
   * backing detail. Callers decide which half they cannot proceed without.
   */
  hostError: string | null;
  datastoreError: string | null;
}

/**
 * ONE SOAP session, two batched property fetches: every ESXi host's stats plus
 * the datastore inventory their storage figures come from.
 *
 * Used by BOTH the monitoring warm cache (one upstream round trip per vCenter
 * integration per tick serves every monitored host) and discovery's Phase 2 —
 * sharing it is what makes the host's vSwitches free at discovery time and
 * keeps exactly one parser for them. A failed LOGIN still throws: that is fatal
 * to both halves and there is nothing to report per-half about.
 */
export async function fetchVcenterHostSnapshot(
  config: VcenterConfig,
  signal?: AbortSignal,
): Promise<VcenterHostSnapshot> {
  const session = await soapLogin(config, signal);
  try {
    const hosts: VcenterHostStats[] = [];
    let hostError: string | null = null;
    try {
      const hostBlocks = await retrieveAllProperties(config, session, "HostSystem", HOST_STATS_PATHS, signal);
      for (const b of hostBlocks) {
        const parsed = parseHostStatsBlock(b);
        if (parsed) hosts.push(parsed);
      }
    } catch (err: any) {
      if (signal?.aborted) throw err;
      hostError = err?.message || "HostSystem property fetch failed";
    }

    const datastores: DiscoveredVcenterDatastore[] = [];
    let datastoreError: string | null = null;
    try {
      const dsBlocks = await retrieveAllProperties(config, session, "Datastore", DATASTORE_PATHS, signal);
      for (const b of dsBlocks) {
        const parsed = parseDatastoreBlock(b);
        if (parsed) datastores.push(parsed);
      }
    } catch (err: any) {
      if (signal?.aborted) throw err;
      datastoreError = err?.message || "Datastore property fetch failed";
    }

    return { hosts, datastores, hostError, datastoreError };
  } finally {
    await soapLogout(config, session);
  }
}

// ─── NAA vendor identification ──────────────────────────────────────────────

/**
 * NAA type-6 device ids embed the array vendor's IEEE OUI in the six hex
 * digits after "naa.6". Conservative map of the arrays operators actually
 * name (unknown OUIs → null; the raw diskName still renders).
 * Exported for tests + the frontend backing label.
 */
const NAA_VENDOR_PREFIXES: ReadonlyArray<[prefix: string, vendor: string]> = [
  ["naa.624a9370", "Pure Storage"],
  ["naa.600a0980", "NetApp"], // FAS/AFF ONTAP
  ["naa.60a98000", "NetApp"], // older ONTAP format
  ["naa.60060160", "Dell EMC Unity/VNX"],
  ["naa.60000970", "Dell EMC PowerMax/VMAX"],
  ["naa.60060e80", "Hitachi Vantara"],
  ["naa.60050768", "IBM"], // SVC / Storwize / FlashSystem
  ["naa.60002ac0", "HPE 3PAR/Primera"],
  ["naa.6000d310", "Dell Compellent/SC"],
  ["naa.6589cfc0", "TrueNAS/iXsystems"],
  ["naa.60003ff4", "Microsoft iSCSI Target"],
  ["naa.6001405", "Linux LIO Target"],
  ["naa.6000c29", "VMware Virtual Disk"],
];

export function vendorFromNaa(diskName: string | null | undefined): string | null {
  if (!diskName) return null;
  const d = diskName.toLowerCase().trim();
  for (const [prefix, vendor] of NAA_VENDOR_PREFIXES) {
    if (d.startsWith(prefix)) return vendor;
  }
  return null;
}

/** Derive the display label for a datastore's backing. Exported for tests. */
export function backingLabelFor(backing: VcenterDatastoreBacking | null): string | null {
  if (!backing) return null;
  if (backing.vmfs && backing.vmfs.length > 0) {
    const vendors = [...new Set(backing.vmfs.map((e) => e.vendor).filter((v): v is string => !!v))];
    if (vendors.length > 0) return vendors.join(" + ");
    return null;
  }
  if (backing.nas) return `NFS: ${backing.nas.remoteHost}`;
  return null;
}

// ─── Pure helpers (exported for tests + syncVcenterDevices) ─────────────────

/**
 * May this run's inventory be read as "everything vCenter still has"?
 *
 * Absence from a discovery read is only evidence of deletion when the read was
 * whole. Two answers must never be treated as a deleted fleet:
 *   - an incomplete inventory (a per-host VM list failed and was logged rather
 *     than failing the run), and
 *   - an empty one (zero hosts AND zero VMs is a credential/permission answer
 *     far more often than a genuinely emptied vCenter — business rule 35's
 *     shrunken-read guard, same reasoning).
 *
 * Returns the reason string when the sweep must be skipped, or null when the
 * inventory is trustworthy.
 */
export function vcenterSweepBlockedReason(
  result: Pick<VcenterDiscoveryResult, "hosts" | "vms" | "inventoryComplete"> & { scoped?: boolean },
): string | null {
  // Checked FIRST so a scoped run gets an accurate reason rather than the
  // "a per-host VM list failed" message, which would be a lie an operator
  // could waste an afternoon on.
  if (result.scoped) return "the run was scoped to a single device";
  if (!result.inventoryComplete) return "the inventory read was incomplete (a per-host VM list failed)";
  if (result.hosts.length === 0 && result.vms.length === 0) return "the inventory came back empty";
  return null;
}

/**
 * Split stale vcenter AssetSource rows (externalId no longer in the current
 * inventory) into the ones that really vanished and the ones that are still in
 * vCenter but dropped out of `result.vms` for an innocent reason — excluded by
 * `vmInclude`/`vmExclude`, or a per-VM detail call that failed this cycle.
 *
 * `presentVmMorefs` is the RAW per-host listing, taken before the name filter
 * and before the detail fan-out, so a filter change reads as "still there"
 * rather than as a deletion — the same call the FortiGate roster sweep makes.
 * Host rows are never retained this way: the host list either arrives whole or
 * throws, so a missing host moref really is a removed host.
 */
export function partitionStaleVcenterSources<T extends { sourceKind: string; observed: unknown }>(
  rows: T[],
  presentVmMorefs: Iterable<string>,
): { retained: T[]; gone: T[] } {
  const present = presentVmMorefs instanceof Set ? presentVmMorefs : new Set(presentVmMorefs);
  const retained: T[] = [];
  const gone: T[] = [];
  for (const row of rows) {
    const moref = (row.observed as { moref?: unknown } | null)?.moref;
    if (row.sourceKind === "vcenter-vm" && typeof moref === "string" && present.has(moref)) retained.push(row);
    else gone.push(row);
  }
  return { retained, gone };
}


/**
 * VM externalId for the AssetSource identity key. instanceUuid survives
 * vMotion and host moves and is unique per vCenter; when the detail call
 * couldn't produce one, fall back to the integration-scoped moref (morefs
 * like "vm-42" repeat across different vCenters).
 */
export function pickVmExternalId(
  vm: Pick<DiscoveredVcenterVm, "moref" | "instanceUuid">,
  integrationId: string,
): string {
  return vm.instanceUuid || `${integrationId}:${vm.moref}`;
}

/** Host externalId — always integration-scoped (no REST-visible hardware UUID). */
export function hostExternalId(hostMoref: string, integrationId: string): string {
  return `${integrationId}:${hostMoref}`;
}

/** cluster moref → member host morefs, from the per-cluster host listing. */
export function buildClusterHostMap(
  hostsByCluster: ReadonlyArray<{ clusterMoref: string; hostMorefs: string[] }>,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of hostsByCluster) out.set(entry.clusterMoref, [...entry.hostMorefs]);
  return out;
}

/**
 * Build VM→host dependency edges, vMotion-safe:
 *  - VM on a CLUSTERED host → one edge per cluster-member host asset. Under
 *    the all-down multi-parent semantics the VM suppresses only when the
 *    whole cluster is down, so an intra-cluster vMotion between discovery
 *    cycles can never cause a false Dep. Down.
 *  - VM on a standalone host → single edge.
 * Hosts without a Polaris asset (not yet synced / filtered) are skipped.
 * Returns deduped (assetId, parentAssetId) pairs.
 */
export function buildVcenterDependencyEdges(
  placements: ReadonlyArray<{ vmAssetId: string; hostMoref: string }>,
  hostAssetIdByMoref: ReadonlyMap<string, string>,
  clusterMorefByHostMoref: ReadonlyMap<string, string>,
  clusterHostMorefs: ReadonlyMap<string, string[]>,
): Array<{ assetId: string; parentAssetId: string }> {
  const seen = new Set<string>();
  const out: Array<{ assetId: string; parentAssetId: string }> = [];
  for (const p of placements) {
    const clusterMoref = clusterMorefByHostMoref.get(p.hostMoref);
    const parentMorefs =
      clusterMoref !== undefined
        ? clusterHostMorefs.get(clusterMoref) ?? [p.hostMoref]
        : [p.hostMoref];
    for (const hostMoref of parentMorefs) {
      const parentAssetId = hostAssetIdByMoref.get(hostMoref);
      if (!parentAssetId || parentAssetId === p.vmAssetId) continue;
      const key = `${p.vmAssetId}::${parentAssetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ assetId: p.vmAssetId, parentAssetId });
    }
  }
  return out;
}

/** Wildcard match (same semantics as the AD OU filters). Exported for tests. */
// Shared glob-lite matcher (exported alias — the unit tests exercise the
// VM-filter semantics through this name).
export const matchesVmWildcard = matchesWildcard;

export function filterVms<T extends { name: string }>(
  vms: T[],
  include?: string[],
  exclude?: string[],
): T[] {
  if (include && include.length > 0) {
    return vms.filter((vm) => include.some((p) => matchesVmWildcard(p, vm.name)));
  }
  if (exclude && exclude.length > 0) {
    return vms.filter((vm) => !exclude.some((p) => matchesVmWildcard(p, vm.name)));
  }
  return vms;
}

/**
 * Parse the REST VM detail body into the discovery shape (guest + quickStats
 * fields are merged by the caller). Defensive — every field is optional.
 * Exported for tests.
 */
export function parseVmDetail(
  moref: string,
  hostMoref: string,
  listName: string,
  listPowerState: string,
  detail: any,
  datastoreMorefByName: ReadonlyMap<string, string>,
): DiscoveredVcenterVm {
  const identity = detail?.identity ?? {};
  const cpu = detail?.cpu ?? {};
  const memory = detail?.memory ?? {};

  const nicMacs: Array<{ mac: string; connected: boolean }> = [];
  for (const nic of Object.values<any>(detail?.nics ?? {})) {
    const mac = typeof nic?.mac_address === "string" ? nic.mac_address : null;
    if (!mac) continue;
    nicMacs.push({ mac, connected: nic?.state === "CONNECTED" });
  }

  const disks: VcenterVmDisk[] = [];
  for (const [key, disk] of Object.entries<any>(detail?.disks ?? {})) {
    const vmdk = typeof disk?.backing?.vmdk_file === "string" ? disk.backing.vmdk_file : "";
    // Backing file format: "[datastoreName] path/to/file.vmdk"
    const dsName = vmdk.match(/^\[([^\]]+)\]/)?.[1] ?? null;
    disks.push({
      key,
      label: typeof disk?.label === "string" ? disk.label : `Disk ${key}`,
      capacityBytes: typeof disk?.capacity === "number" ? disk.capacity : null,
      datastoreName: dsName,
      datastoreMoref: dsName ? datastoreMorefByName.get(dsName) ?? null : null,
    });
  }

  return {
    moref,
    instanceUuid: typeof identity?.instance_uuid === "string" ? identity.instance_uuid : null,
    biosUuid: typeof identity?.bios_uuid === "string" ? identity.bios_uuid : null,
    name: typeof detail?.name === "string" && detail.name ? detail.name : listName,
    powerState: typeof detail?.power_state === "string" ? detail.power_state : listPowerState,
    hostMoref,
    guestHostname: null,
    guestIp: null,
    guestOsFullName: null,
    toolsRunState: null,
    toolsVersionStatus: null,
    cpuCount: typeof cpu?.count === "number" ? cpu.count : null,
    memoryMiB: typeof memory?.size_MiB === "number" ? memory.size_MiB : null,
    cpuUsageMhz: null,
    cpuMaxMhz: null,
    memUsedBytes: null,
    nicMacs,
    disks,
  };
}

// ─── Inventory discovery ────────────────────────────────────────────────────

/** Run `fn` over `items` with bounded concurrency; aborts stop new starts. */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (signal?.aborted) return;
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function discoverInventory(
  config: VcenterConfig,
  signal?: AbortSignal,
  onProgress?: VcenterDiscoveryProgressCallback,
  /**
   * Narrow the run to ONE VM or ONE ESXi host. Backs the asset slide-in's
   * "Discover Now".
   *
   * The win is Phase 4: a full run spends 3–4 REST calls PER VM on detail,
   * Tools and guest identity, so a 2000-VM vCenter is thousands of calls; a
   * VM-scoped run does that for one. Phases 1/2/5/6 are bounded by HOST count
   * (tens), so they stay — and Phase 1 has to stay regardless, because VM→host
   * placement is derived from the per-host listing and a VM written without its
   * host would clobber `Asset.virtualization.hostAssetId`.
   *
   * The returned result is marked `scoped`, which is what stops the sync layer
   * reading one VM as "the rest of the fleet was deleted".
   */
  scope?: { kind: "vm" | "host"; moref: string },
): Promise<VcenterDiscoveryResult> {
  const log = onProgress || (() => {});

  if (!config.host) throw new AppError(400, "Host is required");
  if (!config.username) throw new AppError(400, "Username is required");
  if (!config.password) throw new AppError(400, "Password is required");

  const session = new VcenterRestSession(config);
  try {
    await session.login(signal);

    // Phase 1 — clusters + hosts + membership.
    const clusterRows = await session.request<Array<{ cluster: string; name: string }>>(
      "GET",
      "/api/vcenter/cluster",
      { signal },
    );
    const clusters: DiscoveredVcenterCluster[] = clusterRows.map((c) => ({ moref: c.cluster, name: c.name }));

    const hostRows = await session.request<
      Array<{ host: string; name: string; connection_state?: string; power_state?: string }>
    >("GET", "/api/vcenter/host", { signal });

    const clusterByHost = new Map<string, DiscoveredVcenterCluster>();
    for (const cluster of clusters) {
      if (signal?.aborted) throw new AppError(499, "Aborted");
      try {
        const members = await session.request<Array<{ host: string }>>("GET", "/api/vcenter/host", {
          query: { clusters: cluster.moref },
          signal,
        });
        for (const member of members) clusterByHost.set(member.host, cluster);
      } catch (err: any) {
        log("discover.vcenter.cluster", "error", `vCenter: failed to list hosts for cluster ${cluster.name} — ${err?.message}`);
      }
    }

    const hosts: DiscoveredVcenterHost[] = hostRows.map((h) => ({
      moref: h.host,
      name: h.name,
      connectionState: h.connection_state || "",
      powerState: h.power_state || "",
      clusterMoref: clusterByHost.get(h.host)?.moref ?? null,
      clusterName: clusterByHost.get(h.host)?.name ?? null,
      vswitches: null,
      portgroups: null,
      datastoreMorefs: [],
      resolvedIp: null,
    }));
    log("discover.vcenter.inventory", "info", `vCenter: ${hosts.length} ESXi host(s), ${clusters.length} cluster(s)`);

    // Phase 2 — datastores + host virtual networking. SOAP-primary via the
    // SAME fetch the monitor loop uses (`fetchVcenterHostSnapshot`: one session,
    // HostSystem properties then Datastore properties), so the host's vSwitches
    // and port groups ride along at no extra call cost and there is exactly one
    // parser for them. REST fallback keeps capacity figures when /sdk is
    // unreachable — vSwitches simply stay null there, which the General-tab
    // section renders as absent rather than as "no vSwitches".
    let datastores: DiscoveredVcenterDatastore[] = [];
    try {
      const snapshot = await fetchVcenterHostSnapshot(config, signal);
      if (snapshot.datastoreError) throw new AppError(502, snapshot.datastoreError);
      datastores = snapshot.datastores;
      const netByMoref = new Map(snapshot.hosts.map((h) => [h.moref, h]));
      let withNet = 0;
      for (const host of hosts) {
        const stats = netByMoref.get(host.moref);
        if (!stats) continue;
        host.vswitches = stats.vswitches;
        host.portgroups = stats.portgroups;
        if (stats.vswitches) withNet++;
      }
      if (snapshot.hostError) {
        // Datastores arrived; only the virtual networking is missing. Log it
        // and carry on — vSwitches stay null, which renders as absent.
        log("discover.vcenter.hostnet", "error", `vCenter: host network config unavailable — ${snapshot.hostError}`);
      }
      log("discover.vcenter.datastores", "info", `vCenter: ${datastores.length} datastore(s) (with backing detail), virtual networking on ${withNet}/${hosts.length} host(s)`);
    } catch (err: any) {
      if (signal?.aborted) throw err;
      log("discover.vcenter.datastores", "error", `vCenter: SOAP datastore fetch failed — ${err?.message}; falling back to REST list`);
      try {
        const dsRows = await session.request<
          Array<{ datastore: string; name: string; type?: string; capacity?: number; free_space?: number }>
        >("GET", "/api/vcenter/datastore", { signal });
        datastores = dsRows.map((d) => ({
          moref: d.datastore,
          name: d.name,
          dsType: d.type ?? null,
          capacityBytes: typeof d.capacity === "number" ? d.capacity : null,
          freeBytes: typeof d.free_space === "number" ? d.free_space : null,
          provisionedBytes: null,
          accessible: null,
          hostMorefs: [],
          backing: null,
          backingLabel: null,
        }));
      } catch (restErr: any) {
        log("discover.vcenter.datastores", "error", `vCenter: REST datastore list also failed — ${restErr?.message}`);
      }
    }
    const datastoreMorefByName = new Map<string, string>();
    for (const ds of datastores) datastoreMorefByName.set(ds.name, ds.moref);
    // Project datastore host-mounts onto the host rows.
    const hostByMoref = new Map(hosts.map((h) => [h.moref, h]));
    for (const ds of datastores) {
      for (const hostMoref of ds.hostMorefs) {
        hostByMoref.get(hostMoref)?.datastoreMorefs.push(ds.moref);
      }
    }

    // Phase 3 — VM lists per host (pins VM→host placement; also sidesteps the
    // 4000-item global list cap).
    //
    // Scoped to a HOST: there is no VM work to do at all, so the whole loop is
    // skipped. Scoped to a VM: the same per-host loop runs, but each call also
    // filters on the target moref, so every host answers with 0 or 1 rows and
    // the loop still tells us WHICH host holds it — the placement fact we
    // cannot get from the VM detail endpoint.
    type VmListRow = { vm: string; name: string; power_state?: string; hostMoref: string };
    const vmRows: VmListRow[] = [];
    let vmListFailures = 0;
    for (const host of (scope?.kind === "host" ? [] : hosts)) {
      if (signal?.aborted) throw new AppError(499, "Aborted");
      log("discover.device.start", "info", `vCenter: listing VMs on ${host.name}`);
      try {
        const rows = await session.request<Array<{ vm: string; name: string; power_state?: string }>>(
          "GET",
          "/api/vcenter/vm",
          { query: scope?.kind === "vm" ? { hosts: host.moref, vms: scope.moref } : { hosts: host.moref }, signal },
        );
        for (const row of rows) vmRows.push({ ...row, hostMoref: host.moref });
        log("discover.device.complete", "info", `vCenter: ${host.name} — ${rows.length} VM(s)`);
      } catch (err: any) {
        if (signal?.aborted) throw err;
        // The run continues without this host's VMs — which makes the
        // inventory incomplete, and an incomplete inventory must never be read
        // as "these VMs were deleted".
        vmListFailures += 1;
        log("discover.device.skip", "error", `vCenter: VM list failed for ${host.name} — ${err?.message}`);
      }
    }
    log("discover.devices", "info", `Found ${vmRows.length} virtual machine(s) across ${hosts.length} host(s)`);

    // Name filter BEFORE the per-VM detail fan-out — excluded VMs cost nothing.
    const filteredRows = filterVms(vmRows, config.vmInclude, config.vmExclude);
    const droppedByFilter = vmRows.length - filteredRows.length;
    if (droppedByFilter > 0) {
      log("discover.filter", "info", `VM filter: ${filteredRows.length} included, ${droppedByFilter} excluded`);
    }

    // Phase 4 — per-VM detail + Tools guest info (bounded fan-out).
    const vms = (
      await mapBounded(filteredRows, VM_DETAIL_CONCURRENCY, signal, async (row): Promise<DiscoveredVcenterVm | null> => {
        let detail: any = null;
        try {
          detail = await session.request<any>("GET", `/api/vcenter/vm/${row.vm}`, { signal });
        } catch (err: any) {
          if (signal?.aborted) return null;
          log("discover.device.skip", "error", `vCenter: VM detail failed for ${row.name} (${row.vm}) — ${err?.message}`);
          return null;
        }
        const vm = parseVmDetail(row.vm, row.hostMoref, row.name, row.power_state || "", detail, datastoreMorefByName);

        // Tools state — cheap and works regardless of guest state.
        try {
          const tools = await session.request<any>("GET", `/api/vcenter/vm/${row.vm}/tools`, { signal });
          vm.toolsRunState = typeof tools?.run_state === "string" ? tools.run_state : null;
          vm.toolsVersionStatus = typeof tools?.version_status === "string" ? tools.version_status : null;
        } catch { /* older FTools endpoints may 404 — treat as unknown */ }

        // Guest surfaces need running Tools (503 otherwise) — each degrades alone.
        if (vm.toolsRunState === "RUNNING") {
          try {
            const identity = await session.request<any>("GET", `/api/vcenter/vm/${row.vm}/guest/identity`, { signal });
            vm.guestHostname = typeof identity?.host_name === "string" && identity.host_name ? identity.host_name : null;
            vm.guestIp = typeof identity?.ip_address === "string" && identity.ip_address ? identity.ip_address : null;
            vm.guestOsFullName = typeof identity?.full_name?.default_message === "string"
              ? identity.full_name.default_message
              : typeof identity?.full_name === "string" ? identity.full_name : null;
          } catch { /* null */ }
        }
        return vm;
      })
    ).filter((vm): vm is DiscoveredVcenterVm => vm !== null);

    if (signal?.aborted) throw new AppError(499, "Aborted");

    // Phase 5 — SOAP quickStats merge (usage snapshot; graceful absence).
    try {
      const stats = await fetchVcenterQuickStats(config, signal);
      const byMoref = new Map(stats.map((s) => [s.moref, s]));
      for (const vm of vms) {
        const s = byMoref.get(vm.moref);
        if (!s) continue;
        vm.cpuUsageMhz = s.cpuUsageMhz;
        vm.cpuMaxMhz = s.cpuMaxMhz;
        vm.memUsedBytes = s.guestMemUsageMB !== null ? s.guestMemUsageMB * 1024 * 1024 : null;
        if (vm.instanceUuid === null && s.instanceUuid) vm.instanceUuid = s.instanceUuid;
      }
      log("discover.vcenter.quickstats", "info", `vCenter: usage stats merged for ${stats.length} VM(s)`);
    } catch (err: any) {
      if (signal?.aborted) throw err;
      log("discover.vcenter.quickstats", "error", `vCenter: SOAP quickStats fetch failed — ${err?.message}; usage figures unavailable this cycle`);
    }

    // Phase 6 — resolve host FQDNs to IPs (REST exposes no host mgmt IP).
    try {
      const resolver = await getConfiguredResolver();
      await mapBounded(hosts, 6, signal, async (host) => {
        if (!host.name || /^\d{1,3}(\.\d{1,3}){3}$/.test(host.name)) {
          // Host was added by IP — use it directly.
          host.resolvedIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host.name) ? host.name : null;
          return;
        }
        try {
          const records = await resolver.lookup(host.name);
          host.resolvedIp = records[0]?.address ?? null;
        } catch { /* unresolvable — leave null */ }
      });
    } catch (err: any) {
      logger.debug({ err: err?.message }, "vcenter: host DNS resolution unavailable");
    }

    // A scoped run returns only the host(s) it actually concerns, so the sync
    // doesn't upsert the whole cluster for one operator's click:
    //   host scope — the target host.
    //   vm scope   — the host the VM was found on. Its asset row still has to be
    //                written, because `hostAssetIdByMoref` is how the VM's
    //                `virtualization.hostAssetId` resolves; dropping it would
    //                write the VM with no placement.
    // Empty when the target wasn't found — a scoped run that matched nothing
    // syncs nothing, and every absence-based pass is suppressed anyway.
    const scopedHostMorefs = new Set(
      scope?.kind === "host" ? [scope.moref] : scope?.kind === "vm" ? vms.map((v) => v.hostMoref) : [],
    );
    const returnedHosts = scope ? hosts.filter((h) => scopedHostMorefs.has(h.moref)) : hosts;

    return {
      clusters,
      hosts: returnedHosts,
      vms,
      datastores,
      presentVmMorefs: vmRows.map((r) => r.vm),
      // A scoped run did NOT read the whole inventory, so this is the honest
      // value — and it is load-bearing: `vcenterSweepBlockedReason` treats an
      // incomplete read as "never sweep", which is the SECOND independent guard
      // stopping a one-device result from being read as a deleted fleet. The
      // first is `scoped` below. Two guards because the failure is silent and
      // catastrophic: it decommissions assets.
      inventoryComplete: scope ? false : vmListFailures === 0,
      scoped: scope ? true : undefined,
    };
  } finally {
    await session.logout();
  }
}
