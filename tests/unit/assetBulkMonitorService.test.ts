/**
 * tests/unit/assetBulkMonitorService.test.ts — POST /assets/bulk-monitor's
 * write, moved out of routes/assets/list.ts (CQ-B062 slice 2), and the
 * unfiltered tag list GET /assets/tags reads (assetTagListService). The HTTP
 * contract stays in tests/integration/monitorableStatusClamp.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  assertCreds: vi.fn(),
  recompute: vi.fn(),
  recordUse: vi.fn(),
  logEvent: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({ prisma: { asset: { findMany: m.findMany, updateMany: m.updateMany } } }));
vi.mock("../../src/services/credentialService.js", () => ({ assertCredentialAssignments: m.assertCreds }));
vi.mock("../../src/services/monitorOverrideService.js", () => ({ recomputeMonitorOverrideForAssets: m.recompute }));
vi.mock("../../src/services/credentialUseAuditService.js", () => ({
  recordCredentialUse: m.recordUse,
  assetCredentialDestination: (a: { ipAddress: string | null }) => a.ipAddress,
}));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: m.logEvent }));

import { bulkSetMonitored } from "../../src/services/assetBulkMonitorService.js";
import { listAllAssetTags } from "../../src/services/assetTagListService.js";

const credActor = { username: "op", actor: "op", mayUseAny: false };
beforeEach(() => { for (const f of Object.values(m)) f.mockReset(); m.updateMany.mockResolvedValue({ count: 0 }); });

describe("bulkSetMonitored", () => {
  it("reports missing ids and unmonitorable statuses per id and updates the rest in one statement", async () => {
    m.findMany.mockResolvedValue([
      { id: "a", status: "active", hostname: "a", ipAddress: "10.0.0.1", monitorCredentialId: null },
      { id: "d", status: "decommissioned", hostname: "d", ipAddress: null, monitorCredentialId: null },
    ]);
    m.updateMany.mockResolvedValue({ count: 1 });
    const r = await bulkSetMonitored({ ids: ["a", "d", "gone"], monitored: true }, credActor, "op");
    expect(r.updated).toBe(1);
    expect(r.errors).toEqual([
      { id: "gone", error: "Asset not found" },
      { id: "d", error: "A decommissioned asset cannot be monitored" },
    ]);
    const call = m.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: { in: ["a"] } });
    // clampMonitoredState: enabling resets the probe state.
    expect(call.data).toMatchObject({ monitored: true, monitorStatus: "recovering", consecutiveFailures: 0, consecutiveSuccesses: 0 });
    expect(m.recompute).toHaveBeenCalledWith(expect.anything(), ["a"]);
    expect(m.logEvent.mock.calls[0][0]).toMatchObject({ action: "monitor.bulk_enabled", actor: "op" });
  });

  it("records the credential only for assets that did not already carry it (rule 112)", async () => {
    m.findMany.mockResolvedValue([
      { id: "a", status: "active", hostname: "a", ipAddress: "10.0.0.1", monitorCredentialId: "c1" },
      { id: "b", status: "active", hostname: "b", ipAddress: "10.0.0.2", monitorCredentialId: null },
    ]);
    m.updateMany.mockResolvedValue({ count: 2 });
    await bulkSetMonitored({ ids: ["a", "b"], monitored: true, monitorCredentialId: "c1" }, credActor, "op");
    expect(m.assertCreds).toHaveBeenCalledWith({ monitorCredentialId: "c1" }, null);
    const [actor, via, uses] = m.recordUse.mock.calls[0];
    expect(actor).toBe(credActor);
    expect(via).toBe("asset.bulk-monitor");
    expect(uses.map((u: { assetId: string }) => u.assetId)).toEqual(["b"]);
  });

  it("disabling never refuses a status and writes nothing when no id exists", async () => {
    m.findMany.mockResolvedValue([]);
    const r = await bulkSetMonitored({ ids: ["x"], monitored: false }, credActor, undefined);
    expect(r).toEqual({ updated: 0, errors: [{ id: "x", error: "Asset not found" }] });
    expect(m.updateMany).not.toHaveBeenCalled();
    expect(m.logEvent.mock.calls[0][0].action).toBe("monitor.bulk_disabled");
  });
});

describe("listAllAssetTags", () => {
  it("returns every distinct tag, sorted, with no monitored filter", async () => {
    m.findMany.mockResolvedValue([{ tags: ["b", "a"] }, { tags: ["a", "c"] }]);
    expect(await listAllAssetTags()).toEqual(["a", "b", "c"]);
    expect(m.findMany.mock.calls[0][0].where).toEqual({ NOT: { tags: { isEmpty: true } } });
  });
});
