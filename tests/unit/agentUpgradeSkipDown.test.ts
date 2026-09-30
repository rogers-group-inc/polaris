/**
 * tests/unit/agentUpgradeSkipDown.test.ts
 *
 * upgradeAllOutdated never attempts a host monitoring reads as DOWN: the
 * SSH/WinRM connect would only sit out its timeout while holding one of the
 * pool slots every reachable host is queued behind. The row is left untouched
 * for the next fan-out, and the deferral is recorded as its own Event action
 * (agent.upgrade_deferred) so an automation keyed on agent.upgrade_skipped —
 * "a host stranded on its old binary" — doesn't page about a host that is off.
 * An UNMONITORED asset's monitorStatus is stale, so it is still attempted.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    managedAgent: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
  logEvent: vi.fn(async () => {}),
  logEventsBatch: vi.fn(async () => 0),
  getInventory: vi.fn(),
}));

vi.mock("../../src/db.js", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: h.logEvent,
  logEventsBatch: h.logEventsBatch,
}));
vi.mock("../../src/services/agentBuildService.js", () => ({
  getInventory: h.getInventory,
}));

const { upgradeAllOutdated } = await import("../../src/services/agentInstallService.js");

const row = (id: string, monitored: boolean, monitorStatus: string) => ({
  id, assetId: `asset-${id}`, agentVersion: "0.18.0",
  asset: { hostname: `HOST-${id}`, ipAddress: null, monitored, monitorStatus },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.getInventory.mockResolvedValue({ manifest: { currentVersion: "0.19.0" } });
  // Every attempted row refuses at the first read — enough to tell an
  // attempted row (startUpgrade ran, agent.upgrade_skipped) from a deferred one.
  h.prisma.managedAgent.findUnique.mockResolvedValue(null);
});

describe("upgradeAllOutdated — down hosts", () => {
  it("defers a monitored DOWN host without attempting it, and still attempts the rest", async () => {
    h.prisma.managedAgent.findMany.mockResolvedValue([
      row("down", true, "down"),
      row("up", true, "up"),
      row("stale", false, "down"),
    ]);

    const r = await upgradeAllOutdated("tester");

    expect(r.eligible).toBe(3);
    expect(r.deferredDown).toBe(1);
    const attempted = h.prisma.managedAgent.findUnique.mock.calls.map((c: any[]) => c[0].where.id).sort();
    expect(attempted).toEqual(["stale", "up"]);

    const deferred = h.logEventsBatch.mock.calls[0][0] as any[];
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({
      action: "agent.upgrade_deferred", resourceId: "asset-down", resourceName: "HOST-down", level: "info",
    });
    expect(r.perAsset.find((p) => p.managedAgentId === "down")).toMatchObject({ ok: false, error: "host is down" });

    // The skip Event belongs to rows that were attempted and refused, never
    // to the deferred one.
    const skippedFor = h.logEvent.mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => e.action === "agent.upgrade_skipped")
      .map((e: any) => e.resourceId);
    expect(skippedFor).not.toContain("asset-down");
  });

  it("writes no deferral when nothing is down", async () => {
    h.prisma.managedAgent.findMany.mockResolvedValue([row("up", true, "up")]);
    const r = await upgradeAllOutdated("tester");
    expect(r.deferredDown).toBe(0);
    expect(h.logEventsBatch).not.toHaveBeenCalled();
  });
});
