/**
 * tests/unit/arcgisService.test.ts — the ArcGIS integration's client
 * (services/arcgisService.ts): portal URL checks, the four sign-in methods,
 * token caching, the REST error envelope, and the connection test. The HTTP
 * transport is replaced through `_setRequestImplForTests`; nothing leaves the
 * process.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  portalUrlProblem,
  portalBase,
  getArcgisToken,
  arcgisRequest,
  testConnection,
  clearArcgisTokenCache,
  ArcgisError,
  _setRequestImplForTests,
  type ArcgisHttpRequest,
} from "../../src/services/arcgisService.js";

let calls: ArcgisHttpRequest[] = [];
function serve(handler: (req: ArcgisHttpRequest) => { status?: number; json?: unknown; body?: string }) {
  calls = [];
  _setRequestImplForTests(async (req) => {
    calls.push(req);
    const r = handler(req);
    return { status: r.status ?? 200, body: r.body ?? JSON.stringify(r.json ?? {}) };
  });
}

beforeEach(() => clearArcgisTokenCache());
afterEach(() => _setRequestImplForTests(null));

describe("portal URL", () => {
  it("accepts an https portal and refuses everything else", () => {
    expect(portalUrlProblem("https://www.arcgis.com")).toBeNull();
    expect(portalUrlProblem("https://gis.example.com/portal")).toBeNull();
    expect(portalUrlProblem("http://gis.example.com/portal")).toMatch(/https/);
    expect(portalUrlProblem("gis.example.com")).toMatch(/full address/);
    expect(portalUrlProblem("https://u:p@gis.example.com")).toMatch(/user name or password/);
    expect(portalUrlProblem("https://gis.example.com/portal?x=1")).toMatch(/query/);
    expect(portalUrlProblem("https://127.0.0.1/portal")).toMatch(/blocked range/);
    expect(portalUrlProblem("https://169.254.169.254")).toMatch(/blocked range/);
  });

  it("defaults to ArcGIS Online and drops a trailing slash", () => {
    expect(portalBase({})).toBe("https://www.arcgis.com");
    expect(portalBase({ portalUrl: "https://gis.example.com/portal/" })).toBe("https://gis.example.com/portal");
  });
});

describe("sign-in", () => {
  it("none sends no token, and an API key is sent as-is", async () => {
    serve(() => ({ json: {} }));
    expect(await getArcgisToken({ authMode: "none" })).toBeNull();
    expect(await getArcgisToken({ authMode: "apiKey", apiToken: "AAPK123" })).toBe("AAPK123");
    await expect(getArcgisToken({ authMode: "apiKey" })).rejects.toThrow(/No API key/);
    expect(calls).toHaveLength(0);
  });

  it("app credentials are exchanged at the portal's oauth2 endpoint and cached", async () => {
    serve(() => ({ json: { access_token: "tok-1", expires_in: 7200 } }));
    const cfg = { authMode: "appCredentials" as const, portalUrl: "https://gis.example.com/portal", clientId: "cid", clientSecret: "sec" };
    expect(await getArcgisToken(cfg)).toBe("tok-1");
    expect(await getArcgisToken(cfg)).toBe("tok-1");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://gis.example.com/portal/sharing/rest/oauth2/token");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].form).toMatchObject({ client_id: "cid", client_secret: "sec", grant_type: "client_credentials", f: "json" });
  });

  it("a changed secret is not served from the cache", async () => {
    let n = 0;
    serve(() => ({ json: { access_token: `tok-${++n}`, expires_in: 7200 } }));
    const cfg = { authMode: "appCredentials" as const, clientId: "cid", clientSecret: "old" };
    expect(await getArcgisToken(cfg)).toBe("tok-1");
    expect(await getArcgisToken({ ...cfg, clientSecret: "new" })).toBe("tok-2");
  });

  it("a token about to expire is renewed", async () => {
    let n = 0;
    serve(() => ({ json: { access_token: `tok-${++n}`, expires_in: 30 } }));
    const cfg = { authMode: "appCredentials" as const, clientId: "cid", clientSecret: "s" };
    expect(await getArcgisToken(cfg)).toBe("tok-1");
    expect(await getArcgisToken(cfg)).toBe("tok-2");
  });

  it("a named user signs in through generateToken with the portal as referer", async () => {
    serve(() => ({ json: { token: "ut", expires: Date.now() + 3_600_000 } }));
    const cfg = { authMode: "userPassword" as const, portalUrl: "https://gis.example.com/portal", username: "svc", password: "pw" };
    expect(await getArcgisToken(cfg)).toBe("ut");
    expect(calls[0].url).toBe("https://gis.example.com/portal/sharing/rest/generateToken");
    expect(calls[0].form).toMatchObject({ username: "svc", password: "pw", client: "referer", referer: "https://gis.example.com/portal" });
  });

  it("refused credentials surface the portal's own message", async () => {
    serve(() => ({ json: { error: { code: 400, message: "Unable to generate token.", details: ["Invalid username or password."] } } }));
    await expect(getArcgisToken({ authMode: "userPassword", username: "u", password: "bad" }))
      .rejects.toThrow("Unable to generate token. (Invalid username or password.)");
  });
});

describe("arcgisRequest", () => {
  it("adds f=json and the token to a GET", async () => {
    serve(() => ({ json: { ok: 1 } }));
    await arcgisRequest({}, "https://services.example.com/arcgis/rest/services/X/FeatureServer/0", { token: "t" });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("f")).toBe("json");
    expect(u.searchParams.get("token")).toBe("t");
    expect(calls[0].verifySsl).toBe(true);
  });

  it("passes verifySsl false through for a private-certificate portal", async () => {
    serve(() => ({ json: {} }));
    await arcgisRequest({ verifySsl: false }, "https://gis.example.com/portal/sharing/rest/info");
    expect(calls[0].verifySsl).toBe(false);
  });

  it("turns an HTTP-200 error envelope, a bad status and a non-JSON body into ArcgisError", async () => {
    serve(() => ({ json: { error: { code: 498, message: "Invalid token." } } }));
    await expect(arcgisRequest({}, "https://x.example.com/a")).rejects.toMatchObject({ name: "ArcgisError", code: 498 });
    serve(() => ({ status: 503, json: {} }));
    await expect(arcgisRequest({}, "https://x.example.com/a")).rejects.toThrow(/HTTP 503/);
    serve(() => ({ body: "<html>login</html>" }));
    await expect(arcgisRequest({}, "https://x.example.com/a")).rejects.toThrow(/not JSON/);
  });

  it("names the host when the transport fails", async () => {
    _setRequestImplForTests(async () => { throw new Error("ECONNREFUSED"); });
    const err = await arcgisRequest({}, "https://gis.example.com/a").catch((e) => e);
    expect(err).toBeInstanceOf(ArcgisError);
    expect(err.message).toBe("Could not reach gis.example.com: ECONNREFUSED");
  });
});

describe("testConnection", () => {
  it("signs in and names the organisation", async () => {
    serve((req) => req.url.includes("/oauth2/token")
      ? { json: { access_token: "t", expires_in: 7200 } }
      : { json: { name: "Example GIS", currentVersion: "2024.3" } });
    const r = await testConnection({ authMode: "appCredentials", clientId: "c", clientSecret: "s" });
    expect(r).toEqual({ ok: true, message: "Signed in to Example GIS as an app", version: "2024.3" });
    expect(calls[1].url).toContain("https://www.arcgis.com/sharing/rest/portals/self");
  });

  it("without a sign-in, only checks that the portal answers", async () => {
    serve(() => ({ json: { fullVersion: "11.3" } }));
    const r = await testConnection({ authMode: "none" });
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/only public services/);
    expect(new URL(calls[0].url).pathname).toBe("/sharing/rest/info");
  });

  it("reports a failure instead of throwing", async () => {
    serve(() => ({ json: { error: { code: 498, message: "Invalid token." } } }));
    expect(await testConnection({ authMode: "apiKey", apiToken: "bad" })).toEqual({ ok: false, message: "Invalid token." });
    expect(await testConnection({ portalUrl: "http://gis.example.com" })).toMatchObject({ ok: false, message: expect.stringMatching(/https/) });
  });
});

describe("imagery (rule 183)", () => {
  it("accepts a cached MapServer / ImageServer over https and refuses the rest", async () => {
    const { imageryUrlProblem } = await import("../../src/services/arcgisService.js");
    expect(imageryUrlProblem("https://tiles.arcgis.com/tiles/abc/arcgis/rest/services/Site/MapServer")).toBeNull();
    expect(imageryUrlProblem("https://gis.example.com/server/rest/services/Ortho/ImageServer/")).toBeNull();
    expect(imageryUrlProblem("http://gis.example.com/server/rest/services/Ortho/ImageServer")).toMatch(/https/);
    expect(imageryUrlProblem("https://gis.example.com/server/rest/services/Ortho/FeatureServer")).toMatch(/MapServer or \/ImageServer/);
    expect(imageryUrlProblem("https://127.0.0.1/rest/services/X/MapServer")).toMatch(/blocked range/);
    expect(imageryUrlProblem("https://gis.example.com/X/MapServer?token=a")).toMatch(/query/);
  });

  it("picks the World Imagery host by sign-in, and orders tiles z / y / x", async () => {
    const { basemapTileUrl } = await import("../../src/services/arcgisService.js");
    expect(basemapTileUrl({ authMode: "none" }, null, 4, 3, 2))
      .toBe("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/4/2/3");
    expect(basemapTileUrl({ authMode: "appCredentials" }, "t", 4, 3, 2))
      .toBe("https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/4/2/3");
    expect(basemapTileUrl({ authMode: "apiKey", apiToken: "k" }, "k", 4, 3, 2))
      .toBe("https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/4/2/3?token=k");
    expect(basemapTileUrl({ authMode: "userPassword", basemapSource: "service", imageryUrl: "https://g.example.com/s/MapServer/" }, "a b", 1, 0, 0))
      .toBe("https://g.example.com/s/MapServer/tile/1/0/0?token=a%20b");
  });
});
