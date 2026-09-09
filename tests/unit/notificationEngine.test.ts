/**
 * tests/unit/notificationEngine.test.ts
 *
 * Pure-function coverage for the notification rules engine: comparators, glob
 * matching, condition evaluation, scope matching, region-prefix stripping, and
 * the trigger Zod union. The DB-bound evaluation/firing path is exercised by
 * the integration suite + the podman mock walkthrough.
 */

import { describe, it, expect } from "vitest";
import { compareNum, compareValue, globToRegExp, readingMeets, interfaceIsPinned, interfaceDimLabel, tunnelIsPinned, applyDeviceFilters } from "../../src/services/notificationEngine.js";
import { scopeMatchesAsset, type ScopeAsset } from "../../src/services/notificationRuleService.js";
import { stripRegionPrefix } from "../../src/services/notificationService.js";
import { bareInterfaceIp } from "../../src/utils/cidr.js";
import { ruleInputSchema, buildSchemaCatalog, triggerDimensionApplicable, scopeIsUnconstrained } from "../../src/services/notificationTypes.js";

describe("compareNum", () => {
  it("evaluates every operator", () => {
    expect(compareNum(90, ">", 80)).toBe(true);
    expect(compareNum(80, ">", 80)).toBe(false);
    expect(compareNum(80, ">=", 80)).toBe(true);
    expect(compareNum(70, "<", 80)).toBe(true);
    expect(compareNum(80, "<=", 80)).toBe(true);
    expect(compareNum(80, "==", 80)).toBe(true);
    expect(compareNum(80, "!=", 81)).toBe(true);
    expect(compareNum(80, "??", 80)).toBe(false);
  });
});

describe("compareValue", () => {
  it("compares strings case-insensitively on equality", () => {
    expect(compareValue("DOWN", "==", "down")).toBe(true);
    expect(compareValue("up", "!=", "down")).toBe(true);
  });
  it("compares booleans via stringification", () => {
    expect(compareValue(true, "==", "true")).toBe(true);
    expect(compareValue(false, "==", "true")).toBe(false);
  });
  it("falls back to numeric comparison when both coerce to numbers", () => {
    expect(compareValue(3, ">=", 3)).toBe(true);
    expect(compareValue("5", ">", "3")).toBe(true);
  });
  it("returns false for null/undefined", () => {
    expect(compareValue(null, "==", "x")).toBe(false);
    expect(compareValue(undefined as any, "==", "x")).toBe(false);
  });
});

describe("globToRegExp", () => {
  it("matches exact action strings", () => {
    expect(globToRegExp("monitor.status_changed").test("monitor.status_changed")).toBe(true);
    expect(globToRegExp("monitor.status_changed").test("monitor.status_other")).toBe(false);
  });
  it("treats * as a wildcard and anchors the pattern", () => {
    const re = globToRegExp("integration.test.*");
    expect(re.test("integration.test.failed")).toBe(true);
    expect(re.test("integration.test.recovered")).toBe(true);
    expect(re.test("integration.discover.error")).toBe(false);
    // anchored: a prefix-only match must not pass
    expect(globToRegExp("asset.created").test("asset.created.extra")).toBe(false);
  });
});

describe("readingMeets", () => {
  it("asset_metric / host_metric compare numerically", () => {
    const t = { type: "asset_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 80, forDurationSec: 0 } as any;
    expect(readingMeets(t, 92)).toBe(true);
    expect(readingMeets(t, 70)).toBe(false);
    expect(readingMeets(t, null)).toBe(false);
    expect(readingMeets(t, "92")).toBe(false); // non-numeric reading never meets a metric threshold
  });
  it("asset_state compares the field value", () => {
    const t = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0 } as any;
    expect(readingMeets(t, "down")).toBe(true);
    expect(readingMeets(t, "up")).toBe(false);
  });
  it("event/change triggers never meet via the threshold path", () => {
    expect(readingMeets({ type: "event", actionPattern: "x" } as any, 1)).toBe(false);
    expect(readingMeets({ type: "change", changeType: "lldp_neighbor_added" } as any, 1)).toBe(false);
  });
});

describe("interfaceIsPinned", () => {
  it("admits only interfaces in the asset's pin set", () => {
    const a = { monitoredInterfaces: ["port1", "wan1"] };
    expect(interfaceIsPinned(a, "port1")).toBe(true);
    expect(interfaceIsPinned(a, "wan1")).toBe(true);
    // The gate every interface resolver applies: an unpinned port reports data
    // but must never raise an alert, or one switch becomes a page of alerts
    // about ports nobody selected.
    expect(interfaceIsPinned(a, "port2")).toBe(false);
  });
  it("matches exactly — never by prefix or case", () => {
    const a = { monitoredInterfaces: ["port1"] };
    expect(interfaceIsPinned(a, "port10")).toBe(false);
    expect(interfaceIsPinned(a, "Port1")).toBe(false);
  });
  it("no pins, or no asset at all, alerts on nothing", () => {
    expect(interfaceIsPinned({ monitoredInterfaces: [] }, "port1")).toBe(false);
    expect(interfaceIsPinned({}, "port1")).toBe(false);
    // A reading whose asset fell out of the scope index is dropped rather than
    // defaulting to allowed — fail closed, same as the resolvers' `index.get`.
    expect(interfaceIsPinned(undefined, "port1")).toBe(false);
  });
});

describe("interfaceDimLabel", () => {
  it("names the port and carries the operator's label beside it", () => {
    // The complaint this exists for: a PoE fault on port39 mailed as
    // "Interface PoE status on Indoor AP is fault" sends the operator hunting
    // for which port that is. The port comes first; the label rides along.
    expect(interfaceDimLabel("port39", "Indoor AP")).toBe("port39 (Indoor AP)");
  });
  it("states the name alone when there is nothing to add", () => {
    expect(interfaceDimLabel("port39", null)).toBe("port39");
    expect(interfaceDimLabel("port39", undefined)).toBe("port39");
    expect(interfaceDimLabel("port39", "   ")).toBe("port39");
    // A FortiSwitch reports ifAlias = the port name, so alias == ifName is the
    // common case, not the corner — "port39 (port39)" would be noise.
    expect(interfaceDimLabel("port39", "port39")).toBe("port39");
  });
  it("leaves the KEY untouched — this is a caption, not an identity", () => {
    // Whatever the device called the port stays the label's first token, so a
    // reader can match the alert to the state row and the System tab even on a
    // switch whose ifName walk handed back a description.
    expect(interfaceDimLabel("Indoor AP", "port39")).toBe("Indoor AP (port39)");
  });
});

describe("tunnelIsPinned", () => {
  it("admits only tunnels in the asset's pin set", () => {
    const a = { monitoredIpsecTunnels: ["to-hq", "to-dr"] };
    expect(tunnelIsPinned(a, "to-hq")).toBe(true);
    expect(tunnelIsPinned(a, "to-dr")).toBe(true);
    // The IPsec sample stream still writes every tunnel the gate reports
    // (unpinned rows ride cadence="slow"), so this gate is what keeps
    // ipsecStatus/ipsecThroughputBps rules from alerting on tunnels nobody
    // selected for monitoring.
    expect(tunnelIsPinned(a, "to-branch")).toBe(false);
  });
  it("matches exactly — never by prefix or case", () => {
    const a = { monitoredIpsecTunnels: ["to-hq"] };
    expect(tunnelIsPinned(a, "to-hq2")).toBe(false);
    expect(tunnelIsPinned(a, "To-HQ")).toBe(false);
  });
  it("no pins, or no asset at all, alerts on nothing", () => {
    expect(tunnelIsPinned({ monitoredIpsecTunnels: [] }, "to-hq")).toBe(false);
    expect(tunnelIsPinned({}, "to-hq")).toBe(false);
    expect(tunnelIsPinned(undefined, "to-hq")).toBe(false);
  });
});

describe("scopeIsUnconstrained", () => {
  // The distinction scopeMatchesAsset cannot make: `{}` means "nothing" to the
  // matcher and "everything" to an automation saved before device filters
  // reached event triggers (business rule 46). Every caller that FILTERS on a
  // scope has to ask this first.
  it("allAssets and an absent/empty scope are both unconstrained", () => {
    expect(scopeIsUnconstrained({ allAssets: true })).toBe(true);
    expect(scopeIsUnconstrained({})).toBe(true);
    expect(scopeIsUnconstrained(null)).toBe(true);
    expect(scopeIsUnconstrained(undefined)).toBe(true);
  });
  it("an empty condition tree selects nothing either (it ANDs to true)", () => {
    expect(scopeIsUnconstrained({ condition: { op: "and", children: [] } })).toBe(true);
  });
  it("any populated dimension, or any tree with a rule in it, constrains", () => {
    expect(scopeIsUnconstrained({ assetTypes: ["switch"] })).toBe(false);
    expect(scopeIsUnconstrained({ tags: ["prod"] })).toBe(false);
    expect(scopeIsUnconstrained({ assetIds: ["a1"] })).toBe(false);
    expect(scopeIsUnconstrained({ integrationIds: ["i1"] })).toBe(false);
    expect(scopeIsUnconstrained({ manufacturers: ["Fortinet"] })).toBe(false);
    expect(scopeIsUnconstrained({ models: ["FGT-60F"] })).toBe(false);
    expect(scopeIsUnconstrained({ subnetCidrs: ["10.0.0.0/8"] })).toBe(false);
    expect(scopeIsUnconstrained({ condition: { op: "and", children: [{ field: "hostname", operator: "contains", value: "fw" }] } })).toBe(false);
  });
  it("an empty LIST is not a constraint (the matcher ignores it too)", () => {
    expect(scopeIsUnconstrained({ assetTypes: [], tags: [] })).toBe(true);
  });
});

describe("scopeMatchesAsset", () => {
  const asset: ScopeAsset = {
    id: "a1", assetType: "server", tags: ["region:Atlanta", "prod"], discoveredByIntegrationId: "i1",
    manufacturer: "Fortinet Inc.", model: "FortiGate FGT-60F", ipAddress: "10.20.30.40",
  };
  it("allAssets matches anything", () => {
    expect(scopeMatchesAsset({ allAssets: true }, asset)).toBe(true);
  });
  it("empty scope (no dimensions, not allAssets) matches nothing", () => {
    expect(scopeMatchesAsset({}, asset)).toBe(false);
  });
  it("AND across dimensions, OR within a list", () => {
    expect(scopeMatchesAsset({ assetTypes: ["server", "switch"] }, asset)).toBe(true);
    expect(scopeMatchesAsset({ assetTypes: ["switch"] }, asset)).toBe(false);
    // both dimensions must pass
    expect(scopeMatchesAsset({ assetTypes: ["server"], tags: ["prod"] }, asset)).toBe(true);
    expect(scopeMatchesAsset({ assetTypes: ["server"], tags: ["staging"] }, asset)).toBe(false);
  });
  it("tag match is case-insensitive", () => {
    expect(scopeMatchesAsset({ tags: ["REGION:atlanta"] }, asset)).toBe(true);
  });
  it("matches by integration id and asset id", () => {
    expect(scopeMatchesAsset({ integrationIds: ["i1"] }, asset)).toBe(true);
    expect(scopeMatchesAsset({ assetIds: ["a1"] }, asset)).toBe(true);
    expect(scopeMatchesAsset({ assetIds: ["other"] }, asset)).toBe(false);
  });
  it("manufacturer / model match case-insensitively on contains", () => {
    expect(scopeMatchesAsset({ manufacturers: ["fortinet"] }, asset)).toBe(true);
    expect(scopeMatchesAsset({ manufacturers: ["Cisco", "FORTINET"] }, asset)).toBe(true); // OR within
    expect(scopeMatchesAsset({ manufacturers: ["Cisco"] }, asset)).toBe(false);
    expect(scopeMatchesAsset({ models: ["fgt-60f"] }, asset)).toBe(true);
    expect(scopeMatchesAsset({ models: ["FGT-100"] }, asset)).toBe(false);
    // absent asset fields never match
    expect(scopeMatchesAsset({ manufacturers: ["fortinet"] }, { ...asset, manufacturer: null })).toBe(false);
  });
  it("subnetCidrs match the primary IP; bare IPs act as host routes", () => {
    expect(scopeMatchesAsset({ subnetCidrs: ["10.20.0.0/16"] }, asset)).toBe(true);
    expect(scopeMatchesAsset({ subnetCidrs: ["10.99.0.0/16", "10.20.30.0/24"] }, asset)).toBe(true); // OR within
    expect(scopeMatchesAsset({ subnetCidrs: ["10.99.0.0/16"] }, asset)).toBe(false);
    expect(scopeMatchesAsset({ subnetCidrs: ["10.20.30.40"] }, asset)).toBe(true); // bare IP = /32
    expect(scopeMatchesAsset({ subnetCidrs: ["10.20.30.41"] }, asset)).toBe(false);
    expect(scopeMatchesAsset({ subnetCidrs: ["10.20.0.0/16"] }, { ...asset, ipAddress: null })).toBe(false);
  });
  it("new dimensions AND with the existing ones", () => {
    expect(scopeMatchesAsset({ assetTypes: ["server"], manufacturers: ["fortinet"], subnetCidrs: ["10.20.0.0/16"] }, asset)).toBe(true);
    expect(scopeMatchesAsset({ assetTypes: ["switch"], manufacturers: ["fortinet"] }, asset)).toBe(false);
  });
});

describe("stripRegionPrefix", () => {
  it("strips the region: prefix and leaves plain tags alone", () => {
    expect(stripRegionPrefix("region:Atlanta")).toBe("Atlanta");
    expect(stripRegionPrefix("REGION:Boston")).toBe("Boston");
    expect(stripRegionPrefix("prod")).toBe("prod");
  });
});

describe("ruleInputSchema", () => {
  it("accepts a valid host_metric rule and applies defaults", () => {
    const parsed = ruleInputSchema.parse({
      name: "host mem",
      trigger: { type: "host_metric", metric: "memUsedPct", operator: ">", threshold: 85 },
    });
    expect(parsed.severity).toBe("warning");
    expect(parsed.reset).toEqual({ mode: "manual" }); // v2 canonical output
    // A body with no actions array still audits: the Event was implicit before
    // it became an action, so omitting it can't silently turn auditing off.
    // An EXPLICIT `actions: []` is respected — that's the opt-out.
    expect(parsed.actions).toEqual([{ type: "event" }]);
    expect(parsed.channels).toEqual(["in_app"]);
    // trigger defaults
    expect((parsed.trigger as any).aggregation).toBe("latest");
    expect((parsed.trigger as any).forDurationSec).toBe(0);
  });
  it("accepts asset_metric, asset_state, event, and change triggers", () => {
    expect(() => ruleInputSchema.parse({ name: "a", trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 80 }, scope: { allAssets: true } })).not.toThrow();
    expect(() => ruleInputSchema.parse({ name: "b", trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" }, scope: { assetTypes: ["server"] } })).not.toThrow();
    expect(() => ruleInputSchema.parse({ name: "c", trigger: { type: "event", actionPattern: "monitor.status_changed" } })).not.toThrow();
    expect(() => ruleInputSchema.parse({ name: "d", trigger: { type: "change", changeType: "lldp_neighbor_added" }, scope: { allAssets: true } })).not.toThrow();
  });
  it("rejects an unknown trigger type and unknown metric", () => {
    expect(() => ruleInputSchema.parse({ name: "x", trigger: { type: "bogus" } })).toThrow();
    expect(() => ruleInputSchema.parse({ name: "y", trigger: { type: "host_metric", metric: "nope", operator: ">", threshold: 1 } })).toThrow();
  });
});

describe("buildSchemaCatalog", () => {
  it("exposes all six trigger types with the scoped flag", () => {
    const cat = buildSchemaCatalog();
    const types = cat.triggerTypes.map((t) => t.type);
    expect(types).toEqual(["asset_metric", "asset_state", "host_metric", "event", "change", "composite"]);
    const scoped = cat.triggerTypes.filter((t) => t.scoped).map((t) => t.type);
    // `event` joined the scoped list in 2026-09 (business rule 46) — the flag is
    // what makes the wizard SAVE the Devices step instead of discarding it.
    // `host_metric` is the only one left that genuinely ignores a device filter.
    expect(scoped).toEqual(["asset_metric", "asset_state", "event", "change", "composite"]);
  });
});

describe("applyDeviceFilters", () => {
  const fleet = [
    { id: "1", hostname: "CORE-SW-01", ipAddress: "10.4.12.1", macAddress: "aa:bb:cc:00:00:01", manufacturer: "Fortinet Inc.", model: "FS-148F" },
    { id: "2", hostname: "db-server-2", ipAddress: "10.9.0.5", macAddress: "00:50:56:aa:bb:02", manufacturer: "VMware, Inc.", model: "VMware7,1" },
    { id: "3", hostname: null, ipAddress: null, macAddress: null, manufacturer: null, model: null },
  ];
  const ids = (df: Record<string, string>) => applyDeviceFilters(fleet, df).map((a) => a.id);

  it("narrows by each identifier dimension", () => {
    expect(ids({ hostnamePattern: "core" })).toEqual(["1"]);
    expect(ids({ ipPattern: "10.4" })).toEqual(["1"]);
    expect(ids({ ipPattern: "10.4.0.0/16" })).toEqual(["1"]);
    expect(ids({ macPattern: "00-50-56" })).toEqual(["2"]); // separator-insensitive
    expect(ids({ manufacturerPattern: "vmware" })).toEqual(["2"]);
    expect(ids({ modelPattern: "FS-148" })).toEqual(["1"]);
  });

  it("dimensions AND together, and a device missing the field never matches", () => {
    expect(ids({ hostnamePattern: "0", ipPattern: "10.9." })).toEqual([]);
    expect(ids({ manufacturerPattern: "VMware", ipPattern: "10.9." })).toEqual(["2"]);
    expect(ids({ hostnamePattern: "x" })).toEqual([]); // null hostname is not a match
  });

  it("no identifier pattern set passes the set through untouched", () => {
    expect(applyDeviceFilters(fleet, {})).toBe(fleet);
    expect(applyDeviceFilters(fleet, null)).toBe(fleet);
    expect(applyDeviceFilters(fleet, undefined)).toBe(fleet);
    // Non-identifier dimensions on the same filter don't trigger a scan.
    expect(applyDeviceFilters(fleet, { ifNamePattern: "wan" } as never)).toBe(fleet);
  });
});

describe("trigger dimension vocabulary (identifier + state-field dims)", () => {
  it("publishes the device-identifier dimensions once, not per metric", () => {
    const catalog = buildSchemaCatalog();
    expect(catalog.deviceFilterDimensions).toEqual([
      "hostnamePattern", "ipPattern", "macPattern", "manufacturerPattern", "modelPattern",
    ]);
    // METRIC_DIMENSIONS stays metric-specific — identifiers are not repeated
    // into every entry (the wizard's filter rows read deviceFilterDimensions).
    const md = catalog.metricDimensions as Record<string, string[]>;
    expect(md.storageUsedPct).toEqual(["mountPathPattern"]);
    expect(md.ifInBps).toEqual(["ifNamePattern"]);
    expect(md.cpuPct).toBeUndefined();
  });
  it("state fields publish their component-name dimensions (the wizard's fieldDimensions)", () => {
    const fd = buildSchemaCatalog().fieldDimensions as Record<string, string[]>;
    // The engine has honored these filters since the pin-gate work; the builder
    // finally offers them (interface on the state trio, tunnel on ipsecStatus).
    expect(fd.ifOperStatus).toEqual(["ifNamePattern"]);
    expect(fd.ifAdminStatus).toEqual(["ifNamePattern"]);
    expect(fd.ifIpAddress).toEqual(["ifNamePattern"]);
    expect(fd.poeStatus).toEqual(["ifNamePattern"]);
    expect(fd.ipsecStatus).toEqual(["tunnelName"]);
    // The SD-WAN pair alerts per ruleName — this narrows to the named rule(s).
    expect(fd.sdwanRuleStatus).toEqual(["sdwanRulePattern"]);
    expect(fd.sdwanSelectedMember).toEqual(["sdwanRulePattern"]);
    expect(fd.monitorStatus).toBeUndefined();
  });
  it("triggerDimensionApplicable admits metric dims, field dims, and identifiers on any asset leaf", () => {
    expect(triggerDimensionApplicable("storageUsedPct", "mountPathPattern")).toBe(true);
    expect(triggerDimensionApplicable("ifOperStatus", "ifNamePattern")).toBe(true);
    expect(triggerDimensionApplicable("sdwanRuleStatus", "sdwanRulePattern")).toBe(true);
    expect(triggerDimensionApplicable("sdwanSelectedMember", "sdwanRulePattern")).toBe(true);
    expect(triggerDimensionApplicable("cpuPct", "hostnamePattern")).toBe(true);
    expect(triggerDimensionApplicable("ipsecStatus", "macPattern")).toBe(true);
    // Wrong pairings stay 400s at the dimension-values endpoint.
    expect(triggerDimensionApplicable("cpuPct", "ifNamePattern")).toBe(false);
    expect(triggerDimensionApplicable("ifOperStatus", "tunnelName")).toBe(false);
    // Host metrics have no asset, so no identifier dims.
    expect(triggerDimensionApplicable("loadAvg1", "hostnamePattern")).toBe(false);
  });
  it("ruleInputSchema accepts identifier dims on metric AND state triggers", () => {
    const base = { name: "t", severity: "warning", scope: { allAssets: true }, messageTemplate: "{message}" };
    expect(() => ruleInputSchema.parse({
      ...base,
      trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90, dimensionFilter: { hostnamePattern: "db-", manufacturerPattern: "Dell" } },
    })).not.toThrow();
    expect(() => ruleInputSchema.parse({
      ...base,
      trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", dimensionFilter: { ifNamePattern: "wan1", ipPattern: "10.4.0.0/16", macPattern: "aa:bb" } },
    })).not.toThrow();
    expect(() => ruleInputSchema.parse({
      ...base,
      trigger: { type: "asset_state", field: "ipsecStatus", operator: "!=", value: "up", dimensionFilter: { tunnelName: "to-hq", modelPattern: "FGT-60F" } },
    })).not.toThrow();
    expect(() => ruleInputSchema.parse({
      ...base,
      trigger: { type: "asset_state", field: "sdwanSelectedMember", operator: "!=", value: "wan1", dimensionFilter: { sdwanRulePattern: "Internet", hostnamePattern: "BRANCH" } },
    })).not.toThrow();
  });
});

describe("ifIpAddress (interface IP address state field)", () => {
  const base = { name: "t", severity: "warning", scope: { allAssets: true }, messageTemplate: "{message}" };

  it("is authorable as a per-interface condition", () => {
    // The shape the SD-WAN case needs: the underlay port names itself through
    // the interface dimension, and the gate is the negative comparison.
    expect(() => ruleInputSchema.parse({
      ...base,
      trigger: { type: "asset_state", field: "ifIpAddress", operator: "!=", value: "0.0.0.0", dimensionFilter: { ifNamePattern: "wan1" } },
    })).not.toThrow();
    expect(triggerDimensionApplicable("ifIpAddress", "ifNamePattern")).toBe(true);
    expect(triggerDimensionApplicable("ifIpAddress", "tunnelName")).toBe(false);
  });

  it("publishes a label, an address placeholder and equality-only operators", () => {
    // The builder renders the operator select and the value box off these: the
    // default hint ("e.g. up / down") is wrong for an address, and an ordered
    // comparator over one can only ever read false (compareValue).
    const fieldMeta = buildSchemaCatalog().fieldMeta as Record<string, { label: string; kind: string; placeholder?: string; equalityOnly?: boolean; integralDimension?: string }>;
    const meta = fieldMeta.ifIpAddress!;
    expect(meta.label).toBe("Interface IP address");
    expect(meta.kind).toBe("dynamic");
    expect(meta.placeholder).toBe("e.g. 0.0.0.0");
    expect(meta.equalityOnly).toBe(true);
    // The interface is INTEGRAL to this field, which is what keeps its picker on
    // the condition row instead of leaving it to a group filter row: an address
    // comparison is about one port, and unnamed it reads "any monitored
    // interface" — true of every addressed device once a composite folds it per
    // device. The other interface fields are narrowed by choice, not by need.
    expect(meta.integralDimension).toBe("ifNamePattern");
    expect(triggerDimensionApplicable("ifIpAddress", meta.integralDimension!)).toBe(true);
    for (const f of ["ifOperStatus", "ifAdminStatus", "poeStatus"]) expect(fieldMeta[f]!.integralDimension).toBeUndefined();
  });

  it("compares an address the way the resolver hands it over", () => {
    // The resolver normalizes the reading through bareInterfaceIp, so what
    // reaches compareValue is the bare address on both sides.
    expect(compareValue(bareInterfaceIp("0.0.0.0 0.0.0.0"), "!=", "0.0.0.0")).toBe(false);
    expect(compareValue(bareInterfaceIp("10.4.1.1 255.255.255.0"), "!=", "0.0.0.0")).toBe(true);
    // No reading is not "has an address" — a null never satisfies anything.
    expect(compareValue(null, "!=", "0.0.0.0")).toBe(false);
  });
});
