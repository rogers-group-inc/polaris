/**
 * tests/unit/alertGroups.test.ts — own suite for
 * services/notificationTypes/alertGroups.ts (CQ-T010, business rule 75).
 *
 * Complements, does not repeat, tests/unit/alertGrouping.test.ts, which covers
 * the main behaviour of every fold helper (merge / leave / severity / primary /
 * render / classify / describe / queue / refresh / owner / fold targets). This
 * file pins the edges that suite leaves open:
 *   - countNoun / wholeGroupSubject on their own;
 *   - mergeGroupChanges' collapse table (joined→recovered drops out, recovered→
 *     joined/returned reads as "back", later states replace earlier ones);
 *   - describeGroupChanges' "recovered" clause, its −/back subject tags, the
 *     "a and b" list, and a re-open with no name;
 *   - classifyGroupChanges with an unparsable leftAt;
 *   - queueGroupChanges keeping the FIRST re-opener and ignoring a junk column;
 *   - the snapshot cap when every contribution is live;
 *   - primaryMember / groupSeverity when nothing is active;
 *   - refreshMemberContext's device count from distinct ACTIVE devices, the
 *     several-automation whole-group naming, and the subnet exemption;
 *   - alertOwnerOf's severity fallbacks and a rule with no id/name;
 *   - dimensionSpaceOf / dimensionNounOf for whole-device triggers and the
 *     cpuCorePct component noun;
 *   - buildSchemaCatalog's v2 marker and that its vocabularies are the live ones.
 */

import { describe, it, expect } from "vitest";
import {
  countNoun,
  wholeGroupSubject,
  mergeGroupChanges,
  describeGroupChanges,
  classifyGroupChanges,
  queueGroupChanges,
  mergeMembers,
  primaryMember,
  groupSeverity,
  refreshMemberContext,
  alertOwnerOf,
  dimensionSpaceOf,
  dimensionNounOf,
  buildSchemaCatalog,
  memberMatches,
  MAX_GROUP_MEMBERS,
  GROUP_LABEL_CAP,
  ALERT_GROUP_FOLD_BY,
  type AlertMember,
  type GroupChange,
} from "../../src/services/notificationTypes/alertGroups.js";
import { METRIC_DIMENSIONS } from "../../src/services/notificationTypes/dimensions.js";
import { SEVERITIES } from "../../src/services/notificationTypes/scopeConditions.js";

const RULE = "11111111-1111-4111-8111-111111111111";
const RULE_B = "22222222-2222-4222-8222-222222222222";
const T0 = new Date("2026-09-18T10:00:00.000Z");
const T1 = new Date("2026-09-18T10:05:00.000Z");

function member(key: string, over: Partial<AlertMember> = {}): AlertMember {
  return {
    key,
    label: over.label ?? key,
    ruleId: over.ruleId ?? RULE,
    ruleName: over.ruleName ?? "PoE fault",
    severity: over.severity ?? "warning",
    joinedAt: over.joinedAt ?? T0.toISOString(),
    ...over,
  };
}

describe("countNoun / wholeGroupSubject", () => {
  it("pluralises on anything but one", () => {
    expect(countNoun(0, "device")).toBe("0 devices");
    expect(countNoun(1, "device")).toBe("1 device");
    expect(countNoun(2, "path check")).toBe("2 path checks");
  });

  it("names path checks when every contribution is one, several automations otherwise, else nothing", () => {
    expect(wholeGroupSubject({ devices: 9, checks: 1, automations: 3, pathOnly: true })).toBe("1 path check");
    expect(wholeGroupSubject({ devices: 9, checks: 0, automations: 3, pathOnly: false })).toBe("3 automations");
    expect(wholeGroupSubject({ devices: 9, checks: 0, automations: 1, pathOnly: false })).toBe("");
  });

  it("publishes the caps and the four folds, device first", () => {
    expect(MAX_GROUP_MEMBERS).toBe(64);
    expect(GROUP_LABEL_CAP).toBe(6);
    expect(ALERT_GROUP_FOLD_BY[0]).toBe("device");
  });
});

describe("mergeGroupChanges — the update cadence's collapse table", () => {
  const c = (label: string, kind: GroupChange["kind"], awayMs?: number): GroupChange => ({ label, kind, ...(awayMs !== undefined ? { awayMs } : {}) });

  it("a component that joined and recovered inside one interval was never worth an email", () => {
    expect(mergeGroupChanges([c("port1", "joined")], [c("port1", "recovered")])).toEqual([]);
  });

  it("recovered then faulting again — returned or joined — reads as back", () => {
    expect(mergeGroupChanges([c("port1", "recovered")], [c("port1", "joined")])).toEqual([c("port1", "returned")]);
    expect(mergeGroupChanges([c("port1", "recovered")], [c("port1", "returned", 5000)])).toEqual([c("port1", "returned", 5000)]);
  });

  it("otherwise the later state replaces the earlier, others untouched", () => {
    const out = mergeGroupChanges([c("port1", "returned", 1), c("port2", "joined")], [c("port1", "recovered")]);
    expect(out).toEqual([c("port1", "recovered"), c("port2", "joined")]);
  });

  it("tolerates no pending list", () => {
    expect(mergeGroupChanges(null, [c("a", "joined")])).toEqual([c("a", "joined")]);
    expect(mergeGroupChanges(undefined, [])).toEqual([]);
  });
});

describe("describeGroupChanges — edges", () => {
  it("says what recovered and tags it with a minus", () => {
    const d = describeGroupChanges([{ label: "port3", kind: "recovered" }, { label: "port4", kind: "recovered" }])!;
    expect(d.sentence).toBe("Update: port3 and port4 recovered.");
    expect(d.subjectTag).toBe("−port3, −port4");
  });

  it("a return without a known absence says so plainly, and tags it 'back'", () => {
    const d = describeGroupChanges([{ label: "port9", kind: "returned" }])!;
    expect(d.sentence).toBe("Update: port9 is in fault again after recovering.");
    expect(d.subjectTag).toBe("port9 back");
  });

  it("names 'someone' when the re-opener is unknown but the alert was acknowledged", () => {
    expect(describeGroupChanges([{ label: "a", kind: "joined" }], { reopenedFrom: "" })!.sentence)
      .toBe("Update: a joined this alert. Re-opened — someone had acknowledged it.");
    expect(describeGroupChanges([{ label: "a", kind: "joined" }], { reopenedFrom: null })!.sentence).toContain("someone");
  });
});

describe("classifyGroupChanges — edges", () => {
  it("a stored departure with an unreadable time still reports the return, without a duration", () => {
    const prev = [member("port1", { leftAt: "not a date" })];
    expect(classifyGroupChanges(prev, [member("port1")], T1)).toEqual([{ label: "port1", kind: "returned" }]);
  });

  it("names a contribution by its key when it carries no label", () => {
    expect(classifyGroupChanges([], [member("port7", { label: "" })], T1)).toEqual([{ label: "port7", kind: "joined" }]);
  });

  it("never reports a negative absence", () => {
    const prev = [member("port1", { leftAt: T1.toISOString() })];
    expect(classifyGroupChanges(prev, [member("port1")], T0)[0].awayMs).toBe(0);
  });
});

describe("queueGroupChanges — edges", () => {
  it("keeps who FIRST re-opened the alert across later re-opens", () => {
    const first = queueGroupChanges(null, [{ label: "a", kind: "joined" }], "alice")!;
    const second = queueGroupChanges(first, [{ label: "b", kind: "joined" }], "bob")!;
    expect(second.reopenedFrom).toBe("alice");
    expect(second.changes.map((c) => c.label)).toEqual(["a", "b"]);
  });

  it("a re-open alone is worth queueing; a junk stored value is read as empty", () => {
    expect(queueGroupChanges("garbage", [], "carol")).toEqual({ changes: [], reopenedFrom: "carol" });
    expect(queueGroupChanges({ changes: "nope" }, [{ label: "x", kind: "joined" }])).toEqual({ changes: [{ label: "x", kind: "joined" }] });
  });
});

describe("the snapshot cap with every contribution live", () => {
  it("keeps the first MAX_GROUP_MEMBERS — the oldest findings — when nothing departed can give way", () => {
    const live = Array.from({ length: MAX_GROUP_MEMBERS + 5 }, (_, i) => member(`port${i}`));
    const out = mergeMembers([], live, T0);
    expect(out).toHaveLength(MAX_GROUP_MEMBERS);
    expect(out[0].key).toBe("port0");
    expect(out.at(-1)!.key).toBe(`port${MAX_GROUP_MEMBERS - 1}`);
  });

  it("stamps joinedAt only where the contribution brought none", () => {
    const out = mergeMembers([], [member("a", { joinedAt: "" }), member("b", { joinedAt: T0.toISOString() })], T1);
    expect(out.map((m) => m.joinedAt)).toEqual([T1.toISOString(), T0.toISOString()]);
  });
});

describe("primaryMember / groupSeverity with nothing active", () => {
  it("primaryMember falls back to the departed contributions so the alert still names one", () => {
    const gone = [member("port10", { leftAt: T1.toISOString(), severity: "critical" }), member("port2", { leftAt: T1.toISOString() })];
    expect(primaryMember(gone)!.key).toBe("port10"); // worst first, even recovered
  });

  it("groupSeverity is the base, and a null snapshot is no snapshot", () => {
    expect(groupSeverity(null, "info")).toBe("info");
    expect(primaryMember(null)).toBeNull();
  });
});

describe("memberMatches", () => {
  it("compares the device only when the stored member carries one", () => {
    expect(memberMatches(member("k"), RULE, "k", "any")).toBe(true);
    expect(memberMatches(member("k", { assetId: "a1" }), RULE, "k", "a2")).toBe(false);
    expect(memberMatches(member("k", { assetId: "a1" }), RULE, "k", null)).toBe(false);
    expect(memberMatches(member("k"), RULE_B, "k")).toBe(false);
  });
});

describe("refreshMemberContext — edges", () => {
  it("counts distinct ACTIVE devices when no true counts are given", () => {
    const members = [
      member("k", { assetId: "a1", label: "h1" }),
      member("k2", { assetId: "a1", label: "h1 b" }),
      member("k", { assetId: "a2", label: "h2" }),
      member("k", { assetId: "a3", label: "h3", leftAt: T1.toISOString() }),
    ];
    const out = refreshMemberContext({ asset: "old" }, members, null);
    expect(out["asset"]).toBe("2 devices");
    expect(out["dimension.count"]).toBe("3");
    expect(out).not.toHaveProperty("message");
  });

  it("a subnet-folded alert keeps its subnet as {asset}", () => {
    const members = [member("k", { assetId: "a1", subnet: "Plant A (10.1.0.0/24)" })];
    expect(refreshMemberContext({ asset: "Plant A (10.1.0.0/24)" }, members, null)["asset"]).toBe("Plant A (10.1.0.0/24)");
  });

  it("a whole-group alert over several automations is named for the group", () => {
    const members = [
      member("k", { assetId: "a1", group: "Core", ruleName: "CPU high" }),
      member("k", { assetId: "a2", group: "Core", ruleId: RULE_B, ruleName: "Mem high" }),
    ];
    const out = refreshMemberContext({ rule: "CPU high" }, members, null, { devices: 2, checks: 0, automations: 2, pathOnly: false });
    expect(out["asset"]).toBe("2 automations");
    expect(out["rule"]).toBe("Core");
    expect(out["dimension.suffix"]).toBe(" · 2 devices");
  });

  it("a whole-group alert with no true counts says only how many devices", () => {
    const members = [member("k", { assetId: "a1", group: "Core" })];
    const out = refreshMemberContext({ rule: "x" }, members, null);
    expect(out["asset"]).toBe("1 device");
    expect(out["rule"]).toBe("x");
  });

  it("an all-recovered snapshot empties the list and its suffix", () => {
    const out = refreshMemberContext({ dimension: "port1" }, [member("port1", { leftAt: T1.toISOString() })], "m");
    expect(out["dimension"]).toBe("");
    expect(out["dimension.suffix"]).toBe("");
    expect(out["dimension.first"]).toBe("port1");
  });
});

describe("alertOwnerOf — fallbacks", () => {
  it("a group reports the alert's own severity, defaulting to warning", () => {
    expect(alertOwnerOf({ alertGroup: { id: "g", name: "G" } })!.severity).toBe("warning");
    expect(alertOwnerOf({ severity: "critical", alertGroup: { id: "g", name: "G" } })!.severity).toBe("critical");
  });

  it("a rule selected for its policy columns alone still yields an owner", () => {
    const o = alertOwnerOf({ severity: "info", rule: { resetActions: [{ type: "email" }] } })!;
    expect(o).toMatchObject({ kind: "rule", id: "", name: "", severity: "info", requireAckNote: false, resetActions: [{ type: "email" }] });
    expect(o.escalation).toBeNull();
    expect(o.messageTemplate).toBeNull();
  });

  it("nothing at all is no owner", () => {
    expect(alertOwnerOf(null)).toBeNull();
    expect(alertOwnerOf({ alertGroup: { id: "g", name: "G", enabled: false } })).toBeNull();
  });
});

describe("dimensionSpaceOf / dimensionNounOf — edges", () => {
  it("a whole-device trigger has no space and no noun", () => {
    expect(dimensionSpaceOf({ type: "asset_metric", metric: "cpuPct" })).toBeNull();
    expect(dimensionSpaceOf({ type: "event" })).toBeNull();
    expect(dimensionSpaceOf(null)).toBeNull();
    expect(dimensionNounOf({ type: "asset_state", field: "monitorStatus" })).toBe("");
    expect(dimensionNounOf(undefined)).toBe("");
  });

  it("the space is the SORTED key set, whatever order the metric declares", () => {
    const [metric, keys] = Object.entries(METRIC_DIMENSIONS).find(([, k]) => k.length > 1) ?? [];
    if (!metric) return; // no multi-key metric in this build
    expect(dimensionSpaceOf({ type: "asset_metric", metric })).toBe([...keys!].sort().join(","));
  });

  it("names cpuCorePct's components although it is one alert per device", () => {
    expect(dimensionSpaceOf({ type: "asset_metric", metric: "cpuCorePct" })).toBeNull();
    expect(dimensionNounOf({ type: "asset_metric", metric: "cpuCorePct" })).toBe("CPU cores");
  });
});

describe("buildSchemaCatalog", () => {
  it("carries the v2 marker and the live vocabularies, not copies that can drift", () => {
    const cat = buildSchemaCatalog() as Record<string, unknown>;
    expect(cat.schemaVersion).toBe(2);
    expect(cat.severities).toBe(SEVERITIES);
    expect(cat.metricDimensions).toBe(METRIC_DIMENSIONS);
    expect(Array.isArray(cat.sdwanMemberIpTargets)).toBe(true);
    expect((cat.prioritySeverity as { triggers: unknown[] }).triggers).toHaveLength(2);
  });
});
