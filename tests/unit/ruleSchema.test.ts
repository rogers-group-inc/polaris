/**
 * tests/unit/ruleSchema.test.ts — the automation input schema and read-path
 * normalizer (src/services/notificationTypes/ruleSchema.ts).
 *
 * Complements (does not repeat):
 *  - notificationRuleShapeV2.test.ts — normalizeReset legacy folding, the
 *    targets <-> actions round trip, legacyMirrorOfV2, normalizeRuleToV2 over
 *    pre-v2 rows, hysteresis ordering, event / condition reset modes;
 *  - alertGrouping.test.ts — the groupByAsset refusals;
 *  - downDetectionTriggerSchema.test.ts — missedPolls / alertWhenDependencyDown
 *    on bare triggers; priorityTags.test.ts — severityFromPriorityTag;
 *  - sdwanMemberIpFilter.test.ts / interfaceTagFilter.test.ts — the member-IP
 *    and interface-tag refusals; pathMonitorTrigger.test.ts — includeServer.
 * New here: the severity-band validators (non-numeric trigger, 0/1 metric,
 * equality operator, non-increasing severities, per-band equality operator),
 * the repeat-needs-a-notify rule incl. band actions, missedPolls / dependency
 * flag inside a composite, the tag-condition refusal, the condition-reset caps
 * and kind coherence, rule 146's event-action stripping, the legacy
 * repeat.quiet -> quietTime promotion (rule 92), the quiet-blob retry on the
 * read path, multi-channel expansion into targets, parseSeverityBands and
 * priorityTagSubjectOf. Pure — no database.
 */

import { describe, it, expect } from "vitest";
import {
  ruleInputSchema,
  previewInputSchema,
  normalizeReset,
  actionsToTargets,
  targetsToNotifyActions,
  legacyMirrorOfV2,
  priorityTagSubjectOf,
  normalizeRuleToV2,
  parseSeverityBands,
  REPEATABLE_ACTION_TYPES,
} from "../../src/services/notificationTypes/ruleSchema.js";
import type { AutomationAction } from "../../src/services/notificationTypes/actions.js";

const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", startTime: "22:00", endTime: "06:00" };
const cpu = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 };
const notify = { type: "notify", channelId: "c1" };
const body = (over: Record<string, unknown> = {}) => ({ name: "r", scope: { allAssets: true }, trigger: cpu, ...over });

function issues(input: unknown, schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } } = ruleInputSchema) {
  const r = schema.safeParse(input);
  return r.success ? [] : r.error!.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}
const messages = (input: unknown) => issues(input).map((i) => i.message).join(" | ");

describe("severity bands", () => {
  it("accepts strictly increasing severities on an ordered numeric trigger", () => {
    expect(issues(body({ severity: "warning", severityBands: [{ threshold: 95, severity: "serious" }, { threshold: 99, severity: "critical" }] }))).toEqual([]);
  });

  it("refuses bands on a non-numeric trigger", () => {
    const t = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };
    expect(messages(body({ trigger: t, severityBands: [{ threshold: 1, severity: "critical" }] }))).toContain("only to numeric metric triggers");
  });

  it("refuses bands on a 0/1 state metric with the metric-specific message", () => {
    const t = { type: "asset_metric", metric: "hwSensorAlarm", operator: ">=", threshold: 1 };
    expect(messages(body({ trigger: t, severityBands: [{ threshold: 1, severity: "critical" }] }))).toContain("0/1 state metric");
  });

  it("refuses bands under an equality operator, on the trigger or on a tier", () => {
    expect(messages(body({ trigger: { ...cpu, operator: "==" }, severityBands: [{ threshold: 1, severity: "critical" }] }))).toContain("ordered operator");
    const r = issues(body({ severityBands: [{ threshold: 1, severity: "critical", operator: "!=" }] }));
    expect(r.map((i) => i.path)).toContain("severityBands.0.operator");
  });

  it("refuses a band that is not more severe than the one before it", () => {
    const r = issues(body({ severity: "serious", severityBands: [{ threshold: 95, severity: "warning" }, { threshold: 99, severity: "critical" }] }));
    expect(r.map((i) => i.path)).toEqual(["severityBands.0.severity"]);
    const dup = issues(body({ severity: "warning", severityBands: [{ threshold: 95, severity: "critical" }, { threshold: 99, severity: "critical" }] }));
    expect(dup.map((i) => i.path)).toEqual(["severityBands.1.severity"]);
  });

  it("an empty band list is normalized to null", () => {
    const r = ruleInputSchema.parse(body({ severityBands: [] }));
    expect(r.severityBands).toBeNull();
  });
});

describe("repeat needs a Notify action", () => {
  const repeat = { everyMin: 15 };

  it("refuses a rule-level repeat with no notify anywhere", () => {
    expect(messages(body({ repeat, actions: [] }))).toContain("needs at least one Notify action");
    expect(messages(body({ repeat, actions: [{ type: "api_call", url: "https://example.com/hook", method: "POST" }] }))).toContain("Notify action");
  });

  it("a notify on a severity band counts", () => {
    expect(issues(body({ repeat, actions: [], severityBands: [{ threshold: 99, severity: "critical", actions: [notify] }] }))).toEqual([]);
  });

  it("only notify is repeatable", () => {
    expect([...REPEATABLE_ACTION_TYPES]).toEqual(["notify"]);
  });
});

describe("down-detection keys inside a composite", () => {
  const down = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };
  const composite = (leafExtra: Record<string, unknown>) => ({
    type: "composite", kind: "asset", op: "and",
    children: [{ ...down, ...leafExtra }, { type: "asset_state", field: "quarantined", operator: "==", value: true }],
  });

  it("refuses a missed-poll count on a leaf of a multi-condition trigger", () => {
    expect(messages(body({ trigger: composite({ missedPolls: 3 }) }))).toContain("missed-poll count cannot sit inside");
  });

  it("refuses the dependency-down flag on a leaf of a multi-condition trigger", () => {
    expect(messages(body({ trigger: composite({ alertWhenDependencyDown: true }) }))).toContain("dependency-down cannot sit inside");
  });

  it("a single-leaf composite has collapsed before the check, so the count is accepted", () => {
    const t = { type: "composite", kind: "asset", op: "and", children: [{ ...down, missedPolls: 4 }] };
    const r = ruleInputSchema.safeParse(body({ trigger: t }));
    expect(r.success).toBe(true);
    expect(r.success && r.data.trigger).toMatchObject({ type: "asset_state", field: "monitorStatus", missedPolls: 4 });
  });
});

describe("tag condition", () => {
  const tag = (value: unknown, operator = "==") => ({ type: "asset_state", field: "tag", operator, value });

  it("needs a non-blank string compared with is / is not", () => {
    expect(issues(body({ trigger: tag("prod") }))).toEqual([]);
    expect(issues(body({ trigger: tag("prod", "!=") }))).toEqual([]);
    expect(issues(body({ trigger: tag("   ") })).map((i) => i.path)).toContain("trigger.value");
    expect(issues(body({ trigger: tag(5) })).map((i) => i.path)).toContain("trigger.value");
    expect(issues(body({ trigger: tag("prod", ">=") })).map((i) => i.path)).toContain("trigger.value");
  });

  it("is checked on composite leaves too", () => {
    const t = { type: "composite", kind: "asset", op: "and", children: [tag(""), cpu] };
    // The leaf's value is z.string().max(200), so a blank tag passes the schema;
    // the refusal comes from the tag-condition check, on the children path.
    expect(issues(body({ trigger: t })).map((i) => i.path)).toContain("trigger.children");
  });
});

describe("condition reset tree", () => {
  const leaf = { type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 50 };

  it("caps depth at 3 and leaves at 10", () => {
    const deep = { op: "and", children: [{ op: "or", children: [{ op: "and", children: [{ op: "or", children: [leaf] }] }] }] };
    expect(messages(body({ reset: { mode: "condition", condition: deep } }))).toContain("nest at most 3 deep");
    const wide = { op: "and", children: [{ op: "or", children: Array(10).fill(leaf) }, leaf] };
    expect(messages(body({ reset: { mode: "condition", condition: wide } }))).toContain("at most 10 conditions per reset tree");
  });

  it("refuses host leaves in a device trigger's reset, and device leaves in a host trigger's", () => {
    const hostLeaf = { type: "host_metric", metric: "loadAvg1", operator: "<", threshold: 1 };
    expect(messages(body({ reset: { mode: "condition", condition: { op: "and", children: [hostLeaf] } } }))).toContain("match the trigger's kind");
    const hostTrigger = { type: "host_metric", metric: "cpuPct", operator: ">", threshold: 90 };
    expect(messages(body({ trigger: hostTrigger, reset: { mode: "condition", condition: { op: "and", children: [leaf] } } }))).toContain("match the trigger's kind");
    expect(issues(body({ trigger: hostTrigger, reset: { mode: "condition", condition: { op: "and", children: [hostLeaf] } } }))).toEqual([]);
  });

  it("refuses a condition reset on an instantaneous trigger", () => {
    const ev = { type: "event", actionPattern: "integration.*" };
    expect(messages(body({ trigger: ev, reset: { mode: "condition", condition: { op: "and", children: [leaf] } } }))).toContain("continuous condition");
  });

  it("refuses a condition reset beside includeServer", () => {
    const path = { type: "asset_metric", metric: "pathFailurePct", operator: ">", threshold: 50, includeServer: true };
    expect(messages(body({ trigger: path, reset: { mode: "condition", condition: { op: "and", children: [{ ...leaf, metric: "pathFailurePct" }] } } }))).toContain("can't watch the Polaris server");
  });
});

describe("clear threshold on non-numeric triggers", () => {
  it("refuses hysteresis on a state trigger", () => {
    const t = { type: "asset_state", field: "consecutiveFailures", operator: ">=", value: 3 };
    expect(messages(body({ trigger: t, reset: { mode: "auto", clearThreshold: 1 } }))).toContain("only applies to numeric metric triggers");
  });

  it("refuses it with an equality operator", () => {
    expect(messages(body({ trigger: { ...cpu, operator: "==" }, reset: { mode: "auto", clearThreshold: 1 } }))).toContain("cannot be combined with the == operator");
  });
});

describe("rule 146: the retired event action", () => {
  it("is dropped from actions, band actions and reset actions; an empty reset list becomes null", () => {
    const r = ruleInputSchema.parse(body({
      actions: [{ type: "event" }, notify],
      severityBands: [{ threshold: 99, severity: "critical", actions: [{ type: "event" }] }],
      resetActions: [{ type: "event" }],
    }));
    expect(r.actions).toEqual([notify]);
    expect(r.severityBands?.[0]?.actions).toEqual([]);
    expect(r.resetActions).toBeNull();
  });

  it("an explicit empty actions list is respected, and a legacy body folds targets forward", () => {
    expect(ruleInputSchema.parse(body({ actions: [] })).actions).toEqual([]);
    const legacy = ruleInputSchema.parse(body({ targets: [{ channelId: "c9" }] }));
    expect(legacy.actions).toEqual([{ type: "notify", channelId: "c9", emailComposition: null }]);
  });
});

describe("rule 92: legacy repeat.quiet promotion", () => {
  it("promotes deduplicated windows from the rule, its actions and its bands into followUps quiet time", () => {
    const quiet = { windows: [NIGHTLY] };
    const r = ruleInputSchema.parse(body({
      repeat: { everyMin: 15, quiet },
      actions: [{ ...notify, repeat: { everyMin: 30, quiet } }],
      severityBands: [{ threshold: 99, severity: "critical", actions: [{ ...notify, repeat: { everyMin: 5, quiet: { windows: [{ ...NIGHTLY, startTime: "23:00" }] } } }] }],
    }));
    expect(r.quietTime).toMatchObject({ holds: "followUps" });
    expect((r.quietTime as { windows: unknown[] }).windows).toHaveLength(2);
  });

  it("an explicit quietTime wins over the legacy windows; none at all stays null", () => {
    const r = ruleInputSchema.parse(body({ actions: [notify], quietTime: { ignoreGlobal: true }, repeat: { everyMin: 15, quiet: { windows: [NIGHTLY] } } }));
    expect(r.quietTime).toEqual({ ignoreGlobal: true });
    expect(ruleInputSchema.parse(body()).quietTime).toBeNull();
  });

  it("refuses an alert-kind filter and unknown severities in an automation's own quiet time", () => {
    expect(issues(body({ quietTime: { windows: [NIGHTLY], alertKinds: ["automation"] } })).length).toBeGreaterThan(0);
    expect(issues(body({ quietTime: { windows: [NIGHTLY], severities: ["fatal"] } })).length).toBeGreaterThan(0);
  });
});

describe("previewInputSchema", () => {
  it("defaults the name, keeps the edit id and carve-out trigger, and collapses the trigger", () => {
    const r = previewInputSchema.parse({ scope: { allAssets: true }, id: "rule-1", carveOutTrigger: cpu });
    expect(r.name).toBe("Draft automation");
    expect(r.id).toBe("rule-1");
    expect(r.trigger).toBeUndefined();
    expect(r.carveOutTrigger).toMatchObject({ type: "asset_metric", metric: "cpuPct" });
  });
});

describe("pure helpers", () => {
  it("normalizeReset: an unknown stored mode is manual; legacy auto carries no hysteresis keys", () => {
    expect(normalizeReset({ mode: "bogus" } as never)).toEqual({ mode: "manual" });
    expect(normalizeReset(null, "auto")).toEqual({ mode: "auto" });
    expect(normalizeReset(undefined, "something-else", 60)).toEqual({ mode: "manual" });
    expect(normalizeReset({ mode: "event", resetEvent: { actionPattern: "agent.up" } } as never)).toEqual({ mode: "event", resetEvent: { actionPattern: "agent.up", resourceType: null } });
  });

  it("actionsToTargets expands a multi-channel action to one target per distinct channel", () => {
    const targets = actionsToTargets([{ type: "notify", channelId: "a", channelIds: ["a", "b", "a"], addresses: ["x@example.com"] } as AutomationAction]);
    expect(targets).toEqual([{ channelId: "a", addresses: ["x@example.com"] }, { channelId: "b", addresses: ["x@example.com"] }]);
  });

  it("the device-region levels survive both directions (the field that once routed to nobody)", () => {
    const actions = targetsToNotifyActions([{ channelId: "a", recipientDeviceRegionLevels: [1, 2] } as never], null);
    expect(actions[0]).toMatchObject({ recipientDeviceRegionLevels: [1, 2] });
    expect(actionsToTargets(actions)[0]).toMatchObject({ recipientDeviceRegionLevels: [1, 2] });
  });

  it("legacyMirrorOfV2: manual / auto keep their mode with no timer", () => {
    expect(legacyMirrorOfV2({ mode: "manual" }, [])).toEqual({ clearBehavior: "manual", clearAfterSec: null, targets: [] });
    expect(legacyMirrorOfV2({ mode: "auto", sustainSec: 60 } as never, []).clearAfterSec).toBeNull();
  });

  it("priorityTagSubjectOf: device for monitor-down, interface for oper-down, else null", () => {
    expect(priorityTagSubjectOf({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down" })).toBe("device");
    expect(priorityTagSubjectOf({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" })).toBe("interface");
    expect(priorityTagSubjectOf({ type: "asset_state", field: "monitorStatus", operator: "!=", value: "down" })).toBeNull();
    expect(priorityTagSubjectOf({ type: "asset_state", field: "monitorStatus", operator: "==", value: "Down" })).toBeNull();
    expect(priorityTagSubjectOf({ type: "composite" })).toBeNull();
    expect(priorityTagSubjectOf(null)).toBeNull();
  });

  it("parseSeverityBands keeps valid bands, drops outgrown ones, null when none survive", () => {
    expect(parseSeverityBands([{ threshold: 1, severity: "critical" }, { threshold: "x", severity: "critical" }])).toEqual([{ threshold: 1, severity: "critical", actions: [] }]);
    expect(parseSeverityBands([{ bogus: true }])).toBeNull();
    expect(parseSeverityBands("nope")).toBeNull();
  });
});

describe("normalizeRuleToV2 read path", () => {
  it("a malformed quiet blob is dropped but the repeat survives", () => {
    const v = normalizeRuleToV2({ repeat: { everyMin: 15, stopOn: "clear", quiet: { windows: [{ nonsense: true }] } } });
    expect(v.repeat).toEqual({ everyMin: 15, stopOn: "clear" });
  });

  it("a repeat broken elsewhere still reads as never repeats", () => {
    expect(normalizeRuleToV2({ repeat: { everyMin: 1 } }).repeat).toBeNull();
    expect(normalizeRuleToV2({ repeat: { everyMin: 1, quiet: { windows: [] } } }).repeat).toBeNull();
  });

  it("drops malformed reset actions and bandNotify; empty reset list is null", () => {
    const v = normalizeRuleToV2({ resetActions: [{ type: "bogus" }, notify], bandNotify: { resolvedMode: "nope" } });
    expect(v.resetActions).toEqual([notify]);
    expect(v.bandNotify).toBeNull();
    expect(normalizeRuleToV2({ resetActions: [{ type: "bogus" }] }).resetActions).toBeNull();
  });

  it("an unparseable stored reset falls back to the legacy columns", () => {
    expect(normalizeRuleToV2({ reset: { mode: "nope" }, clearBehavior: "timed", clearAfterSec: 600 }).reset).toEqual({ mode: "timed", afterSec: 600 });
  });

  it("an invalid stored emailComposition is not copied onto folded legacy targets", () => {
    const v = normalizeRuleToV2({ targets: [{ channelId: "c1" }], emailComposition: { subjectTemplate: 42 } });
    expect(v.actions).toEqual([{ type: "notify", channelId: "c1", emailComposition: null }]);
  });
});
