/**
 * tests/unit/sntp.test.ts — the SNTP query and NTS key exchange behind Server
 * Settings → NTP "Test Sync". The query runs against a real UDP server on
 * loopback (no outside network); the key exchange against a scripted socket.
 */

import { describe, it, expect, afterEach } from "vitest";
import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import {
  buildSntpRequest, parseSntpReply, readNtpTimestamp, writeNtpTimestamp, querySntp,
  buildNtsKeRequest, parseNtsKeResponse, checkNtsKe, NTS_AEAD_AES_SIV_CMAC_256,
} from "../../src/utils/sntp.js";

const T = Date.UTC(2026, 10, 11, 12, 0, 0);

/** A server reply to `request`: received at `t2`, sent at `t3`. */
function reply(request: Buffer, t2: number, t3: number, over: { stratum?: number; leap?: number; mode?: number; refId?: string } = {}): Buffer {
  const b = Buffer.alloc(48);
  b[0] = ((over.leap ?? 0) << 6) | (4 << 3) | (over.mode ?? 4);
  b[1] = over.stratum ?? 2;
  if (over.refId) b.write(over.refId, 12, "latin1"); else b.set([10, 0, 0, 1], 12);
  request.copy(b, 24, 40, 48);
  writeNtpTimestamp(b, 32, t2);
  writeNtpTimestamp(b, 40, t3);
  return b;
}

describe("packets", () => {
  it("a timestamp round-trips to the millisecond", () => {
    const b = Buffer.alloc(8);
    writeNtpTimestamp(b, 0, T + 123);
    expect(readNtpTimestamp(b, 0)).toBeCloseTo(T + 123, 0);
  });

  it("the request is NTPv4 client mode with our transmit time and per-query noise", () => {
    const a = buildSntpRequest(T, 1);
    const b = buildSntpRequest(T, 2);
    expect(a).toHaveLength(48);
    expect(a[0]).toBe(0x23);
    expect(readNtpTimestamp(a, 40)).toBeCloseTo(T, 0);
    expect(a.equals(b)).toBe(false);
  });
});

describe("parseSntpReply", () => {
  const req = buildSntpRequest(T, 7);

  it("computes offset and delay the RFC way", () => {
    // Sent at T, server got it at T+520 and answered at T+530, back at T+60:
    // the server is ~500 ms ahead; 50 ms of round trip.
    const r = parseSntpReply(reply(req, T + 520, T + 530), req, T, T + 60, "10.0.0.5");
    expect(r.offsetMs).toBeCloseTo(495, 0);
    expect(r.delayMs).toBeCloseTo(50, 0);
    expect(r).toMatchObject({ stratum: 2, refId: "10.0.0.1", address: "10.0.0.5" });
  });

  it("names a stratum-1 reference source", () => {
    expect(parseSntpReply(reply(req, T, T, { stratum: 1, refId: "GPS" }), req, T, T).refId).toBe("GPS");
  });

  it("refuses a reply to another query, a kiss-of-death, an unsynchronized server and a non-server mode", () => {
    const other = buildSntpRequest(T, 8);
    expect(() => parseSntpReply(reply(other, T, T), req, T, T)).toThrow(/originate timestamp mismatch/);
    expect(() => parseSntpReply(reply(req, T, T, { stratum: 0, refId: "RATE" }), req, T, T)).toThrow(/kiss code RATE/);
    expect(() => parseSntpReply(reply(req, T, T, { leap: 3 }), req, T, T)).toThrow(/not synchronized/);
    expect(() => parseSntpReply(reply(req, T, T, { stratum: 16 }), req, T, T)).toThrow(/not synchronized/);
    expect(() => parseSntpReply(reply(req, T, T, { mode: 3 }), req, T, T)).toThrow(/mode 3/);
    expect(() => parseSntpReply(Buffer.alloc(20), req, T, T)).toThrow(/short reply/);
  });
});

describe("querySntp (a real UDP server on loopback)", () => {
  let server: dgram.Socket | null = null;
  afterEach(() => { server?.close(); server = null; });

  async function listen(onMessage: (msg: Buffer, rinfo: dgram.RemoteInfo, s: dgram.Socket) => void): Promise<number> {
    server = dgram.createSocket("udp4");
    server.on("message", (m, r) => onMessage(m, r, server!));
    await new Promise<void>((res) => server!.bind(0, "127.0.0.1", () => res()));
    return server.address().port;
  }

  it("answers with the server's stratum and an offset near the one it was given", async () => {
    const port = await listen((msg, r, s) => {
      const now = Date.now() + 2000; // the server runs 2 s ahead
      s.send(reply(msg, now, now), r.port, r.address);
    });
    const res = await querySntp("127.0.0.1", { port, timeoutMs: 2000 });
    expect(res.stratum).toBe(2);
    expect(res.offsetMs).toBeGreaterThan(1900);
    expect(res.offsetMs).toBeLessThan(2100);
  });

  it("ignores a stray datagram and keeps waiting for the real answer", async () => {
    const port = await listen((msg, r, s) => {
      s.send(reply(buildSntpRequest(0, 1), Date.now(), Date.now()), r.port, r.address);
      setTimeout(() => s.send(reply(msg, Date.now(), Date.now()), r.port, r.address), 20);
    });
    await expect(querySntp("127.0.0.1", { port, timeoutMs: 2000 })).resolves.toMatchObject({ stratum: 2 });
  });

  it("times out on a server that never answers, and reports a name that does not resolve", async () => {
    const port = await listen(() => {});
    await expect(querySntp("127.0.0.1", { port, timeoutMs: 100 })).rejects.toThrow(/no answer within 0.1 s/);
    await expect(querySntp("ntp.invalid", { lookup: async () => { throw new Error("ENOTFOUND"); } })).rejects.toThrow(/does not resolve/);
  });
});

describe("NTS key exchange", () => {
  const rec = (type: number, body: number[] | Buffer, critical = true) => {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return Buffer.concat([Buffer.from([(critical ? 0x80 : 0) | (type >> 8), type & 0xff, b.length >> 8, b.length & 0xff]), b]);
  };
  const goodResponse = () => Buffer.concat([
    rec(1, [0, 0]), rec(4, [0, NTS_AEAD_AES_SIV_CMAC_256]),
    rec(5, Buffer.alloc(100), false), rec(5, Buffer.alloc(100), false),
    rec(6, Buffer.from("time.example.net")), rec(7, [0x01, 0x23]), rec(0, []),
  ]);

  it("asks for NTPv4 and AES-SIV-CMAC-256, and reads the server's answer", () => {
    expect(parseNtsKeResponse(buildNtsKeRequest())).toMatchObject({ complete: true, protocols: [0], aead: [NTS_AEAD_AES_SIV_CMAC_256] });
    expect(parseNtsKeResponse(goodResponse())).toEqual({
      complete: true, protocols: [0], aead: [15], cookies: 2, server: "time.example.net", port: 0x123, error: null,
    });
    expect(parseNtsKeResponse(goodResponse().subarray(0, 10)).complete).toBe(false);
  });

  /** A scripted TLS socket: emits secureConnect with `alpn`, then answers the request with `chunks`. */
  function fakeConnect(alpn: string | false, chunks: Buffer[]) {
    const s = new EventEmitter() as EventEmitter & { alpnProtocol: string | false; write: (b: Buffer) => void; destroy: () => void; written: Buffer[] };
    s.alpnProtocol = alpn;
    s.written = [];
    s.write = (b) => { s.written.push(b); for (const c of chunks) setImmediate(() => s.emit("data", c)); };
    s.destroy = () => {};
    setImmediate(() => s.emit("secureConnect"));
    return { connect: (() => s) as any, socket: s };
  }

  it("a complete exchange, even split across reads, passes and names the NTP server", async () => {
    const full = goodResponse();
    const { connect, socket } = fakeConnect("ntske/1", [full.subarray(0, 7), full.subarray(7)]);
    await expect(checkNtsKe("nts.example.net", { connect })).resolves.toMatchObject({ cookies: 2, server: "time.example.net", port: 0x123 });
    expect(socket.written[0].equals(buildNtsKeRequest())).toBe(true);
  });

  it("refuses no ALPN, an error record, no cookies, and a connection closed early", async () => {
    await expect(checkNtsKe("x", fakeConnect(false, []))).rejects.toThrow(/no ntske\/1 ALPN/);
    await expect(checkNtsKe("x", fakeConnect("ntske/1", [Buffer.concat([rec(2, [0, 1]), rec(0, [])])]))).rejects.toThrow(/bad request/);
    await expect(checkNtsKe("x", fakeConnect("ntske/1", [Buffer.concat([rec(1, [0, 0]), rec(4, [0, 15]), rec(0, [])])]))).rejects.toThrow(/no cookies/);
    const early = fakeConnect("ntske/1", []);
    const p = checkNtsKe("x", early);
    setTimeout(() => early.socket.emit("end"), 5);
    await expect(p).rejects.toThrow(/closed the connection/);
  });
});
