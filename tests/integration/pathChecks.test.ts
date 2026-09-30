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
 *   - nothing touches the host's monitorStatus (business rule 85),
 *   - the Polaris server as a source: its assetId-NULL row, the server-subject
 *     ingest and its three readings, and the networkScan:write chained gate
 *     (a role-bound token without it is refused with 403).
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
import { createToken } from "../../src/services/apiTokenService.js";
import { createRole, deleteRole } from "../../src/services/roleService.js";
import { ingestPathCheckSamples, ingestPathCheckTraceroutes, POLARIS_SERVER_SUBJECT } from "../../src/services/pathCheckIngestService.js";

const d = dbDescribe;
const HOST = "path-check-it-host";
const GATE = "path-check-it-gate";

let hostId = "";
let gateId = "";
let bearer = "";
let checkId = "";
const NO_SCAN_ROLE = "it-path-check-no-network-scan";
let noScanRoleId = "";
let noScanToken = "";

async function cleanup(): Promise<void> {
  await prisma.pathCheck.deleteMany({ where: { name: { startsWith: "IT path-check" } } });
  await prisma.apiToken.deleteMany({ where: { name: NO_SCAN_ROLE } });
  await prisma.role.deleteMany({ where: { name: NO_SCAN_ROLE } });
  await prisma.credential.deleteMany({ where: { name: { startsWith: "IT path-check cred" } } });
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
  // Path Monitor write, but no Network Discovery — may run checks from agents only.
  noScanRoleId = (await createRole({ name: NO_SCAN_ROLE, permissions: { pathChecks: "write", networkScan: "read" } })).id;
  noScanToken = (await createToken({ name: NO_SCAN_ROLE, roleId: noScanRoleId, createdBy: "integration-test" })).rawToken;
});

afterAll(async () => {
  if (!dbReachable) return;
  try {
    await prisma.apiToken.deleteMany({ where: { name: NO_SCAN_ROLE } });
    await deleteRole(noScanRoleId).catch(() => {});
    await cleanup();
  } catch { /* noop */ }
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

  it("runs a picked-hosts check on its pins only, stores the finder filter, and previews every match id", async () => {
    const { agent, csrf } = await authedAgent(app);
    const finder = { condition: { op: "and", children: [{ field: "tag", operator: "has", value: "it-conn" }] } };
    const preview = await agent.post("/api/v1/path-checks/preview-sources").set("X-CSRF-Token", csrf).send({ scope: finder, assetIds: [] });
    expect(preview.status).toBe(200);
    expect(preview.body.ids).toEqual([hostId]);
    const res = await agent.post("/api/v1/path-checks").set("X-CSRF-Token", csrf).send({
      name: "IT path-check picked", kind: "icmp", target: "10.20.30.1", scope: {}, assetIds: [hostId], sourceFilter: finder,
    });
    expect(res.status).toBe(201);
    expect(res.body.sourceFilter).toEqual(finder);
    expect(res.body.scope).toEqual({});
    const src = await prisma.pathCheckSource.findMany({ where: { checkId: res.body.id } });
    expect(src.map((s) => [s.assetId, s.explicit])).toEqual([[hostId, true]]);
    await agent.delete("/api/v1/path-checks/" + res.body.id).set("X-CSRF-Token", csrf);
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

d("path checks — the Polaris server as a source", () => {
  let serverCheckId = "";
  const serverBody = {
    name: "IT path-check from the server",
    kind: "tcp",
    target: "db01.example.test:5432",
    intervalSec: 60,
    timeoutMs: 5000,
    traceroute: { enabled: true, everyNRuns: 5 },
    scope: {},
    assetIds: [],
    runOnServer: true,
  };

  it("refuses a caller without networkScan:write, and creates it for one with it", async () => {
    const denied = await request(app).post("/api/v1/path-checks").set("Authorization", `Bearer ${noScanToken}`).send(serverBody);
    expect(denied.status).toBe(403);
    expect(await prisma.pathCheck.count({ where: { name: serverBody.name } })).toBe(0);
    // The same caller may still create an agent-only check.
    const agentOnly = await request(app).post("/api/v1/path-checks").set("Authorization", `Bearer ${noScanToken}`)
      .send({ ...serverBody, name: "IT path-check agents only", runOnServer: false, scope: { allAssets: true } });
    expect(agentOnly.status).toBe(201);
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/path-checks").set("X-CSRF-Token", csrf).send(serverBody);
    expect(res.status).toBe(201);
    serverCheckId = res.body.id;
    expect(res.body).toMatchObject({ runOnServer: true, sourceCount: 1 });
    const rows = await prisma.pathCheckSource.findMany({ where: { checkId: serverCheckId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].assetId).toBeNull();
  });

  it("holds one server row per check at the database, not just in the reconcile", async () => {
    await expect(prisma.pathCheckSource.create({ data: { checkId: serverCheckId, assetId: null, explicit: true } })).rejects.toThrow();
  });

  it("lets a caller without networkScan rename it or turn the server off, never re-aim it", async () => {
    const put = (body: object) => request(app).put(`/api/v1/path-checks/${serverCheckId}`).set("Authorization", `Bearer ${noScanToken}`).send(body);
    expect((await put({ ...serverBody, target: "db02.example.test:5432" })).status).toBe(403);
    const renamed = await put({ ...serverBody, name: "IT path-check from the server (renamed)" });
    expect(renamed.status).toBe(200);
    serverBody.name = "IT path-check from the server (renamed)";
  });

  it("ingests under the server subject and serves its three readings", async () => {
    const now = new Date();
    const r = await ingestPathCheckSamples(POLARIS_SERVER_SUBJECT, [
      { checkId: serverCheckId, timestamp: new Date(now.getTime() - 60_000).toISOString(), ok: true, latencyMs: 12, connectMs: 12, resolvedIp: "10.77.0.50" },
    ], now);
    expect(r).toEqual({ accepted: 1, rejected: 0 });
    await ingestPathCheckTraceroutes(POLARIS_SERVER_SUBJECT, [{
      checkId: serverCheckId, timestamp: new Date(now.getTime() - 50_000).toISOString(), complete: true, destinationIp: "10.77.0.50",
      hops: [{ ttl: 1, ip: "10.77.0.1", rttMs: [1] }, { ttl: 2, ip: "10.77.0.50", rttMs: [2] }],
    }], now);
    await flushAllSampleBuffers();
    // An agent's bearer can never write under the server's check.
    const foreign = await agentReq("post", "/samples").send({ stream: "pathCheck", samples: [{ checkId: serverCheckId, ok: true }] });
    expect(foreign.body).toEqual({ accepted: 0, rejected: 1 });

    const { agent } = await authedAgent(app);
    const results = await agent.get(`/api/v1/path-checks/${serverCheckId}/results`);
    expect(results.body.results[0]).toMatchObject({ server: true, assetId: null, hostname: "Polaris server", lastOk: true, lastLatencyMs: 12 });
    const detail = await agent.get(`/api/v1/path-checks/${serverCheckId}/server`);
    expect(detail.status).toBe(200);
    expect(detail.body.checks[0]).toMatchObject({ id: serverCheckId, latestSample: { ok: true, resolvedIp: "10.77.0.50" } });
    const hist = await agent.get(`/api/v1/path-checks/${serverCheckId}/server/history?range=1h`);
    expect(hist.status).toBe(200);
    expect(hist.body.samples).toHaveLength(1);
    const trs = await agent.get(`/api/v1/path-checks/${serverCheckId}/server/traceroutes?limit=5`);
    expect(trs.body.traceroutes).toHaveLength(1);
    expect((trs.body.traceroutes[0].hops as Array<{ assetId?: string }>)[0]).toMatchObject({ assetId: gateId });
    // A check that does not run on the server answers an empty list, not an error.
    const other = await agent.get(`/api/v1/path-checks/${checkId}/server`);
    expect(other.body).toEqual({ checks: [] });
  });

  it("refuses to re-enable a server-run check without networkScan:write", async () => {
    const { agent, csrf } = await authedAgent(app);
    await agent.post(`/api/v1/path-checks/${serverCheckId}/enabled`).set("X-CSRF-Token", csrf).send({ enabled: false });
    const denied = await request(app).post(`/api/v1/path-checks/${serverCheckId}/enabled`).set("Authorization", `Bearer ${noScanToken}`).send({ enabled: true });
    expect(denied.status).toBe(403);
  });

  it("test-runs a draft from the server for a caller with networkScan:write, and audits it", async () => {
    const draft = { kind: "tcp", target: "no-such-host.invalid:443", timeoutMs: 2000 };
    const denied = await request(app).post("/api/v1/path-checks/test").set("Authorization", `Bearer ${noScanToken}`).send(draft);
    expect(denied.status).toBe(403);
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/path-checks/test").set("X-CSRF-Token", csrf).send(draft);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "server", sample: { ok: false } });
    expect(res.body.sample.error).toMatch(/^dns lookup failed: /);
    expect(await prisma.event.count({ where: { action: "path_check.tested", resourceName: "Test run" } })).toBeGreaterThanOrEqual(1);
    const bad = await agent.post("/api/v1/path-checks/test").set("X-CSRF-Token", csrf).send({ kind: "http", target: "http://127.0.0.1/" });
    expect(bad.status).toBe(400);
  });

  it("drops the server row when the server is turned off", async () => {
    const res = await request(app).put(`/api/v1/path-checks/${serverCheckId}`).set("Authorization", `Bearer ${noScanToken}`)
      .send({ ...serverBody, enabled: false, runOnServer: false, scope: { allAssets: true } });
    expect(res.status).toBe(200);
    expect(await prisma.pathCheckSource.count({ where: { checkId: serverCheckId, assetId: null } })).toBe(0);
  });
});

d("path checks — authentication (server-only)", () => {
  let credId = "";
  let authCheckId = "";

  it("creates an authenticating check that runs only from the server", async () => {
    const cred = await prisma.credential.create({
      data: { name: "IT path-check cred", type: "http", config: { authMode: "basic", username: "svc", password: "s3cret" }, createdBy: "someone-else" },
    });
    credId = cred.id;
    const body = {
      name: "IT path-check with auth", kind: "https", target: "https://erp.example.test/health",
      http: { expectStatus: "", verifyTls: true }, scope: {}, assetIds: [], credentialId: credId,
    };
    // Path Monitor + Network Discovery, but no Credentials rung: may not USE a stored secret.
    const denied = await request(app).post("/api/v1/path-checks").set("Authorization", `Bearer ${noScanToken}`).send(body);
    expect(denied.status).toBe(403);
    const { agent, csrf } = await authedAgent(app);
    const withAgents = await agent.post("/api/v1/path-checks").set("X-CSRF-Token", csrf).send({ ...body, scope: { allAssets: true } });
    expect(withAgents.status).toBe(400);
    const res = await agent.post("/api/v1/path-checks").set("X-CSRF-Token", csrf).send(body);
    expect(res.status).toBe(201);
    authCheckId = res.body.id;
    expect(res.body).toMatchObject({ credentialId: credId, runOnServer: true });
    const rows = await prisma.pathCheckSource.findMany({ where: { checkId: authCheckId } });
    expect(rows.map((r) => r.assetId)).toEqual([null]);
    // Never in an agent's config, and the definition carries no secret.
    const cfg = await agentReq("get", "/config");
    expect((cfg.body.pathChecks as Array<{ id: string }>).some((c) => c.id === authCheckId)).toBe(false);
    expect(JSON.stringify(cfg.body)).not.toContain("s3cret");
  });

  it("refuses to delete a credential a check uses, naming the check", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.delete(`/api/v1/credentials/${credId}`).set("X-CSRF-Token", csrf);
    expect(res.status).toBe(409);
    expect(res.body.error ?? res.body.message).toMatch(/IT path-check with auth/);
  });

  it("the server job's definitions carry the credential, and the opened auth is usable", async () => {
    const { serverCheckDefinitions, loadServerCheckAuth } = await import("../../src/services/pathCheckService.js");
    const def = (await serverCheckDefinitions()).find((d) => d.id === authCheckId);
    expect(def?.credentialId).toBe(credId);
    expect(await loadServerCheckAuth(credId)).toMatchObject({ authMode: "basic", username: "svc", password: "s3cret" });
  });
});
