/**
 * tests/unit/searchServiceOrigin.test.ts — which FortiGate an asset hit's
 * Device Map entry opens (`context.siteId`).
 *
 * The dependency tree decides first — the same chain the asset's own
 * dependency view draws — and the DHCP sighting only when the tree reaches no
 * gate. The case that motivated it: a server built at headquarters and
 * shipped to a remote site keeps the headquarters gate as its freshest DHCP
 * sighting once it runs on a static address, so the map opened headquarters'
 * topology while its asset page showed the remote gate.
 *
 * The database is mocked; what is pinned is the precedence.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/applicationMapService.js", () => ({ resolveIpsToAssets: vi.fn(async () => new Map()) }));
vi.mock("../../src/services/notificationService.js", () => ({ activeAlertSummaryByAsset: vi.fn(async () => new Map()) }));
vi.mock("../../src/services/discoveredHostnameService.js", () => ({ findAssetIdsByDiscoveredHostname: vi.fn(async () => new Map()) }));

import { searchAll } from "../../src/services/searchService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

type Row = Record<string, unknown> & { id: string };
const asset = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, hostname: id, ipAddress: null, macAddress: null, assetTag: null, assetType: "server",
  manufacturer: null, model: null, monitored: false, monitorStatus: null, status: "active",
  dependencySuppressed: false, dependencyTestUntil: null, latitude: null, longitude: null,
  learnedLocation: null, ...over,
});

const SERVER = asset("SRV-01");
const REMOTE_SW = asset("SW-REMOTE", { assetType: "switch" });
const REMOTE_FG = asset("FG-REMOTE", { assetType: "firewall", latitude: 35, longitude: -86, monitorStatus: "up" });
const HQ_FG = asset("FG-HQ", { assetType: "firewall", latitude: 36, longitude: -87, monitorStatus: "up" });

let fleet: Row[];
let edges: Array<{ assetId: string; parentAssetId: string; source: string }>;
let sightings: Array<{ assetId: string; fortigateDevice: string; lastSeen: Date }>;

function byIds(where: any): Row[] {
  const ids: string[] | undefined = where?.id?.in;
  return ids ? fleet.filter((a) => ids.includes(a.id)) : [];
}

beforeEach(() => {
  resetDbStub();
  stubbed(prisma.$queryRaw).mockImplementation(async () => []);
  stubbed(prisma.assetIpsecConnection.findMany).mockImplementation(async () => []);
  stubbed(prisma.ipBlock.findMany).mockImplementation(async () => []);
  stubbed(prisma.subnet.findMany).mockImplementation(async () => []);
  stubbed(prisma.reservation.findMany).mockImplementation(async () => []);
  stubbed(prisma.assetSource.findMany).mockImplementation(async () => []);
  stubbed(prisma.assetMacAddress.findMany).mockImplementation(async () => []);
  stubbed(prisma.assetAssociatedIp.findMany).mockImplementation(async () => []);
  stubbed(prisma.assetIpHistory.findMany).mockImplementation(async () => []);
});

beforeEach(() => {
  fleet = [SERVER, REMOTE_SW, REMOTE_FG, HQ_FG];
  edges = [];
  sightings = [{ assetId: SERVER.id, fortigateDevice: "FG-HQ", lastSeen: new Date("2026-10-01T00:00:00Z") }];
  stubbed(prisma.asset.findMany).mockReset();
  stubbed(prisma.asset.findMany).mockImplementation(async (args: any) => {
    const where = args?.where ?? {};
    // The search's own hostname query: the server is the only match.
    if (where.AND) return [SERVER];
    // Firewall-by-hostname lookup for the sighting fallback.
    if (where.hostname?.in) {
      return fleet.filter((a) => a.assetType === "firewall" && where.hostname.in.includes(a.hostname) && a.latitude != null);
    }
    return byIds(where);
  });
  stubbed(prisma.assetDependencyParent.findMany).mockReset();
  stubbed(prisma.assetDependencyParent.findMany).mockImplementation(async (args: any) =>
    edges.filter((e) => args.where.assetId.in.includes(e.assetId)));
  stubbed(prisma.assetFortigateSighting.findMany).mockReset();
  stubbed(prisma.assetFortigateSighting.findMany).mockImplementation(async (args: any) =>
    sightings.filter((s) => args.where.assetId.in.includes(s.assetId)));
});

async function originOf() {
  const r = await searchAll("asset:SRV-01");
  return r.assets.find((a) => a.id === SERVER.id)?.context ?? {};
}

describe("searchAll — an asset hit's Device Map origin", () => {
  it("follows the dependency tree to the gate the server sits behind now, not its build site's DHCP sighting", async () => {
    edges = [
      { assetId: SERVER.id, parentAssetId: REMOTE_SW.id, source: "endpoint" },
      { assetId: REMOTE_SW.id, parentAssetId: REMOTE_FG.id, source: "computed" },
    ];
    expect(await originOf()).toMatchObject({ siteId: REMOTE_FG.id, siteHostname: "FG-REMOTE" });
    // The tree answered; the sighting log was never read.
    expect(stubbed(prisma.assetFortigateSighting.findMany)).not.toHaveBeenCalled();
  });

  it("lets an override set win over the computed parents, as the dependency view does", async () => {
    edges = [
      { assetId: SERVER.id, parentAssetId: HQ_FG.id, source: "endpoint" },
      { assetId: SERVER.id, parentAssetId: REMOTE_SW.id, source: "override" },
      { assetId: REMOTE_SW.id, parentAssetId: REMOTE_FG.id, source: "computed" },
    ];
    expect(await originOf()).toMatchObject({ siteId: REMOTE_FG.id });
  });

  it("gives no map entry when the tree's gate is not pinned — never some other site's sighting", async () => {
    fleet = [SERVER, REMOTE_SW, { ...REMOTE_FG, latitude: null, longitude: null }, HQ_FG];
    edges = [
      { assetId: SERVER.id, parentAssetId: REMOTE_SW.id, source: "endpoint" },
      { assetId: REMOTE_SW.id, parentAssetId: REMOTE_FG.id, source: "computed" },
    ];
    expect((await originOf()).siteId).toBeUndefined();
  });

  it("stops at the first gate — a spoke's hub above it is not the server's site", async () => {
    edges = [
      { assetId: SERVER.id, parentAssetId: REMOTE_FG.id, source: "endpoint" },
      { assetId: REMOTE_FG.id, parentAssetId: HQ_FG.id, source: "computed" },
    ];
    expect(await originOf()).toMatchObject({ siteId: REMOTE_FG.id });
  });

  it("falls back to the freshest DHCP sighting when the tree reaches no gate", async () => {
    edges = [];
    expect(await originOf()).toMatchObject({ siteId: HQ_FG.id, siteHostname: "FG-HQ" });
  });

  it("survives a cycle in the tree without hanging, then falls back to the sighting", async () => {
    edges = [
      { assetId: SERVER.id, parentAssetId: REMOTE_SW.id, source: "endpoint" },
      { assetId: REMOTE_SW.id, parentAssetId: SERVER.id, source: "override" },
    ];
    expect(await originOf()).toMatchObject({ siteId: HQ_FG.id });
  });
});
