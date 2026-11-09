/**
 * tests/integration/monitorSettings.test.ts
 *
 * Integration coverage for the polling-method redesign — the four-tier
 * monitor-settings hierarchy (per-asset → class override → integration tier
 * or manual tier → source default) plus the compatibility matrix.
 *
 * Requires a running PostgreSQL pointed to by DATABASE_URL. Spin one up
 * with `docker compose up -d db`, or run against the dev DB.
 *
 * The tests share a single Express agent per `describe` block so cookies
 * (session + CSRF token) persist across requests; per-test cleanup wipes
 * the rows the suite touches without nuking the user account.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbReachable, dbDescribe, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;
let TEST_USERNAME = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  ({ username: TEST_USERNAME } = await ensureTestUser());
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Clean state for the polling-redesign surface area. Order matters for FKs:
  // class overrides reference Integration; assets reference Integration;
  // events / settings stand alone.
  await prisma.monitorClassOverride.deleteMany();
  await prisma.assetMonitorSample.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.setting.deleteMany({
    where: { key: { in: ["manualMonitorSettings", "monitorSettings", "monitorSettingsHierarchyMigratedAt"] } },
  });
  await prisma.event.deleteMany({
    where: { action: { startsWith: "monitor_settings." } },
  });
});

// ─── Test helpers ──────────────────────────────────────────────────────────

/**
 * Default tier-3 settings that satisfy TierSettingsSchema in
 * src/api/routes/monitorSettings.ts. Tests spread overrides on top.
 */
function defaultTierSettings(): Record<string, unknown> {
  return {
    intervalSeconds:            60,
    failureThreshold:           3,
    probeTimeoutMs:             5000,
    // The telemetry stream split into cpuMemory + temperature; both interval
    // fields are now required by TierSettingsSchema.
    cpuMemoryIntervalSeconds:   60,
    temperatureIntervalSeconds: 60,
    systemInfoIntervalSeconds:  600,
    // Retention moved to Setting("sampleRetention") — these keys are still
    // tolerated on input (and dropped before persistence), so keep sending
    // them to exercise that path.
    sampleRetentionDays:        30,
    telemetryRetentionDays:     30,
    systemInfoRetentionDays:    30,
  };
}

// ─── Manual tier ───────────────────────────────────────────────────────────

d("PUT /api/v1/monitor-settings/manual", () => {
  it("upserts the manual tier (including polling fields) and returns the saved values", async () => {
    const { agent, csrf } = await authedAgent(app);
    const body = {
      ...defaultTierSettings(),
      responseTimePolling: "snmp",
      cpuMemoryPolling:    null,
      interfacesPolling:   "winrm",
      lldpPolling:         null,
    };
    const resp = await agent
      .put("/api/v1/monitor-settings/manual")
      .set("X-CSRF-Token", csrf)
      .send(body);
    expect(resp.status).toBe(200);
    expect(resp.body.responseTimePolling).toBe("snmp");
    expect(resp.body.interfacesPolling).toBe("winrm");
    // Re-read via GET to confirm the Setting row landed.
    const after = await agent.get("/api/v1/monitor-settings/manual");
    expect(after.status).toBe(200);
    expect(after.body.responseTimePolling).toBe("snmp");
    expect(after.body.interfacesPolling).toBe("winrm");
  });

  it("rejects probeTimeoutMs below 100 with a 400", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .put("/api/v1/monitor-settings/manual")
      .set("X-CSRF-Token", csrf)
      .send({ ...defaultTierSettings(), probeTimeoutMs: 50 });
    expect(resp.status).toBe(400);
  });

  it("emits a monitor_settings.manual.updated audit Event", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent
      .put("/api/v1/monitor-settings/manual")
      .set("X-CSRF-Token", csrf)
      .send(defaultTierSettings());
    const events = await prisma.event.findMany({
      where: { action: "monitor_settings.manual.updated" },
    });
    expect(events.length).toBe(1);
    expect(events[0].actor).toBe(TEST_USERNAME);
  });
});

// ─── Integration tier (compatibility-aware) ────────────────────────────────

d("PUT /api/v1/monitor-settings/integration/:id", () => {
  it("rejects WinRM polling on a FortiManager integration with a 400", async () => {
    const { agent, csrf } = await authedAgent(app);
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const resp = await agent
      .put(`/api/v1/monitor-settings/integration/${integ.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ ...defaultTierSettings(), responseTimePolling: "winrm" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/winrm/i);
    expect(String(resp.body?.error || "")).toMatch(/fortimanager/i);
  });

  it("accepts SNMP polling on a FortiManager integration and writes monitorSettings", async () => {
    const { agent, csrf } = await authedAgent(app);
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: { useProxy: true } },
    });
    const resp = await agent
      .put(`/api/v1/monitor-settings/integration/${integ.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ ...defaultTierSettings(), cpuMemoryPolling: "snmp" });
    expect(resp.status).toBe(200);
    const fresh = await prisma.integration.findUnique({ where: { id: integ.id } });
    const cfg = fresh!.config as Record<string, unknown>;
    expect((cfg.monitorSettings as any).cpuMemoryPolling).toBe("snmp");
    // Existing config keys are preserved.
    expect(cfg.useProxy).toBe(true);
  });

  it("rejects REST API polling on an Active Directory integration", async () => {
    const { agent, csrf } = await authedAgent(app);
    const integ = await prisma.integration.create({
      data: { type: "activedirectory", name: "AD-test", config: {} },
    });
    const resp = await agent
      .put(`/api/v1/monitor-settings/integration/${integ.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ ...defaultTierSettings(), responseTimePolling: "rest_api" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/rest api/i);
  });
});

// ─── Class overrides (compatibility-aware) ─────────────────────────────────

d("POST /api/v1/monitor-settings/class-overrides", () => {
  it("creates a manual-scope override accepting any polling method (winrm)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const resp = await agent
      .post("/api/v1/monitor-settings/class-overrides")
      .set("X-CSRF-Token", csrf)
      .send({
        integrationId: null,
        assetType:     "workstation",
        responseTimePolling: "winrm",
      });
    expect(resp.status).toBe(201);
    expect(resp.body.responseTimePolling).toBe("winrm");
    expect(resp.body.integrationId).toBeNull();
  });

  it("rejects WinRM on an integration-scoped override when the integration is FortiManager", async () => {
    const { agent, csrf } = await authedAgent(app);
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const resp = await agent
      .post("/api/v1/monitor-settings/class-overrides")
      .set("X-CSRF-Token", csrf)
      .send({
        integrationId: integ.id,
        assetType:     "firewall",
        responseTimePolling: "winrm",
      });
    expect(resp.status).toBe(400);
  });

  it("returns 409 when an override for (integrationId, assetType) already exists", async () => {
    const { agent, csrf } = await authedAgent(app);
    await prisma.monitorClassOverride.create({
      data: { integrationId: null, assetType: "switch" },
    });
    const resp = await agent
      .post("/api/v1/monitor-settings/class-overrides")
      .set("X-CSRF-Token", csrf)
      .send({ integrationId: null, assetType: "switch" });
    expect(resp.status).toBe(409);
  });
});

// ─── Per-asset polling overrides ───────────────────────────────────────────

d("PUT /api/v1/assets/:id (polling fields)", () => {
  it("rejects WinRM polling on a FortiManager-discovered asset with a 400", async () => {
    const { agent, csrf } = await authedAgent(app);
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const asset = await prisma.asset.create({
      data: {
        hostname:                  "test-fw",
        assetType:                 "firewall",
        manufacturer:              "Fortinet",
        discoveredByIntegrationId: integ.id,
      },
    });
    const resp = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ responseTimePolling: "winrm" });
    expect(resp.status).toBe(400);
    expect(String(resp.body?.error || "")).toMatch(/winrm/i);
  });

  it("accepts SNMP polling on a FortiManager-discovered asset", async () => {
    const { agent, csrf } = await authedAgent(app);
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const asset = await prisma.asset.create({
      data: {
        hostname:                  "test-fw",
        assetType:                 "firewall",
        manufacturer:              "Fortinet",
        discoveredByIntegrationId: integ.id,
      },
    });
    const resp = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ cpuMemoryPolling: "snmp" });
    expect(resp.status).toBe(200);
    const fresh = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(fresh!.cpuMemoryPolling).toBe("snmp");
  });

  it("recomputes monitorOverride after a PUT that includes the monitored field — no integration link → stays false", async () => {
    const { agent, csrf } = await authedAgent(app);
    const asset = await prisma.asset.create({
      data: { hostname: "test-host", assetType: "server", monitorOverride: false },
    });
    const resp = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ monitored: true });
    expect(resp.status).toBe(200);
    const fresh = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(fresh!.monitored).toBe(true);
    // No discoveredByIntegrationId → recompute helper's WHERE clause skips
    // this asset and monitorOverride stays at its existing value (false).
    expect(fresh!.monitorOverride).toBe(false);
  });

  it("leaves monitorOverride alone when the PUT body omits monitored", async () => {
    const { agent, csrf } = await authedAgent(app);
    const asset = await prisma.asset.create({
      data: { hostname: "test-host", assetType: "server", monitorOverride: false },
    });
    const resp = await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ notes: "just touching notes" });
    expect(resp.status).toBe(200);
    const fresh = await prisma.asset.findUnique({ where: { id: asset.id } });
    expect(fresh!.monitorOverride).toBe(false);
  });
});

// ─── Effective settings + provenance resolver ──────────────────────────────

d("GET /api/v1/assets/:id/effective-monitor-settings", () => {
  it("returns the runtime source defaults for an asset under the manual tier with no overrides", async () => {
    const { agent } = await authedAgent(app);
    const asset = await prisma.asset.create({
      data: { hostname: "manual-host", assetType: "server" },
    });
    const resp = await agent.get(`/api/v1/assets/${asset.id}/effective-monitor-settings`);
    expect(resp.status).toBe(200);
    // Since the 2026-08 resolver fold, the provenance endpoint reports the
    // MATERIALIZED runtime resolution: when no tier sets a method, resolved
    // carries the source default (manual → icmp for response-time, null for
    // telemetry) labeled "default".
    expect(resp.body.resolved.responseTimePolling).toBe("icmp");
    expect(resp.body.provenance.responseTimePolling).toBe("default");
    expect(resp.body.resolved.cpuMemoryPolling).toBeNull();
    expect(resp.body.provenance.cpuMemoryPolling).toBe("default");
    expect(resp.body.tier3Source).toBe("manual");
  });

  it("bubbles a per-asset polling override into resolved + flips provenance to 'asset'", async () => {
    const { agent, csrf } = await authedAgent(app);
    const integ = await prisma.integration.create({
      data: { type: "fortimanager", name: "FMG-test", config: {} },
    });
    const asset = await prisma.asset.create({
      data: {
        hostname:                  "fw-with-snmp-override",
        assetType:                 "firewall",
        discoveredByIntegrationId: integ.id,
      },
    });
    // Set the per-asset override via the route (not raw Prisma) so the
    // compatibility check + audit logging exercise too.
    await agent
      .put(`/api/v1/assets/${asset.id}`)
      .set("X-CSRF-Token", csrf)
      .send({ cpuMemoryPolling: "snmp" });

    const resp = await agent.get(`/api/v1/assets/${asset.id}/effective-monitor-settings`);
    expect(resp.status).toBe(200);
    expect(resp.body.resolved.cpuMemoryPolling).toBe("snmp");
    expect(resp.body.provenance.cpuMemoryPolling).toBe("asset");
    // Unset streams materialize the runtime source default (2026-08 resolver
    // fold): FMG-sourced response-time defaults to icmp, labeled "default".
    expect(resp.body.resolved.responseTimePolling).toBe("icmp");
    expect(resp.body.provenance.responseTimePolling).toBe("default");
    expect(resp.body.tier3Source).toBe("integration");
  });
});

// ─── Auth required across the surface ──────────────────────────────────────

d("monitor-settings routes require authentication", () => {
  it("rejects PUT /manual without a session", async () => {
    const resp = await request(app)
      .put("/api/v1/monitor-settings/manual")
      .send(defaultTierSettings());
    // CSRF middleware runs before auth, so a sessionless mutation is rejected
    // with 403 (missing token) rather than 401 — either way it must not land.
    expect([401, 403]).toContain(resp.status);
  });

  it("rejects POST /class-overrides without a session", async () => {
    const resp = await request(app)
      .post("/api/v1/monitor-settings/class-overrides")
      .send({ integrationId: null, assetType: "server" });
    expect([401, 403]).toContain(resp.status);
  });
});
