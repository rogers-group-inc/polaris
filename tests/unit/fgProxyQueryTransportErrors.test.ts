/**
 * tests/unit/fgProxyQueryTransportErrors.test.ts
 *
 * The Query API tool's FortiGate transport (`proxyQuery`) must turn a request
 * that never got an HTTP answer — refused, timed out, no route, TLS rejected,
 * or a non-JSON body — into a 502 that names WHERE it connected and WHY.
 *
 * `fgRequest` maps every HTTP status to an AppError but lets these escape raw,
 * and the route error handler can only report a raw error as a bare 500
 * "Internal server error". Under FMG bypass the address is resolved out of
 * FortiManager rather than typed, so "which IP did it try" is the first thing
 * the operator needs — the gate was up, Polaris just could not reach the
 * address it was handed.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { proxyQuery, describeFgTransportError } from "../../src/services/fortigateService.js";
import { AppError } from "../../src/utils/errors.js";

// Same seam as fgRequestStatusMapping.test.ts: route tlsFetch to global fetch.
vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
  insecureTlsDispatcher: () => ({}),
}));

const config = { host: "10.9.8.7", port: 443, apiUser: "", apiToken: "tok", verifySsl: false };

function fetchFailed(code: string): Error {
  const cause = Object.assign(new Error(`connect ${code} 10.9.8.7:443`), { code });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

function mockReject(err: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => { throw err; }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("proxyQuery — transport failures become a named 502", () => {
  it("ETIMEDOUT names the address, port and the code", async () => {
    mockReject(fetchFailed("ETIMEDOUT"));
    const err = await proxyQuery(config as any, "GET", "/api/v2/monitor/system/status").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.httpStatus).toBe(502);
    expect(err.message).toMatch(/Could not reach FortiGate at 10\.9\.8\.7:443/);
    expect(err.message).toMatch(/ETIMEDOUT/);
  });

  it("carries the caller's note on how the address was chosen", async () => {
    mockReject(fetchFailed("ECONNREFUSED"));
    await expect(proxyQuery(config as any, "GET", "/x", undefined, undefined, '(resolved from "port1")'))
      .rejects.toThrow(/10\.9\.8\.7:443 \(resolved from "port1"\) — connection refused \(ECONNREFUSED\)/);
  });

  it("fgRequest's own timeout (AbortError) reads as a timeout", async () => {
    mockReject(new DOMException("This operation was aborted", "AbortError"));
    await expect(proxyQuery(config as any, "GET", "/x")).rejects.toThrow(/request timed out/);
  });

  it("a certificate rejection says SSL verification is on", async () => {
    mockReject(fetchFailed("DEPTH_ZERO_SELF_SIGNED_CERT"));
    await expect(proxyQuery(config as any, "GET", "/x")).rejects.toThrow(/TLS certificate error.*SSL verification/);
  });

  it("a 200 with a non-JSON body is named, not a 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200, ok: true, json: async () => JSON.parse("<html>"),
    })));
    const err = await proxyQuery(config as any, "GET", "/x").catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toMatch(/not JSON/);
  });

  it("HTTP-status AppErrors pass through unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401, ok: false, json: async () => ({}) })));
    const err = await proxyQuery(config as any, "GET", "/x").catch((e) => e);
    expect(err.message).toMatch(/^Authentication failed \(HTTP 401\)/);
    expect(err.message).not.toMatch(/Could not reach/);
  });
});

describe("describeFgTransportError", () => {
  it("returns null for AppErrors and unrecognised errors", () => {
    expect(describeFgTransportError(new AppError(502, "x"))).toBeNull();
    expect(describeFgTransportError(new Error("boom"))).toBeNull();
  });

  it("falls back to an unknown cause code verbatim", () => {
    expect(describeFgTransportError(fetchFailed("EPROTO"))).toMatch(/^EPROTO/);
  });
});
