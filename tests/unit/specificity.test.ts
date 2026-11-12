/**
 * tests/unit/specificity.test.ts — automation precedence
 * (src/services/notificationTypes/specificity.ts): the specificity ladder
 * (business rule 18), scope membership, the carve-out signature + shadow index,
 * the down-detection predicates (rules 36 / 78) and the device-filter matchers.
 *
 * Complements (does not repeat):
 *  - notificationSpecificity.test.ts — scopeRank / scopeRankLabel ladder basics;
 *  - notificationCarveOut.test.ts — buildShadowIndex / isAssetShadowed fixtures;
 *  - automationTriggerFilters.test.ts — ip / mac / device filter happy paths;
 *  - downDetectionTriggerSchema.test.ts, recoveryConfirmation.test.ts — the
 *    down-detection predicates reached through the schema and the engine.
 * New here: scopeIsUnconstrained's "bare {} = any device" contract against
 * scopeMatchesAsset's "{} = nothing", every flat dimension's AND-across /
 * OR-within semantics, the monitorStatus / tag signature special cases, a
 * device-filtered peer that shadows only what it covers, downRecoveryPolls
 * (untested), and the IP matcher's octet-boundary + CIDR edge cases.
 * Pure module — no database, no network.
 */

import { describe, it, expect } from "vitest";
import {
  SCOPE_RANK,
  SCOPE_RANK_LADDER,
  scopeRankLabel,
  scopeRank,
  scopeIsUnconstrained,
  scopeMatchesAsset,
  triggerSignature,
  buildShadowIndex,
  isAssetShadowed,
  isDownDetectionTrigger,
  ruleAlertsWhenDependencyDown,
  downRecoverySustainSec,
  downRecoveryPolls,
  downRecoveryConsumesSustain,
  DOWN_ALERT_HOLDING_STATES,
  DEFAULT_MISSED_POLLS,
  dimensionSubstringMatch,
  ipDimensionMatch,
  macDimensionMatch,
  deviceFilterMatch,
  type ScopeAsset,
  type ShadowRule,
} from "../../src/services/notificationTypes/specificity.js";
import type { Trigger, RuleScope } from "../../src/services/notificationTypes/triggers.js";
import type { ResetConfig } from "../../src/services/notificationTypes/actions.js";

const asset = (over: Partial<ScopeAsset> = {}): ScopeAsset => ({
  id: "a1",
  assetType: "switch",
  tags: [],
  discoveredByIntegrationId: null,
  ...over,
});

const downTrigger = (over: Record<string, unknown> = {}): Trigger =>
  ({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0, ...over }) as Trigger;

const cpu = (dimensionFilter?: Record<string, unknown>): Trigger =>
  ({ type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 90, forDurationSec: 0, dimensionFilter }) as Trigger;

describe("specificity ladder", () => {
  it("the ladder lists every rank exactly once, in increasing order", () => {
    const ranks = SCOPE_RANK_LADDER.map((r) => SCOPE_RANK[r.key]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(Object.keys(SCOPE_RANK).length);
  });

  it("an IP block ranks below a subnet, a region tag above a plain tag", () => {
    expect(SCOPE_RANK.ipBlock).toBeLessThan(SCOPE_RANK.subnet);
    expect(SCOPE_RANK.region).toBeGreaterThan(SCOPE_RANK.tag);
  });

  it("scopeRankLabel names the rung at or below the rank", () => {
    expect(scopeRankLabel(0)).toBe("All assets");
    expect(scopeRankLabel(SCOPE_RANK.hostname)).toBe("Hostname");
    expect(scopeRankLabel(99)).toBe("Hostname");
    expect(scopeRankLabel(-1)).toBe("All assets");
  });

  it("scopeRank takes the most specific of flat and tree dimensions", () => {
    expect(scopeRank({})).toBe(0);
    expect(scopeRank({ allAssets: true })).toBe(0);
    expect(scopeRank({ assetTypes: ["switch"], models: ["124F"] })).toBe(SCOPE_RANK.model);
    expect(scopeRank({ tags: ["prod", "Region:East"] })).toBe(SCOPE_RANK.region);
    expect(scopeRank({ subnetCidrs: ["10.0.0.0/8"], condition: { op: "and", children: [{ field: "hostname", operator: "equals", value: "x" }] } })).toBe(SCOPE_RANK.hostname);
  });

  it("negative operators and none / notAll subtrees never raise specificity", () => {
    expect(scopeRank({ condition: { op: "and", children: [{ field: "hostname", operator: "notEquals", value: "x" }] } })).toBe(0);
    expect(scopeRank({ condition: { op: "none", children: [{ field: "hostname", operator: "equals", value: "x" }] } })).toBe(0);
    expect(scopeRank({ condition: { op: "or", children: [{ op: "notAll", children: [{ field: "subnet", operator: "inCidr", value: "10.0.0.0/8" }] }, { field: "os", operator: "contains", value: "win" }] } })).toBe(SCOPE_RANK.os);
  });

  it("ipBlock / region-tag / interfaceName in the tree rank as documented", () => {
    expect(scopeRank({ condition: { op: "and", children: [{ field: "ipBlock", operator: "inCidr", value: "10.0.0.0/8" }] } })).toBe(SCOPE_RANK.ipBlock);
    expect(scopeRank({ condition: { op: "and", children: [{ field: "tag", operator: "has", value: " region:West" }] } })).toBe(SCOPE_RANK.region);
    expect(scopeRank({ condition: { op: "and", children: [{ field: "interfaceName", operator: "equals", value: "fortilink" }] } })).toBe(0);
  });
});

describe("scopeIsUnconstrained vs scopeMatchesAsset", () => {
  it("rule 46: a bare {} / null / allAssets is unconstrained", () => {
    expect(scopeIsUnconstrained(null)).toBe(true);
    expect(scopeIsUnconstrained(undefined)).toBe(true);
    expect(scopeIsUnconstrained({})).toBe(true);
    expect(scopeIsUnconstrained({ allAssets: true, tags: ["x"] })).toBe(true);
    expect(scopeIsUnconstrained({ tags: [] })).toBe(true);
    expect(scopeIsUnconstrained({ condition: { op: "and", children: [] } })).toBe(true);
  });

  it("any non-empty list or tree constrains", () => {
    for (const s of [{ assetTypes: ["x"] }, { tags: ["x"] }, { assetIds: ["x"] }, { integrationIds: ["x"] }, { manufacturers: ["x"] }, { models: ["x"] }, { subnetCidrs: ["10.0.0.0/8"] }] as RuleScope[]) {
      expect(scopeIsUnconstrained(s)).toBe(false);
    }
    expect(scopeIsUnconstrained({ condition: { op: "and", children: [{ field: "hostname", operator: "equals", value: "x" }] } })).toBe(false);
  });

  it("scopeMatchesAsset: {} matches NOTHING, allAssets matches everything", () => {
    expect(scopeMatchesAsset({}, asset())).toBe(false);
    expect(scopeMatchesAsset({ allAssets: true }, asset())).toBe(true);
  });

  it("ORs within a list and ANDs across lists", () => {
    const a = asset({ assetType: "switch", tags: ["Prod"], manufacturer: "Fortinet, Inc.", model: "FortiSwitch 124F" });
    expect(scopeMatchesAsset({ assetTypes: ["firewall", "switch"] }, a)).toBe(true);
    expect(scopeMatchesAsset({ assetTypes: ["switch"], tags: ["dev"] }, a)).toBe(false);
    expect(scopeMatchesAsset({ tags: ["PROD"], manufacturers: ["fortinet"], models: ["124f"] }, a)).toBe(true);
    expect(scopeMatchesAsset({ manufacturers: ["cisco"] }, a)).toBe(false);
  });

  it("manufacturer / model need a value — an empty column never contains anything", () => {
    expect(scopeMatchesAsset({ manufacturers: [""] }, asset({ manufacturer: null }))).toBe(false);
    expect(scopeMatchesAsset({ models: ["x"] }, asset({ model: null }))).toBe(false);
  });

  it("assetIds / integrationIds match exactly", () => {
    expect(scopeMatchesAsset({ assetIds: ["a1"] }, asset())).toBe(true);
    expect(scopeMatchesAsset({ assetIds: ["A1"] }, asset())).toBe(false);
    expect(scopeMatchesAsset({ integrationIds: ["i1"] }, asset({ discoveredByIntegrationId: "i1" }))).toBe(true);
    expect(scopeMatchesAsset({ integrationIds: ["i1"] }, asset())).toBe(false);
  });

  it("subnetCidrs: containment, bare IP = host route, no IP = no match, garbage never throws", () => {
    expect(scopeMatchesAsset({ subnetCidrs: ["10.0.0.0/8"] }, asset({ ipAddress: "10.4.4.4" }))).toBe(true);
    expect(scopeMatchesAsset({ subnetCidrs: ["10.4.4.4"] }, asset({ ipAddress: "10.4.4.4" }))).toBe(true);
    expect(scopeMatchesAsset({ subnetCidrs: ["10.4.4.5"] }, asset({ ipAddress: "10.4.4.4" }))).toBe(false);
    expect(scopeMatchesAsset({ subnetCidrs: ["10.0.0.0/8"] }, asset({ ipAddress: null }))).toBe(false);
    expect(scopeMatchesAsset({ subnetCidrs: ["junk", "10.0.0.0/8"] }, asset({ ipAddress: "10.1.1.1" }))).toBe(true);
  });

  it("the condition tree ANDs with flat dimensions", () => {
    const scope: RuleScope = { assetTypes: ["switch"], condition: { op: "and", children: [{ field: "hostname", operator: "startsWith", value: "core" }] } };
    expect(scopeMatchesAsset(scope, asset({ hostname: "core-1" }))).toBe(true);
    expect(scopeMatchesAsset(scope, asset({ hostname: "edge-1" }))).toBe(false);
    expect(scopeMatchesAsset(scope, asset({ hostname: "core-1", assetType: "firewall" }))).toBe(false);
  });
});

describe("triggerSignature", () => {
  it("asset_metric keys on metric + a stable, empty-pruned dimension filter", () => {
    const a = triggerSignature(cpu({ ifNamePattern: "wan", sensorClass: undefined, link: "" }));
    const b = triggerSignature(cpu({ ifNamePattern: "wan" }));
    expect(a).toBe(b);
    expect(triggerSignature(cpu())).toBe("am:cpuPct:");
    expect(triggerSignature(cpu({ ifNamePattern: "wan" }))).not.toBe(triggerSignature(cpu()));
  });

  it("key order of the dimension filter does not matter", () => {
    const x = triggerSignature({ type: "asset_metric", metric: "hwSensorValue", aggregation: "latest", windowSec: 0, operator: ">", threshold: 1, forDurationSec: 0, dimensionFilter: { sensorClass: "fan", sensorNamePattern: "1" } } as Trigger);
    const y = triggerSignature({ type: "asset_metric", metric: "hwSensorValue", aggregation: "latest", windowSec: 0, operator: ">", threshold: 1, forDurationSec: 0, dimensionFilter: { sensorNamePattern: "1", sensorClass: "fan" } } as Trigger);
    expect(x).toBe(y);
  });

  it("monitorStatus drops the device filter and keys on operator + lower-cased value", () => {
    expect(triggerSignature(downTrigger({ dimensionFilter: { hostnamePattern: "core" } }))).toBe(triggerSignature(downTrigger({ value: "DOWN" })));
    expect(triggerSignature(downTrigger())).not.toBe(triggerSignature(downTrigger({ value: "warning" })));
    expect(triggerSignature(downTrigger())).not.toBe(triggerSignature(downTrigger({ operator: "!=" })));
  });

  it("a tag condition keys on its value AND its filter", () => {
    const tag = (value: string, df?: Record<string, unknown>) => ({ type: "asset_state", field: "tag", operator: "==", value, forDurationSec: 0, dimensionFilter: df }) as Trigger;
    expect(triggerSignature(tag("prod"))).not.toBe(triggerSignature(tag("dev")));
    expect(triggerSignature(tag("Prod"))).toBe(triggerSignature(tag("prod")));
    expect(triggerSignature(tag("prod", { hostnamePattern: "x" }))).not.toBe(triggerSignature(tag("prod")));
  });

  it("other state fields key on field + filter only", () => {
    const op = (value: string) => ({ type: "asset_state", field: "ifOperStatus", operator: "==", value, forDurationSec: 0 }) as Trigger;
    expect(triggerSignature(op("down"))).toBe(triggerSignature(op("up")));
  });

  it("host / event / change / composite triggers do not participate", () => {
    expect(triggerSignature({ type: "host_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 1, forDurationSec: 0 } as Trigger)).toBeNull();
    expect(triggerSignature({ type: "event", actionPattern: "*" } as Trigger)).toBeNull();
    expect(triggerSignature({ type: "change", changeType: "firmware_changed" } as Trigger)).toBeNull();
    expect(triggerSignature({ type: "composite", kind: "asset", op: "and", children: [], forDurationSec: 0 } as unknown as Trigger)).toBeNull();
  });
});

describe("shadow index + isAssetShadowed", () => {
  const broad: ShadowRule = { id: "broad", trigger: downTrigger(), scope: { allAssets: true } };
  const narrow: ShadowRule = { id: "narrow", trigger: downTrigger({ dimensionFilter: { hostnamePattern: "core-" } }), scope: { assetTypes: ["switch"] } };
  const event: ShadowRule = { id: "ev", trigger: { type: "event", actionPattern: "*" } as Trigger, scope: {} };

  it("groups by signature, records max rank, skips non-participating triggers", () => {
    const idx = buildShadowIndex([broad, narrow, event]);
    const sig = triggerSignature(broad.trigger)!;
    expect(idx.bySig.get(sig)?.map((m) => m.rule.id)).toEqual(["broad", "narrow"]);
    expect(idx.maxRankBySig.get(sig)).toBe(SCOPE_RANK.assetType);
    expect(idx.bySig.size).toBe(1);
  });

  it("a device-filtered peer shadows only the devices its filter covers", () => {
    const idx = buildShadowIndex([broad, narrow]);
    const sig = triggerSignature(broad.trigger)!;
    expect(isAssetShadowed(idx, broad, sig, 0, asset({ hostname: "core-sw1" }))).toBe(true);
    expect(isAssetShadowed(idx, broad, sig, 0, asset({ hostname: "edge-sw1" }))).toBe(false);
    // Out of the peer's scope entirely.
    expect(isAssetShadowed(idx, broad, sig, 0, asset({ hostname: "core-fw", assetType: "firewall" }))).toBe(false);
  });

  it("never shadows itself, nor by an equal or lower rank, nor an unknown signature", () => {
    const idx = buildShadowIndex([broad, narrow]);
    const sig = triggerSignature(broad.trigger)!;
    expect(isAssetShadowed(idx, narrow, sig, SCOPE_RANK.assetType, asset({ hostname: "core-1" }))).toBe(false);
    const twin: ShadowRule = { id: "twin", trigger: downTrigger(), scope: { assetTypes: ["switch"] } };
    const idx2 = buildShadowIndex([twin, { ...twin, id: "twin2" }]);
    expect(isAssetShadowed(idx2, twin, sig, SCOPE_RANK.assetType, asset())).toBe(false);
    expect(isAssetShadowed(idx, broad, "am:nope:", 0, asset())).toBe(false);
  });

  it("a peer whose filter holds only non-device dimensions covers its whole scope", () => {
    const a: ShadowRule = { id: "a", trigger: cpu({ ifNamePattern: "wan" }), scope: { allAssets: true } };
    const b: ShadowRule = { id: "b", trigger: cpu({ ifNamePattern: "wan" }), scope: { tags: ["prod"] } };
    const idx = buildShadowIndex([a, b]);
    expect(isAssetShadowed(idx, a, triggerSignature(a.trigger)!, 0, asset({ tags: ["prod"] }))).toBe(true);
  });
});

describe("down-detection predicates", () => {
  it("isDownDetectionTrigger is exactly monitorStatus == down (any case)", () => {
    expect(isDownDetectionTrigger(downTrigger())).toBe(true);
    expect(isDownDetectionTrigger(downTrigger({ value: "Down" }))).toBe(true);
    expect(isDownDetectionTrigger(downTrigger({ operator: "!=" }))).toBe(false);
    expect(isDownDetectionTrigger(downTrigger({ value: "warning" }))).toBe(false);
    expect(isDownDetectionTrigger(downTrigger({ field: "fortilinkStatus" }))).toBe(false);
    expect(isDownDetectionTrigger(cpu())).toBe(false);
  });

  it("rule 78: alertWhenDependencyDown is honoured only on a down-detection trigger and only when true", () => {
    expect(ruleAlertsWhenDependencyDown(downTrigger({ alertWhenDependencyDown: true }))).toBe(true);
    expect(ruleAlertsWhenDependencyDown(downTrigger({ alertWhenDependencyDown: false }))).toBe(false);
    expect(ruleAlertsWhenDependencyDown(downTrigger())).toBe(false);
    expect(ruleAlertsWhenDependencyDown(downTrigger({ value: "warning", alertWhenDependencyDown: true }))).toBe(false);
  });

  it("downRecoverySustainSec: auto resets with a positive hold only", () => {
    expect(downRecoverySustainSec({ mode: "auto", sustainSec: 120 })).toBe(120);
    expect(downRecoverySustainSec({ mode: "auto", sustainSec: 0 })).toBeNull();
    expect(downRecoverySustainSec({ mode: "condition", sustainSec: 120 })).toBeNull();
    expect(downRecoverySustainSec(null)).toBeNull();
    expect(downRecoverySustainSec("auto")).toBeNull();
  });

  it("downRecoveryPolls: the stated count, rounded; null without one", () => {
    expect(downRecoveryPolls({ mode: "auto", sustainPolls: 5 })).toBe(5);
    expect(downRecoveryPolls({ mode: "auto", sustainPolls: 2.6 })).toBe(3);
    expect(downRecoveryPolls({ mode: "auto", sustainSec: 300 })).toBeNull();
    expect(downRecoveryPolls({ mode: "auto", sustainPolls: 0 })).toBeNull();
    expect(downRecoveryPolls({ mode: "manual", sustainPolls: 5 })).toBeNull();
    expect(downRecoveryPolls(undefined)).toBeNull();
  });

  it("downRecoveryConsumesSustain: either spelling on a down trigger, never elsewhere", () => {
    expect(downRecoveryConsumesSustain(downTrigger(), { mode: "auto", sustainPolls: 3 } as ResetConfig)).toBe(true);
    expect(downRecoveryConsumesSustain(downTrigger(), { mode: "auto", sustainSec: 60 } as ResetConfig)).toBe(true);
    expect(downRecoveryConsumesSustain(downTrigger(), { mode: "auto" } as ResetConfig)).toBe(false);
    expect(downRecoveryConsumesSustain(cpu(), { mode: "auto", sustainPolls: 3 } as ResetConfig)).toBe(false);
  });

  it("holding states + default count are the documented constants", () => {
    expect([...DOWN_ALERT_HOLDING_STATES].sort()).toEqual(["down", "recovering", "warning"]);
    expect(DEFAULT_MISSED_POLLS).toBe(3);
  });
});

describe("device-filter matchers", () => {
  it("dimensionSubstringMatch: unset needle matches, case-insensitive substring otherwise", () => {
    expect(dimensionSubstringMatch(null, undefined)).toBe(true);
    expect(dimensionSubstringMatch(null, "")).toBe(true);
    expect(dimensionSubstringMatch("Port10", "rt1")).toBe(true);
    expect(dimensionSubstringMatch(null, "x")).toBe(false);
  });

  it("ipDimensionMatch: octet-boundary prefixes never cross an octet", () => {
    expect(ipDimensionMatch("10.4.1.5", "10.4")).toBe(true);
    expect(ipDimensionMatch("10.40.1.5", "10.4")).toBe(false);
    expect(ipDimensionMatch("110.1.1.55", "10.1.1.5")).toBe(false);
    expect(ipDimensionMatch("10.1.1.55", "10.1.1.5")).toBe(false);
    expect(ipDimensionMatch("10.1.1.5", "10.1.1.5")).toBe(true);
    expect(ipDimensionMatch("10.4.1.9", "10.4.1.")).toBe(true);
  });

  it("ipDimensionMatch: CIDR containment, blank pattern, missing IP, bad CIDR", () => {
    expect(ipDimensionMatch("10.4.1.9", "10.4.0.0/16")).toBe(true);
    expect(ipDimensionMatch("10.5.1.9", "10.4.0.0/16")).toBe(false);
    expect(ipDimensionMatch("10.5.1.9", "10.4.0.0/99")).toBe(false);
    expect(ipDimensionMatch("10.5.1.9", "   ")).toBe(true);
    expect(ipDimensionMatch(null, "10.4")).toBe(false);
    expect(ipDimensionMatch("", undefined)).toBe(true);
  });

  it("macDimensionMatch is separator- and case-insensitive", () => {
    expect(macDimensionMatch("AA:BB:CC:DD:EE:FF", "aa-bb-cc")).toBe(true);
    expect(macDimensionMatch("aabb.ccdd.eeff", "BB:CC:DD")).toBe(true);
    expect(macDimensionMatch("aa:bb:cc:dd:ee:ff", "11:22")).toBe(false);
    expect(macDimensionMatch(null, "aa")).toBe(false);
    expect(macDimensionMatch(null, "::--")).toBe(true);
  });

  it("deviceFilterMatch ANDs every set pattern", () => {
    const a = { hostname: "CORE-1", ipAddress: "10.4.1.1", macAddress: "aa:bb:cc:00:11:22", manufacturer: "Fortinet", model: "FS-124F" };
    expect(deviceFilterMatch(null, a)).toBe(true);
    expect(deviceFilterMatch({ hostnamePattern: "core", ipPattern: "10.4", macPattern: "AABBCC", manufacturerPattern: "forti", modelPattern: "124" }, a)).toBe(true);
    expect(deviceFilterMatch({ hostnamePattern: "core", modelPattern: "148" }, a)).toBe(false);
    expect(deviceFilterMatch({ ipPattern: "10.40" }, a)).toBe(false);
    expect(deviceFilterMatch({ macPattern: "ff:ff" }, a)).toBe(false);
    expect(deviceFilterMatch({ manufacturerPattern: "cisco" }, a)).toBe(false);
  });
});
