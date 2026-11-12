/**
 * tests/unit/scopeConditions.test.ts — the scope condition tree
 * (src/services/notificationTypes/scopeConditions.ts): the vocabulary, the two
 * Zod tree schemas, the pure evaluator and the prefetch-key helpers.
 *
 * Complements (does not repeat):
 *  - assetTypeMatch.test.ts — assetType equals / notEquals through the evaluator;
 *  - notificationEngine.test.ts / deviceFilterCondition.test.ts — the evaluator
 *    reached through scopeMatchesAsset and the contact device filter;
 *  - nativeVlan / port-tag suites — positiveNativeVlans over business rule 133.
 * New here: group-combinator identities (and / or / none / notAll on empty and
 * mixed children), every field family's arm (CIDR / range / subnet-name,
 * multi-valued fortigate + interface + SSID with the any-vs-all negation rule,
 * agentInstalled, relation-leaf prefetch has()-vs-get()), the schema's cross-field
 * refusals, the depth / rule caps on scopeSchema, and the key helpers.
 * Pure module — no database, no network.
 */

import { describe, it, expect } from "vitest";
import {
  SEVERITIES,
  severityRank,
  eventFeedsAutomations,
  ALERT_EMAIL_SENT_ACTION,
  SCOPE_FIELD_OPS,
  DEVICE_FILTER_FIELD_OPS,
  scopeConditionSchema,
  deviceFilterConditionSchema,
  scopeConditionStats,
  conditionFields,
  conditionNeedsInterfaces,
  conditionNeedsApVaps,
  conditionNeedsManagedAgent,
  parseVlanId,
  positiveNativeVlans,
  positiveStringOp,
  relationLeafKey,
  isSubnetNameLeaf,
  subnetNameLeafKey,
  evaluateScopeCondition,
  scopeSchema,
  scopeCidrOf,
  SCOPE_CONDITION_MAX_DEPTH,
  SCOPE_CONDITION_MAX_RULES,
  type ScopeConditionGroup,
  type ScopeConditionRule,
  type ScopeConditionAsset,
} from "../../src/services/notificationTypes/scopeConditions.js";

const rule = (field: string, operator: string, value: string): ScopeConditionRule => ({ field, operator, value });
const and = (...children: ScopeConditionGroup["children"]): ScopeConditionGroup => ({ op: "and", children });
const asset = (over: Partial<ScopeConditionAsset> = {}): ScopeConditionAsset => ({ id: "a1", ...over });

describe("severity + event vocabulary", () => {
  it("ranks severities least to most severe, -1 for unknown", () => {
    expect(SEVERITIES.map(severityRank)).toEqual([0, 1, 2, 3, 4]);
    expect(severityRank("critical")).toBeGreaterThan(severityRank("warning"));
    expect(severityRank("fatal")).toBe(-1);
  });

  it("rule 106: the alert-email Event never feeds automations, everything else does", () => {
    expect(eventFeedsAutomations(ALERT_EMAIL_SENT_ACTION)).toBe(false);
    expect(eventFeedsAutomations("notification.triggered")).toBe(true);
    expect(eventFeedsAutomations("notification.email_sent.extra")).toBe(true);
  });
});

describe("field vocabularies", () => {
  it("the device-filter vocabulary is a strict superset of the automations scope", () => {
    for (const field of Object.keys(SCOPE_FIELD_OPS)) {
      for (const op of SCOPE_FIELD_OPS[field]!) expect(DEVICE_FILTER_FIELD_OPS[field]).toContain(op);
    }
    for (const extra of ["osVersion", "department", "location", "fortigate", "nativeVlan"]) {
      expect(SCOPE_FIELD_OPS[extra]).toBeUndefined();
      expect(DEVICE_FILTER_FIELD_OPS[extra]).toBeDefined();
    }
  });

  it("only free-string fields gain the wildcard operator", () => {
    expect(DEVICE_FILTER_FIELD_OPS.hostname).toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.assetType).not.toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.subnet).not.toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.tag).not.toContain("matches");
    expect(SCOPE_FIELD_OPS.hostname).not.toContain("matches");
  });
});

describe("scopeConditionSchema", () => {
  it("accepts a valid nested tree", () => {
    const tree = and(rule("hostname", "contains", "core"), { op: "or", children: [rule("subnet", "inCidr", "10.0.0.0/8"), rule("tag", "has", "prod")] });
    expect(scopeConditionSchema.safeParse(tree).success).toBe(true);
  });

  it("refuses an operator the field does not offer", () => {
    expect(scopeConditionSchema.safeParse(and(rule("tag", "equals", "prod"))).success).toBe(false);
    expect(scopeConditionSchema.safeParse(and(rule("assetType", "contains", "sw"))).success).toBe(false);
  });

  it("refuses device-filter-only fields on the automations scope, accepts them on the device filter", () => {
    const tree = and(rule("location", "contains", "Plant"));
    expect(scopeConditionSchema.safeParse(tree).success).toBe(false);
    expect(deviceFilterConditionSchema.safeParse(tree).success).toBe(true);
  });

  it("subnet / ipBlock values must be a CIDR or an IP", () => {
    expect(scopeConditionSchema.safeParse(and(rule("subnet", "inCidr", "10.1.2.3"))).success).toBe(true);
    expect(scopeConditionSchema.safeParse(and(rule("ipBlock", "notInCidr", "10.0.0.0/8"))).success).toBe(true);
    expect(scopeConditionSchema.safeParse(and(rule("subnet", "inCidr", "not-a-cidr"))).success).toBe(false);
    expect(scopeConditionSchema.safeParse(and(rule("ipBlock", "inCidr", "10.0.0.0/33"))).success).toBe(false);
  });

  it("an IPv4 range must parse first-to-last", () => {
    expect(scopeConditionSchema.safeParse(and(rule("subnet", "inRange", "10.0.0.10-10.0.0.50"))).success).toBe(true);
    expect(scopeConditionSchema.safeParse(and(rule("subnet", "notInRange", "10.0.0.10-50"))).success).toBe(true);
    expect(scopeConditionSchema.safeParse(and(rule("subnet", "inRange", "10.0.0.50-10.0.0.10"))).success).toBe(false);
    expect(scopeConditionSchema.safeParse(and(rule("subnet", "inRange", "10.0.0.0/24"))).success).toBe(false);
  });

  it("a subnet-name pattern is not CIDR-validated", () => {
    expect(scopeConditionSchema.safeParse(and(rule("subnet", "inSubnetNamed", "Plant-*"))).success).toBe(true);
  });

  it("nativeVlan values must be 1..4094 on the device filter", () => {
    expect(deviceFilterConditionSchema.safeParse(and(rule("nativeVlan", "equals", "30"))).success).toBe(true);
    expect(deviceFilterConditionSchema.safeParse(and(rule("nativeVlan", "equals", "0"))).success).toBe(false);
    expect(deviceFilterConditionSchema.safeParse(and(rule("nativeVlan", "equals", "4095"))).success).toBe(false);
    expect(deviceFilterConditionSchema.safeParse(and(rule("nativeVlan", "equals", "vlan30"))).success).toBe(false);
  });

  it("is strict — unknown keys on a rule or a group are refused", () => {
    expect(scopeConditionSchema.safeParse({ op: "and", children: [{ ...rule("hostname", "equals", "x"), extra: 1 }] }).success).toBe(false);
    expect(scopeConditionSchema.safeParse({ op: "and", children: [], extra: true }).success).toBe(false);
    expect(scopeConditionSchema.safeParse({ op: "xor", children: [] }).success).toBe(false);
  });
});

describe("scopeConditionStats / conditionFields / needs*", () => {
  const tree = and(
    rule("hostname", "contains", "a"),
    { op: "or", children: [rule("ssid", "equals", "GUEST"), { op: "none", children: [rule("interfaceName", "equals", "port9")] }] },
  );

  it("counts depth (root = 1) and every rule", () => {
    expect(scopeConditionStats(tree)).toEqual({ depth: 3, rules: 3 });
    expect(scopeConditionStats({ op: "and", children: [] })).toEqual({ depth: 1, rules: 0 });
  });

  it("lists every referenced field and derives the relation joins from it", () => {
    expect([...conditionFields(tree)].sort()).toEqual(["hostname", "interfaceName", "ssid"]);
    expect(conditionNeedsInterfaces(tree)).toBe(true);
    expect(conditionNeedsApVaps(tree)).toBe(true);
    expect(conditionNeedsManagedAgent(tree)).toBe(false);
    expect(conditionNeedsInterfaces(and(rule("nativeVlan", "equals", "5")))).toBe(true);
    expect(conditionNeedsManagedAgent(and(rule("agentInstalled", "equals", "yes")))).toBe(true);
    expect(conditionNeedsInterfaces(null)).toBe(false);
    expect(conditionNeedsApVaps(undefined)).toBe(false);
    expect(conditionNeedsManagedAgent(null)).toBe(false);
  });
});

describe("parseVlanId / positiveNativeVlans", () => {
  it("canonicalizes padded ids and refuses non-VLANs", () => {
    expect(parseVlanId("030")).toBe(30);
    expect(parseVlanId(" 4094 ")).toBe(4094);
    expect(parseVlanId("0")).toBeNull();
    expect(parseVlanId("4095")).toBeNull();
    expect(parseVlanId("12345")).toBeNull();
    expect(parseVlanId("-5")).toBeNull();
    expect(parseVlanId(null)).toBeNull();
  });

  it("collects VLANs asserted present through even/odd negation, sorted and deduped", () => {
    const tree = and(
      rule("nativeVlan", "equals", "30"),
      rule("nativeVlan", "equals", "030"),
      { op: "none", children: [rule("nativeVlan", "notEquals", "10"), rule("nativeVlan", "equals", "99")] },
      { op: "notAll", children: [{ op: "none", children: [rule("nativeVlan", "equals", "5")] }] },
    );
    expect(positiveNativeVlans(tree)).toEqual([5, 10, 30]);
    expect(positiveNativeVlans(null)).toEqual([]);
  });
});

describe("prefetch keys", () => {
  it("positiveStringOp maps only the two negative string ops", () => {
    expect(positiveStringOp("notEquals")).toBe("equals");
    expect(positiveStringOp("notContains")).toBe("contains");
    expect(positiveStringOp("startsWith")).toBe("startsWith");
  });

  it("relationLeafKey shares a key across a negative pair and separates fields", () => {
    expect(relationLeafKey(rule("interfaceName", "equals", "Port9"))).toBe(relationLeafKey(rule("interfaceName", "notEquals", "port9")));
    expect(relationLeafKey(rule("interfaceName", "equals", "GUEST"))).not.toBe(relationLeafKey(rule("ssid", "equals", "GUEST")));
  });

  it("subnet-name leaves are recognized and keyed trimmed + lower-cased", () => {
    expect(isSubnetNameLeaf(rule("subnet", "inSubnetNamed", "x"))).toBe(true);
    expect(isSubnetNameLeaf(rule("subnet", "notInSubnetNamed", "x"))).toBe(true);
    expect(isSubnetNameLeaf(rule("subnet", "inCidr", "10.0.0.0/8"))).toBe(false);
    expect(isSubnetNameLeaf(rule("hostname", "inSubnetNamed", "x"))).toBe(false);
    expect(subnetNameLeafKey(rule("subnet", "inSubnetNamed", " Plant-* "))).toBe(subnetNameLeafKey(rule("subnet", "notInSubnetNamed", "plant-*")));
  });
});

describe("evaluateScopeCondition — group combinators", () => {
  const T = rule("assetType", "equals", "switch");
  const F = rule("assetType", "equals", "firewall");
  const a = asset({ assetType: "switch" });

  it("follows boolean identities on empty groups", () => {
    expect(evaluateScopeCondition({ op: "and", children: [] }, a)).toBe(true);
    expect(evaluateScopeCondition({ op: "or", children: [] }, a)).toBe(false);
    expect(evaluateScopeCondition({ op: "none", children: [] }, a)).toBe(true);
    expect(evaluateScopeCondition({ op: "notAll", children: [] }, a)).toBe(false);
  });

  it("and / or / none / notAll over mixed children", () => {
    expect(evaluateScopeCondition({ op: "and", children: [T, F] }, a)).toBe(false);
    expect(evaluateScopeCondition({ op: "or", children: [T, F] }, a)).toBe(true);
    expect(evaluateScopeCondition({ op: "none", children: [T, F] }, a)).toBe(false);
    expect(evaluateScopeCondition({ op: "none", children: [F] }, a)).toBe(true);
    expect(evaluateScopeCondition({ op: "notAll", children: [T, F] }, a)).toBe(true);
    expect(evaluateScopeCondition({ op: "notAll", children: [T] }, a)).toBe(false);
  });

  it("an unknown combinator selects nothing", () => {
    expect(evaluateScopeCondition({ op: "xor" as never, children: [T] }, a)).toBe(false);
  });
});

describe("evaluateScopeCondition — field arms", () => {
  it("string ops are case-insensitive on both sides", () => {
    const a = asset({ hostname: "CORE-SW-01", manufacturer: "Fortinet", os: "FortiOS" });
    expect(evaluateScopeCondition(and(rule("hostname", "startsWith", "core-")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("hostname", "endsWith", "-01")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("manufacturer", "notContains", "cisco")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("os", "equals", "fortios")), a)).toBe(true);
    // A missing column reads as "" — notEquals holds, contains fails.
    expect(evaluateScopeCondition(and(rule("model", "notEquals", "x")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("model", "contains", "x")), a)).toBe(false);
  });

  it("the wildcard operator matches shell-style on the device filter's fields", () => {
    const a = asset({ hostname: "PLV01-61F-A", department: "Ops" });
    expect(evaluateScopeCondition(and(rule("hostname", "matches", "plv*-61f-?")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("hostname", "matches", "plv*-60f-?")), a)).toBe(false);
    expect(evaluateScopeCondition(and(rule("department", "equals", "ops")), a)).toBe(true);
  });

  it("status and assetId compare exactly; assetId is case-sensitive", () => {
    const a = asset({ id: "Abc", status: "Active" });
    expect(evaluateScopeCondition(and(rule("status", "equals", "active")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("status", "notEquals", "active")), a)).toBe(false);
    expect(evaluateScopeCondition(and(rule("assetId", "equals", "Abc")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("assetId", "equals", "abc")), a)).toBe(false);
    expect(evaluateScopeCondition(and(rule("assetId", "notEquals", "abc")), a)).toBe(true);
  });

  it("tag has / notHas match a WHOLE tag, case-insensitively", () => {
    const a = asset({ tags: ["Priority-Critical"] });
    expect(evaluateScopeCondition(and(rule("tag", "has", "priority-critical")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("tag", "has", "critical")), a)).toBe(false);
    expect(evaluateScopeCondition(and(rule("tag", "notHas", "critical")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("tag", "notHas", "x")), asset())).toBe(true);
  });

  it("subnet / ipBlock CIDR containment, bare IP as a host route, no IP = outside", () => {
    const a = asset({ ipAddress: "10.20.5.9" });
    expect(evaluateScopeCondition(and(rule("subnet", "inCidr", "10.20.0.0/16")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("ipBlock", "inCidr", "10.20.0.0/16")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("subnet", "inCidr", "10.20.5.9")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("subnet", "inCidr", "10.20.5.10")), a)).toBe(false);
    expect(evaluateScopeCondition(and(rule("subnet", "notInCidr", "192.168.0.0/16")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("subnet", "inCidr", "10.0.0.0/8")), asset())).toBe(false);
    expect(evaluateScopeCondition(and(rule("subnet", "notInCidr", "10.0.0.0/8")), asset())).toBe(true);
    // A malformed stored value (written past validation) never throws.
    expect(evaluateScopeCondition(and(rule("subnet", "inCidr", "garbage")), a)).toBe(false);
  });

  it("subnet range is inclusive and IPv4-only", () => {
    expect(evaluateScopeCondition(and(rule("subnet", "inRange", "10.0.0.10-10.0.0.50")), asset({ ipAddress: "10.0.0.50" }))).toBe(true);
    expect(evaluateScopeCondition(and(rule("subnet", "inRange", "10.0.0.10-50")), asset({ ipAddress: "10.0.0.51" }))).toBe(false);
    expect(evaluateScopeCondition(and(rule("subnet", "notInRange", "10.0.0.10-50")), asset({ ipAddress: "10.0.0.51" }))).toBe(true);
    expect(evaluateScopeCondition(and(rule("subnet", "inRange", "10.0.0.10-50")), asset({ ipAddress: "fe80::1" }))).toBe(false);
  });

  it("subnet by name reads only the decorated verdict; undecorated = in no such subnet", () => {
    const leaf = rule("subnet", "inSubnetNamed", "Plant-*");
    const neg = rule("subnet", "notInSubnetNamed", "Plant-*");
    const hits = new Map([[subnetNameLeafKey(leaf), true]]);
    expect(evaluateScopeCondition(and(leaf), asset({ relationLeafHits: hits }))).toBe(true);
    expect(evaluateScopeCondition(and(neg), asset({ relationLeafHits: hits }))).toBe(false);
    expect(evaluateScopeCondition(and(leaf), asset({ ipAddress: "10.0.0.1" }))).toBe(false);
    expect(evaluateScopeCondition(and(neg), asset({ ipAddress: "10.0.0.1" }))).toBe(true);
  });

  it("fortigate: a positive op is ANY name, a negative op must hold for ALL names", () => {
    const a = asset({ learnedLocation: "PLV-FGT-01", fortigateSightings: [{ fortigateDevice: "CENTRALFMG1" }, { fortigateDevice: null }] });
    expect(evaluateScopeCondition(and(rule("fortigate", "contains", "centralfmg")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("fortigate", "notContains", "centralfmg")), a)).toBe(false);
    expect(evaluateScopeCondition(and(rule("fortigate", "notEquals", "other")), a)).toBe(true);
    // Nothing known: positive fails, absence holds.
    expect(evaluateScopeCondition(and(rule("fortigate", "equals", "x")), asset())).toBe(false);
    expect(evaluateScopeCondition(and(rule("fortigate", "notEquals", "x")), asset())).toBe(true);
  });

  it("interfaceName: a switch with port9 AND port10 does not satisfy 'not port9'", () => {
    const a = asset({ interfaces: [{ ifName: "port9" }, { ifName: "port10" }] });
    expect(evaluateScopeCondition(and(rule("interfaceName", "equals", "PORT9")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("interfaceName", "notEquals", "port9")), a)).toBe(false);
    expect(evaluateScopeCondition(and(rule("interfaceName", "notEquals", "port11")), a)).toBe(true);
    expect(evaluateScopeCondition(and(rule("interfaceName", "startsWith", "port1")), a)).toBe(true);
  });

  it("a prefetched relation verdict wins; an absent key falls through to the joined relation", () => {
    const leaf = rule("interfaceName", "equals", "port9");
    const neg = rule("interfaceName", "notEquals", "port9");
    // Prefetch says no, relation says yes — prefetch is authoritative.
    const decorated = asset({ interfaces: [{ ifName: "port9" }], relationLeafHits: new Map([[relationLeafKey(leaf), false]]) });
    expect(evaluateScopeCondition(and(leaf), decorated)).toBe(false);
    expect(evaluateScopeCondition(and(neg), decorated)).toBe(true);
    // A map that lacks this leaf's key is UNKNOWN, not false.
    const other = asset({ interfaces: [{ ifName: "port9" }], relationLeafHits: new Map([["interfaceName|equals\u0000x", false]]) });
    expect(evaluateScopeCondition(and(leaf), other)).toBe(true);
  });

  it("ssid deduplicates VAPs and follows the multi-value negation rule", () => {
    const ap = asset({ apVaps: [{ ssid: "GUEST" }, { ssid: "guest" }, { ssid: null }, { ssid: "CORP" }] });
    expect(evaluateScopeCondition(and(rule("ssid", "equals", "guest")), ap)).toBe(true);
    expect(evaluateScopeCondition(and(rule("ssid", "notEquals", "guest")), ap)).toBe(false);
    expect(evaluateScopeCondition(and(rule("ssid", "equals", "guest")), asset())).toBe(false);
  });

  it("nativeVlan compares by number on both paths", () => {
    const sw = asset({ interfaces: [{ ifName: "p1", nativeVlan: 30 }, { ifName: "p2", nativeVlan: null }] });
    expect(evaluateScopeCondition(and(rule("nativeVlan", "equals", "030")), sw)).toBe(true);
    expect(evaluateScopeCondition(and(rule("nativeVlan", "notEquals", "30")), sw)).toBe(false);
    expect(evaluateScopeCondition(and(rule("nativeVlan", "equals", "31")), sw)).toBe(false);
    // An invalid stored value matches no port.
    expect(evaluateScopeCondition(and(rule("nativeVlan", "equals", "abc")), sw)).toBe(false);
    expect(evaluateScopeCondition(and(rule("nativeVlan", "notEquals", "abc")), sw)).toBe(true);
    const leaf = rule("nativeVlan", "equals", "30");
    expect(evaluateScopeCondition(and(leaf), asset({ relationLeafHits: new Map([[relationLeafKey(leaf), true]]) }))).toBe(true);
  });

  it("agentInstalled: an ACTIVE agent row is yes; prefetch overrides the join", () => {
    const yes = rule("agentInstalled", "equals", "yes");
    const no = rule("agentInstalled", "equals", "no");
    expect(evaluateScopeCondition(and(yes), asset({ managedAgent: { installStatus: "active" } }))).toBe(true);
    expect(evaluateScopeCondition(and(yes), asset({ managedAgent: { installStatus: "pending" } }))).toBe(false);
    expect(evaluateScopeCondition(and(no), asset({ managedAgent: null }))).toBe(true);
    expect(evaluateScopeCondition(and(rule("agentInstalled", "equals", "TRUE")), asset({ managedAgent: { installStatus: "active" } }))).toBe(true);
    expect(evaluateScopeCondition(and(rule("agentInstalled", "notEquals", "yes")), asset({ managedAgent: { installStatus: "active" } }))).toBe(false);
    expect(evaluateScopeCondition(and(yes), asset({ managedAgent: null, relationLeafHits: new Map([[relationLeafKey(yes), true]]) }))).toBe(true);
  });

  it("an unknown operator on a string field matches nothing", () => {
    expect(evaluateScopeCondition(and(rule("hostname", "regex", ".*")), asset({ hostname: "x" }))).toBe(false);
  });
});

describe("scopeSchema", () => {
  it("accepts flat dimensions + a tree, and rejects unknown keys", () => {
    expect(scopeSchema.safeParse({ allAssets: true }).success).toBe(true);
    expect(scopeSchema.safeParse({ tags: ["prod"], condition: and(rule("hostname", "contains", "a")) }).success).toBe(true);
    expect(scopeSchema.safeParse({ bogus: 1 }).success).toBe(false);
  });

  it("validates subnetCidrs entries", () => {
    expect(scopeSchema.safeParse({ subnetCidrs: ["10.0.0.0/8", "10.1.1.1", "fe80::/10"] }).success).toBe(true);
    expect(scopeSchema.safeParse({ subnetCidrs: ["10.0.0.0/40"] }).success).toBe(false);
  });

  it("enforces the depth cap", () => {
    let g: ScopeConditionGroup = and(rule("hostname", "contains", "x"));
    for (let i = 1; i < SCOPE_CONDITION_MAX_DEPTH; i++) g = and(g);
    expect(scopeConditionStats(g).depth).toBe(SCOPE_CONDITION_MAX_DEPTH);
    expect(scopeSchema.safeParse({ condition: g }).success).toBe(true);
    const r = scopeSchema.safeParse({ condition: and(g) });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("nest at most");
  });

  it("enforces the rule cap across groups (each group itself holds at most 50)", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => rule("hostname", "contains", `h${i}`));
    const ok = and({ op: "or", children: fifty }, { op: "or", children: fifty });
    expect(scopeConditionStats(ok).rules).toBe(SCOPE_CONDITION_MAX_RULES);
    expect(scopeSchema.safeParse({ condition: ok }).success).toBe(true);
    const over = and({ op: "or", children: fifty }, { op: "or", children: fifty }, rule("hostname", "contains", "one-more"));
    const r = scopeSchema.safeParse({ condition: over });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain(`at most ${SCOPE_CONDITION_MAX_RULES} rules`);
  });
});

describe("scopeCidrOf", () => {
  it("turns a bare IP into a host route and leaves CIDRs alone", () => {
    expect(scopeCidrOf("10.1.2.3")).toBe("10.1.2.3/32");
    expect(scopeCidrOf("fe80::1")).toBe("fe80::1/128");
    expect(scopeCidrOf("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(scopeCidrOf("junk")).toBe("junk");
  });
});
