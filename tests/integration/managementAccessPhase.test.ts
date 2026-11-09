/**
 * tests/integration/managementAccessPhase.test.ts
 *
 * Sync Phase 13.6 through the real `syncDhcpSubnets`: it WRITES the
 * management-access summaries each gate's own discovery pass built
 * (`DiscoveryResult.managementAccess`) onto Asset.managementAccess, joined by
 * serial through the AssetSource rows discovery wrote — and makes no device or
 * FortiManager call to do it. Until 2026-11 this phase re-read every gate after
 * the run (up to five whole tables per gate, plus a management-IP lookup per
 * gate in direct mode).
 *
 * Skips cleanly when DATABASE_URL isn't reachable (tests/integration/_helpers).
 */

import { it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import { syncDhcpSubnets } from "../../src/services/discovery/discoveryEngine.js";

// The Fortinet transports call `tlsFetch`, not the global fetch — route it to
// the global so the spy below sees any read this phase might make.
vi.mock("../../src/utils/tlsDispatcher.js", () => ({
  tlsFetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
  insecureTlsDispatcher: () => ({}),
}));

const d = dbDescribe;
const INTEGRATION = "ma136-test";
const GATE = "MA136-SITEA-FW";
const GATE_SN = "FG100FTK13600001";
const SW_SN = "S124FTF136000001";
const AP_SN = "FP231FTF13600001";
let integrationId = "";
const ids = { gate: "", sw: "", ap: "" };

const summary = (source: string, protocols: string[] | null, extra: Record<string, unknown> = {}) => ({
  source, interfaceName: null, profileName: null, mgmtIp: null, protocols,
  https: !!protocols?.includes("https"), ssh: !!protocols?.includes("ssh"), snmp: !!protocols?.includes("snmp"),
  checkedAt: "2026-11-09T12:00:00.000Z", ...extra,
});

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
  const assets = await prisma.asset.findMany({ where: { hostname: { startsWith: "MA136-" } }, select: { id: true } });
  if (assets.length) await prisma.asset.deleteMany({ where: { id: { in: assets.map((a) => a.id) } } });
  const intgs = await prisma.integration.findMany({ where: { name: INTEGRATION }, select: { id: true } });
  if (intgs.length) {
    await prisma.conflict.deleteMany({ where: { integrationId: { in: intgs.map((i) => i.id) } } });
    await prisma.integration.deleteMany({ where: { id: { in: intgs.map((i) => i.id) } } });
  }
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  // A real-looking FMG config, so a stray live read would have somewhere to go.
  const intg = await prisma.integration.create({
    data: {
      type: "fortimanager", name: INTEGRATION, enabled: true,
      config: { host: "fmg.ma136.invalid", apiUser: "u", apiToken: "t", useProxy: true, mgmtInterface: "mgmt" },
    },
  });
  integrationId = intg.id;
  const make = async (hostname: string, serialNumber: string, assetType: string, sourceKind: string, role: string) => {
    const a = await prisma.asset.create({
      data: {
        hostname, serialNumber, assetType: assetType as any, status: "active", manufacturer: "Fortinet",
        discoveredByIntegrationId: integrationId,
        fortinetTopology: { role, deviceName: hostname, controllerFortigate: GATE },
        managementAccess: summary("old", ["https", "ssh"]) as any,
      },
    });
    // Upsert: a row may already exist for the serial (left by an earlier run
    // whose asset went, or written by an asset-create hook).
    await prisma.assetSource.upsert({
      where: { sourceKind_externalId: { sourceKind, externalId: serialNumber } },
      create: { assetId: a.id, sourceKind, externalId: serialNumber, integrationId },
      update: { assetId: a.id, integrationId },
    });
    return a.id;
  };
  ids.gate = await make(GATE, GATE_SN, "firewall", "fortigate-firewall", "fortigate");
  ids.sw = await make("MA136-IDF-1", SW_SN, "switch", "fortiswitch", "fortiswitch");
  ids.ap = await make("MA136-AP-1", AP_SN, "access_point", "fortiap", "fortiap");
});

afterEach(() => { vi.unstubAllGlobals(); });

function run(managementAccess: unknown) {
  return {
    subnets: [], interfaceIps: [], dhcpEntries: [], deviceInventory: [],
    devices: [{ name: GATE, hostname: GATE, serial: GATE_SN, model: "FortiGate-100F", mgmtIp: "10.136.0.1" }],
    inventoryDevices: [GATE], knownDeviceNames: [GATE], knownDeviceSerials: [GATE_SN],
    fortiSwitches: [{
      device: GATE, deviceSerial: GATE_SN, name: "MA136-IDF-1", serial: SW_SN,
      ipAddress: "10.136.0.10", fgtInterface: "fortilink", osVersion: "7.4.5", state: "Authorized", connected: true,
    }],
    fortiAps: [{ device: GATE, deviceSerial: GATE_SN, name: "MA136-AP-1", serial: AP_SN, ipAddress: "10.136.0.20" }],
    vips: [], switchMacTable: [], arpTable: [], arpQueriedDevices: [],
    cmdbSwitchSerials: [], cmdbApSerials: [],
    switchInventoriedDevices: [GATE], apInventoriedDevices: [GATE],
    managementAccess,
  } as any;
}

const accessOf = async (id: string) =>
  ((await prisma.asset.findUnique({ where: { id }, select: { managementAccess: true } }))?.managementAccess ?? null) as any;

d("sync Phase 13.6: writes discovery's management-access summaries, reads nothing", { timeout: 60_000 }, () => {
  it("writes each summary onto the asset its serial belongs to, with no network call", async () => {
    const fetchSpy = vi.fn(async () => { throw new Error("Phase 13.6 must not call a device or FortiManager"); });
    vi.stubGlobal("fetch", fetchSpy);

    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", run([
      { serial: GATE_SN, summary: summary("firewall-interface", ["ping", "https"], { interfaceName: "mgmt", mgmtIp: "10.136.0.1" }) },
      { serial: SW_SN, summary: summary("fortiswitch", ["https", "ping", "snmp"], { profileName: "default" }) },
      { serial: AP_SN, summary: summary("fortiap-profile", null, { profileName: "FAP231F-default" }) },
    ]), "tester", "finalize-scoped");

    expect(await accessOf(ids.gate)).toMatchObject({ source: "firewall-interface", protocols: ["ping", "https"], ssh: false, mgmtIp: "10.136.0.1" });
    expect(await accessOf(ids.sw)).toMatchObject({ source: "fortiswitch", protocols: ["https", "ping", "snmp"], snmp: true });
    // Unknown is written as unknown — the UI then offers both verbs, unverified.
    expect(await accessOf(ids.ap)).toMatchObject({ source: "fortiap-profile", protocols: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a device the run did not summarize keeps what it had", async () => {
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", run([
      { serial: GATE_SN, summary: summary("firewall-interface", ["ping"]) },
    ]), "tester", "finalize-scoped");

    expect((await accessOf(ids.gate)).protocols).toEqual(["ping"]);
    expect(await accessOf(ids.sw)).toMatchObject({ source: "old", protocols: ["https", "ssh"] });
    expect(await accessOf(ids.ap)).toMatchObject({ source: "old", protocols: ["https", "ssh"] });
  });

  it("a run that carries no summaries writes nothing", async () => {
    await syncDhcpSubnets(integrationId, INTEGRATION, "fortimanager", run(undefined), "tester", "finalize-scoped");
    expect((await accessOf(ids.gate)).source).toBe("old");
  });
});
