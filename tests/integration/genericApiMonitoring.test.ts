/**
 * tests/integration/genericApiMonitoring.test.ts — the `genericapi` polling
 * method end to end against a real database (business rule 100(i)):
 *   - saving monitor queries keeps the integration tier in step: a stream a
 *     query feeds "by default" resolves to genericapi, seeded from the manual
 *     tier the first time; an edit keeps the tier; a removed query clears its
 *     stream; the dialog's save never deletes the tier;
 *   - the monitor dispatch reaches the method for response time and system
 *     info on an asset the integration lists (fake transport — netGuard
 *     refuses loopback, so no local server);
 *   - the asset PUT refuses the method on an asset with no Generic API record;
 *   - GET /assets/:id/custom-widgets includes the integration's widgets.
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";
import { _setRequestImplForTests } from "../../src/services/genericApiService.js";
import { invalidateGenericApiMonitorCache } from "../../src/services/genericApiMonitorService.js";
import { collectSystemInfo, invalidateMonitorSettingsCache, probeAsset } from "../../src/services/monitoringService.js";

const d = dbDescribe;
const NAME = "IT generic monitoring";
const HOST_PREFIX = "gamon-";
const MANUAL_KEY = "manualMonitorSettings";
let savedManual: unknown = undefined;

async function cleanup(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: HOST_PREFIX } }, select: { id: true } });
  const ids = assets.map((a) => a.id);
  if (ids.length) {
    await prisma.assetSource.deleteMany({ where: { assetId: { in: ids } } });
    await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  }
  await prisma.integration.deleteMany({ where: { name: { startsWith: NAME } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
  const row = await prisma.setting.findUnique({ where: { key: MANUAL_KEY } });
  savedManual = row ? row.value : null;
  await prisma.setting.upsert({
    where: { key: MANUAL_KEY },
    update: { value: { intervalSeconds: 77, systemInfoIntervalSeconds: 600 } as any },
    create: { key: MANUAL_KEY, value: { intervalSeconds: 77, systemInfoIntervalSeconds: 600 } as any },
  });
});

afterAll(async () => {
  _setRequestImplForTests(null);
  if (!dbReachable) return;
  await cleanup();
  if (savedManual === null) await prisma.setting.deleteMany({ where: { key: MANUAL_KEY } });
  else await prisma.setting.update({ where: { key: MANUAL_KEY }, data: { value: savedManual as any } });
});

const STATUS = {
  name: "Status", stream: "responseTime", scope: "fleet", path: "/api/status",
  recordsPath: "items", matchPath: "device", map: { up: "state" },
};
const PORTS = {
  name: "Ports", stream: "interfaces", scope: "asset", path: "/api/devices/{{identity}}/ports",
  itemsPath: "ports", map: { name: "id", operStatus: "link" },
};
const SUPPLIES = {
  name: "Supplies", stream: "widgets", scope: "asset", path: "/api/devices/{{identity}}",
  widgets: [{ name: "Toner", type: "gauge", path: "toner", unit: "%", min: 0, max: 100 }],
};

const config = (monitorQueries: unknown[]) => ({
  host: "inventory.example.com",
  path: "/api/devices",
  recordsPath: "data",
  fieldMap: { id: "id", hostname: "name" },
  monitorQueries,
});

d("Generic API monitoring — the integration tier follows the queries", () => {
  it("seeds from the manual tier, sets the defaulted streams, keeps the tier across an edit, and clears a removed stream", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf)
      .send({ type: "genericapi", name: NAME, config: config([STATUS, PORTS, { ...SUPPLIES }]) });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const read = async () => ((await prisma.integration.findUnique({ where: { id } }))!.config as any);

    let cfg = await read();
    expect(cfg.monitorSettings).toMatchObject({ intervalSeconds: 77, systemInfoIntervalSeconds: 600, responseTimePolling: "genericapi", interfacesPolling: "genericapi" });
    expect(cfg.monitorQueries).toHaveLength(3);

    // An operator-set key and a dialog save that sends no monitorSettings.
    cfg.monitorSettings.cpuMemoryPolling = "snmp";
    await prisma.integration.update({ where: { id }, data: { config: cfg } });
    const edited = await agent.put(`/api/v1/integrations/${id}`).set("X-CSRF-Token", csrf)
      .send({ config: config([STATUS, { ...PORTS, useByDefault: false }, SUPPLIES]) });
    expect(edited.status).toBe(200);
    cfg = await read();
    expect(cfg.monitorSettings.cpuMemoryPolling).toBe("snmp");
    expect(cfg.monitorSettings.responseTimePolling).toBe("genericapi");
    expect(cfg.monitorSettings).not.toHaveProperty("interfacesPolling");
    expect(cfg.monitorSettings.intervalSeconds).toBe(77);
  });

  it("refuses a monitor query that would read wrong", async () => {
    const { agent, csrf } = await authedAgent(app);
    const cases: Array<[string, unknown, RegExp]> = [
      ["fleet query with a placeholder", { ...STATUS, path: "/api/{{identity}}" }, /cannot hold/],
      ["fleet query without an identity path", { ...STATUS, matchPath: "" }, /identity/],
      ["unknown field for the stream", { ...STATUS, map: { up: "s", cpuPct: "c" } }, /not a responseTime field/],
      ["path naming another host", { ...STATUS, path: "//evil.example/x" }, /single/],
      ["widgets query with no widgets", { ...SUPPLIES, widgets: [] }, /at least one widget/],
    ];
    for (const [label, q, msg] of cases) {
      const r = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf)
        .send({ type: "genericapi", name: `${NAME} bad`, config: config([q]) });
      expect(r.status, label).toBe(400);
      expect(JSON.stringify(r.body), label).toMatch(msg);
    }
  });
});

d("Generic API monitoring — dispatch, the asset PUT guard, widgets", () => {
  it("probes and collects through the integration's queries, guards the PUT, and lists the widgets", async () => {
    const { agent, csrf } = await authedAgent(app);
    const created = await agent.post("/api/v1/integrations").set("X-CSRF-Token", csrf)
      .send({ type: "genericapi", name: `${NAME} dispatch`, config: config([STATUS, PORTS, SUPPLIES]) });
    expect(created.status).toBe(201);
    const integrationId = created.body.id as string;

    const asset = await prisma.asset.create({
      data: { hostname: `${HOST_PREFIX}cam`, assetType: "other", status: "active", monitored: true, discoveredByIntegrationId: integrationId },
    });
    await prisma.assetSource.create({
      data: {
        assetId: asset.id, sourceKind: "generic-api", externalId: `${integrationId}:dev1`, integrationId,
        observed: { kind: "generic-api", identity: "dev1" } as any, inferred: false,
      },
    });
    invalidateMonitorSettingsCache({ integrationId });
    invalidateGenericApiMonitorCache();
    _setRequestImplForTests(async (url) => {
      const json = url.pathname === "/api/status" ? { items: [{ device: "dev1", state: "online" }] }
        : url.pathname === "/api/devices/dev1/ports" ? { ports: [{ id: "eth0", link: "up" }] }
        : { toner: 42 };
      return { status: 200, headers: {}, text: "", json };
    });

    const probe = await probeAsset(asset.id);
    expect(probe.success).toBe(true);
    const sys = await collectSystemInfo(asset.id);
    expect(sys.supported).toBe(true);
    expect(sys.data?.interfaces.map((i) => [i.ifName, i.operStatus])).toEqual([["eth0", "up"]]);

    const widgets = await agent.get(`/api/v1/assets/${asset.id}/custom-widgets`);
    expect(widgets.status).toBe(200);
    expect(widgets.body.widgets.map((w: any) => [w.name, w.widgetType, w.source?.kind])).toEqual([["Toner", "gauge", "genericapi"]]);

    // The PUT guard: an asset with no Generic API record cannot take the method.
    const orphan = await prisma.asset.create({ data: { hostname: `${HOST_PREFIX}orphan`, assetType: "server", status: "active" } });
    const refused = await agent.put(`/api/v1/assets/${orphan.id}`).set("X-CSRF-Token", csrf).send({ interfacesPolling: "genericapi" });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toMatch(/no Generic API record/);
    const accepted = await agent.put(`/api/v1/assets/${asset.id}`).set("X-CSRF-Token", csrf).send({ lldpPolling: "genericapi" });
    expect(accepted.status).toBe(200);
    expect((await prisma.asset.findUnique({ where: { id: asset.id }, select: { lldpPolling: true } }))?.lldpPolling).toBe("genericapi");
  });
});
