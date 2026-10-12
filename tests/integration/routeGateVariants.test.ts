/**
 * tests/integration/routeGateVariants.test.ts
 *
 * Express routes case-insensitively and ignores a trailing slash, so a gate that
 * runs before the router and compares req.path to exact lowercase strings is
 * skipped by `/API/V1/AUTH/LOGIN/`. Scan findings F166 (login source gate, API
 * docs gate) and F234 (the nginx /metrics allow-list is an exact match, so any
 * other spelling reached the app). Business rule 108.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { saveLoginAccessSettings, invalidateLoginAccessCache } from "../../src/services/loginAccessService.js";
import {
  saveApiDocsSettings,
  invalidateApiDocsSettingsCache,
} from "../../src/services/apiDocsAccessService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

/** Blocked: loopback is outside a custom list holding only a TEST-NET address. */
async function blockLoopbackLogin(): Promise<void> {
  await saveLoginAccessSettings({ enabled: true, ipScope: "custom", allowedCidrs: ["203.0.113.99/32"] });
  invalidateLoginAccessCache();
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await saveLoginAccessSettings({ enabled: false, ipScope: "rfc1918", allowedCidrs: [] });
  invalidateLoginAccessCache();
  await saveApiDocsSettings({ enabled: true, ipScope: "rfc1918", allowedCidrs: [] });
  invalidateApiDocsSettingsCache();
  await prisma.event.deleteMany({ where: { action: "auth.login.blocked_source" } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.event.deleteMany({ where: { action: "auth.login.blocked_source" } });
});

/**
 * A browser-like agent holding a CSRF cookie. The CSRF layer exempts the exact
 * lowercase login paths, so a differently-spelled POST must carry a token to get
 * as far as the gate under test — which is what an attacker would do.
 */
async function csrfAgent() {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  return { agent, csrf };
}

const LOGIN_VARIANTS = [
  "/api/v1/auth/login",
  "/api/v1/auth/login/",
  "/api/v1/auth/LOGIN",
  "/API/V1/AUTH/LOGIN/",
  "/Api/v1/Auth/Login",
  "/api/v1/auth/login//",
  "/api/v1/auth/login/TOTP",
  "/api/v1/auth/passkeys/login/",
  "/api/v1/auth/Passkeys/Login/Options",
];

d("local login source gate", () => {
  it.each(LOGIN_VARIANTS)("refuses a credential POST to %s from a source outside the scope", async (path) => {
    await blockLoopbackLogin();
    const { agent, csrf } = await csrfAgent();
    const res = await agent.post(path).set("X-CSRF-Token", csrf).send({ username: "nobody-route-variant", password: "wrong" });
    // The gate's own answer: the same generic 401 a wrong password gets, with a
    // blocked-source Event — not the handler's, which would have no such Event.
    expect(res.status).toBe(401);
    const blocked = await prisma.event.count({ where: { action: "auth.login.blocked_source" } });
    expect(blocked).toBe(1);
  });

  it.each(["/login.html", "/LOGIN.HTML"])("drops the page request for %s", async (path) => {
    await blockLoopbackLogin();
    await expect(request(app).get(path)).rejects.toBeTruthy();
  });

  it("still lets an in-scope source reach the handler by any spelling", async () => {
    await saveLoginAccessSettings({ enabled: true, ipScope: "rfc1918", allowedCidrs: [] });
    invalidateLoginAccessCache();
    const { agent, csrf } = await csrfAgent();
    const res = await agent.post("/api/v1/auth/LOGIN/").set("X-CSRF-Token", csrf).send({ username: "nobody-route-variant", password: "wrong" });
    expect(res.status).toBe(401);
    expect(await prisma.event.count({ where: { action: "auth.login.blocked_source" } })).toBe(0);
  });
});

d("API docs source gate", () => {
  it.each(["/api", "/api/", "/API", "/Api/", "/api.html", "/API.HTML", "/api.Html"])(
    "drops %s when the docs are switched off",
    async (path) => {
      await saveApiDocsSettings({ enabled: false });
      invalidateApiDocsSettingsCache();
      await expect(request(app).get(path)).rejects.toBeTruthy();
    },
  );

  it("leaves /api/v1 traffic alone", async () => {
    await saveApiDocsSettings({ enabled: false });
    invalidateApiDocsSettingsCache();
    const res = await request(app).get("/api/v1/auth/me");
    expect(res.status).toBe(200);
  });
});

d("/metrics spelling", () => {
  it("serves the exact path", async () => {
    const res = await request(app).get("/metrics");
    expect([200, 401]).toContain(res.status);
  });

  it.each(["/Metrics", "/METRICS", "/metrics/", "/Metrics/", "/metrics//", "/mEtRiCs"])(
    "answers %s as an unknown path, never with metrics",
    async (path) => {
      const res = await request(app).get(path);
      expect(res.status).toBe(404);
      expect(res.text).not.toMatch(/polaris_|process_cpu|nodejs_/);
    },
  );
});
