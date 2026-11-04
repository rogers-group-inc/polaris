/**
 * tests/unit/assetUpstream.test.ts
 *
 * The pure half of the upstream-device resolver: splitting a `lastSeenSwitch`
 * value into the device name the asset page makes clickable and the port half
 * it leaves as text. The resolution itself needs a database and is covered by
 * tests/integration/assetUpstream.test.ts.
 */

import { describe, it, expect } from "vitest";
import { pickFirewallEntry, splitLastSeenSwitch, type UpstreamAssetRef } from "../../src/services/assetUpstreamService.js";

describe("splitLastSeenSwitch", () => {
  it("splits the stored '<switch>/<port>' shape", () => {
    expect(splitLastSeenSwitch("FS-248E-01/port15")).toEqual({ name: "FS-248E-01", port: "port15" });
  });
  it("accepts a bare switch name with no port", () => {
    expect(splitLastSeenSwitch("S248EPTF1234567")).toEqual({ name: "S248EPTF1234567", port: "" });
  });
  it("keeps a port name containing a slash intact", () => {
    // Only the FIRST slash separates; a FortiSwitch port can carry more.
    expect(splitLastSeenSwitch("SW-1/port1/1")).toEqual({ name: "SW-1", port: "port1/1" });
  });
  it("trims both halves", () => {
    expect(splitLastSeenSwitch("  SW-1 / port3 ")).toEqual({ name: "SW-1", port: "port3" });
  });
  it("null for empty / missing / a value with no device name", () => {
    expect(splitLastSeenSwitch(null)).toBeNull();
    expect(splitLastSeenSwitch(undefined)).toBeNull();
    expect(splitLastSeenSwitch("   ")).toBeNull();
    expect(splitLastSeenSwitch("/port9")).toBeNull();
  });
});

describe("pickFirewallEntry — sighted gates that are gone", () => {
  const ref = (id: string, status = "active"): UpstreamAssetRef => ({
    id, hostname: id, ipAddress: null, assetType: "firewall", status, monitorStatus: null, managementAccess: null,
  });
  const at = (iso: string) => new Date(iso);
  const subnet = { name: "NEW-FGT", source: "subnet" as const, subnetCidr: "10.9.0.0/24", asset: ref("new") };

  it("names the newest sighting when its gate still exists", () => {
    const out = pickFirewallEntry(
      [{ fortigateDevice: "NEW-FGT", lastSeen: at("2026-11-01T00:00:00Z") }, { fortigateDevice: "OLD-FGT", lastSeen: at("2026-10-01T00:00:00Z") }],
      (n) => ref(n),
      subnet,
    );
    expect(out).toMatchObject({ name: "NEW-FGT", source: "sighting", lastSeen: "2026-11-01T00:00:00.000Z" });
  });

  it("passes over a newer sighting whose gate was deleted for an older one that still exists", () => {
    const out = pickFirewallEntry(
      [{ fortigateDevice: "GONE-FGT", lastSeen: at("2026-11-01T00:00:00Z") }, { fortigateDevice: "LIVE-FGT", lastSeen: at("2026-10-01T00:00:00Z") }],
      (n) => (n === "LIVE-FGT" ? ref(n) : null),
      null,
    );
    expect(out).toMatchObject({ name: "LIVE-FGT", source: "sighting" });
  });

  it("passes over a decommissioned gate", () => {
    const out = pickFirewallEntry([{ fortigateDevice: "OLD-FGT", lastSeen: at("2026-10-01T00:00:00Z") }], (n) => ref(n, "decommissioned"), subnet);
    expect(out).toBe(subnet);
  });

  it("falls to the IPAM gate when every sighted gate is gone — the replaced-firewall case", () => {
    const out = pickFirewallEntry([{ fortigateDevice: "OLD-FGT", lastSeen: at("2026-10-01T00:00:00Z") }], () => null, subnet);
    expect(out).toBe(subnet);
  });

  it("keeps the newest name, unresolved, when nothing resolves and IPAM has no answer", () => {
    const out = pickFirewallEntry(
      [{ fortigateDevice: "A-FGT", lastSeen: at("2026-11-01T00:00:00Z") }, { fortigateDevice: "B-FGT", lastSeen: at("2026-10-01T00:00:00Z") }],
      () => null,
      null,
    );
    expect(out).toMatchObject({ name: "A-FGT", source: "sighting", asset: null });
  });

  it("null with no sightings and no IPAM answer", () => {
    expect(pickFirewallEntry([], () => null, null)).toBeNull();
  });
});
