/**
 * tests/integration/inventoryDeltaWrite.test.ts — the service and process
 * inventory writers against a real Postgres.
 *
 * Both used to delete every row of the host and insert the new list on every
 * scrape. They now write a delta (utils/inventoryDelta). What only a real
 * database can show: an unchanged row really is left alone (same id, same
 * updatedAt — no write reached it), the interactive transaction and the
 * scrape-stamp upsert run for real, and a jittering CPU / memory figure is
 * absorbed by the rounding instead of rewriting the row.
 */

import { afterAll, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import { persistAssetServices, type AssetServiceInput } from "../../src/services/serviceInventoryService.js";
import { persistAssetProcesses, type AssetProcessInput } from "../../src/services/monitoringService.js";

// Neither table has an FK to assets, so a bare id isolates this file's rows.
const ASSET = randomUUID();

const svc = (unit: string, over: Partial<AssetServiceInput> = {}): AssetServiceInput => ({
  unit, platform: "windows", displayName: unit, description: null, loadState: null,
  activeState: "running", subState: null, enabledState: "auto", mainPid: 100,
  mainProcess: "svchost.exe", memBytes: 50_331_648n, cpuPct: 0.03, ...over,
});

const proc = (name: string, over: Partial<AssetProcessInput> = {}): AssetProcessInput => ({
  name, instanceCount: 1, cpuPct: 1.04, memRssBytes: 402_653_184n, exePath: null,
  username: null, startedAt: new Date("2026-09-01T00:00:00Z"), serviceUnit: null, controllable: false, ...over,
});

async function cleanup(): Promise<void> {
  await prisma.assetService.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetProcess.deleteMany({ where: { assetId: ASSET } });
  await prisma.assetInventoryScrape.deleteMany({ where: { assetId: ASSET } });
}

dbDescribe("inventory delta write", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("services: an unchanged row is not rewritten, only the scrape stamp moves", async () => {
    const t0 = new Date("2026-09-28T15:00:00Z");
    await persistAssetServices(ASSET, [svc("Spooler"), svc("BITS")], t0);
    const before = await prisma.assetService.findMany({ where: { assetId: ASSET }, orderBy: { unit: "asc" } });

    // Same services five minutes later, figures jittering inside the rounding.
    const t1 = new Date(t0.getTime() + 300_000);
    const r = await persistAssetServices(ASSET, [svc("Spooler", { cpuPct: 0.04, memBytes: 50_335_744n }), svc("BITS")], t1);
    expect(r).toEqual({ created: 0, updated: 0, removed: 0, unchanged: 2 });
    const after = await prisma.assetService.findMany({ where: { assetId: ASSET }, orderBy: { unit: "asc" } });
    expect(after.map((x) => [x.id, x.updatedAt.getTime()])).toEqual(before.map((x) => [x.id, x.updatedAt.getTime()]));

    const stamp = await prisma.assetInventoryScrape.findUnique({ where: { assetId_kind: { assetId: ASSET, kind: "services" } } });
    expect(stamp?.scrapedAt).toEqual(t1);
  });

  it("services: updates the changed row in place, deletes the vanished one, creates the new one", async () => {
    await persistAssetServices(ASSET, [svc("Spooler"), svc("BITS"), svc("Gone")]);
    const spoolerId = (await prisma.assetService.findFirstOrThrow({ where: { assetId: ASSET, unit: "Spooler" } })).id;
    const r = await persistAssetServices(ASSET, [svc("Spooler", { activeState: "stopped", mainPid: null, cpuPct: null }), svc("BITS"), svc("New")]);
    expect(r).toEqual({ created: 1, updated: 1, removed: 1, unchanged: 1 });
    const rows = await prisma.assetService.findMany({ where: { assetId: ASSET }, orderBy: { unit: "asc" } });
    expect(rows.map((x) => x.unit)).toEqual(["BITS", "New", "Spooler"]);
    const spooler = rows.find((x) => x.unit === "Spooler")!;
    expect(spooler.id).toBe(spoolerId);
    expect(spooler.activeState).toBe("stopped");
    expect(spooler.cpuPct).toBeNull();
  });

  it("processes: same delta, rounding stored, empty scrape deletes all", async () => {
    await persistAssetProcesses(ASSET, [proc("sqlservr.exe", { cpuPct: 184.249, memRssBytes: 12_884_901_888n }), proc("w3wp.exe")]);
    const sql = await prisma.assetProcess.findFirstOrThrow({ where: { assetId: ASSET, name: "sqlservr.exe" } });
    expect(sql.cpuPct).toBe(184.2);
    expect(sql.memRssBytes).toBe(12_900_000_000n);

    const r1 = await persistAssetProcesses(ASSET, [proc("sqlservr.exe", { cpuPct: 184.21, memRssBytes: 12_884_905_984n }), proc("w3wp.exe", { instanceCount: 4 })]);
    expect(r1).toEqual({ created: 0, updated: 1, removed: 0, unchanged: 1 });

    const r2 = await persistAssetProcesses(ASSET, []);
    expect(r2.removed).toBe(2);
    expect(await prisma.assetProcess.count({ where: { assetId: ASSET } })).toBe(0);
    expect(await prisma.assetInventoryScrape.count({ where: { assetId: ASSET, kind: "processes" } })).toBe(1);
  });
});
