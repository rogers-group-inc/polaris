/**
 * tests/unit/firewallAssets.test.ts — the own suite for
 * src/services/discovery/dhcp/firewallAssets.ts (syncDhcpSubnets Phase 3, CQ-T010).
 *
 * Pins one asset per FortiGate and per HA member, matched by serial: the
 * create payload (identity, every interface MAC, the monitored opt-in, the
 * standby's null IP / tags / notes), the HA topology stamp and the managed
 * membership stamp, the update path's projected writes, the hostname / IP
 * fallback for serial-less placeholders only and the serial-mismatch guard
 * (an RMA'd chassis never binds to the old row, compared through
 * normalizeSerialKey), resurrection and lastSeen only on a live read (rule 12),
 * the stale fortigate-endpoint sweep, manual coordinates winning, the MAC
 * merge, every cell of the monitor stamp (override kept, standby swept off),
 * the standby down / restored Events, the SNMP location pull, the
 * address-metavar-over-sysLocation geocode, the geocode-miss batch and the
 * coordinate write-back, and per-device failure isolation.
 *
 * The projection is stubbed to read the observed blob back, and the engine's
 * observed-blob builder is a pass-through, so projected writes are what the
 * device reported.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const m = vi.hoisted(() => ({
  sysLocation: vi.fn(),
  geocode: vi.fn(),
  logGeoFailures: vi.fn(),
  pushCoords: vi.fn(),
  reconcileMacs: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/fortigateLocationService.js", () => ({ fetchFortigateSysLocation: m.sysLocation }));
vi.mock("../../src/services/geocoderService.js", () => ({ geocode: m.geocode, logGeocodeFailureEvents: m.logGeoFailures }));
vi.mock("../../src/services/fortigateCoordPushService.js", () => ({ pushCoordsToFortigate: m.pushCoords }));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacs }));
vi.mock("../../src/utils/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("../../src/utils/assetProjection.js", () => ({
  projectAssetFromSources: (rows: Array<{ sourceKind: string; observed: Record<string, any> }>) => {
    const o = rows.find((r) => r.sourceKind === "fortigate-firewall")?.observed ?? rows[0]?.observed ?? {};
    return {
      projected: {
        hostname: o.hostname ?? null, model: o.model ?? null, osVersion: o.osVersion ?? null,
        manufacturer: o.hostname ? "Fortinet" : null, serialNumber: o.serial ?? null, ipAddress: o.mgmtIp || null,
        latitude: o.snmpGeocodedLatitude ?? o.latitude ?? null, longitude: o.snmpGeocodedLongitude ?? o.longitude ?? null,
        snmpLocation: o.snmpLocation ?? null, learnedAddress: o.metavarAddress ?? null,
        learnedLocation: null, os: null,
      },
    };
  },
}));

import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
const { syncFirewallAssets } = await import("../../src/services/discovery/dhcp/firewallAssets.js");

const db = {
  create: stubbed(prisma.asset.create),
  update: stubbed(prisma.asset.update),
  srcDeleteMany: stubbed(prisma.assetSource.deleteMany),
};

const NOW = "2026-11-13T12:00:00.000Z";
let nextId = 0;

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(m)) f.mockReset();
  nextId = 0;
  db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `fw${++nextId}`, ...data }));
  db.update.mockResolvedValue({});
  db.srcDeleteMany.mockResolvedValue({ count: 1 });
  m.logGeoFailures.mockResolvedValue(0);
  m.geocode.mockResolvedValue({ latitude: null, longitude: null, failure: null, provider: null, cached: false });
  m.reconcileMacs.mockResolvedValue(undefined);
});

function device(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    name: "FGT-HQ", hostname: "fgt-hq", serial: "FG100F0001", model: "FortiGate-100F", osVersion: "7.4.3",
    mgmtIp: "10.0.0.1", mgmtMac: "00:09:0f:aa:bb:01", interfaceMacs: ["00:09:0f:aa:bb:01", "00-09-0F-AA-BB-02", "00:00:00:00:00:00"],
    latitude: null, longitude: null, ...over,
  };
}

function index(assets: Array<Record<string, any>> = []) {
  const rows = [...assets];
  return {
    rows,
    findBySerial: vi.fn((s: string) => rows.find((a) => a.serialNumber === s)),
    findByEntry: vi.fn((_mac: unknown, name?: string, ip?: string) =>
      rows.find((a) => (name && a.hostname === name) || (ip && a.ipAddress === ip))),
    add: vi.fn((a: any) => rows.push(a)),
    reindex: vi.fn(),
  };
}

function run(devices: Array<Record<string, any>>, over: Record<string, unknown> = {}) {
  const state = {
    result: { devices } as never,
    assetIdx: index() as any,
    assetNames: [] as string[],
    now: NOW,
    membershipSwitchByDevice: new Map<string, Set<string>>(),
    membershipSwitchKnown: new Set<string>(),
    membershipApByDevice: new Map<string, Set<string>>(),
    membershipApKnown: new Set<string>(),
    fortigateAddAsMonitored: false,
    pullSnmpLocation: false,
    useSnmpLocationCoords: false,
    pushGeocodedCoords: false,
    latitudeMetavar: "",
    longitudeMetavar: "",
    addressMetavar: "",
    integrationConfig: { host: "fmg" } as Record<string, unknown> | null,
    verboseLogging: false,
    infraSourcesOf: vi.fn((_id: string): any[] => []),
    applyInfraSourceInMemory: vi.fn(),
    dropInfraSourceKindInMemory: vi.fn(),
    buildFortigateFirewallObservedBlob: vi.fn((dev: any, _type: string, _at: Date, ha?: any) => ({ ...dev, ha: ha ?? null })),
    upsertFortigateFirewallAssetSource: vi.fn(async (..._a: any[]) => undefined),
    integrationId: "int1",
    integrationName: "HQ FMG",
    integrationType: "fortimanager",
    integrationLabel: "FortiManager",
    actor: "discovery",
    syncLog: vi.fn(),
    ...over,
  };
  return { state, done: syncFirewallAssets(state as never) };
}

/** Make infraSourcesOf return the firewall row the run just upserted (the engine's in-memory mirror). */
function mirror(state: any) {
  const map = new Map<string, any[]>();
  state.applyInfraSourceInMemory.mockImplementation((id: string, kind: string, ext: string, observed: any) => {
    map.set(id, [...(map.get(id) ?? []).filter((r) => r.sourceKind !== kind), { sourceKind: kind, externalId: ext, inferred: false, observed }]);
  });
  state.infraSourcesOf.mockImplementation((id: string) => map.get(id) ?? []);
  return map;
}

function existing(over: Record<string, unknown> = {}): Record<string, any> {
  return {
    id: "a1", hostname: "fgt-hq", serialNumber: "FG100F0001", ipAddress: "10.0.0.1", assetType: "firewall",
    status: "active", monitored: false, monitorOverride: null, macAddress: null, macAddresses: [],
    learnedLocation: null, coordSource: null, fortinetTopology: null, lastSeen: null, ...over,
  };
}

/** Run the update path for one device against one existing asset, with the source mirror wired. */
async function runUpdate(dev: Record<string, any>, asset: Record<string, any>, over: Record<string, unknown> = {}) {
  const idx = index([asset]);
  const r = run([dev], { assetIdx: idx, ...over });
  mirror(r.state);
  // run() already started; wire the mirror before the first await resolves.
  await r.done;
  return { ...r, idx };
}

// ─── Create path ─────────────────────────────────────────────────────────────

describe("syncFirewallAssets — create a standalone gate", () => {
  it("creates the firewall with its identity, every distinct interface MAC and presence", async () => {
    const { state, done } = run([device()]);
    await done;
    expect(db.create).toHaveBeenCalledTimes(1);
    const data = db.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      ipAddress: "10.0.0.1", ipSource: "fgt-hq", hostname: "fgt-hq", serialNumber: "FG100F0001",
      manufacturer: "Fortinet", model: "FortiGate-100F", osVersion: "7.4.3", assetType: "firewall", status: "active",
      statusChangedBy: "FortiManager", department: "Network Security", learnedLocation: "fgt-hq",
      lastSeenSource: "discovery", discoveredByIntegrationId: "int1",
      macAddress: "00:09:0f:aa:bb:01",
      notes: "Auto-discovered from FortiManager integration", tags: ["fortigate", "auto-discovered"],
      fortinetTopology: { role: "fortigate", deviceName: "FGT-HQ" },
    });
    expect(data.lastSeen).toEqual(new Date(NOW));
    expect(data.macAddressRows.create.map((r: any) => r.mac)).toEqual(["00:09:0F:AA:BB:01", "00:09:0F:AA:BB:02"]);
    expect(data).not.toHaveProperty("monitored");
    expect(state.assetNames).toEqual(["fgt-hq"]);
    expect(state.assetIdx.add).toHaveBeenCalledWith(expect.objectContaining({ id: "fw1" }));
  });

  it("writes the fortigate-firewall source and seeds the in-memory mirror", async () => {
    const { state, done } = run([device()]);
    await done;
    expect(state.upsertFortigateFirewallAssetSource).toHaveBeenCalledWith("fw1", "int1", "FG100F0001", expect.objectContaining({ serial: "FG100F0001" }), new Date(NOW), new Date(NOW));
    expect(state.applyInfraSourceInMemory).toHaveBeenCalledWith("fw1", "fortigate-firewall", "FG100F0001", expect.any(Object), new Date(NOW), new Date(NOW));
    expect(eventLog.logDiscoveryAssetCreated).toHaveBeenCalledWith("fw1", "fgt-hq", { integrationName: "HQ FMG", integrationId: "int1", sourceKind: "fortigate-firewall", actor: "discovery" });
  });

  it("creates the gate monitored when the integration opts in", async () => {
    const { done } = run([device()], { fortigateAddAsMonitored: true });
    await done;
    expect(db.create.mock.calls[0][0].data.monitored).toBe(true);
  });

  it("creates an offline-in-FMG gate with no presence, and its source with a null lastSeen", async () => {
    const { state, done } = run([device({ offline: true })]);
    await done;
    const data = db.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("lastSeen");
    expect(data).not.toHaveProperty("lastSeenSource");
    expect(state.upsertFortigateFirewallAssetSource.mock.calls[0][5]).toBeNull();
    expect(state.buildFortigateFirewallObservedBlob.mock.calls[0][0].offline).toBe(true);
  });

  it("creates a serial-less gate without a source row and without a MAC when none was read", async () => {
    const { state, done } = run([device({ serial: "", mgmtMac: undefined, interfaceMacs: undefined })]);
    await done;
    const data = db.create.mock.calls[0][0].data;
    expect(data.serialNumber).toBeNull();
    expect(data).not.toHaveProperty("macAddress");
    expect(data).not.toHaveProperty("macAddressRows");
    expect(state.upsertFortigateFirewallAssetSource).not.toHaveBeenCalled();
  });

  it("falls back to the device name when the gate reports no hostname", async () => {
    const { done } = run([device({ hostname: "" })]);
    await done;
    expect(db.create.mock.calls[0][0].data).toMatchObject({ hostname: "FGT-HQ", learnedLocation: "FGT-HQ" });
  });

  it("keeps the created asset when its source upsert fails, and says so", async () => {
    const { state, done } = run([device()], { upsertFortigateFirewallAssetSource: vi.fn(async () => { throw new Error("fk"); }) });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Created FortiGate asset fgt-hq but failed to upsert AssetSource row: fk");
    expect(eventLog.logDiscoveryAssetCreated).toHaveBeenCalledTimes(1);
    expect(state.assetIdx.add).toHaveBeenCalledTimes(1);
  });
});

describe("syncFirewallAssets — managed-device membership stamp", () => {
  it("stamps the switch and AP serials the gate's roster answered, keyed by the lower-cased device name", async () => {
    const { done } = run([device()], {
      membershipSwitchKnown: new Set(["fgt-hq"]), membershipSwitchByDevice: new Map([["fgt-hq", new Set(["S1", "S2"])]]),
      membershipApKnown: new Set(["fgt-hq"]),
    });
    await done;
    const topo = db.create.mock.calls[0][0].data.fortinetTopology;
    expect(topo.managedSwitchSerials).toEqual(["S1", "S2"]);
    expect(topo.managedApSerials).toEqual([]);
    expect(typeof topo.managedInventoryAt).toBe("string");
  });

  it("omits the membership fields entirely when no roster answered", async () => {
    const { done } = run([device()]);
    await done;
    const topo = db.create.mock.calls[0][0].data.fortinetTopology;
    expect(topo).not.toHaveProperty("managedSwitchSerials");
    expect(topo).not.toHaveProperty("managedApSerials");
    expect(topo).not.toHaveProperty("managedInventoryAt");
  });
});

describe("syncFirewallAssets — HA clusters", () => {
  const ha = (over: Record<string, unknown> = {}) => device({
    haMode: "a-p",
    haMembers: [
      { serial: "FG100F0001", name: "fgt-hq-a", isPrimary: true, status: "up" },
      { serial: "FG100F0002", name: "fgt-hq-b", isPrimary: false, status: "up" },
    ],
    ...over,
  });

  it("creates one asset per member; only the primary holds the cluster IP and the MACs", async () => {
    const { state, done } = run([ha()], { fortigateAddAsMonitored: true });
    await done;
    expect(db.create).toHaveBeenCalledTimes(2);
    const [p, s] = db.create.mock.calls.map((c) => c[0].data);
    expect(p).toMatchObject({ ipAddress: "10.0.0.1", ipSource: "fgt-hq-a", hostname: "fgt-hq-a", serialNumber: "FG100F0001", monitored: true, macAddress: "00:09:0f:aa:bb:01" });
    expect(p.tags).toEqual(["fortigate", "auto-discovered"]);
    expect(s).toMatchObject({ ipAddress: null, hostname: "fgt-hq-b", serialNumber: "FG100F0002", notes: "Auto-discovered from FortiManager integration (HA standby member)" });
    expect(s.tags).toEqual(["fortigate", "auto-discovered", "ha-standby"]);
    expect(s).not.toHaveProperty("ipSource");
    expect(s).not.toHaveProperty("monitored");
    expect(s).not.toHaveProperty("macAddress");
    expect(state.assetNames).toEqual(["fgt-hq-a (HA primary)", "fgt-hq-b (HA secondary)"]);
  });

  it("stamps the cluster relationship on each member's topology, the cluster IP only on the standby", async () => {
    const { done } = run([ha()]);
    await done;
    const [p, s] = db.create.mock.calls.map((c) => c[0].data.fortinetTopology);
    expect(p).toEqual({ role: "fortigate", deviceName: "FGT-HQ", haMode: "a-p", haRole: "primary", haPeerSerial: "FG100F0002", haMemberStatus: "up" });
    expect(s).toEqual({ role: "fortigate", deviceName: "FGT-HQ", haMode: "a-p", haRole: "secondary", haPeerSerial: "FG100F0001", haMemberStatus: "up", haClusterIp: "10.0.0.1" });
  });

  it("records active-active mode and omits an unknown member status", async () => {
    const { done } = run([ha({ haMode: "a-a", haMembers: [
      { serial: "A", name: "a", isPrimary: true },
      { serial: "B", name: "", isPrimary: false },
    ] })]);
    await done;
    const [p, s] = db.create.mock.calls.map((c) => c[0].data);
    expect(p.fortinetTopology.haMode).toBe("a-a");
    expect(p.fortinetTopology).not.toHaveProperty("haMemberStatus");
    // A nameless standby falls back to the cluster hostname.
    expect(s.hostname).toBe("fgt-hq");
  });

  it("passes the HA context to the observed-blob builder", async () => {
    const { state, done } = run([ha()]);
    await done;
    expect(state.buildFortigateFirewallObservedBlob.mock.calls[0][3]).toEqual({ haMode: "a-p", haRole: "primary", haPeerSerial: "FG100F0002" });
    expect(state.buildFortigateFirewallObservedBlob.mock.calls[0][1]).toBe("fortimanager");
  });

  it("warns at once about a standby first seen already down", async () => {
    const { done } = run([ha({ haMembers: [
      { serial: "FG100F0001", name: "fgt-hq-a", isPrimary: true, status: "up" },
      { serial: "FG100F0002", name: "fgt-hq-b", isPrimary: false, status: "down" },
    ] })]);
    await done;
    const ev = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "asset.ha.standby_down");
    expect(ev).toMatchObject({ resourceId: "fw2", level: "warning", resourceName: "fgt-hq-b" });
    expect(ev?.message).toBe("[HQ FMG] HA standby fgt-hq-b (FG100F0002) reported DOWN in cluster FGT-HQ's HA roster");
  });

  it("raises no standby Event for an offline cluster's cached roster", async () => {
    const { done } = run([ha({ offline: true, haMembers: [
      { serial: "FG100F0001", name: "a", isPrimary: true },
      { serial: "FG100F0002", name: "b", isPrimary: false, status: "down" },
    ] })]);
    await done;
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

// ─── Update path ─────────────────────────────────────────────────────────────

describe("syncFirewallAssets — update by serial", () => {
  it("writes the projected identity, presence and topology, and logs the audit diff", async () => {
    const asset = existing({ hostname: "old-name", model: "FortiGate-60F" });
    const { state, idx } = await runUpdate(device(), asset);
    expect(db.create).not.toHaveBeenCalled();
    const { where, data } = db.update.mock.calls[0][0];
    expect(where).toEqual({ id: "a1" });
    expect(data).toMatchObject({
      learnedLocation: "fgt-hq", fortinetTopology: { role: "fortigate", deviceName: "FGT-HQ" }, discoveredByIntegrationId: "int1",
      hostname: "fgt-hq", model: "FortiGate-100F", osVersion: "7.4.3", manufacturer: "Fortinet", serialNumber: "FG100F0001",
      ipAddress: "10.0.0.1", ipSource: "fgt-hq", lastSeenSource: "discovery",
    });
    expect(data.lastSeen).toEqual(new Date(NOW));
    expect(data).not.toHaveProperty("assetType");
    expect(data).not.toHaveProperty("status");
    const [before, , id, name, ctx] = eventLog.logDiscoveryAssetUpdated.mock.calls[0] as any[];
    expect(before.hostname).toBe("old-name");
    expect(id).toBe("a1");
    expect(name).toBe("fgt-hq");
    expect(ctx).toMatchObject({ sourceKind: "fortigate-firewall", integrationId: "int1" });
    expect(idx.reindex).toHaveBeenCalledWith(asset);
    expect(asset).toMatchObject({ hostname: "fgt-hq", model: "FortiGate-100F", ipAddress: "10.0.0.1" });
    expect(state.assetNames).toEqual(["fgt-hq (updated)"]);
  });

  it("upserts the source before projecting, and mirrors it in memory", async () => {
    const { state } = await runUpdate(device(), existing());
    expect(state.upsertFortigateFirewallAssetSource).toHaveBeenCalledWith("a1", "int1", "FG100F0001", expect.any(Object), new Date(NOW), new Date(NOW));
    expect(state.upsertFortigateFirewallAssetSource.mock.invocationCallOrder[0]).toBeLessThan(db.update.mock.invocationCallOrder[0]);
    expect(state.infraSourcesOf).toHaveBeenCalledWith("a1");
  });

  it("retypes an asset another pathway created as a firewall", async () => {
    await runUpdate(device(), existing({ assetType: "other" }));
    expect(db.update.mock.calls[0][0].data.assetType).toBe("firewall");
  });

  it("resurrects a decommissioned firewall on a live read", async () => {
    const asset = existing({ status: "decommissioned" });
    await runUpdate(device(), asset);
    expect(db.update.mock.calls[0][0].data).toMatchObject({ status: "active", statusChangedAt: new Date(NOW), statusChangedBy: "FortiManager" });
    expect(asset.status).toBe("active");
  });

  it("never resurrects or advances presence from an offline gate's cached config (rule 12)", async () => {
    const { state } = await runUpdate(device({ offline: true }), existing({ status: "decommissioned" }));
    const data = db.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("status");
    expect(data).not.toHaveProperty("lastSeen");
    expect(state.upsertFortigateFirewallAssetSource.mock.calls[0][5]).toBeNull();
  });

  // BUG: the in-memory mirror after the write (`if (existingAsset.status ===
  // "decommissioned") existingAsset.status = "active"`) is unconditional, while the
  // DB write above it only resurrects on a LIVE read. For an offline-in-FMG gate
  // whose asset is decommissioned, the row stays decommissioned in the database but
  // the indexed asset the rest of the run reads says "active" — so a later phase
  // that keys on status (deviceInventory Phase 7 resurrects only a row it sees as
  // decommissioned) acts on a status the database does not hold.
  it.fails("leaves an offline gate's decommissioned asset decommissioned in the in-memory index too", async () => {
    const asset = existing({ status: "decommissioned" });
    await runUpdate(device({ offline: true }), asset);
    expect(asset.status).toBe("decommissioned");
  });

  it("lets polling own presence for a monitored firewall (rule 12)", async () => {
    await runUpdate(device(), existing({ monitored: true }));
    expect(db.update.mock.calls[0][0].data).not.toHaveProperty("lastSeen");
  });

  it("never moves lastSeen backwards", async () => {
    await runUpdate(device(), existing({ lastSeen: new Date("2026-11-14T00:00:00Z") }));
    expect(db.update.mock.calls[0][0].data).not.toHaveProperty("lastSeen");
  });

  it("clamps acquiredAt down to the new lastSeen", async () => {
    await runUpdate(device(), existing({ acquiredAt: new Date("2027-01-01T00:00:00Z") }));
    expect(db.update.mock.calls[0][0].data.acquiredAt).toEqual(new Date(NOW));
  });

  it("keeps going when the source upsert fails", async () => {
    const upsert = vi.fn(async () => { throw new Error("deadlock"); });
    const { state } = await runUpdate(device(), existing(), { upsertFortigateFirewallAssetSource: upsert });
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to upsert fortigate-firewall AssetSource for fgt-hq: deadlock");
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});

describe("syncFirewallAssets — matching", () => {
  it("binds a serial-less placeholder by hostname / management IP", async () => {
    const placeholder = existing({ serialNumber: null, hostname: "fgt-hq" });
    const { idx } = await runUpdate(device(), placeholder);
    expect(idx.findByEntry).toHaveBeenCalledWith(undefined, "fgt-hq", "10.0.0.1");
    expect(db.update.mock.calls[0][0].where).toEqual({ id: "a1" });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("never binds the hostname fallback to an asset carrying a different serial (an RMA'd chassis)", async () => {
    const old = existing({ serialNumber: "FG100F9999" });
    await runUpdate(device(), old);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it("compares serials case- and space-blind through normalizeSerialKey", async () => {
    const asset = existing({ serialNumber: " fg100f0001 " });
    const idx = index([asset]);
    idx.findBySerial.mockReturnValue(undefined);
    const r = run([device()], { assetIdx: idx });
    mirror(r.state);
    await r.done;
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.create).not.toHaveBeenCalled();
  });

  it("never uses the hostname fallback for an HA standby", async () => {
    const lookalike = existing({ serialNumber: null, hostname: "fgt-hq-b", ipAddress: null });
    const idx = index([lookalike]);
    const r = run([device({ haMembers: [
      { serial: "FG100F0001", name: "fgt-hq-a", isPrimary: true },
      { serial: "FG100F0002", name: "fgt-hq-b", isPrimary: false },
    ] })], { assetIdx: idx });
    await r.done;
    // Only the primary consults the fallback.
    expect(idx.findByEntry).toHaveBeenCalledTimes(1);
    expect(db.create).toHaveBeenCalledTimes(2);
  });
});

describe("syncFirewallAssets — sources, coordinates, location fields", () => {
  it("sweeps a stale fortigate-endpoint source and projects without it", async () => {
    const asset = existing({ ipAddress: "10.9.9.9" });
    const idx = index([asset]);
    const r = run([device()], { assetIdx: idx });
    const map = mirror(r.state);
    map.set("a1", [{ sourceKind: "fortigate-endpoint", externalId: "x", inferred: false, observed: { mgmtIp: "10.9.9.9" } }]);
    await r.done;
    expect(db.srcDeleteMany).toHaveBeenCalledWith({ where: { assetId: "a1", sourceKind: "fortigate-endpoint" } });
    expect(r.state.dropInfraSourceKindInMemory).toHaveBeenCalledWith("a1", "fortigate-endpoint");
    expect(db.update.mock.calls[0][0].data.ipAddress).toBe("10.0.0.1");
  });

  it("treats the endpoint sweep as best-effort", async () => {
    db.srcDeleteMany.mockRejectedValue(new Error("gone"));
    const asset = existing();
    const idx = index([asset]);
    const r = run([device()], { assetIdx: idx });
    const map = mirror(r.state);
    map.set("a1", [{ sourceKind: "fortigate-endpoint", externalId: "x", inferred: false, observed: {} }]);
    await r.done;
    expect(db.update).toHaveBeenCalledTimes(1);
    expect(r.state.dropInfraSourceKindInMemory).not.toHaveBeenCalled();
  });

  it("writes device coordinates unless the operator pinned them manually", async () => {
    await runUpdate(device({ latitude: 36.1, longitude: -86.7 }), existing());
    expect(db.update.mock.calls[0][0].data).toMatchObject({ latitude: 36.1, longitude: -86.7 });
    db.update.mockClear();
    await runUpdate(device({ latitude: 36.1, longitude: -86.7 }), existing({ coordSource: "manual" }));
    const data = db.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("latitude");
    expect(data).not.toHaveProperty("longitude");
  });

  it("only touches snmpLocation / learnedAddress when this cycle looked", async () => {
    await runUpdate(device({ metavarAddress: "1 Main St" }), existing());
    const data = db.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("snmpLocation");
    expect(data).not.toHaveProperty("snmpLocationFetchedAt");
    expect(data).not.toHaveProperty("learnedAddress");
  });

  it("clears learnedAddress when an address metavar is configured but empty on the device", async () => {
    await runUpdate(device(), existing(), { addressMetavar: "site_address" });
    expect(db.update.mock.calls[0][0].data.learnedAddress).toBeNull();
  });

  it("keeps the learned location the gate's own hostname even over an earlier value", async () => {
    await runUpdate(device(), existing({ learnedLocation: "Room 101" }));
    expect(db.update.mock.calls[0][0].data.learnedLocation).toBe("fgt-hq");
  });
});

describe("syncFirewallAssets — MAC backfill", () => {
  it("merges every interface MAC, sets the scalar from the management MAC and reconciles the side table", async () => {
    const asset = existing({ macAddresses: [{ mac: "00:09:0F:AA:BB:02", lastSeen: "2026-01-01T00:00:00Z", source: "dhcp" }] });
    await runUpdate(device(), asset);
    const data = db.update.mock.calls[0][0].data;
    expect(data.macAddress).toBe("00:09:0f:aa:bb:01");
    const list = m.reconcileMacs.mock.calls[0][1];
    expect(m.reconcileMacs.mock.calls[0][0]).toBe("a1");
    expect(list.map((e: any) => [e.mac, e.source, e.lastSeen])).toEqual([
      ["00:09:0F:AA:BB:02", "fortigate-firewall", NOW],
      ["00:09:0F:AA:BB:01", "fortigate-firewall", NOW],
    ]);
    expect(asset.macAddress).toBe("00:09:0f:aa:bb:01");
  });

  it("keeps an existing scalar MAC", async () => {
    await runUpdate(device(), existing({ macAddress: "11:22:33:44:55:66" }));
    expect(db.update.mock.calls[0][0].data).not.toHaveProperty("macAddress");
  });

  it("skips the merge when the gate surfaced no usable MAC", async () => {
    await runUpdate(device({ mgmtMac: "00:00:00:00:00:00", interfaceMacs: [] }), existing());
    expect(m.reconcileMacs).not.toHaveBeenCalled();
  });
});

describe("syncFirewallAssets — monitor stamp", () => {
  it.each([
    [true, false, { monitored: true }],
    [false, true, { monitored: false }],
    [true, true, {}],
    [false, false, {}],
  ])("addAsMonitored=%s, currently monitored=%s → %o", async (flag, current, expected) => {
    await runUpdate(device(), existing({ monitored: current }), { fortigateAddAsMonitored: flag });
    const data = db.update.mock.calls[0][0].data;
    if ("monitored" in expected) expect(data.monitored).toBe(expected.monitored);
    else expect(data).not.toHaveProperty("monitored");
  });

  it("keeps an operator's monitor override whatever the integration says", async () => {
    await runUpdate(device(), existing({ monitored: false, monitorOverride: true }), { fortigateAddAsMonitored: true });
    expect(db.update.mock.calls[0][0].data).not.toHaveProperty("monitored");
  });
});

describe("syncFirewallAssets — HA standby on update", () => {
  const pair = (standbyStatus?: string) => device({ haMembers: [
    { serial: "FG100F0001", name: "fgt-hq-a", isPrimary: true, status: "up" },
    { serial: "FG100F0002", name: "fgt-hq-b", isPrimary: false, ...(standbyStatus ? { status: standbyStatus } : {}) },
  ] });

  async function runPair(dev: Record<string, any>, standby: Record<string, any>, over: Record<string, unknown> = {}) {
    const primary = existing({ id: "p1", hostname: "fgt-hq-a" });
    const idx = index([primary, standby]);
    const r = run([dev], { assetIdx: idx, ...over });
    mirror(r.state);
    await r.done;
    const standbyCall = db.update.mock.calls.find((c) => c[0].where.id === standby.id);
    return { ...r, standbyData: standbyCall?.[0].data as Record<string, any> };
  }

  it("nulls the standby's IP and sweeps it off monitoring with its failure streak", async () => {
    const standby = existing({ id: "s1", serialNumber: "FG100F0002", hostname: "fgt-hq-b", ipAddress: "10.0.0.1", monitored: true });
    const { standbyData } = await runPair(pair("up"), standby, { fortigateAddAsMonitored: true });
    expect(standbyData).toMatchObject({ ipAddress: null, ipSource: null, monitored: false, consecutiveFailures: 0 });
    expect(standby.ipAddress).toBeNull();
  });

  it("leaves an already-unmonitored standby's monitor flag alone", async () => {
    const standby = existing({ id: "s1", serialNumber: "FG100F0002", monitored: false });
    const { standbyData } = await runPair(pair("up"), standby, { fortigateAddAsMonitored: true });
    expect(standbyData).not.toHaveProperty("monitored");
  });

  it("warns when the roster first reports the standby down", async () => {
    const standby = existing({ id: "s1", serialNumber: "FG100F0002", fortinetTopology: { haMemberStatus: "up" } });
    await runPair(pair("down"), standby);
    const ev = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "asset.ha.standby_down");
    expect(ev).toMatchObject({ resourceId: "s1", level: "warning" });
  });

  it("logs the recovery when a down standby comes back up", async () => {
    const standby = existing({ id: "s1", serialNumber: "FG100F0002", fortinetTopology: { haMemberStatus: "down" } });
    await runPair(pair("up"), standby);
    const ev = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "asset.ha.standby_restored");
    expect(ev).toMatchObject({ resourceId: "s1", level: "info" });
    expect(ev?.message).toContain("is back UP");
  });

  it("stays quiet while a standby remains down, or has no roster status", async () => {
    await runPair(pair("down"), existing({ id: "s1", serialNumber: "FG100F0002", fortinetTopology: { haMemberStatus: "down" } }));
    await runPair(pair(), existing({ id: "s2", serialNumber: "FG100F0002", fortinetTopology: { haMemberStatus: "down" } }));
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

// ─── Location → coordinates ──────────────────────────────────────────────────

describe("syncFirewallAssets — SNMP location and geocoding", () => {
  it("pulls sysLocation when opted in and stores it with its fetch time, without driving the pin", async () => {
    m.sysLocation.mockResolvedValue("Building 4, Nashville");
    const { done } = run([device()], { pullSnmpLocation: true });
    await done;
    expect(m.sysLocation).toHaveBeenCalledWith({ integration: { id: "int1", type: "fortimanager", config: { host: "fmg" } }, deviceName: "FGT-HQ" });
    expect(m.geocode).not.toHaveBeenCalled();
    const data = db.create.mock.calls[0][0].data;
    expect(data.snmpLocation).toBe("Building 4, Nashville");
    expect(data.snmpLocationFetchedAt).toBeInstanceOf(Date);
  });

  it("does not pull sysLocation without a stored config or for a non-Fortinet integration", async () => {
    await run([device()], { pullSnmpLocation: true, integrationConfig: null }).done;
    await run([device()], { pullSnmpLocation: true, integrationType: "generic" }).done;
    expect(m.sysLocation).not.toHaveBeenCalled();
  });

  it("logs a failed sysLocation pull and still creates the gate", async () => {
    m.sysLocation.mockRejectedValue(new Error("snmp timeout"));
    const { state, done } = run([device()], { pullSnmpLocation: true });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "fgt-hq: SNMP location pull threw — snmp timeout");
    expect(db.create.mock.calls[0][0].data.snmpLocationFetchedAt).toBeInstanceOf(Date);
  });

  it("geocodes sysLocation only when the operator opted into sysLocation coordinates", async () => {
    m.sysLocation.mockResolvedValue("Nashville TN");
    m.geocode.mockResolvedValue({ latitude: 36.16, longitude: -86.78, failure: null, provider: "nominatim", cached: false });
    const { done } = run([device()], { pullSnmpLocation: true, useSnmpLocationCoords: true });
    await done;
    expect(m.geocode).toHaveBeenCalledWith("Nashville TN");
    expect(db.create.mock.calls[0][0].data).toMatchObject({ latitude: 36.16, longitude: -86.78 });
  });

  it("lets a populated address metavar win over sysLocation", async () => {
    m.sysLocation.mockResolvedValue("Nashville TN");
    const { done } = run([device({ metavarAddress: "  1 Main St, Memphis  " })], {
      addressMetavar: "site_address", pullSnmpLocation: true, useSnmpLocationCoords: true,
    });
    await done;
    expect(m.geocode).toHaveBeenCalledWith("1 Main St, Memphis");
    expect(db.create.mock.calls[0][0].data.learnedAddress).toBe("  1 Main St, Memphis  ");
  });

  it("ignores the device's address metavar when no address metavar is configured", async () => {
    const { done } = run([device({ metavarAddress: "1 Main St" })]);
    await done;
    expect(m.geocode).not.toHaveBeenCalled();
    expect(db.create.mock.calls[0][0].data).not.toHaveProperty("learnedAddress");
  });

  it("reports a geocode miss on every member asset in one batch after the loop", async () => {
    const failure = { reason: "no_match", providers: [] };
    m.geocode.mockResolvedValue({ latitude: null, longitude: null, failure, provider: null, cached: false });
    const { state, done } = run([device({ metavarAddress: "Nowhere", haMembers: [
      { serial: "A", name: "a", isPrimary: true }, { serial: "B", name: "b", isPrimary: false },
    ] })], { addressMetavar: "site_address" });
    await done;
    expect(m.logGeoFailures).toHaveBeenCalledTimes(1);
    const entries = m.logGeoFailures.mock.calls[0][0];
    expect(entries.map((e: any) => e.assetId)).toEqual(["fw1", "fw2"]);
    expect(entries[0]).toMatchObject({ query: "Nowhere", source: "address-metavar", failure, integrationId: "int1", actor: "discovery" });
    expect(state.buildFortigateFirewallObservedBlob.mock.calls[0][0].geocodeFailure).toEqual({ query: "Nowhere", source: "address-metavar", reason: "no_match" });
  });

  it("flushes an empty miss batch when every lookup resolved", async () => {
    await run([device()]).done;
    expect(m.logGeoFailures).toHaveBeenCalledWith([]);
  });

  it("logs a geocoder exception and carries on", async () => {
    m.geocode.mockRejectedValue(new Error("rate limited"));
    const { state, done } = run([device({ metavarAddress: "1 Main St" })], { addressMetavar: "a" });
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", 'fgt-hq: Geocode of address-metavar "1 Main St" failed — rate limited');
    expect(db.create).toHaveBeenCalledTimes(1);
  });
});

describe("syncFirewallAssets — coordinate write-back", () => {
  const geo = () => m.geocode.mockResolvedValue({ latitude: 36.16, longitude: -86.78, failure: null, provider: "x", cached: true });
  const opts = { addressMetavar: "a", pushGeocodedCoords: true, latitudeMetavar: "lat", longitudeMetavar: "lng" };

  it("pushes geocoded coordinates the gate does not hold yet, once per cluster, and logs it", async () => {
    geo();
    m.pushCoords.mockResolvedValue({ ok: true, targets: ["gui-device-latitude", "metavar"] });
    const { done } = run([device({ metavarAddress: "1 Main St", haMembers: [
      { serial: "A", name: "a", isPrimary: true }, { serial: "B", name: "b", isPrimary: false },
    ] })], opts);
    await done;
    expect(m.pushCoords).toHaveBeenCalledTimes(1);
    expect(m.pushCoords).toHaveBeenCalledWith({ id: "int1", type: "fortimanager", config: { host: "fmg" } }, "FGT-HQ", 36.16, -86.78, "lat", "lng");
    const ev = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "integration.coords.pushed");
    expect(ev?.message).toBe("[HQ FMG] Pushed geocoded coords 36.160000,-86.780000 to fgt-hq (targets: gui-device-latitude, metavar)");
    expect(ev).toMatchObject({ resourceType: "integration", resourceId: "int1" });
  });

  it("logs a warning when the write-back is refused", async () => {
    geo();
    m.pushCoords.mockResolvedValue({ ok: false, error: "permission denied", targets: [] });
    await run([device({ metavarAddress: "1 Main St" })], opts).done;
    const ev = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "integration.coords.push_failed");
    expect(ev).toMatchObject({ level: "warning", message: "[HQ FMG] Failed to push geocoded coords to fgt-hq: permission denied" });
  });

  it("skips the write-back when the gate already holds matching coordinates", async () => {
    geo();
    await run([device({ metavarAddress: "1 Main St", latitude: 36.160001, longitude: -86.780001 })], opts).done;
    expect(m.pushCoords).not.toHaveBeenCalled();
  });

  it("skips the write-back when nothing geocoded or the toggle is off", async () => {
    await run([device({ metavarAddress: "1 Main St" })], opts).done;
    geo();
    await run([device({ metavarAddress: "1 Main St" })], { ...opts, pushGeocodedCoords: false }).done;
    expect(m.pushCoords).not.toHaveBeenCalled();
  });

  it("logs a thrown write-back without failing the device", async () => {
    geo();
    m.pushCoords.mockRejectedValue(new Error("socket hang up"));
    const { state, done } = run([device({ metavarAddress: "1 Main St" })], opts);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Coord write-back to fgt-hq threw — socket hang up");
    expect(state.assetNames).toEqual(["fgt-hq"]);
  });
});

describe("syncFirewallAssets — failure isolation", () => {
  it("logs a device whose write fails and still processes the next one", async () => {
    db.create.mockRejectedValueOnce(new Error("unique violation")).mockImplementationOnce(async ({ data }: any) => ({ id: "fw2", ...data }));
    const { state, done } = run([device(), device({ name: "FGT-BR", hostname: "fgt-br", serial: "FG2", mgmtIp: "10.1.0.1" })]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create/update asset for device FGT-HQ: unique violation");
    expect(state.assetNames).toEqual(["fgt-br"]);
    expect(m.logGeoFailures).toHaveBeenCalledTimes(1);
  });
});
