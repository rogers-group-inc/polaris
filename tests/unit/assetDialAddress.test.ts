/**
 * tests/unit/assetDialAddress.test.ts
 *
 * Business rule 128: IPv4 first, always; IPv6 only for an asset with no IPv4
 * and only while IPv6 is on. ipv6Gate.test.ts covers the gate service; this
 * pins the pure picker.
 */

import { describe, it, expect } from "vitest";
import { assetDialAddress } from "../../src/utils/assetDialAddress.js";

describe("assetDialAddress", () => {
  it("prefers IPv4 even when IPv6 is allowed and present", () => {
    expect(assetDialAddress({ ipAddress: "10.0.0.1", ipv6Address: "2001:db8::1" }, true)).toBe("10.0.0.1");
  });

  it("trims the address", () => {
    expect(assetDialAddress({ ipAddress: "  10.0.0.1 " }, false)).toBe("10.0.0.1");
    expect(assetDialAddress({ ipAddress: null, ipv6Address: " 2001:db8::1 " }, true)).toBe("2001:db8::1");
  });

  it("falls back to IPv6 only when there is no IPv4 and IPv6 is enabled", () => {
    expect(assetDialAddress({ ipAddress: null, ipv6Address: "2001:db8::1" }, true)).toBe("2001:db8::1");
    expect(assetDialAddress({ ipAddress: "", ipv6Address: "2001:db8::1" }, false)).toBeNull();
  });

  it("treats a whitespace-only IPv4 as absent", () => {
    expect(assetDialAddress({ ipAddress: "   ", ipv6Address: "fe80::1" }, true)).toBe("fe80::1");
  });

  it("returns null when nothing is dialable", () => {
    expect(assetDialAddress(null, true)).toBeNull();
    expect(assetDialAddress(undefined, true)).toBeNull();
    expect(assetDialAddress({}, true)).toBeNull();
    expect(assetDialAddress({ ipAddress: null, ipv6Address: "  " }, true)).toBeNull();
  });
});
