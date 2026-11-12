/**
 * tests/unit/fortiosCollectors.test.ts — own suite for
 * services/monitoring/fortiosCollectors.ts (CQ-T010).
 *
 * Complements, does not repeat:
 *   - fortiInterfaceParse.test.ts / fortiosInterfaceCmdbFormat.test.ts — the
 *     interface parse/merge cores and collectSystemInfoFortinet's fan-out
 *   - fortilinkLldp.test.ts — fortilinkInterfaceNamesFromCmdb
 *   - sdwanParse.test.ts — the four SD-WAN parsers
 *   - defaultPollingProxyAware / probes — buildFortinetConfig's use from the
 *     probe path (mocked there)
 *
 * Unreached until now: buildFortinetConfig's token-source order (a stream's
 * restapi credential first, then the integration's token, with each refusal's
 * wording, and TLS verify off unless asked), collectTelemetryFortinet's
 * resource/usage decoding (flat, {current}, {historical}, the per-interval
 * array where the shortest interval wins, session count unclamped),
 * collectHardwareSensorsFortinet, collectLldpOnlyFortinet's defensive field
 * picking (and that a failed LLDP read is "not read", undefined, never []),
 * fetchFortilinkInterfaceSet degrading to "collect everything",
 * collectIpsecFortinet's optional CMDB and SSL-VPN reads,
 * collectSdwanFortinet's independent sub-reads (rules undefined when the CMDB
 * read fails, reachable false only when both fail), and
 * applyFortiInterfaceFilter keeping children of a surviving parent.
 * fgRequest is a spy; nothing dials a gate.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fg = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("../../src/services/fortigateService.js", async (orig) => ({
  ...(await orig<object>()),
  fgRequest: fg.request,
}));

import {
  buildFortinetConfig,
  collectTelemetryFortinet,
  collectHardwareSensorsFortinet,
  collectLldpOnlyFortinet,
  fetchFortilinkInterfaceSet,
  collectIpsecFortinet,
  collectSdwanFortinet,
  applyFortiInterfaceFilter,
} from "../../src/services/monitoring/fortiosCollectors.js";
import type { FortiGateConfig } from "../../src/services/fortigateService.js";

const FGT = { type: "fortigate", config: { apiUser: "api", apiToken: "tok" } };
const CFG: FortiGateConfig = { host: "10.0.0.1", apiUser: "api", apiToken: "tok", verifySsl: false };

/** Route fgRequest by path; a value that is an Error rejects. */
function route(map: Record<string, unknown>) {
  fg.request.mockImplementation(async (_cfg: unknown, _m: string, path: string) => {
    const v = map[path];
    if (v instanceof Error) throw v;
    if (v === undefined) throw new Error(`unexpected ${path}`);
    return v;
  });
}

// A block body on purpose: mockReset() returns the spy, and a FUNCTION returned
// from beforeEach is run by Vitest as that test's cleanup hook.
beforeEach(() => {
  fg.request.mockReset();
});

// ─── buildFortinetConfig ────────────────────────────────────────────────────

describe("buildFortinetConfig", () => {
  it("a FortiGate integration's own token, TLS verification off unless explicitly on", () => {
    expect(buildFortinetConfig("10.0.0.1", FGT)).toEqual({ host: "10.0.0.1", apiUser: "api", apiToken: "tok", verifySsl: false });
    expect(buildFortinetConfig("h", { type: "fortigate", config: { apiToken: "t", verifySsl: true } })).toMatchObject({ verifySsl: true });
    expect(buildFortinetConfig("h", { type: "fortigate", config: { apiToken: "t", verifySsl: "yes" } })).toMatchObject({ verifySsl: false });
  });

  it("a FortiManager supplies its separate FortiGate token", () => {
    expect(buildFortinetConfig("h", { type: "fortimanager", config: { apiToken: "fmg", fortigateApiUser: "u", fortigateApiToken: "fgt" } }))
      .toMatchObject({ apiUser: "u", apiToken: "fgt" });
  });

  it("refuses with the reason when no token exists anywhere", () => {
    expect(buildFortinetConfig("h", { type: "fortimanager", config: { apiToken: "fmg-only" } }))
      .toEqual({ error: expect.stringContaining("this FortiManager integration has none configured") });
    expect(buildFortinetConfig("h", { type: "fortigate", config: {} }))
      .toEqual({ error: expect.stringContaining("this integration has none configured") });
  });

  it("a stream's restapi credential wins, at the ASSET's host, port only from its baseUrl", () => {
    const cred = { type: "restapi", config: { apiToken: "per-gate", apiUser: "g", baseUrl: "https://elsewhere:8443", verifyTls: true } };
    expect(buildFortinetConfig("10.0.0.9", FGT, cred as never)).toEqual({
      host: "10.0.0.9", apiUser: "g", apiToken: "per-gate", verifySsl: true, port: 8443,
    });
  });

  it("a credential of another type is ignored; a restapi one without a token is refused", () => {
    expect(buildFortinetConfig("h", FGT, { type: "snmp", config: {} } as never)).toMatchObject({ apiToken: "tok" });
    expect(buildFortinetConfig("h", FGT, { type: "restapi", config: {} } as never)).toEqual({ error: "REST API credential is missing its API token" });
  });
});

// ─── telemetry ──────────────────────────────────────────────────────────────

describe("collectTelemetryFortinet", () => {
  it("throws a 409 rather than dialing without a token", async () => {
    await expect(collectTelemetryFortinet("h", { type: "fortigate", config: {} })).rejects.toMatchObject({ httpStatus: 409 });
    expect(fg.request).not.toHaveBeenCalled();
  });

  it("reads resource/usage at global scope with the caller's timeout", async () => {
    route({ "/api/v2/monitor/system/resource/usage": { cpu: 12, mem: 34, session: 5000 } });
    const t = await collectTelemetryFortinet("10.0.0.1", FGT, 4321);
    expect(t).toEqual({ cpuPct: 12, memPct: 34, memUsedBytes: null, memTotalBytes: null, sessionCount: 5000 });
    expect(fg.request).toHaveBeenCalledWith(expect.objectContaining({ host: "10.0.0.1" }), "GET", "/api/v2/monitor/system/resource/usage", { query: { scope: "global" }, timeoutMs: 4321 });
  });

  it("decodes every resource shape FortiOS has used", async () => {
    route({ "/api/v2/monitor/system/resource/usage": {
      cpu: [
        { interval: "1-hour", current: 90 },
        { interval: "1-min", historical: [1, 2, 7] },
        { interval: "10-min", current: 50 },
      ],
      memory: { historical: [20, 25] },
      session: { current: 250_000 },
    } });
    const t = await collectTelemetryFortinet("h", FGT);
    expect(t.cpuPct).toBe(7);           // the 1-min entry, its freshest historical point
    expect(t.memPct).toBe(25);          // `memory` fallback key, last historical
    expect(t.sessionCount).toBe(250_000); // an absolute count is never clamped to 100
  });

  it("clamps percentages and reads a missing resource as null", async () => {
    route({ "/api/v2/monitor/system/resource/usage": { cpu: { current: 140 }, mem: "n/a" } });
    const t = await collectTelemetryFortinet("h", FGT);
    expect(t.cpuPct).toBe(100);
    expect(t.memPct).toBeNull();
    expect(t.sessionCount).toBeNull();
  });
});

describe("collectHardwareSensorsFortinet", () => {
  it("keeps every named sensor, classified, with its alarm flag", async () => {
    route({ "/api/v2/monitor/system/sensor-info": { results: [
      { name: "CPU ON-DIE Temp", type: "temperature", value: 51.23456, alarm: false },
      { name: "FAN1", type: "fan", value: "4200", alarm: 1 },
      { name: "", value: 1 },
      { name: "PSU", value: "garbage" },
      null,
    ] } });
    const s = await collectHardwareSensorsFortinet(CFG, 100);
    expect(s).toEqual([
      expect.objectContaining({ sensorName: "CPU ON-DIE Temp", sensorClass: "temperature", value: 51.235, alarmStatus: "ok" }),
      expect.objectContaining({ sensorName: "FAN1", value: 4200, alarmStatus: "alarm" }),
      expect.objectContaining({ sensorName: "PSU", value: null, alarmStatus: null }),
    ]);
  });

  it("accepts a bare array answer and an empty one", async () => {
    route({ "/api/v2/monitor/system/sensor-info": [{ name: "T", value: 1 }] });
    expect(await collectHardwareSensorsFortinet(CFG)).toHaveLength(1);
    route({ "/api/v2/monitor/system/sensor-info": {} });
    expect(await collectHardwareSensorsFortinet(CFG)).toEqual([]);
  });
});

// ─── LLDP ───────────────────────────────────────────────────────────────────

describe("collectLldpOnlyFortinet", () => {
  it("refuses without a token", async () => {
    await expect(collectLldpOnlyFortinet("h", { type: "fortigate", config: {} })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("picks each field from whichever name this firmware used", async () => {
    route({ "/api/v2/monitor/system/interface/lldp-neighbors": { results: [
      { local_intf: "port1", chassis_id: "00:09:0f:aa:bb:cc", port_id: "port49", port_desc: " uplink ", sys_name: "sw1",
        management_addresses: [{ address: "10.0.0.2" }], enabled_capabilities: "Bridge, Router" },
      { interface: "port2", management_address: "10.0.0.3,10.0.0.4", system_capabilities: ["WLAN"] },
      { chassis_id: "no-local-port" },
    ] } });
    const n = await collectLldpOnlyFortinet("10.0.0.1", FGT);
    expect(n).toEqual([
      {
        localIfName: "port1", chassisIdSubtype: null, chassisId: "00:09:0f:aa:bb:cc", portIdSubtype: null, portId: "port49",
        portDescription: "uplink", systemName: "sw1", systemDescription: null, managementIp: "10.0.0.2", capabilities: ["bridge", "router"],
      },
      expect.objectContaining({ localIfName: "port2", managementIp: "10.0.0.3", capabilities: ["wlan"] }),
    ]);
    expect(fg.request.mock.calls[0][3]).toMatchObject({ query: { vdom: "root" } });
  });

  it("a failed read is 'not read' (undefined), so stored neighbours survive", async () => {
    route({ "/api/v2/monitor/system/interface/lldp-neighbors": new Error("404") });
    expect(await collectLldpOnlyFortinet("h", FGT)).toBeUndefined();
  });
});

describe("fetchFortilinkInterfaceSet", () => {
  it("returns the FortiLink aggregates and their members", async () => {
    route({ "/api/v2/cmdb/system/interface": { results: [
      { name: "fortilink", fortilink: "enable", member: [{ "interface-name": "a" }, "b"] },
      { name: "port1", fortilink: "disable" },
    ] } });
    expect([...await fetchFortilinkInterfaceSet(CFG)].sort()).toEqual(["a", "b", "fortilink"]);
  });

  it("a token without CMDB scope degrades to an empty set — collect all LLDP, drop nothing", async () => {
    route({ "/api/v2/cmdb/system/interface": new Error("403") });
    expect((await fetchFortilinkInterfaceSet(CFG)).size).toBe(0);
  });
});

// ─── IPsec ──────────────────────────────────────────────────────────────────

describe("collectIpsecFortinet", () => {
  it("a monitor failure rejects — no data, never 'every tunnel down'", async () => {
    route({
      "/api/v2/cmdb/vpn.ipsec/phase1-interface": { results: [] },
      "/api/v2/monitor/vpn/ipsec": new Error("timeout"),
    });
    await expect(collectIpsecFortinet(CFG)).rejects.toThrow("timeout");
  });

  it("the CMDB read is optional, and SSL-VPN is asked only when wanted", async () => {
    route({
      "/api/v2/cmdb/vpn.ipsec/phase1-interface": new Error("403"),
      "/api/v2/monitor/vpn/ipsec": { results: [] },
    });
    const r = await collectIpsecFortinet(CFG);
    expect(r.tunnels).toEqual([]);
    expect(r.sslVpnSessions).toBeUndefined();
    expect(fg.request.mock.calls.map((c) => c[2])).not.toContain("/api/v2/monitor/vpn/ssl");
  });

  it("an unanswered SSL-VPN read stays undefined so stored sessions are kept", async () => {
    route({
      "/api/v2/cmdb/vpn.ipsec/phase1-interface": { results: [] },
      "/api/v2/monitor/vpn/ipsec": { results: [] },
      "/api/v2/monitor/vpn/ssl": new Error("403"),
    });
    expect((await collectIpsecFortinet(CFG, 10, { includeSslVpn: true })).sslVpnSessions).toBeUndefined();
  });

  it("an answered SSL-VPN read is parsed (an empty list wipes)", async () => {
    route({
      "/api/v2/cmdb/vpn.ipsec/phase1-interface": { results: [] },
      "/api/v2/monitor/vpn/ipsec": { results: [] },
      "/api/v2/monitor/vpn/ssl": { results: [] },
    });
    expect((await collectIpsecFortinet(CFG, 10, { includeSslVpn: true })).sslVpnSessions).toEqual([]);
  });
});

// ─── SD-WAN ─────────────────────────────────────────────────────────────────

describe("collectSdwanFortinet", () => {
  it("both reads failing is unreachable, with nothing to write", async () => {
    route({
      "/api/v2/monitor/virtual-wan/health-check": new Error("x"),
      "/api/v2/cmdb/system/sdwan": new Error("x"),
    });
    expect(await collectSdwanFortinet(CFG)).toEqual({ perfSla: [], sdwanRules: undefined, reachable: false });
  });

  it("a failed CMDB read leaves the rules NOT READ (undefined), never an empty replace", async () => {
    route({
      "/api/v2/monitor/virtual-wan/health-check": { results: {} },
      "/api/v2/cmdb/system/sdwan": new Error("timeout"),
    });
    const r = await collectSdwanFortinet(CFG);
    expect(r.reachable).toBe(true);
    expect(r.sdwanRules).toBeUndefined();
  });

  it("an answered CMDB read yields a rules list even when health checks fail", async () => {
    route({
      "/api/v2/monitor/virtual-wan/health-check": new Error("404"),
      "/api/v2/cmdb/system/sdwan": { results: { members: [], service: [] } },
    });
    const r = await collectSdwanFortinet(CFG);
    expect(r).toMatchObject({ perfSla: [], sdwanRules: [], reachable: true });
  });
});

// ─── interface filter ───────────────────────────────────────────────────────

describe("applyFortiInterfaceFilter", () => {
  const ifs = (...names: Array<[string, string?]>) => names.map(([ifName, ifParent]) => ({ ifName, ifParent: ifParent ?? null }) as never);
  const names = (list: Array<{ ifName: string }>) => list.map((i) => i.ifName);

  it("does nothing without patterns or integration", () => {
    const list = ifs(["port1"], ["port2"]);
    applyFortiInterfaceFilter(list, null);
    applyFortiInterfaceFilter(list, { config: { interfaceInclude: [], interfaceExclude: [] } });
    expect(names(list)).toEqual(["port1", "port2"]);
  });

  it("include wins over exclude, and children of a kept parent survive", () => {
    const list = ifs(["wan1"], ["wan1.100", "wan1"], ["port5"], ["port5.20", "port5"]);
    applyFortiInterfaceFilter(list, { config: { interfaceInclude: ["wan*"], interfaceExclude: ["wan1"] } });
    expect(names(list)).toEqual(["wan1", "wan1.100"]);
  });

  it("exclude alone drops what matches; a child judged on its own name may stay", () => {
    const list = ifs(["port1"], ["ssl.root"], ["port1.10", "port1"], ["ha"]);
    applyFortiInterfaceFilter(list, { config: { interfaceExclude: ["ssl.*", "port1"] } });
    expect(names(list)).toEqual(["port1.10", "ha"]);
  });
});
