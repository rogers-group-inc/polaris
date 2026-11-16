/**
 * tests/unit/deviceHttp.test.ts — services/firmwareEngines/deviceHttp.ts, the
 * HTTP client the firmware engines (rules 87, 129, 138) and the reboot login
 * link (rule 115) use against a device's own web UI.
 *
 * Its header lists the hardware-learned rules this pins: TLS unverified but
 * pinned (rule 113, with the Fortinet serial precheck), the one legacy
 * renegotiation retry, redirects never followed, bare name=value cookies, a
 * precomputed Content-Length on streamed uploads, an IDLE (not total) upload
 * cap that becomes an answer cap once the body is sent (uploadAnswerMs, rule
 * 129), capped bodies, gzip bodies inflated, and an abort that rejects with
 * an AbortError — never a DeviceConnectionError (rule 138(b)).
 *
 * node:https / node:http are mocked at the module boundary with a scripted
 * fake request; the pinning agent is mocked. Upload sources are real files in
 * os.tmpdir().
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { constants as cryptoConstants } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

type Responder = (req: FakeReq) => void;

interface FakeReq extends EventEmitter {
  scheme: "https" | "http";
  opts: Record<string, any>;
  written: Buffer[];
  ended: boolean;
  destroyedWith: Error | null;
  timeoutMs: number | null;
  timeoutCb: (() => void) | null;
  writeReturns: boolean;
  respond(r: { status?: number; headers?: Record<string, unknown>; chunks?: Array<Buffer | string> }): void;
  fail(err: Error & { code?: string }): void;
  setTimeout(ms: number, cb: () => void): void;
  write(b: Buffer): boolean;
  end(data?: Buffer | (() => void), cb?: () => void): void;
  destroy(err?: Error): void;
}

const h = vi.hoisted(() => ({
  reqs: [] as unknown[],
  responder: null as null | ((req: unknown) => void),
  pinnedAgentFor: vi.fn((..._a: unknown[]) => ({ fake: "agent" })),
}));

function makeReq(scheme: "https" | "http", opts: Record<string, any>, cb: (res: unknown) => void): FakeReq {
  const req = new EventEmitter() as FakeReq;
  Object.assign(req, {
    scheme, opts, written: [] as Buffer[], ended: false, destroyedWith: null, timeoutMs: null, timeoutCb: null, writeReturns: true,
  });
  let settledRes = false;
  req.respond = ({ status = 200, headers = {}, chunks = [] }) => {
    if (settledRes) return;
    settledRes = true;
    const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, unknown> };
    res.statusCode = status;
    res.headers = headers;
    cb(res);
    for (const c of chunks) res.emit("data", typeof c === "string" ? Buffer.from(c) : c);
    res.emit("end");
  };
  req.fail = (err) => { process.nextTick(() => req.emit("error", err)); };
  req.setTimeout = (ms, fn) => { req.timeoutMs = ms; req.timeoutCb = fn; };
  req.write = (b) => { req.written.push(Buffer.from(b)); return req.writeReturns; };
  req.end = (data?: Buffer | (() => void), cb2?: () => void) => {
    if (Buffer.isBuffer(data)) req.written.push(Buffer.from(data));
    req.ended = true;
    const done = typeof data === "function" ? data : cb2;
    process.nextTick(() => {
      done?.();
      h.responder?.(req);
    });
  };
  req.destroy = (err?: Error) => {
    req.destroyedWith = err ?? new Error("destroyed");
    process.nextTick(() => req.emit("error", req.destroyedWith));
  };
  h.reqs.push(req);
  return req;
}

vi.mock("node:https", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  request: (opts: Record<string, any>, cb: (res: unknown) => void) => makeReq("https", opts, cb),
}));
vi.mock("node:http", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  request: (opts: Record<string, any>, cb: (res: unknown) => void) => makeReq("http", opts, cb),
}));
vi.mock("../../src/utils/pinnedTlsAgent.js", () => ({ pinnedAgentFor: h.pinnedAgentFor }));

import {
  DeviceHttpClient, DeviceConnectionError, fortinetSerialPrecheck, base64Length, Base64Encode, jsonOrNull, asString,
} from "../../src/services/firmwareEngines/deviceHttp.js";

const reqs = () => h.reqs as FakeReq[];
const respondWith = (r: Responder) => { h.responder = r as (req: unknown) => void; };
const ok = (body = "{}", headers: Record<string, unknown> = {}) => respondWith((req) => req.respond({ status: 200, headers, chunks: [body] }));

function client(over: Partial<ConstructorParameters<typeof DeviceHttpClient>[0]> = {}) {
  return new DeviceHttpClient({ host: "10.0.0.5", commandMs: 5000, uploadIdleMs: 1000, ...over });
}

async function ticks(n = 50) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

/** Spin the event loop (real I/O, setImmediate — never the faked setTimeout) until `cond` or 2 s. */
async function until(cond: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setImmediate(r));
  await ticks(3);
}

let dir = "";
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "polaris-devicehttp-")); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

beforeEach(() => {
  h.reqs.length = 0;
  h.responder = null;
  h.pinnedAgentFor.mockClear();
});

// ─── pure helpers ──────────────────────────────────────────────────────────

describe("fortinetSerialPrecheck (rule 113(c))", () => {
  const forti = (cn: unknown, o: unknown = "Fortinet") => ({ subject: { O: o, CN: cn } as never });

  it("passes when the asset has no serial to compare", () => {
    expect(fortinetSerialPrecheck(null, forti("FGT60F0000000001"))).toEqual({ ok: true });
    expect(fortinetSerialPrecheck("  ", forti("FGT60F0000000001"))).toEqual({ ok: true });
  });

  it("leaves a certificate the operator installed (not a Fortinet factory one) to the pin", () => {
    expect(fortinetSerialPrecheck("FGT60F0000000001", forti("FGT60F0000000002", "Acme Corp"))).toEqual({ ok: true });
    expect(fortinetSerialPrecheck("FGT60F0000000001", forti("fw.example.com"))).toEqual({ ok: true });
    expect(fortinetSerialPrecheck("FGT60F0000000001", { subject: undefined as never })).toEqual({ ok: true });
  });

  it("passes a factory certificate naming this serial, case- and space-blind", () => {
    expect(fortinetSerialPrecheck(" fgt60f0000000001 ", forti("FGT60F0000000001"))).toEqual({ ok: true });
    expect(fortinetSerialPrecheck("FGT60F0000000001", forti(["fgt60f0000000001"], ["Fortinet"]))).toEqual({ ok: true });
  });

  it("refuses a factory certificate naming another serial, naming both", () => {
    const v = fortinetSerialPrecheck("FGT60F0000000001", forti("FGT60F0000000099"));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/FGT60F0000000099.*FGT60F0000000001/);
  });
});

describe("base64Length / Base64Encode", () => {
  it("base64Length is the padded length", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(base64Length)).toEqual([0, 4, 4, 4, 8, 8, 8, 12]);
  });

  it("streams byte-identical base64 whatever the chunk boundaries", async () => {
    const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 37) % 256));
    for (const sizes of [[1], [2], [3], [7, 1, 5], [1000]]) {
      const chunks: Buffer[] = [];
      let at = 0, k = 0;
      while (at < data.length) { const n = sizes[k++ % sizes.length]; chunks.push(data.subarray(at, at + n)); at += n; }
      const out: string[] = [];
      await new Promise<void>((resolve, reject) => {
        Readable.from(chunks).pipe(new Base64Encode()).on("data", (s: Buffer | string) => out.push(String(s))).on("end", resolve).on("error", reject);
      });
      const joined = out.join("");
      expect(joined).toBe(data.toString("base64"));
      expect(joined.length).toBe(base64Length(data.length));
    }
  });

  it("an empty stream encodes to nothing", async () => {
    const out: string[] = [];
    await new Promise<void>((resolve) => { Readable.from([]).pipe(new Base64Encode()).on("data", (s) => out.push(String(s))).on("end", resolve); });
    expect(out.join("")).toBe("");
  });
});

describe("jsonOrNull / asString", () => {
  it("jsonOrNull keeps only a JSON object", () => {
    expect(jsonOrNull('{"a":1}')).toEqual({ a: 1 });
    for (const s of ["[1]", "null", "5", '"x"', "<html>", ""]) expect(jsonOrNull(s)).toBeNull();
  });

  it("asString: non-empty strings and numbers, else null", () => {
    expect(asString("x")).toBe("x");
    expect(asString(42)).toBe("42");
    expect(asString(0)).toBe("0");
    for (const v of ["", null, undefined, true, {}, []]) expect(asString(v)).toBeNull();
  });
});

// ─── request shape ─────────────────────────────────────────────────────────

describe("DeviceHttpClient — request shape", () => {
  it("builds its base from scheme / port, bracketing IPv6", () => {
    expect(client().base).toBe("https://10.0.0.5:443");
    expect(client({ scheme: "http" }).base).toBe("http://10.0.0.5:80");
    expect(client({ port: 8443 }).base).toBe("https://10.0.0.5:8443");
    expect(client({ host: "fe80::1" }).base).toBe("https://[fe80::1]:443");
  });

  it("an unverified HTTPS GET uses a fresh pinning agent carrying the serial precheck", async () => {
    ok('{"x":1}');
    const c = client({ host: "2001:db8::5", port: 4443, expectedSerial: "FGT60F0000000001" });
    const res = await c.get("/api/v2/monitor/system/status?vdom=root");
    expect(res).toMatchObject({ status: 200, body: '{"x":1}', location: null });
    const o = reqs()[0].opts;
    expect(reqs()[0].scheme).toBe("https");
    expect(o).toMatchObject({ hostname: "2001:db8::5", port: "4443", path: "/api/v2/monitor/system/status?vdom=root", method: "GET", rejectUnauthorized: false });
    expect(o.headers).toMatchObject({ accept: "*/*", "user-agent": "Polaris-Firmware/1.0" });
    expect(o.headers["content-length"]).toBeUndefined();
    expect(o.agent).toEqual({ fake: "agent" });
    expect(h.pinnedAgentFor).toHaveBeenCalledWith("2001:db8::5", 4443, expect.objectContaining({ precheck: expect.any(Function) }));
    const precheck = (h.pinnedAgentFor.mock.calls[0][2] as { precheck: (c: unknown) => unknown }).precheck;
    expect(precheck({ subject: { O: "Fortinet", CN: "FGT60F0000000002" } })).toMatchObject({ ok: false });
    expect(precheck({ subject: { O: "Fortinet", CN: "FGT60F0000000001" } })).toEqual({ ok: true });
    expect(reqs()[0].timeoutMs).toBe(5000);
  });

  it("verifyTls verifies the chain and uses no pinning agent", async () => {
    ok();
    await client({ verifyTls: true }).get("/");
    expect(reqs()[0].opts).toMatchObject({ rejectUnauthorized: true, agent: false });
    expect(h.pinnedAgentFor).not.toHaveBeenCalled();
  });

  it("plain http goes through node:http with no agent", async () => {
    ok();
    await client({ scheme: "http" }).get("/x", 1234);
    expect(reqs()[0].scheme).toBe("http");
    expect(reqs()[0].opts.agent).toBe(false);
    expect(reqs()[0].timeoutMs).toBe(1234);
  });

  it("postForm url-encodes fields in order with a Content-Length", async () => {
    ok();
    await client().postForm("/logincheck", [{ name: "username", value: "ad min" }, { name: "secretkey", value: "p&ss=1" }]);
    const r = reqs()[0];
    const body = Buffer.concat(r.written).toString();
    expect(body).toBe("username=ad%20min&secretkey=p%26ss%3D1");
    expect(r.opts.method).toBe("POST");
    expect(r.opts.headers).toMatchObject({ "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) });
  });

  it("postJson sends JSON; postEmpty sends Content-Length 0; delete is bodiless", async () => {
    ok();
    const c = client();
    await c.postJson("/api", { a: "é" });
    await c.postEmpty("/probe");
    await c.delete("/api/v2/authentication");
    const [j, e, d] = reqs();
    expect(Buffer.concat(j.written).toString("utf8")).toBe('{"a":"é"}');
    expect(j.opts.headers).toMatchObject({ "content-type": "application/json", "content-length": String(Buffer.byteLength('{"a":"é"}')) });
    expect(e.opts.headers["content-length"]).toBe("0");
    expect(d.opts.method).toBe("DELETE");
    expect(d.opts.headers["content-length"]).toBeUndefined();
  });

  it("echoes a header set with setHeader until it is cleared", async () => {
    ok();
    const c = client();
    c.setHeader("X-CSRF-Token", "abc");
    await c.get("/1");
    c.setHeader("X-CSRF-Token", null);
    await c.get("/2");
    expect(reqs()[0].opts.headers["X-CSRF-Token"]).toBe("abc");
    expect(reqs()[1].opts.headers["X-CSRF-Token"]).toBeUndefined();
  });
});

// ─── responses ─────────────────────────────────────────────────────────────

describe("DeviceHttpClient — responses", () => {
  it("never follows a redirect: a 302 is the answer, with its Location", async () => {
    respondWith((req) => req.respond({ status: 302, headers: { location: "/login" } }));
    const res = await client().get("/system/status");
    expect(res).toMatchObject({ status: 302, location: "/login", body: "" });
    expect(reqs()).toHaveLength(1);
  });

  it("keeps bare name=value cookies, sends them back, and forgets an emptied one", async () => {
    const c = client();
    respondWith((req) => req.respond({ headers: { "set-cookie": [
      "APSCOOKIE_1234=tok%3D; Domain=10.0.0.5; Path=/; Secure; HttpOnly",
      "ccsrftoken_443=\"abc\"; Path=/",
      "=junk",
      "noequals",
    ] } }));
    await c.get("/login");
    expect(c.cookieCount()).toBe(2);
    expect(c.hasCookie("APSCOOKIE_1234")).toBe(true);
    expect(c.cookieMatching(/^ccsrftoken/)).toBe('"abc"');
    expect(c.cookieMatching(/^nope/)).toBeNull();

    respondWith((req) => req.respond({ headers: { "set-cookie": ['ccsrftoken_443=""; Path=/', "APSCOOKIE_1234=; Max-Age=0"] } }));
    await c.get("/next");
    expect(reqs()[1].opts.headers.cookie).toBe('APSCOOKIE_1234=tok%3D; ccsrftoken_443="abc"');
    expect(c.cookieCount()).toBe(0);

    ok();
    await c.get("/after");
    expect(reqs()[2].opts.headers.cookie).toBeUndefined();
  });

  it("clearSession drops cookies and echoed headers", async () => {
    const c = client();
    respondWith((req) => req.respond({ headers: { "set-cookie": ["a=1"] } }));
    await c.get("/");
    c.setHeader("X-Token", "t");
    c.clearSession();
    expect(c.cookieCount()).toBe(0);
    ok();
    await c.get("/");
    expect(c.cookieCount()).toBe(0);
    expect(reqs()[1].opts.headers.cookie).toBeUndefined();
    expect(reqs()[1].opts.headers["X-Token"]).toBeUndefined();
  });

  it("caps the body at maxBodyBytes (chunks past the cap are dropped)", async () => {
    respondWith((req) => req.respond({ chunks: ["12345678", "abcdefgh"] }));
    const res = await client({ maxBodyBytes: 10 }).get("/");
    expect(res.body).toBe("12345678");
  });

  it("inflates a gzip body — by header or by its magic bytes — and passes a fake one through", async () => {
    const gz = gzipSync(Buffer.from("<html>login</html>"));
    respondWith((req) => req.respond({ headers: { "content-encoding": "gzip" }, chunks: [gz] }));
    expect((await client().get("/")).body).toBe("<html>login</html>");
    respondWith((req) => req.respond({ chunks: [gz] }));
    expect((await client().get("/")).body).toBe("<html>login</html>");
    respondWith((req) => req.respond({ headers: { "content-encoding": "gzip" }, chunks: ["plain text"] }));
    expect((await client().get("/")).body).toBe("plain text");
  });

  it("a socket that dies without a status line is a DeviceConnectionError with its code", async () => {
    respondWith((req) => req.fail(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })));
    const err = await client().get("/").catch((e) => e);
    expect(err).toBeInstanceOf(DeviceConnectionError);
    expect(err).toMatchObject({ message: "read ECONNRESET", code: "ECONNRESET", bytesSent: 0, bodyFullySent: false });
  });

  it("the request timeout destroys the request and rejects as a DeviceConnectionError", async () => {
    respondWith((req) => req.timeoutCb?.());
    const err = await client({ commandMs: 777 }).get("/").catch((e) => e);
    expect(err).toBeInstanceOf(DeviceConnectionError);
    expect(err.message).toBe("timed out after 777 ms");
  });

  it("an unsafe-legacy-renegotiation failure is retried ONCE with SSL_OP_LEGACY_SERVER_CONNECT, which then sticks", async () => {
    let n = 0;
    respondWith((req) => { if (n++ === 0) req.fail(new Error("unsafe legacy renegotiation disabled")); else req.respond({ chunks: ["ok"] }); });
    const c = client();
    expect((await c.get("/")).body).toBe("ok");
    expect(reqs()).toHaveLength(2);
    expect(reqs()[0].opts.secureOptions).toBeUndefined();
    expect(reqs()[1].opts.secureOptions).toBe(cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT);
    await c.get("/again");
    expect(reqs()[2].opts.secureOptions).toBe(cryptoConstants.SSL_OP_LEGACY_SERVER_CONNECT);
  });

  it("a second renegotiation failure is thrown, not retried again", async () => {
    respondWith((req) => req.fail(new Error("unsafe legacy renegotiation disabled")));
    await expect(client().get("/")).rejects.toBeInstanceOf(DeviceConnectionError);
    expect(reqs()).toHaveLength(2);
  });
});

// ─── abort (rule 138(b)) ───────────────────────────────────────────────────

describe("DeviceHttpClient — abort", () => {
  it("an already-aborted run sends nothing and rejects with an AbortError", async () => {
    const ac = new AbortController();
    ac.abort();
    const err = await client({ signal: ac.signal }).get("/").catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(DeviceConnectionError);
    expect(reqs()).toHaveLength(0);
  });

  it("an abort mid-request destroys it and rejects with an AbortError, never a connection error, and is not retried", async () => {
    const ac = new AbortController();
    respondWith(() => { /* the device never answers */ });
    const p = client({ signal: ac.signal }).get("/").catch((e) => e);
    await ticks(5);
    ac.abort();
    const err = await p;
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(DeviceConnectionError);
    expect(reqs()[0].destroyedWith?.name).toBe("AbortError");
    expect(reqs()).toHaveLength(1);
  });

  it("releaseSignal lets the clean-up an aborted engine owes the device go through", async () => {
    const ac = new AbortController();
    ac.abort();
    const c = client({ signal: ac.signal });
    c.releaseSignal();
    ok("done");
    expect((await c.get("/unstage")).body).toBe("done");
  });

  it("a completed request removes its abort listener", async () => {
    const ac = new AbortController();
    const remove = vi.spyOn(ac.signal, "removeEventListener");
    ok();
    await client({ signal: ac.signal }).get("/");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

// ─── streamed uploads ──────────────────────────────────────────────────────

describe("DeviceHttpClient — streamed uploads", () => {
  function file(name: string, bytes: Buffer) {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  }

  it("postMultipart: fields first in order, then the file, with a precomputed Content-Length that matches the bytes sent", async () => {
    const data = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    const p = file("fw.out", data);
    ok('{"status":"success"}');
    const progress: Array<[number, number]> = [];
    const res = await client().postMultipart("/upload", [{ name: "a", value: "1" }, { name: "b", value: "two" }],
      { field: "file", filename: "fw.out", path: p, size: data.length }, (s, t) => progress.push([s, t]));
    expect(res.status).toBe(200);
    const r = reqs()[0];
    const body = Buffer.concat(r.written);
    expect(r.opts.headers["content-length"]).toBe(String(body.length));
    const boundary = /boundary=(\S+)/.exec(r.opts.headers["content-type"])![1];
    expect(boundary).toMatch(/^----PolarisFirmware[0-9a-f]{24}$/);
    const text = body.toString("latin1");
    expect(text.indexOf('name="a"')).toBeLessThan(text.indexOf('name="b"'));
    expect(text.indexOf('name="b"')).toBeLessThan(text.indexOf('filename="fw.out"'));
    expect(text).toContain("Content-Type: application/octet-stream");
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(body.includes(data)).toBe(true);
    const last = progress[progress.length - 1];
    expect(last).toEqual([body.length, body.length]);
  });

  it("postJsonBase64File streams { ...fields, file: base64 } with a matching Content-Length", async () => {
    const data = Buffer.from(Array.from({ length: 4001 }, (_, i) => (i * 7) % 256));
    const p = file("fgt.out", data);
    ok();
    await client().postJsonBase64File("/api/v2/monitor/system/firmware/upgrade", { source: "upload", flag: true, n: 2 }, "file_content", { path: p, size: data.length });
    const r = reqs()[0];
    const body = Buffer.concat(r.written).toString("utf8");
    expect(r.opts.headers["content-length"]).toBe(String(Buffer.byteLength(body)));
    expect(JSON.parse(body)).toEqual({ source: "upload", flag: true, n: 2, file_content: data.toString("base64") });
  });

  it("postJsonBase64File with no other fields is still valid JSON", async () => {
    const data = Buffer.from("hello");
    const p = file("tiny.out", data);
    ok();
    await client().postJsonBase64File("/x", {}, "file_content", { path: p, size: data.length });
    expect(JSON.parse(Buffer.concat(reqs()[0].written).toString())).toEqual({ file_content: data.toString("base64") });
  });

  it("a connection that dies mid-upload is a DeviceConnectionError reporting the bytes sent", async () => {
    const data = Buffer.alloc(100, 1);
    const p = file("die.out", data);
    respondWith((req) => req.fail(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })));
    const err = await client().postMultipart("/u", [], { field: "f", filename: "f", path: p, size: data.length }).catch((e) => e);
    expect(err).toBeInstanceOf(DeviceConnectionError);
    expect(err.code).toBe("ECONNRESET");
    expect(err.bytesSent).toBe(Buffer.concat(reqs()[0].written).length);
    expect(err.bodyFullySent).toBe(true);
  });

  it("an already-aborted run uploads nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = file("ab.out", Buffer.from("x"));
    const err = await client({ signal: ac.signal }).postMultipart("/u", [], { field: "f", filename: "f", path: p, size: 1 }).catch((e) => e);
    expect(err.name).toBe("AbortError");
    expect(reqs()).toHaveLength(0);
  });

  it("an abort while waiting for the device's answer rejects with an AbortError, not a connection error", async () => {
    const ac = new AbortController();
    const p = file("ab2.out", Buffer.alloc(64, 2));
    respondWith(() => { /* never answers */ });
    const pr = client({ signal: ac.signal }).postMultipart("/u", [], { field: "f", filename: "f", path: p, size: 64 }).catch((e) => e);
    await until(() => reqs()[0]?.ended === true);
    ac.abort();
    const err = await pr;
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(DeviceConnectionError);
    expect(reqs()[0].destroyedWith?.name).toBe("AbortError");
  });

  describe("idle caps (fake timers)", () => {
    beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }); });
    afterEach(() => { vi.useRealTimers(); });

    it("an upload the device stops accepting fails after uploadIdleMs with the bytes sent", async () => {
      const p = file("stall.out", Buffer.alloc(10, 3));
      respondWith(() => { /* never answers */ });
      // The first file chunk fills the socket and no drain ever comes.
      const c = client({ uploadIdleMs: 30_000 });
      const pr = c.postMultipart("/u", [], { field: "f", filename: "f", path: p, size: 10 }).catch((e) => e);
      const r = () => reqs()[0];
      r().writeReturns = false;
      await until(() => r().written.length >= 2);
      expect(r().written.length).toBe(2);
      vi.advanceTimersByTime(30_000);
      const err = await pr;
      expect(err).toBeInstanceOf(DeviceConnectionError);
      expect(err.message).toMatch(/upload stalled: no bytes accepted for 30 s/);
      expect(err.bodyFullySent).toBe(false);
      expect(err.bytesSent).toBe(r().written[0].length + 10);
    });

    it("once the whole body is sent the cap becomes uploadAnswerMs (rule 129: an HA primary answers late)", async () => {
      const p = file("answer.out", Buffer.alloc(10, 4));
      respondWith(() => { /* answers only after the cap */ });
      const c = client({ uploadIdleMs: 1_000, uploadAnswerMs: 900_000 });
      const pr = c.postMultipart("/u", [], { field: "f", filename: "f", path: p, size: 10 }).catch((e) => e);
      await until(() => reqs()[0].ended);
      vi.advanceTimersByTime(1_000);
      await ticks(2);
      expect(reqs()[0].destroyedWith).toBeNull();
      vi.advanceTimersByTime(899_000);
      const err = await pr;
      expect(err).toBeInstanceOf(DeviceConnectionError);
      expect(err.message).toBe("no answer 900 s after the whole image was sent");
      expect(err.bodyFullySent).toBe(true);
    });

    it("without uploadAnswerMs the answer cap is the idle cap", async () => {
      const p = file("answer2.out", Buffer.alloc(10, 5));
      respondWith(() => { /* never answers */ });
      const pr = client({ uploadIdleMs: 2_000 }).postMultipart("/u", [], { field: "f", filename: "f", path: p, size: 10 }).catch((e) => e);
      await until(() => reqs()[0].ended);
      vi.advanceTimersByTime(2_000);
      const err = await pr;
      expect(err.message).toBe("no answer 2 s after the whole image was sent");
    });
  });
});
