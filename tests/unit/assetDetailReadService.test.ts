/**
 * tests/unit/assetDetailReadService.test.ts — the own suite for
 * src/services/assetDetailReadService.ts (CQ-T010).
 *
 * Complements tests/integration/assistantSlideIns.test.ts (every assistant
 * section answers on the real schema with an all-permissions role) and the
 * route-level integration suites (monitorSettings, assetAddressNetworks,
 * tlsPinnedDispatcher, writeScope), which reach these reads through HTTP.
 * assetLiveActionService.test.ts's header mentions the monitor-history range
 * checks but has no case for them; they are here.
 *
 * Adds, with every collaborator mocked: the role gates of the assistant
 * sections (VIPs / contacts / gate sightings refused in their own slot, the
 * upstream firewall + subnet-gate halves passed from assetsQuarantine /
 * subnets — business rule 95), a failing section answering `{ error }` while
 * the others answer, duplicate sections read once, the compaction (nulls and
 * empties dropped, Dates to ISO, BigInts to numbers), the caps that say how
 * much was left out, the 1,500-character cut of raw integration payloads, the
 * no-secrets shapes (loginBound instead of the binding, the automation SUMMARY
 * only), the uptime said in words when nothing reads it, storage percentages,
 * workload children; getEffectiveMonitorSettings' covering profile (rule
 * 131/173), integration info and down-detection block (rule 36);
 * getAssetDetail's IPAM re-check that never fails the read (rule 102(a)), the
 * stripped integration config and its derived FMG / description-sync flags;
 * the IP history's per-gate network; the monitor-history ranges, the 400s,
 * the rollup-tier last success and the recovery-poll resolution.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Request } from "express";

const m = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  withProvenance: vi.fn(),
  resolveSettings: vi.fn(),
  snmpCred: vi.fn(),
  describeDown: vi.fn(),
  recoveryPolls: vi.fn(),
  ipHistory: vi.fn(),
  ipContexts: vi.fn(),
  networks: vi.fn(),
  discoveredHostname: vi.fn(),
  pickTier: vi.fn(),
  monitorHistory: vi.fn(),
  lastSuccess: vi.fn(),
  sdwanMembers: vi.fn(),
  reconcile: vi.fn(),
  shapeIps: vi.fn(),
  confidence: vi.fn(),
  refreshProfiles: vi.fn(),
  findProfile: vi.fn(),
  upstream: vi.fn(),
  vips: vi.fn(),
  contacts: vi.fn(),
  maintenance: vi.fn(),
  inferred: vi.fn(),
  radios: vi.fn(),
  ipsec: vi.fn(),
  procConns: vi.fn(),
  software: vi.fn(),
  fwAvail: vi.fn(),
  fwRuns: vi.fn(),
  rbAvail: vi.fn(),
  rbRuns: vi.fn(),
  pins: vi.fn(),
  sightings: vi.fn(),
  notifications: vi.fn(),
  tlsEndpoints: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/api/middleware/permissions.js", () => ({ hasPermission: m.hasPermission }));
vi.mock("../../src/services/monitoringService.js", () => ({ resolveMonitorSettingsWithProvenance: m.withProvenance, resolveMonitorSettings: m.resolveSettings }));
vi.mock("../../src/services/assetCredentialScopeService.js", () => ({ snmpPollingCredentialId: m.snmpCred }));
vi.mock("../../src/services/downDetectionService.js", () => ({ describeDownDetectionFor: m.describeDown, recoveryPollsFor: m.recoveryPolls }));
vi.mock("../../src/services/assetIpHistoryService.js", () => ({ getIpHistory: m.ipHistory }));
vi.mock("../../src/services/subnetService.js", () => ({ buildIpContexts: m.ipContexts, networksForAddresses: m.networks }));
vi.mock("../../src/services/discoveredHostnameService.js", () => ({ getDiscoveredHostname: m.discoveredHostname }));
vi.mock("../../src/services/sampleQueryRouter.js", () => ({ pickSampleTierForAsset: m.pickTier }));
vi.mock("../../src/services/sampleHistoryService.js", () => ({ readMonitorHistory: m.monitorHistory, readLastMonitorSuccessAt: m.lastSuccess, readSdwanMembers: m.sdwanMembers }));
vi.mock("../../src/utils/logger.js", () => {
  const logger: Record<string, unknown> = { warn: m.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  logger.child = () => logger;
  return { logger };
});
vi.mock("../../src/services/assetAddressService.js", () => ({ reconcileAddressesWithIpam: m.reconcile, shapeAssociatedIps: m.shapeIps, ASSOCIATED_IP_SELECT: { ip: true } }));
vi.mock("../../src/services/addressConfidenceService.js", () => ({ buildAddressConfidence: m.confidence, confidenceToJson: (c: unknown) => c ?? null }));
vi.mock("../../src/services/manufacturerProfileService.js", () => ({ refreshProfileCacheIfStale: m.refreshProfiles }));
vi.mock("../../src/services/profileResolver.js", () => ({ findDbProfile: m.findProfile }));
vi.mock("../../src/services/assetUpstreamService.js", () => ({ resolveAssetUpstream: m.upstream }));
vi.mock("../../src/services/assetVipService.js", () => ({ resolveAssetVips: m.vips }));
vi.mock("../../src/services/contactService.js", () => ({ resolveContactsForAsset: m.contacts }));
vi.mock("../../src/services/maintenanceScheduleService.js", () => ({ getAssetMaintenanceInfo: m.maintenance }));
vi.mock("../../src/services/peerInferredLldpService.js", () => ({
  buildInferredNeighborsForAsset: m.inferred,
  dedupeInferredNeighbors: (_l: unknown, inferred: unknown[]) => inferred,
  aggregateMembershipMap: () => new Map(),
}));
vi.mock("../../src/services/apRadioService.js", () => ({ getApRadioInventory: m.radios }));
vi.mock("../../src/services/ipsecConnectionService.js", () => ({ readAssetIpsec: m.ipsec }));
vi.mock("../../src/services/applicationMapService.js", () => ({ getAssetProcessConnections: m.procConns }));
vi.mock("../../src/services/softwareInventoryService.js", () => ({ getAssetSoftware: m.software }));
vi.mock("../../src/services/firmwareUpgradeService.js", () => ({ getUpgradeAvailability: m.fwAvail, listRunsForAsset: m.fwRuns }));
vi.mock("../../src/services/rebootService.js", () => ({ getRebootAvailability: m.rbAvail, listRebootRunsForAsset: m.rbRuns }));
vi.mock("../../src/services/agentHostPinService.js", () => ({ hostPinsForAsset: m.pins }));
vi.mock("../../src/services/assetSightingService.js", () => ({ getSightingsForAsset: m.sightings }));
vi.mock("../../src/services/notificationService.js", () => ({ getAssetNotifications: m.notifications }));
vi.mock("../../src/services/tlsCertPinService.js", () => ({ assetTlsEndpoints: m.tlsEndpoints }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import {
  ASSET_SECTIONS,
  assertAssetExists,
  assetTlsPins,
  findAssetScopeRecord,
  getAssetDetail,
  getAssetIpHistory,
  getEffectiveMonitorSettings,
  loadAssetScopeRecord,
  readAssetMonitorHistory,
  readAssetSections,
} from "../../src/services/assetDetailReadService.js";

const db = prisma as any;
const req = {} as Request;
const NOW = new Date("2026-11-13T12:00:00.000Z");

/** A role granting exactly these second keys at read. */
function grant(...keys: string[]): void {
  m.hasPermission.mockImplementation((_r: unknown, key: string) => keys.includes(key));
}

beforeEach(() => {
  resetDbStub();
  for (const f of Object.values(m)) f.mockReset();
  grant();
  m.refreshProfiles.mockResolvedValue(undefined);
  m.findProfile.mockReturnValue(null);
  m.withProvenance.mockResolvedValue({ resolved: { intervalSeconds: 60 }, provenance: { intervalSeconds: "default" } });
  m.snmpCred.mockResolvedValue(null);
  m.describeDown.mockResolvedValue(null);
  m.networks.mockResolvedValue(new Map());
  m.confidence.mockResolvedValue(new Map());
  m.shapeIps.mockImplementation((rows: unknown[]) => rows ?? []);
  m.ipContexts.mockResolvedValue(new Map());
});

// ─── getEffectiveMonitorSettings ─────────────────────────────────────────────

describe("getEffectiveMonitorSettings", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "a1", assetType: "ups", manufacturer: "APC", model: "SMT1500", os: null, ipAddress: "10.0.0.5",
    discoveredByIntegrationId: "i1",
    discoveredByIntegration: { name: "FMG", type: "fortimanager", pollInterval: 14400, config: { apiToken: "SECRET", monitorCredentialId: "c1" } },
    monitorCredentialId: "c-mon", responseTimeCredentialId: null, cpuMemoryCredentialId: null, temperatureCredentialId: null,
    interfacesCredentialId: null, lldpCredentialId: null, processesCredentialId: null, eventLogCredentialId: null,
    customWidgetPolling: null, customWidgetCredentialId: null,
    ...over,
  });

  it("404s an unknown asset", async () => {
    db.asset.findUnique.mockResolvedValue(null);
    await expect(getEffectiveMonitorSettings("nope")).rejects.toMatchObject({ httpStatus: 404, message: "Asset not found" });
  });

  it("resolves with the integration's type, names the integration without its config, and the covering profile's MIBs once each", async () => {
    db.asset.findUnique.mockResolvedValue(row());
    m.findProfile.mockReturnValue({ id: "p-apc", manufacturer: "APC" });
    db.mibFile.findMany.mockResolvedValue([{ moduleName: "PowerNet-MIB" }, { moduleName: "PowerNet-MIB" }, { moduleName: "UPS-MIB" }]);
    m.snmpCred.mockResolvedValue("c-mon");
    const out = await getEffectiveMonitorSettings("a1");
    expect(m.withProvenance.mock.calls[0][0]).toMatchObject({ id: "a1", discoveredByIntegrationType: "fortimanager" });
    expect(m.findProfile).toHaveBeenCalledWith({ manufacturer: "APC", os: null, model: "SMT1500", assetType: "ups", mibModule: null });
    expect(db.mibFile.findMany.mock.calls[0][0].where).toEqual({ manufacturer: { equals: "APC", mode: "insensitive" } });
    expect(out.manufacturerProfile).toEqual({ id: "p-apc", manufacturer: "APC", mibs: ["PowerNet-MIB", "UPS-MIB"] });
    expect(out.integration).toEqual({ id: "i1", name: "FMG", type: "fortimanager", pollInterval: 14400 });
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.snmpCredentialId).toBe("c-mon");
    // The SNMP Walk default sees the integration config (for its fallback) — but only it.
    expect(m.snmpCred.mock.calls[0][0].integration).toEqual({ type: "fortimanager", config: { apiToken: "SECRET", monitorCredentialId: "c1" } });
    expect(out.downDetection).toBeNull();
  });

  it("no covering profile, no MIB query; no integration, null info", async () => {
    db.asset.findUnique.mockResolvedValue(row({ discoveredByIntegration: null, discoveredByIntegrationId: null }));
    const out = await getEffectiveMonitorSettings("a1");
    expect(out.manufacturerProfile).toBeNull();
    expect(db.mibFile.findMany).not.toHaveBeenCalled();
    expect(out.integration).toBeNull();
    expect(m.withProvenance.mock.calls[0][0].discoveredByIntegrationType).toBeNull();
  });

  it("names the automation that decides down, its missed / recovery polls, severity and a tie (rule 36)", async () => {
    db.asset.findUnique.mockResolvedValue(row());
    m.describeDown.mockResolvedValue({
      passive: false,
      winner: { threshold: 3, ruleId: "r1", ruleName: "Core down", severity: "critical" },
      conflict: { ruleIds: ["r1", "r2"], counts: [3, 5], chosen: 3, extra: "dropped" },
    });
    m.recoveryPolls.mockReturnValue(2);
    const out = await getEffectiveMonitorSettings("a1");
    expect(m.recoveryPolls).toHaveBeenCalledWith(expect.objectContaining({ ruleId: "r1" }), 60);
    expect(out.downDetection).toEqual({
      passive: false, missedPolls: 3, recoveryPolls: 2, automationId: "r1", automationName: "Core down", severity: "critical",
      conflict: { ruleIds: ["r1", "r2"], counts: [3, 5], chosen: 3 },
    });
  });

  it("a passive device (no automation covers it) has no threshold to apply", async () => {
    db.asset.findUnique.mockResolvedValue(row());
    m.describeDown.mockResolvedValue({ passive: true, winner: null, conflict: null });
    const out = await getEffectiveMonitorSettings("a1");
    expect(out.downDetection).toEqual({ passive: true, missedPolls: null, recoveryPolls: null, automationId: null, automationName: null, severity: null, conflict: null });
    expect(m.recoveryPolls).not.toHaveBeenCalled();
  });
});

// ─── readAssetSections ───────────────────────────────────────────────────────

describe("readAssetSections — gates and isolation", () => {
  beforeEach(() => {
    m.upstream.mockResolvedValue({ switch: { id: "s1" } });
    m.vips.mockResolvedValue([{ vip: "203.0.113.5" }]);
    m.contacts.mockResolvedValue([{ name: "NOC" }]);
    db.assetMclagPeer.findMany.mockResolvedValue([]);
    db.assetSource.findMany.mockResolvedValue([]);
    m.pins.mockResolvedValue([]);
    m.sightings.mockResolvedValue([{ gate: "g1" }]);
  });

  it("a role without the second keys gets 'Not permitted' in the slot, never an empty list, and the upstream without the firewall halves", async () => {
    const out = await readAssetSections("a1", ["connections", "sources"], req, 50) as any;
    expect(out.connections.vips).toEqual({ error: "Not permitted: your role cannot read reservations (VIPs)." });
    expect(out.connections.contacts).toEqual({ error: "Not permitted: your role cannot read contacts." });
    expect(out.sources.gateSightings).toEqual({ error: "Not permitted: your role cannot read gate sightings." });
    expect(m.upstream).toHaveBeenCalledWith("a1", { includeFirewall: false, includeSubnetGate: false });
    expect(m.vips).not.toHaveBeenCalled();
    expect(m.contacts).not.toHaveBeenCalled();
    expect(m.sightings).not.toHaveBeenCalled();
  });

  it("with the keys, each slot is read through its tab's own service", async () => {
    grant("reservations", "contacts", "assetsQuarantine", "subnets");
    const out = await readAssetSections("a1", ["connections", "sources"], req, 50) as any;
    expect(m.upstream).toHaveBeenCalledWith("a1", { includeFirewall: true, includeSubnetGate: true });
    expect(out.connections).toMatchObject({ upstream: { switch: { id: "s1" } }, vips: [{ vip: "203.0.113.5" }], contacts: [{ name: "NOC" }] });
    expect(out.sources.gateSightings).toEqual({ rows: [{ gate: "g1" }], total: 1 });
  });

  it("a failing section answers { error } in its own slot; the others still answer; a section asked twice is read once", async () => {
    db.asset.findUnique.mockRejectedValue(new Error("db gone"));
    db.assetMacTableEntry.findMany.mockResolvedValue([]);
    db.assetMacTableEntry.count.mockResolvedValue(0);
    const out = await readAssetSections("a1", ["identity", "mac_table", "mac_table"], req, 50);
    expect(out.identity).toEqual({ error: "db gone" });
    expect(out.mac_table).toEqual({ total: 0 }); // compact() drops the empty list
    expect(db.assetMacTableEntry.count).toHaveBeenCalledTimes(1);
  });

  it("ASSET_SECTIONS lists sixteen sections", () => {
    expect(ASSET_SECTIONS).toHaveLength(16);
  });
});

describe("readAssetSections — section shapes", () => {
  it("identity: compacts (nulls / empties dropped, Dates to ISO) and cuts fortinetTopology at 1,500 characters", async () => {
    db.asset.findUnique.mockResolvedValue({
      notes: "rack 4", dnsName: null, description: "", associatedUsers: [], statusChangedAt: new Date("2026-11-01T00:00:00Z"),
      fortinetTopology: { blob: "x".repeat(2000) },
      macAddressRows: [{ mac: "AA:BB:CC:00:00:01", source: "dhcp", device: null, lastSeen: new Date("2026-11-02T00:00:00Z") }],
    });
    const out = (await readAssetSections("a1", ["identity"], req, 50)).identity as any;
    expect(out).not.toHaveProperty("dnsName");
    expect(out).not.toHaveProperty("description");
    expect(out).not.toHaveProperty("associatedUsers");
    expect(out.statusChangedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(out.macAddressRows).toEqual([{ mac: "AA:BB:CC:00:00:01", source: "dhcp", lastSeen: "2026-11-02T00:00:00.000Z" }]);
    expect(typeof out.fortinetTopology).toBe("string");
    expect(out.fortinetTopology).toHaveLength(1500 + "…(cut)".length);
    expect(out.fortinetTopology.endsWith("…(cut)")).toBe(true);
  });

  it("identity of an unknown asset is null", async () => {
    db.asset.findUnique.mockResolvedValue(null);
    expect((await readAssetSections("a1", ["identity"], req, 50)).identity).toBeNull();
  });

  it("monitoring: uptime said in words when no probe reads it; the streams, provenance and down rule from the effective settings", async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    try {
      db.asset.findUnique.mockImplementation(async ({ select }: any) => (select.monitored
        ? { monitored: true, monitorStatus: "up", lastUptimeSec: null, lastMonitorAt: NOW, lastRebootAt: null, consecutiveFailures: 0 }
        : { id: "a1", assetType: "server", manufacturer: null, model: null, os: null, discoveredByIntegration: null }));
      db.assetTelemetrySample.findFirst.mockResolvedValue({ timestamp: NOW, cpuPct: 12.5, memPct: null });
      m.maintenance.mockResolvedValue({ inWindow: false });
      const out = (await readAssetSections("a1", ["monitoring"], req, 50)).monitoring as any;
      expect(out.uptime).toBe("not reported: no probe on this device reads uptime (ICMP / SSH / WinRM only)");
      expect(out.state).toEqual({ monitored: true, monitorStatus: "up", lastMonitorAt: NOW.toISOString(), consecutiveFailures: 0 });
      expect(out.latestCpuMemory).toEqual({ timestamp: NOW.toISOString(), cpuPct: 12.5 });
      expect(out.streams).toEqual({ intervalSeconds: 60 });
      expect(out.settingSources).toEqual({ intervalSeconds: "default" });
      expect(out.maintenance).toEqual({ inWindow: false });

      db.asset.findUnique.mockImplementation(async ({ select }: any) => (select.monitored
        ? { monitored: true, monitorStatus: "up", lastUptimeSec: 3600, lastMonitorAt: NOW, lastRebootAt: null }
        : { id: "a1", assetType: "server", discoveredByIntegration: null }));
      const up = (await readAssetSections("a1", ["monitoring"], req, 50)).monitoring as any;
      expect(up.uptime).toMatchObject({ uptimeSec: 3600 });
      expect(up.state).not.toHaveProperty("lastUptimeSec");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hardware: the latest storage / sensor scrape only, BigInt bytes to numbers, usedPercent to one decimal, inventory capped", async () => {
    const at = new Date("2026-11-13T11:55:00Z");
    db.assetPhysicalEntity.findMany.mockResolvedValue([{ name: "PSU 1" }, { name: "PSU 2" }, { name: "Fan 1" }]);
    db.assetStorageSample.findFirst.mockResolvedValue({ timestamp: at });
    db.assetHardwareSensorSample.findFirst.mockResolvedValue(null);
    db.assetStorageSample.findMany.mockResolvedValue([
      { mountPath: "/", totalBytes: 1000n, usedBytes: 333n },
      { mountPath: "/empty", totalBytes: 0n, usedBytes: 0n },
    ]);
    const out = (await readAssetSections("a1", ["hardware"], req, 2)).hardware as any;
    expect(db.assetStorageSample.findMany.mock.calls[0][0].where).toEqual({ assetId: "a1", timestamp: at });
    expect(db.assetHardwareSensorSample.findMany).not.toHaveBeenCalled();
    expect(out.inventory).toEqual({ rows: [{ name: "PSU 1" }, { name: "PSU 2" }], total: 3, truncated: true });
    expect(out.storage).toEqual([{ mountPath: "/", totalBytes: 1000, usedBytes: 333, usedPercent: 33.3 }, { mountPath: "/empty", totalBytes: 0, usedBytes: 0 }]);
    expect(out.storageAt).toBe(at.toISOString());
    expect(out).not.toHaveProperty("sensorsAt");
    expect(out.sensors).toEqual({ total: 0 });
  });

  it("mac_table / arp_table: take the cap and say when the table is larger", async () => {
    db.assetArpEntry.findMany.mockResolvedValue([{ ipAddress: "10.0.0.1" }, { ipAddress: "10.0.0.2" }]);
    db.assetArpEntry.count.mockResolvedValue(9);
    const out = (await readAssetSections("a1", ["arp_table"], req, 2)).arp_table as any;
    expect(db.assetArpEntry.findMany.mock.calls[0][0].take).toBe(2);
    expect(out).toEqual({ total: 9, truncated: true, rows: [{ ipAddress: "10.0.0.1" }, { ipAddress: "10.0.0.2" }] });
  });

  it("neighbors: real LLDP first, then the inferred ones, named by their matched asset", async () => {
    db.assetLldpNeighbor.findMany.mockResolvedValue([{ localIfName: "port1", systemName: "core", source: "lldp", matchedAsset: { id: "c1", hostname: "core", ipAddress: "10.0.0.1", assetType: "switch" } }]);
    m.inferred.mockResolvedValue([{ localIfName: "port2", systemName: "ap-1", source: "peer-inferred", matchedAsset: null }]);
    db.assetInterface.findMany.mockResolvedValue([]);
    const out = (await readAssetSections("a1", ["neighbors"], req, 50)).neighbors as any;
    expect(out.rows).toEqual([
      { localPort: "port1", systemName: "core", source: "lldp", matchedAsset: { id: "c1", hostname: "core" } },
      { localPort: "port2", systemName: "ap-1", source: "peer-inferred" },
    ]);
  });

  it("virtualization: none; a guest names its host; a workload host lists its children", async () => {
    db.asset.findUnique.mockResolvedValueOnce({ virtualization: null });
    expect((await readAssetSections("a1", ["virtualization"], req, 50)).virtualization).toEqual({ virtualization: null });

    db.asset.findUnique
      .mockResolvedValueOnce({ virtualization: { role: "guest", hostAssetId: "h1", platform: "vmware" } })
      .mockResolvedValueOnce({ id: "h1", hostname: "esx-1", monitorStatus: "up" });
    const guest = (await readAssetSections("a1", ["virtualization"], req, 50)).virtualization as any;
    expect(guest.host).toEqual({ id: "h1", hostname: "esx-1", monitorStatus: "up" });
    expect(db.asset.findMany).not.toHaveBeenCalled();

    db.asset.findUnique.mockResolvedValueOnce({ virtualization: { role: "host", platform: "unraid" } });
    db.asset.findMany.mockResolvedValue([{ id: "c1", hostname: "plex", assetType: "container", monitorStatus: "up", virtualization: { role: "container", state: "running", image: "plex:latest", updateAvailable: true } }]);
    const host = (await readAssetSections("a1", ["virtualization"], req, 7)).virtualization as any;
    expect(db.asset.findMany.mock.calls[0][0]).toMatchObject({ where: { virtualization: { path: ["hostAssetId"], equals: "a1" }, status: { not: "decommissioned" } }, take: 7 });
    expect(host.workloads).toEqual([{ id: "c1", hostname: "plex", role: "container", state: "running", image: "plex:latest", updateAvailable: true, monitorStatus: "up" }]);
  });

  it("lifecycle: the agent without secrets, the firmware card with loginBound instead of the binding, a failing card answers its own error", async () => {
    db.managedAgent.findUnique.mockResolvedValue({ agentVersion: "0.30.0", installStatus: "active" });
    m.fwAvail.mockResolvedValue({
      state: "available", available: true, reason: null, platform: "fortigate", current: "7.4.3", image: { version: "7.6.8", id: "img" },
      vsPrimary: "older", primaryVersion: "7.6.8", blockers: [], credential: { id: "binding-1", username: "admin" }, activeRun: null, lastRun: null,
    });
    m.fwRuns.mockResolvedValue([]);
    m.rbAvail.mockRejectedValue(new Error("no reboot engine"));
    m.rbRuns.mockResolvedValue([{ id: "rr1" }]);
    const out = (await readAssetSections("a1", ["lifecycle"], req, 50)).lifecycle as any;
    expect(db.managedAgent.findUnique.mock.calls[0][0].select).not.toHaveProperty("bearerTokenHash");
    expect(Object.keys(db.managedAgent.findUnique.mock.calls[0][0].select).some((k) => /hash|secret|prefix/i.test(k))).toBe(false);
    expect(out.firmware).toEqual({ state: "available", available: true, platform: "fortigate", current: "7.4.3", target: "7.6.8", vsPrimary: "older", primaryVersion: "7.6.8", loginBound: true });
    expect(JSON.stringify(out)).not.toContain("binding-1");
    expect(out.reboot).toEqual({ error: "no reboot engine" });
    expect(out.rebootRuns).toEqual([{ id: "rr1" }]);
    expect(m.fwRuns).toHaveBeenCalledWith("a1", 5);
  });

  it("sources: each payload cut to 1,500 characters; a host-key pin failure is null, not an error", async () => {
    db.assetSource.findMany.mockResolvedValue([{ sourceKind: "vcenter-vm", externalId: "vm-1", observed: { big: "y".repeat(3000) }, integration: { name: "VC", type: "vcenter" } }]);
    m.pins.mockRejectedValue(new Error("pins down"));
    const out = (await readAssetSections("a1", ["sources"], req, 50)).sources as any;
    expect(out.sources.rows[0].observed.endsWith("…(cut)")).toBe(true);
    expect(out).not.toHaveProperty("hostKeyPins");
  });

  it("alerts: always the automation SUMMARY, never a full rule", async () => {
    m.notifications.mockResolvedValue({
      active: [{ severity: "critical", message: "down", triggeredAt: NOW, acknowledged: false, acknowledgedBy: null, ruleName: "Core down", groupName: null, maintenanceHold: null, apiHeaders: "SECRET" }],
      matchingRules: [{ id: "r1", name: "Core down" }],
    });
    const out = (await readAssetSections("a1", ["alerts"], req, 50)).alerts as any;
    expect(m.notifications).toHaveBeenCalledWith("a1", { fullRules: false });
    expect(out.active.rows).toEqual([{ severity: "critical", message: "down", triggeredAt: NOW.toISOString(), acknowledged: false, automation: "Core down" }]);
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.automationsApplying).toEqual({ rows: [{ id: "r1", name: "Core down" }], total: 1 });
  });

  it("software / processes / sdwan / ipsec / wireless pass their service's answer through, capped", async () => {
    m.software.mockResolvedValue({ collectedAt: NOW, rows: [{ name: "a" }, { name: "b" }, { name: "c" }] });
    db.assetProcess.findMany.mockResolvedValue([{ name: "sshd" }]);
    m.procConns.mockResolvedValue({ listeners: [] });
    db.assetSdwanRule.findMany.mockResolvedValue([{ ruleName: "r1" }]);
    m.sdwanMembers.mockResolvedValue({ members: [{ name: "wan1" }], collectedAt: NOW });
    m.ipsec.mockResolvedValue({ collectedAt: null, tunnels: [{ name: "t1" }], connections: [] });
    m.radios.mockResolvedValue([{ radioId: 1 }]);
    db.assetWirelessStation.findMany.mockResolvedValue([]);
    const out = await readAssetSections("a1", ["software", "processes", "sdwan", "ipsec", "wireless"], req, 2) as any;
    expect(out.software).toEqual({ collectedAt: NOW.toISOString(), rows: { rows: [{ name: "a" }, { name: "b" }], total: 3, truncated: true } });
    expect(out.processes.processes).toEqual({ rows: [{ name: "sshd" }], total: 1 });
    expect(out.sdwan).toEqual({ rules: { rows: [{ ruleName: "r1" }], total: 1 }, members: [{ name: "wan1" }], membersAt: NOW.toISOString() });
    expect(out.ipsec).toEqual({ tunnels: { rows: [{ name: "t1" }], total: 1 }, connections: { total: 0 } });
    expect(out.wireless).toEqual({ radios: [{ radioId: 1 }], stations: { total: 0 } });
  });
});

// ─── The small reads ─────────────────────────────────────────────────────────

describe("existence and scope reads", () => {
  it("assertAssetExists / loadAssetScopeRecord 404; findAssetScopeRecord answers null", async () => {
    db.asset.findUnique.mockResolvedValue(null);
    await expect(assertAssetExists("x")).rejects.toMatchObject({ httpStatus: 404 });
    await expect(loadAssetScopeRecord("x")).rejects.toMatchObject({ httpStatus: 404 });
    expect(await findAssetScopeRecord("x")).toBeNull();
    db.asset.findUnique.mockResolvedValue({ id: "a1", createdBy: "bob", tags: ["core"] });
    await expect(assertAssetExists("a1")).resolves.toBeUndefined();
    expect(await loadAssetScopeRecord("a1")).toEqual({ id: "a1", createdBy: "bob", tags: ["core"] });
    expect(db.asset.findUnique).toHaveBeenLastCalledWith({ where: { id: "a1" }, select: { id: true, createdBy: true, tags: true } });
  });

  it("assetTlsPins: 404, else the endpoints for the integration with its config (an empty object when unset)", async () => {
    db.asset.findUnique.mockResolvedValueOnce(null);
    await expect(assetTlsPins("x")).rejects.toMatchObject({ httpStatus: 404 });
    db.asset.findUnique.mockResolvedValueOnce({ assetType: "firewall", ipAddress: "10.0.0.1", discoveredByIntegration: { type: "fortigate", name: "FGT", config: null } });
    m.tlsEndpoints.mockReturnValue([{ host: "10.0.0.1" }]);
    expect(await assetTlsPins("a1")).toEqual([{ host: "10.0.0.1" }]);
    expect(m.tlsEndpoints).toHaveBeenCalledWith({ assetType: "firewall", ipAddress: "10.0.0.1" }, { type: "fortigate", name: "FGT", config: {} });
    db.asset.findUnique.mockResolvedValueOnce({ assetType: "server", ipAddress: null, discoveredByIntegration: null });
    await assetTlsPins("a2");
    expect(m.tlsEndpoints).toHaveBeenLastCalledWith({ assetType: "server", ipAddress: null }, null);
  });
});

describe("getAssetDetail", () => {
  const assetRow = (over: Record<string, unknown> = {}) => ({
    id: "a1", hostname: "gw", hostnameOverride: null, ipAddress: "10.0.0.1", learnedLocation: "SITE-A-FW", createdBy: "bob", tags: ["core"],
    fortinetTopology: { role: "fortiap" },
    discoveredByIntegration: { id: "i1", name: "FMG", type: "fortimanager", config: { apiToken: "SECRET", monitorCredentialId: "c1", adom: "", useProxy: false, syncDescriptions: true } },
    associatedIpRows: [{ ip: "10.0.0.1", device: "SITE-A-FW" }],
    macAddressRows: [],
    ...over,
  });

  it("re-checks addresses against IPAM first, and a failing re-check never fails the read", async () => {
    m.reconcile.mockRejectedValue(new Error("ipam down"));
    db.asset.findUnique.mockResolvedValue(assetRow({ discoveredByIntegration: null }));
    const out = await getAssetDetail("a1", "alice");
    expect(m.reconcile).toHaveBeenCalledWith("a1", "alice");
    expect(m.warn).toHaveBeenCalledWith(expect.objectContaining({ assetId: "a1" }), expect.stringMatching(/IPAM address cross-check failed/));
    expect(out.safeAsset.discoveredByIntegration).toBeNull();
    expect(out.scopeRec).toEqual({ createdBy: "bob", tags: ["core"] });
  });

  it("404s an unknown asset", async () => {
    db.asset.findUnique.mockResolvedValue(null);
    await expect(getAssetDetail("x", undefined)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("strips the integration config, keeping only derived flags: proxy, ADOM (default root), description sync for this role", async () => {
    db.asset.findUnique.mockResolvedValue(assetRow());
    db.credential.findUnique.mockResolvedValue({ id: "c1", name: "SNMP ro", type: "snmp" });
    m.ipContexts.mockResolvedValue(new Map([["10.0.0.1", { subnet: "10.0.0.0/24" }]]));
    m.networks.mockResolvedValue(new Map([["10.0.0.1|SITE-A-FW", { cidr: "10.0.0.0/24", vlan: 10 }]]));
    const out = await getAssetDetail("a1", "alice");
    expect(JSON.stringify(out)).not.toContain("SECRET");
    expect(out.safeAsset.discoveredByIntegration).toEqual({ id: "i1", name: "FMG", type: "fortimanager", useProxy: false, adom: "root", syncDescriptions: true });
    expect(out.safeAsset.integrationMonitorCredential).toEqual({ id: "c1", name: "SNMP ro", type: "snmp" });
    expect(out.ipCtx).toEqual({ subnet: "10.0.0.0/24" });
    expect(m.networks).toHaveBeenCalledWith([{ ip: "10.0.0.1", gate: "SITE-A-FW" }], "SITE-A-FW");
    expect(out.safeAsset.associatedIps).toEqual([{ ip: "10.0.0.1", device: "SITE-A-FW", network: { cidr: "10.0.0.0/24", vlan: 10 } }]);
    expect(out.safeAsset).not.toHaveProperty("associatedIpRows");
    expect(out.safeAsset).not.toHaveProperty("macAddressRows");
    expect(m.discoveredHostname).not.toHaveBeenCalled();
  });

  it("a standalone FortiGate has no proxy / ADOM; a non-Fortinet integration no description sync; a pinned hostname shows what discovery says", async () => {
    db.asset.findUnique.mockResolvedValue(assetRow({
      hostnameOverride: "pinned", ipAddress: null,
      discoveredByIntegration: { id: "i2", name: "FGT", type: "fortigate", config: { useProxy: true } },
    }));
    m.discoveredHostname.mockResolvedValue("from-discovery");
    const out = await getAssetDetail("a1", "alice");
    expect(out.safeAsset.discoveredByIntegration).toMatchObject({ useProxy: null, adom: null, syncDescriptions: false });
    expect(out.safeAsset.hostnameDiscovered).toBe("from-discovery");
    expect(out.ipCtx).toBeNull();
    expect(m.ipContexts).not.toHaveBeenCalled();

    db.asset.findUnique.mockResolvedValue(assetRow({ discoveredByIntegration: { id: "i3", name: "AD", type: "activedirectory", config: {} } }));
    const ad = await getAssetDetail("a1", "alice");
    expect(ad.safeAsset.discoveredByIntegration).toMatchObject({ useProxy: null, adom: null, syncDescriptions: null });
    expect(db.credential.findUnique).not.toHaveBeenCalled();
  });
});

describe("getAssetIpHistory", () => {
  it("404s, else resolves each row's network on the gate its source names (the ':arp' suffix stripped), then the asset's gate", async () => {
    db.asset.findUnique.mockResolvedValueOnce(null);
    await expect(getAssetIpHistory("x")).rejects.toMatchObject({ httpStatus: 404 });
    db.asset.findUnique.mockResolvedValue({ id: "a1", learnedLocation: "HOME-FW" });
    m.ipHistory.mockResolvedValue([
      { ip: "10.0.0.5", source: "SITE-B-FW:arp" },
      { ip: "10.0.0.6", source: null },
      { ip: "10.0.0.7", source: " :x" },
    ]);
    m.networks.mockResolvedValue(new Map([["10.0.0.5|SITE-B-FW", { vlan: 20, cidr: "10.0.0.0/24" }]]));
    const rows = await getAssetIpHistory("a1");
    expect(m.networks).toHaveBeenCalledWith([{ ip: "10.0.0.5", gate: "SITE-B-FW" }, { ip: "10.0.0.6", gate: null }, { ip: "10.0.0.7", gate: null }], "HOME-FW");
    expect(rows.map((r) => [r.ip, r.vlan])).toEqual([["10.0.0.5", 20], ["10.0.0.6", null], ["10.0.0.7", null]]);
  });
});

// ─── readAssetMonitorHistory ─────────────────────────────────────────────────

describe("readAssetMonitorHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    m.pickTier.mockResolvedValue({ tier: "detail", bucketSeconds: 0 });
    m.monitorHistory.mockResolvedValue({ samples: [{ t: 1 }], loss: [], stats: { avg: 5 } });
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["1h", 60 * 60_000], ["12h", 12 * 60 * 60_000], ["7d", 7 * 86_400_000], ["30d", 30 * 86_400_000], ["24h", 86_400_000], ["bogus", 86_400_000],
  ])("preset %s reads that window back from now", async (range, ms) => {
    const out = await readAssetMonitorHistory("a1", null, null, range);
    expect(out).toMatchObject({ range, until: NOW, since: new Date(NOW.getTime() - ms), tier: "detail", samples: [{ t: 1 }], stats: { avg: 5 } });
    // Detail tier: five minutes of lookback, and no extra last-success query.
    expect(m.monitorHistory).toHaveBeenCalledWith("a1", new Date(NOW.getTime() - ms), NOW, "detail", new Date(NOW.getTime() - ms - 5 * 60_000));
    expect(m.lastSuccess).not.toHaveBeenCalled();
  });

  it.each([
    ["not-a-date", "2026-11-13T00:00:00Z", "Invalid from/to date"],
    ["2026-11-13T00:00:00Z", "2026-11-13T00:00:00Z", "from must be before to"],
    ["2026-11-14T00:00:00Z", "2026-11-13T00:00:00Z", "from must be before to"],
    ["2025-11-12T00:00:00Z", "2026-11-13T00:00:00Z", "Custom range cannot exceed 1 year"],
  ])("custom %s → %s is a 400: %s", async (from, to, msg) => {
    await expect(readAssetMonitorHistory("a1", from, to, "24h")).rejects.toMatchObject({ httpStatus: 400, message: msg });
    expect(m.pickTier).not.toHaveBeenCalled();
  });

  it("a custom range of exactly a year is allowed; on a rollup tier the real last success rides along and the lookback is one bucket", async () => {
    m.pickTier.mockResolvedValue({ tier: "hourly", bucketSeconds: 3600 });
    m.lastSuccess.mockResolvedValue(new Date("2026-11-13T11:59:00Z"));
    const from = "2025-11-13T00:00:00Z", to = "2026-11-13T00:00:00Z";
    const out = await readAssetMonitorHistory("a1", from, to, "24h");
    expect(out).toMatchObject({ range: "custom", tier: "hourly", bucketSeconds: 3600, lastSuccessAt: new Date("2026-11-13T11:59:00Z") });
    expect(m.monitorHistory.mock.calls[0][4]).toEqual(new Date(new Date(from).getTime() - 3600_000));
    expect(m.lastSuccess).toHaveBeenCalledWith("a1", new Date(from));
  });

  it("down detection: none → null; a failing resolver degrades to null rather than failing the history", async () => {
    expect((await readAssetMonitorHistory("a1", null, null, "1h")).downDetection).toBeNull();
    m.describeDown.mockRejectedValue(new Error("resolver down"));
    expect((await readAssetMonitorHistory("a1", null, null, "1h")).downDetection).toBeNull();
  });

  it("without a reset hold the recovery count IS the missed-poll count — no asset read", async () => {
    m.describeDown.mockResolvedValue({ passive: false, winner: { threshold: 4, recoverySustainSec: 0, severity: "major" } });
    const out = await readAssetMonitorHistory("a1", null, null, "1h");
    expect(out.downDetection).toEqual({ passive: false, missedPolls: 4, recoveryPolls: 4, severity: "major" });
    expect(db.asset.findUnique).not.toHaveBeenCalled();
  });

  it("with a reset hold, resolves the cadence from the asset's settings and counts recovery polls on it", async () => {
    const winner = { threshold: 3, recoverySustainSec: 300, severity: "critical" };
    m.describeDown.mockResolvedValue({ passive: false, winner });
    db.asset.findUnique.mockResolvedValue({ assetType: "switch", discoveredByIntegrationId: "i1", discoveredByIntegration: { type: "fortimanager" }, monitorIntervalSec: 30 });
    m.resolveSettings.mockResolvedValue({ intervalSeconds: 30 });
    m.recoveryPolls.mockReturnValue(10);
    const out = await readAssetMonitorHistory("a1", null, null, "1h");
    expect(m.resolveSettings.mock.calls[0][0]).toMatchObject({ assetType: "switch", discoveredByIntegrationType: "fortimanager" });
    expect(m.recoveryPolls).toHaveBeenCalledWith(winner, 30);
    expect(out.downDetection).toEqual({ passive: false, missedPolls: 3, recoveryPolls: 10, severity: "critical" });
  });

  it("a passive device: no threshold, nothing may go red", async () => {
    m.describeDown.mockResolvedValue({ passive: true, winner: null });
    expect((await readAssetMonitorHistory("a1", null, null, "1h")).downDetection).toEqual({ passive: true, missedPolls: null, recoveryPolls: null, severity: null });
  });
});
