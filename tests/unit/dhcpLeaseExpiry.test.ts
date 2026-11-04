import { describe, it, expect } from "vitest";
import { dhcpExpiryPatch } from "../../src/utils/dhcpLeaseExpiry.js";

const T = new Date("2026-11-04T12:00:00Z");
const later = (ms: number) => new Date(T.getTime() + ms);

describe("dhcpExpiryPatch", () => {
  it("moves a renewed lease's expiry to the gate's new lease end", () => {
    expect(dhcpExpiryPatch(T, "dhcp_lease", later(12 * 3600_000))).toEqual({ expiresAt: later(12 * 3600_000) });
  });

  it("writes nothing when the lease end is unchanged or within jitter", () => {
    expect(dhcpExpiryPatch(T, "dhcp_lease", T)).toBeNull();
    expect(dhcpExpiryPatch(T, "dhcp_lease", later(30_000))).toBeNull();
  });

  it("stamps a lease row that has no expiry yet", () => {
    expect(dhcpExpiryPatch(null, "dhcp_lease", T)).toEqual({ expiresAt: T });
  });

  it("leaves a lease alone when the gate reported no lease end", () => {
    expect(dhcpExpiryPatch(T, "dhcp_lease", undefined)).toBeNull();
    expect(dhcpExpiryPatch(T, "dhcp_lease", new Date(NaN))).toBeNull();
  });

  it("clears the expiry when a lease becomes a reservation or infra row", () => {
    expect(dhcpExpiryPatch(T, "dhcp_reservation", undefined)).toEqual({ expiresAt: null });
    expect(dhcpExpiryPatch(T, "fortiswitch", undefined)).toEqual({ expiresAt: null });
  });

  it("writes nothing for a reservation that already never expires", () => {
    expect(dhcpExpiryPatch(null, "dhcp_reservation", undefined)).toBeNull();
  });
});
