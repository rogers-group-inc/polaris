/**
 * tests/unit/persistAssetServices.test.ts
 *
 * Coverage for the service-inventory DELTA writer (serviceInventoryService):
 *   - isServiceControllable: systemd loaded→true, masked/not-found→false,
 *     Windows always→true
 *   - persistAssetServices: one interactive transaction that reads the host's
 *     rows and creates / updates / deletes only what changed, normalizes CPU
 *     and memory before comparing, and stamps the scrape time.
 *
 * Prisma is an in-memory table (the transaction runs its callback against it)
 * so the assertions are about what ends up STORED and which writes were
 * issued. tests/integration/inventoryDeltaWrite.test.ts runs the same writer
 * against Postgres.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { table, scrapes, ops } = vi.hoisted(() => ({
  table: new Map<string, Record<string, unknown>>(),
  scrapes: new Map<string, Date>(),
  ops: [] as string[],
}));

vi.mock("../../src/db.js", () => {
  const assetService = {
    findMany: vi.fn(async (a: { where: { assetId: string } }) =>
      [...table.values()].filter((r) => r.assetId === a.where.assetId).map((r) => ({ ...r }))),
    deleteMany: vi.fn(async (a: { where: { id: { in: string[] } } }) => {
      ops.push(`delete:${a.where.id.in.length}`);
      for (const id of a.where.id.in) table.delete(id);
      return { count: a.where.id.in.length };
    }),
    createMany: vi.fn(async (a: { data: Array<Record<string, unknown>> }) => {
      ops.push(`create:${a.data.length}`);
      for (const r of a.data) table.set(r.id as string, { ...r });
      return { count: a.data.length };
    }),
    updateMany: vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
      ops.push("update");
      const r = table.get(a.where.id);
      if (r) Object.assign(r, a.data);
      return { count: r ? 1 : 0 };
    }),
  };
  const assetInventoryScrape = {
    upsert: vi.fn(async (a: { where: { assetId_kind: { assetId: string; kind: string } }; update: { scrapedAt: Date } }) => {
      scrapes.set(`${a.where.assetId_kind.assetId}|${a.where.assetId_kind.kind}`, a.update.scrapedAt);
    }),
  };
  const tx = { assetService, assetInventoryScrape };
  return { prisma: { ...tx, $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } };
});
vi.mock("../../src/utils/dbRetry.js", () => ({
  retryOnDeadlock: (fn: () => Promise<unknown>) => fn(),
}));

import { persistAssetServices, isServiceControllable, isPolarisAgentOwnUnit, type AssetServiceInput } from "../../src/services/serviceInventoryService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const txn = prisma.$transaction as unknown as Mock;
const stored = (unit: string) => [...table.values()].find((r) => r.unit === unit);

const ASSET = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function svc(over: Partial<AssetServiceInput>): AssetServiceInput {
  return {
    unit: "x.service", platform: "systemd", displayName: null, description: null, loadState: "loaded",
    activeState: "active", subState: "running", enabledState: "enabled",
    mainPid: null, mainProcess: null, memBytes: null, cpuPct: null, ...over,
  };
}

beforeEach(() => { table.clear(); scrapes.clear(); ops.length = 0; txn.mockClear(); });

describe("isServiceControllable", () => {
  it("systemd loaded → controllable", () => {
    expect(isServiceControllable(svc({ loadState: "loaded" }))).toBe(true);
  });
  it("systemd masked / not-found → not controllable", () => {
    expect(isServiceControllable(svc({ loadState: "masked" }))).toBe(false);
    expect(isServiceControllable(svc({ loadState: "not-found" }))).toBe(false);
    expect(isServiceControllable(svc({ loadState: null }))).toBe(false);
  });
  it("windows → always controllable", () => {
    expect(isServiceControllable(svc({ platform: "windows", loadState: null }))).toBe(true);
  });
  it("the agent's own service is never controllable (both platforms)", () => {
    expect(isServiceControllable(svc({ unit: "polaris-agent.service", loadState: "loaded" }))).toBe(false);
    expect(isServiceControllable(svc({ unit: "polaris-agent", platform: "windows", loadState: null }))).toBe(false);
  });
});

describe("isPolarisAgentOwnUnit", () => {
  it("matches the Linux unit and Windows short name, case-insensitively", () => {
    expect(isPolarisAgentOwnUnit("polaris-agent.service")).toBe(true);
    expect(isPolarisAgentOwnUnit("polaris-agent")).toBe(true);
    expect(isPolarisAgentOwnUnit("  POLARIS-AGENT.SERVICE ")).toBe(true);
  });
  it("does not match unrelated units", () => {
    expect(isPolarisAgentOwnUnit("sshd.service")).toBe(false);
    expect(isPolarisAgentOwnUnit("polaris-agent-helper.service")).toBe(false);
  });
});

describe("persistAssetServices", () => {
  const T0 = new Date("2026-09-28T15:00:00Z");

  it("creates every row on a first scrape, with derived controllable, in one transaction", async () => {
    const r = await persistAssetServices(ASSET, [
      svc({ unit: "truckscale-central.service", loadState: "loaded", mainPid: 2589126, mainProcess: "java", memBytes: 925368320n }),
      svc({ unit: "masked.service", loadState: "masked" }),
    ], T0);
    expect(r).toEqual({ created: 2, updated: 0, removed: 0, unchanged: 0 });
    expect(txn).toHaveBeenCalledTimes(1);
    expect(ops).toEqual(["create:2"]);
    const ts = stored("truckscale-central.service")!;
    expect(ts.controllable).toBe(true);
    expect(ts.mainProcess).toBe("java");
    // Three significant figures: 925,368,320 → 925,000,000.
    expect(ts.memBytes).toBe(925_000_000n);
    expect(ts.assetId).toBe(ASSET);
    expect(stored("masked.service")!.controllable).toBe(false);
    expect(scrapes.get(`${ASSET}|services`)).toEqual(T0);
  });

  it("writes nothing but the scrape stamp when nothing changed — jitter included", async () => {
    await persistAssetServices(ASSET, [svc({ unit: "a.service", cpuPct: 0.03, memBytes: 402_653_184n })], T0);
    const id = stored("a.service")!.id;
    ops.length = 0;
    const T1 = new Date(T0.getTime() + 300_000);
    // CPU 0.03 → 0.04 and memory +2 KiB both round to the same stored value.
    const r = await persistAssetServices(ASSET, [svc({ unit: "a.service", cpuPct: 0.04, memBytes: 402_655_232n })], T1);
    expect(r).toEqual({ created: 0, updated: 0, removed: 0, unchanged: 1 });
    expect(ops).toEqual([]);
    expect(stored("a.service")!.id).toBe(id);
    expect(scrapes.get(`${ASSET}|services`)).toEqual(T1);
  });

  it("a figure inside its dead band is not rewritten; outside it is, rounded", async () => {
    await persistAssetServices(ASSET, [svc({ unit: "a.service", cpuPct: 0.2, memBytes: 100_000_000n })], T0);
    ops.length = 0;
    expect((await persistAssetServices(ASSET, [svc({ unit: "a.service", cpuPct: 0.9, memBytes: 101_000_000n })], T0)).unchanged).toBe(1);
    expect(stored("a.service")!.cpuPct).toBe(0.2); // lags by less than a point
    const r = await persistAssetServices(ASSET, [svc({ unit: "a.service", cpuPct: 1.26, memBytes: 101_000_000n })], T0);
    expect(r.updated).toBe(1);
    expect(stored("a.service")!.cpuPct).toBe(1.3);
    expect(ops).toEqual(["update"]);
  });

  it("updates only what changed, deletes what vanished, creates what appeared", async () => {
    await persistAssetServices(ASSET, [
      svc({ unit: "keep.service" }),
      svc({ unit: "stops.service", activeState: "active" }),
      svc({ unit: "gone.service" }),
    ], T0);
    ops.length = 0;
    const r = await persistAssetServices(ASSET, [
      svc({ unit: "keep.service" }),
      svc({ unit: "stops.service", activeState: "inactive" }),
      svc({ unit: "new.service" }),
    ], T0);
    expect(r).toEqual({ created: 1, updated: 1, removed: 1, unchanged: 1 });
    expect([...ops].sort()).toEqual(["create:1", "delete:1", "update"]);
    expect(stored("stops.service")!.activeState).toBe("inactive");
    expect(stored("gone.service")).toBeUndefined();
    expect(stored("new.service")).toBeDefined();
  });

  it("carries a Windows service's description and CPU through to the row", async () => {
    await persistAssetServices(ASSET, [
      svc({ unit: "Spooler", platform: "windows", loadState: null, enabledState: "auto-delayed",
        description: "Spools print jobs.", cpuPct: 1.25, memBytes: 12_000_000n }),
    ], T0);
    const sp = stored("Spooler")!;
    expect(sp.description).toBe("Spools print jobs.");
    expect(sp.cpuPct).toBe(1.3);
    expect(sp.enabledState).toBe("auto-delayed");
    expect(sp.memBytes).toBe(12_000_000n);
  });

  it("an empty scrape deletes the host's rows and still stamps the scrape", async () => {
    await persistAssetServices(ASSET, [svc({ unit: "a.service" }), svc({ unit: "b.service" })], T0);
    ops.length = 0;
    const r = await persistAssetServices(ASSET, [], T0);
    expect(r.removed).toBe(2);
    expect(ops).toEqual(["delete:2"]);
    expect(table.size).toBe(0);
    expect(scrapes.has(`${ASSET}|services`)).toBe(true);
  });
});
