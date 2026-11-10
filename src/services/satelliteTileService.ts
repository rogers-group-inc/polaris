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
 */

import { createHash } from "node:crypto";
import { createSettingStore } from "./settingsStore.js";
import { logEvent } from "./eventLogService.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getAppVersion } from "../utils/version.js";

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

/** What GET /server-settings/satellite returns: the token replaced by whether one is set. */
export type SatelliteSettingsView = Omit<SatelliteSettings, "apiToken"> & { apiTokenSet: boolean };

/** What a map viewer is told (GET /map/satellite). */
export interface SatelliteStatus {
  available: boolean;
  attribution: string;
  maxNativeZoom: number;
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

function toView(s: SatelliteSettings): SatelliteSettingsView {
  const { apiToken, ...rest } = s;
  return { ...rest, apiTokenSet: apiToken.length > 0 };
}

export async function getSatelliteSettings(): Promise<SatelliteSettingsView> {
  return toView(await read());
}

export async function getSatelliteStatus(): Promise<SatelliteStatus> {
  const s = await read();
  return { available: isUsable(s), attribution: s.attribution, maxNativeZoom: s.maxNativeZoom };
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
  return toView(saved);
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

function fingerprint(s: SatelliteSettings): string {
  return createHash("sha256").update(s.urlTemplate + "\n" + s.apiToken).digest("hex").slice(0, 16);
}

async function fetchTile(s: SatelliteSettings, z: number, x: number, y: number): Promise<Tile> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(buildTileUrl(s, z, x, y), {
      headers: { "User-Agent": `Polaris/${getAppVersion()}` },
      signal: ctrl.signal,
      redirect: "error",
    });
  } catch (err) {
    const why = (err as Error)?.name === "AbortError" ? "timed out" : "could not be reached";
    throw new AppError(502, `The satellite tile server ${why}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) throw new AppError(404, "No satellite tile here");
  if (res.status === 401 || res.status === 403) throw new AppError(502, `The satellite tile server refused the request (HTTP ${res.status}) — check the API key`);
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
  const s = await read();
  if (!isUsable(s)) throw new AppError(404, "Satellite imagery is not configured");
  if (z > s.maxNativeZoom) throw new AppError(400, `The satellite source serves zoom 0-${s.maxNativeZoom}`);
  const key = `${fingerprint(s)}/${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;
  const pending = tileInFlight.get(key);
  if (pending) return pending;
  const promise = fetchTile(s, z, x, y)
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
  const tile = await fetchTile(candidate, 1, 0, 0);
  return { ok: true, contentType: tile.contentType, bytes: tile.body.byteLength };
}

/** Tests only. */
export function _resetSatelliteForTests(): void {
  store.invalidate();
  clearTileCache();
  tileInFlight.clear();
}
