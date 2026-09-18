/**
 * tests/unit/alertGrouping.test.ts
 *
 * The pure fold layer behind grouped alerts (business rule 74): one alert may
 * name many parts of one device, and it ends only when the last of them does.
 *
 * Everything here decides; nothing here touches the database. The engine owns
 * the I/O — whether a contribution is still firing is asked of the
 * NotificationRuleState rows, never of the `members` snapshot these functions
 * fold — so the DB-bound half (does a MIDDLE contribution recovering leave the
 * alert up? does a join re-open an acknowledgement?) is
 * tests/integration/alertGrouping.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  ruleInputSchema,
  buildSchemaCatalog,
  type AlertMember,
  MAX_GROUP_MEMBERS,
  GROUP_LABEL_CAP,
  groupKeyOf,
  triggerIsPerDimension,
  ruleGroupsByAsset,
  activeMembers,
  mergeMembers,
  markMemberLeft,
  groupSeverity,
  primaryMember,
  renderMemberList,
  naturalCompare,
  triggerCanJoinGroup,
  alertScopeOf,
  alertOwnerOf,
} from "../../src/services/notificationTypes.js";

const RULE = "11111111-1111-4111-8111-111111111111";
const RULE_B = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-09-18T10:00:00.000Z");
const T1 = new Date("2026-09-18T10:05:00.000Z");
const T2 = new Date("2026-09-18T10:10:00.000Z");

/** A live contribution, the way the engine hands one to mergeMembers. */
function member(key: string, over: Partial<AlertMember> = {}): AlertMember {
  return {
    key,
    label: over.label ?? key,
    ruleId: over.ruleId ?? RULE,
    ruleName: over.ruleName ?? "PoE fault",
    severity: over.severity ?? "warning",
    joinedAt: over.joinedAt ?? "",
    ...over,
  };
}

describe("groupKeyOf", () => {
  it("scopes the key so a rule fold and a group fold can never collide", () => {
    expect(groupKeyOf("rule", "r1", "a1")).toBe("rule:r1|a1");
    expect(groupKeyOf("grp", "r1", "a1")).toBe("grp:r1|a1");
    expect(groupKeyOf("rule", "r1", "a1")).not.toBe(groupKeyOf("grp", "r1", "a1"));
  });
});

describe("triggerIsPerDimension", () => {
  it("is true for the fields and metrics reported per component", () => {
    for (const field of ["poeStatus", "ifOperStatus", "ifAdminStatus", "ifIpAddress", "ipsecStatus", "sdwanMemberState"]) {
      expect(triggerIsPerDimension({ type: "asset_state", field, operator: "==", value: "x" } as never), field).toBe(true);
    }
    for (const metric of ["hwSensorValue", "storageUsedPct", "ifInBps", "ipsecThroughputBps"]) {
      expect(triggerIsPerDimension({ type: "asset_metric", metric, operator: ">=", threshold: 1 } as never), metric).toBe(true);
    }
  });

  it("is false for anything already reported once per device", () => {
    expect(triggerIsPerDimension({ type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 } as never)).toBe(false);
    expect(triggerIsPerDimension({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } as never)).toBe(false);
    expect(triggerIsPerDimension({ type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90 } as never)).toBe(false);
    expect(triggerIsPerDimension({ type: "composite", kind: "asset", condition: { op: "and", children: [] } } as never)).toBe(false);
    expect(triggerIsPerDimension({ type: "event", actionPattern: "agent.*" } as never)).toBe(false);
    expect(triggerIsPerDimension({ type: "change", changeType: "lldp" } as never)).toBe(false);
    expect(triggerIsPerDimension(null)).toBe(false);
  });
});

describe("ruleGroupsByAsset", () => {
  const poe = { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" } as never;
  const cpu = { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 } as never;

  it("gates on the flag AND on there being something to fold", () => {
    expect(ruleGroupsByAsset({ groupByAsset: true, trigger: poe })).toBe(true);
    expect(ruleGroupsByAsset({ groupByAsset: false, trigger: poe })).toBe(false);
    // The belt to validateGrouping's braces: a flag that survived on a
    // non-dimensioned trigger (an API-authored rule, a row predating a
    // metric's dimensions changing) must not make the engine take the
    // grouping path for a rule that has one reading per device.
    expect(ruleGroupsByAsset({ groupByAsset: true, trigger: cpu })).toBe(false);
  });

  it("is false for every rule in an install that has not opted in", () => {
    expect(ruleGroupsByAsset({ trigger: poe })).toBe(false);
    expect(ruleGroupsByAsset({ groupByAsset: null, trigger: poe })).toBe(false);
  });
});

describe("mergeMembers", () => {
  it("stamps joinedAt on a first appearance", () => {
    const out = mergeMembers([], [member("port12"), member("port14")], T0);
    expect(out.map((m) => m.key)).toEqual(["port12", "port14"]);
    expect(out.every((m) => m.joinedAt === T0.toISOString())).toBe(true);
  });

  it("keeps the ORIGINAL joinedAt when a contribution is still firing", () => {
    const first = mergeMembers([], [member("port12")], T0);
    const again = mergeMembers(first, [member("port12")], T1);
    expect(again).toHaveLength(1);
    expect(again[0]!.joinedAt).toBe(T0.toISOString());
  });

  it("refreshes the label, severity and value without moving the row", () => {
    const first = mergeMembers([], [member("port12", { label: "port12" }), member("port14")], T0);
    const again = mergeMembers(
      first,
      [member("port12", { label: "port12 (AP-1)", severity: "critical", value: "fault" })],
      T1,
    );
    expect(again.map((m) => m.key)).toEqual(["port12", "port14"]);
    expect(again[0]!.label).toBe("port12 (AP-1)");
    expect(again[0]!.severity).toBe("critical");
    expect(again[0]!.value).toBe("fault");
  });

  it("does NOT drop a stored contribution just because this tick had no reading for it", () => {
    // A collection gap is not a recovery. Departure is stamped on the recovery
    // transition by markMemberLeft, which is the only place that knows.
    const first = mergeMembers([], [member("port12"), member("port14")], T0);
    const again = mergeMembers(first, [member("port12")], T1);
    expect(again.map((m) => m.key)).toEqual(["port12", "port14"]);
    expect(again[1]!.leftAt).toBeUndefined();
  });

  it("treats a re-join as the same contribution returning, clearing leftAt", () => {
    const first = mergeMembers([], [member("port12")], T0);
    const left = markMemberLeft(first, RULE, "port12", T1);
    expect(left[0]!.leftAt).toBe(T1.toISOString());
    const back = mergeMembers(left, [member("port12")], T2);
    expect(back).toHaveLength(1);
    expect(back[0]!.leftAt).toBeUndefined();
    expect(back[0]!.joinedAt).toBe(T0.toISOString());
  });

  it("keeps contributions from two automations about the same component apart", () => {
    const out = mergeMembers(
      [],
      [member("port12", { ruleName: "PoE fault" }), member("port12", { ruleId: RULE_B, ruleName: "Interface down" })],
      T0,
    );
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.ruleName)).toEqual(["PoE fault", "Interface down"]);
  });

  it("caps the snapshot, shedding DEPARTED entries before any live one", () => {
    const departed = Array.from({ length: MAX_GROUP_MEMBERS }, (_, i) =>
      ({ ...member(`old${i}`), joinedAt: T0.toISOString(), leftAt: new Date(T0.getTime() + i * 1000).toISOString() }));
    const out = mergeMembers(departed, [member("live1"), member("live2")], T2);
    expect(out).toHaveLength(MAX_GROUP_MEMBERS);
    expect(out.some((m) => m.key === "live1")).toBe(true);
    expect(out.some((m) => m.key === "live2")).toBe(true);
    // The two oldest departures gave way, not the newest ones.
    expect(out.some((m) => m.key === "old0")).toBe(false);
    expect(out.some((m) => m.key === "old1")).toBe(false);
  });
});

describe("markMemberLeft", () => {
  it("stamps only the named (automation, component) pair", () => {
    const members = mergeMembers(
      [],
      [member("port12"), member("port14"), member("port12", { ruleId: RULE_B })],
      T0,
    );
    const out = markMemberLeft(members, RULE, "port12", T1);
    expect(out[0]!.leftAt).toBe(T1.toISOString());
    expect(out[1]!.leftAt).toBeUndefined();
    expect(out[2]!.leftAt).toBeUndefined(); // same component, different automation
  });

  it("never re-stamps a contribution that already left", () => {
    const members = markMemberLeft(mergeMembers([], [member("port12")], T0), RULE, "port12", T1);
    const again = markMemberLeft(members, RULE, "port12", T2);
    expect(again[0]!.leftAt).toBe(T1.toISOString());
  });
});

describe("groupSeverity", () => {
  it("is the worst of what is STILL wrong", () => {
    const members = mergeMembers(
      [],
      [member("port12", { severity: "warning" }), member("port14", { severity: "critical" })],
      T0,
    );
    expect(groupSeverity(members, "warning")).toBe("critical");
  });

  it("falls back when the only critical contribution has recovered", () => {
    const members = markMemberLeft(
      mergeMembers([], [member("port12", { severity: "warning" }), member("port14", { severity: "critical" })], T0),
      RULE,
      "port14",
      T1,
    );
    expect(groupSeverity(members, "warning")).toBe("warning");
  });

  it("returns the rule's base severity when nothing is active", () => {
    expect(groupSeverity([], "critical")).toBe("critical");
    expect(groupSeverity(null, "notice")).toBe("notice");
  });
});

describe("primaryMember", () => {
  it("leads with the worst severity", () => {
    const members = mergeMembers(
      [],
      [member("port2", { severity: "warning" }), member("port40", { severity: "critical" })],
      T0,
    );
    expect(primaryMember(members)!.key).toBe("port40");
  });

  it("breaks a tie naturally, so port2 precedes port10", () => {
    const members = mergeMembers([], [member("port10"), member("port2")], T0);
    expect(primaryMember(members)!.key).toBe("port2");
  });

  it("is stable across re-renders — the email's chart must not change component", () => {
    const a = mergeMembers([], [member("port2"), member("port10"), member("port7")], T0);
    const b = mergeMembers(a, [member("port7"), member("port2"), member("port10")], T1);
    expect(primaryMember(a)!.key).toBe(primaryMember(b)!.key);
  });

  it("ignores recovered contributions while any remain active", () => {
    const members = markMemberLeft(
      mergeMembers([], [member("port2", { severity: "critical" }), member("port40", { severity: "warning" })], T0),
      RULE,
      "port2",
      T1,
    );
    expect(primaryMember(members)!.key).toBe("port40");
  });

  it("returns null for an empty snapshot", () => {
    expect(primaryMember([])).toBeNull();
    expect(primaryMember(null)).toBeNull();
  });
});

describe("renderMemberList", () => {
  it("names LABELS, never keys — the alert says which port that is", () => {
    const members = mergeMembers([], [member("port12", { label: "port12 (Indoor AP)" })], T0);
    expect(renderMemberList(members)).toBe("port12 (Indoor AP)");
  });

  it("caps and counts the rest", () => {
    const members = mergeMembers([], Array.from({ length: 9 }, (_, i) => member(`port${i + 1}`)), T0);
    const out = renderMemberList(members, 3);
    expect(out).toBe("port1, port2, port3 and 6 more");
  });

  it("defaults to the published cap", () => {
    const members = mergeMembers([], Array.from({ length: GROUP_LABEL_CAP + 2 }, (_, i) => member(`p${i + 1}`)), T0);
    expect(renderMemberList(members)).toMatch(/ and 2 more$/);
  });

  it("leads with the worst contribution", () => {
    const members = mergeMembers(
      [],
      [member("port2", { severity: "warning" }), member("port40", { severity: "critical" })],
      T0,
    );
    expect(renderMemberList(members)).toBe("port40, port2");
  });

  it("names only what is still wrong", () => {
    const members = markMemberLeft(mergeMembers([], [member("port12"), member("port14")], T0), RULE, "port12", T1);
    expect(renderMemberList(members)).toBe("port14");
  });

  it("is empty when everything recovered, so a sentence can drop the clause", () => {
    const members = markMemberLeft(mergeMembers([], [member("port12")], T0), RULE, "port12", T1);
    expect(renderMemberList(members)).toBe("");
  });
});

describe("activeMembers", () => {
  it("excludes departed contributions and tolerates a null snapshot", () => {
    const members = markMemberLeft(mergeMembers([], [member("a"), member("b")], T0), RULE, "a", T1);
    expect(activeMembers(members).map((m) => m.key)).toEqual(["b"]);
    expect(activeMembers(null)).toEqual([]);
  });
});

describe("naturalCompare", () => {
  it("compares digit runs as numbers", () => {
    expect(naturalCompare("port2", "port10")).toBeLessThan(0);
    expect(["port10", "port2", "port1"].sort(naturalCompare)).toEqual(["port1", "port2", "port10"]);
  });
});

describe("validateGrouping (via ruleInputSchema)", () => {
  const rule = (trigger: unknown, groupByAsset = true) => ({
    name: "r", scope: { allAssets: true }, groupByAsset, trigger,
  });
  /** The issue paths a refusal reports, so a 400 points the wizard at the box. */
  const paths = (r: ReturnType<typeof ruleInputSchema.safeParse>) =>
    r.success ? [] : r.error.issues.map((i) => i.path.join("."));

  it("accepts it on every trigger that reports per component", () => {
    const ok = [
      { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" },
      { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" },
      { type: "asset_state", field: "ipsecStatus", operator: "!=", value: "up" },
      { type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 70 },
      { type: "asset_metric", metric: "storageUsedPct", operator: ">=", threshold: 90 },
    ];
    for (const t of ok) {
      expect(paths(ruleInputSchema.safeParse(rule(t))), JSON.stringify(t)).not.toContain("groupByAsset");
    }
  });

  it("refuses it where there would be nothing to fold, naming the box", () => {
    const refused = [
      { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 },
      { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
      { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90 },
      { type: "event", actionPattern: "agent.*" },
    ];
    for (const t of refused) {
      expect(paths(ruleInputSchema.safeParse(rule(t))), JSON.stringify(t)).toContain("groupByAsset");
    }
  });

  it("says WHY, so an operator knows which choice to change", () => {
    const res = ruleInputSchema.safeParse(rule({ type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 }));
    const msg = res.success ? "" : res.error.issues.find((i) => i.path.join(".") === "groupByAsset")?.message ?? "";
    expect(msg).toMatch(/cpuPct/);
    expect(msg).toMatch(/already raises one alert per device/);
  });

  it("leaves every un-ticked automation alone", () => {
    const res = ruleInputSchema.safeParse(rule({ type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 }, false));
    expect(paths(res)).not.toContain("groupByAsset");
  });

  it("defaults to off, so an install that upgrades changes nothing", () => {
    const res = ruleInputSchema.safeParse({
      name: "r", scope: { allAssets: true },
      trigger: { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" },
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.groupByAsset).toBe(false);
  });

  it("keeps the flag OUT of the trigger, so precedence still pairs grouped with ungrouped", () => {
    // triggerIdentityOf / triggerSignature are computed from the trigger and
    // feed the carve-out shadow index. Move grouping inside the trigger and a
    // grouped automation silently stops shadowing its ungrouped sibling
    // (business rule 46) — two alerts where the operator arranged for one.
    const res = ruleInputSchema.safeParse(rule({ type: "asset_state", field: "poeStatus", operator: "==", value: "fault" }));
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.groupByAsset).toBe(true);
    expect(JSON.stringify(res.data.trigger)).not.toMatch(/groupByAsset/);
  });

  it("publishes the capability so a pre-upgrade client renders no checkbox", () => {
    const cat = buildSchemaCatalog() as Record<string, any>;
    expect(cat.alertGrouping?.supported).toBe(true);
    expect(cat.alertGrouping?.labelCap).toBe(GROUP_LABEL_CAP);
  });
});

// ─── Alert groups: folding alerts ACROSS automations ────────────────────────

describe("triggerCanJoinGroup", () => {
  it("admits a COMPOSITE, which the per-rule checkbox refuses", () => {
    // Redundant as a self-fold (it already fires once per device), but a
    // perfectly good whole-device contribution to a group — "Switch health"
    // wanting one beside a PoE-fault automation is the obvious case.
    const composite = { type: "composite", kind: "asset", op: "and", children: [] } as never;
    expect(triggerCanJoinGroup(composite)).toBe(true);
    expect(triggerIsPerDimension(composite)).toBe(false);
  });

  it("admits the per-component triggers", () => {
    expect(triggerCanJoinGroup({ type: "asset_state", field: "poeStatus", operator: "==", value: "fault" } as never)).toBe(true);
    expect(triggerCanJoinGroup({ type: "asset_metric", metric: "storageUsedPct", operator: ">=", threshold: 90 } as never)).toBe(true);
  });

  it("refuses what could never contribute", () => {
    // host_metric: no device. event/change: no state row, so the alert could
    // never learn their part in it had ended.
    expect(triggerCanJoinGroup({ type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 90 } as never)).toBe(false);
    expect(triggerCanJoinGroup({ type: "composite", kind: "host", op: "and", children: [] } as never)).toBe(false);
    expect(triggerCanJoinGroup({ type: "event", actionPattern: "agent.*" } as never)).toBe(false);
    expect(triggerCanJoinGroup({ type: "change", changeType: "lldp" } as never)).toBe(false);
    expect(triggerCanJoinGroup(null)).toBe(false);
  });
});

describe("ruleGroupsByAsset with a group", () => {
  const poe = { type: "asset_state", field: "poeStatus", operator: "==", value: "fault" } as never;
  const composite = { type: "composite", kind: "asset", op: "and", children: [] } as never;

  it("membership IMPLIES the per-component fold, whatever the checkbox says", () => {
    expect(ruleGroupsByAsset({ groupByAsset: false, alertGroupId: "g1", trigger: poe })).toBe(true);
    expect(ruleGroupsByAsset({ alertGroupId: "g1", trigger: composite })).toBe(true);
  });

  it("still refuses a member whose trigger could never contribute", () => {
    expect(ruleGroupsByAsset({ alertGroupId: "g1", trigger: { type: "host_metric", metric: "cpuPct", operator: ">=", threshold: 1 } as never })).toBe(false);
  });
});

describe("alertScopeOf", () => {
  it("keys a group member on the GROUP, so every member folds into one alert", () => {
    expect(alertScopeOf({ id: "r1", alertGroupId: "g1" })).toEqual({ scope: "grp", id: "g1" });
    expect(alertScopeOf({ id: "r1" })).toEqual({ scope: "rule", id: "r1" });
  });

  it("changes the key when a rule joins or leaves, so two episodes cannot collide", () => {
    const solo = alertScopeOf({ id: "r1", alertGroupId: null });
    const joined = alertScopeOf({ id: "r1", alertGroupId: "g1" });
    expect(groupKeyOf(solo.scope, solo.id, "a1")).not.toBe(groupKeyOf(joined.scope, joined.id, "a1"));
  });
});

describe("alertOwnerOf", () => {
  const rule = { id: "r1", name: "PoE fault", severity: "warning", requireAckNote: false, actions: [{ type: "notify" }], escalation: { tiers: [] }, repeat: null, emailComposition: null, resetActions: null, messageTemplate: null };
  const group = { id: "g1", name: "Switch health", enabled: true, requireAckNote: true, actions: [{ type: "notify" }], escalation: null, repeat: { everyMin: 15 }, emailComposition: null, resetActions: null, messageTemplate: null };

  it("hands delivery to the GROUP when there is one", () => {
    const owner = alertOwnerOf({ severity: "warning", rule, alertGroup: group })!;
    expect(owner.kind).toBe("group");
    expect(owner.name).toBe("Switch health");
    expect(owner.requireAckNote).toBe(true);
    expect(owner.repeat).toEqual({ everyMin: 15 });
  });

  it("carries NO severity bands for a group — the alert's severity is its contributions'", () => {
    expect(alertOwnerOf({ severity: "critical", rule: { ...rule, severityBands: [{ threshold: 1, severity: "critical" }] }, alertGroup: group })!.severityBands).toBeNull();
  });

  it("falls back to the automation when the group is DISABLED", () => {
    // A disabled group hands delivery back rather than owning nothing: an
    // alert outliving the switch-off must not lose its escalation entirely.
    const owner = alertOwnerOf({ severity: "warning", rule, alertGroup: { ...group, enabled: false } })!;
    expect(owner.kind).toBe("rule");
    expect(owner.name).toBe("PoE fault");
  });

  it("is the automation when there is no group at all", () => {
    expect(alertOwnerOf({ severity: "warning", rule })!.kind).toBe("rule");
  });

  it("is null when there is neither — a test alert, or a deleted automation", () => {
    expect(alertOwnerOf({ severity: "warning" })).toBeNull();
    expect(alertOwnerOf(null)).toBeNull();
  });
});
