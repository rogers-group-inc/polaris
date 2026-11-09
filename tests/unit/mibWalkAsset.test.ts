/**
 * tests/unit/mibWalkAsset.test.ts — mibService.findMibWalkAsset, the walk
 * target lookup lifted out of routes/mibs.ts by CQ-B044.
 */

import { describe, it, expect, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("../../src/db.js", () => ({ prisma: { asset: { findUnique } } }));

const { findMibWalkAsset } = await import("../../src/services/mibService.js");

describe("findMibWalkAsset", () => {
  it("loads only the fields the walk dials and labels with", async () => {
    findUnique.mockResolvedValue({ id: "a1", hostname: "sw1", ipAddress: "10.0.0.1", ipv6Address: null });
    expect(await findMibWalkAsset("a1")).toEqual({ id: "a1", hostname: "sw1", ipAddress: "10.0.0.1", ipv6Address: null });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "a1" },
      select: { id: true, hostname: true, ipAddress: true, ipv6Address: true },
    });
  });

  it("404s a missing asset", async () => {
    findUnique.mockResolvedValue(null);
    await expect(findMibWalkAsset("nope")).rejects.toMatchObject({ httpStatus: 404, message: "Asset not found" });
  });
});
