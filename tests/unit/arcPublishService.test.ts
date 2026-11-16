/**
 * tests/unit/arcPublishService.test.ts
 *
 * The edges of the Arc run-command path that tests/unit/arcPublish.test.ts
 * (roster re-resolution, opt-in, partial failure) does not reach:
 * getMachineResult, listMachines, the 200 boundary, an unknown integration,
 * the audit when every id resolved, and a selection that names one machine
 * twice. Arc EXECUTES on create, so the target list is the review gate.
 * azureArcService is mocked; nothing reaches ARM.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listRunCommandTargets: vi.fn(),
  dispatchRunCommand: vi.fn(),
  readRunCommandResult: vi.fn(),
  getOnboardingScript: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/azureArcService.js", () => ({
  listRunCommandTargets: h.listRunCommandTargets,
  dispatchRunCommand: h.dispatchRunCommand,
  readRunCommandResult: h.readRunCommandResult,
}));
vi.mock("../../src/services/windowsSshOnboardingService.js", () => ({ getOnboardingScript: h.getOnboardingScript }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  ARC_RUN_COMMAND_NAME,
  getMachineResult,
  listMachines,
  listPublishTargets,
  runOnboardingOnMachines,
} from "../../src/services/arcPublishService.js";

const integ = { findUnique: stubbed(prisma.integration.findUnique), findMany: stubbed(prisma.integration.findMany) };
const arm = (name: string) => `/subscriptions/s/resourceGroups/rg/providers/Microsoft.HybridCompute/machines/${name}`;
const machine = (name: string, osType = "linux") => ({ armId: arm(name), name, subscriptionId: "s", resourceGroup: "rg", azureRegion: "eastus", osType, status: "Connected" });

function enabled(config: Record<string, unknown> = {}) {
  integ.findUnique.mockResolvedValue({ id: "i1", name: "Corp Arc", type: "azurearc", config: { allowRunCommand: true, ...config } });
}
async function rejection(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (err) { return err as AppError; }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  vi.clearAllMocks();
  h.listRunCommandTargets.mockReset().mockResolvedValue([machine("m1"), machine("m2", "windows")]);
  h.dispatchRunCommand.mockReset().mockImplementation(async (_c: unknown, targets: any[]) =>
    targets.map((t) => ({ armId: t.armId, name: t.name, dispatched: true, skipped: false })));
  h.readRunCommandResult.mockReset().mockResolvedValue({ provisioningState: "Succeeded", exitCode: 0 });
  h.getOnboardingScript.mockReset().mockImplementation(async (platform: string) => ({ script: platform === "linux" ? "SH" : "PS1" }));
});

describe("opt-in gate", () => {
  it("404s an unknown integration before any Azure call", async () => {
    integ.findUnique.mockResolvedValue(null);
    expect((await rejection(runOnboardingOnMachines("nope", [arm("m1")], "alice"))).httpStatus).toBe(404);
    expect((await rejection(listMachines("nope"))).httpStatus).toBe(404);
    expect((await rejection(getMachineResult("nope", arm("m1")))).httpStatus).toBe(404);
    expect(h.listRunCommandTargets).not.toHaveBeenCalled();
  });

  it("refuses a null config and a non-boolean flag", async () => {
    integ.findUnique.mockResolvedValue({ id: "i1", name: "Corp Arc", type: "azurearc", config: null });
    expect((await rejection(listMachines("i1"))).httpStatus).toBe(400);
    enabled({ allowRunCommand: "yes" });
    expect((await rejection(listMachines("i1"))).httpStatus).toBe(400);
    expect(h.listRunCommandTargets).not.toHaveBeenCalled();
  });

  it("checks the selection size before loading the integration", async () => {
    expect((await rejection(runOnboardingOnMachines("i1", [], "alice"))).httpStatus).toBe(400);
    expect(integ.findUnique).not.toHaveBeenCalled();
  });
});

describe("listMachines", () => {
  it("returns the live roster for an enabled integration, executing nothing", async () => {
    enabled();
    expect(await listMachines("i1")).toEqual([machine("m1"), machine("m2", "windows")]);
    expect(h.dispatchRunCommand).not.toHaveBeenCalled();
  });
});

describe("runOnboardingOnMachines", () => {
  it("accepts exactly 200 ids and refuses 201", async () => {
    enabled();
    const ids200 = Array.from({ length: 200 }, (_, i) => arm(`x${i}`));
    h.listRunCommandTargets.mockResolvedValue(ids200.map((_, i) => machine(`x${i}`)));
    await expect(runOnboardingOnMachines("i1", ids200, "alice")).resolves.toMatchObject({ dispatched: 200 });
    expect((await rejection(runOnboardingOnMachines("i1", [...ids200, arm("one-more")], "alice"))).httpStatus).toBe(400);
  });

  it("passes the stable run-command name and both scripts", async () => {
    enabled();
    await runOnboardingOnMachines("i1", [arm("m1")], "alice");
    const [, targets, scripts, opts] = h.dispatchRunCommand.mock.calls[0];
    expect(targets).toEqual([machine("m1")]);
    expect(scripts).toEqual({ windows: "PS1", linux: "SH" });
    expect(opts).toEqual({ runCommandName: ARC_RUN_COMMAND_NAME });
  });

  it("leaves unknownArmIds out of the audit when every id resolved", async () => {
    enabled();
    await runOnboardingOnMachines("i1", [arm("m1"), arm("m2")], "alice");
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "arc.run_command_executed", level: "warning", actor: "alice", details: { dispatched: 2, skipped: 0, failed: 0 } });
    expect(ev.details).not.toHaveProperty("unknownArmIds");
  });

  it("counts a result that is neither dispatched nor skipped as failed, carrying its error", async () => {
    enabled();
    h.dispatchRunCommand.mockResolvedValue([
      { armId: arm("m1"), name: "m1", dispatched: false, skipped: false, error: "403" },
      { armId: arm("m2"), name: "m2", dispatched: false, skipped: true, error: "OS unknown" },
    ]);
    const out = await runOnboardingOnMachines("i1", [arm("m1"), arm("m2")], "alice");
    expect(out).toMatchObject({ dispatched: 0, skipped: 1, failed: 1 });
    expect(eventLog.logEvent.mock.calls[0][0].message).toMatch(/on 0 Arc machine\(s\).*\(1 skipped, 1 failed\)/);
  });

  // BUG: runOnboardingOnMachines resolves every id in `armIds` against the
  // roster and pushes the hit, with no de-duplication — so a selection that
  // names one machine twice (the same id, or the same id in another case,
  // which the case-insensitive match maps to one roster row) sends that
  // machine to dispatchRunCommand twice: two PUTs of the same run-command
  // name, the second replacing the first while it may still be executing as
  // root/SYSTEM, and the audit says "2 machines". Right: each roster machine
  // is targeted once.
  it.fails("targets a machine once when the selection names it twice (any case)", async () => {
    enabled();
    await runOnboardingOnMachines("i1", [arm("m1"), arm("m1").toUpperCase()], "alice");
    expect(h.dispatchRunCommand.mock.calls[0][1]).toHaveLength(1);
  });
});

describe("getMachineResult", () => {
  it("reads the run command by the stable name for a roster machine, case-insensitively", async () => {
    enabled();
    const out = await getMachineResult("i1", arm("m2").toLowerCase());
    expect(out).toEqual({ provisioningState: "Succeeded", exitCode: 0 });
    const [, target, name] = h.readRunCommandResult.mock.calls[0];
    expect(target).toEqual(machine("m2", "windows"));
    expect(name).toBe(ARC_RUN_COMMAND_NAME);
  });

  it("404s a machine not in this integration's roster", async () => {
    enabled();
    const err = await rejection(getMachineResult("i1", arm("elsewhere")));
    expect(err.httpStatus).toBe(404);
    expect(h.readRunCommandResult).not.toHaveBeenCalled();
  });
});

describe("listPublishTargets", () => {
  it("lists Arc integrations, a null config reading as not enabled", async () => {
    integ.findMany.mockResolvedValue([{ id: "a", name: "A", config: null }, { id: "b", name: "B", config: { allowRunCommand: true } }]);
    expect(await listPublishTargets()).toEqual([
      { integrationId: "a", integrationName: "A", enabled: false },
      { integrationId: "b", integrationName: "B", enabled: true },
    ]);
    expect(integ.findMany.mock.calls[0][0]).toMatchObject({ where: { type: "azurearc" }, orderBy: { name: "asc" } });
  });
});
