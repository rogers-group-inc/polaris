/**
 * tests/integration/dhcpClaimRunScope.test.ts
 *
 * The DHCP claim ranking (utils/dhcpClaimFreshness.ts) decides which FortiGate
 * speaks for an asset's address. It only arbitrates if every competing gate
 * lands in the SAME ranking state — and in FortiManager mode that is not what
 * happens by default: `syncDhcpSubnets` runs once per managed gate (the
 * `onDeviceComplete` streaming callback), so state held inside that function
 * starts empty for every gate. Each gate then wins its own map uncontested and
 * the address becomes last-gate-to-finish-wins, with the ranking arbitrating
 * nothing. The run's closing call does not repair it either: that one is mode
 * "finalize", and Phases 3-7 are gated to "full" | "skip-deprecation".
 *
 * Prod 2026-09-22: an endpoint whose live-lease gate scored 1 on `seenLeased`
 * lost its address to a gate holding a never-claimed static reservation
 * (score 0) that happened to finish 10 seconds later.
 *
 * The unit tests in tests/unit/dhcpClaimFreshness.test.ts model the ranking;
 * only the real function against a real database shows the SCOPE, because the
 * bug lives in where the state is declared, not in how it compares.
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";
import { createDhcpClaimState } from "../../src/utils/dhcpClaimFreshness.js";

const d = dbDescribe;
const MAC = "AA:BB:CC:00:5C:01";
const HOST = "CLAIM-SCOPE-1";
/** The gate actually holding the client's lease. */
const GATE_LIVE = "CLAIM-SCOPE-LIVE-GW";
/** A gate carrying a static reservation its target has never claimed. */
const GATE_STALE = "CLAIM-SCOPE-STALE-GW";
const IP_LIVE = "10.81.0.10";
const IP_STALE = "10.82.0.10";
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
  const owned = await prisma.assetMacAddress.findMany({ where: { mac: MAC }, select: { assetId: true } });
  const ids = [...new Set(owned.map((m) => m.assetId))];
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
  await prisma.asset.deleteMany({
    where: { OR: [{ macAddress: MAC }, { hostname: { contains: "CLAIM-SCOPE", mode: "insensitive" } }] },
  });
  const intgs = await prisma.integration.findMany({ where: { name: "claim-scope-test" }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  const intg = await prisma.integration.create({
    data: { type: "fortimanager", name: "claim-scope-test", config: {}, enabled: true },
  });
  integrationId = intg.id;
});

/**
 * One gate's DHCP view. `seenLeased` is the ranking's most decisive key: true
 * means the gate's DHCP monitor confirmed the binding is being held right now,
 * false is configuration the target has never claimed.
 */
function dhcpEntry(device: string, ipAddress: string, seenLeased: boolean) {
  return {
    device,
    interfaceName: "internal",
    ipAddress,
    macAddress: MAC,
    hostname: HOST,
    type: "dhcp-reservation" as const,
    seenLeased,
  };
}

/** A DiscoveryResult carrying one gate's DHCP entries and nothing else. */
function resultWith(dhcpEntries: any[], device: string) {
  return {
    subnets: [], devices: [], interfaceIps: [],
    dhcpEntries,
    deviceInventory: [], inventoryDevices: [],
    knownDeviceNames: [device], knownDeviceSerials: [],
    fortiSwitches: [], fortiAps: [], vips: [],
    switchMacTable: [], arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [], apInventoriedDevices: [], vipInventoriedDevices: [],
    dhcpReservationsInventoriedDevices: [], dhcpLeasesInventoriedDevices: [],
  } as any;
}

/**
 * One gate's sync, exactly as the FMG `onDeviceComplete` callback issues it:
 * mode "skip-deprecation", one gate's result, and the run's shared claim state.
 */
const gateSync = (device: string, ipAddress: string, seenLeased: boolean, claimState?: ReturnType<typeof createDhcpClaimState>) =>
  syncDhcpSubnets(
    integrationId, "claim-scope-test", "fortimanager",
    resultWith([dhcpEntry(device, ipAddress, seenLeased)], device),
    "tester", "skip-deprecation", undefined, undefined, claimState,
  );

async function seedAsset(): Promise<string> {
  const a = await prisma.asset.create({
    data: { hostname: HOST, macAddress: MAC, assetType: "workstation", status: "active", ipAddress: IP_LIVE },
  });
  return a.id;
}

const readIp = (id: string) =>
  prisma.asset.findUnique({ where: { id }, select: { ipAddress: true, ipSource: true, learnedLocation: true } });

d("DHCP claim ranking spans the per-gate syncs of one FMG run", () => {
  it("the live-lease gate keeps the address when the stale gate syncs LAST", async () => {
    // The prod ordering: the gate with real evidence finishes first, and the
    // gate holding a never-claimed reservation follows ten seconds later.
    const id = await seedAsset();
    const claimState = createDhcpClaimState();
    await gateSync(GATE_LIVE, IP_LIVE, true, claimState);
    await gateSync(GATE_STALE, IP_STALE, false, claimState);

    const after = await readIp(id);
    expect(after?.ipAddress).toBe(IP_LIVE);
    expect(after?.ipSource).toBe(GATE_LIVE);
    expect(after?.learnedLocation).toBe(GATE_LIVE);
  });

  it("the live-lease gate takes the address when it syncs last, over a stale incumbent", async () => {
    // The mirror ordering. Together these two are the real assertion: the
    // outcome must not depend on which gate finished last.
    const id = await seedAsset();
    await prisma.asset.update({ where: { id }, data: { ipAddress: IP_STALE, ipSource: GATE_STALE } });
    const claimState = createDhcpClaimState();
    await gateSync(GATE_STALE, IP_STALE, false, claimState);
    await gateSync(GATE_LIVE, IP_LIVE, true, claimState);

    const after = await readIp(id);
    expect(after?.ipAddress).toBe(IP_LIVE);
    expect(after?.ipSource).toBe(GATE_LIVE);
  });

  it("without the shared state each gate wins uncontested — the bug this guards", async () => {
    // The pre-fix shape, kept as the counter-example the fix is defined
    // against: omitting the run state gives every gate its own empty ranking,
    // so the last one to finish takes the address whatever its evidence.
    const id = await seedAsset();
    await gateSync(GATE_LIVE, IP_LIVE, true);
    await gateSync(GATE_STALE, IP_STALE, false);

    const after = await readIp(id);
    expect(after?.ipAddress).toBe(IP_STALE);
    expect(after?.ipSource).toBe(GATE_STALE);
  });
});
