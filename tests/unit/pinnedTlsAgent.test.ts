/**
 * tests/unit/pinnedTlsAgent.test.ts
 *
 * Business rule 113: the pinning agent decides AFTER the TLS handshake and
 * BEFORE the request is written. Against a real local HTTPS server with a
 * self-signed certificate: an accepted certificate carries the request, a
 * refused one fails it with CertPinRefusedError and the server never sees the
 * request (so never sees the Authorization header). Also the firmware
 * engines' Fortinet serial pre-check, which is pure.
 *
 * The two certificates under tests/fixtures/tls-pin-{a,b}.{pem,key} are
 * throwaway self-signed test keys, valid for 100 years, used nowhere else.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, request, type Server } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { X509Certificate } from "node:crypto";
import type { AddressInfo } from "node:net";
import { PinnedTlsAgent, CertPinRefusedError } from "../../src/utils/pinnedTlsAgent.js";
import { fortinetSerialPrecheck } from "../../src/services/firmwareEngines/deviceHttp.js";

const FIX = join(__dirname, "..", "fixtures");
const certA = { cert: readFileSync(join(FIX, "tls-pin-a.pem")), key: readFileSync(join(FIX, "tls-pin-a.key")) };
const fingerprintA = new X509Certificate(certA.cert).fingerprint256;

let server: Server | null = null;
let seen: Array<string | undefined> = [];

async function serve(): Promise<number> {
  seen = [];
  server = createServer(certA, (req, res) => {
    seen.push(req.headers.authorization);
    res.end("ok");
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

function get(port: number, agent: PinnedTlsAgent): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/wsman", method: "GET", agent, headers: { authorization: "Basic c2VjcmV0" } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("PinnedTlsAgent", () => {
  it("sends the request when the check accepts the certificate", async () => {
    const port = await serve();
    const checked: string[] = [];
    const agent = new PinnedTlsAgent(async (cert) => { checked.push(cert.fingerprint256); return { ok: true }; });
    const res = await get(port, agent);
    expect(res).toEqual({ status: 200, body: "ok" });
    expect(checked).toEqual([fingerprintA]);
    expect(seen).toEqual(["Basic c2VjcmV0"]);
  });

  it("refuses before the request is written when the check rejects", async () => {
    const port = await serve();
    const agent = new PinnedTlsAgent(async () => ({ ok: false, reason: "certificate changed" }));
    await expect(get(port, agent)).rejects.toBeInstanceOf(CertPinRefusedError);
    // Give the server a moment: nothing must ever arrive.
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toEqual([]);
  });

  it("fails closed when the check itself throws", async () => {
    const port = await serve();
    const agent = new PinnedTlsAgent(async () => { throw new Error("db down"); });
    await expect(get(port, agent)).rejects.toThrow(/Could not check the server certificate: db down/);
    expect(seen).toEqual([]);
  });

  it("checks every connection — no session resumption, no keep-alive", async () => {
    const port = await serve();
    let calls = 0;
    const agent = new PinnedTlsAgent(async () => { calls++; return { ok: true }; });
    await get(port, agent);
    await get(port, agent);
    expect(calls).toBe(2);
  });
});

describe("fortinetSerialPrecheck", () => {
  const factory = (cn: string) => ({ subject: { C: "US", O: "Fortinet", OU: "FortiGate", CN: cn } as never });

  it("accepts a factory certificate naming the asset's serial (any case)", () => {
    expect(fortinetSerialPrecheck("FGT60FTK21000001", factory("fgt60ftk21000001"))).toEqual({ ok: true });
  });

  it("refuses a factory certificate naming a different serial", () => {
    const v = fortinetSerialPrecheck("FGT60FTK21000001", factory("FGT60FTK29999999"));
    expect(v.ok).toBe(false);
    expect(v.ok ? "" : v.reason).toMatch(/FGT60FTK29999999.*FGT60FTK21000001/);
  });

  it("leaves an operator-installed certificate, and an asset with no serial, to the pin", () => {
    expect(fortinetSerialPrecheck("FGT60FTK21000001", { subject: { O: "Rogers", CN: "fw1.corp.example" } as never })).toEqual({ ok: true });
    expect(fortinetSerialPrecheck("FGT60FTK21000001", { subject: { O: "Fortinet", CN: "fw1.corp.example" } as never })).toEqual({ ok: true });
    expect(fortinetSerialPrecheck(null, factory("FGT60FTK29999999"))).toEqual({ ok: true });
  });
});
