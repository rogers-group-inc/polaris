/**
 * tests/integration/unprofiledManufacturers.test.ts — business rule 172
 * against a real database: `listUnprofiledManufacturers` counts only devices
 * that answer SNMP (a recent `lastDescrAt`, or an SNMP-only source row), never
 * a decommissioned one, and drops a manufacturer that has a profile.
 * Skips when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { listUnprofiledManufacturers, refreshProfileCache } from "../../src/services/manufacturerProfileService.js";

const d = dbDescribe;
const PFX = "Zzunprof";

async function cleanup() {
  await prisma.assetSource.deleteMany({ where: { asset: { manufacturer: { startsWith: PFX } } } });
  await prisma.asset.deleteMany({ where: { manufacturer: { startsWith: PFX } } });
  await (prisma as any).manufacturerProfile.deleteMany({ where: { manufacturer: { startsWith: PFX } } });
  await refreshProfileCache();
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
});
afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

const asset = (n: string, manufacturer: string, extra: Record<string, unknown> = {}) =>
  prisma.asset.create({ data: { hostname: `${PFX.toLowerCase()}-${n}`, assetType: "power", status: "active", manufacturer, ...extra } as never });

d("manufacturers without a profile (rule 172)", () => {
  it("counts SNMP-answering devices only, and never a decommissioned one", async () => {
    const now = new Date();
    await asset("a1", `${PFX} Alpha`, { lastDescrAt: now });
    await asset("a2", `${PFX} Alpha`, { lastDescrAt: new Date(now.getTime() - 40 * 86_400_000) });   // too old
    const a3 = await asset("a3", `${PFX} Alpha`);
    await prisma.assetSource.create({ data: { assetId: a3.id, sourceKind: "snmp-identity", externalId: a3.id, observed: {}, lastSeen: now } as never });
    await asset("a4", `${PFX} Alpha`, { lastDescrAt: now, status: "decommissioned" });
    await asset("b1", `${PFX} Beta`);   // never answered SNMP

    const out = (await listUnprofiledManufacturers(now)).filter((m) => m.manufacturer.startsWith(PFX));
    expect(out).toEqual([{ manufacturer: `${PFX} Alpha`, assetCount: 2, coveredBy: null }]);
  });

  it("drops a manufacturer once it has a profile", async () => {
    await asset("c1", `${PFX} Gamma`, { lastDescrAt: new Date() });
    expect((await listUnprofiledManufacturers()).some((m) => m.manufacturer === `${PFX} Gamma`)).toBe(true);
    await (prisma as any).manufacturerProfile.create({ data: { manufacturer: `${PFX} Gamma` } });
    await refreshProfileCache();
    expect((await listUnprofiledManufacturers()).some((m) => m.manufacturer === `${PFX} Gamma`)).toBe(false);
  });
});
