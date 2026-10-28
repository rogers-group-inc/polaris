import { describe, it, expect, vi, beforeEach } from "vitest";

// The Events page's Device column: every row is named by the CURRENT hostname
// of the asset in Event.assetId (an alert's Resource Name is the automation,
// so this is the only column that says which device fired), and the column's
// text filter is resolved to asset ids because the name lives on Asset.

const h = vi.hoisted(() => ({
  prisma: {
    asset: { findMany: vi.fn() },
    event: { findMany: vi.fn(), count: vi.fn() },
  },
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventArchiveService.js", () => ({ getCachedRetentionSettings: vi.fn() }));

import { withAssetNames, eventDeviceFilter, queryEventsPage } from "../../src/services/eventLogService.js";

beforeEach(() => {
  h.prisma.asset.findMany.mockReset();
  h.prisma.event.findMany.mockReset();
  h.prisma.event.count.mockReset();
});

describe("withAssetNames", () => {
  it("names each event by hostname, else IP, in ONE lookup of the distinct ids", async () => {
    h.prisma.asset.findMany.mockResolvedValue([
      { id: "a1", hostname: "fg-core", ipAddress: "10.0.0.1" },
      { id: "a2", hostname: null, ipAddress: "10.0.0.2" },
    ]);
    const out = await withAssetNames([
      { id: "e1", assetId: "a1" },
      { id: "e2", assetId: "a1" },
      { id: "e3", assetId: "a2" },
      { id: "e4", assetId: null },
    ]);
    expect(out.map((e) => e.assetName)).toEqual(["fg-core", "fg-core", "10.0.0.2", null]);
    expect(h.prisma.asset.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.asset.findMany.mock.calls[0][0].where).toEqual({ id: { in: ["a1", "a2"] } });
  });

  it("reads null for a deleted device and skips the lookup when no row has one", async () => {
    h.prisma.asset.findMany.mockResolvedValue([]);
    expect((await withAssetNames([{ assetId: "gone" }]))[0].assetName).toBeNull();
    h.prisma.asset.findMany.mockClear();
    expect(await withAssetNames([{ assetId: null }])).toEqual([{ assetId: null, assetName: null }]);
    expect(h.prisma.asset.findMany).not.toHaveBeenCalled();
  });

  it("queryEventsPage returns the named rows", async () => {
    h.prisma.event.findMany.mockResolvedValue([{ id: "e1", assetId: "a1" }]);
    h.prisma.event.count.mockResolvedValue(1);
    h.prisma.asset.findMany.mockResolvedValue([{ id: "a1", hostname: "sw-1", ipAddress: null }]);
    const r = await queryEventsPage({ where: {}, orderBy: { timestamp: "desc" }, skip: 0, take: 50 });
    expect(r).toEqual({ events: [{ id: "e1", assetId: "a1", assetName: "sw-1" }], total: 1 });
  });
});

describe("eventDeviceFilter", () => {
  it("contains → events about the assets whose hostname or IP matches", async () => {
    h.prisma.asset.findMany.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);
    expect(await eventDeviceFilter("fg", undefined)).toEqual({ assetId: { in: ["a1", "a2"] } });
    expect(h.prisma.asset.findMany.mock.calls[0][0].where).toEqual({
      OR: [
        { hostname: { contains: "fg", mode: "insensitive" } },
        { ipAddress: { contains: "fg", mode: "insensitive" } },
      ],
    });
  });

  it("not_contains keeps events about no device", async () => {
    h.prisma.asset.findMany.mockResolvedValue([{ id: "a1" }]);
    expect(await eventDeviceFilter("fg", "not_contains")).toEqual({ OR: [{ assetId: null }, { assetId: { notIn: ["a1"] } }] });
  });

  it("empty / is_not_empty test for a device without a lookup; a blank value is no filter", async () => {
    expect(await eventDeviceFilter(undefined, "empty")).toEqual({ assetId: null });
    expect(await eventDeviceFilter(undefined, "is_not_empty")).toEqual({ assetId: { not: null } });
    expect(await eventDeviceFilter("  ", undefined)).toBeUndefined();
    expect(h.prisma.asset.findMany).not.toHaveBeenCalled();
  });
});
