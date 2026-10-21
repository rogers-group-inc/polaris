/**
 * Business rule 126 — what an interface row may say about its addresses.
 * RFC 5737 / RFC 3849 addresses.
 */
import { describe, it, expect } from "vitest";
import { reportableInterfaceIp, pickInterfaceAddresses, splitInterfaceAddresses } from "../../src/utils/interfaceAddress.js";

describe("reportableInterfaceIp", () => {
  it("answers the bare address from every shape a collector hands over", () => {
    expect(reportableInterfaceIp("192.0.2.10")).toBe("192.0.2.10");
    expect(reportableInterfaceIp("192.0.2.10/24")).toBe("192.0.2.10");
    expect(reportableInterfaceIp("192.0.2.10 255.255.255.0")).toBe("192.0.2.10");
    expect(reportableInterfaceIp("2001:DB8:0:1::A/64")).toBe("2001:db8:0:1::a");
  });
  it("never reports loopback, link-local, 0.0.0.0/8 or non-unicast IPv6", () => {
    for (const ip of ["127.0.0.1", "169.254.10.1", "0.0.0.0", "0.1.2.3", "::1", "::", "fe80::1", "fe80::1%eth0", "ff02::1", "::ffff:192.0.2.1", "", null, undefined, "not-an-ip"]) {
      expect(reportableInterfaceIp(ip as any)).toBeNull();
    }
  });
});

describe("pickInterfaceAddresses", () => {
  it("takes the first reportable of each family in the collector's order", () => {
    expect(pickInterfaceAddresses(["fe80::1", "127.0.0.1", "2001:db8::5", "192.0.2.7", "192.0.2.8", "2001:db8::6"]))
      .toEqual({ ipAddress: "192.0.2.7", ipv6Address: "2001:db8::5" });
    expect(pickInterfaceAddresses([])).toEqual({ ipAddress: null, ipv6Address: null });
  });
});

describe("splitInterfaceAddresses", () => {
  it("keeps IPv4 in ipAddress and IPv6 in ipv6Address", () => {
    expect(splitInterfaceAddresses("192.0.2.1", "2001:db8::1")).toEqual({ ipAddress: "192.0.2.1", ipv6Address: "2001:db8::1" });
  });
  it("moves an IPv6 a collector put in ipAddress, when ipv6Address is empty", () => {
    expect(splitInterfaceAddresses("2001:db8::9")).toEqual({ ipAddress: null, ipv6Address: "2001:db8::9" });
    expect(splitInterfaceAddresses("2001:db8::9", "2001:db8::1")).toEqual({ ipAddress: null, ipv6Address: "2001:db8::1" });
  });
  it("filters what an un-upgraded agent reports: lo's 127.0.0.1 and an IPv6-only NIC's fe80::", () => {
    expect(splitInterfaceAddresses("127.0.0.1")).toEqual({ ipAddress: null, ipv6Address: null });
    expect(splitInterfaceAddresses("fe80::aa:bb")).toEqual({ ipAddress: null, ipv6Address: null });
  });
  it("refuses an IPv4 sent as the IPv6 column", () => {
    expect(splitInterfaceAddresses(null, "192.0.2.1")).toEqual({ ipAddress: null, ipv6Address: null });
  });
});
