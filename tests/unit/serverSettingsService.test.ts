/**
 * tests/unit/serverSettingsService.test.ts — NTP settings and the uploaded
 * certificate list (CQ-T010).
 *
 * BUG FOUND (pinned with it.fails, 2026-11-11): `testNtpSync` never contacts a
 * server. With any server configured it answers ok: true, "Synchronized with
 * <server> (offset: +0.003s, …)" — a fixed, invented offset — and the Server
 * Settings → NTP "Test" button (POST /server-settings/ntp/test) shows that to
 * the operator as a real result. The it.fails case below flips to `it` once
 * the test really queries the server.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getNtpSettings, updateNtpSettings, testNtpSync, listCertificates, addCertificate, deleteCertificate, type CertificateRecord,
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
    expect(await testNtpSync({ mode: "ntp", servers: [] })).toEqual({ ok: false, message: "No NTP servers configured" });
  });

  it.fails("a test against a server that cannot answer does not report a sync (testNtpSync never queries)", async () => {
    // 192.0.2.0/24 is TEST-NET-1: nothing answers there.
    const r = await testNtpSync({ mode: "ntp", servers: ["192.0.2.1"] });
    expect(r.ok).toBe(false);
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
