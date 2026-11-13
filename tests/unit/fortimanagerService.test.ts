/**
 * tests/unit/fortimanagerService.test.ts — the FortiManager JSON-RPC client's
 * small entry points (CQ-T010: one own file per service).
 *
 * Complements, does not repeat:
 *   - discovery (discoverDhcpSubnets) — fmgDiscoverySteps, fmgOfflineCmdb,
 *     fmgScopedDiscovery, fmgManagementAccess;
 *   - the transport retry / status classification — fmgRpcRetry;
 *   - testConnection — integrationAdapters and the routes' tests;
 *   - the pure parsers (decodeCentralManagementFlags, extractHaFromFmgDevice,
 *     extractMetavarCoordsFromFmgDevice, extractRosterConnectivity /
 *     extractRosterIdentities, parseFmgVariableDynamicMapping, parseVipServerInfo)
 *     — each has its own suite.
 *
 * What this adds — exports no test ran the body of (callers mock them):
 *   - rpc()'s lane routing through the FmgWorker: /sys/proxy/json → the
 *     concurrency-1 proxy lane, everything else → the native lane, no
 *     integrationId → direct (proxyQuery is the probe);
 *   - resolveDeviceMgmtIpViaFmg: no mgmt interface = no call, the filtered fast
 *     path, the unfiltered fallback when the filter comes back empty / throws,
 *     0.0.0.0 rejected (an HA cluster's dedicated mgmt interface);
 *   - testRandomFortiGate: every FMG-level refusal (not retried), the backup
 *     pick after a first gate fails, the "also tried" message, the direct
 *     FortiGate config it builds;
 *   - detectCentralManagement: the ADOM flags verdict beats the table probe,
 *     the probe is the fallback, a transport failure returns null (keep the
 *     previous stamp);
 *   - fmgProxyRest: the /sys/proxy/json envelope it sends and unwraps, -11,
 *     FortiOS-level errors, body only on POST/PUT;
 *   - setFmgDeviceCmdbGuiCoords / setFmgDeviceMetavarCoords: payload shape
 *     (native update / set on dynamic_mapping, 6 decimals) and per-param failures;
 *   - proxyQueryViaFortigate: the 400s, the unresolvable-IP 502, the FortiGate
 *     config handed to the direct client;
 *   - fetchRosterConnectivity: one native roster read with NO fields list.
 *
 * FMG response shapes mirror the fixtures in fmgDiscoverySteps.test.ts
 * (`nativeData`, `proxyEnvelope`); nothing here invents a format.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  tlsFetch: vi.fn(),
  submitProxy: vi.fn(),
  submitNative: vi.fn(),
  getFmgWorker: vi.fn(),
  fgTestConnection: vi.fn(),
  fgProxyQuery: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: h.tlsFetch,
  insecureTlsDispatcher: () => ({}),
}));
vi.mock("../../src/services/fmgWorker.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getFmgWorker: h.getFmgWorker,
}));
vi.mock("../../src/services/fortigateService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  testConnection: h.fgTestConnection,
  proxyQuery: h.fgProxyQuery,
}));

import {
  proxyQuery,
  resolveDeviceMgmtIpViaFmg,
  testRandomFortiGate,
  detectCentralManagement,
  fmgProxyRest,
  setFmgDeviceCmdbGuiCoords,
  setFmgDeviceMetavarCoords,
  proxyQueryViaFortigate,
  fetchRosterConnectivity,
  type FortiManagerConfig,
} from "../../src/services/fortimanagerService.js";

const CONFIG: FortiManagerConfig = {
  host: "fmg.test.local",
  port: 443,
  apiUser: "polaris-api",
  apiToken: "test-token",
  adom: "root",
};

function nativeData(data: unknown, code = 0, message = "OK") {
  return { result: [{ status: { code, message }, data }] };
}
function proxyEnvelope(results: unknown, code = 0, httpStatus = 200) {
  return { result: [{ status: { code: 0 }, data: [{ status: { code }, response: { http_status: httpStatus, results } }] }] };
}

/** Every JSON-RPC payload sent, parsed. */
const sent = (): any[] => h.tlsFetch.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));

/** Route each JSON-RPC payload to a canned body. */
function route(fn: (payload: any) => unknown): void {
  h.tlsFetch.mockImplementation(async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body);
    const body = fn(payload);
    if (body instanceof Error) throw body;
    return { status: 200, ok: true, json: async () => body };
  });
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.submitProxy.mockImplementation((_l: string, run: () => Promise<unknown>) => run());
  h.submitNative.mockImplementation((_l: string, run: () => Promise<unknown>) => run());
  h.getFmgWorker.mockReturnValue({ submitProxy: h.submitProxy, submitNative: h.submitNative });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── rpc lane routing ──────────────────────────────────────────────────────

describe("rpc lane routing (via proxyQuery)", () => {
  it("without an integrationId the call runs direct, bypassing the worker", async () => {
    route(() => nativeData([]));
    await proxyQuery(CONFIG, "get", [{ url: "/sys/status" }]);
    expect(h.getFmgWorker).not.toHaveBeenCalled();
    expect(h.tlsFetch.mock.calls[0][0]).toBe("https://fmg.test.local:443/jsonrpc");
    const init = h.tlsFetch.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(init.headers.access_user).toBe("polaris-api");
  });

  it("a /sys/proxy/json payload goes to the concurrency-1 proxy lane, labelled by target and resource", async () => {
    route(() => proxyEnvelope([]));
    await proxyQuery(CONFIG, "exec", [{ url: "/sys/proxy/json", data: { target: ["/adom/root/device/FGT-A"], action: "get", resource: "/api/v2/monitor/system/status" } }], "itg1");
    expect(h.getFmgWorker).toHaveBeenCalledWith("itg1");
    expect(h.submitProxy).toHaveBeenCalledTimes(1);
    expect(h.submitNative).not.toHaveBeenCalled();
    expect(h.submitProxy.mock.calls[0][0]).toBe("fmg.exec:/adom/root/device/FGT-A:/api/v2/monitor/system/status");
  });

  it("every other URL goes to the native lane", async () => {
    route(() => nativeData([]));
    await proxyQuery(CONFIG, "get", [{ url: "/dvmdb/adom/root/device" }], "itg1");
    expect(h.submitNative).toHaveBeenCalledTimes(1);
    expect(h.submitNative.mock.calls[0][0]).toBe("fmg.get:/dvmdb/adom/root/device");
    expect(h.submitProxy).not.toHaveBeenCalled();
  });

  it("a non-default port lands in the endpoint URL", async () => {
    route(() => nativeData([]));
    await proxyQuery({ ...CONFIG, port: 8443 }, "get", [{ url: "/sys/status" }]);
    expect(h.tlsFetch.mock.calls[0][0]).toBe("https://fmg.test.local:8443/jsonrpc");
  });
});

// ─── resolveDeviceMgmtIpViaFmg ─────────────────────────────────────────────

describe("resolveDeviceMgmtIpViaFmg", () => {
  const ifaceUrl = "/pm/config/device/FGT-A/global/system/interface";

  it("no management interface configured: null, and FMG is never asked", async () => {
    expect(await resolveDeviceMgmtIpViaFmg({ ...CONFIG, mgmtInterface: "  " }, "FGT-A")).toBeNull();
    expect(h.tlsFetch).not.toHaveBeenCalled();
  });

  it("the filtered fast path answers in one call", async () => {
    route(() => nativeData([{ name: "mgmt", ip: ["10.0.0.1", "255.255.255.0"] }]));
    expect(await resolveDeviceMgmtIpViaFmg({ ...CONFIG, mgmtInterface: "mgmt" }, "FGT-A", undefined, "itg1")).toBe("10.0.0.1");
    expect(sent()).toHaveLength(1);
    expect(sent()[0].params[0]).toEqual({ url: ifaceUrl, filter: [["name", "==", "mgmt"]], fields: ["name", "ip"], loadsub: 0 });
    expect(h.submitNative).toHaveBeenCalledTimes(1);
  });

  it("an empty filtered answer falls back to the full list, matched client-side", async () => {
    route((p) => p.params[0].filter
      ? nativeData([])
      : nativeData([
          { name: "wan1", ip: ["203.0.113.2", "255.255.255.0"] },
          { name: "mgmt", ip: ["10.0.0.9", "255.255.255.0"] },
        ]));
    expect(await resolveDeviceMgmtIpViaFmg({ ...CONFIG, mgmtInterface: "mgmt" }, "FGT-A")).toBe("10.0.0.9");
    expect(sent()).toHaveLength(2);
    expect(sent()[1].params[0]).toEqual({ url: ifaceUrl, fields: ["name", "ip"], loadsub: 0 });
  });

  it("a thrown filtered query also falls back (a scalar ip is accepted too)", async () => {
    // A permanent HTTP status, so the throw skips the transient-retry backoff.
    h.tlsFetch
      .mockResolvedValueOnce({ status: 404, ok: false, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 200, ok: true, json: async () => nativeData([{ name: "mgmt", ip: "10.0.0.7" }]) });
    expect(await resolveDeviceMgmtIpViaFmg({ ...CONFIG, mgmtInterface: "mgmt" }, "FGT-A")).toBe("10.0.0.7");
  });

  it("0.0.0.0 (an HA cluster's dedicated mgmt interface) is no address on either pass", async () => {
    route(() => nativeData([{ name: "mgmt", ip: ["0.0.0.0", "0.0.0.0"] }]));
    expect(await resolveDeviceMgmtIpViaFmg({ ...CONFIG, mgmtInterface: "mgmt" }, "FGT-A")).toBeNull();
    expect(sent()).toHaveLength(2);
  });

  it("a non-array unfiltered answer is null, not a throw", async () => {
    route(() => nativeData(null, -3, "Object does not exist"));
    expect(await resolveDeviceMgmtIpViaFmg({ ...CONFIG, mgmtInterface: "mgmt" }, "FGT-A")).toBeNull();
  });
});

// ─── testRandomFortiGate ───────────────────────────────────────────────────

describe("testRandomFortiGate", () => {
  const direct: FortiManagerConfig = { ...CONFIG, useProxy: false, fortigateApiUser: "fgapi", fortigateApiToken: "fg-tok", mgmtInterface: "mgmt" };

  it("refuses without a FortiGate API token, before contacting FMG", async () => {
    const r = await testRandomFortiGate({ ...direct, fortigateApiToken: undefined });
    expect(r.ok).toBe(false);
    expect(r.deviceName).toBe("(none)");
    expect(r.message).toMatch(/FortiGate API Token is required/);
    expect(h.tlsFetch).not.toHaveBeenCalled();
  });

  it("a failed roster fetch is reported, not retried per gate", async () => {
    h.tlsFetch.mockResolvedValue({ status: 403, ok: false, json: async () => ({}) });
    const r = await testRandomFortiGate(direct);
    expect(r).toMatchObject({ ok: false, deviceName: "(none)" });
    expect(r.message).toMatch(/^Failed to fetch device list from FMG: .*403/);
    expect(h.tlsFetch).toHaveBeenCalledTimes(1);
  });

  it("an empty ADOM names the ADOM", async () => {
    route(() => nativeData([]));
    const r = await testRandomFortiGate({ ...direct, adom: "branch" });
    expect(r.message).toBe('No managed devices found in ADOM "branch"');
    expect(sent()[0].params[0]).toEqual({ url: "/dvmdb/adom/branch/device", fields: ["name", "hostname", "ip"], loadsub: 0 });
  });

  it("include filters that leave nothing are reported as such", async () => {
    route(() => nativeData([{ name: "FGT-A" }, { name: "FGT-B" }]));
    const r = await testRandomFortiGate({ ...direct, deviceInclude: ["LAB-*"] });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/No managed FortiGate is available to test against/);
  });

  it("no management interface on the integration is an FMG-level refusal", async () => {
    route(() => nativeData([{ name: "FGT-A" }]));
    const r = await testRandomFortiGate({ ...direct, mgmtInterface: "" });
    expect(r.message).toMatch(/mgmt interface is not configured/);
    expect(h.fgTestConnection).not.toHaveBeenCalled();
  });

  it("a gate with no resolvable IP is skipped for a backup pick, which succeeds", async () => {
    // random → 0 keeps the shuffle deterministic: [A, B] → [B, A].
    vi.spyOn(Math, "random").mockReturnValue(0);
    route((p) => {
      const url: string = p.params[0].url;
      if (url === "/dvmdb/adom/root/device") return nativeData([{ name: "FGT-A" }, { name: "FGT-B" }]);
      if (url === "/pm/config/device/FGT-B/global/system/interface") return nativeData([]);
      if (url === "/pm/config/device/FGT-A/global/system/interface") return nativeData([{ name: "mgmt", ip: ["10.0.0.1", "255.255.255.0"] }]);
      return nativeData(null, -3);
    });
    h.fgTestConnection.mockResolvedValue({ ok: true, message: "Connected — FortiOS v7.6.8", version: "v7.6.8" });
    const r = await testRandomFortiGate(direct);
    expect(r).toEqual({ ok: true, message: "Connected — FortiOS v7.6.8", version: "v7.6.8", deviceName: "FGT-A", attempts: ["FGT-B", "FGT-A"] });
    expect(h.fgTestConnection).toHaveBeenCalledWith({
      host: "10.0.0.1", port: 443, apiUser: "fgapi", apiToken: "fg-tok", vdom: "root", verifySsl: false, mgmtInterface: "mgmt",
    });
  });

  it("at most two gates are tried; the last failure is returned with the others named", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999); // identity shuffle: [A, B, C]
    route((p) => {
      const url: string = p.params[0].url;
      if (url === "/dvmdb/adom/root/device") return nativeData([{ name: "FGT-A" }, { name: "FGT-B" }, { name: "FGT-C" }]);
      return nativeData([{ name: "mgmt", ip: ["10.0.0.1", "255.255.255.0"] }]);
    });
    h.fgTestConnection
      .mockResolvedValueOnce({ ok: false, message: "timeout A" })
      .mockResolvedValueOnce({ ok: false, message: "401 B", version: undefined });
    const r = await testRandomFortiGate({ ...direct, fortigateVerifySsl: true });
    expect(h.fgTestConnection).toHaveBeenCalledTimes(2);
    expect(h.fgTestConnection.mock.calls[0][0].verifySsl).toBe(true);
    expect(r).toMatchObject({ ok: false, deviceName: "FGT-B", message: "401 B (also tried: FGT-A)", attempts: ["FGT-A", "FGT-B"] });
  });

  it("a single gate that fails carries no 'also tried' suffix; a device with no name falls back to hostname", async () => {
    route((p) => {
      const url: string = p.params[0].url;
      if (url === "/dvmdb/adom/root/device") return nativeData([{ hostname: "fw-host" }]);
      return nativeData([]);
    });
    const r = await testRandomFortiGate(direct);
    expect(r).toMatchObject({ ok: false, deviceName: "fw-host", attempts: ["fw-host"] });
    expect(r.message).toBe('Could not resolve a management IP for "fw-host" on interface "mgmt"');
  });
});

// ─── detectCentralManagement ───────────────────────────────────────────────

describe("detectCentralManagement", () => {
  const syntax = { adom: { attr: { flags: { opts: { per_device_wtp: 1024, per_device_fsw: 65536 } } } } };

  function routeCm(opts: { flags?: unknown; syntaxOk?: boolean; wtp?: unknown; fsw?: unknown }) {
    route((p) => {
      const q = p.params[0];
      if (q.url === "/dvmdb/adom" && q.option) return opts.syntaxOk === false ? nativeData(null, -6) : nativeData(syntax);
      if (q.url === "/dvmdb/adom") return nativeData([{ name: "other", flags: 0 }, { name: "root", flags: opts.flags }]);
      if (q.url === "/pm/config/adom/root/obj/wireless-controller/wtp") return opts.wtp ?? nativeData([]);
      if (q.url === "/pm/config/adom/root/obj/fsp/managed-switch") return opts.fsw ?? nativeData([]);
      return nativeData(null, -3);
    });
  }

  it("the ADOM flags verdict wins over the table probe", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z"));
    // per_device_fsw set → switches per-device even though the switch table has rows;
    // APs central even though the AP table is empty.
    routeCm({ flags: 65536, wtp: nativeData([]), fsw: nativeData([{ name: "S1" }, { name: "S2" }]) });
    const r = await detectCentralManagement(CONFIG, "itg1");
    expect(r).toEqual({ wtp: true, fsw: false, wtpCount: 0, fswCount: 2, detectedAt: "2026-06-15T12:00:00.000Z" });
    // The ADOM row read uses the TABLE form with a filter (mkey-get rejects extra attributes).
    const rowRead = sent().find((p) => p.params[0].url === "/dvmdb/adom" && p.params[0].filter);
    expect(rowRead.params[0]).toEqual({ url: "/dvmdb/adom", filter: ["name", "==", "root"], fields: ["name", "flags"] });
    vi.useRealTimers();
  });

  it("without a syntax dump the table probe decides: rows = central, a rejected table = not", async () => {
    routeCm({ syntaxOk: false, wtp: nativeData([{ name: "AP1" }]), fsw: nativeData(null, -3) });
    const r = await detectCentralManagement(CONFIG);
    expect(r).toMatchObject({ wtp: true, fsw: false, wtpCount: 1, fswCount: null });
  });

  it("a transport failure on the probes returns null so the previous stamp is kept", async () => {
    h.tlsFetch.mockResolvedValue({ status: 401, ok: false, json: async () => ({}) });
    expect(await detectCentralManagement(CONFIG)).toBeNull();
  });
});

// ─── fmgProxyRest ──────────────────────────────────────────────────────────

describe("fmgProxyRest", () => {
  it("sends one exec on /sys/proxy/json targeting the device, and unwraps FortiOS results", async () => {
    route(() => ({ result: [{ status: { code: 0 }, data: [{ response: { http_status: 200, results: [{ ip: "10.1.1.1" }] } }] }] }));
    const out = await fmgProxyRest(CONFIG, "FGT-A", "GET", "/api/v2/monitor/system/dhcp", { integrationId: "itg1", body: { ignored: true } });
    expect(out).toEqual([{ ip: "10.1.1.1" }]);
    expect(sent()[0]).toEqual({
      id: 1, method: "exec",
      params: [{ url: "/sys/proxy/json", data: { target: ["/adom/root/device/FGT-A"], action: "get", resource: "/api/v2/monitor/system/dhcp" } }],
    });
    expect(h.submitProxy).toHaveBeenCalledTimes(1);
  });

  it("POST / PUT forward the body as the proxy payload", async () => {
    route(() => ({ result: [{ status: { code: 0 }, data: [{ response: { http_status: 200, mkey: "7" } }] }] }));
    const out = await fmgProxyRest({ ...CONFIG, adom: "branch" }, "FGT-A", "POST", "/api/v2/monitor/system/dhcp/revoke", { body: { ip: ["10.1.1.1"] } });
    expect(sent()[0].params[0].data).toEqual({ target: ["/adom/branch/device/FGT-A"], action: "post", resource: "/api/v2/monitor/system/dhcp/revoke", payload: { ip: ["10.1.1.1"] } });
    // No `results` in the response: the response body itself is returned.
    expect(out).toEqual({ http_status: 200, mkey: "7" });
  });

  it("FMG -11 is an expired-token error; any other FMG code carries FMG's message", async () => {
    route(() => nativeData(null, -11, "No permission"));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/x")).rejects.toThrow("FortiManager: invalid or expired API token");
    route(() => nativeData(null, -6, "Invalid url"));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/x")).rejects.toThrow("FortiManager proxy error: Invalid url");
  });

  it("an empty proxy payload is a 502", async () => {
    route(() => ({ result: [{ status: { code: 0 }, data: [] }] }));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/x")).rejects.toMatchObject({ httpStatus: 502, message: "FortiManager proxy returned no response payload" });
  });

  it("a FortiOS-level error status surfaces the gate's own error text", async () => {
    route(() => ({ result: [{ status: { code: 0 }, data: [{ response: { http_status: 404, error: -5 } }] }] }));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/api/v2/monitor/nope")).rejects.toThrow(/^FortiGate \(via FMG proxy\) error: /);
    route(() => ({ result: [{ status: { code: 0 }, data: [{ response: { http_status: 500, message: "internal" } }] }] }));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/x")).rejects.toThrow("FortiGate (via FMG proxy) error: internal");
  });

  // Was a bug until 2026-11-13: fmgProxyRest read the per-target
  // `data[0].status.code` as the FortiOS HTTP status, while every other
  // /sys/proxy/json reader in the file reads it as FMG's per-target code (0 = OK)
  // and takes HTTP from `response.http_status`. A successful target's 0 became
  // "HTTP 0", so every proxied write (reservation push, lease release,
  // quarantine, reboot) failed in proxy mode.
  it("accepts a successful target whose per-target FMG status code is 0 (the fixtures' proxyEnvelope shape)", async () => {
    route(() => proxyEnvelope([{ ip: "10.1.1.1" }]));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/api/v2/monitor/system/dhcp")).resolves.toEqual([{ ip: "10.1.1.1" }]);
  });

  it("a non-zero per-target FMG code outside the HTTP range is FMG failing to reach the gate, with its message", async () => {
    route(() => ({ result: [{ status: { code: 0 }, data: [{ status: { code: -3, message: "device is not reachable" } }] }] }));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/x")).rejects.toThrow("FortiGate (via FMG proxy) error: device is not reachable");
  });

  it("a per-target code in the HTTP range is still read as the HTTP status", async () => {
    route(() => ({ result: [{ status: { code: 0 }, data: [{ status: { code: 403, message: "forbidden" } }] }] }));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/x")).rejects.toThrow("FortiGate (via FMG proxy) error: forbidden");
    route(() => ({ result: [{ status: { code: 0 }, data: [{ status: { code: 200 }, response: { results: { ok: 1 } } }] }] }));
    await expect(fmgProxyRest(CONFIG, "FGT-A", "GET", "/x")).resolves.toEqual({ ok: 1 });
  });
});

// ─── native coordinate writes ──────────────────────────────────────────────

describe("setFmgDeviceCmdbGuiCoords", () => {
  it("updates system/global natively with six-decimal strings", async () => {
    route(() => nativeData(null));
    await setFmgDeviceCmdbGuiCoords(CONFIG, "FGT-A", 37.1, -87.123456789, "itg1");
    expect(sent()[0]).toEqual({
      id: 1, method: "update",
      params: [{ url: "/pm/config/device/FGT-A/global/system/global", data: { "gui-device-latitude": "37.100000", "gui-device-longitude": "-87.123457" } }],
    });
    expect(h.submitNative).toHaveBeenCalledTimes(1);
  });

  it("a non-zero status throws with FMG's message", async () => {
    route(() => nativeData(null, -10, "The data is invalid for selected url"));
    await expect(setFmgDeviceCmdbGuiCoords(CONFIG, "FGT-A", 1, 2)).rejects.toThrow("FortiManager CMDB coord write failed: The data is invalid for selected url");
  });
});

describe("setFmgDeviceMetavarCoords", () => {
  it("sets each coordinate variable's dynamic_mapping entry scoped to the device (global vdom)", async () => {
    route(() => ({ result: [{ status: { code: 0 } }, { status: { code: 0 } }] }));
    await setFmgDeviceMetavarCoords(CONFIG, "FGT-A", 37.5, -87.5, " SiteLat ", "");
    const p = sent()[0];
    expect(p.method).toBe("set");
    expect(p.params).toEqual([
      { url: "/pm/config/adom/root/obj/fmg/variable/SiteLat/dynamic_mapping", data: [{ _scope: [{ name: "FGT-A", vdom: "global" }], value: "37.500000" }] },
      // a blank metavar name falls back to the default
      { url: "/pm/config/adom/root/obj/fmg/variable/Longitude/dynamic_mapping", data: [{ _scope: [{ name: "FGT-A", vdom: "global" }], value: "-87.500000" }] },
    ]);
  });

  it("names every variable that failed, with its code", async () => {
    route(() => ({ result: [{ status: { code: 0 } }, { status: { code: -3, message: "Object does not exist" } }] }));
    await expect(setFmgDeviceMetavarCoords(CONFIG, "FGT-A", 1, 2))
      .rejects.toThrow("FortiManager metavar coord write failed — Longitude: Object does not exist (code -3)");
    route(() => ({ result: [] }));
    await expect(setFmgDeviceMetavarCoords(CONFIG, "FGT-A", 1, 2))
      .rejects.toThrow("FortiManager metavar coord write failed — Latitude: rejected; Longitude: rejected");
  });
});

// ─── proxyQueryViaFortigate ────────────────────────────────────────────────

describe("proxyQueryViaFortigate", () => {
  const direct: FortiManagerConfig = { ...CONFIG, fortigateApiToken: "fg-tok", mgmtInterface: "mgmt" };

  it("refuses with 400 without a FortiGate token or a management interface", async () => {
    await expect(proxyQueryViaFortigate({ ...direct, fortigateApiToken: undefined }, "FGT-A", "GET", "/x")).rejects.toMatchObject({ httpStatus: 400 });
    await expect(proxyQueryViaFortigate({ ...direct, mgmtInterface: undefined }, "FGT-A", "GET", "/x")).rejects.toMatchObject({ httpStatus: 400 });
    expect(h.tlsFetch).not.toHaveBeenCalled();
  });

  it("an unresolvable management IP is a 502 naming the device and interface", async () => {
    route(() => nativeData([]));
    await expect(proxyQueryViaFortigate(direct, "FGT-A", "GET", "/x")).rejects.toMatchObject({
      httpStatus: 502, message: 'Could not resolve a management IP for "FGT-A" on interface "mgmt"',
    });
    expect(h.fgProxyQuery).not.toHaveBeenCalled();
  });

  it("hands the direct client the resolved IP, the gate credentials and a target note", async () => {
    route(() => nativeData([{ name: "mgmt", ip: ["10.0.0.1", "255.255.255.0"] }]));
    h.fgProxyQuery.mockResolvedValue({ ok: 1 });
    expect(await proxyQueryViaFortigate(direct, "FGT-A", "PUT", "/api/v2/cmdb/x", { vdom: "root" }, "itg1", { a: 1 })).toEqual({ ok: 1 });
    const [cfg, method, path, query, body, note] = h.fgProxyQuery.mock.calls[0];
    expect(cfg).toEqual({ host: "10.0.0.1", port: 443, apiUser: "", apiToken: "fg-tok", vdom: "root", verifySsl: false, mgmtInterface: "mgmt" });
    expect([method, path, query, body]).toEqual(["PUT", "/api/v2/cmdb/x", { vdom: "root" }, { a: 1 }]);
    expect(note).toContain('"FGT-A"');
  });
});

// ─── fetchRosterConnectivity ───────────────────────────────────────────────

describe("fetchRosterConnectivity", () => {
  it("reads the roster natively with no fields list (a fields list trips -11) and projects it", async () => {
    route(() => nativeData([
      { name: "FGT-A", sn: "fgt60f001", conn_status: 1, ha_slave: [{ name: "FGT-A-2", sn: "fgt60f002", status: 0 }] },
      { name: "FGT-B", sn: "FGT60F003", conn_status: 2 },
    ]));
    const r = await fetchRosterConnectivity({ ...CONFIG, adom: "branch" }, undefined, "itg1");
    expect(sent()[0].params).toEqual([{ url: "/dvmdb/adom/branch/device" }]);
    expect(h.submitNative).toHaveBeenCalledTimes(1);
    expect(r.map((d) => [d.serial, d.connected, d.haMember])).toEqual([
      ["FGT60F001", true, false],
      ["FGT60F002", false, true],
      ["FGT60F003", false, false],
    ]);
  });

  it("a roster with no data is an empty list", async () => {
    route(() => nativeData(null, -11));
    expect(await fetchRosterConnectivity(CONFIG)).toEqual([]);
  });
});
