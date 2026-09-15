/**
 * tests/unit/oidRegistryStandardLayer.test.ts — the bundled standard MIBs are
 * the registry's base layer (Phase 1 of uniform SNMP).
 *
 * Until 2026-09 the eleven IETF/IEEE modules under src/services/stdMibs/ fed
 * ONLY the Browse/Walk UI (stdMibLibrary); the probe-path resolver read the
 * database and a hardcoded seed and nothing else, so `ifHCInOctets` did not
 * resolve by name on an install that had uploaded nothing. What is pinned
 * here:
 *
 *   1. Standard symbols resolve with an EMPTY MibFile table, and say where
 *      they came from (`fromScope: "standard"`, the module name).
 *   2. The modules resolve TOGETHER — Q-BRIDGE-MIB finds BRIDGE-MIB's
 *      `dot1dBridge` with nothing seeded by hand (the seed no longer carries
 *      it).
 *   3. An uploaded generic module of the same name OVERRIDES the shipped one,
 *      so an operator can carry a newer IF-MIB than Polaris bundles.
 *   4. A model with no device-scoped upload SHARES its manufacturer's scope
 *      map — the cache holds a handful of maps at fleet scale, not one per
 *      model.
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

// A tiny generic-scope upload that redefines one IF-MIB symbol at a different
// arc. Fully numeric body so it needs no anchors of its own.
const IF_MIB_OVERRIDE = `
IF-MIB DEFINITIONS ::= BEGIN
ifHCInOctets OBJECT IDENTIFIER ::= { 1 3 6 1 2 1 31 1 1 1 99 }
END
`;

// A vendor-scoped upload (manufacturer only) and a device-scoped one.
const VENDOR_MIB = `
ACME-MIB DEFINITIONS ::= BEGIN
acmeCpu OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 1 1 }
END
`;
const DEVICE_MIB = `
ACME-X1-MIB DEFINITIONS ::= BEGIN
acmeX1Fan OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 2 1 }
END
`;

function row(id: string, moduleName: string, contents: string, manufacturer: string | null = null, model: string | null = null) {
  return { id, moduleName, manufacturer, model, contents };
}

beforeEach(async () => {
  h.rows = [];
  await registry.refreshRegistry();
});

describe("oidRegistry — standard layer", () => {
  it("resolves standard symbols with an empty MibFile table, attributed to their module", async () => {
    const ifHC = await registry.resolveSymbolAtVendorScope("Nobody", "ifHCInOctets");
    expect(ifHC.resolved).toBe(true);
    expect(ifHC.oid).toBe("1.3.6.1.2.1.31.1.1.1.6");
    expect(ifHC.fromScope).toBe("standard");
    expect(ifHC.fromModuleName).toBe("IF-MIB");

    expect(registry.resolveOidSync("hrStorageUsed", {})).toBe("1.3.6.1.2.1.25.2.3.1.6");
    expect(registry.resolveOidSync("ipNetToPhysicalPhysAddress", {})).toBe("1.3.6.1.2.1.4.35.1.4");
    expect(registry.resolveOidSync("lldpRemSysName", {})).toBe("1.0.8802.1.1.2.1.4.1.1.9");
  });

  it("resolves the bundled modules together — Q-BRIDGE finds BRIDGE-MIB's anchor unseeded", () => {
    // dot1dBridge left BUILT_IN_OIDS in Phase 1. If Q-BRIDGE-MIB still
    // resolves, the standard layer's cross-module fixpoint is doing the work
    // the seed used to do.
    expect(registry.BUILT_IN_OIDS.dot1dBridge).toBeUndefined();
    expect(registry.BUILT_IN_OIDS.dot1dStp).toBeUndefined();
    expect(registry.resolveOidSync("dot1qTpFdbPort", {})).toBe("1.3.6.1.2.1.17.7.1.2.2.1.2");
    expect(registry.resolveOidSync("dot1dStpPortState", {})).toBe("1.3.6.1.2.1.17.2.15.1.3");
  });

  it("exposes the whole standard table for stdMibLibrary, seed arcs included", () => {
    const std = registry.resolveStandardSymbols();
    expect(std.get("ifHCInOctets")).toBe("1.3.6.1.2.1.31.1.1.1.6");
    expect(std.get("mib-2")).toBe("1.3.6.1.2.1");
    // Order of magnitude: eleven RFC modules carry ~1000 assignments.
    expect(std.size).toBeGreaterThan(600);
  });

  it("lets an uploaded generic module override the shipped standard", async () => {
    h.rows = [row("m1", "IF-MIB", IF_MIB_OVERRIDE)];
    await registry.refreshRegistry();
    const r = await registry.resolveSymbolAtVendorScope("Nobody", "ifHCInOctets");
    expect(r.oid).toBe("1.3.6.1.2.1.31.1.1.1.99");
    expect(r.fromScope).toBe("generic");
    expect(r.fromModuleName).toBe("IF-MIB");
    // Everything the override did NOT redefine is still the shipped standard.
    expect(registry.resolveOidSync("ifHCOutOctets", {})).toBe("1.3.6.1.2.1.31.1.1.1.10");
  });

  it("shares one scope map across models that have no device-scoped upload", async () => {
    h.rows = [row("v1", "ACME-MIB", VENDOR_MIB, "Acme")];
    await registry.refreshRegistry();
    const before = registry.scopeCacheStats().scopes;
    // Three models, none with a MIB of its own → all three read the vendor map.
    expect(registry.resolveOidSync("acmeCpu", { manufacturer: "Acme", model: "X1" })).toBe("1.3.6.1.4.1.99999.1.1");
    expect(registry.resolveOidSync("acmeCpu", { manufacturer: "Acme", model: "X2" })).toBe("1.3.6.1.4.1.99999.1.1");
    expect(registry.resolveOidSync("acmeCpu", { manufacturer: "Acme", model: "X3" })).toBe("1.3.6.1.4.1.99999.1.1");
    expect(registry.scopeCacheStats().scopes - before).toBe(1);
  });

  it("still builds a distinct map for a model that HAS a device-scoped upload", async () => {
    h.rows = [
      row("v1", "ACME-MIB", VENDOR_MIB, "Acme"),
      row("d1", "ACME-X1-MIB", DEVICE_MIB, "Acme", "X1"),
    ];
    await registry.refreshRegistry();
    const before = registry.scopeCacheStats().scopes;
    expect(registry.resolveOidSync("acmeX1Fan", { manufacturer: "Acme", model: "X1" })).toBe("1.3.6.1.4.1.99999.2.1");
    expect(registry.resolveOidSync("acmeX1Fan", { manufacturer: "Acme", model: "X2" })).toBeNull();
    // X1 got its own map; X2 fell back to (and created) the vendor map.
    expect(registry.scopeCacheStats().scopes - before).toBe(2);
    // The device-scoped model still sees the vendor and standard layers.
    expect(registry.resolveOidSync("acmeCpu", { manufacturer: "Acme", model: "X1" })).toBe("1.3.6.1.4.1.99999.1.1");
    expect(registry.resolveOidSync("ifHCInOctets", { manufacturer: "Acme", model: "X1" })).toBe("1.3.6.1.2.1.31.1.1.1.6");
  });
});
