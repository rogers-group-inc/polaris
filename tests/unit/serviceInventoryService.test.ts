/**
 * tests/unit/serviceInventoryService.test.ts — the service-inventory writer's
 * edges that tests/unit/persistAssetServices.test.ts (the delta) and
 * tests/unit/inventoryPresence.test.ts (the tab presence) do not reach:
 * controllable is derived, never trusted from the wire; the write retries a
 * deadlock and nothing else; a first scrape skips duplicates; an update is
 * keyed by row id through updateMany; presence answers false on an empty host.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/sleep.js", () => ({ sleep: vi.fn(async () => undefined) }));

import {
  isServiceControllable,
  isPolarisAgentOwnUnit,
  persistAssetServices,
  getInventoryPresence,
  type AssetServiceInput,
} from "../../src/services/serviceInventoryService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const findMany = () => stubbed(prisma.assetService.findMany);
const createMany = () => stubbed(prisma.assetService.createMany);
const updateMany = () => stubbed(prisma.assetService.updateMany);
const deleteMany = () => stubbed(prisma.assetService.deleteMany);
const upsert = () => stubbed(prisma.assetInventoryScrape.upsert);
const transaction = () => stubbed(prisma.$transaction);

function svc(over: Partial<AssetServiceInput> = {}): AssetServiceInput {
  return {
    unit: "nginx.service", platform: "systemd", displayName: null, description: null, loadState: "loaded",
    activeState: "active", subState: "running", enabledState: "enabled",
    mainPid: 100, mainProcess: "nginx", memBytes: null, cpuPct: null, ...over,
  };
}

beforeEach(() => {
  resetDbStub();
  findMany().mockResolvedValue([]);
});

describe("isPolarisAgentOwnUnit / isServiceControllable", () => {
  it("never makes the agent's own Windows service controllable", () => {
    expect(isServiceControllable(svc({ unit: "Polaris-Agent", platform: "windows" }))).toBe(false);
  });

  it("does not treat a unit that merely contains the name as the agent", () => {
    expect(isPolarisAgentOwnUnit("my-polaris-agent.service")).toBe(false);
  });

  it("reads systemd loadState case-insensitively, and an unknown load state as not controllable", () => {
    expect(isServiceControllable(svc({ loadState: "LOADED" }))).toBe(true);
    expect(isServiceControllable(svc({ loadState: null }))).toBe(false);
    expect(isServiceControllable(svc({ loadState: "error" }))).toBe(false);
  });

  it("a Windows service is controllable whatever its load state", () => {
    expect(isServiceControllable(svc({ platform: "windows", unit: "Spooler", loadState: null }))).toBe(true);
  });
});

describe("persistAssetServices", () => {
  it("derives controllable on create — a wire value cannot make the agent's own unit controllable", async () => {
    const wire = { ...svc({ unit: "polaris-agent.service" }), controllable: true } as AssetServiceInput;
    await persistAssetServices("a1", [wire, svc()]);
    const rows = createMany().mock.calls[0][0].data as Array<Record<string, unknown>>;
    expect(createMany().mock.calls[0][0].skipDuplicates).toBe(true);
    expect(rows.find((r) => r.unit === "polaris-agent.service")?.controllable).toBe(false);
    expect(rows.find((r) => r.unit === "nginx.service")).toMatchObject({ assetId: "a1", controllable: true });
    expect(rows.every((r) => typeof r.id === "string" && (r.id as string).length === 36)).toBe(true);
  });

  it("updates a changed row by its id through updateMany (a concurrently deleted row is a no-op, not a throw)", async () => {
    findMany().mockResolvedValue([{ id: "row-1", ...svc(), controllable: true }]);
    const out = await persistAssetServices("a1", [svc({ activeState: "failed", subState: "failed" })]);
    expect(out).toEqual({ created: 0, updated: 1, removed: 0, unchanged: 0 });
    expect(updateMany().mock.calls[0][0]).toMatchObject({ where: { id: "row-1" }, data: { activeState: "failed", subState: "failed" } });
    expect(createMany()).not.toHaveBeenCalled();
    expect(deleteMany()).not.toHaveBeenCalled();
  });

  it("rewrites controllable when the load state changes it", async () => {
    findMany().mockResolvedValue([{ id: "row-1", ...svc(), controllable: true }]);
    await persistAssetServices("a1", [svc({ loadState: "masked" })]);
    expect(updateMany().mock.calls[0][0].data).toMatchObject({ loadState: "masked", controllable: false });
  });

  it("stamps the services scrape at the given time", async () => {
    const at = new Date("2026-11-16T10:00:00Z");
    await persistAssetServices("a1", [], at);
    expect(upsert().mock.calls[0][0]).toEqual({
      where: { assetId_kind: { assetId: "a1", kind: "services" } },
      create: { assetId: "a1", kind: "services", scrapedAt: at },
      update: { scrapedAt: at },
    });
  });

  it("runs in one transaction with a 30 s timeout", async () => {
    await persistAssetServices("a1", [svc()]);
    expect(transaction()).toHaveBeenCalledOnce();
    expect(transaction().mock.calls[0][1]).toEqual({ timeout: 30_000 });
  });

  it("retries the whole transaction on a deadlock", async () => {
    const real = transaction().getMockImplementation()!;
    transaction()
      .mockImplementationOnce(async () => { throw Object.assign(new Error("deadlock detected"), { code: "40P01" }); })
      .mockImplementation(real);
    const out = await persistAssetServices("a1", [svc()]);
    expect(out.created).toBe(1);
    expect(transaction()).toHaveBeenCalledTimes(2);
  });

  it("does not retry any other error", async () => {
    transaction().mockRejectedValue(Object.assign(new Error("unique violation"), { code: "23505" }));
    await expect(persistAssetServices("a1", [svc()])).rejects.toThrow("unique violation");
    expect(transaction()).toHaveBeenCalledOnce();
  });
});

describe("getInventoryPresence", () => {
  it("answers false for both tabs on a host with nothing", async () => {
    for (const m of [prisma.assetService, prisma.assetProcess, prisma.assetSoftware]) stubbed(m.findFirst).mockResolvedValue(null);
    stubbed(prisma.assetInventoryScrape.findFirst).mockResolvedValue(null);
    expect(await getInventoryPresence("a1")).toEqual({ services: false, software: false });
  });

  it("a software row alone lights only the Software tab", async () => {
    for (const m of [prisma.assetService, prisma.assetProcess]) stubbed(m.findFirst).mockResolvedValue(null);
    stubbed(prisma.assetSoftware.findFirst).mockResolvedValue({ id: "s" });
    stubbed(prisma.assetInventoryScrape.findFirst).mockResolvedValue(null);
    expect(await getInventoryPresence("a1")).toEqual({ services: false, software: true });
  });
});
