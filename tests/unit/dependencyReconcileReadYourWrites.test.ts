/**
 * tests/unit/dependencyReconcileReadYourWrites.test.ts
 *
 * `reconcileDependencySuppression` reads each asset's monitorStatus through the
 * probe-patch buffer (business rule 38(c)). `recordProbeResult` BUFFERS its
 * status write and fires `propagateAfterStatusChange` straight away, so the
 * hook's reconcile used to read the parent's row from before the edge it was
 * called for: a gate's →up edge saw `recovering`, held the subtree, and the
 * release waited for the next 60 s tick — a minute per layer down a chain.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const { db } = vi.hoisted(() => {
  const db = {
    assets: [] as Array<Record<string, unknown>>,
    edges: [] as Array<{ assetId: string; parentAssetId: string; source: string }>,
    resumed: [] as string[],
    suppressed: [] as string[],
  };
  return { db };
});

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: {
      findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => {
        // The expired-overlay and HA-standby reads filter; the fleet read does not.
        if (args?.where) return [];
        return db.assets;
      }),
      updateMany: vi.fn((args: { where: { id: { in: string[] } }; data: { dependencySuppressed: boolean } }) => {
        (args.data.dependencySuppressed ? db.suppressed : db.resumed).push(...args.where.id.in);
        return Promise.resolve({ count: args.where.id.in.length });
      }),
    },
    assetDependencyParent: { findMany: vi.fn(async () => db.edges) },
    assetMaintenanceWindow: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (ops: Array<Promise<unknown>>) => Promise.all(ops)),
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({
  logEventsBatch: vi.fn(async () => {}),
  logEvent: vi.fn(async () => {}),
}));

import { reconcileDependencySuppression } from "../../src/services/dependencyTreeService.js";
import { enqueueProbePatch, __test__ as patchBuffer } from "../../src/services/probePatchBuffer.js";

function asset(id: string, layer: number, monitorStatus: string, dependencySuppressed: boolean) {
  return { id, hostname: id, assetType: "switch", monitored: true, monitorStatus, status: "active", dependencyLayer: layer, dependencySuppressed, dependencyTestUntil: null };
}

function patch(status: "up" | "recovering") {
  return { monitorStatus: status, lastMonitorAt: new Date(), lastResponseTimeMs: 2, consecutiveFailures: 0, consecutiveSuccesses: 5 } as const;
}

beforeEach(() => {
  patchBuffer.reset();
  db.resumed.length = 0;
  db.suppressed.length = 0;
  // Gate → switch → AP. On disk the gate still reads `recovering` (its →up
  // patch has not flushed) and so does the switch; both are up in the buffer.
  db.assets = [asset("fg", 1, "recovering", false), asset("sw", 2, "recovering", true), asset("ap", 3, "up", true)];
  db.edges = [
    { assetId: "sw", parentAssetId: "fg", source: "computed" },
    { assetId: "ap", parentAssetId: "sw", source: "computed" },
  ];
});

describe("reconcileDependencySuppression — read-your-writes (rule 38(c))", () => {
  it("holds the subtree when nothing is buffered and the disk says recovering", async () => {
    await reconcileDependencySuppression();
    expect(db.resumed).toEqual([]);
  });

  it("releases the whole chain on the gate's buffered →up, in one pass", async () => {
    enqueueProbePatch("fg", patch("up"));
    enqueueProbePatch("sw", patch("up"));
    await reconcileDependencySuppression();
    expect(db.resumed.sort()).toEqual(["ap", "sw"]);
  });

  it("releases only as far as the buffered state reaches", async () => {
    // The switch's own count has NOT drained: released (its parent is back),
    // but the AP behind it is held until the switch reads `up` itself.
    enqueueProbePatch("fg", patch("up"));
    await reconcileDependencySuppression();
    expect(db.resumed).toEqual(["sw"]);
  });
});
