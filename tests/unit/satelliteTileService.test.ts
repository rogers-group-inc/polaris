/**
 * tests/unit/satelliteTileService.test.ts — the optional satellite basemap of
 * the topology view's Topology canvas: an operator-chosen provider whose tiles
 * Polaris proxies, so the key stays on the server and the CSP keeps one tile
 * host. Off by default; the key is never returned; a switched-on source must
 * have a usable https template and an attribution; the proxy refuses a
 * non-image, a redirect and a disabled source.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  stored: undefined as unknown,
  events: [] as Array<Record<string, any>>,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(async () => (h.stored === undefined ? null : { value: h.stored })),
      upsert: vi.fn(async ({ create }: { create: { value: unknown } }) => { h.stored = create.value; return create; }),
    },
  },
}));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => {
  resetEventLogStub();
  eventLog.logEvent.mockImplementation(async (e) => { h.events.push(e); return undefined; });
});

import {
  parseSatelliteSettings, urlTemplateProblem, buildTileUrl, mergeSatelliteSettings,
  getSatelliteSettings, getSatelliteStatus, saveSatelliteSettings, getSatelliteTile, testSatelliteSettings,
  _resetSatelliteForTests,
} from "../../src/services/satelliteTileService.js";

const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
const KEYED = "https://tiles.example.com/sat/{z}/{x}/{y}.jpg?token={key}";
const on = { enabled: true, urlTemplate: KEYED, apiToken: "s3cret", attribution: "Imagery © Example", maxNativeZoom: 19 };

const status = async (fn: () => Promise<unknown>): Promise<number | null> => {
  try { await fn(); return null; } catch (e) { return (e as { httpStatus?: number }).httpStatus ?? -1; }
};

function imageResponse(type = "image/jpeg", body = "JPEGDATA", status = 200): Response {
  return new Response(body, { status, headers: { "content-type": type } });
}

beforeEach(() => {
  h.stored = undefined;
  h.events = [];
  _resetSatelliteForTests();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("satellite settings", () => {
  it("is off by default and a bad row reads as off", async () => {
    expect((await getSatelliteStatus()).available).toBe(false);
    expect(parseSatelliteSettings("garbage")).toMatchObject({ enabled: false, maxNativeZoom: 19 });
    expect(parseSatelliteSettings({ enabled: "yes", maxNativeZoom: 99 })).toMatchObject({ enabled: false, maxNativeZoom: 19 });
  });

  it("checks the URL template", () => {
    expect(urlTemplateProblem(ESRI, false)).toBeNull();
    expect(urlTemplateProblem(KEYED, true)).toBeNull();
    expect(urlTemplateProblem(KEYED, false)).toMatch(/\{key\}/);
    expect(urlTemplateProblem("http://x.example.com/{z}/{x}/{y}", false)).toMatch(/https/);
    expect(urlTemplateProblem("https://x.example.com/{z}/{x}", false)).toMatch(/\{y\}/);
    expect(urlTemplateProblem("https://x.example.com/{z}/{x}/{y}/{s}", false)).toMatch(/unknown placeholder \{s\}/);
    expect(urlTemplateProblem("https://me:pw@x.example.com/{z}/{x}/{y}", false)).toMatch(/credentials/);
    expect(urlTemplateProblem("", false)).toMatch(/Enter/);
  });

  it("builds the tile address, URL-encoding the key", () => {
    expect(buildTileUrl({ urlTemplate: ESRI, apiToken: "" }, 5, 7, 9)).toBe(ESRI.replace("{z}/{y}/{x}", "5/9/7"));
    expect(buildTileUrl({ urlTemplate: KEYED, apiToken: "a b&c" }, 1, 0, 1)).toBe("https://tiles.example.com/sat/1/0/1.jpg?token=a%20b%26c");
  });

  it("an omitted key keeps the stored one; an empty one clears it", () => {
    const current = parseSatelliteSettings(on);
    expect(mergeSatelliteSettings(current, { ...on, apiToken: undefined }).apiToken).toBe("s3cret");
    expect(mergeSatelliteSettings(current, { ...on, urlTemplate: ESRI, apiToken: "" }).apiToken).toBe("");
  });

  it("a switched-on source needs a working template and an attribution; a switched-off one may be blank", () => {
    const blank = parseSatelliteSettings(undefined);
    expect(() => mergeSatelliteSettings(blank, { ...on, attribution: "" })).toThrow(/attribution/);
    expect(() => mergeSatelliteSettings(blank, { ...on, urlTemplate: "https://x/{z}" })).toThrow(/\{x\}/);
    expect(() => mergeSatelliteSettings(blank, { ...on, maxNativeZoom: 30 })).toThrow(/zoom/);
    expect(mergeSatelliteSettings(blank, { enabled: false, urlTemplate: "", attribution: "", maxNativeZoom: 19 }).enabled).toBe(false);
  });

  it("never returns the key, and audits a save without it", async () => {
    const view = await saveSatelliteSettings(on, "admin");
    expect(view).not.toHaveProperty("apiToken");
    expect(view.apiTokenSet).toBe(true);
    expect((await getSatelliteSettings()).apiTokenSet).toBe(true);
    expect(await getSatelliteStatus()).toEqual({ available: true, attribution: "Imagery © Example", maxNativeZoom: 19 });
    const ev = h.events.find((e) => e.action === "setting.satellite_updated")!;
    expect(ev.message).toMatch(/tiles\.example\.com/);
    expect(JSON.stringify(ev)).not.toContain("s3cret");
    expect(ev.details.apiTokenChanged).toBe(true);
  });
});

describe("satellite tile proxy", () => {
  it("404s while satellite imagery is not configured", async () => {
    expect(await status(() => getSatelliteTile(1, 0, 0))).toBe(404);
  });

  it("fetches with the key, refuses redirects, and caches per tile", async () => {
    await saveSatelliteSettings(on, "admin");
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const tile = await getSatelliteTile(3, 2, 1);
    expect(tile.contentType).toBe("image/jpeg");
    expect(tile.body.toString()).toBe("JPEGDATA");
    await getSatelliteTile(3, 2, 1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://tiles.example.com/sat/3/2/1.jpg?token=s3cret");
    expect(init.redirect).toBe("error");
  });

  it("a key changed on another process (no local save) misses the cache", async () => {
    await saveSatelliteSettings(on, "admin");
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    await getSatelliteTile(3, 2, 1);
    // Another role writes the row; this process sees it once the store's TTL lapses.
    h.stored = { ...on, apiToken: "rotated" };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 10 * 60_000);
    try {
      await getSatelliteTile(3, 2, 1);
      await getSatelliteTile(3, 2, 1);
    } finally { clock.mockRestore(); }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toBe("https://tiles.example.com/sat/3/2/1.jpg?token=rotated");
  });

  it("refuses out-of-range coordinates, a zoom past the source, a non-image and an upstream refusal", async () => {
    await saveSatelliteSettings({ ...on, maxNativeZoom: 18 }, "admin");
    expect(await status(() => getSatelliteTile(2, 4, 0))).toBe(400);
    expect(await status(() => getSatelliteTile(19, 0, 0))).toBe(400);
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("text/html", "<html>")));
    expect(await status(() => getSatelliteTile(1, 0, 0))).toBe(502);
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("image/svg+xml", "<svg/>")));
    expect(await status(() => getSatelliteTile(1, 1, 0))).toBe(502);
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("text/plain", "denied", 403)));
    await expect(getSatelliteTile(1, 1, 1)).rejects.toThrow(/API key/);
  });

  it("Test uses the values on screen with the stored key", async () => {
    await saveSatelliteSettings(on, "admin");
    const fetchMock = vi.fn(async () => imageResponse("image/png", "PNG"));
    vi.stubGlobal("fetch", fetchMock);
    const r = await testSatelliteSettings({ enabled: false, urlTemplate: "https://other.example.com/{z}/{x}/{y}?k={key}", attribution: "", maxNativeZoom: 19 });
    expect(r).toEqual({ ok: true, contentType: "image/png", bytes: 3 });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://other.example.com/1/0/0?k=s3cret");
  });
});
