/**
 * tests/integration/genericApiSync.test.ts
 *
 * syncGenericApiDevices against a real Postgres. Pins:
 *   1. a first run creates one asset per record with a `generic-api` source
 *      row keyed `${integrationId}:${identity}`; a re-run is idempotent;
 *   2. it never writes lastSeen (rule 12) and never sets `monitored`;
 *   3. a record matches an existing asset on MAC, and on a unique serial —
 *      claiming it, and filling only what first-party sources left blank;
 *   4. a hostname collision with an unlinked asset is a pending Conflict;
 *   5. the missing-record sweep is opt-in, refuses an incomplete or empty
 *      read and a mass removal, and keeps a FILTERED-OUT record's asset;
 *   6. an asset another integration owns loses only this feed's row;
 *   7. an unknown mapped asset type falls back to the default, then "other";
 *   8. the directly-written columns (department, owner, PO, dates,
 *      description, asset tag) and tags: filled when blank, changed only
 *      while they still hold what the feed wrote, never over an operator's
 *      edit; an asset tag another asset holds is left off; typed
 *      coordinates are never moved.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncGenericApiDevices } from "../../src/services/discovery/genericApiSync.js";
import type { GenericApiDiscoveryResult, GenericApiMappedRecord } from "../../src/services/genericApiService.js";

const d = dbDescribe;
const NAME = "generic-sync-test";
const OTHER = "generic-sync-test-other";
const PREFIX = "gsync-";
let integrationId = "";

async function cleanup(): Promise<void> {
  const intgs = await prisma.integration.findMany({ where: { name: { in: [NAME, OTHER] } }, select: { id: true } });
  const ids = intgs.map((i) => i.id);
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: PREFIX } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  if (assetIds.length) {
    await prisma.assetSource.deleteMany({ where: { assetId: { in: assetIds } } });
    await prisma.conflict.deleteMany({ where: { OR: [{ assetId: { in: assetIds } }, { integrationId: { in: ids } }] } });
    await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  }
  if (ids.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: ids } } });
    await prisma.integration.deleteMany({ where: { id: { in: ids } } });
  }
}

beforeAll(async () => { if (dbReachable) await prisma.$connect(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({ data: { type: "genericapi", name: NAME, config: {}, enabled: true } });
  integrationId = intg.id;
});

const rec = (id: string, over: Partial<GenericApiMappedRecord> = {}): GenericApiMappedRecord => ({
  identity: id,
  hostname: `${PREFIX}${id}`,
  ipAddress: null,
  macs: [],
  serialNumber: null,
  manufacturer: null,
  model: null,
  os: null,
  osVersion: null,
  rawAssetType: null,
  assetType: null,
  location: null,
  assetTag: null,
  department: null,
  assignedTo: null,
  description: null,
  tags: [],
  acquiredAt: null,
  warrantyExpiry: null,
  purchaseOrder: null,
  latitude: null,
  longitude: null,
  ...over,
});

function result(records: GenericApiMappedRecord[], over: Partial<GenericApiDiscoveryResult> = {}): GenericApiDiscoveryResult {
  return {
    records,
    presentIdentities: records.map((r) => r.identity),
    complete: true,
    pages: 1,
    rawCount: records.length,
    unmapped: 0,
    unmappedReasons: [],
    duplicates: 0,
    filtered: 0,
    detailRequests: 0,
    detailFailures: 0,
    warnings: [],
    ...over,
  };
}

async function byName(suffix: string) {
  return prisma.asset.findFirst({
    where: { hostname: `${PREFIX}${suffix}` },
    select: { id: true, assetType: true, status: true, lastSeen: true, monitored: true, model: true, os: true, discoveredByIntegrationId: true, tags: true, learnedLocation: true, serialNumber: true },
  });
}

d("syncGenericApiDevices", () => {
  it("creates one asset per record, keyed to the integration, idempotently — no lastSeen, no monitoring", async () => {
    const records = [
      rec("cam1", { ipAddress: "10.250.9.1", model: "P3245-V", assetType: "printer", location: "HQ / Lobby", macs: ["AC:CC:8E:00:00:01"] }),
      rec("cam2"),
    ];
    const r1 = await syncGenericApiDevices(integrationId, NAME, {}, result(records));
    expect(r1.created.sort()).toEqual([`${PREFIX}cam1`, `${PREFIX}cam2`]);

    const cam1 = await byName("cam1");
    expect(cam1).toMatchObject({ assetType: "printer", model: "P3245-V", status: "active", discoveredByIntegrationId: integrationId, learnedLocation: "HQ / Lobby" });
    expect(cam1?.tags).toEqual(expect.arrayContaining(["genericapi", "auto-discovered"]));
    // Rule 12: an inventory record is not presence.
    expect(cam1?.lastSeen).toBeNull();
    expect(cam1?.monitored).toBe(false);
    expect((await byName("cam2"))?.assetType).toBe("other");

    const rows = await prisma.assetSource.findMany({ where: { integrationId }, select: { sourceKind: true, externalId: true } });
    expect(rows.map((r) => `${r.sourceKind}|${r.externalId}`).sort()).toEqual([
      `generic-api|${integrationId}:cam1`,
      `generic-api|${integrationId}:cam2`,
    ]);

    const r2 = await syncGenericApiDevices(integrationId, NAME, {}, result(records));
    expect(r2.created).toEqual([]);
    expect(r2.updated).toHaveLength(2);
    expect(await prisma.assetSource.count({ where: { integrationId } })).toBe(2);
  });

  it("matches an existing asset on MAC and on a unique serial, filling only what is blank", async () => {
    const byMac = await prisma.asset.create({ data: { hostname: `${PREFIX}known-mac`, assetType: "server", status: "active", macAddress: "AC:CC:8E:00:00:09", os: "Windows Server 2022" } });
    const bySerial = await prisma.asset.create({ data: { hostname: `${PREFIX}known-serial`, assetType: "other", status: "active", serialNumber: "SRV-GSYNC-0001" } });

    const r = await syncGenericApiDevices(integrationId, NAME, { assetTypeDefault: "switch" }, result([
      // Prefixed so cleanup() finds them once the projection renames the assets.
      rec("a", { hostname: `${PREFIX}renamed-a`, macs: ["ac:cc:8e:00:00:09"], os: "From the feed", model: "M1" }),
      rec("b", { hostname: `${PREFIX}renamed-b`, serialNumber: "SRV-GSYNC-0001" }),
    ]));
    expect(r.created).toEqual([]);
    expect(r.updated).toHaveLength(2);

    const a = await prisma.asset.findUnique({ where: { id: byMac.id } });
    // Claimed (it was unowned), filled the blank model…
    expect(a?.discoveredByIntegrationId).toBe(integrationId);
    expect(a?.model).toBe("M1");
    // …and the assetType a classification already gave it stands.
    expect(a?.assetType).toBe("server");
    const b = await prisma.asset.findUnique({ where: { id: bySerial.id } });
    // Retyped from "other" to the integration's default.
    expect(b?.assetType).toBe("switch");
    expect(await prisma.assetSource.count({ where: { integrationId, assetId: { in: [byMac.id, bySerial.id] } } })).toBe(2);
  });

  it("queues a hostname collision with an unlinked asset as a pending Conflict, never a merge", async () => {
    const existing = await prisma.asset.create({ data: { hostname: `${PREFIX}printer`, assetType: "printer", status: "active" } });
    const r = await syncGenericApiDevices(integrationId, NAME, {}, result([rec("p1", { hostname: `${PREFIX}printer` })]));
    expect(r.skipped).toEqual([`${PREFIX}printer (hostname collision — pending review)`]);
    const conflict = await prisma.conflict.findFirst({ where: { integrationId, assetId: existing.id, status: "pending" } });
    expect(conflict?.proposedDeviceId).toBe(`${integrationId}:p1`);
    expect((conflict?.proposedAssetFields as any)?.sourceType).toBe("genericapi");
    expect(await prisma.assetSource.count({ where: { integrationId } })).toBe(0);
  });

  it("keeps everything when decommissioning is off, and sweeps a vanished record when it is on — not a filtered one", async () => {
    await syncGenericApiDevices(integrationId, NAME, {}, result([rec("x1"), rec("x2"), rec("x3")]));

    // Off (the default): x3 leaves the feed, nothing happens.
    const off = await syncGenericApiDevices(integrationId, NAME, {}, result([rec("x1"), rec("x2")]));
    expect(off.decommissioned).toEqual([]);
    expect(await prisma.assetSource.count({ where: { integrationId } })).toBe(3);

    // On: x3 is gone; x2 is still in the feed but filtered out (present in
    // presentIdentities, absent from records) and must keep its asset.
    const on = await syncGenericApiDevices(integrationId, NAME, { decommissionMissing: true },
      result([rec("x1")], { presentIdentities: ["x1", "x2"], filtered: 1 }));
    expect(on.decommissioned).toEqual([`${PREFIX}x3`]);
    expect((await byName("x3"))?.status).toBe("decommissioned");
    expect((await byName("x2"))?.status).toBe("active");
    expect(await prisma.assetSource.count({ where: { integrationId } })).toBe(2);
  });

  it("refuses to sweep an incomplete read, an empty read, and a mass removal", async () => {
    const many = Array.from({ length: 60 }, (_, i) => rec(`m${i}`));
    await syncGenericApiDevices(integrationId, NAME, {}, result(many));
    const cfg = { decommissionMissing: true };

    const partial = await syncGenericApiDevices(integrationId, NAME, cfg, result(many.slice(0, 59), { complete: false }));
    expect(partial.decommissioned).toEqual([]);

    const empty = await syncGenericApiDevices(integrationId, NAME, cfg, result([]));
    expect(empty.decommissioned).toEqual([]);

    const mass = await syncGenericApiDevices(integrationId, NAME, cfg, result(many.slice(0, 2)));
    expect(mass.decommissioned).toEqual([]);
    expect(await prisma.assetSource.count({ where: { integrationId } })).toBe(60);
  });

  it("drops only its own row from an asset another integration owns", async () => {
    const other = await prisma.integration.create({ data: { type: "activedirectory", name: OTHER, config: {}, enabled: true } });
    await syncGenericApiDevices(integrationId, NAME, {}, result([rec("o1"), rec("o2")]));
    const o1 = await byName("o1");
    await prisma.asset.update({ where: { id: o1!.id }, data: { discoveredByIntegrationId: other.id } });

    const r = await syncGenericApiDevices(integrationId, NAME, { decommissionMissing: true }, result([rec("o2")]));
    expect(r.decommissioned).toEqual([]);
    expect((await byName("o1"))?.status).toBe("active");
    expect(await prisma.assetSource.count({ where: { integrationId, assetId: o1!.id } })).toBe(0);
  });
});

d("syncGenericApiDevices — the directly-written columns", () => {
  const owned = (suffix: string) => prisma.asset.findFirst({
    where: { hostname: `${PREFIX}${suffix}` },
    select: {
      id: true, department: true, assignedTo: true, purchaseOrder: true, description: true, assetTag: true,
      acquiredAt: true, warrantyExpiry: true, tags: true, latitude: true, longitude: true, coordSource: true,
    },
  });
  const full = (over: Partial<GenericApiMappedRecord> = {}) => rec("f1", {
    department: "Ops", assignedTo: "a@example.com", purchaseOrder: "PO-1", description: "Lobby camera",
    assetTag: `${PREFIX}TAG-1`, acquiredAt: "2024-02-03T00:00:00.000Z", warrantyExpiry: "2027-03-01T00:00:00.000Z",
    tags: ["east", "lobby"], latitude: 36.16, longitude: -86.78, ...over,
  });

  it("writes every mapped column on create, and follows the feed while nobody else has touched them", async () => {
    await syncGenericApiDevices(integrationId, NAME, {}, result([full()]));
    const a = await owned("f1");
    expect(a).toMatchObject({
      department: "Ops", assignedTo: "a@example.com", purchaseOrder: "PO-1", description: "Lobby camera",
      assetTag: `${PREFIX}TAG-1`, latitude: 36.16, longitude: -86.78,
    });
    expect(a?.acquiredAt?.toISOString()).toBe("2024-02-03T00:00:00.000Z");
    expect(a?.warrantyExpiry?.toISOString()).toBe("2027-03-01T00:00:00.000Z");
    expect(a?.tags).toEqual(expect.arrayContaining(["east", "lobby", "genericapi", "auto-discovered"]));

    await syncGenericApiDevices(integrationId, NAME, {}, result([full({ department: "NOC", warrantyExpiry: "2028-03-01T00:00:00.000Z", tags: ["east"] })]));
    const b = await owned("f1");
    expect(b?.department).toBe("NOC");
    expect(b?.warrantyExpiry?.toISOString()).toBe("2028-03-01T00:00:00.000Z");
    expect(b?.tags).not.toContain("lobby");
    expect(b?.tags).toContain("east");
  });

  it("never overwrites an operator's edit, never clears, and keeps an operator's tag", async () => {
    await syncGenericApiDevices(integrationId, NAME, {}, result([full()]));
    const a = await owned("f1");
    await prisma.asset.update({
      where: { id: a!.id },
      data: { department: "Facilities", tags: [...(a!.tags as string[]), "critical"], latitude: 40.1, longitude: -75.2, coordSource: "manual" },
    });

    await syncGenericApiDevices(integrationId, NAME, {}, result([full({ department: "NOC", assignedTo: null, latitude: 36.2, longitude: -86.7 })]));
    const b = await owned("f1");
    expect(b?.department).toBe("Facilities");
    expect(b?.assignedTo).toBe("a@example.com");
    expect(b?.tags).toContain("critical");
    expect([b?.latitude, b?.longitude, b?.coordSource]).toEqual([40.1, -75.2, "manual"]);
  });

  it("leaves off an asset tag another asset already carries", async () => {
    await prisma.asset.create({ data: { hostname: `${PREFIX}holder`, assetType: "other", status: "active", assetTag: `${PREFIX}TAG-1` } });
    const r = await syncGenericApiDevices(integrationId, NAME, {}, result([full()]));
    expect(r.created).toEqual([`${PREFIX}f1`]);
    const a = await owned("f1");
    expect(a?.assetTag).toBeNull();
    expect(a?.department).toBe("Ops");
  });

  it("does not write a description onto an asset another integration owns", async () => {
    const other = await prisma.integration.create({ data: { type: "activedirectory", name: OTHER, config: {}, enabled: true } });
    const adOwned = await prisma.asset.create({
      data: { hostname: `${PREFIX}ad-owned`, assetType: "server", status: "active", macAddress: "AC:CC:8E:00:00:77", discoveredByIntegrationId: other.id },
    });
    const r = await syncGenericApiDevices(integrationId, NAME, {}, result([rec("x1", { macs: ["AC:CC:8E:00:00:77"], description: "From the feed", department: "Ops" })]));
    expect(r.created).toEqual([]);
    // By id: with no hostname source of its own the asset takes the feed's name.
    const a = await prisma.asset.findUnique({ where: { id: adOwned.id }, select: { description: true, department: true, discoveredByIntegrationId: true } });
    expect(a?.description).toBeNull();
    expect(a?.department).toBe("Ops");
    expect(a?.discoveredByIntegrationId).toBe(other.id);
  });
});
