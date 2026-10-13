/**
 * tests/unit/notificationRuleShapeV2.test.ts — Automation rule-shape v2:
 * legacy→v2 conversion fidelity (normalizeRuleToV2 / normalizeReset /
 * targetsToNotifyActions / normalizeEscalationToV2), the legacy mirror
 * (legacyMirrorOfV2), input folding (ruleInputSchema accepts old POST
 * bodies), and the v2 cross-field validation (hysteresis threshold ordering).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  ruleInputSchema,
  evaluateScopeCondition,
  previewInputSchema,
  normalizeRuleToV2,
  normalizeReset,
  normalizeEscalationToV2,
  targetsToNotifyActions,
  actionsToTargets,
  legacyMirrorOfV2,
  buildSchemaCatalog,
  allRuleActionRefs,
  ruleHasAnyEscalation,
  escalationChainsForSeverity,
  escalationTierStateKey,
  type DeliveryTarget,
  type EmailComposition,
} from "../../src/services/notificationTypes.js";
import { scopeMatchesAsset } from "../../src/services/notificationRuleService.js";

const metricTrigger = { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 };

describe("normalizeReset", () => {
  it("derives reset from legacy clearBehavior/clearAfterSec", () => {
    expect(normalizeReset(null, "manual", null)).toEqual({ mode: "manual" });
    expect(normalizeReset(null, "auto", null)).toEqual({ mode: "auto" });
    expect(normalizeReset(null, "timed", 3600)).toEqual({ mode: "timed", afterSec: 3600 });
    expect(normalizeReset(null, undefined, undefined)).toEqual({ mode: "manual" });
  });

  it("strips mode-irrelevant fields from a provided reset", () => {
    expect(normalizeReset({ mode: "manual", afterSec: 60, clearThreshold: 5 } as any)).toEqual({ mode: "manual" });
    expect(normalizeReset({ mode: "timed", afterSec: 120, clearThreshold: 5 } as any)).toEqual({ mode: "timed", afterSec: 120 });
    expect(normalizeReset({ mode: "auto", clearThreshold: 80, sustainSec: 300, afterSec: 99 } as any)).toEqual({
      // `sustainPolls` is the count the engine actually counts; null = this
      // reset states only its wall-clock mirror.
      mode: "auto", clearThreshold: 80, sustainSec: 300, sustainPolls: null,
    });
  });
});

describe("targetsToNotifyActions / actionsToTargets round-trip", () => {
  const targets: DeliveryTarget[] = [
    { channelId: "ch-email", recipientUserIds: ["u1"], addresses: ["noc@example.com"], recipientScopeRegion: true },
    { channelId: "ch-slack" },
  ];
  const comp: EmailComposition = { subjectTemplate: "[{severity.upper}] {asset}" };

  it("copies the rule-level emailComposition onto every converted notify action", () => {
    const actions = targetsToNotifyActions(targets, comp);
    expect(actions).toHaveLength(2);
    for (const a of actions) {
      expect(a.type).toBe("notify");
      expect((a as any).emailComposition).toEqual(comp);
    }
    expect((actions[0] as any).recipientUserIds).toEqual(["u1"]);
    expect((actions[0] as any).recipientScopeRegion).toBe(true);
    expect((actions[1] as any).recipientUserIds).toBeUndefined();
  });

  it("mirrors notify actions back to targets losslessly (sans per-action composition)", () => {
    const actions = targetsToNotifyActions(targets, comp);
    expect(actionsToTargets(actions)).toEqual(targets);
  });

  it("drops api_call/script actions from the legacy mirror", () => {
    const mixed = [
      ...targetsToNotifyActions([{ channelId: "c1" }], null),
      { type: "api_call" as const, method: "POST" as const, url: "https://example.com/hook", timeoutSec: 15 },
    ];
    expect(actionsToTargets(mixed)).toEqual([{ channelId: "c1" }]);
  });
});

describe("legacyMirrorOfV2", () => {
  it("projects reset back onto clearBehavior/clearAfterSec", () => {
    expect(legacyMirrorOfV2({ mode: "timed", afterSec: 900 }, [])).toEqual({
      clearBehavior: "timed", clearAfterSec: 900, targets: [],
    });
    expect(legacyMirrorOfV2({ mode: "auto", clearThreshold: 55, sustainSec: 60 }, [])).toEqual({
      clearBehavior: "auto", clearAfterSec: null, targets: [],
    });
  });
});

describe("normalizeRuleToV2 (stored rows)", () => {
  it("converts a pre-v2 row (clearBehavior + targets + emailComposition)", () => {
    const v2 = normalizeRuleToV2({
      clearBehavior: "auto",
      clearAfterSec: null,
      targets: [{ channelId: "ch1", addresses: ["a@example.com"] }],
      emailComposition: { subjectTemplate: "s" },
      escalation: null,
      reset: null,
      actions: null,
    });
    expect(v2.reset).toEqual({ mode: "auto" });
    // The audit Event rides along: a pre-v2 row wrote notification.triggered
    // before the Event became a removable action, and un-migrated rows must
    // keep doing so rather than silently stop auditing.
    expect(v2.actions).toEqual([
      { type: "notify", channelId: "ch1", addresses: ["a@example.com"], emailComposition: { subjectTemplate: "s" } },
      { type: "event" },
    ]);
    expect(v2.escalation).toBeNull();
  });

  it("prefers persisted v2 columns over the legacy mirror", () => {
    const v2 = normalizeRuleToV2({
      clearBehavior: "manual",
      targets: [{ channelId: "stale" }],
      reset: { mode: "auto", clearThreshold: 55, sustainSec: 120 },
      actions: [{ type: "api_call", method: "POST", url: "https://example.com/x", timeoutSec: 15 }],
    });
    expect(v2.reset).toEqual({ mode: "auto", clearThreshold: 55, sustainSec: 120, sustainPolls: null });
    expect(v2.actions).toEqual([{ type: "api_call", method: "POST", url: "https://example.com/x", timeoutSec: 15 }]);
  });

  it("drops malformed stored actions defensively instead of throwing", () => {
    const v2 = normalizeRuleToV2({
      reset: { mode: "manual" },
      actions: [{ type: "notify", channelId: "ok" }, { type: "bogus" }, 42],
    });
    expect(v2.actions).toEqual([{ type: "notify", channelId: "ok" }]);
  });
});

describe("normalizeEscalationToV2", () => {
  it("converts legacy email tiers to notify-action tiers, preserving overrides", () => {
    const v2 = normalizeEscalationToV2({
      stopOn: "clear",
      tiers: [
        {
          afterMin: 30,
          channelId: "ch-email",
          to: { recipientUserIds: ["u1"], addresses: ["mgr@example.com"] },
          cc: { addresses: ["cc@example.com"] },
          subjectTemplate: "ESC {asset}",
          repeatEveryMin: 60,
          maxRepeats: 3,
        },
        { afterMin: 120, channelId: "ch-email", to: { addresses: ["oncall@example.com"] } },
      ],
    });
    expect(v2).not.toBeNull();
    expect(v2!.stopOn).toBe("clear");
    expect(v2!.tiers).toHaveLength(2);
    const t1 = v2!.tiers[0]!;
    expect(t1.afterMin).toBe(30);
    expect(t1.repeatEveryMin).toBe(60);
    expect(t1.maxRepeats).toBe(3);
    expect(t1.actions).toEqual([
      {
        type: "notify",
        channelId: "ch-email",
        recipientUserIds: ["u1"],
        addresses: ["mgr@example.com"],
        emailComposition: {
          subjectTemplate: "ESC {asset}",
          bodyTextTemplate: null,
          bodyHtmlTemplate: null,
          cc: { addresses: ["cc@example.com"] },
          bcc: null,
        },
      },
    ]);
    // Tier 2 set no overrides → emailComposition null (executor falls back to
    // the rule-level composition, then the [ESCALATION n] default).
    expect((v2!.tiers[1]!.actions[0] as any).emailComposition).toBeNull();
  });

  it("passes v2 escalation through and rejects malformed shapes to null", () => {
    const v2 = {
      stopOn: "acknowledge",
      tiers: [{ afterMin: 10, actions: [{ type: "notify", channelId: "c" }] }],
    };
    expect(normalizeEscalationToV2(v2)).toEqual({
      stopOn: "acknowledge",
      tiers: [{ afterMin: 10, actions: [{ type: "notify", channelId: "c" }], repeatEveryMin: undefined, maxRepeats: undefined }],
    });
    expect(normalizeEscalationToV2(null)).toBeNull();
    expect(normalizeEscalationToV2({ tiers: [] })).toBeNull();
    expect(normalizeEscalationToV2({ tiers: [{ nonsense: true }] })).toBeNull();
  });
});

describe("ruleInputSchema (v2 input with legacy folding)", () => {
  it("folds a legacy POST body into the v2 canonical shape", () => {
    const parsed = ruleInputSchema.parse({
      name: "legacy body",
      trigger: metricTrigger,
      scope: { allAssets: true },
      clearBehavior: "timed",
      clearAfterSec: 1800,
      targets: [{ channelId: "ch1" }],
      emailComposition: { subjectTemplate: "s" },
    });
    expect(parsed.reset).toEqual({ mode: "timed", afterSec: 1800 });
    // Same reasoning as the stored-row case: a legacy body carried an implicit
    // audit Event, so folding it forward has to keep one.
    expect(parsed.actions).toEqual([
      { type: "notify", channelId: "ch1", emailComposition: { subjectTemplate: "s" } },
      { type: "event" },
    ]);
  });

  it("v2 fields win over conflicting legacy fields", () => {
    const parsed = ruleInputSchema.parse({
      name: "both",
      trigger: metricTrigger,
      scope: { allAssets: true },
      clearBehavior: "manual",
      reset: { mode: "auto", clearThreshold: 80, sustainSec: 60 },
      targets: [{ channelId: "stale" }],
      actions: [],
    });
    expect(parsed.reset).toEqual({ mode: "auto", clearThreshold: 80, sustainSec: 60, sustainPolls: null });
    expect(parsed.actions).toEqual([]);
  });

  it("rejects timed reset without afterSec", () => {
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: metricTrigger, scope: { allAssets: true }, reset: { mode: "timed" } }),
    ).toThrow(/afterSec/);
  });

  it("rejects a clear threshold on the wrong side of the fire threshold", () => {
    // op >= 90 ⇒ clearThreshold must be ≤ 90
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: metricTrigger, scope: { allAssets: true },
        reset: { mode: "auto", clearThreshold: 95 },
      }),
    ).toThrow(/at or below/);
    // op <= 10 ⇒ clearThreshold must be ≥ 10
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "asset_metric", metric: "cpuPct", operator: "<=", threshold: 10 },
        scope: { allAssets: true },
        reset: { mode: "auto", clearThreshold: 5 },
      }),
    ).toThrow(/at or above/);
    // equality operators can't carry hysteresis
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "asset_metric", metric: "cpuPct", operator: "==", threshold: 0 },
        scope: { allAssets: true },
        reset: { mode: "auto", clearThreshold: 1 },
      }),
    ).toThrow(/cannot be combined/);
    // non-numeric trigger can't carry hysteresis
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
        scope: { allAssets: true },
        reset: { mode: "auto", clearThreshold: 1 },
      }),
    ).toThrow(/numeric metric triggers/);
  });

  it("accepts a valid hysteresis + sustain reset", () => {
    const parsed = ruleInputSchema.parse({
      name: "temp",
      trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 60, dimensionFilter: { sensorClass: "temperature" } },
      scope: { allAssets: true },
      reset: { mode: "auto", clearThreshold: 55, sustainSec: 300 },
    });
    expect(parsed.reset).toEqual({ mode: "auto", clearThreshold: 55, sustainSec: 300, sustainPolls: null });
  });

  it("accepts api_call actions and rejects non-http(s) URLs", () => {
    const ok = ruleInputSchema.parse({
      name: "hook", trigger: metricTrigger, scope: { allAssets: true },
      actions: [{ type: "api_call", url: "https://example.com/hook", headers: { "X-Env": "prod" } }],
    });
    expect(ok.actions[0]).toMatchObject({ type: "api_call", method: "POST", timeoutSec: 15 });
    expect(() =>
      ruleInputSchema.parse({
        name: "bad", trigger: metricTrigger, scope: { allAssets: true },
        actions: [{ type: "api_call", url: "ftp://example.com/x" }],
      }),
    ).toThrow();
  });
});

describe("scopeSchema — manufacturer / model / subnet dimensions", () => {
  it("accepts the new dimensions", () => {
    const parsed = ruleInputSchema.parse({
      name: "scoped", trigger: metricTrigger,
      scope: { manufacturers: ["Fortinet"], models: ["FGT-60F"], subnetCidrs: ["10.20.0.0/16", "192.168.1.5"] },
    });
    expect(parsed.scope.manufacturers).toEqual(["Fortinet"]);
    expect(parsed.scope.subnetCidrs).toEqual(["10.20.0.0/16", "192.168.1.5"]);
  });

  it("rejects garbage subnet entries at save", () => {
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: metricTrigger, scope: { subnetCidrs: ["not-a-cidr"] } }),
    ).toThrow(/CIDR/);
  });
});

describe("scope condition tree", () => {
  const asset = {
    id: "a1", assetType: "switch", manufacturer: "Fortinet Inc.", model: "FortiSwitch 148F",
    hostname: "sw-floor2-01", os: "FortiSwitchOS", tags: ["region:Atlanta", "prod"],
    ipAddress: "10.20.30.40", status: "active",
  };

  it("evaluates AND / OR nesting like the reference builder", () => {
    // (type == switch) AND (mfr contains forti) AND (vendor==net-snmp OR host contains floor2)
    const cond = {
      op: "and" as const,
      children: [
        { field: "assetType", operator: "equals", value: "switch" },
        { field: "manufacturer", operator: "contains", value: "forti" },
        {
          op: "or" as const,
          children: [
            { field: "manufacturer", operator: "equals", value: "net-snmp" },
            { field: "hostname", operator: "contains", value: "floor2" },
          ],
        },
      ],
    };
    expect(evaluateScopeCondition(cond, asset)).toBe(true);
    expect(evaluateScopeCondition(cond, { ...asset, hostname: "sw-floor3-01" })).toBe(false); // OR group fails
    expect(evaluateScopeCondition(cond, { ...asset, assetType: "server" })).toBe(false); // AND leg fails
  });

  it("none / notAll combinators negate correctly", () => {
    const inner = [
      { field: "status", operator: "equals", value: "decommissioned" },
      { field: "tag", operator: "has", value: "lab" },
    ];
    expect(evaluateScopeCondition({ op: "none", children: inner }, asset)).toBe(true); // neither matches
    expect(evaluateScopeCondition({ op: "none", children: inner }, { ...asset, tags: ["lab"] })).toBe(false);
    expect(evaluateScopeCondition({ op: "notAll", children: inner }, asset)).toBe(true); // at least one fails
    expect(evaluateScopeCondition({ op: "notAll", children: inner }, { ...asset, status: "decommissioned", tags: ["lab"] })).toBe(false);
  });

  it("per-field operators: string ops, tag has/notHas, subnet in/notIn", () => {
    const ev = (field: string, operator: string, value: string, a = asset) =>
      evaluateScopeCondition({ op: "and", children: [{ field, operator, value }] }, a);
    expect(ev("hostname", "startsWith", "sw-")).toBe(true);
    expect(ev("hostname", "endsWith", "-01")).toBe(true);
    expect(ev("model", "notContains", "/u")).toBe(true);
    expect(ev("os", "equals", "fortiswitchos")).toBe(true); // case-insensitive
    expect(ev("tag", "has", "PROD")).toBe(true);
    expect(ev("tag", "notHas", "prod")).toBe(false);
    expect(ev("subnet", "inCidr", "10.20.0.0/16")).toBe(true);
    expect(ev("subnet", "notInCidr", "10.99.0.0/16")).toBe(true);
    expect(ev("subnet", "inCidr", "10.20.30.40")).toBe(true); // bare IP = host route
    expect(ev("assetId", "equals", "a1")).toBe(true);
    expect(ev("status", "notEquals", "active")).toBe(false);
  });

  it("scopeMatchesAsset routes condition trees (and ANDs with flat dims)", () => {
    const scope = { condition: { op: "or" as const, children: [{ field: "hostname", operator: "contains", value: "floor2" }] } };
    expect(scopeMatchesAsset(scope, asset as never)).toBe(true);
    expect(scopeMatchesAsset({ ...scope, assetTypes: ["server"] }, asset as never)).toBe(false); // flat dim ANDs in
  });

  it("ruleInputSchema accepts condition scopes and rejects bad operator/field/subnet combos", () => {
    const good = ruleInputSchema.parse({
      name: "cond", trigger: metricTrigger,
      scope: { condition: { op: "and", children: [{ field: "manufacturer", operator: "contains", value: "forti" }] } },
    });
    expect(good.scope.condition!.op).toBe("and");
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: metricTrigger, scope: { condition: { op: "and", children: [{ field: "tag", operator: "contains", value: "x" }] } } }),
    ).toThrow(/not valid for field/);
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: metricTrigger, scope: { condition: { op: "and", children: [{ field: "subnet", operator: "inCidr", value: "bogus" }] } } }),
    ).toThrow(/CIDR/);
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: metricTrigger, scope: { condition: { op: "nand", children: [] } } }),
    ).toThrow();
  });
});

describe("previewInputSchema (partial drafts)", () => {
  it("accepts a scope-only body with defaulted name and no trigger", () => {
    const parsed = previewInputSchema.parse({ scope: { assetTypes: ["server"] } });
    expect(parsed.trigger).toBeUndefined();
    expect(parsed.name).toBe("Draft automation");
    expect(parsed.scope).toEqual({ assetTypes: ["server"] });
  });

  it("still validates hysteresis ordering when a trigger is present", () => {
    expect(() =>
      previewInputSchema.parse({ trigger: metricTrigger, reset: { mode: "auto", clearThreshold: 95 } }),
    ).toThrow(/at or below/);
  });
});

describe("buildSchemaCatalog v2 additions", () => {
  it("exposes schemaVersion 2 + the wizard vocabulary", () => {
    const cat = buildSchemaCatalog();
    expect(cat.schemaVersion).toBe(2);
    expect(cat.resetModes).toEqual(["manual", "auto", "timed", "condition", "event"]);
    // event/change get "event" where the continuous triggers get "condition" —
    // the recovery they actually have, leading for the same reason.
    expect(cat.resetModesByTriggerType.event).toEqual(["event", "timed", "manual"]);
    expect(cat.resetModesByTriggerType.change).toEqual(["event", "timed", "manual"]);
    expect(cat.resetEventSuggestions["agent.disconnected"]).toBe("agent.connected");
    expect(cat.resetModesByTriggerType.composite).toEqual(["auto", "condition", "timed", "manual"]);
    // Every continuous trigger offers "condition", and it leads the non-auto
    // modes because that's the order the wizard renders the radios in.
    expect(cat.resetModesByTriggerType.asset_metric).toEqual(["auto", "condition", "timed", "manual"]);
    expect(cat.resetModesByTriggerType.asset_state).toEqual(["auto", "condition", "timed", "manual"]);
    expect(cat.resetModesByTriggerType.host_metric).toEqual(["auto", "condition", "timed", "manual"]);
    // Per-dimension alerting vocabulary the reset step's note is built from.
    expect(cat.stateFieldDimensions.ifOperStatus).toEqual(["ifNamePattern"]);
    expect(cat.stateFieldDimensions.monitorStatus).toBeUndefined();
    expect(cat.dimensionNouns.ifNamePattern).toBe("interface");
    expect(cat.actionTypes.map((a: { type: string }) => a.type)).toEqual(["notify", "api_call", "script", "event", "reboot"]);
    // Business rule 115(c): the reboot action is gated on the reboot grant.
    expect(cat.actionTypes.find((a: { type: string }) => a.type === "reboot")).toMatchObject({ permission: "assets" });
    expect(cat.rebootMeta).toMatchObject({ whenOptions: ["now", "at"], defaultAt: "02:00", defaultMinGapHours: 24 });
    expect(cat.inverseComparators[">="]).toBe("<");
    expect(cat.comparatorPhrases[">="]).toBe("is at or above");
    expect(cat.escalationMeta.maxTiers).toBe(5);
    expect(cat.compositeMeta.groupOps).toEqual(["and", "or"]);
    expect(cat.compositeMeta.maxDepth).toBe(3);
    expect(cat.compositeMeta.maxLeaves).toBe(10);
    expect(cat.triggerTypes.some((t: { type: string }) => t.type === "composite")).toBe(true);
  });
});

// ─── Composite triggers + condition-mode reset ──────────────────────────────

const cpuLeaf = { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 };
const tempLeaf = {
  type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 60,
  dimensionFilter: { sensorClass: "temperature" },
};
const statusLeaf = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };
const hostLeaf = { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 95 };
const compositeAnd = { type: "composite", kind: "asset", op: "and", children: [cpuLeaf, tempLeaf] };

describe("composite trigger schema", () => {
  it("accepts a 2-leaf AND tree and applies leaf defaults", () => {
    const parsed = ruleInputSchema.parse({ name: "combo", trigger: compositeAnd });
    expect(parsed.trigger.type).toBe("composite");
    const t = parsed.trigger as any;
    expect(t.forDurationSec).toBe(0);
    expect(t.children[0].aggregation).toBe("latest"); // leaf default applied
    expect(t.children[0].forDurationSec).toBeUndefined(); // leaves carry no per-leaf sustain
  });

  it("accepts nested groups and mixed metric/state leaves (kind=asset)", () => {
    const parsed = ruleInputSchema.parse({
      name: "combo",
      trigger: {
        type: "composite", kind: "asset", op: "or",
        children: [statusLeaf, { op: "and", children: [cpuLeaf, tempLeaf] }],
      },
    });
    expect((parsed.trigger as any).children).toHaveLength(2);
  });

  it("collapses a single-leaf composite to the legacy single trigger, hoisting forDurationSec", () => {
    const parsed = ruleInputSchema.parse({
      name: "solo",
      trigger: { type: "composite", kind: "asset", op: "and", children: [cpuLeaf], forDurationSec: 300 },
    });
    expect(parsed.trigger).toMatchObject({ type: "asset_metric", metric: "cpuPct", threshold: 90, forDurationSec: 300 });
  });

  it("collapses through single-child group wrappers", () => {
    const parsed = ruleInputSchema.parse({
      name: "wrapped",
      trigger: {
        type: "composite", kind: "asset", op: "and",
        children: [{ op: "or", children: [{ op: "and", children: [statusLeaf] }] }],
        forDurationSec: 60,
      },
    });
    expect(parsed.trigger).toMatchObject({ type: "asset_state", field: "monitorStatus", forDurationSec: 60 });
  });

  it("rejects none/notAll group ops, over-deep nesting, and too many leaves", () => {
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "composite", kind: "asset", op: "none", children: [cpuLeaf, tempLeaf] },
      }),
    ).toThrow();
    const depth4 = {
      type: "composite", kind: "asset", op: "and",
      children: [cpuLeaf, { op: "and", children: [tempLeaf, { op: "or", children: [statusLeaf, { op: "and", children: [cpuLeaf, tempLeaf] }] }] }],
    };
    expect(() => ruleInputSchema.parse({ name: "x", trigger: depth4 })).toThrow(/nest at most 3 deep/);
    const manyLeaves = {
      type: "composite", kind: "asset", op: "or",
      children: Array.from({ length: 11 }, () => cpuLeaf),
    };
    expect(() => ruleInputSchema.parse({ name: "x", trigger: manyLeaves })).toThrow();
  });

  it("enforces kind coherence (host kind = host_metric leaves only, asset kind = no host leaves)", () => {
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "composite", kind: "host", op: "and", children: [hostLeaf, cpuLeaf] },
      }),
    ).toThrow();
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "composite", kind: "asset", op: "and", children: [cpuLeaf, hostLeaf] },
      }),
    ).toThrow(/may not contain Polaris-host/);
    const hostOk = ruleInputSchema.parse({
      name: "x",
      trigger: { type: "composite", kind: "host", op: "and", children: [hostLeaf, { ...hostLeaf, threshold: 80, metric: "memUsedPct" }] },
    });
    expect(hostOk.trigger.type).toBe("composite");
  });

  it("rejects hysteresis clearThreshold on a composite trigger", () => {
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: compositeAnd, reset: { mode: "auto", clearThreshold: 80 } }),
    ).toThrow(/numeric metric triggers/);
  });
});

/**
 * event-mode reset — the counterpart Event that says the thing came back. The
 * mirror image of condition-mode: allowed on exactly the two trigger types a
 * condition reset is refused on.
 */
describe("event-mode reset", () => {
  const evTrigger = { type: "event", actionPattern: "agent.disconnected" };

  it("accepts a counterpart-event reset on an event trigger and strips mode-irrelevant fields", () => {
    const parsed = ruleInputSchema.parse({
      name: "x", trigger: evTrigger,
      reset: { mode: "event", resetEvent: { actionPattern: "agent.connected" }, afterSec: 999, sustainSec: 60 },
    });
    expect(parsed.reset).toEqual({ mode: "event", resetEvent: { actionPattern: "agent.connected", resourceType: null } });
  });

  it("accepts it on a change trigger too", () => {
    const parsed = ruleInputSchema.parse({
      name: "x", trigger: { type: "change", changeType: "firmware_changed" },
      reset: { mode: "event", resetEvent: { actionPattern: "asset.firmware.changed" } },
    });
    expect(parsed.reset.mode).toBe("event");
  });

  it("refuses it on a continuous trigger — that recovers on its own reading", () => {
    expect(() =>
      ruleInputSchema.parse({
        name: "x",
        trigger: { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 },
        reset: { mode: "event", resetEvent: { actionPattern: "agent.connected" } },
      }),
    ).toThrow(/only applies to event and change triggers/);
  });

  it("refuses an event reset with no pattern", () => {
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: evTrigger, reset: { mode: "event" } }),
    ).toThrow(/requires the action pattern/);
  });

  it("normalizeReset keeps a patternless event reset intact so validation can reject it", () => {
    expect(normalizeReset({ mode: "event" } as any)).toEqual({ mode: "event", resetEvent: null });
  });

  it("legacyMirrorOfV2 projects event mode to clearBehavior=auto with no timer", () => {
    const m = legacyMirrorOfV2({ mode: "event", resetEvent: { actionPattern: "agent.connected" } } as any, []);
    expect(m.clearBehavior).toBe("auto");
    expect(m.clearAfterSec).toBeNull();
  });

  it("survives the stored-row round trip through normalizeRuleToV2", () => {
    const v2 = normalizeRuleToV2({
      reset: { mode: "event", resetEvent: { actionPattern: "agent.connected", resourceType: "asset" } },
      actions: [],
    });
    expect(v2.reset).toEqual({ mode: "event", resetEvent: { actionPattern: "agent.connected", resourceType: "asset" } });
  });
});

describe("condition-mode reset", () => {
  const resetTree = { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 70 }] };

  it("accepts a condition reset on a composite trigger and normalizes it", () => {
    const parsed = ruleInputSchema.parse({
      name: "x", trigger: compositeAnd,
      reset: { mode: "condition", condition: resetTree, sustainSec: 120, afterSec: 999, clearThreshold: 5 },
    });
    // mode-irrelevant fields stripped; leaf defaults (aggregation/windowSec) applied
    expect(parsed.reset).toMatchObject({ mode: "condition", condition: resetTree, sustainSec: 120 });
    expect((parsed.reset as any).afterSec).toBeUndefined();
    expect((parsed.reset as any).clearThreshold).toBeUndefined();
  });

  it("normalizeReset keeps condition mode (does not fall through to manual)", () => {
    expect(normalizeReset({ mode: "condition", condition: resetTree } as any)).toEqual({
      mode: "condition", condition: resetTree, sustainSec: null, sustainPolls: null,
    });
  });

  it("survives the stored-row round trip through normalizeRuleToV2", () => {
    const v2 = normalizeRuleToV2({
      reset: { mode: "condition", condition: resetTree, sustainSec: 60 },
      actions: [],
    });
    expect(v2.reset).toMatchObject({ mode: "condition", condition: resetTree, sustainSec: 60 });
  });

  it("legacyMirrorOfV2 projects condition mode to clearBehavior=auto", () => {
    expect(legacyMirrorOfV2({ mode: "condition", condition: resetTree } as any, []).clearBehavior).toBe("auto");
  });

  it("rejects condition reset without a tree", () => {
    expect(() =>
      ruleInputSchema.parse({ name: "x", trigger: compositeAnd, reset: { mode: "condition" } }),
    ).toThrow(/requires a condition tree/);
  });

  // The composite-only restriction was lifted 2026-08: a custom reset tree is
  // just a more expressive spelling of "the trigger is no longer true", and the
  // wizard seeds it with the trigger inverted on every continuous trigger.
  it("accepts a condition reset on a single metric trigger", () => {
    const parsed = ruleInputSchema.parse({
      name: "x", trigger: metricTrigger,
      reset: { mode: "condition", condition: resetTree, sustainSec: 300 },
    });
    expect(parsed.reset).toMatchObject({ mode: "condition", condition: resetTree, sustainSec: 300 });
  });

  it("accepts a condition reset on a single asset_state trigger", () => {
    const parsed = ruleInputSchema.parse({
      name: "x",
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
      reset: { mode: "condition", condition: resetTree },
    });
    expect(parsed.reset.mode).toBe("condition");
  });

  it("still refuses one on event/change — an instant has no condition to recover", () => {
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: { type: "event", actionPattern: "integration.*" },
        reset: { mode: "condition", condition: resetTree },
      }),
    ).toThrow(/continuous condition/);
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: { type: "change", changeType: "sdwan_failover" },
        reset: { mode: "condition", condition: resetTree },
      }),
    ).toThrow(/continuous condition/);
  });

  it("enforces kind coherence on a SINGLE trigger too (host trigger, device leaf)", () => {
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90 },
        reset: { mode: "condition", condition: resetTree },
      }),
    ).toThrow(/match the trigger's kind/);
    // …and the mirror: a device trigger can't recover on a Polaris-host reading.
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: metricTrigger,
        reset: { mode: "condition", condition: { op: "and", children: [hostLeaf] } },
      }),
    ).toThrow(/match the trigger's kind/);
  });

  it("rejects a reset tree whose leaves mismatch the trigger kind", () => {
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: compositeAnd,
        reset: { mode: "condition", condition: { op: "and", children: [hostLeaf] } },
      }),
    ).toThrow(/match the trigger's kind/);
  });
});

// ─── Per-action escalation + device-region recipient flag + chain helpers ───

describe("escalatable actions (per-action escalation)", () => {
  const chain = { stopOn: "acknowledge", tiers: [{ afterMin: 15, actions: [{ type: "notify", channelId: "c2" }] }] };

  it("accepts an escalation chain on top-level and band actions", () => {
    const parsed = ruleInputSchema.parse({
      name: "x", trigger: metricTrigger,
      actions: [{ type: "notify", channelId: "c1", escalation: chain }],
      severityBands: [{ threshold: 95, severity: "critical", actions: [{ type: "api_call", url: "https://x.example.com/hook", escalation: chain }] }],
    });
    expect((parsed.actions[0] as { escalation?: unknown }).escalation).toBeTruthy();
    expect((parsed.severityBands?.[0]?.actions[0] as { escalation?: unknown }).escalation).toBeTruthy();
  });

  it("rejects nested chains: actions INSIDE escalation tiers cannot escalate", () => {
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: metricTrigger,
        actions: [{
          type: "notify", channelId: "c1",
          escalation: { tiers: [{ afterMin: 15, actions: [{ type: "notify", channelId: "c2", escalation: chain }] }] },
        }],
      }),
    ).toThrow();
    // resolvedActions are bare too.
    expect(() =>
      ruleInputSchema.parse({
        name: "x", trigger: metricTrigger,
        severityBands: [{ threshold: 95, severity: "critical" }],
        bandNotify: { resolvedActions: [{ type: "notify", channelId: "c1", escalation: chain }] },
      }),
    ).toThrow();
  });

  it("normalizeRuleToV2 preserves stored per-action escalation (strict-schema drop regression)", () => {
    const v2 = normalizeRuleToV2({
      reset: { mode: "manual" },
      actions: [{ type: "notify", channelId: "c1", escalation: chain }],
    });
    expect(v2.actions).toHaveLength(1);
    expect((v2.actions[0] as { escalation?: unknown }).escalation).toBeTruthy();
  });

  it("legacy mirror drops per-action escalation but keeps the recipient flags", () => {
    const targets = actionsToTargets([
      { type: "notify", channelId: "c1", recipientDeviceRegion: true, escalation: chain } as never,
    ]);
    expect(targets).toEqual([{ channelId: "c1", recipientDeviceRegion: true }]);
  });
});

describe("recipientDeviceRegion round-trip", () => {
  it("survives targets → actions → targets (both converters)", () => {
    const actions = targetsToNotifyActions([{ channelId: "c1", recipientDeviceRegion: true }], null);
    expect((actions[0] as { recipientDeviceRegion?: boolean }).recipientDeviceRegion).toBe(true);
    expect(actionsToTargets(actions)[0]).toMatchObject({ channelId: "c1", recipientDeviceRegion: true });
  });

  it("is accepted by ruleInputSchema on notify actions", () => {
    const parsed = ruleInputSchema.parse({
      name: "x", trigger: metricTrigger,
      actions: [{ type: "notify", channelId: "c1", recipientDeviceRegion: true }],
    });
    expect((parsed.actions[0] as { recipientDeviceRegion?: boolean }).recipientDeviceRegion).toBe(true);
  });
});

describe("allRuleActionRefs / ruleHasAnyEscalation / escalationChainsForSeverity", () => {
  const chainTo = (channelId: string) => ({ stopOn: "acknowledge" as const, tiers: [{ afterMin: 10, actions: [{ type: "notify" as const, channelId }] }] });
  const rule = {
    severity: "warning",
    actions: [
      { type: "notify" as const, channelId: "base-1", escalation: chainTo("base-1-esc") },
      { type: "api_call" as const, method: "POST" as const, url: "https://x.example.com", timeoutSec: 15 },
    ],
    escalation: chainTo("rule-esc"),
    severityBands: [
      { threshold: 95, severity: "critical", actions: [{ type: "notify" as const, channelId: "band-1", escalation: chainTo("band-1-esc") }], escalation: chainTo("band-esc") },
      { threshold: 90, severity: "serious", actions: [] },
    ],
    bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "reuse" as const, resolvedActions: [{ type: "notify" as const, channelId: "resolved-1" }] },
    resetActions: [{ type: "notify" as const, channelId: "reset-1" }],
  };

  it("allRuleActionRefs walks all EIGHT action locations", () => {
    const ids = allRuleActionRefs(rule as never).map((r) =>
      r.action.type === "notify" ? r.action.channelId : r.action.type,
    );
    expect(ids).toEqual(expect.arrayContaining([
      "base-1", "base-1-esc", "api_call", "rule-esc", "band-1", "band-1-esc", "band-esc", "resolved-1",
      // resetActions is the eighth location. Missing it here would let a
      // script action on a recovery slip past the automationScripts gate, and
      // hide an {asset.*} template from ruleWantsAssetDetail.
      "reset-1",
    ]));
    expect(ids).toHaveLength(9);
  });

  it("ruleHasAnyEscalation sees chains at every level (and none when absent)", () => {
    expect(ruleHasAnyEscalation(rule as never)).toBe(true);
    expect(ruleHasAnyEscalation({ actions: [{ type: "notify", channelId: "c" }] } as never)).toBe(false);
    expect(ruleHasAnyEscalation({ actions: [{ type: "notify", channelId: "c", escalation: chainTo("x") }] } as never)).toBe(true);
    expect(ruleHasAnyEscalation({ severityBands: [{ threshold: 1, severity: "critical", actions: [], escalation: chainTo("x") }] } as never)).toBe(true);
  });

  it("escalationChainsForSeverity: base severity = rule chain + per-action chains", () => {
    const chains = escalationChainsForSeverity(rule as never, "warning");
    expect(chains.map((c) => c.key)).toEqual(["", "a0"]);
    expect(chains[0]!.escalation.tiers[0]!.actions[0]).toMatchObject({ channelId: "rule-esc" });
    expect(chains[1]!.escalation.tiers[0]!.actions[0]).toMatchObject({ channelId: "base-1-esc" });
  });

  it("band severity uses the band's chains; empty band falls back to base actions + rule chain", () => {
    const critical = escalationChainsForSeverity(rule as never, "critical");
    expect(critical.map((c) => c.key)).toEqual(["", "a0"]);
    expect(critical[0]!.escalation.tiers[0]!.actions[0]).toMatchObject({ channelId: "band-esc" });
    expect(critical[1]!.escalation.tiers[0]!.actions[0]).toMatchObject({ channelId: "band-1-esc" });
    // The "serious" band has no actions and no chain → base actions' chains + rule chain.
    const serious = escalationChainsForSeverity(rule as never, "serious");
    expect(serious.map((c) => c.key)).toEqual(["", "a0"]);
    expect(serious[0]!.escalation.tiers[0]!.actions[0]).toMatchObject({ channelId: "rule-esc" });
    expect(serious[1]!.escalation.tiers[0]!.actions[0]).toMatchObject({ channelId: "base-1-esc" });
  });

  it("escalationTierStateKey keeps bare numeric keys for the level chain", () => {
    expect(escalationTierStateKey("", 0)).toBe("0");
    expect(escalationTierStateKey("", 2)).toBe("2");
    expect(escalationTierStateKey("a1", 0)).toBe("a1:t0");
  });

  it("catalog advertises per-action escalation + band meta", () => {
    const cat = buildSchemaCatalog();
    expect(cat.escalationMeta.perAction).toBe(true);
    expect(cat.bandMeta.maxBands).toBe(4);
  });
});

// ─── Audit Event as a removable action ──────────────────────────────────────
//
// The `notification.triggered` Event became an action so a noisy automation can
// drop it. The risk that buys is SILENT AUDIT LOSS: anything that reaches the
// engine without an event action stops auditing, and those Events feed the
// Events tab, the baseline event-trigger automations and the syslog/SFTP
// archivers. These pin the three ways a rule can arrive without one.
describe("audit-Event action", () => {
  const METRIC = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 } as const;
  const EVENT_TRIGGER = { type: "event", actionPattern: "discovery.*" } as const;

  it("adds it to a body that omits actions entirely", () => {
    const parsed = ruleInputSchema.parse({ name: "r", trigger: METRIC });
    expect(parsed.actions).toEqual([{ type: "event" }]);
  });

  it("respects an EXPLICIT empty action list as the opt-out", () => {
    const parsed = ruleInputSchema.parse({ name: "r", trigger: METRIC, actions: [] });
    expect(parsed.actions).toEqual([]);
  });

  it("leaves an explicit action list alone", () => {
    const parsed = ruleInputSchema.parse({
      name: "r", trigger: METRIC,
      actions: [{ type: "api_call", method: "POST", url: "https://example.com/x" }],
    });
    expect(parsed.actions.map((a) => a.type)).toEqual(["api_call"]);
  });

  it("does NOT add it to an event-triggered rule", () => {
    // The engine's event tail writes no Events by design — an automation
    // driven BY Events emitting one would feed itself.
    const parsed = ruleInputSchema.parse({ name: "r", trigger: EVENT_TRIGGER });
    expect(parsed.actions).toEqual([]);
  });

  it("adds it when folding a pre-v2 stored row forward", () => {
    const v2 = normalizeRuleToV2({ trigger: METRIC, clearBehavior: "manual", targets: [], actions: null });
    expect(v2.actions).toEqual([{ type: "event" }]);
  });

  it("does NOT add it to a pre-v2 event-triggered stored row", () => {
    const v2 = normalizeRuleToV2({ trigger: EVENT_TRIGGER, clearBehavior: "manual", targets: [], actions: null });
    expect(v2.actions).toEqual([]);
  });

  it("never second-guesses a stored v2 row that dropped it", () => {
    // Removing the action is the whole point — re-adding it on read would make
    // it unremovable.
    const v2 = normalizeRuleToV2({ trigger: METRIC, clearBehavior: "manual", actions: [] });
    expect(v2.actions).toEqual([]);
  });

  it("rejects an escalation chain on an event action", () => {
    // Nothing to chase if an instantaneous Event goes "unhandled", and the
    // strict schema is what keeps the builder and the model in step.
    const bad = ruleInputSchema.safeParse({
      name: "r", trigger: METRIC,
      actions: [{ type: "event", escalation: { stopOn: "clear", tiers: [{ afterMin: 5, actions: [] }] } }],
    });
    expect(bad.success).toBe(false);
  });
});
