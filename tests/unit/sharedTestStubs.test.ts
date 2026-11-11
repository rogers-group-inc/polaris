/**
 * tests/unit/sharedTestStubs.test.ts — the shared db / eventLog stubs
 * (CQ-T009) behave as their headers promise, since ~every service test will
 * lean on them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma, prismaBase } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import * as eventLogService from "../../src/services/eventLogService.js";

beforeEach(() => { resetDbStub(); resetEventLogStub(); });

describe("_dbStub", () => {
  it("hands out one stable spy per model.method, also through prismaBase", () => {
    expect(prisma.asset.findUnique).toBe(prisma.asset.findUnique);
    expect(prismaBase.asset.findUnique).toBe(prisma.asset.findUnique);
    expect(prisma.asset.findUnique).not.toBe(prisma.asset.findMany);
    expect(vi.isMockFunction(prisma.$queryRawUnsafe)).toBe(true);
  });

  it("is not a thenable, so `await prisma` and `await tx` do not hang", async () => {
    expect((prisma as unknown as { then?: unknown }).then).toBeUndefined();
    await expect(Promise.resolve(prisma)).resolves.toBe(prisma);
  });

  it("an unconfigured call resolves to undefined; a configured one returns its value", async () => {
    expect(await prisma.asset.count()).toBeUndefined();
    vi.mocked(prisma.asset.count).mockResolvedValue(3);
    expect(await prisma.asset.count()).toBe(3);
  });

  it("$transaction awaits an array in order and passes the stub to a callback", async () => {
    expect(await prisma.$transaction([Promise.resolve(1), Promise.resolve(2)] as never)).toEqual([1, 2]);
    const seen = await prisma.$transaction(async (tx) => tx);
    expect(seen).toBe(prisma);
  });

  it("resetDbStub clears calls and implementations but keeps $transaction working", async () => {
    vi.mocked(prisma.asset.count).mockResolvedValue(3);
    await prisma.asset.count();
    resetDbStub();
    expect(prisma.asset.count).not.toHaveBeenCalled();
    expect(await prisma.asset.count()).toBeUndefined();
    expect(await prisma.$transaction([Promise.resolve("x")] as never)).toEqual(["x"]);
  });
});

describe("_eventLogStub", () => {
  it("replaces the writers with the shared spies", async () => {
    await eventLogService.logEvent({ action: "a.b", resourceType: "asset", message: "m" });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(await eventLogService.logEventsBatch([{ action: "x", resourceType: "asset", message: "m" }])).toBe(1);
  });

  it("keeps the pure builders real", () => {
    expect(vi.isMockFunction(eventLogService.buildChanges)).toBe(false);
    expect(eventLogService.buildChanges({ a: 1 }, { a: 2 })).toBeTruthy();
  });

  it("resetEventLogStub clears calls and keeps the writers resolving", async () => {
    await eventLogService.logEvent({ action: "a.b", resourceType: "asset", message: "m" });
    resetEventLogStub();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
    await expect(eventLogService.logEvent({ action: "c", resourceType: "asset", message: "m" })).resolves.toBeUndefined();
  });
});
