/**
 * tests/unit/fortinetLiveVersionService.test.ts
 *
 * Own suite for src/services/fortinetLiveVersionService.ts. The headline
 * behaviours (steady state is free, enrichment-row + projection write, the
 * non-convergence guard, per-device isolation) are pinned in
 * tests/unit/fortinetLiveVersion.test.ts; this file adds the edges: trimming,
 * the shape of the source row, retry after a failed record, a second real
 * change after the guard, the projection choosing nothing, and the
 * envelope-version formatter's corners.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  project: vi.fn(),
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/assetProjection.js", () => ({ projectAssetFromSources: h.project }));
vi.mock("../../src/services/eventLogService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/eventLogService.js")>();
  return { ...actual, logEvent: vi.fn(async (input: Record<string, unknown>) => { h.events.push(input); }) };
});
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  liveVersionDiffers,
  fortigateLiveVersionFor,
  reconcileFortinetLiveVersions,
  resetFortinetLiveVersionCache,
  type FortinetLiveVersionReading,
} from "../../src/services/fortinetLiveVersionService.js";

function reading(over: Partial<FortinetLiveVersionReading> = {}): FortinetLiveVersionReading {
  return { assetId: "a1", hostname: "SW-1", currentOsVersion: "7.4.3", liveVersion: "7.4.5", reader: "fortilink-sweep", ...over };
}

/** Make the projection answer `osVersion` with whatever the fortinet-live row says. */
function projectLiveWins(): void {
  h.project.mockImplementation((sources: Array<{ sourceKind: string; observed: Record<string, unknown> | null }>) => {
    const live = sources.find((s) => s.sourceKind === "fortinet-live");
    return { projected: { osVersion: (live?.observed?.osVersion as string | undefined) ?? null } };
  });
}

beforeEach(() => {
  resetDbStub();
  resetFortinetLiveVersionCache();
  h.project.mockReset();
  h.events.length = 0;
  stubbed(prisma.assetSource.upsert).mockResolvedValue({});
  stubbed(prisma.asset.update).mockResolvedValue({});
  // findMany echoes the row the upsert last wrote for that asset.
  stubbed(prisma.assetSource.findMany).mockImplementation(async ({ where }: { where: { assetId: string } }) => {
    const last = stubbed(prisma.assetSource.upsert).mock.calls.map((c) => c[0]).filter((a) => a.create.assetId === where.assetId).at(-1);
    return last ? [{ sourceKind: "fortinet-live", inferred: false, observed: last.update.observed, lastSeen: last.update.lastSeen }] : [];
  });
  projectLiveWins();
});

describe("liveVersionDiffers — edges", () => {
  it("answers false for an undefined or whitespace live string", () => {
    expect(liveVersionDiffers("7.4.5", undefined)).toBe(false);
    expect(liveVersionDiffers(undefined, undefined)).toBe(false);
  });

  it("fills an empty current value from any readable live one", () => {
    expect(liveVersionDiffers("", "7.4.5")).toBe(true);
    expect(liveVersionDiffers(undefined, "v7.0.1")).toBe(true);
  });

  it("sees a downgrade as a difference too", () => {
    expect(liveVersionDiffers("7.4.5", "7.2.9")).toBe(true);
  });
});

describe("fortigateLiveVersionFor — edges", () => {
  it("answers null for null / undefined / empty", () => {
    expect(fortigateLiveVersionFor("fortigate", null)).toBeNull();
    expect(fortigateLiveVersionFor("fortimanager", undefined)).toBeNull();
    expect(fortigateLiveVersionFor("fortimanager", "")).toBeNull();
  });

  it("trims, and strips a capital V for FortiManager", () => {
    expect(fortigateLiveVersionFor("fortimanager", "  V7.6.1  ")).toBe("7.6.1");
    expect(fortigateLiveVersionFor("fortigate", "  v7.6.1  ")).toBe("v7.6.1");
  });

  it("strips only a leading v", () => {
    expect(fortigateLiveVersionFor("fortimanager", "7.6.1v")).toBe("7.6.1v");
  });

  it("keeps the envelope verbatim for any non-FortiManager type", () => {
    expect(fortigateLiveVersionFor("generic", "v7.0.0")).toBe("v7.0.0");
  });
});

describe("reconcileFortinetLiveVersions — edges", () => {
  it("answers 0 and touches nothing for an empty batch", async () => {
    expect(await reconcileFortinetLiveVersions([])).toBe(0);
    expect(prisma.assetSource.upsert).not.toHaveBeenCalled();
  });

  it("ignores a whitespace-only live string and an unreadable one", async () => {
    const n = await reconcileFortinetLiveVersions([
      reading({ liveVersion: "   " }),
      reading({ assetId: "a2", liveVersion: "FortiAP" }),
      reading({ assetId: "a3", liveVersion: null }),
    ]);
    expect(n).toBe(0);
    expect(prisma.assetSource.upsert).not.toHaveBeenCalled();
  });

  it("records the TRIMMED live string, with its reader, on a fortinet-live row keyed by the asset id", async () => {
    await reconcileFortinetLiveVersions([reading({ liveVersion: "  7.4.5  ", reader: "fortios-probe" })]);

    const arg = stubbed(prisma.assetSource.upsert).mock.calls[0][0];
    expect(arg.where).toEqual({ sourceKind_externalId: { sourceKind: "fortinet-live", externalId: "a1" } });
    expect(arg.create).toMatchObject({
      assetId: "a1", sourceKind: "fortinet-live", externalId: "a1",
      observed: { osVersion: "7.4.5", reader: "fortios-probe" },
    });
    expect(arg.update).toMatchObject({ assetId: "a1", observed: { osVersion: "7.4.5", reader: "fortios-probe" } });
    expect(arg.create.syncedAt).toBeInstanceOf(Date);
    expect(arg.create.lastSeen).toBe(arg.create.syncedAt);
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { osVersion: "7.4.5" } });
  });

  it("projects over every source row of the asset, with the four fields the projection needs", async () => {
    await reconcileFortinetLiveVersions([reading()]);
    expect(prisma.assetSource.findMany).toHaveBeenCalledWith({
      where: { assetId: "a1" },
      select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
    });
    expect(h.project).toHaveBeenCalledTimes(1);
  });

  it("writes nothing to the asset and audits nothing when the projection picks no osVersion", async () => {
    h.project.mockReturnValue({ projected: { osVersion: null } });

    const n = await reconcileFortinetLiveVersions([reading()]);

    expect(n).toBe(0);
    expect(prisma.assetSource.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
  });

  it("audits the change from the caller's current value to the projected one, as system:monitor", async () => {
    await reconcileFortinetLiveVersions([reading({ hostname: "AP-7" })]);

    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({
      action: "asset.firmware.changed",
      resourceId: "a1",
      resourceName: "AP-7",
      actor: "system:monitor",
    });
    expect(String(h.events[0].message)).toContain("7.4.3 → 7.4.5");
  });

  it("records a later real change after the guard has remembered the earlier one", async () => {
    h.project.mockReturnValue({ projected: { osVersion: "7.4.3" } }); // another source keeps winning
    await reconcileFortinetLiveVersions([reading({ liveVersion: "7.4.5" })]);
    await reconcileFortinetLiveVersions([reading({ liveVersion: "7.4.5" })]);
    expect(prisma.assetSource.upsert).toHaveBeenCalledTimes(1);

    await reconcileFortinetLiveVersions([reading({ liveVersion: "7.6.0" })]);
    expect(prisma.assetSource.upsert).toHaveBeenCalledTimes(2);
  });

  it("re-records after resetFortinetLiveVersionCache (the process-restart case)", async () => {
    h.project.mockReturnValue({ projected: { osVersion: "7.4.3" } });
    await reconcileFortinetLiveVersions([reading()]);
    resetFortinetLiveVersionCache();
    await reconcileFortinetLiveVersions([reading()]);
    expect(prisma.assetSource.upsert).toHaveBeenCalledTimes(2);
  });

  it("does not remember a reading whose upsert failed, so the next pass retries it", async () => {
    stubbed(prisma.assetSource.upsert).mockRejectedValueOnce(new Error("deadlock"));

    expect(await reconcileFortinetLiveVersions([reading()])).toBe(0);
    expect(await reconcileFortinetLiveVersions([reading()])).toBe(1);
    expect(prisma.assetSource.upsert).toHaveBeenCalledTimes(2);
  });

  it("never rejects, even when every device fails", async () => {
    stubbed(prisma.assetSource.upsert).mockRejectedValue(new Error("db gone"));
    await expect(reconcileFortinetLiveVersions([reading(), reading({ assetId: "a2" })])).resolves.toBe(0);
  });

  it("counts only the devices whose asset row actually moved", async () => {
    h.project.mockImplementation((sources: Array<{ observed: Record<string, unknown> | null }>) => {
      const v = sources[0]?.observed?.osVersion as string;
      // a2's projection lands on the value the caller already shows.
      return { projected: { osVersion: v === "7.6.0" ? "7.2.0" : v } };
    });
    const n = await reconcileFortinetLiveVersions([
      reading({ assetId: "a1", liveVersion: "7.4.5" }),
      reading({ assetId: "a2", currentOsVersion: "7.2.0", liveVersion: "7.6.0" }),
    ]);
    expect(n).toBe(1);
  });
});
