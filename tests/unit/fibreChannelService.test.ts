/**
 * tests/unit/fibreChannelService.test.ts
 *
 * Business rule 156 — the writer and reader (services/fibreChannelService.ts).
 * Pinned:
 *   - logins are stored with the asset their host name uniquely matches;
 *   - first-seen survives a re-read;
 *   - the first collection is silent, a login that leaves writes one
 *     asset.fc_logins_changed warning;
 *   - the host view groups a server's logins by switch and carries the
 *     switch port's counters and the other (storage) devices on its VSAN.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  ports: [] as any[],
  logins: [] as any[],
  assets: [] as any[],
  events: [] as any[],
}));

vi.mock("../../src/db.js", () => {
  const match = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "OR") return (v as any[]).some((w) => match(row, w));
      if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
      if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
      return row[k] === v;
    });
  const table = (key: "ports" | "logins") => ({
    findMany: vi.fn(async ({ where }: any) => h[key].filter((r) => match(r, where))
      .map((r) => key === "logins" && r.matchedAssetId
        ? { ...r, matchedAsset: h.assets.find((a) => a.id === r.matchedAssetId), asset: h.assets.find((a) => a.id === r.assetId) }
        : { ...r, asset: h.assets.find((a) => a.id === r.assetId) })),
    deleteMany: vi.fn(async ({ where }: any) => { h[key] = h[key].filter((r) => !match(r, where)); return {}; }),
    createMany: vi.fn(async ({ data }: any) => { h[key].push(...data); return {}; }),
  });
  return {
    prisma: {
      assetFcPort: table("ports"),
      assetFcLogin: table("logins"),
      asset: {
        findMany: vi.fn(async () => h.assets),
        findUnique: vi.fn(async ({ where }: any) => h.assets.find((a) => a.id === where.id) ?? null),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => { for (const op of ops) await op; }),
    },
  };
});

vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: any) => { h.events.push(e); }),
}));

const { persistFibreChannel, getFibreChannelForAsset } = await import("../../src/services/fibreChannelService.js");

const counters = (invalidTxWords: number) => ({
  linkFailures: 0, syncLosses: 0, sigLosses: 0, invalidTxWords, invalidCrcs: 0, linkResetIns: 0, linkResetOuts: 0,
});
const login = (ifIndex: number, ifName: string, portWwn: string, hostName: string | null, symbolicName: string | null = "Emulex X") => ({
  ifIndex, ifName, vsan: 101, portWwn, nodeWwn: null, fcid: null, symbolicName, hostName,
  hbaModel: symbolicName ? "Emulex SN1200E2P" : null, hbaFirmware: null, hbaDriver: null, osInfo: null,
});
const INV = {
  ports: [
    { ifIndex: 1, ifName: "fc1/1", errorCounters: counters(5) },
    { ifIndex: 8, ifName: "fc1/8", errorCounters: counters(0) },
  ],
  logins: [
    login(1, "fc1/1", "10:00:00:00:00:00:00:01", "lnx01.example.com"),
    login(8, "fc1/8", "52:4a:93:00:00:00:30:09", "PURE01-ct0", null),
  ],
};

beforeEach(() => {
  h.ports = []; h.logins = []; h.events = [];
  h.assets = [
    { id: "sw", hostname: "mds-a", dnsName: null, model: "DS-C9148S-K9" },
    { id: "host", hostname: "lnx01", dnsName: "lnx01.example.com", model: null },
  ];
});

describe("persistFibreChannel", () => {
  it("stores ports and logins, matching the host by its registered name, silently the first time", async () => {
    await persistFibreChannel("sw", INV, new Date("2026-11-11T10:00:00Z"));
    expect(h.ports).toHaveLength(2);
    const byPort = Object.fromEntries(h.logins.map((l) => [l.ifName, l]));
    expect(byPort["fc1/1"]).toMatchObject({ matchedAssetId: "host", matchMethod: "name" });
    expect(byPort["fc1/8"]).toMatchObject({ matchedAssetId: null, matchMethod: null });
    expect(h.events).toHaveLength(0);
  });

  it("keeps first-seen and reports a login that left", async () => {
    await persistFibreChannel("sw", INV, new Date("2026-11-11T10:00:00Z"));
    await persistFibreChannel("sw", { ports: INV.ports, logins: [INV.logins[1]] }, new Date("2026-11-11T10:10:00Z"));
    expect(h.logins).toHaveLength(1);
    expect(h.logins[0].firstSeen).toEqual(new Date("2026-11-11T10:00:00Z"));
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ action: "asset.fc_logins_changed", level: "warning" });
    expect(String(h.events[0].message)).toContain("logged out fc1/1 lnx01.example.com");
  });
});

describe("getFibreChannelForAsset", () => {
  it("serves the switch view and the host view", async () => {
    await persistFibreChannel("sw", INV);
    const sw = await getFibreChannelForAsset("sw");
    expect(sw.switch?.ports).toHaveLength(2);
    expect(sw.host).toBeNull();

    const host = await getFibreChannelForAsset("host");
    expect(host.switch).toBeNull();
    expect(host.host?.fabrics).toHaveLength(1);
    const fabric = host.host!.fabrics[0];
    expect(fabric.switch.hostname).toBe("mds-a");
    expect(fabric.ports[0]).toMatchObject({ ifName: "fc1/1", errorCounters: counters(5) });
    expect(fabric.others).toEqual([{ ifName: "fc1/8", portWwn: "52:4a:93:00:00:00:30:09", label: "PURE01-ct0" }]);
  });

  it("is empty on both sides for an asset with no FC rows", async () => {
    const r = await getFibreChannelForAsset("host");
    expect(r).toMatchObject({ switch: null, host: null, collectedAt: null });
  });
});
