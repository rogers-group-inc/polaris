/**
 * tests/integration/renamedControllerSweep.test.ts
 *
 * Business rule 41(b) through the real `syncDhcpSubnets`. A FortiGate renamed
 * in FortiManager (moved to a new site) re-stamps only the switches it still
 * manages; the ones it left behind kept the OLD controller name, which Phase 2b
 * never found in its inventoried set again, so they stayed active forever.
 *
 * Now the controller is resolved through `controllerSerial` to the gate's
 * current name, and a child whose controller is in the roster under neither
 * name nor serial is an orphan. A gate still in the roster but not read this
 * run keeps its children, and a scoped run never judges orphans.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

const d = dbDescribe;
const INTEGRATION = "rc41b-test";
const GATE_SN = "FG100FTK41B00001";
const OLD_NAME = "RC41B-SITEA-FW";
const NEW_NAME = "RC41B-SITEB-FW";
const UNREAD_GATE = "RC41B-UNREAD-FW";
const GONE_GATE = "RC41B-GONE-FW";
const SERIALS = {
  moved:     "S124FTF41B000001", // went with the gate: reported live under the new name
  leftBehind:"S124FTF41B000002", // stayed at the old site, removed from the gate
  orphan:    "S124FTF41B000003", // controller gone from FMG (name-only stamp)
  unread:    "S124FTF41B000004", // controller in the roster, inventory not read
};
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
  await prisma.asset.deleteMany({
    where: { OR: [
      { serialNumber: { in: [...Object.values(SERIALS), GATE_SN] } },
      { hostname: { startsWith: "RC41B-" } },
    ] },
  });
  const intgs = await prisma.integration.findMany({ where: { name: INTEGRATION }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

async function seedSwitch(key: keyof typeof SERIALS, topo: Record<string, unknown>): Promise<string> {
  const a = await prisma.asset.create({
    data: {
      hostname: `RC41B-SW-${key}`, serialNumber: SERIALS[key], assetType: "switch", status: "active",
      manufacturer: "Fortinet", discoveredByIntegrationId: integrationId,
      fortinetTopology: { role: "fortiswitch", ...topo },
    },
  });
  return a.id;
}

let ids: Record<keyof typeof SERIALS, string>;

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: INTEGRATION, config: {}, enabled: true },
  });
  integrationId = intg.id;
  ids = {
    moved:      await seedSwitch("moved",      { controllerFortigate: OLD_NAME, controllerSerial: GATE_SN }),
    leftBehind: await seedSwitch("leftBehind", { controllerFortigate: OLD_NAME, controllerSerial: GATE_SN }),
    orphan:     await seedSwitch("orphan",     { controllerFortigate: GONE_GATE }),
    unread:     await seedSwitch("unread",     { controllerFortigate: UNREAD_GATE }),
  };
});

/** The run after the rename: the gate answers as NEW_NAME and reports one switch. */
function renamedRun() {
  return {
    subnets: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [],
    devices: [{ name: NEW_NAME, hostname: NEW_NAME, serial: GATE_SN, model: "FortiGate-100F", mgmtIp: "10.41.0.1" }],
    inventoryDevices: [NEW_NAME],
    knownDeviceNames: [NEW_NAME, UNREAD_GATE], knownDeviceSerials: [GATE_SN],
    fortiSwitches: [{
      device: NEW_NAME, deviceSerial: GATE_SN, name: "RC41B-SW-moved", serial: SERIALS.moved,
      ipAddress: "10.41.0.10", fgtInterface: "fortilink", osVersion: "7.4.5", state: "Authorized", connected: true,
    }],
    fortiAps: [], vips: [], switchMacTable: [], arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [NEW_NAME], apInventoriedDevices: [],
  } as any;
}

const statusOf = async (id: string) => (await prisma.asset.findUnique({ where: { id }, select: { status: true } }))?.status;

d("Phase 2b after a controller rename (business rule 41(b))", { timeout: 60_000 }, () => {
  it("decommissions what the renamed gate left behind, keeps what it still reports", async () => {
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", renamedRun(), "tester", "full");
    expect(await statusOf(ids.moved)).not.toBe("decommissioned");
    expect(await statusOf(ids.leftBehind)).toBe("decommissioned");
    const ev = await prisma.event.findFirst({
      where: { action: "asset.fortiswitch.decommissioned", resourceId: ids.leftBehind },
      select: { details: true },
    });
    expect(ev?.details).toMatchObject({ reason: "missing-from-controller", controllerFortigate: NEW_NAME, renamedFrom: OLD_NAME });
  });

  it("decommissions an orphan whose controller left the roster, keeps one whose gate was not read", async () => {
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", renamedRun(), "tester", "full");
    expect(await statusOf(ids.orphan)).toBe("decommissioned");
    expect(await statusOf(ids.unread)).not.toBe("decommissioned");
    const ev = await prisma.event.findFirst({
      where: { action: "asset.fortiswitch.decommissioned", resourceId: ids.orphan },
      select: { details: true },
    });
    expect(ev?.details).toMatchObject({ reason: "controller-not-in-roster", controllerFortigate: GONE_GATE });
  });

  it("spares an orphan another gate still has in its CMDB", async () => {
    const r = renamedRun();
    r.cmdbSwitchSerials = [{ device: NEW_NAME, serial: SERIALS.orphan }];
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", r, "tester", "full");
    expect(await statusOf(ids.orphan)).not.toBe("decommissioned");
  });

  it("a scoped run judges the renamed gate's children but never an orphan", async () => {
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", renamedRun(), "tester", "finalize-scoped");
    expect(await statusOf(ids.leftBehind)).toBe("decommissioned");
    expect(await statusOf(ids.orphan)).not.toBe("decommissioned");
  });
});
