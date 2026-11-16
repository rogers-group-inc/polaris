/**
 * tests/unit/discoveryRunState.test.ts — CQ-T010 own suite for
 * src/services/discoveryRunState.ts, the DB-backed live state of a discovery
 * run (polaris-change-impact → discovery-fortinet.md).
 *
 * Contract under test: the enqueue upsert resets EVERY per-run field (counters,
 * slow flags, cancel request, scope label) and stamps a fresh createdAt; the
 * worker's flush never touches the web-owned slow flags; progress flushes and
 * heartbeats are best-effort; the reaper marks stale queued/running rows as
 * error. Prisma is the shared stub.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/logger.js", () => {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  logger.child = () => logger;
  return { logger };
});

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { logger } from "../../src/utils/logger.js";
import {
  newRunAccumulator,
  upsertQueuedRun,
  markRunStarted,
  flushRunProgress,
  touchWorkerHeartbeat,
  finishRun,
  isRunActive,
  anyRunActive,
  isCancelRequested,
  requestCancel,
  listActiveRuns,
  persistSlowFlags,
  reapStaleRuns,
} from "../../src/services/discoveryRunState.js";

const p = prisma as any;
const NOW = new Date("2026-11-16T12:00:00.000Z");
const ACTIVE = { in: ["queued", "running"] };

beforeEach(() => {
  resetDbStub();
  vi.mocked(logger.warn).mockReset();
  vi.mocked(logger.debug).mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("newRunAccumulator", () => {
  it("starts empty with zeroed counters and no total", () => {
    const acc = newRunAccumulator("i1", "FMG", "fortimanager", 123);
    expect(acc).toMatchObject({
      integrationId: "i1",
      integrationName: "FMG",
      type: "fortimanager",
      startedAt: 123,
      totalDevices: null,
      completedCount: 0,
      skippedOfflineCount: 0,
      skippedErrorCount: 0,
    });
    expect(acc.skippedErrorDevices.size).toBe(0);
    expect(acc.activeDevices.size).toBe(0);
  });

  it("gives each run its own Set and Map", () => {
    const a = newRunAccumulator("i1", "A", "t", 0);
    const b = newRunAccumulator("i2", "B", "t", 0);
    a.activeDevices.set("gw", 1);
    a.skippedErrorDevices.add("gw");
    expect(b.activeDevices.size).toBe(0);
    expect(b.skippedErrorDevices.size).toBe(0);
  });
});

describe("upsertQueuedRun", () => {
  const resetFields = {
    integrationName: "FMG",
    type: "fortimanager",
    status: "queued",
    actor: "alice",
    startedAt: null,
    finishedAt: null,
    totalDevices: null,
    completedCount: 0,
    skippedOfflineCount: 0,
    skippedErrorCount: 0,
    activeDevices: [],
    slowAlerted: false,
    slowAlertedDevices: [],
    cancelRequested: false,
    workerHeartbeatAt: null,
  };

  it("creates a queued row keyed on the integration and resets every per-run field on update", async () => {
    await upsertQueuedRun({ integrationId: "i1", integrationName: "FMG", type: "fortimanager", actor: "alice" });
    expect(p.discoveryRun.upsert).toHaveBeenCalledTimes(1);
    const arg = stubbed(p.discoveryRun.upsert).mock.calls[0]![0];
    expect(arg.where).toEqual({ integrationId: "i1" });
    expect(arg.create).toEqual({ integrationId: "i1", ...resetFields, scopeDeviceName: null });
    expect(arg.update).toEqual({ ...resetFields, scopeDeviceName: null, createdAt: NOW });
  });

  it("does not set createdAt on create (the column default does that the first time)", async () => {
    await upsertQueuedRun({ integrationId: "i1", integrationName: "FMG", type: "fortimanager", actor: "alice" });
    const arg = stubbed(p.discoveryRun.upsert).mock.calls[0]![0];
    expect("createdAt" in arg.create).toBe(false);
  });

  it("stamps a scoped re-discovery's device name", async () => {
    await upsertQueuedRun({ integrationId: "i1", integrationName: "FMG", type: "fortimanager", actor: "alice", scopeDeviceName: "FGT-HQ" });
    const arg = stubbed(p.discoveryRun.upsert).mock.calls[0]![0];
    expect(arg.create.scopeDeviceName).toBe("FGT-HQ");
    expect(arg.update.scopeDeviceName).toBe("FGT-HQ");
  });

  it("a later full run resets the scope label to NULL", async () => {
    await upsertQueuedRun({ integrationId: "i1", integrationName: "FMG", type: "fortimanager", actor: "alice", scopeDeviceName: "FGT-HQ" });
    await upsertQueuedRun({ integrationId: "i1", integrationName: "FMG", type: "fortimanager", actor: "alice" });
    const second = stubbed(p.discoveryRun.upsert).mock.calls[1]![0];
    expect(second.update.scopeDeviceName).toBeNull();
  });

  it("propagates a DB failure (the enqueue must not pretend it queued)", async () => {
    stubbed(p.discoveryRun.upsert).mockRejectedValue(new Error("db down"));
    await expect(upsertQueuedRun({ integrationId: "i1", integrationName: "x", type: "t", actor: "a" })).rejects.toThrow("db down");
  });
});

describe("markRunStarted", () => {
  it("flips the row to running with the given start and a first heartbeat", async () => {
    const started = new Date("2026-11-16T11:59:00.000Z");
    await markRunStarted("i1", started);
    expect(p.discoveryRun.update).toHaveBeenCalledWith({
      where: { integrationId: "i1" },
      data: { status: "running", startedAt: started, workerHeartbeatAt: NOW },
    });
  });
});

describe("flushRunProgress", () => {
  it("serializes the accumulator onto the row, active devices as {name, startedAt}", async () => {
    const acc = newRunAccumulator("i1", "FMG", "fortimanager", 1);
    acc.totalDevices = 10;
    acc.completedCount = 4;
    acc.skippedOfflineCount = 2;
    acc.skippedErrorCount = 1;
    acc.skippedErrorDevices.add("FGT-B");
    acc.activeDevices.set("FGT-A", 1000);
    acc.activeDevices.set("FGT-C", 2000);
    stubbed(p.discoveryRun.update).mockResolvedValue({});
    await flushRunProgress(acc);
    expect(p.discoveryRun.update).toHaveBeenCalledWith({
      where: { integrationId: "i1" },
      data: {
        totalDevices: 10,
        completedCount: 4,
        skippedOfflineCount: 2,
        skippedErrorCount: 1,
        activeDevices: [{ name: "FGT-A", startedAt: 1000 }, { name: "FGT-C", startedAt: 2000 }],
        workerHeartbeatAt: NOW,
      },
    });
  });

  it("never writes the web-owned slow-alert flags, nor the in-memory error device names", async () => {
    const acc = newRunAccumulator("i1", "FMG", "fortimanager", 1);
    acc.skippedErrorDevices.add("FGT-B");
    stubbed(p.discoveryRun.update).mockResolvedValue({});
    await flushRunProgress(acc);
    const data = stubbed(p.discoveryRun.update).mock.calls[0]![0].data;
    expect(data).not.toHaveProperty("slowAlerted");
    expect(data).not.toHaveProperty("slowAlertedDevices");
    expect(data).not.toHaveProperty("skippedErrorDevices");
    expect(data).not.toHaveProperty("status");
  });

  it("is best-effort: a DB failure is logged at debug and swallowed", async () => {
    stubbed(p.discoveryRun.update).mockRejectedValue(new Error("transient"));
    await expect(flushRunProgress(newRunAccumulator("i1", "x", "t", 0))).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(expect.objectContaining({ integrationId: "i1" }), expect.any(String));
  });
});

describe("touchWorkerHeartbeat", () => {
  it("touches only a queued/running row", async () => {
    stubbed(p.discoveryRun.updateMany).mockResolvedValue({ count: 1 });
    await touchWorkerHeartbeat("i1");
    expect(p.discoveryRun.updateMany).toHaveBeenCalledWith({
      where: { integrationId: "i1", status: ACTIVE },
      data: { workerHeartbeatAt: NOW },
    });
  });

  it("swallows a DB failure", async () => {
    stubbed(p.discoveryRun.updateMany).mockRejectedValue(new Error("x"));
    await expect(touchWorkerHeartbeat("i1")).resolves.toBeUndefined();
  });
});

describe("finishRun", () => {
  it.each(["completed", "aborted", "error"] as const)("writes the terminal %s status, finishedAt, a heartbeat and clears active devices", async (status) => {
    stubbed(p.discoveryRun.update).mockResolvedValue({});
    await finishRun("i1", status);
    expect(p.discoveryRun.update).toHaveBeenCalledWith({
      where: { integrationId: "i1" },
      data: { status, finishedAt: NOW, workerHeartbeatAt: NOW, activeDevices: [] },
    });
  });

  it("logs a warning and does not throw when the finalize fails", async () => {
    stubbed(p.discoveryRun.update).mockRejectedValue(new Error("gone"));
    await expect(finishRun("i1", "completed")).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ integrationId: "i1", status: "completed" }), expect.any(String));
  });
});

describe("isRunActive / anyRunActive", () => {
  it("isRunActive counts queued/running rows for the integration", async () => {
    stubbed(p.discoveryRun.count).mockResolvedValue(1);
    await expect(isRunActive("i1")).resolves.toBe(true);
    expect(p.discoveryRun.count).toHaveBeenCalledWith({ where: { integrationId: "i1", status: ACTIVE } });
    stubbed(p.discoveryRun.count).mockResolvedValue(0);
    await expect(isRunActive("i1")).resolves.toBe(false);
  });

  it("anyRunActive counts across every integration", async () => {
    stubbed(p.discoveryRun.count).mockResolvedValue(3);
    await expect(anyRunActive()).resolves.toBe(true);
    expect(p.discoveryRun.count).toHaveBeenCalledWith({ where: { status: ACTIVE } });
    stubbed(p.discoveryRun.count).mockResolvedValue(0);
    await expect(anyRunActive()).resolves.toBe(false);
  });
});

describe("isCancelRequested / requestCancel", () => {
  it("reads the cancel flag; a missing row or a false flag is not a cancel", async () => {
    stubbed(p.discoveryRun.findUnique).mockResolvedValueOnce({ cancelRequested: true });
    await expect(isCancelRequested("i1")).resolves.toBe(true);
    expect(p.discoveryRun.findUnique).toHaveBeenCalledWith({ where: { integrationId: "i1" }, select: { cancelRequested: true } });
    stubbed(p.discoveryRun.findUnique).mockResolvedValueOnce({ cancelRequested: false });
    await expect(isCancelRequested("i1")).resolves.toBe(false);
    stubbed(p.discoveryRun.findUnique).mockResolvedValueOnce(null);
    await expect(isCancelRequested("i1")).resolves.toBe(false);
  });

  it("requestCancel flips only an active row and reports whether it did", async () => {
    stubbed(p.discoveryRun.updateMany).mockResolvedValueOnce({ count: 1 });
    await expect(requestCancel("i1")).resolves.toBe(true);
    expect(p.discoveryRun.updateMany).toHaveBeenCalledWith({
      where: { integrationId: "i1", status: ACTIVE },
      data: { cancelRequested: true },
    });
    stubbed(p.discoveryRun.updateMany).mockResolvedValueOnce({ count: 0 });
    await expect(requestCancel("i1")).resolves.toBe(false);
  });
});

describe("listActiveRuns", () => {
  it("lists queued/running rows oldest start first", async () => {
    const rows = [{ integrationId: "i1" }];
    stubbed(p.discoveryRun.findMany).mockResolvedValue(rows);
    await expect(listActiveRuns()).resolves.toBe(rows);
    expect(p.discoveryRun.findMany).toHaveBeenCalledWith({ where: { status: ACTIVE }, orderBy: { startedAt: "asc" } });
  });
});

describe("persistSlowFlags", () => {
  it("writes only the slow-alert flags", async () => {
    stubbed(p.discoveryRun.update).mockResolvedValue({});
    await persistSlowFlags("i1", true, ["FGT-A"]);
    expect(p.discoveryRun.update).toHaveBeenCalledWith({
      where: { integrationId: "i1" },
      data: { slowAlerted: true, slowAlertedDevices: ["FGT-A"] },
    });
  });

  it("swallows a failure (a run that finished in between has no row to flag)", async () => {
    stubbed(p.discoveryRun.update).mockRejectedValue(new Error("P2025"));
    await expect(persistSlowFlags("i1", false, [])).resolves.toBeUndefined();
  });
});

describe("reapStaleRuns", () => {
  it("marks queued/running rows with a stale heartbeat — or none and an old createdAt — as error", async () => {
    stubbed(p.discoveryRun.updateMany).mockResolvedValue({ count: 2 });
    await expect(reapStaleRuns(10 * 60_000)).resolves.toBe(2);
    const cutoff = new Date(NOW.getTime() - 10 * 60_000);
    expect(p.discoveryRun.updateMany).toHaveBeenCalledWith({
      where: {
        status: ACTIVE,
        OR: [
          { workerHeartbeatAt: { lt: cutoff } },
          { workerHeartbeatAt: null, createdAt: { lt: cutoff } },
        ],
      },
      data: { status: "error", finishedAt: NOW, activeDevices: [] },
    });
    expect(logger.warn).toHaveBeenCalledWith({ reaped: 2, maxStaleMs: 600_000 }, expect.any(String));
  });

  it("reaps nothing quietly", async () => {
    stubbed(p.discoveryRun.updateMany).mockResolvedValue({ count: 0 });
    await expect(reapStaleRuns(60_000)).resolves.toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("propagates a DB failure to the reaper job", async () => {
    stubbed(p.discoveryRun.updateMany).mockRejectedValue(new Error("down"));
    await expect(reapStaleRuns(60_000)).rejects.toThrow("down");
  });
});
