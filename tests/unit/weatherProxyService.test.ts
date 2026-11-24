import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getRadarFrames,
  getRadarTile,
  getTemperature,
  __resetWeatherProxyCachesForTests,
} from "../../src/services/weatherProxyService.js";
import { AppError } from "../../src/utils/errors.js";

// Exercises the Status Map weather proxy's caching + validation through its
// public surface with a stubbed global fetch (fmgRpcRetry precedent). No DB.

const INDEX_BODY = {
  host: "https://tilecache.rainviewer.com",
  radar: {
    past: [
      { time: 1000, path: "/v2/radar/frameaaa" },
      { time: 1600, path: "/v2/radar/framebbb" },
    ],
  },
};

function jsonResponse(body: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function pngResponse(bytes: number[], status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  };
}

beforeEach(() => {
  __resetWeatherProxyCachesForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRadarFrames", () => {
  it("returns frame ids + times and caches the index", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(INDEX_BODY));
    vi.stubGlobal("fetch", fetchMock);

    const first = await getRadarFrames();
    expect(first.frames).toEqual([
      { id: "frameaaa", time: 1000 },
      { id: "framebbb", time: 1600 },
    ]);

    await getRadarFrames();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws 502 when the upstream index fails and no cache exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 503)));
    await expect(getRadarFrames()).rejects.toMatchObject({ httpStatus: 502 });
  });

  it("throws 502 on an empty index body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ host: "https://x", radar: { past: [] } })));
    await expect(getRadarFrames()).rejects.toMatchObject({ httpStatus: 502 });
  });
});

describe("getRadarTile", () => {
  it("proxies a tile and serves repeats from cache", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(INDEX_BODY))
      .mockResolvedValueOnce(pngResponse([1, 2, 3]));
    vi.stubGlobal("fetch", fetchMock);

    const tile = await getRadarTile("frameaaa", 7, 33, 49);
    expect([...tile]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://tilecache.rainviewer.com/v2/radar/frameaaa/256/7/33/49/6/1_1.png",
    );

    const again = await getRadarTile("frameaaa", 7, 33, 49);
    expect([...again]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2); // no second upstream fetch
  });

  it("rejects a frame id the index does not know (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(INDEX_BODY)));
    await expect(getRadarTile("not-a-frame", 7, 1, 1)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("rejects out-of-range tile coordinates (400) without fetching upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(INDEX_BODY));
    vi.stubGlobal("fetch", fetchMock);
    await expect(getRadarTile("frameaaa", 99, 0, 0)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(getRadarTile("frameaaa", 3, 8, 0)).rejects.toMatchObject({ httpStatus: 400 }); // x >= 2^3
    await expect(getRadarTile("frameaaa", 3, 0, -1)).rejects.toMatchObject({ httpStatus: 400 });
    expect(fetchMock).not.toHaveBeenCalled(); // validation precedes the index read
  });

  it("maps an upstream tile failure to 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(INDEX_BODY))
        .mockResolvedValueOnce(pngResponse([], 500)),
    );
    await expect(getRadarTile("frameaaa", 7, 1, 1)).rejects.toMatchObject({ httpStatus: 502 });
  });

  it("keeps the previous index generation's frame ids resolvable", async () => {
    const rotated = {
      host: "https://tilecache.rainviewer.com",
      radar: { past: [{ time: 2200, path: "/v2/radar/frameccc" }] },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(INDEX_BODY))
      .mockResolvedValueOnce(jsonResponse(rotated))
      .mockResolvedValueOnce(pngResponse([9]));
    vi.stubGlobal("fetch", fetchMock);

    await getRadarFrames();
    // Force the index past its TTL so the rotated generation is fetched.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    try {
      const idx = await getRadarFrames();
      expect(idx.frames).toEqual([{ id: "frameccc", time: 2200 }]);
      // frameaaa is gone from the new index but still resolves (grace).
      const tile = await getRadarTile("frameaaa", 5, 1, 1);
      expect([...tile]).toEqual([9]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getTemperature", () => {
  it("returns the reading and caches per 1.5° grid cell", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ current: { temperature_2m: 74.3 } }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getTemperature(38.19, -85.71)).toEqual({ temperature: 74.3 });
    // Same grid cell (rounds to the same key) → cache hit, no second fetch.
    expect(await getTemperature(38.2, -85.7)).toEqual({ temperature: 74.3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Different cell → new fetch.
    await getTemperature(45.0, -122.0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a null reading without throwing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ current: {} }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getTemperature(10, 10)).toEqual({ temperature: null });
    expect(await getTemperature(10, 10)).toEqual({ temperature: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws 502 on transport failure so the widget can fall back", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ETIMEDOUT")));
    await expect(getTemperature(10, 10)).rejects.toMatchObject({ httpStatus: 502 });
  });

  it("rejects out-of-range coordinates (400)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getTemperature(91, 0)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(getTemperature(0, 181)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(getTemperature(NaN, 0)).rejects.toMatchObject({ httpStatus: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates AppError instances unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, 429)));
    const err = await getTemperature(10, 10).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(502);
  });
});

describe("tile host pin (CodeQL #143)", () => {
  it("refuses an index that names another tile host", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...INDEX_BODY, host: "http://169.254.169.254" })));
    await expect(getRadarFrames()).rejects.toMatchObject({ httpStatus: 502 });
  });
  it("accepts the pinned host with a trailing slash", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ ...INDEX_BODY, host: "https://tilecache.rainviewer.com/" })));
    await expect(getRadarFrames()).resolves.toBeTruthy();
  });
});
