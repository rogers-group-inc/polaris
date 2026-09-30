/**
 * tests/unit/pathCheckServerRunner.test.ts — the Polaris server's own path-
 * check probe: the agent-mirroring body match / excerpt / refusal rules, the
 * scheduling helpers the job uses (the agent's due and traceroute rules), and
 * real HTTP + TCP runs against a loopback fixture server (the loopback refusal
 * is lifted through the test seam — production never lifts it).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  pathBodyMatches,
  excerptOf,
  refusedAddress,
  runServerCheck,
  serverCheckDue,
  serverTraceMode,
  pruneServerStates,
  DUE_SLACK_MS,
  captureHeaders,
  MAX_CAPTURED_HEADERS,
  _deps,
  type RunCapture,
} from "../../src/services/pathCheckServerRunner.js";
import type { AgentCheckDef } from "../../src/services/pathCheckService.js";

function def(over: Partial<AgentCheckDef> = {}): AgentCheckDef {
  return {
    id: "c1", name: "c1", kind: "http", target: "http://intranet.example/", intervalSec: 60, timeoutMs: 2000,
    expectStatus: "", expectBody: null, verifyTls: false, keepBodyExcerpt: false,
    traceroute: { enabled: false, everyNRuns: 5, maxHops: 30, probesPerHop: 3, probeTimeoutMs: 1000 },
    revision: "r1",
    ...over,
  };
}

describe("pathBodyMatches — the agent's three modes", () => {
  it("contains, case-folded unless asked", () => {
    expect(pathBodyMatches("Status: OK", { mode: "contains", value: "ok", caseSensitive: false })).toBe(true);
    expect(pathBodyMatches("Status: OK", { mode: "contains", value: "ok", caseSensitive: true })).toBe(false);
  });
  it("exact ignores trailing CR/LF only", () => {
    expect(pathBodyMatches("OK\r\n", { mode: "exact", value: "OK", caseSensitive: true })).toBe(true);
    expect(pathBodyMatches(" OK", { mode: "exact", value: "OK", caseSensitive: true })).toBe(false);
  });
  it("regex, and no expectation always matches", () => {
    expect(pathBodyMatches('{"status":"up"}', { mode: "regex", value: '"status":\\s*"up"', caseSensitive: false })).toBe(true);
    expect(pathBodyMatches("anything", null)).toBe(true);
  });
});

describe("excerptOf", () => {
  it("keeps a short body whole and cuts a long one to 4 KB without tearing a character", () => {
    expect(excerptOf(Buffer.from("hello"))).toBe("hello");
    const body = Buffer.concat([Buffer.alloc(4095, "a"), Buffer.from("é")]); // é is 2 bytes, straddling 4096
    const ex = excerptOf(body);
    expect(ex).toBe("a".repeat(4095));
    expect(ex.includes("�")).toBe(false);
  });
});

describe("refusedAddress", () => {
  const own = new Set(["10.1.1.5"]);
  it("refuses the SSRF ranges and this server's own addresses; allows RFC1918", () => {
    expect(refusedAddress("127.0.0.1", own)).toMatch(/loopback/);
    expect(refusedAddress("169.254.169.254", own)).toMatch(/link-local/);
    expect(refusedAddress("10.1.1.5", own)).toMatch(/this Polaris server/);
    expect(refusedAddress("10.1.1.6", own)).toBeNull();
  });
});

describe("scheduling — the agent's rules", () => {
  const d = def({ traceroute: { enabled: true, everyNRuns: 3, maxHops: 30, probesPerHop: 3, probeTimeoutMs: 1000 } });
  it("a first run is always due; later runs on the interval, with slack", () => {
    expect(serverCheckDue(undefined, d, 0)).toBe(true);
    const st = { revision: "r1", lastRunAt: 1_000_000, runCount: 1, lastOk: true };
    expect(serverCheckDue(st, d, 1_000_000 + 60_000 - DUE_SLACK_MS - 1)).toBe(false);
    expect(serverCheckDue(st, d, 1_000_000 + 60_000 - DUE_SLACK_MS)).toBe(true);
  });
  it("traces the baseline, every Nth run, and a failure after a pass", () => {
    expect(serverTraceMode(undefined, d)).toBe("always");
    expect(serverTraceMode({ revision: "r1", lastRunAt: 0, runCount: 3, lastOk: true }, d)).toBe("always");
    expect(serverTraceMode({ revision: "r1", lastRunAt: 0, runCount: 1, lastOk: true }, d)).toBe("onFail");
    expect(serverTraceMode({ revision: "r1", lastRunAt: 0, runCount: 1, lastOk: false }, d)).toBe("never");
    expect(serverTraceMode(undefined, def())).toBe("never"); // traceroute off
  });
  it("a changed definition re-baselines; a dropped check is forgotten", () => {
    const states = new Map([["c1", { revision: "old", lastRunAt: 5, runCount: 9, lastOk: true }], ["gone", { revision: "x", lastRunAt: 5, runCount: 9, lastOk: true }]]);
    const out = pruneServerStates(states, [d]);
    expect([...out.keys()]).toEqual(["c1"]);
    expect(out.get("c1")).toMatchObject({ revision: "r1", runCount: 0 });
  });
});

describe("runServerCheck — against a loopback fixture", () => {
  let server: http.Server;
  let port = 0;
  const realRefused = _deps.refusedAddress;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") { res.writeHead(200, { "content-type": "text/plain" }); res.end("status: up\n"); return; }
      if (req.url === "/redirect") { res.writeHead(302, { location: "/ok" }); res.end(); return; }
      if (req.url === "/big") { res.writeHead(200); res.end(Buffer.alloc(200 * 1024, "x")); return; }
      res.writeHead(500); res.end("boom");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as AddressInfo).port;
    _deps.refusedAddress = () => null;
  });
  afterAll(async () => {
    _deps.refusedAddress = realRefused;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("passes a 200 with the expected body, timing the phases and fingerprinting the body", async () => {
    const { sample, trace } = await runServerCheck(def({ target: `http://127.0.0.1:${port}/ok`, expectBody: { mode: "contains", value: "UP", caseSensitive: false } }), "never");
    expect(sample).toMatchObject({ checkId: "c1", ok: true, httpStatus: 200, bodyMatched: true, resolvedIp: "127.0.0.1", bodyBytes: 11 });
    expect(sample.bodySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sample.latencyMs).toBeGreaterThan(0);
    expect(sample.connectMs).not.toBeUndefined();
    expect(sample.bodyExcerpt).toBeUndefined(); // passing run, excerpts off
    expect(trace).toBeNull();
  });
  it("judges a redirect as itself (never followed) and keeps the excerpt of a failed run", async () => {
    const r = await runServerCheck(def({ target: `http://127.0.0.1:${port}/redirect` }), "never");
    expect(r.sample).toMatchObject({ ok: false, httpStatus: 302, error: "HTTP 302 (expected 2xx)" });
    const f = await runServerCheck(def({ target: `http://127.0.0.1:${port}/fail` }), "never");
    expect(f.sample).toMatchObject({ ok: false, httpStatus: 500, bodyExcerpt: "boom" });
  });
  it("fills a test run's capture with the headers and the body it judged, and leaves a scheduled run's alone", async () => {
    const cap: RunCapture = {};
    await runServerCheck(def({ target: `http://127.0.0.1:${port}/ok` }), "never", undefined, cap);
    expect(cap.headers?.["content-type"]).toBe("text/plain");
    expect(cap.body).toBe("status: up\n");
    expect(cap.httpVersion).toBe("1.1");
    const big: RunCapture = {};
    await runServerCheck(def({ target: `http://127.0.0.1:${port}/big` }), "never", undefined, big);
    expect(big.body).toHaveLength(64 * 1024);
  });
  it("fails on a missing body text and reads at most 64 KB", async () => {
    const miss = await runServerCheck(def({ target: `http://127.0.0.1:${port}/ok`, expectBody: { mode: "exact", value: "down", caseSensitive: true } }), "never");
    expect(miss.sample).toMatchObject({ ok: false, bodyMatched: false });
    expect(miss.sample.error).toMatch(/Expected text not found/);
    const big = await runServerCheck(def({ target: `http://127.0.0.1:${port}/big` }), "never");
    expect(big.sample).toMatchObject({ ok: true, bodyBytes: 64 * 1024 });
  });
  it("connects a TCP check and reports a refused port", async () => {
    const ok = await runServerCheck(def({ kind: "tcp", target: `127.0.0.1:${port}` }), "never");
    expect(ok.sample).toMatchObject({ ok: true });
    expect(ok.sample.latencyMs).toBe(ok.sample.connectMs);
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
    const closed = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const bad = await runServerCheck(def({ kind: "tcp", target: `127.0.0.1:${closed}` }), "never");
    expect(bad.sample.ok).toBe(false);
    expect(bad.sample.error).toMatch(/^connect failed: /);
  });
});

describe("runServerCheck — refusals and resolution", () => {
  const realLookup = _deps.lookup;
  afterEach(() => { _deps.lookup = realLookup; });
  it("refuses loopback after resolution, as the agent does", async () => {
    _deps.lookup = (async () => [{ address: "127.0.0.1", family: 4 }]) as any;
    const { sample } = await runServerCheck(def({ target: "http://sneaky.example/" }), "always");
    expect(sample.ok).toBe(false);
    expect(sample.error).toMatch(/^refused: 127\.0\.0\.1/);
    expect(sample.dnsMs).not.toBeNull();
  });
  it("reports an IPv6-only name as unsupported and a failed lookup as a DNS error", async () => {
    _deps.lookup = (async () => [{ address: "2001:db8::1", family: 6 }]) as any;
    expect((await runServerCheck(def(), "never")).sample.error).toBe("ipv6 not supported in v1");
    _deps.lookup = (async () => { throw new Error("getaddrinfo ENOTFOUND intranet.example"); }) as any;
    expect((await runServerCheck(def(), "never")).sample.error).toMatch(/^dns lookup failed: /);
  });
  it("runs no traceroute when there is no destination to trace", async () => {
    _deps.lookup = (async () => { throw new Error("nope"); }) as any;
    const r = await runServerCheck(def({ traceroute: { enabled: true, everyNRuns: 1, maxHops: 30, probesPerHop: 3, probeTimeoutMs: 1000 } }), "always");
    expect(r.trace).toBeNull();
  });
});

describe("captureHeaders", () => {
  it("lower-cases, joins repeats, redacts cookie values and caps count and length", () => {
    const h = captureHeaders({ "Content-Type": "text/html", "Set-Cookie": ["SID=abc123; Path=/", "lang=en"], Vary: ["a", "b"], "X-Long": "x".repeat(600), Gone: undefined });
    expect(h["content-type"]).toBe("text/html");
    expect(h["set-cookie"]).toBe("SID=(redacted); lang=(redacted)");
    expect(h["set-cookie"]).not.toContain("abc123");
    expect(h.vary).toBe("a, b");
    expect(h["x-long"].length).toBe(513);
    expect("gone" in h).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`h${i}`, "v"]));
    expect(Object.keys(captureHeaders(many))).toHaveLength(MAX_CAPTURED_HEADERS);
  });
});
