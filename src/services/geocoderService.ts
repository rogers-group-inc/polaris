/**
 * src/services/geocoderService.ts
 *
 * Address-string → lat/lng geocoder. Used by FMG/FortiGate discovery to derive
 * coordinates from a FortiGate's FMG address metavariable or its SNMP
 * `sysLocation` when the CMDB `gui-device-latitude` / `gui-device-longitude`
 * are missing or malformed — the strict fallback path in syncDhcpSubnets
 * Phase 3.
 *
 * Provider chain: the providers named by `POLARIS_GEOCODER_PROVIDERS` are tried
 * in order (default `nominatim,census`) and the first VALID hit wins. The two
 * fail in opposite directions, which is the whole reason for the chain:
 *
 *   - `nominatim` (OpenStreetMap) resolves place names and POIs — "Atlanta, GA",
 *     a site label, anything non-US — but misses plenty of real US street
 *     addresses that aren't in OSM.
 *   - `census` (US Census Bureau geocoder, TIGER address ranges) resolves US
 *     street addresses that OSM has never heard of, and returns NOTHING for a
 *     city/state string or any address outside the US.
 *
 * Accuracy caveat: a Census hit is interpolated along the TIGER street segment
 * (correct block, correct side of the street, NOT the rooftop), where a
 * Nominatim hit is usually a real OSM node/way. That's why Nominatim leads the
 * default order — Census is the fallback that turns a miss into a block-level
 * pin, not a precision upgrade. `GeocodeResult.provider` names whoever answered.
 *
 * Caching: results live in the `GeocodeCache` table for 90 days, keyed on
 * (provider, normalized query) — one row per provider per string. Negative
 * results (that provider found nothing) are stored with null lat/lng so we
 * don't repeatedly hit an upstream for input it will never resolve; a negative
 * row suppresses only ITS OWN provider's leg and the chain still walks on to
 * the next one. Transport failures (timeout, non-2xx, parse error) are NOT
 * cached — those are retried on the next cycle so a transient outage doesn't
 * poison the table.
 *
 * Rate limit: per provider, serialized process-wide by a chained Promise.
 * Nominatim's usage policy permits at most 1 req/sec per application; the
 * Census geocoder publishes no per-second limit, so its gate is politeness
 * only. Cache hits skip the rate limiter entirely — steady-state requests are
 * near-zero after the initial fleet pass.
 */
import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { isValidGeoCoord } from "../utils/geo.js";
import { getAppVersion } from "../utils/version.js";
import { logEventsBatch } from "./eventLogService.js";

const DEFAULT_NOMINATIM_ENDPOINT = "https://nominatim.openstreetmap.org/search";
const DEFAULT_CENSUS_ENDPOINT =
  "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const DEFAULT_PROVIDER_ORDER = "nominatim,census";
const REQUEST_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export interface GeocodeResult {
  latitude: number | null;
  longitude: number | null;
  cached: boolean;
  /** Provider that produced the coordinates; null when nothing resolved. */
  provider: string | null;
  /** Why nothing resolved; null on a hit and for an empty input. */
  failure: GeocodeFailure | null;
}

/**
 * Why a non-empty query produced no coordinates. `unreachable` wins over
 * `no_match` when the chain saw both: a provider that never answered might
 * have had the address, so "nobody knows this address" would be a claim the
 * run does not support.
 */
export interface GeocodeFailure {
  reason: "no_match" | "unreachable" | "disabled";
  /** Each provider tried, in chain order, and what it said. */
  providers: Array<{ name: string; outcome: "no_match" | "no_match_cached" | "unreachable" }>;
}

const NO_RESULT: GeocodeResult = {
  latitude: null,
  longitude: null,
  cached: false,
  provider: null,
  failure: null,
};

/** A parsed upstream answer: coordinates, or null for "no match". */
type ProviderHit = { latitude: number; longitude: number } | null;

interface GeocodeProvider {
  name: string;
  /** Minimum gap between outgoing requests to THIS provider, ms. */
  rateLimitMs: number;
  buildUrl(query: string): string;
  /** Parse a 2xx body. Return null for a well-formed "no match" response. */
  parse(body: unknown): ProviderHit;
}

/** Read a coordinate out of an unknown JSON value; NaN-safe. */
function coordPair(lat: unknown, lng: unknown): ProviderHit {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  // A provider "hit" must be a valid geographic pair. (0,0) is treated as
  // unset here for the same reason it is in isValidGeoCoord — no operator
  // pins a firewall in the Gulf of Guinea — so a provider that answers with
  // zeroes is cached as a negative and the chain walks on.
  if (!isValidGeoCoord(parsedLat, parsedLng)) return null;
  return { latitude: parsedLat, longitude: parsedLng };
}

const PROVIDERS: Record<string, GeocodeProvider> = {
  nominatim: {
    name: "nominatim",
    rateLimitMs: 1100, // 1 req/sec policy + 100ms safety margin
    buildUrl(query) {
      const url = new URL(
        process.env.POLARIS_GEOCODER_NOMINATIM_URL || DEFAULT_NOMINATIM_ENDPOINT,
      );
      url.searchParams.set("q", query);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      return url.toString();
    },
    parse(body) {
      const rows = body as Array<{ lat?: string; lon?: string }> | undefined;
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return coordPair(rows[0]?.lat, rows[0]?.lon);
    },
  },
  census: {
    name: "census",
    rateLimitMs: 250, // politeness only — no published per-second limit
    buildUrl(query) {
      const url = new URL(
        process.env.POLARIS_GEOCODER_CENSUS_URL || DEFAULT_CENSUS_ENDPOINT,
      );
      url.searchParams.set("address", query);
      url.searchParams.set("benchmark", "Public_AR_Current");
      url.searchParams.set("format", "json");
      return url.toString();
    },
    parse(body) {
      // { result: { addressMatches: [ { coordinates: { x: lon, y: lat } } ] } }
      // An unmatched address is a 200 with an empty addressMatches array.
      const matches = (
        body as { result?: { addressMatches?: Array<{ coordinates?: { x?: number; y?: number } }> } }
      )?.result?.addressMatches;
      if (!Array.isArray(matches) || matches.length === 0) return null;
      return coordPair(matches[0]?.coordinates?.y, matches[0]?.coordinates?.x);
    },
  },
};

/**
 * Resolve the ordered provider chain from the environment. Unknown names are
 * dropped with a warning; an empty list disables geocoding outright (a
 * supported posture for installs with no outbound internet — see .env.example).
 */
function resolveProviders(): GeocodeProvider[] {
  const raw = process.env.POLARIS_GEOCODER_PROVIDERS ?? DEFAULT_PROVIDER_ORDER;
  const out: GeocodeProvider[] = [];
  for (const token of raw.split(",")) {
    const name = token.trim().toLowerCase();
    if (!name) continue;
    const provider = PROVIDERS[name];
    if (!provider) {
      logger.warn({ provider: name }, "geocode.unknown_provider_ignored");
      continue;
    }
    if (!out.includes(provider)) out.push(provider);
  }
  return out;
}

/**
 * Canonicalize a free-text location string into the cache key. Same
 * normalization is applied on read and write so "Atlanta, GA" / "atlanta,  ga"
 * / " Atlanta,  GA " all collapse to one row per provider.
 */
function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase();
}

// ─── Rate limit gate (per provider) ─────────────────────────────────────────
// Each entry is the tail of a Promise chain. A request awaits its provider's
// tail, fires, then sleeps for that provider's rateLimitMs before resolving the
// next step. Module-level so it serializes across every discovery cycle in the
// process, and per-provider so a slow Nominatim leg doesn't throttle Census.
// INTENTIONAL .then() serialization queue — this is the rate-limiter itself,
// not a fire-and-forget; do NOT rewrite to an async IIFE (would break the
// chaining that enforces one-request-per-rateLimitMs ordering).
const chains = new Map<string, Promise<void>>();

function acquireRateSlot(provider: GeocodeProvider): Promise<void> {
  const gap = provider.rateLimitMs;
  if (gap <= 0) return Promise.resolve();
  const wait = new Promise<void>((resolveSlot) => {
    const prior = chains.get(provider.name) ?? Promise.resolve();
    chains.set(
      provider.name,
      prior.then(async () => {
        resolveSlot();
        // Hold the slot for rateLimitMs so the NEXT acquire waits.
        await new Promise<void>((r) => setTimeout(r, gap));
      }),
    );
  });
  return wait;
}

/** User-Agent identifying Polaris per Nominatim's usage policy. */
function userAgent(): string {
  return `Polaris-IPAM/${getAppVersion()}`;
}

/**
 * One upstream call. Returns the parsed hit (or null for a clean "no match"),
 * or the `TRANSPORT_FAILED` sentinel when the request itself failed — the
 * caller must not cache that.
 */
const TRANSPORT_FAILED = Symbol("transport-failed");

async function fetchFromProvider(
  provider: GeocodeProvider,
  query: string,
): Promise<ProviderHit | typeof TRANSPORT_FAILED> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(provider.buildUrl(query), {
      headers: { "User-Agent": userAgent(), Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      logger.warn(
        { provider: provider.name, status: res.status, query },
        "geocode.upstream_non_200",
      );
      return TRANSPORT_FAILED;
    }
    return provider.parse(await res.json());
  } catch (err: any) {
    logger.warn(
      { provider: provider.name, err: err?.message, query },
      "geocode.upstream_fetch_failed",
    );
    return TRANSPORT_FAILED;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve a location string to lat/lng by walking the provider chain. Always
 * returns a result object — never throws. Callers in the discovery hot path
 * don't need to wrap.
 */
export async function geocode(rawQuery: string): Promise<GeocodeResult> {
  const trimmed = (rawQuery || "").trim();
  if (!trimmed) return { ...NO_RESULT };

  const key = normalizeQuery(trimmed);
  const providers = resolveProviders();
  if (providers.length === 0) {
    logger.warn({ query: key }, "geocode.no_providers_configured");
    return { ...NO_RESULT, failure: { reason: "disabled", providers: [] } };
  }

  const outcomes: GeocodeFailure["providers"] = [];
  for (const provider of providers) {
    const now = new Date();

    // Cache lookup — a positive hit returns, a negative hit skips this
    // provider's network leg and falls through to the next provider.
    let negativeCached = false;
    try {
      const cached = await prisma.geocodeCache.findUnique({
        where: { provider_query: { provider: provider.name, query: key } },
      });
      if (cached && cached.ttlExpiresAt > now) {
        if (cached.latitude !== null && cached.longitude !== null) {
          logger.debug(
            { provider: provider.name, query: key, lat: cached.latitude, lng: cached.longitude },
            "geocode.cache_hit",
          );
          return {
            latitude: cached.latitude,
            longitude: cached.longitude,
            cached: true,
            provider: provider.name,
            failure: null,
          };
        }
        negativeCached = true;
      }
    } catch (err: any) {
      // DB error on cache read isn't fatal — fall through to live geocode.
      logger.warn({ provider: provider.name, err: err?.message }, "geocode.cache_read_failed");
    }
    if (negativeCached) {
      outcomes.push({ name: provider.name, outcome: "no_match_cached" });
      continue;
    }

    // Live request — gated by this provider's rate limiter.
    await acquireRateSlot(provider);
    const hit = await fetchFromProvider(provider, trimmed);

    // Transport failures don't poison the cache — try the next provider now,
    // and this one again on the next cycle.
    if (hit === TRANSPORT_FAILED) {
      outcomes.push({ name: provider.name, outcome: "unreachable" });
      continue;
    }

    // Persist positive OR negative result with a fresh TTL.
    await writeCacheRow(provider.name, key, trimmed, hit);

    if (hit) {
      return {
        latitude: hit.latitude,
        longitude: hit.longitude,
        cached: false,
        provider: provider.name,
        failure: null,
      };
    }
    outcomes.push({ name: provider.name, outcome: "no_match" });
  }

  const reason = outcomes.some((o) => o.outcome === "unreachable") ? "unreachable" : "no_match";
  return { ...NO_RESULT, failure: { reason, providers: outcomes } };
}

async function writeCacheRow(
  provider: string,
  key: string,
  displayQuery: string,
  hit: ProviderHit,
): Promise<void> {
  const now = new Date();
  const row = {
    displayQuery,
    latitude: hit?.latitude ?? null,
    longitude: hit?.longitude ?? null,
    provider,
    fetchedAt: now,
    ttlExpiresAt: new Date(now.getTime() + CACHE_TTL_MS),
  };
  try {
    await prisma.geocodeCache.upsert({
      where: { provider_query: { provider, query: key } },
      create: { query: key, ...row },
      update: row,
    });
  } catch (err: any) {
    // Failing to cache shouldn't block the result from reaching the caller.
    logger.warn({ provider, err: err?.message }, "geocode.cache_write_failed");
  }
}

// ─── Failure events on the asset ────────────────────────────────────────────
// A miss used to be silent: the pin quietly kept the device's other
// coordinates (often a stale pair in another state) and the only trace was a
// null row in geocode_cache. These events put it on the asset's Events tab.

export const GEOCODE_FAILED_ACTION = "asset.location.geocode_failed";
/** The same (asset, address, reason) is reported at most once per window. */
export const GEOCODE_FAILED_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;

export interface GeocodeFailureForAsset {
  assetId: string;
  assetName: string;
  /** The string that was geocoded, as the device reported it. */
  query: string;
  /** Where the string came from — the caller's geoSource. */
  source: "snmp" | "address-metavar";
  failure: GeocodeFailure;
  integrationId: string;
  integrationName: string;
  actor?: string;
}

/** The operator-facing sentence for one failure. Pure. */
export function describeGeocodeFailure(f: Pick<GeocodeFailureForAsset, "query" | "source" | "failure">): string {
  const what = f.source === "snmp" ? "SNMP location" : "address metavariable";
  const head = `The ${what} "${f.query}" could not be placed on the map`;
  const keep = "The map pin was not moved: it keeps the device's other coordinates (manual, the Latitude/Longitude metavariables, or the FortiGate's own GUI coordinates).";
  const names = (outcome: (o: GeocodeFailure["providers"][number]) => boolean) =>
    f.failure.providers.filter(outcome).map((p) => p.name).join(" and ");
  if (f.failure.reason === "disabled") {
    return `${head}: geocoding is turned off on this server (POLARIS_GEOCODER_PROVIDERS is empty). ${keep}`;
  }
  if (f.failure.reason === "unreachable") {
    const down = names((p) => p.outcome === "unreachable");
    const missed = names((p) => p.outcome !== "unreachable");
    return `${head}: Polaris could not reach ${down}` +
      (missed ? ` (${missed} had no match)` : "") +
      `. It retries on the next discovery run. ${keep}`;
  }
  return `${head}: ${names(() => true)} ${f.failure.providers.length === 1 ? "does" : "do"} not recognise the address. ` +
    `A city, state and ZIP usually resolves; changing the text makes the next discovery run look it up again ` +
    `(a no-match for the same text is remembered for 90 days). ${keep}`;
}

/**
 * Write one warning Event per failure onto the asset (so the asset's Events
 * tab shows it), skipping any (asset, address, reason) already reported in the
 * last GEOCODE_FAILED_REPEAT_MS — discovery runs often, and a gate whose
 * address no geocoder knows would otherwise add a row every cycle. One read
 * and one batched write per call, whatever the fleet size. Never throws.
 */
export async function logGeocodeFailureEvents(entries: GeocodeFailureForAsset[], now = new Date()): Promise<number> {
  if (entries.length === 0) return 0;
  const keyOf = (assetId: string, query: string, reason: string) =>
    `${assetId}\u0000${normalizeQuery(query)}\u0000${reason}`;
  try {
    const recent = await prisma.event.findMany({
      where: {
        assetId: { in: [...new Set(entries.map((e) => e.assetId))] },
        action: GEOCODE_FAILED_ACTION,
        timestamp: { gte: new Date(now.getTime() - GEOCODE_FAILED_REPEAT_MS) },
      },
      select: { assetId: true, details: true },
    });
    const seen = new Set<string>();
    for (const r of recent) {
      const d = (r.details ?? {}) as { query?: unknown; reason?: unknown };
      if (r.assetId && typeof d.query === "string" && typeof d.reason === "string") {
        seen.add(keyOf(r.assetId, d.query, d.reason));
      }
    }
    const fresh = entries.filter((e) => {
      const k = keyOf(e.assetId, e.query, e.failure.reason);
      if (seen.has(k)) return false;
      seen.add(k); // also collapses duplicates within this batch
      return true;
    });
    return await logEventsBatch(fresh.map((e) => ({
      action: GEOCODE_FAILED_ACTION,
      resourceType: "asset",
      resourceId: e.assetId,
      resourceName: e.assetName,
      actor: e.actor,
      level: "warning" as const,
      message: describeGeocodeFailure(e),
      details: {
        query: e.query,
        source: e.source,
        reason: e.failure.reason,
        providers: e.failure.providers,
        integrationId: e.integrationId,
        integrationName: e.integrationName,
      },
    })));
  } catch (err: any) {
    logger.warn({ err: err?.message }, "geocode.failure_events_failed");
    return 0;
  }
}

/**
 * Test seam: clears the per-provider rate-limit chains and (by default) drops
 * every gate to zero so a suite isn't paced by Nominatim's 1 req/sec policy.
 */
export function __resetGeocoderStateForTests(rateLimitMs = 0): void {
  chains.clear();
  for (const provider of Object.values(PROVIDERS)) {
    provider.rateLimitMs = rateLimitMs;
  }
}
