/**
 * tests/unit/actionWalk.test.ts — walking a rule's actions
 * (src/services/notificationTypes/actionWalk.ts): the canonical eight-location
 * action walk, escalation-chain selection per severity, per-action reminders,
 * band follow-up policy, and the business-rule-145 reset helpers.
 *
 * Complements (does not repeat):
 *  - resetMatchEscalation.test.ts — expandResetActions / refreshMatchedResetSnapshots
 *    / levelChainOwner / parseEscalationFired end to end;
 *  - followUpPolicy.test.ts — the repeat + escalation sentences;
 *  - automationActionRefs / assertActionRefs suites — allRuleActionRefs read
 *    through the rule service's save-time gate.
 * New here: allRuleActionRefs' labels + `where` for every location (incl. the
 * escalation-reset overrides), ruleHasAnyEscalation per location, the state-key
 * helpers, effectiveAckNoteForSeverity's presence-not-truthiness rule,
 * repeatingActionsForSeverity / allRepeatsOf (no direct test before),
 * escalationChainsForSeverity's band fallback, appendEscalationFired dedupe,
 * severitiesRunningSection, and isAssetScopedTrigger. Pure — no database.
 */

import { describe, it, expect } from "vitest";
import {
  allRuleActionRefs,
  ruleHasAnyEscalation,
  escalationTierStateKey,
  REPEAT_STATE_KEY,
  repeatStateKey,
  effectiveAckNoteForSeverity,
  repeatingActionsForSeverity,
  allRepeatsOf,
  escalationChainsForSeverity,
  parseEscalationFired,
  appendEscalationFired,
  severitiesRunningSection,
  levelChainOwner,
  isAssetScopedTrigger,
  type RuleActionCarrier,
} from "../../src/services/notificationTypes/actionWalk.js";
import type { EscalatableAction, SeverityBand, AutomationAction, RepeatConfig, EscalationV2Config } from "../../src/services/notificationTypes/actions.js";
import type { Trigger } from "../../src/services/notificationTypes/triggers.js";

const notify = (channelId: string, extra: Record<string, unknown> = {}): EscalatableAction =>
  ({ type: "notify", channelId, ...extra }) as EscalatableAction;
const v2Esc = (...afterMins: number[]): EscalationV2Config => ({
  stopOn: "acknowledge",
  tiers: afterMins.map((afterMin, i) => ({ afterMin, actions: [{ type: "notify", channelId: `esc${i}` } as AutomationAction] })),
});
const legacyEsc = (afterMin: number) => ({ stopOn: "clear", tiers: [{ afterMin, channelId: "mail", to: { addresses: ["ops@example.com"] } }] });
const band = (severity: string, over: Partial<SeverityBand> = {}): SeverityBand =>
  ({ threshold: 1, severity, actions: [], ...over }) as SeverityBand;
const rep = (everyMin: number): RepeatConfig => ({ everyMin, stopOn: "acknowledge" });

describe("allRuleActionRefs", () => {
  it("walks every action location with a label and where it runs", () => {
    const rule: RuleActionCarrier = {
      actions: [notify("c1", { escalation: v2Esc(15) })],
      escalation: legacyEsc(30),
      severityBands: [band("critical", { actions: [notify("c2", { escalation: v2Esc(5) })], escalation: v2Esc(10) })],
      bandNotify: { onIncrease: true, onDecrease: false, onResolved: true, resolvedMode: "dedicated", resolvedActions: [{ type: "notify", channelId: "c3" } as AutomationAction] },
      resetActions: [{ type: "notify", channelId: "c4", resetEscalation: { custom: { "warning:0": [{ type: "notify", channelId: "c5" }] } } } as AutomationAction],
    };
    const refs = allRuleActionRefs(rule).map((r) => [r.label, r.where, (r.action as { channelId?: string }).channelId]);
    expect(refs).toEqual([
      ["Action 1", "fire", "c1"],
      ["Action 1 escalation tier 1", "tier", "esc0"],
      ["Rule escalation tier 1", "tier", "mail"],
      ["critical band action 1", "fire", "c2"],
      ["critical band action 1 escalation tier 1", "tier", "esc0"],
      ["critical band escalation tier 1", "tier", "esc0"],
      ["Resolved action 1", "resolved", "c3"],
      ["Reset action 1", "reset", "c4"],
      ["Reset action 1 escalation reset warning:0", "reset", "c5"],
    ]);
  });

  it("is empty for an empty rule and ignores an unparseable escalation", () => {
    expect(allRuleActionRefs({})).toEqual([]);
    expect(allRuleActionRefs({ escalation: { tiers: "nope" } })).toEqual([]);
  });

  it("non-notify reset actions carry no escalation-reset walk", () => {
    const refs = allRuleActionRefs({ resetActions: [{ type: "event" } as AutomationAction] });
    expect(refs.map((r) => r.label)).toEqual(["Reset action 1"]);
  });
});

describe("ruleHasAnyEscalation", () => {
  it("finds a chain at each of the four places one can live", () => {
    expect(ruleHasAnyEscalation({})).toBe(false);
    expect(ruleHasAnyEscalation({ escalation: v2Esc(5) })).toBe(true);
    expect(ruleHasAnyEscalation({ actions: [notify("c", { escalation: legacyEsc(5) })] })).toBe(true);
    expect(ruleHasAnyEscalation({ severityBands: [band("critical", { escalation: v2Esc(5) })] })).toBe(true);
    expect(ruleHasAnyEscalation({ severityBands: [band("critical", { actions: [notify("c", { escalation: v2Esc(5) })] })] })).toBe(true);
    expect(ruleHasAnyEscalation({ actions: [notify("c")], severityBands: [band("critical")] })).toBe(false);
  });
});

describe("state keys", () => {
  it("level chain keeps bare numerics; per-action chains and reminders are prefixed", () => {
    expect(escalationTierStateKey("", 0)).toBe("0");
    expect(escalationTierStateKey("a2", 1)).toBe("a2:t1");
    expect(repeatStateKey(3)).toBe("a3:repeat");
    expect(REPEAT_STATE_KEY).toBe("repeat");
    // Collision-free by construction.
    expect(new Set([escalationTierStateKey("", 0), escalationTierStateKey("a0", 0), repeatStateKey(0), REPEAT_STATE_KEY]).size).toBe(4);
  });
});

describe("effectiveAckNoteForSeverity", () => {
  const base = { severity: "warning", requireAckNote: true };

  it("the base severity reads the rule's flag", () => {
    expect(effectiveAckNoteForSeverity(base, "warning")).toBe(true);
    expect(effectiveAckNoteForSeverity({ severity: "warning" }, "warning")).toBe(false);
  });

  it("a band WITH a followUp answers for itself, even when it says false", () => {
    const rule = { ...base, severityBands: [band("critical", { followUp: { requireAckNote: false } })] };
    expect(effectiveAckNoteForSeverity(rule, "critical")).toBe(false);
    const rule2 = { severity: "warning", requireAckNote: false, severityBands: [band("critical", { followUp: { requireAckNote: true } })] };
    expect(effectiveAckNoteForSeverity(rule2, "critical")).toBe(true);
  });

  it("a band without a followUp, or an unknown severity, inherits the rule's", () => {
    expect(effectiveAckNoteForSeverity({ ...base, severityBands: [band("critical")] }, "critical")).toBe(true);
    expect(effectiveAckNoteForSeverity(base, "serious")).toBe(true);
  });
});

describe("repeatingActionsForSeverity / allRepeatsOf", () => {
  it("inherits the rule clock when an action is silent, opts out on explicit null", () => {
    const rule = {
      severity: "warning",
      repeat: rep(30),
      actions: [notify("a"), notify("b", { repeat: null }), notify("c", { repeat: rep(10) }), { type: "event" } as EscalatableAction],
    };
    const out = repeatingActionsForSeverity(rule, "warning");
    expect(out.map((x) => [x.index, (x.action as { channelId: string }).channelId, x.repeat.everyMin])).toEqual([[0, "a", 30], [2, "c", 10]]);
  });

  it("only notify actions repeat — api calls and scripts never do", () => {
    const rule = { severity: "warning", repeat: rep(15), actions: [{ type: "api_call", url: "https://example.com", method: "POST" } as unknown as EscalatableAction, notify("n")] };
    expect(repeatingActionsForSeverity(rule, "warning").map((x) => x.index)).toEqual([1]);
  });

  it("a band with its own actions takes over at its severity; an empty band falls back", () => {
    const rule = {
      severity: "warning",
      actions: [notify("base", { repeat: rep(60) })],
      severityBands: [band("serious"), band("critical", { actions: [notify("crit", { repeat: rep(5) })] })],
    };
    expect(repeatingActionsForSeverity(rule, "critical")[0]!.repeat.everyMin).toBe(5);
    expect(repeatingActionsForSeverity(rule, "serious")[0]!.repeat.everyMin).toBe(60);
    expect(repeatingActionsForSeverity({ severity: "warning" }, "warning")).toEqual([]);
  });

  it("allRepeatsOf lists the rule's and every action's own clock, band actions included", () => {
    const rule = {
      repeat: rep(30),
      actions: [notify("a", { repeat: rep(10) }), notify("b", { repeat: null })],
      severityBands: [band("critical", { actions: [notify("c", { repeat: rep(5) })] })],
    };
    expect(allRepeatsOf(rule).map((r) => r.everyMin)).toEqual([30, 10, 5]);
    expect(allRepeatsOf({})).toEqual([]);
  });
});

describe("escalationChainsForSeverity", () => {
  const rule = {
    severity: "warning",
    escalation: v2Esc(30),
    actions: [notify("a", { escalation: v2Esc(15) }), notify("b")],
    severityBands: [
      band("serious"),
      band("critical", { escalation: v2Esc(5), actions: [notify("x"), notify("y", { escalation: legacyEsc(2) })] }),
    ],
  };

  it("base severity: the rule's level chain plus per-action chains keyed by index", () => {
    const chains = escalationChainsForSeverity(rule, "warning");
    expect(chains.map((c) => [c.key, c.escalation.tiers[0]!.afterMin])).toEqual([["", 30], ["a0", 15]]);
  });

  it("a band with its own chain and actions replaces both", () => {
    const chains = escalationChainsForSeverity(rule, "critical");
    expect(chains.map((c) => [c.key, c.escalation.tiers[0]!.afterMin])).toEqual([["", 5], ["a1", 2]]);
    // The legacy per-action tier is converted to a v2 notify.
    expect(chains[1]!.escalation.tiers[0]!.actions[0]).toMatchObject({ type: "notify", channelId: "mail", addresses: ["ops@example.com"] });
  });

  it("a band with neither falls back to the rule's chain and actions", () => {
    expect(escalationChainsForSeverity(rule, "serious").map((c) => c.key)).toEqual(["", "a0"]);
  });

  it("no chains anywhere = empty", () => {
    expect(escalationChainsForSeverity({ severity: "warning", actions: [notify("a")] }, "warning")).toEqual([]);
  });
});

describe("escalation-fired records + section helpers (rule 145)", () => {
  it("parseEscalationFired keeps well-formed records only", () => {
    const good = { severity: "warning", chain: "", tier: 0, at: "2026-11-12T12:00:00Z" };
    expect(parseEscalationFired([good, null, { severity: "x", chain: "", tier: 1.5 }, { chain: "", tier: 0 }])).toEqual([good]);
    expect(parseEscalationFired("nope")).toEqual([]);
  });

  it("appendEscalationFired dedupes on (severity, chain, tier), ignoring the time", () => {
    const a = { severity: "warning", chain: "", tier: 0, at: "t1" };
    const list = appendEscalationFired([], a);
    expect(appendEscalationFired(list, { ...a, at: "t2" })).toBe(list);
    expect(appendEscalationFired(list, { ...a, tier: 1 })).toHaveLength(2);
    expect(appendEscalationFired(list, { ...a, chain: "a0" })).toHaveLength(2);
  });

  it("severitiesRunningSection: a band section is itself; the base also runs every action-less band", () => {
    const rule = { severity: "warning", severityBands: [band("serious"), band("critical", { actions: [notify("c")] })] };
    expect(severitiesRunningSection(rule, "critical")).toEqual(["critical"]);
    expect(severitiesRunningSection(rule, null)).toEqual(["warning", "serious"]);
  });

  it("levelChainOwner: a band owns its chain only when it declares tiers", () => {
    const rule = { severity: "warning", severityBands: [band("serious"), band("critical", { escalation: v2Esc(5) })] };
    expect(levelChainOwner(rule, "warning")).toBe("warning");
    expect(levelChainOwner(rule, "serious")).toBe("warning");
    expect(levelChainOwner(rule, "critical")).toBe("critical");
    expect(levelChainOwner(rule, "informational")).toBe("warning");
  });
});

describe("isAssetScopedTrigger", () => {
  it("asset metric / state / change are about a device; host and event are not", () => {
    expect(isAssetScopedTrigger({ type: "asset_metric" } as Trigger)).toBe(true);
    expect(isAssetScopedTrigger({ type: "asset_state" } as Trigger)).toBe(true);
    expect(isAssetScopedTrigger({ type: "change" } as Trigger)).toBe(true);
    expect(isAssetScopedTrigger({ type: "host_metric" } as Trigger)).toBe(false);
    expect(isAssetScopedTrigger({ type: "event" } as Trigger)).toBe(false);
  });

  it("a composite depends on its kind", () => {
    expect(isAssetScopedTrigger({ type: "composite", kind: "asset" } as Trigger)).toBe(true);
    expect(isAssetScopedTrigger({ type: "composite", kind: "host" } as Trigger)).toBe(false);
  });
});
