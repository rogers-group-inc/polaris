/**
 * tests/unit/systemInfoPersist.test.ts — CQ-T010:
 * src/services/monitoring/systemInfoPersist.ts.
 *
 * Complements tests/integration/recordSystemInfoContract.test.ts (the per-
 * stream contracts against a real database: cadence stamps, the MAC fold, the
 * assoc-IP replace, LLDP stickiness) and tests/unit/probes.test.ts (which only
 * checks the probe CALLS applyDescrIdentity). This file runs on the shared
 * _dbStub with every writer service mocked and pins what the integration test
 * does not:
 *
 *  - applyDescrIdentity (rules 34 / 161): the one-read steady state, the
 *    identity-field-only diff, the raw-sysDescr `os` cleanup, the OUI-override
 *    guard, `other`-only type inference re-asserted in the WHERE, firmware
 *    first-learn vs move, and identity "moved" auditing;
 *  - recordSystemInfoResult's gates: unsupported is silent, no data and empty
 *    interfaces are a stream failure (rule 118) and never bump lastSystemInfoAt,
 *    time-series rows only for pinned interfaces, the undefined-vs-[] contract
 *    per table, detected-model adoption only over an empty / "FortiSwitch" model;
 *  - persistSdwanRules failover and MCLAG peer-lost change events (gated);
 *  - persistAssetProcesses' delta and started / stopped events;
 *  - persistPerfSlaSampleStream and persistAgentAddressRows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enqueueInterfaceSamples: vi.fn(),
  enqueueStorageSamples: vi.fn(),
  enqueueIpsecTunnelSamples: vi.fn(),
  enqueuePerfSlaSamples: vi.fn(),
  reconcileInterfaceMacs: vi.fn(),
  persistInterfaces: vi.fn(),
  loadInterfaceIdentity: vi.fn(),
  repairInterfacePins: vi.fn(),
  canonicalizeInterfaceRows: vi.fn(),
  projectAssetFromSources: vi.fn(),
  lookupOuiOverride: vi.fn(),
  reconcileSnmpSelfIdentity: vi.fn(),
  reconcileSnmpProfileIdentity: vi.fn(),
  persistFibreChannel: vi.fn(),
  resolveAssetTypeCached: vi.fn(),
  maybeEmitChangeEvents: vi.fn(),
  isChangeActionSubscribed: vi.fn(),
  persistApRadioInventory: vi.fn(),
  recordInterfaceLinkEvents: vi.fn(),
  persistAssetArpNeighbors: vi.fn(),
  persistIpsecConnections: vi.fn(),
  recordIpHistoryEntries: vi.fn(),
  buildMonitorAssocIpEntries: vi.fn(),
  persistPhysicalEntities: vi.fn(),
  persistTrunkMembers: vi.fn(),
  persistMacTable: vi.fn(),
  persistLldpNeighbors: vi.fn(),
  persistWirelessStations: vi.fn(),
  recordStreamFailure: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/sampleWriteBuffer.js", () => ({
  enqueueInterfaceSamples: h.enqueueInterfaceSamples,
  enqueueStorageSamples: h.enqueueStorageSamples,
  enqueueIpsecTunnelSamples: h.enqueueIpsecTunnelSamples,
  enqueuePerfSlaSamples: h.enqueuePerfSlaSamples,
}));
vi.mock("../../src/services/ipv6GateService.js", () => ({ ipv6Enabled: () => true }));
vi.mock("../../src/services/macAddressService.js", () => ({ reconcileInterfaceMacs: h.reconcileInterfaceMacs }));
vi.mock("../../src/services/interfaceInventoryService.js", () => ({
  persistInterfaces: h.persistInterfaces,
  loadInterfaceIdentity: h.loadInterfaceIdentity,
  repairInterfacePins: h.repairInterfacePins,
}));
vi.mock("../../src/utils/interfaceIdentity.js", () => ({
  buildInterfaceIdentity: () => ({}),
  canonicalizeInterfaceRows: h.canonicalizeInterfaceRows,
}));
vi.mock("../../src/utils/assetProjection.js", () => ({ projectAssetFromSources: h.projectAssetFromSources }));
vi.mock("../../src/services/ouiService.js", () => ({ lookupOuiOverride: h.lookupOuiOverride }));
vi.mock("../../src/services/snmpSelfIdentityService.js", () => ({
  reconcileSnmpSelfIdentity: h.reconcileSnmpSelfIdentity,
  reconcileSnmpProfileIdentity: h.reconcileSnmpProfileIdentity,
}));
vi.mock("../../src/services/fibreChannelService.js", () => ({ persistFibreChannel: h.persistFibreChannel }));
vi.mock("../../src/utils/assetTypeMatch.js", () => ({ resolveAssetTypeCached: h.resolveAssetTypeCached }));
vi.mock("../../src/services/notificationChangeEvents.js", () => ({ maybeEmitChangeEvents: h.maybeEmitChangeEvents }));
vi.mock("../../src/services/notificationRuleService.js", () => ({ isChangeActionSubscribed: h.isChangeActionSubscribed }));
vi.mock("../../src/services/apRadioService.js", () => ({ persistApRadioInventory: h.persistApRadioInventory }));
vi.mock("../../src/metrics.js", () => ({ startSampleWriteTimer: () => () => {} }));
vi.mock("../../src/services/interfaceLinkEventService.js", () => ({ recordInterfaceLinkEvents: h.recordInterfaceLinkEvents }));
vi.mock("../../src/services/arpTableService.js", () => ({ persistAssetArpNeighbors: h.persistAssetArpNeighbors }));
vi.mock("../../src/services/ipsecConnectionService.js", () => ({ persistIpsecConnections: h.persistIpsecConnections }));
vi.mock("../../src/services/assetIpHistoryService.js", () => ({ recordIpHistoryEntries: h.recordIpHistoryEntries }));
vi.mock("../../src/services/assetAddressService.js", () => ({
  DISCOVERED_ADDRESS_SOURCES: ["dhcp-lease", "dhcp-reservation", "device-inventory", "arp"],
}));
vi.mock("../../src/services/monitoring/lldpMatchIndex.js", () => ({ buildMonitorAssocIpEntries: h.buildMonitorAssocIpEntries }));
vi.mock("../../src/services/monitoring/snmpCollectors.js", () => ({
  persistPhysicalEntities: h.persistPhysicalEntities,
  persistTrunkMembers: h.persistTrunkMembers,
  persistMacTable: h.persistMacTable,
}));
vi.mock("../../src/services/monitoring/neighborPersistence.js", () => ({
  persistLldpNeighbors: h.persistLldpNeighbors,
  persistWirelessStations: h.persistWirelessStations,
}));
vi.mock("../../src/services/monitoring/pollStamps.js", () => ({
  pollFailureText: (err: string | undefined, dflt: string) => err || dflt,
  systemInfoSuccessStamps: (now: Date) => ({ lastSystemInfoAt: now }),
  recordStreamFailure: h.recordStreamFailure,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  applyDescrIdentity,
  persistAgentAddressRows,
  persistAssetProcesses,
  persistPerfSlaSampleStream,
  persistSdwanRules,
  recordSystemInfoResult,
} from "../../src/services/monitoring/systemInfoPersist.js";

const NOW = new Date("2026-05-01T08:00:00Z");

function pins(over: Record<string, unknown> = {}) {
  return {
    monitoredInterfaces: [], monitoredStorage: [], monitoredIpsecTunnels: [],
    ipAddress: "10.0.0.5", model: null, hostname: "cam1", manufacturer: null, osVersion: null, os: null,
    macAddress: null, assetType: "other", productType: null, serialNumber: null,
    ...over,
  } as any;
}

const actions = () => eventLog.logEvent.mock.calls.map((c) => c[0].action);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.canonicalizeInterfaceRows.mockImplementation((rows: unknown[]) => ({ rows, renamed: [], dropped: 0 }));
  h.buildMonitorAssocIpEntries.mockReturnValue([]);
  h.isChangeActionSubscribed.mockResolvedValue(false);
  h.recordIpHistoryEntries.mockResolvedValue(undefined);
  h.recordInterfaceLinkEvents.mockResolvedValue(undefined);
  vi.mocked(prisma.asset.updateMany).mockResolvedValue({ count: 1 } as never);
});

// ─── applyDescrIdentity ─────────────────────────────────────────────────────

describe("applyDescrIdentity", () => {
  const detail = { manufacturer: "Axis", model: "M2036-LE", osVersion: "10.12", productType: "Network Camera" };

  function project(projected: Record<string, string | null>) {
    h.projectAssetFromSources.mockReturnValue({
      projected: { manufacturer: null, model: null, os: null, osVersion: null, productType: null, serialNumber: null, ...projected },
    });
    vi.mocked(prisma.assetSource.findMany).mockResolvedValue([] as never);
  }

  it("an unchanged reading costs one read and nothing else", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue({
      observed: { ...detail, serialNumber: null, sysObjectId: null, sysDescr: "AXIS" },
    } as never);
    await applyDescrIdentity("a1", detail, "AXIS", pins());
    expect(prisma.assetSource.upsert).not.toHaveBeenCalled();
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("records the reading as the snmp-sysdescr source keyed by the asset id", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({});
    await applyDescrIdentity("a1", detail, "AXIS", pins(), "1.3.6.1.4.1.368");
    const arg = vi.mocked(prisma.assetSource.upsert).mock.calls[0]![0] as any;
    expect(arg.where).toEqual({ sourceKind_externalId: { sourceKind: "snmp-sysdescr", externalId: "a1" } });
    expect(arg.create.observed).toMatchObject({ model: "M2036-LE", sysObjectId: "1.3.6.1.4.1.368", sysDescr: "AXIS", serialNumber: null });
  });

  it("writes only the identity fields the projection changed, never hostname/IP", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ manufacturer: "Axis", model: "M2036-LE", osVersion: "10.12", hostname: "other" } as never);
    await applyDescrIdentity("a1", detail, "AXIS", pins({ assetType: "camera" }));
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { manufacturer: "Axis", model: "M2036-LE", osVersion: "10.12" } });
  });

  it("nothing to change → no Asset write and no events", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ model: "M2036-LE" });
    await applyDescrIdentity("a1", detail, "AXIS", pins({ model: "M2036-LE" }));
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("clears an `os` that holds this very sysDescr (whitespace-insensitive)", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({});
    await applyDescrIdentity("a1", detail, "AXIS M2036 ; 10.12", pins({ os: "  AXIS M2036 ; 10.12 ", assetType: "camera" }));
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { os: null } });
  });

  it("leaves an `os` some other source wrote alone", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({});
    await applyDescrIdentity("a1", detail, "AXIS", pins({ os: "Linux", assetType: "camera" }));
    expect(prisma.asset.update).not.toHaveBeenCalled();
  });

  it("an operator OUI override keeps the vendor; the rest still lands", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ manufacturer: "Axis", model: "M2036-LE" });
    h.lookupOuiOverride.mockResolvedValue({ vendor: "Operator Co" });
    await applyDescrIdentity("a1", detail, "AXIS", pins({ macAddress: "00:40:8C:00:00:01", assetType: "camera" }));
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { model: "M2036-LE" } });
  });

  it("the OUI table is not consulted without a MAC", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ manufacturer: "Axis" });
    await applyDescrIdentity("a1", detail, "AXIS", pins({ assetType: "camera" }));
    expect(h.lookupOuiOverride).not.toHaveBeenCalled();
  });

  it("an `other` asset is typed through the scan rules, with `other` re-asserted in the WHERE", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ model: "M2036-LE", productType: "Network Camera" });
    h.resolveAssetTypeCached.mockReturnValue("camera");
    await applyDescrIdentity("a1", detail, "AXIS", pins());
    expect(h.resolveAssetTypeCached).toHaveBeenCalledWith(
      expect.objectContaining({ os: "AXIS", model: "M2036-LE", productType: "Network Camera" }), "scan");
    expect(prisma.asset.updateMany).toHaveBeenCalledWith({ where: { id: "a1", assetType: "other" }, data: { assetType: "camera" } });
    expect(actions()).toContain("asset.type_inferred");
  });

  it("no type event when the row was typed by someone else in the meantime", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ model: "M2036-LE" });
    h.resolveAssetTypeCached.mockReturnValue("camera");
    vi.mocked(prisma.asset.updateMany).mockResolvedValue({ count: 0 } as never);
    await applyDescrIdentity("a1", detail, "AXIS", pins());
    expect(actions()).not.toContain("asset.type_inferred");
  });

  it("an already-typed asset is never re-typed", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ model: "M2036-LE" });
    await applyDescrIdentity("a1", detail, "AXIS", pins({ assetType: "server" }));
    expect(h.resolveAssetTypeCached).not.toHaveBeenCalled();
    expect(prisma.asset.updateMany).not.toHaveBeenCalled();
  });

  it("a first-learned firmware fills silently; a moved one writes asset.firmware.changed", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ osVersion: "10.12" });
    await applyDescrIdentity("a1", detail, "AXIS", pins({ assetType: "camera" }));
    expect(actions()).not.toContain("asset.firmware.changed");

    resetEventLogStub();
    await applyDescrIdentity("a1", detail, "AXIS", pins({ assetType: "camera", osVersion: "10.11" }));
    expect(eventLog.logEvent.mock.calls.find((c) => c[0].action === "asset.firmware.changed")![0]).toMatchObject({
      actor: "system:monitor", resourceId: "a1",
    });
  });

  it("a model / manufacturer / serial MOVE is audited; a first learn is not", async () => {
    vi.mocked(prisma.assetSource.findUnique).mockResolvedValue(null as never);
    project({ model: "M2036-LE", manufacturer: "Axis", serialNumber: "S2" });
    await applyDescrIdentity("a1", detail, "AXIS", pins({ assetType: "camera" }));
    expect(actions()).not.toContain("asset.model_detected");

    resetEventLogStub();
    await applyDescrIdentity("a1", detail, "AXIS", pins({ assetType: "camera", model: "P1455", manufacturer: "ServerTech", serialNumber: "S1" }));
    const ev = eventLog.logEvent.mock.calls.find((c) => c[0].action === "asset.model_detected")![0];
    expect(ev.message).toBe('Identity restated by the device: cam1 model "P1455" → "M2036-LE"; manufacturer "ServerTech" → "Axis"; serial "S1" → "S2"');
  });
});

// ─── recordSystemInfoResult ─────────────────────────────────────────────────

describe("recordSystemInfoResult", () => {
  const iface = (ifName: string, over: Record<string, unknown> = {}) => ({ ifName, macAddress: null, ipAddress: null, ...over });

  function data(over: Record<string, unknown> = {}) {
    return { interfaces: [], storage: [], ...over } as any;
  }

  it("an unsupported transport writes nothing at all", async () => {
    await recordSystemInfoResult("a1", { supported: false } as any);
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
    expect(h.recordStreamFailure).not.toHaveBeenCalled();
  });

  it("no data is a stream failure with the collector's error, else a default", async () => {
    await recordSystemInfoResult("a1", { supported: true, error: "timeout" } as any);
    expect(h.recordStreamFailure).toHaveBeenCalledWith("systemInfo", "a1", NOW, "timeout");
    await recordSystemInfoResult("a1", { supported: true } as any);
    expect(h.recordStreamFailure).toHaveBeenLastCalledWith("systemInfo", "a1", NOW, "The device returned no interface data");
  });

  it("empty interfaces: failure stamped (rule 118), lastSystemInfoAt untouched, inventory not blanked", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins() as never);
    await recordSystemInfoResult("a1", { supported: true, data: data() } as any);
    expect(h.recordStreamFailure).toHaveBeenCalledWith("systemInfo", "a1", NOW, "The device answered but returned no interfaces");
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(h.persistInterfaces).not.toHaveBeenCalled();
  });

  it("time-series rows only for pinned interfaces; every MAC folds; success stamps lastDescrAt when sysDescr rode along", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins({ monitoredInterfaces: ["port1"] }) as never);
    await recordSystemInfoResult("a1", {
      supported: true,
      data: data({ sysDescr: "x", interfaces: [iface("port1", { macAddress: "AA", speedBps: 1e9 }), iface("port2", { macAddress: "BB" })] }),
    } as any);
    const rows = h.enqueueInterfaceSamples.mock.calls[0]![0];
    expect(rows.map((r: any) => r.ifName)).toEqual(["port1"]);
    expect(rows[0]).toMatchObject({ cadence: "fast", speedBps: 1000000000n, taggedVlans: [], trunksAllVlans: false });
    expect(rows[0]).not.toHaveProperty("fcErrors");
    expect(h.reconcileInterfaceMacs).toHaveBeenCalledWith("a1", ["AA", "BB"], NOW);
    expect(h.persistInterfaces).toHaveBeenCalled();
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { lastSystemInfoAt: NOW, lastDescrAt: NOW } });
  });

  it("description-named ports are mapped back before anything keys on them", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins({ monitoredInterfaces: ["port1"] }) as never);
    h.canonicalizeInterfaceRows.mockReturnValue({ rows: [iface("port1")], renamed: [{ from: "MORGAN", to: "port1" }], dropped: 0 });
    await recordSystemInfoResult("a1", { supported: true, data: data({ interfaces: [iface("MORGAN")] }) } as any);
    expect(h.persistInterfaces.mock.calls[0]![1].map((r: any) => r.ifName)).toEqual(["port1"]);
  });

  it("storage cadence is fast when pinned, slow otherwise", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins({ monitoredStorage: ["/"] }) as never);
    await recordSystemInfoResult("a1", {
      supported: true,
      data: data({ interfaces: [iface("eth0")], storage: [{ mountPath: "/", totalBytes: 10.4, usedBytes: null }, { mountPath: "/boot", totalBytes: 1, usedBytes: 1 }] }),
    } as any);
    expect(h.enqueueStorageSamples.mock.calls[0]![0].map((r: any) => [r.mountPath, r.cadence, r.totalBytes])).toEqual([
      ["/", "fast", 10n], ["/boot", "slow", 1n],
    ]);
  });

  it("undefined tables are left alone; [] tables are written (replace)", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins() as never);
    await recordSystemInfoResult("a1", { supported: true, data: data({ interfaces: [iface("eth0")] }) } as any);
    for (const f of [h.persistLldpNeighbors, h.persistPhysicalEntities, h.persistMacTable, h.persistTrunkMembers, h.persistWirelessStations, h.persistApRadioInventory]) {
      expect(f).not.toHaveBeenCalled();
    }
    h.persistApRadioInventory.mockResolvedValue({ radios: 0, vaps: 0 });
    await recordSystemInfoResult("a1", {
      supported: true,
      data: data({ interfaces: [iface("eth0")], lldpNeighbors: [], physicalEntities: [], macTable: [], trunkMembers: [], wirelessStations: [], apRadios: [] }),
    } as any);
    expect(h.persistLldpNeighbors).toHaveBeenCalledWith("a1", [], NOW, "fortios");
    for (const f of [h.persistPhysicalEntities, h.persistMacTable, h.persistTrunkMembers, h.persistWirelessStations, h.persistApRadioInventory]) {
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("the ARP cache accumulates: an empty array is not a write", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins() as never);
    await recordSystemInfoResult("a1", { supported: true, data: data({ interfaces: [iface("eth0")], arpNeighbors: [] }) } as any);
    expect(h.persistAssetArpNeighbors).not.toHaveBeenCalled();
  });

  it("detected model is adopted over an empty or generic FortiSwitch model only", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins({ model: "FortiSwitch" }) as never);
    await recordSystemInfoResult("a1", { supported: true, data: data({ interfaces: [iface("p1")], detectedModel: "FortiSwitch 248E" }) } as any);
    expect(prisma.asset.update).toHaveBeenCalledWith({ where: { id: "a1" }, data: { model: "FortiSwitch 248E" } });
    expect(actions()).toContain("asset.model_detected");

    vi.mocked(prisma.asset.update).mockClear();
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins({ model: "Custom Model" }) as never);
    await recordSystemInfoResult("a1", { supported: true, data: data({ interfaces: [iface("p1")], detectedModel: "FortiSwitch 248E" }) } as any);
    expect(prisma.asset.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: { model: "FortiSwitch 248E" } }));
  });

  it("the assoc-IP mirror keeps manual rows and only takes over discovered rows for scraped IPs", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue(pins() as never);
    h.buildMonitorAssocIpEntries.mockReturnValue([{ ip: "10.1.1.1", source: "monitor-system-info" }]);
    await recordSystemInfoResult("a1", { supported: true, data: data({ interfaces: [iface("eth0")] }) } as any);
    const where = vi.mocked(prisma.assetAssociatedIp.deleteMany).mock.calls[0]![0]!.where as any;
    expect(where.OR[0].source.notIn).toContain("manual");
    expect(where.OR[1]).toMatchObject({ ip: { in: ["10.1.1.1"] } });
    expect(h.recordIpHistoryEntries).toHaveBeenCalledWith("a1", [{ ip: "10.1.1.1", source: "monitor-system-info" }], "10.0.0.5");
  });
});

// ─── SD-WAN / processes / perf-SLA / agent addresses ────────────────────────

describe("persistSdwanRules", () => {
  const rule = (ruleName: string, selectedMember: string | null) => ({ ruleName, selectedMember }) as any;

  it("replaces the rows; no prior read when no rule subscribes to failover", async () => {
    await persistSdwanRules("a1", [rule("r1", "wan1")]);
    expect(prisma.assetSdwanRule.deleteMany).toHaveBeenCalledWith({ where: { assetId: "a1" } });
    expect(prisma.assetSdwanRule.createMany).toHaveBeenCalled();
    expect(prisma.assetSdwanRule.findMany).not.toHaveBeenCalled();
  });

  it("an empty scrape deletes without a createMany", async () => {
    await persistSdwanRules("a1", []);
    expect(prisma.assetSdwanRule.createMany).not.toHaveBeenCalled();
  });

  it("emits a failover only for a rule whose selected member moved between two known members", async () => {
    h.isChangeActionSubscribed.mockResolvedValue(true);
    vi.mocked(prisma.assetSdwanRule.findMany).mockResolvedValue([
      { ruleName: "r1", selectedMember: "wan1" }, { ruleName: "r2", selectedMember: null }, { ruleName: "r3", selectedMember: "wan1" },
    ] as never);
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ hostname: "gate" } as never);
    await persistSdwanRules("a1", [rule("r1", "wan2"), rule("r2", "wan2"), rule("r3", "wan1"), rule("new", "wan2")]);
    expect(h.maybeEmitChangeEvents).toHaveBeenCalledWith("change.sdwan.failover", "a1", "gate", [
      { label: "r1: wan1 → wan2", details: { ruleName: "r1", from: "wan1", to: "wan2" } },
    ]);
  });
});

describe("persistAssetProcesses", () => {
  const proc = (name: string, over: Record<string, unknown> = {}) => ({
    name, instanceCount: 1, cpuPct: 1, memRssBytes: 1000n, exePath: null, username: null, startedAt: null, serviceUnit: null, controllable: false, ...over,
  });

  it("creates the new, deletes the vanished, stamps the scrape, and reports counts", async () => {
    vi.mocked(prisma.assetProcess.findMany).mockResolvedValue([{ id: "p-old", ...proc("old") }, { id: "p-same", ...proc("same") }] as never);
    const r = await persistAssetProcesses("a1", [proc("same"), proc("new")], NOW);
    expect(r).toEqual({ created: 1, updated: 0, removed: 1, unchanged: 1 });
    expect(prisma.assetProcess.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["p-old"] } } });
    expect((vi.mocked(prisma.assetProcess.createMany).mock.calls[0]![0] as any).data[0]).toMatchObject({ assetId: "a1", name: "new" });
    expect(prisma.assetInventoryScrape.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { assetId_kind: { assetId: "a1", kind: "processes" } }, update: { scrapedAt: NOW },
    }));
  });

  it("an exact-field change is an update via updateMany", async () => {
    vi.mocked(prisma.assetProcess.findMany).mockResolvedValue([{ id: "p1", ...proc("sshd") }] as never);
    const r = await persistAssetProcesses("a1", [proc("sshd", { instanceCount: 3 })], NOW);
    expect(r.updated).toBe(1);
    expect(prisma.assetProcess.updateMany).toHaveBeenCalledWith({ where: { id: "p1" }, data: expect.objectContaining({ instanceCount: 3 }) });
  });

  it("started / stopped events go out only when subscribed", async () => {
    vi.mocked(prisma.assetProcess.findMany).mockResolvedValue([{ id: "p1", ...proc("old") }] as never);
    await persistAssetProcesses("a1", [proc("new")], NOW);
    expect(h.maybeEmitChangeEvents).not.toHaveBeenCalled();

    h.isChangeActionSubscribed.mockImplementation(async (a: string) => a === "change.process.stopped");
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ hostname: "srv" } as never);
    await persistAssetProcesses("a1", [proc("new")], NOW);
    expect(h.maybeEmitChangeEvents).toHaveBeenCalledWith("change.process.started", "a1", "srv", [{ label: "new", details: { name: "new" } }]);
    expect(h.maybeEmitChangeEvents).toHaveBeenCalledWith("change.process.stopped", "a1", "srv", [{ label: "old", details: { name: "old" } }]);
  });

  it("an empty scrape is a valid delete-only pass", async () => {
    vi.mocked(prisma.assetProcess.findMany).mockResolvedValue([{ id: "p1", ...proc("x") }] as never);
    expect(await persistAssetProcesses("a1", [], NOW)).toEqual({ created: 0, updated: 0, removed: 1, unchanged: 0 });
    expect(prisma.assetProcess.createMany).not.toHaveBeenCalled();
  });
});

describe("persistPerfSlaSampleStream / persistAgentAddressRows", () => {
  it("perf-SLA rows are all stamped fast; nothing is enqueued for empty / undefined input", () => {
    persistPerfSlaSampleStream("a1", undefined, NOW);
    persistPerfSlaSampleStream("a1", [], NOW);
    expect(h.enqueuePerfSlaSamples).not.toHaveBeenCalled();
    persistPerfSlaSampleStream("a1", [{ healthCheck: "hc", link: "wan1", latencyMs: 3 } as any], NOW);
    expect(h.enqueuePerfSlaSamples.mock.calls[0]![0][0]).toMatchObject({ assetId: "a1", cadence: "fast", healthCheck: "hc", link: "wan1", latencyMs: 3, timestamp: NOW });
  });

  it("the agent push mirrors under the agent-interface source and skips an empty push", async () => {
    vi.mocked(prisma.asset.findUnique).mockResolvedValue({ ipAddress: "10.0.0.9" } as never);
    await persistAgentAddressRows("a1", [{ ifName: "eth0", ipAddress: "10.0.0.9", ipv6Address: null, macAddress: null }], NOW);
    expect(h.buildMonitorAssocIpEntries.mock.calls[0]![2]).toBe("agent-interface");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
