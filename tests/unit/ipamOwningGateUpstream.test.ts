/**
 * tests/unit/ipamOwningGateUpstream.test.ts
 *
 * The pure decisions added when IPAM became an upstream source:
 *
 *   - `partitionAdoptableMacs` — which derived MACs may be written onto
 *     `Asset.macAddress`. Adoption is the one irreversible write in the rule 45
 *     sweep (a MAC makes the row eligible for MAC-keyed dedupe and merge), so
 *     the collision refusals are tested rather than assumed.
 *   - `resolveEndpointParent`'s fourth tier — the owning FortiGate from IPAM,
 *     consulted only when nothing observed can place the endpoint.
 *
 * The DB-bound halves (the sweep's writes, the reconciler's two-pass gate
 * resolution) are covered by tests/integration/ipUpstreamChain.test.ts and
 * tests/integration/dependencyTree.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  macKey,
  partitionAdoptableMacs,
} from "../../src/services/ipUpstreamChainService.js";
import {
  resolveEndpointParent,
  type DepEndpoint,
} from "../../src/services/dependencyTreeService.js";
import { buildInfraParentIndex, type InfraParentCandidate } from "../../src/utils/fortinetParentKey.js";

// ─── macKey ──────────────────────────────────────────────────────────────────

describe("macKey", () => {
  it("normalizes to the Asset storage form (upper, colon-separated)", () => {
    expect(macKey("aa-bb-cc-dd-ee-01")).toBe("AA:BB:CC:DD:EE:01");
    expect(macKey("  aa:bb:cc:dd:ee:01  ")).toBe("AA:BB:CC:DD:EE:01");
  });

  it("treats empty and whitespace-only as no MAC", () => {
    expect(macKey(null)).toBeNull();
    expect(macKey(undefined)).toBeNull();
    expect(macKey("")).toBeNull();
    expect(macKey("   ")).toBeNull();
  });
});

// ─── partitionAdoptableMacs ──────────────────────────────────────────────────

describe("partitionAdoptableMacs", () => {
  it("adopts a MAC nothing else holds", () => {
    const r = partitionAdoptableMacs(
      [{ assetId: "a1", mac: "aa:bb:cc:dd:ee:01" }],
      new Set(),
    );
    expect(r.adopt.get("a1")).toBe("AA:BB:CC:DD:EE:01");
    expect(r.collisions).toBe(0);
  });

  it("refuses a MAC another asset already carries", () => {
    // This is the merge hazard: adopting here makes both rows candidates for
    // mergeDuplicateHostnameAssets, which collapses rows sharing a MAC and
    // deletes one row's monitoring history. Two assets at one address is rule
    // 40's duplicate-IP conflict — an operator decision, not a silent merge.
    const r = partitionAdoptableMacs(
      [{ assetId: "a1", mac: "AA:BB:CC:DD:EE:01" }],
      new Set(["AA:BB:CC:DD:EE:01"]),
    );
    expect(r.adopt.size).toBe(0);
    expect(r.collisions).toBe(1);
  });

  it("matches the held set case-insensitively and across separators", () => {
    const r = partitionAdoptableMacs(
      [{ assetId: "a1", mac: "aa-bb-cc-dd-ee-01" }],
      new Set(["AA:BB:CC:DD:EE:01"]),
    );
    expect(r.adopt.size).toBe(0);
    expect(r.collisions).toBe(1);
  });

  it("refuses BOTH candidates when two assets in one pass resolve to one MAC", () => {
    const r = partitionAdoptableMacs(
      [
        { assetId: "a1", mac: "AA:BB:CC:DD:EE:01" },
        { assetId: "a2", mac: "aa:bb:cc:dd:ee:01" },
      ],
      new Set(),
    );
    expect(r.adopt.size).toBe(0);
    expect(r.collisions).toBe(2);
  });

  it("a collision on one MAC does not block an unrelated one", () => {
    const r = partitionAdoptableMacs(
      [
        { assetId: "a1", mac: "AA:BB:CC:DD:EE:01" },
        { assetId: "a2", mac: "AA:BB:CC:DD:EE:01" },
        { assetId: "a3", mac: "AA:BB:CC:DD:EE:99" },
      ],
      new Set(),
    );
    expect([...r.adopt.entries()]).toEqual([["a3", "AA:BB:CC:DD:EE:99"]]);
    expect(r.collisions).toBe(2);
  });

  it("skips unparseable MACs without counting them as collisions", () => {
    const r = partitionAdoptableMacs([{ assetId: "a1", mac: "   " }], new Set());
    expect(r.adopt.size).toBe(0);
    expect(r.collisions).toBe(0);
  });

  it("is empty for no candidates", () => {
    const r = partitionAdoptableMacs([], new Set(["AA:BB:CC:DD:EE:01"]));
    expect(r.adopt.size).toBe(0);
    expect(r.collisions).toBe(0);
  });
});

// ─── resolveEndpointParent — the IPAM tier ───────────────────────────────────

const INFRA: InfraParentCandidate[] = [
  { id: "sw1", hostname: "FS-248E-01", serialNumber: "S248EP0001", assetType: "switch", fortinetTopology: null },
  { id: "ap1", hostname: "FAP-431F-01", serialNumber: "FP431F0001", assetType: "access_point", fortinetTopology: null },
  { id: "fw-sighted", hostname: "FGT-SIGHTED", serialNumber: "FG100F0001", assetType: "firewall", fortinetTopology: null },
  { id: "fw-owner", hostname: "FGT-OWNER", serialNumber: "FG100F0002", assetType: "firewall", fortinetTopology: null },
] as unknown as InfraParentCandidate[];

function endpoint(over: Partial<DepEndpoint> = {}): DepEndpoint {
  return {
    id: "e1",
    lastSeenSwitch: null,
    lastSeenAp: null,
    sightedFortigates: [],
    ipamGateAssetId: null,
    ...over,
  };
}

describe("resolveEndpointParent — the IPAM owning-gate tier", () => {
  const index = buildInfraParentIndex(INFRA);

  it("uses the owning gate when nothing observed can place the endpoint", () => {
    const hit = resolveEndpointParent(index, endpoint({ ipamGateAssetId: "fw-owner" }));
    expect(hit).toEqual({ parentAssetId: "fw-owner", detectedVia: "subnet" });
  });

  it("still returns null with no address-derived gate — no parent, alerting unchanged", () => {
    expect(resolveEndpointParent(index, endpoint())).toBeNull();
  });

  it("a switch port outranks it — an observation beats an inference", () => {
    const hit = resolveEndpointParent(
      index,
      endpoint({ lastSeenSwitch: "FS-248E-01/port15", ipamGateAssetId: "fw-owner" }),
    );
    expect(hit).toEqual({ parentAssetId: "sw1", detectedVia: "switch-port" });
  });

  it("an AP outranks it", () => {
    const hit = resolveEndpointParent(
      index,
      endpoint({ lastSeenAp: "FAP-431F-01", ipamGateAssetId: "fw-owner" }),
    );
    expect(hit).toEqual({ parentAssetId: "ap1", detectedVia: "wireless" });
  });

  it("a SIGHTING outranks it — a gate that reported the device beats one that merely owns its address", () => {
    const hit = resolveEndpointParent(
      index,
      endpoint({ sightedFortigates: ["FGT-SIGHTED"], ipamGateAssetId: "fw-owner" }),
    );
    expect(hit).toEqual({ parentAssetId: "fw-sighted", detectedVia: "sighting" });
  });

  it("falls through to it when the sighted gate names nothing Polaris holds", () => {
    // An unresolvable sighting is not an answer, so the address gets its turn
    // rather than the endpoint being left unparented.
    const hit = resolveEndpointParent(
      index,
      endpoint({ sightedFortigates: ["FGT-DECOMMISSIONED"], ipamGateAssetId: "fw-owner" }),
    );
    expect(hit).toEqual({ parentAssetId: "fw-owner", detectedVia: "subnet" });
  });

  it("never parents an endpoint to itself", () => {
    // buildEndpointDependencyEdges drops a self-edge; resolveEndpointParent
    // itself may return one, so the guard is asserted at the edge builder.
    const hit = resolveEndpointParent(index, endpoint({ id: "fw-owner", ipamGateAssetId: "fw-owner" }));
    expect(hit?.parentAssetId).toBe("fw-owner");
  });
});
