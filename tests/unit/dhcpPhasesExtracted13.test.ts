/**
 * tests/unit/dhcpPhasesExtracted13.test.ts — syncDhcpSubnets Phase 3b, the
 * FortiSwitch / FortiAP fan-out, now
 * src/services/discovery/dhcp/managedSwitchesAps.ts (CQ-B060 slice 14). Pins
 * the create path and the per-class monitoring policy (credential stamp,
 * monitored sweep, operator override), the controller claims recorded for the
 * caller's flush (rule 83), the reservation at the device's address (and the
 * conflict when an operator's row there is not the device's own), an
 * unauthorized switch landing in storage, and an AP's LLDP / radio
 * persistence. The projection is stubbed to read the observed blob; the rest
 * of the phase against a real database: fortiswitchGateMacPairing,
 * fortiapUnauthorizedPairing, serialHostnameGhostMerge, renamedControllerSweep.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  assetCreate: stubbed(prisma.asset.create),
  assetUpdate: stubbed(prisma.asset.update),
  sourceDeleteMany: stubbed(prisma.assetSource.deleteMany),
  resCreate: stubbed(prisma.reservation.create),
};

const m = vi.hoisted(() => ({
  logEvent: vi.fn(),
  logCreated: vi.fn(),
  logUpdated: vi.fn(),
  releaseDns: vi.fn(),
  lldp: vi.fn(),
  invalidateLldp: vi.fn(),
  radios: vi.fn(),
  reconcileMacs: vi.fn(),
  isGhost: vi.fn(),
  mergeGhost: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: m.logEvent,
  snapshotMaterialAssetFields: (a: Record<string, unknown>) => ({ ...a }),
  logDiscoveryAssetCreated: m.logCreated,
  logDiscoveryAssetUpdated: m.logUpdated,
}));
vi.mock("../../src/services/dnsResolvedReservationService.js", () => ({ releaseDnsResolvedAt: m.releaseDns }));
vi.mock("../../src/services/monitoringService.js", () => ({ persistManagedApLldpNeighbors: m.lldp, invalidateLldpMatchCache: m.invalidateLldp }));
vi.mock("../../src/services/apRadioService.js", () => ({ persistApRadioInventory: m.radios }));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacs }));
vi.mock("../../src/services/assetGhostMergeService.js", () => ({ isMergeableEndpointGhost: m.isGhost, mergeEndpointGhostIntoAsset: m.mergeGhost }));
// The projection reads the observed blob back out, so the asset carries what the device reported.
vi.mock("../../src/utils/assetProjection.js", () => ({
  projectAssetFromSources: (rows: Array<{ observed: Record<string, any> }>) => {
    const o = rows[0]?.observed ?? {};
    return {
      projected: {
        hostname: o.switchId ?? o.name ?? null, serialNumber: o.serial ?? null, ipAddress: o.mgmtIp ?? null,
        manufacturer: null, model: o.model ?? null, osVersion: o.osVersion ?? null, learnedLocation: o.controllerFortigate ?? null,
        os: null, latitude: null, longitude: null, snmpLocation: null, learnedAddress: null,
      },
    };
  },
}));

const { syncManagedSwitchesAndAps } = await import("../../src/services/discovery/dhcp/managedSwitchesAps.js");

const NOW = "2026-11-10T12:00:00.000Z";
const OFF = { enabled: false, snmpCredentialId: null, sshCredentialId: null, addAsMonitored: false, stampCredentialId: null };
let nextId = 0;
beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  nextId = 0;
  db.assetCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `d${++nextId}`, ...data }));
  db.assetUpdate.mockResolvedValue({});
  db.sourceDeleteMany.mockResolvedValue({ count: 0 });
  db.resCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `r${++nextId}`, ...data }));
  m.isGhost.mockResolvedValue(false);
});

function index(assets: Array<Record<string, any>> = []) {
  const rows = [...assets];
  return {
    rows,
    findBySerial: (s: string) => rows.find((a) => a.serialNumber === s),
    findByMac: () => undefined,
    findByEntry: () => undefined,
    findById: (id: string) => rows.find((a) => a.id === id),
    add: (a: any) => rows.push(a),
    remove: vi.fn(),
    reindex: vi.fn(),
  };
}

function run(resultOver: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const state = {
    result: { fortiSwitches: [], fortiAps: [], dhcpEntries: [], deviceInventory: [], arpTable: [], ...resultOver } as never,
    activeResMap: new Map<string, any>(), assetIdx: index() as never,
    assetNames: [] as string[], reservationNames: [] as string[], controllerClaims: [] as any[], now: NOW,
    switchMonitorCfg: { ...OFF }, apMonitorCfg: { ...OFF },
    findSubnetForIp: (ip: string) => (ip.startsWith("10.2.") ? { id: "mgmt" } : undefined),
    reservationKey: (s: string, ip: string) => `${s}|${ip}`,
    projectRefLabel: "FortiManager Integration",
    infraSourcesOf: () => [], infraPriorObserved: () => null, applyInfraSourceInMemory: vi.fn(), noteChangeBaseline: vi.fn(),
    upsertConflict: vi.fn(async () => undefined), upsertFortinetInfraAssetSource: vi.fn(async () => undefined),
    integrationId: "i1", integrationName: "FMG", integrationType: "fortimanager", integrationLabel: "FortiManager",
    actor: "system", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: syncManagedSwitchesAndAps(state as never) };
}
const sw = (over: Record<string, unknown> = {}) => ({
  name: "IDF-1", serial: "S108EP0000000001", ipAddress: "10.2.0.11", device: "SITE-A-FW", deviceSerial: "FGT60F0000000001",
  fgtInterface: "fortilink", osVersion: "v7.4.4", state: "Authorized", connected: true, joinTime: 1_700_000_000,
  ...over,
});
const ap = (over: Record<string, unknown> = {}) => ({
  name: "AP-LOBBY", serial: "FP231F0000000001", ipAddress: "10.2.0.21", device: "SITE-A-FW", deviceSerial: "FGT60F0000000001",
  model: "FAP-231F", status: "online", authorizationState: "authorized",
  ...over,
});

describe("Phase 3b — FortiSwitches", () => {
  it("creates a switch, records its source and controller claim, and reserves its address", async () => {
    const { state, done } = run({ fortiSwitches: [sw()] });
    await done;
    const data = db.assetCreate.mock.calls[0][0].data;
    expect(data).toMatchObject({
      hostname: "IDF-1", serialNumber: "S108EP0000000001", ipAddress: "10.2.0.11", ipSource: "SITE-A-FW",
      assetType: "switch", model: "FortiSwitch", status: "active", lastSeenSource: "discovery",
      tags: ["fortiswitch", "auto-discovered"], notes: "Auto-discovered from FortiGate SITE-A-FW via fortilink via FortiManager",
    });
    expect(data.monitored).toBeUndefined(); // class policy off
    expect(state.upsertFortinetInfraAssetSource).toHaveBeenCalledWith("fortiswitch", "d1", "i1", "S108EP0000000001", expect.objectContaining({ kind: "fortiswitch", controllerFortigate: "SITE-A-FW" }), new Date(NOW), new Date(NOW), "FMG");
    expect(state.controllerClaims).toEqual([{ assetId: "d1", deviceSerial: "S108EP0000000001", sourceKind: "fortiswitch", controllerDevice: "SITE-A-FW", controllerSerial: "FGT60F0000000001", integrationId: "i1" }]);
    expect(db.resCreate.mock.calls[0][0].data).toMatchObject({ subnetId: "mgmt", ipAddress: "10.2.0.11", hostname: "IDF-1", owner: "network-team", sourceType: "fortiswitch" });
    expect(state.reservationNames).toEqual(["10.2.0.11 (IDF-1)"]);
    expect(state.assetNames).toEqual(["IDF-1"]);
  });

  it("an unauthorized switch lands in storage", async () => {
    await run({ fortiSwitches: [sw({ state: "Unauthorized" })] }).done;
    expect(db.assetCreate.mock.calls[0][0].data.status).toBe("storage");
  });

  it("the class policy stamps its credential and monitored on create", async () => {
    await run({ fortiSwitches: [sw()] }, { switchMonitorCfg: { ...OFF, enabled: true, addAsMonitored: true, stampCredentialId: "cred-snmp" } }).done;
    expect(db.assetCreate.mock.calls[0][0].data).toMatchObject({ monitorCredentialId: "cred-snmp", monitored: true });
  });

  it("on an existing switch: sweeps monitored off, keeps an operator's credential, and honours an override", async () => {
    const existing = (over: Record<string, unknown>) => ({
      id: "e1", serialNumber: "S108EP0000000001", hostname: "IDF-1", ipAddress: "10.2.0.11", status: "active", assetType: "switch",
      macAddress: null, macAddresses: [], monitored: true, monitorOverride: false, monitorCredentialId: "cred-mine", fortinetTopology: {}, ...over,
    });
    const cfg = { ...OFF, enabled: true, addAsMonitored: false, stampCredentialId: "cred-snmp" };
    await run({ fortiSwitches: [sw()] }, { switchMonitorCfg: cfg, assetIdx: index([existing({})]) as never }).done;
    const data = db.assetUpdate.mock.calls[0][0].data;
    expect(data.monitored).toBe(false);
    expect(data.monitorCredentialId).toBeUndefined();

    db.assetUpdate.mockClear();
    await run({ fortiSwitches: [sw()] }, { switchMonitorCfg: cfg, assetIdx: index([existing({ monitorOverride: true })]) as never }).done;
    expect(db.assetUpdate.mock.calls[0][0].data.monitored).toBeUndefined();
  });

  it("an operator's manual row at the address raises a conflict unless it is this device's own", async () => {
    const theirs = { id: "m1", sourceType: "manual", hostname: "printer", macAddress: null };
    const { state, done } = run({ fortiSwitches: [sw()] }, { activeResMap: new Map([["mgmt|10.2.0.11", theirs]]) });
    await done;
    expect(state.upsertConflict).toHaveBeenCalledWith("m1", "i1", expect.objectContaining({ sourceType: "fortiswitch", hostname: "IDF-1" }), theirs);
    expect(db.resCreate).not.toHaveBeenCalled();

    const own = { id: "m2", sourceType: "manual", hostname: "idf-1", macAddress: null };
    const second = run({ fortiSwitches: [sw()] }, { activeResMap: new Map([["mgmt|10.2.0.11", own]]) });
    await second.done;
    expect(second.state.upsertConflict).not.toHaveBeenCalled();
  });
});

describe("Phase 3b — FortiAPs", () => {
  it("creates an AP, records its claim, reserves its address, and persists its LLDP and radios", async () => {
    const lldpNeighbors = [{ systemName: "IDF-1", portId: "port7" }];
    const radios = [{ band: "5GHz", channel: 36 }];
    const { state, done } = run({ fortiAps: [ap({ lldpNeighbors, radios })] });
    await done;
    expect(db.assetCreate.mock.calls[0][0].data).toMatchObject({ hostname: "AP-LOBBY", serialNumber: "FP231F0000000001", assetType: "access_point" });
    expect(state.controllerClaims).toEqual([expect.objectContaining({ assetId: "d1", sourceKind: "fortiap", controllerDevice: "SITE-A-FW" })]);
    expect(m.lldp).toHaveBeenCalledWith("d1", lldpNeighbors, new Date(NOW));
    expect(m.invalidateLldp).toHaveBeenCalled();
    expect(m.radios).toHaveBeenCalledWith("d1", radios, "fortios", new Date(NOW));
    expect(db.resCreate.mock.calls[0][0].data).toMatchObject({ ipAddress: "10.2.0.21", sourceType: "fortinap" });
  });

  it("a failing device is logged and the next one still syncs", async () => {
    db.assetCreate.mockRejectedValueOnce(new Error("boom"));
    const { state, done } = run({ fortiSwitches: [sw(), sw({ name: "IDF-2", serial: "S108EP0000000002", ipAddress: "10.2.0.12" })] });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", expect.stringContaining("boom"));
    expect(state.assetNames).toEqual(["IDF-2"]);
  });
});
