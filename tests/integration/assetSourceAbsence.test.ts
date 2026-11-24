/**
 * tests/integration/assetSourceAbsence.test.ts — business rule 200 against a
 * real Postgres:
 *   1. markSourcesMissing stamps only unstamped rows (the first time wins);
 *      clearSourcesMissing clears; markAssetSourcesMissing is per asset +
 *      kind + integration;
 *   2. retireSourceRows deletes the live row and keeps a last-known copy,
 *      carrying the live row's missingSince when it had one, else the sweep's
 *      time; a second retirement of the same identity replaces the copy;
 *   3. listShownRetiredSources hides a copy once a live row with its
 *      identity exists again — on this asset or another;
 *   4. the Sources tab view reads both as Missing; a merge carries the
 *      absorbed record's copies to the survivor.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  markSourcesMissing,
  clearSourcesMissing,
  markAssetSourcesMissing,
  retireSourceRows,
  listShownRetiredSources,
} from "../../src/services/assetSourceAbsenceService.js";
import { listAssetSourcesForDisplay } from "../../src/services/assetSourceService.js";
import { absorbAssetRelations } from "../../src/services/assetMergeService.js";

const PREFIX = "srcabs-";
const T1 = new Date("2026-11-20T10:00:00Z");
const T2 = new Date("2026-11-22T10:00:00Z");
let intgId = "";

async function cleanup(): Promise<void> {
  await prisma.asset.deleteMany({ where: { hostname: { startsWith: PREFIX } } });
  await prisma.integration.deleteMany({ where: { name: { startsWith: PREFIX } } });
}

async function asset(name: string) {
  return prisma.asset.create({ data: { hostname: `${PREFIX}${name}`, assetType: "server", status: "active" } });
}

async function source(assetId: string, sourceKind: string, externalId: string, over: Record<string, unknown> = {}) {
  return prisma.assetSource.create({
    data: { assetId, sourceKind, externalId: `${PREFIX}${externalId}`, integrationId: intgId, observed: { name: externalId }, ...over },
  });
}

beforeAll(async () => { if (dbReachable) await prisma.$connect(); });
afterAll(async () => { if (!dbReachable) return; await cleanup(); await prisma.$disconnect(); });
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  intgId = (await prisma.integration.create({ data: { type: "activedirectory", name: `${PREFIX}ad`, config: {}, enabled: true } })).id;
});

dbDescribe("assetSourceAbsenceService (rule 200)", () => {
  it("stamps once, keeps the first time, and clears", async () => {
    const a = await asset("a");
    const s = await source(a.id, "ad", "g1");
    expect(await markSourcesMissing([s.id], T1)).toBe(1);
    expect(await markSourcesMissing([s.id], T2)).toBe(0);
    expect((await prisma.assetSource.findUnique({ where: { id: s.id } }))!.missingSince).toEqual(T1);
    expect(await clearSourcesMissing([s.id])).toBe(1);
    expect((await prisma.assetSource.findUnique({ where: { id: s.id } }))!.missingSince).toBeNull();
  });

  it("marks by asset only the named kinds of the named integration", async () => {
    const a = await asset("b");
    const sw = await source(a.id, "fortiswitch", "sw1");
    const ep = await source(a.id, "fortigate-endpoint", "ep1");
    expect(await markAssetSourcesMissing([a.id], ["fortiswitch", "fortiap"], intgId, T1)).toBe(1);
    expect((await prisma.assetSource.findUnique({ where: { id: sw.id } }))!.missingSince).toEqual(T1);
    expect((await prisma.assetSource.findUnique({ where: { id: ep.id } }))!.missingSince).toBeNull();
  });

  it("retires a row into a last-known copy, carrying its stamp, and replaces an older copy of the same identity", async () => {
    const a = await asset("c");
    const stamped = await source(a.id, "ad", "g2", { missingSince: T1, lastSeen: T1 });
    const fresh = await source(a.id, "vcenter-vm", "vm1");
    expect(await retireSourceRows([stamped.id, fresh.id], T2)).toBe(2);
    // (Asset.create mints a `manual` placeholder row — not one of ours.)
    expect(await prisma.assetSource.count({ where: { assetId: a.id, sourceKind: { not: "manual" } } })).toBe(0);
    const copies = await prisma.assetSourceRetired.findMany({ where: { assetId: a.id }, orderBy: { sourceKind: "asc" } });
    expect(copies.map((c) => [c.sourceKind, c.missingSince.toISOString()])).toEqual([
      ["ad", T1.toISOString()],
      ["vcenter-vm", T2.toISOString()],
    ]);
    expect(copies[0].observed).toEqual({ name: "g2" });

    // The identity comes back, then leaves again: one copy, the newer one.
    const again = await source(a.id, "ad", "g2");
    await retireSourceRows([again.id], T2);
    const ad = await prisma.assetSourceRetired.findMany({ where: { sourceKind: "ad", externalId: `${PREFIX}g2` } });
    expect(ad).toHaveLength(1);
    expect(ad[0].missingSince).toEqual(T2);
  });

  it("hides a copy while a live row holds its identity, on any asset", async () => {
    const a = await asset("d");
    const b = await asset("e");
    const s = await source(a.id, "ad", "g3");
    await retireSourceRows([s.id], T1);
    expect(await listShownRetiredSources(a.id)).toHaveLength(1);
    await source(b.id, "ad", "g3");
    expect(await listShownRetiredSources(a.id)).toHaveLength(0);
  });

  it("the Sources tab view reads a stamped row and a copy as Missing", async () => {
    const a = await asset("f");
    await source(a.id, "ad", "g4", { missingSince: T1 });
    const vm = await source(a.id, "vcenter-vm", "vm2");
    await retireSourceRows([vm.id], T2);
    const rows = await listAssetSourcesForDisplay(a.id);
    expect(rows.filter((r) => r.sourceKind !== "manual").map((r) => [r.sourceKind, r.state.state, r.retired])).toEqual([
      ["ad", "missing", false],
      ["vcenter-vm", "missing", true],
    ]);
  });

  it("a merge carries the absorbed record's copies to the survivor", async () => {
    const keep = await asset("g");
    const gone = await asset("h");
    const s = await source(gone.id, "ad", "g5");
    await retireSourceRows([s.id], T1);
    await prisma.$transaction((tx) => absorbAssetRelations(tx, gone.id, keep.id));
    expect(await prisma.assetSourceRetired.count({ where: { assetId: keep.id } })).toBe(1);
  });
});
