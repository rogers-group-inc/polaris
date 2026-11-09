/**
 * tests/unit/savedFolderService.test.ts
 *
 * Folder-tree decisions of business rule 140 that the route-level integration
 * suite (tests/integration/savedFolderOwnership.test.ts) does not reach: the
 * nesting-depth bound on create AND on move (depth of the target + height of
 * the moved subtree), the per-user folder cap, the same-parent no-op, the
 * cross-list filing refusal, "include contents" acting only on rows the caller
 * could act on one by one, the 409 on a name clash, and the Event level of a
 * takeover.
 *
 * savedOwnershipService runs for real (it is the rule); Prisma is an in-memory
 * folder table.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Folder = {
  id: string; kind: string; scope: string; name: string; parentId: string | null;
  ownerId: string | null; ownerRoleId: string | null; ownerRegion: string | null; ownerName: string;
  visibility: string; createdAt: Date; updatedAt: Date; ownerRole?: { name: string } | null;
};
type Item = { id: string; folderId: string | null; ownerId: string | null; ownerRoleId: string | null; ownerRegion: string | null; ownerName: string; visibility: string };

const db = vi.hoisted(() => ({
  folders: new Map<string, Folder>(),
  filters: [] as Item[],
  dashboards: [] as Item[],
  count: 0,
  users: new Map<string, { id: string; username: string; disabledAt: Date | null }>(),
  transactionError: null as unknown,
  folderUpdateMany: [] as unknown[],
  filterUpdateMany: [] as unknown[],
  dashboardUpdateMany: [] as unknown[],
  folderDeleteMany: [] as unknown[],
  folderUpdate: [] as unknown[],
  findManyWhere: [] as unknown[],
  logEvent: vi.fn(),
}));

function matchIn(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") continue; // visibility predicate — asserted separately
    if (v && typeof v === "object" && "in" in (v as object)) {
      if (!(v as { in: unknown[] }).in.includes(row[k])) return false;
    } else if (row[k] !== v) return false;
  }
  return true;
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    savedFolder: {
      findMany: vi.fn(async (a: { where?: Record<string, unknown> } = {}) => {
        db.findManyWhere.push(a.where);
        return [...db.folders.values()].filter((f) => matchIn(a.where ?? {}, f)).sort((x, y) => x.name.localeCompare(y.name));
      }),
      findUnique: vi.fn(async (a: { where: { id: string } }) => db.folders.get(a.where.id) ?? null),
      count: vi.fn(async () => db.count),
      create: vi.fn(async (a: { data: Partial<Folder> }) => {
        const row = {
          id: "new", ownerRoleId: null, ownerRegion: null, createdAt: new Date(0), updatedAt: new Date(0), ownerRole: null,
          ...a.data,
        } as Folder;
        db.folders.set(row.id, row);
        return row;
      }),
      update: vi.fn(async (a: { where: { id: string }; data: Partial<Folder> }) => {
        db.folderUpdate.push(a);
        const row = { ...db.folders.get(a.where.id)!, ...a.data };
        db.folders.set(row.id, row);
        return row;
      }),
      updateMany: vi.fn(async (a: unknown) => { db.folderUpdateMany.push(a); return { count: 0 }; }),
      deleteMany: vi.fn(async (a: unknown) => { db.folderDeleteMany.push(a); return { count: 0 }; }),
    },
    savedTableFilter: {
      findMany: vi.fn(async (a: { where: Record<string, unknown> }) => db.filters.filter((f) => matchIn(a.where, f))),
      updateMany: vi.fn(async (a: unknown) => { db.filterUpdateMany.push(a); return { count: 0 }; }),
    },
    savedDashboard: {
      findMany: vi.fn(async (a: { where: Record<string, unknown> }) => db.dashboards.filter((f) => matchIn(a.where, f))),
      updateMany: vi.fn(async (a: unknown) => { db.dashboardUpdateMany.push(a); return { count: 0 }; }),
    },
    user: { findUnique: vi.fn(async (a: { where: { id: string } }) => db.users.get(a.where.id) ?? null) },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => {
      const r = await Promise.all(ops);
      if (db.transactionError) throw db.transactionError;
      return r;
    }),
  },
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: db.logEvent }));

const svc = await import("../../src/services/savedFolderService.js");
type Viewer = Parameters<typeof svc.createFolder>[1];

const alice: Viewer = { id: "u-alice", username: "alice", roleId: "r-noc", regions: [], write: true, fullwrite: false };
const bob: Viewer = { id: "u-bob", username: "bob", roleId: "r-noc", regions: [], write: true, fullwrite: false };
const admin: Viewer = { id: "u-admin", username: "admin", roleId: "r-admin", regions: [], write: true, fullwrite: true };

function folder(id: string, parentId: string | null, over: Partial<Folder> = {}): Folder {
  const f: Folder = {
    id, kind: "filter", scope: "assets", name: id, parentId,
    ownerId: alice.id, ownerRoleId: null, ownerRegion: null, ownerName: "alice",
    visibility: "private", createdAt: new Date(0), updatedAt: new Date(0), ownerRole: null,
    ...over,
  };
  db.folders.set(id, f);
  return f;
}
/** A chain f1 > f2 > … > fN, returning the deepest id. */
function chain(n: number, prefix = "c"): string {
  let parent: string | null = null;
  for (let i = 1; i <= n; i++) {
    folder(`${prefix}${i}`, parent);
    parent = `${prefix}${i}`;
  }
  return parent!;
}
const item = (id: string, folderId: string, ownerId: string | null, visibility = "private"): Item =>
  ({ id, folderId, ownerId, ownerRoleId: null, ownerRegion: null, ownerName: ownerId ?? "", visibility });

beforeEach(() => {
  db.folders.clear();
  db.filters = [];
  db.dashboards = [];
  db.count = 0;
  db.users.clear();
  db.transactionError = null;
  db.folderUpdateMany = [];
  db.filterUpdateMany = [];
  db.dashboardUpdateMany = [];
  db.folderDeleteMany = [];
  db.folderUpdate = [];
  db.findManyWhere = [];
  db.logEvent.mockReset();
});

// ─── Listing ─────────────────────────────────────────────────────────────────

describe("listVisibleFolders", () => {
  it("pushes the visibility predicate into the query and reports a folder whose parent is invisible at the top level", async () => {
    // The query returns only what the viewer can see: the child, not its parent.
    folder("child", "hidden-parent", { visibility: "public", ownerId: bob.id });
    const { folders, visibleIds } = await svc.listVisibleFolders("filter", "assets", alice);
    expect(db.findManyWhere[0]).toMatchObject({ kind: "filter", scope: "assets", OR: expect.any(Array) });
    expect(folders).toHaveLength(1);
    expect(folders[0].parentId).toBeNull(); // the invisible parent's id never leaks
    expect(visibleIds.has("child")).toBe(true);
  });

  it("keeps parentId when the parent is visible too", async () => {
    folder("p", null);
    folder("k", "p");
    const { folders } = await svc.listVisibleFolders("filter", "assets", alice);
    expect(folders.find((f) => f.id === "k")!.parentId).toBe("p");
  });
});

// ─── Filing target ───────────────────────────────────────────────────────────

describe("assertFolderTarget", () => {
  it("passes the top level (null) without a lookup", async () => {
    await expect(svc.assertFolderTarget("filter", "assets", null, alice)).resolves.toBeUndefined();
  });

  it("answers an invisible folder exactly like a missing one", async () => {
    folder("bobs", null, { ownerId: bob.id, ownerName: "bob" });
    const err1 = await svc.assertFolderTarget("filter", "assets", "bobs", alice).catch((e) => e);
    const err2 = await svc.assertFolderTarget("filter", "assets", "nope", alice).catch((e) => e);
    expect(err1).toMatchObject({ httpStatus: 400, message: "That folder does not exist" });
    expect(err2).toMatchObject({ httpStatus: 400, message: "That folder does not exist" });
  });

  it("lets anyone file into a PUBLIC folder they do not own (filing is open)", async () => {
    folder("team", null, { ownerId: bob.id, visibility: "public" });
    await expect(svc.assertFolderTarget("filter", "assets", "team", alice)).resolves.toBeUndefined();
  });

  it("refuses a folder from a different list (kind or scope)", async () => {
    folder("dash", null, { kind: "dashboard", scope: "dashboards" });
    await expect(svc.assertFolderTarget("filter", "assets", "dash", alice)).rejects.toMatchObject({
      httpStatus: 400, message: expect.stringContaining("different list"),
    });
  });
});

// ─── Create ──────────────────────────────────────────────────────────────────

describe("createFolder", () => {
  const input = (parentId: string | null) => ({ kind: "filter" as const, scope: "assets", name: "  My   folder ", parentId, visibility: "private" as const });

  it("creates owned by the caller with the name normalized, and writes a created Event", async () => {
    const dto = await svc.createFolder(input(null), alice);
    expect(dto).toMatchObject({ name: "My folder", ownerId: alice.id, ownerName: "alice", isOwner: true, canManage: true, parentId: null });
    expect(db.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "saved_folder.created", actor: "alice" }));
  });

  it("allows a folder at depth 8 and refuses depth 9", async () => {
    const seventh = chain(7);
    await expect(svc.createFolder(input(seventh), alice)).resolves.toMatchObject({ parentId: seventh });
    db.folders.delete("new");
    const eighth = "c8";
    folder(eighth, seventh);
    await expect(svc.createFolder(input(eighth), alice)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("8 deep") });
  });

  it("refuses the 201st folder a user owns in one list", async () => {
    db.count = 200;
    await expect(svc.createFolder(input(null), alice)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("200") });
  });

  it("refuses an empty name before touching the table", async () => {
    await expect(svc.createFolder({ ...input(null), name: "   " }, alice)).rejects.toMatchObject({ httpStatus: 400 });
    expect(db.folders.size).toBe(0);
  });
});

// ─── Manage: update / move / delete ──────────────────────────────────────────

describe("updateFolder", () => {
  it("404s a folder the caller cannot see, 403s one they can see but do not own", async () => {
    folder("bobs-private", null, { ownerId: bob.id });
    folder("bobs-public", null, { ownerId: bob.id, visibility: "public", ownerName: "bob" });
    await expect(svc.updateFolder("bobs-private", { name: "x", visibility: "private" }, alice)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(svc.updateFolder("bobs-public", { name: "x", visibility: "private" }, alice)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("even a fullwrite holder cannot rename someone else's owned folder", async () => {
    folder("bobs-public", null, { ownerId: bob.id, visibility: "public" });
    await expect(svc.updateFolder("bobs-public", { name: "x", visibility: "public" }, admin)).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("a fullwrite holder manages an OWNERLESS folder", async () => {
    folder("orphan", null, { ownerId: null, visibility: "public" });
    await expect(svc.updateFolder("orphan", { name: "Renamed", visibility: "public" }, admin)).resolves.toMatchObject({ name: "Renamed" });
  });
});

describe("moveFolder", () => {
  it("is a no-op (no write, no Event) when the parent does not change", async () => {
    folder("p", null);
    folder("k", "p");
    await svc.moveFolder("k", "p", alice);
    expect(db.folderUpdate).toEqual([]);
    expect(db.logEvent).not.toHaveBeenCalled();
  });

  it("refuses a move into itself or into its own subtree", async () => {
    folder("a", null);
    folder("b", "a");
    folder("c", "b");
    await expect(svc.moveFolder("a", "a", alice)).rejects.toMatchObject({ httpStatus: 400 });
    await expect(svc.moveFolder("a", "c", alice)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("into itself") });
  });

  it("refuses a move when target depth + subtree height exceeds 8", async () => {
    const deep = chain(5, "d");           // d5 sits at depth 5
    folder("s1", null);                   // a subtree of height 4: s1 > s2 > s3 > s4
    folder("s2", "s1");
    folder("s3", "s2");
    folder("s4", "s3");
    await expect(svc.moveFolder("s1", deep, alice)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("8 deep") });
    // Depth 4 + height 4 = 8 fits.
    await expect(svc.moveFolder("s1", "d4", alice)).resolves.toBeUndefined();
    expect(db.folders.get("s1")!.parentId).toBe("d4");
  });

  it("moves to the top level and records from/to", async () => {
    folder("p", null);
    folder("k", "p");
    await svc.moveFolder("k", null, alice);
    expect(db.folders.get("k")!.parentId).toBeNull();
    expect(db.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "saved_folder.moved", details: { from: "p", to: null } }));
  });
});

describe("deleteFolder", () => {
  it("moves the folder's contents up to its parent rather than deleting them", async () => {
    folder("p", null);
    folder("k", "p");
    await svc.deleteFolder("k", alice);
    expect(db.filterUpdateMany).toContainEqual({ where: { folderId: "k" }, data: { folderId: "p" } });
    expect(db.dashboardUpdateMany).toContainEqual({ where: { folderId: "k" }, data: { folderId: "p" } });
    expect(db.folderUpdateMany).toContainEqual({ where: { parentId: "k", id: { notIn: ["k"] } }, data: { parentId: "p" } });
    expect(db.folderDeleteMany).toEqual([{ where: { id: { in: ["k"] } } }]);
  });

  it("refuses a non-owner", async () => {
    folder("bobs", null, { ownerId: bob.id, visibility: "public" });
    await expect(svc.deleteFolder("bobs", alice)).rejects.toMatchObject({ httpStatus: 403 });
    expect(db.folderDeleteMany).toEqual([]);
  });
});

// ─── Re-owning with contents ─────────────────────────────────────────────────

describe("changeFolderOwner / takeFolder with contents", () => {
  beforeEach(() => {
    db.users.set(bob.id, { id: bob.id, username: "bob", disabledAt: null });
    folder("root", null, { visibility: "public" });
    folder("mine-sub", "root", { visibility: "public" });
    folder("bobs-sub", "root", { visibility: "public", ownerId: bob.id });
    db.filters = [item("f-mine", "root", alice.id), item("f-bob", "mine-sub", bob.id, "public")];
  });

  it("moves only the subtree rows the caller manages — never a back door to someone else's", async () => {
    const r = await svc.changeFolderOwner("root", { kind: "user", userId: bob.id }, true, alice);
    expect(r.moved).toEqual({ folders: 1, filters: 1, dashboards: 0 });
    const folderWrite = db.folderUpdateMany[0] as { where: { id: { in: string[] } }; data: Record<string, unknown> };
    expect(folderWrite.where.id.in.sort()).toEqual(["mine-sub", "root"]);
    expect(folderWrite.data).toMatchObject({ ownerId: bob.id, ownerName: "bob" });
    expect((db.filterUpdateMany[0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(["f-mine"]);
    expect(db.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "saved_folder.owner_changed" }));
  });

  it("without includeContents re-owns the folder alone", async () => {
    const r = await svc.changeFolderOwner("root", { kind: "user", userId: bob.id }, false, alice);
    expect(r.moved).toEqual({ folders: 0, filters: 0, dashboards: 0 });
    expect((db.folderUpdateMany[0] as { where: { id: { in: string[] } } }).where.id.in).toEqual(["root"]);
  });

  it("turns a unique-name clash in the new owner's rows into a 409", async () => {
    db.transactionError = Object.assign(new Error("dup"), { code: "P2002" });
    await expect(svc.changeFolderOwner("root", { kind: "user", userId: bob.id }, true, alice)).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("a fullwrite takeover takes the whole subtree (canTake) and is a warning-level 'taken' Event", async () => {
    const r = await svc.takeFolder("root", true, admin);
    expect(r.moved).toEqual({ folders: 2, filters: 2, dashboards: 0 });
    expect((db.folderUpdateMany[0] as { data: Record<string, unknown> }).data).toMatchObject({ ownerId: admin.id, visibility: "private" });
    expect(db.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "saved_folder.taken", level: "warning" }));
  });

  it("making your own folder private is an info-level 'updated' Event", async () => {
    await svc.takeFolder("root", false, alice);
    expect(db.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "saved_folder.updated", level: "info" }));
  });

  it("a non-owner without fullwrite cannot take", async () => {
    await expect(svc.takeFolder("bobs-sub", false, alice)).rejects.toMatchObject({ httpStatus: 403 });
  });
});
