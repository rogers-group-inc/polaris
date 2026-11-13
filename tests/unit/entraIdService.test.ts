/**
 * tests/unit/entraIdService.test.ts — entraIdService's own suite (CQ-T010).
 *
 * Complements, and does not repeat:
 *   - graphRequest.test.ts        — graphApiRequest: host pinning, 401/403
 *                                   re-mint, 429 backoff, 204, allow404
 *   - entraEthernetMac.test.ts    — planEthernetMacFetch + the per-device $batch read
 *   - directoryAbsence.test.ts    — entraSweepBlockedReason
 *   - directorySearchService / directoryBulkReaders — searchDirectoryEntra,
 *                                   listDirectoryPeople
 *   - softwareReaders / softwareInventoryService — fetchIntuneDetectedApps
 *   - intunePublish.test.ts       — Graph writes through graphApiRequest
 *
 * Covered here: the client-credentials token (error_description first line,
 * bare `error`, a missing access_token, the per-tenant:client cache and its
 * 60 s early refresh), testConnection (required fields, the fresh-secret
 * re-mint, Intune probe failure wording, the swallowed Organization read, the
 * network-error mapping), proxyQuery (path prefix guard, query params, the
 * fixed host), and discoverDevices end to end: Entra paging, the Intune overlay
 * (Intune wins on shared fields; Intune-only devices), null-GUID skip, MAC
 * normalisation, the include / exclude filter and includeDisabled=false, the
 * absence snapshot taken BEFORE either filter, Intune failure / partial read
 * degrading to Entra-only, a scoped run's OData filter and its GUID guard.
 *
 * Graph is a stubbed fetch answering the shapes the existing suites use
 * ({ value: [...] , "@odata.nextLink"? }). Secrets are placeholders.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/utils/sleep.js", () => ({ sleep: vi.fn(async () => {}) }));

import { testConnection, proxyQuery, discoverDevices, type EntraIdConfig } from "../../src/services/entraIdService.js";

const DEV_A = "aaaaaaaa-0000-0000-0000-000000000001";
const DEV_B = "bbbbbbbb-0000-0000-0000-000000000002";
const DEV_C = "cccccccc-0000-0000-0000-000000000003";
const NULL_GUID = "00000000-0000-0000-0000-000000000000";

let seq = 0;
function cfg(over: Partial<EntraIdConfig> = {}): EntraIdConfig {
  seq++;
  return { tenantId: `tenant-${seq}`, clientId: `client-${seq}`, clientSecret: "placeholder-secret", ...over };
}

type Route = (url: URL, init: any) => { status: number; body?: unknown } | undefined;
let routes: Route[] = [];
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (pred: (u: URL) => boolean) => fetchMock.mock.calls.filter(([u]) => pred(new URL(String(u))));
const isToken = (u: URL) => u.host === "login.microsoftonline.com";
const graphCalls = () => calls((u) => u.host === "graph.microsoft.com");

function json(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  routes = [];
  fetchMock = vi.fn(async (url: string, init: any = {}) => {
    const u = new URL(String(url));
    for (const r of routes) {
      const out = r(u, init);
      if (out) return json(out.status, out.body ?? {});
    }
    if (isToken(u)) return json(200, { access_token: "placeholder-token", expires_in: 3600 });
    return json(404, { error: { message: `unrouted ${u.pathname}` } });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the client-credentials token", () => {
  it("surfaces the first line of error_description on a refused secret", async () => {
    routes.push((u) => (isToken(u) ? { status: 401, body: { error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided.\r\nTrace ID: x" } } : undefined));
    await expect(testConnection(cfg())).resolves.toEqual({ ok: false, message: "Entra ID token request failed: AADSTS7000215: Invalid client secret provided." });
  });

  it("falls back to the bare error code, then to the HTTP status", async () => {
    routes.push((u) => (isToken(u) ? { status: 400, body: { error: "unauthorized_client" } } : undefined));
    expect((await testConnection(cfg())).message).toBe("Entra ID token request failed: unauthorized_client");
    routes.length = 0;
    routes.push((u) => (isToken(u) ? { status: 503, body: "<html>down</html>" } : undefined));
    expect((await testConnection(cfg())).message).toBe("Entra ID token request failed: HTTP 503");
  });

  it("refuses a 200 that carries no access_token", async () => {
    routes.push((u) => (isToken(u) ? { status: 200, body: { token_type: "Bearer" } } : undefined));
    expect((await testConnection(cfg())).message).toBe("Entra ID token response missing access_token");
  });

  it("is cached per tenant:client and re-minted 60 s before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-04-01T12:00:00Z"));
    routes.push((u) => (isToken(u) ? { status: 200, body: { access_token: "short", expires_in: 120 } } : undefined));
    routes.push((u) => (u.pathname === "/v1.0/me" ? { status: 200, body: { ok: 1 } } : undefined));
    const c = cfg();
    await proxyQuery(c, "/v1.0/me");
    await proxyQuery(c, "/v1.0/me");
    expect(calls(isToken)).toHaveLength(1);
    vi.setSystemTime(new Date("2026-04-01T12:01:01Z")); // 59 s left: inside the refresh margin
    await proxyQuery(c, "/v1.0/me");
    expect(calls(isToken)).toHaveLength(2);
    await proxyQuery(cfg({ tenantId: c.tenantId }), "/v1.0/me"); // another client id: its own token
    expect(calls(isToken)).toHaveLength(3);
  });

  it("sends the bearer token and the eventual-consistency header to Graph", async () => {
    routes.push((u) => (u.pathname === "/v1.0/me" ? { status: 200, body: {} } : undefined));
    await proxyQuery(cfg(), "/v1.0/me");
    const init = graphCalls()[0][1];
    expect(init.headers).toMatchObject({ Authorization: "Bearer placeholder-token", ConsistencyLevel: "eventual" });
  });
});

describe("testConnection", () => {
  it.each([
    [{ tenantId: "" }, "Tenant ID is required"],
    [{ clientId: "" }, "Client ID is required"],
    [{ clientSecret: "" }, "Client secret is required"],
  ])("refuses %j without a network call", async (over, message) => {
    await expect(testConnection(cfg(over))).resolves.toEqual({ ok: false, message });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("names the tenant when Organization.Read.All is granted", async () => {
    routes.push((u) => (u.pathname === "/v1.0/devices" ? { status: 200, body: { value: [] } } : undefined));
    routes.push((u) => (u.pathname === "/v1.0/organization" ? { status: 200, body: { value: [{ displayName: "Example Tenant" }] } } : undefined));
    await expect(testConnection(cfg())).resolves.toEqual({ ok: true, message: 'Connected — tenant "Example Tenant"' });
  });

  it("swallows a refused Organization read and still reports success", async () => {
    routes.push((u) => (u.pathname === "/v1.0/devices" ? { status: 200, body: { value: [] } } : undefined));
    routes.push((u) => (u.pathname === "/v1.0/organization" ? { status: 403, body: { error: { message: "Insufficient privileges" } } } : undefined));
    await expect(testConnection(cfg())).resolves.toEqual({ ok: true, message: "Connected successfully" });
  });

  it("always mints a fresh token, even with one cached, so a new secret is really tested", async () => {
    routes.push((u) => (u.pathname === "/v1.0/devices" || u.pathname === "/v1.0/me" ? { status: 200, body: { value: [] } } : undefined));
    const c = cfg();
    await proxyQuery(c, "/v1.0/me");
    await testConnection(c);
    expect(calls(isToken)).toHaveLength(2);
  });

  it("only probes Intune when enabled, and says which scope failed", async () => {
    routes.push((u) => (u.pathname === "/v1.0/devices" ? { status: 200, body: { value: [] } } : undefined));
    routes.push((u) => (u.pathname === "/v1.0/deviceManagement/managedDevices" ? { status: 403, body: { error: { message: "Missing scope" } } } : undefined));
    await testConnection(cfg());
    expect(graphCalls().some(([u]) => String(u).includes("managedDevices"))).toBe(false);
    const res = await testConnection(cfg({ enableIntune: true }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/^Entra device scope OK, but Intune query failed — Graph API permission denied \(403\): Missing scope/);
  });

  it("maps network failures to operator wording", async () => {
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); });
    expect((await testConnection(cfg())).message).toBe("Host not found — check network connectivity");
    fetchMock.mockImplementationOnce(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); });
    expect((await testConnection(cfg())).message).toBe("Connection timed out contacting Microsoft Graph");
    fetchMock.mockImplementationOnce(async () => { throw new Error("socket hang up"); });
    expect((await testConnection(cfg())).message).toBe("socket hang up");
  });
});

describe("proxyQuery", () => {
  it("refuses a path that is not /v1.0/ or /beta/ before any request", async () => {
    await expect(proxyQuery(cfg(), "/v2.0/me")).rejects.toMatchObject({ httpStatus: 400 });
    await expect(proxyQuery(cfg(), "//evil.example/v1.0/x")).rejects.toMatchObject({ httpStatus: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the host, sets the query params (skipping blank keys) and returns the parsed body", async () => {
    routes.push((u) => (u.pathname === "/beta/devices" ? { status: 200, body: { value: [1] } } : undefined));
    await expect(proxyQuery(cfg(), "/beta/devices", { $top: "5", "": "dropped", $select: "id,displayName" })).resolves.toEqual({ value: [1] });
    const u = new URL(String(graphCalls()[0][0]));
    expect(u.host).toBe("graph.microsoft.com");
    expect(u.searchParams.get("$top")).toBe("5");
    expect(u.searchParams.get("$select")).toBe("id,displayName");
    expect([...u.searchParams.keys()]).not.toContain("");
  });
});

describe("discoverDevices", () => {
  const entra = (deviceId: string, over: Record<string, unknown> = {}) => ({
    id: "obj-" + deviceId, deviceId, displayName: "E-" + deviceId.slice(0, 4), operatingSystem: "Windows",
    operatingSystemVersion: "10.0.19045", trustType: "AzureAd", accountEnabled: true, isCompliant: true, isManaged: true, ...over,
  });
  const intune = (azureADDeviceId: string, over: Record<string, unknown> = {}) => ({
    id: "md-" + azureADDeviceId.slice(0, 8), azureADDeviceId,
    deviceName: "I-" + azureADDeviceId.slice(0, 4), operatingSystem: "Windows", osVersion: "10.0.22631",
    serialNumber: "SN-" + azureADDeviceId.slice(0, 4), wiFiMacAddress: "a0b1c2d3e4f5", ethernetMacAddress: null,
    manufacturer: "Dell", model: "Latitude", userPrincipalName: "user@example.test", complianceState: "compliant",
    lastSyncDateTime: "2026-04-01T00:00:00Z", ...over,
  });

  function serve(opts: { entraPages: unknown[][]; intune?: unknown[] | "fail"; intuneNext?: boolean }): void {
    routes.push((u) => {
      if (u.pathname !== "/v1.0/devices") return undefined;
      const page = Number(u.searchParams.get("page") ?? "0");
      const next = page + 1 < opts.entraPages.length ? `https://graph.microsoft.com/v1.0/devices?page=${page + 1}` : undefined;
      return { status: 200, body: { value: opts.entraPages[page], ...(next ? { "@odata.nextLink": next } : {}) } };
    });
    routes.push((u) => {
      if (u.pathname !== "/v1.0/deviceManagement/managedDevices") return undefined;
      if (opts.intune === "fail") return { status: 500, body: { error: { message: "Intune service unavailable" } } };
      return { status: 200, body: { value: opts.intune ?? [] } };
    });
    // Per-device Ethernet MAC reads: none reported.
    routes.push((u, init) => {
      if (u.pathname !== "/v1.0/$batch") return undefined;
      const body = JSON.parse(init.body);
      return { status: 200, body: { responses: body.requests.map((r: any) => ({ id: r.id, status: 200, body: { ethernetMacAddress: null } })) } };
    });
  }

  it("pages Entra devices through nextLink and merges Intune over them (Intune wins on shared fields)", async () => {
    serve({ entraPages: [[entra(DEV_A)], [entra(DEV_B)]], intune: [intune(DEV_A.toUpperCase())] });
    const progress: string[] = [];
    const res = await discoverDevices(cfg({ enableIntune: true }), undefined, (step, _lvl, msg) => progress.push(`${step}: ${msg}`));
    expect(res.devices.map((d) => [d.deviceId, d.sources])).toEqual([[DEV_A, ["entra", "intune"]], [DEV_B, ["entra"]]]);
    const a = res.devices[0];
    expect(a).toMatchObject({
      displayName: "I-AAAA", entraDisplayName: "E-aaaa", intuneDeviceName: "I-AAAA", operatingSystemVersion: "10.0.22631",
      trustType: "AzureAd", serialNumber: "SN-AAAA", wifiMacAddress: "A0:B1:C2:D3:E4:F5", macAddress: "A0:B1:C2:D3:E4:F5",
      manufacturer: "Dell", isCompliant: true,
    });
    expect(a.ethernetMacAddress).toBeUndefined();
    expect(res.devices[1]).toMatchObject({ displayName: "E-bbbb", operatingSystemVersion: "10.0.19045", serialNumber: undefined });
    expect(res.intuneRead).toBe("ok");
    expect(progress).toContain("discover.entra.devices: Entra ID: retrieved 2 device(s)");
  });

  it("adds Intune-only devices as active, and skips empty / null-GUID ids on both sides", async () => {
    serve({ entraPages: [[entra(DEV_A), entra(NULL_GUID), entra("")]], intune: [intune(DEV_C), intune(NULL_GUID)] });
    const progress: string[] = [];
    const res = await discoverDevices(cfg({ enableIntune: true }), undefined, (_s, _l, m) => progress.push(m));
    expect(res.devices.map((d) => [d.deviceId, d.sources, d.accountEnabled])).toEqual([[DEV_A, ["entra"], true], [DEV_C, ["intune"], true]]);
    expect(res.devices[1]).toMatchObject({ trustType: "", displayName: "I-cccc" });
    expect(progress.some((m) => /Skipping 3 device\(s\) with empty or null deviceId/.test(m))).toBe(true);
  });

  it("drops an unparseable Wi-Fi MAC rather than storing junk", async () => {
    serve({ entraPages: [[entra(DEV_A)]], intune: [intune(DEV_A, { wiFiMacAddress: "000000000000" })] });
    const [d] = (await discoverDevices(cfg({ enableIntune: true }))).devices;
    expect(d.wifiMacAddress).toBeUndefined();
    expect(d.macAddress).toBeUndefined();
  });

  it("takes the absence snapshot BEFORE the name filter and the includeDisabled skip", async () => {
    serve({ entraPages: [[entra(DEV_A, { displayName: "LAB-01" }), entra(DEV_B, { displayName: "OFFICE-01", accountEnabled: false }), entra(DEV_C, { displayName: "OFFICE-02" })]] });
    const res = await discoverDevices(cfg({ deviceExclude: ["LAB-*"], includeDisabled: false }));
    expect(res.devices.map((d) => d.displayName)).toEqual(["OFFICE-02"]);
    expect(res.presentDeviceIds).toEqual([DEV_A, DEV_B, DEV_C]);
    expect(res.disabledDeviceIds).toEqual([DEV_B]);
    expect(res).toMatchObject({ intuneRead: "disabled", presentIntuneDeviceIds: [], inventoryComplete: true, scoped: false });
  });

  it("an include list wins over an exclude list; disabled devices are kept by default", async () => {
    serve({ entraPages: [[entra(DEV_A, { displayName: "LAB-01", accountEnabled: false }), entra(DEV_B, { displayName: "OFFICE-01" })]] });
    const res = await discoverDevices(cfg({ deviceInclude: ["lab-*"], deviceExclude: ["LAB-01"] }));
    expect(res.devices.map((d) => [d.displayName, d.accountEnabled])).toEqual([["LAB-01", false]]);
  });

  it("an Intune outage degrades to Entra-only with intuneRead 'failed', never failing the run", async () => {
    serve({ entraPages: [[entra(DEV_A)]], intune: "fail" });
    const progress: Array<[string, string]> = [];
    const res = await discoverDevices(cfg({ enableIntune: true }), undefined, (_s, lvl, m) => progress.push([lvl, m]));
    expect(res.devices.map((d) => d.sources)).toEqual([["entra"]]);
    expect(res.intuneRead).toBe("failed");
    expect(progress).toContainEqual(["error", expect.stringMatching(/^Intune: failed to list managed devices — Graph API HTTP 500: Intune service unavailable/)]);
  });

  it("an Entra failure fails the run, logged first", async () => {
    routes.push((u) => (u.pathname === "/v1.0/devices" ? { status: 403, body: { error: { message: "Device.Read.All missing" } } } : undefined));
    const progress: string[] = [];
    await expect(discoverDevices(cfg(), undefined, (_s, _l, m) => progress.push(m))).rejects.toThrow(/permission denied \(403\): Device.Read.All missing/);
    expect(progress[0]).toMatch(/^Entra ID: failed to list devices/);
  });

  it("an aborted read is reported incomplete and Intune is not asked", async () => {
    serve({ entraPages: [[entra(DEV_A)]], intune: [intune(DEV_A)] });
    const ac = new AbortController();
    ac.abort();
    const res = await discoverDevices(cfg({ enableIntune: true }), ac.signal);
    expect(res).toMatchObject({ devices: [], inventoryComplete: false, intuneRead: "disabled" });
    expect(graphCalls()).toHaveLength(0);
  });

  it("a scoped run filters both endpoints by the lower-cased deviceId and says it was scoped", async () => {
    serve({ entraPages: [[entra(DEV_A)]], intune: [intune(DEV_A)] });
    const res = await discoverDevices(cfg({ enableIntune: true }), undefined, undefined, { deviceId: DEV_A.toUpperCase() });
    expect(res.scoped).toBe(true);
    const urls = graphCalls().map(([u]) => decodeURIComponent(String(u)));
    expect(urls[0]).toContain(`$filter=deviceId eq '${DEV_A}'`);
    expect(urls[1]).toContain(`$filter=azureADDeviceId eq '${DEV_A}'`);
  });

  it("refuses a scoped deviceId that is not a GUID — it would reach an OData filter", async () => {
    await expect(discoverDevices(cfg(), undefined, undefined, { deviceId: "x' or 1 eq 1 or deviceId eq '" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
