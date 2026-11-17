/**
 * src/services/arcgisLayerService.ts — ArcGIS feature layers READ for the
 * Device Map's Topology views (business rule 188).
 *
 * Polaris never writes to ArcGIS. An `arcgis` integration lists the feature
 * layers it reads (`config.layers`), each with a style, a label field, an
 * identity field, the fields a click shows and an optional where clause.
 * Operators find them by searching the portal (`searchItems`, `serviceLayers`)
 * or by pasting a layer URL (`readLayer`). The Topology canvas asks for the
 * features inside its viewport (`queryFeatures`) and, for a routed connection
 * whose line is outside it, by id (`featuresByIds`). The integration's token
 * never leaves the server: the browser only sees features.
 *
 * A token is sent only to the portal and to the layer hosts the config names;
 * `layerHosts` lists the hosts that are not the portal's own (or ArcGIS
 * Online's `*.arcgis.com` for an Online portal) so a new one counts as a
 * rule-111 destination move.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { isBlockedOutboundHost } from "../utils/netGuard.js";
import { ArcgisError, arcgisRequest, getArcgisToken, portalBase, type ArcgisConfig } from "./arcgisService.js";

// ─── Configuration ───────────────────────────────────────────────────────

export const LAYER_GEOMETRIES = ["line", "point", "area"] as const;
export type LayerGeometry = (typeof LAYER_GEOMETRIES)[number];
/** Colour names the canvas maps to theme tokens (map.css `.topo-arc-*`). */
export const LAYER_COLORS = ["accent", "orange", "green", "yellow", "grey", "red"] as const;
export const LAYER_DASHES = ["solid", "dashed", "dotted"] as const;
export const MAX_LAYERS = 20;
export const MAX_POPUP_FIELDS = 10;
export const MAX_WHERE = 500;
/** An ArcGIS field name. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

interface ArcgisLayerField { name: string; alias: string }
export interface ArcgisLayerConfig {
  id: string;
  url: string;
  itemId?: string;
  title: string;
  geometry: LayerGeometry;
  idField: string;
  labelField?: string;
  popupFields: ArcgisLayerField[];
  where?: string;
  style: { color: (typeof LAYER_COLORS)[number]; width: number; dash: (typeof LAYER_DASHES)[number] };
}
export interface ArcgisLayersConfig extends ArcgisConfig {
  layers?: ArcgisLayerConfig[];
  layerHosts?: string[];
}

function geometryOf(esriType: string): LayerGeometry | null {
  if (esriType === "esriGeometryPolyline") return "line";
  if (esriType === "esriGeometryPoint" || esriType === "esriGeometryMultipoint") return "point";
  if (esriType === "esriGeometryPolygon") return "area";
  return null;
}

/**
 * Why a feature-layer URL cannot be read, or null: https, ending in
 * `/FeatureServer/<n>` or `/MapServer/<n>`, no credentials / query / fragment,
 * outside the blocked ranges.
 */
export function layerUrlProblem(raw: string): string | null {
  const s = (raw ?? "").trim();
  if (!s) return "Enter the layer's URL";
  let u: URL;
  try { u = new URL(s); } catch { return "The layer URL is not a valid URL"; }
  if (u.protocol !== "https:") return "The layer URL must use https";
  if (u.username || u.password) return "Put credentials in the sign-in fields, not in the URL";
  if (u.search || u.hash) return "The layer URL takes no query string or fragment";
  if (!/\/(FeatureServer|MapServer)\/\d+\/?$/i.test(u.pathname)) return "Give one layer of a service, ending in /FeatureServer/<layer number>";
  if (isBlockedOutboundHost(u.hostname)) return "That address is in a blocked range (loopback, link-local or metadata)";
  return null;
}

/** Why a where clause cannot be sent, or null. ArcGIS itself checks the SQL. */
export function whereProblem(where: string): string | null {
  if (where.length > MAX_WHERE) return `A filter may be at most ${MAX_WHERE} characters`;
  if (/[\u0000-\u001f\u007f;]/.test(where)) return "A filter may not contain control characters or ';'";
  return null;
}

function isOnlinePortal(portal: string): boolean {
  const h = new URL(portal).hostname.toLowerCase();
  return h === "www.arcgis.com" || h === "arcgis.com" || h.endsWith(".maps.arcgis.com");
}

/**
 * The layer hosts a token goes to that are not the portal's own — sorted,
 * de-duplicated, lower case. An Online portal's `*.arcgis.com` hosts are
 * Esri's own and do not count.
 */
export function layerHosts(cfg: ArcgisLayersConfig): string[] {
  const portal = portalBase(cfg);
  const portalHost = new URL(portal).hostname.toLowerCase();
  const online = isOnlinePortal(portal);
  const out = new Set<string>();
  for (const l of cfg.layers ?? []) {
    let h: string;
    try { h = new URL(l.url).hostname.toLowerCase(); } catch { continue; }
    if (h === portalHost) continue;
    if (online && (h === "arcgis.com" || h.endsWith(".arcgis.com"))) continue;
    out.add(h);
  }
  return [...out].sort();
}

/** Problems with a layer list as saved: duplicates, bad URLs, bad fields, bad filters. */
export function layersProblem(layers: ArcgisLayerConfig[]): string | null {
  if (layers.length > MAX_LAYERS) return `An integration reads at most ${MAX_LAYERS} layers`;
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const l of layers) {
    if (ids.has(l.id)) return "Two layers share an id";
    ids.add(l.id);
    const key = l.url.replace(/\/+$/, "").toLowerCase();
    if (urls.has(key)) return `"${l.title}" is listed twice`;
    urls.add(key);
    const u = layerUrlProblem(l.url);
    if (u) return `${l.title}: ${u}`;
    for (const f of [l.idField, l.labelField, ...l.popupFields.map((p) => p.name)]) {
      if (f && !FIELD_NAME_RE.test(f)) return `${l.title}: "${f}" is not a field name`;
    }
    if (l.where) {
      const w = whereProblem(l.where);
      if (w) return `${l.title}: ${w}`;
    }
  }
  return null;
}

// ─── Reading a layer's description ───────────────────────────────────────

export interface LayerInfo {
  url: string;
  name: string;
  geometry: LayerGeometry | null;
  geometryType: string;
  objectIdField: string;
  globalIdField: string | null;
  maxRecordCount: number;
  fields: Array<{ name: string; alias: string; type: string }>;
}

interface RawLayer {
  name?: string;
  geometryType?: string;
  objectIdField?: string;
  globalIdField?: string;
  maxRecordCount?: number;
  fields?: Array<{ name?: string; type?: string; alias?: string }>;
}

function trimUrl(u: string): string { return u.trim().replace(/\/+$/, ""); }

/** Read one layer's description: geometry, fields, id fields, page size. */
export async function readLayer(cfg: ArcgisConfig, rawUrl: string): Promise<LayerInfo> {
  const url = trimUrl(rawUrl);
  const problem = layerUrlProblem(url);
  if (problem) throw new AppError(400, problem);
  const token = await getArcgisToken(cfg);
  const raw = await arcgisRequest<RawLayer>(cfg, url, { token });
  const fields = (raw.fields ?? [])
    .filter((f) => f.name && FIELD_NAME_RE.test(String(f.name)))
    .map((f) => ({ name: String(f.name), alias: String(f.alias ?? f.name), type: String(f.type ?? "") }));
  const oid = raw.objectIdField || fields.find((f) => f.type === "esriFieldTypeOID")?.name || "OBJECTID";
  const gid = raw.globalIdField || fields.find((f) => f.type === "esriFieldTypeGlobalID")?.name || null;
  return {
    url,
    name: String(raw.name ?? ""),
    geometry: geometryOf(String(raw.geometryType ?? "")),
    geometryType: String(raw.geometryType ?? ""),
    objectIdField: oid,
    globalIdField: gid,
    maxRecordCount: typeof raw.maxRecordCount === "number" && raw.maxRecordCount > 0 ? raw.maxRecordCount : 1000,
    fields,
  };
}

// ─── Finding layers in the portal ────────────────────────────────────────

export interface PortalItem {
  itemId: string;
  title: string;
  owner: string;
  url: string;
  modified: string | null;
  snippet: string;
}

interface RawSearch {
  total?: number;
  nextStart?: number;
  results?: Array<{ id?: string; title?: string; owner?: string; url?: string; modified?: number; snippet?: string }>;
}

/** Quote a search term for the portal's query language. */
function term(q: string): string {
  return q.replace(/["\\]/g, " ").trim();
}

/**
 * Search the portal for feature services this sign-in can see. `scope`
 * "org" = the organization's content, "mine" = the signed-in user's own.
 */
export async function searchItems(
  cfg: ArcgisConfig,
  opts: { q?: string; scope?: "org" | "mine"; start?: number },
): Promise<{ items: PortalItem[]; total: number; nextStart: number | null }> {
  const token = await getArcgisToken(cfg);
  const base = `${portalBase(cfg)}/sharing/rest`;
  const parts = ['type:"Feature Service"'];
  const text = term(opts.q ?? "");
  if (text) parts.unshift(`(${text})`);
  if (token) {
    const self = await arcgisRequest<{ id?: string; user?: { username?: string } }>(cfg, `${base}/portals/self`, { token });
    if (opts.scope === "mine" && self.user?.username) parts.push(`owner:"${term(self.user.username)}"`);
    else if (self.id) parts.push(`orgid:${term(self.id)}`);
  }
  const raw = await arcgisRequest<RawSearch>(cfg, `${base}/search`, {
    token,
    params: { q: parts.join(" AND "), num: "25", start: String(Math.max(1, opts.start ?? 1)), sortField: "modified", sortOrder: "desc" },
  });
  const items = (raw.results ?? [])
    .filter((r) => r.id && r.url)
    .map((r) => ({
      itemId: String(r.id),
      title: String(r.title ?? r.id),
      owner: String(r.owner ?? ""),
      url: trimUrl(String(r.url)),
      modified: typeof r.modified === "number" ? new Date(r.modified).toISOString() : null,
      snippet: String(r.snippet ?? "").slice(0, 300),
    }));
  const next = typeof raw.nextStart === "number" && raw.nextStart > 0 ? raw.nextStart : null;
  return { items, total: typeof raw.total === "number" ? raw.total : items.length, nextStart: next };
}

/** The layers of one feature service: id, name, geometry, URL. Tables are left out. */
export async function serviceLayers(
  cfg: ArcgisConfig,
  serviceUrl: string,
): Promise<Array<{ id: number; name: string; geometry: LayerGeometry | null; url: string }>> {
  const url = trimUrl(serviceUrl);
  if (!/\/(FeatureServer|MapServer)$/i.test(new URL(url).pathname)) throw new AppError(400, "Not a feature service URL");
  if (layerUrlProblem(`${url}/0`)) throw new AppError(400, layerUrlProblem(`${url}/0`)!);
  const token = await getArcgisToken(cfg);
  const raw = await arcgisRequest<{ layers?: Array<{ id?: number; name?: string; geometryType?: string }> }>(cfg, url, { token });
  return (raw.layers ?? [])
    .filter((l) => typeof l.id === "number")
    .map((l) => ({ id: l.id as number, name: String(l.name ?? `Layer ${l.id}`), geometry: geometryOf(String(l.geometryType ?? "")), url: `${url}/${l.id}` }));
}

/** A new layer entry from a layer's description (the Layers tab's Add). */
export function newLayerConfig(info: LayerInfo, itemId?: string, title?: string): ArcgisLayerConfig {
  if (!info.geometry) throw new AppError(400, `"${info.name}" has no map geometry (it is a table)`);
  const label = info.fields.find((f) => /name|label|id$/i.test(f.name) && f.type === "esriFieldTypeString");
  return {
    id: randomUUID(),
    url: info.url,
    ...(itemId ? { itemId } : {}),
    title: (title || info.name || "ArcGIS layer").slice(0, 120),
    geometry: info.geometry,
    idField: info.globalIdField ?? info.objectIdField,
    ...(label ? { labelField: label.name } : {}),
    popupFields: [],
    style: { color: info.geometry === "line" ? "accent" : info.geometry === "point" ? "green" : "grey", width: 3, dash: "solid" },
  };
}

// ─── Features ────────────────────────────────────────────────────────────

/** One feature as the canvas draws it. `g` is GeoJSON-ordered [lng, lat]. */
export interface MapFeature {
  id: string;
  /** line: paths; area: rings; point: [[ [lng, lat] ]]. */
  g: Array<Array<[number, number]>>;
  label: string | null;
  attrs: Record<string, string | number | null>;
}

interface RawFeature {
  attributes?: Record<string, unknown>;
  geometry?: { paths?: number[][][]; rings?: number[][][]; x?: number; y?: number; points?: number[][] };
}
interface RawQuery { features?: RawFeature[]; exceededTransferLimit?: boolean }

const MAX_FEATURES = 2000;
const MAX_IDS = 50;
// An hour (operator request 2026-11-17; a minute until then): fibre routes,
// pole lines and parcels change rarely, and panning a site should read from
// Polaris, not ArcGIS. Saving a layer's settings clears it (clearFeatureCache).
const CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX = 300;
const cache = new Map<string, { at: number; value: unknown }>();

function cached<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return undefined; }
  return hit.value as T;
}
function remember(key: string, value: unknown): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
}
/** Forget cached features (a layer's settings changed). */
export function clearFeatureCache(): void { cache.clear(); }

function r6(v: number): number { return Math.round(v * 1e6) / 1e6; }

function toFeature(f: RawFeature, layer: ArcgisLayerConfig): MapFeature | null {
  const a = f.attributes ?? {};
  const idv = a[layer.idField];
  if (idv === null || idv === undefined || idv === "") return null;
  const geo = f.geometry ?? {};
  let g: Array<Array<[number, number]>> = [];
  const pt = (p: number[]): [number, number] => [r6(p[0]), r6(p[1])];
  if (Array.isArray(geo.paths)) g = geo.paths.map((p) => p.map(pt));
  else if (Array.isArray(geo.rings)) g = geo.rings.map((p) => p.map(pt));
  else if (typeof geo.x === "number" && typeof geo.y === "number") g = [[pt([geo.x, geo.y])]];
  else if (Array.isArray(geo.points)) g = [geo.points.map(pt)];
  if (!g.length) return null;
  const attrs: Record<string, string | number | null> = {};
  for (const p of layer.popupFields) {
    const v = a[p.name];
    attrs[p.name] = v === null || v === undefined ? null : typeof v === "number" ? v : String(v).slice(0, 500);
  }
  const lab = layer.labelField ? a[layer.labelField] : null;
  return { id: String(idv).slice(0, 80), g, label: lab === null || lab === undefined ? null : String(lab).slice(0, 120), attrs };
}

function outFields(layer: ArcgisLayerConfig): string {
  return Array.from(new Set([layer.idField, layer.labelField, ...layer.popupFields.map((p) => p.name)].filter(Boolean))).join(",");
}

/** The configured layer by id across enabled ArcGIS integrations, with its integration's config. */
async function findLayer(layerId: string): Promise<{ layer: ArcgisLayerConfig; cfg: ArcgisLayersConfig } | null> {
  const rows = await prisma.integration.findMany({ where: { type: "arcgis", enabled: true }, select: { config: true } });
  for (const r of rows) {
    const cfg = (r.config ?? {}) as ArcgisLayersConfig;
    const layer = (cfg.layers ?? []).find((l) => l.id === layerId);
    if (layer) return { layer, cfg };
  }
  return null;
}

/** Every layer the Topology canvas may draw, without credentials. */
export async function listMapLayers(): Promise<Array<Omit<ArcgisLayerConfig, "url" | "where"> & { itemUrl: string | null }>> {
  const rows = await prisma.integration.findMany({ where: { type: "arcgis", enabled: true }, select: { config: true }, orderBy: { createdAt: "asc" } });
  const out: Array<Omit<ArcgisLayerConfig, "url" | "where"> & { itemUrl: string | null }> = [];
  for (const r of rows) {
    const cfg = (r.config ?? {}) as ArcgisLayersConfig;
    const portal = portalBase(cfg);
    for (const l of cfg.layers ?? []) {
      out.push({
        id: l.id, title: l.title, geometry: l.geometry, idField: l.idField, labelField: l.labelField,
        popupFields: l.popupFields, style: l.style, ...(l.itemId ? { itemId: l.itemId } : {}),
        itemUrl: l.itemId ? `${portal}/home/item.html?id=${encodeURIComponent(l.itemId)}` : null,
      });
    }
  }
  return out;
}

export interface Bbox { w: number; s: number; e: number; n: number }

/** Parse "w,s,e,n" in degrees; null when malformed or out of range. */
export function parseBbox(raw: string): Bbox | null {
  const p = raw.split(",").map(Number);
  if (p.length !== 4 || !p.every(Number.isFinite)) return null;
  const [w, s, e, n] = p;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) return null;
  return { w, s, e, n };
}

/** Snap a bbox outward to a grid one tile wide at `zoom`, so nearby pans share a cache entry. */
export function snapBbox(b: Bbox, zoom: number): Bbox {
  const step = 360 / 2 ** Math.max(0, Math.min(22, Math.floor(zoom)));
  const down = (v: number) => Math.floor(v / step) * step;
  const up = (v: number) => Math.ceil(v / step) * step;
  return { w: Math.max(-180, down(b.w)), s: Math.max(-90, down(b.s)), e: Math.min(180, up(b.e)), n: Math.min(90, up(b.n)) };
}

function generalisation(zoom: number): string {
  // Half a screen pixel, in degrees, at this zoom.
  return String(360 / (256 * 2 ** Math.max(0, Math.min(22, zoom))) / 2);
}

/** The features of one layer inside a bbox (generalised for the zoom, capped). */
export async function queryFeatures(
  layerId: string,
  bbox: Bbox,
  zoom: number,
): Promise<{ features: MapFeature[]; truncated: boolean }> {
  const found = await findLayer(layerId);
  if (!found) throw new AppError(404, "That ArcGIS layer is not configured");
  const { layer, cfg } = found;
  const snapped = snapBbox(bbox, zoom);
  const key = `${layerId}|${Math.floor(zoom)}|${snapped.w},${snapped.s},${snapped.e},${snapped.n}`;
  const hit = cached<{ features: MapFeature[]; truncated: boolean }>(key);
  if (hit) return hit;
  const token = await getArcgisToken(cfg);
  const raw = await arcgisRequest<RawQuery>(cfg, `${trimUrl(layer.url)}/query`, {
    token,
    params: {
      where: layer.where || "1=1",
      geometry: `${snapped.w},${snapped.s},${snapped.e},${snapped.n}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: outFields(layer),
      returnGeometry: "true",
      geometryPrecision: "6",
      maxAllowableOffset: layer.geometry === "point" ? "0" : generalisation(zoom),
      resultRecordCount: String(MAX_FEATURES),
    },
  });
  const features = (raw.features ?? []).slice(0, MAX_FEATURES).map((f) => toFeature(f, layer)).filter((f): f is MapFeature => !!f);
  const value = { features, truncated: raw.exceededTransferLimit === true || (raw.features ?? []).length > MAX_FEATURES };
  remember(key, value);
  return value;
}

function sqlLiteral(v: string): string {
  return /^-?\d+$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`;
}

/** Features of one layer by identity value (≤ 50), full detail — for routed connections. */
export async function featuresByIds(layerId: string, ids: string[]): Promise<MapFeature[]> {
  const found = await findLayer(layerId);
  if (!found) throw new AppError(404, "That ArcGIS layer is not configured");
  const { layer, cfg } = found;
  const clean = Array.from(new Set(ids.map((s) => s.trim()).filter((s) => s && s.length <= 80 && !/[\u0000-\u001f]/.test(s)))).slice(0, MAX_IDS);
  if (!clean.length) return [];
  const key = `${layerId}|ids|${clean.slice().sort().join(",")}`;
  const hit = cached<MapFeature[]>(key);
  if (hit) return hit;
  const token = await getArcgisToken(cfg);
  const inList = `${layer.idField} IN (${clean.map(sqlLiteral).join(",")})`;
  const raw = await arcgisRequest<RawQuery>(cfg, `${trimUrl(layer.url)}/query`, {
    method: "POST",
    token,
    params: {
      where: layer.where ? `(${layer.where}) AND ${inList}` : inList,
      outSR: "4326",
      outFields: outFields(layer),
      returnGeometry: "true",
      geometryPrecision: "6",
    },
  });
  const out = (raw.features ?? []).map((f) => toFeature(f, layer)).filter((f): f is MapFeature => !!f);
  remember(key, out);
  return out;
}

/** Test Connection's check of each layer: readable, still has its fields, filter accepted. */
export async function checkLayers(cfg: ArcgisLayersConfig): Promise<string[]> {
  const problems: string[] = [];
  for (const l of cfg.layers ?? []) {
    try {
      const info = await readLayer(cfg, l.url);
      const names = new Set(info.fields.map((f) => f.name.toLowerCase()));
      for (const f of [l.idField, l.labelField, ...l.popupFields.map((p) => p.name)]) {
        if (f && !names.has(f.toLowerCase())) problems.push(`${l.title}: the layer has no field "${f}"`);
      }
      if (l.where) {
        const token = await getArcgisToken(cfg);
        await arcgisRequest(cfg, `${trimUrl(l.url)}/query`, { token, params: { where: l.where, returnCountOnly: "true" } });
      }
    } catch (err) {
      const msg = err instanceof ArcgisError || err instanceof AppError ? err.message : String(err);
      problems.push(`${l.title}: ${msg}`);
    }
  }
  return problems;
}
