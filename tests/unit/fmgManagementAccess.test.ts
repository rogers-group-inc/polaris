/**
 * tests/unit/fmgManagementAccess.test.ts
 *
 * FortiManager proxy-mode discovery builds the management-access summaries
 * (Asset.managementAccess — the slide-over's Open HTTPS / Open SSH buttons)
 * inside each gate's own pass, from FortiManager's DEVICE DB: `allowaccess`
 * rides Step 1's interface read, `wtp-profile` rides Step 3d.4's wtp read, and
 * Step 3d.6 adds the AP-profile and switch local-access tables. None of it may
 * go through /sys/proxy/json — the one-at-a-time lane sync Phase 13.6 used to
 * queue up to five reads per gate on, after the run had finished.
 *
 * FortiManager's encodings are the device DB's: string-array allowaccess,
 * one-element reference arrays, [addr, mask] ip arrays.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { discoverDhcpSubnets, type FortiManagerConfig } from "../../src/services/fortimanagerService.js";

// Route the transport back to the global fetch (see fmgDiscoverySteps.test.ts).
vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
  insecureTlsDispatcher: () => ({}),
}));

const CONFIG = {
  host: "fmg.test.local", port: 443, apiUser: "polaris-api", apiToken: "test-token", adom: "root", useProxy: true,
} as FortiManagerConfig;

const DEVICE = {
  name: "FGT-A", hostname: "fgt-a", sn: "FG100XTEST", platform_str: "FortiGate-100F",
  ip: "10.0.0.1", conn_status: 1, os_ver: 7, mr: 4, patch: 3,
};

const D = "/pm/config/device/FGT-A";
const native = (data: unknown) => ({ result: [{ status: { code: 0 }, data }] });
const proxied = (results: unknown, httpStatus = 200) =>
  ({ result: [{ status: { code: 0 }, data: [{ status: { code: 0 }, response: { http_status: httpStatus, results } }] }] });
const missing = { result: [{ status: { code: -3, message: "no such object" }, data: null }] };

interface RouterOpts {
  withInfra?: boolean;
  /** Override (or blank) a native url's answer. */
  native?: Record<string, unknown>;
}

function stub(opts: RouterOpts = {}) {
  const withInfra = opts.withInfra !== false;
  const nativeCalls: string[] = [];
  const proxyResources: string[] = [];
  const NATIVE: Record<string, unknown> = {
    "/dvmdb/adom/root/device": native([DEVICE]),
    [`${D}/global/system/interface`]: native([
      { name: "mgmt", ip: ["10.0.0.1", "255.255.255.0"], macaddr: "00:09:0f:11:22:33", allowaccess: ["ping", "https", "ssh"] },
      { name: "wan1", ip: ["203.0.113.2", "255.255.255.0"], macaddr: "00:09:0f:11:22:44", allowaccess: ["ping"] },
    ]),
    [`${D}/vdom/root/wireless-controller/wtp`]: native([{ "wtp-id": "FP231FTEST0001", name: "ap-1", "wtp-profile": ["FAP231F-default"] }]),
    [`${D}/vdom/root/wireless-controller/wtp-profile`]: native([{ name: "FAP231F-default", allowaccess: ["https", "snmp"] }]),
    [`${D}/global/switch-controller/security-policy/local-access`]: native([
      { name: "default", "mgmt-allowaccess": ["https", "ping", "ssh"], "internal-allowaccess": ["https", "ping"] },
    ]),
    ...opts.native,
  };
  vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
    const p = JSON.parse(init.body).params?.[0] ?? {};
    const url: string = p.url ?? "";
    let body: unknown = missing;
    if (url === "/sys/proxy/json") {
      const resource: string = p.data?.resource ?? "";
      proxyResources.push(resource);
      if (resource.startsWith("/api/v2/monitor/switch-controller/managed-switch/status")) {
        body = withInfra
          ? proxied([{ serial: "S248EFTEST0001", "switch-id": "S248EFTEST0001", connecting_from: "10.255.1.2", status: "Connected", state: "Authorized" }])
          : proxied(null, 404);
      } else if (resource.startsWith("/api/v2/monitor/wifi/managed_ap")) {
        body = withInfra
          ? proxied([{ name: "ap-1", serial: "FP231FTEST0001", wtp_id: "FP231FTEST0001", status: "connected", state: "authorized", connecting_from: "10.30.0.9" }])
          : proxied(null, 404);
      } else {
        body = proxied([]);
      }
    } else {
      nativeCalls.push(url);
      if (url in NATIVE) body = NATIVE[url];
    }
    return { ok: true, status: 200, json: async () => body };
  });
  return { nativeCalls, proxyResources };
}

afterEach(() => { vi.unstubAllGlobals(); });

const protocolsBySerial = (r: Awaited<ReturnType<typeof discoverDhcpSubnets>>) =>
  Object.fromEntries((r.managementAccess ?? []).map((m) => [m.serial, m.summary.protocols]));

describe("FMG proxy discovery — management access from the device DB", () => {
  it("summarizes the gate, its AP and its switch without a single proxied read for it", async () => {
    const { nativeCalls, proxyResources } = stub();
    const result = await discoverDhcpSubnets({ ...CONFIG, switchManagementInterface: "mgmt" });

    expect(protocolsBySerial(result)).toEqual({
      FG100XTEST: ["ping", "https", "ssh"],
      FP231FTEST0001: ["https", "snmp"],
      // switchManagementInterface "mgmt" reads the policy's mgmt half.
      S248EFTEST0001: ["https", "ping", "ssh"],
    });
    const fw = result.managementAccess!.find((m) => m.serial === "FG100XTEST")!.summary;
    expect(fw.mgmtIp).toBe("10.0.0.1");

    // Native reads, one each — and nothing management-access-shaped on the proxy lane.
    expect(nativeCalls.filter((u) => u === `${D}/global/system/interface`)).toHaveLength(1);
    expect(nativeCalls.filter((u) => u.endsWith("/wireless-controller/wtp-profile"))).toEqual([`${D}/vdom/root/wireless-controller/wtp-profile`]);
    expect(nativeCalls.filter((u) => u.endsWith("/local-access"))).toEqual([`${D}/global/switch-controller/security-policy/local-access`]);
    expect(proxyResources.filter((r) => /system\/interface|wtp-profile|local-access|wireless-controller\/wtp/.test(r))).toEqual([]);
  });

  it("falls back to the ADOM wtp-profile objects and the vdom local-access scope", async () => {
    const { nativeCalls } = stub({
      native: {
        [`${D}/vdom/root/wireless-controller/wtp-profile`]: native([]),
        "/pm/config/adom/root/obj/wireless-controller/wtp-profile": native([{ name: "FAP231F-default", allowaccess: ["ssh"] }]),
        [`${D}/global/switch-controller/security-policy/local-access`]: missing,
        [`${D}/vdom/root/switch-controller/security-policy/local-access`]: native([{ name: "default", "internal-allowaccess": ["snmp"] }]),
      },
    });
    const result = await discoverDhcpSubnets(CONFIG);

    expect(protocolsBySerial(result)).toMatchObject({ FP231FTEST0001: ["ssh"], S248EFTEST0001: ["snmp"] });
    expect(nativeCalls).toContain("/pm/config/adom/root/obj/wireless-controller/wtp-profile");
    expect(nativeCalls).toContain(`${D}/vdom/root/switch-controller/security-policy/local-access`);
  });

  it("a table neither place answers leaves its devices unknown, never 'nothing permitted'", async () => {
    stub({
      native: {
        [`${D}/vdom/root/wireless-controller/wtp-profile`]: missing,
        [`${D}/global/switch-controller/security-policy/local-access`]: missing,
        // An encoding the parser does not know (a bitmask) on the gate's interface.
        [`${D}/global/system/interface`]: native([{ name: "mgmt", ip: ["10.0.0.1", "255.255.255.0"], allowaccess: 1234 }]),
      },
    });
    const result = await discoverDhcpSubnets(CONFIG);
    expect(protocolsBySerial(result)).toEqual({ FG100XTEST: null, FP231FTEST0001: null, S248EFTEST0001: null });
  });

  it("a gate with no switches or APs makes no profile or local-access read", async () => {
    const { nativeCalls } = stub({ withInfra: false });
    const result = await discoverDhcpSubnets(CONFIG);
    expect(protocolsBySerial(result)).toEqual({ FG100XTEST: ["ping", "https", "ssh"] });
    expect(nativeCalls.filter((u) => u.endsWith("/wtp-profile") || u.endsWith("/local-access"))).toEqual([]);
  });
});
