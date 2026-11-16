/**
 * tests/unit/monitoringDial.test.ts — business rule 128: every stream dials an
 * asset's IPv4, else — only while IPv6 is on for the install — its primary
 * IPv6. dial() is the service-side wrapper that reads the install switch.
 * The pure picker is pinned by tests/unit/assetDialAddress.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const gate = vi.hoisted(() => ({ dialable: false }));
vi.mock("../../src/services/ipv6GateService.js", () => ({ ipv6Dialable: () => gate.dialable }));

import { dial } from "../../src/services/monitoring/dial.js";

beforeEach(() => {
  gate.dialable = false;
});

describe("dial", () => {
  it("dials the IPv4 whenever there is one, IPv6 on or off", () => {
    expect(dial({ ipAddress: "10.0.0.5", ipv6Address: "2001:db8::5" })).toBe("10.0.0.5");
    gate.dialable = true;
    expect(dial({ ipAddress: "10.0.0.5", ipv6Address: "2001:db8::5" })).toBe("10.0.0.5");
  });

  it("falls back to the IPv6 only while the install has IPv6 on", () => {
    expect(dial({ ipAddress: null, ipv6Address: "2001:db8::5" })).toBeNull();
    gate.dialable = true;
    expect(dial({ ipAddress: null, ipv6Address: "2001:db8::5" })).toBe("2001:db8::5");
  });

  it("treats a blank IPv4 as absent and trims what it dials", () => {
    gate.dialable = true;
    expect(dial({ ipAddress: "  ", ipv6Address: " fe80::1 " })).toBe("fe80::1");
    expect(dial({ ipAddress: " 10.0.0.5 " })).toBe("10.0.0.5");
  });

  it("is null when the asset has no address at all", () => {
    gate.dialable = true;
    expect(dial({})).toBeNull();
    expect(dial({ ipAddress: null, ipv6Address: "" })).toBeNull();
  });

  it("reads the install switch on every call, not once", () => {
    const asset = { ipv6Address: "2001:db8::9" };
    expect(dial(asset)).toBeNull();
    gate.dialable = true;
    expect(dial(asset)).toBe("2001:db8::9");
    gate.dialable = false;
    expect(dial(asset)).toBeNull();
  });
});
