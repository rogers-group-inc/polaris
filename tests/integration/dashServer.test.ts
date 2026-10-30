/**
 * tests/integration/dashServer.test.ts
 *
 * The Dash wallboard listener's access-control chain, exercised via supertest
 * against buildDashApp() with injected settings/identity providers (no DB):
 *   - operator kill-switch: disabled ⇒ 403 everywhere
 *   - source-IP gate: loopback socket passes; an unauthorized source is
 *     DROPPED (socket destroyed → the request errors, no HTTP status)
 *   - ipScope "all" widens to any source; "custom" serves only allow-list CIDRs
 *   - GET/HEAD-only: writes 405 app-wide
 *   - exact-path API allowlist: unlisted paths 404 before touching a router
 *   - synthetic /auth/me: readonly-role identity in the real /auth/me shape
 *   - headers: CSP present, Cache-Control: no-store on API responses
 *
 * Everything above runs without a database. The one exception is the
 * /map/sites regression guard, which needs a real query to prove the gate lets
 * the request THROUGH — it is skipped when DATABASE_URL is unreachable.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { buildDashApp } from "../../src/dash/dashServer.js";
import type { DashSettings } from "../../src/services/dashSettingsService.js";
import type { DashRoleIdentity } from "../../src/services/dashRoleSnapshotService.js";
import { dbReachable } from "./_helpers.js";

const savedCert = process.env.POLARIS_PROXY_CERT_PATH;

beforeEach(() => {
  delete process.env.POLARIS_PROXY_CERT_PATH;
});

afterEach(() => {
  if (savedCert === undefined) delete process.env.POLARIS_PROXY_CERT_PATH;
  else process.env.POLARIS_PROXY_CERT_PATH = savedCert;
});

// Mirrors the seeded built-in `readonly` matrix for the keys the dash surface
// actually consults. deviceMap=read matters: the /map mount carries a
// deviceMap=read floor (same as the main router), and the Status Map / Device
// Map wallboard widgets fetch GET /map/sites through it.
const READONLY_IDENTITY: DashRoleIdentity = {
  snapshot: {
    id: "role-readonly-id",
    name: "readonly",
    isProtected: true,
    permissions: {
      assets: "read",
      events: "read",
      ipBlocks: "read",
      reservations: "read",
      deviceMap: "read",
      // Published dashboards: the wallboard's "load a public dashboard" menu
      // reads /saved-dashboards through the same floor.
      savedDashboards: "read",
    },
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  regionTags: [],
};

function buildApp(opts: { settings?: Partial<DashSettings>; proxyMode?: boolean } = {}) {
  if (opts.proxyMode) {
    // Must be set BEFORE buildDashApp so resolveTrustProxy() returns "1"
    // and X-Forwarded-For is honored for req.ip. Restored by afterEach.
    process.env.POLARIS_PROXY_CERT_PATH = "/tmp/proxy-mode-marker-file";
  }
  const settings: DashSettings = { enabled: true, ipScope: "rfc1918", allowedCidrs: [], ...opts.settings };
  return buildDashApp({
    settingsProvider: async () => settings,
    identityProvider: async () => READONLY_IDENTITY,
  });
}

// A dropped source destroys the socket with no HTTP response — supertest
// surfaces that as a rejected request (ECONNRESET / socket hang up), NOT a
// status code. Assert the GET rejects.
async function expectDropped(app: ReturnType<typeof buildApp>, path: string, headers: Record<string, string> = {}) {
  let req = request(app).get(path);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  await expect(req).rejects.toBeTruthy();
}

describe("operator kill-switch", () => {
  it("403s everything when disabled", async () => {
    const app = buildApp({ settings: { enabled: false } });
    for (const path of ["/dash", "/dash/api/v1/auth/me", "/js/api.js"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      expect(res.body.error ?? res.text).toMatch(/disabled/i);
    }
  });
});

describe("source-IP gate (rfc1918 default)", () => {
  it("passes the loopback test socket through", async () => {
    const res = await request(buildApp()).get("/dash/api/v1/auth/me");
    expect(res.status).toBe(200);
  });

  it("DROPS a public X-Forwarded-For under proxy-mode trust (no response)", async () => {
    await expectDropped(buildApp({ proxyMode: true }), "/dash/api/v1/auth/me", { "X-Forwarded-For": "203.0.113.5" });
  });

  it("honors a private X-Forwarded-For under proxy-mode trust → 200", async () => {
    const res = await request(buildApp({ proxyMode: true }))
      .get("/dash/api/v1/auth/me")
      .set("X-Forwarded-For", "192.168.4.20");
    expect(res.status).toBe(200);
  });

  it("ignores a spoofed X-Forwarded-For without trust proxy (socket IP wins) → 200", async () => {
    const res = await request(buildApp())
      .get("/dash/api/v1/auth/me")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(res.status).toBe(200);
  });
});

describe("source-IP gate — ipScope all", () => {
  it("serves any source when scope is 'all'", async () => {
    const res = await request(buildApp({ proxyMode: true, settings: { ipScope: "all" } }))
      .get("/dash/api/v1/auth/me")
      .set("X-Forwarded-For", "203.0.113.5");
    expect(res.status).toBe(200);
  });
});

describe("source-IP gate — ipScope custom", () => {
  const customApp = () => buildApp({ proxyMode: true, settings: { ipScope: "custom", allowedCidrs: ["203.0.113.0/24"] } });

  it("serves a source inside an allow-list CIDR → 200", async () => {
    const res = await request(customApp()).get("/dash/api/v1/auth/me").set("X-Forwarded-For", "203.0.113.42");
    expect(res.status).toBe(200);
  });

  it("DROPS a source outside every allow-list CIDR", async () => {
    await expectDropped(customApp(), "/dash/api/v1/auth/me", { "X-Forwarded-For": "198.51.100.7" });
  });
});

describe("read-only enforcement", () => {
  it("405s every write verb", async () => {
    const app = buildApp();
    for (const method of ["post", "put", "patch", "delete"] as const) {
      const res = await request(app)[method]("/dash/api/v1/dashboard/summary");
      expect(res.status).toBe(405);
      expect(res.body.error ?? res.text).toMatch(/read-only/i);
    }
  });
});

describe("API path allowlist", () => {
  it("404s paths outside the allowlist without reaching a router", async () => {
    const app = buildApp();
    for (const path of [
      "/dash/api/v1/reservations/some-id",
      "/dash/api/v1/reservations",
      "/dash/api/v1/assets",
      "/dash/api/v1/users",
      "/dash/api/v1/me/dashboard",
      "/dash/api/v1/server-settings/pg-tuning",
      "/dash/api/v1/map/regions",
      // Region geometry is readable at deviceMap:read on the MAIN listener so
      // the map's "Show regions" button works for any viewer — but the
      // unauthenticated wallboard cannot run the Device Map at all, so exposing
      // it here would be a pure attack-surface increase.
      "/dash/api/v1/map/region-overlay",
      // Only the topology graph itself is admitted (the Device Map widget's
      // single-gate / double-click view) — not the endpoint search beside it,
      // nor anything nested under it.
      "/dash/api/v1/map/sites/some-id/topology/search",
      "/dash/api/v1/map/sites/some-id/topology/layout",
      "/dash/api/v1/map/sites/a/b/topology",
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
    }
  });

  // Needs a DB: proving the gate lets the request through means letting the
  // handler run its query. Skipped rather than asserted loosely, because a
  // "not 403" that is really a timeout would pass for the wrong reason.
  it.skipIf(!dbReachable)(
    "still serves /map/sites, which the wallboard map widgets depend on",
    async () => {
      // Regression guard for the deviceMap=read floor added to both /map mounts:
      // the dash identity must satisfy it, or the Status Map and Device Map
      // widgets silently render empty on every wallboard.
      const res = await request(buildApp()).get("/dash/api/v1/map/sites");
      expect(res.status).toBe(200);
    },
    30_000,
  );

  // The allowlist lets /map/sites/:id/topology through to the real router:
  // an unknown id reaches buildSiteTopology, whose 404 names the FortiGate —
  // not the allowlist's bare "Not found".
  it.skipIf(!dbReachable)(
    "lets /map/sites/:id/topology through to the topology route",
    async () => {
      const res = await request(buildApp()).get("/dash/api/v1/map/sites/00000000-0000-0000-0000-000000000000/topology");
      expect(res.status).toBe(404);
      expect(res.body.error ?? res.text).toMatch(/FortiGate not found/i);
    },
    30_000,
  );
});

describe("synthetic /auth/me", () => {
  it("returns the readonly-role identity in the real /auth/me shape", async () => {
    const res = await request(buildApp()).get("/dash/api/v1/auth/me");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authenticated: true,
      username: "dash",
      authProvider: "local",
      role: {
        name: "readonly",
        isProtected: true,
        permissions: { assets: "read" },
        color: null,
      },
    });
    expect(res.body.regionTags).toEqual({ user: [], role: [], group: [], effective: [] });
    expect(res.body.otherTags).toEqual({ user: [], role: [], group: [], effective: [] });
  });
});

describe("headers", () => {
  it("sends the shared CSP and no-store on API responses", async () => {
    const res = await request(buildApp()).get("/dash/api/v1/auth/me");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("https://api.open-meteo.com");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("serves the wallboard page with no-store", async () => {
    const res = await request(buildApp()).get("/dash");
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["content-type"]).toContain("text/html");
  });
});
