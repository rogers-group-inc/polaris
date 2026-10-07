import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  assetFind: vi.fn(),
  assetUpdate: vi.fn(),
  sourceFind: vi.fn(),
  snapshot: vi.fn(),
  invalidate: vi.fn(),
  openHold: vi.fn(),
  releaseHold: vi.fn(),
  recompute: vi.fn(),
  logEvent: vi.fn(),
  containerAction: vi.fn(),
  vmAction: vi.fn(),
  appAction: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({
  prisma: { asset: { findUnique: h.assetFind, update: h.assetUpdate }, assetSource: { findFirst: h.sourceFind } },
}));
vi.mock("../../src/services/workloadMonitorService.js", () => ({
  fetchWorkloadSnapshotCached: h.snapshot, invalidateWorkloadSnapshot: h.invalidate,
}));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ openMaintenanceHold: h.openHold, releaseMaintenanceHold: h.releaseHold }));
vi.mock("../../src/services/monitorOverrideService.js", () => ({ recomputeMonitorOverrideForAssets: h.recompute }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/unraidService.js", () => ({ containerAction: h.containerAction, vmAction: h.vmAction, refreshUpdateChecks: vi.fn() }));
vi.mock("../../src/services/truenasService.js", () => ({ appAction: h.appAction, vmAction: vi.fn(), refreshUpdateChecks: vi.fn() }));

const svc = await import("../../src/services/workloadActionService.js");

const ctr = (state: string, updateAvailable: boolean | null = false) => ({
  platformId: "srv:NEWID", name: "plex", image: "plex", state, rawState: state.toUpperCase(), ip: null,
  updateAvailable, version: null, latestVersion: null, memberCount: 1, ports: [], autostart: true,
});

function setup(opts: { state?: string; updateAvailable?: boolean | null; monitored?: boolean; virtualization?: Record<string, unknown>; platform?: "unraid" | "truenas" } = {}) {
  const platform = opts.platform ?? "unraid";
  h.assetFind.mockResolvedValue({ id: "a1", hostname: "plex", monitored: opts.monitored ?? true, virtualization: opts.virtualization ?? { role: "container" } });
  h.sourceFind.mockResolvedValue({
    sourceKind: platform === "unraid" ? "unraid-container" : "truenas-app",
    externalId: "int1:ctr:plex",
    integration: { id: "int1", name: "Tower", type: platform, config: { host: "h", apiToken: "k" }, enabled: true },
  });
  h.snapshot.mockResolvedValue({
    vmsById: new Map(),
    containersById: new Map([["int1:ctr:plex", ctr(opts.state ?? "running", opts.updateAvailable ?? false)]]),
  });
}

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  h.openHold.mockResolvedValue(true);
  h.releaseHold.mockResolvedValue(true);
  h.assetUpdate.mockResolvedValue({});
});

describe("allowedVerbs", () => {
  it("offers what the state allows, and update only for a container with one waiting", () => {
    expect(svc.allowedVerbs("container", "running", true)).toEqual(["stop", "restart", "update"]);
    expect(svc.allowedVerbs("container", "stopped", false)).toEqual(["start"]);
    expect(svc.allowedVerbs("vm", "running", true)).toEqual(["stop", "restart"]);
    expect(svc.allowedVerbs("vm", "paused", null)).toEqual(["start", "stop"]);
  });
});

describe("runWorkloadAction", () => {
  it("restarts under a maintenance hold, with the FRESH platform id, and releases it", async () => {
    setup();
    await svc.runWorkloadAction({ assetId: "a1", verb: "restart", actor: "alice" });
    expect(h.openHold).toHaveBeenCalledWith({ assetId: "a1", kind: "workload-restart", actor: "alice" });
    expect(h.containerAction).toHaveBeenCalledWith(expect.anything(), "srv:NEWID", "restart");
    expect(h.releaseHold).toHaveBeenCalledWith({ assetId: "a1", kind: "workload-restart" });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.workload.restart", level: "info", actor: "alice" }));
  });

  it("releases the hold and audits the failure when the platform refuses", async () => {
    setup({ updateAvailable: true });
    h.containerAction.mockRejectedValue(new Error("pull failed"));
    await expect(svc.runWorkloadAction({ assetId: "a1", verb: "update", actor: "alice" })).rejects.toThrow(/pull failed/);
    expect(h.releaseHold).toHaveBeenCalledWith({ assetId: "a1", kind: "workload-update" });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.workload.update", level: "error" }));
    expect(h.assetUpdate).not.toHaveBeenCalled();
  });

  it("refuses a verb the state does not allow, and audits the refusal", async () => {
    setup({ state: "stopped" });
    await expect(svc.runWorkloadAction({ assetId: "a1", verb: "restart", actor: "a" })).rejects.toMatchObject({ httpStatus: 409 });
    expect(h.containerAction).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ level: "warning" }));
  });

  it("refuses an update when none is available", async () => {
    setup({ updateAvailable: false });
    await expect(svc.runWorkloadAction({ assetId: "a1", verb: "update", actor: "a" })).rejects.toThrow(/no update is available/);
  });

  it("a stop pauses monitoring (no TTL'd hold) and flags it; the start resumes it", async () => {
    setup();
    await svc.runWorkloadAction({ assetId: "a1", verb: "stop", actor: "a" });
    expect(h.openHold).not.toHaveBeenCalled();
    expect(h.assetUpdate).toHaveBeenCalledWith({
      where: { id: "a1" },
      data: { virtualization: { role: "container", monitoringPausedByStop: true }, monitored: false },
    });
    expect(h.recompute).toHaveBeenCalledWith(expect.anything(), ["a1"]);

    for (const f of Object.values(h)) f.mockClear();
    setup({ state: "stopped", monitored: false, virtualization: { role: "container", monitoringPausedByStop: true } });
    await svc.runWorkloadAction({ assetId: "a1", verb: "start", actor: "a" });
    expect(h.assetUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { virtualization: { role: "container" }, monitored: true } });
  });

  it("leaves monitoring alone when the operator opts out of the pause", async () => {
    setup();
    await svc.runWorkloadAction({ assetId: "a1", verb: "stop", actor: "a", pauseMonitoring: false });
    expect(h.assetUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { virtualization: { role: "container" } } });
    expect(h.recompute).not.toHaveBeenCalled();
  });

  it("does not resume monitoring an operator paused by hand", async () => {
    setup({ state: "stopped", monitored: false });
    await svc.runWorkloadAction({ assetId: "a1", verb: "start", actor: "a" });
    expect(h.assetUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { virtualization: { role: "container" } } });
  });

  it("routes a TrueNAS App through appAction by name", async () => {
    setup({ platform: "truenas", updateAvailable: true });
    await svc.runWorkloadAction({ assetId: "a1", verb: "update", actor: "a" });
    expect(h.appAction).toHaveBeenCalledWith(expect.anything(), "srv:NEWID", "update");
  });

  it("refuses the host and anything without a workload source", async () => {
    setup();
    h.sourceFind.mockResolvedValue({ sourceKind: "unraid-host", externalId: "int1:host", integration: { id: "int1", name: "T", type: "unraid", config: {}, enabled: true } });
    await expect(svc.runWorkloadAction({ assetId: "a1", verb: "stop", actor: "a" })).rejects.toThrow(/not to the host/);
    h.sourceFind.mockResolvedValue(null);
    await expect(svc.runWorkloadAction({ assetId: "a1", verb: "stop", actor: "a" })).rejects.toThrow(/Only a VM or container/);
  });
});
