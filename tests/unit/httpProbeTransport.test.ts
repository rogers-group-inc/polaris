/**
 * tests/unit/httpProbeTransport.test.ts
 *
 * The transport half of the "http" polling method, exercised against a real
 * loopback HTTP server via the exported `probeCredentialAgainstHost` (the same
 * entry point the Credentials → Test Connection button uses, so this covers
 * that surface too).
 *
 * httpCheck.test.ts covers the decision logic in isolation; what needs a real
 * socket is everything the pure core can't see: that the request line is
 * actually built from the credential, that a redirect is NOT followed, that the
 * body cap tears the request down instead of buffering, and that auth headers
 * are shaped the way a device expects them. Each of those, wrong, produces a
 * probe that looks like it works.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { probeCredentialAgainstHost } from "../../src/services/monitoringService.js";
import { MAX_BODY_BYTES, MAX_EXCERPT_CHARS, type HttpProbeDiagnostics } from "../../src/utils/httpCheck.js";

let server: Server;
let port = 0;
/** Every request the server saw, so the test can assert on the request line. */
const seen: Array<{ url: string; auth: string | undefined }> = [];

function handler(req: IncomingMessage, res: ServerResponse) {
  seen.push({ url: req.url || "", auth: req.headers.authorization });
  const url = req.url || "/";
  if (url === "/healthz")   { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Status: OK"); return; }
  if (url === "/degraded")  { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("Status: DEGRADED"); return; }
  if (url === "/nocontent") { res.writeHead(204); res.end(); return; }
  if (url === "/boom")      { res.writeHead(500); res.end("kaboom"); return; }
  if (url === "/denied")    { res.writeHead(401); res.end("nope"); return; }
  // A redirect whose TARGET would match the expectation — so a probe that
  // follows redirects passes this and one that doesn't, correctly, fails.
  if (url === "/redirect")  { res.writeHead(302, { Location: "/healthz" }); res.end(); return; }
  // Far more than the read cap, with the match string only at the very end.
  if (url === "/flood") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.write("x".repeat(MAX_BODY_BYTES + 4096));
    res.end("TRAILER-MARKER");
    return;
  }
  // The match string sits just inside the cap — must still be found.
  if (url === "/nearcap") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("y".repeat(MAX_BODY_BYTES - 64) + "EDGE-MARKER");
    return;
  }
  res.writeHead(404); res.end("not found");
}

beforeAll(async () => {
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Since the 2026-08 split, the credential carries AUTH and the check definition
 * is supplied separately (it lives on a manufacturer widget, or comes from the
 * Test Connection form). These cases predate that and were written as one blob,
 * so the helper divides it the way the two owners now do — which keeps each
 * test asserting exactly what it always did.
 */
const AUTH_KEYS = new Set(["authMode", "apiToken", "username", "password"]);

function splitConfig(config: Record<string, unknown>) {
  const auth: Record<string, unknown> = {};
  const check: Record<string, unknown> = { port };
  for (const [k, v] of Object.entries(config)) {
    if (AUTH_KEYS.has(k)) auth[k] = v;
    else check[k] = v;
  }
  return { auth, check };
}

function probe(config: Record<string, unknown>) {
  const { auth, check } = splitConfig(config);
  return probeCredentialAgainstHost("127.0.0.1", "http", auth, undefined, check);
}

/** Same probe, capturing the operator-facing diagnostics. */
async function probeWithDiag(config: Record<string, unknown>) {
  const out: { diag?: HttpProbeDiagnostics } = {};
  const { auth, check } = splitConfig(config);
  const result = await probeCredentialAgainstHost("127.0.0.1", "http", auth, out, check);
  return { result, diag: out.diag };
}

describe("http probe — status handling", () => {
  it("a 200 with no content expectation succeeds and reports a response time", async () => {
    const r = await probe({ path: "/healthz" });
    expect(r.success).toBe(true);
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
  });
  it("204 counts as up under the default any-2xx rule", async () => {
    expect((await probe({ path: "/nocontent" })).success).toBe(true);
  });
  it("a 500 fails and names the status", async () => {
    const r = await probe({ path: "/boom" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("HTTP 500");
  });
  it("a 401 fails on the status rather than on the content", async () => {
    const r = await probe({ path: "/denied", expectBody: "OK" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("HTTP 401");
    expect(r.error).not.toContain("not found in");
  });
  it("an exact expectStatus rejects a different 2xx", async () => {
    expect((await probe({ path: "/healthz", expectStatus: 204 })).success).toBe(false);
    expect((await probe({ path: "/nocontent", expectStatus: 204 })).success).toBe(true);
  });
});

describe("http probe — content match", () => {
  it("a matching body succeeds", async () => {
    expect((await probe({ path: "/healthz", expectBody: "OK" })).success).toBe(true);
  });
  it("a 200 whose body does not match is DOWN, with the reason naming the content", async () => {
    const r = await probe({ path: "/degraded", expectBody: "OK" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Expected text not found");
  });
  // The `failOnMismatch` escape hatch is gone — a mismatch always fails. A
  // stored value cannot re-open it, which is the property worth pinning: the
  // field is stripped on save, so anything still carrying one is a legacy row.
  it("a mismatched 200 fails even with a leftover failOnMismatch:false", async () => {
    const r = await probe({ path: "/degraded", expectBody: "OK", failOnMismatch: false });
    expect(r.success).toBe(false);
  });
  it("regex mode matches against the real body", async () => {
    expect((await probe({ path: "/healthz", expectBody: "^Status:\\s+OK$", matchMode: "regex" })).success).toBe(true);
    expect((await probe({ path: "/degraded", expectBody: "^Status:\\s+OK$", matchMode: "regex" })).success).toBe(false);
  });
});

describe("http probe — the decisions that make the check trustworthy", () => {
  it("does NOT follow a redirect, even when the target would satisfy the check", async () => {
    // A 302 to a login page is the classic way an HTTP health check reports a
    // dead service as healthy. Following it here would pass.
    const r = await probe({ path: "/redirect", expectBody: "OK" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("HTTP 302");
  });
  it("a redirect IS up when the operator asked for that status", async () => {
    expect((await probe({ path: "/redirect", expectStatus: 302 })).success).toBe(true);
  });
  it("requests exactly the credential's path, normalized", async () => {
    seen.length = 0;
    await probe({ path: "healthz" });
    expect(seen.at(-1)?.url).toBe("/healthz");
  });
  it("defaults to / when the credential names no path", async () => {
    seen.length = 0;
    await probe({});
    expect(seen.at(-1)?.url).toBe("/");
  });
  it("caps an oversized body and reports the truncation instead of hanging", async () => {
    const r = await probe({ path: "/flood", expectBody: "TRAILER-MARKER" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("KB of the response body");
  });
  it("still finds a match sitting just inside the cap", async () => {
    // Guards the off-by-one in the truncating slice: a naive implementation
    // that drops the final chunk entirely would miss this.
    expect((await probe({ path: "/nearcap", expectBody: "EDGE-MARKER" })).success).toBe(true);
  });
});

describe("http probe — auth headers", () => {
  it("sends a bearer token when one is configured", async () => {
    seen.length = 0;
    await probe({ path: "/healthz", apiToken: "tok123" });
    expect(seen.at(-1)?.auth).toBe("Bearer tok123");
  });
  it("sends basic auth when a username/password pair is configured", async () => {
    seen.length = 0;
    await probe({ path: "/healthz", username: "mon", password: "pw" });
    expect(seen.at(-1)?.auth).toBe("Basic " + Buffer.from("mon:pw").toString("base64"));
  });
  it("a bearer token wins over basic auth — one Authorization header, predictably chosen", async () => {
    seen.length = 0;
    await probe({ path: "/healthz", apiToken: "tok123", username: "mon", password: "pw" });
    expect(seen.at(-1)?.auth).toBe("Bearer tok123");
  });
  it("sends no Authorization header when neither is configured", async () => {
    seen.length = 0;
    await probe({ path: "/healthz" });
    expect(seen.at(-1)?.auth).toBeUndefined();
  });
});

describe("http probe — transport failures", () => {
  it("a closed port fails with the connection error rather than throwing", async () => {
    // Port 1 on loopback: nothing listens, and ECONNREFUSED is immediate.
    const r = await probeCredentialAgainstHost("127.0.0.1", "http", { port: 1, path: "/healthz" });
    expect(r.success).toBe(false);
    expect(r.error).toBeTruthy();
  });
  it("requires a host — an http check has nowhere to go without one", async () => {
    const r = await probeCredentialAgainstHost("", "http", { path: "/healthz" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("Host is required");
  });
});

describe("http probe — Test Connection diagnostics (tailoring the check)", () => {
  it("returns the body so the operator can pick a match string out of it", async () => {
    const { diag } = await probeWithDiag({ path: "/healthz" });
    expect(diag?.excerpt).toBe("Status: OK");
    expect(diag?.statusCode).toBe(200);
    expect(diag?.contentType).toContain("text/plain");
    expect(diag?.bytesRead).toBe("Status: OK".length);
  });

  it("names the request line as DIALED, so a 404 is diagnosable", async () => {
    const { diag } = await probeWithDiag({ path: "healthz" });
    expect(diag?.url).toBe(`http://127.0.0.1:${port}/healthz`);
  });

  it("reports matched:null when no expectation is configured — the first-test state", async () => {
    const { diag } = await probeWithDiag({ path: "/healthz" });
    expect(diag?.matched).toBe(null);
  });

  it("distinguishes 'expectation failed' from 'no expectation set'", async () => {
    // `matched` is three-valued for the modal's benefit: false means the string
    // was looked for and missing, null means nothing was configured yet. Those
    // need different messages — the second is the state every operator is in on
    // their first test, and rendering it as a failed match would send them
    // hunting for a problem with the device.
    const missed = await probeWithDiag({ path: "/degraded", expectBody: "OK" });
    expect(missed.result.success).toBe(false);
    expect(missed.diag?.matched).toBe(false);

    const unset = await probeWithDiag({ path: "/degraded" });
    expect(unset.result.success).toBe(true);
    expect(unset.diag?.matched).toBeNull();
  });

  it("reports diagnostics on a FAILING status too — that response is the diagnosis", async () => {
    const { result, diag } = await probeWithDiag({ path: "/boom" });
    expect(result.success).toBe(false);
    expect(diag?.statusCode).toBe(500);
    expect(diag?.excerpt).toBe("kaboom");
  });

  it("flags a read-capped body, and caps the shown excerpt far below it", async () => {
    const { diag } = await probeWithDiag({ path: "/flood" });
    expect(diag?.bodyTruncatedAtCap).toBe(true);
    expect(diag?.excerptTruncated).toBe(true);
    expect(diag?.excerpt.length).toBe(MAX_EXCERPT_CHARS);
    expect(diag?.bytesRead).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  it("carries no diagnostics when the caller didn't ask — the monitor hot path builds none", async () => {
    // The out-param is the only thing that turns this on; probe() omits it.
    const r = await probe({ path: "/healthz" });
    expect((r as unknown as Record<string, unknown>).httpDiagnostics).toBeUndefined();
  });

  it("an empty body is reported as empty rather than as a missing response", async () => {
    const { diag } = await probeWithDiag({ path: "/nocontent" });
    expect(diag?.statusCode).toBe(204);
    expect(diag?.excerpt).toBe("");
    expect(diag?.bytesRead).toBe(0);
  });
});
