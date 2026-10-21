/**
 * Business rule 125 — the `observed` IPv6 reservations: which sightings
 * become rows, which rows a sighting refreshes, and what it never touches.
 * RFC 3849 addresses.
 */
import { describe, it, expect } from "vitest";
import {
  collectObservedIpv6Sightings,
  planObservedIpv6,
  OBSERVED_IPV6_TTL_MS,
  type ObservedIpv6Sighting,
} from "../../src/utils/observedIpv6.js";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const HOUR = 3600_000;

const inv = (over: Record<string, unknown> = {}) => ({
  device: "gate", macAddress: "aa:bb:cc:00:00:01", ipAddress: "192.0.2.10", hostname: "laptop",
  os: "", osVersion: "", hardwareVendor: "", interfaceName: "", switchName: "", switchPort: "", apName: "", user: "",
  isOnline: true, lastSeen: new Date(NOW).toISOString(), ipv6Address: "2001:db8:1::10", ...over,
}) as any;

describe("collectObservedIpv6Sightings", () => {
  it("takes inventory and detected-device rows, freshest sighting per address", () => {
    const s = collectObservedIpv6Sightings(
      [inv({ isOnline: false, lastSeen: new Date(NOW - 5 * HOUR).toISOString(), device: "old-gate" }), inv({ device: "new-gate", ipv6Address: "2001:db8:1::11" })],
      [
        { fortigateDevice: "new-gate", switchId: "sw", portName: "port1", mac: "AA:BB:CC:00:00:01", lastSeen: 7, ipv6Address: "2001:db8:1::10" },
        { fortigateDevice: "new-gate", switchId: "sw", portName: "port48", mac: "AA:BB:CC:00:00:99", lastSeen: 1, ipv6Address: "2001:db8:1::99", isFortilinkPeer: true },
      ],
      NOW,
    );
    const by = Object.fromEntries(s.map((x) => [x.ip, x]));
    expect(Object.keys(by).sort()).toEqual(["2001:db8:1::10", "2001:db8:1::11"]);
    // The switch saw ::10 seven seconds ago; the inventory row is five hours stale.
    expect(by["2001:db8:1::10"].source).toBe("detected-device");
    expect(by["2001:db8:1::10"].seenAtMs).toBe(NOW - 7000);
    expect(by["2001:db8:1::10"].mac).toBe("AA:BB:CC:00:00:01");
  });
  it("reads a detected-device last_seen that is an epoch as one", () => {
    const s = collectObservedIpv6Sightings([], [
      { fortigateDevice: "g", switchId: "sw", portName: "p", mac: "AA:BB:CC:00:00:02", lastSeen: (NOW - HOUR) / 1000, ipv6Address: "2001:db8:1::2" },
    ], NOW);
    expect(s[0].seenAtMs).toBe(NOW - HOUR);
  });
  it("ignores rows with no IPv6 address", () => {
    expect(collectObservedIpv6Sightings([inv({ ipv6Address: undefined })], [], NOW)).toEqual([]);
  });
});

describe("planObservedIpv6", () => {
  const sighting = (over: Partial<ObservedIpv6Sighting> = {}): ObservedIpv6Sighting => ({
    ip: "2001:db8:1::10", mac: "AA:BB:CC:00:00:01", hostname: "laptop", device: "gate", source: "device-inventory", seenAtMs: NOW, ...over,
  });
  const base = {
    findSubnetId: (ip: string) => (ip.startsWith("2001:db8:1:") ? "sub-1" : undefined),
    hostnameForMac: () => null,
    nowMs: NOW,
  };

  it("creates a row expiring a day after the sighting, named by the asset that owns the MAC", () => {
    const plan = planObservedIpv6({ ...base, sightings: [sighting({ seenAtMs: NOW - 2 * HOUR })], activeRow: () => undefined, hostnameForMac: () => "ASSET-01" });
    expect(plan.creates).toEqual([{
      subnetId: "sub-1", ip: "2001:db8:1::10", mac: "AA:BB:CC:00:00:01", hostname: "ASSET-01", device: "gate", source: "device-inventory",
      expiresAt: new Date(NOW - 2 * HOUR + OBSERVED_IPV6_TTL_MS),
    }]);
  });

  it("never touches a row another source holds", () => {
    const plan = planObservedIpv6({ ...base, sightings: [sighting()], activeRow: () => ({ id: "r1", sourceType: "manual", macAddress: null, hostname: "x" }) });
    expect(plan.creates).toEqual([]);
    expect(plan.refresh.ids).toEqual([]);
    expect(plan.patches).toEqual([]);
    expect(plan.heldByOtherSource).toBe(1);
  });

  it("refreshes only on a CURRENT sighting, and patches a changed MAC or hostname", () => {
    const row = { id: "r1", sourceType: "observed", macAddress: "AA:BB:CC:00:00:01", hostname: "laptop" };
    const current = planObservedIpv6({ ...base, sightings: [sighting({ hostname: "renamed" })], activeRow: () => row });
    expect(current.refresh).toEqual({ ids: ["r1"], expiresAt: new Date(NOW + OBSERVED_IPV6_TTL_MS) });
    expect(current.patches).toEqual([{ id: "r1", data: { hostname: "renamed" } }]);

    const stale = planObservedIpv6({ ...base, sightings: [sighting({ seenAtMs: NOW - 3 * HOUR })], activeRow: () => row });
    expect(stale.refresh.ids).toEqual([]);
  });

  it("drops a sighting older than the TTL and counts one outside every network", () => {
    const plan = planObservedIpv6({ ...base,
      sightings: [sighting({ seenAtMs: NOW - OBSERVED_IPV6_TTL_MS - 1 }), sighting({ ip: "2001:db8:9::1" })],
      activeRow: () => undefined,
    });
    expect(plan.creates).toEqual([]);
    expect(plan.skippedNoSubnet).toBe(1);
  });
});
