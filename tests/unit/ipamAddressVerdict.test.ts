/**
 * tests/unit/ipamAddressVerdict.test.ts — what IPAM says about one discovered
 * DHCP address row (services/assetAddressService.ts →
 * judgeDhcpAddressAgainstIpam), business rule 102(a).
 */

import { describe, it, expect } from "vitest";
import { judgeDhcpAddressAgainstIpam } from "../../src/services/assetAddressService.js";

const MAC = "84:8B:CD:4C:45:40";
const lease = { mac: MAC, source: "dhcp-lease" };
const res = (over: Partial<{ macAddress: string | null; sourceType: string; pushStatus: string | null }> = {}) => ({
  macAddress: MAC, sourceType: "dhcp_lease", pushStatus: null, ...over,
});

describe("judgeDhcpAddressAgainstIpam", () => {
  it("keeps a row IPAM has no subnet for — no opinion is not a release", () => {
    expect(judgeDhcpAddressAgainstIpam(lease, false, null)).toEqual({ action: "keep" });
  });

  it("removes a row whose address IPAM no longer holds", () => {
    expect(judgeDhcpAddressAgainstIpam(lease, true, null).action).toBe("remove");
  });

  it("removes a row whose address IPAM gives to another MAC, naming it", () => {
    const v = judgeDhcpAddressAgainstIpam(lease, true, res({ macAddress: "aa-bb-cc-dd-ee-ff" }));
    expect(v).toEqual({ action: "remove", reason: "IPAM assigns this address to AA:BB:CC:DD:EE:FF" });
  });

  it("matches MACs across case and separator", () => {
    const v = judgeDhcpAddressAgainstIpam(lease, true, res({ macAddress: MAC.toLowerCase().replace(/:/g, "-") }));
    expect(v).toEqual({ action: "keep" });
  });

  it("keeps a row when the IPAM entry carries no MAC", () => {
    expect(judgeDhcpAddressAgainstIpam(lease, true, res({ macAddress: null }))).toEqual({ action: "keep" });
  });

  it("re-labels a lease IPAM now records as a reservation, and back", () => {
    expect(judgeDhcpAddressAgainstIpam(lease, true, res({ sourceType: "dhcp_reservation" })))
      .toEqual({ action: "relabel", source: "dhcp-reservation" });
    expect(judgeDhcpAddressAgainstIpam({ mac: MAC, source: "dhcp-reservation" }, true, res()))
      .toEqual({ action: "relabel", source: "dhcp-lease" });
  });

  it("treats a synced pushed reservation as a reservation, an unpushed manual one as no change", () => {
    expect(judgeDhcpAddressAgainstIpam(lease, true, res({ sourceType: "manual", pushStatus: "synced" })))
      .toEqual({ action: "relabel", source: "dhcp-reservation" });
    expect(judgeDhcpAddressAgainstIpam(lease, true, res({ sourceType: "manual", pushStatus: null })))
      .toEqual({ action: "keep" });
  });
});
