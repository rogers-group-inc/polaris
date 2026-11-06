/**
 * tests/unit/tagRegistryService.test.ts — the tag registry's guards and
 * writes (services/tagRegistryService.ts, lifted out of routes/tags.ts by
 * CQ-B044). The SQL of the rename rewrite is pinned by the integration suite
 * (tagFilterRoutes, builtinPriorityTags, azureTagsHidden, interfaceTags).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  tag: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  setting: { findUnique: vi.fn(), upsert: vi.fn() },
  $executeRaw: vi.fn(),
  $transaction: vi.fn(),
}));
const logEvent = vi.hoisted(() => vi.fn());
const reconcileTag = vi.hoisted(() => vi.fn());
const stripTagAssignments = vi.hoisted(() => vi.fn());

vi.mock("../../src/db.js", () => ({ prisma: db }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent }));
vi.mock("../../src/services/tagAssignmentService.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/tagAssignmentService.js")>()),
  reconcileTag,
  stripTagAssignments,
}));

const svc = await import("../../src/services/tagRegistryService.js");

const row = (over: Record<string, unknown> = {}) => ({
  id: "t1", name: "Plant", category: "General", color: "#4ade80", builtIn: false,
  assetCondition: null, criteria: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  reconcileTag.mockResolvedValue(undefined);
  db.$executeRaw.mockResolvedValue(0);
  db.$transaction.mockResolvedValue([]);
});

describe("listTagRegistry", () => {
  it("returns every row with its filter view folded in, ordered by category then name", async () => {
    db.tag.findMany.mockResolvedValue([row()]);
    const out = await svc.listTagRegistry();
    expect(db.tag.findMany).toHaveBeenCalledWith({ orderBy: [{ category: "asc" }, { name: "asc" }] });
    expect(out[0]).toMatchObject({ id: "t1", name: "Plant" });
  });
});

describe("createTag", () => {
  it("creates a manual tag, defaulting the category, and writes tag.created", async () => {
    db.tag.findUnique.mockResolvedValue(null);
    db.tag.create.mockImplementation(async ({ data }: any) => ({ id: "new", ...data }));
    const tag = await svc.createTag({ name: "  Plant  " }, "alice");
    expect(tag).toMatchObject({ name: "Plant", category: "General" });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "tag.created", actor: "alice" }));
    expect(reconcileTag).not.toHaveBeenCalled();
  });

  it("refuses a blank name (400), a duplicate (409) and every reserved name or category (409)", async () => {
    await expect(svc.createTag({ name: "  " }, "a")).rejects.toMatchObject({ httpStatus: 400 });
    db.tag.findUnique.mockResolvedValue(row());
    await expect(svc.createTag({ name: "Plant" }, "a")).rejects.toMatchObject({ httpStatus: 409 });
    db.tag.findUnique.mockResolvedValue(null);
    await expect(svc.createTag({ name: "Region:East" }, "a")).rejects.toMatchObject({ httpStatus: 409 });
    await expect(svc.createTag({ name: "azure:env" }, "a")).rejects.toMatchObject({ httpStatus: 409 });
    await expect(svc.createTag({ name: "X", category: "Map Regions" }, "a")).rejects.toMatchObject({ httpStatus: 409 });
    expect(db.tag.create).not.toHaveBeenCalled();
  });
});

describe("tag settings", () => {
  it("reads { enforce: false } when unset and audits a write", async () => {
    db.setting.findUnique.mockResolvedValue(null);
    expect(await svc.getTagSettings()).toEqual({ enforce: false });
    db.setting.upsert.mockResolvedValue({ value: { enforce: true } });
    expect(await svc.updateTagSettings(true, "bob")).toEqual({ enforce: true });
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "tag.settings.updated", actor: "bob" }));
  });
});

describe("updateTag", () => {
  it("404s a missing tag", async () => {
    db.tag.findUnique.mockResolvedValue(null);
    await expect(svc.updateTag("nope", {}, "a")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("a rename rewrites the string across every tag-bearing table and re-reconciles", async () => {
    db.tag.findUnique.mockImplementation(async ({ where }: any) => (where.id ? row() : null));
    db.tag.update.mockImplementation(async ({ data }: any) => ({ ...row(), ...data }));
    const tag = await svc.updateTag("t1", { name: "Mill" }, "a");
    expect(tag.name).toBe("Mill");
    expect(db.$executeRaw).toHaveBeenCalledTimes(7); // 3 array_replace + 2 × (delete + update)
    expect(db.$transaction).toHaveBeenCalledTimes(2);
    expect(reconcileTag).toHaveBeenCalledWith("t1");
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "tag.updated" }));
  });

  it("a colour-only edit rewrites nothing and does not reconcile", async () => {
    db.tag.findUnique.mockResolvedValue(row());
    db.tag.update.mockImplementation(async ({ data }: any) => ({ ...row(), ...data }));
    await svc.updateTag("t1", { color: "#f87171" }, "a");
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(reconcileTag).not.toHaveBeenCalled();
  });

  it("refuses editing a mirrored azure: row and changing a built-in Priority tag's fixed fields", async () => {
    db.tag.findUnique.mockResolvedValue(row({ name: "azure:env" }));
    await expect(svc.updateTag("t1", { color: "#000000" }, "a")).rejects.toMatchObject({ httpStatus: 409 });
    db.tag.findUnique.mockResolvedValue(row({ name: "Critical", category: "Priority", color: "severity:critical", builtIn: true }));
    await expect(svc.updateTag("t1", { name: "P1" }, "a")).rejects.toMatchObject({ httpStatus: 409 });
    expect(db.tag.update).not.toHaveBeenCalled();
  });
});

describe("deleteTag", () => {
  it("deletes a manual tag and audits it at warning", async () => {
    db.tag.findUnique.mockResolvedValue(row());
    await svc.deleteTag("t1", "a");
    expect(db.tag.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(stripTagAssignments).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "tag.deleted", level: "warning" }));
  });

  it("refuses a built-in Priority tag and a mirrored azure: row", async () => {
    db.tag.findUnique.mockResolvedValue(row({ builtIn: true }));
    await expect(svc.deleteTag("t1", "a")).rejects.toMatchObject({ httpStatus: 409 });
    db.tag.findUnique.mockResolvedValue(row({ name: "azure:env" }));
    await expect(svc.deleteTag("t1", "a")).rejects.toMatchObject({ httpStatus: 409 });
    expect(db.tag.delete).not.toHaveBeenCalled();
  });
});
