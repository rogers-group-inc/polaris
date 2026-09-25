/**
 * tests/unit/subnetService.test.ts
 *
 * Unit tests for subnetService — Prisma is mocked so no database is needed.
 *
 * The mock's `$transaction` runs its callback against the SAME mock object, so
 * the interactive-transaction body in createSubnetRowChecked exercises the real
 * lock-then-recheck-then-insert sequence and `$executeRaw` calls are observable.
 * That ordering is the whole point of the fix (see the overlap-invariant note at
 * the top of subnetService.ts), so the tests assert it explicitly rather than
 * just asserting the end state.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AppError } from "../../src/utils/errors.js";

// Mock the prisma singleton before importing the service
const prisma = {
  ipBlock:     { findUnique: vi.fn(), findMany: vi.fn() },
  subnet:      { create: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
  reservation: { count: vi.fn() },
  // Business rule 42: createSubnetRowChecked asks the exclusion registry before
  // it inserts, and both allocators fold excluded ranges into their taken-space
  // list. Default empty = nothing excluded, so every test below reads as it did
  // before the rule existed; the exclusion behaviour itself is covered against a
  // real database in tests/integration/subnetExclusions.test.ts.
  subnetExclusion: { findMany: vi.fn(async () => []), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  $executeRaw: vi.fn(async () => 1),
  $transaction: vi.fn(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg),
  ),
};
vi.mock("../../src/db.js", () => ({ prisma }));

const { createSubnet, deleteSubnet, allocateNextSubnet } = await import(
  "../../src/services/subnetService.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$executeRaw.mockResolvedValue(1);
  prisma.subnetExclusion.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg),
  );
});

// ─── createSubnet ─────────────────────────────────────────────────────────────

describe("createSubnet", () => {
  it("throws 400 for an invalid CIDR", async () => {
    await expect(
      createSubnet({ blockId: "b1", cidr: "bad", name: "test" })
    ).rejects.toThrow(AppError);
  });

  it("throws 404 when the parent block does not exist", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue(null);
    await expect(
      createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" })
    ).rejects.toThrow(AppError);
  });

  it("throws 400 when subnet CIDR is not within the parent block", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "192.168.0.0/24", ipVersion: "v4" });
    await expect(
      createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" })
    ).rejects.toThrow(AppError);
  });

  it("throws 409 when the subnet overlaps with a sibling", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/8", ipVersion: "v4" });
    prisma.subnet.findMany.mockResolvedValue([{ cidr: "10.0.1.0/24" }]);
    await expect(
      createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" })
    ).rejects.toThrow(AppError);
  });

  it("creates the subnet when all checks pass", async () => {
    const fakeSubnet = { id: "s1", cidr: "10.0.1.0/24", blockId: "b1", name: "test" };
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/8", ipVersion: "v4" });
    prisma.subnet.findMany.mockResolvedValue([]);
    prisma.subnet.create.mockResolvedValue(fakeSubnet);

    const result = await createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" });
    expect(result).toMatchObject(fakeSubnet);
    expect(result.block).toEqual({ id: "b1", name: undefined, cidr: "10.0.0.0/8" });
    expect(prisma.subnet.create).toHaveBeenCalledOnce();
  });

  it("with no blockId, lands in the most specific block containing the CIDR", async () => {
    prisma.ipBlock.findMany.mockResolvedValue([
      { id: "wide", name: "Corp", cidr: "10.0.0.0/8", ipVersion: "v4" },
      { id: "site", name: "Site", cidr: "10.84.0.0/16", ipVersion: "v4" },
      { id: "far", name: "Lab", cidr: "192.168.0.0/16", ipVersion: "v4" },
    ]);
    prisma.subnet.findMany.mockResolvedValue([]);
    prisma.subnet.create.mockImplementation(async ({ data }: any) => ({ id: "s1", ...data }));

    const result = await createSubnet({ cidr: "10.84.3.7/24", name: "test" });
    expect(prisma.ipBlock.findUnique).not.toHaveBeenCalled();
    expect(prisma.ipBlock.findMany).toHaveBeenCalledWith({ where: { ipVersion: "v4" } });
    expect(prisma.subnet.create.mock.calls[0][0].data).toMatchObject({ blockId: "site", cidr: "10.84.3.0/24" });
    expect(result.block).toEqual({ id: "site", name: "Site", cidr: "10.84.0.0/16" });
  });

  it("with no blockId, 400s when no block contains the CIDR", async () => {
    prisma.ipBlock.findMany.mockResolvedValue([
      { id: "far", name: "Lab", cidr: "192.168.0.0/16", ipVersion: "v4" },
    ]);
    await expect(createSubnet({ cidr: "10.1.1.0/24", name: "test" })).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.subnet.create).not.toHaveBeenCalled();
  });

  it("inserts inside a transaction that first takes the per-block advisory lock", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/8", ipVersion: "v4" });
    prisma.subnet.findMany.mockResolvedValue([]);
    prisma.subnet.create.mockResolvedValue({ id: "s1", cidr: "10.0.1.0/24" });

    const order: string[] = [];
    prisma.$executeRaw.mockImplementation(async () => { order.push("lock"); return 1; });
    prisma.subnet.findMany.mockImplementation(async () => { order.push("recheck"); return []; });
    prisma.subnet.create.mockImplementation(async () => { order.push("insert"); return { id: "s1", cidr: "10.0.1.0/24" }; });

    await createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" });

    expect(prisma.$transaction).toHaveBeenCalled();
    // Lock BEFORE the sibling re-read, re-read before the insert. A lock taken
    // after the re-read would be decorative.
    expect(order).toEqual(["lock", "recheck", "insert"]);
    const lockSql = String(prisma.$executeRaw.mock.calls[0][0]);
    expect(lockSql).toContain("pg_advisory_xact_lock");
  });

  it("reads siblings exactly once, and only after the lock, so the decision cannot be stale", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/8", ipVersion: "v4" });
    prisma.subnet.findMany.mockResolvedValue([]);
    prisma.subnet.create.mockResolvedValue({ id: "s1", cidr: "10.0.1.0/24" });

    await createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" });

    // The old shape read siblings once unlocked (to decide) and inserted as a
    // separate statement. There must now be exactly ONE sibling read, and it
    // must come after the advisory lock — an extra unlocked read would be a
    // decision made against state that can change before the insert.
    expect(prisma.subnet.findMany).toHaveBeenCalledOnce();
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.subnet.findMany.mock.invocationCallOrder[0],
    );
  });

  it("409s on a sibling overlap discovered under the lock, without inserting", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/8", ipVersion: "v4" });
    // A /25 sibling a concurrent writer committed: not an exact duplicate, so
    // the unique index would NOT catch it. Only the locked re-read does.
    prisma.subnet.findMany.mockResolvedValue([{ cidr: "10.0.1.0/25" }]);

    await expect(
      createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" }),
    ).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.subnet.create).not.toHaveBeenCalled();
  });

  it("translates the unique-index violation (P2002) into a 409", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/8", ipVersion: "v4" });
    prisma.subnet.findMany.mockResolvedValue([]);
    prisma.subnet.create.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));

    await expect(
      createSubnet({ blockId: "b1", cidr: "10.0.1.0/24", name: "test" }),
    ).rejects.toMatchObject({ httpStatus: 409 });
  });
});

// ─── allocateNextSubnet ──────────────────────────────────────────────────────

describe("allocateNextSubnet", () => {
  it("re-picks and succeeds when a concurrent writer takes the chosen CIDR", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/16", ipVersion: "v4" });

    // Attempt 1: both the pick and the locked re-read see an empty block, but
    // the insert loses to the unique index (the other writer committed first).
    // Attempt 2: the pick now sees 10.0.0.0/24 taken and moves to 10.0.1.0/24.
    let picks = 0;
    prisma.subnet.findMany.mockImplementation(async () => {
      picks++;
      return picks <= 2 ? [] : [{ cidr: "10.0.0.0/24" }];
    });
    prisma.subnet.create
      .mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }))
      .mockResolvedValue({ id: "s2", cidr: "10.0.1.0/24" });

    const result = await allocateNextSubnet("b1", 24, { name: "auto" });
    expect(result).toMatchObject({ cidr: "10.0.1.0/24" });
    expect(prisma.subnet.create).toHaveBeenCalledTimes(2);
  });

  it("does not retry a genuine block-full 409", async () => {
    prisma.ipBlock.findUnique.mockResolvedValue({ id: "b1", cidr: "10.0.0.0/24", ipVersion: "v4" });
    prisma.subnet.findMany.mockResolvedValue([{ cidr: "10.0.0.0/24" }]);

    await expect(allocateNextSubnet("b1", 24, { name: "auto" })).rejects.toMatchObject({
      httpStatus: 409,
    });
    expect(prisma.subnet.create).not.toHaveBeenCalled();
  });
});

// ─── deleteSubnet ─────────────────────────────────────────────────────────────

describe("deleteSubnet", () => {
  it("throws 404 when subnet does not exist", async () => {
    prisma.subnet.findUnique.mockResolvedValue(null);
    await expect(deleteSubnet("s1")).rejects.toThrow(AppError);
  });

  it("throws 409 when subnet has active reservations", async () => {
    prisma.subnet.findUnique.mockResolvedValue({ id: "s1", cidr: "10.0.1.0/24", _count: { reservations: 2 } });
    prisma.reservation.count.mockResolvedValue(2);
    await expect(deleteSubnet("s1")).rejects.toThrow(AppError);
  });
});
