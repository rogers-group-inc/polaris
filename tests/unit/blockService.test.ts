/**
 * tests/unit/blockService.test.ts — IP blocks (CQ-T010; the HTTP contract and
 * rule 4 end to end are tests/integration/blocks.test.ts): create normalizes
 * the CIDR and refuses an invalid or duplicate one; the list filters by tag and
 * reports utilization without leaking child CIDRs; delete takes the subnet
 * write lock (rule 20a) BEFORE counting and refuses a block that still holds
 * networks (rule 4) without deleting anything.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ lock: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/subnetService.js", () => ({ lockBlockForSubnetWrites: h.lock }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { listBlocks, getBlock, createBlock, updateBlock, deleteBlock } from "../../src/services/blockService.js";

const db = {
  findMany: stubbed(prisma.ipBlock.findMany),
  findUnique: stubbed(prisma.ipBlock.findUnique),
  create: stubbed(prisma.ipBlock.create),
  update: stubbed(prisma.ipBlock.update),
  delete: stubbed(prisma.ipBlock.delete),
};

beforeEach(() => { resetDbStub(); resetEventLogStub(); h.lock.mockReset(); });

describe("createBlock", () => {
  it("refuses an invalid CIDR and a duplicate", async () => {
    await expect(createBlock({ name: "x", cidr: "10.0.0.0/33" })).rejects.toMatchObject({ httpStatus: 400 });
    db.findUnique.mockResolvedValue({ id: "b" });
    await expect(createBlock({ name: "x", cidr: "10.0.0.0/8" })).rejects.toMatchObject({ httpStatus: 409 });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("stores the normalized CIDR with its IP version and logs block.created", async () => {
    db.findUnique.mockResolvedValue(null);
    db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "b1", ...data }));
    const b = await createBlock({ name: "Corp", cidr: "10.1.2.3/16", actor: "op" });
    expect(b).toMatchObject({ cidr: "10.1.0.0/16", ipVersion: "v4", tags: [] });
    expect(db.findUnique).toHaveBeenCalledWith({ where: { cidr: "10.1.0.0/16" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "block.created", actor: "op", resourceId: "b1" });
  });
});

describe("listBlocks / getBlock", () => {
  it("filters by tag and reports utilization without the child CIDRs", async () => {
    db.findMany.mockResolvedValue([
      { id: "a", cidr: "10.0.0.0/24", tags: ["prod"], subnets: [{ cidr: "10.0.0.0/25" }] },
      { id: "b", cidr: "10.1.0.0/24", tags: [], subnets: [] },
    ]);
    const r = await listBlocks({ tag: "prod" });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: "a", utilizationPercent: 50 });
    expect(r[0]).not.toHaveProperty("subnets");
  });

  it("getBlock 404s an unknown id", async () => {
    db.findUnique.mockResolvedValue(null);
    await expect(getBlock("x")).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("updateBlock", () => {
  it("404s an unknown block, and logs the changed fields", async () => {
    db.findUnique.mockResolvedValueOnce(null);
    await expect(updateBlock("x", { name: "n" })).rejects.toMatchObject({ httpStatus: 404 });
    db.findUnique.mockResolvedValueOnce({ id: "b", name: "Old", description: null, tags: [] });
    db.update.mockResolvedValue({ id: "b", name: "New", description: null, tags: [] });
    await updateBlock("b", { name: "New", actor: "op" });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "block.updated", details: { changes: { name: { from: "Old", to: "New" } } } });
  });
});

describe("deleteBlock (rules 4 and 20a)", () => {
  it("takes the block's subnet write lock before counting its networks", async () => {
    db.findUnique.mockResolvedValue({ id: "b", cidr: "10.0.0.0/8", name: "B", _count: { subnets: 0 } });
    db.delete.mockResolvedValue({ id: "b", name: "B" });
    await deleteBlock("b", "op");
    expect(h.lock).toHaveBeenCalledWith(prisma, "b");
    expect(h.lock.mock.invocationCallOrder[0]).toBeLessThan(db.findUnique.mock.invocationCallOrder[0]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "block.deleted", actor: "op" });
  });

  it("refuses a block that still holds networks, and deletes nothing", async () => {
    db.findUnique.mockResolvedValue({ id: "b", cidr: "10.0.0.0/8", name: "B", _count: { subnets: 2 } });
    await expect(deleteBlock("b")).rejects.toMatchObject({ httpStatus: 409, message: expect.stringContaining("2 networks") });
    expect(db.delete).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("404s an unknown block", async () => {
    db.findUnique.mockResolvedValue(null);
    await expect(deleteBlock("x")).rejects.toMatchObject({ httpStatus: 404 });
  });
});
