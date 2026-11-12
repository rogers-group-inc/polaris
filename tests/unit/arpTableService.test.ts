/**
 * tests/unit/arpTableService.test.ts
 *
 * The three decisions in `persistFortigateArpTables` that a wrong answer would
 * make invisible rather than loud: which gates get wiped, which asset a gate
 * resolves to, and what `matchedAssetId` is allowed to join on.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { persistFortigateArpTables } from "../../src/services/arpTableService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const sourceFindMany = stubbed(prisma.assetSource.findMany);
const executeRaw = stubbed(prisma.$executeRawUnsafe);

const row = (device: string, ip: string, mac: string, iface = "internal1", age?: number) =>
  ({ fortigateDevice: device, ip, mac, interface: iface, age });

function resetPrisma() {
  resetDbStub();
  sourceFindMany.mockReset().mockResolvedValue([{ assetId: "asset-gate-a", externalId: "FG100F0001" }]);
  executeRaw.mockReset().mockResolvedValue(1);
}

/**
 * The writer builds ONE parameterized INSERT per chunk: `sql` first, then the
 * flat param list (assetId, now, then nine per row). Reading the params back
 * into row objects is what lets these assertions talk about rows rather than
 * about SQL text.
 */
const ROW_PARAMS = 6; // id, ip, mac, ifName, ageSec, matchedAssetId
function insertedRows(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const call of executeRaw.mock.calls) {
    const [, assetId, , ...rest] = call as unknown[];
    for (let i = 0; i + ROW_PARAMS <= rest.length; i += ROW_PARAMS) {
      out.push({
        assetId,
        ipAddress:      rest[i + 1],
        macAddress:     rest[i + 2],
        ifName:         rest[i + 3],
        ageSec:         rest[i + 4],
        matchedAssetId: rest[i + 5],
      });
    }
  }
  return out;
}
/** The SQL text of the first statement, for the ON CONFLICT assertions. */
const sqlText = () => String(executeRaw.mock.calls[0]?.[0] ?? "");

const baseOpts = {
  integrationId: "int-1",
  deviceSerials: new Map([["FGT-A", "FG100F0001"]]),
  matchAssetByMac: () => null,
};

beforeEach(resetPrisma);

describe("persistFortigateArpTables — which gates it records", () => {
  it("does nothing at all when no gate answered", async () => {
    const result = await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: [],
    });
    expect(result.assetsWritten).toBe(0);
    expect(sourceFindMany).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("writes nothing for an answering gate that reported zero rows", async () => {
    // Under the old delete-replace writer this WIPED the gate. Accumulate+age
    // has no way to express "the cache is empty" and must not invent one:
    // retention is the only thing that removes a row.
    const result = await persistFortigateArpTables({ ...baseOpts, rows: [], answeredDevices: ["FGT-A"] });
    expect(result.entriesWritten).toBe(0);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("records only the gates that answered", async () => {
    sourceFindMany.mockResolvedValue([
      { assetId: "asset-gate-a", externalId: "FG100F0001" },
      { assetId: "asset-gate-b", externalId: "FG100F0002" },
    ]);
    await persistFortigateArpTables({
      ...baseOpts,
      deviceSerials: new Map([["FGT-A", "FG100F0001"], ["FGT-B", "FG100F0002"]]),
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"), row("FGT-B", "10.1.0.1", "AA:BB:CC:DD:EE:02")],
      answeredDevices: ["FGT-A"],
    });
    const rows = insertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ assetId: "asset-gate-a", ipAddress: "10.0.0.1" });
  });

  it("matches the answering device case-insensitively", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("fgt-a", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(insertedRows()).toHaveLength(1);
  });
});

describe("persistFortigateArpTables — resolving the gate to an asset", () => {
  it("goes name -> serial -> assetId, and queries the fortigate-firewall source kind", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(sourceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        integrationId: "int-1",
        sourceKind: "fortigate-firewall",
        externalId: { in: ["FG100F0001"] },
      }),
    }));
    expect(insertedRows()[0].assetId).toBe("asset-gate-a");
  });

  it("reports a gate with no firewall asset instead of writing anything for it", async () => {
    sourceFindMany.mockResolvedValue([]);
    const result = await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(result.assetsWritten).toBe(0);
    expect(result.unresolvedDevices).toEqual(["fgt-a"]);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("reports a gate whose name never resolved to a serial", async () => {
    const result = await persistFortigateArpTables({
      ...baseOpts,
      deviceSerials: new Map(),
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(result.unresolvedDevices).toEqual(["fgt-a"]);
    expect(sourceFindMany).not.toHaveBeenCalled();
  });
});

describe("persistFortigateArpTables — row content", () => {
  it("resolves matchedAssetId from the MAC and passes the normalized value", async () => {
    const seen: string[] = [];
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "aa-bb-cc-dd-ee-01")],
      answeredDevices: ["FGT-A"],
      matchAssetByMac: (mac) => { seen.push(mac); return "asset-endpoint"; },
    });
    expect(seen).toEqual(["AA:BB:CC:DD:EE:01"]);
    expect(insertedRows()[0].matchedAssetId).toBe("asset-endpoint");
  });

  it("stores null rather than undefined for an unmatched MAC", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
      matchAssetByMac: () => undefined,
    });
    expect(insertedRows()[0].matchedAssetId).toBeNull();
  });

  it("writes the empty-string sentinel, never NULL, for an unattributed row", async () => {
    // NULL here would defeat the ON CONFLICT target and insert a duplicate on
    // every scrape, since Postgres treats NULLs as distinct.
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "")],
      answeredDevices: ["FGT-A"],
    });
    expect(insertedRows()[0].ifName).toBe("");
  });

  it("upserts rather than deleting: no wipe, and firstSeen is absent from the update", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    const sql = sqlText();
    expect(sql).toContain("ON CONFLICT");
    expect(sql).not.toMatch(/DELETE/i);
    const update = sql.slice(sql.indexOf("DO UPDATE"));
    expect(update).not.toContain('"firstSeen"');
    expect(update).toContain('"lastSeen"');
  });

  it("never clears an existing match, only fills one in", async () => {
    await persistFortigateArpTables({
      ...baseOpts,
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")],
      answeredDevices: ["FGT-A"],
    });
    expect(sqlText()).toContain('COALESCE(EXCLUDED."matchedAssetId"');
  });
});

describe("persistFortigateArpTables — failure isolation", () => {
  it("keeps going after one gate's write throws, and reports only what landed", async () => {
    sourceFindMany.mockResolvedValue([
      { assetId: "asset-gate-a", externalId: "FG100F0001" },
      { assetId: "asset-gate-b", externalId: "FG100F0002" },
    ]);
    let call = 0;
    executeRaw.mockImplementation(async () => {
      call++;
      if (call === 1) throw new Error("deadlock detected");
      return 1;
    });
    const result = await persistFortigateArpTables({
      ...baseOpts,
      deviceSerials: new Map([["FGT-A", "FG100F0001"], ["FGT-B", "FG100F0002"]]),
      rows: [row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"), row("FGT-B", "10.1.0.1", "AA:BB:CC:DD:EE:02")],
      answeredDevices: ["FGT-A", "FGT-B"],
    });
    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(result.assetsWritten).toBe(1);
    expect(result.entriesWritten).toBe(1);
  });

  it("logs a warning-level line when a gate's table is truncated", async () => {
    const log = vi.fn();
    const many = Array.from({ length: 4100 }, (_, i) =>
      row("FGT-A", `10.${Math.floor(i / 254)}.0.${(i % 254) + 1}`, `AA:BB:CC:${String(i).padStart(6, "0").slice(0, 2)}:00:${String(i % 100).padStart(2, "0")}`, "internal1"),
    );
    const result = await persistFortigateArpTables({
      ...baseOpts, rows: many, answeredDevices: ["FGT-A"], log,
    });
    expect(result.truncated).toBeGreaterThan(0);
    expect(log).toHaveBeenCalledWith("warning", expect.stringContaining("dropped"));
  });
});
