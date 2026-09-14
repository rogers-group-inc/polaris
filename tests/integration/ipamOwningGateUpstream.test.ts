/**
 * tests/integration/ipamOwningGateUpstream.test.ts
 *
 * IPAM as an upstream source, across its two consumers:
 *
 *   1. `resolveAssetUpstream` — the General tab's Last Seen Firewall row falls
 *      back to the gate that owns the network the asset's address sits in when
 *      NO gate has ever sighted the device, and says it did (`source:
 *      "subnet"`) so the row can't read as evidence it isn't.
 *   2. `syncEndpointDependencyEdges` — the same gate becomes the endpoint's
 *      dependency parent (`detectedVia: "subnet"`), last of four tiers, so a
 *      device nothing can observe still suppresses behind its gate.
 *
 * What needs a real database here is the CONTAINMENT plus rule 41's gate
 * resolution: the subnet names its gate by chassis serial and by FortiManager
 * device name, and neither is the gate's hostname. The freshness gate on the
 * asset's address claim (rule 40) is the other half — a recycled address must
 * not parent a departed device to whoever serves that range now.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resolveAssetUpstream } from "../../src/services/assetUpstreamService.js";
import { recomputeDependencyTree } from "../../src/services/dependencyTreeService.js";
import { dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const GATE_SERIAL = "FG100F0000000001";
const FMG_DEVICE_NAME = "SITE-A-FGT-PRIMARY";
const CIDR = "10.42.8.0/24";
const IP = "10.42.8.50";

let blockId = "";
let gate = "";
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
  await prisma.assetDependencyParent.deleteMany();
  await prisma.assetFortigateSighting.deleteMany();
  await prisma.assetIpHistory.deleteMany();
  await prisma.assetSource.deleteMany();
  await prisma.asset.deleteMany();
  await prisma.subnet.deleteMany();
  await prisma.ipBlock.deleteMany();

  blockId = (
    await prisma.ipBlock.create({ data: { name: "Site A", cidr: "10.42.0.0/16", ipVersion: "v4" } })
  ).id;

  // The gate's hostname deliberately differs from BOTH the serial and the FMG
  // device name the subnet records — a hostname match would find nothing, which
  // is the failure rule 41 exists to prevent.
  gate = (
    await prisma.asset.create({
      data: {
        hostname: "fgt-a.example.internal",
        serialNumber: GATE_SERIAL,
        assetType: "firewall",
        status: "active",
        ipAddress: "10.42.8.1",
        monitored: true,
        fortinetTopology: { deviceName: FMG_DEVICE_NAME } as any,
      },
    })
  ).id;

  await prisma.subnet.create({
    data: {
      blockId,
      cidr: CIDR,
      name: "Site A user VLAN",
      fortigateSerial: GATE_SERIAL,
      fortigateDevice: FMG_DEVICE_NAME,
    },
  });

  // An asset with an address and nothing else: no switch, no AP, no sighting.
  // This is exactly the row that could never be placed before.
  endpoint = (
    await prisma.asset.create({
      data: {
        hostname: "AD-WORKSTATION-7",
        assetType: "workstation",
        status: "active",
        ipAddress: IP,
        ipSource: "manual", // operator-owned claim — never expires (rule 40)
        lastSeen: new Date(),
      },
    })
  ).id;
});

d("Last Seen Firewall — the IPAM fallback", () => {
  it("names the gate that owns the containing network when nothing has sighted the device", async () => {
    const r = await resolveAssetUpstream(endpoint);
    expect(r).not.toBeNull();
    expect(r!.firewall).not.toBeNull();
    expect(r!.firewall!.source).toBe("subnet");
    expect(r!.firewall!.asset?.id).toBe(gate);
    expect(r!.firewall!.subnetCidr).toBe(CIDR);
    // An inference has no moment — the row must not print a "last seen" time.
    expect(r!.firewall!.lastSeen).toBeUndefined();
    expect(r!.visibility.subnetGate).toBe(true);
  });

  it("a real sighting outranks it, and carries its timestamp", async () => {
    const integrationId = (
      await prisma.integration.create({
        data: { name: "FMG", type: "fortimanager", config: {} as any, enabled: true },
      })
    ).id;
    await prisma.assetFortigateSighting.create({
      data: {
        assetId: endpoint,
        integrationId,
        fortigateDevice: FMG_DEVICE_NAME,
        source: "dhcp_lease",
        lastSeen: new Date("2026-09-01T12:00:00Z"),
      },
    });

    const r = await resolveAssetUpstream(endpoint);
    expect(r!.firewall!.source).toBe("sighting");
    expect(r!.firewall!.name).toBe(FMG_DEVICE_NAME);
    expect(r!.firewall!.lastSeen).toBe("2026-09-01T12:00:00.000Z");
    expect(r!.firewall!.subnetCidr).toBeUndefined();
  });

  it("is withheld — and says so — from a caller without subnets:read", async () => {
    const r = await resolveAssetUpstream(endpoint, { includeSubnetGate: false });
    expect(r!.firewall).toBeNull();
    expect(r!.visibility.subnetGate).toBe(false);
  });

  it("answers nothing for an address in no known network", async () => {
    await prisma.asset.update({ where: { id: endpoint }, data: { ipAddress: "192.0.2.77" } });
    const r = await resolveAssetUpstream(endpoint);
    expect(r!.firewall).toBeNull();
  });

  it("answers nothing when the owning gate has no Asset row", async () => {
    await prisma.assetDependencyParent.deleteMany();
    await prisma.asset.delete({ where: { id: gate } });
    const r = await resolveAssetUpstream(endpoint);
    expect(r!.firewall).toBeNull();
  });
});

d("Endpoint dependency parent — the IPAM tier", () => {
  // recomputeDependencyTree runs the infra half and then the endpoint half
  // (syncEndpointDependencyEdges) on the same inventory — the discovery-finalize
  // cadence in one call, which is what the reconciler actually does.
  const syncEndpoints = () => recomputeDependencyTree();

  it("parents an otherwise unplaceable endpoint to its network's owning gate", async () => {
    await syncEndpoints();
    const rows = await prisma.assetDependencyParent.findMany({
      where: { assetId: endpoint },
      select: { parentAssetId: true, detectedVia: true, source: true },
    });
    expect(rows).toEqual([
      { parentAssetId: gate, detectedVia: "subnet", source: "endpoint" },
    ]);
  });

  it("refuses a stale discovered claim on the address", async () => {
    // The departed-laptop case: the row still records the address, but nothing
    // has re-asserted it inside CLAIM_FRESH_DAYS. Parenting it to whoever
    // serves that range today would suppress its alerts behind an unrelated
    // gate, so the tier declines and the endpoint keeps no parent at all.
    const old = new Date(Date.now() - 30 * 86_400_000);
    await prisma.asset.update({
      where: { id: endpoint },
      data: { ipSource: "fortigate", ipOverride: null, lastSeen: old },
    });
    // The AssetIpHistory row is what claimIsFresh consults FIRST (the db.ts
    // extension bumps it on every write staging ipAddress, so it tracks
    // discovery cadence rather than change). Age it too, or the claim is
    // current no matter how old Asset.lastSeen is.
    await prisma.assetIpHistory.updateMany({
      where: { assetId: endpoint },
      data: { lastSeen: old },
    });

    await syncEndpoints();
    const rows = await prisma.assetDependencyParent.findMany({ where: { assetId: endpoint } });
    expect(rows).toEqual([]);
  });

  it("a sighting still wins — an observation outranks the inference", async () => {
    const integrationId = (
      await prisma.integration.create({
        data: { name: "FMG", type: "fortimanager", config: {} as any, enabled: true },
      })
    ).id;
    const other = await prisma.asset.create({
      data: {
        hostname: "fgt-b.example.internal",
        serialNumber: "FG100F0000000002",
        assetType: "firewall",
        status: "active",
        ipAddress: "10.43.8.1",
        fortinetTopology: { deviceName: "SITE-B-FGT" } as any,
      },
    });
    await prisma.assetFortigateSighting.create({
      data: {
        assetId: endpoint,
        integrationId,
        fortigateDevice: "SITE-B-FGT",
        source: "dhcp_lease",
        lastSeen: new Date(),
      },
    });

    await syncEndpoints();
    const rows = await prisma.assetDependencyParent.findMany({
      where: { assetId: endpoint },
      select: { parentAssetId: true, detectedVia: true },
    });
    expect(rows).toEqual([{ parentAssetId: other.id, detectedVia: "sighting" }]);
  });

  it("is idempotent — a second pass rewrites nothing", async () => {
    await syncEndpoints();
    const again = await syncEndpoints();
    expect(again.endpointEdges).toBe(1);
    const rows = await prisma.assetDependencyParent.findMany({
      where: { assetId: endpoint },
      select: { parentAssetId: true, detectedVia: true },
    });
    expect(rows).toEqual([{ parentAssetId: gate, detectedVia: "subnet" }]);
  });
});
