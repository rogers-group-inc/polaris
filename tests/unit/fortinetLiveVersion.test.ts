/**
 * tests/unit/fortinetLiveVersion.test.ts
 *
 * The live firmware reading for FortiGates / FortiSwitches / FortiAPs
 * (services/fortinetLiveVersionService.ts). Pinned here:
 *
 *   - a reading that agrees with the asset — including the same version in a
 *     different format — costs no DB call at all;
 *   - a real change lands through an enrichment AssetSource row and the
 *     projection (never a direct osVersion write that skips it), and audits
 *     one asset.firmware.changed Event;
 *   - a projection that keeps choosing another source's value is not
 *     re-recorded every pass;
 *   - the FortiGate envelope version is shaped to match what each
 *     integration's discovery stores.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  sources: new Map<string, Array<Record<string, unknown>>>(),
  upserts: [] as Array<Record<string, unknown>>,
  assetUpdates: [] as Array<{ id: string; data: Record<string, unknown> }>,
  events: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetSource: {
      upsert: vi.fn(async (args: any) => {
        h.upserts.push(args);
        const assetId = args.create.assetId as string;
        const rows = (h.sources.get(assetId) ?? []).filter((r) => r.sourceKind !== "fortinet-live");
        rows.push({ sourceKind: "fortinet-live", inferred: false, observed: args.create.observed, lastSeen: new Date() });
        h.sources.set(assetId, rows);
        return {};
      }),
      findMany: vi.fn(async ({ where }: any) => h.sources.get(where.assetId) ?? []),
    },
    asset: {
      update: vi.fn(async ({ where, data }: any) => {
        h.assetUpdates.push({ id: where.id, data });
        return {};
      }),
    },
  },
}));

vi.mock("../../src/services/eventLogService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/eventLogService.js")>();
  return {
    ...actual,
    logEvent: vi.fn(async (input: any) => { h.events.push(input); }),
  };
});

const {
  reconcileFortinetLiveVersions,
  liveVersionDiffers,
  fortigateLiveVersionFor,
  resetFortinetLiveVersionCache,
} = await import("../../src/services/fortinetLiveVersionService.js");

function discovered(assetId: string, kind: string, osVersion: string) {
  h.sources.set(assetId, [{ sourceKind: kind, inferred: false, observed: { kind, osVersion }, lastSeen: new Date(Date.now() - 3_600_000) }]);
}

beforeEach(() => {
  h.sources.clear();
  h.upserts.length = 0;
  h.assetUpdates.length = 0;
  h.events.length = 0;
  resetFortinetLiveVersionCache();
});

describe("liveVersionDiffers", () => {
  it("treats the same version in another format as the same", () => {
    expect(liveVersionDiffers("7.4.5", "v7.4.5")).toBe(false);
    expect(liveVersionDiffers("S108EP-v7.2.5-build0453", "S108EP-v7.2.5-build0453")).toBe(false);
  });

  it("sees a real move in any component", () => {
    expect(liveVersionDiffers("7.4.3", "v7.4.5")).toBe(true);
    expect(liveVersionDiffers("FP231K-v7.6.0-build0100", "FP231K-v7.6.0-build0120")).toBe(true);
  });

  it("never acts on an unreadable live string, and fills an unreadable current one", () => {
    expect(liveVersionDiffers("7.4.3", "FortiAP")).toBe(false);
    expect(liveVersionDiffers(null, "")).toBe(false);
    expect(liveVersionDiffers(null, "v7.4.5")).toBe(true);
    expect(liveVersionDiffers("FortiSwitch", "S108EP-v7.2.5-build0453")).toBe(true);
  });
});

describe("fortigateLiveVersionFor", () => {
  it("drops the v for FortiManager (dvmdb-built 7.4.5) and keeps it for a standalone FortiGate", () => {
    expect(fortigateLiveVersionFor("fortimanager", "v7.4.5")).toBe("7.4.5");
    expect(fortigateLiveVersionFor("fortigate", "v7.4.5")).toBe("v7.4.5");
    expect(fortigateLiveVersionFor("fortigate", "  ")).toBeNull();
  });
});

describe("reconcileFortinetLiveVersions", () => {
  it("costs no DB call when every device agrees with its record", async () => {
    const n = await reconcileFortinetLiveVersions([
      { assetId: "a1", hostname: "sw1", currentOsVersion: "S108EP-v7.2.5-build0453", liveVersion: "S108EP-v7.2.5-build0453", reader: "fortilink-sweep" },
      { assetId: "a2", hostname: "fg1", currentOsVersion: "7.4.5", liveVersion: "v7.4.5", reader: "fortios-probe" },
      { assetId: "a3", hostname: "ap1", currentOsVersion: "7.4.5", liveVersion: undefined, reader: "fortilink-sweep" },
    ]);
    expect(n).toBe(0);
    expect(h.upserts).toHaveLength(0);
    expect(h.assetUpdates).toHaveLength(0);
  });

  it("records an upgrade through an enrichment source row, projects it and audits it once", async () => {
    discovered("a1", "fortiswitch", "S108EP-v7.2.5-build0453");
    const n = await reconcileFortinetLiveVersions([
      { assetId: "a1", hostname: "sw1", currentOsVersion: "S108EP-v7.2.5-build0453", liveVersion: "S108EP-v7.4.3-build0800", reader: "fortilink-sweep" },
    ]);
    expect(n).toBe(1);
    expect(h.upserts[0]).toMatchObject({
      where: { sourceKind_externalId: { sourceKind: "fortinet-live", externalId: "a1" } },
      create: { sourceKind: "fortinet-live", observed: { osVersion: "S108EP-v7.4.3-build0800" } },
    });
    // Live outranks the discovery copy for osVersion, and only osVersion moves.
    expect(h.assetUpdates).toEqual([{ id: "a1", data: { osVersion: "S108EP-v7.4.3-build0800" } }]);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ action: "asset.firmware.changed", resourceId: "a1", actor: "system:monitor" });
    expect(String(h.events[0].message)).toContain("S108EP-v7.2.5-build0453 → S108EP-v7.4.3-build0800");
  });

  it("does not re-record the same reading when the projection keeps another value", async () => {
    // A higher-priority source (here: a Polaris Agent row) owns osVersion, so
    // our row never wins and the asset never converges to the live string.
    h.sources.set("a1", [{ sourceKind: "polaris-agent", inferred: false, observed: { osVersion: "7.2.0" }, lastSeen: new Date() }]);
    const reading = { assetId: "a1", hostname: "fg1", currentOsVersion: "7.2.0", liveVersion: "7.4.5", reader: "fortios-probe" as const };
    expect(await reconcileFortinetLiveVersions([reading])).toBe(0);
    expect(h.upserts).toHaveLength(1);
    expect(h.assetUpdates).toHaveLength(0);
    await reconcileFortinetLiveVersions([reading]);
    expect(h.upserts).toHaveLength(1);
  });

  it("isolates one device's failure from the rest of the batch", async () => {
    discovered("a2", "fortiap", "FP231K-v7.6.0-build0100");
    const { prisma } = await import("../../src/db.js");
    (prisma.assetSource.upsert as any).mockImplementationOnce(async () => { throw new Error("boom"); });
    const n = await reconcileFortinetLiveVersions([
      { assetId: "a1", hostname: "ap0", currentOsVersion: "FP231K-v7.6.0-build0100", liveVersion: "FP231K-v7.6.0-build0120", reader: "fortilink-sweep" },
      { assetId: "a2", hostname: "ap1", currentOsVersion: "FP231K-v7.6.0-build0100", liveVersion: "FP231K-v7.6.0-build0120", reader: "fortilink-sweep" },
    ]);
    expect(n).toBe(1);
    expect(h.assetUpdates.map((u) => u.id)).toEqual(["a2"]);
  });
});
