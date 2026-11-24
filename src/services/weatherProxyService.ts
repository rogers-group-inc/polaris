/**
 * src/services/weatherProxyService.ts — server-side proxy + cache for the
 * Status Map widget's weather overlay (RainViewer precipitation radar +
 * Open-Meteo current temperature).
 *
 * Why a proxy: every dashboard/dash-wallboard viewer used to fetch the same
 * ~14 radar frames × viewport tiles straight from RainViewer's CDN. Routing
 * through Polaris deduplicates those downloads (one upstream fetch per tile,
 * served to every viewer) and — the real win — lets wallboard kiosks on
 * egress-restricted VLANs show weather when only the Polaris server has
 * internet access. The widget still falls back to the CDNs directly when
 * these endpoints fail, so the CSP keeps the rainviewer/open-meteo hosts.
 *
 * Caching:
 *   - Frame index (weather-maps.json): 5 min TTL, in-flight dedupe, and
 *     serve-stale for up to 30 min when the upstream fetch fails.
 *   - Radar tiles: immutable per frame id (the id is a content hash in the
 *     RainViewer path), so a plain size-bounded FIFO keyed frame/z/x/y with
 *     no TTL. Tile requests are validated against the known frame ids from
 *     the last TWO index fetches, so an animation started just before an
 *     index rotation keeps resolving (and the endpoint can't be used as an
 *     open proxy).
 *   - Temperature: keyed on the same 1.5° grid the widget rounds to, 20 min
 *     TTL. Negative results (no data) cache too; transport failures throw
 *     (502) so the widget can fall back per-cell — they never poison the
 *     cache (geocoderService precedent).
 *
 * Everything here is read-only public weather data — no Events, no DB.
 */

import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { getAppVersion } from "../utils/version.js";

const RAINVIEWER_INDEX_URL = "https://api.rainviewer.com/public/weather-maps.json";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
/** The only tile host RainViewer's index is allowed to name (see getRadarTile). */
const RAINVIEWER_TILE_ORIGIN = "https://tilecache.rainviewer.com";
const REQUEST_TIMEOUT_MS = 8000;

const INDEX_TTL_MS = 5 * 60 * 1000;
const INDEX_STALE_MAX_MS = 30 * 60 * 1000;

// ~14 frames × a couple hundred viewport tiles × ~10 KB is well under this;
// the cap only matters when many operators pan across the whole country.
const TILE_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const TILE_CACHE_MAX_ENTRIES = 4000;
// The widget requests radar at maxNativeZoom 7; allow headroom, not the world.
const TILE_MAX_ZOOM = 12;

const TEMP_TTL_MS = 20 * 60 * 1000;
const TEMP_CACHE_MAX_ENTRIES = 500;
// Must match the widget's grid rounding (siteMap.js loadTemps) so every
// viewer of the same site cluster hits the same cache row.
const TEMP_GRID_DEG = 1.5;

export interface RadarFrame {
  /** Last segment of the RainViewer frame path — a content hash, so immutable. */
  id: string;
  /** Unix seconds of the radar snapshot. */
  time: number;
}

interface FrameIndexCache {
  fetchedAt: number;
  host: string;
  frames: RadarFrame[];
  /** frame id → full RainViewer path, union of the last two fetches. */
  knownPaths: Map<string, string>;
}

let indexCache: FrameIndexCache | null = null;
let indexInFlight: Promise<FrameIndexCache> | null = null;

const tileCache = new Map<string, Buffer>();
let tileCacheBytes = 0;
const tileInFlight = new Map<string, Promise<Buffer>>();

const tempCache = new Map<string, { fetchedAt: number; temperature: number | null }>();

function userAgent(): string {
  return `Polaris-IPAM/${getAppVersion()}`;
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { "User-Agent": userAgent() },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFrameIndex(): Promise<FrameIndexCache> {
  const res = await fetchWithTimeout(RAINVIEWER_INDEX_URL);
  if (!res.ok) throw new AppError(502, `RainViewer index returned HTTP ${res.status}`);
  const body = (await res.json()) as {
    host?: string;
    radar?: { past?: Array<{ time?: number; path?: string }> };
  };
  const host = typeof body?.host === "string" ? body.host.replace(/\/$/, "") : "";
  const past = Array.isArray(body?.radar?.past) ? body.radar!.past! : [];
  if (!host || past.length === 0) throw new AppError(502, "RainViewer index response was empty");
  // The tile host is pinned, not taken from the index on trust: a tampered or
  // changed index must not point this server at another address.
  if (host !== RAINVIEWER_TILE_ORIGIN) throw new AppError(502, `RainViewer index named an unexpected tile host "${host}"`);

  const frames: RadarFrame[] = [];
  const knownPaths = new Map<string, string>();
  for (const f of past) {
    if (typeof f?.path !== "string" || typeof f?.time !== "number") continue;
    const id = f.path.split("/").filter(Boolean).pop();
    if (!id) continue;
    frames.push({ id, time: f.time });
    knownPaths.set(id, f.path);
  }
  if (frames.length === 0) throw new AppError(502, "RainViewer index carried no radar frames");

  // Grace: keep the previous index's frame ids resolvable so an animation
  // started just before this rotation doesn't 404 its remaining tiles.
  if (indexCache) {
    for (const [id, path] of indexCache.knownPaths) {
      if (!knownPaths.has(id)) knownPaths.set(id, path);
    }
    // Bound the union to two generations (~30 frames).
    while (knownPaths.size > frames.length * 2 + 4) {
      const oldest = knownPaths.keys().next().value;
      if (oldest === undefined) break;
      knownPaths.delete(oldest);
    }
  }

  return { fetchedAt: Date.now(), host, frames, knownPaths };
}

async function getIndex(): Promise<FrameIndexCache> {
  const now = Date.now();
  if (indexCache && now - indexCache.fetchedAt < INDEX_TTL_MS) return indexCache;
  if (indexInFlight) return indexInFlight;
  indexInFlight = fetchFrameIndex()
    .then((idx) => {
      indexCache = idx;
      return idx;
    })
    .catch((err) => {
      // Serve-stale: a transient RainViewer outage shouldn't flip every
      // viewer to the CDN (which is presumably also unreachable from here).
      if (indexCache && now - indexCache.fetchedAt < INDEX_STALE_MAX_MS) {
        logger.warn({ err: (err as Error)?.message }, "weather.index_stale_served");
        return indexCache;
      }
      throw err;
    })
    .finally(() => {
      indexInFlight = null;
    });
  return indexInFlight;
}

/** Radar frame list for the widget: `{ frames: [{ id, time }] }`. */
export async function getRadarFrames(): Promise<{ frames: RadarFrame[] }> {
  const idx = await getIndex();
  return { frames: idx.frames };
}

function evictTilesFor(bytes: number): void {
  while (
    tileCache.size > 0 &&
    (tileCacheBytes + bytes > TILE_CACHE_MAX_BYTES || tileCache.size >= TILE_CACHE_MAX_ENTRIES)
  ) {
    const oldest = tileCache.keys().next().value;
    if (oldest === undefined) break;
    tileCacheBytes -= tileCache.get(oldest)!.byteLength;
    tileCache.delete(oldest);
  }
}

/**
 * One radar tile PNG (256px, color scheme 6, smoothed+snow "1_1" — the same
 * rendering options the widget's direct-CDN URL template hardcodes).
 * Throws 400 on out-of-range coordinates, 404 for a frame id not in the
 * current-or-previous index, 502 on upstream failure.
 */
export async function getRadarTile(frameId: string, z: number, x: number, y: number): Promise<Buffer> {
  if (!Number.isInteger(z) || z < 0 || z > TILE_MAX_ZOOM) {
    throw new AppError(400, `Tile zoom must be an integer 0-${TILE_MAX_ZOOM}`);
  }
  const extent = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= extent || y >= extent) {
    throw new AppError(400, "Tile x/y out of range for zoom level");
  }

  const idx = await getIndex();
  const path = idx.knownPaths.get(frameId);
  if (!path) throw new AppError(404, "Unknown radar frame — refresh the frame list");

  const key = `${frameId}/${z}/${x}/${y}`;
  const cached = tileCache.get(key);
  if (cached) return cached;

  const inFlight = tileInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    // A literal origin with its trailing "/" as the prefix: nothing after it can
    // move the request to another host.
    const res = await fetchWithTimeout(`https://tilecache.rainviewer.com/${path.replace(/^\/+/, "")}/256/${z}/${x}/${y}/6/1_1.png`);
    if (res.status === 404) throw new AppError(404, "Radar tile not found upstream");
    if (!res.ok) throw new AppError(502, `RainViewer tile returned HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    evictTilesFor(buf.byteLength);
    tileCache.set(key, buf);
    tileCacheBytes += buf.byteLength;
    return buf;
  })().finally(() => {
    tileInFlight.delete(key);
  });
  tileInFlight.set(key, promise);
  return promise;
}

/**
 * Current temperature (°F) at a coordinate, cached per 1.5° grid cell.
 * Returns null when Open-Meteo has no reading; throws 502 on transport
 * failure so the widget can fall back to fetching Open-Meteo directly.
 */
export async function getTemperature(lat: number, lng: number): Promise<{ temperature: number | null }> {
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new AppError(400, "lat/lng out of range");
  }

  const key = `${Math.round(lat / TEMP_GRID_DEG)},${Math.round(lng / TEMP_GRID_DEG)}`;
  const cached = tempCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TEMP_TTL_MS) {
    return { temperature: cached.temperature };
  }

  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lng));
  url.searchParams.set("current", "temperature_2m");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("forecast_days", "1");

  let temperature: number | null = null;
  try {
    const res = await fetchWithTimeout(url.toString());
    if (!res.ok) throw new AppError(502, `Open-Meteo returned HTTP ${res.status}`);
    const body = (await res.json()) as { current?: { temperature_2m?: unknown } };
    const t = body?.current?.temperature_2m;
    temperature = typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, `Open-Meteo fetch failed: ${(err as Error)?.message}`);
  }

  if (tempCache.size >= TEMP_CACHE_MAX_ENTRIES) {
    const oldest = tempCache.keys().next().value;
    if (oldest !== undefined) tempCache.delete(oldest);
  }
  tempCache.set(key, { fetchedAt: Date.now(), temperature });
  return { temperature };
}

/** Test seam — drops every module-level cache. */
export function __resetWeatherProxyCachesForTests(): void {
  indexCache = null;
  indexInFlight = null;
  tileCache.clear();
  tileCacheBytes = 0;
  tileInFlight.clear();
  tempCache.clear();
}
