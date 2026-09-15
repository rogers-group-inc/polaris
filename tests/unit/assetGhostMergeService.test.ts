/**
 * tests/unit/assetGhostMergeService.test.ts
 *
 * Coverage for the endpoint-ghost merge service:
 *   - eligibility: fortigate-endpoint provenance required; any authoritative
 *     source (fortiswitch / ad / entra / agent / ...) disqualifies; the empty
 *     "manual" row an operator edit stamps does NOT disqualify
 *   - merge: side-table rows re-point to the canonical, colliding rows are
 *     deleted (canonical wins), ghost sources are dropped, the ghost row is
 *     deleted
 *   - MAC adoption only when the canonical has none
 *   - monitored=true carries over only when the ghost was monitored and the
 *     canonical wasn't, followed by a monitorOverride recompute
 *
 * Prisma is mocked so the merge choreography is exercised without a live DB.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => {
  const tx = {
    asset: { findUniqueOrThrow: vi.fn(), update: vi.fn(), delete: vi.fn() },
    assetMacAddress: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    assetAssociatedIp: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    assetIpHistory: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    assetFortigateSighting: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    assetSource: { deleteMany: vi.fn() },
  };
  return {
    prisma: {
      _tx: tx,
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
      $executeRaw: vi.fn(async () => 0),
      assetSource: { findMany: vi.fn() },
    },
  };
});

import {
  isMergeableGhostSourceKinds,
  isMergeableEndpointGhost,
  mergeEndpointGhostIntoAsset,
  mergeDuplicateHostnameGhost,
  type DuplicateHostnameAssetRow,
} from "../../src/services/assetGhostMergeService.js";
import { prisma } from "../../src/db.js";

type Mock = ReturnType<typeof vi.fn>;
const tx = (prisma as unknown as { _tx: Record<string, Record<string, Mock>> })._tx;
const sourceFindMany = prisma.assetSource.findMany as unknown as Mock;
const executeRaw = (prisma as unknown as { $executeRaw: Mock }).$executeRaw;

const CANON = "canonical-id";
const GHOST = "ghost-id";

/** Seed the tx mocks for one merge run. */
function seedMerge(opts: {
  canonical?: { macAddress?: string | null; monitored?: boolean };
  ghost?: { macAddress?: string | null; monitored?: boolean };
  canonMacs?: string[];
  ghostMacs?: Array<{ id: string; mac: string }>;
  canonIps?: string[];
  ghostIps?: Array<{ id: string; ip: string }>;
} = {}) {
  const canonical = { macAddress: null, monitored: false, ...(opts.canonical ?? {}) };
  const ghost = { macAddress: null, monitored: false, ...(opts.ghost ?? {}) };
  tx.asset.findUniqueOrThrow
    .mockResolvedValueOnce(canonical)
    .mockResolvedValueOnce(ghost);
  // Each side table is read twice: canonical rows, then ghost rows.
  tx.assetMacAddress.findMany
    .mockResolvedValueOnce((opts.canonMacs ?? []).map((mac) => ({ mac })))
    .mockResolvedValueOnce(opts.ghostMacs ?? []);
  tx.assetAssociatedIp.findMany
    .mockResolvedValueOnce((opts.canonIps ?? []).map((ip) => ({ ip })))
    .mockResolvedValueOnce(opts.ghostIps ?? []);
  tx.assetIpHistory.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  tx.assetFortigateSighting.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isMergeableGhostSourceKinds", () => {
  it("accepts a pure fortigate-endpoint placeholder", () => {
    expect(isMergeableGhostSourceKinds(["fortigate-endpoint"])).toBe(true);
  });

  it("accepts fortigate-endpoint plus the manual row an operator edit stamps", () => {
    expect(isMergeableGhostSourceKinds(["fortigate-endpoint", "manual"])).toBe(true);
  });

  it("rejects an asset without fortigate-endpoint provenance", () => {
    expect(isMergeableGhostSourceKinds([])).toBe(false);
    expect(isMergeableGhostSourceKinds(["manual"])).toBe(false);
  });

  it.each([
    "fortiswitch",
    "fortiap",
    "fortigate-firewall",
    "ad",
    "entra",
    "intune",
    "polaris-agent",
  ])("rejects when any authoritative source is present (%s)", (kind) => {
    expect(isMergeableGhostSourceKinds(["fortigate-endpoint", kind])).toBe(false);
  });
});

describe("isMergeableEndpointGhost", () => {
  it("reads the asset's source kinds and applies the pure check", async () => {
    sourceFindMany.mockResolvedValueOnce([
      { sourceKind: "fortigate-endpoint" },
      { sourceKind: "manual" },
    ]);
    await expect(isMergeableEndpointGhost(GHOST)).resolves.toBe(true);
    expect(sourceFindMany).toHaveBeenCalledWith({
      where: { assetId: GHOST },
      select: { sourceKind: true },
    });

    sourceFindMany.mockResolvedValueOnce([{ sourceKind: "fortiswitch" }]);
    await expect(isMergeableEndpointGhost(GHOST)).resolves.toBe(false);
  });
});

describe("mergeEndpointGhostIntoAsset", () => {
  it("re-points non-colliding side rows and deletes colliding ones", async () => {
    seedMerge({
      canonMacs: ["AA:AA:AA:AA:AA:AA"],
      ghostMacs: [
        { id: "m1", mac: "AA:AA:AA:AA:AA:AA" }, // collides — delete
        { id: "m2", mac: "BB:BB:BB:BB:BB:BB" }, // re-point
      ],
      canonIps: ["10.0.0.1"],
      ghostIps: [
        { id: "i1", ip: "10.0.0.1" }, // collides — delete
        { id: "i2", ip: "10.0.0.2" }, // re-point
      ],
    });

    await mergeEndpointGhostIntoAsset(CANON, GHOST);

    expect(tx.assetMacAddress.delete).toHaveBeenCalledWith({ where: { id: "m1" } });
    expect(tx.assetMacAddress.update).toHaveBeenCalledWith({
      where: { id: "m2" },
      data: { assetId: CANON },
    });
    expect(tx.assetAssociatedIp.delete).toHaveBeenCalledWith({ where: { id: "i1" } });
    expect(tx.assetAssociatedIp.update).toHaveBeenCalledWith({
      where: { id: "i2" },
      data: { assetId: CANON },
    });
    expect(tx.assetSource.deleteMany).toHaveBeenCalledWith({ where: { assetId: GHOST } });
    expect(tx.asset.delete).toHaveBeenCalledWith({ where: { id: GHOST } });
  });

  it("adopts the ghost's MAC only when the canonical has none", async () => {
    seedMerge({
      canonical: { macAddress: null },
      ghost: { macAddress: "48:3A:02:00:00:01" },
    });
    const res = await mergeEndpointGhostIntoAsset(CANON, GHOST);
    expect(res.adoptedMac).toBe("48:3A:02:00:00:01");
    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: CANON },
      data: { macAddress: "48:3A:02:00:00:01" },
    });
  });

  it("keeps the canonical's MAC when it already has one", async () => {
    seedMerge({
      canonical: { macAddress: "AA:AA:AA:AA:AA:AA" },
      ghost: { macAddress: "48:3A:02:00:00:01" },
    });
    const res = await mergeEndpointGhostIntoAsset(CANON, GHOST);
    expect(res.adoptedMac).toBeNull();
    expect(tx.asset.update).not.toHaveBeenCalled();
  });

  it("carries monitored=true over and recomputes the override", async () => {
    seedMerge({
      canonical: { monitored: false },
      ghost: { monitored: true },
    });
    const res = await mergeEndpointGhostIntoAsset(CANON, GHOST);
    expect(res.transferredMonitored).toBe(true);
    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: CANON },
      data: { monitored: true },
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it("does not touch monitored (or recompute) when the ghost was unmonitored", async () => {
    seedMerge({
      canonical: { monitored: false },
      ghost: { monitored: false },
    });
    const res = await mergeEndpointGhostIntoAsset(CANON, GHOST);
    expect(res.transferredMonitored).toBe(false);
    expect(tx.asset.update).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });
});

// ── the duplicate-hostname ghost merge's scalar absorption ──
// Null-fill mirrors acceptAssetConflict; the case worth its own coverage is
// assetType, where the `other` catch-all counts as empty.

function dupRow(id: string, over: Partial<DuplicateHostnameAssetRow> = {}): DuplicateHostnameAssetRow {
  return {
    id,
    hostname: "ws-1234",
    ipAddress: null,
    macAddress: null,
    serialNumber: null,
    manufacturer: null,
    model: null,
    assetType: "other",
    os: null,
    osVersion: null,
    assignedTo: null,
    notes: null,
    learnedLocation: null,
    acquiredAt: null,
    lastSeen: null,
    lastSeenSource: null,
    monitored: false,
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    tags: [],
    sources: [],
    ...over,
  };
}

/** Side tables are read twice each (canonical rows, then ghost rows) — all empty here. */
function seedEmptySideTables() {
  for (const t of [tx.assetMacAddress, tx.assetAssociatedIp, tx.assetIpHistory, tx.assetFortigateSighting]) {
    t.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  }
}

describe("mergeDuplicateHostnameGhost — assetType", () => {
  it("adopts the ghost's specific type when the canonical is still 'other'", async () => {
    seedEmptySideTables();
    await mergeDuplicateHostnameGhost(dupRow(CANON, { assetType: "other" }), dupRow(GHOST, { assetType: "server" }));
    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: CANON },
      data: { assetType: "server" },
    });
    expect(tx.asset.delete).toHaveBeenCalledWith({ where: { id: GHOST } });
  });

  it("keeps the canonical's specific type over a ghost filed as 'other'", async () => {
    seedEmptySideTables();
    await mergeDuplicateHostnameGhost(dupRow(CANON, { assetType: "switch" }), dupRow(GHOST, { assetType: "other" }));
    expect(tx.asset.update).not.toHaveBeenCalled();
  });

  it("does not replace one specific type with another — the canonical was chosen by source tier", async () => {
    seedEmptySideTables();
    await mergeDuplicateHostnameGhost(dupRow(CANON, { assetType: "server" }), dupRow(GHOST, { assetType: "hypervisor" }));
    expect(tx.asset.update).not.toHaveBeenCalled();
  });
});
