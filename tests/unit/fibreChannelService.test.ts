/**
 * tests/unit/fibreChannelService.test.ts
 *
 * Business rule 159 — the writer and reader (services/fibreChannelService.ts).
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
  hbas: [] as any[],
}));

vi.mock("../../src/db.js", () => {
  const match = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "OR") return (v as any[]).some((w) => match(row, w));
      // The related-asset status filter: every fixture asset is live.
      if (k === "asset") return true;
      if (v && typeof v === "object" && "in" in v) return v.in.includes(row[k]);
      if (v && typeof v === "object" && "not" in v) return row[k] !== v.not;
      return row[k] === v;
    });
  const table = (key: "ports" | "logins" | "hbas") => ({
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
      assetHbaPort: table("hbas"),
      asset: {
        findMany: vi.fn(async () => h.assets),
        findUnique: vi.fn(async ({ where }: any) => h.assets.find((a) => a.id === where.id) ?? null),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => { for (const op of ops) await op; }),
    },
  };
});

vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => {
  resetEventLogStub();
  eventLog.logEvent.mockImplementation(async (e) => { h.events.push(e); return undefined; });
});

const { persistFibreChannel, getFibreChannelForAsset, recordHostHbaPorts, resetHbaPortCache, getFcLoginsForSwitches, getFcByInterface } = await import("../../src/services/fibreChannelService.js");

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
  h.ports = []; h.logins = []; h.events = []; h.hbas = [];
  resetHbaPortCache();
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

  it("dates a host's tab from the rows it shows, not the switch-only ones", async () => {
    await persistFibreChannel("sw", INV, new Date("2026-11-11T10:00:00Z"));
    const host = await getFibreChannelForAsset("host");
    expect(host.collectedAt).toEqual(new Date("2026-11-11T10:00:00Z"));

    // A host whose only FC rows are its own HBA report is dated by that.
    h.assets.push({ id: "esx07", hostname: "esx07", dnsName: null, model: null });
    await recordHostHbaPorts("esx07", "vcenter", [{ name: "vmhba9", portWwn: "10:00:00:00:00:00:00:77" }], new Date("2026-11-12T08:00:00Z"));
    const esx = await getFibreChannelForAsset("esx07");
    expect(esx.collectedAt).toEqual(new Date("2026-11-12T08:00:00Z"));
  });

  it("is empty on both sides for an asset with no FC rows", async () => {
    const r = await getFibreChannelForAsset("host");
    expect(r).toMatchObject({ switch: null, host: null, collectedAt: null });
  });
});

describe("host-reported HBA ports (WWN matching)", () => {
  it("records a host's ports normalised, and clears them on an empty reading", async () => {
    await recordHostHbaPorts("host", "agent", [
      { name: "host3", portWwn: "0x1000000000000001", nodeWwn: "0x2000000000000001", portState: "Online", fabricWwn: "0xffffffffffffffff" },
      { name: "bad", portWwn: "not-a-wwn" },
    ]);
    expect(h.hbas).toHaveLength(1);
    expect(h.hbas[0]).toMatchObject({ source: "agent", portWwn: "10:00:00:00:00:00:00:01", nodeWwn: "20:00:00:00:00:00:00:01", fabricWwn: null });
    await recordHostHbaPorts("host", "agent", []);
    expect(h.hbas).toHaveLength(0);
  });

  it("matches a login by the WWN the host reports, ahead of any name", async () => {
    h.assets.push({ id: "esx07", hostname: "esx07", dnsName: null, model: null });
    await recordHostHbaPorts("esx07", "vcenter", [{ name: "vmhba2", portWwn: "10:00:00:00:00:00:00:01" }]);
    // The HBA registered lnx01's name, but esx07 reports the WWN: the WWN wins.
    await persistFibreChannel("sw", INV);
    const l = h.logins.find((x) => x.ifName === "fc1/1");
    expect(l).toMatchObject({ matchedAssetId: "esx07", matchMethod: "wwn" });
  });

  it("serves a host's ports with the switch port that sees each one", async () => {
    await recordHostHbaPorts("host", "agent", [
      { name: "host3", portWwn: "10:00:00:00:00:00:00:01" },
      { name: "host4", portWwn: "10:00:00:00:00:00:00:99" },
    ]);
    await persistFibreChannel("sw", INV);
    const r = await getFibreChannelForAsset("host");
    const byName = Object.fromEntries(r.host!.hbas.map((x) => [x.name, x]));
    expect(byName.host3.seenBy).toEqual([{ switch: { id: "sw", hostname: "mds-a", dnsName: null, model: "DS-C9148S-K9" }, ifName: "fc1/1", vsan: 101 }]);
    expect(byName.host4.seenBy).toEqual([]);
  });
});

describe("getFcLoginsForSwitches (the Device Map's FC links, rule 162)", () => {
  it("returns each login with its live host, and unmatches a retired one", async () => {
    await persistFibreChannel("sw", INV);
    let rows = await getFcLoginsForSwitches(["sw"]);
    const lnx = rows.find((r) => r.ifName === "fc1/1")!;
    expect(lnx).toMatchObject({ matchMethod: "name", matchedAsset: { id: "host" } });
    expect(rows.find((r) => r.ifName === "fc1/8")).toMatchObject({ hostName: "PURE01-ct0", matchedAsset: null });

    h.assets.find((a) => a.id === "host")!.status = "decommissioned";
    rows = await getFcLoginsForSwitches(["sw"]);
    expect(rows.find((r) => r.ifName === "fc1/1")).toMatchObject({ matchedAsset: null, matchMethod: null });
  });

  it("asks nothing for no switches", async () => {
    expect(await getFcLoginsForSwitches([])).toEqual([]);
  });
});

describe("getFcByInterface (the Interfaces table's FC columns, rule 159a)", () => {
  it("gives each FC port its counters and what is logged into it, keyed by name", async () => {
    await persistFibreChannel("sw", INV);
    const byIf = await getFcByInterface("sw");
    expect(byIf.get("fc1/1")).toMatchObject({
      errorCounters: { invalidTxWords: 5 },
      logins: [{ portWwn: "10:00:00:00:00:00:00:01", matchMethod: "name", matchedAsset: { id: "host", hostname: "lnx01" } }],
    });
    expect(byIf.get("fc1/8")!.logins[0]).toMatchObject({ hostName: "PURE01-ct0", matchedAsset: null });
  });

  it("unmatches a login whose host was decommissioned", async () => {
    await persistFibreChannel("sw", INV);
    h.assets.find((a) => a.id === "host")!.status = "decommissioned";
    const byIf = await getFcByInterface("sw");
    expect(byIf.get("fc1/1")!.logins[0]).toMatchObject({ matchedAsset: null, matchMethod: null });
  });

  it("is empty for a device that is not an FC switch", async () => {
    expect((await getFcByInterface("host")).size).toBe(0);
  });
});
