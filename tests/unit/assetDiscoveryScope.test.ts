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

describe("resolveDiscoveryScopeForAsset — assets with no scoped path", () => {
  const base = {
    id: "a-x", hostname: "host-1", ipAddress: "10.9.0.5", learnedLocation: null,
    assetType: "workstation", fortinetTopology: null, discoveredByIntegration: null,
  };

  it("names the product for a directory-discovered asset", async () => {
    subject = { ...base, sources: [{ sourceKind: "ad" }] };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("Active Directory");
    expect(r.reason).toMatch(/Integrations page/);
  });

  it("names vCenter for a VM", async () => {
    subject = { ...base, assetType: "server", sources: [{ sourceKind: "vcenter-vm" }] };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("vCenter");
  });

  it("prefers a discovery source over an enrichment-only one", async () => {
    // snmp-sysdescr describes a device without claiming it; the Entra row is
    // the one an operator could act on, so it should drive the message.
    subject = { ...base, sources: [{ sourceKind: "snmp-sysdescr" }, { sourceKind: "entra" }] };
    const r = await resolveDiscoveryScopeForAsset("a-x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("Entra ID");
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
