/**
 * tests/unit/dnsService.test.ts — the own suite for src/services/dnsService.ts
 * (CQ-T010). dnsTestTarget.test.ts already covers parseDnsTestTarget; this
 * file covers the rest with node:dns/promises, node:https and node:tls mocked
 * at the module boundary (no socket is opened):
 *
 *   - settings: defaults, the migrate-safe verifyTls read (=== true), the
 *     partial update merge and blank-server filter;
 *   - the resolver factory's mode dispatch (doh needs a URL, dot needs
 *     servers, else standard);
 *   - standard: { timeout: 5000, tries: 1 }, hostname servers resolved to IPs
 *     (port kept, failures dropped), ttl null, A then AAAA fallback;
 *   - DoH: the PTR / A / AAAA query URLs (in-addr.arpa and nibble ip6.arpa),
 *     the type filter, numeric TTL, verifyTls → rejectUnauthorized, HTTP /
 *     connect / non-JSON / timeout errors, a failed record type skipped;
 *   - DoT: the TCP wire query, length-prefixed response reassembly across
 *     chunks, compression pointers, TTLs, server fallthrough, port parsing,
 *     A then AAAA, verifyTls, the 5 s timeout destroying the socket.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

const h = vi.hoisted(() => ({
  lookup: vi.fn(),
  resolverCtor: vi.fn(),
  setServers: vi.fn(),
  reverse: vi.fn(),
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  httpsGet: vi.fn(),
  tlsConnect: vi.fn(),
}));

vi.mock("node:dns/promises", () => {
  class Resolver {
    constructor(opts: unknown) { h.resolverCtor(opts); }
    setServers(s: string[]) { h.setServers(s); }
    reverse(ip: string) { return h.reverse(ip); }
    resolve4(n: string) { return h.resolve4(n); }
    resolve6(n: string) { return h.resolve6(n); }
  }
  const mod = { lookup: h.lookup, Resolver };
  return { default: mod, ...mod };
});
vi.mock("node:https", () => ({ default: { get: h.httpsGet }, get: h.httpsGet }));
vi.mock("node:tls", () => ({ default: { connect: h.tlsConnect }, connect: h.tlsConnect }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  getDnsSettings,
  updateDnsSettings,
  createResolver,
  getConfiguredResolver,
  type DnsSettings,
} from "../../src/services/dnsService.js";

const db = prisma as any;

const settings = (over: Partial<DnsSettings> = {}): DnsSettings => ({ servers: [], mode: "standard", dohUrl: "", verifyTls: false, ...over });

// ─── DNS wire helpers ───────────────────────────────────────────────────────

function encName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const l of name.split(".").filter(Boolean)) parts.push(Buffer.from([l.length]), Buffer.from(l, "ascii"));
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

type Answer = { type: number; ttl: number; rdata: Buffer };

/** A response echoing `qname`, each answer's owner a pointer to the question (0xC00C). */
function dnsResponse(qname: string, qtype: number, answers: Answer[]): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);
  const q = Buffer.concat([encName(qname), Buffer.from([0, qtype, 0, 1])]);
  const rrs = answers.map((a) => {
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0);
    fixed.writeUInt16BE(a.type, 2);
    fixed.writeUInt16BE(1, 4);
    fixed.writeUInt32BE(a.ttl, 6);
    fixed.writeUInt16BE(a.rdata.length, 10);
    return Buffer.concat([fixed, a.rdata]);
  });
  return Buffer.concat([header, q, ...rrs]);
}

const lenPrefixed = (b: Buffer) => { const p = Buffer.alloc(2); p.writeUInt16BE(b.length, 0); return Buffer.concat([p, b]); };

/** Decode the QNAME / QTYPE of a length-prefixed TCP DNS query. */
function decodeQuery(buf: Buffer): { len: number; name: string; qtype: number; rd: boolean; qdcount: number } {
  const len = buf.readUInt16BE(0);
  const msg = buf.subarray(2);
  const labels: string[] = [];
  let o = 12;
  while (msg[o] !== 0) { labels.push(msg.subarray(o + 1, o + 1 + msg[o]).toString("ascii")); o += 1 + msg[o]; }
  return { len, name: labels.join("."), qtype: msg.readUInt16BE(o + 1), rd: (msg.readUInt16BE(2) & 0x0100) !== 0, qdcount: msg.readUInt16BE(4) };
}

// ─── socket / https fakes ───────────────────────────────────────────────────

type TlsBehaviour = { error?: Error; chunks?: Buffer[]; closeEarly?: boolean; silent?: boolean };
let tlsQueue: TlsBehaviour[] = [];
let tlsWrites: Buffer[] = [];
let sockets: Array<EventEmitter & { destroy: ReturnType<typeof vi.fn> }> = [];

function installTls() {
  h.tlsConnect.mockImplementation((_opts: unknown, onConnect: () => void) => {
    const b = tlsQueue.shift() ?? { error: new Error("no behaviour queued") };
    const sock = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy: vi.fn(function (this: any) { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => sock.emit("close")); } }),
      write: vi.fn((buf: Buffer) => {
        tlsWrites.push(buf);
        if (b.silent) return;
        queueMicrotask(() => {
          for (const c of b.chunks ?? []) sock.emit("data", c);
          if (b.closeEarly) sock.destroy();
        });
      }),
    });
    sockets.push(sock as any);
    queueMicrotask(() => { if (b.error) sock.emit("error", b.error); else onConnect(); });
    return sock;
  });
}

type HttpsBehaviour = { status?: number; body?: string; error?: { code?: string; message?: string }; hang?: boolean };
let httpsQueue: HttpsBehaviour[] = [];
let httpsReqs: Array<{ url: string; opts: any; req: EventEmitter & { destroy: ReturnType<typeof vi.fn> } }> = [];

function installHttps() {
  h.httpsGet.mockImplementation((url: string, opts: any, cb: (res: any) => void) => {
    const b = httpsQueue.shift() ?? { status: 200, body: "{}" };
    const req = Object.assign(new EventEmitter(), { destroy: vi.fn() });
    httpsReqs.push({ url, opts, req });
    if (b.hang) return req;
    queueMicrotask(() => {
      if (b.error) {
        req.emit("error", Object.assign(new Error(b.error.message ?? ""), { code: b.error.code }));
        return;
      }
      const res = Object.assign(new EventEmitter(), { statusCode: b.status ?? 200, resume: vi.fn() });
      cb(res);
      queueMicrotask(() => { res.emit("data", Buffer.from(b.body ?? "")); res.emit("end"); });
    });
    return req;
  });
}

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(h)) f.mockReset();
  tlsQueue = []; tlsWrites = []; sockets = []; httpsQueue = []; httpsReqs = [];
  installTls();
  installHttps();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── settings ───────────────────────────────────────────────────────────────

describe("getDnsSettings", () => {
  it("defaults when nothing is stored", async () => {
    stubbed(db.setting.findUnique).mockResolvedValue(null);
    expect(await getDnsSettings()).toEqual({ servers: [], mode: "standard", dohUrl: "", verifyTls: false });
    expect(stubbed(db.setting.findUnique).mock.calls[0][0]).toEqual({ where: { key: "dnsSettings" } });
  });

  it("fills missing fields and keeps a flagless stored setting at no-verify (migrate-safe)", async () => {
    stubbed(db.setting.findUnique).mockResolvedValue({ value: { mode: "dot" } });
    expect(await getDnsSettings()).toEqual({ servers: [], mode: "dot", dohUrl: "", verifyTls: false });
    stubbed(db.setting.findUnique).mockResolvedValue({ value: { servers: ["1.1.1.1"], verifyTls: "true" } });
    expect((await getDnsSettings()).verifyTls).toBe(false);
    stubbed(db.setting.findUnique).mockResolvedValue({ value: { servers: ["1.1.1.1"], mode: "doh", dohUrl: "https://x/resolve", verifyTls: true } });
    expect(await getDnsSettings()).toEqual({ servers: ["1.1.1.1"], mode: "doh", dohUrl: "https://x/resolve", verifyTls: true });
  });
});

describe("updateDnsSettings", () => {
  it("merges a partial update over the stored value, drops blank servers, and upserts", async () => {
    stubbed(db.setting.findUnique).mockResolvedValue({ value: { servers: ["9.9.9.9"], mode: "dot", dohUrl: "", verifyTls: true } });
    const out = await updateDnsSettings({ servers: ["1.1.1.1", "", "8.8.8.8"] });
    expect(out).toEqual({ servers: ["1.1.1.1", "8.8.8.8"], mode: "dot", dohUrl: "", verifyTls: true });
    expect(stubbed(db.setting.upsert).mock.calls[0][0]).toEqual({
      where: { key: "dnsSettings" }, update: { value: out }, create: { key: "dnsSettings", value: out },
    });
  });

  it("keeps the stored servers when none are given and lets verifyTls be turned off", async () => {
    stubbed(db.setting.findUnique).mockResolvedValue({ value: { servers: ["9.9.9.9"], mode: "standard", verifyTls: true } });
    expect(await updateDnsSettings({ verifyTls: false, mode: "doh", dohUrl: "https://dns.google/resolve" }))
      .toEqual({ servers: ["9.9.9.9"], mode: "doh", dohUrl: "https://dns.google/resolve", verifyTls: false });
  });
});

// ─── standard mode ──────────────────────────────────────────────────────────

describe("createResolver — standard", () => {
  it("builds an isolated resolver with one 5 s try and leaves system servers alone when none are set", async () => {
    await createResolver(settings());
    expect(h.resolverCtor).toHaveBeenCalledWith({ timeout: 5000, tries: 1 });
    expect(h.setServers).not.toHaveBeenCalled();
  });

  it("resolves hostname servers to IPs (keeping a port), passes IPs through, drops what will not resolve", async () => {
    h.lookup.mockImplementation(async (host: string) => {
      if (host === "dns.corp.lan") return { address: "10.0.0.53" };
      throw new Error("ENOTFOUND");
    });
    await createResolver(settings({ servers: ["1.1.1.1", "8.8.8.8:5353", "[2001:db8::53]:53", "2001:db8::54", "dns.corp.lan:5300", "nowhere.lan"] }));
    expect(h.setServers).toHaveBeenCalledWith(["1.1.1.1", "8.8.8.8:5353", "[2001:db8::53]:53", "2001:db8::54", "10.0.0.53:5300"]);
    expect(h.lookup).toHaveBeenCalledTimes(2);
  });

  it("calls setServers not at all when every server fails to resolve", async () => {
    h.lookup.mockRejectedValue(new Error("ENOTFOUND"));
    await createResolver(settings({ servers: ["a.lan", "b.lan"] }));
    expect(h.setServers).not.toHaveBeenCalled();
  });

  it("reverse returns every PTR name with ttl null", async () => {
    h.reverse.mockResolvedValue(["host.corp.lan", "alias.corp.lan"]);
    const r = await createResolver(settings());
    expect(await r.reverse("10.0.0.5")).toEqual([{ name: "host.corp.lan", ttl: null }, { name: "alias.corp.lan", ttl: null }]);
    expect(h.reverse).toHaveBeenCalledWith("10.0.0.5");
  });

  it("reverse propagates a resolver failure", async () => {
    h.reverse.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    const r = await createResolver(settings());
    await expect(r.reverse("10.0.0.5")).rejects.toThrow("ENOTFOUND");
  });

  it("lookup answers A first, falling back to AAAA only when A fails", async () => {
    h.resolve4.mockResolvedValue(["10.0.0.5", "10.0.0.6"]);
    const r = await createResolver(settings());
    expect(await r.lookup("nas.lan")).toEqual([{ address: "10.0.0.5", family: 4 }, { address: "10.0.0.6", family: 4 }]);
    expect(h.resolve6).not.toHaveBeenCalled();

    h.resolve4.mockRejectedValue(new Error("ENODATA"));
    h.resolve6.mockResolvedValue(["2001:db8::5"]);
    expect(await r.lookup("nas.lan")).toEqual([{ address: "2001:db8::5", family: 6 }]);
  });

  it("lookup throws when both families fail", async () => {
    h.resolve4.mockRejectedValue(new Error("ENODATA"));
    h.resolve6.mockRejectedValue(new Error("ENOTFOUND"));
    const r = await createResolver(settings());
    await expect(r.lookup("nas.lan")).rejects.toThrow("ENOTFOUND");
  });

  it("falls back to standard for doh without a URL and dot without servers", async () => {
    await createResolver(settings({ mode: "doh", dohUrl: "" }));
    await createResolver(settings({ mode: "dot", servers: [] }));
    expect(h.resolverCtor).toHaveBeenCalledTimes(2);
    expect(h.httpsGet).not.toHaveBeenCalled();
    expect(h.tlsConnect).not.toHaveBeenCalled();
  });

  it("getConfiguredResolver builds from the stored settings", async () => {
    stubbed(db.setting.findUnique).mockResolvedValue({ value: { mode: "doh", dohUrl: "https://dns.google/resolve" } });
    const r = await getConfiguredResolver();
    httpsQueue.push({ body: JSON.stringify({ Answer: [] }) });
    await r.reverse("10.0.0.5");
    expect(h.httpsGet).toHaveBeenCalledTimes(1);
    expect(h.resolverCtor).not.toHaveBeenCalled();
  });
});

// ─── DoH ────────────────────────────────────────────────────────────────────

describe("createResolver — DoH", () => {
  const doh = (over: Partial<DnsSettings> = {}) => createResolver(settings({ mode: "doh", dohUrl: "https://dns.google/resolve", ...over }));

  it("asks for the in-addr.arpa PTR with the dns-json Accept, keeping PTR answers only, trailing dot dropped", async () => {
    httpsQueue.push({ body: JSON.stringify({ Answer: [
      { type: 5, data: "cname.example.", TTL: 30 },
      { type: 12, data: "host.example.", TTL: 300 },
      { type: 12, data: "alias.example", TTL: "x" },
    ] }) });
    const r = await doh();
    expect(await r.reverse("10.0.0.5")).toEqual([{ name: "host.example", ttl: 300 }, { name: "alias.example", ttl: null }]);
    const { url, opts } = httpsReqs[0];
    expect(url).toBe("https://dns.google/resolve?ct=application/dns-json&name=5.0.0.10.in-addr.arpa&type=PTR");
    expect(opts.headers).toEqual({ Accept: "application/dns-json" });
    expect(opts.rejectUnauthorized).toBe(false);
  });

  it("uses the nibble-reversed ip6.arpa name for an IPv6 PTR and '&' when the URL has a query", async () => {
    httpsQueue.push({ body: "{}" });
    const r = await doh({ dohUrl: "https://doh.corp/dns-query?x=1" });
    expect(await r.reverse("2001:db8::1")).toEqual([]);
    expect(httpsReqs[0].url).toBe(
      "https://doh.corp/dns-query?x=1&ct=application/dns-json&name=" +
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa&type=PTR",
    );
  });

  it("verifies the certificate only when verifyTls is set", async () => {
    httpsQueue.push({ body: "{}" });
    await (await doh({ verifyTls: true })).reverse("10.0.0.5");
    expect(httpsReqs[0].opts.rejectUnauthorized).toBe(true);
  });

  it("returns [] when the answer section is missing or not an array", async () => {
    httpsQueue.push({ body: JSON.stringify({ Status: 3 }) }, { body: JSON.stringify({ Answer: "nope" }) });
    const r = await doh();
    expect(await r.reverse("10.0.0.5")).toEqual([]);
    expect(await r.reverse("10.0.0.5")).toEqual([]);
  });

  it("rejects a non-2xx answer with DOH_HTTP_ERROR and drains it", async () => {
    httpsQueue.push({ status: 404, body: "nf" });
    const r = await doh();
    await expect(r.reverse("10.0.0.5")).rejects.toMatchObject({ code: "DOH_HTTP_ERROR", message: "DoH query failed (HTTP 404)" });
  });

  it.each([
    [{ code: "ENOTFOUND" }, "Cannot resolve hostname in DoH URL"],
    [{ code: "ECONNREFUSED" }, "Connection refused by DoH server"],
    [{ code: "EPIPE", message: "socket hang up" }, "socket hang up"],
  ])("maps a connect error %o to DOH_CONNECT_ERROR", async (error, message) => {
    httpsQueue.push({ error });
    const r = await doh();
    await expect(r.reverse("10.0.0.5")).rejects.toMatchObject({ code: "DOH_CONNECT_ERROR", message });
  });

  it("rejects a non-JSON body with DOH_PARSE_ERROR", async () => {
    httpsQueue.push({ body: "<html>" });
    const r = await doh();
    await expect(r.reverse("10.0.0.5")).rejects.toMatchObject({ code: "DOH_PARSE_ERROR" });
  });

  it("times out after 5 s, destroying the request", async () => {
    vi.useFakeTimers();
    httpsQueue.push({ hang: true });
    const r = await doh();
    const p = r.reverse("10.0.0.5").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await p).toMatchObject({ code: "DOH_TIMEOUT" });
    expect(httpsReqs[0].req.destroy).toHaveBeenCalled();
  });

  it("lookup asks A then AAAA and merges the matching answers", async () => {
    httpsQueue.push(
      { body: JSON.stringify({ Answer: [{ type: 5, data: "x." }, { type: 1, data: "10.0.0.5" }, { type: 1 }] }) },
      { body: JSON.stringify({ Answer: [{ type: 28, data: "2001:db8::5" }] }) },
    );
    const r = await doh();
    expect(await r.lookup("nas.lan")).toEqual([{ address: "10.0.0.5", family: 4 }, { address: "2001:db8::5", family: 6 }]);
    expect(httpsReqs.map((x) => x.url.split("&type=")[1])).toEqual(["A", "AAAA"]);
    expect(httpsReqs[0].url).toContain("name=nas.lan");
  });

  it("lookup skips a record type that errors instead of failing", async () => {
    httpsQueue.push({ status: 500 }, { body: JSON.stringify({ Answer: [{ type: 28, data: "2001:db8::5" }] }) });
    const r = await doh();
    expect(await r.lookup("nas.lan")).toEqual([{ address: "2001:db8::5", family: 6 }]);
  });
});

// ─── DoT ────────────────────────────────────────────────────────────────────

describe("createResolver — DoT", () => {
  const dot = (servers: string[], over: Partial<DnsSettings> = {}) => createResolver(settings({ mode: "dot", servers, ...over }));
  const ptrResponse = (qname: string, names: Array<[string, number]>) =>
    dnsResponse(qname, 12, names.map(([n, ttl]) => ({ type: 12, ttl, rdata: encName(n) })));

  it("sends a length-prefixed, recursion-desired PTR query on 853 and returns names with TTLs", async () => {
    tlsQueue.push({ chunks: [lenPrefixed(ptrResponse("5.0.0.10.in-addr.arpa", [["host.corp.lan", 600]]))] });
    const r = await dot(["1.1.1.1"]);
    expect(await r.reverse("10.0.0.5")).toEqual([{ name: "host.corp.lan", ttl: 600 }]);
    expect(h.tlsConnect.mock.calls[0][0]).toEqual({ host: "1.1.1.1", port: 853, rejectUnauthorized: false });
    const q = decodeQuery(tlsWrites[0]);
    expect(q).toMatchObject({ name: "5.0.0.10.in-addr.arpa", qtype: 12, rd: true, qdcount: 1 });
    expect(q.len).toBe(tlsWrites[0].length - 2);
  });

  it("reassembles a response split across chunks, length prefix included", async () => {
    const full = lenPrefixed(ptrResponse("5.0.0.10.in-addr.arpa", [["a.lan", 1], ["b.lan", 2]]));
    tlsQueue.push({ chunks: [full.subarray(0, 1), full.subarray(1, 20), full.subarray(20)] });
    const r = await dot(["1.1.1.1"]);
    expect(await r.reverse("10.0.0.5")).toEqual([{ name: "a.lan", ttl: 1 }, { name: "b.lan", ttl: 2 }]);
  });

  it("follows a compression pointer inside the PTR rdata", async () => {
    // rdata "host" + pointer to offset 12 + 2 ("0.0.10.in-addr.arpa", i.e. past the first label "5").
    const rdata = Buffer.concat([Buffer.from([4]), Buffer.from("host"), Buffer.from([0xc0, 14])]);
    const resp = dnsResponse("5.0.0.10.in-addr.arpa", 12, [{ type: 12, ttl: 60, rdata }]);
    tlsQueue.push({ chunks: [lenPrefixed(resp)] });
    const r = await dot(["1.1.1.1"]);
    expect(await r.reverse("10.0.0.5")).toEqual([{ name: "host.0.0.10.in-addr.arpa", ttl: 60 }]);
  });

  it("ignores non-PTR answers and returns [] for an empty answer section", async () => {
    const mixed = dnsResponse("5.0.0.10.in-addr.arpa", 12, [
      { type: 5, ttl: 9, rdata: encName("cname.lan") },
      { type: 12, ttl: 7, rdata: encName("real.lan") },
    ]);
    tlsQueue.push({ chunks: [lenPrefixed(mixed)] }, { chunks: [lenPrefixed(ptrResponse("5.0.0.10.in-addr.arpa", []))] });
    const r = await dot(["1.1.1.1"]);
    expect(await r.reverse("10.0.0.5")).toEqual([{ name: "real.lan", ttl: 7 }]);
    expect(await r.reverse("10.0.0.5")).toEqual([]);
  });

  it("falls through to the next server on failure and throws the last error when all fail", async () => {
    tlsQueue.push({ error: new Error("ECONNREFUSED") }, { chunks: [lenPrefixed(ptrResponse("5.0.0.10.in-addr.arpa", [["ok.lan", 5]]))] });
    const r = await dot(["10.9.9.1", "10.9.9.2"]);
    expect(await r.reverse("10.0.0.5")).toEqual([{ name: "ok.lan", ttl: 5 }]);
    expect(h.tlsConnect.mock.calls.map((c) => c[0].host)).toEqual(["10.9.9.1", "10.9.9.2"]);

    tlsQueue.push({ error: new Error("first") }, { error: new Error("second") });
    await expect(r.reverse("10.0.0.5")).rejects.toThrow("second");
  });

  it("rejects a connection closed before the whole message arrived", async () => {
    const full = lenPrefixed(ptrResponse("5.0.0.10.in-addr.arpa", [["a.lan", 1]]));
    tlsQueue.push({ chunks: [full.subarray(0, 10)], closeEarly: true });
    const r = await dot(["1.1.1.1"]);
    await expect(r.reverse("10.0.0.5")).rejects.toThrow("DoT connection closed before complete response");
  });

  it.each([
    ["9.9.9.9:8853", { host: "9.9.9.9", port: 8853 }],
    ["dns.quad9.net", { host: "dns.quad9.net", port: 853 }],
    ["dns.quad9.net:abc", { host: "dns.quad9.net", port: 853 }],
    ["[2620:fe::fe]:8853", { host: "2620:fe::fe", port: 8853 }],
    ["[2620:fe::fe]", { host: "2620:fe::fe", port: 853 }],
    ["2620:fe::fe", { host: "2620:fe::fe", port: 853 }],
  ])("parses the server %s", async (server, want) => {
    tlsQueue.push({ chunks: [lenPrefixed(ptrResponse("5.0.0.10.in-addr.arpa", []))] });
    await (await dot([server])).reverse("10.0.0.5");
    expect(h.tlsConnect.mock.calls[0][0]).toMatchObject(want);
  });

  it("verifies the certificate only when verifyTls is set", async () => {
    tlsQueue.push({ chunks: [lenPrefixed(ptrResponse("5.0.0.10.in-addr.arpa", []))] });
    await (await dot(["1.1.1.1"], { verifyTls: true })).reverse("10.0.0.5");
    expect(h.tlsConnect.mock.calls[0][0].rejectUnauthorized).toBe(true);
  });

  it("times out after 5 s and destroys the socket", async () => {
    vi.useFakeTimers();
    tlsQueue.push({ silent: true });
    const r = await dot(["1.1.1.1"]);
    const p = r.reverse("10.0.0.5").catch((e) => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect(String(await p)).toContain("DoT query timed out (5s)");
    expect(sockets[0].destroy).toHaveBeenCalled();
  });

  it("lookup returns the A answers and does not ask AAAA when A answered", async () => {
    const a = dnsResponse("nas.lan", 1, [
      { type: 5, ttl: 1, rdata: encName("alias.lan") },
      { type: 1, ttl: 1, rdata: Buffer.from([10, 0, 0, 5]) },
      { type: 1, ttl: 1, rdata: Buffer.from([10, 0, 0, 6, 7]) },
    ]);
    tlsQueue.push({ chunks: [lenPrefixed(a)] });
    const r = await dot(["1.1.1.1"]);
    expect(await r.lookup("nas.lan")).toEqual([{ address: "10.0.0.5", family: 4 }]);
    expect(decodeQuery(tlsWrites[0])).toMatchObject({ name: "nas.lan", qtype: 1 });
    expect(h.tlsConnect).toHaveBeenCalledTimes(1);
  });

  it("lookup falls back to AAAA when A has no answers", async () => {
    const v6 = Buffer.from("20010db8000000000000000000000005", "hex");
    tlsQueue.push(
      { chunks: [lenPrefixed(dnsResponse("nas.lan", 1, []))] },
      { chunks: [lenPrefixed(dnsResponse("nas.lan", 28, [{ type: 28, ttl: 1, rdata: v6 }]))] },
    );
    const r = await dot(["1.1.1.1"]);
    const out = await r.lookup("nas.lan");
    expect(out).toHaveLength(1);
    expect(out[0].family).toBe(6);
    // Groups are written uncompressed (suspicious, not pinned: DoH and the
    // standard resolver hand back the canonical "2001:db8::5").
    expect(out[0].address).toBe("2001:db8:0:0:0:0:0:5");
    expect(decodeQuery(tlsWrites[1]).qtype).toBe(28);
  });

  it("lookup returns [] (never throws) when every server fails for both types", async () => {
    tlsQueue.push({ error: new Error("a") }, { error: new Error("b") }, { error: new Error("c") }, { error: new Error("d") });
    const r = await dot(["10.9.9.1", "10.9.9.2"]);
    expect(await r.lookup("nas.lan")).toEqual([]);
    expect(h.tlsConnect).toHaveBeenCalledTimes(4);
  });
});
