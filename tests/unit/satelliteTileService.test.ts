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
  integrations: [] as Array<{ id: string; name: string; type: string; enabled: boolean; config: Record<string, unknown> }>,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    integration: {
      findMany: vi.fn(async ({ where }: { where: { type: string; enabled?: boolean; id?: { not: string } } }) =>
        h.integrations.filter((i) => i.type === where.type
          && (where.enabled === undefined || i.enabled === where.enabled)
          && (!where.id || i.id !== where.id.not))),
    },
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
  h.integrations = [];
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
    expect(await getSatelliteStatus()).toEqual({ available: true, attribution: "Imagery © Example", maxNativeZoom: 19, source: "custom" });
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

describe("the ArcGIS home (rule 183)", () => {
  const arcgisRow = (config: Record<string, unknown>, extra: Partial<{ id: string; name: string; enabled: boolean }> = {}) => ({
    id: extra.id ?? "ag-1", name: extra.name ?? "Corporate GIS", type: "arcgis", enabled: extra.enabled ?? true,
    config: { portalUrl: "https://www.arcgis.com", authMode: "none", basemapEnabled: true, basemapSource: "world_imagery", basemapMaxZoom: 19, ...config },
  });

  it("wins over the Customization setting, and says so on the settings view", async () => {
    await saveSatelliteSettings(on, "admin");
    h.integrations = [arcgisRow({})];
    _resetSatelliteForTests();
    h.stored = { ...on };
    const st = await getSatelliteStatus();
    expect(st).toMatchObject({ available: true, source: "arcgis", maxNativeZoom: 19 });
    expect(st.attribution).toMatch(/Esri/);
    expect((await getSatelliteSettings()).overriddenBy).toBe("Corporate GIS");

    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    await getSatelliteTile(3, 1, 2);
    // ArcGIS tiles are z / y / x, and no token goes to the public host.
    expect((fetchMock.mock.calls[0] as unknown as [string])[0])
      .toBe("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/3/2/1");
  });

  it("falls back to the setting when the integration is disabled or its basemap is off", async () => {
    await saveSatelliteSettings(on, "admin");
    h.integrations = [arcgisRow({}, { enabled: false }), arcgisRow({ basemapEnabled: false }, { id: "ag-2" })];
    _resetSatelliteForTests();
    h.stored = { ...on };
    expect(await getSatelliteStatus()).toMatchObject({ available: true, source: "custom" });
    expect((await getSatelliteSettings()).overriddenBy).toBeNull();
  });

  it("sends an API key to the keyed World Imagery host, and an app token to a portal service", async () => {
    h.integrations = [arcgisRow({ authMode: "apiKey", apiToken: "AAPK1" })];
    const fetchMock = vi.fn(async () => imageResponse());
    vi.stubGlobal("fetch", fetchMock);
    await getSatelliteTile(2, 1, 1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0])
      .toBe("https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/2/1/1?token=AAPK1");

    const { _setRequestImplForTests } = await import("../../src/services/arcgisService.js");
    _setRequestImplForTests(async () => ({ status: 200, body: JSON.stringify({ access_token: "app-tok", expires_in: 7200 }) }));
    try {
      h.integrations = [arcgisRow({
        authMode: "appCredentials", clientId: "c", clientSecret: "s",
        basemapSource: "service", imageryUrl: "https://tiles.example.com/arcgis/rest/services/Site_2026/MapServer",
        basemapAttribution: "Site imagery © Example", basemapMaxZoom: 21,
      })];
      _resetSatelliteForTests();
      expect(await getSatelliteStatus()).toMatchObject({ source: "arcgis", attribution: "Site imagery © Example", maxNativeZoom: 21 });
      await getSatelliteTile(20, 5, 7);
      expect((fetchMock.mock.calls[1] as unknown as [string])[0])
        .toBe("https://tiles.example.com/arcgis/rest/services/Site_2026/MapServer/tile/20/7/5?token=app-tok");
    } finally {
      _setRequestImplForTests(null);
    }
  });

  it("names the one integration that already supplies imagery, never the one being saved", async () => {
    const { arcgisBasemapOwner } = await import("../../src/services/satelliteTileService.js");
    h.integrations = [arcgisRow({}, { id: "ag-1", name: "A" }), arcgisRow({ basemapEnabled: false }, { id: "ag-2", name: "B" })];
    expect(await arcgisBasemapOwner()).toEqual({ id: "ag-1", name: "A" });
    expect(await arcgisBasemapOwner("ag-1")).toBeNull();
  });

  it("Test fetches one tile; a 404 still proves a regional service answers", async () => {
    const { testArcgisBasemap } = await import("../../src/services/satelliteTileService.js");
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("image/jpeg", "J".repeat(2048))));
    expect(await testArcgisBasemap({ authMode: "none", basemapEnabled: true })).toMatchObject({ ok: true, message: expect.stringMatching(/2 KB/) });
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("text/plain", "no", 404)));
    expect((await testArcgisBasemap({ authMode: "none", basemapEnabled: true })).ok).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => imageResponse("text/plain", "denied", 403)));
    expect((await testArcgisBasemap({ authMode: "none", basemapEnabled: true })).ok).toBe(false);
    expect(await testArcgisBasemap({ basemapSource: "service", imageryUrl: "https://x.example.com/foo" }))
      .toMatchObject({ ok: false, message: expect.stringMatching(/MapServer or \/ImageServer/) });
  });
});
