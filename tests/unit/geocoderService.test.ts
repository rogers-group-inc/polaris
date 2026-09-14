/**
 * tests/unit/geocoderService.test.ts
 *
 * The geocoder's provider chain and its per-provider cache. Exercises the
 * public `geocode()` surface with a stubbed global fetch (weatherProxyService
 * precedent) and a mocked Prisma.
 *
 * The load-bearing behaviours here are the ones that make the chain worth
 * having: a Nominatim MISS must fall through to Census, a cached NEGATIVE must
 * suppress only its own provider's leg (never the whole chain — that was the
 * bug a query-keyed cache would have reintroduced), and a transport failure
 * must leave no cache row behind.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    geocodeCache: { findUnique: vi.fn(), upsert: vi.fn() },
  },
}));

import { geocode, __resetGeocoderStateForTests } from "../../src/services/geocoderService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const findUnique = prisma.geocodeCache.findUnique as unknown as Mock;
const upsert = prisma.geocodeCache.upsert as unknown as Mock;

const NOMINATIM_HIT = [{ lat: "30.7293", lon: "-88.0602" }];
const NOMINATIM_MISS: unknown[] = [];
const CENSUS_HIT = {
  result: {
    addressMatches: [
      { coordinates: { x: -88.060171929088, y: 30.729323127577 } },
    ],
  },
};
const CENSUS_MISS = { result: { addressMatches: [] } };

function jsonResponse(body: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** Stub fetch with one response per call, in order. */
function stubFetch(...responses: unknown[]) {
  const mock = vi.fn();
  for (const r of responses) mock.mockResolvedValueOnce(r);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** The provider each fetch call went to, in order. */
function providersCalled(mock: Mock): string[] {
  return mock.mock.calls.map(([url]: [string]) =>
    url.includes("census") ? "census" : "nominatim",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetGeocoderStateForTests(); // rate-limit gates → 0ms
  // A real .env is loaded by tests/setup.ts; pin the chain so a host override
  // can't change what these tests are asserting.
  vi.stubEnv("POLARIS_GEOCODER_PROVIDERS", "nominatim,census");
  vi.stubEnv("POLARIS_GEOCODER_NOMINATIM_URL", "https://nominatim.example/search");
  vi.stubEnv("POLARIS_GEOCODER_CENSUS_URL", "https://geocoding.census.example/onelineaddress");
  findUnique.mockResolvedValue(null); // cold cache
  upsert.mockResolvedValue({});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("provider chain", () => {
  it("returns the Nominatim hit without consulting Census", async () => {
    const fetchMock = stubFetch(jsonResponse(NOMINATIM_HIT));

    const result = await geocode("Atlanta, GA");

    expect(result).toEqual({
      latitude: 30.7293,
      longitude: -88.0602,
      cached: false,
      provider: "nominatim",
    });
    expect(providersCalled(fetchMock)).toEqual(["nominatim"]);
  });

  it("falls through to Census when Nominatim has no match", async () => {
    const fetchMock = stubFetch(jsonResponse(NOMINATIM_MISS), jsonResponse(CENSUS_HIT));

    const result = await geocode("1920 Bay Bridge Cutoff Rd, Mobile, AL 36610");

    expect(result.provider).toBe("census");
    expect(result.latitude).toBeCloseTo(30.729323, 5);
    expect(result.longitude).toBeCloseTo(-88.060172, 5);
    expect(providersCalled(fetchMock)).toEqual(["nominatim", "census"]);
  });

  it("returns nothing when every provider misses", async () => {
    stubFetch(jsonResponse(NOMINATIM_MISS), jsonResponse(CENSUS_MISS));

    expect(await geocode("Building 4 rear closet")).toEqual({
      latitude: null,
      longitude: null,
      cached: false,
      provider: null,
    });
  });

  it("sends the query in each provider's own parameter shape", async () => {
    const fetchMock = stubFetch(jsonResponse(NOMINATIM_MISS), jsonResponse(CENSUS_HIT));

    await geocode("1920 Bay Bridge Cutoff Rd, Mobile, AL 36610");

    const nominatimUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(nominatimUrl.searchParams.get("q")).toBe("1920 Bay Bridge Cutoff Rd, Mobile, AL 36610");
    expect(nominatimUrl.searchParams.get("format")).toBe("jsonv2");
    expect(nominatimUrl.searchParams.get("limit")).toBe("1");

    const censusUrl = new URL(fetchMock.mock.calls[1][0]);
    expect(censusUrl.searchParams.get("address")).toBe("1920 Bay Bridge Cutoff Rd, Mobile, AL 36610");
    expect(censusUrl.searchParams.get("benchmark")).toBe("Public_AR_Current");
    expect(censusUrl.searchParams.get("format")).toBe("json");
  });

  it("identifies Polaris in the User-Agent (Nominatim usage policy)", async () => {
    const fetchMock = stubFetch(jsonResponse(NOMINATIM_HIT));
    await geocode("Atlanta, GA");
    expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toMatch(/^Polaris-IPAM\//);
  });

  it("treats a (0,0) answer as no match and keeps walking the chain", async () => {
    const fetchMock = stubFetch(
      jsonResponse([{ lat: "0", lon: "0" }]),
      jsonResponse(CENSUS_HIT),
    );

    const result = await geocode("somewhere unset");

    expect(result.provider).toBe("census");
    expect(providersCalled(fetchMock)).toEqual(["nominatim", "census"]);
    // The zero pair is cached as a NEGATIVE for nominatim, not stored as coords.
    expect(upsert.mock.calls[0][0].update).toMatchObject({
      provider: "nominatim",
      latitude: null,
      longitude: null,
    });
  });

  it("ignores an empty input without touching the network", async () => {
    const fetchMock = stubFetch();
    expect(await geocode("   ")).toEqual({
      latitude: null, longitude: null, cached: false, provider: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("provider configuration", () => {
  it("honours the configured order", async () => {
    vi.stubEnv("POLARIS_GEOCODER_PROVIDERS", "census,nominatim");
    const fetchMock = stubFetch(jsonResponse(CENSUS_MISS), jsonResponse(NOMINATIM_HIT));

    const result = await geocode("Atlanta, GA");

    expect(providersCalled(fetchMock)).toEqual(["census", "nominatim"]);
    expect(result.provider).toBe("nominatim");
  });

  it("drops unknown provider names and keeps the rest", async () => {
    vi.stubEnv("POLARIS_GEOCODER_PROVIDERS", "mapbox, census ,nominatim");
    const fetchMock = stubFetch(jsonResponse(CENSUS_HIT));

    await geocode("1920 Bay Bridge Cutoff Rd, Mobile, AL 36610");

    expect(providersCalled(fetchMock)).toEqual(["census"]);
  });

  it("disables geocoding entirely when the chain is empty", async () => {
    vi.stubEnv("POLARIS_GEOCODER_PROVIDERS", "");
    const fetchMock = stubFetch();

    expect(await geocode("Atlanta, GA")).toEqual({
      latitude: null, longitude: null, cached: false, provider: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("cache", () => {
  it("keys reads and writes on (provider, normalized query)", async () => {
    stubFetch(jsonResponse(NOMINATIM_HIT));

    await geocode("  Atlanta,   GA  ");

    expect(findUnique.mock.calls[0][0]).toEqual({
      where: { provider_query: { provider: "nominatim", query: "atlanta, ga" } },
    });
    const write = upsert.mock.calls[0][0];
    expect(write.where).toEqual({
      provider_query: { provider: "nominatim", query: "atlanta, ga" },
    });
    // displayQuery keeps the operator's original casing (trimmed).
    expect(write.create).toMatchObject({
      query: "atlanta, ga",
      displayQuery: "Atlanta,   GA",
      provider: "nominatim",
      latitude: 30.7293,
    });
  });

  it("serves a positive hit from cache without any request", async () => {
    findUnique.mockResolvedValueOnce({
      latitude: 36.1627,
      longitude: -86.7816,
      ttlExpiresAt: new Date(Date.now() + 60_000),
    });
    const fetchMock = stubFetch();

    expect(await geocode("Nashville, TN")).toEqual({
      latitude: 36.1627,
      longitude: -86.7816,
      cached: true,
      provider: "nominatim",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("lets a cached Nominatim negative fall through to a live Census call", async () => {
    findUnique
      .mockResolvedValueOnce({
        latitude: null,
        longitude: null,
        ttlExpiresAt: new Date(Date.now() + 60_000),
      })
      .mockResolvedValueOnce(null);
    const fetchMock = stubFetch(jsonResponse(CENSUS_HIT));

    const result = await geocode("1920 Bay Bridge Cutoff Rd, Mobile, AL 36610");

    // The negative suppressed ONLY the Nominatim leg.
    expect(providersCalled(fetchMock)).toEqual(["census"]);
    expect(result.provider).toBe("census");
    expect(result.cached).toBe(false);
  });

  it("refetches once a cached row has expired", async () => {
    findUnique.mockResolvedValueOnce({
      latitude: 1,
      longitude: 1,
      ttlExpiresAt: new Date(Date.now() - 60_000),
    });
    const fetchMock = stubFetch(jsonResponse(NOMINATIM_HIT));

    const result = await geocode("Atlanta, GA");

    expect(providersCalled(fetchMock)).toEqual(["nominatim"]);
    expect(result.latitude).toBe(30.7293);
  });

  it("caches a miss so the provider isn't asked again", async () => {
    stubFetch(jsonResponse(NOMINATIM_MISS), jsonResponse(CENSUS_MISS));

    await geocode("Building 4 rear closet");

    expect(upsert).toHaveBeenCalledTimes(2);
    for (const [args] of upsert.mock.calls) {
      expect(args.create).toMatchObject({ latitude: null, longitude: null });
    }
    expect(upsert.mock.calls.map(([a]: [any]) => a.create.provider)).toEqual([
      "nominatim",
      "census",
    ]);
  });

  it("sets a 90-day TTL", async () => {
    stubFetch(jsonResponse(NOMINATIM_HIT));
    const before = Date.now();

    await geocode("Atlanta, GA");

    const { fetchedAt, ttlExpiresAt } = upsert.mock.calls[0][0].create;
    expect(ttlExpiresAt.getTime() - fetchedAt.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
    expect(fetchedAt.getTime()).toBeGreaterThanOrEqual(before);
  });
});

describe("failure handling", () => {
  it("does NOT cache a non-2xx response, and still tries the next provider", async () => {
    const fetchMock = stubFetch(jsonResponse({}, 503), jsonResponse(CENSUS_HIT));

    const result = await geocode("1920 Bay Bridge Cutoff Rd, Mobile, AL 36610");

    expect(providersCalled(fetchMock)).toEqual(["nominatim", "census"]);
    expect(result.provider).toBe("census");
    // Only the Census answer was persisted — a 503 must stay retryable.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0][0].create.provider).toBe("census");
  });

  it("does NOT cache a thrown transport error", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await geocode("Atlanta, GA");

    expect(result.provider).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("geocodes anyway when the cache read fails", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    stubFetch(jsonResponse(NOMINATIM_HIT));

    const result = await geocode("Atlanta, GA");

    expect(result.latitude).toBe(30.7293);
    expect(result.provider).toBe("nominatim");
  });

  it("returns the coordinates even when the cache write fails", async () => {
    upsert.mockRejectedValue(new Error("db down"));
    stubFetch(jsonResponse(NOMINATIM_HIT));

    const result = await geocode("Atlanta, GA");

    expect(result.latitude).toBe(30.7293);
  });

  it("never throws on a malformed upstream body", async () => {
    stubFetch(jsonResponse({ unexpected: true }), jsonResponse({ result: null }));

    await expect(geocode("Atlanta, GA")).resolves.toMatchObject({ provider: null });
  });
});

describe("rate limiting", () => {
  it("spaces consecutive requests to the same provider", async () => {
    __resetGeocoderStateForTests(60);
    vi.stubEnv("POLARIS_GEOCODER_PROVIDERS", "nominatim");
    stubFetch(jsonResponse(NOMINATIM_HIT), jsonResponse(NOMINATIM_HIT));

    const started = Date.now();
    await geocode("Atlanta, GA");
    await geocode("Nashville, TN");

    // First call is immediate; the second waits out the gate.
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it("does not make one provider's gate delay another's", async () => {
    __resetGeocoderStateForTests(60);
    stubFetch(jsonResponse(NOMINATIM_MISS), jsonResponse(CENSUS_HIT));

    const started = Date.now();
    await geocode("1920 Bay Bridge Cutoff Rd, Mobile, AL 36610");

    // Nominatim then Census within ONE call: each gate is entered for the
    // first time, so neither waits.
    expect(Date.now() - started).toBeLessThan(50);
  });
});
