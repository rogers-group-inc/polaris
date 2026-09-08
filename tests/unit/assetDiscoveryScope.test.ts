/**
 * tests/unit/assetDiscoveryScope.test.ts — which discovery refreshes ONE asset.
 *
 * Backs the asset details slide-in's "Discover Now" button. Two things are
 * pinned here beyond the happy paths:
 *
 *   1. A FortiSwitch/FortiAP resolves through `utils/fortinetParentKey.ts`, so
 *      a controller whose FMG DEVICE NAME differs from its configured hostname
 *      still resolves. That mismatch is legal, common, and fails SILENTLY —
 *      it's the 2026-08-12 prod bug that produced the shared resolver, and a
 *      hostname-keyed lookup here would reintroduce it as "Discover Now does
 *      nothing on half the switches".
 *   2. Every "can't refresh this" case returns a REASON, not a bare false. The
 *      button renders disabled with that text, so a silent empty string would
 *      read to an operator as a permission problem.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, any>;

/** The asset the route asks about. Swapped per test. */
let subject: Row | null = null;
/** Candidate parent gates, matched against parentAssetWhereOr's OR branches. */
let gates: Row[] = [];

const FMG = { id: "i-fmg", name: "HQ FortiManager", type: "fortimanager", config: {}, enabled: true };
const FGT = { id: "i-fgt", name: "Branch FortiGate", type: "fortigate", config: {}, enabled: true };

/** Does one `parentAssetWhereOr` branch match a candidate row? */
function branchMatches(branch: Row, row: Row): boolean {
  if (branch.serialNumber !== undefined) return row.serialNumber === branch.serialNumber;
  if (branch.hostname !== undefined) return row.hostname === branch.hostname;
  if (branch.fortinetTopology) {
    const [key] = branch.fortinetTopology.path as string[];
    return (row.fortinetTopology || {})[key] === branch.fortinetTopology.equals;
  }
  return false;
}

vi.mock("../../src/db.js", () => ({
  prisma: {
    asset: {
      findUnique: vi.fn(async () => subject),
      findMany: vi.fn(async ({ where }: { where: Row }) => {
        const or = (where.OR || []) as Row[];
        return gates.filter(
          (g) => g.assetType === where.assetType && or.some((b) => branchMatches(b, g)),
        );
      }),
    },
  },
}));

const { resolveDiscoveryScopeForAsset } = await import("../../src/services/discovery/assetDiscoveryScope.js");

/** A FortiGate asset row as the resolver selects it. */
function gate(over: Row = {}): Row {
  return {
    id: "a-gate",
    hostname: "fgt-hq",
    ipAddress: "10.0.0.1",
    learnedLocation: null,
    serialNumber: "FG100F0001",
    assetType: "firewall",
    fortinetTopology: { role: "fortigate", deviceName: "fgt-hq" },
    discoveredByIntegration: FMG,
    sources: [{ sourceKind: "fortigate-firewall" }],
    ...over,
  };
}

beforeEach(() => {
  subject = null;
  gates = [];
});

describe("resolveDiscoveryScopeForAsset — FortiGate", () => {
  it("scopes an FMG-owned gate to its FMG device name", async () => {
    subject = gate({ hostname: "branch-01", fortinetTopology: { role: "fortigate", deviceName: "FGT-BRANCH-01" } });
    const r = await resolveDiscoveryScopeForAsset("a-gate");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The FMG/dvmdb name wins over the configured hostname — it is the string
    // the scoped roster filter matches on.
    expect(r.resolved.scope).toEqual({ kind: "fmg-device", deviceName: "FGT-BRANCH-01" });
    expect(r.resolved.deviceName).toBe("FGT-BRANCH-01");
    expect(r.resolved.viaController).toBe(false);
  });

  it("falls back to the hostname on a gate with no deviceName stamp", async () => {
    subject = gate({ fortinetTopology: { role: "fortigate" } });
    const r = await resolveDiscoveryScopeForAsset("a-gate");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "fmg-device", deviceName: "fgt-hq" });
  });

  it("runs a standalone FortiGate integration unscoped — it IS the one gate", async () => {
    subject = gate({ discoveredByIntegration: FGT });
    const r = await resolveDiscoveryScopeForAsset("a-gate");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toBeNull();
    expect(r.resolved.deviceName).toBeNull();
  });

  it("refuses a gate owned by a non-Fortinet integration", async () => {
    subject = gate({ discoveredByIntegration: { ...FMG, type: "vcenter" } });
    const r = await resolveDiscoveryScopeForAsset("a-gate");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/not owned by a FortiManager or FortiGate/i);
  });

  it("refuses a disabled integration by name", async () => {
    subject = gate({ discoveredByIntegration: { ...FMG, enabled: false } });
    const r = await resolveDiscoveryScopeForAsset("a-gate");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("HQ FortiManager");
  });
});

describe("resolveDiscoveryScopeForAsset — FortiSwitch / FortiAP via controller", () => {
  it("scopes a switch to its controller gate, filtering on the GATE", async () => {
    gates = [gate()];
    subject = {
      id: "a-sw", hostname: "sw-floor1", ipAddress: "10.0.0.20", learnedLocation: null,
      assetType: "switch", sources: [{ sourceKind: "fortiswitch" }],
      fortinetTopology: { role: "fortiswitch", controllerSerial: "FG100F0001", controllerFortigate: "fgt-hq" },
      discoveredByIntegration: FMG,
    };
    const r = await resolveDiscoveryScopeForAsset("a-sw");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "fmg-device", deviceName: "fgt-hq" });
    expect(r.resolved.viaController).toBe(true);
    // The include/exclude filters name GATES — checking the switch's own
    // hostname against them would match nothing.
    expect(r.resolved.filterAsset.hostname).toBe("fgt-hq");
  });

  it("resolves a controller whose FMG device name differs from its hostname", async () => {
    // The 2026-08-12 prod shape: FMG calls the device "HQ-EDGE-01" while the
    // gate's configured hostname is "fgt-hq". The child stamps the FMG name.
    gates = [gate({ hostname: "fgt-hq", fortinetTopology: { role: "fortigate", deviceName: "HQ-EDGE-01" } })];
    subject = {
      id: "a-ap", hostname: "ap-lobby", ipAddress: "10.0.0.30", learnedLocation: null,
      assetType: "access_point", sources: [{ sourceKind: "fortiap" }],
      // No controllerSerial — a stamp written before that field existed.
      fortinetTopology: { role: "fortiap", controllerFortigate: "HQ-EDGE-01" },
      discoveredByIntegration: FMG,
    };
    const r = await resolveDiscoveryScopeForAsset("a-ap");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "fmg-device", deviceName: "HQ-EDGE-01" });
    expect(r.resolved.viaController).toBe(true);
  });

  it("explains an unknown controller instead of failing silently", async () => {
    gates = [];
    subject = {
      id: "a-sw", hostname: "sw-orphan", ipAddress: null, learnedLocation: null,
      assetType: "switch", sources: [{ sourceKind: "fortiswitch" }],
      fortinetTopology: { role: "fortiswitch", controllerFortigate: "gate-not-in-polaris" },
      discoveredByIntegration: FMG,
    };
    const r = await resolveDiscoveryScopeForAsset("a-sw");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/controller FortiGate is not in Polaris/i);
  });

  it("explains a switch that records no controller at all", async () => {
    subject = {
      id: "a-sw", hostname: "sw-solo", ipAddress: null, learnedLocation: null,
      assetType: "switch", sources: [{ sourceKind: "fortiswitch" }],
      fortinetTopology: { role: "fortiswitch" },
      discoveredByIntegration: FMG,
    };
    const r = await resolveDiscoveryScopeForAsset("a-sw");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/records no controller FortiGate/i);
  });
});

describe("resolveDiscoveryScopeForAsset — directory sources", () => {
  const ENTRA = { id: "i-entra", name: "Corp Entra", type: "entraid", config: {}, enabled: true };
  const AD = { id: "i-ad", name: "Corp AD", type: "activedirectory", config: {}, enabled: true };
  const wks = (sources: any[]) => ({
    id: "a-w", hostname: "LAPTOP-42", ipAddress: "10.9.0.5", learnedLocation: null,
    assetType: "workstation", fortinetTopology: null, discoveredByIntegration: ENTRA, sources,
  });

  it("scopes an Entra device by its deviceId", async () => {
    subject = wks([{ sourceKind: "entra", externalId: "9f1c-dev-guid", observed: {}, integration: ENTRA }]);
    const r = await resolveDiscoveryScopeForAsset("a-w");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "entra-device", deviceId: "9f1c-dev-guid" });
    expect(r.resolved.integration.id).toBe("i-entra");
    // The run row gets a name an operator recognises, not the GUID.
    expect(r.resolved.deviceName).toBe("LAPTOP-42");
    expect(r.resolved.viaController).toBe(false);
  });

  it("resolves an Intune-only row to the same Entra run", async () => {
    // Intune enrichment rides the owning Entra integration's discovery; there
    // is no separate Intune run to scope.
    subject = wks([{ sourceKind: "intune", externalId: "9f1c-dev-guid", observed: {}, integration: ENTRA }]);
    const r = await resolveDiscoveryScopeForAsset("a-w");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "entra-device", deviceId: "9f1c-dev-guid" });
  });

  it("prefers the entra row over an intune row on the same asset", async () => {
    subject = wks([
      { sourceKind: "intune", externalId: "intune-id", observed: {}, integration: ENTRA },
      { sourceKind: "entra", externalId: "entra-id", observed: {}, integration: ENTRA },
    ]);
    const r = await resolveDiscoveryScopeForAsset("a-w");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "entra-device", deviceId: "entra-id" });
  });

  it("scopes an AD object by objectGUID and carries its OU path to the filter", async () => {
    subject = {
      ...wks([{
        sourceKind: "ad",
        externalId: "4ca21f00112233445566778899aabbcc",
        observed: { ouPath: "OU=Plants,DC=example,DC=com" },
        integration: AD,
      }]),
      discoveredByIntegration: AD,
    };
    const r = await resolveDiscoveryScopeForAsset("a-w");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "ad-object", objectGuid: "4ca21f00112233445566778899aabbcc" });
    // ouInclude/ouExclude match on the OU path; without it the route's filter
    // re-check falls back to learnedLocation and reads as "no OU".
    expect(r.resolved.filterAsset.adOuPath).toBe("OU=Plants,DC=example,DC=com");
  });

  it("ignores an enrichment-only source and scopes the real one", async () => {
    subject = wks([
      { sourceKind: "snmp-sysdescr", externalId: "a-w", observed: {}, integration: null },
      { sourceKind: "entra", externalId: "real-id", observed: {}, integration: ENTRA },
    ]);
    const r = await resolveDiscoveryScopeForAsset("a-w");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "entra-device", deviceId: "real-id" });
  });

  it("refuses a disabled directory integration by name", async () => {
    subject = wks([{ sourceKind: "entra", externalId: "x", observed: {}, integration: { ...ENTRA, enabled: false } }]);
    const r = await resolveDiscoveryScopeForAsset("a-w");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("Corp Entra");
  });

  it("does not match a source whose integration is of another type", async () => {
    // An "entra" row pointing at a non-entraid integration is corrupt state;
    // scoping it would aim an entra-device scope at the wrong collector.
    subject = wks([{ sourceKind: "entra", externalId: "x", observed: {}, integration: AD }]);
    const r = await resolveDiscoveryScopeForAsset("a-w");
    expect(r.ok).toBe(false);
  });
});

describe("resolveDiscoveryScopeForAsset — vCenter and Arc", () => {
  const VC = { id: "i-vc", name: "Prod vCenter", type: "vcenter", config: {}, enabled: true };
  const ARC = { id: "i-arc", name: "Azure Arc", type: "azurearc", config: {}, enabled: true };
  const RESOURCE_ID = "/subscriptions/aaaa/resourcegroups/rg1/providers/microsoft.hybridcompute/machines/srv-9";

  it("scopes a VM by the moref from Asset.virtualization, not the source externalId", async () => {
    // The vcenter-vm externalId is the INSTANCE UUID (with an
    // "<integrationId>:<moref>" fallback), so reading the moref off the source
    // row would be wrong for every VM that reports a UUID.
    subject = {
      id: "a-vm", hostname: "app-01", ipAddress: "10.4.0.9", learnedLocation: null,
      assetType: "server", fortinetTopology: null, discoveredByIntegration: VC,
      virtualization: { role: "vm", vcenterIntegrationId: "i-vc", vmMoref: "vm-1024", hostMoref: "host-7" },
      sources: [{ sourceKind: "vcenter-vm", externalId: "5001-instance-uuid", observed: {}, integration: VC }],
    };
    const r = await resolveDiscoveryScopeForAsset("a-vm");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "vcenter-vm", moref: "vm-1024" });
    expect(r.resolved.integration.id).toBe("i-vc");
  });

  it("scopes an ESXi host by its hostMoref", async () => {
    subject = {
      id: "a-esx", hostname: "esx-03", ipAddress: "10.4.0.3", learnedLocation: null,
      assetType: "hypervisor", fortinetTopology: null, discoveredByIntegration: VC,
      virtualization: { role: "host", vcenterIntegrationId: "i-vc", hostMoref: "host-42" },
      sources: [{ sourceKind: "vcenter-host", externalId: "host-ext", observed: {}, integration: VC }],
    };
    const r = await resolveDiscoveryScopeForAsset("a-esx");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "vcenter-host", moref: "host-42" });
  });

  it("refuses a vCenter asset whose moref has not been recorded yet", async () => {
    // Better a clear "not recorded yet" than a scope built from a guess.
    subject = {
      id: "a-vm", hostname: "app-01", ipAddress: null, learnedLocation: null,
      assetType: "server", fortinetTopology: null, discoveredByIntegration: VC,
      virtualization: null,
      sources: [{ sourceKind: "vcenter-vm", externalId: "uuid", observed: {}, integration: VC }],
    };
    const r = await resolveDiscoveryScopeForAsset("a-vm");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/managed-object reference/i);
  });

  it("scopes an Arc machine by its ARM resource id (the source externalId)", async () => {
    subject = {
      id: "a-arc", hostname: "srv-9", ipAddress: "10.7.0.9", learnedLocation: null,
      assetType: "server", fortinetTopology: null, discoveredByIntegration: ARC,
      virtualization: null,
      sources: [{ sourceKind: "arc", externalId: RESOURCE_ID, observed: {}, integration: ARC }],
    };
    const r = await resolveDiscoveryScopeForAsset("a-arc");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolved.scope).toEqual({ kind: "arc-machine", resourceId: RESOURCE_ID });
  });

  it("does not scope a connected-Kubernetes cluster asset", async () => {
    // arc-k8s rows come from the cluster query a scoped run deliberately skips.
    subject = {
      id: "a-k8s", hostname: "aks-1", ipAddress: null, learnedLocation: null,
      assetType: "other", fortinetTopology: null, discoveredByIntegration: ARC,
      virtualization: null,
      sources: [{ sourceKind: "arc-k8s", externalId: "/subscriptions/a/clusters/c", observed: {}, integration: ARC }],
    };
    const r = await resolveDiscoveryScopeForAsset("a-k8s");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("Kubernetes");
  });
});

describe("resolveDiscoveryScopeForAsset — assets with no scoped path", () => {
  const base = {
    id: "a-x", hostname: "host-1", ipAddress: "10.9.0.5", learnedLocation: null,
    assetType: "workstation", fortinetTopology: null, discoveredByIntegration: null,
  };

  it("does not scope a vCenter source whose integration row is gone", async () => {
    subject = {
      ...base, assetType: "server",
      sources: [{ sourceKind: "vcenter-vm", externalId: "uuid", observed: {}, integration: null }],
    };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/No discovery source owns this asset/i);
  });

  it("does not scope an Arc source whose integration row is gone", async () => {
    subject = {
      ...base, assetType: "server",
      sources: [{ sourceKind: "arc", externalId: "/subscriptions/a/x", observed: {}, integration: null }],
    };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/No discovery source owns this asset/i);
  });

  it("does not scope a directory source whose integration row is gone", async () => {
    // A source left behind by a deleted integration must read as
    // unrefreshable, never run against some other integration.
    subject = { ...base, sources: [{ sourceKind: "ad", externalId: "abcd", observed: {}, integration: null }] };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/No discovery source owns this asset/i);
  });

  it("explains an agent-reported asset", async () => {
    subject = { ...base, sources: [{ sourceKind: "polaris-agent" }] };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/Polaris Agent/);
  });

  it("explains a manually-created asset", async () => {
    subject = { ...base, sources: [{ sourceKind: "manual" }] };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/created manually/i);
  });

  it("handles an asset with no sources at all", async () => {
    subject = { ...base, sources: [] };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/No discovery source owns this asset/i);
  });

  it("reports a missing asset distinctly (the route's only 404)", async () => {
    subject = null;
    const r = await resolveDiscoveryScopeForAsset("nope");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe("Asset not found");
  });
});
