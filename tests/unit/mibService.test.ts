/**
 * tests/unit/mibService.test.ts — the own suite for src/services/mibService.ts
 * (CQ-T010).
 *
 * Complements the narrower suites (mibParseStructured, mibFacets, mibUploadLimit,
 * mibReadiness, mibWalkAsset). Pins in one place:
 *   - parseMib: the upload gate — empty, oversize (413), BOM, control bytes,
 *     the header (incl. SNMPv2-style mixed-case names), the END terminator,
 *     IMPORTS (deduped, comments ignored);
 *   - parseMibStructured: the four macro kinds, OID shorthand, SYNTAX base
 *     types, enums, access/status, DESCRIPTION quoting + cap, INDEX/IMPLIED,
 *     table detection and column order;
 *   - the CRUD: listMibs' where building, getMib / findMibWalkAsset 404s,
 *     createMib's validation, duplicate 409, stored shape, the readiness
 *     figures and a failing registry refresh, deleteMib's 404 + refresh;
 *   - getMibFacets: union of MIB + inventory facets, trimming, counts.
 *
 * The OID registry is mocked; no Prisma touches a database (_dbStub).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  refresh: vi.fn(),
  resolve: vi.fn(),
  missing: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/oidRegistry.js", () => ({
  refreshRegistry: h.refresh,
  resolveSymbolsForMib: h.resolve,
  missingRootsForMib: h.missing,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  MIB_MAX_BYTES,
  parseMib,
  parseMibStructured,
  listMibs,
  getMib,
  createMib,
  findMibWalkAsset,
  deleteMib,
  getMibFacets,
} from "../../src/services/mibService.js";

const flush = () => new Promise((r) => setTimeout(r, 0));

const MINI = [
  "TEST-MIB DEFINITIONS ::= BEGIN",
  "IMPORTS",
  "  enterprises FROM SNMPv2-SMI",
  "  DisplayString FROM SNMPv2-TC;",
  "testRoot OBJECT IDENTIFIER ::= { enterprises 99 }",
  "END",
].join("\n");

const FULL = String.raw`ACME-MIB DEFINITIONS ::= BEGIN

IMPORTS
    MODULE-IDENTITY, OBJECT-TYPE, NOTIFICATION-TYPE, Integer32, Counter64, enterprises
        FROM SNMPv2-SMI
    DisplayString
        FROM SNMPv2-TC
    OBJECT-TYPE
        FROM SNMPv2-SMI;  -- duplicate import module, deduped

acme MODULE-IDENTITY
    LAST-UPDATED "202601010000Z"
    ORGANIZATION "Acme"
    CONTACT-INFO "x"
    DESCRIPTION "The Acme MIB."
    ::= { enterprises 4242 }

acmeObjects OBJECT IDENTIFIER ::= { acme 1 }

acmeStatus OBJECT-TYPE
    SYNTAX      INTEGER { ok(1), degraded(2), failed(3) }
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "Overall ""health"" of
                 the unit."
    ::= { acmeObjects 1 }

acmeName OBJECT-TYPE
    SYNTAX      DisplayString
    ACCESS      read-write
    STATUS      deprecated
    DESCRIPTION "Name."
    ::= { acmeObjects 2 }

acmePortTable OBJECT-TYPE
    SYNTAX      SEQUENCE OF AcmePortEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "Ports."
    ::= { acmeObjects 3 }

acmePortEntry OBJECT-TYPE
    SYNTAX      AcmePortEntry
    MAX-ACCESS  not-accessible
    STATUS      current
    DESCRIPTION "A port."
    INDEX       { acmePortIndex, IMPLIED acmePortName }
    ::= { acmePortTable 1 }

AcmePortEntry ::= SEQUENCE {
    acmePortIndex Integer32,
    acmePortOctets Counter64
}

acmePortOctets OBJECT-TYPE
    SYNTAX      Counter64
    MAX-ACCESS  read-only
    STATUS      current
    DESCRIPTION "Octets."
    ::= { acmePortEntry 3 }

acmePortIndex OBJECT-TYPE
    SYNTAX      Integer32 (1..65535)
    MAX-ACCESS  not-accessible
    STATUS      bogus
    DESCRIPTION "Index."
    ::= { acmePortEntry 1 }

acmeTrap NOTIFICATION-TYPE
    OBJECTS     { acmeStatus }
    STATUS      current
    DESCRIPTION "Status changed."
    ::= { acme 0 1 }

END
`;

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(h)) f.mockReset();
  h.refresh.mockResolvedValue(undefined);
  h.resolve.mockResolvedValue(null);
  h.missing.mockReturnValue([]);
});

// ─── parseMib ───────────────────────────────────────────────────────────────

describe("parseMib", () => {
  const status = (fn: () => unknown): number | undefined => {
    try { fn(); } catch (e) { return (e as AppError).httpStatus; }
    return undefined;
  };

  it("reads the module name and the imported modules in order", () => {
    expect(parseMib(MINI)).toEqual({ moduleName: "TEST-MIB", imports: ["SNMPv2-SMI", "SNMPv2-TC"], cleanText: MINI });
  });

  it("dedupes imports", () => {
    expect(parseMib(FULL).imports).toEqual(["SNMPv2-SMI", "SNMPv2-TC"]);
  });

  it("a module with no IMPORTS block has none", () => {
    expect(parseMib("X-MIB DEFINITIONS ::= BEGIN\nEND").imports).toEqual([]);
  });

  it("strips a UTF-8 BOM from the stored text", () => {
    expect(parseMib("﻿" + MINI).cleanText).toBe(MINI);
  });

  it("accepts the SNMPv2 mixed-case header and DEFINITIONS tags", () => {
    expect(parseMib("SNMPv2-TC DEFINITIONS IMPLICIT TAGS ::= BEGIN\nEND").moduleName).toBe("SNMPv2-TC");
  });

  it("tolerates CRLF line endings and tabs", () => {
    expect(parseMib(MINI.replace(/\n/g, "\r\n").replace(/  /g, "\t")).moduleName).toBe("TEST-MIB");
  });

  it("refuses an empty file (and a BOM-only one) with 400", () => {
    expect(status(() => parseMib(""))).toBe(400);
    expect(() => parseMib("﻿")).toThrow("MIB file is empty");
  });

  it("refuses an oversize file with 413", () => {
    const big = "A".repeat(MIB_MAX_BYTES + 1);
    expect(status(() => parseMib(big))).toBe(413);
    expect(() => parseMib(big)).toThrow("MIB files are limited to 6 MiB");
  });

  it.each([["NUL", "\u0000"], ["BEL", "\u0007"], ["DEL", "\u007f"], ["ESC", "\u001b"]])("refuses a %s byte", (_n, ch) => {
    expect(() => parseMib(MINI.replace("IMPORTS", "IMPORTS" + ch))).toThrow(/binary or control characters/);
  });

  it("refuses a file without the DEFINITIONS header", () => {
    expect(() => parseMib("hello world\nEND")).toThrow(/missing the `<NAME> DEFINITIONS ::= BEGIN` header/);
  });

  it("a lowercase-leading module name is not a header", () => {
    expect(status(() => parseMib("test-mib DEFINITIONS ::= BEGIN\nEND"))).toBe(400);
  });

  it("refuses a truncated file (no END)", () => {
    expect(() => parseMib("X-MIB DEFINITIONS ::= BEGIN\nfoo OBJECT IDENTIFIER ::= { bar 1 }")).toThrow(/does not end with the `END` token/);
  });

  it("an END hidden in a trailing comment does not count", () => {
    expect(() => parseMib("X-MIB DEFINITIONS ::= BEGIN\nfoo\n-- END")).toThrow(/END/);
  });

  it("a header inside a comment does not count", () => {
    expect(() => parseMib("-- X-MIB DEFINITIONS ::= BEGIN\nEND")).toThrow(/header/);
  });

  it("is the upload gate for arbitrary text", () => {
    expect(() => parseMib("#!/bin/sh\nrm -rf /\n")).toThrow(AppError);
  });
});

// ─── parseMibStructured ─────────────────────────────────────────────────────

describe("parseMibStructured", () => {
  const parsed = parseMibStructured(FULL);
  const sym = (n: string) => parsed.symbols.find((s) => s.name === n)!;

  it("carries the module name and imports from the validator", () => {
    expect(parsed.moduleName).toBe("ACME-MIB");
    expect(parsed.imports).toEqual(["SNMPv2-SMI", "SNMPv2-TC"]);
  });

  it("propagates structural refusals", () => {
    expect(() => parseMibStructured("nope")).toThrow(AppError);
  });

  it("returns symbols sorted by name", () => {
    const names = parsed.symbols.map((s) => s.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it("classifies the four macro kinds and the OID shorthand", () => {
    expect(sym("acme").kind).toBe("module-identity");
    expect(sym("acmeStatus").kind).toBe("object-type");
    expect(sym("acmeTrap").kind).toBe("notification-type");
    expect(sym("acmeObjects")).toMatchObject({ kind: "object-identity", baseType: "OBJECT IDENTIFIER", parentName: "acme", oidIndex: 1, syntax: null });
  });

  it("parent + arc from ::= { parent N }; fullOid is left to the registry", () => {
    expect(sym("acme")).toMatchObject({ parentName: "enterprises", oidIndex: 4242, fullOid: null });
    expect(sym("acmeTrap")).toMatchObject({ parentName: "acme", oidIndex: 0 });
  });

  it("decodes INTEGER enums", () => {
    expect(sym("acmeStatus")).toMatchObject({
      baseType: "INTEGER",
      enumValues: [{ label: "ok", value: 1 }, { label: "degraded", value: 2 }, { label: "failed", value: 3 }],
    });
  });

  it("access from MAX-ACCESS or ACCESS; status validated", () => {
    expect(sym("acmeStatus")).toMatchObject({ access: "read-only", status: "current" });
    expect(sym("acmeName")).toMatchObject({ access: "read-write", status: "deprecated", baseType: "OCTET STRING" });
    expect(sym("acmePortIndex").status).toBeNull(); // "bogus" is not a status
  });

  it("DESCRIPTION unescapes doubled quotes and normalises whitespace", () => {
    expect(sym("acmeStatus").description).toBe('Overall "health" of the unit.');
  });

  it("base types: Integer32 → INTEGER, Counter64, SEQUENCE OF", () => {
    expect(sym("acmePortIndex").baseType).toBe("INTEGER");
    expect(sym("acmePortOctets").baseType).toBe("Counter64");
    expect(sym("acmePortTable").baseType).toBe("SEQUENCE OF");
  });

  it("INDEX names drop IMPLIED and mark the row", () => {
    expect(sym("acmePortEntry")).toMatchObject({ indexNames: ["acmePortIndex", "acmePortName"], isTableRow: true, baseType: "SEQUENCE" });
  });

  it("detects the table with its row and columns in arc order", () => {
    expect(parsed.tables).toEqual([{
      name: "acmePortTable",
      rowSymbol: "acmePortEntry",
      columns: ["acmePortIndex", "acmePortOctets"],
      indexNames: ["acmePortIndex", "acmePortName"],
      description: "Ports.",
    }]);
  });

  it("a table whose only child has no INDEX still finds it (single-child fallback)", () => {
    const src = [
      "T-MIB DEFINITIONS ::= BEGIN",
      "tTable OBJECT-TYPE SYNTAX SEQUENCE OF Foo MAX-ACCESS not-accessible STATUS current DESCRIPTION \"t\" ::= { x 1 }",
      "tEntry OBJECT-TYPE SYNTAX Bar MAX-ACCESS not-accessible STATUS current DESCRIPTION \"e\" ::= { tTable 1 }",
      "END",
    ].join("\n");
    const p = parseMibStructured(src);
    expect(p.tables[0]).toMatchObject({ rowSymbol: "tEntry", indexNames: [], columns: [] });
    expect(p.symbols.find((s) => s.name === "tEntry")).toMatchObject({ isTableRow: true, baseType: "SEQUENCE" });
  });

  it("a SEQUENCE OF with no child yields no table", () => {
    const src = "T-MIB DEFINITIONS ::= BEGIN\ntTable OBJECT-TYPE SYNTAX SEQUENCE OF Foo ::= { x 1 }\nEND";
    expect(parseMibStructured(src).tables).toEqual([]);
  });

  it("caps a DESCRIPTION at 4096 characters", () => {
    const long = "a".repeat(5000);
    const src = `T-MIB DEFINITIONS ::= BEGIN\nfoo OBJECT-TYPE SYNTAX Gauge32 DESCRIPTION "${long}" ::= { x 1 }\nEND`;
    const s = parseMibStructured(src).symbols[0];
    expect(s.description).toHaveLength(4096);
    expect(s.baseType).toBe("Gauge32");
  });

  it("an unknown SYNTAX is OTHER and an empty description is null", () => {
    const src = 'T-MIB DEFINITIONS ::= BEGIN\nfoo OBJECT-TYPE SYNTAX AcmeThing DESCRIPTION "  " ::= { x 1 }\nEND';
    expect(parseMibStructured(src).symbols[0]).toMatchObject({ baseType: "OTHER", description: null, enumValues: null, access: null });
  });

  it("an OID shorthand already declared by a macro is not duplicated", () => {
    const src = "T-MIB DEFINITIONS ::= BEGIN\nfoo OBJECT-IDENTITY STATUS current DESCRIPTION \"d\" ::= { x 1 }\nfoo OBJECT IDENTIFIER ::= { x 1 }\nEND";
    const p = parseMibStructured(src);
    expect(p.symbols.filter((s) => s.name === "foo")).toHaveLength(1);
    expect(p.symbols[0].description).toBe("d");
  });
});

// ─── CRUD ───────────────────────────────────────────────────────────────────

describe("listMibs", () => {
  const where = () => stubbed(prisma.mibFile.findMany).mock.calls[0][0].where;
  beforeEach(() => {
    stubbed(prisma.mibFile.findMany).mockResolvedValue([]);
  });

  it("no filter → no where, ordered by manufacturer / model / module", async () => {
    await listMibs();
    expect(where()).toEqual({});
    expect(stubbed(prisma.mibFile.findMany).mock.calls[0][0].orderBy).toEqual([{ manufacturer: "asc" }, { model: "asc" }, { moduleName: "asc" }]);
  });

  it("never selects the contents", async () => {
    await listMibs();
    expect(stubbed(prisma.mibFile.findMany).mock.calls[0][0].select.contents).toBeUndefined();
  });

  it("scope generic → manufacturer null, and a manufacturer filter is ignored", async () => {
    await listMibs({ scope: "generic", manufacturer: "APC" });
    expect(where()).toEqual({ manufacturer: null });
  });

  it("scope device → manufacturer not null", async () => {
    await listMibs({ scope: "device" });
    expect(where()).toEqual({ manufacturer: { not: null } });
  });

  it("a manufacturer / model filter is case-insensitive; null means generic", async () => {
    await listMibs({ manufacturer: "apc", model: "smt" });
    expect(where()).toEqual({ manufacturer: { equals: "apc", mode: "insensitive" }, model: { equals: "smt", mode: "insensitive" } });
    stubbed(prisma.mibFile.findMany).mockClear();
    await listMibs({ manufacturer: null, model: null });
    expect(where()).toEqual({ manufacturer: null, model: null });
  });

  it("returns the rows as read", async () => {
    stubbed(prisma.mibFile.findMany).mockResolvedValue([{ id: "m1" }]);
    expect(await listMibs()).toEqual([{ id: "m1" }]);
  });
});

describe("getMib / findMibWalkAsset", () => {
  it("getMib returns the row and 404s when missing", async () => {
    stubbed(prisma.mibFile.findUnique).mockResolvedValueOnce({ id: "m1" }).mockResolvedValueOnce(null);
    expect(await getMib("m1")).toEqual({ id: "m1" });
    await expect(getMib("x")).rejects.toMatchObject({ httpStatus: 404, message: "MIB not found" });
  });

  it("findMibWalkAsset selects the dial fields and 404s when missing", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValueOnce({ id: "a1", hostname: "h", ipAddress: null, ipv6Address: "2001:db8::1" }).mockResolvedValueOnce(null);
    expect(await findMibWalkAsset("a1")).toMatchObject({ ipv6Address: "2001:db8::1" });
    expect(stubbed(prisma.asset.findUnique).mock.calls[0][0]).toEqual({
      where: { id: "a1" },
      select: { id: true, hostname: true, ipAddress: true, ipv6Address: true },
    });
    await expect(findMibWalkAsset("x")).rejects.toMatchObject({ httpStatus: 404, message: "Asset not found" });
  });
});

describe("createMib", () => {
  beforeEach(() => {
    stubbed(prisma.mibFile.findFirst).mockResolvedValue(null);
    stubbed(prisma.mibFile.create).mockImplementation(async ({ data }: any) => ({ id: "new", ...data, uploadedAt: new Date(0) }));
  });

  it("requires a filename", async () => {
    await expect(createMib({ filename: "  ", contents: MINI })).rejects.toMatchObject({ httpStatus: 400, message: "filename is required" });
  });

  it("refuses a model without a manufacturer", async () => {
    await expect(createMib({ filename: "a.mib", contents: MINI, model: "X", manufacturer: "  " })).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.mibFile.create).not.toHaveBeenCalled();
  });

  it("refuses invalid contents before any read", async () => {
    await expect(createMib({ filename: "a.mib", contents: "junk" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.mibFile.findFirst).not.toHaveBeenCalled();
  });

  it("409s on a duplicate (manufacturer, model, module), checked by hand for generics", async () => {
    stubbed(prisma.mibFile.findFirst).mockResolvedValue({ id: "old" });
    await expect(createMib({ filename: "a.mib", contents: MINI })).rejects.toMatchObject({ httpStatus: 409 });
    expect(stubbed(prisma.mibFile.findFirst).mock.calls[0][0].where).toEqual({ manufacturer: null, model: null, moduleName: "TEST-MIB" });
  });

  it("stores trimmed metadata, the BOM-less text, its length and the imports", async () => {
    await createMib({ filename: " a.mib ", contents: "﻿" + MINI, manufacturer: " APC ", model: " SMT ", notes: "  ", uploadedBy: "" });
    expect(stubbed(prisma.mibFile.create).mock.calls[0][0].data).toEqual({
      filename: "a.mib",
      moduleName: "TEST-MIB",
      manufacturer: "APC",
      model: "SMT",
      contents: MINI,
      imports: ["SNMPv2-SMI", "SNMPv2-TC"],
      size: MINI.length,
      notes: null,
      uploadedBy: null,
    });
  });

  it("refreshes the registry and reports the readiness figures", async () => {
    h.resolve.mockResolvedValue(new Map([["a", "1.3.6.1"], ["b", null], ["c", null]]));
    h.missing.mockReturnValue([{ name: "fortinet", module: "FORTINET-CORE-MIB" }]);
    const r = await createMib({ filename: "a.mib", contents: MINI, uploadedBy: "alice" });
    expect(h.refresh).toHaveBeenCalled();
    expect(h.resolve).toHaveBeenCalledWith("new");
    expect(r).toMatchObject({ id: "new", symbolCount: 3, unresolvedCount: 2, unresolvedRoots: [{ name: "fortinet", module: "FORTINET-CORE-MIB" }] });
  });

  it("fully resolved → no roots lookup", async () => {
    h.resolve.mockResolvedValue(new Map([["a", "1.3"]]));
    const r = await createMib({ filename: "a.mib", contents: MINI });
    expect(r).toMatchObject({ symbolCount: 1, unresolvedCount: 0, unresolvedRoots: [] });
    expect(h.missing).not.toHaveBeenCalled();
  });

  it("a failing registry refresh still returns the stored row with zero figures", async () => {
    h.refresh.mockRejectedValue(new Error("boom"));
    const r = await createMib({ filename: "a.mib", contents: MINI });
    expect(r).toMatchObject({ id: "new", symbolCount: 0, unresolvedCount: 0, unresolvedRoots: [] });
  });
});

describe("deleteMib", () => {
  it("deletes and refreshes the registry in the background", async () => {
    stubbed(prisma.mibFile.delete).mockResolvedValue({});
    await deleteMib("m1");
    expect(prisma.mibFile.delete).toHaveBeenCalledWith({ where: { id: "m1" } });
    await flush();
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a failing delete is a 404 and skips the refresh", async () => {
    stubbed(prisma.mibFile.delete).mockRejectedValue(new Error("P2025"));
    await expect(deleteMib("x")).rejects.toMatchObject({ httpStatus: 404 });
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it("a failing background refresh does not surface", async () => {
    stubbed(prisma.mibFile.delete).mockResolvedValue({});
    h.refresh.mockRejectedValue(new Error("x"));
    await expect(deleteMib("m1")).resolves.toBeUndefined();
    await flush();
  });
});

describe("getMibFacets", () => {
  it("unions MIB and inventory facets, trims, sorts and counts devices", async () => {
    stubbed(prisma.mibFile.findMany).mockResolvedValue([
      { manufacturer: "APC", model: "SMT" },
      { manufacturer: "Zebra", model: null },
    ]);
    stubbed(prisma.asset.groupBy).mockResolvedValue([
      { manufacturer: " APC ", model: "SRT ", _count: { _all: 3 } },
      { manufacturer: "APC", model: null, _count: { _all: 2 } },
      { manufacturer: "Cisco", model: "  ", _count: { _all: 5 } },
      { manufacturer: "   ", model: "x", _count: { _all: 9 } },
    ]);
    expect(await getMibFacets()).toEqual({
      manufacturers: ["APC", "Cisco", "Zebra"],
      modelsByManufacturer: { APC: ["SMT", "SRT"], Zebra: [], Cisco: [] },
      assetCounts: { APC: 5, Cisco: 5 },
    });
  });

  it("an empty install has empty facets", async () => {
    stubbed(prisma.mibFile.findMany).mockResolvedValue([]);
    stubbed(prisma.asset.groupBy).mockResolvedValue([]);
    expect(await getMibFacets()).toEqual({ manufacturers: [], modelsByManufacturer: {}, assetCounts: {} });
  });
});
