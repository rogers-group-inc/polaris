/**
 * tests/unit/manufacturerAliasService.test.ts — CQ-T010 own suite for
 * src/services/manufacturerAliasService.ts.
 *
 * The contract (polaris-change-impact → snmp-mibs-profiles.md): the in-memory
 * alias map is refreshed after every mutation, the seed is idempotent and never
 * overwrites, and the backfill respects the MibFile (manufacturer, model,
 * moduleName) uniqueness by updating one row at a time and warning on a clash.
 * Prisma is the shared stub; the normalize util is REAL, so the cache refresh is
 * observed through `normalizeManufacturer`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/logger.js", () => {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  logger.child = () => logger;
  return { logger };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { logger } from "../../src/utils/logger.js";
import { normalizeManufacturer, _resetAliasMap } from "../../src/utils/manufacturerNormalize.js";
import { AppError } from "../../src/utils/errors.js";
import {
  DEFAULT_ALIASES,
  listAliases,
  createAlias,
  updateAlias,
  deleteAlias,
  refreshAliasCache,
  seedDefaultAliases,
  applyAliasesToExistingRows,
} from "../../src/services/manufacturerAliasService.js";

const p = prisma as any;

function row(alias: string, canonical: string, id = `id-${alias}`) {
  return { id, alias, canonical, createdAt: new Date(0), updatedAt: new Date(0) };
}

async function expectAppError(promise: Promise<unknown>, status: number, re?: RegExp) {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (re) expect((err as AppError).message).toMatch(re);
}

/** Let the fire-and-forget backfill settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetDbStub();
  _resetAliasMap();
  vi.mocked(logger.warn).mockReset();
  vi.mocked(logger.error).mockReset();
  // Defaults: an empty table and an empty inventory.
  stubbed(p.manufacturerAlias.findMany).mockResolvedValue([]);
  stubbed(p.asset.findMany).mockResolvedValue([]);
  stubbed(p.mibFile.findMany).mockResolvedValue([]);
});

describe("DEFAULT_ALIASES", () => {
  it("every entry has a non-empty alias and canonical", () => {
    for (const e of DEFAULT_ALIASES) {
      expect(e.alias.trim()).not.toBe("");
      expect(e.canonical.trim()).not.toBe("");
    }
  });

  it("maps the common IEEE legal names to marketing names", () => {
    const map = new Map(DEFAULT_ALIASES.map((e) => [e.alias, e.canonical]));
    expect(map.get("Fortinet, Inc.")).toBe("Fortinet");
    expect(map.get("Cisco Systems, Inc.")).toBe("Cisco");
    expect(map.get("Hewlett Packard Enterprise")).toBe("HPE");
    expect(map.get("Microsoft Corporation")).toBe("Microsoft");
  });

  it("carries one case-only duplicate (MikroTikls SIA / Mikrotikls SIA) — the seed's lowercasing folds them into one row", () => {
    const keys = DEFAULT_ALIASES.map((e) => e.alias.trim().toLowerCase());
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual(["mikrotikls sia"]);
  });
});

describe("listAliases", () => {
  it("orders by canonical then alias and returns the rows as read", async () => {
    const rows = [row("cisco systems", "Cisco")];
    stubbed(p.manufacturerAlias.findMany).mockResolvedValue(rows);
    await expect(listAliases()).resolves.toBe(rows);
    expect(p.manufacturerAlias.findMany).toHaveBeenCalledWith({
      orderBy: [{ canonical: "asc" }, { alias: "asc" }],
    });
  });
});

describe("refreshAliasCache", () => {
  it("loads every row into the normalize map", async () => {
    stubbed(p.manufacturerAlias.findMany).mockResolvedValue([
      { alias: "fortinet, inc.", canonical: "Fortinet" },
      { alias: "dell inc.", canonical: "Dell" },
    ]);
    await refreshAliasCache();
    expect(p.manufacturerAlias.findMany).toHaveBeenCalledWith({ select: { alias: true, canonical: true } });
    expect(normalizeManufacturer("Fortinet, Inc.")).toBe("Fortinet");
    expect(normalizeManufacturer("  DELL INC.  ")).toBe("Dell");
    expect(normalizeManufacturer("Unknown Co")).toBe("Unknown Co");
  });

  it("replaces the previous map rather than merging into it", async () => {
    stubbed(p.manufacturerAlias.findMany).mockResolvedValueOnce([{ alias: "a corp", canonical: "A" }]);
    await refreshAliasCache();
    stubbed(p.manufacturerAlias.findMany).mockResolvedValueOnce([{ alias: "b corp", canonical: "B" }]);
    await refreshAliasCache();
    expect(normalizeManufacturer("A Corp")).toBe("A Corp");
    expect(normalizeManufacturer("B Corp")).toBe("B");
  });
});

describe("createAlias", () => {
  it("lower-cases + trims the alias, trims the canonical, creates, and refreshes the cache", async () => {
    stubbed(p.manufacturerAlias.findUnique).mockResolvedValue(null);
    const created = row("acme networks, inc.", "Acme");
    stubbed(p.manufacturerAlias.create).mockResolvedValue(created);
    stubbed(p.manufacturerAlias.findMany).mockResolvedValue([{ alias: "acme networks, inc.", canonical: "Acme" }]);

    await expect(createAlias({ alias: "  Acme Networks, Inc. ", canonical: " Acme " })).resolves.toBe(created);
    expect(p.manufacturerAlias.findUnique).toHaveBeenCalledWith({ where: { alias: "acme networks, inc." } });
    expect(p.manufacturerAlias.create).toHaveBeenCalledWith({ data: { alias: "acme networks, inc.", canonical: "Acme" } });
    expect(normalizeManufacturer("ACME NETWORKS, INC.")).toBe("Acme");
  });

  it("kicks off the backfill after the create", async () => {
    stubbed(p.manufacturerAlias.findUnique).mockResolvedValue(null);
    stubbed(p.manufacturerAlias.create).mockResolvedValue(row("x", "X"));
    await createAlias({ alias: "x inc", canonical: "X" });
    await flush();
    expect(p.asset.findMany).toHaveBeenCalled();
    expect(p.mibFile.findMany).toHaveBeenCalled();
  });

  it("a failing backfill is logged and never fails the create", async () => {
    stubbed(p.manufacturerAlias.findUnique).mockResolvedValue(null);
    const created = row("x", "X");
    stubbed(p.manufacturerAlias.create).mockResolvedValue(created);
    stubbed(p.asset.findMany).mockRejectedValue(new Error("db gone"));
    await expect(createAlias({ alias: "x inc", canonical: "X" })).resolves.toBe(created);
    await flush();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringMatching(/after create/));
  });

  it("refuses an empty alias (400)", async () => {
    await expectAppError(createAlias({ alias: "   ", canonical: "X" }), 400, /alias is required/);
    expect(p.manufacturerAlias.create).not.toHaveBeenCalled();
  });

  it("refuses an empty canonical (400)", async () => {
    await expectAppError(createAlias({ alias: "x", canonical: "  " }), 400, /canonical is required/);
  });

  it("refuses an alias equal to its canonical, case-insensitively (400)", async () => {
    await expectAppError(createAlias({ alias: "FORTINET", canonical: "Fortinet" }), 400, /cannot be the same/);
  });

  it("refuses an alias that already exists, matched on the lower-cased key (409)", async () => {
    stubbed(p.manufacturerAlias.findUnique).mockResolvedValue(row("dell inc", "Dell"));
    await expectAppError(createAlias({ alias: "DELL INC", canonical: "Dell" }), 409, /already exists/);
    expect(p.manufacturerAlias.findUnique).toHaveBeenCalledWith({ where: { alias: "dell inc" } });
    expect(p.manufacturerAlias.create).not.toHaveBeenCalled();
  });
});

describe("updateAlias", () => {
  it("normalizes both fields, updates, and refreshes the cache", async () => {
    const updated = row("new name", "Canon");
    stubbed(p.manufacturerAlias.update).mockResolvedValue(updated);
    stubbed(p.manufacturerAlias.findMany).mockResolvedValue([{ alias: "new name", canonical: "Canon" }]);
    await expect(updateAlias("id1", { alias: " New Name ", canonical: " Canon " })).resolves.toBe(updated);
    expect(p.manufacturerAlias.update).toHaveBeenCalledWith({ where: { id: "id1" }, data: { alias: "new name", canonical: "Canon" } });
    expect(normalizeManufacturer("NEW NAME")).toBe("Canon");
  });

  it("only writes the fields given", async () => {
    stubbed(p.manufacturerAlias.update).mockResolvedValue(row("a", "B"));
    await updateAlias("id1", { canonical: "B" });
    expect(p.manufacturerAlias.update).toHaveBeenCalledWith({ where: { id: "id1" }, data: { canonical: "B" } });
  });

  it("runs the backfill after the update", async () => {
    stubbed(p.manufacturerAlias.update).mockResolvedValue(row("a", "B"));
    await updateAlias("id1", { canonical: "B" });
    await flush();
    expect(p.asset.findMany).toHaveBeenCalled();
  });

  it("refuses an alias or canonical blanked to whitespace (400)", async () => {
    await expectAppError(updateAlias("id1", { alias: "  " }), 400, /alias cannot be empty/);
    await expectAppError(updateAlias("id1", { canonical: "" }), 400, /canonical cannot be empty/);
    expect(p.manufacturerAlias.update).not.toHaveBeenCalled();
  });

  it("refuses alias == canonical when both are given (400)", async () => {
    await expectAppError(updateAlias("id1", { alias: "Cisco", canonical: "cisco" }), 400, /cannot be the same/);
  });

  it("maps a missing row to 404", async () => {
    stubbed(p.manufacturerAlias.update).mockRejectedValue(Object.assign(new Error("not found"), { code: "P2025" }));
    await expectAppError(updateAlias("nope", { canonical: "X" }), 404, /Alias not found/);
  });

  // BUG: updateAlias catches EVERY update error as "Alias not found". Renaming
  // an alias onto one that already exists raises the unique-constraint error
  // (Prisma P2002); the operator is told 404 "Alias not found" for a row that
  // plainly exists. createAlias answers the same clash with 409 "already
  // exists" — the update should too (or at least not claim the row is missing).
  it.fails("renaming onto an alias that already exists is a 409 conflict, not a 404", async () => {
    stubbed(p.manufacturerAlias.update).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed on the fields: (`alias`)"), { code: "P2002" }),
    );
    await expectAppError(updateAlias("id1", { alias: "dell inc" }), 409);
  });
});

describe("deleteAlias", () => {
  it("deletes, refreshes the cache, and runs no backfill", async () => {
    stubbed(p.manufacturerAlias.delete).mockResolvedValue(row("a", "B"));
    stubbed(p.manufacturerAlias.findMany).mockResolvedValue([]);
    await deleteAlias("id1");
    await flush();
    expect(p.manufacturerAlias.delete).toHaveBeenCalledWith({ where: { id: "id1" } });
    expect(p.manufacturerAlias.findMany).toHaveBeenCalledTimes(1);
    expect(p.asset.findMany).not.toHaveBeenCalled();
    expect(p.mibFile.findMany).not.toHaveBeenCalled();
  });

  it("drops the deleted alias from the live map", async () => {
    stubbed(p.manufacturerAlias.findMany).mockResolvedValueOnce([{ alias: "gone corp", canonical: "Gone" }]);
    await refreshAliasCache();
    expect(normalizeManufacturer("Gone Corp")).toBe("Gone");
    stubbed(p.manufacturerAlias.delete).mockResolvedValue(row("gone corp", "Gone"));
    stubbed(p.manufacturerAlias.findMany).mockResolvedValueOnce([]);
    await deleteAlias("id1");
    expect(normalizeManufacturer("Gone Corp")).toBe("Gone Corp");
  });

  it("maps a missing row to 404 and leaves the cache alone", async () => {
    stubbed(p.manufacturerAlias.delete).mockRejectedValue(new Error("P2025"));
    await expectAppError(deleteAlias("nope"), 404, /Alias not found/);
    expect(p.manufacturerAlias.findMany).not.toHaveBeenCalled();
  });
});

describe("seedDefaultAliases", () => {
  it("inserts every default into an empty table, lower-casing the alias", async () => {
    const stored = new Set<string>();
    stubbed(p.manufacturerAlias.findUnique).mockImplementation(async ({ where }: any) =>
      stored.has(where.alias) ? { id: where.alias } : null);
    stubbed(p.manufacturerAlias.create).mockImplementation(async ({ data }: any) => {
      stored.add(data.alias);
      return data;
    });
    const res = await seedDefaultAliases();
    const distinct = new Set(DEFAULT_ALIASES.map((e) => e.alias.trim().toLowerCase()));
    expect(res.inserted).toBe(distinct.size);
    expect(stored).toEqual(distinct);
    expect(p.manufacturerAlias.create).toHaveBeenCalledWith({ data: { alias: "fortinet, inc.", canonical: "Fortinet" } });
  });

  it("is idempotent: existing rows are skipped, never overwritten", async () => {
    stubbed(p.manufacturerAlias.findUnique).mockResolvedValue({ id: "x", alias: "x", canonical: "Admin's choice" });
    await expect(seedDefaultAliases()).resolves.toEqual({ inserted: 0 });
    expect(p.manufacturerAlias.create).not.toHaveBeenCalled();
    expect(p.manufacturerAlias.update).not.toHaveBeenCalled();
    expect(p.manufacturerAlias.upsert).not.toHaveBeenCalled();
  });

  it("a failing row is warned about and the seed carries on", async () => {
    stubbed(p.manufacturerAlias.findUnique).mockResolvedValue(null);
    let n = 0;
    stubbed(p.manufacturerAlias.create).mockImplementation(async ({ data }: any) => {
      if (n++ === 0) throw new Error("boom");
      return data;
    });
    const res = await seedDefaultAliases();
    expect(res.inserted).toBe(DEFAULT_ALIASES.length - 1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ alias: "fortinet, inc." }),
      expect.stringMatching(/Failed to seed/),
    );
  });
});

describe("applyAliasesToExistingRows", () => {
  beforeEach(async () => {
    stubbed(p.manufacturerAlias.findMany).mockResolvedValue([
      { alias: "fortinet, inc.", canonical: "Fortinet" },
      { alias: "cisco systems", canonical: "Cisco" },
    ]);
    await refreshAliasCache();
  });

  it("issues one updateMany per distinct raw asset value that canonicalizes differently", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([
      { manufacturer: "Fortinet, Inc." },
      { manufacturer: "Cisco Systems" },
      { manufacturer: "Fortinet" }, // already canonical
      { manufacturer: "Unknown" },  // no alias
      { manufacturer: null },
    ]);
    stubbed(p.asset.updateMany)
      .mockResolvedValueOnce({ count: 3 })
      .mockResolvedValueOnce({ count: 2 });
    const res = await applyAliasesToExistingRows();
    expect(p.asset.findMany).toHaveBeenCalledWith({
      where: { manufacturer: { not: null } },
      select: { manufacturer: true },
      distinct: ["manufacturer"],
    });
    expect(p.asset.updateMany).toHaveBeenCalledTimes(2);
    expect(p.asset.updateMany).toHaveBeenNthCalledWith(1, { where: { manufacturer: "Fortinet, Inc." }, data: { manufacturer: "Fortinet" } });
    expect(p.asset.updateMany).toHaveBeenNthCalledWith(2, { where: { manufacturer: "Cisco Systems" }, data: { manufacturer: "Cisco" } });
    expect(res).toEqual({ assets: 5, mibs: 0 });
  });

  it("trims a raw value even with no alias (whitespace is a difference)", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([{ manufacturer: " Acme " }]);
    stubbed(p.asset.updateMany).mockResolvedValue({ count: 1 });
    await applyAliasesToExistingRows();
    expect(p.asset.updateMany).toHaveBeenCalledWith({ where: { manufacturer: " Acme " }, data: { manufacturer: "Acme" } });
  });

  it("leaves a whitespace-only manufacturer alone (normalizes to null, which is skipped)", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([{ manufacturer: "   " }]);
    await applyAliasesToExistingRows();
    expect(p.asset.updateMany).not.toHaveBeenCalled();
  });

  it("updates MIB rows one at a time and counts each", async () => {
    stubbed(p.mibFile.findMany).mockResolvedValue([
      { id: "m1", manufacturer: "Fortinet, Inc.", model: null, moduleName: "FORTINET-CORE-MIB" },
      { id: "m2", manufacturer: "Fortinet", model: null, moduleName: "X" },
      { id: "m3", manufacturer: "cisco systems", model: "c9300", moduleName: "Y" },
    ]);
    stubbed(p.mibFile.update).mockResolvedValue({});
    const res = await applyAliasesToExistingRows();
    expect(p.mibFile.update).toHaveBeenCalledTimes(2);
    expect(p.mibFile.update).toHaveBeenCalledWith({ where: { id: "m1" }, data: { manufacturer: "Fortinet" } });
    expect(p.mibFile.update).toHaveBeenCalledWith({ where: { id: "m3" }, data: { manufacturer: "Cisco" } });
    expect(res.mibs).toBe(2);
  });

  it("a MIB row that would collide after the collapse is warned about and skipped; the rest still update", async () => {
    stubbed(p.mibFile.findMany).mockResolvedValue([
      { id: "m1", manufacturer: "Fortinet, Inc.", model: null, moduleName: "FORTINET-CORE-MIB" },
      { id: "m2", manufacturer: "Cisco Systems", model: null, moduleName: "Y" },
    ]);
    stubbed(p.mibFile.update)
      .mockRejectedValueOnce(Object.assign(new Error("unique"), { code: "P2002" }))
      .mockResolvedValueOnce({});
    const res = await applyAliasesToExistingRows();
    expect(res.mibs).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mibId: "m1", from: "Fortinet, Inc.", to: "Fortinet", moduleName: "FORTINET-CORE-MIB" }),
      expect.stringMatching(/duplicate/),
    );
  });

  it("with nothing to rewrite returns zero counts and writes nothing", async () => {
    await expect(applyAliasesToExistingRows()).resolves.toEqual({ assets: 0, mibs: 0 });
    expect(p.asset.updateMany).not.toHaveBeenCalled();
    expect(p.mibFile.update).not.toHaveBeenCalled();
  });
});
