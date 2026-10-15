/**
 * tests/integration/arpTable.test.ts
 *
 * The FortiGate ARP Table feature end to end against a real database: the
 * writer's delete-replace scoping and firstSeen carry-forward against the real
 * unique constraint, and what GET /assets/:id/arp-table hands the tab.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { persistFortigateArpTables, persistAssetArpNeighbors } from "../../src/services/arpTableService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const GATE_A_SERIAL = "FG100FTK20000001";
const GATE_B_SERIAL = "FG100FTK20000002";

let integrationId = "";
let gateA = "";
let gateB = "";
let endpoint = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.assetArpEntry.deleteMany();
  await prisma.assetSource.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.integration.deleteMany();

  const integration = await prisma.integration.create({
    data: { name: "FMG-Test", type: "fortimanager", config: {} as any, enabled: true },
  });
  integrationId = integration.id;

  const mk = async (hostname: string, assetType: string) =>
    (await prisma.asset.create({ data: { hostname, assetType, status: "active" } })).id;

  gateA    = await mk("FGT-A", "firewall");
  gateB    = await mk("FGT-B", "firewall");
  endpoint = await mk("PRINTER-4", "printer");

  // The `fortigate-firewall` AssetSource row is the serial → assetId hop the
  // writer resolves through; without it a gate is "unresolved" by design.
  for (const [assetId, externalId] of [[gateA, GATE_A_SERIAL], [gateB, GATE_B_SERIAL]] as const) {
    await prisma.assetSource.create({
      data: { assetId, sourceKind: "fortigate-firewall", externalId, integrationId, observed: {} as any },
    });
  }
});

const serials = () => new Map([["FGT-A", GATE_A_SERIAL], ["FGT-B", GATE_B_SERIAL]]);
const row = (device: string, ip: string, mac: string, iface = "internal1", age?: number) =>
  ({ fortigateDevice: device, ip, mac, interface: iface, age });
const persist = (rows: any[], answered: string[], matchByMac: (m: string) => string | null = () => null) =>
  persistFortigateArpTables({
    integrationId, rows, answeredDevices: answered, deviceSerials: serials(), matchAssetByMac: matchByMac,
  });

d("persistFortigateArpTables (real DB)", () => {
  it("accumulates rather than replacing: a silent gate keeps its rows, and so does a gate that reports nothing", async () => {
    await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"),
      row("FGT-B", "10.1.0.1", "AA:BB:CC:DD:EE:02"),
    ], ["FGT-A", "FGT-B"]);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(1);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateB } })).toBe(1);

    // Next cycle: only A answers, and it answers with nothing. Neither gate
    // loses anything — retention is the only thing that removes a row.
    await persist([], ["FGT-A"]);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(1);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateB } })).toBe(1);
  });

  it("bumps lastSeen on a binding that is still there instead of duplicating it", async () => {
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"]);
    const first = await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } });

    await new Promise((r) => setTimeout(r, 15));
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"]);

    const rows = await prisma.assetArpEntry.findMany({ where: { assetId: gateA } });
    expect(rows).toHaveLength(1);
    expect(rows[0].firstSeen.getTime()).toBe(first.firstSeen.getTime());
    expect(rows[0].lastSeen.getTime()).toBeGreaterThan(first.lastSeen.getTime());
  });

  it("keeps a binding that has gone away, so history can still answer for it", async () => {
    await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"),
      row("FGT-A", "10.0.0.2", "AA:BB:CC:DD:EE:02"),
    ], ["FGT-A"]);
    // .2 unplugged; only .1 is in the cache now.
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"]);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(2);
  });

  it("survives a duplicate binding in one payload rather than aborting the gate", async () => {
    const result = await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 300),
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 12),
    ], ["FGT-A"]);
    expect(result.entriesWritten).toBe(1);
    const stored = await prisma.assetArpEntry.findFirst({ where: { assetId: gateA } });
    expect(stored?.ageSec).toBe(12);
  });

  it("does not duplicate an UNATTRIBUTED row across scrapes", async () => {
    // The reason ifName is "" and not NULL: Postgres treats NULLs as distinct
    // in a unique index, so a nullable column would insert a fresh row here on
    // every single poll.
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "")], ["FGT-A"]);
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "")], ["FGT-A"]);
    const rows = await prisma.assetArpEntry.findMany({ where: { assetId: gateA } });
    expect(rows).toHaveLength(1);
    expect(rows[0].ifName).toBe("");
  });

  it("treats the same binding on two interfaces as two rows", async () => {
    await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1"),
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "internal2"),
    ], ["FGT-A"]);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(2);
  });

  it("fills in matchedAssetId but never clears one a previous run resolved", async () => {
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"], () => endpoint);
    expect((await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } })).matchedAssetId).toBe(endpoint);

    // A later run whose resolver cannot match the MAC (the monitor pass has no
    // warm asset index) must not undo the discovery run's work.
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"], () => null);
    expect((await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } })).matchedAssetId).toBe(endpoint);
  });

  it("releases the match when the endpoint asset is deleted, and cascades with the gate", async () => {
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01")], ["FGT-A"], () => endpoint);
    await prisma.asset.delete({ where: { id: endpoint } });
    expect((await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } })).matchedAssetId).toBeNull();

    await prisma.asset.delete({ where: { id: gateA } });
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(0);
  });
});

d("persistAssetArpNeighbors (the monitor-cadence entry point)", () => {
  it("lands collector rows on the same table as discovery, and converges with them", async () => {
    await persistAssetArpNeighbors(gateA, [
      { ipAddress: "10.0.0.1", macAddress: "AA:BB:CC:DD:EE:01", ifName: "internal1", ageSec: 5 },
      { ipAddress: "10.0.0.2", macAddress: "AA:BB:CC:DD:EE:02", ifName: null,        ageSec: null },
    ]);
    const rows = await prisma.assetArpEntry.findMany({ where: { assetId: gateA }, orderBy: { ipAddress: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[1].ifName).toBe("");

    // The discovery writer seeing the same binding is a bump, not a duplicate
    // — which is what makes two writers on different cadences safe.
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "internal1", 90)], ["FGT-A"]);
    expect(await prisma.assetArpEntry.count({ where: { assetId: gateA } })).toBe(2);
    const bumped = await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA, ipAddress: "10.0.0.1" } });
    expect(bumped.ageSec).toBe(90);
  });

  it("carries an IPv6 neighbour, which only the SNMP transport can supply", async () => {
    await persistAssetArpNeighbors(gateA, [
      { ipAddress: "fe80::21a:2bff:fe3c:4d5e", macAddress: "00:1A:2B:3C:4D:5E", ifName: "wan1", ageSec: null },
    ]);
    const stored = await prisma.assetArpEntry.findFirstOrThrow({ where: { assetId: gateA } });
    expect(stored.ipAddress).toBe("fe80::21a:2bff:fe3c:4d5e");
  });
});

d("GET /assets/:id/arp-table", () => {
  it("returns entries, per-interface counts, the collection stamp and the cadence facts", async () => {
    await persist([
      row("FGT-A", "10.0.0.2",  "AA:BB:CC:DD:EE:02", "internal1", 30),
      row("FGT-A", "10.0.0.10", "AA:BB:CC:DD:EE:0A", "internal1"),
      row("FGT-A", "10.9.0.1",  "AA:BB:CC:DD:EE:09", "wan1"),
    ], ["FGT-A"], (mac) => (mac === "AA:BB:CC:DD:EE:02" ? endpoint : null));

    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${gateA}/arp-table`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.interfaceCounts).toEqual({ internal1: 2, wan1: 1 });
    expect(res.body.collectedAt).toBeTruthy();
    expect(res.body.range).toBe("current");
    // The disclaimer is built from these two, so they must always be present.
    expect(res.body).toHaveProperty("retentionDays");
    expect(res.body).toHaveProperty("pollIntervalSec");

    const matched = res.body.entries.find((e: any) => e.ipAddress === "10.0.0.2");
    expect(matched.matchedAsset.hostname).toBe("PRINTER-4");
    expect(matched.ageSec).toBe(30);
    expect(res.body.entries.find((e: any) => e.ipAddress === "10.0.0.10").ageSec).toBeNull();
  });

  it("maps the empty-string interface sentinel back to null", async () => {
    await persist([row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01", "")], ["FGT-A"]);
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${gateA}/arp-table`);
    expect(res.body.entries[0].ifName).toBeNull();
  });

  it("filters by range on lastSeen", async () => {
    await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"),
      row("FGT-A", "10.0.0.2", "AA:BB:CC:DD:EE:02"),
    ], ["FGT-A"]);
    // Age one row out of the short windows.
    await prisma.assetArpEntry.updateMany({
      where: { assetId: gateA, ipAddress: "10.0.0.2" },
      data:  { lastSeen: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
    });

    const { agent } = await authedAgent(app);
    const recent = await agent.get(`/api/v1/assets/${gateA}/arp-table?range=1h`);
    expect(recent.body.entries.map((e: any) => e.ipAddress)).toEqual(["10.0.0.1"]);

    const week = await agent.get(`/api/v1/assets/${gateA}/arp-table?range=7d`);
    expect(week.body.entries.map((e: any) => e.ipAddress).sort()).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(week.body.range).toBe("7d");
  });

  it("Current shows only the newest read, not every retained row", async () => {
    await persist([
      row("FGT-A", "10.0.0.1", "AA:BB:CC:DD:EE:01"),
      row("FGT-A", "10.0.0.2", "AA:BB:CC:DD:EE:02"),
      row("FGT-A", "10.0.0.3", "AA:BB:CC:DD:EE:03"),
    ], ["FGT-A"]);
    // 10.0.0.2 was last answered by an earlier read, ten minutes ago.
    await prisma.assetArpEntry.updateMany({
      where: { assetId: gateA, ipAddress: "10.0.0.2" },
      data:  { lastSeen: new Date(Date.now() - 10 * 60 * 1000) },
    });

    const { agent } = await authedAgent(app);
    const current = await agent.get(`/api/v1/assets/${gateA}/arp-table`);
    expect(current.body.entries.map((e: any) => e.ipAddress).sort()).toEqual(["10.0.0.1", "10.0.0.3"]);
    expect(current.body.total).toBe(2);

    const hour = await agent.get(`/api/v1/assets/${gateA}/arp-table?range=1h`);
    expect(hour.body.entries).toHaveLength(3);
  });

  it("rejects a range it does not offer instead of silently widening", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${gateA}/arp-table?range=90d`);
    expect(res.status).toBe(400);
  });

  it("answers empty rather than 404 for a gate that has never been read", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/api/v1/assets/${gateB}/arp-table`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 0, entries: [], interfaceCounts: {}, collectedAt: null });
  });

  it("requires authentication", async () => {
    const request = (await import("supertest")).default;
    const res = await request(app).get(`/api/v1/assets/${gateA}/arp-table`);
    expect(res.status).toBe(401);
  });
});
