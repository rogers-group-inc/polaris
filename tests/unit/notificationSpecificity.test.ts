/**
 * tests/unit/notificationSpecificity.test.ts — the pure precedence + severity
 * primitives: scopeRank (the least→most specificity ladder over flat dims + the
 * condition tree), triggerSignature (the carve-out "same trigger" key), and
 * severityForValue / severityRank (value-driven severity bands).
 */

import { describe, it, expect } from "vitest";
import { scopeRank, scopeRankLabel, triggerSignature, severityForValue, severityRank, type RuleScope, type Trigger } from "../../src/services/notificationTypes.js";
import { SCOPE_RANK } from "../../src/services/notificationTypes/specificity.js";

const scope = (s: Partial<RuleScope>): RuleScope => s as RuleScope;

describe("scopeRank — flat dimensions", () => {
  it("all-assets / empty scope ranks 0", () => {
    expect(scopeRank(scope({ allAssets: true }))).toBe(SCOPE_RANK.allAssets);
    expect(scopeRank(scope({}))).toBe(0);
  });

  it("ranks each flat dimension on the ladder", () => {
    expect(scopeRank(scope({ assetTypes: ["switch"] }))).toBe(SCOPE_RANK.assetType);
    expect(scopeRank(scope({ manufacturers: ["Cisco"] }))).toBe(SCOPE_RANK.manufacturer);
    expect(scopeRank(scope({ models: ["C9300"] }))).toBe(SCOPE_RANK.model);
    expect(scopeRank(scope({ subnetCidrs: ["10.0.0.0/24"] }))).toBe(SCOPE_RANK.subnet);
    expect(scopeRank(scope({ tags: ["core"] }))).toBe(SCOPE_RANK.tag);
  });

  it("a region: tag outranks a plain tag", () => {
    expect(scopeRank(scope({ tags: ["region:east"] }))).toBe(SCOPE_RANK.region);
    expect(scopeRank(scope({ tags: ["core", "region:east"] }))).toBe(SCOPE_RANK.region);
  });

  it("takes the MAX across mixed flat dimensions", () => {
    expect(scopeRank(scope({ assetTypes: ["switch"], subnetCidrs: ["10.0.0.0/24"] }))).toBe(SCOPE_RANK.subnet);
  });

  it("assetIds / integrationIds are not on the ladder", () => {
    expect(scopeRank(scope({ assetIds: ["abc"] }))).toBe(0);
    expect(scopeRank(scope({ integrationIds: ["int1"] }))).toBe(0);
  });
});

describe("scopeRank — condition tree", () => {
  const cond = (children: any[], op = "and"): RuleScope => scope({ condition: { op, children } as any });

  it("ranks positive rules by field, hostname the most specific", () => {
    expect(scopeRank(cond([{ field: "assetType", operator: "equals", value: "switch" }]))).toBe(SCOPE_RANK.assetType);
    expect(scopeRank(cond([{ field: "os", operator: "contains", value: "FortiOS" }]))).toBe(SCOPE_RANK.os);
    expect(scopeRank(cond([{ field: "hostname", operator: "startsWith", value: "core" }]))).toBe(SCOPE_RANK.hostname);
  });

  it("a region: tag rule outranks a plain tag rule", () => {
    expect(scopeRank(cond([{ field: "tag", operator: "has", value: "region:west" }]))).toBe(SCOPE_RANK.region);
    expect(scopeRank(cond([{ field: "tag", operator: "has", value: "core" }]))).toBe(SCOPE_RANK.tag);
  });

  it("status and assetId rules do not raise specificity", () => {
    expect(scopeRank(cond([{ field: "status", operator: "equals", value: "active" }]))).toBe(0);
    expect(scopeRank(cond([{ field: "assetId", operator: "equals", value: "abc" }]))).toBe(0);
  });

  it("negative operators do not target (broaden), so they rank 0", () => {
    expect(scopeRank(cond([{ field: "hostname", operator: "notContains", value: "lab" }]))).toBe(0);
    expect(scopeRank(cond([{ field: "tag", operator: "notHas", value: "core" }]))).toBe(0);
  });

  it("none / notAll subtrees invert to must-NOT and do not raise rank", () => {
    expect(scopeRank(cond([{ field: "hostname", operator: "equals", value: "x" }], "none"))).toBe(0);
    expect(scopeRank(cond([{ field: "subnet", operator: "inCidr", value: "10.0.0.0/8" }], "notAll"))).toBe(0);
  });

  it("takes the MAX across nested positive rules and combines with flat dims", () => {
    const s = scope({
      assetTypes: ["switch"],
      condition: {
        op: "and",
        children: [
          { field: "os", operator: "contains", value: "FortiOS" },
          { op: "or", children: [{ field: "hostname", operator: "startsWith", value: "core" }] },
        ],
      } as any,
    });
    expect(scopeRank(s)).toBe(SCOPE_RANK.hostname);
  });
});

describe("scopeRankLabel", () => {
  it("maps a numeric rank to the ladder rung", () => {
    expect(scopeRankLabel(SCOPE_RANK.allAssets)).toBe("All assets");
    expect(scopeRankLabel(SCOPE_RANK.hostname)).toBe("Hostname");
    expect(scopeRankLabel(SCOPE_RANK.region)).toBe("Region");
  });
});

describe("triggerSignature", () => {
  it("keys asset_metric by metric + dimension filter", () => {
    const t = (df?: any): Trigger => ({ type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 80, aggregation: "latest", windowSec: 0, forDurationSec: 0, dimensionFilter: df } as any);
    expect(triggerSignature(t())).toBe("am:hwSensorValue:");
    expect(triggerSignature(t({ sensorClass: "temperature" }))).toBe("am:hwSensorValue:sensorClass=temperature");
  });

  it("a filtered sensor and an unfiltered one are DIFFERENT signatures (strict, never cross-shadow)", () => {
    const base = { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 80, aggregation: "latest", windowSec: 0, forDurationSec: 0 } as const;
    expect(triggerSignature({ ...base } as any)).not.toBe(triggerSignature({ ...base, dimensionFilter: { sensorClass: "temperature" } } as any));
    expect(triggerSignature({ ...base, dimensionFilter: { sensorClass: "temperature" } } as any)).not.toBe(triggerSignature({ ...base, dimensionFilter: { sensorClass: "fan" } } as any));
  });

  it("keys asset_state by field", () => {
    expect(triggerSignature({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", forDurationSec: 0 } as any)).toBe("as:ifOperStatus:");
  });

  // monitorStatus is the one state field keyed by VALUE and NOT by its device
  // filter — it is a single per-asset column with no reading dimensions, so a
  // dimensionFilter on it narrows the asset set rather than the reading. Every
  // "== down" automation therefore has to land in ONE carve-out group whatever
  // its device filter, because that group is also what decides whose
  // missed-poll count governs each asset (down-detection authority).
  it("groups every monitorStatus == down rule together regardless of device filter", () => {
    const down = (df?: any): Trigger =>
      ({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down", forDurationSec: 0, dimensionFilter: df } as any);
    expect(triggerSignature(down())).toBe("as:monitorStatus:==down");
    expect(triggerSignature(down({ hostnamePattern: "core-" }))).toBe(triggerSignature(down()));
    expect(triggerSignature(down({ modelPattern: "FortiSwitch" }))).toBe(triggerSignature(down()));
  });

  it("keys monitorStatus by the compared VALUE — down and warning are different things to watch", () => {
    const at = (value: string): Trigger =>
      ({ type: "asset_state", field: "monitorStatus", operator: "==", value, forDurationSec: 0 } as any);
    expect(triggerSignature(at("down"))).not.toBe(triggerSignature(at("warning")));
    expect(triggerSignature(at("down"))).not.toBe(triggerSignature(at("passive")));
    // and by the comparator, so "is not down" never shadows "is down"
    expect(triggerSignature(at("down"))).not.toBe(
      triggerSignature({ type: "asset_state", field: "monitorStatus", operator: "!=", value: "down", forDurationSec: 0 } as any),
    );
  });

  it("compares monitorStatus values case-insensitively", () => {
    const at = (value: string): Trigger =>
      ({ type: "asset_state", field: "monitorStatus", operator: "==", value, forDurationSec: 0 } as any);
    expect(triggerSignature(at("Down"))).toBe(triggerSignature(at("down")));
  });

  it("still keys OTHER state fields by their dimension filter", () => {
    const iface = (df?: any): Trigger =>
      ({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", forDurationSec: 0, dimensionFilter: df } as any);
    expect(triggerSignature(iface({ interfaceName: "port2" }))).not.toBe(triggerSignature(iface()));
  });

  it("returns null for host_metric / event / change / composite (exempt from carve-out)", () => {
    expect(triggerSignature({ type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90, aggregation: "latest", windowSec: 0, forDurationSec: 0 } as any)).toBeNull();
    expect(triggerSignature({ type: "event", actionPattern: "x.*" } as any)).toBeNull();
    expect(triggerSignature({ type: "change", changeType: "sdwan_failover" } as any)).toBeNull();
    expect(triggerSignature({ type: "composite", kind: "asset", op: "and", children: [], forDurationSec: 0 } as any)).toBeNull();
  });
});

describe("severityRank", () => {
  it("orders notice < informational < warning < serious < critical", () => {
    expect(severityRank("notice")).toBeLessThan(severityRank("warning"));
    expect(severityRank("warning")).toBeLessThan(severityRank("serious"));
    expect(severityRank("serious")).toBeLessThan(severityRank("critical"));
    expect(severityRank("bogus")).toBe(-1);
  });
});

describe("severityForValue", () => {
  // warning ≥55, serious ≥60, critical ≥65
  const bands = [{ threshold: 60, severity: "serious" as const }, { threshold: 65, severity: "critical" as const }];

  it("returns null below tier 0 (not firing)", () => {
    expect(severityForValue(">=", 55, "warning", bands, 54)).toBeNull();
    expect(severityForValue(">=", 55, "warning", bands, null)).toBeNull();
  });

  it("returns the most-severe satisfied tier for ascending thresholds", () => {
    expect(severityForValue(">=", 55, "warning", bands, 55)).toBe("warning");
    expect(severityForValue(">=", 55, "warning", bands, 61)).toBe("serious");
    expect(severityForValue(">=", 55, "warning", bands, 66)).toBe("critical");
  });

  it("no bands behaves like the single-threshold fire/clear decision", () => {
    expect(severityForValue(">=", 90, "critical", null, 95)).toBe("critical");
    expect(severityForValue(">=", 90, "critical", [], 80)).toBeNull();
  });

  it("works for a descending (<=) direction (e.g. days-until-full)", () => {
    // ≤30 warning, ≤14 serious, ≤7 critical
    const low = [{ threshold: 14, severity: "serious" as const }, { threshold: 7, severity: "critical" as const }];
    expect(severityForValue("<=", 30, "warning", low, 31)).toBeNull();
    expect(severityForValue("<=", 30, "warning", low, 20)).toBe("warning");
    expect(severityForValue("<=", 30, "warning", low, 10)).toBe("serious");
    expect(severityForValue("<=", 30, "warning", low, 3)).toBe("critical");
  });
});
