/**
 * tests/integration/scopedGateFinalize.test.ts
 *
 * Business rule 142 through the real `syncDhcpSubnets`: Discover Now on one
 * gate runs the whole finalize, narrowed to that gate.
 *
 *  - Phase 12: the dependency tree is rebuilt, so a switch swapped in behind
 *    the gate is parented on the click (it used to wait for the next full run).
 *  - Phase 2a: a chassis replaced under the scoped gate's name is retired —
 *    but a firewall belonging to ANOTHER gate, even one the roster no longer
 *    lists, is never judged by a scoped run.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const INTEGRATION = "sg142-test";
const GATE = "SG142-SITEA-FW";
const OTHER_GATE = "SG142-SITEB-FW";     // gone from the roster — a FULL finalize would retire it
const NEW_GATE_SN = "FG100FTK14200001";  // the chassis FMG now reports for GATE
const OLD_GATE_SN = "FG100FTK14200009";  // the chassis it replaced, same name
const OTHER_GATE_SN = "FG100FTK14200002";
const NEW_SW_SN = "S124FTF142000001";
let integrationId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await prisma.$disconnect();
});

async function cleanup(): Promise<void> {
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: "SG142-" } }, select: { id: true } });
  const assetIds = assets.map((a) => a.id);
  // AssetDependencyParent rows cascade with their assets.
  if (assetIds.length) await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
  const intgs = await prisma.integration.findMany({ where: { name: INTEGRATION }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

const ids = { newGate: "", oldGate: "", otherGate: "", newSwitch: "" };

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: INTEGRATION, config: {}, enabled: true },
  });
  integrationId = intg.id;
  const fw = async (hostname: string, serialNumber: string) => (await prisma.asset.create({
    data: {
      hostname, serialNumber, assetType: "firewall", status: "active", manufacturer: "Fortinet",
      discoveredByIntegrationId: integrationId,
      fortinetTopology: { role: "fortigate", deviceName: hostname },
    },
  })).id;
  ids.newGate = await fw(GATE, NEW_GATE_SN);
  ids.oldGate = await fw(GATE, OLD_GATE_SN);
  ids.otherGate = await fw(OTHER_GATE, OTHER_GATE_SN);
  // The swapped-in switch, as the per-device pass leaves it: stamped with its
  // controller, no dependency rows yet.
  ids.newSwitch = (await prisma.asset.create({
    data: {
      hostname: "SG142-IDF-1", serialNumber: NEW_SW_SN, assetType: "switch", status: "active",
      manufacturer: "Fortinet", discoveredByIntegrationId: integrationId,
      fortinetTopology: { role: "fortiswitch", controllerFortigate: GATE, controllerSerial: NEW_GATE_SN },
    },
  })).id;
});

/** The scoped run's result: one gate, its one switch, the whole roster's identities. */
function scopedRun() {
  return {
    subnets: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [],
    devices: [{ name: GATE, hostname: GATE, serial: NEW_GATE_SN, model: "FortiGate-100F", mgmtIp: "10.142.0.1" }],
    inventoryDevices: [GATE],
    knownDeviceNames: [GATE], knownDeviceSerials: [NEW_GATE_SN],
    fortiSwitches: [{
      device: GATE, deviceSerial: NEW_GATE_SN, name: "SG142-IDF-1", serial: NEW_SW_SN,
      ipAddress: "10.142.0.10", fgtInterface: "fortilink", osVersion: "7.4.5", state: "Authorized", connected: true,
    }],
    fortiAps: [], vips: [], switchMacTable: [], arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [GATE], apInventoriedDevices: [],
  } as any;
}

const statusOf = async (id: string) => (await prisma.asset.findUnique({ where: { id }, select: { status: true } }))?.status;

d("finalize-scoped: the full finalize, narrowed to the gate (business rule 142)", { timeout: 60_000 }, () => {
  it("rebuilds the dependency tree: the swapped-in switch is parented under its gate", async () => {
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", scopedRun(), "tester", "finalize-scoped");
    const parents = await prisma.assetDependencyParent.findMany({
      where: { assetId: ids.newSwitch },
      select: { parentAssetId: true, source: true },
    });
    expect(parents).toEqual([{ parentAssetId: ids.newGate, source: "computed" }]);
  });

  it("retires the chassis replaced under the gate's name, and never judges another gate", async () => {
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", scopedRun(), "tester", "finalize-scoped");
    expect(await statusOf(ids.oldGate)).toBe("decommissioned");
    expect(await statusOf(ids.newGate)).toBe("active");
    expect(await statusOf(ids.otherGate)).toBe("active");
    expect(await statusOf(ids.newSwitch)).toBe("active");
    const ev = await prisma.event.findFirst({
      where: { action: "asset.fortigate.decommissioned", resourceId: ids.oldGate },
      select: { details: true },
    });
    expect(ev?.details).toMatchObject({ reason: "chassis-replaced", oldSerial: OLD_GATE_SN });
  });

  it("control: a FULL finalize on the same roster does retire the other gate (what the scoped run must not do)", async () => {
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", scopedRun(), "tester", "finalize");
    expect(await statusOf(ids.otherGate)).toBe("decommissioned");
  });
});
