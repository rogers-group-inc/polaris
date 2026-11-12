/**
 * tests/unit/resolveMonitorSettings.test.ts
 *
 * Coverage for the four-tier monitor-settings resolver:
 *
 *   per-asset override
 *     -> (assetType + integration) class override
 *     -> integration tier (Integration.config.monitorSettings)
 *        OR manual tier   (Setting "manualMonitorSettings")
 *     -> hardcoded floor  (final safety net)
 *
 * Prisma is mocked so the tests stay fast and independent of DB state. Cache
 * state in the resolver module is reset between every test by calling the
 * exported `invalidateMonitorSettingsCache()` — without that, the second
 * test in a describe() would see stale memoized values from the first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Module-mocked stubs so each test can override behaviour. The functions are
// re-bound by re-mocking on the imported `prisma` reference below; vitest
// preserves identity through the import.
vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(),
    },
    integration: {
      findUnique: vi.fn(),
    },
    monitorClassOverride: {
      findFirst: vi.fn(),
    },
    asset: {
      findMany: vi.fn(),
    },
  },
}));

import {
  resolveMonitorSettings,
  resolveMonitorSettingsWithProvenance,
  invalidateMonitorSettingsCache,
  fleetCadences,
} from "../../src/services/monitoringService.js";
import { prisma } from "../../src/db.js";

// Tier-3 baseline values. After 3d the resolver also returns four per-stream
// polling fields — those are computed from the asset's source kind and the
// compatibility matrix, so the expected resolved shape varies per test. Each
// test that uses toEqual() picks the right polling defaults below.
const FLOOR = {
  intervalSeconds:            60,
  failureThreshold:           3,
  // Fast-confirm re-probe cadence (business rule 30). Neither tier below sets
  // it, so every resolved shape carries the floor's 10s.
  fastConfirmIntervalSec:     10,
  probeTimeoutMs:             5000,
  cpuMemoryTimeoutMs:         10000,
  temperatureTimeoutMs:       10000,
  systemInfoTimeoutMs:        10000,
  cpuMemoryIntervalSeconds:   60,
  temperatureIntervalSeconds: 60,
  systemInfoIntervalSeconds:  600,
  // Phase 2 LLDP / Storage cadence + timeout fields — hardcoded floor.
  lldpIntervalSeconds:        600,
  lldpTimeoutMs:              10000,
  storageIntervalSeconds:     600,
  storageTimeoutMs:           10000,
  // Cross-transport streams — cadence/timeout fall through to the floor.
  processesIntervalSeconds:   600,
  processesTimeoutMs:         10000,
  eventLogIntervalSeconds:    600,
  eventLogTimeoutMs:          10000,
  sampleRetentionDays:        30,
  telemetryRetentionDays:     30,
  systemInfoRetentionDays:    30,
  responseTimePolling:        null,
  cpuMemoryPolling:           null,
  temperaturePolling:         null,
  interfacesPolling:          null,
  lldpPolling:                null,
  // Per-stream MIB id hints — tierFromJson always includes them on the
  // resolved shape (null when unseeded). Mirrored here so toEqual() lines up.
  // Per-stream credential IDs are class-override-only, but the resolver
  // unconditionally writes null for them at every other tier so toEqual()
  // sees a stable shape.
  responseTimeCredentialId:   null,
  cpuMemoryCredentialId:      null,
  temperatureCredentialId:    null,
  interfacesCredentialId:     null,
  lldpCredentialId:           null,
  processesCredentialId:      null,
  eventLogCredentialId:       null,
};

const TUNED_TIER = {
  intervalSeconds:            120,
  failureThreshold:           5,
  fastConfirmIntervalSec:     10,
  probeTimeoutMs:             7500,
  // Tuned tier doesn't set the new timeout fields — they fall through to the
  // hardcoded floor (10000 ms each) per the resolver's tierFromJson default.
  cpuMemoryTimeoutMs:         10000,
  temperatureTimeoutMs:       10000,
  systemInfoTimeoutMs:        10000,
  cpuMemoryIntervalSeconds:   90,
  temperatureIntervalSeconds: 90,
  systemInfoIntervalSeconds:  1200,
  // Phase 2 LLDP / Storage cadence + timeout fields. Tuned tier doesn't set
  // them — they fall through to the hardcoded floor (600 s / 10000 ms each)
  // per tierFromJson's default chain.
  lldpIntervalSeconds:        600,
  lldpTimeoutMs:              10000,
  storageIntervalSeconds:     600,
  storageTimeoutMs:           10000,
  processesIntervalSeconds:   600,
  processesTimeoutMs:         10000,
  eventLogIntervalSeconds:    600,
  eventLogTimeoutMs:          10000,
  sampleRetentionDays:        60,
  telemetryRetentionDays:     14,
  systemInfoRetentionDays:    14,
  responseTimePolling:        null,
  cpuMemoryPolling:           null,
  temperaturePolling:         null,
  interfacesPolling:          null,
  lldpPolling:                null,
  responseTimeCredentialId:   null,
  cpuMemoryCredentialId:      null,
  temperatureCredentialId:    null,
  interfacesCredentialId:     null,
  lldpCredentialId:           null,
  processesCredentialId:      null,
  eventLogCredentialId:       null,
};

// Per-stream polling defaults the resolver applies for a given source kind.
// Mirrors defaultPollingForSource in monitoringService.ts.
const MANUAL_POLLING_DEFAULT = {
  responseTimePolling: "icmp" as const,
  cpuMemoryPolling:    null,
  temperaturePolling:  null,
  interfacesPolling:   null,
  lldpPolling:         null,
  storagePolling:      null,
  // Cross-transport streams default to "disabled" across every source.
  processesPolling:    "disabled" as const,
  eventLogPolling:     "disabled" as const,
};
const FORTI_POLLING_DEFAULT = {
  // Response time defaults to ICMP across every source kind — the cheapest
  // universal liveness probe. Operators wanting REST `/sys/status` or SNMP
  // sysUpTime opt in per-asset / per-class / at the integration tier.
  responseTimePolling: "icmp" as const,
  cpuMemoryPolling:    "rest_api" as const,
  temperaturePolling:  "rest_api" as const,
  interfacesPolling:   "rest_api" as const,
  // LLDP defaults to "disabled" on FMG/FortiGate sources because the
  // FortiOS REST `lldp-neighbors` endpoint is empty on most fleets;
  // operators flip this back to rest_api when they actually have LLDP on.
  lldpPolling:         "disabled" as const,
  // Storage defaults to "disabled" on FMG/FortiGate sources because FortiOS
  // appliances don't expose meaningful mountable storage; operators opt in
  // per-asset when they have a device that does.
  storagePolling:      "disabled" as const,
  // Cross-transport streams default to "disabled" across every source.
  processesPolling:    "disabled" as const,
  eventLogPolling:     "disabled" as const,
};
// vCenter answers for four streams from ONE batched fetch per integration per
// tick, so all four default to it — including response time, which was ICMP
// until 2026-08. ICMP was the wrong question twice over on this source: it
// needs a guest IP Polaris may not have, and it reports whether a packet came
// back rather than whether the VM is running. Temperature and LLDP have no
// vCenter source at all.
const VCENTER_POLLING_DEFAULT = {
  responseTimePolling: "vcenter" as const,
  cpuMemoryPolling:    "vcenter" as const,
  temperaturePolling:  null,
  interfacesPolling:   "vcenter" as const,
  lldpPolling:         null,
  storagePolling:      "vcenter" as const,
  processesPolling:    "disabled" as const,
  eventLogPolling:     "disabled" as const,
};

beforeEach(() => {
  invalidateMonitorSettingsCache();
  vi.clearAllMocks();
});

// ─── Tier-3 only: manual / integration / floor fallback ─────────────────────

describe("resolveMonitorSettings — tier-3 fallback", () => {
  it("manual tier when asset has no integration and the Setting row exists", async () => {
    (prisma.setting.findUnique as any).mockResolvedValue({ key: "manualMonitorSettings", value: TUNED_TIER });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "workstation",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    // Manual source: ICMP for responseTime, null for the other streams.
    expect(out).toEqual({ ...TUNED_TIER, ...MANUAL_POLLING_DEFAULT });
  });

  it("hardcoded floor when manual tier Setting is unseeded AND legacy row absent", async () => {
    // manualMonitorSettings missing; legacy monitorSettings (transitional
    // fallback) also missing. Resolver should fall through to the floor.
    (prisma.setting.findUnique as any).mockResolvedValue(null);
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "server",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out).toEqual({ ...FLOOR, ...MANUAL_POLLING_DEFAULT });
  });

  it("never reads the retired legacy monitorSettings row: an unseeded manual tier is the floor (CQ-B012)", async () => {
    // The pre-hierarchy single-row Setting is retired: the startup migration
    // converts and deletes it, and the resolver no longer falls back to it.
    // Even if one were still present, an unseeded manual tier resolves to
    // the hard-coded floor.
    const readKeys: string[] = [];
    (prisma.setting.findUnique as any).mockImplementation(async (args: any) => {
      readKeys.push(args.where.key);
      if (args.where.key === "manualMonitorSettings") return null;
      if (args.where.key === "monitorSettings") return { key: "monitorSettings", value: TUNED_TIER };
      return null;
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "switch",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out).toEqual({ ...FLOOR, ...MANUAL_POLLING_DEFAULT });
    expect(readKeys).not.toContain("monitorSettings");
  });

  it("integration tier when asset.discoveredByIntegrationId is set", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: { monitorSettings: TUNED_TIER },
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "firewall",
      discoveredByIntegrationId: "fmg-1",
      discoveredByIntegrationType: "fortimanager",
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    // FortiManager source: REST API for every stream.
    expect(out).toEqual({ ...TUNED_TIER, ...FORTI_POLLING_DEFAULT });
  });

  it("vCenter source defaults every stream vCenter can answer to the vcenter method", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: { monitorSettings: TUNED_TIER },
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const vm = await resolveMonitorSettings({
      assetType:                 "server",       // vCenter VMs are typed "server"
      discoveredByIntegrationId: "vc-1",
      discoveredByIntegrationType: "vcenter",
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(vm).toEqual({ ...TUNED_TIER, ...VCENTER_POLLING_DEFAULT });

    // ESXi hosts take the same defaults — the host fetch answers the same four
    // streams, so a host needs no SNMP community to be monitored.
    const host = await resolveMonitorSettings({
      assetType:                 "hypervisor",
      discoveredByIntegrationId: "vc-1",
      discoveredByIntegrationType: "vcenter",
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(host).toEqual({ ...TUNED_TIER, ...VCENTER_POLLING_DEFAULT });
  });

  it("reads from fortiswitchMonitor.streams when assetType=switch (Phase 2 per-class)", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: {
        monitorSettings: TUNED_TIER,
        // Switch-specific overlay: response time on SNMP at 30s, leave the
        // rest inheriting from the flat tier baseline.
        fortiswitchMonitor: {
          enabled: true,
          streams: {
            responseTime: { polling: "snmp", intervalSeconds: 30, timeoutMs: 8000 },
            // Empty cells inherit the flat baseline.
            cpuMemory:   {},
            temperature: {},
            interfaces:  {},
            lldp:        {},
            storage:     { polling: "snmp" },
          },
        },
      },
      type: "fortimanager",
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      discoveredByIntegrationType: "fortimanager",
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:      null,
      temperatureIntervalSec:    null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    // Class block wins: responseTime polling flips snmp; intervalSeconds=30;
    // probeTimeoutMs=8000; storage polling flips snmp. Other fields stay at
    // the flat baseline / source default.
    expect(out.responseTimePolling).toBe("snmp");
    expect(out.intervalSeconds).toBe(30);
    expect(out.probeTimeoutMs).toBe(8000);
    expect(out.storagePolling).toBe("snmp");
    // cpuMemory unchanged, and this fixture is an FMG with no useProxy flag
    // (= proxy, the default) and no fortigateApiToken — so no FortiOS REST call
    // can be assembled and the source default is "disabled" rather than
    // rest_api. It was rest_api, which 409'd on every tick; for a managed
    // switch it was doubly dead, since REST telemetry is hard-guarded off for
    // that class anyway.
    expect(out.cpuMemoryPolling).toBe("disabled");
  });

  it("firewall vs switch read from different per-class streams blocks on the same integration", async () => {
    // Same integration, two assets of different classes. The resolver's
    // cache key is `${integrationId}:${assetType}` so each class gets its
    // own resolved snapshot.
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: {
        monitorSettings: TUNED_TIER,
        fortigateMonitor:   { streams: { responseTime: { polling: "rest_api", intervalSeconds: 60 } } },
        fortiswitchMonitor: { enabled: true, streams: { responseTime: { polling: "snmp",     intervalSeconds: 120 } } },
      },
      type: "fortimanager",
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const firewallOut = await resolveMonitorSettings({
      assetType: "firewall", discoveredByIntegrationId: "fmg-1", discoveredByIntegrationType: "fortimanager",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    const switchOut = await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-1", discoveredByIntegrationType: "fortimanager",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    // The firewall's class block asks for rest_api, but this fixture is an FMG
    // with no useProxy flag (= proxy) and no fortigateApiToken, so a FortiOS
    // call cannot be assembled and rest_api is skipped like any other method
    // the source can't use — the layer below stays, which is icmp. This is the
    // "locked to inherited" behaviour: the stored choice is untouched and
    // returns the moment a token is supplied (see the next test).
    expect(firewallOut.responseTimePolling).toBe("icmp");
    // The cadence from the same class block is unaffected — only the METHOD is
    // gated. Getting this wrong would silently reset every operator's interval.
    expect(firewallOut.intervalSeconds).toBe(60);
    expect(switchOut.responseTimePolling).toBe("snmp");
    expect(switchOut.intervalSeconds).toBe(120);
  });

  it("a FortiGate API token makes rest_api reachable again under proxy mode", async () => {
    // Same shape as above plus the direct token. Proxy transport with a token
    // is a legitimate configuration — discovery and writes ride FMG, monitoring
    // dials the gates directly — so nothing should be gated.
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: {
        monitorSettings: TUNED_TIER,
        fortigateApiToken: "a-real-token",
        fortigateMonitor: { streams: { responseTime: { polling: "rest_api", intervalSeconds: 60 } } },
      },
      type: "fortimanager",
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType: "firewall", discoveredByIntegrationId: "fmg-tok", discoveredByIntegrationType: "fortimanager",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    expect(out.responseTimePolling).toBe("rest_api");
    // …and the REST source defaults come back with it.
    expect(out.cpuMemoryPolling).toBe("rest_api");
  });

  it("a per-asset REST API credential makes rest_api reachable with no integration token", async () => {
    // The escape hatch for a fleet where each gate carries its OWN api-user:
    // the integration token field is fleet-wide by construction ("must be the
    // same across all managed FortiGates"), so a per-gate token can only live
    // on a Credential the operator selects on the asset. Discarding the method
    // here would throw away the fix for the very condition being detected.
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: { monitorSettings: TUNED_TIER },   // proxy transport, NO token
      type: "fortimanager",
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const base = {
      assetType: "firewall", discoveredByIntegrationId: "fmg-cred", discoveredByIntegrationType: "fortimanager",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
      cpuMemoryPolling: "rest_api", interfacesPolling: "rest_api",
    } as const;

    // Without a credential the stored method is skipped, as before.
    const bare = await resolveMonitorSettings({ ...base });
    expect(bare.cpuMemoryPolling).toBe("disabled");
    expect(bare.interfacesPolling).toBe("disabled");

    // With one it stands — and only for the stream carrying it, since a
    // per-gate token is selected per stream.
    const withCred = await resolveMonitorSettings({ ...base, cpuMemoryCredentialId: "cred-1" });
    expect(withCred.cpuMemoryPolling).toBe("rest_api");
    expect(withCred.interfacesPolling).toBe("disabled");
  });

  it("a managed switch keeps its controller-table probe with no token", async () => {
    // The one FortiOS read the proxy serves on FMG's own credential: a managed
    // switch/AP's up/down comes off the PARENT gate's controller table via
    // fetchViaFortinetTransport, which honours useProxy. Downgrading it to icmp
    // would be a real regression — many FortiLink devices are not pingable.
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: {
        monitorSettings: TUNED_TIER,
        fortiswitchMonitor: { enabled: true, streams: { responseTime: { polling: "rest_api" } } },
      },
      type: "fortimanager",
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-sw", discoveredByIntegrationType: "fortimanager",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    expect(out.responseTimePolling).toBe("rest_api");
  });
});

// ─── Tier-2 layering: class override on top of tier-3 ───────────────────────

describe("resolveMonitorSettings — class override layering", () => {
  it("class override fields layer onto integration tier", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({
      config: { monitorSettings: TUNED_TIER },
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue({
      // Only intervalSeconds + probeTimeoutMs differ; the rest inherit.
      intervalSeconds:           300,
      failureThreshold:          null,
      probeTimeoutMs:            8000,
      cpuMemoryIntervalSeconds:   null,
      temperatureIntervalSeconds: null,
      systemInfoIntervalSeconds: null,
      sampleRetentionDays:       null,
      telemetryRetentionDays:    null,
      systemInfoRetentionDays:   null,
    });

    const out = await resolveMonitorSettings({
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.intervalSeconds).toBe(300);
    expect(out.probeTimeoutMs).toBe(8000);
    // Untouched fields keep tier-3 values.
    expect(out.failureThreshold).toBe(TUNED_TIER.failureThreshold);
    expect(out.cpuMemoryIntervalSeconds).toBe(TUNED_TIER.cpuMemoryIntervalSeconds);
    expect(out.sampleRetentionDays).toBe(TUNED_TIER.sampleRetentionDays);
  });

  it("null integrationId is the manual-tier class override", async () => {
    (prisma.setting.findUnique as any).mockResolvedValue({ key: "manualMonitorSettings", value: TUNED_TIER });
    (prisma.monitorClassOverride.findFirst as any).mockImplementation(async (args: any) => {
      // Only return the override when (integrationId, assetType) matches
      // the orphan-asset scope.
      if (args.where.integrationId === null && args.where.assetType === "printer") {
        return { intervalSeconds: 900, failureThreshold: null, probeTimeoutMs: null,
                 cpuMemoryIntervalSeconds:   null, systemInfoIntervalSeconds: null,
                 temperatureIntervalSeconds: null,
                 sampleRetentionDays: null, telemetryRetentionDays: null, systemInfoRetentionDays: null };
      }
      return null;
    });

    const out = await resolveMonitorSettings({
      assetType:                 "printer",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.intervalSeconds).toBe(900);
    expect(out.failureThreshold).toBe(TUNED_TIER.failureThreshold);
  });
});

// ─── Tier-1: per-asset overrides on top ─────────────────────────────────────

describe("resolveMonitorSettings — per-asset overrides win", () => {
  it("per-asset monitorIntervalSec / probeTimeoutMs override class + tier-3", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue({
      intervalSeconds: 300, failureThreshold: null, probeTimeoutMs: 8000,
      cpuMemoryIntervalSeconds:   null, systemInfoIntervalSeconds: null,
      temperatureIntervalSeconds: null,
      sampleRetentionDays: null, telemetryRetentionDays: null, systemInfoRetentionDays: null,
    });

    const out = await resolveMonitorSettings({
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        45,    // beats class (300) and tier (120)
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            500,   // beats class (8000) and tier (7500)
    });
    expect(out.intervalSeconds).toBe(45);
    expect(out.probeTimeoutMs).toBe(500);
    // No per-asset override on these → still resolves through class → tier.
    expect(out.failureThreshold).toBe(TUNED_TIER.failureThreshold);
    expect(out.cpuMemoryIntervalSeconds).toBe(TUNED_TIER.cpuMemoryIntervalSeconds);
  });

  it("per-asset overrides only apply for the four overridable fields (cadence + timeout)", async () => {
    // failureThreshold and the three retention fields are NOT in
    // AssetMonitorContext — they cascade only down to tier-2.
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettings({
      assetType:                 "firewall",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        45,
      cpuMemoryIntervalSec:   77,
      temperatureIntervalSec: 77,
      systemInfoIntervalSec:     333,
      probeTimeoutMs:            444,
    });
    expect(out.intervalSeconds).toBe(45);
    expect(out.cpuMemoryIntervalSeconds).toBe(77);
    expect(out.systemInfoIntervalSeconds).toBe(333);
    expect(out.probeTimeoutMs).toBe(444);
    // failureThreshold + retentions inherit from tier-3.
    expect(out.failureThreshold).toBe(TUNED_TIER.failureThreshold);
    expect(out.sampleRetentionDays).toBe(TUNED_TIER.sampleRetentionDays);
    expect(out.telemetryRetentionDays).toBe(TUNED_TIER.telemetryRetentionDays);
    expect(out.systemInfoRetentionDays).toBe(TUNED_TIER.systemInfoRetentionDays);
  });
});

// ─── Resolver caching ──────────────────────────────────────────────────────

describe("resolveMonitorSettings — caches tier and class lookups", () => {
  it("hits Prisma at most once per (integrationId, assetType) pair across many calls", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const ctx = {
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    };

    // Cold call: 1 integration read + 1 class-override read.
    await resolveMonitorSettings(ctx);
    expect((prisma.integration.findUnique as any).mock.calls.length).toBe(1);
    expect((prisma.monitorClassOverride.findFirst as any).mock.calls.length).toBe(1);

    // 50 more calls with the same (integration, assetType) — cache hits.
    for (let i = 0; i < 50; i++) await resolveMonitorSettings(ctx);
    expect((prisma.integration.findUnique as any).mock.calls.length).toBe(1);
    expect((prisma.monitorClassOverride.findFirst as any).mock.calls.length).toBe(1);
  });

  it("invalidateMonitorSettingsCache(scope) clears just the matching tier + class entries", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-2",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    expect((prisma.integration.findUnique as any).mock.calls.length).toBe(2);

    // Invalidate only fmg-1; fmg-2's tier should still be cached.
    invalidateMonitorSettingsCache({ integrationId: "fmg-1" });
    await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    await resolveMonitorSettings({
      assetType: "switch", discoveredByIntegrationId: "fmg-2",
      monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null, systemInfoIntervalSec: null, probeTimeoutMs: null,
    });
    // fmg-1 hit DB again; fmg-2 still cached.
    expect((prisma.integration.findUnique as any).mock.calls.length).toBe(3);
  });
});

// ─── Provenance helper ─────────────────────────────────────────────────────

describe("resolveMonitorSettingsWithProvenance — labels each field", () => {
  it("labels every field as integration when no class or asset override applies", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettingsWithProvenance({
      assetType:                 "firewall",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.tier3Source).toBe("integration");
    expect(out.classOverrideId).toBeNull();
    // Polling fields where no tier supplies a method resolve to the runtime
    // source default and are labeled "default" (2026-08 resolver fold —
    // TUNED_TIER sets no polling methods). Every other field is tier-3's.
    for (const [field, tier] of Object.entries(out.provenance)) {
      expect(tier, field).toBe(field.endsWith("Polling") ? "default" : "integration");
    }
  });

  it("labels manual when asset has no integration", async () => {
    (prisma.setting.findUnique as any).mockResolvedValue({ key: "manualMonitorSettings", value: TUNED_TIER });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);

    const out = await resolveMonitorSettingsWithProvenance({
      assetType:                 "workstation",
      discoveredByIntegrationId: null,
      monitorIntervalSec:        null,
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.tier3Source).toBe("manual");
    for (const [field, tier] of Object.entries(out.provenance)) {
      expect(tier, field).toBe(field.endsWith("Polling") ? "default" : "manual");
    }
  });

  it("labels per-field provenance correctly when class + asset overrides mix", async () => {
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER } });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue({
      intervalSeconds: 300, failureThreshold: null, probeTimeoutMs: 8000,
      cpuMemoryIntervalSeconds:   null, systemInfoIntervalSeconds: null,
      temperatureIntervalSeconds: null,
      sampleRetentionDays: null, telemetryRetentionDays: null, systemInfoRetentionDays: null,
    });
    // Class-row id lookup for the badge UI.
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValueOnce({
      intervalSeconds: 300, failureThreshold: null, probeTimeoutMs: 8000,
      cpuMemoryIntervalSeconds:   null, systemInfoIntervalSeconds: null,
      temperatureIntervalSeconds: null,
      sampleRetentionDays: null, telemetryRetentionDays: null, systemInfoRetentionDays: null,
    });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValueOnce({ id: "class-row-id" });

    const out = await resolveMonitorSettingsWithProvenance({
      assetType:                 "switch",
      discoveredByIntegrationId: "fmg-1",
      monitorIntervalSec:        45,    // per-asset
      cpuMemoryIntervalSec:   null,
      temperatureIntervalSec: null,
      systemInfoIntervalSec:     null,
      probeTimeoutMs:            null,
    });
    expect(out.provenance.intervalSeconds).toBe("asset");
    expect(out.provenance.probeTimeoutMs).toBe("class");
    expect(out.provenance.failureThreshold).toBe("integration");
    expect(out.classOverrideId).toBe("class-row-id");
  });

  it("labels the runtime truth when a tier's polling method is incompatible (resolver fold)", async () => {
    // AD-sourced asset with a class override pinning cpuMemoryPolling to
    // rest_api — a method the compatibility matrix rejects for directory
    // sources. Pre-fold, the provenance path adopted the class value ungated
    // (badge said "class: REST API" while the runtime used the source
    // default). Post-fold both resolvers substitute the default and the
    // label says so.
    (prisma.integration.findUnique as any).mockResolvedValue({ config: { monitorSettings: TUNED_TIER }, type: "activedirectory" });
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue({ cpuMemoryPolling: "rest_api" });

    const ctx = {
      assetType:                   "server",
      discoveredByIntegrationId:   "ad-1",
      discoveredByIntegrationType: "activedirectory",
      monitorIntervalSec:          null,
      cpuMemoryIntervalSec:        null,
      temperatureIntervalSec:      null,
      systemInfoIntervalSec:       null,
      probeTimeoutMs:              null,
    };
    const out = await resolveMonitorSettingsWithProvenance(ctx);
    // AD sources have no cpuMemory default — the incompatible class value is
    // skipped, not displayed.
    expect(out.resolved.cpuMemoryPolling).toBeNull();
    expect(out.provenance.cpuMemoryPolling).toBe("default");
    expect(out.inheritPolling.values.cpuMemoryPolling).toBeNull();
    expect(out.inheritPolling.provenance.cpuMemoryPolling).toBe("default");
    // The fold's guarantee: the UI payload IS the runtime resolution.
    expect(await resolveMonitorSettings(ctx)).toEqual(out.resolved);
  });
});

// CQ-B012: the capacity model's cadences come from what the fleet is actually
// configured to run, not from the retired legacy Setting row (which the
// startup migration deletes, leaving every projection on the floor defaults).
describe("fleetCadences", () => {
  const asset = (over: Record<string, unknown> = {}) => ({
    assetType: "server", discoveredByIntegrationId: null, discoveredByIntegration: null,
    monitorIntervalSec: null, cpuMemoryIntervalSec: null, temperatureIntervalSec: null,
    systemInfoIntervalSec: null, lldpIntervalSec: null, storageIntervalSec: null, probeTimeoutMs: null,
    ...over,
  });

  beforeEach(() => {
    (prisma.setting.findUnique as any).mockResolvedValue(null);
    (prisma.monitorClassOverride.findFirst as any).mockResolvedValue(null);
  });

  it("is the floor when nothing is monitored", async () => {
    (prisma.asset.findMany as any).mockResolvedValue([]);
    expect(await fleetCadences()).toEqual({
      intervalSeconds: FLOOR.intervalSeconds,
      telemetryIntervalSeconds: FLOOR.cpuMemoryIntervalSeconds,
      systemInfoIntervalSeconds: FLOOR.systemInfoIntervalSeconds,
    });
  });

  it("uses the configured manual tier, not the floor", async () => {
    (prisma.setting.findUnique as any).mockImplementation(async (args: any) =>
      args.where.key === "manualMonitorSettings"
        ? { key: "manualMonitorSettings", value: { ...FLOOR, intervalSeconds: 10 } }
        : null);
    (prisma.asset.findMany as any).mockResolvedValue([asset(), asset()]);
    const out = await fleetCadences();
    expect(out.intervalSeconds).toBe(10);
  });

  it("is the rate-weighted mean: N / Σ(1/interval), rounded to whole seconds", async () => {
    // Two assets on the floor's interval, one overridden to 10 s.
    (prisma.asset.findMany as any).mockResolvedValue([asset(), asset(), asset({ monitorIntervalSec: 10 })]);
    const floor = FLOOR.intervalSeconds;
    const out = await fleetCadences();
    expect(out.intervalSeconds).toBe(Math.round(3 / (2 / floor + 1 / 10)));
    expect(Number.isInteger(out.telemetryIntervalSeconds)).toBe(true);
    expect(Number.isInteger(out.systemInfoIntervalSeconds)).toBe(true);
  });

  it("a uniform fleet reads as its interval, not float noise (60.000000000000014)", async () => {
    // Two configurations on 60 s (one asset a switch, five servers) are two
    // resolve groups: 6 / (1/60 + 5/60) is 60.00000000000001 in floating point.
    (prisma.asset.findMany as any).mockResolvedValue([
      asset({ monitorIntervalSec: 60, assetType: "switch" }),
      ...Array.from({ length: 5 }, () => asset({ monitorIntervalSec: 60 })),
    ]);
    expect((await fleetCadences()).intervalSeconds).toBe(60);
  });

  it("resolves each distinct configuration once, however many assets share it", async () => {
    (prisma.asset.findMany as any).mockResolvedValue(Array.from({ length: 500 }, () => asset()));
    await fleetCadences();
    // The manual tier is loaded once (then cached) — not 500 times.
    const manualReads = (prisma.setting.findUnique as any).mock.calls.filter((c: any[]) => c[0].where.key === "manualMonitorSettings");
    expect(manualReads.length).toBeLessThanOrEqual(1);
  });
});
