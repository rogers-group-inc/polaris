/**
 * tests/unit/streamCollection.test.ts — own suite for
 * services/monitoring/streamCollection.ts (CQ-T010).
 *
 * Complements, does not repeat:
 *   - fortiswitchPortVlans.test.ts — buildFortiswitchControllerPortsMap
 *   - assetLiveActionService.test.ts — mocks collectTelemetry /
 *     collectHardwareSensors / collectSystemInfo wholesale
 *   - tests/integration/collectSystemInfoGates.test.ts,
 *     genericApiMonitoring.test.ts, interfaceIdentityReconcile.test.ts — the
 *     full system-info pass and the fast-result writer against a database
 *
 * What is pinned here is each stream's DISPATCH: the resolved polling method
 * picks exactly one collector, the guards in front of it (not found, not
 * monitored, agent-mode stays out of the way, no address — with the FQDN
 * fallback only for WinRM/SSH, REST only from a Fortinet source and never at
 * a managed switch), the per-stream credential chosen ahead of the asset
 * default, a collector failure returned as a supported error rather than a
 * throw, and the fast pass's pinned-only filtering and sample writes.
 * Every collector is a spy — nothing dials a device.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  resolve: vi.fn(),
  telemetrySnmp: vi.fn(),
  hwSnmp: vi.fn(),
  fastSnmp: vi.fn(),
  telemetryFortinet: vi.fn(),
  hwFortinet: vi.fn(),
  sysInfoFortinet: vi.fn(),
  buildFortinetConfig: vi.fn(),
  collectIpsecFortinet: vi.fn(),
  applyFortiInterfaceFilter: vi.fn(),
  telemetryVcenter: vi.fn(),
  readVcenterAsset: vi.fn(),
  buildVcenterSystemInfo: vi.fn(),
  telemetryWorkload: vi.fn(),
  hwWorkload: vi.fn(),
  sysInfoWorkload: vi.fn(),
  telemetryGeneric: vi.fn(),
  hwGeneric: vi.fn(),
  sysInfoGeneric: vi.fn(),
  hostSsh: vi.fn(),
  hostWinrm: vi.fn(),
  enqueueIf: vi.fn(),
  enqueueSt: vi.fn(),
  enqueueTn: vi.fn(),
  linkEvents: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/monitoring/monitorSettings.js", async (orig) => ({
  ...(await orig<object>()),
  resolveMonitorSettings: m.resolve,
}));
vi.mock("../../src/services/monitoring/dial.js", () => ({
  dial: (a: { ipAddress?: string | null }) => a.ipAddress ?? null,
}));
vi.mock("../../src/services/monitoring/snmpCore.js", async (orig) => ({
  ...(await orig<object>()),
  withSnmpSession: async (_h: string, _c: unknown, fn: (s: unknown) => Promise<unknown>) => fn({}),
}));
vi.mock("../../src/services/monitoring/snmpCollectors.js", async (orig) => ({
  ...(await orig<object>()),
  collectTelemetrySnmp: m.telemetrySnmp,
  collectHardwareSensorsSnmp: m.hwSnmp,
  collectFastFilteredSnmp: m.fastSnmp,
  snmpVendorScope: () => ({ manufacturer: "x" }),
}));
vi.mock("../../src/services/monitoring/fortiosCollectors.js", async (orig) => ({
  ...(await orig<object>()),
  collectTelemetryFortinet: m.telemetryFortinet,
  collectHardwareSensorsFortinet: m.hwFortinet,
  collectSystemInfoFortinet: m.sysInfoFortinet,
  buildFortinetConfig: m.buildFortinetConfig,
  collectIpsecFortinet: m.collectIpsecFortinet,
  applyFortiInterfaceFilter: m.applyFortiInterfaceFilter,
}));
vi.mock("../../src/services/monitoring/vcenterFmgCollectors.js", async (orig) => ({
  ...(await orig<object>()),
  collectTelemetryVcenter: m.telemetryVcenter,
  readVcenterAsset: m.readVcenterAsset,
  buildVcenterSystemInfo: m.buildVcenterSystemInfo,
}));
vi.mock("../../src/services/workloadMonitorService.js", async (orig) => ({
  ...(await orig<object>()),
  collectTelemetryWorkload: m.telemetryWorkload,
  collectHardwareSensorsWorkload: m.hwWorkload,
  collectSystemInfoWorkload: m.sysInfoWorkload,
}));
vi.mock("../../src/services/genericApiMonitorService.js", async (orig) => ({
  ...(await orig<object>()),
  collectTelemetryGenericApi: m.telemetryGeneric,
  collectHardwareSensorsGenericApi: m.hwGeneric,
  collectSystemInfoGenericApi: m.sysInfoGeneric,
}));
vi.mock("../../src/services/agentlessHostService.js", async (orig) => ({
  ...(await orig<object>()),
  collectHostSsh: m.hostSsh,
  collectHostWinrm: m.hostWinrm,
}));
vi.mock("../../src/services/sampleWriteBuffer.js", async (orig) => ({
  ...(await orig<object>()),
  enqueueInterfaceSamples: m.enqueueIf,
  enqueueStorageSamples: m.enqueueSt,
  enqueueIpsecTunnelSamples: m.enqueueTn,
}));
vi.mock("../../src/services/interfaceLinkEventService.js", async (orig) => ({
  ...(await orig<object>()),
  recordInterfaceLinkEvents: m.linkEvents,
}));
vi.mock("../../src/services/interfaceInventoryService.js", async (orig) => ({
  ...(await orig<object>()),
  loadInterfaceIdentity: vi.fn(async () => ({ names: new Set(), labelToName: new Map() })),
}));
vi.mock("../../src/services/oidRegistry.js", async (orig) => ({
  ...(await orig<object>()),
  ensureRegistryLoaded: vi.fn(async () => undefined),
}));
vi.mock("../../src/services/profileResolver.js", async (orig) => ({
  ...(await orig<object>()),
  pickDbProfile: vi.fn(() => null),
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  collectTelemetry,
  collectHardwareSensors,
  collectFastFiltered,
  recordFastFilteredResult,
  loadTelemetryAsset,
} from "../../src/services/monitoring/streamCollection.js";

const SNMP = { type: "snmp", config: { community: "asset-default" } };
const SNMP_CPU = { type: "snmp", config: { community: "cpu-stream" } };

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1", monitored: true, assetType: "server", ipAddress: "10.0.0.5", dnsName: null, hostname: "srv1",
    manufacturer: "Acme", model: "X1", os: "Linux", status: "active",
    monitorCredential: null, cpuMemoryCredential: null, temperatureCredential: null,
    customWidgetCredential: null, interfacesCredential: null,
    discoveredByIntegration: null, discoveredByIntegrationId: null, fortinetTopology: null,
    monitoredInterfaces: [], monitoredStorage: [], monitoredIpsecTunnels: [],
    ...over,
  } as never;
}

function settings(over: Record<string, unknown> = {}) {
  return {
    cpuMemoryPolling: "snmp", temperaturePolling: "snmp", interfacesPolling: "snmp", storagePolling: "snmp",
    cpuMemoryTimeoutMs: 1111, temperatureTimeoutMs: 2222, systemInfoTimeoutMs: 3333,
    cpuMemoryCredentialId: null, temperatureCredentialId: null, interfacesCredentialId: null,
    ...over,
  };
}

const FGT = { id: "int1", type: "fortigate", config: { host: "fg", apiToken: "t" } };

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(m)) f.mockReset();
  m.resolve.mockResolvedValue(settings());
  m.buildFortinetConfig.mockReturnValue({ host: "x" });
});

// ─── telemetry ──────────────────────────────────────────────────────────────

describe("collectTelemetry — guards", () => {
  it("loads the asset once with the union include when nothing is preloaded", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    expect(await collectTelemetry("a1")).toEqual({ supported: false, error: "Asset not found" });
    const q = stubbed(prisma.asset.findUnique).mock.calls[0][0];
    expect(Object.keys(q.include).sort()).toEqual(["cpuMemoryCredential", "customWidgetCredential", "discoveredByIntegration", "monitorCredential", "temperatureCredential"]);
    expect(q.omit).toMatchObject({ virtualization: true });
    await loadTelemetryAsset("a2");
    expect(stubbed(prisma.asset.findUnique).mock.calls[1][0].where).toEqual({ id: "a2" });
  });

  it("a preloaded row (even null) is used as is", async () => {
    expect(await collectTelemetry("a1", null)).toEqual({ supported: false, error: "Asset not found" });
    expect(prisma.asset.findUnique).not.toHaveBeenCalled();
  });

  it("is unsupported for an unmonitored asset, no method, or agent mode — the agent pushes its own", async () => {
    expect(await collectTelemetry("a1", asset({ monitored: false }))).toEqual({ supported: false });
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: null }));
    expect(await collectTelemetry("a1", asset())).toEqual({ supported: false });
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "agent" }));
    expect(await collectTelemetry("a1", asset())).toEqual({ supported: false });
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "icmp" }));
    expect(await collectTelemetry("a1", asset())).toEqual({ supported: false });
  });

  it("resolves settings with the discovering integration's type", async () => {
    m.telemetrySnmp.mockResolvedValue({});
    await collectTelemetry("a1", asset({ discoveredByIntegration: FGT, monitorCredential: SNMP }));
    expect(m.resolve.mock.calls[0][0]).toMatchObject({ discoveredByIntegrationType: "fortigate" });
  });
});

describe("collectTelemetry — dispatch", () => {
  it("vCenter, workload and Generic API need no address and go to their own collectors", async () => {
    m.telemetryVcenter.mockResolvedValue({ supported: true, data: "vc" });
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "vcenter" }));
    expect(await collectTelemetry("a1", asset({ ipAddress: null }))).toEqual({ supported: true, data: "vc" });

    m.telemetryWorkload.mockResolvedValue({ supported: true, data: "wl" });
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "unraid" }));
    expect(await collectTelemetry("a1", asset({ ipAddress: null }))).toEqual({ supported: true, data: "wl" });

    m.telemetryGeneric.mockResolvedValue({ supported: true, data: "ga" });
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "genericapi" }));
    expect(await collectTelemetry("a1", asset({ ipAddress: null }))).toEqual({ supported: true, data: "ga" });
  });

  it("SNMP with no address is unsupported, with a reason", async () => {
    expect(await collectTelemetry("a1", asset({ ipAddress: null }))).toEqual({ supported: false, error: "Asset has no IP address" });
  });

  it("SNMP prefers the CPU/memory stream's credential over the asset default", async () => {
    m.telemetrySnmp.mockResolvedValue({ cpuPct: 5 });
    const r = await collectTelemetry("a1", asset({ monitorCredential: SNMP, cpuMemoryCredential: SNMP_CPU }));
    expect(r).toEqual({ supported: true, data: { cpuPct: 5 } });
    expect(m.telemetrySnmp).toHaveBeenCalledWith("10.0.0.5", { community: "cpu-stream" }, "Acme", "X1", "Linux", 1111, "server");
  });

  it("SNMP with no usable credential is a supported error, not a silent skip", async () => {
    const r = await collectTelemetry("a1", asset());
    expect(r).toEqual({ supported: true, error: "No SNMP credential selected" });
    expect(m.telemetrySnmp).not.toHaveBeenCalled();
  });

  it("a collector that throws comes back as a supported error", async () => {
    m.telemetrySnmp.mockRejectedValue(new Error("timeout"));
    expect(await collectTelemetry("a1", asset({ monitorCredential: SNMP }))).toEqual({ supported: true, error: "timeout" });
  });

  it("REST is FortiOS only and never aimed at a managed switch", async () => {
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "rest_api" }));
    expect(await collectTelemetry("a1", asset())).toEqual({ supported: false });
    expect(await collectTelemetry("a1", asset({ assetType: "switch", discoveredByIntegration: FGT }))).toEqual({ supported: false });
    m.telemetryFortinet.mockResolvedValue({ cpuPct: 9 });
    const r = await collectTelemetry("a1", asset({ assetType: "firewall", discoveredByIntegration: FGT }));
    expect(r).toEqual({ supported: true, data: { cpuPct: 9 } });
    expect(m.telemetryFortinet.mock.calls[0][0]).toBe("10.0.0.5");
    expect(m.telemetryFortinet.mock.calls[0][2]).toBe(1111);
  });

  it("SSH falls back to the DNS name when there is no address, and reports an empty reading", async () => {
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "ssh" }));
    const cred = { type: "ssh", config: { username: "u", password: "p" } };
    m.hostSsh.mockResolvedValue({ telemetry: { cpuPct: 3 } });
    expect(await collectTelemetry("a1", asset({ ipAddress: null, dnsName: "srv1.corp", monitorCredential: cred })))
      .toEqual({ supported: true, data: { cpuPct: 3 } });
    expect(m.hostSsh).toHaveBeenCalledWith("srv1.corp", { username: "u", password: "p" }, expect.objectContaining({ telemetry: true, interfaces: false, storage: false }));

    m.hostSsh.mockResolvedValue({});
    expect(await collectTelemetry("a1", asset({ monitorCredential: cred }))).toEqual({ supported: true, error: "Host returned no CPU/memory reading" });
  });

  it("WinRM with no credential names the method", async () => {
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "winrm" }));
    expect(await collectTelemetry("a1", asset())).toEqual({ supported: true, error: "No WinRM credential selected" });
  });

  it("WinRM is called with the connection shape and a 30 s floor", async () => {
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "winrm" }));
    m.hostWinrm.mockResolvedValue({ telemetry: { cpuPct: 1 } });
    await collectTelemetry("a1", asset({ monitorCredential: { type: "winrm", config: { username: "u", password: "p" } } }));
    expect(m.hostWinrm.mock.calls[0][0]).toMatchObject({ host: "10.0.0.5", username: "u", useHttps: true, timeoutMs: 30_000 });
  });
});

// ─── hardware sensors ───────────────────────────────────────────────────────

describe("collectHardwareSensors", () => {
  it("dispatches on temperaturePolling, independent of CPU/memory", async () => {
    m.resolve.mockResolvedValue(settings({ cpuMemoryPolling: "rest_api", temperaturePolling: "snmp" }));
    m.hwSnmp.mockResolvedValue([{ sensorName: "CPU" }]);
    const r = await collectHardwareSensors("a1", asset({ temperatureCredential: SNMP }));
    expect(r).toEqual({ supported: true, data: [{ sensorName: "CPU" }] });
    expect(m.telemetryFortinet).not.toHaveBeenCalled();
  });

  it("SSH / WinRM / ICMP deliver no hardware sensors", async () => {
    for (const p of ["ssh", "winrm", "icmp"]) {
      m.resolve.mockResolvedValue(settings({ temperaturePolling: p }));
      expect(await collectHardwareSensors("a1", asset())).toEqual({ supported: false });
    }
  });

  it("REST: a FortiGate config error is reported, a managed switch is skipped", async () => {
    m.resolve.mockResolvedValue(settings({ temperaturePolling: "rest_api" }));
    m.buildFortinetConfig.mockReturnValue({ error: "FortiGate API token not configured" });
    expect(await collectHardwareSensors("a1", asset({ assetType: "firewall", discoveredByIntegration: FGT })))
      .toEqual({ supported: true, error: "FortiGate API token not configured" });
    expect(await collectHardwareSensors("a1", asset({ assetType: "switch", discoveredByIntegration: FGT }))).toEqual({ supported: false });
  });

  it("REST on a gate reads the sensors with the stream's timeout", async () => {
    m.resolve.mockResolvedValue(settings({ temperaturePolling: "rest_api" }));
    m.hwFortinet.mockResolvedValue([]);
    expect(await collectHardwareSensors("a1", asset({ assetType: "firewall", discoveredByIntegration: FGT }))).toEqual({ supported: true, data: [] });
    expect(m.hwFortinet).toHaveBeenCalledWith({ host: "x" }, 2222);
  });

  it("workload and Generic API sources go to their own collectors; agent mode stays out", async () => {
    m.hwWorkload.mockResolvedValue({ supported: true, data: ["disk"] });
    m.resolve.mockResolvedValue(settings({ temperaturePolling: "truenas" }));
    expect(await collectHardwareSensors("a1", asset())).toEqual({ supported: true, data: ["disk"] });
    m.hwGeneric.mockResolvedValue({ supported: true, data: [] });
    m.resolve.mockResolvedValue(settings({ temperaturePolling: "genericapi" }));
    expect(await collectHardwareSensors("a1", asset())).toEqual({ supported: true, data: [] });
    m.resolve.mockResolvedValue(settings({ temperaturePolling: "agent" }));
    expect(await collectHardwareSensors("a1", asset())).toEqual({ supported: false });
  });
});

// ─── fast pass ──────────────────────────────────────────────────────────────

describe("collectFastFiltered", () => {
  const iface = (ifName: string) => ({ ifName, operStatus: "up" });

  it("is unsupported when nothing is pinned — no settings resolve, no scrape", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    expect(await collectFastFiltered("a1")).toEqual({ supported: false });
    expect(m.resolve).not.toHaveBeenCalled();
  });

  it("SNMP: asks for the pinned names and returns only those, storage only when storage is SNMP too", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ monitorCredential: SNMP, monitoredInterfaces: ["port1"], monitoredStorage: ["/"] }));
    m.fastSnmp.mockResolvedValue({ interfaces: [iface("port1"), iface("port2")], storage: [{ mountPath: "/" }, { mountPath: "/var" }] });
    let r = await collectFastFiltered("a1");
    expect(m.fastSnmp).toHaveBeenCalledWith("10.0.0.5", { community: "asset-default" }, expect.objectContaining({ wantedIfaces: ["port1"], wantedStorage: ["/"], timeoutMs: 3333 }));
    expect(r).toEqual({ supported: true, data: { interfaces: [iface("port1")], storage: [{ mountPath: "/" }], ipsecTunnels: undefined } });

    m.resolve.mockResolvedValue(settings({ storagePolling: "winrm" }));
    r = await collectFastFiltered("a1");
    expect(r.data!.storage).toEqual([]);
  });

  it("a Fortinet-sourced SNMP scrape is filtered through the integration and picks up pinned tunnels over REST", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({
      assetType: "firewall", discoveredByIntegration: FGT, monitorCredential: SNMP,
      monitoredInterfaces: ["wan1"], monitoredIpsecTunnels: ["to-dc"],
    }));
    m.fastSnmp.mockResolvedValue({ interfaces: [iface("wan1")], storage: [] });
    m.collectIpsecFortinet.mockResolvedValue({ tunnels: [{ tunnelName: "to-dc" }, { tunnelName: "to-br" }] });
    const r = await collectFastFiltered("a1");
    expect(m.applyFortiInterfaceFilter).toHaveBeenCalled();
    expect(r.data!.ipsecTunnels).toEqual([{ tunnelName: "to-dc" }]);
  });

  it("REST: a gate only — a managed switch / AP has no REST path", async () => {
    m.resolve.mockResolvedValue(settings({ interfacesPolling: "rest_api" }));
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ assetType: "switch", discoveredByIntegration: FGT, monitoredInterfaces: ["port1"] }));
    expect(await collectFastFiltered("a1")).toEqual({ supported: false });

    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ assetType: "firewall", discoveredByIntegration: FGT, monitoredInterfaces: ["wan1"] }));
    m.sysInfoFortinet.mockResolvedValue({ interfaces: [iface("wan1"), iface("lan")], storage: [] });
    const r = await collectFastFiltered("a1");
    expect(m.sysInfoFortinet.mock.calls[0][2]).toEqual({ includeIpsec: false, includeLldp: false, timeoutMs: 3333 });
    expect(r.data!.interfaces).toEqual([iface("wan1")]);
  });

  it("vCenter: an unreachable server is a supported error; otherwise the pinned subset", async () => {
    m.resolve.mockResolvedValue(settings({ interfacesPolling: "vcenter", storagePolling: "vcenter" }));
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ monitoredInterfaces: ["nic1"], monitoredStorage: ["/data"] }));
    m.readVcenterAsset.mockResolvedValue({ kind: "unreachable", error: "vCenter down" });
    expect(await collectFastFiltered("a1")).toEqual({ supported: true, error: "vCenter down" });

    m.readVcenterAsset.mockResolvedValue({ kind: "vm" });
    m.buildVcenterSystemInfo.mockReturnValue({ interfaces: [iface("nic1"), iface("nic2")], storage: [{ mountPath: "/data" }, { mountPath: "/" }] });
    expect(await collectFastFiltered("a1")).toEqual({ supported: true, data: { interfaces: [iface("nic1")], storage: [{ mountPath: "/data" }] } });
  });

  it("an unsupported method (WinRM) is not a fast-pass source", async () => {
    m.resolve.mockResolvedValue(settings({ interfacesPolling: "winrm" }));
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ monitoredInterfaces: ["eth0"] }));
    expect(await collectFastFiltered("a1")).toEqual({ supported: false });
  });

  it("a scrape that throws is a supported error", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ monitorCredential: SNMP, monitoredInterfaces: ["port1"] }));
    m.fastSnmp.mockRejectedValue(new Error("no response"));
    expect(await collectFastFiltered("a1")).toEqual({ supported: true, error: "no response" });
  });
});

describe("recordFastFilteredResult", () => {
  it("writes nothing for an unsupported or failed scrape", async () => {
    await recordFastFilteredResult("a1", { supported: false });
    await recordFastFilteredResult("a1", { supported: true, error: "x" });
    expect(m.enqueueIf).not.toHaveBeenCalled();
    expect(m.enqueueSt).not.toHaveBeenCalled();
  });

  it("queues fast-cadence rows, counters as BigInt, and records link events", async () => {
    await recordFastFilteredResult("a1", {
      supported: true,
      data: {
        interfaces: [{ ifName: "port1", operStatus: "up", speedBps: 1e9, inOctets: 12.6, outOctets: null, ipAddress: "10.0.0.1" } as never],
        storage: [{ mountPath: "/", totalBytes: 100, usedBytes: null }],
        ipsecTunnels: [{ tunnelName: "t", parentInterface: "wan1", remoteGateway: "1.2.3.4", status: "up", incomingBytes: 5, outgoingBytes: null, proxyIdCount: 1 } as never],
      },
    });
    const row = m.enqueueIf.mock.calls[0][0][0];
    expect(row).toMatchObject({ assetId: "a1", cadence: "fast", ifName: "port1", speedBps: 1_000_000_000n, inOctets: 13n, outOctets: null, ipAddress: "10.0.0.1", ifType: null, taggedVlans: [], trunksAllVlans: false });
    expect(m.linkEvents).toHaveBeenCalledWith(m.enqueueIf.mock.calls[0][0]);
    expect(m.enqueueSt.mock.calls[0][0][0]).toMatchObject({ cadence: "fast", mountPath: "/", totalBytes: 100n, usedBytes: null });
    expect(m.enqueueTn.mock.calls[0][0][0]).toMatchObject({ cadence: "fast", tunnelName: "t", incomingBytes: 5n, outgoingBytes: null });
  });

  it("an empty fast scrape queues nothing", async () => {
    await recordFastFilteredResult("a1", { supported: true, data: { interfaces: [], storage: [] } });
    expect(m.enqueueIf).not.toHaveBeenCalled();
    expect(m.enqueueSt).not.toHaveBeenCalled();
    expect(m.enqueueTn).not.toHaveBeenCalled();
  });
});
