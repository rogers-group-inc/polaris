/**
 * tests/unit/dependencyBlameCacheRace.test.ts
 *
 * Business rule 78 — the engine's gate (`suppressionOwedToMaintenance`) walks
 * every suppressed device's blame IN PARALLEL through ONE per-tick
 * `BlameLoadCache`. A walk that finds a node's edges already marked loaded must
 * still see the states the loading walk is fetching above it; if it gives up
 * there, the maintained gate is invisible to it and an opted-in down
 * automation fires mid-window, to be retired by the next sweep (production,
 * 2026-11-23: the Boone belt scales under one plant switch looped
 * fire → clear every few minutes).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const { resolveDependencyBlame, newBlameLoadCache } = await import("../../src/services/dependencyTreeService.js");

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id, hostname: id.toUpperCase(), assetType: "switch", monitored: true, monitorStatus: "up",
  status: "active", dependencyLayer: 1, dependencySuppressed: false, dependencyTestUntil: null, ...over,
});

beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  stubbed(prisma.assetMaintenanceWindow.findMany).mockResolvedValue([]);
});

describe("resolveDependencyBlame — concurrent walks on one tick cache", () => {
  it("a second walk through a half-loaded switch still finds the maintained gate above it", async () => {
    // scale1, scale2 → sw (Dep. Down) → fg (in a maintenance window).
    const edges: Record<string, string> = { scale1: "sw", scale2: "sw", sw: "fg" };
    stubbed(prisma.assetDependencyParent.findMany).mockImplementation(async ({ where }: any) =>
      (where.assetId.in as string[]).filter((id) => edges[id]).map((id) => ({ assetId: id, parentAssetId: edges[id], source: "computed" })));

    // Hold the read of fg's state until the second walk has run.
    let releaseFg!: () => void;
    const fgHeld = new Promise<void>((r) => { releaseFg = r; });
    let fgRequested!: () => void;
    const fgAsked = new Promise<void>((r) => { fgRequested = r; });
    const all = [
      node("sw", { monitorStatus: "down", dependencySuppressed: true }),
      node("fg", { assetType: "firewall", monitorStatus: "down", status: "maintenance" }),
    ];
    stubbed(prisma.asset.findMany).mockImplementation(async ({ where }: any) => {
      if (where.fortinetTopology) return [];
      const ids = where.id.in as string[];
      if (ids.includes("fg")) { fgRequested(); await fgHeld; }
      return all.filter((a) => ids.includes(a.id));
    });

    const cache = newBlameLoadCache();
    const first = resolveDependencyBlame("scale1", cache);
    await fgAsked; // walk 1 has marked sw's edges loaded and is fetching fg
    const second = resolveDependencyBlame("scale2", cache);
    // Let walk 2 run as far as it can on its own before fg arrives.
    await new Promise((r) => setTimeout(r, 10));
    releaseFg();

    const [b1, b2] = await Promise.all([first, second]);
    expect(b1?.maintenance?.id).toBe("fg");
    expect(b2?.maintenance?.id).toBe("fg");
    expect(b2?.rootCause).toMatchObject({ id: "fg", reason: "maintenance" });
  });
});
