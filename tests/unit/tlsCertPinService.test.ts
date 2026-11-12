/**
 * tests/unit/tlsCertPinService.test.ts — CQ-T010, business rule 113 (TOFU
 * TLS certificate pinning; (f) remembered pending certificate + trust exactly
 * that one; (g) post-upgrade re-pin window).
 *
 * Complements tests/unit/tlsEndpointsForAsset.test.ts (the pure endpoint
 * list) and tests/integration/tlsCertPin.test.ts / tlsPinnedDispatcher.test.ts
 * (the real table and the TLS dispatcher end to end). This file drives the
 * DECISION logic on the shared _dbStub with no database: first-use pin, the
 * unique-index race, the per-process cache, the once-per-new-certificate
 * mismatch Event, the re-pin window, trustPendingCert's stale-page 409, the
 * hourly lastSeen throttle, and the list ordering / owner lookup.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  _resetCaches,
  allowRepin,
  assetTlsEndpoints,
  changedCertPins,
  deleteCertPin,
  forgetCachedCertPin,
  listCertPins,
  listCertPinsWithUsers,
  normalizeFingerprint,
  trustPendingCert,
  verifyOrPinCert,
} from "../../src/services/tlsCertPinService.js";

const NOW = new Date("2026-04-15T10:00:00Z");
const FP_A = "AA:BB:CC";
const FP_B = "dd:ee:ff";

function pin(over: Record<string, unknown> = {}) {
  return {
    id: "p1", host: "10.0.0.1", port: 443, fingerprint: "AABBCC", subject: "CN=gate",
    firstSeen: NOW, lastSeen: NOW, pendingFingerprint: null, pendingSubject: null, pendingSeenAt: null, repinUntil: null,
    ...over,
  };
}

const actions = () => eventLog.logEvent.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  _resetCaches();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(prisma.tlsCertPin.update).mockResolvedValue({} as never);
});
afterEach(() => vi.useRealTimers());

describe("normalizeFingerprint", () => {
  it("strips separators and uppercases", () => {
    expect(normalizeFingerprint("aa:bb-cc dd")).toBe("AABBCCDD");
  });
  it("drops non-hex characters entirely", () => {
    expect(normalizeFingerprint("zz12")).toBe("12");
  });
});

describe("verifyOrPinCert — first use", () => {
  it("pins an unseen endpoint, normalizing the fingerprint and truncating the subject", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(null as never);
    const v = await verifyOrPinCert("10.0.0.1", 443, FP_A, "x".repeat(600));
    expect(v).toEqual({ ok: true, outcome: "pinned" });
    const data = vi.mocked(prisma.tlsCertPin.create).mock.calls[0]![0].data as Record<string, unknown>;
    expect(data.fingerprint).toBe("AABBCC");
    expect((data.subject as string).length).toBe(500);
    expect(actions()).toEqual(["tls.cert.pinned"]);
  });

  it("the second call is served from the cache without a DB read", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(null as never);
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    vi.mocked(prisma.tlsCertPin.findUnique).mockClear();
    expect(await verifyOrPinCert("10.0.0.1", 443, "aabbcc")).toEqual({ ok: true, outcome: "matched" });
    expect(prisma.tlsCertPin.findUnique).not.toHaveBeenCalled();
  });

  it("losing the unique-index race to the SAME certificate still counts as pinned", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(pin() as never);
    vi.mocked(prisma.tlsCertPin.create).mockRejectedValue(new Error("P2002"));
    expect(await verifyOrPinCert("10.0.0.1", 443, FP_A)).toEqual({ ok: true, outcome: "pinned" });
  });

  it("losing the race to a DIFFERENT certificate is a mismatch with a warning Event", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique)
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(pin() as never);
    vi.mocked(prisma.tlsCertPin.create).mockRejectedValue(new Error("P2002"));
    const v = await verifyOrPinCert("10.0.0.1", 443, FP_B);
    expect(v).toEqual({ ok: false, outcome: "mismatch", expected: "AABBCC", actual: "DDEEFF" });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ action: "tls.cert.mismatch", level: "warning" });
  });
});

describe("verifyOrPinCert — an existing pin", () => {
  it("a match refreshes lastSeen, then not again within the hour", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin() as never);
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    await vi.waitFor(() => expect(prisma.tlsCertPin.update).toHaveBeenCalledTimes(1));
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    vi.setSystemTime(new Date(NOW.getTime() + 59 * 60_000));
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    await Promise.resolve();
    expect(prisma.tlsCertPin.update).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(NOW.getTime() + 61 * 60_000));
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    await vi.waitFor(() => expect(prisma.tlsCertPin.update).toHaveBeenCalledTimes(2));
  });

  it("a match clears a stale pending certificate (the pinned one came back)", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin({ pendingFingerprint: "DDEEFF" }) as never);
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    expect(prisma.tlsCertPin.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { pendingFingerprint: null, pendingSubject: null, pendingSeenAt: null },
    });
  });

  it("a changed certificate is refused, remembered as pending, and reported (113(f))", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin() as never);
    const v = await verifyOrPinCert("10.0.0.1", 443, FP_B, "CN=new");
    expect(v).toEqual({ ok: false, outcome: "mismatch", expected: "AABBCC", actual: "DDEEFF" });
    expect(prisma.tlsCertPin.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { pendingFingerprint: "DDEEFF", pendingSubject: "CN=new", pendingSeenAt: NOW },
    });
    expect(actions()).toEqual(["tls.cert.mismatch"]);
    expect(eventLog.logEvent.mock.calls[0]![0].details).toMatchObject({ expectedFingerprint: "AABBCC", actualFingerprint: "DDEEFF" });
  });

  it("the same refused certificate is reported only once (already pending)", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin({ pendingFingerprint: "DDEEFF" }) as never);
    const v = await verifyOrPinCert("10.0.0.1", 443, FP_B);
    expect(v.ok).toBe(false);
    expect(prisma.tlsCertPin.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a cached mismatch is re-read from the DB (an operator may have deleted the pin)", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValueOnce(pin() as never);
    await verifyOrPinCert("10.0.0.1", 443, FP_B);
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValueOnce(null as never);
    expect(await verifyOrPinCert("10.0.0.1", 443, FP_B)).toEqual({ ok: true, outcome: "pinned" });
  });

  it("a failed pending write does not prevent the refusal", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin() as never);
    vi.mocked(prisma.tlsCertPin.update).mockRejectedValue(new Error("db down"));
    expect((await verifyOrPinCert("10.0.0.1", 443, FP_B)).ok).toBe(false);
  });

  it("inside the re-pin window a change is accepted and re-pinned (113(g))", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(
      pin({ repinUntil: new Date(NOW.getTime() + 60_000), pendingFingerprint: "112233" }) as never,
    );
    const v = await verifyOrPinCert("10.0.0.1", 443, FP_B, "CN=new");
    expect(v).toEqual({ ok: true, outcome: "pinned" });
    expect(vi.mocked(prisma.tlsCertPin.update).mock.calls[0]![0].data).toMatchObject({
      fingerprint: "DDEEFF", pendingFingerprint: null, pendingSubject: null, pendingSeenAt: null,
    });
    // The window is NOT closed on the first change: repinUntil is not written.
    expect(vi.mocked(prisma.tlsCertPin.update).mock.calls[0]![0].data).not.toHaveProperty("repinUntil");
    expect(actions()).toEqual(["tls.cert.repinned"]);
  });

  it("an expired re-pin window refuses as usual", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin({ repinUntil: new Date(NOW.getTime() - 1) }) as never);
    expect((await verifyOrPinCert("10.0.0.1", 443, FP_B)).ok).toBe(false);
  });

  it("pins are per host:port", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(null as never);
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    await verifyOrPinCert("10.0.0.1", 8443, FP_B);
    expect(prisma.tlsCertPin.create).toHaveBeenCalledTimes(2);
  });

  it("forgetCachedCertPin forces the next call back to the DB", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(null as never);
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    forgetCachedCertPin("10.0.0.1", 443);
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin() as never);
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    expect(prisma.tlsCertPin.findUnique).toHaveBeenCalledTimes(2);
  });
});

describe("trustPendingCert", () => {
  it("404 for an unknown pin", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(null as never);
    await expect(trustPendingCert("x", FP_B, "alice")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("409 when nothing is pending", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin() as never);
    await expect(trustPendingCert("p1", FP_B, "alice")).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("409 when the server has since presented another certificate (stale page)", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(pin({ pendingFingerprint: "112233" }) as never);
    await expect(trustPendingCert("p1", FP_B, "alice")).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.tlsCertPin.update).not.toHaveBeenCalled();
  });

  it("trusts exactly the pending certificate (separator-insensitive), closes any window, audits, and caches it", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(
      pin({ pendingFingerprint: "DDEEFF", pendingSubject: "CN=new", repinUntil: NOW }) as never,
    );
    vi.mocked(prisma.tlsCertPin.update).mockResolvedValue(pin({ fingerprint: "DDEEFF" }) as never);
    await trustPendingCert("p1", "dd-ee-ff", "alice");
    expect(vi.mocked(prisma.tlsCertPin.update).mock.calls[0]![0].data).toMatchObject({
      fingerprint: "DDEEFF", subject: "CN=new", pendingFingerprint: null, repinUntil: null,
    });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ action: "tls.cert.trusted", actor: "alice", level: "warning" });
    vi.mocked(prisma.tlsCertPin.findUnique).mockClear();
    expect(await verifyOrPinCert("10.0.0.1", 443, FP_B)).toEqual({ ok: true, outcome: "matched" });
    expect(prisma.tlsCertPin.findUnique).not.toHaveBeenCalled();
  });
});

describe("allowRepin", () => {
  it("no host or no ports is a no-op", async () => {
    expect(await allowRepin("", [443], 10, "system")).toBe(0);
    expect(await allowRepin("h", [], 10, "system")).toBe(0);
    expect(prisma.tlsCertPin.updateMany).not.toHaveBeenCalled();
  });

  it("opens the window on existing pins and audits only when something was touched", async () => {
    vi.mocked(prisma.tlsCertPin.updateMany).mockResolvedValue({ count: 2 } as never);
    expect(await allowRepin("10.0.0.1", [443, 8443], 15, "system:firmware")).toBe(2);
    expect(prisma.tlsCertPin.updateMany).toHaveBeenCalledWith({
      where: { host: "10.0.0.1", port: { in: [443, 8443] } },
      data: { repinUntil: new Date(NOW.getTime() + 15 * 60_000) },
    });
    expect(actions()).toEqual(["tls.cert.repin_window"]);

    resetEventLogStub();
    vi.mocked(prisma.tlsCertPin.updateMany).mockResolvedValue({ count: 0 } as never);
    expect(await allowRepin("10.9.9.9", [443], 15, "system")).toBe(0);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("deleteCertPin", () => {
  it("404 for an unknown pin", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValue(null as never);
    await expect(deleteCertPin("x", "alice")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("deletes, audits as a warning, and re-opens first-use trust", async () => {
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValueOnce(null as never);
    await verifyOrPinCert("10.0.0.1", 443, FP_A);
    resetEventLogStub();
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValueOnce(pin() as never);
    await deleteCertPin("p1", "alice");
    expect(prisma.tlsCertPin.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ action: "tls.cert.deleted", level: "warning", actor: "alice" });
    vi.mocked(prisma.tlsCertPin.findUnique).mockResolvedValueOnce(null as never);
    expect(await verifyOrPinCert("10.0.0.1", 443, FP_B)).toEqual({ ok: true, outcome: "pinned" });
  });
});

describe("listings", () => {
  it("listCertPins puts changed certificates first, preserving host order within each group", async () => {
    vi.mocked(prisma.tlsCertPin.findMany).mockResolvedValue([
      pin({ id: "a", host: "a" }), pin({ id: "b", host: "b", pendingFingerprint: "X" }), pin({ id: "c", host: "c" }),
    ] as never);
    expect((await listCertPins()).map((p) => p.id)).toEqual(["b", "a", "c"]);
  });

  it("listCertPinsWithUsers returns [] without querying owners when there are no pins", async () => {
    vi.mocked(prisma.tlsCertPin.findMany).mockResolvedValue([] as never);
    expect(await listCertPinsWithUsers()).toEqual([]);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("listCertPinsWithUsers matches assets by IP or hostname (case-insensitive) and integrations by config host, without leaking config", async () => {
    vi.mocked(prisma.tlsCertPin.findMany).mockResolvedValue([pin({ host: "FMG.example" }), pin({ id: "p2", host: "10.0.0.1" })] as never);
    vi.mocked(prisma.asset.findMany).mockResolvedValue([
      { id: "a1", hostname: "fmg.example", ipAddress: "10.5.5.5" },
      { id: "a2", hostname: "gate", ipAddress: "10.0.0.1" },
    ] as never);
    vi.mocked(prisma.integration.findMany).mockResolvedValue([
      { id: "i1", name: "FMG", type: "fortimanager", config: { host: " fmg.EXAMPLE ", apiToken: "secret" } },
      { id: "i2", name: "Other", type: "fortigate", config: null },
    ] as never);
    const out = await listCertPinsWithUsers();
    expect(out[0]!.assets.map((a) => a.id)).toEqual(["a1"]);
    expect(out[0]!.integrations).toEqual([{ id: "i1", name: "FMG", type: "fortimanager" }]);
    expect(out[1]!.assets.map((a) => a.id)).toEqual(["a2"]);
    expect(out[1]!.integrations).toEqual([]);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("changedCertPins asks only for pending rows, oldest first", async () => {
    vi.mocked(prisma.tlsCertPin.findMany).mockResolvedValue([] as never);
    await changedCertPins();
    expect(prisma.tlsCertPin.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { pendingFingerprint: { not: null } },
      orderBy: { pendingSeenAt: "asc" },
    }));
  });

  it("assetTlsEndpoints attaches each endpoint's pin, null when not pinned, and skips the query with no endpoints", async () => {
    vi.mocked(prisma.tlsCertPin.findMany).mockResolvedValue([pin({ host: "fmg", port: 443 })] as never);
    const eps = await assetTlsEndpoints(
      { assetType: "firewall", ipAddress: "10.0.0.1" },
      { type: "fortimanager", name: "F", config: { host: "fmg", useProxy: false } },
    );
    expect(eps.map((e) => [e.host, e.pin?.id ?? null])).toEqual([["fmg", "p1"], ["10.0.0.1", null]]);

    vi.mocked(prisma.tlsCertPin.findMany).mockClear();
    expect(await assetTlsEndpoints({ assetType: "server", ipAddress: null }, null)).toEqual([]);
    expect(prisma.tlsCertPin.findMany).not.toHaveBeenCalled();
  });
});
