/**
 * tests/integration/sightingsPerBindingKind.test.ts
 *
 * A FortiGate sighting is kept per (asset, gate, binding kind): a gate that
 * holds both a DHCP reservation and a lease for the device keeps a row for
 * each, so Firewall Sightings shows the lease too (before, the reservation won
 * the tie and the lease vanished). Quarantine still targets each gate once.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { recordSightings, getSightingsForAsset, getQuarantineCandidates } from "../../src/services/assetSightingService.js";

const d = dbDescribe;
const HOST = "sightkind-test-pc";
let assetId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: HOST } });
  await prisma.$disconnect();
});
beforeEach(async () => {
  if (!dbReachable) return;
  await prisma.asset.deleteMany({ where: { hostname: HOST } });
  assetId = (await prisma.asset.create({ data: { hostname: HOST, assetType: "workstation", status: "active" } })).id;
});

d("FortiGate sightings per binding kind", () => {
  it("keeps the lease and the reservation on one gate, and refreshes each in place", async () => {
    const t1 = new Date("2026-11-03T10:00:00Z");
    await recordSightings([
      { assetId, fortigateDevice: "SK-GW-A", source: "dhcp_reservation", ipAddress: "10.0.0.50", seenAt: t1 },
      { assetId, fortigateDevice: "SK-GW-A", source: "dhcp_lease", ipAddress: "10.0.0.90", seenAt: t1 },
    ]);
    const t2 = new Date("2026-11-03T11:00:00Z");
    await recordSightings([{ assetId, fortigateDevice: "SK-GW-A", source: "dhcp_lease", ipAddress: "10.0.0.91", seenAt: t2 }]);

    const rows = await getSightingsForAsset(assetId);
    expect(rows.map((r) => [r.source, r.ipAddress]).sort()).toEqual([
      ["dhcp_lease", "10.0.0.91"],
      ["dhcp_reservation", "10.0.0.50"],
    ]);
  });

  it("quarantine candidates name each gate once, by its freshest row", async () => {
    await recordSightings([
      { assetId, fortigateDevice: "SK-GW-A", source: "dhcp_reservation", seenAt: new Date(Date.now() - 60_000) },
      { assetId, fortigateDevice: "SK-GW-A", source: "dhcp_lease", seenAt: new Date() },
      { assetId, fortigateDevice: "SK-GW-B", source: "dhcp_lease", seenAt: new Date() },
    ]);
    const gates = (await getQuarantineCandidates(assetId)).map((s) => [s.fortigateDevice, s.source]).sort();
    expect(gates).toEqual([["SK-GW-A", "dhcp_lease"], ["SK-GW-B", "dhcp_lease"]]);
  });
});
