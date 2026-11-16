/**
 * tests/unit/macAddressService.test.ts — the two AssetMacAddress side-table
 * writers (src/services/macAddressService.ts), against a stubbed Prisma client.
 *
 * The contract (polaris-change-impact → assets-inventory.md): the two writers
 * never churn each other's rows (source "monitor-interface" belongs to
 * reconcileInterfaceMacs alone), the all-zero MAC is never written (rule 97),
 * the discovery reconcile is mac-sorted for deterministic lock order, a range
 * slides past a start key another source holds, and every statement rides
 * retryOnDeadlock. The pure folding is pinned in tests/unit/macAddresses.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const { reconcileMacAddresses, reconcileInterfaceMacs } = await import("../../src/services/macAddressService.js");

const db = {
  deleteMany: stubbed(prisma.assetMacAddress.deleteMany),
  findMany: stubbed(prisma.assetMacAddress.findMany),
  execRaw: stubbed(prisma.$executeRawUnsafe),
};

const IF_SRC = "monitor-interface";

beforeEach(() => {
  resetDbStub();
  db.deleteMany.mockResolvedValue({ count: 0 });
  db.findMany.mockResolvedValue([]);
  db.execRaw.mockResolvedValue(0);
});

/** The bulk upsert's params, chunked per row. */
function rows(call: unknown[], width: number): unknown[][] {
  const params = call.slice(1);
  const out: unknown[][] = [];
  for (let i = 0; i < params.length; i += width) out.push(params.slice(i, i + width));
  return out;
}

describe("reconcileMacAddresses", () => {
  it("wipes only the non-interface rows when the list is empty", async () => {
    await reconcileMacAddresses("a1", []);
    expect(db.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", source: { not: IF_SRC } } });
    expect(db.execRaw).not.toHaveBeenCalled();
  });

  it("treats a list of only empty / all-zero / interface-fold entries as empty (rule 97)", async () => {
    await reconcileMacAddresses("a1", [
      { mac: "" },
      { mac: "00:00:00:00:00:00", source: "fortigate" },
      { mac: "00-00-00-00-00-00" },
      { mac: "AA:BB:CC:00:00:01", source: IF_SRC },
    ] as never);
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", source: { not: IF_SRC } } });
    expect(db.execRaw).not.toHaveBeenCalled();
  });

  it("deletes rows outside the new set (never the interface fold), then bulk-upserts sorted by mac", async () => {
    await reconcileMacAddresses("a1", [
      { mac: "CC:00:00:00:00:01", source: "fortigate", device: "FGT-A", subnetCidr: "10.0.0.0/24", subnetName: "LAN", lastSeen: "2026-11-01T00:00:00.000Z" },
      { mac: "AA:00:00:00:00:01", source: "polaris-agent" },
      { mac: "BB:00:00:00:00:01", source: IF_SRC }, // dropped: interface-fold row
      { mac: "00:00:00:00:00:00" },                 // dropped: all-zero
    ] as never);
    expect(db.deleteMany).toHaveBeenCalledWith({
      where: { assetId: "a1", source: { not: IF_SRC }, mac: { notIn: ["AA:00:00:00:00:01", "CC:00:00:00:00:01"] } },
    });
    expect(db.execRaw).toHaveBeenCalledTimes(1);
    const call = db.execRaw.mock.calls[0];
    const sql = call[0] as string;
    expect(sql).toContain(`INSERT INTO "asset_mac_addresses"`);
    expect(sql).toContain(`ON CONFLICT ("assetId", "mac") DO UPDATE SET`);
    expect(sql).toContain(`"macEnd" = NULL`);
    expect(sql).not.toMatch(/"firstSeen" = EXCLUDED/);
    expect(sql).toContain("$16::timestamp");
    const r = rows(call, 8);
    expect(r.map((x) => x[1])).toEqual(["AA:00:00:00:00:01", "CC:00:00:00:00:01"]);
    expect(r[1]).toEqual(["a1", "CC:00:00:00:00:01", "fortigate", "FGT-A", "10.0.0.0/24", "LAN", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z"]);
  });

  it("defaults a missing source to 'unknown', missing metadata to null, and a missing lastSeen to now", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
      await reconcileMacAddresses("a1", [{ mac: "AA:00:00:00:00:01" }] as never);
    } finally {
      vi.useRealTimers();
    }
    expect(rows(db.execRaw.mock.calls[0], 8)[0]).toEqual([
      "a1", "AA:00:00:00:00:01", "unknown", null, null, null, "2026-11-16T12:00:00.000Z", "2026-11-16T12:00:00.000Z",
    ]);
  });

  it("does not reorder the caller's array", async () => {
    const input = [{ mac: "CC:00:00:00:00:01" }, { mac: "AA:00:00:00:00:01" }];
    await reconcileMacAddresses("a1", input as never);
    expect(input.map((m) => m.mac)).toEqual(["CC:00:00:00:00:01", "AA:00:00:00:00:01"]);
  });

  it("dedupes a MAC across spellings into one upsert tuple, keeping the freshest sighting", async () => {
    await reconcileMacAddresses("a1", [
      { mac: "aa:00:00:00:00:01", source: "old", lastSeen: "2026-11-01T00:00:00.000Z" },
      { mac: "AA-00-00-00-00-01", source: "new", lastSeen: "2026-11-02T00:00:00.000Z" },
    ] as never);
    // Was a bug until 2026-11-16: both reached the one INSERT (Postgres refuses a key twice) and case was not normalised.
    const r = rows(db.execRaw.mock.calls[0], 8);
    expect(r).toHaveLength(1);
    expect(r[0].slice(1, 3)).toEqual(["AA:00:00:00:00:01", "new"]);
    expect(db.deleteMany.mock.calls[0][0].where.mac).toEqual({ notIn: ["AA:00:00:00:00:01"] });
  });

  it("defaults an unparseable lastSeen to now, and deletes + upserts in one transaction", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-16T12:00:00Z"));
      await reconcileMacAddresses("a1", [{ mac: "AA:00:00:00:00:01", lastSeen: "not-a-date" }] as never);
    } finally {
      vi.useRealTimers();
    }
    // Was a bug until 2026-11-16: a RangeError was thrown after the stale-row delete had committed, so no new row was written.
    expect(rows(db.execRaw.mock.calls[0], 8)[0][6]).toBe("2026-11-16T12:00:00.000Z");
    expect(db.deleteMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.$transaction)).toHaveBeenCalledTimes(1);
  });

  it("retries a deadlocked statement and then succeeds", async () => {
    db.execRaw.mockRejectedValueOnce(Object.assign(new Error("deadlock detected"), { code: "40P01" })).mockResolvedValue(1);
    await reconcileMacAddresses("a1", [{ mac: "AA:00:00:00:00:01" }] as never);
    expect(db.execRaw).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-deadlock error", async () => {
    db.deleteMany.mockRejectedValue(new Error("connection lost"));
    await expect(reconcileMacAddresses("a1", [{ mac: "AA:00:00:00:00:01" }] as never)).rejects.toThrow("connection lost");
    expect(db.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.execRaw).not.toHaveBeenCalled();
  });
});

describe("reconcileInterfaceMacs", () => {
  const NOW = new Date("2026-11-16T10:00:00Z");

  it("deletes only interface rows when the scrape has no valid MAC", async () => {
    await reconcileInterfaceMacs("a1", [null, undefined, "", "garbage", "00:00:00:00:00:00"], NOW);
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", source: IF_SRC } });
    expect(db.findMany).not.toHaveBeenCalled();
    expect(db.execRaw).not.toHaveBeenCalled();
  });

  it("folds contiguous MACs into a range row and upserts singles with macEnd null", async () => {
    await reconcileInterfaceMacs("a1", ["aa:00:00:00:00:03", "AA-00-00-00-00-01", "aa:00:00:00:00:02", "bb:00:00:00:00:09"], NOW);
    expect(db.deleteMany).toHaveBeenCalledWith({
      where: { assetId: "a1", source: IF_SRC, mac: { notIn: ["AA:00:00:00:00:01", "BB:00:00:00:00:09"] } },
    });
    const call = db.execRaw.mock.calls[0];
    expect(call[0]).toContain(`"macEnd" = EXCLUDED."macEnd"`);
    expect(call[0]).not.toMatch(/"firstSeen" = EXCLUDED/);
    expect(rows(call, 6)).toEqual([
      ["a1", "AA:00:00:00:00:01", "AA:00:00:00:00:03", IF_SRC, NOW.toISOString(), NOW.toISOString()],
      ["a1", "BB:00:00:00:00:09", null, IF_SRC, NOW.toISOString(), NOW.toISOString()],
    ]);
  });

  it("slides a range's start past a key another source holds", async () => {
    db.findMany.mockResolvedValue([
      { mac: "AA:00:00:00:00:01", source: "fortigate" },
      { mac: "AA:00:00:00:00:02", source: "polaris-agent" },
      { mac: "AA:00:00:00:00:05", source: IF_SRC }, // our own row: not occupied
    ]);
    await reconcileInterfaceMacs("a1", ["AA:00:00:00:00:01", "AA:00:00:00:00:02", "AA:00:00:00:00:03", "AA:00:00:00:00:04"], NOW);
    expect(rows(db.execRaw.mock.calls[0], 6)[0].slice(0, 3)).toEqual(["a1", "AA:00:00:00:00:03", "AA:00:00:00:00:04"]);
  });

  it("collapses a range slid down to one MAC into a single row", async () => {
    db.findMany.mockResolvedValue([{ mac: "AA:00:00:00:00:01", source: "fortigate" }]);
    await reconcileInterfaceMacs("a1", ["AA:00:00:00:00:01", "AA:00:00:00:00:02"], NOW);
    expect(rows(db.execRaw.mock.calls[0], 6)[0].slice(1, 3)).toEqual(["AA:00:00:00:00:02", null]);
  });

  it("drops an entry other sources cover entirely, and wipes our rows when nothing is left", async () => {
    db.findMany.mockResolvedValue([
      { mac: "AA:00:00:00:00:01", source: "fortigate" },
      { mac: "AA:00:00:00:00:02", source: "fortigate" },
    ]);
    await reconcileInterfaceMacs("a1", ["AA:00:00:00:00:01", "AA:00:00:00:00:02"], NOW);
    expect(db.deleteMany).toHaveBeenCalledTimes(1);
    expect(db.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", source: IF_SRC } });
    expect(db.execRaw).not.toHaveBeenCalled();
  });

  it("never deletes another source's rows", async () => {
    db.findMany.mockResolvedValue([{ mac: "CC:00:00:00:00:01", source: "fortigate" }]);
    await reconcileInterfaceMacs("a1", ["AA:00:00:00:00:01"], NOW);
    for (const [arg] of db.deleteMany.mock.calls) expect(arg.where.source).toBe(IF_SRC);
  });
});
