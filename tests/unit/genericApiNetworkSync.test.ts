/**
 * tests/unit/genericApiNetworkSync.test.ts — the pure parts of the Generic
 * API network sync (business rule 100(j)). The IPAM writes themselves are
 * pinned against a real database in tests/integration/genericApiNetworkSync.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  GENERIC_API_FEED_SOURCE_TYPES,
  dedupeFeedAddresses,
  defaultLeaseExpiry,
  pickSubnetForIp,
} from "../../src/services/discovery/genericApiNetworkSync.js";

const addr = (ip: string, over: Record<string, unknown> = {}) => ({
  ipAddress: ip, macAddress: null, hostname: null, expiresAt: null, owner: null, notes: null, ...over,
});

describe("defaultLeaseExpiry", () => {
  const now = new Date("2026-10-11T00:00:00Z");
  it("outlives the gap to the next run: at least a day, else twice the discovery interval", () => {
    expect(defaultLeaseExpiry(now, 4).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(defaultLeaseExpiry(now, 24).toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(defaultLeaseExpiry(now, null).toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });
});

describe("pickSubnetForIp", () => {
  const subnets = [
    { id: "a", cidr: "10.0.0.0/16", status: "available" },
    { id: "b", cidr: "10.0.5.0/24", status: "available" },
    { id: "c", cidr: "10.0.6.0/24", status: "deprecated" },
  ];
  it("picks the MOST specific live subnet, never a deprecated one", () => {
    expect(pickSubnetForIp(subnets, "10.0.5.9")?.id).toBe("b");
    expect(pickSubnetForIp(subnets, "10.0.6.9")?.id).toBe("a");
    expect(pickSubnetForIp(subnets, "192.168.0.1")).toBeNull();
  });
});

describe("dedupeFeedAddresses", () => {
  it("one row per address, the more deliberate kind winning: reservation > assignment > lease", () => {
    const out = dedupeFeedAddresses([
      { kind: "leases", addr: addr("10.0.0.5", { hostname: "lease" }) },
      { kind: "assignments", addr: addr("10.0.0.5", { hostname: "assign" }) },
      { kind: "reservations", addr: addr("10.0.0.5", { hostname: "res" }) },
      { kind: "leases", addr: addr("10.0.0.6") },
      { kind: "assignments", addr: addr("10.0.0.7") },
      { kind: "leases", addr: addr("10.0.0.7") },
    ]);
    expect([...out.entries()].map(([ip, v]) => [ip, v.sourceType, v.addr.hostname])).toEqual([
      ["10.0.0.5", "dhcp_reservation", "res"],
      ["10.0.0.6", "dhcp_lease", null],
      ["10.0.0.7", "external", null],
    ]);
  });

  it("writes only the three feed sourceTypes", () => {
    expect([...GENERIC_API_FEED_SOURCE_TYPES]).toEqual(["dhcp_lease", "dhcp_reservation", "external"]);
  });
});
