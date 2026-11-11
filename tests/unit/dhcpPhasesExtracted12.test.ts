/**
 * tests/unit/dhcpPhasesExtracted12.test.ts — syncDhcpSubnets Phase 3, the
 * FortiGate fan-out, now src/services/discovery/dhcp/firewallAssets.ts
 * (CQ-B060 slice 13). Pins the create path for a standalone gate and an HA
 * pair, the monitored stamp on an existing member (standby swept off, an
 * operator override kept), the serial guard on a hostname / IP match, and
 * which location source reaches the geocoder. The projection and the
 * observed-blob shape have their own suites; here both are stubbed. The rest
 * against a real database: haStandbyRosterIdentity, renamedControllerSweep,
 * scopedGateFinalize, serialHostnameMatch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  sourceDeleteMany: vi.fn(),
  logEvent: vi.fn(),
  logCreated: vi.fn(),
  logUpdated: vi.fn(),
  project: vi.fn(),
  geocode: vi.fn(),
  logGeoFailures: vi.fn(),
  sysLocation: vi.fn(),
  pushCoords: vi.fn(),
  reconcileMacs: vi.fn(),
}));
vi.mock("../../src/db.js", () => ({
  prisma: { asset: { create: m.create, update: m.update }, assetSource: { deleteMany: m.sourceDeleteMany } },
}));
vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: m.logEvent,
  snapshotMaterialAssetFields: (a: Record<string, unknown>) => ({ ...a }),
  logDiscoveryAssetCreated: m.logCreated,
  logDiscoveryAssetUpdated: m.logUpdated,
}));
vi.mock("../../src/utils/assetProjection.js", () => ({ projectAssetFromSources: m.project }));
vi.mock("../../src/services/geocoderService.js", () => ({ geocode: m.geocode, logGeocodeFailureEvents: m.logGeoFailures }));
vi.mock("../../src/services/fortigateLocationService.js", () => ({ fetchFortigateSysLocation: m.sysLocation }));
vi.mock("../../src/services/fortigateCoordPushService.js", () => ({ pushCoordsToFortigate: m.pushCoords }));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileMacAddresses: m.reconcileMacs }));

const { syncFirewallAssets } = await import("../../src/services/discovery/dhcp/firewallAssets.js");

const NOW = "2026-11-10T12:00:00.000Z";
const PROJECTED = {
  hostname: null, ipAddress: "10.0.0.1", serialNumber: null, manufacturer: null, model: null, osVersion: "v7.6.8",
  latitude: null, longitude: null, snmpLocation: null, learnedAddress: null, os: null, learnedLocation: null,
};
let nextId = 0;
beforeEach(() => {
  vi.clearAllMocks();
  nextId = 0;
  m.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: `fw${++nextId}`, ...data }));
  m.update.mockResolvedValue({});
  m.sourceDeleteMany.mockResolvedValue({ count: 0 });
  m.project.mockReturnValue({ projected: { ...PROJECTED } });
  m.geocode.mockResolvedValue({ latitude: null, longitude: null, failure: null });
  m.logGeoFailures.mockResolvedValue(undefined);
});

function index(assets: Array<Record<string, any>> = []) {
  const rows = [...assets];
  return {
    rows,
    findBySerial: (s: string) => rows.find((a) => a.serialNumber === s),
    findByEntry: (_mac: unknown, hostname?: string) => rows.find((a) => hostname && a.hostname === hostname),
    add: (a: any) => rows.push(a),
    reindex: vi.fn(),
  };
}

function run(devices: unknown[], over: Record<string, unknown> = {}) {
  const state = {
    result: { devices } as never,
    assetIdx: index() as never,
    assetNames: [] as string[], now: NOW,
    membershipSwitchByDevice: new Map(), membershipSwitchKnown: new Set<string>(),
    membershipApByDevice: new Map(), membershipApKnown: new Set<string>(),
    fortigateAddAsMonitored: true, pullSnmpLocation: false, useSnmpLocationCoords: false, pushGeocodedCoords: false,
    latitudeMetavar: "Latitude", longitudeMetavar: "Longitude", addressMetavar: "",
    integrationConfig: { host: "fmg" }, verboseLogging: false,
    infraSourcesOf: () => [], applyInfraSourceInMemory: vi.fn(), dropInfraSourceKindInMemory: vi.fn(),
    buildFortigateFirewallObservedBlob: vi.fn(() => ({ stub: true })),
    upsertFortigateFirewallAssetSource: vi.fn(async () => undefined),
    integrationId: "i1", integrationName: "FMG", integrationType: "fortimanager", integrationLabel: "FortiManager",
    actor: "system", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: syncFirewallAssets(state as never) };
}
const gate = (over: Record<string, unknown> = {}) => ({
  name: "SITE-A-FW", hostname: "site-a-fw", serial: "FGT60F0000000001", mgmtIp: "10.0.0.1", mgmtMac: "00:09:0f:00:00:01",
  ...over,
});

describe("Phase 3 — new FortiGates", () => {
  it("creates a standalone gate as a monitored firewall and records its fortigate-firewall source", async () => {
    const { state, done } = run([gate()]);
    await done;
    const data = m.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      ipAddress: "10.0.0.1", hostname: "site-a-fw", serialNumber: "FGT60F0000000001", assetType: "firewall",
      manufacturer: "Fortinet", model: "FortiGate", monitored: true, discoveredByIntegrationId: "i1",
      tags: ["fortigate", "auto-discovered"], learnedLocation: "site-a-fw", lastSeenSource: "discovery",
    });
    expect(state.upsertFortigateFirewallAssetSource).toHaveBeenCalledWith("fw1", "i1", "FGT60F0000000001", { stub: true }, new Date(NOW), new Date(NOW));
    expect((state.assetIdx as any).rows).toHaveLength(1);
    expect(state.assetNames).toEqual(["site-a-fw"]);
    expect(m.logCreated).toHaveBeenCalled();
  });

  it("an HA pair: the standby is created with no address, not monitored, tagged ha-standby", async () => {
    const pair = gate({ haMembers: [
      { serial: "FGT60F0000000001", hostname: "site-a-fw", role: "primary", isPrimary: true },
      { serial: "FGT60F0000000002", hostname: "site-a-fw-2", role: "secondary", isPrimary: false },
    ] });
    await run([pair]).done;
    expect(m.create).toHaveBeenCalledTimes(2);
    const bySerial = new Map(m.create.mock.calls.map((c) => [c[0].data.serialNumber, c[0].data]));
    expect(bySerial.get("FGT60F0000000001")).toMatchObject({ ipAddress: "10.0.0.1", monitored: true });
    const standby = bySerial.get("FGT60F0000000002")!;
    expect(standby.ipAddress).toBeNull();
    expect(standby.monitored).toBeUndefined();
    expect(standby.tags).toContain("ha-standby");
  });

  it("a hostname match carrying a DIFFERENT serial is not this gate — a new asset is created (rule 41)", async () => {
    const other = { id: "old", hostname: "site-a-fw", serialNumber: "FGT60F0000000099", monitored: false };
    await run([gate()], { assetIdx: index([other]) as never }).done;
    expect(m.update).not.toHaveBeenCalled();
    expect(m.create).toHaveBeenCalledTimes(1);
  });
});

describe("Phase 3 — the monitored stamp on an existing gate", () => {
  const existing = (over: Record<string, unknown> = {}) => ({
    id: "fw-e", hostname: "site-a-fw", serialNumber: "FGT60F0000000001", ipAddress: "10.0.0.1", macAddress: null, macAddresses: [],
    monitored: false, monitorOverride: false, status: "active", assetType: "firewall", ...over,
  });

  it("follows the integration's flag on the primary", async () => {
    await run([gate()], { assetIdx: index([existing()]) as never }).done;
    expect(m.update.mock.calls[0][0].data.monitored).toBe(true);
  });

  it("sweeps a monitored standby off, resetting its failure streak; an operator override is left alone", async () => {
    const pair = gate({ haMembers: [
      { serial: "FGT60F0000000001", hostname: "site-a-fw", isPrimary: true },
      { serial: "FGT60F0000000002", hostname: "site-a-fw-2", isPrimary: false },
    ] });
    const primary = existing({ monitored: true });
    const standby = existing({ id: "fw-s", hostname: "site-a-fw-2", serialNumber: "FGT60F0000000002", monitored: true });
    await run([pair], { assetIdx: index([primary, standby]) as never }).done;
    const dataFor = (id: string) => m.update.mock.calls.find((c) => c[0].where.id === id)![0].data;
    expect(dataFor("fw-s")).toMatchObject({ monitored: false, consecutiveFailures: 0 });
    expect(dataFor("fw-e").monitored).toBeUndefined(); // already monitored

    m.update.mockClear();
    const pinned = existing({ id: "fw-s", hostname: "site-a-fw-2", serialNumber: "FGT60F0000000002", monitored: true, monitorOverride: true });
    await run([pair], { assetIdx: index([existing({ monitored: true }), pinned]) as never }).done;
    expect(m.update.mock.calls.find((c) => c[0].where.id === "fw-s")![0].data.monitored).toBeUndefined();
  });
});

describe("Phase 3 — which location reaches the geocoder", () => {
  it("an address metavar wins; a miss is reported against the asset after the loop", async () => {
    m.geocode.mockResolvedValue({ latitude: null, longitude: null, failure: { kind: "no-match" } });
    await run([gate({ metavarAddress: " 1 Main St, Nashville " })], { addressMetavar: "Address", pullSnmpLocation: true, useSnmpLocationCoords: true }).done;
    expect(m.geocode).toHaveBeenCalledWith("1 Main St, Nashville");
    expect(m.logGeoFailures).toHaveBeenCalledWith([expect.objectContaining({ assetId: "fw1", query: "1 Main St, Nashville", source: "address-metavar" })]);
  });

  it("sysLocation is pulled for display but drives the coords only when opted in", async () => {
    m.sysLocation.mockResolvedValue("Building 4, Nashville");
    await run([gate()], { pullSnmpLocation: true, useSnmpLocationCoords: false }).done;
    expect(m.sysLocation).toHaveBeenCalledWith({ integration: { id: "i1", type: "fortimanager", config: { host: "fmg" } }, deviceName: "SITE-A-FW" });
    expect(m.geocode).not.toHaveBeenCalled();

    await run([gate()], { pullSnmpLocation: true, useSnmpLocationCoords: true }).done;
    expect(m.geocode).toHaveBeenCalledWith("Building 4, Nashville");
  });

  it("a failing device is logged and the next one still syncs", async () => {
    m.create.mockRejectedValueOnce(new Error("boom"));
    const { state, done } = run([gate(), gate({ name: "SITE-B-FW", hostname: "site-b-fw", serial: "FGT60F0000000003" })]);
    await done;
    expect(state.syncLog).toHaveBeenCalledWith("error", "Failed to create/update asset for device SITE-A-FW: boom");
    expect(state.assetNames).toEqual(["site-b-fw"]);
  });
});
