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

// A FortiGate that is OFFLINE in FortiManager (conn_status !== 1) must still
// have its IP information pulled from FMG's cached CMDB — subnets, static DHCP
// reservations, interface IPs, VIPs — while ALL live-monitor queries
// (/sys/proxy/json → /api/v2/monitor/*: leases, inventory, switch/AP status,
// ARP) are skipped (the device is unreachable). The offline pull is config-only:
// it must never mark the device as inventoried (so it can't drive decommission)
// and the returned device carries offline=true (so the sync withholds lastSeen).

const DEVICE = "FGT-OFFLINE";

// One fetch response entry per JSON-RPC param, keyed on the param's `url`
// (and, for live-monitor calls, `data.resource`). Records whether any
// /sys/proxy/json call was attempted so tests can assert it never happens.
function makeFetchMock() {
  const state = { proxyCalled: false as boolean, hosts: new Set<string>() };
  const fetchMock = vi.fn(async (url: string, init: any) => {
    state.hosts.add(new URL(url).host);
    const body = JSON.parse(init.body);
    const params: any[] = body.params || [];
    const result = params.map((p) => {
      const u: string = p.url || "";

      // Live monitor — must NEVER be reached for an offline gate.
      if (u === "/sys/proxy/json") {
        state.proxyCalled = true;
        return { status: { code: 0 }, data: [] };
      }

      // Device roster: one offline device (conn_status 0), no coords/metavars.
      if (u.endsWith(`/dvmdb/adom/root/device`)) {
        return {
          status: { code: 0 },
          data: [{
            name: DEVICE,
            hostname: DEVICE,
            sn: "FGT-OFFLINE-SN",
            platform_str: "FortiGate-60F",
            os_ver: 7, mr: 4, patch: 5,
            ip: "10.0.0.1",
            conn_status: 0,
          }],
        };
      }

      // Step 1: mgmt interface (global path) — resolves mgmt IP + MACs.
      if (u.endsWith(`/global/system/interface`)) {
        return { status: { code: 0 }, data: [{ name: "port1", ip: ["10.0.0.1", "255.255.255.0"], macaddr: "00:11:22:33:44:55" }] };
      }
      // Step 3: interfaces (vdom path) — interface IPs + VLAN backfill.
      if (u.endsWith(`/vdom/root/system/interface`)) {
        return { status: { code: 0 }, data: [{ name: "port2", ip: ["192.168.10.1", "255.255.255.0"], vlanid: 10 }] };
      }
      // Step 2: DHCP server config — one subnet + one static reservation.
      if (u.endsWith(`/vdom/root/system/dhcp/server`)) {
        return {
          status: { code: 0 },
          data: [{
            id: 1,
            interface: "port2",
            netmask: "255.255.255.0",
            "ip-range": [{ "start-ip": "192.168.10.10" }],
            "reserved-address": [{ id: 1, ip: "192.168.10.50", mac: "aa:bb:cc:dd:ee:ff", description: "printer" }],
          }],
        };
      }
      // Step 3e: firewall VIP.
      if (u.endsWith(`/vdom/root/firewall/vip`)) {
        return {
          status: { code: 0 },
          data: [{ name: "vip1", extip: ["203.0.113.10"], mappedip: [{ range: "192.168.10.50" }], extintf: ["port1"], type: "static-nat" }],
        };
      }
      // Step 3c.5 / 3d.4: CMDB switch + AP rosters (decommission protection).
      if (u.endsWith(`/global/switch-controller/managed-switch`)) {
        return { status: { code: 0 }, data: [{ "switch-id": "S1234", name: "sw1" }] };
      }
      if (u.endsWith(`/vdom/root/wireless-controller/wtp`)) {
        return { status: { code: 0 }, data: [{ "wtp-id": "AP5678", name: "ap1" }] };
      }
      // Step 3d.6 geo (system/global) + metavar variables + anything else:
      // empty, best-effort.
      return { status: { code: 0 }, data: {} };
    });
    return { status: 200, ok: true, json: async () => ({ id: body.id, result }) };
  });
  return { fetchMock, state };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FMG offline-gate CMDB pull", () => {
  it("pulls CMDB IP data from an offline gate and skips all live-monitor queries (proxy mode)", async () => {
    const { fetchMock, state } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const config: FortiManagerConfig = {
      host: "fmg.test",
      port: 443,
      apiUser: "polaris",
      apiToken: "tok",
      verifySsl: true,
      mgmtInterface: "port1",
    };

    const result = await discoverDhcpSubnets(config);

    // 1. CMDB config-derived IP data is present.
    expect(result.subnets.map((s) => s.cidr)).toContain("192.168.10.0/24");
    expect(result.vips.map((v) => v.name)).toContain("vip1");
    const reservation = result.dhcpEntries.find((e) => e.ipAddress === "192.168.10.50");
    expect(reservation).toBeDefined();
    expect(reservation?.type).toBe("dhcp-reservation");
    expect(reservation?.seenLeased).toBeFalsy(); // config-only, not live-leased
    expect(result.interfaceIps.some((i) => i.ipAddress === "192.168.10.1")).toBe(true);

    // 2. No live-monitor data, and /sys/proxy/json was never called.
    expect(state.proxyCalled).toBe(false);
    expect(result.deviceInventory).toHaveLength(0);
    expect(result.dhcpEntries.every((e) => e.type !== "dhcp-lease")).toBe(true);
    expect(result.fortiSwitches).toHaveLength(0);
    expect(result.fortiAps).toHaveLength(0);
    expect(result.switchMacTable).toHaveLength(0);
    expect(result.arpTable).toHaveLength(0);

    // 3. CMDB switch/AP rosters preserved (decommission protection). Each
    //    entry carries the source gate so the sync can scope the protection
    //    per-controller — an offline gate's cached roster must only shield
    //    devices whose recorded controller IS that gate.
    expect(result.cmdbSwitchSerials).toContainEqual({ device: DEVICE, serial: "S1234" });
    expect(result.cmdbApSerials).toContainEqual({ device: DEVICE, serial: "AP5678" });

    // 4. The offline device drives NO decommission sweep — excluded from every
    //    "inventoried"/"queried" set even though CMDB VIP/DHCP reads succeeded.
    expect(result.inventoryDevices).not.toContain(DEVICE);
    expect(result.switchInventoriedDevices).not.toContain(DEVICE);
    expect(result.apInventoriedDevices).not.toContain(DEVICE);
    expect(result.vipInventoriedDevices).not.toContain(DEVICE);
    expect(result.dhcpReservationsInventoriedDevices).not.toContain(DEVICE);
    expect(result.dhcpLeasesInventoriedDevices).not.toContain(DEVICE);

    // 5. Device emitted with offline=true + present in the known-devices roster.
    expect(result.devices).toHaveLength(1);
    expect((result.devices[0] as { offline?: boolean }).offline).toBe(true);
    expect(result.knownDeviceNames).toContain(DEVICE);
  });

  it("falls back to FMG-native CMDB for an offline gate even in direct mode (never touches the device directly)", async () => {
    const { fetchMock, state } = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const config: FortiManagerConfig = {
      host: "fmg.test",
      port: 443,
      apiUser: "polaris",
      apiToken: "tok",
      verifySsl: true,
      mgmtInterface: "port1",
      useProxy: false,               // direct mode
      fortigateApiToken: "fgt-tok",
    };

    const result = await discoverDhcpSubnets(config);

    // Same CMDB data as proxy mode — proves the !useProxy && !offline fallthrough.
    expect(result.subnets.map((s) => s.cidr)).toContain("192.168.10.0/24");
    expect(result.vips.map((v) => v.name)).toContain("vip1");
    expect((result.devices[0] as { offline?: boolean }).offline).toBe(true);

    // Direct mode would hit the FortiGate's mgmt IP for an ONLINE gate; an
    // offline gate must only ever be read via FMG (config.host).
    expect([...state.hosts]).toEqual(["fmg.test"]);
    expect(state.proxyCalled).toBe(false);
  });
});
