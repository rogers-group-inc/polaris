/**
 * Business rule 125 — the FortiOS IPv6 parsers shared by the FortiManager and
 * standalone FortiGate collectors. Row shapes are those read off FortiOS 7.6.7
 * / 8.0.1 (lab, 2026-10-21); addresses are RFC 3849 documentation space.
 */
import { describe, it, expect } from "vitest";
import {
  fortiosEnabled,
  parseFortiosIpv6Prefix,
  parseDhcp6Servers,
  parseInterfaceIpv6,
  advertisedPrefixSubnets,
  parseDhcpMonitorAddress,
  clientIpv6Address,
  DHCP_MONITOR_FORMAT,
} from "../../src/utils/fortiosIpv6.js";

// The unconfigured block every interface carries on 7.6.7 (trimmed).
const UNSET_IPV6 = {
  "ip6-mode": "static", "ip6-address": "::/0", "ip6-extra-addr": [], "ip6-send-adv": "disable",
  "ip6-prefix-list": [], "ip6-subnet": "::/0", "ip6-delegated-prefix-list": [],
};

describe("fortiosEnabled", () => {
  it("reads FortiOS strings and FortiManager integers alike", () => {
    expect(fortiosEnabled("enable")).toBe(true);
    expect(fortiosEnabled(1)).toBe(true);
    expect(fortiosEnabled("disable")).toBe(false);
    expect(fortiosEnabled(0)).toBe(false);
    expect(fortiosEnabled(undefined)).toBeUndefined();
    expect(fortiosEnabled("maybe")).toBeUndefined();
  });
});

describe("parseFortiosIpv6Prefix", () => {
  it("splits an interface address into a canonical address and its network", () => {
    expect(parseFortiosIpv6Prefix("2001:DB8:1:0::1/64")).toEqual({ ip: "2001:db8:1::1", cidr: "2001:db8:1::/64" });
  });
  it("refuses the unset placeholder, link-local, multicast, IPv4 and junk", () => {
    expect(parseFortiosIpv6Prefix("::/0")).toBeNull();
    expect(parseFortiosIpv6Prefix("fe80::1/64")).toBeNull();
    expect(parseFortiosIpv6Prefix("ff02::1/128")).toBeNull();
    expect(parseFortiosIpv6Prefix("10.0.0.1/24")).toBeNull();
    expect(parseFortiosIpv6Prefix("2001:db8::/64\nx")).toBeNull();
    expect(parseFortiosIpv6Prefix(null)).toBeNull();
  });
});

describe("parseDhcp6Servers", () => {
  it("skips the unconfigured server the lab's HUB1 carries (subnet ::/0)", () => {
    const lab = [{ id: 1, status: "enable", subnet: "::/0", interface: "fortilink", "ip-mode": "range", "ip-range": [] }];
    expect(parseDhcp6Servers(lab, "HUB1-a", "FGT61FTK00000001")).toEqual([]);
  });
  it("turns a configured scope into a dhcp6 subnet with a prefixed server id", () => {
    const rows = [
      { id: 3, status: "enable", subnet: "2001:db8:10::/64", interface: "lan" },
      { id: 4, status: 0, subnet: "2001:db8:11::/64", interface: "guest" }, // FMG-coded disable
      { id: 5, status: "enable", subnet: "2001:db8:12::/64", interface: "" },
    ];
    expect(parseDhcp6Servers(rows, "gate", "SN1")).toEqual([
      { cidr: "2001:db8:10::/64", name: "lan", fortigateDevice: "gate", fortigateSerial: "SN1", dhcpServerId: "dhcp6-3", origin: "dhcp6" },
      { cidr: "2001:db8:12::/64", name: "dhcp6-5", fortigateDevice: "gate", fortigateSerial: "SN1", dhcpServerId: "dhcp6-5", origin: "dhcp6" },
    ]);
  });
  it("answers an empty list for a missing or non-array table", () => {
    expect(parseDhcp6Servers(undefined, "g", undefined)).toEqual([]);
  });
});

describe("parseInterfaceIpv6", () => {
  it("reads nothing from the lab's unconfigured block, or no block at all", () => {
    expect(parseInterfaceIpv6({ name: "LabProd", ipv6: UNSET_IPV6 })).toEqual({ addresses: [], advertisedPrefixes: [] });
    expect(parseInterfaceIpv6({ name: "port1" })).toEqual({ addresses: [], advertisedPrefixes: [] });
  });
  it("reads the primary and extra addresses, dropping link-local", () => {
    const parsed = parseInterfaceIpv6({ ipv6: { ...UNSET_IPV6,
      "ip6-address": "2001:db8:20::1/64",
      "ip6-extra-addr": [{ prefix: "2001:db8:21::1/64" }, { prefix: "fe80::99/64" }, { prefix: "2001:db8:20::1/64" }],
    } });
    expect(parsed.addresses).toEqual([
      { ipAddress: "2001:db8:20::1", role: "interface" },
      { ipAddress: "2001:db8:21::1", role: "secondary" },
    ]);
    // Not advertising — a WAN address is the gate's, not a served network.
    expect(parsed.advertisedPrefixes).toEqual([]);
  });
  it("lists the advertised prefixes when RA is on, falling back to the on-link prefix", () => {
    const withList = parseInterfaceIpv6({ ipv6: { ...UNSET_IPV6, "ip6-address": "2001:db8:30::1/64", "ip6-send-adv": "enable",
      "ip6-prefix-list": [{ prefix: "2001:db8:31::/64" }, { prefix: "2001:db8:32::/64" }] } });
    expect(withList.advertisedPrefixes).toEqual(["2001:db8:31::/64", "2001:db8:32::/64"]);
    const fallback = parseInterfaceIpv6({ ipv6: { ...UNSET_IPV6, "ip6-address": "2001:db8:30::1/64", "ip6-send-adv": 1 } });
    expect(fallback.advertisedPrefixes).toEqual(["2001:db8:30::/64"]);
  });
});

describe("advertisedPrefixSubnets", () => {
  it("leaves a prefix a DHCPv6 scope on the same gate already reported to that scope", () => {
    const parsed = { addresses: [], advertisedPrefixes: ["2001:db8:40::/64", "2001:db8:41::/64"] };
    const existing = [{ cidr: "2001:db8:40::/64", fortigateDevice: "gate" }];
    expect(advertisedPrefixSubnets("lan", parsed, "gate", "SN", existing)).toEqual([
      { cidr: "2001:db8:41::/64", name: "lan", fortigateDevice: "gate", fortigateSerial: "SN", dhcpServerId: "ra-lan", origin: "ra" },
    ]);
    // Another gate's scope does not swallow it.
    expect(advertisedPrefixSubnets("lan", parsed, "other", undefined, existing)).toHaveLength(2);
  });
});

describe("parseDhcpMonitorAddress", () => {
  it("requests the family column", () => {
    expect(DHCP_MONITOR_FORMAT.split("|")).toContain("type");
  });
  it("keeps the IPv4 handling exactly as it was", () => {
    expect(parseDhcpMonitorAddress({ ip: "192.0.2.5", mac: "aa:bb:cc:dd:ee:ff", type: "ipv4" })).toEqual({ ip: "192.0.2.5", mac: "aa:bb:cc:dd:ee:ff", v6: false });
    expect(parseDhcpMonitorAddress({ ip: "0.0.0.0" })).toBeNull();
    expect(parseDhcpMonitorAddress({ ip: "" })).toBeNull();
  });
  it("canonicalises an IPv6 lease and drops a DUID from the MAC column", () => {
    expect(parseDhcpMonitorAddress({ ip: "2001:DB8:50:0::A", mac: "00:01:00:01:2a:2b:2c:2d:aa:bb:cc:dd:ee:ff", type: "ipv6" }))
      .toEqual({ ip: "2001:db8:50::a", mac: "", v6: true });
    expect(parseDhcpMonitorAddress({ ip: "2001:db8:50::b", mac: "aa:bb:cc:dd:ee:01", type: "ipv6" }))
      .toEqual({ ip: "2001:db8:50::b", mac: "aa:bb:cc:dd:ee:01", v6: true });
    expect(parseDhcpMonitorAddress({ ip: "fe80::1", type: "ipv6" })).toBeNull();
  });
});

describe("clientIpv6Address", () => {
  it("canonicalises IPAM space and refuses everything else", () => {
    expect(clientIpv6Address("FD00::2")).toBe("fd00::2");
    expect(clientIpv6Address("::")).toBeUndefined();
    expect(clientIpv6Address("fe80::1")).toBeUndefined();
    expect(clientIpv6Address("192.0.2.1")).toBeUndefined();
    expect(clientIpv6Address(undefined)).toBeUndefined();
  });
});
