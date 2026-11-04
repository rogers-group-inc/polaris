/**
 * Business rule 91(e): an AP with no base MAC is paired with the MAC its own
 * controller sees on its reported address — never across gates, and never
 * when the gate's evidence is not single-valued.
 */
import { describe, it, expect } from "vitest";
import { buildGateMacIndex, fortiapGateMac, fortiswitchGateMac, isFortiapUnauthorized } from "../../src/utils/fortiapGateMac.js";

const lease = (device: string, ipAddress: string, macAddress: string, type: "dhcp-lease" | "dhcp-reservation" = "dhcp-lease") =>
  ({ device, ipAddress, macAddress, type });
const arp = (fortigateDevice: string, ip: string, mac: string) => ({ fortigateDevice, ip, mac });
const ap = (device: string, ipAddress: string) => ({ device, ipAddress });
const inv = (device: string, ipAddress: string, macAddress: string, isOnline = true) => ({ device, ipAddress, macAddress, isOnline });

describe("fortiapGateMac", () => {
  it("returns the MAC the AP's own gate leased on its address", () => {
    const idx = buildGateMacIndex({ leases: [lease("ENNIS-61F-1", "192.168.1.2", "80-80-2c-ae-76-d8")], inventory: [], arp: [], aps: [ap("ENNIS-61F-1", "192.168.1.2")] });
    expect(fortiapGateMac(idx, ap("ENNIS-61F-1", "192.168.1.2"))).toBe("80:80:2C:AE:76:D8");
  });

  it("reads the gate's online detected-device row — an AP on its static default has no lease", () => {
    const idx = buildGateMacIndex({ leases: [], inventory: [inv("G1", "192.168.1.2", "80:80:2C:AE:76:D8")], arp: [], aps: [] });
    expect(fortiapGateMac(idx, ap("G1", "192.168.1.2"))).toBe("80:80:2C:AE:76:D8");
  });

  it("ignores an offline detected-device row", () => {
    const idx = buildGateMacIndex({ leases: [], inventory: [inv("G1", "192.168.1.2", "80:80:2C:AE:76:D8", false)], arp: [], aps: [] });
    expect(fortiapGateMac(idx, ap("G1", "192.168.1.2"))).toBeNull();
  });

  it("falls back to the gate's ARP entry", () => {
    const idx = buildGateMacIndex({ leases: [], inventory: [], arp: [arp("G1", "192.168.1.2", "80:80:2C:AE:76:D8")], aps: [] });
    expect(fortiapGateMac(idx, ap("G1", "192.168.1.2"))).toBe("80:80:2C:AE:76:D8");
  });

  it("never pairs across gates — the factory-default address sits behind many", () => {
    const idx = buildGateMacIndex({ leases: [lease("OTHER-GATE", "192.168.1.2", "80:80:2C:00:00:01")], inventory: [], arp: [], aps: [] });
    expect(fortiapGateMac(idx, ap("ENNIS-61F-1", "192.168.1.2"))).toBeNull();
  });

  it("refuses when the lease and ARP disagree", () => {
    const idx = buildGateMacIndex({ leases: [lease("G1", "10.0.0.5", "80:80:2C:00:00:01")], inventory: [], arp: [arp("G1", "10.0.0.5", "80:80:2C:00:00:02")], aps: [] });
    expect(fortiapGateMac(idx, ap("G1", "10.0.0.5"))).toBeNull();
  });

  it("agrees when lease and ARP name the same MAC in different spellings", () => {
    const idx = buildGateMacIndex({ leases: [lease("G1", "10.0.0.5", "80-80-2c-00-00-01")], inventory: [], arp: [arp("G1", "10.0.0.5", "80:80:2C:00:00:01")], aps: [] });
    expect(fortiapGateMac(idx, ap("G1", "10.0.0.5"))).toBe("80:80:2C:00:00:01");
  });

  it("refuses when two APs on one gate report the same address", () => {
    const idx = buildGateMacIndex({ leases: [lease("G1", "192.168.1.2", "80:80:2C:00:00:01")], inventory: [], arp: [], aps: [ap("G1", "192.168.1.2"), ap("G1", "192.168.1.2")] });
    expect(fortiapGateMac(idx, ap("G1", "192.168.1.2"))).toBeNull();
  });

  it("ignores reservations, blank / 0.0.0.0 addresses and the all-zero MAC", () => {
    const idx = buildGateMacIndex({ leases: [lease("G1", "10.0.0.5", "80:80:2C:00:00:01", "dhcp-reservation"), lease("G1", "0.0.0.0", "80:80:2C:00:00:02")], inventory: [], arp: [arp("G1", "10.0.0.6", "00:00:00:00:00:00")], aps: [] });
    expect(fortiapGateMac(idx, ap("G1", "10.0.0.5"))).toBeNull();
    expect(fortiapGateMac(idx, ap("G1", "0.0.0.0"))).toBeNull();
    expect(fortiapGateMac(idx, ap("G1", "10.0.0.6"))).toBeNull();
    expect(fortiapGateMac(idx, ap("", "10.0.0.5"))).toBeNull();
  });
});

// Business rule 91(g): FortiOS reports no MAC for a managed switch, so its
// controller's view of `connecting_from` is the switch's management MAC.
describe("fortiswitchGateMac", () => {
  const sw = (device: string, ipAddress: string) => ({ device, ipAddress });

  it("takes the MAC the switch's own gate sees online at connecting_from", () => {
    const idx = buildGateMacIndex({
      leases: [], arp: [], aps: [],
      inventory: [inv("GAINESBORO-61F", "172.22.58.129", "d4:b4:c0:78:60:7e")],
      switches: [sw("GAINESBORO-61F", "172.22.58.129")],
    });
    expect(fortiswitchGateMac(idx, sw("GAINESBORO-61F", "172.22.58.129"))).toBe("D4:B4:C0:78:60:7E");
  });

  it("agrees across lease, ARP and inventory naming one MAC", () => {
    const idx = buildGateMacIndex({
      leases: [lease("G1", "10.255.1.2", "d4-b4-c0-78-60-7e")],
      inventory: [inv("G1", "10.255.1.2", "D4:B4:C0:78:60:7E")],
      arp: [arp("G1", "10.255.1.2", "d4:b4:c0:78:60:7e")],
      aps: [], switches: [sw("G1", "10.255.1.2")],
    });
    expect(fortiswitchGateMac(idx, sw("G1", "10.255.1.2"))).toBe("D4:B4:C0:78:60:7E");
  });

  it("refuses when the gate's tables name two MACs at the address", () => {
    const idx = buildGateMacIndex({
      leases: [lease("G1", "10.255.1.2", "D4:B4:C0:00:00:01")], inventory: [],
      arp: [arp("G1", "10.255.1.2", "D4:B4:C0:00:00:02")], aps: [], switches: [],
    });
    expect(fortiswitchGateMac(idx, sw("G1", "10.255.1.2"))).toBeNull();
  });

  it("never reads another gate's tables", () => {
    const idx = buildGateMacIndex({
      leases: [lease("G2", "10.255.1.2", "D4:B4:C0:00:00:01")], inventory: [], arp: [], aps: [], switches: [],
    });
    expect(fortiswitchGateMac(idx, sw("G1", "10.255.1.2"))).toBeNull();
  });

  it("refuses an address a switch and an AP on one gate both report", () => {
    const idx = buildGateMacIndex({
      leases: [lease("G1", "10.255.1.2", "D4:B4:C0:00:00:01")], inventory: [], arp: [],
      aps: [ap("G1", "10.255.1.2")], switches: [sw("G1", "10.255.1.2")],
    });
    expect(fortiswitchGateMac(idx, sw("G1", "10.255.1.2"))).toBeNull();
    expect(fortiapGateMac(idx, ap("G1", "10.255.1.2"))).toBeNull();
  });

  it("refuses an address two switches on one gate report", () => {
    const idx = buildGateMacIndex({
      leases: [lease("G1", "10.255.1.2", "D4:B4:C0:00:00:01")], inventory: [], arp: [], aps: [],
      switches: [sw("G1", "10.255.1.2"), sw("G1", "10.255.1.2")],
    });
    expect(fortiswitchGateMac(idx, sw("G1", "10.255.1.2"))).toBeNull();
  });

  it("returns null for a switch with no connecting_from", () => {
    const idx = buildGateMacIndex({ leases: [], inventory: [], arp: [], aps: [], switches: [] });
    expect(fortiswitchGateMac(idx, sw("G1", ""))).toBeNull();
  });
});

describe("isFortiapUnauthorized", () => {
  it("reads discovered / unauthorized in any case as unauthorized", () => {
    expect(isFortiapUnauthorized("discovered")).toBe(true);
    expect(isFortiapUnauthorized("Unauthorized")).toBe(true);
    expect(isFortiapUnauthorized(" DISCOVERED ")).toBe(true);
  });
  it("does not read authorized, disabled or a missing state as unauthorized", () => {
    expect(isFortiapUnauthorized("authorized")).toBe(false);
    expect(isFortiapUnauthorized("disable")).toBe(false);
    expect(isFortiapUnauthorized("")).toBe(false);
    expect(isFortiapUnauthorized(null)).toBe(false);
  });
});
