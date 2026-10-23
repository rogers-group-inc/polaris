/**
 * src/services/genericApiMonitorService.ts
 *
 * The `genericapi` polling method (business rule 100(i)): response time,
 * CPU / memory, interfaces, storage, temperature and LLDP — plus custom
 * widgets — for an asset a Generic API integration discovered, read from the
 * operator's own monitor queries (GenericApiMonitorQuery in genericApiService).
 * The asset itself is never contacted. monitoringService dispatches here
 * before its IP guard, the workload posture.
 *
 * Every read produces one DOCUMENT for the asset:
 *   fleet — one request per query per tick (paged like the inventory when the
 *           query says so), warm-cached for FLEET_TTL_MS and shared by every
 *           asset and every stream on that query; each record is joined to an
 *           asset by the query's match path, normalized like the integration's
 *           identity field. 2000 assets on one fleet query cost one paged read
 *           per 30 s, not 2000.
 *   asset — one request per asset, its path a `{{path}}` template filled from
 *           the asset's own record as the inventory last mapped it (the
 *           `generic-api` AssetSource's observed blob). Cached for ASSET_TTL_MS
 *           so the interfaces, storage and LLDP read of one query on one pass
 *           share one request, and run at most `detailConcurrency` at a time
 *           per integration.
 *
 * The reading model is the workload one, for the workload reason:
 *   doc         — the source answered about this asset; its values decide.
 *   absent      — the source answered and this asset is not in it (a 404 on a
 *                 per-asset query, a complete fleet read without the record).
 *                 A real finding: the probe FAILS.
 *   unreachable — Polaris could not ask (API down, credentials refused,
 *                 integration disabled, an incomplete fleet read). A fact about
 *                 the feed, not the device: the probe is SKIPPED, so one
 *                 inventory server outage never declares a fleet down.
 *   none        — the asset's feed has no query for this stream: the method is
 *                 set where nothing can answer it.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { readJsonPathString, readJsonPathStrings, selectRecords } from "../utils/jsonPath.js";
import { evaluateStateMap, normalizeStateMap, type StateMap } from "../utils/stateProbes.js";
import { GENERIC_API_SOURCE_KIND, GENERIC_API_TYPE, genericApiIdentityFromExternalId } from "../utils/genericApiSource.js";
import { isIpv6Address, isValidIpAddress } from "../utils/cidr.js";
import { normalizeMacsDistinct } from "../utils/mac.js";
import {
  GENERIC_API_BYTE_UNITS,
  GENERIC_API_MONITOR_LIMITS,
  buildRequestHeaders,
  fetchGenericApiRecords,
  fetchJsonDocument,
  fillDetailTemplate,
  genericApiWidgetId,
  identityKeyFor,
  type GenericApiConfig,
  type GenericApiIdentityField,
  type GenericApiMonitorQuery,
  type GenericApiMonitorStream,
  type GenericApiWidgetDef,
} from "./genericApiService.js";
import type {
  CollectionResult,
  HardwareSensorSample,
  InterfaceSample,
  LldpNeighborSample,
  ProbeResult,
  StorageSample,
  SystemInfoSample,
  TelemetrySample,
} from "./monitoringService.js";

/** The method name — the same word as the integration type. */
export const GENERIC_API_POLLING_METHOD = "genericapi";

export const FLEET_TTL_MS = 30_000;
export const ASSET_TTL_MS = 30_000;
/** One OAuth token / header set per integration for this long — never a token per request. */
const HEADERS_TTL_MS = 5 * 60_000;

interface FleetSnapshot {
  byIdentity: Map<string, unknown>;
  complete: boolean;
  warnings: string[];
}
type AssetDoc = { ok: true; doc: unknown } | { ok: false; notFound: boolean; error: string };

const fleetCache = createTtlCache<FleetSnapshot>({ ttlMs: FLEET_TTL_MS, maxEntries: 256 });
// Sized for 2000+ assets × several per-asset queries: an evicted entry only
// costs a repeat request, but a cap below the working set would cost one per
// stream per pass.
const assetCache = createTtlCache<AssetDoc>({ ttlMs: ASSET_TTL_MS, maxEntries: 32_768 });
const headerCache = createTtlCache<Record<string, string>>({ ttlMs: HEADERS_TTL_MS, maxEntries: 256 });

/** Drop every cached read — tests, and a process that wants a clean slate. */
export function invalidateGenericApiMonitorCache(): void {
  fleetCache.invalidate();
  assetCache.invalidate();
  headerCache.invalidate();
}

// ─── Per-integration request slots (per-asset scope) ──────────────────────────

const slots = new Map<string, { active: number; waiting: Array<() => void> }>();

async function withSlot<T>(key: string, limit: number, fn: () => Promise<T>): Promise<T> {
  let s = slots.get(key);
  if (!s) { s = { active: 0, waiting: [] }; slots.set(key, s); }
  const state = s;
  if (state.active >= limit) await new Promise<void>((resolve) => state.waiting.push(resolve));
  state.active++;
  try {
    return await fn();
  } finally {
    state.active--;
    const next = state.waiting.shift();
    if (next) next();
    else if (state.active === 0) slots.delete(key);
  }
}

function queryHashOf(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * A short stable hash of a query and the request it makes, so an edited query
 * (or a moved host) never reads a stale cache entry — the edit happens on the
 * web role, and nothing can invalidate this process's caches from there.
 */
function queryHash(q: GenericApiMonitorQuery, cfg: GenericApiConfig): string {
  return queryHashOf(JSON.stringify([
    q.scope, q.path, q.method, q.body, q.recordsPath, q.matchPath, q.paginate,
    cfg.identityField ?? "id", cfg.host, cfg.port, cfg.useHttps, q.paginate ? cfg.pagination : null,
  ]));
}

// ─── Reading one asset ────────────────────────────────────────────────────────

export type GenericApiMonitorReading =
  | { kind: "doc"; doc: unknown; query: GenericApiMonitorQuery; integrationId: string; integrationName: string }
  | { kind: "absent"; error: string }
  | { kind: "unreachable"; error: string }
  | { kind: "none"; error: string };

interface SourceRow {
  externalId: string;
  observed: unknown;
  integration: { id: string; name: string; type: string; config: unknown; enabled: boolean } | null;
}

async function loadSourceRows(assetId: string): Promise<SourceRow[]> {
  return prisma.assetSource.findMany({
    where: { assetId, sourceKind: GENERIC_API_SOURCE_KIND },
    select: { externalId: true, observed: true, integration: { select: { id: true, name: true, type: true, config: true, enabled: true } } },
  }) as unknown as Promise<SourceRow[]>;
}

const STREAM_LABEL: Record<GenericApiMonitorStream, string> = {
  responseTime: "response time",
  cpuMemory: "CPU / memory",
  interfaces: "interfaces",
  storage: "storage",
  temperature: "temperature",
  lldp: "LLDP",
  widgets: "custom widgets",
};

/** The template context a per-asset query fills from: the observed blob, plus `mac` (the first MAC). */
export function assetTemplateContext(observed: unknown): Record<string, unknown> {
  const o = (observed && typeof observed === "object" ? observed : {}) as Record<string, unknown>;
  const macs = Array.isArray(o.macs) ? o.macs : [];
  return { ...o, mac: macs[0] ?? null };
}

/**
 * The run's headers, cached per integration AND per credential fingerprint:
 * the integration is edited on the web role and read here on the monitor
 * role, which cannot be told to invalidate, so a changed token or header has
 * to miss the cache on its own. The fingerprint is a hash held in memory only.
 */
async function headersFor(integrationId: string, cfg: GenericApiConfig): Promise<Record<string, string>> {
  const fp = queryHashOf(JSON.stringify([
    cfg.authType, cfg.apiToken, cfg.authHeaderName, cfg.username, cfg.password,
    cfg.tokenUrl, cfg.clientId, cfg.clientSecret, cfg.scope, cfg.headers, cfg.method,
  ]));
  return headerCache.getOrCompute(`${integrationId}:${fp}`, () => buildRequestHeaders(cfg));
}

async function fetchFleet(cfg: GenericApiConfig, q: GenericApiMonitorQuery, headers: Record<string, string>): Promise<FleetSnapshot> {
  const readCfg: GenericApiConfig = {
    ...cfg,
    path: q.path,
    method: q.method ?? "GET",
    body: q.body ?? "",
    recordsPath: q.recordsPath ?? "",
    pagination: q.paginate ? cfg.pagination : { mode: "none" },
  };
  const fetched = await fetchGenericApiRecords(readCfg, { headers });
  const identityField = (cfg.identityField ?? "id") as GenericApiIdentityField;
  const byIdentity = new Map<string, unknown>();
  for (const rec of fetched.records) {
    const key = identityKeyFor(identityField, readJsonPathString(rec, q.matchPath));
    if (key && !byIdentity.has(key)) byIdentity.set(key, rec);
  }
  return { byIdentity, complete: fetched.complete, warnings: fetched.warnings };
}

/** One query's document for one asset (the row is the asset's source row on the query's integration). */
async function readQuery(assetId: string, row: SourceRow, q: GenericApiMonitorQuery): Promise<GenericApiMonitorReading> {
  const intg = row.integration!;
  const cfg = (intg.config ?? {}) as GenericApiConfig;
  if (!intg.enabled) return { kind: "unreachable", error: `Integration "${intg.name}" is disabled` };
  const identity = genericApiIdentityFromExternalId(intg.id, row.externalId);
  if (identity === null) return { kind: "absent", error: "This asset's Generic API record belongs to another integration" };
  const hash = queryHash(q, cfg);
  let headers: Record<string, string>;
  try {
    headers = await headersFor(intg.id, cfg);
  } catch (err) {
    return { kind: "unreachable", error: (err as Error)?.message || "Could not authenticate" };
  }
  const doc = { integrationId: intg.id, integrationName: intg.name, query: q };

  if (q.scope === "fleet") {
    let snap: FleetSnapshot;
    try {
      snap = await fleetCache.getOrCompute(`${intg.id}:${hash}`, () => fetchFleet(cfg, q, headers));
    } catch (err) {
      return { kind: "unreachable", error: (err as Error)?.message || "The fleet query failed" };
    }
    const found = snap.byIdentity.get(identity);
    if (found !== undefined) return { kind: "doc", doc: found, ...doc };
    // An incomplete read cannot tell "gone" from "on a page not read".
    if (!snap.complete) return { kind: "unreachable", error: `The fleet query was not read to the end (${snap.warnings[0] ?? "incomplete"})` };
    return { kind: "absent", error: `Not in "${q.name || "the fleet query"}" on "${intg.name}"` };
  }

  const ctx = assetTemplateContext(row.observed);
  const path = fillDetailTemplate(q.path, ctx, "path");
  if (!path.ok) return { kind: "absent", error: path.reason };
  let body: string | undefined;
  if (q.method === "POST") {
    const b = fillDetailTemplate((q.body ?? "").trim() || "{}", ctx, "body");
    if (!b.ok) return { kind: "absent", error: b.reason };
    body = b.value;
  }
  const limit = Math.max(1, Math.min(cfg.detailConcurrency ?? GENERIC_API_MONITOR_LIMITS.defaultAssetConcurrency, 16));
  const res = await assetCache.getOrCompute(`${intg.id}:${hash}:${assetId}`, () =>
    withSlot(intg.id, limit, () => fetchJsonDocument(cfg, { path: path.value, method: q.method, body }, headers)));
  if (res.ok) return { kind: "doc", doc: res.doc, ...doc };
  return res.notFound ? { kind: "absent", error: res.error } : { kind: "unreachable", error: res.error };
}

/**
 * The asset's document for one stream: the first of its Generic API source
 * rows whose integration has a query for the stream (an asset two feeds both
 * list is read through whichever was configured for it).
 */
export async function readGenericApiAsset(assetId: string, stream: GenericApiMonitorStream): Promise<GenericApiMonitorReading> {
  const rows = await loadSourceRows(assetId);
  for (const row of rows) {
    if (!row.integration || row.integration.type !== GENERIC_API_TYPE) continue;
    const queries = ((row.integration.config as GenericApiConfig | null)?.monitorQueries ?? []);
    const q = queries.find((x) => x.stream === stream);
    if (q) return readQuery(assetId, row, q);
  }
  return rows.length === 0
    ? { kind: "none", error: "This asset has no Generic API record (the method needs one)" }
    : { kind: "none", error: `This asset's Generic API integration has no ${STREAM_LABEL[stream]} monitor query` };
}

// ─── Value reading (pure) ─────────────────────────────────────────────────────

/** A number at the path: a numeric string ("42.5", "42.5 %") counts; anything else is null. */
export function readNumber(doc: unknown, path: string | undefined): number | null {
  const s = readJsonPathString(doc, path);
  if (s === null) return null;
  const n = Number.parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function pct(v: number | null): number | null {
  if (v === null) return null;
  return Math.min(100, Math.max(0, v));
}

function bytes(doc: unknown, path: string | undefined, q: GenericApiMonitorQuery): number | null {
  const n = readNumber(doc, path);
  if (n === null || n < 0) return null;
  return Math.round(n * GENERIC_API_BYTE_UNITS[q.byteUnit ?? "B"]);
}

const DEFAULT_UP_VALUES = ["true", "up", "online", "ok", "running", "1", "yes", "active", "healthy", "connected", "available"];

/** Up / down from the `up` path. A value not in the up list is down; a missing value is no answer. */
export function buildProbeResult(doc: unknown, q: GenericApiMonitorQuery): ProbeResult {
  const map = q.map ?? {};
  const raw = readJsonPathString(doc, map.up);
  if (raw === null) return { success: false, responseTimeMs: 0, error: `No value at "${map.up}"` };
  const upValues = (q.upValues && q.upValues.length > 0 ? q.upValues : DEFAULT_UP_VALUES).map((v) => v.trim().toLowerCase());
  const up = upValues.includes(raw.trim().toLowerCase());
  // The latency the SOURCE reports for the device, when it reports one — never
  // the round trip to the inventory server, which says nothing about the device.
  const latency = readNumber(doc, map.latencyMs);
  const uptime = readNumber(doc, map.uptimeSec);
  const out: ProbeResult = up
    ? { success: true, responseTimeMs: latency !== null && latency >= 0 ? Math.round(latency) : 0 }
    : { success: false, responseTimeMs: 0, error: `The feed reports "${raw}"` };
  if (up && uptime !== null && uptime >= 0) out.uptimeSec = Math.floor(uptime);
  return out;
}

export function buildTelemetry(doc: unknown, q: GenericApiMonitorQuery): TelemetrySample | null {
  const map = q.map ?? {};
  const cpuPct = pct(readNumber(doc, map.cpuPct));
  let memUsedBytes = bytes(doc, map.memUsed, q);
  const memTotalBytes = bytes(doc, map.memTotal, q);
  const memFree = bytes(doc, map.memFree, q);
  if (memUsedBytes === null && memTotalBytes !== null && memFree !== null) memUsedBytes = Math.max(0, memTotalBytes - memFree);
  let memPct = pct(readNumber(doc, map.memPct));
  if (memPct === null && memUsedBytes !== null && memTotalBytes) memPct = pct((memUsedBytes / memTotalBytes) * 100);
  if (cpuPct === null && memPct === null && memUsedBytes === null) return null;
  return { cpuPct, memPct, memUsedBytes, memTotalBytes };
}

function rows(doc: unknown, q: GenericApiMonitorQuery): Record<string, unknown>[] {
  return selectRecords(doc, q.itemsPath ?? "").records;
}

function str(row: unknown, path: string | undefined): string | null {
  return readJsonPathString(row, path);
}

/** "up" / "down" from the usual spellings; anything else is kept, lower-cased. */
export function normalizeOperStatus(v: string | null): string | null {
  if (v === null) return null;
  const s = v.trim().toLowerCase();
  if (["true", "up", "1", "online", "connected", "active", "enabled"].includes(s)) return "up";
  if (["false", "down", "0", "offline", "disconnected", "inactive", "disabled", "notpresent", "lowerlayerdown"].includes(s)) return "down";
  return s || null;
}

export function buildInterfaces(doc: unknown, q: GenericApiMonitorQuery): InterfaceSample[] {
  const map = q.map ?? {};
  const out: InterfaceSample[] = [];
  const seen = new Set<string>();
  for (const r of rows(doc, q)) {
    const ifName = str(r, map.name);
    if (!ifName || seen.has(ifName)) continue;
    seen.add(ifName);
    const mbps = readNumber(r, map.speedMbps);
    const bps = readNumber(r, map.speedBps) ?? (mbps !== null ? mbps * 1_000_000 : null);
    const mac = normalizeMacsDistinct(readJsonPathStrings(r, map.macAddress))[0] ?? null;
    const ip = (str(r, map.ipAddress) ?? "").split("/")[0].trim();
    // Business rule 126: an optional IPv6 mapping of its own. The write path
    // normalises both (an IPv6 the operator mapped to ipAddress moves over,
    // loopback / link-local are dropped), so this only has to read it.
    const ip6 = (str(r, map.ipv6Address) ?? "").split("/")[0].trim();
    const counter = (p: string | undefined) => { const n = readNumber(r, p); return n !== null && n >= 0 ? Math.round(n) : null; };
    out.push({
      ifName,
      operStatus: normalizeOperStatus(str(r, map.operStatus)),
      adminStatus: normalizeOperStatus(str(r, map.adminStatus)),
      speedBps: bps !== null && bps >= 0 ? Math.round(bps) : null,
      inOctets: counter(map.inOctets),
      outOctets: counter(map.outOctets),
      inErrors: counter(map.inErrors),
      outErrors: counter(map.outErrors),
      ...(mac ? { macAddress: mac } : {}),
      ...(ip && isValidIpAddress(ip) ? { ipAddress: ip } : {}),
      ...(ip6 && isIpv6Address(ip6) ? { ipv6Address: ip6 } : {}),
      ...(str(r, map.description) ? { description: str(r, map.description) } : {}),
      ...(str(r, map.alias) ? { alias: str(r, map.alias) } : {}),
    });
  }
  return out;
}

export function buildStorage(doc: unknown, q: GenericApiMonitorQuery): StorageSample[] {
  const map = q.map ?? {};
  const out: StorageSample[] = [];
  const seen = new Set<string>();
  for (const r of rows(doc, q)) {
    const mountPath = str(r, map.mountPath);
    if (!mountPath || seen.has(mountPath)) continue;
    seen.add(mountPath);
    const totalBytes = bytes(r, map.total, q);
    let usedBytes = bytes(r, map.used, q);
    const free = bytes(r, map.free, q);
    if (usedBytes === null && totalBytes !== null && free !== null) usedBytes = Math.max(0, totalBytes - free);
    out.push({ mountPath, totalBytes, usedBytes });
  }
  return out;
}

export function buildTemperatures(doc: unknown, q: GenericApiMonitorQuery): HardwareSensorSample[] {
  const map = q.map ?? {};
  const out: HardwareSensorSample[] = [];
  for (const r of rows(doc, q)) {
    const sensorName = str(r, map.name);
    const value = readNumber(r, map.celsius);
    if (!sensorName || value === null) continue;
    out.push({ sensorName, sensorClass: "temperature", value, unit: "°C", alarmStatus: null });
  }
  return out;
}

export function buildLldpNeighbors(doc: unknown, q: GenericApiMonitorQuery): LldpNeighborSample[] {
  const map = q.map ?? {};
  const out: LldpNeighborSample[] = [];
  for (const r of rows(doc, q)) {
    const localIfName = str(r, map.localIfName);
    if (!localIfName) continue;
    const chassisId = str(r, map.chassisId);
    const portId = str(r, map.portId);
    const systemName = str(r, map.systemName);
    if (!chassisId && !portId && !systemName) continue;
    const mgmt = (str(r, map.managementIp) ?? "").trim();
    out.push({
      localIfName,
      chassisId,
      portId,
      portDescription: str(r, map.portDescription),
      systemName,
      systemDescription: str(r, map.systemDescription),
      managementIp: mgmt && isValidIpAddress(mgmt) ? mgmt : null,
    });
  }
  return out;
}

export interface GenericApiWidgetSamples {
  samples: Array<{ widgetId: string; kind: "scalar" | "table"; value: unknown }>;
  stateRows: Array<{ probeId: string; rowKey: string; rowLabel: string; value: number; rawValue: string | null }>;
}

/** One query's widgets read out of the asset's document. A value that is not there is skipped, never a zero. */
export function buildWidgetSamples(doc: unknown, q: GenericApiMonitorQuery, integrationId: string): GenericApiWidgetSamples {
  const out: GenericApiWidgetSamples = { samples: [], stateRows: [] };
  for (const w of q.widgets ?? []) {
    const id = genericApiWidgetId(integrationId, w.name);
    if (w.type === "state") {
      const raw = readJsonPathString(doc, w.path);
      if (raw === null) continue;
      const v = evaluateStateMap(raw, normalizeStateMap(w.stateMap ?? {}));
      if (v === null) continue;
      out.stateRows.push({ probeId: id, rowKey: "", rowLabel: w.name, value: v, rawValue: raw });
      continue;
    }
    const n = readNumber(doc, w.path);
    if (n === null) continue;
    out.samples.push({ widgetId: id, kind: "scalar", value: n });
  }
  return out;
}

// ─── The method's collectors (monitoringService dispatches here) ──────────────

export async function probeGenericApi(assetId: string): Promise<ProbeResult> {
  const reading = await readGenericApiAsset(assetId, "responseTime");
  if (reading.kind === "unreachable") {
    logger.debug({ assetId, reason: reading.error }, "genericapi probe skipped — could not read the feed");
    return { success: false, responseTimeMs: 0, skipped: true, error: reading.error };
  }
  if (reading.kind !== "doc") return { success: false, responseTimeMs: 0, error: reading.error };
  return buildProbeResult(reading.doc, reading.query);
}

export async function collectTelemetryGenericApi(assetId: string): Promise<CollectionResult<TelemetrySample>> {
  const reading = await readGenericApiAsset(assetId, "cpuMemory");
  if (reading.kind === "none") return { supported: false };
  if (reading.kind !== "doc") return { supported: true, error: reading.error };
  const data = buildTelemetry(reading.doc, reading.query);
  if (!data) return { supported: true, error: "No CPU or memory value at the mapped paths" };
  return { supported: true, data };
}

export async function collectHardwareSensorsGenericApi(assetId: string): Promise<CollectionResult<HardwareSensorSample[]>> {
  const reading = await readGenericApiAsset(assetId, "temperature");
  if (reading.kind === "none") return { supported: false };
  if (reading.kind !== "doc") return { supported: true, error: reading.error };
  return { supported: true, data: buildTemperatures(reading.doc, reading.query) };
}

/**
 * Interfaces, storage and LLDP — each from its own stream's query, only for a
 * stream whose resolved method is `genericapi`. A stream that could not be
 * read contributes nothing (an empty list, or LLDP left undefined), which the
 * persisters read as "not collected", never as "it has none".
 */
export async function collectSystemInfoGenericApi(
  assetId: string,
  effective: { interfacesPolling: string | null; storagePolling: string | null; lldpPolling?: string | null },
  pinned?: { interfaces: string[]; storage: string[] },
): Promise<CollectionResult<SystemInfoSample>> {
  const m = GENERIC_API_POLLING_METHOD;
  const want = {
    interfaces: effective.interfacesPolling === m,
    storage: effective.storagePolling === m,
    lldp: !pinned && effective.lldpPolling === m,
  };
  const [ifs, st, ll] = await Promise.all([
    want.interfaces ? readGenericApiAsset(assetId, "interfaces") : null,
    want.storage ? readGenericApiAsset(assetId, "storage") : null,
    want.lldp ? readGenericApiAsset(assetId, "lldp") : null,
  ]);
  const read = [ifs, st, ll].filter((r): r is GenericApiMonitorReading => r !== null);
  if (read.length === 0 || read.every((r) => r.kind === "none")) return { supported: false };
  if (!read.some((r) => r.kind === "doc")) {
    const failed = read.find((r): r is Extract<GenericApiMonitorReading, { error: string }> => r.kind === "absent" || r.kind === "unreachable");
    return { supported: true, error: failed?.error ?? "No Generic API monitor query answered" };
  }

  const data: SystemInfoSample = {
    interfaces: ifs?.kind === "doc" ? buildInterfaces(ifs.doc, ifs.query) : [],
    storage: st?.kind === "doc" ? buildStorage(st.doc, st.query) : [],
  };
  if (ll?.kind === "doc") {
    data.lldpNeighbors = buildLldpNeighbors(ll.doc, ll.query);
    data.lldpSource = "genericapi";
  }
  if (pinned) {
    const wantIf = new Set(pinned.interfaces);
    const wantSt = new Set(pinned.storage);
    data.interfaces = data.interfaces.filter((i) => wantIf.has(i.ifName));
    data.storage = data.storage.filter((s) => wantSt.has(s.mountPath));
  }
  return { supported: true, data };
}

/**
 * Custom widget samples from every widgets query on every Generic API
 * integration that lists the asset. Runs on the telemetry cadence beside the
 * manufacturer-profile widgets and, like the HTTP check widget, needs no
 * polling method: defining the widget on the integration is the choice.
 */
export async function collectGenericApiWidgetSamples(assetId: string): Promise<GenericApiWidgetSamples> {
  const out: GenericApiWidgetSamples = { samples: [], stateRows: [] };
  const rows = await loadSourceRows(assetId);
  const work: Array<Promise<void>> = [];
  for (const row of rows) {
    if (!row.integration || row.integration.type !== GENERIC_API_TYPE) continue;
    const queries = ((row.integration.config as GenericApiConfig | null)?.monitorQueries ?? []).filter((q) => q.stream === "widgets");
    for (const q of queries) {
      work.push((async () => {
        const reading = await readQuery(assetId, row, q);
        if (reading.kind !== "doc") return;
        const got = buildWidgetSamples(reading.doc, q, row.integration!.id);
        out.samples.push(...got.samples);
        out.stateRows.push(...got.stateRows);
      })());
    }
  }
  await Promise.all(work);
  return out;
}

/** A widget definition in the shape the asset tab's Custom widgets data already carries (CustomWidgetRow). */
export interface GenericApiWidgetRow {
  id: string;
  name: string;
  symbol: string | null;
  mibId: null;
  type: "scalar";
  widgetType: GenericApiWidgetDef["type"];
  transform: null;
  displayOptions: Record<string, unknown>;
  order: number;
  modelPattern: null;
  stateMap: StateMap | null;
  labelSymbol: null;
  source: { kind: "genericapi"; integrationId: string; integrationName: string };
}

/** The widgets the asset's Generic API integrations define for it, in query order. */
export async function genericApiWidgetDefsForAsset(assetId: string): Promise<GenericApiWidgetRow[]> {
  const rows = await loadSourceRows(assetId);
  const out: GenericApiWidgetRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const intg = row.integration;
    if (!intg || intg.type !== GENERIC_API_TYPE) continue;
    const queries = ((intg.config as GenericApiConfig | null)?.monitorQueries ?? []).filter((q) => q.stream === "widgets");
    for (const q of queries) {
      for (const w of q.widgets ?? []) {
        const id = genericApiWidgetId(intg.id, w.name);
        if (seen.has(id)) continue;
        seen.add(id);
        const displayOptions: Record<string, unknown> = {};
        if (w.unit) displayOptions.unit = w.unit;
        if (typeof w.min === "number") displayOptions.min = w.min;
        if (typeof w.max === "number") displayOptions.max = w.max;
        if (typeof w.warningAt === "number") {
          displayOptions.warningAt = w.warningAt;
          if (w.warningWhen === "below") displayOptions.warningWhen = "below";
        }
        out.push({
          id,
          name: w.name,
          // The card's subtitle: where the value comes from.
          symbol: `${intg.name} · ${w.path}`,
          mibId: null,
          type: "scalar",
          widgetType: w.type,
          transform: null,
          displayOptions,
          order: 10_000 + out.length,
          modelPattern: null,
          stateMap: w.type === "state" ? normalizeStateMap(w.stateMap ?? {}) : null,
          labelSymbol: null,
          source: { kind: "genericapi", integrationId: intg.id, integrationName: intg.name },
        });
      }
    }
  }
  return out;
}
