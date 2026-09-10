import { describe, it, expect, vi, afterEach } from "vitest";
import { discoverDhcpSubnets, type FortiManagerConfig } from "../../src/services/fortimanagerService.js";

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

// Single-FortiGate scoped re-discovery (`scopeDeviceName`): the roster is
// narrowed to ONE device after the include/exclude filter and after the raw
// roster is captured into knownDeviceNames — so per-device RPCs only fire for
// the scoped gate while the returned knownDeviceNames still carries the whole
// fleet (the caller's sweep protection). A scope that matches nothing throws
// (distinguishing roster-miss from filtered-out) instead of silently running
// an empty discovery.
//
// Both roster devices are offline (conn_status 0) so processDevice stays on
// the deterministic FMG-native cached-CMDB path (no proxy/live-monitor
// branches) — same simplification as fmgOfflineCmdb.test.ts.

const SCOPED = "FGT-A";
const OTHER = "FGT-B";

function makeFetchMock() {
  const state = { urls: [] as string[] };
  const fetchMock = vi.fn(async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const params: any[] = body.params || [];
    const result = params.map((p) => {
      const u: string = p.url || "";
      state.urls.push(u);

      if (u.endsWith(`/dvmdb/adom/root/device`)) {
        return {
          status: { code: 0 },
          data: [
            { name: SCOPED, hostname: SCOPED, sn: "FGT-A-SN", platform_str: "FortiGate-60F", ip: "10.0.0.1", conn_status: 0 },
            { name: OTHER,  hostname: OTHER,  sn: "FGT-B-SN", platform_str: "FortiGate-60F", ip: "10.0.0.2", conn_status: 0 },
          ],
        };
      }
      if (u.endsWith(`/global/system/interface`)) {
        return { status: { code: 0 }, data: [{ name: "port1", ip: ["10.0.0.1", "255.255.255.0"], macaddr: "00:11:22:33:44:55" }] };
      }
      if (u.endsWith(`/vdom/root/system/dhcp/server`)) {
        return {
          status: { code: 0 },
          data: [{ id: 1, interface: "port2", netmask: "255.255.255.0", "ip-range": [{ "start-ip": "192.168.10.10" }] }],
        };
      }
      if (u.endsWith(`/vdom/root/system/interface`)) {
        return { status: { code: 0 }, data: [{ name: "port2", ip: ["192.168.10.1", "255.255.255.0"] }] };
      }
      // VIPs, CMDB rosters, geo, metavars, anything else: empty best-effort.
      return { status: { code: 0 }, data: [] };
    });
    return { status: 200, ok: true, json: async () => ({ id: body.id, result }) };
  });
  return { fetchMock, state };
}

const baseConfig: FortiManagerConfig = {
  host: "fmg.test",
  port: 443,
  apiUser: "polaris",
  apiToken: "tok",
  verifySsl: true,
  mgmtInterface: "port1",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FMG scoped single-device re-discovery", () => {
  it("processes only the scoped device but keeps the full roster in knownDeviceNames", async () => {
    const { fetchMock, state } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const progress: string[] = [];
    const result = await discoverDhcpSubnets(
      baseConfig,
      undefined,
      (_step, _level, message) => { progress.push(message); },
      24, undefined, undefined, undefined, undefined,
      // Scope in different case than the roster's "FGT-A" — matching must be
      // case-insensitive (fmgNameKey semantics, same as filterDevices).
      "fgt-a",
    );

    // Only the scoped device was processed…
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0].name).toBe(SCOPED);
    // …and no per-device RPC ever targeted the other gate.
    expect(state.urls.some((u) => u.includes(`/device/${OTHER}/`))).toBe(false);
    expect(state.urls.some((u) => u.includes(`/device/${SCOPED}/`))).toBe(true);

    // The FULL raw roster is preserved for the caller's sweep protection.
    expect(result.knownDeviceNames).toContain(SCOPED);
    expect(result.knownDeviceNames).toContain(OTHER);

    // The progress message satisfies the run accumulator's
    // /Found (\d+) managed device/ parse with totalDevices = 1.
    const found = progress.find((m) => /Found (\d+) managed device/.test(m));
    expect(found).toBeDefined();
    expect(/Found (\d+) managed device/.exec(found!)?.[1]).toBe("1");
    expect(found).toContain("scoped re-discovery");
  });

  it("throws a roster-miss error when the scoped device is not in the ADOM", async () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      discoverDhcpSubnets(baseConfig, undefined, undefined, 24, undefined, undefined, undefined, undefined, "FGT-MISSING"),
    ).rejects.toThrow(/was not found in the ADOM "root" device roster/);
  });

  it("throws a filtered-out error when the scoped device is excluded by deviceInclude/deviceExclude", async () => {
    const { fetchMock } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const config: FortiManagerConfig = { ...baseConfig, deviceExclude: [SCOPED] };
    await expect(
      discoverDhcpSubnets(config, undefined, undefined, 24, undefined, undefined, undefined, undefined, SCOPED),
    ).rejects.toThrow(/excluded by the integration's device include\/exclude filter/);
  });
});
