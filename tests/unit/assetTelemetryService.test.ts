/**
 * tests/unit/assetTelemetryService.test.ts — the write paths of the telemetry
 * family moved out of routes/assets/telemetry.ts (CQ-B062 slice 2): a CHANGED
 * process log glob needs Agent Deploy and a sane shape (rule 107) while a
 * resave of the current one does not, and an interface comment clears on an
 * empty string and upserts otherwise.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({ sync: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());
vi.mock("../../src/services/descriptionSyncService.js", () => ({ syncDescriptionsOnSave: m.sync }));

import { setProcessLogConfig, setInterfaceComment } from "../../src/services/assetTelemetryService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  cfgFindUnique: stubbed(prisma.assetProcessConfig.findUnique),
  cfgUpsert: stubbed(prisma.assetProcessConfig.upsert),
  assetFindUnique: stubbed(prisma.asset.findUnique),
  ovDeleteMany: stubbed(prisma.assetInterfaceOverride.deleteMany),
  ovUpsert: stubbed(prisma.assetInterfaceOverride.upsert),
};

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(m)) f.mockReset();
  db.cfgUpsert.mockImplementation(async ({ update }: any) => ({ name: "nginx", detectedUnit: null, ...update }));
});

describe("setProcessLogConfig", () => {
  it("refuses a NEW glob without Agent Deploy", async () => {
    db.cfgFindUnique.mockResolvedValue({ logPathGlob: null });
    await expect(setProcessLogConfig("a", "nginx", { logPathGlob: "/var/log/nginx/*.log" }, false, "op")).rejects.toMatchObject({ httpStatus: 403 });
    expect(db.cfgUpsert).not.toHaveBeenCalled();
  });
  it("refuses a UNC / relative glob even with Agent Deploy", async () => {
    db.cfgFindUnique.mockResolvedValue({ logPathGlob: null });
    await expect(setProcessLogConfig("a", "nginx", { logPathGlob: "\\\\server\\share\\x.log" }, true, "op")).rejects.toMatchObject({ httpStatus: 400 });
  });
  it("lets an assets:write caller resave the glob as it stands", async () => {
    db.cfgFindUnique.mockResolvedValue({ logPathGlob: "/var/log/nginx/*.log" });
    const r = await setProcessLogConfig("a", "nginx", { logPathGlob: "/var/log/nginx/*.log", notes: "n" }, false, "op");
    expect(r.config).toMatchObject({ logPathGlob: "/var/log/nginx/*.log", notes: "n" });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.process.log_config_set", actor: "op" });
  });
  it("clearing the glob needs no lookup and no grant", async () => {
    await setProcessLogConfig("a", "nginx", { logPathGlob: null }, false, "op");
    expect(db.cfgFindUnique).not.toHaveBeenCalled();
    expect(db.cfgUpsert).toHaveBeenCalled();
  });
});

describe("setInterfaceComment", () => {
  it("404s an unknown asset", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    await expect(setInterfaceComment("x", "port1", "uplink", "op")).rejects.toMatchObject({ httpStatus: 404 });
  });
  it("an empty comment deletes the override and skips the device sync", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a", hostname: "sw1" });
    const r = await setInterfaceComment("a", "port1", "", "op");
    expect(db.ovDeleteMany).toHaveBeenCalledWith({ where: { assetId: "a", ifName: "port1" } });
    expect(m.sync).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, ifName: "port1", description: null });
  });
  it("a comment upserts the override and asks Description Sync", async () => {
    db.assetFindUnique.mockResolvedValue({ id: "a", hostname: "sw1" });
    m.sync.mockResolvedValue({ pushed: 1 });
    const r = await setInterfaceComment("a", "port1", "uplink", "op");
    expect(db.ovUpsert.mock.calls[0][0].create).toMatchObject({ assetId: "a", ifName: "port1", description: "uplink", updatedBy: "op" });
    expect(m.sync).toHaveBeenCalledWith({ assetId: "a", scope: "interface", ifName: "port1", actor: "op" });
    expect(r).toMatchObject({ description: "uplink", sync: { pushed: 1 } });
  });
});
