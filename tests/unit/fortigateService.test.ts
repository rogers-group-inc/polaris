/**
 * tests/unit/fortigateService.test.ts — the direct FortiOS REST transport:
 * how a request is built, how a refusal is read back, and how the connection
 * test words its answer (CQ-T010).
 *
 * Complements, does not repeat:
 *   - fgRequestStatusMapping.test.ts — 401 vs 403 wording, results unwrap
 *   - fortiosRequestGate.test.ts — the per-gate slot + 401 pause (rule 96)
 *   - fgProxyQueryTransportErrors.test.ts — proxyQuery's 502 wrap, two
 *     describeFgTransportError cases
 *   - fortigateInterfaceSingleRead / fortiosCollectors / fortiosDiscoveryFormats
 *     / releaseDhcpLease / quarantinePushBodyAscii / fortinetQueryPresets /
 *     integrationAdapters / probes — discoverDhcpSubnets and the callers
 *
 * What was unreached: the request itself (URL with port default, query string
 * appended to a path that already carries one, IPv6 brackets, the Bearer and
 * access_user headers, a body sent only on POST/PUT); fgErrorDetail — the
 * FortiOS `cli_error` / `message` / CLI error code relayed on a non-2xx, an
 * HTML page trimmed to one line, an empty body adding nothing; the 404 mapping;
 * a 200 whose envelope says status "error"; `envelope: true`; testConnection's
 * four label shapes and its failure wording; every describeFgTransportError
 * branch; and FortiosAuthPausedError's message.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => h.fetch(...args),
  insecureTlsDispatcher: () => ({}),
}));

import { AppError } from "../../src/utils/errors.js";
import { _resetFortiosGateState } from "../../src/utils/fortiosRequestGate.js";
import {
  FortiosAuthPausedError,
  describeFgTransportError,
  fgRequest,
  proxyQuery,
  testConnection,
  type FortiGateConfig,
} from "../../src/services/fortigateService.js";

const cfg: FortiGateConfig = { host: "10.0.0.1", apiUser: "", apiToken: "tok-123", verifySsl: false };

function respond(status: number, body: unknown, asText?: string) {
  h.fetch.mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (asText !== undefined ? asText : JSON.stringify(body)),
  });
}
const sent = () => h.fetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body?: string }, boolean | undefined];

beforeEach(() => {
  h.fetch.mockReset();
  _resetFortiosGateState();
});
afterEach(() => {
  _resetFortiosGateState();
});

describe("fgRequest — the request it sends", () => {
  it("defaults to port 443, appends the query, and sends the bearer token", async () => {
    respond(200, { results: [] });
    await fgRequest(cfg, "GET", "/api/v2/cmdb/system/interface", { query: { vdom: "root", format: "name|ip" } });
    const [url, init, verify] = sent();
    expect(url).toBe("https://10.0.0.1:443/api/v2/cmdb/system/interface?vdom=root&format=name%7Cip");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(init.headers).not.toHaveProperty("access_user");
    expect(verify).toBe(false);
  });

  it("joins the query with & when the path already has one, and brackets an IPv6 host", async () => {
    respond(200, { results: [] });
    await fgRequest({ ...cfg, host: "2001:db8::1", port: 8443 }, "GET", "/api/v2/monitor/x?scope=global", { query: { vdom: "v1" } });
    expect(sent()[0]).toBe("https://[2001:db8::1]:8443/api/v2/monitor/x?scope=global&vdom=v1");
  });

  it("forwards the API user as access_user when one is set", async () => {
    respond(200, { results: [] });
    await fgRequest({ ...cfg, apiUser: "polaris-api" }, "GET", "/p");
    expect(sent()[1].headers.access_user).toBe("polaris-api");
  });

  it("sends a JSON body on POST and PUT, never on GET or DELETE", async () => {
    respond(200, { results: {} });
    await fgRequest(cfg, "POST", "/p", { body: { a: 1 } });
    expect(h.fetch.mock.calls[0]![1].body).toBe('{"a":1}');
    await fgRequest(cfg, "PUT", "/p", { body: { b: 2 } });
    expect(h.fetch.mock.calls[1]![1].body).toBe('{"b":2}');
    await fgRequest(cfg, "DELETE", "/p", { body: { c: 3 } });
    expect(h.fetch.mock.calls[2]![1].body).toBeUndefined();
    await fgRequest(cfg, "GET", "/p", { body: { d: 4 } });
    expect(h.fetch.mock.calls[3]![1].body).toBeUndefined();
  });
});

describe("fgRequest — reading the answer", () => {
  it("404 is a 404 naming the path", async () => {
    respond(404, {});
    await expect(fgRequest(cfg, "GET", "/api/v2/cmdb/nope")).rejects.toMatchObject({ httpStatus: 404, message: "Endpoint not found: /api/v2/cmdb/nope" });
  });

  it("a refusal relays FortiOS's own cli_error, message and CLI code, in that order", async () => {
    respond(500, { http_status: 500, status: "error", error: -651, cli_error: "entry not\n found", message: "Invalid value" });
    await expect(fgRequest(cfg, "PUT", "/api/v2/cmdb/x")).rejects.toMatchObject({
      httpStatus: 502,
      message: "FortiGate returned HTTP 500 for /api/v2/cmdb/x — entry not found; Invalid value; FortiOS error -651",
    });
  });

  it("an error code of 0 is still named; a body with nothing useful adds nothing", async () => {
    respond(500, { error: 0 });
    await expect(fgRequest(cfg, "GET", "/a")).rejects.toThrow("FortiGate returned HTTP 500 for /a — FortiOS error 0");
    respond(500, { status: "error" });
    await expect(fgRequest(cfg, "GET", "/a")).rejects.toThrow(/^FortiGate returned HTTP 500 for \/a$/);
    respond(502, {}, "");
    await expect(fgRequest(cfg, "GET", "/a")).rejects.toThrow(/^FortiGate returned HTTP 502 for \/a$/);
  });

  it("an HTML page from something in front of the gate is one trimmed line, capped at 200 characters", async () => {
    const html = `<html>\n  <body>\n${"x".repeat(400)}</body></html>`;
    respond(503, null, html);
    const err = (await fgRequest(cfg, "GET", "/a").catch((e: unknown) => e)) as AppError;
    expect(err.message.startsWith("FortiGate returned HTTP 503 for /a — <html> <body> xxx")).toBe(true);
    expect(err.message.length).toBe("FortiGate returned HTTP 503 for /a — ".length + 200);
  });

  it("a body that cannot even be read leaves the plain status message", async () => {
    h.fetch.mockResolvedValue({ status: 500, ok: false, text: async () => { throw new Error("socket closed"); } });
    await expect(fgRequest(cfg, "GET", "/a")).rejects.toThrow(/^FortiGate returned HTTP 500 for \/a$/);
  });

  it("a 200 whose envelope says status error is a 502 with FortiOS's code and message", async () => {
    respond(200, { status: "error", error: -3, message: "object not found" });
    await expect(fgRequest(cfg, "GET", "/a")).rejects.toMatchObject({ httpStatus: 502, message: "FortiGate error (-3): object not found" });
    respond(200, { status: "error" });
    await expect(fgRequest(cfg, "GET", "/a")).rejects.toThrow("FortiGate error (unknown): /a");
  });

  it("envelope: true returns the whole body; otherwise results, else the body itself", async () => {
    respond(200, { status: "success", serial: "FG100F", results: { hostname: "gw" } });
    await expect(fgRequest(cfg, "GET", "/a", { envelope: true })).resolves.toMatchObject({ serial: "FG100F" });
    await expect(fgRequest(cfg, "GET", "/a")).resolves.toEqual({ hostname: "gw" });
    respond(200, { status: "success", data: 1 });
    await expect(fgRequest(cfg, "GET", "/a")).resolves.toEqual({ status: "success", data: 1 });
  });
});

describe("testConnection — what the button says", () => {
  it.each([
    [{ version: "v7.6.7", results: { hostname: "HQ-FW", model: "FGT61F" } }, "Connected — HQ-FW (FGT61F), FortiOS v7.6.7", "v7.6.7"],
    [{ results: { hostname: "HQ-FW" } }, "Connected — HQ-FW", undefined],
    [{ results: { model: "FGT61F" }, version: "v7.4.1" }, "Connected — FGT61F, FortiOS v7.4.1", "v7.4.1"],
    [{ version: "v7.2.0", results: {} }, "Connected — FortiOS v7.2.0", "v7.2.0"],
    [{ results: {} }, "Connected successfully", undefined],
  ])("%j → %s", async (body, message, version) => {
    respond(200, { status: "success", ...body });
    await expect(testConnection(cfg)).resolves.toEqual({ ok: true, message, version });
    expect(sent()[0]).toContain("/api/v2/monitor/system/status");
  });

  it("an HTTP refusal is ok:false with the transport's message", async () => {
    respond(403, {});
    const r = await testConnection(cfg);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/permission denied \(HTTP 403\) for 10\.0\.0\.1:443/);
  });

  it("a refused connection names the target", async () => {
    h.fetch.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expect(testConnection({ ...cfg, port: 10443 })).resolves.toEqual({ ok: false, message: "Connection refused — 10.0.0.1:10443" });
  });

  it("an unrecognised error keeps its own message, and an empty one reads Unknown error", async () => {
    h.fetch.mockRejectedValue(new Error("weird"));
    await expect(testConnection(cfg)).resolves.toEqual({ ok: false, message: "weird" });
    h.fetch.mockRejectedValue(new Error(""));
    await expect(testConnection(cfg)).resolves.toEqual({ ok: false, message: "Unknown error" });
  });
});

describe("describeFgTransportError — every branch", () => {
  const failed = (code?: string, msg?: string) => Object.assign(new TypeError("fetch failed"), { cause: { code, message: msg } });

  it("timeouts and non-JSON answers", () => {
    expect(describeFgTransportError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe("request timed out");
    expect(describeFgTransportError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe("request timed out");
    expect(describeFgTransportError(new SyntaxError("Unexpected token <"))).toMatch(/^the response was not JSON/);
  });

  it("a refused certificate pin (rule 113(e)) uses the pin's own message, else a default", () => {
    expect(describeFgTransportError(failed("CERT_PIN_REFUSED", "pin mismatch for 10.0.0.1"))).toBe("pin mismatch for 10.0.0.1");
    expect(describeFgTransportError(failed("CERT_PIN_REFUSED"))).toBe("the TLS certificate changed since it was pinned");
  });

  it.each([
    ["ECONNREFUSED", /^connection refused \(ECONNREFUSED\)/],
    ["ENOTFOUND", /^host not found \(ENOTFOUND\)$/],
    ["ETIMEDOUT", /^connection timed out \(ETIMEDOUT\)/],
    ["UND_ERR_CONNECT_TIMEOUT", /^connection timed out \(UND_ERR_CONNECT_TIMEOUT\)/],
    ["EHOSTUNREACH", /^no route to host \(EHOSTUNREACH\)$/],
    ["ENETUNREACH", /^no route to host \(ENETUNREACH\)$/],
    ["ECONNRESET", /^connection reset \(ECONNRESET\)$/],
    ["UND_ERR_SOCKET", /^connection reset \(UND_ERR_SOCKET\)$/],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", /^TLS certificate error \(DEPTH_ZERO_SELF_SIGNED_CERT\) — SSL verification is on/],
    ["CERT_HAS_EXPIRED", /^TLS certificate error/],
    ["ERR_TLS_CERT_ALTNAME_INVALID", /^TLS certificate error/],
  ])("%s", (code, re) => {
    expect(describeFgTransportError(failed(code))).toMatch(re);
  });

  it("an unknown code carries its message; fetch failed with only a cause message uses that", () => {
    expect(describeFgTransportError(failed("EPROTO", "wrong version number"))).toBe("EPROTO: wrong version number");
    expect(describeFgTransportError(failed(undefined, "other side closed"))).toBe("other side closed");
    expect(describeFgTransportError(failed(undefined))).toBeNull();
    expect(describeFgTransportError(null)).toBeNull();
  });
});

describe("FortiosAuthPausedError / proxyQuery", () => {
  it("keeps the 401 prefix classifiers read, rounds the pause UP to seconds, and is a 502", () => {
    const e = new FortiosAuthPausedError("10.0.0.9", 8443, 59_001);
    expect(e).toBeInstanceOf(AppError);
    expect(e.httpStatus).toBe(502);
    expect(e.name).toBe("FortiosAuthPausedError");
    expect(e.remainingMs).toBe(59_001);
    expect(e.message).toMatch(/^Authentication failed \(HTTP 401\) for 10\.0\.0\.9:8443 — Polaris has paused requests to this FortiGate for 60 s/);
  });

  it("proxyQuery adds the target note to a transport failure", async () => {
    h.fetch.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    await expect(proxyQuery(cfg, "GET", "/a", undefined, undefined, "(resolved from FortiManager port1)"))
      .rejects.toThrow("Could not reach FortiGate at 10.0.0.1:443 (resolved from FortiManager port1) — host not found (ENOTFOUND)");
  });

  it("proxyQuery passes query and body through on success", async () => {
    respond(200, { results: { ok: 1 } });
    await expect(proxyQuery(cfg, "POST", "/a", { vdom: "root" }, { x: 1 })).resolves.toEqual({ ok: 1 });
    expect(sent()[0]).toBe("https://10.0.0.1:443/a?vdom=root");
    expect(sent()[1].body).toBe('{"x":1}');
  });
});
