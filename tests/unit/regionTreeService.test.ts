/**
 * tests/unit/regionTreeService.test.ts — the database-backed half of
 * src/services/regionTreeService.ts (business rules 153, 156, 168), on the
 * shared _dbStub with a small in-memory RegionNode table behind it.
 *
 * Complements tests/unit/regionTree.test.ts (the PURE half: resolveLocation,
 * chainOf, the remap* re-keyers, rewritesFor, renameRoomContainers, findFloor)
 * and tests/unit/alertDependencyPathTree.test.ts (which mocks siteForAsset
 * away). Covered here: listRegionNodes / loadRegionIndex, createRegionNode
 * (kind / name / parent / floor-number validation, the per-building floor
 * number, the P2002 → 409 mapping, the per-site cap), buildFromDescriptions
 * (only adds, top-down, floors need a holder), updateRegionNode (rename,
 * move, cycle refusal, rewrites + carried view data), mergeRegionNodes,
 * deleteRegionNode and siteForAsset (firewall / switch / endpoint ladder).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  listRegionNodes, loadRegionIndex, createRegionNode, buildFromDescriptions,
  updateRegionNode, mergeRegionNodes, deleteRegionNode, siteForAsset, uniqueKeyFor,
  type RegionKind,
} from "../../src/services/regionTreeService.js";
import type { LocationCodes } from "../../src/utils/locationCodes.js";

const SITE = "site-1";
const codes = (o: Partial<LocationCodes>): LocationCodes => ({ area: null, building: null, floor: null, room: null, rack: null, junctionBox: null, ...o });

interface Row { id: string; siteId: string; kind: string; name: string; parentId: string | null; level: number | null; uniqueKey: string; createdBy?: string | null }
let table: Row[] = [];
let nextId = 0;

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "NOT") {
      const not = v as Record<string, unknown>;
      if (Object.entries(not).every(([nk, nv]) => (row as unknown as Record<string, unknown>)[nk] === nv)) return false;
      continue;
    }
    if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

function node(id: string, kind: RegionKind, name: string, parentId: string | null, level: number | null = null): Row {
  return { id, siteId: SITE, kind, name, parentId, level, uniqueKey: uniqueKeyFor(kind, name, parentId) };
}

function installTable(): void {
  const m = prisma.regionNode;
  stubbed(m.findMany).mockImplementation(async ({ where }: { where: Record<string, unknown> }) => table.filter((r) => matches(r, where)).map((r) => ({ ...r })));
  stubbed(m.findFirst).mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
    const r = table.find((x) => matches(x, where));
    return r ? { ...r } : null;
  });
  stubbed(m.findUnique).mockImplementation(async ({ where }: { where: { id: string } }) => {
    const r = table.find((x) => x.id === where.id);
    return r ? { ...r } : null;
  });
  stubbed(m.count).mockImplementation(async ({ where }: { where: Record<string, unknown> }) => table.filter((r) => matches(r, where)).length);
  stubbed(m.create).mockImplementation(async ({ data }: { data: Omit<Row, "id"> & { id?: string } }) => {
    if (table.some((r) => r.siteId === data.siteId && r.uniqueKey === data.uniqueKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
    const row: Row = { ...data, id: data.id ?? `new-${++nextId}` } as Row;
    table.push(row);
    return { ...row };
  });
  stubbed(m.update).mockImplementation(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const r = table.find((x) => x.id === where.id)!;
    if (data.uniqueKey && table.some((x) => x !== r && x.siteId === r.siteId && x.uniqueKey === data.uniqueKey)) throw Object.assign(new Error("unique"), { code: "P2002" });
    Object.assign(r, data);
    return { ...r };
  });
  stubbed(m.delete).mockImplementation(async ({ where }: { where: { id: string } }) => {
    const i = table.findIndex((x) => x.id === where.id);
    const [r] = table.splice(i, 1);
    return r;
  });
  stubbed(prisma.topologyView.findMany).mockResolvedValue([]);
  stubbed(prisma.topologyLayout.findMany).mockResolvedValue([]);
}

// Mine > Shop > floor 1 > Closet > rack1 ; Mine > Office
function seed(): void {
  table = [
    node("a", "area", "Mine", null),
    node("b1", "building", "Shop", "a"),
    node("b2", "building", "Office", "a"),
    node("f1", "floor", "1", "b1", 1),
    node("r", "room", "Closet", "f1"),
    node("k", "rack", "rack1", "r"),
  ];
}

beforeEach(() => {
  resetDbStub();
  nextId = 0;
  seed();
  installTable();
});

describe("listRegionNodes / loadRegionIndex", () => {
  it("returns the site's nodes as DTOs and drops a row whose kind is not a region kind", async () => {
    table.push({ ...node("x", "area", "Junk", null), kind: "planet" });
    const out = await listRegionNodes(SITE);
    expect(out.map((n) => n.id).sort()).toEqual(["a", "b1", "b2", "f1", "k", "r"]);
    expect(out.find((n) => n.id === "f1")).toEqual({ id: "f1", kind: "floor", name: "1", parentId: "b1", level: 1 });
  });

  it("loadRegionIndex indexes by id, unique key and numbered floor", async () => {
    const idx = await loadRegionIndex(SITE);
    expect(idx.size).toBe(6);
    expect(idx.byKey.get(uniqueKeyFor("room", "closet", null))?.id).toBe("r");
    expect(idx.byFloorLevel.get("b1|1")?.id).toBe("f1");
  });
});

describe("createRegionNode", () => {
  it("refuses an unknown kind", async () => {
    await expect(createRegionNode(SITE, { kind: "planet", name: "X" }, "me")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("refuses a missing or blank name, and a name that holds another location code", async () => {
    await expect(createRegionNode(SITE, { kind: "area" }, "me")).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createRegionNode(SITE, { kind: "area", name: "   " }, "me")).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createRegionNode(SITE, { kind: "area", name: "North b:Shop" }, "me")).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("collapses whitespace in the name and stamps the creator and unique key", async () => {
    const out = await createRegionNode(SITE, { kind: "area", name: "  South   Pit " }, "alice");
    expect(out).toMatchObject({ kind: "area", name: "South Pit", parentId: null, level: null });
    expect(table.at(-1)).toMatchObject({ createdBy: "alice", uniqueKey: "area|south pit" });
  });

  it("rule 168: a floor needs its number, and with no label is named by it", async () => {
    await expect(createRegionNode(SITE, { kind: "floor", parentId: "b2" }, null)).rejects.toThrow(/number/);
    const out = await createRegionNode(SITE, { kind: "floor", parentId: "b2", level: "-1" }, null);
    expect(out).toMatchObject({ name: "-1", level: -1, parentId: "b2" });
  });

  it("rule 168: refuses a floor number out of range or not whole", async () => {
    await expect(createRegionNode(SITE, { kind: "floor", parentId: "b2", level: 100 }, null)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createRegionNode(SITE, { kind: "floor", parentId: "b2", level: -21 }, null)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(createRegionNode(SITE, { kind: "floor", parentId: "b2", level: 1.5 }, null)).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("a floor needs a holder", async () => {
    await expect(createRegionNode(SITE, { kind: "floor", level: 2 }, null)).rejects.toThrow(/building/);
  });

  it("rule 168: a building has one floor per number (409 names the existing label)", async () => {
    table.find((r) => r.id === "f1")!.name = "Ground";
    await expect(createRegionNode(SITE, { kind: "floor", parentId: "b1", level: 1, name: "Main" }, null))
      .rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining('("Ground")') });
  });

  it("the same floor number under another building is fine", async () => {
    const out = await createRegionNode(SITE, { kind: "floor", parentId: "b2", level: 1 }, null);
    expect(out.parentId).toBe("b2");
  });

  it("a parent must be an OUTER level", async () => {
    await expect(createRegionNode(SITE, { kind: "building", name: "Annex", parentId: "r" }, null)).rejects.toThrow(/can't be inside a room/);
    await expect(createRegionNode(SITE, { kind: "building", name: "Annex", parentId: "b1" }, null)).rejects.toThrow(/can't be inside a building/);
  });

  it("a parent from another site (or missing) is a 404", async () => {
    table.push({ ...node("other", "area", "Elsewhere", null), siteId: "site-2" });
    await expect(createRegionNode(SITE, { kind: "building", name: "Annex", parentId: "other" }, null)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("maps a unique-key clash to a 409 naming the kind", async () => {
    await expect(createRegionNode(SITE, { kind: "room", name: "closet", parentId: "f1" }, null))
      .rejects.toMatchObject({ httpStatus: 409, message: 'This site already has a room called "closet"' });
  });

  it("re-throws a database error that is not a clash", async () => {
    stubbed(prisma.regionNode.create).mockRejectedValueOnce(new Error("connection lost"));
    await expect(createRegionNode(SITE, { kind: "area", name: "New" }, null)).rejects.toThrow("connection lost");
  });

  it("refuses a node beyond the per-site cap of 5000", async () => {
    stubbed(prisma.regionNode.count).mockResolvedValueOnce(5000);
    await expect(createRegionNode(SITE, { kind: "area", name: "New" }, null)).rejects.toThrow(/at most 5000/);
    expect(prisma.regionNode.create).not.toHaveBeenCalled();
  });
});

describe("buildFromDescriptions — only adds", () => {
  it("adds the missing levels top-down, under the nearest region the chain names", async () => {
    const out = await buildFromDescriptions(SITE, [codes({ building: "Shop", floor: "2", room: "Lab" })], "me");
    expect(out).toEqual({ added: 2 });
    const f2 = table.find((r) => r.kind === "floor" && r.level === 2)!;
    expect(f2).toMatchObject({ parentId: "b1", name: "2", createdBy: "me" });
    expect(table.find((r) => r.name === "Lab")).toMatchObject({ parentId: f2.id });
  });

  it("adds nothing for chains the tree already holds, and skips null entries", async () => {
    const out = await buildFromDescriptions(SITE, [null, codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet" })], null);
    expect(out).toEqual({ added: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("finds an existing floor by its number even when it carries a label (rule 168)", async () => {
    table.find((r) => r.id === "f1")!.name = "Ground";
    const out = await buildFromDescriptions(SITE, [codes({ building: "Shop", floor: "1" })], null);
    expect(out.added).toBe(0);
  });

  it("never places a floor with nothing above it", async () => {
    const out = await buildFromDescriptions(SITE, [codes({ floor: "3", room: "Annex Room" })], null);
    expect(out.added).toBe(1);
    expect(table.some((r) => r.kind === "floor" && r.level === 3)).toBe(false);
    expect(table.find((r) => r.name === "Annex Room")?.parentId).toBeNull();
  });

  it("a text floor becomes a named floor waiting for its number", async () => {
    await buildFromDescriptions(SITE, [codes({ building: "Office", floor: "Mezzanine" })], null);
    expect(table.find((r) => r.name === "Mezzanine")).toMatchObject({ kind: "floor", level: null, parentId: "b2" });
  });

  it("dedupes a region named by many descriptions", async () => {
    const out = await buildFromDescriptions(SITE, [codes({ area: "Quarry" }), codes({ area: "quarry " }), codes({ area: "QUARRY" })], null);
    expect(out.added).toBe(1);
  });

  it("skips a value that would re-parse as another code", async () => {
    const out = await buildFromDescriptions(SITE, [codes({ area: "x b:y" })], null);
    expect(out.added).toBe(0);
  });

  it("an existing region keeps its place even when a description disagrees", async () => {
    await buildFromDescriptions(SITE, [codes({ building: "Office", floor: "1", room: "Closet" })], null);
    expect(table.find((r) => r.id === "r")?.parentId).toBe("f1");
  });

  it("refuses the whole batch when it would pass the per-site cap", async () => {
    const many = Array.from({ length: 4995 }, (_, i) => codes({ area: `A${i}` }));
    await expect(buildFromDescriptions(SITE, many, null)).rejects.toThrow(/at most 5000/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("updateRegionNode", () => {
  const devices = [
    { assetId: "d1", name: "sw1", written: codes({ room: "Closet" }) },
    { assetId: "d2", name: "sw2", written: codes({ rack: "rack1" }) },
    { assetId: "d3", name: "sw3", written: codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet", rack: "rack1" }) },
  ];

  it("renames, writes the new unique key and returns the descriptions that WROTE the old name", async () => {
    const out = await updateRegionNode(SITE, "r", { name: "IDF" }, devices);
    expect(out.node).toEqual({ id: "r", kind: "room", name: "IDF", parentId: "f1", level: null });
    expect(table.find((x) => x.id === "r")).toMatchObject({ name: "IDF", uniqueKey: "room|idf" });
    expect(out.rewrites.map((w) => w.assetId)).toEqual(["d1", "d3"]); // d2's short rack code resolves through the tree
    expect(out.rewrites[0].codes).toEqual(codes({ room: "IDF" }));
  });

  it("rule 153: never writes a description — only the tree and the stored view data", async () => {
    await updateRegionNode(SITE, "r", { name: "IDF" }, devices);
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(prisma.asset.updateMany).not.toHaveBeenCalled();
  });

  it("carries a Room view's region and its rack names in the same transaction (rule 156)", async () => {
    stubbed(prisma.topologyView.findMany).mockResolvedValue([
      { id: "v1", mode: "room", region: codes({ area: "Mine", building: "Shop", floor: "1", room: "Closet" }), polygons: null, racks: [{ name: "rack1" }, { name: "rack2" }], walls: [] },
      { id: "v2", mode: "topology", region: codes({ area: "Mine", building: "Office" }), polygons: null, racks: null, walls: null },
    ]);
    const out = await updateRegionNode(SITE, "k", { name: "R-01" }, []);
    expect(out.carried).toEqual({ views: 1, layouts: 0 });
    expect(prisma.topologyView.update).toHaveBeenCalledWith({ where: { id: "v1" }, data: { racks: [{ name: "R-01" }, { name: "rack2" }] } });
  });

  it("re-keys a layout row but never overwrites one already saved under the new key", async () => {
    stubbed(prisma.topologyLayout.findMany).mockResolvedValue([
      { id: "l1", view: "r|mine|shop|1|closet", positions: null, savedPositions: null },
      { id: "l2", view: "r|mine|shop|1|idf", positions: null, savedPositions: null },
      { id: "l3", view: "b|mine|shop", positions: { "locgroup:r|mine|shop|1|closet": { x: 1 } }, savedPositions: null },
    ]);
    const out = await updateRegionNode(SITE, "r", { name: "IDF" }, []);
    const calls = vi.mocked(prisma.topologyLayout.update).mock.calls.map((c) => c[0]);
    expect(calls.find((c) => c.where.id === "l1")).toBeUndefined();
    expect(calls.find((c) => c.where.id === "l3")?.data).toEqual({ positions: { "locgroup:r|mine|shop|1|idf": { x: 1 } } });
    expect(out.carried.layouts).toBe(1);
  });

  it("moves a node under a new parent and computes the new chain from it", async () => {
    const out = await updateRegionNode(SITE, "r", { parentId: null }, [devices[2]]);
    expect(out.node.parentId).toBeNull();
    expect(out.rewrites[0].codes).toEqual(codes({ room: "Closet", rack: "rack1" }));
  });

  it("refuses a move that would put the region inside itself", async () => {
    await expect(updateRegionNode(SITE, "r", { parentId: "r" }, [])).rejects.toThrow(/inside itself/);
  });

  it("refuses a move into an inner level", async () => {
    await expect(updateRegionNode(SITE, "b1", { parentId: "r" }, [])).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("only a floor has a number", async () => {
    await expect(updateRegionNode(SITE, "r", { level: 3 }, [])).rejects.toThrow("Only a floor has a number");
  });

  it("rule 168: renumbering a floor onto a taken number is a 409", async () => {
    table.push(node("f2", "floor", "2", "b1", 2));
    await expect(updateRegionNode(SITE, "f2", { level: 1 }, [])).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("rule 168: renumbering carries the floor's NUMBER into the rewrites", async () => {
    const out = await updateRegionNode(SITE, "f1", { level: 4 }, [{ assetId: "d", name: "x", written: codes({ building: "Shop", floor: "1", room: "Closet" }) }]);
    expect(out.node.level).toBe(4);
    expect(out.rewrites[0].codes.floor).toBe("4");
  });

  it("a blank floor name falls back to its number", async () => {
    const out = await updateRegionNode(SITE, "f1", { name: "" }, []);
    expect(out.node.name).toBe("1");
  });

  it("maps a rename clash to 409", async () => {
    await expect(updateRegionNode(SITE, "b2", { name: "shop" }, [])).rejects.toMatchObject({ httpStatus: 409, message: 'This site already has a building called "shop"' });
  });

  it("404s a node of another site", async () => {
    await expect(updateRegionNode("site-2", "r", { name: "IDF" }, [])).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("mergeRegionNodes", () => {
  it("refuses to merge a region into itself, or two kinds", async () => {
    await expect(mergeRegionNodes(SITE, "b1", "b1")).rejects.toMatchObject({ httpStatus: 400 });
    await expect(mergeRegionNodes(SITE, "b1", "a")).rejects.toThrow(/same kind/);
  });

  it("moves the children, deletes the region and returns rewrites to the one it joined", async () => {
    const out = await mergeRegionNodes(SITE, "b1", "b2", [{ assetId: "d", name: "x", written: codes({ building: "Shop", floor: "1" }) }]);
    expect(table.find((r) => r.id === "b1")).toBeUndefined();
    expect(table.find((r) => r.id === "f1")).toMatchObject({ parentId: "b2", uniqueKey: uniqueKeyFor("floor", "1", "b2") });
    expect(out.node.id).toBe("b2");
    expect(out.rewrites[0].codes).toEqual(codes({ building: "Office", floor: "1" }));
  });

  it("refuses when both hold a same-named child (409, nothing deleted)", async () => {
    table.push(node("f1b", "floor", "1", "b2", 1));
    await expect(mergeRegionNodes(SITE, "b1", "b2")).rejects.toMatchObject({ httpStatus: 409 });
    expect(table.find((r) => r.id === "b1")).toBeDefined();
  });

  // Was a bug until 2026-11-12: the twin check compared only uniqueKey, which a
  // floor derives from its NAME, so floor 1 "Ground" merged beside floor 1 "1"
  // and the building had two floors numbered 1. mergeRegionNodes now checks
  // the number too (rule 168, as checkFloorLevel does everywhere else).
  it("rule 168: refuses a merge that would leave a building with two floors of one number", async () => {
    table.find((r) => r.id === "f1")!.name = "Ground";
    table.find((r) => r.id === "f1")!.uniqueKey = uniqueKeyFor("floor", "Ground", "b1");
    table.push(node("f1b", "floor", "1", "b2", 1));
    await expect(mergeRegionNodes(SITE, "b1", "b2")).rejects.toMatchObject({ httpStatus: 409 });
  });
});

describe("deleteRegionNode", () => {
  it("refuses a region that still has regions inside it", async () => {
    await expect(deleteRegionNode(SITE, "f1")).rejects.toThrow('"1" still has 1 region inside it');
  });

  it("deletes a leaf and returns it", async () => {
    const out = await deleteRegionNode(SITE, "k");
    expect(out).toEqual({ id: "k", kind: "rack", name: "rack1", parentId: "r" });
    expect(table.find((r) => r.id === "k")).toBeUndefined();
  });

  it("404s an unknown id", async () => {
    await expect(deleteRegionNode(SITE, "nope")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("siteForAsset", () => {
  const assets = new Map<string, Record<string, unknown>>();
  beforeEach(() => {
    assets.clear();
    stubbed(prisma.asset.findUnique).mockImplementation(async ({ where }: { where: { id: string } }) => assets.get(where.id) ?? null);
  });

  it("404s an unknown asset", async () => {
    await expect(siteForAsset("ghost")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("a FortiGate is its own site", async () => {
    assets.set("fw", { id: "fw", assetType: "firewall", fortinetTopology: null });
    expect(await siteForAsset("fw")).toBe("fw");
  });

  it("a switch resolves to its controller gate by the stamped serial, never by hostname", async () => {
    assets.set("sw", { id: "sw", assetType: "switch", fortinetTopology: { controllerSerial: "FGT123", controllerFortigate: "HQ" } });
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { id: "gate-by-host", hostname: "FGT123x", serialNumber: "OTHER", assetType: "firewall", fortinetTopology: null },
      { id: "gate", hostname: "hq-fw", serialNumber: "FGT123", assetType: "firewall", fortinetTopology: null },
    ]);
    expect(await siteForAsset("sw")).toBe("gate");
    const where = vi.mocked(prisma.asset.findMany).mock.calls[0][0]!.where as { assetType: string };
    expect(where.assetType).toBe("firewall");
  });

  it("an unstamped switch or AP belongs to no site (no query)", async () => {
    assets.set("ap", { id: "ap", assetType: "access_point", fortinetTopology: null });
    expect(await siteForAsset("ap")).toBeNull();
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("an endpoint follows its switch-port dependency edge to the switch's site", async () => {
    assets.set("pc", { id: "pc", assetType: "workstation", fortinetTopology: null, lastSeenSwitch: null, dependencyParents: [{ parentAssetId: "sw" }] });
    assets.set("sw", { id: "sw", assetType: "switch", fortinetTopology: { controllerSerial: "FGT1" } });
    stubbed(prisma.asset.findFirst).mockResolvedValue({ id: "sw" });
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "gate", hostname: null, serialNumber: "FGT1", assetType: "firewall", fortinetTopology: null }]);
    expect(await siteForAsset("pc")).toBe("gate");
  });

  it("an endpoint with no edge trusts lastSeenSwitch only for a fleet-unique switch name (rule 91)", async () => {
    assets.set("pc", { id: "pc", assetType: "workstation", fortinetTopology: null, lastSeenSwitch: "IDF-1/port5", dependencyParents: [] });
    stubbed(prisma.asset.findMany).mockResolvedValueOnce([{ id: "s1" }, { id: "s2" }]);
    expect(await siteForAsset("pc")).toBeNull();
    const where = vi.mocked(prisma.asset.findMany).mock.calls[0][0]!.where as { hostname: unknown };
    expect(where.hostname).toEqual({ equals: "IDF-1", mode: "insensitive" });
  });

  it("an endpoint with neither edge nor lastSeenSwitch has no site", async () => {
    assets.set("pc", { id: "pc", assetType: "workstation", fortinetTopology: null, lastSeenSwitch: null, dependencyParents: [] });
    expect(await siteForAsset("pc")).toBeNull();
  });
});
