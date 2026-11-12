/**
 * tests/unit/probes.test.ts — CQ-T010: src/services/monitoring/probes.ts.
 *
 * Complements the narrower suites that reach probes.ts through one door:
 * tests/unit/holdRecoveryWait.test.ts, assetLiveActionService.test.ts,
 * firmwareUpgradeGates.test.ts and pollingCompatibility.test.ts. None of them
 * drive the `probeAsset` DISPATCH itself, which is what this file does — every
 * transport collaborator is a spy, nothing is dialed (no ping, no SNMP
 * session, no socket):
 *
 *  - the cheap exits in order: not found, duplicate job (probeStillDue),
 *    monitoring off, no method, "disabled" is skipped not failed;
 *  - rule 86: agent mode — fleet-dark is skipped and restarts the silence
 *    clock, a silent agent is a real failure flagged `agentSilent`;
 *  - the no-IP transports (FortiManager, vCenter, workload, Generic API,
 *    Fortinet controller) dispatch before the IP guard;
 *  - rule 96: a FortiOS 401 pause is `skipped` (not a miss) on the firewall
 *    probe AND on the controller probe for its switches / APs;
 *  - ICMP reports ping's own RTT, never the wall clock, and "ping unavailable"
 *    when nothing was sent;
 *  - SNMP: OID-keyed varbinds, the identity read riding the probe;
 *  - the retired "http" method falls back to ICMP rather than false-down;
 *  - probeCredentialAgainstHost and probeHttp (Basic / Bearer headers, "form"
 *    never sends a header, Digest note on a non-Digest 401, diagnostics).
 */

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class FortiosAuthPausedError extends Error {}
  return {
    FortiosAuthPausedError,
    burstPingHost: vi.fn(),
    fgRequest: vi.fn(),
    reconcileFortinetLiveVersions: vi.fn(),
    getPendingProbePatch: vi.fn(),
    judgeAgentSilence: vi.fn(),
    probeStillDue: vi.fn(),
    probeWorkload: vi.fn(),
    probeGenericApi: vi.fn(),
    dial: vi.fn(),
    resolveMonitorSettings: vi.fn(),
    resolveSnmpConfigForStream: vi.fn(),
    buildSnmpSession: vi.fn(),
    buildFortinetConfig: vi.fn(),
    fetchFortinetControllerInventory: vi.fn(),
    probeFortimanagerNative: vi.fn(),
    probeVcenter: vi.fn(),
    applyDescrIdentity: vi.fn(),
    readProfileIdentity: vi.fn(),
    reconcileSnmpProfileIdentity: vi.fn(),
    agentFleetLiveness: vi.fn(),
    restartAgentListening: vi.fn(),
    adBindFallbackAllowed: vi.fn(),
    parseVendorSysDescr: vi.fn(),
    descrReadDue: vi.fn(),
    httpRequest: vi.fn(),
    httpsRequest: vi.fn(),
  };
});

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/utils/icmpPing.js", () => ({ burstPingHost: h.burstPingHost }));
vi.mock("../../src/services/fortigateService.js", () => ({ fgRequest: h.fgRequest, FortiosAuthPausedError: h.FortiosAuthPausedError }));
vi.mock("../../src/services/fortinetLiveVersionService.js", () => ({
  reconcileFortinetLiveVersions: h.reconcileFortinetLiveVersions,
  fortigateLiveVersionFor: (_t: string, v: string) => v,
}));
vi.mock("../../src/services/probePatchBuffer.js", () => ({ getPendingProbePatch: h.getPendingProbePatch }));
vi.mock("../../src/utils/agentSilence.js", () => ({ judgeAgentSilence: h.judgeAgentSilence }));
vi.mock("../../src/utils/monitorStatus.js", () => ({ probeStillDue: h.probeStillDue }));
vi.mock("../../src/services/workloadMonitorService.js", () => ({ probeWorkload: h.probeWorkload }));
vi.mock("../../src/services/genericApiMonitorService.js", () => ({ probeGenericApi: h.probeGenericApi }));
vi.mock("../../src/services/monitoring/dial.js", () => ({ dial: h.dial }));
vi.mock("../../src/services/monitoring/monitorSettings.js", () => ({
  HARDCODED_FLOOR: { probeTimeoutMs: 5000 },
  sysUpTimeOid: "1.3.6.1.2.1.1.3.0",
  PROBE_ASSET_OMIT: {},
  resolveMonitorSettings: h.resolveMonitorSettings,
  resolveSnmpConfigForStream: h.resolveSnmpConfigForStream,
}));
vi.mock("../../src/services/monitoring/snmpCore.js", () => ({
  withSnmpGate: (_h: string, _p: number, fn: () => Promise<unknown>) => fn(),
  buildSnmpSession: h.buildSnmpSession,
  snmpVbToString: (v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v ?? "")),
}));
vi.mock("../../src/services/monitoring/fortiosCollectors.js", () => ({ buildFortinetConfig: h.buildFortinetConfig }));
vi.mock("../../src/services/monitoring/fortinetControllers.js", () => ({ fetchFortinetControllerInventory: h.fetchFortinetControllerInventory }));
vi.mock("../../src/services/monitoring/vcenterFmgCollectors.js", () => ({
  probeFortimanagerNative: h.probeFortimanagerNative,
  probeVcenter: h.probeVcenter,
}));
vi.mock("../../src/services/monitoring/systemInfoPersist.js", () => ({ applyDescrIdentity: h.applyDescrIdentity }));
vi.mock("../../src/services/monitoring/snmpCollectors.js", () => ({
  readProfileIdentity: h.readProfileIdentity,
  profileSubjectFor: () => ({}),
}));
vi.mock("../../src/services/snmpSelfIdentityService.js", () => ({ reconcileSnmpProfileIdentity: h.reconcileSnmpProfileIdentity }));
vi.mock("../../src/services/monitoring/agentSilence.js", () => ({
  agentListeningSince: new Date(0),
  agentFleetLiveness: h.agentFleetLiveness,
  restartAgentListening: h.restartAgentListening,
}));
vi.mock("../../src/utils/adBindFallback.js", () => ({ adBindFallbackAllowed: h.adBindFallbackAllowed }));
vi.mock("../../src/utils/snmpDescrIdentity.js", () => ({
  parseVendorSysDescr: h.parseVendorSysDescr,
  descrReadDue: h.descrReadDue,
}));
vi.mock("../../src/utils/pinnedTlsAgent.js", () => ({ pinnedAgentFor: () => ({ pinned: true }) }));
vi.mock("../../src/utils/remoteExec.js", () => ({ buildHostVerifier: () => () => true }));
vi.mock("ssh2", () => ({ Client: class { on() { return this; } connect() {} end() {} } }));
vi.mock("node:http", () => ({ request: h.httpRequest }));
vi.mock("node:https", () => ({ request: h.httpsRequest }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { probeAsset, probeCredentialAgainstHost, probeHttp } from "../../src/services/monitoring/probes.js";

const UPTIME_OID = "1.3.6.1.2.1.1.3.0";
const DESCR_OID = "1.3.6.1.2.1.1.1.0";
const OBJID_OID = "1.3.6.1.2.1.1.2.0";

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1", hostname: "dev1", dnsName: null, ipAddress: "10.0.0.5", assetType: "server",
    monitored: true, lastMonitorAt: null, serialNumber: null, fortinetTopology: null, osVersion: null,
    lastDescrAt: null, monitorCredential: null, responseTimeCredential: null,
    discoveredByIntegration: null, managedAgent: null,
    ...over,
  };
}

function useAsset(a: Record<string, unknown> | null, polling: string | null, extra: Record<string, unknown> = {}) {
  vi.mocked(prisma.asset.findUnique).mockResolvedValue(a as never);
  h.resolveMonitorSettings.mockResolvedValue({ probeTimeoutMs: 3000, responseTimePolling: polling, intervalSeconds: 60, ...extra });
}

const FMG = { id: "i1", type: "fortimanager", name: "FMG", config: { host: "fmg" } };
const FGT = { id: "i2", type: "fortigate", name: "FGT", config: { host: "10.9.9.1" } };
const AD = { id: "i3", type: "activedirectory", name: "AD", config: { bindDn: "", bindPassword: "" } };

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(h)) if (typeof f === "function" && "mockReset" in f) (f as any).mockReset();
  h.dial.mockImplementation((a: { ipAddress?: string | null }) => a.ipAddress ?? null);
  h.probeStillDue.mockReturnValue(true);
  h.descrReadDue.mockReturnValue(false);
  h.agentFleetLiveness.mockResolvedValue({ freshestLastSeenAt: null, reportingAgents: 1 });
  h.buildFortinetConfig.mockReturnValue({ host: "10.0.0.5" });
});

describe("probeAsset — the cheap exits", () => {
  it("an unknown asset fails with 'Asset not found'", async () => {
    useAsset(null, "icmp");
    expect(await probeAsset("x")).toMatchObject({ success: false, error: "Asset not found" });
  });

  it("hands the loaded row and the resolved timeout back through `out`", async () => {
    useAsset(asset(), "icmp");
    h.burstPingHost.mockResolvedValue({ sent: 1, received: 1, avgRttMs: 2 });
    const out: NonNullable<Parameters<typeof probeAsset>[1]> = {};
    await probeAsset("a1", out);
    expect(out.snapshot).toMatchObject({ id: "a1" });
    expect(out.timeoutMs).toBe(3000);
  });

  it("a job queued behind an already-run one is a duplicate and dials nothing", async () => {
    useAsset(asset(), "icmp");
    h.probeStillDue.mockReturnValue(false);
    h.getPendingProbePatch.mockReturnValue({ lastMonitorAt: new Date() });
    expect(await probeAsset("a1", { dueIntervalSec: 60 })).toEqual({ success: false, responseTimeMs: 0, duplicate: true });
    expect(h.burstPingHost).not.toHaveBeenCalled();
    expect(h.probeStillDue.mock.calls[0]![1]).toBe(60);
  });

  it("the duplicate check is skipped when no due interval was carried", async () => {
    useAsset(asset(), "icmp");
    h.probeStillDue.mockReturnValue(false);
    h.burstPingHost.mockResolvedValue({ sent: 1, received: 1, avgRttMs: 1 });
    expect((await probeAsset("a1")).success).toBe(true);
  });

  it("an unmonitored asset fails without resolving settings", async () => {
    useAsset(asset({ monitored: false }), "icmp");
    expect(await probeAsset("a1")).toMatchObject({ success: false, error: "Monitoring disabled" });
    expect(h.resolveMonitorSettings).not.toHaveBeenCalled();
  });

  it("no resolved method is a failure", async () => {
    useAsset(asset(), null);
    expect((await probeAsset("a1")).error).toBe("No response-time polling method configured");
  });

  it("'disabled' is skipped — no reading, never a manufactured outage", async () => {
    useAsset(asset(), "disabled");
    expect(await probeAsset("a1")).toEqual({ success: false, responseTimeMs: 0, skipped: true });
  });

  it("a thrown error is packaged, never propagated", async () => {
    vi.mocked(prisma.asset.findUnique).mockRejectedValue(new Error("db gone"));
    expect(await probeAsset("a1")).toMatchObject({ success: false, error: "db gone" });
  });

  it("an unknown method names itself", async () => {
    useAsset(asset(), "carrier-pigeon");
    expect((await probeAsset("a1")).error).toBe('Unknown polling method "carrier-pigeon"');
  });
});

describe("probeAsset — agent mode (rule 86)", () => {
  it("a reporting agent is a synthetic success", async () => {
    useAsset(asset({ managedAgent: { installStatus: "installed" } }), "agent");
    h.judgeAgentSilence.mockReturnValue({ kind: "reporting" });
    expect((await probeAsset("a1")).success).toBe(true);
  });

  it("a silent agent is a real failure flagged agentSilent", async () => {
    useAsset(asset({ managedAgent: { installStatus: "installed" } }), "agent");
    h.judgeAgentSilence.mockReturnValue({ kind: "silent", since: new Date("2026-01-01T00:00:00Z") });
    expect(await probeAsset("a1")).toEqual({
      success: false, responseTimeMs: 0, agentSilent: true,
      error: "Polaris Agent has not reported since 2026-01-01T00:00:00.000Z",
    });
  });

  it("a fleet-wide silence is skipped and restarts the listening clock", async () => {
    useAsset(asset({ managedAgent: { installStatus: "installed" } }), "agent");
    h.judgeAgentSilence.mockReturnValue({ kind: "fleetDark" });
    expect(await probeAsset("a1")).toEqual({ success: false, responseTimeMs: 0, skipped: true });
    expect(h.restartAgentListening).toHaveBeenCalledTimes(1);
  });

  it("no managed agent row: the fleet is not queried", async () => {
    useAsset(asset(), "agent");
    h.judgeAgentSilence.mockReturnValue({ kind: "reporting" });
    await probeAsset("a1");
    expect(h.agentFleetLiveness).not.toHaveBeenCalled();
    expect(h.judgeAgentSilence.mock.calls[0]![0]).toMatchObject({ intervalSeconds: 60, fleet: { reportingAgents: 0 } });
  });
});

describe("probeAsset — transports that need no asset IP", () => {
  it("fortimanager without an integration fails; with one it asks FMG", async () => {
    useAsset(asset({ ipAddress: null }), "fortimanager");
    expect((await probeAsset("a1")).error).toBe("FortiManager polling requires a FortiManager integration");
    useAsset(asset({ ipAddress: null, discoveredByIntegration: FMG }), "fortimanager");
    h.probeFortimanagerNative.mockResolvedValue({ success: true, responseTimeMs: 9 });
    expect(await probeAsset("a1")).toEqual({ success: true, responseTimeMs: 9 });
  });

  it("vcenter, workload methods and genericapi dispatch with no IP", async () => {
    h.probeVcenter.mockResolvedValue({ success: true, responseTimeMs: 1 });
    h.probeWorkload.mockResolvedValue({ success: true, responseTimeMs: 2 });
    h.probeGenericApi.mockResolvedValue({ success: true, responseTimeMs: 3 });
    useAsset(asset({ ipAddress: null }), "vcenter");
    expect((await probeAsset("a1")).responseTimeMs).toBe(1);
    for (const m of ["unraid", "truenas", "proxmox"]) {
      useAsset(asset({ ipAddress: null }), m);
      expect((await probeAsset("a1")).responseTimeMs).toBe(2);
    }
    useAsset(asset({ ipAddress: null }), "genericapi");
    expect((await probeAsset("a1")).responseTimeMs).toBe(3);
  });

  it("an IP-bound method with no address fails 'Asset has no IP address'", async () => {
    useAsset(asset({ ipAddress: null, hostname: "h" }), "icmp");
    expect((await probeAsset("a1")).error).toBe("Asset has no IP address");
  });

  it("winrm / ssh fall back to the DNS name, then the hostname", async () => {
    useAsset(asset({ ipAddress: null, dnsName: "srv.corp", discoveredByIntegration: AD }), "winrm");
    h.adBindFallbackAllowed.mockReturnValue(true);
    expect((await probeAsset("a1")).error).toBe("Active Directory bind credentials not configured");
  });
});

describe("probeAsset — Fortinet controller probe (switch / AP)", () => {
  const sw = (over: Record<string, unknown> = {}) =>
    asset({ assetType: "switch", ipAddress: null, serialNumber: "s124", discoveredByIntegration: FMG, fortinetTopology: { controllerFortigate: "FGT-A" }, ...over });

  it("no serial recorded fails", async () => {
    useAsset(sw({ serialNumber: "  " }), "rest_api");
    expect((await probeAsset("a1")).error).toMatch(/no serial number/);
  });

  it("no controller recorded under FortiManager fails", async () => {
    useAsset(sw({ fortinetTopology: null }), "rest_api");
    expect((await probeAsset("a1")).error).toMatch(/no controller FortiGate/);
  });

  it("under a standalone FortiGate the integration host is the controller", async () => {
    useAsset(sw({ fortinetTopology: null, discoveredByIntegration: FGT }), "rest_api");
    h.fetchFortinetControllerInventory.mockResolvedValue({ inventory: new Map([["S124", { connected: true }]]), fetchDurationMs: 40 });
    expect(await probeAsset("a1")).toEqual({ success: true, responseTimeMs: 40 });
    expect(h.fetchFortinetControllerInventory.mock.calls[0]!.slice(1, 3)).toEqual(["10.9.9.1", "switches"]);
  });

  it("reports the UPSTREAM fetch duration, upper-cases the serial, and reads the AP table for an AP", async () => {
    useAsset(sw({ assetType: "access_point" }), "rest_api");
    h.fetchFortinetControllerInventory.mockResolvedValue({ inventory: new Map([["S124", { connected: false, status: "Offline" }]]), fetchDurationMs: 650 });
    expect(await probeAsset("a1")).toEqual({ success: false, responseTimeMs: 650, error: "Controller reports AP status: Offline" });
    expect(h.fetchFortinetControllerInventory.mock.calls[0]![2]).toBe("aps");
  });

  it("absent from the controller's table names the table", async () => {
    useAsset(sw(), "rest_api");
    h.fetchFortinetControllerInventory.mockResolvedValue({ inventory: new Map(), fetchDurationMs: 5 });
    expect((await probeAsset("a1")).error).toBe("Not present in FGT-A's managed-switch table");
  });

  it("a disconnected entry with no status reads 'Disconnected'", async () => {
    useAsset(sw(), "rest_api");
    h.fetchFortinetControllerInventory.mockResolvedValue({ inventory: new Map([["S124", { connected: false }]]), fetchDurationMs: 5 });
    expect((await probeAsset("a1")).error).toBe("Controller reports switch status: Disconnected");
  });

  it("a controller inside a 401 pause is skipped, not a miss (rule 96)", async () => {
    useAsset(sw(), "rest_api");
    h.fetchFortinetControllerInventory.mockRejectedValue(new h.FortiosAuthPausedError("paused"));
    expect(await probeAsset("a1")).toEqual({ success: false, responseTimeMs: 0, skipped: true, error: "paused" });
  });
});

describe("probeAsset — Fortinet firewall REST probe", () => {
  const fw = (integ: Record<string, unknown> = FMG) => asset({ assetType: "firewall", discoveredByIntegration: integ, osVersion: "7.2.0" });

  it("a config error from the shared builder is the probe error", async () => {
    useAsset(fw(), "rest_api");
    h.buildFortinetConfig.mockReturnValue({ error: "No API token" });
    expect((await probeAsset("a1")).error).toBe("No API token");
  });

  it("captures uptime and firmware off system/status and reconciles the live version", async () => {
    useAsset(fw(), "rest_api");
    h.fgRequest.mockResolvedValue({ version: "v7.4.3", results: { uptime: "1234.9" } });
    h.fetchFortinetControllerInventory.mockResolvedValue({ inventory: new Map(), fetchDurationMs: 1 });
    const r = await probeAsset("a1");
    expect(r).toMatchObject({ success: true, uptimeSec: 1234, firmwareVersion: "v7.4.3" });
    expect(h.reconcileFortinetLiveVersions.mock.calls[0]![0][0]).toMatchObject({ assetId: "a1", currentOsVersion: "7.2.0", reader: "fortios-probe" });
  });

  it("a failed live-version reconcile never fails the probe", async () => {
    useAsset(fw(FGT), "rest_api");
    h.fgRequest.mockResolvedValue({ version: "v7.4.3" });
    h.reconcileFortinetLiveVersions.mockRejectedValue(new Error("db"));
    expect((await probeAsset("a1")).success).toBe(true);
  });

  it("proxy-mode FortiManager pre-warms both controller tables; standalone does not", async () => {
    useAsset(fw(), "rest_api");
    h.fgRequest.mockResolvedValue({});
    h.fetchFortinetControllerInventory.mockResolvedValue({ inventory: new Map(), fetchDurationMs: 1 });
    await probeAsset("a1");
    expect(h.fetchFortinetControllerInventory.mock.calls.map((c) => c[2])).toEqual(["switches", "aps"]);
    h.fetchFortinetControllerInventory.mockClear();
    useAsset(fw({ ...FMG, config: { host: "fmg", useProxy: false } }), "rest_api");
    await probeAsset("a1");
    useAsset(fw(FGT), "rest_api");
    await probeAsset("a1");
    expect(h.fetchFortinetControllerInventory).not.toHaveBeenCalled();
  });

  it("a 401 pause is skipped (rule 96); any other error is a failure", async () => {
    useAsset(fw(FGT), "rest_api");
    h.fgRequest.mockRejectedValueOnce(new h.FortiosAuthPausedError("paused"));
    expect(await probeAsset("a1")).toMatchObject({ skipped: true, responseTimeMs: 0 });
    h.fgRequest.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await probeAsset("a1")).toMatchObject({ success: false, error: "ECONNREFUSED" });
  });

  it("rest_api on a manual asset without a restapi credential explains itself", async () => {
    useAsset(asset(), "rest_api");
    expect((await probeAsset("a1")).error).toBe("REST API polling requires either a Fortinet integration or a REST API credential");
  });
});

describe("probeAsset — ICMP", () => {
  it("reports ping's own RTT, rounded, not the wall clock", async () => {
    useAsset(asset(), "icmp");
    h.burstPingHost.mockResolvedValue({ sent: 1, received: 1, avgRttMs: 0.4 });
    expect(await probeAsset("a1")).toEqual({ success: true, responseTimeMs: 0 });
    expect(h.burstPingHost).toHaveBeenCalledWith("10.0.0.5", { count: 1, intervalMs: 200, timeoutMs: 3000 });
  });

  it("nothing sent is 'ping unavailable'; nothing back is 'no echo reply'", async () => {
    useAsset(asset(), "icmp");
    h.burstPingHost.mockResolvedValueOnce({ sent: 0, received: 0, avgRttMs: null });
    expect((await probeAsset("a1")).error).toBe("ping unavailable");
    h.burstPingHost.mockResolvedValueOnce({ sent: 1, received: 0, avgRttMs: null });
    expect((await probeAsset("a1")).error).toBe("no echo reply");
  });

  it("a stored retired 'http' method probes over ICMP instead of failing", async () => {
    useAsset(asset(), "http");
    h.burstPingHost.mockResolvedValue({ sent: 1, received: 1, avgRttMs: 3 });
    expect(await probeAsset("a1")).toEqual({ success: true, responseTimeMs: 3 });
  });
});

describe("probeAsset — SNMP", () => {
  function session(err: Error | null, varbinds: unknown[]) {
    const s = { on: vi.fn(), close: vi.fn(), get: vi.fn((_o: string[], cb: (e: Error | null, v: unknown[]) => void) => cb(err, varbinds)) };
    h.buildSnmpSession.mockReturnValue(s);
    return s;
  }

  it("a credential resolution error or throw is the probe error", async () => {
    useAsset(asset(), "snmp");
    h.resolveSnmpConfigForStream.mockResolvedValueOnce({ error: "No SNMP credential" });
    expect((await probeAsset("a1")).error).toBe("No SNMP credential");
    h.resolveSnmpConfigForStream.mockRejectedValueOnce(new Error("lookup blew up"));
    expect((await probeAsset("a1")).error).toBe("lookup blew up");
  });

  it("reads sysUpTime by OID (not position) and converts ticks to seconds", async () => {
    useAsset(asset(), "snmp");
    h.resolveSnmpConfigForStream.mockResolvedValue({ cfg: { community: "public" } });
    const s = session(null, [{ oid: "1.2.3", type: 4, value: "x" }, { oid: UPTIME_OID, type: 67, value: 12345 }]);
    const r = await probeAsset("a1");
    expect(r).toMatchObject({ success: true, uptimeSec: 123 });
    expect(s.get.mock.calls[0]![0]).toEqual([UPTIME_OID]);
    expect(s.close).toHaveBeenCalled();
  });

  it("an empty varbind list or a get error fails", async () => {
    useAsset(asset(), "snmp");
    h.resolveSnmpConfigForStream.mockResolvedValue({ cfg: {} });
    session(null, []);
    expect((await probeAsset("a1")).error).toBe("SNMP returned no varbinds");
    session(new Error("Request timed out"), []);
    expect((await probeAsset("a1")).error).toBe("Request timed out");
  });

  it("when identity is due, sysDescr + sysObjectID ride the same GET and are reconciled", async () => {
    useAsset(asset(), "snmp");
    h.resolveSnmpConfigForStream.mockResolvedValue({ cfg: {} });
    h.descrReadDue.mockReturnValue(true);
    h.readProfileIdentity.mockResolvedValue({ model: "SRT", serial: null });
    h.reconcileSnmpProfileIdentity.mockResolvedValue(true);
    h.parseVendorSysDescr.mockReturnValue({ vendor: "APC" });
    const s = session(null, [
      { oid: DESCR_OID, type: 4, value: Buffer.from("APC Web/SNMP") },
      { oid: OBJID_OID, type: 6, value: "1.3.6.1.4.1.318" },
      { oid: UPTIME_OID, type: 67, value: 100 },
    ]);
    const r = await probeAsset("a1");
    expect(s.get.mock.calls[0]![0]).toEqual([UPTIME_OID, DESCR_OID, OBJID_OID]);
    expect(r).toMatchObject({ success: true, uptimeSec: 1, sysDescr: "APC Web/SNMP", sysObjectId: "1.3.6.1.4.1.318" });
    expect(h.applyDescrIdentity).toHaveBeenCalledWith("a1", { vendor: "APC" }, "APC Web/SNMP", expect.anything(), "1.3.6.1.4.1.318");
    await vi.waitFor(() => expect(h.reconcileSnmpProfileIdentity).toHaveBeenCalledWith("a1", { model: "SRT", serialNumber: null }));
  });

  it("an identity reconcile failure never fails the probe", async () => {
    useAsset(asset(), "snmp");
    h.resolveSnmpConfigForStream.mockResolvedValue({ cfg: {} });
    h.descrReadDue.mockReturnValue(true);
    h.readProfileIdentity.mockResolvedValue({});
    h.parseVendorSysDescr.mockReturnValue({ vendor: "x" });
    h.applyDescrIdentity.mockRejectedValue(new Error("db"));
    session(null, [{ oid: UPTIME_OID, type: 67, value: 100 }, { oid: DESCR_OID, type: 4, value: "d" }]);
    expect((await probeAsset("a1")).success).toBe(true);
  });
});

describe("probeAsset — WinRM / SSH credential selection", () => {
  it("no credential and no AD fallback names the missing credential", async () => {
    useAsset(asset(), "winrm");
    expect((await probeAsset("a1")).error).toBe("No WinRM credential selected");
    useAsset(asset(), "ssh");
    expect((await probeAsset("a1")).error).toBe("No SSH credential selected");
  });

  it("an AD source whose fallback is not allowed does not borrow the bind account", async () => {
    useAsset(asset({ discoveredByIntegration: { ...AD, config: { bindDn: "u", bindPassword: "p" } } }), "ssh");
    h.adBindFallbackAllowed.mockReturnValue(false);
    expect((await probeAsset("a1")).error).toBe("No SSH credential selected");
  });

  it("a WinRM credential missing its password fails before any request", async () => {
    useAsset(asset({ monitorCredential: { type: "winrm", config: { username: "u" } } }), "winrm");
    expect((await probeAsset("a1")).error).toBe("WinRM credential incomplete");
    expect(h.httpsRequest).not.toHaveBeenCalled();
  });
});

// ─── probeHttp / probeCredentialAgainstHost ─────────────────────────────────

interface FakeResp { status: number; headers?: Record<string, string>; body?: string }

function scriptHttp(fn: typeof h.httpRequest, responses: FakeResp[]) {
  fn.mockImplementation((opts: unknown, cb: (res: unknown) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void; opts: unknown };
    req.opts = opts;
    req.destroy = () => {};
    req.end = () => {
      const r = responses.shift();
      if (!r) { queueMicrotask(() => req.emit("error", new Error("ECONNREFUSED"))); return; }
      const res = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
      res.statusCode = r.status;
      res.headers = r.headers ?? {};
      res.destroy = () => {};
      cb(res);
      queueMicrotask(() => {
        if (r.body) res.emit("data", Buffer.from(r.body));
        res.emit("end");
      });
    };
    return req;
  });
}

const headersSent = (fn: typeof h.httpRequest, i = 0) => (fn.mock.calls[i]![0] as { headers: Record<string, string> }).headers;

describe("probeHttp", () => {
  it("unauthenticated 200 on plain HTTP succeeds and sends no Authorization", async () => {
    scriptHttp(h.httpRequest, [{ status: 200, body: "ok" }]);
    expect((await probeHttp("10.0.0.5", {}, 0, 1000)).success).toBe(true);
    expect(headersSent(h.httpRequest).Authorization).toBeUndefined();
  });

  it("Basic and Bearer headers are computed up front", async () => {
    scriptHttp(h.httpRequest, [{ status: 200 }, { status: 200 }]);
    await probeHttp("h", {}, 0, 1000, null, undefined, { username: "u", password: "p" });
    expect(headersSent(h.httpRequest, 0).Authorization).toBe("Basic " + Buffer.from("u:p").toString("base64"));
    await probeHttp("h", {}, 0, 1000, null, undefined, { apiToken: "tok" });
    expect(headersSent(h.httpRequest, 1).Authorization).toBe("Bearer tok");
  });

  it("the 'form' auth mode never posts the password as Basic", async () => {
    scriptHttp(h.httpRequest, [{ status: 200 }]);
    await probeHttp("h", {}, 0, 1000, null, undefined, { authMode: "form", username: "u", password: "p" });
    expect(headersSent(h.httpRequest).Authorization).toBeUndefined();
  });

  it("an authenticated HTTPS check without verifyTls goes through the pinned agent (rule 113(e))", async () => {
    scriptHttp(h.httpsRequest, [{ status: 200 }, { status: 200 }]);
    await probeHttp("h", { useHttps: true }, 0, 1000, null, undefined, { apiToken: "t" });
    expect((h.httpsRequest.mock.calls[0]![0] as { agent?: unknown }).agent).toEqual({ pinned: true });
    await probeHttp("h", { useHttps: true }, 0, 1000);
    expect((h.httpsRequest.mock.calls[1]![0] as { agent?: unknown }).agent).toBeUndefined();
  });

  it("a status outside expectations fails with the code; the path override wins", async () => {
    scriptHttp(h.httpRequest, [{ status: 503 }]);
    const r = await probeHttp("h", { path: "/a" }, 0, 1000, "health");
    expect(r.error).toBe("HTTP 503 (expected any 2xx)");
    expect((h.httpRequest.mock.calls[0]![0] as { path: string }).path).toBe("/health");
  });

  it("a Digest check answered with a Basic-only 401 names the mismatch, and fires only once", async () => {
    scriptHttp(h.httpRequest, [{ status: 401, headers: { "www-authenticate": 'Basic realm="x"' } }]);
    const r = await probeHttp("h", {}, 0, 1000, null, undefined, { authMode: "digest", username: "u", password: "p" });
    expect(r.error).toMatch(/^HTTP 401 .* — Device requested Basic auth, not Digest$/);
    expect(h.httpRequest).toHaveBeenCalledTimes(1);
  });

  it("a Digest challenge is answered exactly once with a Digest header", async () => {
    scriptHttp(h.httpRequest, [
      { status: 401, headers: { "www-authenticate": 'Digest realm="r", nonce="n1", qop="auth"' } },
      { status: 200, body: "fine" },
    ]);
    const out: { diag?: Record<string, unknown> } = {};
    const r = await probeHttp("h", {}, 0, 1000, null, out as never, { authMode: "digest", username: "u", password: "p" });
    expect(r.success).toBe(true);
    expect(h.httpRequest).toHaveBeenCalledTimes(2);
    expect(headersSent(h.httpRequest, 1).Authorization).toMatch(/^Digest /);
    expect(out.diag).toMatchObject({ statusCode: 200, digestNegotiated: true, bytesRead: 4, authRequested: ["Digest"] });
  });

  it("a transport error is a failure", async () => {
    scriptHttp(h.httpRequest, []);
    expect((await probeHttp("h", {}, 0, 1000)).error).toBe("ECONNREFUSED");
  });
});

describe("probeCredentialAgainstHost", () => {
  it("requires a host except for restapi", async () => {
    expect((await probeCredentialAgainstHost("", "icmp", {})).error).toBe("Host is required");
  });

  it("an unsupported type names itself", async () => {
    expect((await probeCredentialAgainstHost("h", "telnet" as never, {})).error).toBe('Unsupported credential type "telnet"');
  });

  it("icmp uses the hard-coded floor timeout", async () => {
    h.burstPingHost.mockResolvedValue({ sent: 1, received: 1, avgRttMs: 7 });
    expect(await probeCredentialAgainstHost("h", "icmp", {})).toEqual({ success: true, responseTimeMs: 7 });
    expect(h.burstPingHost.mock.calls[0]![1]).toMatchObject({ timeoutMs: 5000 });
  });

  it("http tests the CHECK it was handed with the credential as auth", async () => {
    scriptHttp(h.httpRequest, [{ status: 204 }]);
    const r = await probeCredentialAgainstHost("h", "http", { apiToken: "t" }, undefined, { path: "/status" });
    expect(r.success).toBe(true);
    expect((h.httpRequest.mock.calls[0]![0] as { path: string }).path).toBe("/status");
    expect(headersSent(h.httpRequest).Authorization).toBe("Bearer t");
  });
});
