/**
 * src/services/satelliteTileService.ts — the optional, operator-configured
 * satellite basemap for the Device Map topology view's Topology canvas.
 *
 * Polaris draws every geographic map from ONE tile host, tile.openstreetmap.org
 * (polaris-ui-canon → tech-stack-frontend.md), and OpenStreetMap has no aerial
 * imagery. Satellite imagery therefore comes from a provider the OPERATOR
 * chooses (Esri, Mapbox, MapTiler, an in-house ArcGIS server…) under their own
 * licence and key. Off by default: an install that never fills in the
 * Customization tab's Satellite imagery card shows no Map / Satellite switch.
 *
 * The tiles are PROXIED, not fetched by the browser:
 *   - the provider's API key stays on the server — sealed at rest by the
 *     Setting.value hook in src/db.ts (`apiToken` is in SECRET_CONFIG_KEYS) and
 *     never returned by the API (only `apiTokenSet`);
 *   - the browser's CSP keeps its one tile host — tiles arrive from 'self';
 *   - a viewer whose browser cannot reach the provider still gets the imagery,
 *     and every viewer of a site shares one upstream fetch per tile (cache).
 *
 * The URL template is an admin-entered address the SERVER fetches. It must be
 * https, carry {z} {x} {y} (and {key} when a key is set), and hold no
 * user:password; redirects are refused so an upstream cannot bounce the fetch
 * elsewhere, and only image responses up to TILE_MAX_BYTES are passed on. An
 * internal tile server is allowed on purpose: an on-premises imagery server is
 * a real deployment shape, and the setting is write-gated.
 *
 * TWO HOMES (business rule 183). An enabled ArcGIS integration whose basemap
 * is switched on supplies the imagery and WINS over this Customization
 * setting; the setting stays for every other provider and applies whenever no
 * ArcGIS basemap is on. Both reach the browser the same way — one status, one
 * tile route — so a view saved on the satellite layer keeps working whichever
 * home serves it.
 */

import { prisma } from "../db.js";
import {
  basemapService,
  basemapTileUrl,
  getArcgisToken,
  imageryUrlProblem,
  ArcgisError,
  WORLD_IMAGERY_ATTRIBUTION,
  type ArcgisConfig,
} from "./arcgisService.js";
import { createSettingStore } from "./settingsStore.js";
import { logEvent } from "./eventLogService.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getAppVersion } from "../utils/version.js";
import { tlsFetch } from "../utils/tlsDispatcher.js";

const SATELLITE_SETTING_KEY = "satelliteConfig";

const MAX_TEMPLATE_LEN = 500;
const MAX_ATTRIBUTION_LEN = 200;
const MAX_TOKEN_LEN = 2000;
const MAX_ZOOM = 22;
const DEFAULT_NATIVE_ZOOM = 19;
const REQUEST_TIMEOUT_MS = 8000;
const TILE_MAX_BYTES = 4 * 1024 * 1024;
const TILE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
const TILE_CACHE_MAX_ENTRIES = 4000;

export interface SatelliteSettings {
  enabled: boolean;
  /** e.g. https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x} */
  urlTemplate: string;
  /** Substituted for {key} in the template. Sealed at rest; never sent to a browser. */
  apiToken: string;
  /** The credit line the provider's terms require, drawn on the map. */
  attribution: string;
  /** The deepest zoom the provider serves; Leaflet stretches tiles past it. */
  maxNativeZoom: number;
}

/**
 * What GET /server-settings/satellite returns: the token replaced by whether
 * one is set, and the ArcGIS integration (if any) whose basemap overrides it.
 */
export type SatelliteSettingsView = Omit<SatelliteSettings, "apiToken"> & { apiTokenSet: boolean; overriddenBy: string | null };

/** What a map viewer is told (GET /map/satellite). */
export interface SatelliteStatus {
  available: boolean;
  attribution: string;
  maxNativeZoom: number;
  /** Which home serves the imagery: an ArcGIS integration or the Customization setting. */
  source: "arcgis" | "custom" | null;
}

function defaults(): SatelliteSettings {
  return { enabled: false, urlTemplate: "", apiToken: "", attribution: "", maxNativeZoom: DEFAULT_NATIVE_ZOOM };
}

/** Pure — the stored blob with defaults; never throws (a bad row reads as off). */
export function parseSatelliteSettings(raw: unknown): SatelliteSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const zoom = Number(r.maxNativeZoom);
  return {
    enabled: r.enabled === true,
    urlTemplate: typeof r.urlTemplate === "string" ? r.urlTemplate : "",
    apiToken: typeof r.apiToken === "string" ? r.apiToken : "",
    attribution: typeof r.attribution === "string" ? r.attribution : "",
    maxNativeZoom: Number.isInteger(zoom) && zoom >= 1 && zoom <= MAX_ZOOM ? zoom : DEFAULT_NATIVE_ZOOM,
  };
}

const PLACEHOLDERS = new Set(["z", "x", "y", "key"]);

/**
 * Pure — checks a URL template and returns a problem sentence, or null when it
 * is usable. `hasToken` says whether a key will be substituted for {key}.
 */
export function urlTemplateProblem(template: string, hasToken: boolean): string | null {
  if (!template) return "Enter the tile URL";
  if (template.length > MAX_TEMPLATE_LEN) return `The tile URL may be at most ${MAX_TEMPLATE_LEN} characters`;
  if (/\s/.test(template)) return "The tile URL contains a space";
  const names = Array.from(template.matchAll(/\{([^{}]*)\}/g), (m) => m[1]);
  const unknown = names.filter((n) => !PLACEHOLDERS.has(n));
  if (unknown.length) return `The tile URL has an unknown placeholder {${unknown[0]}} — use {z}, {x}, {y} and {key}`;
  for (const n of ["z", "x", "y"]) if (!names.includes(n)) return `The tile URL needs {${n}}`;
  if (names.includes("key") && !hasToken) return "The tile URL uses {key} but no API key is set";
  let url: URL;
  try {
    url = new URL(template.replace(/\{[a-z]+\}/g, "0"));
  } catch {
    return "The tile URL is not a valid address";
  }
  if (url.protocol !== "https:") return "The tile URL must start with https://";
  if (url.username || url.password) return "Put credentials in the API key field, not in the tile URL";
  return null;
}

/** Pure — the upstream address of one tile. */
export function buildTileUrl(s: Pick<SatelliteSettings, "urlTemplate" | "apiToken">, z: number, x: number, y: number): string {
  return s.urlTemplate
    .replace(/\{z\}/g, String(z))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{key\}/g, encodeURIComponent(s.apiToken));
}

const store = createSettingStore<SatelliteSettings>({
  key: SATELLITE_SETTING_KEY,
  ttlMs: 10_000,
  parse: parseSatelliteSettings,
});

async function read(): Promise<SatelliteSettings> {
  try {
    return await store.get();
  } catch (err) {
    // A settings outage must not break the map: satellite simply isn't offered.
    logger.warn({ err }, "satellite settings: read failed — satellite imagery not offered");
    return defaults();
  }
}

function isUsable(s: SatelliteSettings): boolean {
  return s.enabled && urlTemplateProblem(s.urlTemplate, !!s.apiToken) === null;
}

function toView(s: SatelliteSettings, overriddenBy: string | null = null): SatelliteSettingsView {
  const { apiToken, ...rest } = s;
  return { ...rest, apiTokenSet: apiToken.length > 0, overriddenBy };
}

// ── The ArcGIS home (rule 183) ────────────────────────────────────────────
interface ArcgisBasemap { id: string; name: string; config: ArcgisConfig }
const ARCGIS_TTL_MS = 10_000;
let arcgisCache: { at: number; value: ArcgisBasemap | null } | null = null;

/** The enabled ArcGIS integration whose basemap is on (oldest first), cached 10 s. */
async function readArcgisBasemap(): Promise<ArcgisBasemap | null> {
  if (arcgisCache && Date.now() - arcgisCache.at < ARCGIS_TTL_MS) return arcgisCache.value;
  let value: ArcgisBasemap | null = null;
  try {
    const rows = await prisma.integration.findMany({
      where: { type: "arcgis", enabled: true },
      select: { id: true, name: true, config: true },
      orderBy: { createdAt: "asc" },
    });
    const hit = rows.find((r) => (r.config as ArcgisConfig | null)?.basemapEnabled === true);
    value = hit ? { id: hit.id, name: hit.name, config: hit.config as ArcgisConfig } : null;
  } catch (err) {
    // As with the setting: a read failure means "not offered", never a broken map.
    logger.warn({ err }, "satellite: ArcGIS basemap read failed — falling back to the Customization setting");
  }
  arcgisCache = { at: Date.now(), value };
  return value;
}

/** Forget the cached ArcGIS basemap (an ArcGIS integration was saved or deleted). */
export function invalidateArcgisBasemap(): void {
  arcgisCache = null;
}

/**
 * The other ArcGIS integration whose basemap is on, if any — only one may
 * supply imagery at a time. `excludeId` is the integration being saved.
 */
export async function arcgisBasemapOwner(excludeId?: string): Promise<{ id: string; name: string } | null> {
  const rows = await prisma.integration.findMany({
    where: { type: "arcgis", ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true, config: true },
  });
  const hit = rows.find((r) => (r.config as ArcgisConfig | null)?.basemapEnabled === true);
  return hit ? { id: hit.id, name: hit.name } : null;
}

function validZoom(raw: unknown): number {
  const z = Number(raw);
  return Number.isInteger(z) && z >= 1 && z <= MAX_ZOOM ? z : DEFAULT_NATIVE_ZOOM;
}

/** Where the imagery comes from right now: what the status, the tiles and the cache read. */
interface TileSource {
  kind: "arcgis" | "custom";
  /** Compared in memory to move the cache generation — never hashed (CodeQL #126). */
  identity: string;
  attribution: string;
  maxNativeZoom: number;
  integrationName?: string;
  verifySsl: boolean;
  url(z: number, x: number, y: number): Promise<string>;
}

function customSource(s: SatelliteSettings): TileSource {
  return {
    kind: "custom",
    identity: ["custom", s.urlTemplate, s.apiToken].join("\n"),
    attribution: s.attribution,
    maxNativeZoom: s.maxNativeZoom,
    verifySsl: true,
    url: async (z, x, y) => buildTileUrl(s, z, x, y),
  };
}

function arcgisSource(b: ArcgisBasemap): TileSource | null {
  const cfg = b.config;
  const { root, sendToken } = basemapService(cfg);
  if ((cfg.basemapSource ?? "world_imagery") === "service" && imageryUrlProblem(root)) return null;
  return {
    kind: "arcgis",
    // A credential change moves the generation, so a cached tile fetched with
    // the old one never answers for the new one.
    identity: ["arcgis", b.id, root, cfg.authMode ?? "", cfg.apiToken ?? "", cfg.clientId ?? "",
      cfg.clientSecret ?? "", cfg.username ?? "", cfg.password ?? ""].join("\n"),
    attribution: (cfg.basemapAttribution ?? "").trim() || WORLD_IMAGERY_ATTRIBUTION,
    maxNativeZoom: validZoom(cfg.basemapMaxZoom),
    integrationName: b.name,
    verifySsl: cfg.verifySsl !== false,
    url: async (z, x, y) => basemapTileUrl(cfg, sendToken ? await getArcgisToken(cfg) : null, z, x, y),
  };
}

/** Rule 183: an ArcGIS basemap that is on wins; otherwise the Customization setting. */
async function resolveSource(): Promise<TileSource | null> {
  const b = await readArcgisBasemap();
  const fromArcgis = b ? arcgisSource(b) : null;
  if (fromArcgis) return fromArcgis;
  const s = await read();
  return isUsable(s) ? customSource(s) : null;
}

export async function getSatelliteSettings(): Promise<SatelliteSettingsView> {
  const [s, b] = await Promise.all([read(), readArcgisBasemap()]);
  return toView(s, b?.name ?? null);
}

export async function getSatelliteStatus(): Promise<SatelliteStatus> {
  const src = await resolveSource();
  if (src) return { available: true, attribution: src.attribution, maxNativeZoom: src.maxNativeZoom, source: src.kind };
  const s = await read();
  return { available: false, attribution: s.attribution, maxNativeZoom: s.maxNativeZoom, source: null };
}

export interface SatelliteSettingsPatch {
  enabled: boolean;
  urlTemplate: string;
  /** undefined = keep the stored key; "" = clear it; anything else replaces it. */
  apiToken?: string;
  attribution: string;
  maxNativeZoom: number;
}

/** Merge a patch over the stored settings and validate the result. Pure apart from `current`. */
export function mergeSatelliteSettings(current: SatelliteSettings, patch: SatelliteSettingsPatch): SatelliteSettings {
  const next: SatelliteSettings = {
    enabled: patch.enabled === true,
    urlTemplate: String(patch.urlTemplate ?? "").trim(),
    apiToken: patch.apiToken === undefined ? current.apiToken : String(patch.apiToken).trim(),
    attribution: String(patch.attribution ?? "").trim().replace(/\s+/g, " "),
    maxNativeZoom: Number(patch.maxNativeZoom),
  };
  if (next.apiToken.length > MAX_TOKEN_LEN) throw new AppError(400, `The API key may be at most ${MAX_TOKEN_LEN} characters`);
  if (next.attribution.length > MAX_ATTRIBUTION_LEN) throw new AppError(400, `The attribution may be at most ${MAX_ATTRIBUTION_LEN} characters`);
  if (!Number.isInteger(next.maxNativeZoom) || next.maxNativeZoom < 1 || next.maxNativeZoom > MAX_ZOOM) {
    throw new AppError(400, `The deepest zoom must be a whole number from 1 to ${MAX_ZOOM}`);
  }
  // A switched-off source may be left half filled in; a switched-on one must work.
  if (next.enabled || next.urlTemplate) {
    const problem = urlTemplateProblem(next.urlTemplate, !!next.apiToken);
    if (problem) throw new AppError(400, problem);
  }
  if (next.enabled && !next.attribution) {
    throw new AppError(400, "Enter the attribution the provider's terms require (for example \"Imagery © Esri\")");
  }
  return next;
}

export async function saveSatelliteSettings(patch: SatelliteSettingsPatch, actor: string): Promise<SatelliteSettingsView> {
  const before = await read();
  const next = mergeSatelliteSettings(before, patch);
  const saved = await store.save(next);
  clearTileCache();
  const overriddenBy = (await readArcgisBasemap())?.name ?? null;
  const host = (() => { try { return new URL(saved.urlTemplate.replace(/\{[a-z]+\}/g, "0")).host; } catch { return null; } })();
  await logEvent({
    action: "setting.satellite_updated", resourceType: "setting", resourceName: SATELLITE_SETTING_KEY, actor, level: "info",
    message: saved.enabled ? `Satellite imagery on (${host ?? "no host"})` : "Satellite imagery off",
    // Never the key itself — whether it changed is enough to audit.
    details: {
      before: toView(before), after: toView(saved),
      apiTokenChanged: before.apiToken !== saved.apiToken,
    },
  });
  return toView(saved, overriddenBy);
}

// ── Tiles ─────────────────────────────────────────────────────────────────
interface Tile { body: Buffer; contentType: string }
const tileCache = new Map<string, Tile>();
const tileInFlight = new Map<string, Promise<Tile>>();
let tileCacheBytes = 0;

function clearTileCache(): void {
  tileCache.clear();
  tileCacheBytes = 0;
}

function evictFor(bytes: number): void {
  while (tileCache.size > 0 && (tileCacheBytes + bytes > TILE_CACHE_MAX_BYTES || tileCache.size >= TILE_CACHE_MAX_ENTRIES)) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    tileCacheBytes -= tileCache.get(oldest)!.body.byteLength;
    tileCache.delete(oldest);
  }
}

// Tiles are keyed by a source GENERATION, not a hash of the settings: hashing
// the API key with a fast digest reads as an insecure password hash (CodeQL
// js/insufficient-password-hash), and nothing here needs a digest — the
// current source is compared to the last one seen, in memory, and a change
// (a save on another process included) moves the generation, so an old
// source's tile and in-flight fetch can never answer for the new one.
let tileSource: string | null = null;
let tileGeneration = 0;

function generationFor(src: TileSource): number {
  if (tileSource !== src.identity) {
    if (tileSource !== null) clearTileCache();
    tileSource = src.identity;
    tileGeneration++;
  }
  return tileGeneration;
}

/** The parts of a fetch response a tile needs (global fetch and undici's both fit). */
interface TileResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * `verifySsl: false` (an ArcGIS Enterprise portal with a private certificate)
 * goes through tlsFetch, which pins the certificate instead (rule 113(e)).
 */
async function fetchTile(url: string, verifySsl = true): Promise<Tile> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: TileResponse;
  try {
    const init = {
      headers: { "User-Agent": `Polaris/${getAppVersion()}` },
      signal: ctrl.signal,
      redirect: "error" as const,
    };
    res = verifySsl ? await fetch(url, init) : await tlsFetch(url, init, false);
  } catch (err) {
    const why = (err as Error)?.name === "AbortError" ? "timed out" : "could not be reached";
    throw new AppError(502, `The satellite tile server ${why}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw new AppError(404, "No satellite tile here");
  if (res.status === 401 || res.status === 403) throw new AppError(502, `The satellite tile server refused the request (HTTP ${res.status}) — check the API key or sign-in`);
  if (!res.ok) throw new AppError(502, `The satellite tile server returned HTTP ${res.status}`);
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!contentType.startsWith("image/") || contentType === "image/svg+xml") {
    throw new AppError(502, "The satellite tile server did not return an image — check the tile URL");
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.byteLength > TILE_MAX_BYTES) throw new AppError(502, "The satellite tile was too large");
  return { body, contentType };
}

function checkCoords(z: number, x: number, y: number): void {
  if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) throw new AppError(400, `Tile zoom must be an integer 0-${MAX_ZOOM}`);
  const extent = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= extent || y >= extent) {
    throw new AppError(400, "Tile x/y out of range for zoom level");
  }
}

/** One proxied tile. 404 when satellite imagery is not configured. */
export async function getSatelliteTile(z: number, x: number, y: number): Promise<Tile> {
  checkCoords(z, x, y);
  const src = await resolveSource();
  if (!src) throw new AppError(404, "Satellite imagery is not configured");
  if (z > src.maxNativeZoom) throw new AppError(400, `The satellite source serves zoom 0-${src.maxNativeZoom}`);
  const key = `${generationFor(src)}/${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;
  const pending = tileInFlight.get(key);
  if (pending) return pending;
  const promise = tileUrl(src, z, x, y)
    .then((url) => fetchTile(url, src.verifySsl))
    .then((tile) => {
      evictFor(tile.body.byteLength);
      tileCache.set(key, tile);
      tileCacheBytes += tile.body.byteLength;
      return tile;
    })
    .finally(() => { tileInFlight.delete(key); });
  tileInFlight.set(key, promise);
  return promise;
}

/**
 * The card's Test button: fetch one tile with the settings ON SCREEN (not yet
 * saved). An omitted key means "the stored one". Returns what came back.
 */
export async function testSatelliteSettings(patch: SatelliteSettingsPatch): Promise<{ ok: true; contentType: string; bytes: number }> {
  const candidate = mergeSatelliteSettings(await read(), { ...patch, enabled: true, attribution: patch.attribution || "(test)" });
  // z 1 rather than 0: some imagery services do not serve the single world tile.
  const tile = await fetchTile(buildTileUrl(candidate, 1, 0, 0));
  return { ok: true, contentType: tile.contentType, bytes: tile.body.byteLength };
}

/** The upstream URL; a refused ArcGIS sign-in is a 502 naming why. */
async function tileUrl(src: TileSource, z: number, x: number, y: number): Promise<string> {
  try {
    return await src.url(z, x, y);
  } catch (err) {
    if (err instanceof ArcgisError) throw new AppError(502, `The ArcGIS sign-in for satellite imagery failed: ${err.message}`);
    throw err;
  }
}

/**
 * Part of an ArcGIS integration's Test Connection when its basemap is on: one
 * tile with the config on screen. A 404 still proves the service answers — a
 * regional imagery cache has no tile at zoom 1 over most of the world.
 */
export async function testArcgisBasemap(config: ArcgisConfig): Promise<{ ok: boolean; message: string }> {
  const { root, sendToken } = basemapService(config);
  if ((config.basemapSource ?? "world_imagery") === "service") {
    const problem = imageryUrlProblem(root);
    if (problem) return { ok: false, message: problem };
  }
  try {
    const token = sendToken ? await getArcgisToken(config) : null;
    const tile = await fetchTile(basemapTileUrl(config, token, 1, 0, 0), config.verifySsl !== false);
    return { ok: true, message: `satellite imagery answered (${Math.round(tile.body.byteLength / 1024)} KB tile)` };
  } catch (err) {
    if (err instanceof AppError && err.httpStatus === 404) return { ok: true, message: "satellite imagery answered (no tile at zoom 1 here, which is normal for a regional service)" };
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** Tests only. */
export function _resetSatelliteForTests(): void {
  store.invalidate();
  clearTileCache();
  tileInFlight.clear();
  tileSource = null;
  arcgisCache = null;
}
