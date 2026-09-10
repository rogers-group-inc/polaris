/**
 * tests/unit/fmgDiscoverySteps.test.ts — end-to-end canned-transport coverage
 * for the FMG discovery orchestrator, written alongside the 2026-08 per-device
 * step conversion (fmgStep* over FmgDeviceCtx). Global fetch is stubbed with a
 * JSON-RPC router, so the whole proxy-mode pipeline runs for real: device
 * roster → per-device steps → chunk merge → DiscoveryResult.
 *
 * The load-bearing assertions are the five *InventoriedDevices arrays — they
 * are derived from the ctx.flags booleans the conversion moved across a
 * function boundary (the exact silent-propagation hazard the scouting
 * flagged). The offline case pins the flag-force: a conn_status!=1 gate's
 * cached-CMDB pull stays purely additive (subnets/VIPs land, every flag
 * array empty) and never issues a /sys/proxy/json live-monitor call.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

const CONFIG: FortiManagerConfig = {
  host: "fmg.test.local",
  port: 443,
  apiUser: "polaris-api",
  apiToken: "test-token",
  adom: "root",
  useProxy: true,
} as FortiManagerConfig;

function proxyEnvelope(results: unknown, code = 0, httpStatus = 200) {
  return { result: [{ status: { code: 0 }, data: [{ status: { code }, response: { http_status: httpStatus, results } }] }] };
}
function nativeData(data: unknown) {
  return { result: [{ status: { code: 0 }, data }] };
}

function makeRouter(device: Record<string, unknown>, opts: { failOnProxy?: boolean } = {}) {
  const unrouted: string[] = [];
  const proxyCalls: string[] = [];
  const route = (payload: any): unknown => {
    const p = payload.params?.[0] ?? {};
    const url: string = p.url ?? "";
    if (url === "/dvmdb/adom/root/device") return nativeData([device]);
    if (url === "/pm/config/device/FGT-A/global/system/interface") {
      return nativeData([
        { name: "mgmt", ip: ["10.0.0.1", "255.255.255.0"], macaddr: "00:09:0f:11:22:33" },
        { name: "wan1", ip: ["203.0.113.2", "255.255.255.0"], macaddr: "00:09:0f:11:22:44" },
      ]);
    }
    if (url === "/pm/config/device/FGT-A/vdom/root/system/dhcp/server") {
      return nativeData([{
        id: 1, interface: "lan", netmask: "255.255.255.0",
        "ip-range": [{ "start-ip": "10.10.10.100" }],
        "reserved-address": [{ id: 7, ip: "10.10.10.50", mac: "AA:BB:CC:DD:EE:01", description: "printer" }],
      }]);
    }
    if (url === "/pm/config/device/FGT-A/vdom/root/system/interface") {
      return nativeData([
        { name: "lan", ip: ["10.10.10.1", "255.255.255.0"], "switch-controller-mgmt-vlan": 20 },
        { name: "vl30", ip: ["10.30.0.1", "255.255.255.0"], vlanid: 30 },
      ]);
    }
    if (url === "/pm/config/device/FGT-A/global/switch-controller/managed-switch") return nativeData([]);
    if (url === "/pm/config/device/FGT-A/vdom/root/wireless-controller/wtp") return nativeData([]);
    if (url === "/pm/config/device/FGT-A/global/system/global") return nativeData({});
    if (url === "/pm/config/device/FGT-A/vdom/root/firewall/vip") {
      return nativeData([{ name: "web-vip", extip: ["203.0.113.10"], mappedip: ["10.10.10.20"], extintf: ["wan1"] }]);
    }
    if (url === "/sys/proxy/json") {
      const resource: string = p.data?.resource ?? "";
      proxyCalls.push(resource);
      if (opts.failOnProxy) throw new Error(`offline device must not receive live-monitor calls (got ${resource})`);
      if (resource.startsWith("/api/v2/monitor/system/dhcp")) {
        return proxyEnvelope([
          { ip: "10.10.10.50", mac: "aa:bb:cc:dd:ee:01", reserved: true, interface: "lan" },
          { ip: "10.10.10.77", mac: "AA:BB:CC:DD:EE:02", hostname: "laptop", interface: "lan", expire_time: 4242 },
        ]);
      }
      if (resource.startsWith("/api/v2/monitor/user/device/query")) {
        return proxyEnvelope([{
          mac: "AA:BB:CC:DD:EE:02", ip: "10.10.10.77", hostname: "laptop",
          os: "Windows", is_online: true, last_seen: Math.floor(Date.now() / 1000),
        }]);
      }
      // switch-controller status / wifi managed_ap: feature not licensed —
      // proxy-level 404 counts as "queried successfully, zero devices".
      if (resource.startsWith("/api/v2/monitor/switch-controller/managed-switch/status")) return proxyEnvelope(null, 0, 404);
      if (resource.startsWith("/api/v2/monitor/wifi/managed_ap")) return proxyEnvelope(null, 0, 404);
      if (resource.startsWith("/api/v2/monitor/switch-controller/detected-device")) return proxyEnvelope(null, -11, 200);
      if (resource.startsWith("/api/v2/monitor/network/arp")) return proxyEnvelope([]);
    }
    unrouted.push(url);
    // Best-effort callers (metavar map, etc.) treat a non-zero status as empty.
    return { result: [{ status: { code: -3, message: "unrouted (test)" }, data: null }] };
  };
  return { route, unrouted, proxyCalls };
}

function stubFetch(router: ReturnType<typeof makeRouter>) {
  vi.stubGlobal("fetch", async (_url: unknown, init: { body: string }) => {
    const payload = JSON.parse(init.body);
    const body = router.route(payload);
    return { ok: true, status: 200, json: async () => body };
  });
}

const ONLINE_DEVICE = {
  name: "FGT-A", hostname: "fgt-a", sn: "FG100XTEST", platform_str: "FortiGate-100F",
  ip: "10.0.0.1", conn_status: 1, os_ver: 7, mr: 4, patch: 3,
};

beforeEach(() => { /* per-test stubbing below */ });
afterEach(() => { vi.unstubAllGlobals(); });

describe("discoverDhcpSubnets (FMG proxy mode, canned transport)", () => {
  it("runs the full per-device step pipeline and propagates the query-landed flags", async () => {
    const router = makeRouter(ONLINE_DEVICE);
    stubFetch(router);

    const result = await discoverDhcpSubnets(CONFIG);

    expect(result.knownDeviceNames).toEqual(["FGT-A"]);
    expect(result.devices).toHaveLength(1);
    const dev = result.devices[0]!;
    expect(dev.serial).toBe("FG100XTEST");
    expect(dev.mgmtIp).toBe("10.0.0.1");         // Step 1 resolved from mgmt iface
    expect(dev.mgmtMac).toBe("00:09:0F:11:22:33");
    expect(dev.haMode).toBe("standalone");

    // Step 2 subnet + Step 3 VLAN backfill (switch-controller-mgmt-vlan).
    expect(result.subnets).toEqual([
      expect.objectContaining({ cidr: "10.10.10.0/24", name: "lan", fortigateDevice: "FGT-A", vlan: 20 }),
    ]);

    // Step 3a merge semantics: the CMDB reservation gains seenLeased; the
    // monitor-only IP lands as a dhcp-lease.
    const reservation = result.dhcpEntries.find((e) => e.ipAddress === "10.10.10.50")!;
    expect(reservation.type).toBe("dhcp-reservation");
    expect(reservation.seenLeased).toBe(true);
    const lease = result.dhcpEntries.find((e) => e.ipAddress === "10.10.10.77")!;
    expect(lease.type).toBe("dhcp-lease");
    expect(lease.hostname).toBe("laptop");

    // Step 3 interface IPs (mgmt + filtered interfaces + secondary handling).
    const roles = result.interfaceIps.map((i) => `${i.interfaceName}:${i.role}`).sort();
    expect(roles).toEqual(["lan:interface", "mgmt:management", "vl30:interface"]);

    // Step 3b inventory (with the DHCP-derived interface enrich).
    expect(result.deviceInventory).toHaveLength(1);
    expect(result.deviceInventory[0]!.hostname).toBe("laptop");

    // Step 3e VIP (FMG's flattened single-element-array field encoding).
    expect(result.vips).toEqual([
      expect.objectContaining({ name: "web-vip", extip: "203.0.113.10", mappedips: ["10.10.10.20"], extintf: "wan1" }),
    ]);

    // THE conversion's hazard: the ctx.flags booleans must have propagated
    // out of the step functions. Proxy-404 switch/AP count as queried.
    expect(result.switchInventoriedDevices).toEqual(["FGT-A"]);
    expect(result.apInventoriedDevices).toEqual(["FGT-A"]);
    expect(result.vipInventoriedDevices).toEqual(["FGT-A"]);
    expect(result.dhcpReservationsInventoriedDevices).toEqual(["FGT-A"]);
    expect(result.dhcpLeasesInventoriedDevices).toEqual(["FGT-A"]);
    expect(result.inventoryDevices).toEqual(["FGT-A"]);

    expect(router.unrouted.every((u) => !u.includes("/FGT-A/"))).toBe(true); // no per-device step went unrouted
  });

  it("offline gate: cached-CMDB pull is purely additive — no live-monitor calls, every flag array empty", async () => {
    const router = makeRouter({ ...ONLINE_DEVICE, conn_status: 0 }, { failOnProxy: true });
    stubFetch(router);

    const result = await discoverDhcpSubnets(CONFIG);

    // CMDB-derived data still lands…
    expect(result.subnets).toHaveLength(1);
    expect(result.vips).toHaveLength(1);
    expect(result.devices[0]!.offline).toBe(true);
    // …but no /sys/proxy/json live query was ever attempted…
    expect(router.proxyCalls).toEqual([]);
    // …and the flag-force zeroed every query-landed array, so the sync's
    // decommission / Phase 5b sweeps can never act on a cached pull.
    expect(result.switchInventoriedDevices).toEqual([]);
    expect(result.apInventoriedDevices).toEqual([]);
    expect(result.vipInventoriedDevices).toEqual([]);
    expect(result.dhcpReservationsInventoriedDevices).toEqual([]);
    expect(result.dhcpLeasesInventoriedDevices).toEqual([]);
    expect(result.inventoryDevices).toEqual([]);
  });
});
