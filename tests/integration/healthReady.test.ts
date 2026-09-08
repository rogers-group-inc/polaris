/**
 * tests/integration/healthReady.test.ts — /health/ready over the real app.
 *
 * This is the endpoint a load balancer monitors in the active/standby topology
 * (docs/HA.md), so the contract worth pinning end-to-end is: 200 only on a
 * writable primary, the HEALTH_TOKEN gate applies to readiness exactly as it
 * does to liveness, the answer is never cacheable, and adding readiness did
 * not change what /health has always returned.
 *
 * The test database is a normal primary, so the ready path is what runs here;
 * the in-recovery / db-error / timeout branches are unit-level
 * (readinessCheck.test.ts), since a standby cannot be conjured in CI.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

const savedToken = process.env.HEALTH_TOKEN;

beforeAll(() => {
  delete process.env.HEALTH_TOKEN;
});

afterAll(() => {
  if (savedToken === undefined) delete process.env.HEALTH_TOKEN;
  else process.env.HEALTH_TOKEN = savedToken;
});

d("GET /health/ready", () => {
  it("reports ready against a writable primary", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready" });
  });

  it("is never cached — a stale 200 is the one answer that must not be reused", async () => {
    const res = await request(app).get("/health/ready");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("honours HEALTH_TOKEN: 401 without the bearer, 200 with it", async () => {
    process.env.HEALTH_TOKEN = "ready-token-for-tests";
    try {
      const denied = await request(app).get("/health/ready");
      expect(denied.status).toBe(401);
      expect(denied.body).toEqual({ error: "Unauthorized" });

      const wrong = await request(app)
        .get("/health/ready")
        .set("Authorization", "Bearer not-the-token");
      expect(wrong.status).toBe(401);

      const allowed = await request(app)
        .get("/health/ready")
        .set("Authorization", "Bearer ready-token-for-tests");
      expect(allowed.status).toBe(200);
      expect(allowed.body).toEqual({ status: "ready" });
    } finally {
      delete process.env.HEALTH_TOKEN;
    }
  });
});

d("GET /health (unchanged by the readiness split)", () => {
  it("still answers 200 ok with no token configured", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("still gates on HEALTH_TOKEN when one is set", async () => {
    process.env.HEALTH_TOKEN = "liveness-token-for-tests";
    try {
      expect((await request(app).get("/health")).status).toBe(401);
      const ok = await request(app)
        .get("/health")
        .set("Authorization", "Bearer liveness-token-for-tests");
      expect(ok.status).toBe(200);
    } finally {
      delete process.env.HEALTH_TOKEN;
    }
  });

  it("answers even though liveness deliberately checks nothing", async () => {
    // Guard against someone "improving" /health with a DB check later: the
    // setup wizard polls it before a database exists.
    expect(dbReachable).toBe(true);
    const res = await request(app).get("/health");
    expect(res.body.status).toBe("ok");
  });
});
