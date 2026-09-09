/**
 * tests/unit/notificationCarveOut.test.ts — the precedence carve-out decision
 * (buildShadowIndex + isAssetShadowed): a more-specific automation shadows a
 * less-specific one that watches the SAME trigger signature, per asset. The
 * DB-bound firing/clear-on-supersede behavior is exercised by the integration
 * suite; this covers the pure decision (ranks, ties, cross-signature isolation,
 * self-exclusion).
 */

import { describe, it, expect } from "vitest";
import { buildShadowIndex, isAssetShadowed, carveOutAggregate, applyCarveOutToMatches, type CarveOutPeer, type PreviewMatch } from "../../src/services/notificationEngine.js";
import { triggerSignature, scopeRank, SCOPE_RANK } from "../../src/services/notificationTypes.js";
import type { ScopeAsset } from "../../src/services/notificationRuleService.js";

const tempTrigger = { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 80, aggregation: "latest", windowSec: 0, forDurationSec: 0 };
const downTrigger = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 };

const rule = (id: string, trigger: any, scope: any) => ({ id, name: id, trigger, scope }) as any;
const hostnameScope = (name: string) => ({ condition: { op: "and", children: [{ field: "hostname", operator: "equals", value: name }] } });

const a101f: ScopeAsset = { id: "101f", hostname: "fortigate-101f", assetType: "firewall", tags: [], discoveredByIntegrationId: null };
const other: ScopeAsset = { id: "o1", hostname: "switch-1", assetType: "switch", tags: [], discoveredByIntegrationId: null };

// Mirror the engine's per-asset call.
function shadowed(index: ReturnType<typeof buildShadowIndex>, r: any, asset: ScopeAsset): boolean {
  const sig = triggerSignature(r.trigger);
  if (!sig) return false;
  return isAssetShadowed(index, r, sig, scopeRank(r.scope), asset);
}

describe("buildShadowIndex", () => {
  it("groups asset_metric/asset_state rules by signature and tracks max rank", () => {
    const general = rule("general", tempTrigger, { allAssets: true });
    const specific = rule("specific", tempTrigger, hostnameScope("fortigate-101f"));
    const down = rule("down", downTrigger, { allAssets: true });
    const idx = buildShadowIndex([general, specific, down]);
    const tempSig = triggerSignature(tempTrigger as any)!;
    expect(idx.bySig.get(tempSig)).toHaveLength(2);
    expect(idx.maxRankBySig.get(tempSig)).toBe(scopeRank(specific.scope)); // hostname rank
  });

  it("omits host/event/change/composite rules (null signature)", () => {
    const host = rule("host", { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90, aggregation: "latest", windowSec: 0, forDurationSec: 0 }, { allAssets: true });
    const idx = buildShadowIndex([host]);
    expect(idx.bySig.size).toBe(0);
  });
});

describe("isAssetShadowed", () => {
  const general = rule("general", tempTrigger, { allAssets: true });
  const specific = rule("specific", tempTrigger, hostnameScope("fortigate-101f"));
  const down = rule("down", downTrigger, { allAssets: true });
  const idx = buildShadowIndex([general, specific, down]);

  it("carves the covered asset out of the general rule", () => {
    expect(shadowed(idx, general, a101f)).toBe(true);
  });

  it("leaves assets the specific rule does NOT cover alone", () => {
    expect(shadowed(idx, general, other)).toBe(false);
  });

  it("never shadows the most-specific rule itself", () => {
    expect(shadowed(idx, specific, a101f)).toBe(false);
  });

  it("does not carve across different trigger signatures (temp never shadows DOWN)", () => {
    // a101f is covered by the specific TEMP rule, but the DOWN rule watches a
    // different thing — it keeps alerting on a101f.
    expect(shadowed(idx, down, a101f)).toBe(false);
  });

  it("same-rank same-signature rules do not shadow each other (tie → both fire)", () => {
    const genA = rule("genA", tempTrigger, { allAssets: true });
    const genB = rule("genB", tempTrigger, { allAssets: true });
    const tie = buildShadowIndex([genA, genB]);
    expect(shadowed(tie, genA, a101f)).toBe(false);
    expect(shadowed(tie, genB, a101f)).toBe(false);
  });

  it("ranks by specificity, not rule order (a subnet rule carves out a device-type rule)", () => {
    const byType = rule("byType", tempTrigger, { assetTypes: ["firewall"] });
    const bySubnet = rule("bySubnet", tempTrigger, { subnetCidrs: ["10.0.0.0/24"] });
    const idx2 = buildShadowIndex([byType, bySubnet]);
    const inSubnet: ScopeAsset = { ...a101f, assetType: "firewall", ipAddress: "10.0.0.5" };
    expect(shadowed(idx2, byType, inSubnet)).toBe(true); // subnet (7) > assetType (1)
    expect(shadowed(idx2, bySubnet, inSubnet)).toBe(false);
  });
});

describe("device filters bound coverage", () => {
  // A peer's trigger dimensionFilter narrows the asset SET exactly as its scope
  // does. Coverage used to be scope-only, which was safe while triggerSignature
  // pinned the filter (differently-filtered rules were never compared). Now
  // that monitorStatus rules group by value instead, a filtered peer must only
  // shadow the assets it can genuinely fire on — otherwise a "core-" automation
  // would silence the baseline on every device in the fleet.
  const filteredDown = (df: any) => ({ ...downTrigger, dimensionFilter: df });
  const core: ScopeAsset = { id: "c1", hostname: "core-sw-1", assetType: "switch", tags: [], discoveredByIntegrationId: null };
  const edge: ScopeAsset = { id: "e1", hostname: "edge-sw-9", assetType: "switch", tags: [], discoveredByIntegrationId: null };

  it("a filtered higher-rank peer shadows only the assets its filter matches", () => {
    const baseline = rule("baseline", downTrigger, { allAssets: true });
    const peer = rule("peer", filteredDown({ hostnamePattern: "core-" }), { assetTypes: ["switch"] });
    const idx = buildShadowIndex([baseline, peer]);
    expect(shadowed(idx, baseline, core)).toBe(true);
    expect(shadowed(idx, baseline, edge)).toBe(false);
  });

  it("an unfiltered peer still shadows everything in its scope", () => {
    const baseline = rule("baseline", downTrigger, { allAssets: true });
    const peer = rule("peer", downTrigger, { assetTypes: ["switch"] });
    const idx = buildShadowIndex([baseline, peer]);
    expect(shadowed(idx, baseline, core)).toBe(true);
    expect(shadowed(idx, baseline, edge)).toBe(true);
  });

  it("carveOutAggregate honours a peer's device filter in BOTH directions", () => {
    const higher: CarveOutPeer = { id: "hi", name: "Core switches", scope: { assetTypes: ["switch"] } as any, rank: SCOPE_RANK.assetType, dimensionFilter: { hostnamePattern: "core-" } as any };
    // direction 1: the draft is all-assets, the filtered peer outranks it
    const d1 = carveOutAggregate(SCOPE_RANK.allAssets, [core, edge], [higher]);
    expect(d1.excludedBy.has("c1")).toBe(true);
    expect(d1.excludedBy.has("e1")).toBe(false);
    expect(d1.summary.carvedOut?.count).toBe(1);

    // direction 2: the draft is more specific, so the filtered peer is what it
    // carves FROM — and only for the assets that peer actually covers.
    const lower: CarveOutPeer = { ...higher, rank: SCOPE_RANK.allAssets };
    const d2 = carveOutAggregate(SCOPE_RANK.hostname, [core, edge], [lower]);
    expect(d2.summary.carvesFrom?.[0]?.count).toBe(1);
    expect(d2.summary.carvesFrom?.[0]?.sampleHostnames).toEqual(["core-sw-1"]);
  });

  it("a peer with an empty dimensionFilter object covers its whole scope", () => {
    const peer: CarveOutPeer = { id: "hi", name: "All", scope: { allAssets: true }, rank: SCOPE_RANK.assetType, dimensionFilter: {} as any };
    const { excludedBy } = carveOutAggregate(SCOPE_RANK.allAssets, [core, edge], [peer]);
    expect(excludedBy.size).toBe(2);
  });
});

describe("carveOutAggregate (preview, both directions)", () => {
  const a101f: ScopeAsset = { id: "101f", hostname: "fortigate-101f", assetType: "firewall", tags: [], discoveredByIntegrationId: null };
  const sw: ScopeAsset = { id: "sw1", hostname: "switch-1", assetType: "switch", tags: [], discoveredByIntegrationId: null };
  const hostnamePeer: CarveOutPeer = { id: "spec", name: "Specific 101f", scope: { condition: { op: "and", children: [{ field: "hostname", operator: "equals", value: "fortigate-101f" }] } } as any, rank: SCOPE_RANK.hostname };
  const allPeer: CarveOutPeer = { id: "gen", name: "General", scope: { allAssets: true }, rank: SCOPE_RANK.allAssets };

  it("direction 1: a general draft is carved out by a higher-rank peer (per-asset + summary)", () => {
    const { excludedBy, summary } = carveOutAggregate(SCOPE_RANK.allAssets, [a101f, sw], [hostnamePeer]);
    expect(excludedBy.get("101f")).toEqual({ ruleId: "spec", ruleName: "Specific 101f" });
    expect(excludedBy.has("sw1")).toBe(false);
    expect(summary.carvedOut).toEqual({ count: 1, byRule: [{ ruleId: "spec", ruleName: "Specific 101f", count: 1 }] });
    expect(summary.carvesFrom).toBeUndefined();
  });

  it("direction 2: a specific draft warns which lower-rank peers it carves from", () => {
    const { excludedBy, summary } = carveOutAggregate(SCOPE_RANK.hostname, [a101f], [allPeer]);
    expect(excludedBy.size).toBe(0);
    expect(summary.carvedOut).toBeUndefined();
    expect(summary.carvesFrom).toEqual([{ ruleId: "gen", ruleName: "General", count: 1, sampleHostnames: ["fortigate-101f"] }]);
  });

  it("same-rank peers carve neither direction (ties both fire)", () => {
    const tie: CarveOutPeer = { ...allPeer, rank: SCOPE_RANK.allAssets };
    const { excludedBy, summary } = carveOutAggregate(SCOPE_RANK.allAssets, [a101f, sw], [tie]);
    expect(excludedBy.size).toBe(0);
    expect(summary).toEqual({});
  });

  it("attributes an asset to its HIGHEST-rank coverer", () => {
    const subnetPeer: CarveOutPeer = { id: "sub", name: "By subnet", scope: { subnetCidrs: ["10.0.0.0/24"] }, rank: SCOPE_RANK.subnet };
    const inBoth: ScopeAsset = { ...a101f, ipAddress: "10.0.0.5" };
    // hostname (8) beats subnet (7)
    const { excludedBy } = carveOutAggregate(SCOPE_RANK.allAssets, [inBoth], [subnetPeer, hostnamePeer]);
    expect(excludedBy.get("101f")).toEqual({ ruleId: "spec", ruleName: "Specific 101f" });
  });
});

describe("applyCarveOutToMatches (what the Devices step lists)", () => {
  const row = (assetId: string, meets: boolean, dimension = ""): PreviewMatch =>
    ({ assetId, hostname: assetId + "-host", dimension, value: null, meets });
  const by = (ruleName: string) => ({ ruleId: ruleName, ruleName });

  it("puts the carved-out rows LAST so the 200-row cap keeps the ones this draft covers", () => {
    const rows = [row("carved-a", true), row("kept-a", false), row("carved-b", false), row("kept-b", true)];
    const covered = applyCarveOutToMatches(rows, new Map([
      ["carved-a", by("FortiAP Asset down")],
      ["carved-b", by("FortiSwitch Asset down")],
    ]));
    // meets-first ordering survives WITHIN each group.
    expect(rows.map((r) => r.assetId)).toEqual(["kept-b", "kept-a", "carved-a", "carved-b"]);
    expect(rows[0]!.excludedBy).toBeUndefined();
    expect(rows[2]!.excludedBy).toEqual(by("FortiAP Asset down"));
    expect(covered).toEqual({ evaluated: 2, assets: 2 });
  });

  it("counts a per-dimension metric's readings once per DEVICE", () => {
    const rows = [row("a1", false, "CPU"), row("a1", false, "Fan"), row("a2", false, "CPU")];
    expect(applyCarveOutToMatches(rows, new Map([["a2", by("Specific")]]))).toEqual({ evaluated: 2, assets: 1 });
  });

  it("reports zero covered when a more-specific automation owns every matched device", () => {
    const rows = [row("a1", true), row("a2", false)];
    expect(applyCarveOutToMatches(rows, new Map([["a1", by("Spec")], ["a2", by("Spec")]]))).toEqual({ evaluated: 0, assets: 0 });
  });
});
