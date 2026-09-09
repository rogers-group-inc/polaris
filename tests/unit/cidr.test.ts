/**
 * tests/unit/cidr.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  normalizeCidr,
  isValidCidr,
  isValidIpAddress,
  cidrContains,
  cidrOverlaps,
  ipInCidr,
  compareIpv4,
  usableHostCount,
  findNextAvailableSubnet,
  detectIpVersion,
  packTemplateEntries,
  packIntoAnchor,
  isPrivateIpv4,
  parseRangeFirstIp,
  expandIpv6,
  ipToPtrName,
  isPrivateOrLoopbackIp,
  isLoopbackIp,
  isRfc1918Cidr,
  normalizeAllowlistCidr,
  buildCidrMatcher,
  bareInterfaceIp,
  interfaceIpIsUnaddressed,
} from "../../src/utils/cidr.js";

describe("normalizeCidr", () => {
  it("zeroes host bits", () => {
    expect(normalizeCidr("10.1.1.5/24")).toBe("10.1.1.0/24");
    expect(normalizeCidr("192.168.100.200/16")).toBe("192.168.0.0/16");
  });

  it("is a no-op when already normalized", () => {
    expect(normalizeCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
  });
});

describe("isValidCidr", () => {
  it("accepts valid IPv4 CIDRs", () => {
    expect(isValidCidr("10.0.0.0/8")).toBe(true);
    expect(isValidCidr("192.168.1.0/24")).toBe(true);
    expect(isValidCidr("172.16.0.0/12")).toBe(true);
  });

  it("rejects invalid CIDRs", () => {
    expect(isValidCidr("not-an-ip")).toBe(false);
    expect(isValidCidr("10.0.0.0")).toBe(false); // missing prefix
    expect(isValidCidr("10.0.0.0/33")).toBe(false); // prefix out of range
  });
});

describe("detectIpVersion", () => {
  it("detects v4", () => expect(detectIpVersion("10.0.0.0/8")).toBe("v4"));
  it("detects v6", () => expect(detectIpVersion("2001:db8::/32")).toBe("v6"));
});

describe("cidrContains", () => {
  it("returns true when inner is inside outer", () => {
    expect(cidrContains("10.0.0.0/8", "10.1.0.0/24")).toBe(true);
  });

  it("returns false when inner is outside outer", () => {
    expect(cidrContains("10.0.0.0/8", "192.168.1.0/24")).toBe(false);
  });

  it("returns true for identical CIDRs", () => {
    expect(cidrContains("10.0.0.0/8", "10.0.0.0/8")).toBe(true);
  });

  // Netmask leaves `broadcast` undefined for /31 and /32 — the old
  // `innerBlock.broadcast!` threw on those and every host route reported
  // "not contained", which silently broke region-tag propagation to assets
  // addressed out of an enclosed gate's subnets.
  it("handles a /32 inner (host route)", () => {
    expect(cidrContains("10.88.1.0/24", "10.88.1.20/32")).toBe(true);
    expect(cidrContains("10.88.1.0/24", "10.88.2.20/32")).toBe(false);
  });

  it("handles a /31 inner (point-to-point)", () => {
    expect(cidrContains("10.88.1.0/24", "10.88.1.20/31")).toBe(true);
    // Straddles the boundary: .254-.255 of one /24 vs the next.
    expect(cidrContains("10.88.1.0/24", "10.88.1.254/31")).toBe(true);
    expect(cidrContains("10.88.1.0/24", "10.88.2.0/31")).toBe(false);
  });
});

describe("buildCidrMatcher", () => {
  it("returns the first matching CIDR and null for a miss", () => {
    const match = buildCidrMatcher(["10.0.0.0/24", "10.0.1.0/24"]);
    expect(match("10.0.1.7")).toBe("10.0.1.0/24");
    expect(match("192.168.1.1")).toBeNull();
  });

  it("skips unparseable CIDRs without blinding the rest", () => {
    const match = buildCidrMatcher(["not-a-cidr", "10.0.0.0/24"]);
    expect(match("10.0.0.9")).toBe("10.0.0.0/24");
  });

  it("matches nothing for empty input, IPv6, or an empty ip", () => {
    expect(buildCidrMatcher([])("10.0.0.1")).toBeNull();
    const match = buildCidrMatcher(["10.0.0.0/8"]);
    expect(match("2001:db8::1")).toBeNull();
    expect(match("")).toBeNull();
  });
});

describe("cidrOverlaps", () => {
  it("detects overlap when one contains another", () => {
    expect(cidrOverlaps("10.0.0.0/16", "10.0.1.0/24")).toBe(true);
  });

  it("returns false for non-overlapping blocks", () => {
    expect(cidrOverlaps("10.0.0.0/24", "10.0.1.0/24")).toBe(false);
  });
});

describe("ipInCidr", () => {
  it("returns true for an IP inside the range", () => {
    expect(ipInCidr("10.0.1.50", "10.0.0.0/16")).toBe(true);
  });

  it("returns false for an IP outside the range", () => {
    expect(ipInCidr("192.168.1.1", "10.0.0.0/8")).toBe(false);
  });
});

describe("usableHostCount", () => {
  it("calculates /24 correctly", () => expect(usableHostCount("10.0.0.0/24")).toBe(254));
  it("calculates /32 as 1", () => expect(usableHostCount("10.0.0.1/32")).toBe(1));
  it("calculates /31 as 2", () => expect(usableHostCount("10.0.0.0/31")).toBe(2));
  it("calculates /16 correctly", () => expect(usableHostCount("10.0.0.0/16")).toBe(65534));
});

describe("findNextAvailableSubnet", () => {
  it("returns the first block when nothing is allocated", () => {
    expect(findNextAvailableSubnet("10.0.0.0/8", [], 24)).toBe("10.0.0.0/24");
  });

  it("skips allocated blocks", () => {
    const allocated = ["10.0.0.0/24", "10.0.1.0/24"];
    expect(findNextAvailableSubnet("10.0.0.0/16", allocated, 24)).toBe("10.0.2.0/24");
  });

  it("returns null when no space remains", () => {
    const allocated = ["10.0.0.0/24"];
    expect(findNextAvailableSubnet("10.0.0.0/24", allocated, 24)).toBeNull();
  });
});

describe("packTemplateEntries", () => {
  it("packs the Riverbend template into a /23 span", () => {
    const result = packTemplateEntries([
      { prefixLength: 25 }, // AcmeHardware 128
      { prefixLength: 25 }, // AcmeUsers    128
      { prefixLength: 26 }, // AcmeVoice     64
      { prefixLength: 26 }, // fortilink    64
      { prefixLength: 26 }, // AcmePlant     64
    ]);
    expect(result.packed.map((p) => p.offset)).toEqual([0, 128, 256, 320, 384]);
    expect(result.totalSpan).toBe(448);
    expect(result.containingPrefix).toBe(23); // 512 addrs
  });

  it("pads offsets when a larger subnet follows a smaller one", () => {
    const result = packTemplateEntries([
      { prefixLength: 26 }, // size 64 at offset 0
      { prefixLength: 25 }, // size 128 needs /25 alignment -> skips to 128
    ]);
    expect(result.packed.map((p) => p.offset)).toEqual([0, 128]);
    expect(result.totalSpan).toBe(256);
  });
});

describe("packIntoAnchor (bulk allocation)", () => {
  const riverbend = [
    { name: "AcmeHardware", prefixLength: 25 },
    { name: "AcmeUsers",    prefixLength: 25 },
    { name: "AcmeVoice",    prefixLength: 26 },
    { name: "fortilink",   prefixLength: 26 },
    { name: "AcmePlant",    prefixLength: 26 },
  ];

  it("places the first site at the start of the block", () => {
    const result = packIntoAnchor("172.23.0.0/16", [], riverbend, 24);
    expect(result).not.toBeNull();
    expect(result!.effectiveAnchorPrefix).toBe(23); // template needs /23
    expect(result!.anchorCidr).toBe("172.23.0.0/23");
    expect(result!.assignments.map((a) => a.cidr)).toEqual([
      "172.23.0.0/25",
      "172.23.0.128/25",
      "172.23.1.0/26",
      "172.23.1.64/26",
      "172.23.1.128/26",
    ]);
  });

  it("skips past an earlier Riverbend-shaped allocation to the next /23", () => {
    // Riverbend occupies 172.23.0.0/23 (with a stray /26 hole at .1.64).
    // Smith should land in the next /23, not fill Riverbend's gap.
    const existing = [
      "172.23.0.0/25",
      "172.23.0.128/25",
      "172.23.1.0/26",
      "172.23.1.128/26",
      "172.23.1.192/26",
    ];
    const result = packIntoAnchor("172.23.0.0/16", existing, riverbend, 24);
    expect(result).not.toBeNull();
    expect(result!.anchorCidr).toBe("172.23.2.0/23");
    expect(result!.assignments[0].cidr).toBe("172.23.2.0/25");
    expect(result!.assignments[4].cidr).toBe("172.23.3.128/26");
  });

  it("honors a larger user anchor when the template would fit in less space", () => {
    // One /26 entry would only need /26, but user asks for /24 alignment.
    const result = packIntoAnchor(
      "10.0.0.0/16",
      [],
      [{ name: "voice", prefixLength: 26 }],
      24
    );
    expect(result!.effectiveAnchorPrefix).toBe(24);
    expect(result!.anchorCidr).toBe("10.0.0.0/24");
    expect(result!.assignments[0].cidr).toBe("10.0.0.0/26");
  });

  it("uses a larger effective anchor when the template exceeds the requested one", () => {
    // User asks for /24 anchor but template needs /23.
    const result = packIntoAnchor("10.0.0.0/16", [], riverbend, 24);
    expect(result!.effectiveAnchorPrefix).toBe(23);
  });

  it("reserves space for skip entries in the packed layout", () => {
    // AcmeVoice /26, skip /26, fortilink /26, AcmePlant /26 — the skip row
    // should push fortilink to 172.23.101.128/26 instead of .64/26.
    const result = packIntoAnchor(
      "172.23.0.0/16",
      [],
      [
        { name: "AcmeVoice",  prefixLength: 26 },
        { skip: true,        prefixLength: 26 },
        { name: "fortilink", prefixLength: 26 },
        { name: "AcmePlant",  prefixLength: 26 },
      ],
      24
    );
    expect(result).not.toBeNull();
    expect(result!.assignments.map((a) => a.cidr)).toEqual([
      "172.23.0.0/26",
      "172.23.0.64/26",   // skip — reserved, no subnet will be created
      "172.23.0.128/26",
      "172.23.0.192/26",
    ]);
    const skipped = result!.assignments.find((a) => (a.entry as { skip?: boolean }).skip === true);
    expect(skipped?.cidr).toBe("172.23.0.64/26");
  });

  it("returns null when no anchor-aligned region is free", () => {
    // Fill 10.0.0.0/24 so a /24 anchor can't fit.
    const result = packIntoAnchor(
      "10.0.0.0/24",
      ["10.0.0.0/25", "10.0.0.128/25"],
      [{ name: "x", prefixLength: 26 }],
      24
    );
    expect(result).toBeNull();
  });
});

describe("isPrivateIpv4", () => {
  it("accepts the three RFC 1918 ranges", () => {
    expect(isPrivateIpv4("10.0.0.1")).toBe(true);
    expect(isPrivateIpv4("10.255.255.255")).toBe(true);
    expect(isPrivateIpv4("172.16.0.1")).toBe(true);
    expect(isPrivateIpv4("172.31.255.254")).toBe(true);
    expect(isPrivateIpv4("192.168.1.1")).toBe(true);
  });

  it("rejects public, boundary-adjacent, and non-IPv4 input", () => {
    expect(isPrivateIpv4("8.8.8.8")).toBe(false);
    expect(isPrivateIpv4("172.15.0.1")).toBe(false);
    expect(isPrivateIpv4("172.32.0.1")).toBe(false);
    expect(isPrivateIpv4("192.169.0.1")).toBe(false);
    expect(isPrivateIpv4("11.0.0.1")).toBe(false);
    expect(isPrivateIpv4("not-an-ip")).toBe(false);
    expect(isPrivateIpv4("")).toBe(false);
    expect(isPrivateIpv4("fd00::1")).toBe(false); // ULA is private but v6 — out of scope
    expect(isPrivateIpv4("10.0.0.256")).toBe(false); // invalid octet
  });
});

describe("isPrivateOrLoopbackIp", () => {
  it("accepts RFC 1918, loopback, and v6-mapped private forms", () => {
    expect(isPrivateOrLoopbackIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("192.168.1.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("127.255.255.254")).toBe(true);
    expect(isPrivateOrLoopbackIp("::1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackIp("::FFFF:192.168.5.9")).toBe(true); // case-insensitive prefix
  });

  it("rejects public, boundary-adjacent, link-local, ULA, and junk input", () => {
    expect(isPrivateOrLoopbackIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackIp("172.32.0.1")).toBe(false);
    expect(isPrivateOrLoopbackIp("172.15.0.1")).toBe(false);
    expect(isPrivateOrLoopbackIp("169.254.10.10")).toBe(false); // link-local: deliberately out of scope
    expect(isPrivateOrLoopbackIp("fd00::1")).toBe(false); // ULA: deliberately out of scope
    expect(isPrivateOrLoopbackIp("fe80::1")).toBe(false);
    expect(isPrivateOrLoopbackIp("2001:db8::1")).toBe(false);
    expect(isPrivateOrLoopbackIp("")).toBe(false);
    expect(isPrivateOrLoopbackIp("not-an-ip")).toBe(false);
  });
});

describe("isLoopbackIp", () => {
  it("accepts IPv4 127/8, IPv6 ::1, and v6-mapped loopback forms", () => {
    expect(isLoopbackIp("127.0.0.1")).toBe(true);
    expect(isLoopbackIp("127.9.9.9")).toBe(true);
    expect(isLoopbackIp("127.255.255.254")).toBe(true);
    expect(isLoopbackIp("::1")).toBe(true);
    expect(isLoopbackIp("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackIp("::FFFF:127.0.0.1")).toBe(true); // case-insensitive prefix
    expect(isLoopbackIp("  127.0.0.1  ")).toBe(true); // trimmed
  });

  it("rejects private, public, and junk input", () => {
    expect(isLoopbackIp("10.0.0.1")).toBe(false);
    expect(isLoopbackIp("192.168.1.1")).toBe(false);
    expect(isLoopbackIp("8.8.8.8")).toBe(false);
    expect(isLoopbackIp("::ffff:10.0.0.1")).toBe(false);
    expect(isLoopbackIp("fe80::1")).toBe(false);
    expect(isLoopbackIp("128.0.0.1")).toBe(false); // boundary: first octet just past 127
    expect(isLoopbackIp("")).toBe(false);
    expect(isLoopbackIp("not-an-ip")).toBe(false);
  });
});

describe("isRfc1918Cidr", () => {
  it("accepts CIDRs fully inside each RFC 1918 range", () => {
    expect(isRfc1918Cidr("10.0.0.0/8")).toBe(true);
    expect(isRfc1918Cidr("10.50.0.0/16")).toBe(true);
    expect(isRfc1918Cidr("172.16.0.0/12")).toBe(true);
    expect(isRfc1918Cidr("172.20.4.0/24")).toBe(true);
    expect(isRfc1918Cidr("192.168.0.0/16")).toBe(true);
    expect(isRfc1918Cidr("192.168.44.7/32")).toBe(true); // host route
  });

  it("rejects public space, straddling ranges, loopback, and junk", () => {
    expect(isRfc1918Cidr("8.8.8.0/24")).toBe(false);
    expect(isRfc1918Cidr("203.0.113.5/32")).toBe(false);
    expect(isRfc1918Cidr("0.0.0.0/0")).toBe(false); // contains RFC1918 but is not contained BY it
    expect(isRfc1918Cidr("172.15.255.0/24")).toBe(false); // just below 172.16/12
    expect(isRfc1918Cidr("172.32.0.0/24")).toBe(false); // just above 172.16/12
    expect(isRfc1918Cidr("192.168.0.0/15")).toBe(false); // wider than 192.168/16
    expect(isRfc1918Cidr("9.255.255.0/24")).toBe(false); // just below 10/8
    expect(isRfc1918Cidr("127.0.0.0/8")).toBe(false); // loopback is not RFC1918
    expect(isRfc1918Cidr("127.0.0.1/32")).toBe(false);
    expect(isRfc1918Cidr("")).toBe(false);
    expect(isRfc1918Cidr("not-a-cidr")).toBe(false);
    expect(isRfc1918Cidr("fd00::/8")).toBe(false); // IPv6 out of scope
  });
});

describe("normalizeAllowlistCidr", () => {
  it("normalizes valid IPv4 CIDRs (zeroing host bits) and bare IPs to /32", () => {
    expect(normalizeAllowlistCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(normalizeAllowlistCidr("192.168.1.50/24")).toBe("192.168.1.0/24"); // host bits zeroed
    expect(normalizeAllowlistCidr("203.0.113.5")).toBe("203.0.113.5/32"); // bare → /32
    expect(normalizeAllowlistCidr("  172.16.0.0/12  ")).toBe("172.16.0.0/12"); // trimmed
  });

  it("rejects invalid, IPv6, and empty entries", () => {
    expect(normalizeAllowlistCidr("")).toBeNull();
    expect(normalizeAllowlistCidr("not-an-ip")).toBeNull();
    expect(normalizeAllowlistCidr("10.0.0.0/33")).toBeNull(); // bad prefix
    expect(normalizeAllowlistCidr("10.0.0.256/24")).toBeNull(); // bad octet
    expect(normalizeAllowlistCidr("2001:db8::/32")).toBeNull(); // IPv6 out of scope
    expect(normalizeAllowlistCidr("::1")).toBeNull();
  });
});

// ipMatchesAnyCidr was retired (audit 2026-08) — the Dash gate's CIDR-list
// behaviors are asserted through ipMatchesAllowlist in ipAllowlist.test.ts.

describe("parseRangeFirstIp", () => {
  it("extracts the start of a FortiOS range and accepts a bare IP", () => {
    expect(parseRangeFirstIp("10.1.2.3-10.1.2.9")).toBe("10.1.2.3");
    expect(parseRangeFirstIp("10.1.2.3")).toBe("10.1.2.3");
    expect(parseRangeFirstIp(" 10.1.2.3 - 10.1.2.9 ")).toBe("10.1.2.3");
  });

  it("returns null for empty, invalid, and the 0.0.0.0 placeholder", () => {
    expect(parseRangeFirstIp("")).toBeNull();
    expect(parseRangeFirstIp("0.0.0.0")).toBeNull();
    expect(parseRangeFirstIp("0.0.0.0-10.0.0.1")).toBeNull();
    expect(parseRangeFirstIp("not-a-range")).toBeNull();
  });
});

describe("expandIpv6", () => {
  it("expands :: and zero-pads every group", () => {
    expect(expandIpv6("2001:db8::1")).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
    expect(expandIpv6("::1")).toBe("0000:0000:0000:0000:0000:0000:0000:0001");
    expect(expandIpv6("fe80::")).toBe("fe80:0000:0000:0000:0000:0000:0000:0000");
  });

  it("pads an already-full address without altering group order", () => {
    expect(expandIpv6("2001:db8:0:0:0:0:0:1")).toBe("2001:0db8:0000:0000:0000:0000:0000:0001");
  });
});

describe("ipToPtrName", () => {
  it("builds in-addr.arpa names for IPv4", () => {
    expect(ipToPtrName("10.1.2.3")).toBe("3.2.1.10.in-addr.arpa");
  });

  it("builds nibble-reversed ip6.arpa names for IPv6", () => {
    expect(ipToPtrName("2001:db8::1")).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa",
    );
  });
});

describe("compareIpv4", () => {
  it("orders dotted quads numerically, not lexicographically", () => {
    const sorted = ["10.1.1.10", "10.1.1.2", "10.1.1.100", "9.1.1.1"].sort(compareIpv4);
    expect(sorted).toEqual(["9.1.1.1", "10.1.1.2", "10.1.1.10", "10.1.1.100"]);
  });

  it("returns 0 for the same address", () => {
    expect(compareIpv4("192.168.1.1", "192.168.1.1")).toBe(0);
  });

  it("sorts non-IPv4 values after every IPv4 address", () => {
    const sorted = ["fe80::1", "10.0.0.1", "not-an-ip"].sort(compareIpv4);
    expect(sorted[0]).toBe("10.0.0.1");
    expect(sorted.slice(1).sort()).toEqual(["fe80::1", "not-an-ip"]);
  });
});

describe("bareInterfaceIp / interfaceIpIsUnaddressed", () => {
  it("takes the address out of every shape a transport reports it in", () => {
    // SNMP ipAddrTable / FortiOS monitor: bare. FortiOS CMDB: address + mask.
    // An agent may report a prefix. All three name the same interface address.
    expect(bareInterfaceIp("10.4.1.1")).toBe("10.4.1.1");
    expect(bareInterfaceIp("10.4.1.1 255.255.255.0")).toBe("10.4.1.1");
    expect(bareInterfaceIp("10.4.1.1/24")).toBe("10.4.1.1");
    expect(bareInterfaceIp("  10.4.1.1  ")).toBe("10.4.1.1");
  });

  it("is the empty string for no address at all", () => {
    expect(bareInterfaceIp(null)).toBe("");
    expect(bareInterfaceIp(undefined)).toBe("");
    expect(bareInterfaceIp("   ")).toBe("");
  });

  it("calls 0.0.0.0 unaddressed in every shape, and a real address addressed", () => {
    // The whole point: an operator's `!= 0.0.0.0` automation and the
    // auto-monitor dead-parent check must agree about the mask-carrying form.
    expect(interfaceIpIsUnaddressed("0.0.0.0")).toBe(true);
    expect(interfaceIpIsUnaddressed("0.0.0.0 0.0.0.0")).toBe(true);
    expect(interfaceIpIsUnaddressed("0.0.0.0/0")).toBe(true);
    expect(interfaceIpIsUnaddressed(null)).toBe(true);
    expect(interfaceIpIsUnaddressed("")).toBe(true);
    expect(interfaceIpIsUnaddressed("10.4.1.1")).toBe(false);
    expect(interfaceIpIsUnaddressed("10.4.1.1 255.255.255.0")).toBe(false);
  });
});
