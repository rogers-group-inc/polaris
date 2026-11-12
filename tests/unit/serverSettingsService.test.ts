/**
 * tests/unit/serverSettingsService.test.ts — the server timezone (business
 * rule 168) and the uploaded certificate list (CQ-T010).
 *
 * The timezone override is applied to the PROCESS (process.env.TZ), so every
 * test that applies one restores the zone it found in afterEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  applyProcessTimezone, getServerTimezone, setServerTimezone, refreshProcessTimezone,
  listCertificates, addCertificate, deleteCertificate,
  type CertificateRecord,
} from "../../src/services/serverSettingsService.js";

const findUnique = stubbed(prisma.setting.findUnique);
const upsert = stubbed(prisma.setting.upsert);
const update = stubbed(prisma.setting.update);

const zoneNow = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const START_ZONE = zoneNow();
// A zone far from any CI runner's, so "it moved" cannot pass by accident.
const OTHER = START_ZONE === "Asia/Tokyo" ? "America/Chicago" : "Asia/Tokyo";

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
});

describe("server timezone (business rule 168)", () => {
  afterEach(() => { applyProcessTimezone(null); });

  it("the override moves this process's clock — Intl and Date local getters both", () => {
    expect(applyProcessTimezone(OTHER)).toBe(OTHER);
    expect(zoneNow()).toBe(OTHER);
    const d = new Date("2026-07-01T12:00:00Z");
    const expectedHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: OTHER, hour: "numeric", hourCycle: "h23" }).format(d));
    expect(d.getHours()).toBe(expectedHour);
  });

  it("clearing the override puts the host's zone back (deleting TZ would not)", () => {
    applyProcessTimezone(OTHER);
    expect(applyProcessTimezone(null)).toBe(START_ZONE);
    expect(zoneNow()).toBe(START_ZONE);
  });

  it("a zone this build cannot format in falls back to the host's zone, never Node's silent UTC", () => {
    applyProcessTimezone(OTHER);
    expect(applyProcessTimezone("Mars/Olympus")).toBe(START_ZONE);
  });

  it("no row reads as no override, running in the host's zone", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getServerTimezone()).toEqual({ override: null, effective: START_ZONE, host: START_ZONE });
  });

  it("a stored zone this build cannot use reads as no override", async () => {
    findUnique.mockResolvedValue({ value: { override: "Nowhere/Nothing" } });
    expect((await getServerTimezone()).override).toBeNull();
  });

  it("a save stores the zone, applies it at once and audits the change", async () => {
    findUnique.mockResolvedValue(null);
    upsert.mockResolvedValue({});
    const out = await setServerTimezone(` ${OTHER} `, "admin");
    expect(out).toEqual({ override: OTHER, effective: OTHER, host: START_ZONE });
    expect(upsert.mock.calls[0][0]).toMatchObject({ where: { key: "timezone" }, update: { value: { override: OTHER } } });
    expect(zoneNow()).toBe(OTHER);
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "server.timezone.changed", actor: "admin", details: { before: null, after: OTHER },
    });
  });

  it("re-saving the same zone writes no audit event", async () => {
    findUnique.mockResolvedValue({ value: { override: OTHER } });
    upsert.mockResolvedValue({});
    await setServerTimezone(OTHER);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("an empty value clears the override", async () => {
    findUnique.mockResolvedValue({ value: { override: OTHER } });
    upsert.mockResolvedValue({});
    applyProcessTimezone(OTHER);
    const out = await setServerTimezone("  ");
    expect(out.override).toBeNull();
    expect(out.effective).toBe(START_ZONE);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ details: { before: OTHER, after: null } });
  });

  it("an unknown zone is a 400 and changes nothing", async () => {
    await expect(setServerTimezone("Mars/Olympus")).rejects.toMatchObject({ httpStatus: 400 });
    expect(upsert).not.toHaveBeenCalled();
    expect(zoneNow()).toBe(START_ZONE);
  });

  it("the refresh tick applies what another role saved", async () => {
    findUnique.mockResolvedValue({ value: { override: OTHER } });
    await refreshProcessTimezone();
    expect(zoneNow()).toBe(OTHER);
  });

  it("a refresh that cannot read the setting keeps the zone in force and does not throw", async () => {
    applyProcessTimezone(OTHER);
    findUnique.mockRejectedValue(new Error("db down"));
    await expect(refreshProcessTimezone()).resolves.toBeUndefined();
    expect(zoneNow()).toBe(OTHER);
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
