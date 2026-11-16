/**
 * tests/unit/subnetExclusionService.test.ts — the exclusion registry
 * (src/services/subnetExclusionService.ts, business rule 42), against a stubbed
 * Prisma client. The containment math itself is pinned by
 * tests/unit/subnetExclusion.test.ts; the DB-backed claims by
 * tests/integration/subnetExclusions.test.ts. Here: validation, the 409 seam,
 * the match decoration, the frozen CIDR and the three audit Events.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const {
  loadExclusions,
  listExclusions,
  assertNotExcluded,
  createExclusion,
  updateExclusion,
  deleteExclusion,
} = await import("../../src/services/subnetExclusionService.js");

const db = {
  exFindMany: stubbed(prisma.subnetExclusion.findMany),
  exFindUnique: stubbed(prisma.subnetExclusion.findUnique),
  exCreate: stubbed(prisma.subnetExclusion.create),
  exUpdate: stubbed(prisma.subnetExclusion.update),
  exDelete: stubbed(prisma.subnetExclusion.delete),
  subnetFindMany: stubbed(prisma.subnet.findMany),
};

const T = new Date("2026-11-01T00:00:00Z");
const ex = (id: string, cidr: string, name = `ex-${id}`) => ({
  id, cidr, name, notes: null, createdBy: null, createdAt: T, updatedAt: T,
});
const subnet = (id: string, cidr: string, blockName: string | null = "Corp") => ({
  id, cidr, name: `net-${id}`, status: "available", block: blockName ? { name: blockName } : null,
});

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

const lastEvent = () => eventLog.logEvent.mock.calls.at(-1)![0] as unknown as Record<string, any>;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  db.exFindMany.mockResolvedValue([]);
  db.subnetFindMany.mockResolvedValue([]);
});

describe("loadExclusions", () => {
  it("reads every exclusion ordered by cidr", async () => {
    db.exFindMany.mockResolvedValue([ex("1", "10.0.0.0/8")]);
    await expect(loadExclusions()).resolves.toEqual([ex("1", "10.0.0.0/8")]);
    expect(db.exFindMany).toHaveBeenCalledWith({ orderBy: { cidr: "asc" } });
  });
});

describe("listExclusions", () => {
  it("decorates each exclusion with the live networks it covers (narrower or equal, never wider)", async () => {
    db.exFindMany.mockResolvedValue([ex("a", "10.99.0.0/16"), ex("b", "192.168.1.0/24")]);
    db.subnetFindMany.mockResolvedValue([
      subnet("s1", "10.99.4.0/24"),
      subnet("s2", "10.99.0.0/16", null),
      subnet("s3", "10.0.0.0/8"), // wider: not covered
      subnet("s4", "172.16.0.0/24"),
    ]);
    const [a, b] = await listExclusions();
    expect(a.matchCount).toBe(2);
    expect(a.matches).toEqual([
      { id: "s1", cidr: "10.99.4.0/24", name: "net-s1", status: "available", blockName: "Corp" },
      { id: "s2", cidr: "10.99.0.0/16", name: "net-s2", status: "available", blockName: null },
    ]);
    expect(b.matchCount).toBe(0);
    expect(b.matches).toEqual([]);
    expect(a).toMatchObject({ id: "a", cidr: "10.99.0.0/16", name: "ex-a" });
  });

  it("names at most 20 matches but counts them all", async () => {
    db.exFindMany.mockResolvedValue([ex("a", "10.0.0.0/8")]);
    db.subnetFindMany.mockResolvedValue(Array.from({ length: 25 }, (_, i) => subnet(`s${i}`, `10.${i}.0.0/24`)));
    const [a] = await listExclusions();
    expect(a.matchCount).toBe(25);
    expect(a.matches).toHaveLength(20);
  });

  it("returns an empty list when nothing is excluded", async () => {
    db.subnetFindMany.mockResolvedValue([subnet("s1", "10.0.0.0/24")]);
    await expect(listExclusions()).resolves.toEqual([]);
  });
});

describe("assertNotExcluded", () => {
  it("passes a CIDR no exclusion covers, using the known list without a read", async () => {
    await expect(assertNotExcluded("10.1.0.0/24", [{ cidr: "10.2.0.0/16", name: "x" }])).resolves.toBeUndefined();
    expect(db.exFindMany).not.toHaveBeenCalled();
  });

  it("refuses a covered CIDR with 409, naming the exclusion", async () => {
    const err = await rejection(assertNotExcluded("10.2.3.0/24", [{ cidr: "10.2.0.0/16", name: "OOB" }]));
    expect(err.httpStatus).toBe(409);
    expect(err.message).toContain(`as "OOB"`);
    expect(err.message).toContain("(10.2.0.0/16)");
  });

  it("names the most specific covering exclusion", async () => {
    const err = await rejection(assertNotExcluded("10.2.3.0/26", [
      { cidr: "10.0.0.0/8", name: "wide" },
      { cidr: "10.2.3.0/24", name: "narrow" },
    ]));
    expect(err.message).toContain(`as "narrow"`);
  });

  it("leaves the name out of the message when the exclusion has none", async () => {
    const err = await rejection(assertNotExcluded("10.2.3.0/24", [{ cidr: "10.2.3.0/24", name: "" }]));
    expect(err.message).toBe("Subnet 10.2.3.0/24 is excluded (10.2.3.0/24) and cannot be added to the networks list");
  });

  it("loads the exclusions itself when no list is passed", async () => {
    db.exFindMany.mockResolvedValue([ex("1", "192.168.0.0/16", "Lab")]);
    const err = await rejection(assertNotExcluded("192.168.10.0/24"));
    expect(err.httpStatus).toBe(409);
    expect(db.exFindMany).toHaveBeenCalledTimes(1);
  });

  it("does not exclude a wider CIDR than the exclusion", async () => {
    await expect(assertNotExcluded("10.0.0.0/8", [{ cidr: "10.2.0.0/16", name: "x" }])).resolves.toBeUndefined();
  });
});

describe("createExclusion", () => {
  beforeEach(() => {
    db.exFindUnique.mockResolvedValue(null);
    db.exCreate.mockImplementation(async ({ data }: any) => {
      const row = { id: "new", createdAt: T, updatedAt: T, ...data };
      db.exFindMany.mockResolvedValue([row]);
      return row;
    });
  });

  it("requires a name (400), trimming whitespace first", async () => {
    const err = await rejection(createExclusion({ cidr: "10.0.0.0/24", name: "   " }));
    expect(err.httpStatus).toBe(400);
    expect(db.exCreate).not.toHaveBeenCalled();
  });

  it("refuses an invalid CIDR with 400", async () => {
    for (const cidr of ["10.0.0.0", "10.0.0.0/33", "not-a-cidr", "10.0.0.0/24\nrm -rf", ""]) {
      const err = await rejection(createExclusion({ cidr, name: "x" }));
      expect(err.httpStatus).toBe(400);
    }
    expect(db.exCreate).not.toHaveBeenCalled();
  });

  it("refuses an IPv6 CIDR with 400 (IPv4-only)", async () => {
    const err = await rejection(createExclusion({ cidr: "2001:db8::/32", name: "v6" }));
    expect(err.httpStatus).toBe(400);
    expect(err.message).toMatch(/IPv4-only/);
  });

  it("normalizes the CIDR (trim + host bits) before the clash check and the write", async () => {
    await createExclusion({ cidr: "  10.9.8.7/24 ", name: " Mgmt ", notes: "  shared  ", createdBy: "alice", actor: "alice" });
    expect(db.exFindUnique).toHaveBeenCalledWith({ where: { cidr: "10.9.8.0/24" } });
    expect(db.exCreate).toHaveBeenCalledWith({
      data: { cidr: "10.9.8.0/24", name: "Mgmt", notes: "shared", createdBy: "alice" },
    });
  });

  it("stores blank notes and a missing creator as null", async () => {
    await createExclusion({ cidr: "10.9.8.0/24", name: "Mgmt", notes: "   " });
    expect(db.exCreate.mock.calls[0][0].data).toMatchObject({ notes: null, createdBy: null });
  });

  it("refuses a CIDR that is already excluded with 409, naming the existing one", async () => {
    db.exFindUnique.mockResolvedValue(ex("old", "10.9.8.0/24", "Existing"));
    const err = await rejection(createExclusion({ cidr: "10.9.8.1/24", name: "x" }));
    expect(err.httpStatus).toBe(409);
    expect(err.message).toBe(`10.9.8.0/24 is already excluded as "Existing"`);
    expect(db.exCreate).not.toHaveBeenCalled();
  });

  it("reports covered live networks and touches none of them", async () => {
    db.subnetFindMany.mockResolvedValue([subnet("s1", "10.9.8.0/25"), subnet("s2", "10.1.0.0/24")]);
    const dto = await createExclusion({ cidr: "10.9.8.0/24", name: "Mgmt", actor: "bob" });
    expect(dto.matchCount).toBe(1);
    expect(dto.matches.map((m) => m.id)).toEqual(["s1"]);
    expect(stubbed(prisma.subnet.update)).not.toHaveBeenCalled();
    expect(stubbed(prisma.subnet.delete)).not.toHaveBeenCalled();
    expect(stubbed(prisma.subnet.updateMany)).not.toHaveBeenCalled();
    expect(stubbed(prisma.subnet.deleteMany)).not.toHaveBeenCalled();
    const e = lastEvent();
    expect(e).toMatchObject({
      action: "subnet.exclusion.created",
      resourceType: "subnet-exclusion",
      resourceId: "new",
      resourceName: "Mgmt",
      actor: "bob",
      details: { cidr: "10.9.8.0/24", name: "Mgmt", existingMatches: ["10.9.8.0/25"], matchCount: 1 },
    });
    expect(e.message).toContain("1 existing network(s) match and were left in place");
  });

  it("writes a plain created Event when nothing matches", async () => {
    await createExclusion({ cidr: "10.9.8.0/24", name: "Mgmt" });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(lastEvent().message).toBe(`Subnet 10.9.8.0/24 excluded as "Mgmt" — discovery will no longer record it`);
    expect(lastEvent().details).toMatchObject({ existingMatches: [], matchCount: 0 });
  });
});

describe("updateExclusion", () => {
  const stored = ex("e1", "10.5.0.0/16", "Old");
  beforeEach(() => {
    db.exFindUnique.mockResolvedValue(stored);
    db.exUpdate.mockImplementation(async ({ data }: any) => {
      const row = { ...stored, ...data };
      db.exFindMany.mockResolvedValue([row]);
      return row;
    });
    db.exFindMany.mockResolvedValue([stored]);
  });

  it("404s an unknown id", async () => {
    db.exFindUnique.mockResolvedValue(null);
    const err = await rejection(updateExclusion("nope", { name: "x" }));
    expect(err.httpStatus).toBe(404);
  });

  it("refuses a blank name with 400", async () => {
    const err = await rejection(updateExclusion("e1", { name: "  " }));
    expect(err.httpStatus).toBe(400);
    expect(db.exUpdate).not.toHaveBeenCalled();
  });

  it("renames, never touching the cidr, and audits the rename", async () => {
    const dto = await updateExclusion("e1", { name: " New ", actor: "carol", cidr: "0.0.0.0/0" } as never);
    expect(db.exUpdate).toHaveBeenCalledWith({ where: { id: "e1" }, data: { name: "New" } });
    expect(dto).toMatchObject({ id: "e1", cidr: "10.5.0.0/16", name: "New", matchCount: 0 });
    expect(lastEvent()).toMatchObject({
      action: "subnet.exclusion.updated",
      resourceId: "e1",
      resourceName: "New",
      actor: "carol",
      message: `Subnet exclusion 10.5.0.0/16 renamed from "Old" to "New"`,
      details: { cidr: "10.5.0.0/16", previousName: "Old", name: "New" },
    });
  });

  it("re-notes (blank notes become null) with an 'updated' message", async () => {
    await updateExclusion("e1", { notes: "   " });
    expect(db.exUpdate).toHaveBeenCalledWith({ where: { id: "e1" }, data: { notes: null } });
    expect(lastEvent().message).toBe(`Subnet exclusion "Old" (10.5.0.0/16) updated`);
  });

  it("treats a same-name save as an update, not a rename", async () => {
    await updateExclusion("e1", { name: "Old", notes: "n" });
    expect(lastEvent().message).toBe(`Subnet exclusion "Old" (10.5.0.0/16) updated`);
  });

  it("writes nothing and audits nothing when no field is given", async () => {
    const dto = await updateExclusion("e1", { actor: "x" });
    expect(db.exUpdate).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    expect(dto).toMatchObject({ id: "e1", name: "Old", matchCount: 0, matches: [] });
  });
});

describe("deleteExclusion", () => {
  it("404s an unknown id without deleting", async () => {
    db.exFindUnique.mockResolvedValue(null);
    const err = await rejection(deleteExclusion("nope"));
    expect(err.httpStatus).toBe(404);
    expect(db.exDelete).not.toHaveBeenCalled();
  });

  it("deletes and writes the deleted Event", async () => {
    db.exFindUnique.mockResolvedValue(ex("e1", "10.5.0.0/16", "Shared"));
    await deleteExclusion("e1", "dave");
    expect(db.exDelete).toHaveBeenCalledWith({ where: { id: "e1" } });
    expect(lastEvent()).toMatchObject({
      action: "subnet.exclusion.deleted",
      resourceType: "subnet-exclusion",
      resourceId: "e1",
      resourceName: "Shared",
      actor: "dave",
      details: { cidr: "10.5.0.0/16", name: "Shared" },
    });
    expect(lastEvent().message).toContain("discovery may record this address space again");
  });
});
