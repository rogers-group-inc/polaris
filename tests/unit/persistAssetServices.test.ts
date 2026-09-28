/**
 * tests/unit/persistAssetServices.test.ts
 *
 * Coverage for the service-inventory delete-replace writer
 * (serviceInventoryService):
 *   - isServiceControllable: systemd loaded→true, masked/not-found→false,
 *     Windows always→true
 *   - persistAssetServices: one deleteMany + one createMany in a single
 *     $transaction; controllable derived per row; empty input → delete-only
 *
 * Prisma + retryOnDeadlock are mocked; assertions run against the transaction
 * shape and the createMany payload.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetService: { deleteMany: vi.fn(() => ({ op: "delete" })), createMany: vi.fn((a: unknown) => ({ op: "create", a })) },
    $transaction: vi.fn(async (ops: unknown[]) => ops),
  },
}));
vi.mock("../../src/utils/dbRetry.js", () => ({
  retryOnDeadlock: (fn: () => Promise<unknown>) => fn(),
}));

import { persistAssetServices, isServiceControllable, isPolarisAgentOwnUnit, type AssetServiceInput } from "../../src/services/serviceInventoryService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const createMany = prisma.assetService.createMany as unknown as Mock;
const deleteMany = prisma.assetService.deleteMany as unknown as Mock;
const txn = prisma.$transaction as unknown as Mock;

const ASSET = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function svc(over: Partial<AssetServiceInput>): AssetServiceInput {
  return {
    unit: "x.service", platform: "systemd", displayName: null, description: null, loadState: "loaded",
    activeState: "active", subState: "running", enabledState: "enabled",
    mainPid: null, mainProcess: null, memBytes: null, cpuPct: null, ...over,
  };
}

beforeEach(() => { createMany.mockClear(); deleteMany.mockClear(); txn.mockClear(); });

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
  it("delete-replaces in one transaction with derived controllable", async () => {
    await persistAssetServices(ASSET, [
      svc({ unit: "truckscale-central.service", loadState: "loaded", mainPid: 2589126, mainProcess: "java", memBytes: 925368320n }),
      svc({ unit: "masked.service", loadState: "masked" }),
    ]);
    expect(txn).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { assetId: ASSET } });
    const payload = createMany.mock.calls.at(-1)![0] as { data: Array<Record<string, unknown>> };
    expect(payload.data).toHaveLength(2);
    const ts = payload.data.find((r) => r.unit === "truckscale-central.service")!;
    expect(ts.controllable).toBe(true);
    expect(ts.mainProcess).toBe("java");
    expect(ts.memBytes).toBe(925368320n);
    expect(ts.assetId).toBe(ASSET);
    expect(payload.data.find((r) => r.unit === "masked.service")!.controllable).toBe(false);
  });

  it("carries a Windows service's description and CPU through to the row", async () => {
    await persistAssetServices(ASSET, [
      svc({ unit: "Spooler", platform: "windows", loadState: null, enabledState: "auto-delayed",
        description: "Spools print jobs.", cpuPct: 1.25, memBytes: 12_000_000n }),
    ]);
    const payload = createMany.mock.calls.at(-1)![0] as { data: Array<Record<string, unknown>> };
    const sp = payload.data[0]!;
    expect(sp.description).toBe("Spools print jobs.");
    expect(sp.cpuPct).toBe(1.25);
    expect(sp.enabledState).toBe("auto-delayed");
    expect(sp.memBytes).toBe(12_000_000n);
  });

  it("empty input issues a delete-only transaction (no createMany)", async () => {
    await persistAssetServices(ASSET, []);
    expect(txn).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(createMany).not.toHaveBeenCalled();
  });
});
