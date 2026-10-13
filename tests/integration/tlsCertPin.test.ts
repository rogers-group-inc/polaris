/**
 * tests/integration/tlsCertPin.test.ts
 *
 * Business rule 113, end to end against a real database and a real local
 * HTTPS server: the first connection pins the server's certificate, the same
 * certificate is accepted again, a DIFFERENT certificate on the same host:port
 * is refused before the request is written (with a tls.cert.mismatch Event),
 * and deleting the pin re-opens first-use trust.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import { createServer, request, type Server } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { prisma } from "../../src/db.js";
import { pinnedAgentFor, CertPinRefusedError } from "../../src/utils/pinnedTlsAgent.js";
import { listCertPins, deleteCertPin, _resetCaches } from "../../src/services/tlsCertPinService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;
const FIX = join(__dirname, "..", "fixtures");
const tlsA = { cert: readFileSync(join(FIX, "tls-pin-a.pem")), key: readFileSync(join(FIX, "tls-pin-a.key")) };
const tlsB = { cert: readFileSync(join(FIX, "tls-pin-b.pem")), key: readFileSync(join(FIX, "tls-pin-b.key")) };
const HOST = "127.0.0.1";

let server: Server | null = null;
let port = 0;
let requests = 0;

async function serveWith(tls: { cert: Buffer; key: Buffer }): Promise<void> {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = createServer(tls, (_req, res) => { requests++; res.end("ok"); });
  // Re-listen on the SAME port so the pin's host:port is the same endpoint.
  await new Promise<void>((r) => server!.listen(port, HOST, r));
  port = (server.address() as AddressInfo).port;
}

function get(): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, path: "/", agent: pinnedAgentFor(HOST, port), headers: { authorization: "Basic c2VjcmV0" } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await prisma.tlsCertPin.deleteMany({ where: { host: HOST } });
  _resetCaches();
  await serveWith(tlsA);
});

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (!dbReachable) return;
  await prisma.tlsCertPin.deleteMany({ where: { host: HOST } });
  await prisma.event.deleteMany({ where: { resourceType: "tls-cert-pin", resourceName: { startsWith: `${HOST}:` } } });
  await prisma.$disconnect();
});

d("TLS certificate pinning (rule 113)", () => {
  it("pins the certificate on first use and sends the request", async () => {
    expect(await get()).toBe(200);
    const pins = (await listCertPins()).filter((p) => p.host === HOST && p.port === port);
    expect(pins).toHaveLength(1);
    expect(pins[0].subject).toBe("polaris-tls-pin-test-a");
    expect(requests).toBe(1);
  });

  it("accepts the same certificate again", async () => {
    expect(await get()).toBe(200);
    expect(requests).toBe(2);
  });

  it("refuses a different certificate on the same address, before the request is written", async () => {
    await serveWith(tlsB);
    await expect(get()).rejects.toBeInstanceOf(CertPinRefusedError);
    expect(requests).toBe(2);
    const ev = await prisma.event.findFirst({ where: { action: "tls.cert.mismatch", resourceName: `${HOST}:${port}` }, orderBy: { timestamp: "desc" } });
    expect(ev?.level).toBe("warning");
  });

  it("re-pins the new certificate after the pin is deleted", async () => {
    const pin = (await listCertPins()).find((p) => p.host === HOST && p.port === port)!;
    await deleteCertPin(pin.id, "test");
    expect(await get()).toBe(200);
    const fresh = (await listCertPins()).find((p) => p.host === HOST && p.port === port)!;
    expect(fresh.subject).toBe("polaris-tls-pin-test-b");
    expect(fresh.fingerprint).not.toBe(pin.fingerprint);
  });
});
