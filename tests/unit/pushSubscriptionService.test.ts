/**
 * tests/unit/pushSubscriptionService.test.ts — the per-user Web Push store
 * (CQ-T010): a rotation carries the retiring row's surface forward and is
 * scoped to the caller's own rows, an explicit surface wins, an unknown one
 * falls back to desktop, and a delete never reaches another user's endpoint.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { savePushSubscription, deletePushSubscription } from "../../src/services/pushSubscriptionService.js";

const findFirst = stubbed(prisma.pushSubscription.findFirst);
const deleteMany = stubbed(prisma.pushSubscription.deleteMany);
const upsert = stubbed(prisma.pushSubscription.upsert);
const base = { userId: "u1", endpoint: "https://push/new", p256dh: "k", auth: "a", userAgent: null };

beforeEach(() => resetDbStub());

describe("savePushSubscription", () => {
  it("defaults to desktop and upserts by endpoint, re-owning it for the caller", async () => {
    await savePushSubscription(base);
    const arg = upsert.mock.calls[0][0];
    expect(arg.where).toEqual({ endpoint: "https://push/new" });
    expect(arg.create).toMatchObject({ userId: "u1", surface: "desktop" });
    expect(arg.update).toMatchObject({ userId: "u1", surface: "desktop" });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("an unknown surface falls back to desktop; mobile is kept", async () => {
    await savePushSubscription({ ...base, surface: "watch" });
    expect(upsert.mock.calls[0][0].create.surface).toBe("desktop");
    await savePushSubscription({ ...base, surface: "mobile" });
    expect(upsert.mock.calls[1][0].create.surface).toBe("mobile");
  });

  it("a rotation inherits the old row's surface and retires it, scoped to the caller", async () => {
    findFirst.mockResolvedValue({ surface: "mobile" });
    await savePushSubscription({ ...base, oldEndpoint: "https://push/old" });
    expect(findFirst.mock.calls[0][0].where).toEqual({ endpoint: "https://push/old", userId: "u1" });
    expect(deleteMany).toHaveBeenCalledWith({ where: { endpoint: "https://push/old", userId: "u1" } });
    expect(upsert.mock.calls[0][0].create.surface).toBe("mobile");
  });

  it("an explicit surface wins over the rotated row's", async () => {
    findFirst.mockResolvedValue({ surface: "mobile" });
    await savePushSubscription({ ...base, surface: "desktop", oldEndpoint: "https://push/old" });
    expect(upsert.mock.calls[0][0].create.surface).toBe("desktop");
  });

  it("another user's old endpoint is neither read nor deleted", async () => {
    findFirst.mockResolvedValue(null);
    await savePushSubscription({ ...base, oldEndpoint: "https://push/someone-else" });
    expect(deleteMany).not.toHaveBeenCalled();
    expect(upsert.mock.calls[0][0].create.surface).toBe("desktop");
  });

  it("an oldEndpoint equal to the new one is not a rotation", async () => {
    await savePushSubscription({ ...base, oldEndpoint: base.endpoint });
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("deletePushSubscription", () => {
  it("is scoped to the owning user", async () => {
    await deletePushSubscription("u1", "https://push/x");
    expect(deleteMany).toHaveBeenCalledWith({ where: { endpoint: "https://push/x", userId: "u1" } });
  });
});
