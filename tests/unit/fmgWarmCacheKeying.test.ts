import { describe, it, expect } from "vitest";
import { buildWarmCacheKeyMap } from "../../src/services/discovery/discoveryEngine.js";

// The FMG direct-mode warm cache maps a FortiGate's name TO the address
// discovery dials. Its consumer looks entries up by FortiManager's device name
// (`fmgNameKey(deviceName)`), so the map must be keyed the same way.
//
// It was keyed on `Asset.hostname` — the gate's own `system global hostname` —
// which is under no obligation to match. Every divergent gate's entry was filed
// under a key nothing asked for, so the lookup missed and discovery fell through
// to `resolveDeviceMgmtIp`. That reads only the one interface named by the
// integration's `mgmtInterface` setting and rejects `0.0.0.0`, which is the
// normal state of a dedicated management interface on an HA cluster. Both
// lookups missing means the gate is dropped from the run entirely, keeping its
// firmware and subnets frozen while monitoring reports it healthy — prod
// 2026-09, an 1801F HA pair stuck on old firmware.

const IP_A = "10.1.1.1";
const IP_B = "10.2.2.2";

describe("buildWarmCacheKeyMap", () => {
  it("keys on the FMG device name when it differs from the hostname", () => {
    const map = buildWarmCacheKeyMap([
      { hostname: "site-fw-a", ipAddress: IP_A, fortinetTopology: { deviceName: "JEFFERSON-1801F-CLUSTER" } },
    ]);
    expect(map.get("JEFFERSON-1801F-CLUSTER")).toBe(IP_A);
  });

  it("still offers the hostname as an alias, so either spelling resolves", () => {
    const map = buildWarmCacheKeyMap([
      { hostname: "site-fw-a", ipAddress: IP_A, fortinetTopology: { deviceName: "JEFFERSON-1801F-CLUSTER" } },
    ]);
    expect(map.get("site-fw-a")).toBe(IP_A);
  });

  it("falls back to the hostname alone for a firewall with no deviceName stamp", () => {
    // A gate discovered before the stamp existed, or created by hand. This is
    // the pre-fix behavior and must keep working — the stamp only appears once
    // its integration next runs discovery.
    const map = buildWarmCacheKeyMap([{ hostname: "legacy-fw", ipAddress: IP_A }]);
    expect(map.get("legacy-fw")).toBe(IP_A);
    expect(map.size).toBe(1);
  });

  it("gives a device name precedence over another gate's hostname alias", () => {
    // Gate B's FMG device name collides with gate A's hostname. Every device
    // name is claimed before any alias is offered, so B keeps its own address
    // and A is still reachable under its own device name.
    const map = buildWarmCacheKeyMap([
      { hostname: "SHARED-NAME", ipAddress: IP_A, fortinetTopology: { deviceName: "GATE-A" } },
      { hostname: "gate-b-host", ipAddress: IP_B, fortinetTopology: { deviceName: "SHARED-NAME" } },
    ]);
    expect(map.get("SHARED-NAME")).toBe(IP_B);
    expect(map.get("GATE-A")).toBe(IP_A);
  });

  it("dedupes case-insensitively, matching the consumer's lowercased lookup", () => {
    // fmgNameKey lowercases, so two entries differing only in case would be one
    // key downstream — the second must not silently displace the first.
    const map = buildWarmCacheKeyMap([
      { hostname: "Site-FW", ipAddress: IP_A, fortinetTopology: { deviceName: "SITE-FW" } },
      { hostname: "site-fw", ipAddress: IP_B, fortinetTopology: { deviceName: "site-fw" } },
    ]);
    expect(map.size).toBe(1);
    expect([...map.values()]).toEqual([IP_A]);
  });

  it("emits one key when the device name and hostname agree", () => {
    const map = buildWarmCacheKeyMap([
      { hostname: "SITE-FW", ipAddress: IP_A, fortinetTopology: { deviceName: "SITE-FW" } },
    ]);
    expect(map.size).toBe(1);
  });

  it("skips rows with no address — an HA standby holds no cluster IP", () => {
    const map = buildWarmCacheKeyMap([
      { hostname: "site-fw-b", ipAddress: null, fortinetTopology: { deviceName: "SITE-FW-B" } },
    ]);
    expect(map.size).toBe(0);
  });

  it("ignores a malformed or absent topology rather than throwing", () => {
    const map = buildWarmCacheKeyMap([
      { hostname: "fw-1", ipAddress: IP_A, fortinetTopology: null },
      { hostname: "fw-2", ipAddress: IP_B, fortinetTopology: { deviceName: 42 } },
    ]);
    expect(map.get("fw-1")).toBe(IP_A);
    expect(map.get("fw-2")).toBe(IP_B);
  });

  it("orders keys naturally by hostname so live logs dispatch predictably", () => {
    const map = buildWarmCacheKeyMap([
      { hostname: "FW-10", ipAddress: IP_A },
      { hostname: "FW-2", ipAddress: IP_B },
    ]);
    expect([...map.keys()]).toEqual(["FW-2", "FW-10"]);
  });
});
