/**
 * tests/unit/fgRequestStatusMapping.test.ts
 *
 * How `fgRequest` turns a FortiOS HTTP status into an operator-facing message.
 *
 * The case that matters: 401 and 403 are different problems and must not share
 * a message. A 403 means the token authenticated and FortiOS refused THIS
 * endpoint — the api-user's access profile doesn't cover it, or the caller is
 * outside its trusthost. While the two were conflated, a narrow access profile
 * presented as "Authentication failed — check your API token" on the Test
 * Connection button (which calls /api/v2/monitor/system/status, needing System
 * read) while the Query API tool kept working against permitted paths — an
 * intact token that looked revoked.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { fgRequest } from "../../src/services/fortigateService.js";
import { AppError } from "../../src/utils/errors.js";

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

const config = { host: "10.0.0.1", port: 443, apiUser: "polaris", apiToken: "tok", verifySsl: false };

function mockStatus(status: number, body: unknown = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fgRequest — HTTP status → operator message", () => {
  it("401 points at the token", async () => {
    mockStatus(401);
    await expect(fgRequest(config as any, "GET", "/api/v2/monitor/system/status"))
      .rejects.toThrow(/Authentication failed \(HTTP 401\).*check your API token/);
  });

  it("names the target host on BOTH auth failures", async () => {
    // Under FMG bypass the host is resolved per-device out of FMG, not typed by
    // the operator — so an auth error that doesn't say WHERE it connected can't
    // be acted on. classifyPushError still matches on "Authentication failed".
    mockStatus(401);
    await expect(fgRequest(config as any, "GET", "/api/v2/monitor/system/status"))
      .rejects.toThrow(/10\.0\.0\.1:443/);
    mockStatus(403);
    await expect(fgRequest(config as any, "GET", "/api/v2/monitor/system/status"))
      .rejects.toThrow(/10\.0\.0\.1:443/);
  });

  it("403 points at the access profile and trusthost, NOT the token", async () => {
    mockStatus(403);
    const err = await fgRequest(config as any, "GET", "/api/v2/monitor/system/status")
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.message).toMatch(/permission denied \(HTTP 403\)/);
    expect(err.message).toMatch(/access profile/);
    expect(err.message).toMatch(/trusthost/);
    // The whole point: it must not send the operator after the token.
    expect(err.message).not.toMatch(/check your API token/);
  });

  it("403 names the refused path, so a per-endpoint refusal is visible as such", async () => {
    mockStatus(403);
    await expect(fgRequest(config as any, "GET", "/api/v2/monitor/system/status"))
      .rejects.toThrow(/\/api\/v2\/monitor\/system\/status/);
  });

  it("still maps 404 and generic non-OK distinctly", async () => {
    mockStatus(404);
    await expect(fgRequest(config as any, "GET", "/api/v2/cmdb/nope"))
      .rejects.toThrow(/Endpoint not found: \/api\/v2\/cmdb\/nope/);
    mockStatus(500);
    await expect(fgRequest(config as any, "GET", "/api/v2/cmdb/x"))
      .rejects.toThrow(/FortiGate returned HTTP 500/);
  });

  it("unwraps the FortiOS results envelope on success", async () => {
    mockStatus(200, { status: "success", results: { version: "v7.4.5" } });
    await expect(fgRequest(config as any, "GET", "/api/v2/monitor/system/status"))
      .resolves.toEqual({ version: "v7.4.5" });
  });
});
