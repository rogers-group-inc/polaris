/**
 * Business rule 127 — the install-wide IPv6 switch and the primary IPv6 address.
 *
 * Pins the pure halves: host detection, the mode decision, the dial address
 * (IPv4 first, IPv6 only for an asset with no IPv4 and only while on), the
 * URL-host bracketing, the discovery filter that drops every IPv6 fact, the
 * interface split refusing IPv6, the loss-sweep target, and how the primary
 * IPv6 is picked.
 */

import { describe, it, expect } from "vitest";
import type { networkInterfaces } from "node:os";
import { routableHostIpv6, decideIpv6Enabled, decideIpv6Dialable, hasIpv6Route } from "../../src/services/ipv6GateService.js";
import { pickPrimaryIpv6 } from "../../src/services/primaryIpv6Service.js";
import { assetDialAddress } from "../../src/utils/assetDialAddress.js";
import { urlHost, bareHost } from "../../src/utils/cidr.js";
import { withoutIpv6 } from "../../src/utils/fortiosIpv6.js";
import { splitInterfaceAddresses } from "../../src/utils/interfaceAddress.js";
import { lossSweepTarget, lossSweepIncludes } from "../../src/utils/lossSweep.js";
import type { DiscoveryResult } from "../../src/services/fortimanagerService.js";

type Ifaces = ReturnType<typeof networkInterfaces>;
const nic = (address: string, family: "IPv4" | "IPv6", internal = false) =>
  ({ address, family, internal, netmask: "", mac: "00:00:00:00:00:00", cidr: null, scopeid: 0 }) as never;

describe("routableHostIpv6", () => {
  it("keeps a global address and drops loopback, link-local and internal interfaces", () => {
    const ifaces: Ifaces = {
      lo: [nic("127.0.0.1", "IPv4", true), nic("::1", "IPv6", true)],
      eth0: [nic("10.0.0.5", "IPv4"), nic("fe80::1%eth0", "IPv6"), nic("2001:db8::5", "IPv6")],
    };
    expect(routableHostIpv6(ifaces)).toEqual(["2001:db8::5"]);
  });

  it("is empty on an IPv4-only host", () => {
    expect(routableHostIpv6({ eth0: [nic("10.0.0.5", "IPv4"), nic("fe80::1", "IPv6")] })).toEqual([]);
  });

  it("lists an address once when two interfaces report it", () => {
    expect(routableHostIpv6({ a: [nic("2001:db8::5", "IPv6")], b: [nic("2001:db8::5", "IPv6")] })).toEqual(["2001:db8::5"]);
  });
});

describe("decideIpv6Enabled", () => {
  it("auto follows the host", () => {
    expect(decideIpv6Enabled("auto", [])).toBe(false);
    expect(decideIpv6Enabled("auto", ["2001:db8::5"])).toBe(true);
  });
  it("on and off override the host", () => {
    expect(decideIpv6Enabled("on", [])).toBe(true);
    expect(decideIpv6Enabled("off", ["2001:db8::5"])).toBe(false);
  });
});

describe("decideIpv6Dialable", () => {
  it("needs IPv6 on AND a way to reach it", () => {
    expect(decideIpv6Dialable(false, ["2001:db8::5"], true)).toBe(false);
    expect(decideIpv6Dialable(true, ["2001:db8::5"], false)).toBe(true);
    expect(decideIpv6Dialable(true, [], true)).toBe(true);
  });
  it("forced on in a container with no IPv6 network is not dialable", () => {
    expect(decideIpv6Dialable(decideIpv6Enabled("on", []), [], false)).toBe(false);
  });
});

describe("hasIpv6Route", () => {
  it("answers a boolean without throwing, whatever this machine has", async () => {
    expect(typeof (await hasIpv6Route(500))).toBe("boolean");
  });
});

describe("assetDialAddress", () => {
  it("prefers IPv4 even when IPv6 is on", () => {
    expect(assetDialAddress({ ipAddress: "10.1.1.1", ipv6Address: "2001:db8::1" }, true)).toBe("10.1.1.1");
  });
  it("uses the primary IPv6 only for an asset with no IPv4, and only while on", () => {
    expect(assetDialAddress({ ipAddress: null, ipv6Address: "2001:db8::1" }, true)).toBe("2001:db8::1");
    expect(assetDialAddress({ ipAddress: "  ", ipv6Address: "2001:db8::1" }, true)).toBe("2001:db8::1");
    expect(assetDialAddress({ ipAddress: null, ipv6Address: "2001:db8::1" }, false)).toBeNull();
  });
  it("is null with nothing to dial", () => {
    expect(assetDialAddress(null, true)).toBeNull();
    expect(assetDialAddress({}, true)).toBeNull();
  });
});

describe("urlHost / bareHost", () => {
  it("brackets an IPv6 literal and leaves IPv4 and names alone", () => {
    expect(urlHost("2001:db8::1")).toBe("[2001:db8::1]");
    expect(urlHost("10.0.0.1")).toBe("10.0.0.1");
    expect(urlHost("fgt.example.com")).toBe("fgt.example.com");
  });
  it("round-trips through new URL", () => {
    const u = new URL(`https://${urlHost("2001:db8::1")}:8443/api`);
    expect(bareHost(u.hostname)).toBe("2001:db8::1");
    expect(bareHost("10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("withoutIpv6", () => {
  it("drops every IPv6 fact and keeps the IPv4 ones", () => {
    const result = {
      subnets: [{ cidr: "10.0.0.0/24" }, { cidr: "2001:db8::/64" }],
      interfaceIps: [{ ipAddress: "10.0.0.1" }, { ipAddress: "2001:db8::1" }],
      dhcpEntries: [{ ipAddress: "10.0.0.9" }, { ipAddress: "2001:db8::9" }],
      deviceInventory: [{ macAddress: "aa", ipv6Address: "2001:db8::7" }, { macAddress: "bb" }],
      switchMacTable: [{ macAddress: "cc", ipv6Address: "2001:db8::8" }],
    } as unknown as DiscoveryResult;
    const out = withoutIpv6(result);
    expect(out.subnets.map((s) => s.cidr)).toEqual(["10.0.0.0/24"]);
    expect(out.interfaceIps.map((i) => i.ipAddress)).toEqual(["10.0.0.1"]);
    expect(out.dhcpEntries.map((e) => e.ipAddress)).toEqual(["10.0.0.9"]);
    expect(out.deviceInventory.every((d) => !d.ipv6Address)).toBe(true);
    expect(out.switchMacTable.every((r) => !r.ipv6Address)).toBe(true);
  });
});

describe("splitInterfaceAddresses with IPv6 off", () => {
  it("stores no IPv6, from either field", () => {
    expect(splitInterfaceAddresses("10.0.0.1", "2001:db8::1", false)).toEqual({ ipAddress: "10.0.0.1", ipv6Address: null });
    expect(splitInterfaceAddresses("2001:db8::1", null, false)).toEqual({ ipAddress: null, ipv6Address: null });
  });
  it("still splits while on", () => {
    expect(splitInterfaceAddresses("10.0.0.1", "2001:db8::1", true)).toEqual({ ipAddress: "10.0.0.1", ipv6Address: "2001:db8::1" });
  });
});

describe("loss sweep over IPv6", () => {
  const v6Only = { monitored: true, status: "active", ipAddress: null, ipv6Address: "2001:db8::1" };
  const eff = { responseTimePolling: "icmp" } as never;
  it("targets the primary IPv6 only while on", () => {
    expect(lossSweepTarget(v6Only, true)).toBe("2001:db8::1");
    expect(lossSweepTarget(v6Only, false)).toBeNull();
    expect(lossSweepIncludes(v6Only, eff, true, true)).toBe(true);
    expect(lossSweepIncludes(v6Only, eff, true, false)).toBe(false);
  });
});

describe("pickPrimaryIpv6", () => {
  const t = (s: string) => new Date(s);
  it("takes the best-evidenced address", () => {
    expect(pickPrimaryIpv6([
      { ip: "2001:db8::a", evidenceScore: 1, lastSeen: t("2026-10-22T10:00:00Z") },
      { ip: "2001:db8::b", evidenceScore: 3, lastSeen: t("2026-10-21T10:00:00Z") },
    ])).toBe("2001:db8::b");
  });
  it("breaks a tie on the newest sighting, then the smallest address", () => {
    expect(pickPrimaryIpv6([
      { ip: "2001:db8::a", evidenceScore: 2, lastSeen: t("2026-10-21T10:00:00Z") },
      { ip: "2001:db8::b", evidenceScore: 2, lastSeen: t("2026-10-22T10:00:00Z") },
    ])).toBe("2001:db8::b");
    const same = t("2026-10-22T10:00:00Z");
    expect(pickPrimaryIpv6([
      { ip: "2001:db8::b", evidenceScore: 2, lastSeen: same },
      { ip: "2001:db8::a", evidenceScore: 2, lastSeen: same },
    ])).toBe("2001:db8::a");
  });
  it("is null with no candidates", () => {
    expect(pickPrimaryIpv6([])).toBeNull();
  });
});
