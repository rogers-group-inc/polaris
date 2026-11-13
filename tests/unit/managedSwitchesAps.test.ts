/**
 * tests/unit/managedSwitchesAps.test.ts — the own suite for
 * src/services/discovery/dhcp/managedSwitchesAps.ts (syncDhcpSubnets Phase
 * 3b, CQ-T010).
 *
 * Complements dhcpPhasesExtracted13.test.ts (the CREATE path, the class policy
 * on create, the controller claims, the reservation / conflict at the
 * address, an unauthorized switch in storage, an AP's LLDP and radios) and
 * the real-database suites fortiswitchGateMacPairing, fortiapUnauthorizedPairing,
 * serialHostnameGhostMerge and renamedControllerSweep.
 *
 * Adds the UPDATE path and the matching ladder, which the stub-backed suite
 * never reaches: the gate-MAC pairing (rules 91(e) / 91(g)) feeding the MAC
 * rung, the serial-mismatch guard (an RMA'd unit never binds to the old
 * asset), the name-only AP rung (never bare IP), the retype of an adopted
 * endpoint asset and its fortigate-endpoint source sweep, the MAC list
 * backfill, resurrection only when connected / online, the maintenance and
 * operator status carve-outs, acquiredAt only moving earlier, lastSeen only
 * on presence, attribution, every cell of the class-monitor stamp, the
 * endpoint-ghost sweep (merge, refusal, failure), the AP's DHCP-hostname
 * fallback, lastSeenSwitch and its change baseline, and the failure paths
 * that must not stop the phase.
 *
 * The projection is stubbed to read the observed blob back (as in suite 13),
 * so the update path's projected writes are what the device reported.
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
  ipRefresh: vi.fn(),
}));
vi.mock("../../src/services/assetIpHistoryService.js", () => ({ refreshIpHistoryLastSeen: m.ipRefresh }));
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
vi.mock("../../src/utils/assetProjection.js", () => ({
  projectAssetFromSources: (rows: Array<{ observed: Record<string, any> }>) => {
    const o = rows[0]?.observed ?? {};
    return {
      projected: {
        hostname: o.switchId ?? o.name ?? null, serialNumber: o.serial ?? null, ipAddress: o.mgmtIp ?? null,
        manufacturer: null, model: o.kind === "fortiap" ? o.model ?? null : null, osVersion: o.osVersion ?? null, learnedLocation: null,
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
  m.mergeGhost.mockResolvedValue({ adoptedMac: null, transferredMonitored: false });
});

/** An AssetIndex over plain rows: serial, MAC and entry (hostname / IP) lookups like the engine's. */
function index(assets: Array<Record<string, any>> = []) {
  const rows = [...assets];
  return {
    rows,
    findBySerial: (s: string) => rows.find((a) => a.serialNumber === s),
    findByMac: (mac: string) => rows.find((a) => a.macAddress === mac),
    findByEntry: vi.fn((_mac: unknown, name?: string, ip?: string, opts?: { allowIpFallback?: boolean }) =>
      rows.find((a) => (name && a.hostname === name) || (ip && opts?.allowIpFallback !== false && a.ipAddress === ip))),
    findById: (id: string) => rows.find((a) => a.id === id),
    add: (a: any) => rows.push(a),
    remove: vi.fn((a: any) => { const i = rows.indexOf(a); if (i >= 0) rows.splice(i, 1); }),
    reindex: vi.fn(),
  };
}

function run(resultOver: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const state = {
    result: { fortiSwitches: [], fortiAps: [], dhcpEntries: [], deviceInventory: [], arpTable: [], ...resultOver } as never,
    activeResMap: new Map<string, any>(), assetIdx: index() as any,
    assetNames: [] as string[], reservationNames: [] as string[], controllerClaims: [] as any[], now: NOW,
    switchMonitorCfg: { ...OFF }, apMonitorCfg: { ...OFF },
    findSubnetForIp: (ip: string) => (ip.startsWith("10.2.") ? { id: "mgmt" } : undefined),
    reservationKey: (s: string, ip: string) => `${s}|${ip}`,
    projectRefLabel: "FortiManager Integration",
    infraSourcesOf: vi.fn((): any[] => []), infraPriorObserved: vi.fn(() => null), applyInfraSourceInMemory: vi.fn(), noteChangeBaseline: vi.fn(),
    upsertConflict: vi.fn(async () => undefined), upsertFortinetInfraAssetSource: vi.fn(async (..._a: any[]) => undefined),
    integrationId: "i1", integrationName: "FMG", integrationType: "fortimanager", integrationLabel: "FortiManager",
    actor: "system", syncLog: vi.fn(),
    ...over,
  };
  // The update path projects from the run's source map: hand it the blob just upserted.
  state.infraSourcesOf.mockImplementation(() => {
    const call = state.applyInfraSourceInMemory.mock.calls.at(-1);
    return call ? [{ sourceKind: call[1], inferred: false, observed: call[3] }] : [];
  });
  return { state, done: syncManagedSwitchesAndAps(state as never) };
}

const sw = (over: Record<string, unknown> = {}) => ({
  name: "IDF-1", serial: "S108EP0000000001", ipAddress: "10.2.0.11", device: "SITE-A-FW", deviceSerial: "FGT60F0000000001",
  fgtInterface: "fortilink", osVersion: "v7.4.4", state: "Authorized", connected: true, joinTime: 1_700_000_000,
  ...over,
});
const ap = (over: Record<string, unknown> = {}) => ({
  name: "AP-LOBBY", serial: "FP231F0000000001", ipAddress: "10.2.0.21", baseMac: "", device: "SITE-A-FW", deviceSerial: "FGT60F0000000001",
  model: "FAP-231F", status: "online", authorizationState: "authorized",
  ...over,
});
const existingSwitch = (over: Record<string, unknown> = {}): Record<string, any> => ({
  id: "e1", serialNumber: "S108EP0000000001", hostname: "IDF-1", ipAddress: "10.2.0.11", status: "active", assetType: "switch",
  macAddress: null, macAddresses: [], monitored: false, monitorOverride: false, monitorCredentialId: null,
  discoveredByIntegrationId: "i1", acquiredAt: null, lastSeen: null, fortinetTopology: {}, ...over,
});
const existingAp = (over: Record<string, unknown> = {}): Record<string, any> => ({
  ...existingSwitch({ id: "e2", serialNumber: "FP231F0000000001", hostname: "AP-LOBBY", ipAddress: "10.2.0.21", assetType: "access_point" }),
  ...over,
});
const lease = (ip: string, mac: string, hostname = "") => ({ device: "SITE-A-FW", interfaceName: "fortilink", ipAddress: ip, macAddress: mac, hostname, type: "dhcp-lease" });
const updateData = (i = 0) => db.assetUpdate.mock.calls[i][0].data as Record<string, any>;

// ─── FortiSwitch: matching ───────────────────────────────────────────────────

describe("FortiSwitch — matching an existing asset", () => {
  it("pairs the switch with the MAC its own gate leased at connecting_from (rule 91(g)) and adopts a serial-less endpoint by it", async () => {
    const orphan = existingSwitch({ id: "ep1", serialNumber: null, hostname: "S108EP0000000001", assetType: "other", macAddress: "00:11:22:33:44:55" });
    const idx = index([orphan]);
    const { state, done } = run({ fortiSwitches: [sw()], dhcpEntries: [lease("10.2.0.11", "00-11-22-33-44-55")] }, { assetIdx: idx });
    await done;
    expect(db.assetCreate).not.toHaveBeenCalled();
    expect(db.assetUpdate.mock.calls[0][0].where).toEqual({ id: "ep1" });
    const data = updateData();
    // Retyped, and the stale endpoint provenance swept.
    expect(data.assetType).toBe("switch");
    expect(db.sourceDeleteMany).toHaveBeenCalledWith({ where: { assetId: "ep1", sourceKind: "fortigate-endpoint" } });
    expect(data).toMatchObject({ hostname: "IDF-1", serialNumber: "S108EP0000000001", ipAddress: "10.2.0.11", ipSource: "SITE-A-FW" });
    // The blob records the paired MAC.
    expect(state.upsertFortinetInfraAssetSource.mock.calls[0][4]).toMatchObject({ baseMac: "00:11:22:33:44:55" });
    expect(state.assetNames).toEqual(["IDF-1 (updated)"]);
  });

  it("an address two managed devices on one gate both report pairs neither", async () => {
    const { state, done } = run({
      fortiSwitches: [sw()],
      fortiAps: [ap({ ipAddress: "10.2.0.11", serial: "" })],
      dhcpEntries: [lease("10.2.0.11", "00:11:22:33:44:55")],
    });
    await done;
    expect(state.upsertFortinetInfraAssetSource.mock.calls[0][4].baseMac).toBeNull();
    expect(db.assetCreate.mock.calls[0][0].data.macAddress).toBeNull();
  });

  it("serial-mismatch guard: a name match carrying ANOTHER serial (RMA'd unit) is not bound — a new asset is created", async () => {
    const old = existingSwitch({ id: "old", serialNumber: "S108EP0000000999" });
    const { done } = run({ fortiSwitches: [sw()] }, { assetIdx: index([old]) });
    await done;
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(db.assetCreate).toHaveBeenCalledTimes(1);
  });

  it("the serial compare is case- and whitespace-blind", async () => {
    const same = existingSwitch({ id: "same", serialNumber: " s108ep0000000001 " });
    const idx = index([same]);
    idx.findBySerial = () => undefined; // force the name rung
    await run({ fortiSwitches: [sw()] }, { assetIdx: idx }).done;
    expect(db.assetCreate).not.toHaveBeenCalled();
    expect(db.assetUpdate.mock.calls[0][0].where).toEqual({ id: "same" });
  });
});

// ─── FortiSwitch: the update payload ─────────────────────────────────────────

describe("FortiSwitch — updating", () => {
  it("records the source, the claim and the topology stamp; mirrors them in memory and reindexes", async () => {
    const row = existingSwitch();
    const idx = index([row]);
    const { state, done } = run({ fortiSwitches: [sw({ uplinkPhysicalPort: "port47", description: "  b:HQ f:2  " })] }, { assetIdx: idx });
    await done;
    expect(state.infraPriorObserved).toHaveBeenCalledWith("e1", "fortiswitch", "S108EP0000000001");
    expect(state.controllerClaims).toEqual([expect.objectContaining({ assetId: "e1", sourceKind: "fortiswitch", controllerSerial: "FGT60F0000000001" })]);
    expect(updateData().fortinetTopology).toEqual({
      role: "fortiswitch", controllerFortigate: "SITE-A-FW", controllerSerial: "FGT60F0000000001", uplinkInterface: "fortilink",
      state: "Authorized", uplinkPhysicalPort: "port47", deviceDescription: "b:HQ f:2",
    });
    expect(row.fortinetTopology).toEqual(updateData().fortinetTopology);
    expect(idx.reindex).toHaveBeenCalledWith(row);
    expect(m.logUpdated).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }), updateData(), "e1", "IDF-1", expect.objectContaining({ sourceKind: "fortiswitch" }));
  });

  it("status: written with statusChangedAt only when it changes; never over maintenance", async () => {
    // Unchanged → not re-sent at all (the prune drops what the row holds).
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch()]) }).done;
    expect("status" in updateData()).toBe(false);
    expect(updateData().statusChangedAt).toBeUndefined();

    db.assetUpdate.mockClear();
    await run({ fortiSwitches: [sw({ state: "Unauthorized" })] }, { assetIdx: index([existingSwitch()]) }).done;
    expect(updateData()).toMatchObject({ status: "storage", statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" });

    db.assetUpdate.mockClear();
    await run({ fortiSwitches: [sw({ state: "Unauthorized" })] }, { assetIdx: index([existingSwitch({ status: "maintenance" })]) }).done;
    expect("status" in updateData()).toBe(false);
  });

  it("a decommissioned switch comes back only when it is connected", async () => {
    const off = existingSwitch({ status: "decommissioned" });
    const { state, done } = run({ fortiSwitches: [sw({ connected: false })] }, { assetIdx: index([off]) });
    await done;
    expect("status" in updateData()).toBe(false);
    expect(updateData().lastSeen).toBeUndefined();
    expect(off.status).toBe("decommissioned");
    expect(state.assetNames).toEqual(["IDF-1 (updated — reactivated)"]);

    db.assetUpdate.mockClear();
    const back = existingSwitch({ status: "decommissioned" });
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([back]) }).done;
    expect(updateData()).toMatchObject({ status: "active", lastSeen: new Date(NOW), lastSeenSource: "discovery" });
    expect(back.status).toBe("active");
  });

  it("acquiredAt moves only earlier, to the FortiLink join time", async () => {
    const join = new Date(1_700_000_000 * 1000);
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch({ acquiredAt: "2024-01-01T00:00:00Z" })]) }).done;
    expect(updateData().acquiredAt).toEqual(join);
    db.assetUpdate.mockClear();
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch({ acquiredAt: "2023-01-01T00:00:00Z" })]) }).done;
    expect(updateData().acquiredAt).toBeUndefined();
  });

  it("stamps the integration when another one discovered the switch, and mirrors it", async () => {
    const row = existingSwitch({ discoveredByIntegrationId: "other" });
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([row]) }).done;
    expect(updateData().discoveredByIntegrationId).toBe("i1");
    expect(row.discoveredByIntegrationId).toBe("i1");
    db.assetUpdate.mockClear();
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch()]) }).done;
    expect("discoveredByIntegrationId" in updateData()).toBe(false);
  });

  it("MAC backfill: a new MAC is added to the list and seeds macAddress; a known one only has lastSeen / source / device bumped", async () => {
    const fresh = existingSwitch();
    await run({ fortiSwitches: [sw()], dhcpEntries: [lease("10.2.0.11", "00:11:22:33:44:55")] }, { assetIdx: index([fresh]) }).done;
    expect(updateData().macAddress).toBe("00:11:22:33:44:55");
    expect(m.reconcileMacs).toHaveBeenCalledWith("e1", [{ mac: "00:11:22:33:44:55", lastSeen: NOW, source: "fmg-discovery", device: "SITE-A-FW" }]);

    db.assetUpdate.mockClear();
    m.reconcileMacs.mockClear();
    const known = existingSwitch({
      macAddress: "AA:AA:AA:AA:AA:AA",
      macAddresses: [{ mac: "AA:AA:AA:AA:AA:AA", lastSeen: "2026-11-01T00:00:00.000Z", source: "manual" }, { mac: "00:11:22:33:44:55", lastSeen: "2026-10-01T00:00:00.000Z", source: "dhcp" }],
    });
    await run({ fortiSwitches: [sw()], dhcpEntries: [lease("10.2.0.11", "00:11:22:33:44:55")] }, { assetIdx: index([known]) }).done;
    expect(updateData().macAddress).toBeUndefined(); // the asset already has a primary
    const list = m.reconcileMacs.mock.calls[0][1];
    expect(list[0]).toEqual({ mac: "00:11:22:33:44:55", lastSeen: NOW, source: "fmg-discovery", device: "SITE-A-FW" });
    expect(list).toHaveLength(2);
  });

  it("no paired MAC: no MAC write and no reconcile", async () => {
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch()]) }).done;
    expect(updateData().macAddress).toBeUndefined();
    expect(m.reconcileMacs).not.toHaveBeenCalled();
  });

  it("a failing source upsert is logged and the asset is still updated", async () => {
    const upsert = vi.fn(async () => { throw new Error("unique violation"); });
    const { state, done } = run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch()]), upsertFortinetInfraAssetSource: upsert });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to upsert fortiswitch AssetSource for IDF-1: unique violation");
    expect(state.controllerClaims).toEqual([]);
    expect(db.assetUpdate).toHaveBeenCalledTimes(1);
  });
});

// ─── Skip unchanged writes (efficiency audit) ────────────────────────────────

describe("unchanged fields are left out of the write", () => {
  // A row as the run's full-row preload carries it: pin columns present and empty.
  const unpinned = { ipOverride: false, ipBlankPinned: false, primaryAddressIp: null, hostnameOverride: null, ipSource: "SITE-A-FW", osVersion: "v7.4.4" };

  it("an unchanged, monitored switch is not written at all; its IP history is still refreshed", async () => {
    // First pass learns the topology blob the switch produces…
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch(unpinned)]) }).done;
    const topology = updateData().fortinetTopology;
    db.assetUpdate.mockClear();
    m.ipRefresh.mockClear();
    // …a row already holding all of it (monitored: discovery may not bump lastSeen).
    const row = existingSwitch({ ...unpinned, monitored: true, fortinetTopology: topology, lastSeen: new Date(NOW), acquiredAt: new Date(1_700_000_000_000) });
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([row]), switchMonitorCfg: { ...OFF, addAsMonitored: true } }).done;
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(m.ipRefresh).toHaveBeenCalledWith([{ assetId: "e1", ip: "10.2.0.11", source: "SITE-A-FW" }]);
  });

  it("only the changed key is sent; a pinned row keeps its IP", async () => {
    await run({ fortiSwitches: [sw({ osVersion: "v7.4.5" })] }, { assetIdx: index([existingSwitch(unpinned)]) }).done;
    const d = updateData();
    expect(d.osVersion).toBe("v7.4.5");
    expect("ipAddress" in d).toBe(false);
    expect("serialNumber" in d).toBe(false);
    // hostnameOverride null → hostname equal to the row's is dropped too.
    expect("hostname" in d).toBe(false);

    db.assetUpdate.mockClear();
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch({ ...unpinned, ipOverride: true })]) }).done;
    expect(updateData()).toMatchObject({ ipAddress: "10.2.0.11", ipSource: "SITE-A-FW" });
  });

  it("assetType is still written when the branch retypes the in-memory row first", async () => {
    await run({ fortiSwitches: [sw()] }, { assetIdx: index([existingSwitch({ ...unpinned, assetType: "other" })]) }).done;
    expect(updateData().assetType).toBe("switch");
  });
});

// ─── The class-monitor stamp ─────────────────────────────────────────────────

describe("class-monitor stamp on an existing switch", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> = [
    ["off + unmonitored → nothing", { ...OFF }, { monitored: false }, {}],
    ["off + monitored → swept off", { ...OFF }, { monitored: true }, { monitored: false }],
    ["addAsMonitored only → monitored, no credential", { ...OFF, addAsMonitored: true }, { monitored: false }, { monitored: true }],
    ["enabled, no credential to stamp → monitored only", { ...OFF, enabled: true, addAsMonitored: true }, { monitored: false }, { monitored: true }],
    ["same credential → nothing re-sent (pruned as unchanged)", { ...OFF, enabled: true, addAsMonitored: true, stampCredentialId: "c1" }, { monitored: true, monitorCredentialId: "c1" }, {}],
    ["no credential yet → stamped", { ...OFF, enabled: true, addAsMonitored: true, stampCredentialId: "c1" }, { monitored: true }, { monitorCredentialId: "c1" }],
    ["operator's other credential → kept, sweep still applies", { ...OFF, enabled: true, addAsMonitored: true, stampCredentialId: "c1" }, { monitored: false, monitorCredentialId: "mine" }, { monitored: true }],
    ["override → monitored left alone", { ...OFF, enabled: true, addAsMonitored: true, stampCredentialId: "c1" }, { monitored: false, monitorOverride: true }, { monitorCredentialId: "c1" }],
  ];
  it.each(cases)("%s", async (_label, cfg, existing, want) => {
    await run({ fortiSwitches: [sw({ connected: false })] }, { switchMonitorCfg: cfg, assetIdx: index([existingSwitch(existing)]) }).done;
    const d = updateData();
    const got = Object.fromEntries(["monitored", "monitorCredentialId"].filter((k) => k in d).map((k) => [k, d[k]]));
    expect(got).toEqual(want);
  });
});

// ─── Endpoint-ghost sweep ────────────────────────────────────────────────────

describe("endpoint-ghost sweep", () => {
  it("merges a serial-hostnamed fortigate-endpoint ghost into the switch, adopting its MAC and monitored bit", async () => {
    const row = existingSwitch({ macAddress: null });
    const ghost = { id: "g1", hostname: "S108EP0000000001", serialNumber: null, ipAddress: "10.2.0.11", macAddress: null };
    const idx = index([row, ghost]);
    idx.findByEntry.mockImplementation((_m: unknown, name?: string) => (name === "S108EP0000000001" ? ghost : undefined) as any);
    m.isGhost.mockResolvedValue(true);
    m.mergeGhost.mockResolvedValue({ adoptedMac: "00:11:22:33:44:55", transferredMonitored: true });
    const { state, done } = run({ fortiSwitches: [sw()] }, { assetIdx: idx });
    await done;
    expect(m.mergeGhost).toHaveBeenCalledWith("e1", "g1");
    expect(idx.remove).toHaveBeenCalledWith(ghost);
    expect(row).toMatchObject({ macAddress: "00:11:22:33:44:55", monitored: true });
    expect(m.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: "asset.duplicate_merged", resourceId: "e1",
      details: { integrationId: "i1", integrationName: "FMG", ghostId: "g1", ghostHostname: "S108EP0000000001", adoptedMac: "00:11:22:33:44:55", transferredMonitored: true },
    }));
    expect(state.syncLog).toHaveBeenCalledWith("info", "Merged duplicate endpoint asset S108EP0000000001 into IDF-1");
  });

  it("never merges a candidate that is not a pure endpoint ghost, nor the device itself", async () => {
    const row = existingSwitch();
    const idx = index([row]);
    idx.findByEntry.mockImplementation((_m: unknown, name?: string) => (name === "S108EP0000000001" ? { id: "real", hostname: "x" } : row) as any);
    m.isGhost.mockResolvedValue(false);
    await run({ fortiSwitches: [sw()] }, { assetIdx: idx }).done;
    expect(m.isGhost).toHaveBeenCalledWith("real");
    expect(m.isGhost).not.toHaveBeenCalledWith("e1");
    expect(m.mergeGhost).not.toHaveBeenCalled();
  });

  it("a merge failure is logged and never fails the device", async () => {
    const idx = index([existingSwitch()]);
    idx.findByEntry.mockImplementation((_m: unknown, name?: string) => (name === "S108EP0000000001" ? { id: "g1", hostname: null } : undefined) as any);
    m.isGhost.mockResolvedValue(true);
    m.mergeGhost.mockRejectedValue(new Error("fk"));
    const { state, done } = run({ fortiSwitches: [sw()] }, { assetIdx: idx });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to merge duplicate endpoint asset g1 into IDF-1: fk");
    expect(state.assetNames).toEqual(["IDF-1 (updated)"]);
  });
});

// ─── Reservations ────────────────────────────────────────────────────────────

describe("the reservation at the device's address", () => {
  it("frees a DNS-resolved placeholder before creating the row", async () => {
    await run({ fortiSwitches: [sw()] }).done;
    expect(m.releaseDns).toHaveBeenCalledWith("mgmt", "10.2.0.11");
    expect(m.releaseDns.mock.invocationCallOrder[0]).toBeLessThan(db.resCreate.mock.invocationCallOrder[0]);
  });

  it("an existing non-manual row is left alone: no conflict, no second row", async () => {
    const leaseRow = { id: "l1", sourceType: "dhcp_lease", hostname: "x", macAddress: null };
    const { state, done } = run({ fortiSwitches: [sw()] }, { activeResMap: new Map([["mgmt|10.2.0.11", leaseRow]]) });
    await done;
    expect(state.upsertConflict).not.toHaveBeenCalled();
    expect(db.resCreate).not.toHaveBeenCalled();
  });

  it("an operator's manual row matching the device by MAC, or one pushed to the gate, is its own", async () => {
    const byMac = { id: "m1", sourceType: "manual", hostname: "other-name", macAddress: "00-11-22-33-44-55" };
    const a = run({ fortiSwitches: [sw()], dhcpEntries: [lease("10.2.0.11", "00:11:22:33:44:55")] }, { activeResMap: new Map([["mgmt|10.2.0.11", byMac]]) });
    await a.done;
    expect(a.state.upsertConflict).not.toHaveBeenCalled();
    const pushed = { id: "m2", sourceType: "manual", hostname: "other-name", macAddress: null, pushedToId: "fgt-1" };
    const b = run({ fortiSwitches: [sw()] }, { activeResMap: new Map([["mgmt|10.2.0.11", pushed]]) });
    await b.done;
    expect(b.state.upsertConflict).not.toHaveBeenCalled();
  });

  it("an address in no known subnet, or no address at all, reserves nothing", async () => {
    await run({ fortiSwitches: [sw({ ipAddress: "172.16.0.5" }), sw({ name: "IDF-2", serial: "S2", ipAddress: "" })] }).done;
    expect(db.resCreate).not.toHaveBeenCalled();
  });

  it("a failing create is logged; the next device is still reserved and the map keeps the new row", async () => {
    db.resCreate.mockRejectedValueOnce(new Error("unique"));
    const { state, done } = run({ fortiSwitches: [sw(), sw({ name: "IDF-2", serial: "S2", ipAddress: "10.2.0.12" })] });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create reservation for FortiSwitch IDF-1 at 10.2.0.11: unique");
    expect(state.reservationNames).toEqual(["10.2.0.12 (IDF-2)"]);
    expect(state.activeResMap.get("mgmt|10.2.0.12")).toMatchObject({ ipAddress: "10.2.0.12" });
  });
});

// ─── FortiAP ─────────────────────────────────────────────────────────────────

describe("FortiAP", () => {
  it("with no address from the controller, takes IP + MAC from a DHCP lease named after it (name, then serial)", async () => {
    const { done } = run({
      fortiAps: [ap({ ipAddress: "", baseMac: "" }), ap({ name: "AP-2", serial: "FP231F0000000002", ipAddress: "", baseMac: "" })],
      dhcpEntries: [lease("10.2.0.31", "AA:BB:CC:00:00:01", "ap-lobby"), lease("10.2.0.32", "AA:BB:CC:00:00:02", "FP231F0000000002")],
    });
    await done;
    expect(db.assetCreate.mock.calls.map((c) => c[0].data.macAddress)).toEqual(["AA:BB:CC:00:00:01", "AA:BB:CC:00:00:02"]);
    expect(db.resCreate.mock.calls.map((c) => [c[0].data.ipAddress, c[0].data.sourceType])).toEqual([["10.2.0.31", "fortinap"], ["10.2.0.32", "fortinap"]]);
  });

  it("an AP's name rung never falls back to bare IP (rule 91(e))", async () => {
    const sameIp = existingAp({ id: "other", serialNumber: null, hostname: "PRINTER", ipAddress: "10.2.0.21" });
    const idx = index([sameIp]);
    await run({ fortiAps: [ap({ serial: "" })] }, { assetIdx: idx }).done;
    expect(idx.findByEntry).toHaveBeenCalledWith(undefined, "AP-LOBBY", undefined, { allowIpFallback: false });
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(db.assetCreate).toHaveBeenCalledTimes(1);
  });

  it("an unauthorized AP created in storage; an authorized one active", async () => {
    await run({ fortiAps: [ap({ authorizationState: "discovered" }), ap({ name: "AP-2", serial: "S2", authorizationState: "authorized" })] }).done;
    expect(db.assetCreate.mock.calls.map((c) => c[0].data.status)).toEqual(["storage", "active"]);
  });

  it.each([
    ["active, now unauthorized → storage", "active", "online", "discovered", "storage"],
    ["storage, now authorized → active", "storage", "online", "authorized", "active"],
    ["blank authorization decides nothing", "storage", "online", "", undefined],
    ["an operator status (e.g. 'retired') is left alone", "retired", "online", "discovered", undefined],
    ["maintenance is left alone", "maintenance", "online", "authorized", undefined],
    ["decommissioned + online → back (authorized)", "decommissioned", "online", "authorized", "active"],
    ["decommissioned + online → back to storage (unauthorized)", "decommissioned", "connected", "discovered", "storage"],
    ["decommissioned + offline stays", "decommissioned", "offline", "authorized", undefined],
  ])("status: %s", async (_l, status, apStatus, auth, want) => {
    const row = existingAp({ status });
    await run({ fortiAps: [ap({ status: apStatus, authorizationState: auth })] }, { assetIdx: index([row]) }).done;
    expect(updateData().status).toBe(want);
    if (want) {
      expect(updateData()).toMatchObject({ statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" });
      expect(row.status).toBe(want);
    }
  });

  it("lastSeen moves only for an online AP; a monitored one is left to the probe", async () => {
    await run({ fortiAps: [ap({ status: "offline" })] }, { assetIdx: index([existingAp()]) }).done;
    expect(updateData().lastSeen).toBeUndefined();
    db.assetUpdate.mockClear();
    await run({ fortiAps: [ap()] }, { assetIdx: index([existingAp()]) }).done;
    expect(updateData()).toMatchObject({ lastSeen: new Date(NOW), lastSeenSource: "discovery" });
    db.assetUpdate.mockClear();
    await run({ fortiAps: [ap()] }, { assetIdx: index([existingAp({ monitored: true })]) }).done;
    expect(updateData().lastSeen).toBeUndefined();
  });

  it("stamps lastSeenSwitch from the LLDP peer, notes the change baseline first, and mirrors it", async () => {
    const row = existingAp();
    const { state, done } = run({ fortiAps: [ap({ peerSwitch: "IDF-1", peerPort: "port7", peerVlan: 10, peerSource: "lldp" })] }, { assetIdx: index([row]) });
    await done;
    expect(state.noteChangeBaseline).toHaveBeenCalledWith(row, ["lastSeenSwitch"]);
    expect(updateData().lastSeenSwitch).toBe("IDF-1/port7");
    expect(row.lastSeenSwitch).toBe("IDF-1/port7");
    expect(updateData().fortinetTopology).toMatchObject({ parentSwitch: "IDF-1", parentPort: "port7", parentVlan: 10, peerSource: "lldp" });
  });

  it("a peer switch with no port writes no lastSeenSwitch", async () => {
    const { state, done } = run({ fortiAps: [ap({ peerSwitch: "IDF-1" })] }, { assetIdx: index([existingAp()]) });
    await done;
    expect(updateData().lastSeenSwitch).toBeUndefined();
    expect(state.noteChangeBaseline).not.toHaveBeenCalled();
  });

  it("retypes an adopted endpoint asset to access_point and sweeps its fortigate-endpoint source", async () => {
    const orphan = existingAp({ id: "ep2", serialNumber: null, hostname: "AP-LOBBY", assetType: "other" });
    await run({ fortiAps: [ap()] }, { assetIdx: index([orphan]) }).done;
    expect(updateData().assetType).toBe("access_point");
    expect(db.sourceDeleteMany).toHaveBeenCalledWith({ where: { assetId: "ep2", sourceKind: "fortigate-endpoint" } });
    expect(updateData()).toMatchObject({ model: "FAP-231F", serialNumber: "FP231F0000000001" });
  });

  it("LLDP and radios are kept only from an online AP that returned them; the cache is dropped only when some AP has neighbours", async () => {
    await run({ fortiAps: [ap({ status: "offline", lldpNeighbors: [{ systemName: "x" }], radios: [{}] }), ap({ name: "AP-2", serial: "S2" })] }).done;
    expect(m.invalidateLldp).toHaveBeenCalledTimes(1);
    expect(m.lldp).not.toHaveBeenCalled();
    expect(m.radios).not.toHaveBeenCalled();
    vi.clearAllMocks();
    await run({ fortiAps: [ap({ lldpNeighbors: [] })] }).done;
    expect(m.invalidateLldp).not.toHaveBeenCalled();
    expect(m.lldp).toHaveBeenCalledWith(expect.any(String), [], new Date(NOW)); // present but empty clears the table
  });

  it("an LLDP or radio persist failure is logged and the AP is still reserved", async () => {
    m.lldp.mockRejectedValue(new Error("lldp down"));
    m.radios.mockRejectedValue(new Error("radio down"));
    const { state, done } = run({ fortiAps: [ap({ lldpNeighbors: [{}], radios: [{}] })] });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to persist LLDP neighbors for FortiAP AP-LOBBY: lldp down");
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to persist radios for FortiAP AP-LOBBY: radio down");
    expect(db.resCreate).toHaveBeenCalledTimes(1);
  });

  it("an operator's manual row at the AP's address that is not the AP raises a 'fortinap' conflict", async () => {
    const theirs = { id: "m1", sourceType: "manual", hostname: "camera", macAddress: null };
    const { state, done } = run({ fortiAps: [ap()] }, { activeResMap: new Map([["mgmt|10.2.0.21", theirs]]) });
    await done;
    expect(state.upsertConflict).toHaveBeenCalledWith("m1", "i1", { hostname: "AP-LOBBY", owner: "network-team", projectRef: "FortiManager Integration", notes: "FortiAP managed by FortiGate SITE-A-FW", sourceType: "fortinap" }, theirs);
  });

  it("an AP with no serial records no source and no controller claim", async () => {
    const { state, done } = run({ fortiAps: [ap({ serial: "" })] });
    await done;
    expect(state.upsertFortinetInfraAssetSource).not.toHaveBeenCalled();
    expect(state.controllerClaims).toEqual([]);
    expect(db.assetCreate).toHaveBeenCalledTimes(1);
  });
});
