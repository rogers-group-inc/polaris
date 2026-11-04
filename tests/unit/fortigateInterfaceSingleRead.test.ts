/**
 * tests/unit/fortigateInterfaceSingleRead.test.ts
 *
 * Standalone FortiGate discovery reads the gate's interface table ONCE.
 *
 * Two steps of `discoverDhcpSubnets` need `/api/v2/cmdb/system/interface`:
 * Step 2 takes the management IP / MAC and every interface MAC off it, and
 * Chain A's Step 3b takes interface IPs, VLANs, secondaries and IPv6. They used
 * to make a call each with the same query; Step 3b now awaits Step 2's promise.
 * These cases pin that both consumers still get their data from one call, and
 * that a failed read still reaches Step 3b's "Failed to query interfaces" log.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { discoverDhcpSubnets } from "../../src/services/fortigateService.js";
import { _resetFortiosGateState } from "../../src/utils/fortiosRequestGate.js";

// Route the transport back to the global fetch (see fgRequestStatusMapping.test.ts).
vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
  insecureTlsDispatcher: () => ({}),
}));

const config = { host: "10.0.0.1", port: 443, apiUser: "polaris", apiToken: "tok", verifySsl: false, mgmtInterface: "mgmt" };

const INTERFACES = [
  { name: "mgmt", ip: "10.0.0.1 255.255.255.0", macaddr: "00:11:22:33:44:01", type: "physical" },
  { name: "port2", ip: "192.168.50.1 255.255.255.0", macaddr: "00:11:22:33:44:02", type: "physical" },
];

/** Stub fetch by path; returns the per-path call counter. */
function stubGate(interfaceStatus = 200): Map<string, number> {
  const calls = new Map<string, number>();
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const path = new URL(String(input)).pathname;
    calls.set(path, (calls.get(path) ?? 0) + 1);
    let status = 200;
    let body: unknown = { results: [] };
    if (path === "/api/v2/monitor/system/status") {
      body = { serial: "FGT60FTK00000001", version: "v7.6.8", results: { hostname: "gate-1", model_name: "FortiGate", model_number: "60F" } };
    } else if (path === "/api/v2/cmdb/system/interface") {
      status = interfaceStatus;
      body = interfaceStatus === 200 ? { results: INTERFACES } : {};
    }
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  _resetFortiosGateState();
  vi.restoreAllMocks();
});

describe("discoverDhcpSubnets — one interface-table read", () => {
  it("feeds both the firewall identity and the interface IPs from a single call", async () => {
    const calls = stubGate();
    const result = await discoverDhcpSubnets(config as any);

    expect(calls.get("/api/v2/cmdb/system/interface")).toBe(1);

    // Step 2's consumers: management IP and every interface MAC.
    const gate = result.devices[0] as any;
    expect(gate.interfaceMacs).toEqual(expect.arrayContaining(["00:11:22:33:44:01", "00:11:22:33:44:02"]));
    expect(result.interfaceIps).toEqual(expect.arrayContaining([
      expect.objectContaining({ interfaceName: "mgmt", ipAddress: "10.0.0.1", role: "management" }),
    ]));
    // Step 3b's consumer: the non-management interface's address.
    expect(result.interfaceIps).toEqual(expect.arrayContaining([
      expect.objectContaining({ interfaceName: "port2", ipAddress: "192.168.50.1", role: "interface" }),
    ]));
  });

  it("a failed read is still made once and still logged by Step 3b", async () => {
    const calls = stubGate(500);
    const log = vi.fn();
    await discoverDhcpSubnets(config as any, undefined, log);

    expect(calls.get("/api/v2/cmdb/system/interface")).toBe(1);
    expect(log).toHaveBeenCalledWith("discover.interfaces", "error", expect.stringMatching(/Failed to query interfaces/), "gate-1");
  });
});
