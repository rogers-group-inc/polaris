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
/** Rule 188(b): at most this many types per layer — more is a name or an id, not a type. */
export const MAX_TYPES = 50;
export const MAX_TYPE_VALUE = 200;
/** An ArcGIS field name. */
const FIELD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** A per-type colour (rule 188(b)): ArcGIS's own, so any colour, as #rrggbb. */
export const TYPE_COLOR_RE = /^#[0-9a-f]{6}$/i;

interface ArcgisLayerField { name: string; alias: string }
type LayerDash = (typeof LAYER_DASHES)[number];
export interface TypeStyle { color: string; width: number; dash: LayerDash }
interface LayerTypeEntry { value: string | number; label: string; on: boolean; style: TypeStyle }
/** Rule 188(b): a layer drawn by type — the type field, its values, and the bucket for every other value. */
export interface LayerTypes {
  field: string;
  numeric: boolean;
  values: LayerTypeEntry[];
  other: { on: boolean; style: TypeStyle };
}
/** [west, south, east, north] in degrees. */
export type LayerExtent = [number, number, number, number];
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
  style: { color: (typeof LAYER_COLORS)[number]; width: number; dash: LayerDash };
  /** Drawn by type instead of one style (rule 188(b)). */
  types?: LayerTypes;
  /** The area the layer covers, WGS84 (rule 188(c)); absent = treated as everywhere. */
  extent?: LayerExtent;
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
    if (l.types) {
      const t = typesProblem(l.types);
      if (t) return `${l.title}: ${t}`;
    }
  }
  return null;
}

function styleProblem(s: TypeStyle): string | null {
  if (!TYPE_COLOR_RE.test(s.color)) return `"${s.color}" is not a colour`;
  if (!Number.isInteger(s.width) || s.width < 1 || s.width > 8) return "A width is 1 to 8";
  if (!(LAYER_DASHES as readonly string[]).includes(s.dash)) return "A line is solid, dashed or dotted";
  return null;
}

/** Problems with a layer's by-type settings (rule 188(b)). */
export function typesProblem(t: LayerTypes): string | null {
  if (!FIELD_NAME_RE.test(t.field)) return `"${t.field}" is not a field name`;
  if (t.values.length > MAX_TYPES) return `A layer is drawn by at most ${MAX_TYPES} types`;
  const seen = new Set<string>();
  for (const v of t.values) {
    if (t.numeric ? typeof v.value !== "number" || !Number.isFinite(v.value) : typeof v.value !== "string") {
      return `"${String(v.value)}" is not a ${t.numeric ? "number" : "text"} value of ${t.field}`;
    }
    const key = String(v.value);
    if (!key.length || key.length > MAX_TYPE_VALUE || /[\u0000-\u001f\u007f]/.test(key)) return `"${key.slice(0, 40)}" is not a usable type value`;
    if (seen.has(key)) return `The type "${key}" is listed twice`;
    seen.add(key);
    const s = styleProblem(v.style);
    if (s) return `${v.label || key}: ${s}`;
  }
  return styleProblem(t.other.style);
}

/** A value as ArcGIS SQL: a number bare, text quoted. */
function typeLiteral(v: string | number, numeric: boolean): string {
  return numeric ? String(Number(v)) : `'${String(v).replace(/'/g, "''")}'`;
}

/**
 * The where clause a layer's ticked types add (rule 188(b)): null when every
 * type is drawn, false when none is (nothing to ask ArcGIS for).
 */
export function typeWhere(l: Pick<ArcgisLayerConfig, "types">): string | null | false {
  const t = l.types;
  if (!t) return null;
  const on = t.values.filter((v) => v.on);
  if (on.length === t.values.length && t.other.on) return null;
  const parts: string[] = [];
  if (on.length) parts.push(`${t.field} IN (${on.map((v) => typeLiteral(v.value, t.numeric)).join(",")})`);
  if (t.other.on) {
    parts.push(t.values.length
      ? `(${t.field} IS NULL OR ${t.field} NOT IN (${t.values.map((v) => typeLiteral(v.value, t.numeric)).join(",")}))`
      : "1=1");
  }
  return parts.length ? parts.join(" OR ") : false;
}

/** The layer's own filter and its types' filter as one where clause; false = fetch nothing. */
export function effectiveWhere(l: Pick<ArcgisLayerConfig, "types" | "where">): string | false {
  const tw = typeWhere(l);
  if (tw === false) return false;
  if (l.where && tw) return `(${l.where}) AND (${tw})`;
  return l.where || tw || "1=1";
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
  /** The area the layer covers in WGS84, or null when its coordinate system is not one Polaris converts. */
  extent: LayerExtent | null;
}

interface RawSymbol { type?: string; color?: unknown; width?: unknown; style?: unknown }
interface RawLayer {
  name?: string;
  geometryType?: string;
  objectIdField?: string;
  globalIdField?: string;
  maxRecordCount?: number;
  fields?: Array<{ name?: string; type?: string; alias?: string; domain?: { type?: string; codedValues?: Array<{ name?: unknown; code?: unknown }> } | null }>;
  extent?: { xmin?: unknown; ymin?: unknown; xmax?: unknown; ymax?: unknown; spatialReference?: { wkid?: unknown; latestWkid?: unknown } };
  drawingInfo?: {
    renderer?: {
      type?: string;
      field1?: unknown;
      field2?: unknown;
      valueExpression?: unknown;
      uniqueValueInfos?: Array<{ value?: unknown; label?: unknown; symbol?: RawSymbol }>;
      uniqueValueGroups?: Array<{ classes?: Array<{ label?: unknown; symbol?: RawSymbol; values?: unknown[][] }> }>;
      defaultSymbol?: RawSymbol;
    };
  };
}

function trimUrl(u: string): string { return u.trim().replace(/\/+$/, ""); }

const WEB_MERCATOR_WKIDS = new Set([102100, 3857, 102113, 900913]);
const EARTH_R = 6378137;

/**
 * A layer's extent as [w, s, e, n] degrees (rule 188(c)): WGS84 as given, Web
 * Mercator converted; any other coordinate system → null (the layer is then
 * offered everywhere).
 */
export function extentToWgs84(raw: RawLayer["extent"]): LayerExtent | null {
  if (!raw) return null;
  const n = [raw.xmin, raw.ymin, raw.xmax, raw.ymax].map(Number);
  if (!n.every(Number.isFinite) || n[0] > n[2] || n[1] > n[3]) return null;
  const wkid = Number(raw.spatialReference?.latestWkid ?? raw.spatialReference?.wkid);
  let [w, s, e, nn] = n;
  if (WEB_MERCATOR_WKIDS.has(wkid)) {
    const lng = (x: number) => (x / EARTH_R) * 180 / Math.PI;
    const lat = (y: number) => (2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) * 180 / Math.PI;
    [w, s, e, nn] = [lng(w), lat(s), lng(e), lat(nn)];
  } else if (wkid !== 4326) {
    return null;
  }
  const c = (v: number, lim: number) => Math.round(Math.max(-lim, Math.min(lim, v)) * 1e5) / 1e5;
  return [c(w, 180), c(s, 90), c(e, 180), c(nn, 90)];
}

/** Read one layer's description: geometry, fields, id fields, page size. */
export async function readLayer(cfg: ArcgisConfig, rawUrl: string): Promise<LayerInfo> {
  const url = trimUrl(rawUrl);
  const problem = layerUrlProblem(url);
  if (problem) throw new AppError(400, problem);
  const token = await getArcgisToken(cfg);
  const raw = await arcgisRequest<RawLayer>(cfg, url, { token });
  return describeLayer(url, raw);
}

function describeLayer(url: string, raw: RawLayer): LayerInfo {
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
    extent: extentToWgs84(raw.extent),
  };
}

// ─── Types (rule 188(b)) ─────────────────────────────────────────────────

/** Field types a layer can be drawn by: text and whole numbers. */
const TYPE_FIELD_TYPES = new Set(["esriFieldTypeString", "esriFieldTypeSmallInteger", "esriFieldTypeInteger", "esriFieldTypeBigInteger"]);
/** Colours for types ArcGIS gives no symbol: distinct on the map and on satellite. */
const FALLBACK_COLORS = ["#1e88e5", "#e53935", "#43a047", "#fdd835", "#8e24aa", "#fb8c00", "#00acc1", "#6d4c41", "#d81b60", "#7cb342"];
const OTHER_STYLE: TypeStyle = { color: "#9aa0a6", width: 2, dash: "solid" };

/** An ArcGIS simple-line (or marker / fill outline) symbol as a Polaris style, or null. */
export function symbolStyle(sym: RawSymbol | undefined): TypeStyle | null {
  if (!sym || !Array.isArray(sym.color) || sym.color.length < 3) return null;
  const [r, g, b] = (sym.color as unknown[]).map(Number);
  if (![r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return null;
  const color = "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  const w = Number(sym.width);
  const width = Number.isFinite(w) ? Math.max(1, Math.min(8, Math.round(w * 4 / 3))) : 3;
  const st = String(sym.style ?? "");
  const dash: LayerDash = /Dot$|^esriSLSDot$|ShortDot/.test(st) && !/Dash/.test(st) ? "dotted"
    : /Dash/.test(st) ? "dashed" : "solid";
  return { color, width, dash };
}

export interface TypeReading {
  field: string;
  numeric: boolean;
  /** Each type: its value, ArcGIS's name for it, how many features carry it (null when ArcGIS would not count), and ArcGIS's style. */
  values: Array<{ value: string | number; label: string; count: number | null; style: TypeStyle; fromArcgis: boolean }>;
  /** Features with no value. */
  blank: number | null;
  /** The style a new "Other types" bucket starts with. */
  other: TypeStyle;
}

interface RawStats { features?: Array<{ attributes?: Record<string, unknown> }> }

/**
 * Read the types of one field (rule 188(b)): the values in use (with counts
 * where the service can group), the field's coded-value names, and the
 * layer's own unique-value symbols — so a layer starts out looking as it does
 * in ArcGIS. More than MAX_TYPES values is refused: that field names things,
 * it does not sort them.
 */
export async function readTypes(cfg: ArcgisConfig, rawUrl: string, field: string): Promise<TypeReading> {
  const url = trimUrl(rawUrl);
  const problem = layerUrlProblem(url);
  if (problem) throw new AppError(400, problem);
  if (!FIELD_NAME_RE.test(field)) throw new AppError(400, "Not a field name");
  const token = await getArcgisToken(cfg);
  const raw = await arcgisRequest<RawLayer>(cfg, url, { token });
  const info = describeLayer(url, raw);
  const f = info.fields.find((x) => x.name.toLowerCase() === field.toLowerCase());
  if (!f) throw new AppError(400, `The layer has no field "${field}"`);
  if (!TYPE_FIELD_TYPES.has(f.type)) throw new AppError(400, `${f.name} holds ${f.type.replace("esriFieldType", "").toLowerCase()} values — pick a text or whole-number field`);
  const numeric = f.type !== "esriFieldTypeString";
  const norm = (v: unknown): string | number | null => {
    if (v === null || v === undefined || v === "") return null;
    if (numeric) { const n = Number(v); return Number.isInteger(n) ? n : null; }
    const s = String(v);
    return s.length > MAX_TYPE_VALUE ? null : s;
  };

  // Values in use, with counts when the service can group; plain distinct values otherwise.
  const counts = new Map<string, { value: string | number; count: number | null }>();
  let blank: number | null = null;
  let counted = false;
  try {
    const stats = await arcgisRequest<RawStats>(cfg, `${url}/query`, {
      token,
      params: {
        where: "1=1",
        groupByFieldsForStatistics: f.name,
        outStatistics: JSON.stringify([{ statisticType: "count", onStatisticField: info.objectIdField, outStatisticFieldName: "polaris_n" }]),
        returnGeometry: "false",
      },
    });
    for (const row of stats.features ?? []) {
      const a = row.attributes ?? {};
      const key = Object.keys(a).find((k) => k.toLowerCase() === f.name.toLowerCase());
      const nKey = Object.keys(a).find((k) => k.toLowerCase() === "polaris_n");
      const n = nKey ? Number(a[nKey]) : NaN;
      const v = norm(key ? a[key] : null);
      if (v === null) { blank = (blank ?? 0) + (Number.isFinite(n) ? n : 0); continue; }
      counts.set(String(v), { value: v, count: Number.isFinite(n) ? n : null });
    }
    counted = true;
  } catch {
    const distinct = await arcgisRequest<RawStats>(cfg, `${url}/query`, {
      token,
      params: { where: "1=1", outFields: f.name, returnDistinctValues: "true", returnGeometry: "false" },
    });
    for (const row of distinct.features ?? []) {
      const a = row.attributes ?? {};
      const key = Object.keys(a).find((k) => k.toLowerCase() === f.name.toLowerCase());
      const v = norm(key ? a[key] : null);
      if (v !== null) counts.set(String(v), { value: v, count: null });
    }
  }

  // ArcGIS's names: coded values, then the renderer's labels (which win).
  const names = new Map<string, string>();
  for (const cv of raw.fields?.find((x) => String(x.name).toLowerCase() === f.name.toLowerCase())?.domain?.codedValues ?? []) {
    const v = norm(cv.code);
    if (v !== null && cv.name !== undefined && cv.name !== null) names.set(String(v), String(cv.name).slice(0, 120));
  }
  const styles = new Map<string, TypeStyle>();
  const order: string[] = [];
  const r = raw.drawingInfo?.renderer;
  if (r && r.type === "uniqueValue" && !r.field2 && !r.valueExpression && String(r.field1 ?? "").toLowerCase() === f.name.toLowerCase()) {
    const infos: Array<{ value?: unknown; label?: unknown; symbol?: RawSymbol }> = [...(r.uniqueValueInfos ?? [])];
    for (const g of r.uniqueValueGroups ?? []) for (const c of g.classes ?? []) for (const vs of c.values ?? []) infos.push({ value: vs?.[0], label: c.label, symbol: c.symbol });
    for (const i of infos) {
      const v = norm(i.value);
      if (v === null) continue;
      const k = String(v);
      if (!order.includes(k)) order.push(k);
      if (i.label !== undefined && i.label !== null && String(i.label).trim()) names.set(k, String(i.label).trim().slice(0, 120));
      const st = symbolStyle(i.symbol);
      if (st) styles.set(k, st);
      if (!counts.has(k)) counts.set(k, { value: v, count: counted ? 0 : null });
    }
  }
  for (const k of names.keys()) if (!counts.has(k)) counts.set(k, { value: numeric ? Number(k) : k, count: counted ? 0 : null });

  if (counts.size > MAX_TYPES) {
    throw new AppError(400, `${f.name} has ${counts.size} different values — more than ${MAX_TYPES}. Pick a field that sorts lines into kinds, not one that names each line.`);
  }
  const rest = [...counts.keys()].filter((k) => !order.includes(k))
    .sort((a, b) => (counts.get(b)!.count ?? -1) - (counts.get(a)!.count ?? -1) || a.localeCompare(b));
  let spare = 0;
  const values = [...order.filter((k) => counts.has(k)), ...rest].map((k) => {
    const c = counts.get(k)!;
    const style = styles.get(k) ?? { color: FALLBACK_COLORS[spare++ % FALLBACK_COLORS.length], width: 3, dash: "solid" as LayerDash };
    return { value: c.value, label: names.get(k) ?? k, count: c.count, style, fromArcgis: styles.has(k) };
  });
  return { field: f.name, numeric, values, blank, other: { ...OTHER_STYLE } };
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
    ...(info.extent ? { extent: info.extent } : {}),
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
  /** The feature's type value (rule 188(b)); absent when the layer is drawn in one style. */
  t?: string | number | null;
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
  const out: MapFeature = { id: String(idv).slice(0, 80), g, label: lab === null || lab === undefined ? null : String(lab).slice(0, 120), attrs };
  if (layer.types) {
    const tv = a[layer.types.field];
    out.t = tv === null || tv === undefined || tv === "" ? null : typeof tv === "number" ? tv : String(tv).slice(0, MAX_TYPE_VALUE);
  }
  return out;
}

function outFields(layer: ArcgisLayerConfig): string {
  return Array.from(new Set([layer.idField, layer.labelField, layer.types?.field, ...layer.popupFields.map((p) => p.name)].filter(Boolean))).join(",");
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

/**
 * Every layer the Topology canvas may draw, without credentials. A layer drawn
 * by type lists only its ticked types (and the other bucket when ticked):
 * unticked ones are never fetched, so the map has nothing to offer for them.
 */
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
        ...(l.types ? { types: { ...l.types, values: l.types.values.filter((v) => v.on) } } : {}),
        ...(l.extent ? { extent: l.extent } : {}),
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
  const where = effectiveWhere(layer);
  if (where === false) return { features: [], truncated: false };
  const token = await getArcgisToken(cfg);
  const raw = await arcgisRequest<RawQuery>(cfg, `${trimUrl(layer.url)}/query`, {
    token,
    params: {
      where,
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
  const base = effectiveWhere(layer);
  if (base === false) return [];
  const token = await getArcgisToken(cfg);
  const inList = `${layer.idField} IN (${clean.map(sqlLiteral).join(",")})`;
  const raw = await arcgisRequest<RawQuery>(cfg, `${trimUrl(layer.url)}/query`, {
    method: "POST",
    token,
    params: {
      where: base === "1=1" ? inList : `(${base}) AND ${inList}`,
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
      for (const f of [l.idField, l.labelField, l.types?.field, ...l.popupFields.map((p) => p.name)]) {
        if (f && !names.has(f.toLowerCase())) problems.push(`${l.title}: the layer has no field "${f}"`);
      }
      const where = effectiveWhere(l);
      if (where && where !== "1=1") {
        const token = await getArcgisToken(cfg);
        await arcgisRequest(cfg, `${trimUrl(l.url)}/query`, { token, params: { where, returnCountOnly: "true" } });
      }
    } catch (err) {
      const msg = err instanceof ArcgisError || err instanceof AppError ? err.message : String(err);
      problems.push(`${l.title}: ${msg}`);
    }
  }
  return problems;
}
