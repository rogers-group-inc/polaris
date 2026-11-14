/**
 * tests/unit/assetTypeService.test.ts — the own suite for
 * src/services/assetTypeService.ts (the AssetTypeDef registry; CQ-T010).
 *
 * Pins, against the shared Prisma stub and the REAL utils/assetTypes +
 * utils/assetTypeMatch (validation, normalisation and the two caches are
 * theirs; this service's job is to call them in the right order):
 *   - reads: ordering, usage counts, legacy matchRules folded on the way out;
 *   - create: name / label / matching validation order, 409 on an existing
 *     name, the stored shape, the cache refresh;
 *   - update: the built-in IDENTITY guard (name / label / description → 403)
 *     while built-in MATCHING stays editable, rename-in-one-transaction
 *     (assets first, then the row), DbNull to clear rules, the no-op path;
 *   - delete: protected 403, in-use 409, cache refresh;
 *   - refreshCache: both caches warmed from one read;
 *   - seedBuiltInAssetTypes: creates only what is missing, never re-stamps;
 *   - preview / apply: the `other` bucket only, the draft substituted into the
 *     live registry, directory-then-inventory context, the sample cap, the
 *     race-safe WHERE.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { Prisma } from "../../src/generated/prisma/client.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { AppError } from "../../src/utils/errors.js";
import { isKnownAssetType } from "../../src/utils/assetTypes.js";
import { resolveAssetTypeCached, DEFAULT_TYPE_MATCHING, type MatchRules } from "../../src/utils/assetTypeMatch.js";
import {
  applyMatchRules,
  createAssetType,
  deleteAssetType,
  getAssetType,
  listAssetTypes,
  previewMatchRules,
  refreshCache,
  seedBuiltInAssetTypes,
  updateAssetType,
  type AssetTypeRow,
} from "../../src/services/assetTypeService.js";

const T0 = new Date("2026-01-01T00:00:00Z");
const defs = prisma.assetTypeDef;

function def(over: Partial<Omit<AssetTypeRow, "matchRules">> & { matchRules?: unknown } = {}) {
  return {
    id: "t-1", name: "camera", label: "Camera", description: null as string | null, isBuiltIn: false, isProtected: false,
    createdBy: "alice", createdAt: T0, updatedAt: T0, matchRules: null as unknown, matchContexts: [] as string[], matchPriority: 100,
    ...over,
  };
}

const builtIn = (over: Parameters<typeof def>[0] = {}) => def({ id: "b-1", name: "printer", label: "Printer", description: "Network printer", isBuiltIn: true, isProtected: true, createdBy: null, ...over });

const rules = (value: string, field = "os"): MatchRules => ({ op: "or", children: [{ field: field as never, operator: "contains", value }] });

async function expectStatus(p: Promise<unknown>, status: number, msg?: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

beforeEach(() => {
  resetDbStub();
  stubbed(defs.findMany).mockResolvedValue([]);
  stubbed(defs.findUnique).mockResolvedValue(null);
  stubbed(defs.create).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => def({ ...data, id: "t-new" } as never));
  stubbed(defs.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => def(data as never));
  stubbed(prisma.asset.count).mockResolvedValue(0);
  stubbed(prisma.asset.findMany).mockResolvedValue([]);
});

// ─── Reads ────────────────────────────────────────────────────────────────────

describe("listAssetTypes / getAssetType", () => {
  it("lists built-ins first, then by label, without usage by default", async () => {
    stubbed(defs.findMany).mockResolvedValue([builtIn(), def()]);
    const out = await listAssetTypes();
    expect(stubbed(defs.findMany).mock.calls[0][0]).toEqual({ orderBy: [{ isBuiltIn: "desc" }, { label: "asc" }] });
    expect(out.map((r) => r.name)).toEqual(["printer", "camera"]);
    expect(out[0]).not.toHaveProperty("usageCount");
    expect(prisma.asset.groupBy).not.toHaveBeenCalled();
  });

  it("with usage, joins one groupBy by name; an unused type reads 0", async () => {
    stubbed(defs.findMany).mockResolvedValue([builtIn(), def()]);
    stubbed(prisma.asset.groupBy).mockResolvedValue([{ assetType: "printer", _count: { _all: 7 } }]);
    const out = await listAssetTypes({ withUsage: true });
    expect(out.map((r) => r.usageCount)).toEqual([7, 0]);
    expect(prisma.asset.groupBy).toHaveBeenCalledTimes(1);
  });

  it("folds a legacy flat clause list into the current tree on the way out", async () => {
    stubbed(defs.findMany).mockResolvedValue([def({ matchRules: { clauses: [{ field: "os", op: "starts_with", value: "AXIS" }] } })]);
    const [r] = await listAssetTypes();
    expect(r.matchRules).toEqual({ op: "or", children: [{ field: "os", operator: "startsWith", value: "AXIS" }] });
  });

  it("an invalid stored blob reads as null rules", async () => {
    stubbed(defs.findMany).mockResolvedValue([def({ matchRules: "garbage" })]);
    expect((await listAssetTypes())[0].matchRules).toBeNull();
  });

  it("getAssetType 404s an unknown id", async () => {
    await expectStatus(getAssetType("nope"), 404, /Asset type not found/);
  });

  it("getAssetType counts assets holding its name", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def());
    stubbed(prisma.asset.count).mockResolvedValue(3);
    const r = await getAssetType("t-1");
    expect(r.usageCount).toBe(3);
    expect(prisma.asset.count).toHaveBeenCalledWith({ where: { assetType: "camera" } });
  });
});

// ─── createAssetType ──────────────────────────────────────────────────────────

describe("createAssetType", () => {
  it.each([
    ["x", /2-32 characters/],
    ["has space", /lowercase letters, digits/],
    ["server", /collides with a built-in/],
  ])("refuses the name %j with 400", async (name, msg) => {
    await expectStatus(createAssetType({ name, label: "L" }), 400, msg);
    expect(defs.create).not.toHaveBeenCalled();
  });

  it("refuses a blank or over-long label", async () => {
    await expectStatus(createAssetType({ name: "camera", label: "   " }), 400, /Label must be 1-64/);
    await expectStatus(createAssetType({ name: "camera", label: "x".repeat(65) }), 400, /Label must be 1-64/);
  });

  it("refuses bad rules, an unknown context and an out-of-range priority", async () => {
    await expectStatus(createAssetType({ name: "camera", label: "C", matchRules: [] as never }), 400, /must be an object/);
    await expectStatus(createAssetType({ name: "camera", label: "C", matchContexts: ["dns"] }), 400, /Unknown match context "dns"/);
    for (const p of [-1, 1001, 1.5, "5" as unknown as number]) {
      await expectStatus(createAssetType({ name: "camera", label: "C", matchPriority: p }), 400, /between 0 and 1000/);
    }
  });

  it("accepts priority 0 and 1000", async () => {
    await createAssetType({ name: "cam0", label: "C", matchPriority: 0 });
    await createAssetType({ name: "cam1", label: "C", matchPriority: 1000 });
    expect(stubbed(defs.create).mock.calls.map((c) => c[0].data.matchPriority)).toEqual([0, 1000]);
  });

  it("409s an existing (normalized) name", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def());
    await expectStatus(createAssetType({ name: "  Camera ", label: "Camera" }), 409, /"camera" already exists/);
    expect(defs.findUnique).toHaveBeenCalledWith({ where: { name: "camera" } });
  });

  it("stores a custom, unprotected row: trimmed label, blank description → null, no priority unless given", async () => {
    await createAssetType({ name: "Camera", label: "  IP Camera ", description: "   ", createdBy: "alice" });
    const data = stubbed(defs.create).mock.calls[0][0].data;
    expect(data).toEqual({ name: "camera", label: "IP Camera", description: null, isBuiltIn: false, isProtected: false, createdBy: "alice", matchRules: undefined, matchContexts: [] });
  });

  it("stores rules normalized (legacy folded) and the contexts", async () => {
    await createAssetType({ name: "camera", label: "C", matchRules: { clauses: [{ field: "model", op: "contains", value: "AXIS", negate: true }] } as never, matchContexts: ["directory"] });
    const data = stubbed(defs.create).mock.calls[0][0].data;
    expect(data.matchRules).toEqual({ op: "or", children: [{ field: "model", operator: "notContains", value: "AXIS" }] });
    expect(data.matchContexts).toEqual(["directory"]);
  });

  it("a rule tree with no usable leaf is stored as no rules", async () => {
    await createAssetType({ name: "camera", label: "C", matchRules: { op: "or", children: [] } });
    expect(stubbed(defs.create).mock.calls[0][0].data.matchRules).toBeUndefined();
  });

  it("refreshes the cache so the new name is known at once", async () => {
    stubbed(defs.findMany).mockResolvedValue([{ name: "camera", label: "Camera", isBuiltIn: false, matchRules: null, matchContexts: [], matchPriority: 100 }]);
    await createAssetType({ name: "camera", label: "Camera" });
    expect(isKnownAssetType("camera")).toBe(true);
    expect(isKnownAssetType("server")).toBe(false);
  });
});

// ─── updateAssetType ──────────────────────────────────────────────────────────

describe("updateAssetType", () => {
  it("404s an unknown id", async () => {
    await expectStatus(updateAssetType("nope", { label: "x" }), 404);
  });

  it("validates matching before the identity guard", async () => {
    stubbed(defs.findUnique).mockResolvedValue(builtIn());
    await expectStatus(updateAssetType("b-1", { label: "Renamed", matchContexts: ["bogus"] }), 400, /Unknown match context/);
  });

  it.each([
    [{ name: "printers" }],
    [{ label: "Printers" }],
    [{ description: "different" }],
    [{ description: null }],
  ])("a built-in's identity edit %j is 403", async (input) => {
    stubbed(defs.findUnique).mockResolvedValue(builtIn());
    await expectStatus(updateAssetType("b-1", input), 403, /cannot be renamed or relabelled/);
    expect(defs.update).not.toHaveBeenCalled();
  });

  it("re-sending a built-in's identity unchanged is allowed (the editor round-trips it)", async () => {
    stubbed(defs.findUnique).mockResolvedValue(builtIn());
    await updateAssetType("b-1", { name: "printer", label: "Printer", description: "  Network printer ", matchPriority: 5 });
    expect(stubbed(defs.update).mock.calls[0][0].data).toEqual({ label: "Printer", description: "Network printer", matchPriority: 5 });
  });

  it("a built-in's matching rules are editable", async () => {
    stubbed(defs.findUnique).mockResolvedValue(builtIn());
    await updateAssetType("b-1", { matchRules: rules("laserjet", "model"), matchContexts: ["scan"] });
    expect(stubbed(defs.update).mock.calls[0][0]).toEqual({ where: { id: "b-1" }, data: { matchRules: rules("laserjet", "model"), matchContexts: ["scan"] } });
  });

  it("null rules clear the column with Prisma.DbNull", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def({ matchRules: rules("x") }));
    await updateAssetType("t-1", { matchRules: null });
    expect(stubbed(defs.update).mock.calls[0][0].data.matchRules).toBe(Prisma.DbNull);
  });

  it("nothing to change returns the current row without writing", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def({ matchRules: { clauses: [{ field: "os", op: "contains", value: "axis" }] } }));
    const out = await updateAssetType("t-1", {});
    expect(defs.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(out.matchRules).toEqual({ op: "or", children: [{ field: "os", operator: "contains", value: "axis" }] });
  });

  it("a rename validates the new name", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def());
    await expectStatus(updateAssetType("t-1", { name: "router" }), 400, /collides with a built-in/);
    await expectStatus(updateAssetType("t-1", { name: "a b" }), 400);
  });

  it("a rename onto another row's name is 409", async () => {
    stubbed(defs.findUnique).mockResolvedValueOnce(def()).mockResolvedValueOnce(def({ id: "t-2", name: "webcam" }));
    await expectStatus(updateAssetType("t-1", { name: "Webcam" }), 409, /"webcam" already exists/);
  });

  it("a rename rewrites the assets and the row in ONE transaction, assets first", async () => {
    stubbed(defs.findUnique).mockResolvedValueOnce(def()).mockResolvedValueOnce(null);
    const order: string[] = [];
    stubbed(prisma.asset.updateMany).mockImplementation(async () => { order.push("assets"); return { count: 4 }; });
    stubbed(defs.update).mockImplementation(async ({ data }: { data: Record<string, unknown> }) => { order.push("row"); return def(data as never); });
    const out = await updateAssetType("t-1", { name: "ipcam", label: "IP Cam" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["assets", "row"]);
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({ where: { assetType: "camera" }, data: { assetType: "ipcam" } });
    expect(stubbed(defs.update).mock.calls[0][0].data).toEqual({ name: "ipcam", label: "IP Cam" });
    expect(out.name).toBe("ipcam");
  });

  it("a non-rename edit is a plain update, no transaction, then a cache refresh", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def());
    stubbed(defs.findMany).mockResolvedValue([{ name: "camera", label: "Cam", isBuiltIn: false, matchRules: null, matchContexts: [], matchPriority: 100 }]);
    await updateAssetType("t-1", { label: "Cam" });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(defs.findMany).toHaveBeenCalled();
  });

  it("an empty description clears it to null", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def({ description: "old" }));
    await updateAssetType("t-1", { description: "  " });
    expect(stubbed(defs.update).mock.calls[0][0].data).toEqual({ description: null });
  });

  it("a bad label on a custom row is 400", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def());
    await expectStatus(updateAssetType("t-1", { label: "" }), 400, /Label must be/);
  });
});

// ─── deleteAssetType ──────────────────────────────────────────────────────────

describe("deleteAssetType", () => {
  it("404s, refuses a built-in with 403", async () => {
    await expectStatus(deleteAssetType("x"), 404);
    stubbed(defs.findUnique).mockResolvedValue(builtIn());
    await expectStatus(deleteAssetType("b-1"), 403, /cannot be deleted/);
    expect(defs.delete).not.toHaveBeenCalled();
  });
  it("refuses a type still in use, naming the count", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def());
    stubbed(prisma.asset.count).mockResolvedValue(2);
    await expectStatus(deleteAssetType("t-1"), 409, /"camera" — 2 asset\(s\) still reference it/);
    expect(defs.delete).not.toHaveBeenCalled();
  });
  it("deletes an unused custom type and refreshes the cache", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def());
    await deleteAssetType("t-1");
    expect(defs.delete).toHaveBeenCalledWith({ where: { id: "t-1" } });
    expect(defs.findMany).toHaveBeenCalledTimes(1);
  });
});

// ─── refreshCache ─────────────────────────────────────────────────────────────

describe("refreshCache", () => {
  it("warms the name registry and the match registry from one read", async () => {
    stubbed(defs.findMany).mockResolvedValue([
      { name: "camera", label: "Camera", isBuiltIn: false, matchRules: { clauses: [{ field: "model", op: "contains", value: "axis" }] }, matchContexts: ["directory"], matchPriority: 5 },
    ]);
    await refreshCache();
    expect(defs.findMany).toHaveBeenCalledTimes(1);
    expect(isKnownAssetType("camera")).toBe(true);
    expect(resolveAssetTypeCached({ model: "AXIS M3106" }, "directory")).toBe("camera");
    expect(resolveAssetTypeCached({ model: "AXIS M3106" }, "scan")).toBeNull();
  });
  it("an emptied registry is a real answer: nothing is known, nothing matches", async () => {
    stubbed(defs.findMany).mockResolvedValue([]);
    await refreshCache();
    expect(isKnownAssetType("server")).toBe(false);
    expect(resolveAssetTypeCached({ os: "Windows Server 2022" }, "directory")).toBeNull();
  });
});

// ─── seedBuiltInAssetTypes ────────────────────────────────────────────────────

describe("seedBuiltInAssetTypes", () => {
  it("creates every missing built-in as built-in + protected", async () => {
    const out = await seedBuiltInAssetTypes();
    expect(out.inserted).toBe(11);
    const names = stubbed(defs.create).mock.calls.map((c) => c[0].data.name);
    expect(names).toContain("container");
    expect(names).not.toContain("virtual_machine");
    for (const c of stubbed(defs.create).mock.calls) expect(c[0].data).toMatchObject({ isBuiltIn: true, isProtected: true });
  });

  it("stamps the shipped matching only on a type that has some", async () => {
    await seedBuiltInAssetTypes();
    const byName = new Map(stubbed(defs.create).mock.calls.map((c) => [c[0].data.name, c[0].data]));
    expect(byName.get("server")).toMatchObject({ matchRules: DEFAULT_TYPE_MATCHING.server.rules, matchContexts: ["directory", "inventory"], matchPriority: 20 });
    expect(byName.get("other")).not.toHaveProperty("matchRules");
    expect(byName.get("hypervisor")).not.toHaveProperty("matchContexts");
  });

  it("leaves an existing row untouched, even one whose rules were cleared", async () => {
    stubbed(defs.findUnique).mockImplementation(async ({ where }: { where: { name: string } }) => (where.name === "server" ? def({ name: "server", matchRules: null }) : null));
    const out = await seedBuiltInAssetTypes();
    expect(out.inserted).toBe(10);
    expect(stubbed(defs.create).mock.calls.map((c) => c[0].data.name)).not.toContain("server");
    expect(defs.update).not.toHaveBeenCalled();
  });

  it("is idempotent once everything exists", async () => {
    stubbed(defs.findUnique).mockResolvedValue(def());
    expect(await seedBuiltInAssetTypes()).toEqual({ inserted: 0 });
  });
});

// ─── previewMatchRules / applyMatchRules ──────────────────────────────────────

const registry = [
  { name: "server", matchRules: DEFAULT_TYPE_MATCHING.server.rules, matchContexts: ["directory", "inventory"], matchPriority: 20 },
  { name: "camera", matchRules: rules("axis", "model"), matchContexts: ["inventory"], matchPriority: 50 },
  { name: "printer", matchRules: DEFAULT_TYPE_MATCHING.printer.rules, matchContexts: ["scan"], matchPriority: 18 },
];

function asset(id: string, over: Record<string, string | null> = {}) {
  return { id, hostname: `h-${id}`, os: null, osVersion: null, manufacturer: null, model: null, productType: null, ...over };
}

describe("previewMatchRules", () => {
  beforeEach(() => {
    stubbed(defs.findMany).mockResolvedValue(registry);
  });

  it("examines only assets typed `other`, with every fact column", async () => {
    await previewMatchRules();
    expect(stubbed(prisma.asset.findMany).mock.calls[0][0]).toEqual({
      where: { assetType: "other" },
      select: { id: true, hostname: true, os: true, osVersion: true, manufacturer: true, model: true, productType: true },
    });
  });

  it("counts matches by type (most first, then name), with the deciding clause", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([
      asset("1", { os: "Rocky Linux 9" }),
      asset("2", { os: "Windows Server 2022" }),
      asset("3", { model: "AXIS P3245" }),
      asset("4", { os: "unknown thing" }),
    ]);
    const out = await previewMatchRules();
    expect(out).toMatchObject({ examined: 4, matched: 3, truncated: false, byType: [{ type: "server", count: 2 }, { type: "camera", count: 1 }] });
    const s1 = out.sample.find((s) => s.id === "1");
    expect(s1).toMatchObject({ currentType: "other", matchedType: "server", matchedClause: { field: "os", operator: "contains", value: "rocky linux" } });
  });

  it("an inventory-only type reaches stored assets (rule 164); a scan-only type never does", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("1", { model: "AXIS" }), asset("2", { model: "HP LaserJet" })]);
    const out = await previewMatchRules();
    expect(out.byType).toEqual([{ type: "camera", count: 1 }]);
  });

  it("a rule on productType previews against the stored productType", async () => {
    stubbed(defs.findMany).mockResolvedValue([{ name: "pdu", matchRules: rules("rack pdu", "productType"), matchContexts: ["directory"], matchPriority: 5 }]);
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("1", { productType: "Rack PDU" })]);
    expect((await previewMatchRules()).matched).toBe(1);
  });

  it("a draft replaces its saved namesake in the live registry", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("1", { model: "AXIS" }), asset("2", { model: "Hikvision DS-2" })]);
    const out = await previewMatchRules({ name: "camera", matchRules: rules("hikvision", "model"), matchContexts: ["directory"], matchPriority: 50 });
    expect(out.sample.map((s) => s.id)).toEqual(["2"]);
  });

  it("a draft is judged against higher-priority types, not alone", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("1", { os: "Ubuntu Server 24.04" })]);
    const out = await previewMatchRules({ name: "linuxbox", matchRules: rules("ubuntu"), matchContexts: ["directory"], matchPriority: 90 });
    expect(out.byType).toEqual([{ type: "server", count: 1 }]);
  });

  it("an invalid draft is 400", async () => {
    await expectStatus(previewMatchRules({ name: "x", matchRules: { op: "xor", children: [] } as never, matchContexts: [], matchPriority: 1 }), 400, /unknown group operator/);
  });

  it("caps the sample at 100 and says truncated", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue(Array.from({ length: 130 }, (_, i) => asset(String(i), { os: "CentOS 7" })));
    const out = await previewMatchRules();
    expect(out).toMatchObject({ examined: 130, matched: 130, truncated: true });
    expect(out.sample).toHaveLength(100);
  });

  it("nothing eligible is an empty result", async () => {
    expect(await previewMatchRules()).toEqual({ examined: 0, matched: 0, byType: [], sample: [], truncated: false });
  });
});

describe("applyMatchRules", () => {
  beforeEach(() => {
    stubbed(defs.findMany).mockResolvedValue(registry);
  });

  it("does nothing when no rule claims anything", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("1")]);
    expect(await applyMatchRules()).toEqual({ updated: 0, byType: [] });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("one updateMany per target type in one transaction, re-asserting `other` in the WHERE", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("1", { os: "RHEL 9" }), asset("2", { os: "FreeBSD" }), asset("3", { model: "AXIS" })]);
    stubbed(prisma.asset.updateMany).mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => ({ count: where.id.in.length }));
    const out = await applyMatchRules();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["1", "2"] }, assetType: "other" }, data: { assetType: "server" } });
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({ where: { id: { in: ["3"] }, assetType: "other" }, data: { assetType: "camera" } });
    expect(out).toEqual({ updated: 3, byType: [{ type: "server", count: 2 }, { type: "camera", count: 1 }] });
  });

  it("reports what actually moved: a row typed in between counts 0 and a type with none is dropped", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([asset("1", { os: "RHEL 9" }), asset("3", { model: "AXIS" })]);
    stubbed(prisma.asset.updateMany).mockImplementation(async ({ data }: { data: { assetType: string } }) => ({ count: data.assetType === "camera" ? 0 : 1 }));
    expect(await applyMatchRules()).toEqual({ updated: 1, byType: [{ type: "server", count: 1 }] });
  });
});
