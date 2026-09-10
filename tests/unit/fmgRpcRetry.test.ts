import { describe, it, expect, vi, afterEach } from "vitest";
import { proxyQuery, type FortiManagerConfig } from "../../src/services/fortimanagerService.js";

// The FortiManager/FortiGate transports call `tlsFetch` — undici's own fetch
// paired with its own dispatcher, because a dispatcher is only valid to the
// undici copy that created it (see src/utils/tlsDispatcher.ts). Route it back
// to the global fetch so this file keeps stubbing that one seam. The real
// pairing is exercised unmocked, against a live local server, in
// tests/unit/tlsDispatcher.test.ts — mocking it here is what let the
// undici 6 -> 8 skew reach production unnoticed.
vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
  insecureTlsDispatcher: () => ({}),
}));

// Exercises the transport-layer retry + HTTP-status classification added to
// rpcInner/rpcAttempt, through the public proxyQuery surface (no integrationId
// → runs the rpc directly, bypassing the FmgWorker lanes). Per the FortiManager
// API Best Practices Guide: retry transient errors (5xx / network) with backoff,
// fail fast on permanent ones (401/403/404/405). Backoff is real (500ms+1500ms),
// so the retry-exhaustion cases take ~2s.

const config: FortiManagerConfig = {
  host: "fmg.test",
  port: 443,
  apiUser: "polaris",
  apiToken: "tok",
  verifySsl: true,
};

function okResponse() {
  return {
    status: 200,
    ok: true,
    json: async () => ({ id: 1, result: [{ status: { code: 0 }, data: { ok: true } }] }),
  };
}

function httpResponse(status: number) {
  return { status, ok: status >= 200 && status < 300, json: async () => ({}) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FMG rpc transient retry", () => {
  it("retries a transient 503 then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(httpResponse(503))
      .mockResolvedValueOnce(httpResponse(503))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const res = await proxyQuery(config, "get", [{ url: "/sys/status" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(res).toBeTruthy();
  });

  it("retries a transient network failure then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { cause: { code: "ECONNRESET" } }))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await proxyQuery(config, "get", [{ url: "/sys/status" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a permanent 403 (fails fast on first attempt)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(403));
    vi.stubGlobal("fetch", fetchMock);

    await expect(proxyQuery(config, "get", [{ url: "/sys/status" }])).rejects.toThrow(/403/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a permanent 401", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(proxyQuery(config, "get", [{ url: "/sys/status" }])).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry cap on sustained 500s (3 total attempts)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(httpResponse(500));
    vi.stubGlobal("fetch", fetchMock);

    await expect(proxyQuery(config, "get", [{ url: "/sys/status" }])).rejects.toThrow(/HTTP 500/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
