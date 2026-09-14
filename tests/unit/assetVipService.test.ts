/**
 * tests/unit/assetVipService.test.ts — `parseVipInfo`, the guard between a
 * free-form `Reservation.vipInfo` JSON column and the General tab's VIP row.
 *
 * The column is written by discovery (discoveryEngine Phase 3c) but it is JSON
 * on a table operators can edit, and rows stamped by older discovery cycles
 * predate fields that exist now. The row it feeds answers "what external
 * address, on which firewall" — so a stamp missing either of those two names
 * must yield NOTHING rather than a row reading "VIP  on ".
 *
 * The DB half (containment, gate resolution) is tests/integration/assetVips.test.ts.
 */

import { describe, it, expect } from "vitest";
import { parseVipInfo } from "../../src/services/assetVipService.js";

const full = {
  name: "web-prod",
  device: "SITE-A-FGT-PRIMARY",
  extip: "203.0.113.10",
  role: "mapped",
  isVirtualServer: false,
};

describe("parseVipInfo", () => {
  it("passes a complete discovery stamp through", () => {
    expect(parseVipInfo(full)).toEqual(full);
  });

  it("rejects anything that isn't an object", () => {
    for (const v of [null, undefined, "", "vip", 7, [], [full]]) {
      expect(parseVipInfo(v)).toBeNull();
    }
  });

  it("rejects a stamp with no VIP name or no gate — it answers neither half", () => {
    expect(parseVipInfo({ ...full, name: "" })).toBeNull();
    expect(parseVipInfo({ ...full, name: "   " })).toBeNull();
    expect(parseVipInfo({ ...full, device: undefined })).toBeNull();
    expect(parseVipInfo({ ...full, device: 42 })).toBeNull();
  });

  it("keeps a VIP with no external address — the gate is still the other half", () => {
    expect(parseVipInfo({ ...full, extip: "" })).toMatchObject({ extip: null, name: "web-prod" });
    expect(parseVipInfo({ name: "v", device: "fw" })).toEqual({
      name: "v", device: "fw", extip: null, role: "mapped", isVirtualServer: false,
    });
  });

  it("trims the names, since they land in a link and a copy target", () => {
    expect(parseVipInfo({ ...full, name: "  web-prod  ", device: " FGT ", extip: " 203.0.113.10 " }))
      .toMatchObject({ name: "web-prod", device: "FGT", extip: "203.0.113.10" });
  });

  it("falls back to the internal reading for an unknown role, never inventing an external one", () => {
    // Understating is the safe direction: "maps to <ip>" is wrong-but-harmless
    // on an odd row, where "this address is the external side" would assert
    // something about the device's exposure that nothing checked.
    expect(parseVipInfo({ ...full, role: "something-new" })!.role).toBe("mapped");
    expect(parseVipInfo({ ...full, role: undefined })!.role).toBe("mapped");
    expect(parseVipInfo({ ...full, role: "external" })!.role).toBe("external");
    expect(parseVipInfo({ ...full, role: "realserver" })!.role).toBe("realserver");
  });

  it("treats isVirtualServer as strictly boolean true", () => {
    expect(parseVipInfo({ ...full, isVirtualServer: true })!.isVirtualServer).toBe(true);
    expect(parseVipInfo({ ...full, isVirtualServer: "true" })!.isVirtualServer).toBe(false);
    expect(parseVipInfo({ ...full, isVirtualServer: undefined })!.isVirtualServer).toBe(false);
  });
});
