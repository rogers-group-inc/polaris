/**
 * tests/unit/mibReadiness.test.ts — naming what to upload (Phase 2 of uniform
 * SNMP).
 *
 * When a profile row's symbol does not resolve, the page has to say WHY in
 * words an operator can act on, and the only place that fact exists is the
 * IMPORTS block of the operator's own files: FORTINET-FORTISWITCH-MIB says
 * `fortinet FROM FORTINET-CORE-MIB`. Pinned here:
 *
 *   - `parseImportMap` reads symbol → module pairs out of an IMPORTS block
 *     (multi-line, several FROM clauses, macros included, no block at all).
 *   - `missingRootsForMib` names the module that defines each unresolved
 *     anchor of an uploaded MIB, from that MIB's own IMPORTS.
 *   - `symbolReadiness` reports a resolved symbol's provenance, and for an
 *     unresolved one distinguishes "the pinned MIB is missing an import" from
 *     "no loaded module defines this at all".
 *   - `createMib` returns the readiness figures with the stored row.
 *
 * Prisma is mocked; the registry is real and reads whatever rows a case sets.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  created: null as Record<string, unknown> | null,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    mibFile: {
      findMany: vi.fn(async () => h.rows),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        h.created = { id: "new-1", ...data, uploadedAt: new Date() };
        h.rows.push({ id: "new-1", moduleName: data.moduleName, manufacturer: data.manufacturer, model: data.model, contents: data.contents });
        return h.created;
      }),
    },
  },
}));

const { parseImportMap } = await import("../../src/services/mibParserUtils.js");
const registry = await import("../../src/services/oidRegistry.js");
const { createMib } = await import("../../src/services/mibService.js");

// A leaf module that hangs off an anchor it IMPORTs from a core module.
const ACME_LEAF = `
ACME-SWITCH-MIB DEFINITIONS ::= BEGIN
IMPORTS
    MODULE-IDENTITY, OBJECT-TYPE, Integer32
        FROM SNMPv2-SMI
    acme, AcmeBool
        FROM ACME-CORE-MIB;
acmeSwitchMib MODULE-IDENTITY
    LAST-UPDATED "202401010000Z"
    ::= { acme 106 }
acmeSwCpuUsage OBJECT-TYPE
    SYNTAX Integer32
    MAX-ACCESS read-only
    STATUS current
    ::= { acmeSwitchMib 1 }
END
`;

// The core module that defines the anchor, fully numeric so it needs nothing.
const ACME_CORE = `
ACME-CORE-MIB DEFINITIONS ::= BEGIN
acme OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 }
END
`;

function row(id: string, moduleName: string, contents: string, manufacturer: string | null = null) {
  return { id, moduleName, manufacturer, model: null, contents };
}

beforeEach(async () => {
  h.rows = [];
  h.created = null;
  await registry.refreshRegistry();
});

describe("parseImportMap", () => {
  it("pairs every imported symbol with the module it comes FROM", () => {
    const map = parseImportMap(ACME_LEAF);
    expect(map).toContainEqual({ symbol: "acme", module: "ACME-CORE-MIB" });
    expect(map).toContainEqual({ symbol: "AcmeBool", module: "ACME-CORE-MIB" });
    expect(map).toContainEqual({ symbol: "OBJECT-TYPE", module: "SNMPv2-SMI" });
    expect(map).toContainEqual({ symbol: "Integer32", module: "SNMPv2-SMI" });
  });

  it("returns nothing for a module with no IMPORTS block, and never throws", () => {
    expect(parseImportMap(ACME_CORE)).toEqual([]);
    expect(parseImportMap("")).toEqual([]);
    expect(parseImportMap("IMPORTS ;")).toEqual([]);
  });
});

describe("missingRootsForMib / definingModulesFor", () => {
  it("names the module that defines an unresolved anchor, from the file's own IMPORTS", async () => {
    h.rows = [row("leaf", "ACME-SWITCH-MIB", ACME_LEAF, "Acme")];
    await registry.refreshRegistry();
    expect(registry.missingRootsForMib("leaf")).toEqual([{ symbol: "acme", module: "ACME-CORE-MIB" }]);
    expect(registry.definingModulesFor("acme")).toEqual(["ACME-CORE-MIB"]);
  });

  it("reports nothing once the defining module is uploaded too", async () => {
    h.rows = [row("leaf", "ACME-SWITCH-MIB", ACME_LEAF, "Acme"), row("core", "ACME-CORE-MIB", ACME_CORE, "Acme")];
    await registry.refreshRegistry();
    expect(registry.missingRootsForMib("leaf")).toEqual([]);
    expect(registry.resolveOidSync("acmeSwCpuUsage", { manufacturer: "Acme" })).toBe("1.3.6.1.4.1.99999.106.1");
  });

  it("is empty for an unknown id", () => {
    expect(registry.missingRootsForMib("nope")).toEqual([]);
  });
});

describe("symbolReadiness", () => {
  it("reports provenance for a resolved symbol", async () => {
    h.rows = [row("leaf", "ACME-SWITCH-MIB", ACME_LEAF, "Acme"), row("core", "ACME-CORE-MIB", ACME_CORE, "Acme")];
    await registry.refreshRegistry();
    const r = registry.symbolReadiness("Acme", "acmeSwCpuUsage", "leaf");
    expect(r.resolved).toBe(true);
    expect(r.fromScope).toBe("vendor");
    expect(r.fromModuleName).toBe("ACME-SWITCH-MIB");
    expect(r.hint).toBeNull();
    // A standard symbol resolves for any manufacturer and says so.
    const std = registry.symbolReadiness("Acme", "ifHCInOctets");
    expect(std.resolved).toBe(true);
    expect(std.fromScope).toBe("standard");
  });

  it("blames the pinned MIB's missing import, naming the module to upload", async () => {
    h.rows = [row("leaf", "ACME-SWITCH-MIB", ACME_LEAF, "Acme")];
    await registry.refreshRegistry();
    const r = registry.symbolReadiness("Acme", "acmeSwCpuUsage", "leaf");
    expect(r.resolved).toBe(false);
    expect(r.hint).toEqual({
      kind: "imports",
      mibModuleName: "ACME-SWITCH-MIB",
      roots: [{ symbol: "acme", module: "ACME-CORE-MIB" }],
    });
  });

  it("says no module defines the symbol when nothing loaded mentions it", () => {
    const r = registry.symbolReadiness("Acme", "acmeSwCpuUsage");
    expect(r.resolved).toBe(false);
    expect(r.hint).toEqual({ kind: "no-module" });
  });
});

describe("createMib readiness figures", () => {
  it("returns symbol counts and the named missing import beside the stored row", async () => {
    const result = await createMib({ filename: "ACME-SWITCH-MIB.txt", contents: ACME_LEAF, manufacturer: "Acme" });
    expect(result.moduleName).toBe("ACME-SWITCH-MIB");
    expect(result.symbolCount).toBe(2);           // acmeSwitchMib, acmeSwCpuUsage
    expect(result.unresolvedCount).toBe(2);       // both hang off the missing anchor
    expect(result.unresolvedRoots).toEqual([{ symbol: "acme", module: "ACME-CORE-MIB" }]);
  });

  it("reports everything resolved when the module stands on its own", async () => {
    const result = await createMib({ filename: "ACME-CORE-MIB.txt", contents: ACME_CORE, manufacturer: "Acme" });
    expect(result.symbolCount).toBe(1);
    expect(result.unresolvedCount).toBe(0);
    expect(result.unresolvedRoots).toEqual([]);
  });
});
