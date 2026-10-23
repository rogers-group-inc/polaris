/**
 * tests/unit/oidRegistryProfileScope.test.ts — business rule 131: a profile's
 * symbols resolve where that profile's MIBs were uploaded.
 *
 * Vendor MIBs are scoped by manufacturer NAME. An asset that reaches a profile
 * through its "also applies when" `matchPattern` (an "Aruba Networks" switch
 * governed by the "HP" profile) carries a different name than the one the
 * operator uploaded the MIB under — and the one the profile page's readiness
 * reports against. Before rule 131 the collectors resolved at the asset's
 * scope only, so the page said READY and nothing was collected. What is pinned:
 *
 *   1. With `profileManufacturer`, a symbol the asset's scope cannot resolve is
 *      found at the profile's scope.
 *   2. The asset's own scope stays FIRST: a device-scoped upload for the
 *      asset's real manufacturer + model still wins over the profile's copy.
 *   3. Without `profileManufacturer` (or when it names the asset's own
 *      manufacturer), resolution is exactly what it was.
 *
 * Prisma is mocked: `mibFile.findMany` returns whatever rows a case needs.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../../src/db.js", () => ({
  prisma: {
    mibFile: { findMany: vi.fn(async () => h.rows) },
  },
}));

const registry = await import("../../src/services/oidRegistry.js");

// Fully numeric bodies, so neither needs anchors of its own.
const HP_MIB = `
HP-SWITCH-MIB DEFINITIONS ::= BEGIN
hpSwitchCpuStat OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 11 2 14 11 5 1 9 6 1 }
END
`;
// The same symbol at a different arc, uploaded for one Aruba model only.
const ARUBA_DEVICE_MIB = `
ARUBA-2930-MIB DEFINITIONS ::= BEGIN
hpSwitchCpuStat OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 47196 4 1 1 99 }
END
`;

function row(id: string, moduleName: string, contents: string, manufacturer: string | null = null, model: string | null = null) {
  return { id, moduleName, manufacturer, model, contents };
}

beforeEach(async () => {
  h.rows = [];
  await registry.refreshRegistry();
});

describe("profileManufacturer as the second resolve scope (rule 131)", () => {
  it("finds a profile's symbol for an asset that reached the profile by matchPattern", async () => {
    h.rows = [row("m1", "HP-SWITCH-MIB", HP_MIB, "HP")];
    await registry.refreshRegistry();

    const asset = { manufacturer: "Aruba Networks", model: "2530" };
    expect(registry.resolveOidSync("hpSwitchCpuStat", asset)).toBeNull();
    expect(registry.resolveOidSync("hpSwitchCpuStat", { ...asset, profileManufacturer: "HP" }))
      .toBe("1.3.6.1.4.1.11.2.14.11.5.1.9.6.1");
    await expect(registry.resolveOid("hpSwitchCpuStat", { ...asset, profileManufacturer: "HP" }))
      .resolves.toBe("1.3.6.1.4.1.11.2.14.11.5.1.9.6.1");
  });

  it("keeps the asset's own device-scoped upload first", async () => {
    h.rows = [
      row("m1", "HP-SWITCH-MIB", HP_MIB, "HP"),
      row("m2", "ARUBA-2930-MIB", ARUBA_DEVICE_MIB, "Aruba Networks", "2930F"),
    ];
    await registry.refreshRegistry();

    expect(registry.resolveOidSync("hpSwitchCpuStat", { manufacturer: "Aruba Networks", model: "2930F", profileManufacturer: "HP" }))
      .toBe("1.3.6.1.4.1.47196.4.1.1.99");
    // Another Aruba model has no device upload, so it falls to the profile's.
    expect(registry.resolveOidSync("hpSwitchCpuStat", { manufacturer: "Aruba Networks", model: "2530", profileManufacturer: "HP" }))
      .toBe("1.3.6.1.4.1.11.2.14.11.5.1.9.6.1");
  });

  it("changes nothing when the profile is the asset's own manufacturer, or none is named", async () => {
    h.rows = [row("m1", "HP-SWITCH-MIB", HP_MIB, "HP")];
    await registry.refreshRegistry();

    expect(registry.resolveOidSync("hpSwitchCpuStat", { manufacturer: "hp", model: null, profileManufacturer: "HP" }))
      .toBe("1.3.6.1.4.1.11.2.14.11.5.1.9.6.1");
    expect(registry.resolveOidSync("hpSwitchCpuStat", { manufacturer: "Juniper", model: null })).toBeNull();
    expect(registry.resolveOidSync("hpSwitchCpuStat", { manufacturer: "Juniper", model: null, profileManufacturer: null })).toBeNull();
    expect(registry.resolveOidSync("hpSwitchCpuStat", { manufacturer: "Juniper", model: null, profileManufacturer: "  " })).toBeNull();
  });

  it("standard symbols still resolve at the asset's scope with no profile involved", () => {
    expect(registry.resolveOidSync("sysDescr", { manufacturer: "Aruba Networks", profileManufacturer: "HP" }))
      .toBe("1.3.6.1.2.1.1.1");
  });
});
