/**
 * tests/unit/releasedAddressVerdict.test.ts — what a DHCP release sent to the
 * gate does to one asset's primary address (services/assetAddressService.ts →
 * judgeReleasedAddress), business rule 102(b).
 */

import { describe, it, expect } from "vitest";
import { judgeReleasedAddress } from "../../src/services/assetAddressService.js";

const IP = "10.20.0.15";
const asset = (over: Partial<Parameters<typeof judgeReleasedAddress>[0]> = {}) => ({
  ipAddress: IP, assetType: "workstation", ipOverride: null, ipBlankPinned: false, primaryAddressMac: null, ...over,
});

describe("judgeReleasedAddress", () => {
  it("moves an unpinned endpoint off the released address when nothing else reports it", () => {
    expect(judgeReleasedAddress(asset(), IP, [])).toEqual({ action: "move" });
  });

  it("leaves an asset whose primary address is something else", () => {
    expect(judgeReleasedAddress(asset({ ipAddress: "10.20.0.99" }), IP, [])).toEqual({ action: "keep", reason: "not-primary" });
  });

  it("never overrules an operator pin of any kind", () => {
    expect(judgeReleasedAddress(asset({ ipOverride: IP }), IP, [])).toMatchObject({ action: "keep", reason: "pinned" });
    expect(judgeReleasedAddress(asset({ ipBlankPinned: true }), IP, [])).toMatchObject({ action: "keep", reason: "pinned" });
    expect(judgeReleasedAddress(asset({ primaryAddressMac: "AA:BB:CC:DD:EE:FF" }), IP, [])).toMatchObject({ action: "keep", reason: "pinned" });
  });

  it("leaves Fortinet infra on its management address", () => {
    for (const assetType of ["firewall", "switch", "access_point"]) {
      expect(judgeReleasedAddress(asset({ assetType }), IP, [])).toMatchObject({ action: "keep", reason: "infra" });
    }
  });

  it("keeps the address while the device itself or an operator still lists it", () => {
    expect(judgeReleasedAddress(asset(), IP, ["monitor-system-info"])).toMatchObject({ action: "keep", reason: "device-reports-it" });
    expect(judgeReleasedAddress(asset(), IP, ["manual"])).toMatchObject({ action: "keep", reason: "device-reports-it" });
  });
});
