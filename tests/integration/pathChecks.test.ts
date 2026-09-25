/**
 * tests/integration/pathChecks.test.ts — agent-run path checks
 * end to end against a real database:
 *   - CRUD + membership reconcile (scope ∩ active agents) through the API,
 *   - GET /agents/config ships the check (version-gated) and the heartbeat
 *     configEtag moves when the target changes,
 *   - the two sample streams: rejection of foreign checks, the excerpt policy,
 *     latest-result columns, hop resolution to a monitored asset, and the
 *     path_check.path_changed Event,
 *   - the engine's path* resolvers read the stored samples (previewRule),
 *   - nothing touches the host's monitorStatus (business rule 85).
 */

import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser, waitForEventCount } from "./_helpers.js";
import { generateRawToken, TOKEN_INDEX_PREFIX_LEN } from "../../src/utils/bearerToken.js";
import { hashPassword } from "../../src/utils/password.js";
import { flushAllSampleBuffers } from "../../src/services/sampleWriteBuffer.js";
import { previewRule } from "../../src/services/notificationEngine.js";
import { previewInputSchema } from "../../src/services/notificationTypes.js";

const d = dbDescribe;
const HOST = "path-check-it-host";
const GATE = "path-check-it-gate";

let hostId = "";
let gateId = "";
let bearer = "";
let checkId = "";

async function cleanup(): Promise<void> {
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: "IT pathCheck" } } });
  await prisma.managedAgent.deleteMany({ where: { asset: { hostname: { in: [HOST, GATE] } } } });
  await prisma.asset.deleteMany({ where: { hostname: { in: [HOST, GATE] } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await ensureTestUser();
  await cleanup();
  const host = await prisma.asset.create({
    data: { hostname: HOST, assetType: "workstation", status: "active", ipAddress: "10.77.0.10", monitored: true, monitorStatus: "up", tags: ["it-conn"] } as never,
  });
  hostId = host.id;
  const gate = await prisma.asset.create({
    data: { hostname: GATE, assetType: "firewall", status: "active", ipAddress: "10.77.0.1", monitored: true, monitorStatus: "up" } as never,
  });
  gateId = gate.id;
  bearer = generateRawToken();
  await prisma.managedAgent.create({
    data: {
      assetId: hostId, osPlatform: "windows", arch: "amd64", installStatus: "active", installedBy: "test",
      agentVersion: "0.21.0",
      serverCertFingerprint: "sha256:" + "e".repeat(64), additionalServerCertFingerprints: [],
      bearerPrefix: bearer.slice(0, TOKEN_INDEX_PREFIX_LEN), bearerHash: await hashPassword(bearer),
    },
  });
});

afterAll(async () => {
  if (!dbReachable) return;
  try { await cleanup(); } catch { /* noop */ }
});

function agentReq(method: "get" | "post", path: string) {
  return request(app)[method]("/api/v1/agents" + path).set("Authorization", `Bearer ${bearer}`);
}

d("path checks", () => {
  it("creates a check and reconciles it onto the tagged agent host", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/path-checks").set("X-CSRF-Token", csrf).send({
      name: "IT path-check intranet",
      kind: "https",
      target: "https://intranet.example.test/health",
      intervalSec: 60,
      timeoutMs: 5000,
      http: { expectStatus: "200", bodyMatch: { mode: "contains", pattern: "ok" }, verifyTls: true },
      traceroute: { enabled: true, everyNRuns: 5 },
      scope: { condition: { op: "and", children: [{ field: "tag", operator: "has", value: "it-conn" }] } },
    });
    expect(res.status).toBe(201);
    checkId = res.body.id;
    expect(res.body.sourceCount).toBe(1);
    const src = await prisma.pathCheckSource.findMany({ where: { checkId } });
    expect(src.map((s) => s.assetId)).toEqual([hostId]);
    expect(await waitForEventCount("path_check.created", 1, checkId)).toBe(1);
  });

  it("refuses a loopback target", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/path-checks").set("X-CSRF-Token", csrf).send({
      name: "IT path-check loopback", kind: "http", target: "http://127.0.0.1/", scope: { allAssets: true },
    });
    expect(res.status).toBe(400);
  });

  it("ships the check in /agents/config and moves the heartbeat etag on an edit", async () => {
    const cfg = await agentReq("get", "/config");
    expect(cfg.status).toBe(200);
    expect(cfg.body.pathChecks).toHaveLength(1);
    expect(cfg.body.pathChecks[0]).toMatchObject({ id: checkId, kind: "https", expectStatus: "200", expectBody: { mode: "contains", value: "ok" } });
    const hb1 = await agentReq("post", "/heartbeat").send({ agentVersion: "0.21.0" });
    const { agent, csrf } = await authedAgent(app);
    const cur = await agent.get(`/api/v1/path-checks/${checkId}`);
    const upd = await agent.put(`/api/v1/path-checks/${checkId}`).set("X-CSRF-Token", csrf).send({
      name: cur.body.name, kind: "https", target: "https://intranet2.example.test/health", intervalSec: 60, timeoutMs: 5000,
      http: cur.body.http, traceroute: cur.body.traceroute, scope: cur.body.scope,
    });
    expect(upd.status).toBe(200);
    const hb2 = await agentReq("post", "/heartbeat").send({ agentVersion: "0.21.0" });
    expect(hb1.body.configEtag).toBeTruthy();
    expect(hb2.body.configEtag).not.toBe(hb1.body.configEtag);
  });

  it("ships nothing to an agent below 0.21.0", async () => {
    await prisma.managedAgent.update({ where: { assetId: hostId }, data: { agentVersion: "0.20.1" } });
    const cfg = await agentReq("get", "/config");
    expect(cfg.body.pathChecks).toEqual([]);
    await prisma.managedAgent.update({ where: { assetId: hostId }, data: { agentVersion: "0.21.0" } });
  });

  it("ingests samples: rejects a foreign check, enforces the excerpt policy, never touches monitorStatus", async () => {
    const now = Date.now();
    const res = await agentReq("post", "/samples").send({
      stream: "pathCheck",
      samples: [
        { checkId, timestamp: new Date(now - 120_000).toISOString(), ok: true, latencyMs: 40, httpStatus: 200, bodyExcerpt: "secret page", bodySha256: "a".repeat(64) },
        { checkId, timestamp: new Date(now - 60_000).toISOString(), ok: false, latencyMs: 900, httpStatus: 503, error: "HTTP 503 (expected 200)", bodyExcerpt: "Service Unavailable" },
        { checkId: "00000000-0000-0000-0000-000000000000", ok: true },
      ],
    });
    expect(res.body).toEqual({ accepted: 2, rejected: 1 });
    await flushAllSampleBuffers();
    const rows = await prisma.assetPathCheckSample.findMany({ where: { assetId: hostId, checkId }, orderBy: { timestamp: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0].bodyExcerpt).toBeNull();
    expect(rows[1].bodyExcerpt).toBe("Service Unavailable");
    const src = await prisma.pathCheckSource.findFirst({ where: { checkId, assetId: hostId } });
    expect(src).toMatchObject({ lastOk: false, lastHttpStatus: 503 });
    const host = await prisma.asset.findUnique({ where: { id: hostId }, select: { monitorStatus: true } });
    expect(host?.monitorStatus).toBe("up");
  });

  it("the engine's path* resolvers read the samples", async () => {
    const res = await previewRule(previewInputSchema.parse({
      name: "preview",
      trigger: { type: "asset_metric", metric: "pathLatencyMs", aggregation: "max", windowSec: 900, operator: ">", threshold: 500, forDurationSec: 0, dimensionFilter: { checkId } },
      scope: { assetIds: [hostId] },
    }) as never);
    const m = (res as { matches: Array<{ assetId: string; value: number; dimLabel?: string }> }).matches.find((x) => x.assetId === hostId);
    expect(m?.value).toBe(900);
    const fail = await previewRule(previewInputSchema.parse({
      name: "preview2",
      trigger: { type: "asset_metric", metric: "pathFailurePct", aggregation: "latest", windowSec: 900, operator: ">", threshold: 10, forDurationSec: 0 },
      scope: { assetIds: [hostId] },
    }) as never);
    const f = (fail as { matches: Array<{ assetId: string; value: number }> }).matches.find((x) => x.assetId === hostId);
    expect(f?.value).toBe(50);
  });

  it("resolves traceroute hops to the monitored gate and writes path_check.path_changed on a changed path", async () => {
    const base = Date.now() - 3_600_000;
    const hops = (third: string) => [
      { ttl: 1, ip: "10.77.0.1", rttMs: [1, 1] },
      { ttl: 2, ip: "", rttMs: [-1, -1] },
      { ttl: 3, ip: third, rttMs: [9, 9] },
    ];
    const r1 = await agentReq("post", "/samples").send({ stream: "pathCheckTraceroute", samples: [{ checkId, timestamp: new Date(base).toISOString(), complete: true, destinationIp: "203.0.113.10", hops: hops("203.0.113.10") }] });
    expect(r1.body).toEqual({ accepted: 1, rejected: 0 });
    const tr = await prisma.assetPathCheckTraceroute.findFirst({ where: { assetId: hostId, checkId } });
    const first = (tr!.hops as Array<{ assetId?: string; hostname?: string }>)[0];
    expect(first).toMatchObject({ assetId: gateId, hostname: GATE });
    await agentReq("post", "/samples").send({ stream: "pathCheckTraceroute", samples: [{ checkId, timestamp: new Date(base + 1_200_000).toISOString(), complete: true, destinationIp: "203.0.113.10", hops: hops("198.51.100.7") }] });
    expect(await waitForEventCount("path_check.path_changed", 1, hostId)).toBe(1);
  });

  it("lists the host's checks and history for the slide-over", async () => {
    const { agent } = await authedAgent(app);
    const checks = await agent.get(`/api/v1/assets/${hostId}/path-checks`);
    expect(checks.status).toBe(200);
    expect(checks.body.checks[0]).toMatchObject({ id: checkId });
    expect(checks.body.checks[0].latestSample).toMatchObject({ ok: false, httpStatus: 503 });
    const hist = await agent.get(`/api/v1/assets/${hostId}/path-check-history?checkId=${checkId}&range=1h`);
    expect(hist.status).toBe(200);
    expect(hist.body.samples.length).toBe(2);
    const trs = await agent.get(`/api/v1/assets/${hostId}/path-check-traceroutes?checkId=${checkId}`);
    expect(trs.body.traceroutes).toHaveLength(2);
    const results = await agent.get(`/api/v1/path-checks/${checkId}/results`);
    expect(results.body.results[0]).toMatchObject({ assetId: hostId, hostname: HOST });
  });

  it("rolls the samples up hourly and daily (ok/fail counts, mode status)", async () => {
    const { rollupHourly, rollupDaily } = await import("../../src/services/sampleRollupService.js");
    await rollupHourly(3);
    await rollupDaily(2);
    const hourly = await prisma.assetPathCheckSampleHourly.findMany({ where: { assetId: hostId, checkId } });
    const total = hourly.reduce((n, h) => n + h.sampleCount, 0);
    expect(total).toBe(2);
    expect(hourly.reduce((n, h) => n + h.failCount, 0)).toBe(1);
    const daily = await prisma.assetPathCheckSampleDaily.findMany({ where: { assetId: hostId, checkId } });
    expect(daily.reduce((n, h) => n + h.okCount, 0)).toBe(1);
  });

  it("drops the source when the agent is uninstalled (reconcile)", async () => {
    const { reconcilePathCheckSources } = await import("../../src/services/pathCheckService.js");
    await prisma.managedAgent.update({ where: { assetId: hostId }, data: { installStatus: "failed" } });
    await reconcilePathCheckSources(checkId);
    expect(await prisma.pathCheckSource.count({ where: { checkId } })).toBe(0);
    await prisma.managedAgent.update({ where: { assetId: hostId }, data: { installStatus: "active" } });
  });
});
