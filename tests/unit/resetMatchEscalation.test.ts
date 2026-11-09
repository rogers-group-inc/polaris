// Business rule 145 — reset Notify actions that MATCH a trigger action, and the
// escalation reset that tells only the tiers that actually sent.
import { describe, it, expect } from "vitest";
import {
  expandResetActions,
  refreshMatchedResetSnapshots,
  appendEscalationFired,
  parseEscalationFired,
  levelChainOwner,
  severitiesRunningSection,
  allRuleActionRefs,
  ruleInputSchema,
  type EscalationFiredRecord,
} from "../../src/services/notificationTypes.js";
import { assertResetLinks } from "../../src/services/notificationRuleService.js";

const noc = { type: "notify", id: "n1", channelId: "c1", addresses: ["noc@example.invalid"] } as const;
const lead = { type: "notify", channelId: "c1", addresses: ["lead@example.invalid"] } as const;
const director = { type: "notify", channelId: "c1", addresses: ["director@example.invalid"] } as const;
const chain = {
  stopOn: "acknowledge" as const,
  tiers: [
    { afterMin: 15, actions: [lead] },
    { afterMin: 30, actions: [director] },
  ],
};
const fired = (severity: string, tier: number, chainKey = ""): EscalationFiredRecord =>
  ({ severity, chain: chainKey, tier, at: "2026-11-09T10:00:00.000Z" });

function rule(over: Record<string, unknown> = {}) {
  return {
    severity: "warning",
    actions: [noc],
    escalation: chain,
    severityBands: null,
    resetActions: [] as unknown[],
    ...over,
  } as never;
}

describe("expandResetActions (business rule 145)", () => {
  it("a matched reset sends what the trigger action says NOW, not the stored snapshot", () => {
    const r = rule({
      actions: [{ ...noc, addresses: ["noc-new@example.invalid"] }],
      resetActions: [{ type: "notify", channelId: "c1", addresses: ["noc-old@example.invalid"], matchActionId: "n1" }],
    });
    const out = expandResetActions(r, []);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "notify", addresses: ["noc-new@example.invalid"] });
    // Executes as a plain notify: no link, id, chain or reminder fields.
    expect(out[0]).not.toHaveProperty("matchActionId");
    expect(out[0]).not.toHaveProperty("id");
  });

  it("a customized reset sends its own fields", () => {
    const r = rule({ resetActions: [{ type: "notify", channelId: "c1", addresses: ["ops@example.invalid"], matchActionId: "n1", customized: true }] });
    expect(expandResetActions(r, [])[0]).toMatchObject({ addresses: ["ops@example.invalid"] });
  });

  it("a link whose target is gone falls back to the stored snapshot", () => {
    const r = rule({ resetActions: [{ type: "notify", channelId: "c1", addresses: ["snap@example.invalid"], matchActionId: "gone" }] });
    expect(expandResetActions(r, [])[0]).toMatchObject({ addresses: ["snap@example.invalid"] });
  });

  it("the escalation reset reaches ONLY the tiers that sent", () => {
    const r = rule({ resetActions: [{ type: "notify", channelId: "c1", matchActionId: "n1", resetEscalation: {} }] });
    expect(expandResetActions(r, []).map((a) => (a as { addresses?: string[] }).addresses)).toEqual([["noc@example.invalid"]]);
    expect(expandResetActions(r, [fired("warning", 0)]).map((a) => (a as { addresses?: string[] }).addresses))
      .toEqual([["noc@example.invalid"], ["lead@example.invalid"]]);
    expect(expandResetActions(r, [fired("warning", 0), fired("warning", 1)]).map((a) => (a as { addresses?: string[] }).addresses))
      .toEqual([["noc@example.invalid"], ["lead@example.invalid"], ["director@example.invalid"]]);
  });

  it("without the toggle a fired tier hears nothing", () => {
    const r = rule({ resetActions: [{ type: "notify", channelId: "c1", matchActionId: "n1" }] });
    expect(expandResetActions(r, [fired("warning", 0)])).toHaveLength(1);
  });

  it("a per-tier override replaces that tier's own Notify actions", () => {
    const r = rule({
      resetActions: [{
        type: "notify", channelId: "c1", matchActionId: "n1",
        resetEscalation: { custom: { "warning:1": [{ type: "notify", channelId: "c1", addresses: ["vp@example.invalid"] }] } },
      }],
    });
    const out = expandResetActions(r, [fired("warning", 0), fired("warning", 1)]);
    expect(out.map((a) => (a as { addresses?: string[] }).addresses))
      .toEqual([["noc@example.invalid"], ["lead@example.invalid"], ["vp@example.invalid"]]);
  });

  it("two reset actions asking for one tier send it once", () => {
    const r = rule({
      actions: [noc, { type: "notify", id: "n2", channelId: "c1", addresses: ["b@example.invalid"] }],
      resetActions: [
        { type: "notify", channelId: "c1", matchActionId: "n1", resetEscalation: {} },
        { type: "notify", channelId: "c1", matchActionId: "n2", resetEscalation: {} },
      ],
    });
    const out = expandResetActions(r, [fired("warning", 0)]);
    expect(out.filter((a) => (a as { addresses?: string[] }).addresses?.[0] === "lead@example.invalid")).toHaveLength(1);
  });

  it("a band with no chain of its own escalates on the base chain: one tier, one reset, keyed by the base", () => {
    const bands = [{ severity: "critical", threshold: 95, actions: [] }];
    const r = rule({
      severityBands: bands,
      resetActions: [{
        type: "notify", channelId: "c1", matchActionId: "n1",
        resetEscalation: { custom: { "warning:0": [{ type: "notify", channelId: "c1", addresses: ["override@example.invalid"] }] } },
      }],
    });
    expect(levelChainOwner(r, "critical")).toBe("warning");
    expect(severitiesRunningSection(r, null)).toEqual(["warning", "critical"]);
    // Tier 0 sent at warning, then again after the band change at critical.
    const out = expandResetActions(r, [fired("warning", 0), fired("critical", 0)]);
    expect(out.map((a) => (a as { addresses?: string[] }).addresses))
      .toEqual([["noc@example.invalid"], ["override@example.invalid"]]);
  });

  it("a band action's reset covers only its own band's tiers", () => {
    const bandChain = { stopOn: "acknowledge" as const, tiers: [{ afterMin: 5, actions: [director] }] };
    const r = rule({
      severityBands: [{ severity: "critical", threshold: 95, actions: [{ type: "notify", id: "b1", channelId: "c1", addresses: ["crit@example.invalid"] }], escalation: bandChain }],
      resetActions: [{ type: "notify", channelId: "c1", matchActionId: "b1", resetEscalation: {} }],
    });
    const out = expandResetActions(r, [fired("warning", 0), fired("critical", 0)]);
    expect(out.map((a) => (a as { addresses?: string[] }).addresses))
      .toEqual([["crit@example.invalid"], ["director@example.invalid"]]);
  });

  it("passes every other reset action through untouched", () => {
    const r = rule({ resetActions: [{ type: "event" }, { type: "notify", channelId: "c9", addresses: ["x@example.invalid"] }] });
    expect(expandResetActions(r, [fired("warning", 0)])).toEqual([{ type: "event" }, { type: "notify", channelId: "c9", addresses: ["x@example.invalid"] }]);
  });
});

describe("refreshMatchedResetSnapshots", () => {
  it("rewrites a matched row's copy to the trigger action, keeps the link and the escalation reset", () => {
    const r = rule({ resetActions: [{ type: "notify", channelId: "c1", addresses: ["old@example.invalid"], matchActionId: "n1", resetEscalation: {} }] });
    const out = refreshMatchedResetSnapshots(r as { resetActions: unknown[] } as never) as { resetActions: unknown[] };
    expect(out.resetActions[0]).toEqual({ type: "notify", channelId: "c1", addresses: ["noc@example.invalid"], matchActionId: "n1", resetEscalation: {} });
  });

  it("leaves a customized row's fields alone", () => {
    const row = { type: "notify", channelId: "c1", addresses: ["ops@example.invalid"], matchActionId: "n1", customized: true };
    const out = refreshMatchedResetSnapshots(rule({ resetActions: [row] }) as never) as { resetActions: unknown[] };
    expect(out.resetActions[0]).toEqual(row);
  });

  it("drops a dangling link but keeps the copy it would have sent", () => {
    const out = refreshMatchedResetSnapshots(rule({
      resetActions: [{ type: "notify", channelId: "c1", addresses: ["snap@example.invalid"], matchActionId: "gone", resetEscalation: {} }],
    }) as never) as { resetActions: unknown[] };
    expect(out.resetActions[0]).toEqual({ type: "notify", channelId: "c1", addresses: ["snap@example.invalid"] });
  });
});

describe("assertResetLinks", () => {
  const refs = (r: unknown) => allRuleActionRefs(r as never);

  it("refuses the linking fields anywhere but a reset action", () => {
    expect(() => assertResetLinks(refs(rule({ actions: [{ ...noc, matchActionId: "n1" }] })))).toThrow(/only a reset action/);
    expect(() => assertResetLinks(refs(rule({
      escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 5, actions: [{ ...lead, resetEscalation: {} }] }] },
    })))).toThrow(/only a reset action/);
  });

  it("refuses two firing Notify actions sharing an id", () => {
    expect(() => assertResetLinks(refs(rule({ actions: [noc, { ...noc }] })))).toThrow(/share the id/);
  });

  it("refuses an escalation reset with no trigger action to answer for", () => {
    expect(() => assertResetLinks(refs(rule({ resetActions: [{ type: "notify", channelId: "c1", resetEscalation: {} }] })))).toThrow(/needs the trigger action/);
  });

  it("walks the per-tier overrides as reset actions", () => {
    const r = rule({
      resetActions: [{ type: "notify", channelId: "c1", matchActionId: "n1", resetEscalation: { custom: { "warning:0": [{ type: "notify", channelId: "c7" }] } } }],
    });
    expect(refs(r).filter((x) => x.where === "reset").map((x) => (x.action as { channelId?: string }).channelId)).toEqual(["c1", "c7"]);
  });
});

describe("escalationFired bookkeeping", () => {
  it("appends a tier once per (severity, chain, tier)", () => {
    const a = appendEscalationFired([], fired("warning", 0));
    expect(appendEscalationFired(a, fired("warning", 0))).toBe(a);
    expect(appendEscalationFired(a, fired("critical", 0))).toHaveLength(2);
  });

  it("reads tolerantly", () => {
    expect(parseEscalationFired(null)).toEqual([]);
    expect(parseEscalationFired([fired("warning", 1), { junk: true }])).toEqual([fired("warning", 1)]);
  });
});

describe("rule schema", () => {
  it("accepts an id on a trigger Notify and the link fields on a reset Notify", () => {
    const parsed = ruleInputSchema.safeParse({
      name: "x", enabled: true, severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      actions: [noc],
      resetActions: [{ type: "notify", channelId: "c1", matchActionId: "n1", customized: true, resetEscalation: { custom: { "warning:0": [lead] } } }],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a link inside an override (overrides are plain deliveries)", () => {
    const parsed = ruleInputSchema.safeParse({
      name: "x", enabled: true, severity: "warning",
      trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      actions: [noc],
      resetActions: [{ type: "notify", channelId: "c1", matchActionId: "n1", resetEscalation: { custom: { "warning:0": [{ ...lead, matchActionId: "n1" }] } } }],
    });
    expect(parsed.success).toBe(false);
  });
});
