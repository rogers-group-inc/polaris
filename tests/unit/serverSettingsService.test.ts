/**
 * tests/unit/serverSettingsService.test.ts — NTP settings and the uploaded
 * certificate list (CQ-T010).
 *
 * `testNtpSync` used to answer "Synchronized" with an invented offset without
 * contacting anything (found 2026-11-11, pinned then fixed the same day). It
 * now queries every server for real (src/utils/sntp.ts, tested on loopback in
 * sntp.test.ts); here the query is injected through its `deps` seam.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getNtpSettings, updateNtpSettings, testNtpSync, listCertificates, addCertificate, deleteCertificate,
  type CertificateRecord, type NtpTestDeps,
} from "../../src/services/serverSettingsService.js";

const findUnique = stubbed(prisma.setting.findUnique);
const upsert = stubbed(prisma.setting.upsert);
const update = stubbed(prisma.setting.update);

beforeEach(() => resetDbStub());

describe("NTP settings", () => {
  it("no row reads as the disabled default", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getNtpSettings()).toEqual({ enabled: false, mode: "ntp", servers: [], timezoneOverride: null });
  });

  it("a stored partial value is filled from the default", async () => {
    findUnique.mockResolvedValue({ value: { enabled: true, servers: ["pool.ntp.org"] } });
    expect(await getNtpSettings()).toEqual({ enabled: true, mode: "ntp", servers: ["pool.ntp.org"], timezoneOverride: null });
  });

  it("an update merges over the current value and stores the merge", async () => {
    findUnique.mockResolvedValue({ value: { enabled: true, servers: ["a"] } });
    const r = await updateNtpSettings({ mode: "nts" });
    expect(r).toEqual({ enabled: true, mode: "nts", servers: ["a"], timezoneOverride: null });
    expect(upsert.mock.calls[0][0].update.value).toEqual(r);
  });

  it("a test with no servers is refused", async () => {
    expect(await testNtpSync({ mode: "ntp", servers: [" "] })).toEqual({ ok: false, message: "No NTP servers configured", results: [] });
  });
});

describe("testNtpSync — a real query per server (was an invented success until 2026-11-11)", () => {
  const sample = (over: Record<string, unknown> = {}) => ({ offsetMs: 12, delayMs: 23.4, stratum: 2, refId: "10.0.0.1", address: "a", ...over });
  const deps = (over: Partial<NtpTestDeps> = {}): NtpTestDeps => ({
    querySntp: vi.fn(async () => sample()) as any,
    checkNtsKe: vi.fn(async () => { throw new Error("not used"); }) as any,
    ...over,
  });

  it("queries every distinct server and reports each one's stratum, offset and delay", async () => {
    const d = deps();
    const r = await testNtpSync({ mode: "ntp", servers: ["a.example", "b.example", "a.example"] }, d);
    expect(d.querySntp).toHaveBeenCalledTimes(2);
    expect(r.ok).toBe(true);
    expect(r.message).toBe("a.example: stratum 2, offset +0.012 s, delay 23 ms; b.example: stratum 2, offset +0.012 s, delay 23 ms");
  });

  it("a server that does not answer fails the test and says why; the others still report", async () => {
    const d = deps({
      querySntp: vi.fn(async (host: string) => { if (host === "192.0.2.1") throw new Error("no answer within 3 s"); return sample(); }) as any,
    });
    const r = await testNtpSync({ mode: "ntp", servers: ["192.0.2.1", "ok.example"] }, d);
    expect(r.ok).toBe(false);
    expect(r.results.map((x) => x.ok)).toEqual([false, true]);
    expect(r.message).toContain("192.0.2.1: no answer within 3 s");
  });

  it("says so when this server's clock is more than a second off", async () => {
    const r = await testNtpSync({ mode: "sntp", servers: ["a"] }, deps({ querySntp: vi.fn(async () => sample({ offsetMs: 4200 })) as any }));
    expect(r.ok).toBe(true);
    expect(r.message).toContain("the Polaris server's clock is 4.2 s behind it");
  });

  it("NTS runs the key exchange first, takes the time from the server it names, and says the sample was not NTS-authenticated", async () => {
    const d = deps({ checkNtsKe: vi.fn(async () => ({ complete: true, protocols: [0], aead: [15], cookies: 8, server: "time.example", port: 1123, error: null })) as any });
    const r = await testNtpSync({ mode: "nts", servers: ["nts.example"] }, d);
    expect(d.querySntp).toHaveBeenCalledWith("time.example", { port: 1123 });
    expect(r.message).toMatch(/^nts\.example: NTS key exchange OK \(8 cookies\); stratum 2.*not NTS-authenticated/);
    const refused = await testNtpSync({ mode: "nts", servers: ["x"] }, deps({ checkNtsKe: vi.fn(async () => { throw new Error("NTS key exchange: no ntske/1 ALPN"); }) as any }));
    expect(refused).toMatchObject({ ok: false, message: "x: NTS key exchange: no ntske/1 ALPN" });
  });
});

describe("certificates", () => {
  const cert = (over: Partial<CertificateRecord>): CertificateRecord => ({
    id: "x", category: "ca", type: "cert", name: "n", subject: null, issuer: null, expiresAt: null, uploadedAt: "", pem: "", ...over,
  });

  it("lists trusted CAs and server certificates apart; no row is two empty lists", async () => {
    findUnique.mockResolvedValueOnce(null);
    expect(await listCertificates()).toEqual({ trustedCAs: [], serverCerts: [] });
    findUnique.mockResolvedValueOnce({ value: [cert({ id: "1", category: "ca" }), cert({ id: "2", category: "server" })] });
    const r = await listCertificates();
    expect(r.trustedCAs.map((c) => c.id)).toEqual(["1"]);
    expect(r.serverCerts.map((c) => c.id)).toEqual(["2"]);
  });

  it("an upload is typed key or cert from the name or the PEM, and appended", async () => {
    // A fresh array per read: the service appends to what it read.
    findUnique.mockImplementation(async () => ({ value: [cert({ id: "old" })] }));
    const key = await addCertificate("server", "server.key", "-----BEGIN PRIVATE KEY-----");
    expect(key).toMatchObject({ category: "server", type: "key", name: "server.key", subject: "Private Key" });
    const crt = await addCertificate("ca", "root.pem", "subject= CN=Root CA\n-----BEGIN CERTIFICATE-----");
    expect(crt).toMatchObject({ type: "cert", subject: "CN=Root CA" });
    expect(upsert.mock.calls[0][0].update.value.map((c: CertificateRecord) => c.id)).toEqual(["old", key.id]);
  });

  it("a delete drops only that id; with no row it does nothing", async () => {
    findUnique.mockResolvedValueOnce(null);
    await deleteCertificate("1");
    expect(update).not.toHaveBeenCalled();
    findUnique.mockResolvedValueOnce({ value: [cert({ id: "1" }), cert({ id: "2" })] });
    await deleteCertificate("1");
    expect(update.mock.calls[0][0].data.value.map((c: CertificateRecord) => c.id)).toEqual(["2"]);
  });
});
