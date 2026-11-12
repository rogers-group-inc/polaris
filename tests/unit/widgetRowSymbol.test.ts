/**
 * tests/unit/widgetRowSymbol.test.ts — a custom widget's symbol may name ONE
 * table row: `rPDU2PhaseStatusPower.2`.
 *
 * A scalar widget reads the first readable row of what it walks, so on an APC
 * rack PDU with two phases (L1, L2) only phase 1 could ever be shown
 * (2026-11-11). Pinned here:
 *
 *   - the registry resolves `<symbol>.<index…>` to the symbol's OID plus the
 *     index, at every entry point (resolveOid / resolveOidSync /
 *     symbolReadiness / resolveSymbolAtVendorScope), and only when the base
 *     symbol resolves;
 *   - a name the registry knows WHOLE is never split;
 *   - `readWidgetOid` GETs that exact instance (a walk below a leaf instance
 *     returns nothing) and returns one row keyed "", or none when the agent
 *     has no such instance; any other symbol is still walked.
 *
 * Prisma is mocked; the registry is real (the mibReadiness.test.ts harness).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("../../src/db.js", () => ({
  prisma: {
    mibFile: {
      findMany: vi.fn(async () => h.rows),
      findFirst: vi.fn(async () => null),
    },
  },
}));

const registry = await import("../../src/services/oidRegistry.js");

const PDU_MIB = `
ACME-PDU-MIB DEFINITIONS ::= BEGIN
IMPORTS
    OBJECT-TYPE, Integer32 FROM SNMPv2-SMI;
acmePdu OBJECT IDENTIFIER ::= { 1 3 6 1 4 1 99999 4 }
acmePhaseEntry OBJECT IDENTIFIER ::= { acmePdu 1 }
acmePhasePower OBJECT-TYPE
    SYNTAX Integer32
    MAX-ACCESS read-only
    STATUS current
    ::= { acmePhaseEntry 7 }
END
`;
const BASE = "1.3.6.1.4.1.99999.4.1.7";

beforeEach(async () => {
  h.rows = [{ id: "pdu", moduleName: "ACME-PDU-MIB", manufacturer: "Acme", model: null, contents: PDU_MIB }];
  await registry.refreshRegistry();
});

describe("a symbol naming one row", () => {
  it("resolves to the column OID plus the row index", async () => {
    expect(await registry.resolveOid("acmePhasePower", { manufacturer: "Acme" })).toBe(BASE);
    expect(await registry.resolveOid("acmePhasePower.2", { manufacturer: "Acme" })).toBe(BASE + ".2");
    expect(registry.resolveOidSync("acmePhasePower.1.3", { manufacturer: "Acme" })).toBe(BASE + ".1.3");
  });

  it("is ready for the readiness pill and the vendor-scope check", async () => {
    const r = registry.symbolReadiness("Acme", "acmePhasePower.2");
    expect(r.resolved).toBe(true);
    expect(r.oid).toBe(BASE + ".2");
    expect(r.fromModuleName).toBe("ACME-PDU-MIB");
    expect((await registry.resolveSymbolAtVendorScope("Acme", "acmePhasePower.2")).oid).toBe(BASE + ".2");
  });

  it("does not resolve when the base symbol does not", async () => {
    expect(await registry.resolveOid("noSuchColumn.2", { manufacturer: "Acme" })).toBeNull();
    expect(registry.symbolReadiness("Acme", "noSuchColumn.2").resolved).toBe(false);
  });

  it("only treats a purely numeric tail as a row", async () => {
    expect(registry.hasRowSuffix("acmePhasePower.2")).toBe(true);
    expect(registry.hasRowSuffix("acmePhasePower.1.3")).toBe(true);
    expect(registry.hasRowSuffix("acmePhasePower")).toBe(false);
    expect(registry.hasRowSuffix("acmePhasePower.x")).toBe(false);
    expect(registry.hasRowSuffix("acmePhasePower.")).toBe(false);
    expect(await registry.resolveOid("acmePhasePower.x", { manufacturer: "Acme" })).toBeNull();
  });
});

const { readWidgetOid } = await import("../../src/services/monitoringService.js");

describe("readWidgetOid", () => {
  function session(getValue: unknown) {
    return {
      get: vi.fn((oids: string[], cb: (e: Error | null, vbs: unknown[]) => void) =>
        cb(null, oids.map((oid) => ({ oid, type: 2, value: getValue })))),
      subtree: vi.fn((_oid: string, _rep: number, feed: (vbs: unknown[]) => void, done: (e?: Error) => void) => {
        feed([{ oid: BASE + ".1", type: 2, value: 41 }, { oid: BASE + ".2", type: 2, value: 34 }]);
        done();
      }),
    };
  }

  it("GETs the exact row for a row-suffixed symbol", async () => {
    const s = session(34);
    const rows = await readWidgetOid(s, BASE + ".2", "acmePhasePower.2");
    expect(s.get).toHaveBeenCalledWith([BASE + ".2"], expect.any(Function));
    expect(s.subtree).not.toHaveBeenCalled();
    expect([...rows.entries()]).toEqual([["", 34]]);
  });

  it("returns no row when the agent has no such instance", async () => {
    const rows = await readWidgetOid(session(null), BASE + ".9", "acmePhasePower.9");
    expect(rows.size).toBe(0);
  });

  it("still walks a plain symbol", async () => {
    const s = session(0);
    const rows = await readWidgetOid(s, BASE, "acmePhasePower");
    expect(s.subtree).toHaveBeenCalled();
    expect(s.get).not.toHaveBeenCalled();
    expect(rows.size).toBe(2);
  });
});
