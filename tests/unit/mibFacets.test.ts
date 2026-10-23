/**
 * tests/unit/mibFacets.test.ts — `getMibFacets`, the data behind the MIB
 * upload form's Manufacturer and Model pickers.
 *
 * A vendor MIB only resolves for assets whose manufacturer matches the name it
 * was uploaded under, so the picker leads with the manufacturers actually in
 * inventory and shows each one's device count ("· 8 devices", the same figure
 * the Manufacturer Profiles picker shows). The risks are the counts lying —
 * per-model rows not summed into their manufacturer, a MIB-only name picking
 * up a count, whitespace variants splitting one vendor in two. Prisma is
 * mocked; the shaping is what's under test.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mibFindMany = vi.fn();
const assetGroupBy = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: {
    mibFile: { findMany: (...a: unknown[]) => mibFindMany(...a) },
    asset: { groupBy: (...a: unknown[]) => assetGroupBy(...a) },
  },
}));

const { getMibFacets } = await import("../../src/services/mibService.js");

beforeEach(() => {
  mibFindMany.mockReset();
  assetGroupBy.mockReset();
});

describe("getMibFacets", () => {
  it("sums each manufacturer's per-model asset rows into one device count", async () => {
    mibFindMany.mockResolvedValue([]);
    assetGroupBy.mockResolvedValue([
      { manufacturer: "APC by Schneider Electric", model: "Smart-UPS 1500", _count: { _all: 5 } },
      { manufacturer: "APC by Schneider Electric", model: "Smart-UPS 3000", _count: { _all: 3 } },
      { manufacturer: "Fortinet", model: null, _count: { _all: 2 } },
    ]);

    const out = await getMibFacets();
    expect(out.assetCounts).toEqual({ "APC by Schneider Electric": 8, Fortinet: 2 });
    expect(out.modelsByManufacturer["APC by Schneider Electric"]).toEqual(["Smart-UPS 1500", "Smart-UPS 3000"]);
  });

  it("lists a MIB-only manufacturer without giving it a device count", async () => {
    mibFindMany.mockResolvedValue([{ manufacturer: "APC", model: null }]);
    assetGroupBy.mockResolvedValue([
      { manufacturer: "Fortinet", model: "FortiGate-60F", _count: { _all: 4 } },
    ]);

    const out = await getMibFacets();
    expect(out.manufacturers).toEqual(["APC", "Fortinet"]);
    expect(out.assetCounts).toEqual({ Fortinet: 4 });
  });

  it("folds whitespace variants of one name into a single count", async () => {
    mibFindMany.mockResolvedValue([]);
    assetGroupBy.mockResolvedValue([
      { manufacturer: "Dell", model: "R740", _count: { _all: 2 } },
      { manufacturer: "Dell ", model: "R750", _count: { _all: 1 } },
    ]);

    const out = await getMibFacets();
    expect(out.manufacturers).toEqual(["Dell"]);
    expect(out.assetCounts).toEqual({ Dell: 3 });
  });

  it("counts by groupBy, never by loading asset rows", async () => {
    mibFindMany.mockResolvedValue([]);
    assetGroupBy.mockResolvedValue([]);

    await getMibFacets();
    expect(assetGroupBy).toHaveBeenCalledWith(expect.objectContaining({
      by: ["manufacturer", "model"],
      where: { manufacturer: { not: null } },
    }));
  });
});
