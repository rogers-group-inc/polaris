/**
 * tests/unit/pathCheckServerRunnerOptions.test.ts — the request options on the
 * Polaris server's own probe (the agent's twin is
 * agent/internal/collectors/path_check_options_test.go): HEAD, a Host header
 * override, followed redirects (each hop re-resolved), a negated body match —
 * and authentication, which only the server ever does: Basic, Bearer, the
 * Digest handshake, and credentials never following a redirect off the
 * target's own origin.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runServerCheck, sameOrigin, _deps, type RunCapture } from "../../src/services/pathCheckServerRunner.js";
import type { AgentCheckDef } from "../../src/services/pathCheckService.js";

let server: http.Server;
let port = 0;
const seen: { path: string; method: string; host?: string; auth?: string }[] = [];

function def(path: string, over: Partial<AgentCheckDef> = {}): AgentCheckDef {
  return {
    id: "c1", name: "c1", kind: "http", target: `http://site.test:${port}${path}`, intervalSec: 60, timeoutMs: 3000,
    expectStatus: "", expectBody: null, verifyTls: false, keepBodyExcerpt: false,
    traceroute: { enabled: false, everyNRuns: 5, maxHops: 30, probesPerHop: 3, probeTimeoutMs: 1000 },
    revision: "r1",
    ...over,
  };
}

const realLookup = _deps.lookup;
const realRefused = _deps.refusedAddress;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    seen.push({ path, method: req.method ?? "", host: req.headers.host, auth: req.headers.authorization });
    if (path === "/page") { res.writeHead(200); res.end(req.method === "HEAD" ? undefined : "Welcome — all systems normal"); return; }
    if (path === "/maint") { res.writeHead(200); res.end("Down for maintenance"); return; }
    if (path === "/start") { res.writeHead(302, { location: "/mid" }); res.end(); return; }
    if (path === "/mid") { res.writeHead(301, { location: `http://site.test:${port}/end` }); res.end(); return; }
    if (path === "/end") { res.writeHead(200); res.end("arrived"); return; }
    if (path === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); return; }
    if (path === "/away") { res.writeHead(302, { location: `http://elsewhere.test:${port}/secret-sink` }); res.end(); return; }
    if (path === "/secret-sink") { res.writeHead(200); res.end("ok"); return; }
    if (path === "/basic") {
      const ok = req.headers.authorization === "Basic " + Buffer.from("alice:s3cret").toString("base64");
      res.writeHead(ok ? 200 : 401); res.end(ok ? "in" : "no"); return;
    }
    if (path === "/bearer") { const ok = req.headers.authorization === "Bearer tok-123"; res.writeHead(ok ? 200 : 401); res.end(); return; }
    if (path === "/digest") {
      const a = req.headers.authorization ?? "";
      if (!a.startsWith("Digest ")) {
        res.writeHead(401, { "www-authenticate": 'Digest realm="test", nonce="abc123", qop="auth"' });
        res.end(); return;
      }
      const ok = /username="alice"/.test(a) && /realm="test"/.test(a) && /nonce="abc123"/.test(a) && /uri="\/digest"/.test(a) && /response="[0-9a-f]{32}"/.test(a);
      res.writeHead(ok ? 200 : 403); res.end(ok ? "in" : "bad"); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  // Every *.test name resolves to the loopback fixture; the refusal is lifted
  // (production never lifts it) so the hops can reach it.
  _deps.lookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as any;
  _deps.refusedAddress = () => null;
});

afterAll(async () => {
  _deps.lookup = realLookup;
  _deps.refusedAddress = realRefused;
  await new Promise<void>((r) => server.close(() => r()));
});

const last = () => seen[seen.length - 1];

describe("request options", () => {
  it("sends HEAD and reads no body", async () => {
    const { sample } = await runServerCheck(def("/page", { method: "HEAD" }), "never");
    expect(sample).toMatchObject({ ok: true, httpStatus: 200, bodyBytes: 0 });
    expect(last().method).toBe("HEAD");
  });
  it("sends the Host override in place of the URL's host", async () => {
    await runServerCheck(def("/page", { hostHeader: "intranet.example" }), "never");
    expect(last().host).toBe("intranet.example");
    await runServerCheck(def("/page"), "never");
    expect(last().host).toBe(`site.test:${port}`);
  });
  it("fails a negated match when the text is present, and passes when it is absent", async () => {
    const neg = { mode: "contains" as const, value: "maintenance", caseSensitive: false, negate: true };
    const bad = await runServerCheck(def("/maint", { expectBody: neg }), "never");
    expect(bad.sample).toMatchObject({ ok: false, bodyMatched: false });
    expect(bad.sample.error).toMatch(/^Forbidden text found/);
    const good = await runServerCheck(def("/page", { expectBody: neg }), "never");
    expect(good.sample).toMatchObject({ ok: true, bodyMatched: true });
  });
  it("judges a redirect as itself unless the check follows them; follows ≤ 5 and reports the final URL", async () => {
    expect((await runServerCheck(def("/start"), "never")).sample).toMatchObject({ ok: false, httpStatus: 302 });
    const cap: RunCapture = {};
    const on = await runServerCheck(def("/start", { followRedirects: true, expectBody: { mode: "contains", value: "arrived", caseSensitive: false } }), "never", undefined, cap);
    expect(on.sample).toMatchObject({ ok: true, httpStatus: 200 });
    expect(cap.finalUrl).toBe(`http://site.test:${port}/end`);
    const loop = await runServerCheck(def("/loop", { followRedirects: true }), "never");
    expect(loop.sample.error).toBe("more than 5 redirects");
  });
  it("refuses a redirect into a refused address, re-checking every hop", async () => {
    _deps.refusedAddress = (ip: string) => (ip === "10.9.9.9" ? "refused: 10.9.9.9 is this Polaris server" : null);
    _deps.lookup = (async (h: string) => [{ address: h.startsWith("elsewhere") ? "10.9.9.9" : "127.0.0.1", family: 4 }]) as any;
    try {
      const r = await runServerCheck(def("/away", { followRedirects: true }), "never");
      expect(r.sample.ok).toBe(false);
      expect(r.sample.error).toMatch(/^redirect to elsewhere\.test:\d+: refused/);
    } finally {
      _deps.refusedAddress = () => null;
      _deps.lookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as any;
    }
  });
});

describe("authentication (server only)", () => {
  it("sends Basic and Bearer", async () => {
    expect((await runServerCheck(def("/basic"), "never", undefined, undefined, { authMode: "basic", username: "alice", password: "s3cret" })).sample.ok).toBe(true);
    expect((await runServerCheck(def("/basic"), "never")).sample.httpStatus).toBe(401);
    expect((await runServerCheck(def("/bearer"), "never", undefined, undefined, { authMode: "bearer", apiToken: "tok-123" })).sample.ok).toBe(true);
  });
  it("answers a Digest challenge exactly once", async () => {
    const before = seen.length;
    const r = await runServerCheck(def("/digest"), "never", undefined, undefined, { authMode: "digest", username: "alice", password: "pw" });
    expect(r.sample).toMatchObject({ ok: true, httpStatus: 200 });
    expect(seen.length - before).toBe(2); // challenge + one answer, never a loop
  });
  it("never sends the credential — or the Host override — to a redirect that leaves the target's origin", async () => {
    await runServerCheck(def("/away", { followRedirects: true, hostHeader: "intranet.example" }), "never", undefined, undefined,
      { authMode: "bearer", apiToken: "tok-123" });
    const first = seen[seen.length - 2];
    const sink = last();
    expect(first).toMatchObject({ path: "/away", auth: "Bearer tok-123", host: "intranet.example" });
    expect(sink.path).toBe("/secret-sink");
    expect(sink.auth).toBeUndefined();
    expect(sink.host).toBe(`elsewhere.test:${port}`);
  });
});

describe("sameOrigin", () => {
  it("compares scheme, host (case-folded) and port with defaults made explicit", () => {
    expect(sameOrigin(new URL("https://A.example/x"), new URL("https://a.example:443/y"))).toBe(true);
    expect(sameOrigin(new URL("https://a.example/"), new URL("http://a.example/"))).toBe(false);
    expect(sameOrigin(new URL("http://a.example:8080/"), new URL("http://a.example/"))).toBe(false);
  });
});
