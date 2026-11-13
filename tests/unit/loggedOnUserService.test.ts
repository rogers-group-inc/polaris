/**
 * tests/unit/loggedOnUserService.test.ts — the Intune half of the last
 * logged-on user (business rule 180): which devices are re-read, how logons
 * become sightings, and the pass end to end against a stubbed database and
 * Graph — merged into associatedUsers with Intune's logon time, stamped so an
 * unchanged device is skipped next run, assignedTo never touched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  fetchLogons: vi.fn(),
  resolveUpns: vi.fn(),
  assets: new Map<string, { id: string; associatedUsers: unknown }>(),
  scrapes: new Map<string, { stamp: string | null; scrapedAt: Date }>(),
  sources: [] as Array<{ assetId: string; externalId: string; sourceKind: string; integrationId: string }>,
  updates: [] as Array<{ id: string; data: Record<string, unknown> }>,
}));

vi.mock("../../src/services/entraIdService.js", () => ({
  fetchIntuneLoggedOnUsers: m.fetchLogons,
  resolveUserPrincipalNames: m.resolveUpns,
}));
vi.mock("../../src/db.js", () => {
  const prisma = {
    assetSource: {
      findMany: vi.fn(async (a: any) => m.sources
        .filter((s) => s.sourceKind === a.where.sourceKind && s.integrationId === a.where.integrationId)
        .map((s) => ({ assetId: s.assetId, externalId: s.externalId }))),
    },
    assetInventoryScrape: {
      findMany: vi.fn(async (a: any) => [...m.scrapes]
        .filter(([k]) => k.endsWith(`|${a.where.kind}`) && a.where.assetId.in.includes(k.split("|")[0]))
        .map(([k, v]) => ({ assetId: k.split("|")[0], ...v }))),
      upsert: vi.fn(async (a: any) => {
        const { assetId, kind } = a.where.assetId_kind;
        m.scrapes.set(`${assetId}|${kind}`, { stamp: a.update.stamp, scrapedAt: a.update.scrapedAt });
      }),
    },
    asset: {
      findMany: vi.fn(async (a: any) => a.where.id.in.map((id: string) => m.assets.get(id)).filter(Boolean)),
      update: vi.fn(async (a: any) => {
        m.updates.push({ id: a.where.id, data: a.data });
        const prev = m.assets.get(a.where.id)!;
        m.assets.set(a.where.id, { ...prev, ...a.data });
      }),
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma };
});

const {
  planIntuneLogonFetch,
  intuneLogonSightings,
  syncIntuneLoggedOnUsers,
  INTUNE_LOGONS_SCRAPE_KIND,
  INTUNE_LOGONS_MAX_AGE_MS,
} = await import("../../src/services/loggedOnUserService.js");

const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";
const DEV = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const MD = "mmmmmmmm-0000-0000-0000-000000000000";

beforeEach(() => {
  vi.clearAllMocks();
  m.assets.clear();
  m.scrapes.clear();
  m.sources.length = 0;
  m.updates.length = 0;
});

describe("planIntuneLogonFetch", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  const c = (lastSync: string | null) => ({ assetId: "a1", managedDeviceId: MD, lastSync });

  it("reads a device it never read, and skips one that has not synced since", () => {
    expect(planIntuneLogonFetch([c("s1")], new Map(), now, false).toFetch).toHaveLength(1);
    expect(planIntuneLogonFetch([c("s1")], new Map([["a1", { stamp: "s1", scrapedAt: now }]]), now, false))
      .toMatchObject({ toFetch: [], skippedUnchanged: 1 });
  });

  it("re-reads after a new sync, after the max age, with no lastSync, and when forced", () => {
    const known = new Map([["a1", { stamp: "s1", scrapedAt: now }]]);
    expect(planIntuneLogonFetch([c("s2")], known, now, false).toFetch).toHaveLength(1);
    expect(planIntuneLogonFetch([c(null)], known, now, false).toFetch).toHaveLength(1);
    expect(planIntuneLogonFetch([c("s1")], known, now, true).toFetch).toHaveLength(1);
    const old = new Map([["a1", { stamp: "s1", scrapedAt: new Date(now.getTime() - INTUNE_LOGONS_MAX_AGE_MS - 1) }]]);
    expect(planIntuneLogonFetch([c("s1")], old, now, false).toFetch).toHaveLength(1);
  });
});

describe("intuneLogonSightings", () => {
  it("names each logon by UPN at Intune's logon time, and leaves out an account with no name", () => {
    expect(intuneLogonSightings(
      [{ userId: U1, lastLogOnDateTime: "2026-11-10T07:30:00Z" }, { userId: U2, lastLogOnDateTime: "2026-11-11T07:30:00Z" }],
      new Map([[U1, "jdoe@corp.example"]]),
    )).toEqual([{ account: "jdoe@corp.example", seenAt: new Date("2026-11-10T07:30:00Z"), source: "intune" }]);
  });
});

describe("syncIntuneLoggedOnUsers", () => {
  const device = { deviceId: DEV, intuneManagedDeviceId: MD, lastSyncDateTime: "s1", intuneUserId: U1, userPrincipalName: "jdoe@corp.example" } as any;
  const cfg = { tenantId: "t", clientId: "c", clientSecret: "s", enableIntune: true } as any;
  const opts = (over: Record<string, unknown> = {}) => ({ intuneRead: "ok" as const, scoped: false, log: vi.fn(), ...over });

  function seed(associatedUsers: unknown = []) {
    m.sources.push({ assetId: "a1", externalId: DEV, sourceKind: "intune", integrationId: "i1" });
    m.assets.set("a1", { id: "a1", associatedUsers });
    m.fetchLogons.mockResolvedValue({
      logons: new Map([[MD, [{ userId: U1, lastLogOnDateTime: "2026-11-10T07:30:00Z" }, { userId: U2, lastLogOnDateTime: "2026-11-12T09:00:00Z" }]]]),
      failedBatches: 0, batchCount: 1, lastError: "",
    });
    m.resolveUpns.mockImplementation(async (_c: unknown, _ids: unknown, known: Map<string, string>) => ({
      upns: new Map([...known, [U2, "asmith@corp.example"]]), unresolved: 0, lastError: "",
    }));
  }

  it("merges each logon into associatedUsers with Intune's time, newest first, and stamps the read", async () => {
    seed([{ user: "jdoe@corp.example", lastSeen: "2026-11-01T00:00:00.000Z", source: "device-inventory" }]);
    await syncIntuneLoggedOnUsers("i1", cfg, [device], opts());
    expect(m.resolveUpns).toHaveBeenCalledWith(cfg, expect.any(Set), new Map([[U1, "jdoe@corp.example"]]), undefined);
    expect(m.updates).toHaveLength(1);
    expect(m.updates[0].data).toEqual({ associatedUsers: [
      { user: "asmith@corp.example", lastSeen: "2026-11-12T09:00:00.000Z", source: "intune" },
      { user: "jdoe@corp.example", lastSeen: "2026-11-10T07:30:00.000Z", source: "intune" },
    ] });
    expect(m.updates[0].data).not.toHaveProperty("assignedTo");
    expect(m.scrapes.get(`a1|${INTUNE_LOGONS_SCRAPE_KIND}`)?.stamp).toBe("s1");
  });

  it("a device that has not synced since its last read is not read again", async () => {
    seed();
    m.scrapes.set(`a1|${INTUNE_LOGONS_SCRAPE_KIND}`, { stamp: "s1", scrapedAt: new Date() });
    await syncIntuneLoggedOnUsers("i1", cfg, [device], opts());
    expect(m.fetchLogons).not.toHaveBeenCalled();
  });

  it("writes no asset when nothing is newer, but still stamps", async () => {
    seed([
      { user: "asmith@corp.example", lastSeen: "2026-11-12T09:00:00.000Z", source: "intune" },
      { user: "jdoe@corp.example", lastSeen: "2026-11-10T07:30:00.000Z", source: "intune" },
    ]);
    await syncIntuneLoggedOnUsers("i1", cfg, [device], opts());
    expect(m.updates).toHaveLength(0);
    expect(m.scrapes.has(`a1|${INTUNE_LOGONS_SCRAPE_KIND}`)).toBe(true);
  });

  it("does nothing when Intune is off or its read failed, and never throws", async () => {
    seed();
    await syncIntuneLoggedOnUsers("i1", { ...cfg, enableIntune: false }, [device], opts());
    await syncIntuneLoggedOnUsers("i1", cfg, [device], opts({ intuneRead: "failed" }));
    expect(m.fetchLogons).not.toHaveBeenCalled();
    m.fetchLogons.mockRejectedValue(new Error("boom"));
    const log = vi.fn();
    await expect(syncIntuneLoggedOnUsers("i1", cfg, [device], opts({ log }))).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith("discover.intune.logons", "error", expect.stringContaining("boom"));
  });

  it("reports the accounts it could not name", async () => {
    seed();
    m.resolveUpns.mockResolvedValue({ upns: new Map([[U1, "jdoe@corp.example"]]), unresolved: 1, lastError: "403" });
    const log = vi.fn();
    await syncIntuneLoggedOnUsers("i1", cfg, [device], opts({ log }));
    expect(log).toHaveBeenCalledWith("discover.intune.logons", "info", expect.stringContaining("User.Read.All"));
    expect((m.updates[0].data.associatedUsers as any[]).map((u) => u.user)).toEqual(["jdoe@corp.example"]);
  });
});
