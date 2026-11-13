/**
 * tests/unit/mapRegionService.test.ts — mapRegionService's own suite (CQ-T010):
 * the region CRUD half and the reconcile driver.
 *
 * Complements, and does not repeat:
 *   - mapRegionDrift.test.ts         — diffRegionMembership, applyOneRegion add /
 *                                      drift, applyDelete, the map-save review
 *   - mapRegionHierarchy.test.ts     — levels, the hierarchy cache, setRegionNesting
 *   - mapRegionRetiredSweep.test.ts  — the retired-name record + sweep
 *   - mapRegionTagChunking.test.ts   — the 50-row chunking of tag writers
 *   - mapRegionTagPrefixGuard.test.ts — assertAddedRegionTagsNameARegion
 *   - integration/mapRegionConcurrentWrites + mapRegionSubnetTags — the advisory
 *     lock under real concurrency, subnet propagation, rule 169(b) on a real DB
 *
 * Covered here: name / colour / polygon validation (every refusal), create
 * (409 on a case-insensitive duplicate, colour default + lower-casing, tag
 * registry upsert in the "Map Regions" category, the advisory lock taken FIRST
 * in the transaction), update (partial edits, rename vs case-only change,
 * polygonChanged, registry rotation, 404 / 409), delete (404, children's
 * nestUnderId cleared, registry row dropped), the legacy-colour back-fill at
 * read time (without writing), a registry failure being non-fatal, applyRename's
 * summary, and reconcileMapRegions' per-region failure isolation + totals.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import {
  createRegion,
  updateRegion,
  deleteRegion,
  listRegions,
  applyRename,
  reconcileMapRegions,
  randomTagColor,
  REGION_TAG_CATEGORY,
  type MapRegion,
} from "../../src/services/mapRegionService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const SQUARE: Array<[number, number]> = [[35, -87], [35, -86], [36, -86], [36, -87]];
let settings: Map<string, unknown>;
const order: string[] = [];

function region(over: Partial<MapRegion>): MapRegion {
  return { id: "r1", name: "Nashville", polygon: SQUARE, color: "#4fc3f7", createdBy: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...over };
}
const stored = (): MapRegion[] => settings.get("mapRegions") as MapRegion[];
const retired = (): Array<{ name: string; reason: string }> => (settings.get("mapRegionRetiredNames") as never) ?? [];

beforeEach(() => {
  resetDbStub();
  settings = new Map();
  order.length = 0;
  stubbed(prisma.setting.findUnique).mockImplementation(async ({ where }: any) => {
    order.push("read:" + where.key);
    return settings.has(where.key) ? { value: settings.get(where.key), updatedAt: new Date("2026-01-01T00:00:00Z") } : null;
  });
  stubbed(prisma.setting.upsert).mockImplementation(async ({ where, update }: any) => {
    order.push("write:" + where.key);
    settings.set(where.key, JSON.parse(JSON.stringify(update.value)));
    return {};
  });
  stubbed(prisma.$executeRaw).mockImplementation(async () => { order.push("lock"); return 1; });
  stubbed(prisma.tag.upsert).mockResolvedValue({});
  stubbed(prisma.tag.deleteMany).mockResolvedValue({ count: 1 });
});

describe("validation — refused before the lock is taken", () => {
  it.each([
    [{ name: undefined }, /name is required/],
    [{ name: "   " }, /name is required/],
    [{ name: "x".repeat(65) }, /64 characters or fewer/],
    [{ name: "Bad\u0007Name" }, /control characters/],
    [{ polygon: "nope" }, /array of \[lat, lng\] pairs/],
    [{ polygon: [[1, 1], [2, 2]] }, /at least 3 vertices/],
    [{ polygon: Array.from({ length: 1001 }, (_, i) => [0, i / 10]) }, /more than 1000 vertices/],
    [{ polygon: [[1, 1], [2, 2], [3]] }, /\[lat, lng\] pair/],
    [{ polygon: [[1, 1], [2, 2], ["x", 3]] }, /finite numbers/],
    [{ polygon: [[1, 1], [2, 2], [91, 3]] }, /Latitude must be between -90 and 90/],
    [{ polygon: [[1, 1], [2, 2], [3, -181]] }, /Longitude must be between -180 and 180/],
    [{ color: 123 }, /hex string/],
    [{ color: "#abc" }, /7-character hex string/],
  ])("createRegion refuses %j", async (over, msg) => {
    await expect(createRegion({ name: "Ok", polygon: SQUARE, ...over } as never)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(msg) });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts exactly 64 characters and exactly 1000 vertices, and coerces numeric strings", async () => {
    const poly = Array.from({ length: 1000 }, (_, i) => [String(i / 100), "1"]);
    const r = await createRegion({ name: "y".repeat(64), polygon: poly as never });
    expect(r.polygon).toHaveLength(1000);
    expect(r.polygon[5]).toEqual([0.05, 1]);
  });
});

describe("createRegion", () => {
  it("takes the advisory lock as the FIRST statement, then reads, then writes", async () => {
    await createRegion({ name: "Memphis", polygon: SQUARE });
    expect(order).toEqual(["lock", "read:mapRegions", "write:mapRegions"]);
  });

  it("stores a trimmed name, a lower-cased colour, the actor and matching timestamps", async () => {
    const r = await createRegion({ name: "  Memphis  ", polygon: SQUARE, color: " #ABCDEF ", actor: "alice" });
    expect(r).toMatchObject({ name: "Memphis", color: "#abcdef", createdBy: "alice" });
    expect(r.createdAt).toBe(r.updatedAt);
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(stored()).toEqual([r]);
  });

  it("defaults the colour to a palette pick", async () => {
    const r = await createRegion({ name: "Memphis", polygon: SQUARE });
    expect(r.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(randomTagColor()).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("409s a case-insensitive duplicate and writes nothing", async () => {
    settings.set("mapRegions", [region({ name: "Nashville" })]);
    await expect(createRegion({ name: "NASHVILLE", polygon: SQUARE })).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
    expect(prisma.tag.upsert).not.toHaveBeenCalled();
  });

  it("mirrors the region into the tag registry under its category, without overwriting an existing colour", async () => {
    await createRegion({ name: "Memphis", polygon: SQUARE });
    const call = stubbed(prisma.tag.upsert).mock.calls[0][0];
    expect(call.where).toEqual({ name: "region:Memphis" });
    expect(call.update).toEqual({});
    expect(call.create).toMatchObject({ name: "region:Memphis", category: REGION_TAG_CATEGORY });
  });

  it("a registry failure does not fail the create", async () => {
    stubbed(prisma.tag.upsert).mockRejectedValue(new Error("tag table locked"));
    await expect(createRegion({ name: "Memphis", polygon: SQUARE })).resolves.toMatchObject({ name: "Memphis" });
  });
});

describe("updateRegion", () => {
  beforeEach(() => {
    settings.set("mapRegions", [region({}), region({ id: "r2", name: "Memphis" })]);
  });

  it("404s an unknown id", async () => {
    await expect(updateRegion("nope", { color: "#000000" })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("a colour-only edit keeps name and polygon and is neither a rename nor a polygon change", async () => {
    const res = await updateRegion("r1", { color: "#00FF00" });
    expect(res).toMatchObject({ renamed: false, polygonChanged: false, previousName: "Nashville", region: { name: "Nashville", color: "#00ff00", polygon: SQUARE } });
    expect(prisma.tag.deleteMany).not.toHaveBeenCalled();
    expect(retired()).toEqual([]);
  });

  it("re-sending the same polygon is not a polygon change; moving a vertex is", async () => {
    expect((await updateRegion("r1", { polygon: SQUARE })).polygonChanged).toBe(false);
    const moved = SQUARE.map((p, i) => (i === 0 ? [34.5, -87] : p)) as Array<[number, number]>;
    expect((await updateRegion("r1", { polygon: moved })).polygonChanged).toBe(true);
  });

  it("a case-only rename is NOT a rename (no tag rotation, nothing retired)", async () => {
    const res = await updateRegion("r1", { name: "NASHVILLE" });
    expect(res.renamed).toBe(false);
    expect(res.region.name).toBe("NASHVILLE");
    expect(retired()).toEqual([]);
  });

  it("a rename retires the old name in the same locked write and rotates the registry", async () => {
    const res = await updateRegion("r1", { name: "Music City" });
    expect(res).toMatchObject({ renamed: true, previousName: "Nashville" });
    expect(retired()).toEqual([expect.objectContaining({ name: "Nashville", reason: "rename" })]);
    expect(order.indexOf("write:mapRegionRetiredNames")).toBeGreaterThan(order.indexOf("write:mapRegions"));
    expect(prisma.tag.deleteMany).toHaveBeenCalledWith({ where: { name: "region:Nashville" } });
    expect(stubbed(prisma.tag.upsert).mock.calls[0][0].where).toEqual({ name: "region:Music City" });
  });

  it("409s a rename onto another region's name, case-insensitively", async () => {
    await expect(updateRegion("r1", { name: "memphis" })).rejects.toMatchObject({ httpStatus: 409 });
    expect(stored()[0].name).toBe("Nashville");
  });
});

describe("deleteRegion", () => {
  it("404s an unknown id", async () => {
    settings.set("mapRegions", []);
    await expect(deleteRegion("nope")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("removes the row, sends its children back to automatic nesting, retires the name, drops the registry row", async () => {
    settings.set("mapRegions", [
      region({ id: "parent", name: "Tennessee" }),
      region({ id: "child", name: "Nashville", nestUnderId: "parent" }),
      region({ id: "other", name: "Memphis", nestUnderId: "elsewhere" }),
    ]);
    const removed = await deleteRegion("parent");
    expect(removed.name).toBe("Tennessee");
    expect(stored().map((r) => [r.id, r.nestUnderId])).toEqual([["child", null], ["other", "elsewhere"]]);
    expect(retired()).toEqual([expect.objectContaining({ name: "Tennessee", reason: "delete" })]);
    expect(prisma.tag.deleteMany).toHaveBeenCalledWith({ where: { name: "region:Tennessee" } });
  });

  it("does not retire a name twice", async () => {
    settings.set("mapRegions", [region({ id: "a", name: "Gone" })]);
    settings.set("mapRegionRetiredNames", [{ name: "gone", regionId: "old", retiredAt: "2025-01-01T00:00:00.000Z", reason: "rename" }]);
    await deleteRegion("a");
    expect(retired()).toHaveLength(1);
  });
});

describe("listRegions — reading the blob", () => {
  it("is name-sorted, back-fills a legacy missing / bad colour, and never writes on read", async () => {
    settings.set("mapRegions", [
      { ...region({ id: "b", name: "Zeta" }), color: undefined },
      region({ id: "a", name: "Alpha", color: "#ABCDEF" }),
      { ...region({ id: "c", name: "Mid" }), color: "red" },
    ]);
    const rows = await listRegions();
    expect(rows.map((r) => r.name)).toEqual(["Alpha", "Mid", "Zeta"]);
    expect(rows[0].color).toBe("#abcdef");
    for (const r of rows) expect(r.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(prisma.setting.upsert).not.toHaveBeenCalled();
  });

  it("treats a missing or non-array blob as no regions", async () => {
    expect(await listRegions()).toEqual([]);
    settings.set("mapRegions", { not: "an array" });
    expect(await listRegions()).toEqual([]);
  });
});

describe("applyRename / reconcileMapRegions", () => {
  beforeEach(() => {
    // An empty fleet: no gate is pinned, so every membership is empty.
    stubbed(prisma.asset.findMany).mockResolvedValue([]);
    stubbed(prisma.subnet.findMany).mockResolvedValue([]);
    stubbed(prisma.ipBlock.findMany).mockResolvedValue([]);
    stubbed(prisma.regionTagAssignment.findMany).mockResolvedValue([]);
  });

  it("applyRename strips the old tag fleet-wide and reports it in the summary", async () => {
    stubbed(prisma.asset.findMany).mockImplementation(async ({ where }: any) =>
      where?.tags?.has === "region:Old" ? [{ id: "a1", tags: ["region:Old", "keep"] }, { id: "a2", tags: ["region:Old"] }] : []);
    stubbed(prisma.asset.update).mockResolvedValue({});
    const s = await applyRename(region({ name: "New" }), "Old");
    expect(s).toMatchObject({ regionId: "r1", added: 0, removed: 2, assetsTouched: 2, subnetsRemoved: 0 });
    const writes = stubbed(prisma.asset.update).mock.calls.map((c) => c[0]);
    expect(writes).toEqual([
      { where: { id: "a1" }, data: { tags: ["keep"] } },
      { where: { id: "a2" }, data: { tags: [] } },
    ]);
  });

  it("applyRename carries a hand-applied block tag to the new name without duplicating it (rule 169(b))", async () => {
    stubbed(prisma.ipBlock.findMany).mockResolvedValue([
      { id: "b1", tags: ["region:Old", "dc"] },
      { id: "b2", tags: ["region:New", "region:Old"] },
    ]);
    stubbed(prisma.ipBlock.update).mockResolvedValue({});
    const s = await applyRename(region({ name: "New" }), "Old");
    expect(s.blocksRetagged).toBe(2);
    expect(stubbed(prisma.ipBlock.update).mock.calls.map((c) => c[0].data.tags)).toEqual([["region:New", "dc"], ["region:New"]]);
  });

  it("one region's failure is logged and skipped; the others still run and the totals add up", async () => {
    settings.set("mapRegions", [region({ id: "a", name: "Alpha" }), region({ id: "b", name: "Beta" })]);
    stubbed(prisma.asset.findMany).mockRejectedValueOnce(new Error("statement timeout"));
    const s = await reconcileMapRegions();
    expect(s).toMatchObject({ added: 0, removed: 0, assetsTouched: 0, subnetsAdded: 0, subnetsRemoved: 0, subnetsTouched: 0 });
    // Beta's provenance was still read after Alpha failed
    expect(stubbed(prisma.regionTagAssignment.findMany).mock.calls.map((c) => c[0].where.regionId)).toEqual(["b"]);
    expect(s.retiredTagSweep).toMatchObject({ namesSwept: [], namesReclaimed: [] });
  });

  it("a failing retired-name sweep does not fail the reconcile; it is simply absent from the summary", async () => {
    settings.set("mapRegions", []);
    stubbed(prisma.setting.findUnique).mockImplementation(async ({ where }: any) => {
      if (where.key === "mapRegionRetiredNames") throw new Error("boom");
      return null;
    });
    const s = await reconcileMapRegions();
    expect(s).not.toHaveProperty("retiredTagSweep");
    expect(s.added).toBe(0);
  });
});
