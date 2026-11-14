/**
 * tests/unit/snmpCore.test.ts — CQ-T010: the SNMP session layer every
 * collector shares.
 *
 * withSnmpGate's FIFO / timeout queue has its own suite (withSnmpGate.test.ts)
 * and snmpVbToNumber's absence-vs-zero contract has snmpVarbindNumber.test.ts.
 * This file pins the rest of the module's public surface:
 *
 *   - buildSnmpSession: v2c vs v3, the auth / priv mapping and its 400s, the
 *     udp6 transport for an IPv6 target (rule 128), the timeout floor;
 *   - snmpWalk: index-suffix keys, error varbinds skipped, the row cap, the
 *     non-increasing-OID loop guard (a 502 AppError) running BEFORE the prefix
 *     filter, and a subtree walk never returning its own base OID;
 *   - snmpGetScalar / snmpMultiGet: ".0" instance, error varbind → null (never
 *     0), dedupe, 40-OID batching, first-error-wins;
 *   - withSnmpSession: gate key from the config port, error listener, close in
 *     every outcome; the gate's > 5 s wait warning and env timeout parsing;
 *   - the small decoders.
 *
 * net-snmp is mocked only at createSession / createV3Session — every session
 * the walk / get helpers see is a hand-built fake, so no socket is opened.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  createSession: vi.fn(),
  createV3Session: vi.fn(),
}));

vi.mock("net-snmp", async (orig) => {
  const real = await orig<Record<string, unknown> & { default?: Record<string, unknown> }>();
  const overrides = { createSession: h.createSession, createV3Session: h.createV3Session };
  return { ...real, ...overrides, default: { ...(real.default ?? real), ...overrides } };
});
vi.mock("../../src/utils/logger.js", () => {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  logger.child = () => logger;
  return { logger };
});

import * as snmp from "net-snmp";
import { logger } from "../../src/utils/logger.js";
import { AppError } from "../../src/utils/errors.js";
import {
  OID,
  buildSnmpSession,
  walkLoopError,
  snmpWalk,
  snmpVbToString,
  snmpVbToNumber,
  snmpMacFromBuffer,
  withSnmpSession,
  withSnmpGate,
  snmpGetScalar,
  snmpMultiGet,
} from "../../src/services/monitoring/snmpCore.js";

// ─── A fake agent ───────────────────────────────────────────────────────────

type Vb = { oid: string; type: number; value: unknown };

function cmpOid(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return pa.length - pb.length;
}

const int = (oid: string, n: number): Vb => ({ oid, type: snmp.ObjectType.Integer, value: n });
const noSuch = (oid: string): Vb => ({ oid, type: snmp.ObjectType.NoSuchInstance, value: null });

/**
 * A session over an in-memory table. `subtree` behaves like net-snmp's: it
 * feeds rows strictly under `base.` in OID order, in pages of `page`, stops
 * when the feed returns true, and calls `done` otherwise.
 */
function agentSession(table: Vb[], page = 20) {
  const gets: string[][] = [];
  const walks: string[] = [];
  const session = {
    gets,
    walks,
    subtree(base: string, _maxRep: number, feed: (vbs: unknown[]) => boolean | void, done: (err?: Error) => void) {
      walks.push(base);
      const rows = table.filter((v) => v.oid.startsWith(base + ".")).sort((a, b) => cmpOid(a.oid, b.oid));
      for (let i = 0; i < rows.length; i += page) {
        if (feed(rows.slice(i, i + page)) === true) return;
      }
      done();
    },
    get(oids: string[], cb: (err: Error | null, vbs: unknown[]) => void) {
      gets.push([...oids]);
      cb(null, oids.map((oid) => table.find((v) => v.oid === oid) ?? noSuch(oid)));
    },
  };
  return session;
}

const ORIGINAL_GATE_ENV = process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS;

beforeEach(() => {
  h.createSession.mockReset();
  h.createV3Session.mockReset();
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  if (ORIGINAL_GATE_ENV === undefined) delete process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS;
  else process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS = ORIGINAL_GATE_ENV;
});

// ─── buildSnmpSession ──────────────────────────────────────────────────────

describe("buildSnmpSession — v2c", () => {
  it("defaults to v2c on port 161 over udp4 with no retries and the collector timeout floor", () => {
    h.createSession.mockReturnValue("S");
    expect(buildSnmpSession("10.0.0.1", { community: "public" })).toBe("S");
    expect(h.createSession).toHaveBeenCalledWith("10.0.0.1", "public", {
      port: 161, transport: "udp4", version: snmp.Version2c, timeout: 10_000, retries: 0,
    });
    expect(h.createV3Session).not.toHaveBeenCalled();
  });

  it("a missing community is the empty string, not 'undefined'", () => {
    buildSnmpSession("10.0.0.1", {});
    expect(h.createSession.mock.calls[0][1]).toBe("");
  });

  it("reads a numeric-string port and floors it; a bad port falls back to 161", () => {
    buildSnmpSession("10.0.0.1", { port: "1161" });
    buildSnmpSession("10.0.0.1", { port: -5 });
    buildSnmpSession("10.0.0.1", { port: "abc" });
    expect(h.createSession.mock.calls.map((c) => c[2].port)).toEqual([1161, 161, 161]);
  });

  it("opens a udp6 socket for an IPv6 target (rule 128)", () => {
    buildSnmpSession("fd00::10", { community: "c" });
    expect(h.createSession.mock.calls[0][2].transport).toBe("udp6");
  });

  it("a positive caller timeout overrides the floor", () => {
    buildSnmpSession("10.0.0.1", {}, 2500);
    expect(h.createSession.mock.calls[0][2].timeout).toBe(2500);
  });

  it.each([0, -1])("a non-positive caller timeout (%s) never disables the timeout — the floor applies", (t) => {
    buildSnmpSession("10.0.0.1", {}, t);
    expect(h.createSession.mock.calls[0][2].timeout).toBe(10_000);
  });

  // Was a bug until 2026-11-13: walkLoopError told the operator to "Try an SNMP
  // v1 credential (avoids GETBULK)", but buildSnmpSession maps every version
  // that is not "v3" to Version2c, so the advice could not work. The advice is
  // gone; v1 is not supported (a { version: "v1" } config opens v2c).
  it("a v1 config still opens v2c, and the walk-loop error no longer advises v1", () => {
    buildSnmpSession("10.0.0.1", { version: "v1", community: "c" });
    expect(h.createSession.mock.calls[0][2].version).toBe(snmp.Version2c);
    expect(walkLoopError("1.3.6.1.2.1.2", "1.3.6.1.2.1.2.1", "1.3.6.1.2.1.2.1").message).not.toMatch(/v1/i);
  });
});

describe("buildSnmpSession — v3", () => {
  const v3 = (over: Record<string, unknown> = {}) => ({
    version: "v3", username: "mon", securityLevel: "authPriv",
    authProtocol: "SHA256", authKey: "authpass", privProtocol: "AES", privKey: "privpass", ...over,
  });

  it("authPriv carries both protocols and both keys", () => {
    h.createV3Session.mockReturnValue("V3");
    expect(buildSnmpSession("10.0.0.2", v3(), 3000)).toBe("V3");
    const [host, user, opts] = h.createV3Session.mock.calls[0];
    expect(host).toBe("10.0.0.2");
    expect(user).toEqual({
      name: "mon", level: snmp.SecurityLevel.authPriv,
      authProtocol: snmp.AuthProtocols.sha256, authKey: "authpass",
      privProtocol: snmp.PrivProtocols.aes, privKey: "privpass",
    });
    expect(opts).toEqual({ port: 161, transport: "udp4", version: snmp.Version3, timeout: 3000, retries: 0 });
    expect(h.createSession).not.toHaveBeenCalled();
  });

  it("authNoPriv carries auth only", () => {
    buildSnmpSession("10.0.0.2", v3({ securityLevel: "authNoPriv", privProtocol: "BOGUS" }));
    const user = h.createV3Session.mock.calls[0][1];
    expect(user.level).toBe(snmp.SecurityLevel.authNoPriv);
    expect(user.authProtocol).toBe(snmp.AuthProtocols.sha256);
    expect(user).not.toHaveProperty("privProtocol");
    expect(user).not.toHaveProperty("privKey");
  });

  it("noAuthNoPriv carries neither — an unknown auth protocol is not even looked at", () => {
    buildSnmpSession("10.0.0.2", v3({ securityLevel: "noAuthNoPriv", authProtocol: "BOGUS" }));
    expect(h.createV3Session.mock.calls[0][1]).toEqual({ name: "mon", level: snmp.SecurityLevel.noAuthNoPriv });
  });

  it("an unrecognized security level is treated as authPriv (the strictest)", () => {
    buildSnmpSession("10.0.0.2", v3({ securityLevel: "whatever" }));
    expect(h.createV3Session.mock.calls[0][1].level).toBe(snmp.SecurityLevel.authPriv);
  });

  it.each([
    ["MD5", "md5"], ["SHA", "sha"], ["SHA224", "sha224"], ["SHA256", "sha256"], ["SHA384", "sha384"], ["SHA512", "sha512"],
  ] as const)("maps authProtocol %s", (name, key) => {
    buildSnmpSession("h", v3({ authProtocol: name }));
    expect(h.createV3Session.mock.calls[0][1].authProtocol).toBe((snmp.AuthProtocols as Record<string, unknown>)[key]);
  });

  it.each([["DES", "des"], ["AES", "aes"], ["AES256B", "aes256b"], ["AES256R", "aes256r"]] as const)("maps privProtocol %s", (name, key) => {
    buildSnmpSession("h", v3({ privProtocol: name }));
    expect(h.createV3Session.mock.calls[0][1].privProtocol).toBe((snmp.PrivProtocols as Record<string, unknown>)[key]);
  });

  it("refuses an unknown auth protocol with a 400 AppError and opens nothing", () => {
    let caught: unknown;
    try { buildSnmpSession("h", v3({ authProtocol: "sha256" })); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).httpStatus).toBe(400);
    expect((caught as AppError).message).toContain('authProtocol "sha256"');
    expect(h.createV3Session).not.toHaveBeenCalled();
  });

  it("refuses an unknown or missing priv protocol with a 400 AppError", () => {
    expect(() => buildSnmpSession("h", v3({ privProtocol: "3DES" }))).toThrow(/privProtocol "3DES"/);
    let caught: unknown;
    try { buildSnmpSession("h", v3({ privProtocol: undefined })); } catch (e) { caught = e; }
    expect((caught as AppError).httpStatus).toBe(400);
  });

  it("missing username / keys become empty strings", () => {
    buildSnmpSession("h", { version: "v3", securityLevel: "authPriv", authProtocol: "SHA", privProtocol: "AES" });
    expect(h.createV3Session.mock.calls[0][1]).toMatchObject({ name: "", authKey: "", privKey: "" });
  });

  it("an IPv6 v3 target also gets udp6", () => {
    buildSnmpSession("2001:db8::1", v3());
    expect(h.createV3Session.mock.calls[0][2].transport).toBe("udp6");
  });
});

// ─── walkLoopError ──────────────────────────────────────────────────────────

describe("walkLoopError", () => {
  it("is a 502 AppError naming the base, the previous and the offending OID", () => {
    const e = walkLoopError("1.3.6.1.2.1.2", "1.3.6.1.2.1.2.2.1.5", "1.3.6.1.2.1.2.2.1.4");
    expect(e).toBeInstanceOf(AppError);
    expect(e.httpStatus).toBe(502);
    expect(e.message).toContain("SNMP walk of 1.3.6.1.2.1.2 aborted");
    expect(e.message).toContain("1.3.6.1.2.1.2.2.1.4 after 1.3.6.1.2.1.2.2.1.5");
  });
});

// ─── snmpWalk ───────────────────────────────────────────────────────────────

describe("snmpWalk", () => {
  const base = OID.ifDescr;

  it("keys each row by the index suffix after `base.`", async () => {
    const s = agentSession([
      { oid: `${base}.1`, type: snmp.ObjectType.OctetString, value: Buffer.from("port1") },
      { oid: `${base}.10`, type: snmp.ObjectType.OctetString, value: Buffer.from("port10") },
      { oid: `${base}.2`, type: snmp.ObjectType.OctetString, value: Buffer.from("port2") },
    ]);
    const out = await snmpWalk(s, base);
    expect([...out.keys()]).toEqual(["1", "2", "10"]);
    expect(snmpVbToString(out.get("10"))).toBe("port10");
    expect(s.walks).toEqual([base]);
  });

  it("keeps a multi-part index suffix whole", async () => {
    const lldp = OID.lldpRemSysName;
    const s = agentSession([{ oid: `${lldp}.0.12.1`, type: snmp.ObjectType.OctetString, value: Buffer.from("sw2") }]);
    expect([...(await snmpWalk(s, lldp)).keys()]).toEqual(["0.12.1"]);
  });

  it("never returns the base OID itself, nor a sibling that merely shares its digits", async () => {
    // A sibling column `${base}0` (…2.2.1.20 vs …2.2.1.2) is not under `${base}.`.
    const s = {
      subtree(_b: string, _m: number, feed: (vbs: unknown[]) => boolean | void, done: () => void) {
        feed([int(base, 99), int(`${base}.1`, 1), int(`${base}0.1`, 2)]);
        done();
      },
    };
    const out = await snmpWalk(s, base);
    expect([...out.entries()]).toEqual([["1", 1]]);
  });

  it("skips error varbinds and varbinds without a string OID", async () => {
    const s = {
      subtree(_b: string, _m: number, feed: (vbs: unknown[]) => boolean | void, done: () => void) {
        feed([noSuch(`${base}.1`), { type: snmp.ObjectType.Integer, value: 5 }, int(`${base}.2`, 2)]);
        done();
      },
    };
    expect([...(await snmpWalk(s, base)).entries()]).toEqual([["2", 2]]);
  });

  it("an empty subtree resolves an empty map", async () => {
    expect((await snmpWalk(agentSession([]), base)).size).toBe(0);
  });

  it("stops at the row cap and tells net-snmp to stop", async () => {
    const table = Array.from({ length: 30 }, (_, i) => int(`${base}.${i + 1}`, i + 1));
    const s = agentSession(table, 7);
    const feedResults: Array<boolean | void> = [];
    const realSubtree = s.subtree.bind(s);
    s.subtree = (b, m, feed, done) => realSubtree(b, m, (vbs) => { const r = feed(vbs); feedResults.push(r); return r; }, done);
    const out = await snmpWalk(s, base, 10);
    expect(out.size).toBe(10);
    expect(feedResults.at(-1)).toBe(true);
    expect(feedResults).toHaveLength(2); // 7 rows, then the 3 that reach the cap
  });

  it("defaults the cap to 1000 rows", async () => {
    const table = Array.from({ length: 1005 }, (_, i) => int(`${base}.${i + 1}`, i));
    expect((await snmpWalk(agentSession(table, 50), base)).size).toBe(1000);
  });

  it("rejects with the 502 walk-loop error when the agent echoes an OID back", async () => {
    const s = {
      subtree(_b: string, _m: number, feed: (vbs: unknown[]) => boolean | void, done: () => void) {
        if (feed([int(`${base}.1`, 1), int(`${base}.2`, 2)]) === true) return;
        if (feed([int(`${base}.2`, 2)]) === true) return; // the echo
        done();
      },
    };
    const err = await snmpWalk(s, base).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(502);
    expect(err.message).toContain(`${base}.2 after ${base}.2`);
  });

  it("the loop guard sees OIDs OUTSIDE the prefix too — an agent stuck on the base OID cannot spin forever", async () => {
    let fed = 0;
    const s = {
      subtree(_b: string, _m: number, feed: (vbs: unknown[]) => boolean | void, done: () => void) {
        while (fed < 100) {
          fed++;
          if (feed([int(base, 0)]) === true) return;
        }
        done();
      },
    };
    const err = await snmpWalk(s, base).catch((e) => e);
    expect(err?.httpStatus).toBe(502);
    expect(fed).toBe(2);
  });

  it("propagates the done-callback error", async () => {
    const s = {
      subtree(_b: string, _m: number, feed: (vbs: unknown[]) => boolean | void, done: (e?: Error) => void) {
        feed([int(`${base}.1`, 1)]);
        done(new Error("Request timed out"));
      },
    };
    await expect(snmpWalk(s, base)).rejects.toThrow("Request timed out");
  });

  it("a synchronous throw from subtree rejects rather than escaping", async () => {
    const s = { subtree() { throw new Error("socket closed"); } };
    await expect(snmpWalk(s, base)).rejects.toThrow("socket closed");
  });

  it("settles once: a done() after the cap does not turn the result into an error", async () => {
    const s = {
      subtree(_b: string, _m: number, feed: (vbs: unknown[]) => boolean | void, done: (e?: Error) => void) {
        feed([int(`${base}.1`, 1), int(`${base}.2`, 2)]);
        done(new Error("late"));
      },
    };
    expect((await snmpWalk(s, base, 1)).size).toBe(1);
  });
});

// ─── snmpGetScalar ──────────────────────────────────────────────────────────

describe("snmpGetScalar", () => {
  it("appends the .0 instance when the caller names the object", async () => {
    const s = agentSession([int("1.3.6.1.2.1.1.3.0", 4242)]);
    expect(await snmpGetScalar(s, "1.3.6.1.2.1.1.3")).toBe(4242);
    expect(s.gets).toEqual([["1.3.6.1.2.1.1.3.0"]]);
  });

  it("does not double the .0 when the caller already gave it", async () => {
    const s = agentSession([int("1.3.6.1.2.1.1.3.0", 1)]);
    await snmpGetScalar(s, "1.3.6.1.2.1.1.3.0");
    expect(s.gets).toEqual([["1.3.6.1.2.1.1.3.0"]]);
  });

  it("an error varbind (noSuchObject / noSuchInstance) resolves null, never 0", async () => {
    const s = agentSession([]);
    const v = await snmpGetScalar(s, "1.3.6.1.4.1.12356.106.4.1.2");
    expect(v).toBeNull();
    expect(snmpVbToNumber(v)).toBeNull();
  });

  it("an empty varbind list resolves null", async () => {
    const s = { get(_o: string[], cb: (e: Error | null, v: unknown[]) => void) { cb(null, []); } };
    expect(await snmpGetScalar(s, "1.2.3")).toBeNull();
  });

  it("rejects with the transport error", async () => {
    const s = { get(_o: string[], cb: (e: Error | null, v: unknown[]) => void) { cb(new Error("Request timed out"), []); } };
    await expect(snmpGetScalar(s, "1.2.3")).rejects.toThrow("Request timed out");
  });

  it("rejects when get throws synchronously", async () => {
    const s = { get() { throw new Error("closed"); } };
    await expect(snmpGetScalar(s, "1.2.3")).rejects.toThrow("closed");
  });
});

// ─── snmpMultiGet ──────────────────────────────────────────────────────────

describe("snmpMultiGet", () => {
  it("resolves an empty map without touching the session", async () => {
    const s = agentSession([]);
    expect((await snmpMultiGet(s, [])).size).toBe(0);
    expect(s.gets).toEqual([]);
  });

  it("keys each value by the requested OID, with null for an error varbind", async () => {
    const s = agentSession([int("1.1.0", 5), int("1.3.0", 0)]);
    const out = await snmpMultiGet(s, ["1.1.0", "1.2.0", "1.3.0"]);
    expect([...out.entries()]).toEqual([["1.1.0", 5], ["1.2.0", null], ["1.3.0", 0]]);
  });

  it("dedupes repeated OIDs, preserving first-seen order", async () => {
    const s = agentSession([int("1.1.0", 1), int("1.2.0", 2)]);
    await snmpMultiGet(s, ["1.2.0", "1.1.0", "1.2.0"]);
    expect(s.gets).toEqual([["1.2.0", "1.1.0"]]);
  });

  it("chunks into requests of at most 40 OIDs", async () => {
    const oids = Array.from({ length: 95 }, (_, i) => `1.3.6.1.2.1.2.2.1.10.${i + 1}`);
    const s = agentSession(oids.map((o, i) => int(o, i)));
    const out = await snmpMultiGet(s, oids);
    expect(s.gets.map((b) => b.length)).toEqual([40, 40, 15]);
    expect(out.size).toBe(95);
    expect(out.get(oids[94])).toBe(94);
  });

  it("a short varbind list marks the missing tail null", async () => {
    const s = { get(o: string[], cb: (e: Error | null, v: unknown[]) => void) { cb(null, [int(o[0], 7)]); } };
    expect([...(await snmpMultiGet(s, ["a", "b"])).entries()]).toEqual([["a", 7], ["b", null]]);
  });

  it("rejects on the first batch error and ignores later callbacks", async () => {
    const callbacks: Array<(e: Error | null, v: unknown[]) => void> = [];
    const s = { get(_o: string[], cb: (e: Error | null, v: unknown[]) => void) { callbacks.push(cb); } };
    const oids = Array.from({ length: 50 }, (_, i) => `1.${i}`);
    const p = snmpMultiGet(s, oids);
    expect(callbacks).toHaveLength(2);
    callbacks[1](new Error("Request timed out"), []);
    callbacks[0](null, []);
    await expect(p).rejects.toThrow("Request timed out");
  });

  it("rejects when get throws synchronously", async () => {
    const s = { get() { throw new Error("closed"); } };
    await expect(snmpMultiGet(s, ["1.1.0"])).rejects.toThrow("closed");
  });
});

// ─── Decoders ───────────────────────────────────────────────────────────────

describe("snmpVbToString", () => {
  it("decodes a Buffer as UTF-8 and strips trailing NULs only", () => {
    expect(snmpVbToString(Buffer.from("port1\u0000\u0000"))).toBe("port1");
    expect(snmpVbToString(Buffer.from("a\u0000b"))).toBe("a\u0000b");
  });

  it("null / undefined become the empty string; anything else is String()", () => {
    expect(snmpVbToString(null)).toBe("");
    expect(snmpVbToString(undefined)).toBe("");
    expect(snmpVbToString(42)).toBe("42");
    expect(snmpVbToString("x")).toBe("x");
  });
});

describe("snmpMacFromBuffer", () => {
  it("formats a 6-byte buffer as upper-case colon hex", () => {
    expect(snmpMacFromBuffer(Buffer.from([0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0xef]))).toBe("00:1A:2B:3C:4D:EF");
  });

  it("refuses anything that is not exactly six bytes", () => {
    expect(snmpMacFromBuffer(Buffer.alloc(0))).toBeNull();
    expect(snmpMacFromBuffer(Buffer.alloc(8))).toBeNull();
    expect(snmpMacFromBuffer("00:1a:2b:3c:4d:5e")).toBeNull();
    expect(snmpMacFromBuffer(null)).toBeNull();
  });
});

describe("snmpVbToNumber — the cases its own suite leaves out", () => {
  it("a string with surrounding spaces decodes; a whitespace-only string is absent", () => {
    expect(snmpVbToNumber(" 42 ")).toBe(42);
    expect(snmpVbToNumber("   ")).toBeNull();
  });

  it("a one-byte buffer reads as its unsigned value", () => {
    expect(snmpVbToNumber(Buffer.from([0xff]))).toBe(255);
  });
});

// ─── withSnmpSession + the gate ─────────────────────────────────────────────

function fakeSession() {
  return { on: vi.fn(), close: vi.fn() };
}

describe("withSnmpSession", () => {
  it("builds the session, attaches an error listener, runs fn, closes, and returns fn's value", async () => {
    const s = fakeSession();
    h.createSession.mockReturnValue(s);
    const out = await withSnmpSession("10.9.0.1", { community: "c" }, async (sess) => {
      expect(sess).toBe(s);
      return "ok";
    }, 1500);
    expect(out).toBe("ok");
    expect(s.on).toHaveBeenCalledWith("error", expect.any(Function));
    expect(s.close).toHaveBeenCalledTimes(1);
    expect(h.createSession.mock.calls[0][2].timeout).toBe(1500);
  });

  it("closes the session when fn throws, and propagates the error", async () => {
    const s = fakeSession();
    h.createSession.mockReturnValue(s);
    await expect(withSnmpSession("10.9.0.2", {}, async () => { throw new Error("walk failed"); })).rejects.toThrow("walk failed");
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it("a close() that throws is swallowed", async () => {
    const s = fakeSession();
    s.close.mockImplementation(() => { throw new Error("already closed"); });
    h.createSession.mockReturnValue(s);
    expect(await withSnmpSession("10.9.0.3", {}, async () => 7)).toBe(7);
  });

  it("tolerates a session with no on / close methods", async () => {
    h.createSession.mockReturnValue({});
    expect(await withSnmpSession("10.9.0.4", {}, async () => "bare")).toBe("bare");
  });

  it("a v3 config error surfaces as the 400 AppError from inside the gate", async () => {
    const err = await withSnmpSession("10.9.0.5", { version: "v3", authProtocol: "NOPE" }, async () => 1).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(400);
  });

  it("serializes on host:port from the config — two sessions to one agent never overlap", async () => {
    h.createSession.mockImplementation(() => fakeSession());
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all([
      withSnmpSession("10.9.0.6", { port: 1161 }, work),
      withSnmpSession("10.9.0.6", { port: "1161" }, work),
    ]);
    expect(maxActive).toBe(1);
  });

  it("a different port on the same host is a different gate", async () => {
    h.createSession.mockImplementation(() => fakeSession());
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    };
    await Promise.all([
      withSnmpSession("10.9.0.7", { port: 161 }, work),
      withSnmpSession("10.9.0.7", { port: 1161 }, work),
    ]);
    expect(maxActive).toBe(2);
  });
});

describe("withSnmpGate — wait accounting", () => {
  it("warns when a caller waited more than 5 s for the agent", async () => {
    vi.useFakeTimers();
    let release!: (v: string) => void;
    const first = withSnmpGate("10.8.0.1", 161, () => new Promise<string>((r) => { release = r; }));
    const second = withSnmpGate("10.8.0.1", 161, async () => "two");
    await vi.advanceTimersByTimeAsync(6_000);
    release("one");
    expect(await first).toBe("one");
    expect(await second).toBe("two");
    const warn = vi.mocked(logger.warn).mock.calls.find((c) => c[1] === "SNMP gate wait > 5s");
    expect(warn?.[0]).toMatchObject({ host: "10.8.0.1:161" });
    expect((warn?.[0] as { waitMs: number }).waitMs).toBeGreaterThanOrEqual(6_000);
  });

  it("does not warn for a short wait", async () => {
    await withSnmpGate("10.8.0.2", 161, async () => 1);
    expect(vi.mocked(logger.warn).mock.calls.some((c) => c[1] === "SNMP gate wait > 5s")).toBe(false);
  });

  it.each(["abc", "0", "-5"])("an unusable POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS (%s) falls back to 30 s", async (raw) => {
    vi.useFakeTimers();
    process.env.POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS = raw;
    let release!: () => void;
    const host = `10.8.1.${raw.length}${raw === "0" ? 0 : 1}`;
    const first = withSnmpGate(host, 161, () => new Promise<void>((r) => { release = r; }));
    const second = withSnmpGate(host, 161, async () => "late");
    const settled = second.then(() => "resolved", (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(29_999);
    let state: string | undefined;
    void settled.then((s) => { state = s; });
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toMatch(new RegExp(`SNMP gate timeout for ${host.replace(/\./g, "\\.")}:161 after 30000ms`));
    release();
    await first;
  });
});
