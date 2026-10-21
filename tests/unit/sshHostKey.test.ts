/**
 * tests/unit/sshHostKey.test.ts
 *
 * Coverage for SSH host-key trust-on-first-use pinning:
 *   - fingerprints match the `ssh-keygen -lf` form so operators can compare
 *   - first sight pins; a match accepts; a CHANGED key is refused
 *   - the cache never turns a deleted pin into a permanent rejection
 *   - the default (business rule 113): every credential is verified unless it
 *     sets verifyHostKey: false
 *   - the verifier fails CLOSED on an internal error
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";

interface FakeRow { id: string; host: string; port: number; keyType: string; fingerprint: string; firstSeen: Date; lastSeen: Date }

const db = { rows: [] as FakeRow[], nextId: 1, createCalls: 0 };

function findRow(where: any): FakeRow | null {
  if (where.id) return db.rows.find((r) => r.id === where.id) ?? null;
  const hp = where.host_port;
  if (hp) return db.rows.find((r) => r.host === hp.host && r.port === hp.port) ?? null;
  return null;
}

const assetRows: Array<{ id: string; hostname: string | null; ipAddress: string | null }> = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: { findMany: vi.fn(async () => [...assetRows]) },
    sshHostKey: {
      findUnique: vi.fn(async ({ where }: any) => findRow(where)),
      findMany: vi.fn(async () => [...db.rows]),
      create: vi.fn(async ({ data }: any) => {
        db.createCalls += 1;
        if (db.rows.some((r) => r.host === data.host && r.port === data.port)) {
          throw new Error("Unique constraint failed"); // mimic the race
        }
        const row: FakeRow = {
          id: `hk-${db.nextId++}`, host: data.host, port: data.port,
          keyType: data.keyType, fingerprint: data.fingerprint,
          firstSeen: new Date(), lastSeen: new Date(),
        };
        db.rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = findRow(where)!;
        if (data.lastSeen) row.lastSeen = data.lastSeen;
        return row;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const i = db.rows.findIndex((r) => r.id === where.id);
        return db.rows.splice(i, 1)[0];
      }),
    },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: vi.fn(async () => {}) }));

import {
  verifyOrPin,
  listHostKeys,
  listHostKeysWithAssets,
  deleteHostKey,
  fingerprintKeyBlob,
  keyTypeFromBlob,
  _resetCaches,
} from "../../src/services/sshHostKeyService.js";
import { buildHostVerifier } from "../../src/utils/remoteExec.js";
import { logEvent } from "../../src/services/eventLogService.js";

/** A plausible ed25519 host-key blob: length-prefixed type + 32-byte key. */
function makeKeyBlob(type = "ssh-ed25519", seed = 1): Buffer {
  const name = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(name.length, 0);
  const body = Buffer.alloc(32, seed);
  return Buffer.concat([len, name, body]);
}

const KEY_A = makeKeyBlob("ssh-ed25519", 1);
const KEY_B = makeKeyBlob("ssh-ed25519", 2);

beforeEach(() => {
  db.rows = [];
  db.nextId = 1;
  db.createCalls = 0;
  _resetCaches();
  vi.clearAllMocks();
});

describe("fingerprintKeyBlob", () => {
  it("is SHA256 over the raw blob, base64, unpadded", () => {
    const expected = "SHA256:" + createHash("sha256").update(KEY_A).digest("base64").replace(/=+$/, "");
    expect(fingerprintKeyBlob(KEY_A)).toBe(expected);
    // ssh-keygen strips padding; a padded value wouldn't compare by eye.
    expect(fingerprintKeyBlob(KEY_A).endsWith("=")).toBe(false);
  });

  it("distinguishes different keys", () => {
    expect(fingerprintKeyBlob(KEY_A)).not.toBe(fingerprintKeyBlob(KEY_B));
  });
});

describe("keyTypeFromBlob", () => {
  it("reads the algorithm name from the wire format", () => {
    expect(keyTypeFromBlob(KEY_A)).toBe("ssh-ed25519");
    expect(keyTypeFromBlob(makeKeyBlob("ecdsa-sha2-nistp256"))).toBe("ecdsa-sha2-nistp256");
  });

  it("degrades to 'unknown' on malformed input instead of throwing", () => {
    // Display-only — a bad parse must never fail an otherwise-valid connection.
    expect(keyTypeFromBlob(Buffer.alloc(0))).toBe("unknown");
    expect(keyTypeFromBlob(Buffer.from([0, 0, 0, 2]))).toBe("unknown"); // truncated
    const absurd = Buffer.alloc(8);
    absurd.writeUInt32BE(0xffffff, 0);
    expect(keyTypeFromBlob(absurd)).toBe("unknown"); // declared length is nonsense
  });
});

describe("verifyOrPin", () => {
  it("pins on first sight and accepts", async () => {
    const v = await verifyOrPin("10.0.0.5", 22, KEY_A);
    expect(v).toEqual({ ok: true, outcome: "pinned" });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      host: "10.0.0.5", port: 22, keyType: "ssh-ed25519", fingerprint: fingerprintKeyBlob(KEY_A),
    });
    const ev = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    expect(ev.some((e: any) => e.action === "ssh.host_key.pinned")).toBe(true);
  });

  it("accepts a matching key on later connections", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    const v = await verifyOrPin("10.0.0.5", 22, KEY_A);
    expect(v).toEqual({ ok: true, outcome: "matched" });
    expect(db.rows).toHaveLength(1);
  });

  it("REFUSES a changed key and reports both fingerprints", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    vi.clearAllMocks();

    const v = await verifyOrPin("10.0.0.5", 22, KEY_B);
    expect(v.ok).toBe(false);
    expect(v).toMatchObject({
      outcome: "mismatch",
      expected: fingerprintKeyBlob(KEY_A),
      actual: fingerprintKeyBlob(KEY_B),
    });
    // The pin is NOT overwritten — that would defeat the whole mechanism.
    expect(db.rows[0].fingerprint).toBe(fingerprintKeyBlob(KEY_A));

    const ev = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    const mismatch = ev.find((e: any) => e.action === "ssh.host_key.mismatch");
    expect(mismatch).toBeTruthy();
    expect(mismatch.level).toBe("warning");
    expect(mismatch.message).toMatch(/delete its pin/i);
  });

  it("scopes pins per host AND per port", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    // Different port is a different endpoint, so KEY_B is a first sight, not
    // a mismatch.
    const v = await verifyOrPin("10.0.0.5", 2222, KEY_B);
    expect(v.outcome).toBe("pinned");
    expect(db.rows).toHaveLength(2);
  });

  it("throttles lastSeen writes rather than writing on every connect", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    const { prisma } = await import("../../src/db.js");
    vi.clearAllMocks();
    for (let i = 0; i < 5; i++) await verifyOrPin("10.0.0.5", 22, KEY_A);
    // Hot path: agentless process collection runs this per-minute per host.
    expect((prisma.sshHostKey.update as any).mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("re-pins after the pin is deleted, without a stale-cache rejection", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    await deleteHostKey(db.rows[0].id, "tester");
    // Host was legitimately rebuilt: the new key must be accepted, not
    // refused from a cached fingerprint.
    const v = await verifyOrPin("10.0.0.5", 22, KEY_B);
    expect(v).toEqual({ ok: true, outcome: "pinned" });
    expect(db.rows[0].fingerprint).toBe(fingerprintKeyBlob(KEY_B));
  });

  it("resolves a concurrent first-connect race against the stored winner", async () => {
    // Two processes pin the same endpoint at once; create() throws for the
    // loser, which must then agree with whatever landed.
    db.rows.push({
      id: "pre", host: "10.0.0.9", port: 22, keyType: "ssh-ed25519",
      fingerprint: fingerprintKeyBlob(KEY_A), firstSeen: new Date(), lastSeen: new Date(),
    });
    _resetCaches();
    const v = await verifyOrPin("10.0.0.9", 22, KEY_A);
    expect(v.ok).toBe(true);
  });
});

describe("deleteHostKey", () => {
  it("removes the pin and audits it at warning level", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    vi.clearAllMocks();
    await deleteHostKey(db.rows[0].id, "alice");
    expect(db.rows).toHaveLength(0);
    const ev = (logEvent as any).mock.calls.map((c: any[]) => c[0]);
    const del = ev.find((e: any) => e.action === "ssh.host_key.deleted");
    // Deleting a pin re-opens first-use trust — it belongs in the audit log
    // at a level that stands out.
    expect(del.level).toBe("warning");
    expect(del.actor).toBe("alice");
  });

  it("404s on an unknown id", async () => {
    await expect(deleteHostKey("nope", "alice")).rejects.toThrow(/not found/i);
  });
});

describe("listHostKeys", () => {
  it("returns the pinned rows", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    await verifyOrPin("10.0.0.6", 22, KEY_B);
    expect(await listHostKeys()).toHaveLength(2);
  });
});

describe("listHostKeysWithAssets", () => {
  it("attaches the assets at each pinned address or hostname", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    await verifyOrPin("Web01.corp", 22, KEY_B);
    assetRows.splice(0, assetRows.length,
      { id: "a1", hostname: "db01", ipAddress: "10.0.0.5" },
      { id: "a2", hostname: "web01.corp", ipAddress: "10.0.0.9" });
    const rows = await listHostKeysWithAssets();
    expect(rows.find((r) => r.host === "10.0.0.5")!.assets.map((a) => a.id)).toEqual(["a1"]);
    expect(rows.find((r) => r.host === "Web01.corp")!.assets.map((a) => a.id)).toEqual(["a2"]);
    assetRows.length = 0;
  });
});

describe("buildHostVerifier (default on, rule 113)", () => {
  it("returns null only when the credential explicitly opts out", () => {
    expect(buildHostVerifier("h", 22, { verifyHostKey: false })).toBeNull();
  });

  it("verifies a credential with no flag — legacy rows, managed deployment keys, the AD bind fallback", () => {
    expect(buildHostVerifier("h", 22, {})).toBeTypeOf("function");
    expect(buildHostVerifier("h", 22, { verifyHostKey: "yes" })).toBeTypeOf("function");
  });

  it("returns a verifier that accepts a first-sight key", async () => {
    const verify = buildHostVerifier("10.0.0.5", 22, { verifyHostKey: true })!;
    expect(verify).toBeTypeOf("function");
    const ok = await new Promise<boolean>((resolve) => verify(KEY_A, resolve));
    expect(ok).toBe(true);
  });

  it("returns a verifier that rejects a changed key", async () => {
    await verifyOrPin("10.0.0.5", 22, KEY_A);
    const verify = buildHostVerifier("10.0.0.5", 22, { verifyHostKey: true })!;
    const ok = await new Promise<boolean>((resolve) => verify(KEY_B, resolve));
    expect(ok).toBe(false);
  });

  it("fails CLOSED when verification errors", async () => {
    const { prisma } = await import("../../src/db.js");
    (prisma.sshHostKey.findUnique as any).mockRejectedValueOnce(new Error("db down"));
    const verify = buildHostVerifier("10.0.0.7", 22, { verifyHostKey: true })!;
    const ok = await new Promise<boolean>((resolve) => verify(KEY_A, resolve));
    // An operator who asked for verification gets a refused connection on an
    // internal error, never a silently unverified one.
    expect(ok).toBe(false);
  });
});
