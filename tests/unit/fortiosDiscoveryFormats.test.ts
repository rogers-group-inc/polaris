/**
 * tests/unit/fortiosDiscoveryFormats.test.ts
 *
 * Standalone FortiGate discovery sends `format=` on its CMDB reads (interface,
 * system/global, DHCP servers, VIPs, managed switches, wtp). FortiOS answers a
 * `format=` read with only the listed attributes — and an attribute missing
 * from the list is not an error, it is just absent. So the contract is pinned
 * end to end: discovery against a stub gate that HONOURS `format=` must return
 * exactly what it returns against one that ignores it and sends whole rows.
 * The rows are padded with attributes nothing reads, as a real gate's are
 * (~100-230 per row), and carry every nested table discovery reads.
 *
 * When a reader starts using a new attribute: add it to the format list AND
 * to a fixture row here; this test then proves the list carries it. It also
 * pins that `system/global` is read once (Chain E's duplicate was removed).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverDhcpSubnets } from "../../src/services/fortigateService.js";
import { _resetFortiosGateState } from "../../src/utils/fortiosRequestGate.js";

vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
  insecureTlsDispatcher: () => ({}),
}));

const config = { host: "10.0.0.1", port: 443, apiUser: "polaris", apiToken: "tok", verifySsl: false, mgmtInterface: "mgmt" };
const NOISE = { "q_origin_key": "k", comment: "noise", uuid: "0f0f", "dns-service": "default", vdom: "root", "auto-config": "enable",
  "lease-time": 604800, "ntp-service": "local", "wifi-ac-service": "specify", timezone: "00", "options": [] };

const CMDB: Record<string, unknown[] | Record<string, unknown>> = {
  "/api/v2/cmdb/system/interface": [
    { ...NOISE, name: "mgmt", ip: "10.0.0.1 255.255.255.0", macaddr: "04:d5:90:00:00:01", type: "physical", status: "up", mode: "static", allowaccess: "ping https ssh" },
    { ...NOISE, name: "lan", ip: "192.168.10.1 255.255.255.0", macaddr: "04:d5:90:00:00:02", type: "physical", status: "up", mode: "static",
      "secondary-IP": "enable", secondaryip: [{ id: 1, q_origin_key: 1, ip: "192.168.250.1 255.255.255.0", allowaccess: "" }],
      ipv6: { "ip6-mode": "static", "ip6-address": "::/0", "ip6-extra-addr": [], "ip6-prefix-list": [], "ip6-send-adv": "disable" } },
    { ...NOISE, name: "users", ip: "10.30.0.1 255.255.255.0", macaddr: "04:d5:90:00:00:03", type: "vlan", interface: "fortilink", vlanid: 30, status: "up", mode: "static" },
  ],
  "/api/v2/cmdb/system/global": { ...NOISE, hostname: "GATE", "gui-device-latitude": "36.1627", "gui-device-longitude": "-86.7816", "admin-sport": 443 },
  "/api/v2/cmdb/system.dhcp/server": [
    { ...NOISE, id: 1, interface: "lan", netmask: "255.255.255.0", "default-gateway": "192.168.10.1", status: "enable",
      "ip-range": [{ id: 1, "start-ip": "192.168.10.100", "end-ip": "192.168.10.200", "vci-match": "disable" }],
      "reserved-address": [{ id: 7, ip: "192.168.10.50", mac: "aa:bb:cc:dd:ee:01", description: "printer", action: "reserved", type: "mac" }] },
    { ...NOISE, id: 2, interface: "users", netmask: "255.255.255.0", status: "enable",
      "ip-range": [{ id: 1, "start-ip": "10.30.0.100", "end-ip": "10.30.0.250" }], "reserved-address": [] },
  ],
  "/api/v2/cmdb/firewall/vip": [
    { ...NOISE, name: "web-nat", type: "static-nat", extip: "203.0.113.10", extintf: "wan1", "arp-reply": "enable", portforward: "disable",
      mappedip: [{ range: "192.168.10.20", q_origin_key: "192.168.10.20" }] },
    { ...NOISE, name: "web-slb", type: "server-load-balance", extip: "203.0.113.11", extintf: "wan1", "ldb-method": "round-robin",
      mappedip: [], realservers: [{ id: 1, ip: "192.168.10.21", port: 80, status: "active" }, { id: 2, ip: "192.168.10.22", port: 80, status: "active" }] },
  ],
  "/api/v2/cmdb/switch-controller/managed-switch": [
    { ...NOISE, "switch-id": "S248EFTF00000001", sn: "S248EFTF00000001", name: "idf-1", description: "b:HQ f:2", "fsw-wan1-peer": "fortilink",
      ports: [
        { "port-name": "port1", "fortilink-port": 0, "fgt-peer-device-name": "", speed: "auto", vlan: "default", "poe-status": "enable" },
        { "port-name": "port47", "fortilink-port": 1, "fgt-peer-device-name": "GATE", speed: "auto", vlan: "default" },
      ] },
  ],
  "/api/v2/cmdb/wireless-controller/wtp": [
    { ...NOISE, "wtp-id": "FP231FTF00000001", name: "ap-1", location: "b:HQ f:1", "wtp-profile": "FAP231F-default", admin: "enable" },
  ],
  // The two tables read only for the management-access summary.
  "/api/v2/cmdb/wireless-controller/wtp-profile": [
    { ...NOISE, name: "FAP231F-default", allowaccess: "https snmp", "login-passwd-change": "no", "ap-country": "US" },
  ],
  "/api/v2/cmdb/switch-controller.security-policy/local-access": [
    { ...NOISE, name: "default", "mgmt-allowaccess": "https ping ssh", "internal-allowaccess": "https ping" },
  ],
};

const MONITOR: Record<string, unknown> = {
  "/api/v2/monitor/switch-controller/managed-switch/status": [
    { serial: "S248EFTF00000001", "switch-id": "S248EFTF00000001", connecting_from: "10.255.1.2", fgt_peer_intf_name: "fortilink", os_version: "S248EF-v7.6.4", state: "Authorized", status: "Connected", join_time: 1700000000 },
  ],
  "/api/v2/monitor/wifi/managed_ap": [
    { name: "ap-1", serial: "FP231FTF00000001", wtp_id: "FP231FTF00000001", status: "connected", state: "authorized", connecting_from: "10.30.0.9", os_version: "FP231F-v7.4.5", board_mac: "04:d5:90:aa:00:01" },
  ],
};

/** Stub a gate. `honourFormat` decides whether a CMDB read's `format=` trims its rows. */
function stubGate(honourFormat: boolean): Map<string, number> {
  const calls = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const u = new URL(String(input));
    calls.set(u.pathname, (calls.get(u.pathname) ?? 0) + 1);
    const ok = (body: unknown) => ({ status: 200, ok: true, json: async () => body });
    if (u.pathname === "/api/v2/monitor/system/status") {
      return ok({ serial: "FGT61FTK00000001", version: "v7.6.8", results: { hostname: "GATE", model_name: "FortiGate", model_number: "61F" } });
    }
    const cmdb = CMDB[u.pathname];
    if (cmdb) {
      const fmt = u.searchParams.get("format");
      const keep = honourFormat && fmt ? fmt.split("|") : null;
      const trim = (row: Record<string, unknown>) => (keep ? Object.fromEntries(Object.entries(row).filter(([k]) => keep.includes(k) || k === "q_origin_key")) : row);
      const results = Array.isArray(cmdb) ? (cmdb as Record<string, unknown>[]).map(trim) : trim(cmdb as Record<string, unknown>);
      return ok({ results });
    }
    if (u.pathname in MONITOR) return ok({ results: MONITOR[u.pathname] });
    return ok({ results: [] });
  }));
  return calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  _resetFortiosGateState();
  vi.restoreAllMocks();
});

describe("standalone discovery's format= lists carry everything discovery reads", () => {
  it("returns the same DiscoveryResult whether or not the gate honours format=", async () => {
    // Pin the clock: the management-access summaries carry a checkedAt.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    stubGate(false);
    const whole = await discoverDhcpSubnets(config as any);
    _resetFortiosGateState();
    const calls = stubGate(true);
    const trimmed = await discoverDhcpSubnets(config as any);

    expect(trimmed).toEqual(whole);

    // …and the fixtures actually exercised each read, so the equality is not of empties.
    expect(whole.subnets.map((s) => s.cidr).sort()).toEqual(["10.30.0.0/24", "192.168.10.0/24"]);
    expect(whole.dhcpEntries.find((e) => e.type === "dhcp-reservation")).toMatchObject({ ipAddress: "192.168.10.50", hostname: "printer", scopeId: 1, entryId: 7 });
    expect(whole.vips.find((v) => v.name === "web-nat")?.mappedips).toEqual(["192.168.10.20"]);
    expect(whole.vips.find((v) => v.name === "web-slb")).toMatchObject({ isVirtualServer: true, realservers: ["192.168.10.21", "192.168.10.22"] });
    expect(whole.fortiSwitches[0]).toMatchObject({ uplinkPhysicalPort: "port47", description: "b:HQ f:2" });
    expect(whole.devices[0]).toMatchObject({ latitude: 36.1627, longitude: -86.7816 });
    expect(whole.interfaceIps).toEqual(expect.arrayContaining([expect.objectContaining({ ipAddress: "192.168.250.1", role: "secondary" })]));

    // Management access rode the existing interface + wtp reads (allowaccess,
    // wtp-profile) plus one read each of the profile and local-access tables.
    const access = Object.fromEntries((whole.managementAccess ?? []).map((m) => [m.serial, m.summary.protocols]));
    expect(access).toEqual({
      FGT61FTK00000001: ["ping", "https", "ssh"],
      FP231FTF00000001: ["https", "snmp"],
      S248EFTF00000001: ["https", "ping"],
    });
    expect(calls.get("/api/v2/cmdb/system/interface")).toBe(1);
    expect(calls.get("/api/v2/cmdb/wireless-controller/wtp")).toBe(1);
    expect(calls.get("/api/v2/cmdb/wireless-controller/wtp-profile")).toBe(1);
    expect(calls.get("/api/v2/cmdb/switch-controller.security-policy/local-access")).toBe(1);

    // system/global is read once per run (Step 2 only).
    expect(calls.get("/api/v2/cmdb/system/global")).toBe(1);
  });

  it("FortiManager's proxied managed-switch read uses the same list (parity)", () => {
    const src = readFileSync(join(process.cwd(), "src", "services", "fortimanagerService.ts"), "utf-8");
    expect(src).toContain("resource: `/api/v2/cmdb/switch-controller/managed-switch?format=${FORTISWITCH_DISCOVERY_CMDB_FORMAT}`");
  });
});
