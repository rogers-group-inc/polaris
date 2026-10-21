/**
 * Business rule 126 — an interface's addresses from IP-MIB: the RFC 4293
 * ipAddressTable (both families) and the RFC 1213 ipAddrTable fallback.
 * Index suffixes are built the way RFC 4001 encodes an InetAddress.
 * RFC 5737 / RFC 3849 addresses.
 */
import { describe, it, expect } from "vitest";
import {
  parseIpAddressIndex,
  addressesByIfIndexFromIpAddressTable,
  addressesByIfIndexFromIpAddrTable,
} from "../../src/utils/snmpIpAddressTable.js";
import { pickInterfaceAddresses } from "../../src/utils/interfaceAddress.js";

/** `<type>.<len>.<octets>` for an address, as an agent indexes it. */
function v4Suffix(ip: string, withLength = true): string {
  const o = ip.split(".");
  return withLength ? `1.4.${o.join(".")}` : `1.${o.join(".")}`;
}
function v6Suffix(groups: number[], withLength = true): string {
  const bytes = groups.flatMap((g) => [g >> 8, g & 0xff]);
  return withLength ? `2.16.${bytes.join(".")}` : `2.${bytes.join(".")}`;
}

describe("parseIpAddressIndex", () => {
  it("decodes IPv4 and IPv6 with the RFC 4001 length prefix", () => {
    expect(parseIpAddressIndex(v4Suffix("192.0.2.1"))).toBe("192.0.2.1");
    expect(parseIpAddressIndex(v6Suffix([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]))).toBe("2001:db8::1");
  });
  it("tolerates an agent that omits the length", () => {
    expect(parseIpAddressIndex(v4Suffix("192.0.2.1", false))).toBe("192.0.2.1");
    expect(parseIpAddressIndex(v6Suffix([0x2001, 0xdb8, 0, 1, 0, 0, 0, 5], false))).toBe("2001:db8:0:1::5");
  });
  it("refuses zoned types, a wrong length and junk", () => {
    expect(parseIpAddressIndex("4.20." + Array(20).fill(1).join("."))).toBeNull(); // ipv6z
    expect(parseIpAddressIndex("1.4.192.0.2")).toBeNull();
    expect(parseIpAddressIndex("1.4.300.0.2.1")).toBeNull();
    expect(parseIpAddressIndex("")).toBeNull();
  });
});

describe("addressesByIfIndexFromIpAddressTable", () => {
  it("groups by ifIndex in walk order and keeps only unicast rows when the type was read", () => {
    const g = v6Suffix([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0x10]);
    const anycast = v6Suffix([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    const ll = v6Suffix([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    const v4 = v4Suffix("192.0.2.10");
    const ifIndex = new Map<string, number | null>([[ll, 3], [v4, 3], [g, 3], [anycast, 3], [v4Suffix("198.51.100.1"), 7], [v4Suffix("192.0.2.99"), null]]);
    const types = new Map<string, number | null>([[anycast, 2]]);
    expect(addressesByIfIndexFromIpAddressTable(ifIndex, types)).toEqual(new Map([
      ["3", ["fe80::1", "192.0.2.10", "2001:db8::10"]],
      ["7", ["198.51.100.1"]],
    ]));
    // Without the type column nothing is filtered on it.
    expect(addressesByIfIndexFromIpAddressTable(ifIndex).get("3")).toContain("2001:db8::");
  });
});

// The shape a real net-snmp 5.9.4 agent answered (2026-10-21; addresses
// swapped for documentation space): eth0 lists its BROADCAST address as an
// ipAddressTable row too, typed broadcast(3), between its unicast IPv4 and its
// IPv6 rows — without the type column it would be a candidate address.
describe("a real net-snmp agent's ipAddressTable", () => {
  it("yields eth0's IPv4 + global IPv6, and nothing for lo", () => {
    const rows: Array<[string, number, number]> = [
      ["1.4.127.0.0.1", 1, 1],
      ["1.4.192.0.2.200", 2, 1],
      ["1.4.192.0.2.255", 2, 3],
      ["2.16.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.1", 1, 1],
      ["2.16.32.1.13.184.1.38.0.0.0.0.0.0.0.0.0.7", 2, 1],
      ["2.16.254.128.0.0.0.0.0.0.244.114.176.255.254.123.239.224", 2, 1],
    ];
    const byIf = addressesByIfIndexFromIpAddressTable(
      new Map(rows.map(([s, i]) => [s, i])),
      new Map(rows.map(([s, , t]) => [s, t])),
    );
    expect(byIf.get("2")).toEqual(["192.0.2.200", "2001:db8:126::7", "fe80::f472:b0ff:fe7b:efe0"]);
    expect(pickInterfaceAddresses(byIf.get("2")!)).toEqual({ ipAddress: "192.0.2.200", ipv6Address: "2001:db8:126::7" });
    expect(pickInterfaceAddresses(byIf.get("1")!)).toEqual({ ipAddress: null, ipv6Address: null });
  });
});

describe("addressesByIfIndexFromIpAddrTable", () => {
  it("inverts the legacy table, which is indexed by the address", () => {
    expect(addressesByIfIndexFromIpAddrTable(new Map([["192.0.2.1", 2], ["192.0.2.2", 2], ["198.51.100.1", 5], ["bad", 1]])))
      .toEqual(new Map([["2", ["192.0.2.1", "192.0.2.2"]], ["5", ["198.51.100.1"]]]));
  });
});
