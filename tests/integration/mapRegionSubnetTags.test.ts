/**
 * tests/integration/mapRegionSubnetTags.test.ts
 *
 * Region-tag inheritance for SUBNETS. `mapRegionService` has always tagged
 * assets; a `Subnet` served by an in-polygon FortiGate now inherits the same
 * `region:<name>` tag, which is what lets the IPAM Networks list (whose Sources
 * column IS `Subnet.fortigateDevice`) be filtered by region.
 *
 * The service is entirely DB-driven, so this is a service-level integration
 * test: drive the apply / reconcile entry points and assert against the
 * resulting rows. Skips cleanly when DATABASE_URL is unreachable (_helpers.ts).
 *
 * Covered (read from the service, not assumed):
 *   - A subnet whose `fortigateDevice` matches an enclosed gate's DEVICE NAME
 *     — not its hostname — gets tagged. That is the key that broke the asset
 *     cascade pre-2026-08, and the subnet lookup runs off the same key set.
 *   - Serial and hostname resolve too (controllerIdentityKeys).
 *   - A subnet behind an out-of-polygon gate is left alone.
 *   - Add-pass is idempotent and never disturbs operator-set tags.
 *   - Rename rotates the tag on subnets; delete strips it.
 *   - The summary counts subnets separately from assets.
 *   - DRIFT: re-pointing a subnet's serving gate out of the region strips the
 *     inherited tag on the next reconcile (provenance-bounded — the unit suite
 *     in tests/unit/mapRegionDrift.test.ts covers the full matrix; this one
 *     exercises the real RegionTagAssignment table).
 *   - The map-save review (`reviewRegionTagsForMapSave`) strips a region tag
 *     from a pinned OUT-of-polygon gate even without a provenance row — the
 *     geometry-authoritative gate pass behind the Device Map's Save Regions —
 *     while subnets and non-gates keep the provenance-bounded protections.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe } from "./_helpers.js";
import {
  createRegion,
  updateRegion,
  deleteRegion,
  applyOneRegion,
  applyRename,
  applyDelete,
  reconcileMapRegions,
  reviewRegionTagsForMapSave,
  type MapRegion,
} from "../../src/services/mapRegionService.js";

const d = dbDescribe;

const BLOCK_CIDR = "10.88.0.0/16";
const IN_SUBNET = "10.88.1.0/24";
const OUT_SUBNET = "10.88.2.0/24";

// A tiny square around (40.71, -74.01). The "inside" gate sits
// at its center; the "outside" gate is far outside it.
const POLYGON: [number, number][] = [
  [40.65, -74.08],
  [40.65, -73.93],
  [40.80, -73.93],
  [40.80, -74.08],
];

const REGION_NAME = "Region Subnet Tag Test";
const RENAMED = "Region Subnet Tag Test Renamed";

/** Gate whose FMG device name differs from its configured hostname. */
const IN_DEVICE_NAME = "FGT-TEST-ASHFIELD";
const IN_HOSTNAME = "fgt-ashfield-01";
const IN_SERIAL = "FGTTEST0000000001";
const OUT_DEVICE_NAME = "FGT-TEST-ATLANTA";

async function wipe(): Promise<void> {
  await prisma.subnet.deleteMany({ where: { cidr: { in: [IN_SUBNET, OUT_SUBNET] } } });
  await prisma.ipBlock.deleteMany({ where: { cidr: BLOCK_CIDR } });
  await prisma.asset.deleteMany({ where: { serialNumber: { in: [IN_SERIAL, "FGTTEST0000000002"] } } });
  // Region rows live in one Setting blob; drop any left by a previous run —
  // and the provenance rows keyed by those regions' ids, which would otherwise
  // accumulate as orphans (they're inert: fresh runs mint fresh region UUIDs).
  const blob = await prisma.setting.findUnique({ where: { key: "mapRegions" } });
  const staleIds = Array.isArray(blob?.value)
    ? (blob!.value as Array<{ id?: string }>).map((r) => r.id).filter((id): id is string => !!id)
    : [];
  if (staleIds.length > 0) {
    await prisma.regionTagAssignment.deleteMany({ where: { regionId: { in: staleIds } } });
  }
  await prisma.setting.deleteMany({ where: { key: "mapRegions" } });
  await prisma.tag.deleteMany({ where: { name: { in: [`region:${REGION_NAME}`, `region:${RENAMED}`] } } });
}

async function makeFixtures(): Promise<{ inSubnetId: string; outSubnetId: string; gateId: string }> {
  const block = await prisma.ipBlock.create({
    data: { name: "Region Tag Test Block", cidr: BLOCK_CIDR, ipVersion: "v4" },
  });
  const inSubnet = await prisma.subnet.create({
    data: {
      blockId: block.id,
      cidr: IN_SUBNET,
      name: "In-region network",
      status: "available",
      // Discovery stamps the DEVICE NAME here, not the hostname.
      fortigateDevice: IN_DEVICE_NAME,
      tags: ["operator-set"],
    },
  });
  const outSubnet = await prisma.subnet.create({
    data: {
      blockId: block.id,
      cidr: OUT_SUBNET,
      name: "Out-of-region network",
      status: "available",
      fortigateDevice: OUT_DEVICE_NAME,
    },
  });
  const gate = await prisma.asset.create({
    data: {
      hostname: IN_HOSTNAME,
      assetType: "firewall",
      serialNumber: IN_SERIAL,
      latitude: 40.71,
      longitude: -74.01,
      fortinetTopology: { role: "fortigate", deviceName: IN_DEVICE_NAME },
    },
  });
  await prisma.asset.create({
    data: {
      hostname: "fgt-atlanta-01",
      assetType: "firewall",
      serialNumber: "FGTTEST0000000002",
      latitude: 33.75,
      longitude: -84.39,
      fortinetTopology: { role: "fortigate", deviceName: OUT_DEVICE_NAME },
    },
  });
  return { inSubnetId: inSubnet.id, outSubnetId: outSubnet.id, gateId: gate.id };
}

async function tagsOf(subnetId: string): Promise<string[]> {
  const row = await prisma.subnet.findUnique({ where: { id: subnetId }, select: { tags: true } });
  return row?.tags ?? [];
}

// The 5 s default is crossed in the full serial integration run.
d("mapRegionService — subnet region tags", { timeout: 30_000 }, () => {
  let region: MapRegion;
  let inSubnetId: string;
  let outSubnetId: string;

  beforeAll(async () => {
    await wipe();
  });

  beforeEach(async () => {
    await wipe();
    const f = await makeFixtures();
    inSubnetId = f.inSubnetId;
    outSubnetId = f.outSubnetId;
    region = await createRegion({ name: REGION_NAME, polygon: POLYGON, actor: "test" });
  });

  afterAll(async () => {
    await wipe();
  });

  it("tags a subnet served by an in-polygon gate, matching on the FMG device name", async () => {
    const summary = await applyOneRegion(region);
    expect(summary.subnetsAdded).toBe(1);
    expect(await tagsOf(inSubnetId)).toContain(`region:${REGION_NAME}`);
  });

  it("leaves a subnet behind an out-of-polygon gate untagged", async () => {
    await applyOneRegion(region);
    expect(await tagsOf(outSubnetId)).not.toContain(`region:${REGION_NAME}`);
  });

  it("preserves operator-set tags and is idempotent", async () => {
    await applyOneRegion(region);
    const second = await applyOneRegion(region);
    expect(second.subnetsAdded).toBe(0);
    const tags = await tagsOf(inSubnetId);
    expect(tags).toContain("operator-set");
    expect(tags.filter((t) => t === `region:${REGION_NAME}`)).toHaveLength(1);
  });

  it("matches on the gate's serial and on its hostname too", async () => {
    for (const key of [IN_SERIAL, IN_HOSTNAME]) {
      await prisma.subnet.update({ where: { id: inSubnetId }, data: { fortigateDevice: key, tags: [] } });
      await applyOneRegion(region);
      expect(await tagsOf(inSubnetId), `key ${key}`).toContain(`region:${REGION_NAME}`);
    }
  });

  it("rotates the tag on rename and strips it on delete", async () => {
    await applyOneRegion(region);
    const updated = await updateRegion(region.id, { name: RENAMED });
    const renameSummary = await applyRename(updated.region, updated.previousName);
    expect(renameSummary.subnetsRemoved).toBe(1);
    expect(renameSummary.subnetsAdded).toBe(1);
    let tags = await tagsOf(inSubnetId);
    expect(tags).not.toContain(`region:${REGION_NAME}`);
    expect(tags).toContain(`region:${RENAMED}`);
    expect(tags).toContain("operator-set");

    const removed = await deleteRegion(updated.region.id);
    const deleteSummary = await applyDelete(removed);
    expect(deleteSummary.subnetsRemoved).toBe(1);
    tags = await tagsOf(inSubnetId);
    expect(tags).not.toContain(`region:${RENAMED}`);
    expect(tags).toContain("operator-set");
  });

  it("counts subnets separately from assets in the reconcile summary", async () => {
    const summary = await reconcileMapRegions();
    // The in-polygon gate itself is the asset; the subnet it serves is the network.
    expect(summary.added).toBeGreaterThanOrEqual(1);
    expect(summary.subnetsAdded).toBe(1);
    expect(summary.subnetsTouched).toBe(1);
  });

  it("strips the inherited tag when the subnet's serving gate leaves the region (drift)", async () => {
    await applyOneRegion(region);
    expect(await tagsOf(inSubnetId)).toContain(`region:${REGION_NAME}`);

    // The subnet is re-served by the out-of-polygon gate — the "device moved"
    // event the daily re-evaluation exists for.
    await prisma.subnet.update({
      where: { id: inSubnetId },
      data: { fortigateDevice: OUT_DEVICE_NAME },
    });
    const summary = await applyOneRegion(region);
    expect(summary.subnetsRemoved).toBe(1);
    const tags = await tagsOf(inSubnetId);
    expect(tags).not.toContain(`region:${REGION_NAME}`);
    // The operator's own tag is not ours to strip.
    expect(tags).toContain("operator-set");
  });

  it("never strips a hand-applied region tag (no provenance row)", async () => {
    // Tag the OUT-of-region subnet by hand, then reconcile: no provenance row
    // exists for it, so the re-evaluation must leave it alone.
    const handTag = `region:${REGION_NAME}`;
    const row = await prisma.subnet.findUnique({ where: { id: outSubnetId }, select: { tags: true } });
    await prisma.subnet.update({
      where: { id: outSubnetId },
      data: { tags: [...(row?.tags ?? []), handTag] },
    });
    await applyOneRegion(region);
    expect(await tagsOf(outSubnetId)).toContain(handTag);
  });

  it("map-save review strips a stale region tag from an out-of-polygon gate, provenance row or not", async () => {
    // The pre-provenance stale-tag case: the Atlanta gate carries the region
    // tag with NO RegionTagAssignment row, and its pin sits outside the
    // polygon. The provenance-bounded reconcile must leave it; the map-save
    // review's gate pass must strip it — and only it.
    const outGate = await prisma.asset.findFirst({
      where: { serialNumber: "FGTTEST0000000002" },
      select: { id: true, tags: true },
    });
    await prisma.asset.update({
      where: { id: outGate!.id },
      data: { tags: [...(outGate!.tags ?? []), `region:${REGION_NAME}`, "operator-note"] },
    });

    const summary = await reviewRegionTagsForMapSave();
    expect(summary.firewallTagsStripped).toBe(1);

    const after = await prisma.asset.findUnique({ where: { id: outGate!.id }, select: { tags: true } });
    expect(after?.tags).not.toContain(`region:${REGION_NAME}`);
    expect(after?.tags).toContain("operator-note");

    // The in-polygon gate gained (and keeps) the tag through the reconcile half.
    const inGate = await prisma.asset.findFirst({
      where: { serialNumber: IN_SERIAL },
      select: { tags: true },
    });
    expect(inGate?.tags).toContain(`region:${REGION_NAME}`);
    // Subnets stay provenance-bounded: the hand-tag protection above still holds.
    expect(await tagsOf(inSubnetId)).toContain(`region:${REGION_NAME}`);
  });
});
