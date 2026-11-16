/**
 * tests/integration/cableRuns.test.ts — ArcGIS layers read only on the Device
 * Map (business rule 188) and connections routed through ArcGIS lines (188(a))
 * against a real database, with a fake ArcGIS behind arcgisService's seam:
 * the layer list hides URLs and tokens, features come back for a bbox and by
 * id, a view saves its ticked layers, routed links keep only references to a
 * configured line layer, and the gates (deviceMap read to see, deviceMap
 * write to route; no cableRuns key any more).
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { FUNCTION_KEYS } from "../../src/api/middleware/permissions.js";
import { _setRequestImplForTests, type ArcgisHttpRequest } from "../../src/services/arcgisService.js";
import { clearFeatureCache } from "../../src/services/arcgisLayerService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const PFX = "arcgis-layers-test";
const PASSWORD = "arcgis-layers-password-not-real";
const LINE_ID = "6d1f3a52-7c1e-4d4b-9a0e-2f5b8c9d0e11";
const POINT_ID = "0b9e2f7c-5a41-4c3d-8e6f-1a2b3c4d5e6f";
const LINE_URL = "https://services.example-gis.test/arcgis/rest/services/Fiber/FeatureServer/0";
const POINT_URL = "https://services.example-gis.test/arcgis/rest/services/Fiber/FeatureServer/1";
let siteId = "";
let integrationId = "";
let viewId = "";
const calls: ArcgisHttpRequest[] = [];

// Synthetic features only — never real survey coordinates.
const FEATURES = [
  { attributes: { GlobalID: "{AAAA-1}", ROUTE_NAME: "TRUNK-A", FIBER_COUNT: 48 }, geometry: { paths: [[[-85.70011, 37.98012], [-85.70021, 37.98112]]] } },
  { attributes: { GlobalID: "{AAAA-2}", ROUTE_NAME: "TRUNK-B", FIBER_COUNT: 24 }, geometry: { paths: [[[-85.70121, 37.98012], [-85.70221, 37.98112]]] } },
];

function fakeArcgis(req: ArcgisHttpRequest): Promise<{ status: number; body: string }> {
  calls.push(req);
  const u = new URL(req.url);
  const where = req.form?.where ?? u.searchParams.get("where") ?? "";
  if (u.pathname.endsWith("/FeatureServer/0/query")) {
    const feats = where.includes("IN (") ? FEATURES.filter((f) => where.includes(`'${f.attributes.GlobalID}'`)) : FEATURES;
    return Promise.resolve({ status: 200, body: JSON.stringify({ features: feats }) });
  }
  if (u.pathname.endsWith("/FeatureServer/1/query")) {
    return Promise.resolve({ status: 200, body: JSON.stringify({ features: [{ attributes: { OBJECTID: 7 }, geometry: { x: -85.7, y: 37.98 } }] }) });
  }
  return Promise.resolve({ status: 200, body: JSON.stringify({ error: { code: 400, message: `unexpected ${u.pathname}` } }) });
}

async function makeUser(suffix: string, perms: Record<string, string>): Promise<void> {
  const matrix: Record<string, string> = {};
  for (const { key } of FUNCTION_KEYS) matrix[key] = "none";
  Object.assign(matrix, perms);
  const role = await prisma.role.create({ data: { name: `${PFX}-role-${suffix}`, permissions: matrix } });
  await prisma.user.create({
    data: { username: `${PFX}-user-${suffix}`, passwordHash: await hashPassword(PASSWORD), roleId: role.id, authProvider: "local" },
  });
}

async function loginAs(suffix: string): Promise<{ agent: request.Agent; csrf: string }> {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const login = await agent.post("/api/v1/auth/login")
    .send({ username: `${PFX}-user-${suffix}`, password: PASSWORD }).set("Content-Type", "application/json");
  expect(login.status).toBe(200);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  return { agent, csrf };
}

/** The test admin: GET / PUT with the session's CSRF token. */
async function admin(): Promise<{ get: (u: string) => request.Test; put: (u: string, b: unknown) => request.Test }> {
  const { agent, csrf } = await authedAgent(app);
  return {
    get: (u) => agent.get(u),
    put: (u, b) => agent.put(u).set("x-csrf-token", csrf).send(b as object),
  };
}

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PFX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PFX } } });
  await prisma.user.deleteMany({ where: { username: { startsWith: PFX } } });
  await prisma.role.deleteMany({ where: { name: { startsWith: PFX } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
  _setRequestImplForTests(fakeArcgis);
  clearFeatureCache();
  const fg = await prisma.asset.create({ data: { hostname: `${PFX}-fg`, assetType: "firewall", status: "active" } });
  siteId = fg.id;
  const integ = await prisma.integration.create({
    data: {
      type: "arcgis", name: `${PFX}-gis`, enabled: true, autoDiscover: false,
      config: {
        portalUrl: "https://gis.example-gis.test/portal", authMode: "none", host: "gis.example-gis.test",
        layers: [
          { id: LINE_ID, url: LINE_URL, itemId: "0123456789abcdef0123456789abcdef", title: "Fiber Routes", geometry: "line", idField: "GlobalID",
            labelField: "ROUTE_NAME", popupFields: [{ name: "FIBER_COUNT", alias: "Fibers" }], where: "STATUS = 'In service'",
            style: { color: "accent", width: 3, dash: "solid" } },
          { id: POINT_ID, url: POINT_URL, title: "Handholes", geometry: "point", idField: "OBJECTID", popupFields: [],
            style: { color: "green", width: 3, dash: "solid" } },
        ],
      },
    },
  });
  integrationId = integ.id;
  const view = await prisma.topologyView.create({ data: { siteId, name: `${PFX}-view`, mode: "topology" } });
  viewId = view.id;
  await makeUser("viewer", { deviceMap: "read" });
});

afterAll(async () => {
  _setRequestImplForTests(null);
  if (!dbReachable) return;
  await cleanup();
});

d("ArcGIS layers on the Device Map (rule 188)", () => {
  it("the catalogue has no cableRuns key any more", () => {
    expect(FUNCTION_KEYS.map((k) => k.key)).not.toContain("cableRuns");
  });

  it("lists the configured layers without their URLs, filters or tokens", async () => {
    const { agent } = await loginAs("viewer");
    const res = await agent.get("/api/v1/map/arcgis-layers");
    expect(res.status).toBe(200);
    const mine = res.body.layers.filter((l: { id: string }) => l.id === LINE_ID || l.id === POINT_ID);
    expect(mine).toHaveLength(2);
    const line = mine.find((l: { id: string }) => l.id === LINE_ID);
    expect(line).toMatchObject({ title: "Fiber Routes", geometry: "line", labelField: "ROUTE_NAME" });
    expect(line.itemUrl).toBe("https://gis.example-gis.test/portal/home/item.html?id=0123456789abcdef0123456789abcdef");
    expect(JSON.stringify(res.body)).not.toContain("FeatureServer");
    expect(line).not.toHaveProperty("where");
  });

  it("answers the features in a bbox, with the layer's filter, label and fields", async () => {
    clearFeatureCache();
    calls.length = 0;
    const { agent } = await loginAs("viewer");
    const res = await agent.get(`/api/v1/map/arcgis-layers/${LINE_ID}/features`).query({ bbox: "-85.71,37.97,-85.69,37.99", zoom: "17" });
    expect(res.status).toBe(200);
    expect(res.body.features.map((f: { id: string }) => f.id)).toEqual(["{AAAA-1}", "{AAAA-2}"]);
    expect(res.body.features[0]).toMatchObject({ label: "TRUNK-A", attrs: { FIBER_COUNT: 48 } });
    expect(res.body.features[0].g[0][0]).toEqual([-85.70011, 37.98012]);
    const q = new URL(calls[0].url);
    expect(q.searchParams.get("where")).toBe("STATUS = 'In service'");
    expect(q.searchParams.get("outSR")).toBe("4326");
    expect(q.searchParams.get("outFields")!.split(",").sort()).toEqual(["FIBER_COUNT", "GlobalID", "ROUTE_NAME"]);
    expect(q.searchParams.get("token")).toBeNull();
  });

  it("answers features by identity value for a routed line outside the view", async () => {
    clearFeatureCache();
    const { agent } = await loginAs("viewer");
    const res = await agent.get(`/api/v1/map/arcgis-layers/${LINE_ID}/features`).query({ ids: "{AAAA-2}" });
    expect(res.status).toBe(200);
    expect(res.body.features.map((f: { id: string }) => f.id)).toEqual(["{AAAA-2}"]);
  });

  it("refuses a bad bbox and an unknown layer", async () => {
    const { agent } = await loginAs("viewer");
    expect((await agent.get(`/api/v1/map/arcgis-layers/${LINE_ID}/features`).query({ bbox: "1,2,3" })).status).toBe(400);
    expect((await agent.get("/api/v1/map/arcgis-layers/11111111-2222-4333-8444-555555555555/features").query({ bbox: "0,0,1,1" })).status).toBe(404);
  });

  it("a view saves the layers it draws; a new view draws none", async () => {
    const agent = await admin();
    const before = await prisma.topologyView.findUniqueOrThrow({ where: { id: viewId } });
    expect(before.arcgisLayers).toEqual([]);
    const res = await agent.put(`/api/v1/map/sites/${siteId}/topology/views/${viewId}`, { arcgisLayers: [LINE_ID.toUpperCase(), LINE_ID] });
    expect(res.status).toBe(200);
    expect(res.body.view.arcgisLayers).toEqual([LINE_ID]);
    expect((await agent.put(`/api/v1/map/sites/${siteId}/topology/views/${viewId}`, { arcgisLayers: ["not-a-uuid"] })).status).toBe(400);
  });
});

d("connections routed through ArcGIS lines (rule 188(a))", () => {
  const KEY = "iface|a1|b2";

  it("keeps references to a configured LINE layer and drops the rest", async () => {
    const agent = await admin();
    const res = await agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`, {
      links: { [KEY]: [`${LINE_ID}/{AAAA-1}`, `${POINT_ID}/7`, "11111111-2222-4333-8444-555555555555/x", `${LINE_ID}/{AAAA-2}`] },
    });
    expect(res.status).toBe(200);
    expect(res.body.links[KEY]).toEqual([`${LINE_ID}/{AAAA-1}`, `${LINE_ID}/{AAAA-2}`]);
    const read = await agent.get(`/api/v1/map/sites/${siteId}/cable-run-links`);
    expect(read.body.links[KEY]).toHaveLength(2);
    const ev = await prisma.event.findFirst({ where: { action: "cable_run_link.updated", resourceId: siteId }, orderBy: { timestamp: "desc" } });
    expect(ev).toBeTruthy();
  });

  it("refuses a malformed reference and a malformed link key", async () => {
    const agent = await admin();
    expect((await agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`, { links: { [KEY]: ["not a ref"] } })).status).toBe(400);
    expect((await agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`, { links: { "no-pipes": [] } })).status).toBe(400);
  });

  it("an empty list makes the link straight again", async () => {
    const agent = await admin();
    const res = await agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`, { links: { [KEY]: [] } });
    expect(res.status).toBe(200);
    expect(res.body.links[KEY]).toBeUndefined();
  });

  it("deviceMap read sees routes but cannot change them", async () => {
    const { agent, csrf } = await loginAs("viewer");
    expect((await agent.get(`/api/v1/map/sites/${siteId}/cable-run-links`)).status).toBe(200);
    const put = await agent.put(`/api/v1/map/sites/${siteId}/cable-run-links`).set("x-csrf-token", csrf).send({ links: {} });
    expect(put.status).toBe(403);
  });

  it("the old run routes are gone", async () => {
    const agent = await admin();
    expect((await agent.get(`/api/v1/map/sites/${siteId}/cable-runs`)).status).toBe(404);
    expect((await agent.get(`/api/v1/integrations/${integrationId}/arcgis/write-back`)).status).toBe(404);
  });
});
