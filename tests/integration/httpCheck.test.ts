/**
 * tests/integration/httpCheck.test.ts
 *
 * Route-level contract for the HTTP check after the 2026-08 move: it is no
 * longer a POLLING METHOD but a manufacturer custom widget, and the `http`
 * credential it authenticates with carries authentication and nothing else.
 *
 * This file replaces httpCheckPolling.test.ts, which pinned the shape that
 * change removed — `http` accepted on responseTimePolling, a path and an
 * expectation stored on the credential, and the check passed to the test route
 * inside `config`. Every one of those is now the WRONG answer, so the file is
 * rewritten rather than patched.
 *
 * What is pinned here is the set of behaviours whose wrong version is SILENT:
 * a polling method that saves and then never probes, a path override that
 * quietly repoints a device at "/", a credential that keeps a stale check
 * field, and a widget that stores an unvalidated check.
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const HOST = "http-check-test";
const CRED = "http-check-test-cred";
const MFG  = "HttpCheckTestVendor";
let assetId = "";

async function seedAsset(extra: Record<string, unknown> = {}): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
  const asset = await prisma.asset.create({
    data: {
      hostname: HOST,
      assetType: "server",
      status: "active",
      ipAddress: "10.98.0.10",
      monitored: false,
      ...extra,
    } as never,
  });
  assetId = asset.id;
}

async function put(body: unknown, id = assetId) {
  const { agent, csrf } = await authedAgent(app);
  return agent.put(`/api/v1/assets/${id}`).set("X-CSRF-Token", csrf).send(body as object);
}

async function postCredential(body: unknown) {
  const { agent, csrf } = await authedAgent(app);
  return agent.post("/api/v1/credentials").set("X-CSRF-Token", csrf).send(body as object);
}

async function cleanup() {
  try {
    await prisma.asset.deleteMany({ where: { hostname: { startsWith: HOST } } });
    await prisma.credential.deleteMany({ where: { name: { startsWith: CRED } } });
    const p = await prisma.manufacturerProfile.findFirst({ where: { manufacturer: MFG } });
    if (p) await prisma.manufacturerProfile.delete({ where: { id: p.id } });
  } catch { /* noop */ }
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  try { await prisma.$disconnect(); } catch { /* noop */ }
});

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  await seedAsset();
});

d("PUT /assets/:id — http is no longer a polling method", () => {
  it("rejects http on responseTimePolling, the stream it used to own", async () => {
    // The retirement has to be visible at the route, not just absent from the
    // dropdown: an API caller (or a stale browser tab) posting the old value
    // must be told, rather than storing a method nothing can probe.
    const res = await put({ responseTimePolling: "http" });
    expect(res.status).toBe(400);
  });

  it("rejects http on every other stream too", async () => {
    for (const field of ["cpuMemoryPolling", "temperaturePolling", "interfacesPolling", "lldpPolling", "storagePolling"]) {
      const res = await put({ [field]: "http" });
      expect(res.status, field).toBe(400);
    }
  });

  it("still accepts the methods that remain", async () => {
    expect((await put({ responseTimePolling: "icmp" })).status).toBe(200);
    expect((await put({ responseTimePolling: "snmp" })).status).toBe(200);
  });
});

d("PUT /assets/:id — httpCheckPath override semantics", () => {
  // The override outlived the polling method: model targeting on the widget
  // covers "this MODEL answers elsewhere", and this covers the single device
  // that does. It is now independent of any polling setting, which is why none
  // of these send one.
  it("stores a path override with no polling method involved", async () => {
    const res = await put({ httpCheckPath: "/api/ping" });
    expect(res.status).toBe(200);
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe("/api/ping");
  });

  it("a BLANK override clears to NULL, not to \"/\"", async () => {
    // NULL means "use the widget's path". Storing "" or "/" here would repoint
    // the device at the web root the moment an operator emptied the box.
    await put({ httpCheckPath: "/api/ping" });
    const res = await put({ httpCheckPath: "" });
    expect(res.status).toBe(200);
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe(null);
  });

  it("whitespace-only is a clear too — a spacebar is not a path", async () => {
    await put({ httpCheckPath: "/api/ping" });
    await put({ httpCheckPath: "   " });
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe(null);
  });

  it("an explicit null clears it", async () => {
    await put({ httpCheckPath: "/api/ping" });
    await put({ httpCheckPath: null });
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe(null);
  });

  it("is left alone by a PUT that doesn't mention it", async () => {
    await put({ httpCheckPath: "/api/ping" });
    await put({ department: "ops" });
    const row = await prisma.asset.findUnique({ where: { id: assetId }, select: { httpCheckPath: true } });
    expect(row?.httpCheckPath).toBe("/api/ping");
  });
});

d("POST /credentials — the http type carries authentication only", () => {
  it("creates a digest credential", async () => {
    const res = await postCredential({
      name: CRED, type: "http",
      config: { authMode: "digest", username: "root", password: "camerapass" },
    });
    expect(res.status).toBe(201);
    const row = await prisma.credential.findUnique({ where: { name: CRED } });
    const cfg = (row?.config || {}) as Record<string, unknown>;
    expect(cfg.authMode).toBe("digest");
    expect(cfg.username).toBe("root");
  });

  it("rejects a config with no auth type — a credential must authenticate", async () => {
    const res = await postCredential({ name: CRED, type: "http", config: {} });
    expect(res.status).toBe(400);
  });

  it("rejects the none mode", async () => {
    // An unauthenticated check is a widget with NO credential attached, not a
    // credential that authenticates nothing.
    const res = await postCredential({ name: CRED, type: "http", config: { authMode: "none" } });
    expect(res.status).toBe(400);
  });

  it("rejects half-configured basic auth", async () => {
    const res = await postCredential({
      name: CRED, type: "http", config: { authMode: "basic", username: "monitor" },
    });
    expect(res.status).toBe(400);
  });

  it("strips check-definition fields left over from the pre-split shape", async () => {
    // Dropped rather than 400'd, so a credential written before the split
    // re-saves cleanly instead of failing on fields the form no longer sends.
    const res = await postCredential({
      name: CRED, type: "http",
      config: {
        authMode: "bearer", apiToken: "t0ken",
        path: "/healthz", expectBody: "OK", port: 8443, verifyTls: true,
      },
    });
    expect(res.status).toBe(201);
    const row = await prisma.credential.findUnique({ where: { name: CRED } });
    const cfg = (row?.config || {}) as Record<string, unknown>;
    expect(cfg.path).toBeUndefined();
    expect(cfg.expectBody).toBeUndefined();
    expect(cfg.port).toBeUndefined();
    expect(cfg.apiToken).toBe("t0ken");
  });

  it("masks the bearer token on read", async () => {
    await postCredential({
      name: CRED, type: "http", config: { authMode: "bearer", apiToken: "supersecret" },
    });
    const { agent } = await authedAgent(app);
    const list = await agent.get("/api/v1/credentials");
    expect(list.status).toBe(200);
    const found = (list.body as Array<Record<string, unknown>>).find((c) => c.name === CRED);
    const cfg = (found?.config || {}) as Record<string, unknown>;
    expect(cfg.apiToken).not.toBe("supersecret");
  });
});

d("POST /server-settings/manufacturer-profiles — http check widgets", () => {
  async function newProfile(): Promise<string> {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/server-settings/manufacturer-profiles")
      .set("X-CSRF-Token", csrf).send({ manufacturer: MFG });
    return String((res.body?.profile || res.body)?.id || "");
  }
  async function addWidget(profileId: string, body: unknown) {
    const { agent, csrf } = await authedAgent(app);
    return agent.post(`/api/v1/server-settings/manufacturer-profiles/${profileId}/widgets`)
      .set("X-CSRF-Token", csrf).send(body as object);
  }

  it("accepts an http widget with no MIB or symbol — it names a request, not an OID", async () => {
    const profileId = await newProfile();
    const res = await addWidget(profileId, {
      name: "VAPIX reachable",
      widgetType: "http",
      httpCheck: { path: "healthz", expectBody: "OK" },
    });
    expect(res.status).toBe(201);
    const w = res.body?.widget;
    expect(w.symbol).toBe(null);
    expect(w.mibId).toBe(null);
    // Canonicalized by the same validator the Test Connection flow uses, so a
    // check cannot pass a live test and then be rejected on save.
    expect(w.httpCheck.path).toBe("/healthz");
  });

  it("rejects an invalid regex at save rather than once per asset per interval", async () => {
    const profileId = await newProfile();
    const res = await addWidget(profileId, {
      name: "bad regex",
      widgetType: "http",
      httpCheck: { expectBody: "([unclosed", matchMode: "regex" },
    });
    expect(res.status).toBe(400);
    expect(String(res.body?.error || res.text)).toMatch(/regex/i);
  });

  it("still requires a MIB and symbol on a non-http widget", async () => {
    const profileId = await newProfile();
    const res = await addWidget(profileId, { name: "gauge", widgetType: "gauge" });
    expect(res.status).toBe(400);
  });
});

d("POST /credentials/test — the check is supplied per test, not read off the credential", () => {
  // A real loopback server, so this covers route + probe + diagnostics end to
  // end rather than a mock's idea of it.
  let srv: import("node:http").Server | null = null;
  let srvPort = 0;
  let testAssetId = "";

  beforeAll(async () => {
    if (!dbReachable) return;
    const { createServer } = await import("node:http");
    srv = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"state":"healthy","build":"1.2.3"}');
    });
    await new Promise<void>((resolve) => srv!.listen(0, "127.0.0.1", () => resolve()));
    srvPort = (srv!.address() as { port: number }).port;
  });

  afterAll(async () => {
    if (srv) await new Promise<void>((resolve) => srv!.close(() => resolve()));
  });

  beforeEach(async () => {
    if (!dbReachable) return;
    const a = await prisma.asset.findFirst({ where: { hostname: HOST } });
    testAssetId = a?.id || "";
    await prisma.asset.update({ where: { id: testAssetId }, data: { ipAddress: "127.0.0.1" } });
  });

  async function runTest(check: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const { agent, csrf } = await authedAgent(app);
    return agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf).send({
      assetId: testAssetId,
      type: "http",
      // Auth only — an unauthenticated check needs no credential at all.
      config: {},
      check: { port: srvPort, ...check },
      ...extra,
    });
  }

  it("returns the status, content-type and body so a match string can be picked out of it", async () => {
    const res = await runTest({ path: "/" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const diag = res.body.httpDiagnostics;
    expect(diag).toBeTruthy();
    expect(diag.statusCode).toBe(200);
    expect(diag.contentType).toContain("application/json");
    expect(diag.excerpt).toContain('"state":"healthy"');
    // matched:null is the first-test state — nothing configured to match yet.
    expect(diag.matched).toBe(null);
  });

  it("reports the verdict once an expectation is set", async () => {
    const hit = await runTest({ path: "/", expectBody: "healthy" });
    expect(hit.body.httpDiagnostics.matched).toBe(true);
    const miss = await runTest({ path: "/", expectBody: "degraded" });
    expect(miss.body.httpDiagnostics.matched).toBe(false);
    // A mismatch always fails now — the failOnMismatch escape hatch is gone.
    expect(miss.body.success).toBe(false);
  });

  it.each(["127.0.0.1", "127.1", "2130706433", "[::ffff:7f00:1]", "169.254.169.254", "localhost"])(
    "refuses a typed host that is this machine or a metadata address: %s (rule 110)",
    async (host) => {
      const { agent, csrf } = await authedAgent(app);
      const res = await agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf).send({
        host, type: "http", config: {}, check: { port: srvPort, path: "/" },
      });
      // A RESULT, not a 4xx, and no request was made — so no body comes back.
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(String(res.body.error)).toMatch(/loopback \/ link-local \/ metadata/i);
      expect(res.body.httpDiagnostics).toBeUndefined();
    },
  );

  it("refuses a typed host that is really a URL, naming the field that owns the parts", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf).send({
      host: `http://127.0.0.1:${srvPort}/x`, type: "http", config: {}, check: { path: "/" },
    });
    // Returned as a probe-shaped RESULT, not a 4xx, so the modal renders it
    // inline beside the field just typed in.
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(String(res.body.error)).toMatch(/not a URL/i);
  });

  it("audits the SHAPE of the answer but never the response body", async () => {
    // The body is arbitrary device output: it would land in every pg_dump and
    // every syslog forward, and the operator who needs it is already looking at
    // it in the modal.
    await runTest({ path: "/", expectBody: "healthy" });
    const ev = await prisma.event.findFirst({
      where: { action: "credential.tested" },
      orderBy: { timestamp: "desc" },
    });
    expect(ev).toBeTruthy();
    const details = JSON.stringify(ev?.details ?? {});
    expect(details).toContain("httpStatus");
    expect(details).not.toContain("healthy");
  });

  it("other credential types carry no httpDiagnostics key at all", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf).send({
      assetId: testAssetId, type: "restapi", config: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.httpDiagnostics).toBeUndefined();
  });
});
