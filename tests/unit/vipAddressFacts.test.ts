/**
 * tests/unit/vipAddressFacts.test.ts — the pure half of business rule 76.
 *
 * Four things here break silently in production and cannot be seen from a
 * passing page:
 *
 *  - a `firewall/vip` row arrives in three encodings (FortiOS REST direct, the
 *    FortiManager JSON-RPC fields-projected get, and the FortiManager REST
 *    proxy). A reader that handles one drops addresses from the others without
 *    erroring — which is how proxy-mode mapped IPs were lost once already;
 *  - `vipInfoDiffers` decides whether to WRITE. Reporting "changed" on
 *    equivalent input puts a write on every VIP address on every discover pass;
 *    reporting "unchanged" on a renamed VIP freezes the badge forever;
 *  - `decideVipDhcpBinding` must record the binding and NOTHING else. Flipping
 *    sourceType or stamping an expiry on a VIP row is what business rule 23
 *    forbids, and both would look correct in a unit that only checked the
 *    binding;
 *  - the Virtual Server classification is duplicated from fortimanagerService's
 *    `parseVipServerInfo` (that module cannot be imported from a pure util), so
 *    the two are pinned against each other here.
 */

import { describe, it, expect } from "vitest";
import {
  parseVipRow,
  vipIpRoles,
  vipInfoSnapshot,
  vipInfoDiffers,
  decideVipDhcpBinding,
} from "../../src/utils/vipAddressFacts.js";
import { parseVipServerInfo } from "../../src/services/fortimanagerService.js";

const GATE = "JEFFERSON-101F-1";

describe("parseVipRow", () => {
  it("reads the FortiOS REST encoding: plain extip, mappedip as { range }", () => {
    const parsed = parseVipRow(
      {
        name: "web-dnat",
        extip: "203.0.113.10",
        extintf: "wan1",
        mappedip: [{ range: "10.20.30.40" }, { range: "10.20.30.41" }],
      },
      GATE,
    );
    expect(parsed).toMatchObject({
      device: GATE,
      name: "web-dnat",
      extip: "203.0.113.10",
      mappedips: ["10.20.30.40", "10.20.30.41"],
      extintf: "wan1",
      isVirtualServer: false,
    });
  });

  it("reads the FortiManager encoding: single-element arrays and bare range strings", () => {
    const parsed = parseVipRow(
      {
        name: "web-dnat",
        extip: ["203.0.113.10"],
        extintf: ["wan1"],
        mappedip: ["10.20.30.40"],
      },
      GATE,
    );
    expect(parsed?.extip).toBe("203.0.113.10");
    expect(parsed?.extintf).toBe("wan1");
    expect(parsed?.mappedips).toEqual(["10.20.30.40"]);
  });

  it("takes the first address of a range on either side", () => {
    const parsed = parseVipRow(
      { name: "pool", extip: "203.0.113.10-203.0.113.20", mappedip: [{ range: "10.0.0.5-10.0.0.9" }] },
      GATE,
    );
    expect(parsed?.extip).toBe("203.0.113.10");
    expect(parsed?.mappedips).toEqual(["10.0.0.5"]);
  });

  it("returns null for a row with no name or no usable external address", () => {
    expect(parseVipRow({ extip: "203.0.113.10" }, GATE)).toBeNull();
    expect(parseVipRow({ name: "broken", extip: "" }, GATE)).toBeNull();
    expect(parseVipRow({ name: "broken" }, GATE)).toBeNull();
    expect(parseVipRow(null, GATE)).toBeNull();
  });

  it("classifies a load-balance virtual server and collapses its pool by IP", () => {
    const parsed = parseVipRow(
      {
        name: "lb-app",
        extip: "203.0.113.50",
        type: "server-load-balance",
        realservers: [
          { ip: "10.1.1.10", port: 80 },
          { ip: "10.1.1.10", port: 443 },
          { ip: "10.1.1.11", port: 80 },
        ],
      },
      GATE,
    );
    expect(parsed?.isVirtualServer).toBe(true);
    expect(parsed?.realservers).toEqual(["10.1.1.10", "10.1.1.11"]);
  });

  it("calls a row with a pool a virtual server even when the type string is an integer", () => {
    // FortiManager has returned CMDB enums as integers on some releases, which
    // is why the pool is the primary signal and the string only confirms.
    const parsed = parseVipRow(
      { name: "lb-app", extip: "203.0.113.50", type: 2, realservers: [{ ip: ["10.1.1.10"] }] },
      GATE,
    );
    expect(parsed?.isVirtualServer).toBe(true);
    expect(parsed?.realservers).toEqual(["10.1.1.10"]);
  });

  it("agrees with fortimanagerService.parseVipServerInfo on every shape", () => {
    const rows: unknown[] = [
      { name: "a", extip: "203.0.113.1" },
      { name: "b", extip: "203.0.113.2", type: "server-load-balance" },
      { name: "c", extip: "203.0.113.3", realservers: [{ ip: "10.0.0.1" }] },
      { name: "d", extip: "203.0.113.4", realservers: [{ ip: ["10.0.0.2"] }, { ip: "10.0.0.2" }] },
      { name: "e", extip: "203.0.113.5", realservers: [] },
    ];
    for (const row of rows) {
      const mine = parseVipRow(row, GATE);
      const theirs = parseVipServerInfo(row);
      expect(mine?.isVirtualServer).toBe(theirs.isVirtualServer);
      expect(mine?.realservers).toEqual(theirs.realservers);
    }
  });
});

describe("vipIpRoles", () => {
  const vip = {
    device: GATE,
    name: "web-dnat",
    extip: "203.0.113.10",
    mappedips: ["10.20.30.40"],
    realservers: ["10.20.30.41"],
    extintf: "wan1",
    isVirtualServer: false,
  };

  it("names every address the VIP puts on the map, external first", () => {
    expect(vipIpRoles(vip)).toEqual([
      { ip: "203.0.113.10", role: "external" },
      { ip: "10.20.30.40", role: "mapped" },
      { ip: "10.20.30.41", role: "realserver" },
    ]);
  });

  it("keeps the first role for a hairpin address rather than listing it twice", () => {
    const hairpin = { ...vip, mappedips: ["203.0.113.10"], realservers: [] };
    expect(vipIpRoles(hairpin)).toEqual([{ ip: "203.0.113.10", role: "external" }]);
  });
});

describe("vipInfoDiffers", () => {
  const vip = {
    device: GATE,
    name: "web-dnat",
    extip: "203.0.113.10",
    mappedips: [],
    realservers: [],
    extintf: "wan1",
    isVirtualServer: false,
  };
  const snap = vipInfoSnapshot(vip, "external");

  it("is false against its own snapshot, so a steady VIP writes nothing", () => {
    expect(vipInfoDiffers({ ...snap }, snap)).toBe(false);
  });

  it("ignores extra keys an older row may carry", () => {
    expect(vipInfoDiffers({ ...snap, legacyField: 1 }, snap)).toBe(false);
  });

  it("is true for an absent or non-object stored value", () => {
    expect(vipInfoDiffers(null, snap)).toBe(true);
    expect(vipInfoDiffers(undefined, snap)).toBe(true);
    expect(vipInfoDiffers("vip", snap)).toBe(true);
  });

  it("catches a rename, a move to another gate, a role change and a re-pointed external", () => {
    expect(vipInfoDiffers({ ...snap, name: "web-dnat-old" }, snap)).toBe(true);
    expect(vipInfoDiffers({ ...snap, device: "GLENROSE-61F-1" }, snap)).toBe(true);
    expect(vipInfoDiffers({ ...snap, role: "mapped" }, snap)).toBe(true);
    expect(vipInfoDiffers({ ...snap, extip: "203.0.113.99" }, snap)).toBe(true);
    expect(vipInfoDiffers({ ...snap, isVirtualServer: true }, snap)).toBe(true);
  });

  it("treats a missing isVirtualServer as false rather than as changed", () => {
    const { isVirtualServer: _drop, ...withoutFlag } = snap as Record<string, unknown>;
    expect(vipInfoDiffers(withoutFlag, snap)).toBe(false);
  });
});

describe("decideVipDhcpBinding", () => {
  it("records a dynamic lease on a VIP row", () => {
    expect(
      decideVipDhcpBinding({ sourceType: "vip" }, { type: "dhcp-lease" }),
    ).toEqual({ dhcpBinding: "lease" });
  });

  it("records a real MAC-to-IP binding on a VIP row", () => {
    expect(
      decideVipDhcpBinding({ sourceType: "vip" }, { type: "dhcp-reservation" }),
    ).toEqual({ dhcpBinding: "reservation" });
  });

  it("returns null when nothing changed, so a steady row is never written", () => {
    expect(
      decideVipDhcpBinding({ sourceType: "vip", dhcpBinding: "lease", macAddress: "AA:BB:CC:DD:EE:FF" }, { type: "dhcp-lease", macAddress: "aa-bb-cc-dd-ee-ff" }),
    ).toBeNull();
  });

  it("fills a blank MAC from the DHCP entry and never overwrites one", () => {
    expect(
      decideVipDhcpBinding({ sourceType: "vip", dhcpBinding: "lease" }, { type: "dhcp-lease", macAddress: "aa-bb-cc-dd-ee-ff" }),
    ).toEqual({ macAddress: "AA:BB:CC:DD:EE:FF" });
    expect(
      decideVipDhcpBinding(
        { sourceType: "vip", dhcpBinding: "lease", macAddress: "11:22:33:44:55:66" },
        { type: "dhcp-lease", macAddress: "aa:bb:cc:dd:ee:ff" },
      ),
    ).toBeNull();
  });

  it("never stages sourceType or an expiry (business rule 23's two forbidden writes)", () => {
    const patch = decideVipDhcpBinding(
      { sourceType: "vip" },
      { type: "dhcp-reservation", macAddress: "aa:bb:cc:dd:ee:ff" },
    );
    expect(patch).not.toBeNull();
    expect(Object.keys(patch!).sort()).toEqual(["dhcpBinding", "macAddress"]);
  });

  it("declines any row that is not a VIP, so it cannot touch a lease or an infra row", () => {
    expect(decideVipDhcpBinding({ sourceType: "dhcp_lease" }, { type: "dhcp-lease" })).toBeNull();
    expect(decideVipDhcpBinding({ sourceType: "fortinap" }, { type: "dhcp-lease" })).toBeNull();
    expect(decideVipDhcpBinding({ sourceType: "manual" }, { type: "dhcp-reservation" })).toBeNull();
  });
});
