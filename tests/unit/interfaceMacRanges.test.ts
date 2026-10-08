/**
 * tests/unit/interfaceMacRanges.test.ts — the interface-scrape MAC fold:
 * range coalescing (foldMacsToRanges), range expansion (expandMacRange), and
 * the source-scoped reconcile (reconcileInterfaceMacs) that writes range rows
 * without touching rows owned by other sources.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRawUnsafe: vi.fn(async () => 1),
  deleteMany: vi.fn(async () => ({ count: 0 })),
  findMany: vi.fn(async () => [] as Array<{ mac: string; source: string }>),
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    $executeRawUnsafe: mocks.executeRawUnsafe,
    assetMacAddress: {
      deleteMany: mocks.deleteMany,
      findMany: mocks.findMany,
    },
  },
}));

// retryOnDeadlock just invokes the thunk; run the real (trivial) helper.
import {
  foldMacsToRanges,
  expandMacRange,
  INTERFACE_MAC_SOURCE,
} from "../../src/utils/macAddresses.js";
import { reconcileInterfaceMacs } from "../../src/services/macAddressService.js";

const now = new Date("2026-07-13T12:00:00.000Z");

beforeEach(() => {
  mocks.executeRawUnsafe.mockClear();
  mocks.deleteMany.mockClear();
  mocks.findMany.mockClear();
  mocks.findMany.mockResolvedValue([]);
});

describe("foldMacsToRanges", () => {
  it("returns [] for empty / invalid-only input", () => {
    expect(foldMacsToRanges([])).toEqual([]);
    expect(foldMacsToRanges([null, undefined, "", "nope", "00:11:22"])).toEqual([]);
  });

  it("drops the all-zero MAC loopback / tunnel interfaces report", () => {
    expect(foldMacsToRanges(["00:00:00:00:00:00", "000000000000", "aa:bb:cc:dd:ee:00"])).toEqual([
      { mac: "AA:BB:CC:DD:EE:00", macEnd: null },
    ]);
  });

  it("keeps isolated MACs as single entries (macEnd null)", () => {
    expect(foldMacsToRanges(["aa:bb:cc:dd:ee:00", "aa:bb:cc:dd:ee:05"])).toEqual([
      { mac: "AA:BB:CC:DD:EE:00", macEnd: null },
      { mac: "AA:BB:CC:DD:EE:05", macEnd: null },
    ]);
  });

  it("coalesces contiguous runs into inclusive ranges", () => {
    const macs = ["aa:bb:cc:dd:ee:02", "aa:bb:cc:dd:ee:00", "aa:bb:cc:dd:ee:01"];
    expect(foldMacsToRanges(macs)).toEqual([
      { mac: "AA:BB:CC:DD:EE:00", macEnd: "AA:BB:CC:DD:EE:02" },
    ]);
  });

  it("splits at gaps and mixes ranges with singles, sorted ascending", () => {
    const macs = [
      "aa:bb:cc:dd:ee:10",
      "aa:bb:cc:dd:ee:00",
      "aa:bb:cc:dd:ee:01",
      "aa:bb:cc:dd:ee:03",
    ];
    expect(foldMacsToRanges(macs)).toEqual([
      { mac: "AA:BB:CC:DD:EE:00", macEnd: "AA:BB:CC:DD:EE:01" },
      { mac: "AA:BB:CC:DD:EE:03", macEnd: null },
      { mac: "AA:BB:CC:DD:EE:10", macEnd: null },
    ]);
  });

  it("dedupes across text formats and coalesces across octet boundaries", () => {
    const macs = ["AA:BB:CC:DD:EE:FF", "aa-bb-cc-dd-ee-ff", "aabb.ccdd.ef00"];
    expect(foldMacsToRanges(macs)).toEqual([
      { mac: "AA:BB:CC:DD:EE:FF", macEnd: "AA:BB:CC:DD:EF:00" },
    ]);
  });
});

describe("expandMacRange", () => {
  it("returns [mac] for single rows (macEnd null or equal)", () => {
    expect(expandMacRange("AA:BB:CC:DD:EE:FF", null)).toEqual(["AA:BB:CC:DD:EE:FF"]);
    expect(expandMacRange("AA:BB:CC:DD:EE:FF", "AA:BB:CC:DD:EE:FF")).toEqual(["AA:BB:CC:DD:EE:FF"]);
  });

  it("expands an inclusive range, crossing octet boundaries", () => {
    expect(expandMacRange("AA:BB:CC:DD:EE:FE", "AA:BB:CC:DD:EF:01")).toEqual([
      "AA:BB:CC:DD:EE:FE",
      "AA:BB:CC:DD:EE:FF",
      "AA:BB:CC:DD:EF:00",
      "AA:BB:CC:DD:EF:01",
    ]);
  });

  it("caps expansion of a pathological range", () => {
    const out = expandMacRange("00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF", 16);
    expect(out).toHaveLength(16);
    expect(out[0]).toBe("00:00:00:00:00:00");
  });

  it("returns [] / [start] on invalid bounds", () => {
    expect(expandMacRange("garbage", null)).toEqual([]);
    // inverted range degrades to the start MAC
    expect(expandMacRange("AA:BB:CC:DD:EE:05", "AA:BB:CC:DD:EE:00")).toEqual(["AA:BB:CC:DD:EE:05"]);
  });
});

describe("reconcileInterfaceMacs", () => {
  it("wipes only interface-fold rows when the scrape has no valid MACs", async () => {
    await reconcileInterfaceMacs("a1", [null, "bad"], now);
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMany.mock.calls[0][0]).toEqual({
      where: { assetId: "a1", source: INTERFACE_MAC_SOURCE },
    });
    expect(mocks.executeRawUnsafe).not.toHaveBeenCalled();
  });

  it("writes range + single rows scoped to the monitor-interface source", async () => {
    await reconcileInterfaceMacs(
      "a1",
      ["aa:bb:cc:dd:ee:00", "aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:10"],
      now,
    );
    // stale-delete is scoped to the fold's source and keyed on surviving starts
    const delWhere = mocks.deleteMany.mock.calls[0][0].where;
    expect(delWhere.source).toBe(INTERFACE_MAC_SOURCE);
    expect(delWhere.mac.notIn).toEqual(["AA:BB:CC:DD:EE:00", "AA:BB:CC:DD:EE:10"]);

    const [sql, ...params] = mocks.executeRawUnsafe.mock.calls[0] as [string, ...unknown[]];
    expect(sql).toContain('INSERT INTO "asset_mac_addresses"');
    expect(sql).toContain('"macEnd" = EXCLUDED."macEnd"');
    expect(sql).not.toMatch(/DELETE/i);
    // tuple shape: (assetId, mac, macEnd, source, lastSeen, firstSeen)
    expect(params).toContain("AA:BB:CC:DD:EE:00");
    expect(params).toContain("AA:BB:CC:DD:EE:01"); // range end
    expect(params).toContain("AA:BB:CC:DD:EE:10");
    expect(params).toContain(INTERFACE_MAC_SOURCE);
    expect(params.filter((p) => p === now.toISOString()).length).toBeGreaterThan(0);
  });

  it("slides a range start past a key held by another source", async () => {
    mocks.findMany.mockResolvedValue([
      { mac: "AA:BB:CC:DD:EE:00", source: "fmg-discovery" },
    ]);
    await reconcileInterfaceMacs(
      "a1",
      ["aa:bb:cc:dd:ee:00", "aa:bb:cc:dd:ee:01", "aa:bb:cc:dd:ee:02"],
      now,
    );
    const params = mocks.executeRawUnsafe.mock.calls[0].slice(1);
    // range re-anchored one past the discovery-owned key
    expect(params).toContain("AA:BB:CC:DD:EE:01");
    expect(params).toContain("AA:BB:CC:DD:EE:02");
    expect(params).not.toContain("AA:BB:CC:DD:EE:00");
  });

  it("drops an entry fully covered by other-source rows (dedupe, no write)", async () => {
    mocks.findMany.mockResolvedValue([
      { mac: "AA:BB:CC:DD:EE:00", source: "polaris-agent" },
    ]);
    await reconcileInterfaceMacs("a1", ["aa:bb:cc:dd:ee:00"], now);
    // nothing left to upsert → scoped wipe of our rows only
    expect(mocks.executeRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.deleteMany).toHaveBeenCalledTimes(1);
    expect(mocks.deleteMany.mock.calls[0][0]).toEqual({
      where: { assetId: "a1", source: INTERFACE_MAC_SOURCE },
    });
  });

  it("does not slide past keys already owned by the fold itself", async () => {
    mocks.findMany.mockResolvedValue([
      { mac: "AA:BB:CC:DD:EE:00", source: INTERFACE_MAC_SOURCE },
    ]);
    await reconcileInterfaceMacs("a1", ["aa:bb:cc:dd:ee:00", "aa:bb:cc:dd:ee:01"], now);
    const params = mocks.executeRawUnsafe.mock.calls[0].slice(1);
    expect(params).toContain("AA:BB:CC:DD:EE:00");
    expect(params).toContain("AA:BB:CC:DD:EE:01");
  });
});
