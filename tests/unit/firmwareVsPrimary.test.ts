/**
 * tests/unit/firmwareVsPrimary.test.ts — the `firmwareVsPrimary` automation
 * field's pure half (business rule 87): which primary image the Repository
 * holds for an asset, and how the asset's running version stands against it.
 *
 * What is pinned is the NO-READING posture. A null here is what keeps
 * `!= current` from being true of every workstation, printer and VM in a
 * fleet-wide scope — the rule is about devices the Repository can place, and
 * nothing else — and the three cases that must each produce it are listed one
 * by one so a refactor that collapses them to "no image" fails loudly.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import { firmwareVsPrimary, primaryImageForAsset, type PrimaryImageLite } from "../../src/services/firmwareRepositoryService.js";

function img(over: Partial<PrimaryImageLite> = {}): PrimaryImageLite {
  return {
    manufacturer: "Fortinet", assetType: "switch", model: "FortiSwitch S108FF", platform: "S108FF",
    versionMajor: 7, versionMinor: 6, versionPatch: 8, build: 1164, versionLabel: "7.6.8 build1164",
    uploadedAt: new Date("2026-09-20T00:00:00Z"), ...over,
  };
}
const sw = (over: Record<string, unknown> = {}) => ({
  assetType: "switch", manufacturer: "Fortinet", model: "FortiSwitch S108FF", serialNumber: "S108FFTF23000001", osVersion: "7.4.3 build0542", ...over,
});

describe("firmwareVsPrimary", () => {
  it("reads older / current / newer against the platform's primary", () => {
    const primaries = [img()];
    expect(firmwareVsPrimary(sw(), primaries)).toBe("older");
    expect(firmwareVsPrimary(sw({ osVersion: "v7.6.8,build1164" }), primaries)).toBe("current");
    expect(firmwareVsPrimary(sw({ osVersion: "7.6.9 build1200" }), primaries)).toBe("newer");
  });

  it("an older image made primary reads NEWER on the fleet, not current", () => {
    // The field reports the difference; which side is right is the operator's
    // call, and the automation on `!= current` fires either way.
    expect(firmwareVsPrimary(sw({ osVersion: "7.6.8 build1164" }), [img({ versionMajor: 7, versionMinor: 6, versionPatch: 5, build: 1105 })])).toBe("newer");
  });

  it("matches on manufacturer, device type and the serial's platform prefix", () => {
    // The manufacturer goes through normalizeManufacturer (the alias map is
    // DB-backed and empty under this mock, so only the canonical name is
    // exercised here — the map itself is pinned in manufacturerNormalize's
    // own tests).
    const primaries = [img()];
    expect(firmwareVsPrimary(sw({ manufacturer: " Fortinet " }), primaries)).toBe("older");
    expect(firmwareVsPrimary(sw({ assetType: "access_point" }), primaries)).toBeNull();
    expect(firmwareVsPrimary(sw({ serialNumber: "S548DFTF19000001" }), primaries)).toBeNull();
    expect(firmwareVsPrimary(sw({ manufacturer: "Aruba" }), primaries)).toBeNull();
  });

  it("prefers the node named by the asset's own model when two nodes hold a matching primary", () => {
    const coarse = img({ model: "FortiSwitch", versionMajor: 7, versionMinor: 6, versionPatch: 9, build: 1200, uploadedAt: new Date("2026-09-24T00:00:00Z") });
    const own = img();
    expect(primaryImageForAsset(sw(), [coarse, own])).toBe(own);
    // No own node: the newest upload wins.
    expect(primaryImageForAsset(sw({ model: "FS-108F" }), [own, coarse])).toBe(coarse);
  });

  it("produces NO reading — null, not a word — for each device the Repository cannot place", () => {
    const primaries = [img()];
    expect(firmwareVsPrimary(sw({ assetType: "server" }), primaries)).toBeNull();           // not a switch / AP
    expect(firmwareVsPrimary(sw({ serialNumber: null }), primaries)).toBeNull();            // no serial → no platform
    expect(firmwareVsPrimary(sw({ serialNumber: "unknown" }), primaries)).toBeNull();       // rule 84 placeholder
    expect(firmwareVsPrimary(sw({ osVersion: null }), primaries)).toBeNull();               // no readable version
    expect(firmwareVsPrimary(sw({ osVersion: "FortiSwitchOS" }), primaries)).toBeNull();    // unparsable version
    expect(firmwareVsPrimary(sw(), [])).toBeNull();                                          // no primary at all
    expect(firmwareVsPrimary(sw(), [img({ platform: null })])).toBeNull();                   // filename-only image, never offered
    expect(firmwareVsPrimary(sw({ manufacturer: null }), primaries)).toBeNull();
  });

  it("reads a FortiAP's own version string", () => {
    const ap = { assetType: "access_point", manufacturer: "Fortinet", model: "FortiAP 231K", serialNumber: "FP231KTF24000001", osVersion: "FP231K-v7.4.3-build0542" };
    expect(firmwareVsPrimary(ap, [img({ assetType: "access_point", model: "FortiAP 231K", platform: "FP231K" })])).toBe("older");
  });
});
