/**
 * tests/integration/tlsPinnedDispatcher.test.ts — business rule 113(e)-(f).
 *
 * `tlsFetch(url, init, false)` — every FortiOS / FortiManager request with
 * SSL verification off — used to send its bearer token to whatever answered.
 * It now pins the certificate per host:port (2026-10-14, re-scan F10/F66):
 * first use pins, a changed certificate is refused BEFORE the request is
 * written and remembered on the pin, an administrator trusts exactly that
 * certificate, and Polaris re-pins by itself inside the window it opens after
 * its own firmware upgrade.
 *
 * Real HTTPS over loopback with the two throwaway fixture certificates, and a
 * real database (skips without one; see _helpers.ts).
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../../src/app.js";
import { authedAgent } from "./_helpers.js";
import { createServer, type Server } from "node:https";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { tlsFetch } from "../../src/utils/tlsDispatcher.js";
import {
  _resetCaches, trustPendingCert, allowRepin, normalizeFingerprint, changedCertPins,
} from "../../src/services/tlsCertPinService.js";

const d = dbDescribe;
const FIX = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const certA = { cert: readFileSync(join(FIX, "tls-pin-a.pem")), key: readFileSync(join(FIX, "tls-pin-a.key")) };
const certB = { cert: readFileSync(join(FIX, "tls-pin-b.pem")), key: readFileSync(join(FIX, "tls-pin-b.key")) };
const fpA = normalizeFingerprint(new X509Certificate(certA.cert).fingerprint256);
const fpB = normalizeFingerprint(new X509Certificate(certB.cert).fingerprint256);

let server: Server | null = null;
let port = 0;
let requests = 0;

async function serve(cert: typeof certA): Promise<void> {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = createServer(cert, (_req, res) => { requests++; res.writeHead(200, { "Content-Type": "application/json" }); res.end("{}"); });
  // closeAllConnections on the old server is not enough for undici's pool:
  // keep-alive sockets to the old certificate must not be reused.
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", () => r()));
  port = (server!.address() as AddressInfo).port;
}

async function call(): Promise<{ ok: boolean; code?: string }> {
  try {
    const res = await tlsFetch(`https://127.0.0.1:${port}/api/v2/monitor/system/status`, {
      method: "GET", headers: { Authorization: "Bearer not-a-real-token", Connection: "close" },
    }, false);
    await res.text();
    return { ok: res.ok };
  } catch (err: any) {
    return { ok: false, code: err?.cause?.code };
  }
}

const pin = () => prisma.tlsCertPin.findUnique({ where: { host_port: { host: "127.0.0.1", port } } });

beforeAll(async () => {
  if (!dbReachable) return;
  await serve(certA);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (!dbReachable) return;
  await prisma.tlsCertPin.deleteMany({ where: { host: "127.0.0.1", port } });
});

d("tlsFetch with verifySsl off pins the certificate", () => {
  it("pins on first use and carries the request", async () => {
    _resetCaches();
    expect((await call()).ok).toBe(true);
    expect((await pin())!.fingerprint).toBe(fpA);
  });

  it("refuses a changed certificate before writing the request, and records it", async () => {
    await serve(certB);
    _resetCaches();
    const before = requests;
    const r = await call();
    expect(r.ok).toBe(false);
    expect(r.code).toBe("CERT_PIN_REFUSED");
    expect(requests).toBe(before); // nothing reached the server
    const row = await pin();
    expect(row!.fingerprint).toBe(fpA);
    expect(row!.pendingFingerprint).toBe(fpB);
    expect((await changedCertPins()).some((p) => p.port === port)).toBe(true);
    // A second refusal does not write another mismatch Event.
    const events = await prisma.event.count({ where: { action: "tls.cert.mismatch", resourceName: `127.0.0.1:${port}` } });
    await call();
    expect(await prisma.event.count({ where: { action: "tls.cert.mismatch", resourceName: `127.0.0.1:${port}` } })).toBe(events);
  });

  it("trusts exactly the certificate an administrator inspected", async () => {
    const row = await pin();
    await expect(trustPendingCert(row!.id, fpA, "test-admin")).rejects.toThrow(/different certificate/);
    await trustPendingCert(row!.id, fpB, "test-admin");
    // Also proves a second full handshake still presents a certificate (no
    // TLS session resumption on the pinned connector).
    expect(await call()).toEqual({ ok: true });
    const after = await pin();
    expect(after!.fingerprint).toBe(fpB);
    expect(after!.pendingFingerprint).toBeNull();
  });

  it("re-pins by itself inside the window a Polaris firmware upgrade opens", async () => {
    expect(await allowRepin("127.0.0.1", [port], 5, "system:firmware")).toBe(1);
    await serve(certA);
    _resetCaches();
    expect((await call()).ok).toBe(true);
    const row = await pin();
    expect(row!.fingerprint).toBe(fpA);
    expect(row!.repinUntil).toBeNull();
  });
});

d("routes — the Sources tab and Trust new certificate", () => {
  it("GET /assets/:id/tls-pins lists the FortiManager and, in bypass mode, the gate with its pin", async () => {
    const fmgRow = await prisma.integration.create({
      data: { name: "tlspin-test-fmg", type: "fortimanager", enabled: false, config: { host: "127.0.0.1", port, useProxy: false, apiToken: "x" } as never } as never,
    });
    const asset = await prisma.asset.create({
      data: { hostname: "tlspin-test-gate", assetType: "firewall", status: "active", ipAddress: "198.51.100.170", monitored: false, discoveredByIntegrationId: fmgRow.id } as never,
    });
    try {
      const { agent } = await authedAgent(app);
      const res = await agent.get(`/api/v1/assets/${asset.id}/tls-pins`);
      expect(res.status).toBe(200);
      expect(res.body.endpoints).toHaveLength(2);
      expect(res.body.endpoints[0].host).toBe("127.0.0.1");
      expect(res.body.endpoints[0].pin?.fingerprint).toBe(fpA);
      expect(res.body.endpoints[1]).toMatchObject({ host: "198.51.100.170", port: 443, pin: null });
      expect(JSON.stringify(res.body)).not.toContain('"apiToken"');
    } finally {
      await prisma.asset.delete({ where: { id: asset.id } });
      await prisma.integration.delete({ where: { id: fmgRow.id } });
    }
  });

  it("POST /server-settings/agents/tls-cert-pins/:id/trust needs the fingerprint the admin saw", async () => {
    await serve(certB);
    _resetCaches();
    await call(); // refused, recorded as pending
    const row = await pin();
    const { agent, csrf } = await authedAgent(app);
    const wrong = await agent.post(`/api/v1/server-settings/agents/tls-cert-pins/${row!.id}/trust`).set("X-CSRF-Token", csrf).send({ fingerprint: fpA });
    expect(wrong.status).toBe(409);
    const ok = await agent.post(`/api/v1/server-settings/agents/tls-cert-pins/${row!.id}/trust`).set("X-CSRF-Token", csrf).send({ fingerprint: fpB });
    expect(ok.status).toBe(200);
    expect((await pin())!.fingerprint).toBe(fpB);
  });

  it("the credential test refuses a typed host that does not resolve (re-scan F58)", async () => {
    const { agent, csrf } = await authedAgent(app);
    const res = await agent.post("/api/v1/credentials/test").set("X-CSRF-Token", csrf)
      .send({ type: "http", host: "no-such-host.invalid", config: {}, check: { path: "/" } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/does not resolve/);
  });
});
