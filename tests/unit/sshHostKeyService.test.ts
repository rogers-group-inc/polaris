/**
 * tests/unit/sshHostKeyService.test.ts — own unit suite for
 * src/services/sshHostKeyService.ts (CQ-T010 batch 8c).
 *
 * sshHostKey.test.ts covers the TOFU happy paths against an in-memory table
 * and buildHostVerifier; this suite drives the service against bare Prisma
 * spies to reach what that one cannot: the cache hit that never reads the
 * table, the create-failure branch of the first-connect race, the
 * never-overwrite rule, forgetCachedHostKey (rule 123), swallowed bookkeeping
 * failures, and the asset join's matching rules.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ debug: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/logger.js", () => ({ logger: { debug: h.debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  _resetCaches,
  deleteHostKey,
  fingerprintKeyBlob,
  forgetCachedHostKey,
  keyTypeFromBlob,
  listHostKeys,
  listHostKeysWithAssets,
  verifyOrPin,
} from "../../src/services/sshHostKeyService.js";

function blob(type: string, seed: number): Buffer {
  const name = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length, 0);
  return Buffer.concat([len, name, Buffer.alloc(32, seed)]);
}

const KEY_A = blob("ssh-ed25519", 1);
const KEY_B = blob("ssh-ed25519", 2);
const FP_A = fingerprintKeyBlob(KEY_A);
const FP_B = fingerprintKeyBlob(KEY_B);

function pin(host: string, port: number, fingerprint: string, id = "hk-1") {
  return { id, host, port, keyType: "ssh-ed25519", fingerprint, firstSeen: new Date(), lastSeen: new Date() };
}

const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  _resetCaches();
  h.debug.mockReset();
  stubbed(prisma.sshHostKey.update).mockResolvedValue({});
  stubbed(prisma.sshHostKey.create).mockResolvedValue({});
});

describe("fingerprintKeyBlob", () => {
  it("is ssh-keygen's SHA256:<unpadded base64>", () => {
    expect(fingerprintKeyBlob(Buffer.from(""))).toBe("SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU");
    expect(FP_A).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
    expect(FP_A).not.toBe(FP_B);
  });
});

describe("keyTypeFromBlob", () => {
  it("reads ecdsa / rsa names", () => {
    expect(keyTypeFromBlob(blob("ecdsa-sha2-nistp256", 1))).toBe("ecdsa-sha2-nistp256");
    expect(keyTypeFromBlob(blob("ssh-rsa", 1))).toBe("ssh-rsa");
  });

  it("degrades to unknown on a short buffer, zero or >64 declared length, overrun, or non-printable name", () => {
    expect(keyTypeFromBlob(Buffer.from([0, 0, 1]))).toBe("unknown");
    expect(keyTypeFromBlob(Buffer.from([0, 0, 0, 0, 1, 2]))).toBe("unknown");
    const huge = Buffer.alloc(80);
    huge.writeUInt32BE(65, 0);
    expect(keyTypeFromBlob(huge)).toBe("unknown");
    const overrun = Buffer.alloc(8);
    overrun.writeUInt32BE(10, 0);
    expect(keyTypeFromBlob(overrun)).toBe("unknown");
    const ctrl = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from([0x01, 0x41, 0x42])]);
    expect(keyTypeFromBlob(ctrl)).toBe("unknown");
  });

  it("accepts a name of exactly 64 bytes", () => {
    expect(keyTypeFromBlob(blob("x".repeat(64), 1))).toBe("x".repeat(64));
  });
});

describe("verifyOrPin", () => {
  it("pins a first-seen key with its type and audits ssh.host_key.pinned", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(null);
    expect(await verifyOrPin("10.0.0.5", 22, KEY_A)).toEqual({ ok: true, outcome: "pinned" });
    expect(stubbed(prisma.sshHostKey.findUnique).mock.calls[0][0]).toEqual({ where: { host_port: { host: "10.0.0.5", port: 22 } } });
    expect(stubbed(prisma.sshHostKey.create).mock.calls[0][0]).toEqual({
      data: { host: "10.0.0.5", port: 22, keyType: "ssh-ed25519", fingerprint: FP_A },
    });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "ssh.host_key.pinned",
      resourceType: "ssh-host-key",
      resourceName: "10.0.0.5:22",
      actor: "system:ssh",
      level: "info",
      details: { host: "10.0.0.5", port: 22, keyType: "ssh-ed25519", fingerprint: FP_A },
    });
  });

  it("serves a matching key from the cache without reading the table again", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(pin("10.0.0.5", 22, FP_A));
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    expect(await verifyOrPin("10.0.0.5", 22, KEY_A)).toEqual({ ok: true, outcome: "matched" });
    expect(prisma.sshHostKey.findUnique).toHaveBeenCalledTimes(1);
  });

  it("a cache hit that disagrees re-reads the table before refusing", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(pin("10.0.0.5", 22, FP_A));
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    const v = await verifyOrPin("10.0.0.5", 22, KEY_B);
    expect(prisma.sshHostKey.findUnique).toHaveBeenCalledTimes(2);
    expect(v).toEqual({ ok: false, outcome: "mismatch", expected: FP_A, actual: FP_B });
  });

  it("a mismatch never overwrites the pin and is audited at warning with both fingerprints", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(pin("10.0.0.5", 22, FP_A));
    await verifyOrPin("10.0.0.5", 22, KEY_B);
    expect(prisma.sshHostKey.create).not.toHaveBeenCalled();
    expect(prisma.sshHostKey.update).not.toHaveBeenCalled();
    expect(prisma.sshHostKey.upsert).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "ssh.host_key.mismatch",
      level: "warning",
      details: { expectedFingerprint: FP_A, actualFingerprint: FP_B },
    });
  });

  it("a failing mismatch audit still refuses the key", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(pin("10.0.0.5", 22, FP_A));
    eventLog.logEvent.mockRejectedValue(new Error("event table down"));
    expect((await verifyOrPin("10.0.0.5", 22, KEY_B)).ok).toBe(false);
  });

  it("keys pins per host AND port, including an IPv6 host", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(null);
    await verifyOrPin("2001:db8::5", 22, KEY_A);
    await verifyOrPin("2001:db8::5", 2222, KEY_A);
    expect(prisma.sshHostKey.create).toHaveBeenCalledTimes(2);
    expect(eventLog.logEvent.mock.calls[0][0].resourceName).toBe("2001:db8::5:22");
    expect(eventLog.logEvent.mock.calls[1][0].resourceName).toBe("2001:db8::5:2222");
  });

  it("the race loser that finds a DIFFERENT winner refuses as a mismatch and caches the winner", async () => {
    stubbed(prisma.sshHostKey.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pin("10.0.0.9", 22, FP_B));
    stubbed(prisma.sshHostKey.create).mockRejectedValue(Object.assign(new Error("Unique"), { code: "P2002" }));
    const v = await verifyOrPin("10.0.0.9", 22, KEY_A);
    expect(v).toEqual({ ok: false, outcome: "mismatch", expected: FP_B, actual: FP_A });
    expect(eventLog.logEvent.mock.calls.map((c) => c[0].action)).toEqual(["ssh.host_key.mismatch"]);
    // the winner is now cached: its key matches without another read
    stubbed(prisma.sshHostKey.findUnique).mockClear();
    expect(await verifyOrPin("10.0.0.9", 22, KEY_B)).toEqual({ ok: true, outcome: "matched" });
    expect(prisma.sshHostKey.findUnique).not.toHaveBeenCalled();
  });

  // Since 2026-11-14 the loser reports a match: the winner stored the pin and
  // wrote the one "pinned" Event, so the loser no longer writes a second.
  it("the race loser that agrees with the winner accepts as a match, writing no second pinned Event", async () => {
    stubbed(prisma.sshHostKey.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pin("10.0.0.9", 22, FP_A));
    stubbed(prisma.sshHostKey.create).mockRejectedValue(Object.assign(new Error("Unique"), { code: "P2002" }));
    expect(await verifyOrPin("10.0.0.9", 22, KEY_A)).toEqual({ ok: true, outcome: "matched" });
    expect(eventLog.logEvent.mock.calls.map((c) => c[0].action)).not.toContain("ssh.host_key.pinned");
  });

  // Was a bug until 2026-11-14: verifyOrPin("10.0.0.9", 22, KEY_A) where sshHostKey.create rejects and
  // the re-read finds no row (the failure was not a lost race) returns
  // { ok: true, outcome: "pinned" }, caches KEY_A as the pin and writes an
  // "ssh.host_key.pinned" Event — though nothing was stored. The service's own
  // contract is "fails closed: a verification error rejects the connection";
  // it should refuse (ok:false, or throw so buildHostVerifier refuses) and
  // write no "pinned" Event.
  it("a create failure that is not a lost race fails closed and claims no pin", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(null);
    stubbed(prisma.sshHostKey.create).mockRejectedValue(new Error("value too long for column"));
    const v = await verifyOrPin("10.0.0.9", 22, KEY_A).catch(() => "threw" as const);
    expect(v === "threw" || v.ok === false).toBe(true);
    expect(eventLog.logEvent.mock.calls.map((c) => c[0].action)).not.toContain("ssh.host_key.pinned");
  });

  it("refreshes lastSeen on a match at most hourly", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
      stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(pin("10.0.0.5", 22, FP_A));
      await verifyOrPin("10.0.0.5", 22, KEY_A);
      await verifyOrPin("10.0.0.5", 22, KEY_A);
      expect(prisma.sshHostKey.update).toHaveBeenCalledTimes(1);
      expect(stubbed(prisma.sshHostKey.update).mock.calls[0][0]).toMatchObject({
        where: { host_port: { host: "10.0.0.5", port: 22 } },
      });
      vi.setSystemTime(new Date("2026-11-14T01:00:01Z"));
      await verifyOrPin("10.0.0.5", 22, KEY_A);
      expect(prisma.sshHostKey.update).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed lastSeen write is logged at debug and never fails the match", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(pin("10.0.0.5", 22, FP_A));
    stubbed(prisma.sshHostKey.update).mockRejectedValue(new Error("db down"));
    expect((await verifyOrPin("10.0.0.5", 22, KEY_A)).ok).toBe(true);
    await settle();
    expect(h.debug).toHaveBeenCalled();
  });

  it("a first pin does not also write lastSeen", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(null);
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    await settle();
    expect(prisma.sshHostKey.update).not.toHaveBeenCalled();
  });
});

describe("forgetCachedHostKey (rule 123)", () => {
  it("drops one endpoint so the next connection reads the table", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(pin("10.0.0.5", 22, FP_A));
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    await verifyOrPin("10.0.0.6", 22, KEY_A);
    forgetCachedHostKey("10.0.0.5", 22);
    stubbed(prisma.sshHostKey.findUnique).mockClear();
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    await verifyOrPin("10.0.0.6", 22, KEY_A);
    expect(prisma.sshHostKey.findUnique).toHaveBeenCalledTimes(1);
  });

  it("an archived pin (row gone) re-pins whatever answers", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValueOnce(pin("10.0.0.5", 22, FP_A));
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    forgetCachedHostKey("10.0.0.5", 22);
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(null);
    expect(await verifyOrPin("10.0.0.5", 22, KEY_B)).toEqual({ ok: true, outcome: "pinned" });
  });

  it("is a no-op for an endpoint that was never cached", () => {
    expect(() => forgetCachedHostKey("192.0.2.1", 22)).not.toThrow();
  });
});

describe("listHostKeys / listHostKeysWithAssets", () => {
  it("orders by host then port", async () => {
    stubbed(prisma.sshHostKey.findMany).mockResolvedValue([pin("a", 22, FP_A)]);
    expect(await listHostKeys()).toHaveLength(1);
    expect(stubbed(prisma.sshHostKey.findMany).mock.calls[0][0]).toEqual({ orderBy: [{ host: "asc" }, { port: "asc" }] });
  });

  it("returns [] without an asset query when nothing is pinned", async () => {
    stubbed(prisma.sshHostKey.findMany).mockResolvedValue([]);
    expect(await listHostKeysWithAssets()).toEqual([]);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("joins assets by exact address or case-insensitive hostname, de-duplicating the hosts queried", async () => {
    stubbed(prisma.sshHostKey.findMany).mockResolvedValue([
      pin("10.0.0.5", 22, FP_A, "hk-1"),
      pin("10.0.0.5", 2222, FP_A, "hk-2"),
      pin("Web01.corp", 22, FP_B, "hk-3"),
    ]);
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { id: "a1", hostname: "srv", ipAddress: "10.0.0.5" },
      { id: "a2", hostname: "web01.CORP", ipAddress: "10.0.0.7" },
      { id: "a3", hostname: null, ipAddress: null },
    ]);
    const out = await listHostKeysWithAssets();
    const where = stubbed(prisma.asset.findMany).mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({ ipAddress: { in: ["10.0.0.5", "Web01.corp"], mode: "insensitive" } });
    expect(where.OR[1]).toEqual({ hostname: { in: ["10.0.0.5", "Web01.corp"], mode: "insensitive" } });
    expect(out.map((p) => [p.id, p.assets.map((a) => a.id)])).toEqual([
      ["hk-1", ["a1"]],
      ["hk-2", ["a1"]],
      ["hk-3", ["a2"]],
    ]);
  });

  it("joins an IPv6 pin to its asset across case and compression differences", async () => {
    // Was a bug until 2026-11-16: addresses were compared exactly, so "2001:DB8:0::5" never joined "2001:db8::5".
    stubbed(prisma.sshHostKey.findMany).mockResolvedValue([pin("2001:DB8:0::5", 22, FP_A, "hk-6")]);
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { id: "a6", hostname: "v6host", ipAddress: "2001:db8::5" },
      { id: "a7", hostname: "other", ipAddress: "2001:db8::6" },
    ]);
    const out = await listHostKeysWithAssets();
    const where = stubbed(prisma.asset.findMany).mock.calls[0][0].where;
    expect(where.OR[0].ipAddress.in).toEqual(["2001:DB8:0::5", "2001:db8::5"]);
    expect(out[0].assets.map((a) => a.id)).toEqual(["a6"]);
  });
});

describe("deleteHostKey", () => {
  it("404s on an unknown id", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(null);
    await expect(deleteHostKey("nope", "alice")).rejects.toMatchObject({ httpStatus: 404 });
    expect(prisma.sshHostKey.delete).not.toHaveBeenCalled();
  });

  it("deletes, forgets the cached fingerprint, and audits at warning", async () => {
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(pin("10.0.0.5", 22, FP_A));
    await verifyOrPin("10.0.0.5", 22, KEY_A); // cache it
    eventLog.logEvent.mockClear();
    await deleteHostKey("hk-1", "alice");
    expect(stubbed(prisma.sshHostKey.delete).mock.calls[0][0]).toEqual({ where: { id: "hk-1" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "ssh.host_key.deleted",
      resourceId: "hk-1",
      resourceName: "10.0.0.5:22",
      actor: "alice",
      level: "warning",
      details: { host: "10.0.0.5", port: 22, fingerprint: FP_A },
    });
    // a rebuilt host's new key is accepted, not refused from the cache
    stubbed(prisma.sshHostKey.findUnique).mockResolvedValue(null);
    expect(await verifyOrPin("10.0.0.5", 22, KEY_B)).toEqual({ ok: true, outcome: "pinned" });
  });
});
