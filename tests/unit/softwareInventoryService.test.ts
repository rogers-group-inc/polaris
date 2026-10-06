/**
 * tests/unit/softwareInventoryService.test.ts
 *
 * The installed-software writer and its two integration passes:
 *   - softwareKey / storedSoftwareRow: identity and normalization
 *   - persistAssetSoftware: a delta per (asset, source) — only changed rows are
 *     written, other sources' rows are never touched, the scrape is stamped
 *   - planIntuneSoftwareFetch: which Intune devices need a read
 *   - syncIntuneSoftware / syncArcSoftware: a failed read keeps the stored list,
 *     the toggle off empties it, Arc clears machines with no snapshot only when
 *     every workspace answered
 *
 * Prisma is an in-memory table; the Graph and Log Analytics readers are mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { table, scrapes, sources, fetchApps, fetchArc } = vi.hoisted(() => ({
  table: new Map<string, Record<string, unknown>>(),
  scrapes: new Map<string, { scrapedAt: Date; stamp: string | null }>(),
  sources: [] as Array<{ assetId: string; externalId: string; sourceKind: string; integrationId: string }>,
  fetchApps: vi.fn(),
  fetchArc: vi.fn(),
}));

vi.mock("../../src/db.js", () => {
  const matches = (r: Record<string, unknown>, where: any): boolean => {
    if (where.assetId !== undefined) {
      if (typeof where.assetId === "string" ? r.assetId !== where.assetId : !where.assetId.in.includes(r.assetId)) return false;
    }
    if (where.source !== undefined && r.source !== where.source) return false;
    if (where.id?.in && !where.id.in.includes(r.id)) return false;
    return true;
  };
  const assetSoftware = {
    findMany: vi.fn(async (a: any) => [...table.values()].filter((r) => matches(r, a.where)).map((r) => ({ ...r }))),
    deleteMany: vi.fn(async (a: any) => {
      let count = 0;
      for (const [id, r] of table) if (matches(r, a.where)) { table.delete(id); count++; }
      return { count };
    }),
    createMany: vi.fn(async (a: any) => {
      for (const r of a.data) table.set(r.id, { ...r });
      return { count: a.data.length };
    }),
    updateMany: vi.fn(async (a: any) => {
      const r = table.get(a.where.id);
      if (r) Object.assign(r, a.data);
      return { count: r ? 1 : 0 };
    }),
  };
  const assetInventoryScrape = {
    upsert: vi.fn(async (a: any) => {
      const k = `${a.where.assetId_kind.assetId}|${a.where.assetId_kind.kind}`;
      scrapes.set(k, { scrapedAt: a.update.scrapedAt, stamp: a.update.stamp ?? null });
    }),
    findMany: vi.fn(async (a: any) => {
      const out: any[] = [];
      for (const [k, v] of scrapes) {
        const [assetId, kind] = k.split("|");
        const kindOk = typeof a.where.kind === "string" ? kind === a.where.kind : a.where.kind.in.includes(kind);
        const assetOk = typeof a.where.assetId === "string" ? assetId === a.where.assetId : a.where.assetId.in.includes(assetId);
        if (kindOk && assetOk) out.push({ assetId, kind, ...v });
      }
      return out;
    }),
    deleteMany: vi.fn(async (a: any) => {
      let count = 0;
      for (const k of [...scrapes.keys()]) {
        const [assetId, kind] = k.split("|");
        if (kind === a.where.kind && a.where.assetId.in.includes(assetId)) { scrapes.delete(k); count++; }
      }
      return { count };
    }),
  };
  const assetSource = {
    findMany: vi.fn(async (a: any) => sources
      .filter((s) => s.sourceKind === a.where.sourceKind && s.integrationId === a.where.integrationId)
      .map((s) => ({ assetId: s.assetId, externalId: s.externalId }))),
  };
  const tx = { assetSoftware, assetInventoryScrape };
  return {
    prisma: {
      ...tx,
      assetSource,
      asset: { findUnique: vi.fn(async () => ({ id: "x" })) },
      $executeRaw: vi.fn(async () => 0),
      $transaction: vi.fn(async (arg: any) => (typeof arg === "function" ? arg(tx) : Promise.all(arg))),
    },
  };
});
vi.mock("../../src/utils/dbRetry.js", () => ({ retryOnDeadlock: (fn: () => Promise<unknown>) => fn() }));
vi.mock("../../src/services/entraIdService.js", () => ({ fetchIntuneDetectedApps: fetchApps }));
vi.mock("../../src/services/azureArcService.js", () => ({ fetchArcSoftware: fetchArc }));

import {
  persistAssetSoftware,
  planIntuneSoftwareFetch,
  softwareKey,
  storedSoftwareRow,
  syncArcSoftware,
  syncIntuneSoftware,
  AGENT_SOFTWARE_FRESH_MS,
  INTUNE_SOFTWARE_MAX_AGE_MS,
  type AssetSoftwareInput,
} from "../../src/services/softwareInventoryService.js";

const A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function sw(over: Partial<AssetSoftwareInput>): AssetSoftwareInput {
  return { name: "7-Zip", version: "24.08", publisher: "Igor Pavlov", architecture: "x64", platform: "windows", installDate: "2024-08-01", sizeBytes: 5_000_000n, ...over };
}
const rowsOf = (assetId: string, source: string) =>
  [...table.values()].filter((r) => r.assetId === assetId && r.source === source);
const noop = () => {};

beforeEach(() => {
  table.clear();
  scrapes.clear();
  sources.length = 0;
  fetchApps.mockReset();
  fetchArc.mockReset();
});

describe("softwareKey / storedSoftwareRow", () => {
  it("is case-insensitive over name, version and architecture", () => {
    expect(softwareKey({ name: "Git ", version: "2.46.0", architecture: "X64" }))
      .toBe(softwareKey({ name: "git", version: "2.46.0", architecture: "x64" }));
    expect(softwareKey({ name: "Git", version: "2.46.0", architecture: "x86" }))
      .not.toBe(softwareKey({ name: "Git", version: "2.46.0", architecture: "x64" }));
    expect(softwareKey({ name: "Git", version: null, architecture: null })).toBe(softwareKey({ name: "git", version: "", architecture: "" }));
  });

  it("keeps a real date, drops a malformed or impossible one, and drops a zero size", () => {
    expect(storedSoftwareRow(sw({ installDate: "2024-02-29" })).installDate?.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(storedSoftwareRow(sw({ installDate: "2023-02-29" })).installDate).toBeNull();
    expect(storedSoftwareRow(sw({ installDate: "20240101" })).installDate).toBeNull();
    expect(storedSoftwareRow(sw({ sizeBytes: 0n })).sizeBytes).toBeNull();
    expect(storedSoftwareRow(sw({ publisher: "   " })).publisher).toBeNull();
  });
});

describe("persistAssetSoftware", () => {
  it("creates on the first push, writes nothing on an identical one, and stamps each scrape", async () => {
    const first = await persistAssetSoftware(A, "agent", [sw({}), sw({ name: "Git", version: "2.46.0" })]);
    expect(first).toEqual({ created: 2, updated: 0, removed: 0, unchanged: 0 });
    const second = await persistAssetSoftware(A, "agent", [sw({}), sw({ name: "Git", version: "2.46.0" })]);
    expect(second).toEqual({ created: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(scrapes.get(`${A}|software`)).toBeDefined();
  });

  it("an upgrade is a new key: the old version is removed and the new one created", async () => {
    await persistAssetSoftware(A, "agent", [sw({})]);
    const r = await persistAssetSoftware(A, "agent", [sw({ version: "24.09" })]);
    expect(r).toMatchObject({ created: 1, removed: 1 });
    expect(rowsOf(A, "agent").map((x) => x.version)).toEqual(["24.09"]);
  });

  it("a changed non-key field is an update in place", async () => {
    await persistAssetSoftware(A, "agent", [sw({})]);
    const r = await persistAssetSoftware(A, "agent", [sw({ publisher: "7-Zip Project" })]);
    expect(r).toMatchObject({ updated: 1, created: 0, removed: 0 });
    expect(rowsOf(A, "agent")[0].publisher).toBe("7-Zip Project");
  });

  it("never touches another source's rows, and keeps the source's stamp", async () => {
    await persistAssetSoftware(A, "intune", [sw({ name: "Teams" })], { stamp: "2026-10-01T00:00:00Z" });
    await persistAssetSoftware(A, "agent", []);
    expect(rowsOf(A, "intune")).toHaveLength(1);
    expect(scrapes.get(`${A}|software:intune`)?.stamp).toBe("2026-10-01T00:00:00Z");
    expect(scrapes.get(`${A}|software`)?.stamp).toBeNull();
  });

  it("an empty list removes everything that source reported", async () => {
    await persistAssetSoftware(A, "agent", [sw({}), sw({ name: "Git" })]);
    const r = await persistAssetSoftware(A, "agent", []);
    expect(r.removed).toBe(2);
    expect(rowsOf(A, "agent")).toHaveLength(0);
  });
});

describe("planIntuneSoftwareFetch", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  const c = (assetId: string, lastSync: string | null) => ({ assetId, managedDeviceId: `m-${assetId}`, lastSync });

  it("reads a device it has never read", () => {
    const p = planIntuneSoftwareFetch([c(A, "s1")], new Map(), new Map(), now, false);
    expect(p.toFetch).toHaveLength(1);
  });

  it("skips a device that has not synced since its last read", () => {
    const p = planIntuneSoftwareFetch([c(A, "s1")], new Map([[A, { stamp: "s1", scrapedAt: now }]]), new Map(), now, false);
    expect(p).toMatchObject({ toFetch: [], skippedUnchanged: 1 });
  });

  it("re-reads after a new sync, after the max age, and when forced", () => {
    const known = new Map([[A, { stamp: "s1", scrapedAt: now }]]);
    expect(planIntuneSoftwareFetch([c(A, "s2")], known, new Map(), now, false).toFetch).toHaveLength(1);
    const old = new Map([[A, { stamp: "s1", scrapedAt: new Date(now.getTime() - INTUNE_SOFTWARE_MAX_AGE_MS - 1) }]]);
    expect(planIntuneSoftwareFetch([c(A, "s1")], old, new Map(), now, false).toFetch).toHaveLength(1);
    expect(planIntuneSoftwareFetch([c(A, "s1")], known, new Map(), now, true).toFetch).toHaveLength(1);
  });

  it("skips an asset a Polaris agent reported recently, even when forced", () => {
    const agent = new Map([[A, new Date(now.getTime() - 3600_000)]]);
    expect(planIntuneSoftwareFetch([c(A, "s1")], new Map(), agent, now, true)).toMatchObject({ toFetch: [], skippedAgent: 1 });
    const stale = new Map([[A, new Date(now.getTime() - AGENT_SOFTWARE_FRESH_MS - 1)]]);
    expect(planIntuneSoftwareFetch([c(A, "s1")], new Map(), stale, now, false).toFetch).toHaveLength(1);
  });
});

describe("syncIntuneSoftware", () => {
  const INT = "int-entra";
  const MA = "11111111-1111-1111-1111-111111111111";
  const MB = "22222222-2222-2222-2222-222222222222";
  const device = (deviceId: string, managed: string) =>
    ({ deviceId, intuneManagedDeviceId: managed, lastSyncDateTime: "2026-10-05T10:00:00Z" }) as any;

  beforeEach(() => {
    sources.push(
      { assetId: A, externalId: "dev-a", sourceKind: "intune", integrationId: INT },
      { assetId: B, externalId: "dev-b", sourceKind: "intune", integrationId: INT },
    );
  });

  it("writes the devices that answered and leaves a failed device's list alone", async () => {
    await persistAssetSoftware(B, "intune", [sw({ name: "Old" })], { stamp: "older" });
    fetchApps.mockResolvedValue({
      apps: new Map([[MA, [{ displayName: "Teams", version: "1.0", publisher: "Microsoft", sizeInByte: 1000, platform: "windows" }]]]),
      failedBatches: 1, batchCount: 1, lastError: "boom",
    });
    await syncIntuneSoftware(INT, { enableIntune: true, pullSoftware: true } as any, [device("dev-a", MA), device("dev-b", MB)],
      { intuneRead: "ok", scoped: false, log: noop });
    expect(rowsOf(A, "intune").map((r) => r.name)).toEqual(["Teams"]);
    expect(scrapes.get(`${A}|software:intune`)?.stamp).toBe("2026-10-05T10:00:00Z");
    expect(rowsOf(B, "intune").map((r) => r.name)).toEqual(["Old"]);
    expect(scrapes.get(`${B}|software:intune`)?.stamp).toBe("older");
  });

  it("does not read when the Intune device read itself failed", async () => {
    await syncIntuneSoftware(INT, { enableIntune: true, pullSoftware: true } as any, [device("dev-a", MA)],
      { intuneRead: "failed", scoped: false, log: noop });
    expect(fetchApps).not.toHaveBeenCalled();
  });

  it("with the toggle off, removes the Intune lists and reads nothing", async () => {
    await persistAssetSoftware(A, "intune", [sw({ name: "Teams" })]);
    await persistAssetSoftware(A, "agent", [sw({})]);
    await syncIntuneSoftware(INT, { enableIntune: true, pullSoftware: false } as any, [device("dev-a", MA)],
      { intuneRead: "ok", scoped: false, log: noop });
    expect(fetchApps).not.toHaveBeenCalled();
    expect(rowsOf(A, "intune")).toHaveLength(0);
    expect(rowsOf(A, "agent")).toHaveLength(1);
  });

  it("never throws — a reader failure is a log line", async () => {
    fetchApps.mockRejectedValue(new Error("graph down"));
    const log = vi.fn();
    await expect(syncIntuneSoftware(INT, { enableIntune: true, pullSoftware: true } as any, [device("dev-a", MA)],
      { intuneRead: "ok", scoped: false, log })).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("discover.intune.software", "error", expect.stringContaining("graph down"));
  });
});

describe("syncArcSoftware", () => {
  const INT = "int-arc";
  const RA = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers/microsoft.hybridcompute/machines/a";
  const RB = "/subscriptions/00000000-0000-0000-0000-000000000000/resourcegroups/rg/providers/microsoft.hybridcompute/machines/b";
  const cfg = { pullSoftware: true, logAnalyticsWorkspaceIds: ["33333333-3333-3333-3333-333333333333"] } as any;

  beforeEach(() => {
    sources.push(
      { assetId: A, externalId: RA, sourceKind: "arc", integrationId: INT },
      { assetId: B, externalId: RB, sourceKind: "arc", integrationId: INT },
    );
  });

  it("writes reported machines and clears machines with no snapshot when every workspace answered", async () => {
    await persistAssetSoftware(B, "arc", [sw({ name: "Gone" })]);
    fetchArc.mockResolvedValue({
      byResourceId: new Map([[RA, [{ name: "nginx", version: "1.26", publisher: null, architecture: "x86_64", softwareType: "Package" }]]]),
      failedWorkspaces: 0, workspaceCount: 1,
    });
    await syncArcSoftware(INT, cfg, { scoped: false, log: noop });
    expect(rowsOf(A, "arc").map((r) => r.name)).toEqual(["nginx"]);
    expect(rowsOf(B, "arc")).toHaveLength(0);
  });

  it("keeps an absent machine's list when a workspace failed", async () => {
    await persistAssetSoftware(B, "arc", [sw({ name: "Kept" })]);
    fetchArc.mockResolvedValue({ byResourceId: new Map(), failedWorkspaces: 1, workspaceCount: 1 });
    await syncArcSoftware(INT, cfg, { scoped: false, log: noop });
    expect(rowsOf(B, "arc").map((r) => r.name)).toEqual(["Kept"]);
  });

  it("skips a scoped run, and empties the lists when switched off", async () => {
    await persistAssetSoftware(A, "arc", [sw({ name: "x" })]);
    await syncArcSoftware(INT, cfg, { scoped: true, log: noop });
    expect(fetchArc).not.toHaveBeenCalled();
    expect(rowsOf(A, "arc")).toHaveLength(1);
    await syncArcSoftware(INT, { ...cfg, pullSoftware: false }, { scoped: false, log: noop });
    expect(rowsOf(A, "arc")).toHaveLength(0);
  });
});
