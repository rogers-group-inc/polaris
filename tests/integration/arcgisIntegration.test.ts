/**
 * tests/integration/arcgisIntegration.test.ts — the ArcGIS integration's
 * routes against a real database. Pins:
 *   - create defaults the portal to ArcGIS Online, derives `host` from it,
 *     forces autoDiscover off (nothing to discover) and seals the secret;
 *   - an edit that echoes the mask keeps the stored secret, a moved portal
 *     needs the secret typed again (rule 111), and the loose update schema
 *     cannot smuggle in a plain-http or blocked portal;
 *   - Discover is refused.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.hoisted(() => { process.env.POLARIS_SECRET_KEY ||= "ab".repeat(32); });

import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
const NAME = "IT arcgis";
const SECRET = "app-secret-7d1f0b";

async function cleanup(): Promise<void> {
  await prisma.integration.deleteMany({ where: { name: { startsWith: NAME } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
});
afterAll(async () => { if (dbReachable) await cleanup(); });

d("ArcGIS integration routes", () => {
  it("creates one with ArcGIS Online as the portal, autoDiscover off and the secret sealed", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({
      type: "arcgis", name: NAME, autoDiscover: true,
      config: { authMode: "appCredentials", clientId: "cid-1", clientSecret: SECRET },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.id as string;
    expect(created.body.autoDiscover).toBe(false);
    expect(created.body.config.portalUrl).toBe("https://www.arcgis.com");
    expect(created.body.config.host).toBe("www.arcgis.com");
    expect(created.body.config.clientSecret).not.toBe(SECRET);

    const row = await prisma.$queryRaw<Array<{ config: Record<string, unknown> }>>`SELECT config FROM integrations WHERE id = ${id}`;
    expect(row[0]!.config.clientSecret).not.toBe(SECRET);

    // Echoing the mask back keeps the secret; autoDiscover stays off.
    const got = await agent.get(`/api/v1/integrations/${id}`);
    const put = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ autoDiscover: true, config: { ...got.body.config, clientId: "cid-2" } });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const kept = await prisma.integration.findUnique({ where: { id }, select: { config: true, autoDiscover: true } });
    expect((kept!.config as Record<string, unknown>).clientSecret).toBe(SECRET);
    expect((kept!.config as Record<string, unknown>).clientId).toBe("cid-2");
    expect(kept!.autoDiscover).toBe(false);

    // A new portal is a new destination: the stored secret does not follow it.
    const moved = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { ...got.body.config, portalUrl: "https://gis.example.com/portal" } });
    expect(moved.status).toBe(400);
    expect(JSON.stringify(moved.body)).toMatch(/portalUrl/);

    // The merged config is re-validated: no plain http, no blocked host.
    const http = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { portalUrl: "http://gis.example.com/portal", clientSecret: "x" } });
    expect(http.status).toBe(400);
    const blocked = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { portalUrl: "https://169.254.169.254", clientSecret: "x" } });
    expect(blocked.status).toBe(400);

    // A moved portal WITH the secret typed again is accepted, and host follows.
    const ok = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: { portalUrl: "https://gis.example.com/portal/", clientSecret: "new-secret" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await prisma.integration.findUnique({ where: { id }, select: { config: true } });
    const cfg = after!.config as Record<string, unknown>;
    expect(cfg.portalUrl).toBe("https://gis.example.com/portal");
    expect(cfg.host).toBe("gis.example.com");
    expect(cfg.clientSecret).toBe("new-secret");
  });

  it("refuses an app-credentials sign-in with no client ID, and refuses Discover", async () => {
    const { agent, csrf } = await authedAgent(app);
    const bad = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({
      type: "arcgis", name: `${NAME} bad`, config: { authMode: "appCredentials" },
    });
    expect(bad.status).toBe(400);

    const created = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({
      type: "arcgis", name: `${NAME} public`, config: { authMode: "none" },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await prisma.integration.update({ where: { id: created.body.id }, data: { lastTestOk: true } });
    const disc = await agent.post(`/api/v1/integrations/${created.body.id}/discover`).set("X-CSRF-Token", csrf).send({});
    expect(disc.status).toBe(400);
  });
  it("lets only one ArcGIS integration supply satellite imagery, and checks the imagery service (rule 183)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const first = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({
      type: "arcgis", name: `${NAME} imagery A`, config: { authMode: "none", basemapEnabled: true },
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const second = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({
      type: "arcgis", name: `${NAME} imagery B`, config: { authMode: "none", basemapEnabled: true },
    });
    expect(second.status).toBe(409);
    expect(second.body.error ?? JSON.stringify(second.body)).toMatch(/imagery A/);

    // Off is fine; turning it on while A still supplies imagery is refused.
    const off = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf).send({
      type: "arcgis", name: `${NAME} imagery B`, config: { authMode: "apiKey", apiToken: "AAPK-x", basemapEnabled: false },
    });
    expect(off.status, JSON.stringify(off.body)).toBe(201);
    const turnOn = await agent.put(`/api/v1/integrations/${off.body.id}`).set("X-CSRF-Token", csrf)
      .send({ config: { basemapEnabled: true } });
    expect(turnOn.status).toBe(409);

    // A portal imagery service must be a MapServer / ImageServer and needs an attribution.
    const badSvc = await agent.put(`/api/v1/integrations/${off.body.id}`).set("X-CSRF-Token", csrf)
      .send({ config: { basemapSource: "service", imageryUrl: "https://tiles.example.com/x/FeatureServer", apiToken: "AAPK-x" } });
    expect(badSvc.status).toBe(400);

    // The token goes to the imagery service, so moving it needs the key typed again (rule 111).
    const svc = await agent.put(`/api/v1/integrations/${off.body.id}`).set("X-CSRF-Token", csrf)
      .send({ config: { basemapSource: "service", imageryUrl: "https://tiles.example.com/x/MapServer", apiToken: "AAPK-x" } });
    expect(svc.status, JSON.stringify(svc.body)).toBe(200);
    const got = await agent.get(`/api/v1/integrations/${off.body.id}`);
    const moved = await agent.put(`/api/v1/integrations/${off.body.id}`).set("X-CSRF-Token", csrf)
      .send({ config: { ...got.body.config, imageryUrl: "https://elsewhere.example.com/y/MapServer" } });
    expect(moved.status).toBe(400);

    // The map status names the ArcGIS home while A supplies the imagery.
    const st = await agent.get("/api/v1/map/satellite");
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ available: true, source: "arcgis" });
  });
});
