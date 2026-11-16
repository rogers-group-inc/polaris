/**
 * tests/unit/notificationsTemplating.test.ts — own unit suite for
 * src/services/notifications/templating.ts (CQ-T010).
 *
 * The reading context an alert message carries, the follow-up sentences, the
 * default in-app message (single, grouped — business rule 75 —, subnet- and
 * automation-folded, composite, dependency-down — rule 78 —, per-core CPU —
 * rule 89 — and forecast), and the "does this rule need a template snapshot /
 * the asset detail" switches. All pure; the notificationTypes helpers run real.
 */

import { describe, it, expect } from "vitest";
import {
  readingContextParts,
  followUpParts,
  applyFollowUpPolicy,
  renderMessage,
  round2,
  ruleWantsContext,
  groupWantsContext,
  groupWantsAssetDetail,
  ruleWantsAssetDetail,
} from "../../src/services/notifications/templating.js";
import type { DbRule, Reading } from "../../src/services/notifications/ruleModel.js";
import { followUpPolicy, type AlertMember } from "../../src/services/notificationTypes.js";

const NOW = new Date("2026-11-14T12:00:00Z");

function rule(extra: Partial<DbRule> = {}): DbRule {
  return {
    id: "r1", name: "High CPU", description: null, severity: "warning",
    trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 } as never,
    scope: {} as never, reset: { mode: "auto" } as never, actions: [],
    cooldownSec: null, messageTemplate: null, emailComposition: null, escalation: null,
    severityBands: null, bandNotify: null, resetActions: null, repeat: null,
    groupByAsset: false, alertGroupId: null,
    ...extra,
  };
}

function reading(extra: Partial<Reading> = {}): Reading {
  return { assetId: "a1", hostname: "core-sw1", tags: [], dimKey: "", dimLabel: "", value: 95, ...extra };
}

function member(extra: Partial<AlertMember>): AlertMember {
  return { key: "k", label: "k", ruleId: "r1", ruleName: "High CPU", severity: "warning", joinedAt: NOW.toISOString(), ...extra };
}

const pathOkTrigger = { type: "asset_metric", metric: "pathOk", operator: "==", threshold: 0 } as never;

describe("round2", () => {
  it("rounds to at most two decimals and drops trailing zeros", () => {
    expect(round2(95.456)).toBe("95.46");
    expect(round2(3)).toBe("3");
    expect(round2(0.1 + 0.2)).toBe("0.3");
    expect(round2(-1.234)).toBe("-1.23");
  });
});

describe("readingContextParts", () => {
  it("builds the single-reading context from the trigger and the reading", () => {
    const p = readingContextParts(rule(), reading({ value: 95.456 }), NOW);
    expect(p.asset).toBe("core-sw1");
    expect(p.metric).toBe("cpuPct");
    expect(p.value).toBe("95.46");
    expect(p.threshold).toBe("90");
    expect(p.severity).toBe("warning");
    expect(p.ruleName).toBe("High CPU");
    expect(p.time).toBe(NOW);
    expect(p.dimension).toBe("");
    expect(p.dimensionNoun).toBe("");
    expect(p.dimensionCount).toBe("0");
    expect(typeof p.triggerSummary).toBe("string");
    expect(p.metricLabel).toBeTruthy();
  });

  it("falls back from hostname to assetId to 'host'", () => {
    expect(readingContextParts(rule(), reading({ hostname: null }), NOW).asset).toBe("a1");
    expect(readingContextParts(rule(), reading({ hostname: null, assetId: "" }), NOW).asset).toBe("host");
  });

  it("renders a null reading as n/a and a string reading verbatim", () => {
    expect(readingContextParts(rule(), reading({ value: null }), NOW).value).toBe("n/a");
    const st = rule({ trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" } as never });
    const p = readingContextParts(st, reading({ value: "down" }), NOW);
    expect(p.value).toBe("down");
    expect(p.metric).toBe("monitorStatus");
    expect(p.threshold).toBe("down");
  });

  it("labels a per-component reading and counts it as one", () => {
    const iface = rule({ trigger: { type: "asset_metric", metric: "ifInErrorRate", operator: ">", threshold: 1 } as never });
    const p = readingContextParts(iface, reading({ dimKey: "port12", dimLabel: "port12 (AP-1)" }), NOW);
    expect(p.dimension).toBe("port12 (AP-1)");
    expect(p.dimensionCount).toBe("1");
    expect(p.dimensionFirst).toBe("port12 (AP-1)");
    expect(p.dimensionList).toBe("port12 (AP-1)");
    expect(p.dimensionNoun).toBe("Interface");
  });

  it("names the whole set on a grouped alert, counting only active members", () => {
    const members = [
      member({ key: "port2", label: "port2", severity: "warning" }),
      member({ key: "port10", label: "port10", severity: "critical" }),
      member({ key: "port3", label: "port3", leftAt: NOW.toISOString() }),
    ];
    const p = readingContextParts(rule(), reading({ dimLabel: "port2" }), NOW, undefined, members);
    expect(p.dimension).toBe("port10, port2");
    expect(p.dimensionCount).toBe("2");
    expect(p.dimensionFirst).toBe("port10");
  });

  it("carries the composite summary in {metric} with no value or threshold", () => {
    const comp = rule({ trigger: { type: "composite", op: "and", children: [] } as never });
    const p = readingContextParts(comp, reading(), NOW, { summary: "CPU ≥ 90 (95) and Mem ≥ 80 (85)", conditions: "2 of 2 conditions met" });
    expect(p.metric).toBe("CPU ≥ 90 (95) and Mem ≥ 80 (85)");
    expect(p.value).toBe("");
    expect(p.threshold).toBe("");
    expect(p.conditions).toBe("2 of 2 conditions met");
    expect(readingContextParts(comp, reading(), NOW).metric).toBe("conditions met");
  });

  it("names a subnet-folded alert for its subnet", () => {
    const members = [member({ key: "", label: "h1", assetId: "a1", subnet: "Plant A (10.1.0.0/24)" })];
    const p = readingContextParts(rule(), reading(), NOW, undefined, members);
    expect(p.asset).toBe("Plant A (10.1.0.0/24)");
    expect(p.dimensionNoun).toBe("Devices");
  });

  it("counts the devices on an automation fold, preferring the true span count", () => {
    const members = [
      member({ key: "", label: "h1", assetId: "a1" }),
      member({ key: "", label: "h2", assetId: "a2" }),
      member({ key: "", label: "h1b", assetId: "a1" }),
    ];
    expect(readingContextParts(rule(), reading(), NOW, undefined, members).asset).toBe("2 devices");
    const counts = { devices: 80, checks: 0, automations: 1, pathOnly: false };
    expect(readingContextParts(rule(), reading(), NOW, undefined, members, counts).asset).toBe("80 devices");
  });

  it("makes a path-check split about the CHECK, with the device count as a suffix", () => {
    const members = [
      member({ key: "c1", label: "h1", assetId: "a1", component: "Salesforce HTTPS" }),
      member({ key: "c1", label: "h2", assetId: "a2", component: "Salesforce HTTPS" }),
    ];
    const p = readingContextParts(rule({ trigger: pathOkTrigger }), reading({ value: 0 }), NOW, undefined, members);
    expect(p.asset).toBe("Salesforce HTTPS");
    expect(p.dimensionSuffix).toBe(" · 2 devices");
    expect(p.conditionSuffix).toBe(" is down");
    expect(p.triggerSummary).toBe("Salesforce HTTPS is down from h1, h2");
  });

  it("names a multi-automation whole-group alert for the group", () => {
    const members = [
      member({ key: "", label: "h1", assetId: "a1", group: "Core" }),
      member({ key: "", label: "h2", assetId: "a2", group: "Core", ruleId: "r2" }),
    ];
    const counts = { devices: 2, checks: 0, automations: 2, pathOnly: false };
    const p = readingContextParts(rule(), reading(), NOW, undefined, members, counts);
    expect(p.ruleName).toBe("Core");
    expect(p.asset).toBe("2 automations");
    expect(p.dimensionSuffix).toBe(" · 2 devices");
    // With one automation in the group it is named for that automation.
    const one = readingContextParts(rule(), reading(), NOW, undefined, members, { ...counts, automations: 1 });
    expect(one.ruleName).toBe("High CPU");
  });
});

describe("followUpParts / applyFollowUpPolicy", () => {
  const repeating = rule({
    actions: [{ type: "notify", channelId: "c1" }] as never,
    repeat: { everyMin: 15, stopOn: "acknowledge" } as never,
  });

  it("wraps followUpPolicy's two sentences", () => {
    const p = followUpPolicy(repeating as never, "warning");
    expect(followUpParts(repeating, "warning")).toEqual({ repeatPolicy: p.repeat, escalationPolicy: p.escalation });
    expect(followUpParts(repeating, "warning").repeatPolicy).toMatch(/Reminders every 15 minutes/);
  });

  it("says nothing for a rule that neither repeats nor escalates", () => {
    expect(followUpParts(rule(), "warning")).toEqual({ repeatPolicy: "", escalationPolicy: "" });
  });

  it("applyFollowUpPolicy writes the same sentences in place and keeps the rest", () => {
    const parts = { asset: "x" } as never as Record<string, unknown>;
    applyFollowUpPolicy(parts as never, repeating, "warning");
    expect(parts.asset).toBe("x");
    expect(parts.repeatPolicy).toBe(followUpParts(repeating, "warning").repeatPolicy);
  });
});

describe("renderMessage", () => {
  const ctx = { asset: "core-sw1", metric: "cpuPct", value: "95", threshold: "90", rule: "High CPU" };

  it("renders the default single-reading sentence", () => {
    expect(renderMessage(rule(), reading(), ctx)).toBe("High CPU: core-sw1 — cpuPct = 95 (threshold 90)");
    expect(renderMessage(rule(), reading({ dimLabel: "port1" }), ctx)).toBe("High CPU: core-sw1 [port1] — cpuPct = 95 (threshold 90)");
  });

  it("renders the operator's own template when it has one, ignoring a blank one", () => {
    expect(renderMessage(rule({ messageTemplate: "{asset} is hot" }), reading(), ctx)).toBe("core-sw1 is hot");
    expect(renderMessage(rule({ messageTemplate: "   " }), reading(), ctx)).toBe("High CPU: core-sw1 — cpuPct = 95 (threshold 90)");
  });

  it("appends the dependency notice to a custom template (rule 78), once", () => {
    const depCtx = { ...ctx, "dependency.tag": "DEPENDENCY DOWN", "dependency.headline": "DEPENDENCY DOWN — upstream gw1" };
    const r = rule({ messageTemplate: "{asset} is down" });
    expect(renderMessage(r, reading({ dependencyDown: true }), depCtx)).toBe("core-sw1 is down — DEPENDENCY DOWN — upstream gw1");
    const own = rule({ messageTemplate: "{asset}: DEPENDENCY DOWN" });
    expect(renderMessage(own, reading({ dependencyDown: true }), depCtx)).toBe("core-sw1: DEPENDENCY DOWN");
    // Not dependency-down: nothing appended.
    expect(renderMessage(r, reading(), depCtx)).toBe("core-sw1 is down");
  });

  it("uses the whole dependency sentence by default on a dependency-down reading", () => {
    const depCtx = { ...ctx, "dependency.summary": "core-sw1 is unreachable because gw1 is down" };
    expect(renderMessage(rule(), reading({ dependencyDown: true }), depCtx)).toBe("High CPU: core-sw1 is unreachable because gw1 is down");
  });

  it("states a composite's met-conditions with no threshold artifacts", () => {
    const comp = rule({ trigger: { type: "composite", op: "and", children: [] } as never });
    expect(renderMessage(comp, reading(), { ...ctx, metric: "CPU and Mem", conditions: "2 of 2 conditions met" }))
      .toBe("High CPU: core-sw1 — CPU and Mem (2 of 2 conditions met)");
    expect(renderMessage(comp, reading(), { ...ctx, metric: "CPU and Mem" })).toBe("High CPU: core-sw1 — CPU and Mem");
  });

  it("does not repeat a core reading on a per-core CPU alert (rule 89)", () => {
    const core = rule({ trigger: { type: "asset_metric", metric: "cpuCorePct", operator: ">", threshold: 90 } as never });
    expect(renderMessage(core, reading({ dimLabel: "Core 3 (97%)" }), ctx)).toBe("High CPU: core-sw1 [Core 3 (97%)] (threshold 90)");
  });

  it("says a memory forecast's days until its next level", () => {
    const fc = { ...ctx, "forecast.level": "Serious", "forecast.days": "6" };
    expect(renderMessage(rule(), reading(), fc)).toBe("core-sw1 — Days until Serious: 6");
  });

  it("names a grouped alert's set and its size", () => {
    const members = [member({ key: "p1", label: "p1" }), member({ key: "p2", label: "p2" })];
    expect(renderMessage(rule(), reading(), ctx, members)).toBe("High CPU: core-sw1 [p1, p2] (2) — cpuPct = 95 (threshold 90)");
    const one = [member({ key: "p1", label: "p1" })];
    expect(renderMessage(rule(), reading(), ctx, one)).toBe("High CPU: core-sw1 [p1] — cpuPct = 95 (threshold 90)");
  });

  it("says how many devices in a subnet fold, with the dependency headline", () => {
    const members = [
      member({ key: "", label: "h1", assetId: "a1", subnet: "Plant A" }),
      member({ key: "", label: "h2", assetId: "a2", subnet: "Plant A" }),
    ];
    const sCtx = { ...ctx, asset: "Plant A", "dependency.headline": "DEPENDENCY DOWN" };
    expect(renderMessage(rule(), reading(), sCtx, members)).toBe("High CPU: 2 devices in Plant A — h1, h2");
    expect(renderMessage(rule(), reading({ dependencyDown: true }), sCtx, members)).toBe("High CPU: 2 devices in Plant A — h1, h2 — DEPENDENCY DOWN");
    expect(renderMessage(rule(), reading(), sCtx, [members[0]!])).toBe("High CPU: 1 device in Plant A — h1");
  });

  it("names an automation fold by its device count and list", () => {
    const members = [member({ key: "", label: "h1", assetId: "a1" }), member({ key: "", label: "h2", assetId: "a2" })];
    expect(renderMessage(rule(), reading(), { ...ctx, asset: "2 devices" }, members)).toBe("High CPU: 2 devices — h1, h2");
  });

  it("makes a path-check split's sentence about the check", () => {
    const members = [
      member({ key: "c1", label: "h1", assetId: "a1", component: "Salesforce HTTPS" }),
      member({ key: "c1", label: "h2", assetId: "a2", component: "Salesforce HTTPS" }),
    ];
    const pCtx = { ...ctx, asset: "Salesforce HTTPS", "dimension.suffix": " · 2 devices" };
    expect(renderMessage(rule({ trigger: pathOkTrigger }), reading(), pCtx, members))
      .toBe("Salesforce HTTPS is down from 2 devices — h1, h2");
  });

  it("leaves the device count blank on a path-check split whose context carries no count tag (current behaviour)", () => {
    // Suspicious, not pinned: with no `dimension.suffix` the sentence keeps an
    // empty slot where the device count would be.
    const members = [member({ key: "c1", label: "h1", assetId: "a1", component: "Salesforce HTTPS" })];
    expect(renderMessage(rule({ trigger: pathOkTrigger }), reading(), { ...ctx, asset: "Salesforce HTTPS" }, members))
      .toBe("High CPU — Salesforce HTTPS:  — h1");
  });

  it("speaks for a whole-group alert", () => {
    const members = [
      member({ key: "", label: "h1", assetId: "a1", group: "Core" }),
      member({ key: "", label: "h2", assetId: "a2", group: "Core" }),
    ];
    const gCtx = { ...ctx, rule: "Core", asset: "2 automations", "dimension.suffix": " · 2 devices" };
    expect(renderMessage(rule(), reading(), gCtx, members)).toBe("Core: 2 automations · 2 devices — h1, h2");
    const pathCounts = { devices: 80, checks: 3, automations: 2, pathOnly: true, condition: { one: "is down", many: "are down" } };
    const pgCtx = { ...gCtx, asset: "3 path checks", "dimension.suffix": " · 80 devices" };
    expect(renderMessage(rule(), reading(), pgCtx, members, pathCounts)).toBe("3 path checks are down from 80 devices — h1, h2");
  });
});

describe("ruleWantsContext / groupWantsContext", () => {
  it("is false for a bare rule", () => {
    expect(ruleWantsContext(rule())).toBe(false);
    expect(groupWantsContext(rule())).toBe(false);
  });

  it("is true for an email composition, any escalation chain, or any repeat", () => {
    expect(ruleWantsContext(rule({ emailComposition: { subjectTemplate: "x" } }))).toBe(true);
    expect(ruleWantsContext(rule({ escalation: { stopOn: "acknowledge", tiers: [{ afterMin: 5, actions: [{ type: "event" }] }] } as never }))).toBe(true);
    expect(ruleWantsContext(rule({ repeat: { everyMin: 15, stopOn: "acknowledge" } as never }))).toBe(true);
  });

  it("counts a repeat that lives only on one band's action", () => {
    const r = rule({
      severityBands: [{ severity: "critical", threshold: 99, actions: [{ type: "notify", channelId: "c", repeat: { everyMin: 5, stopOn: "acknowledge" } }] }] as never,
    });
    expect(ruleWantsContext(r)).toBe(true);
  });

  it("snapshots for any alert-group member", () => {
    expect(groupWantsContext(rule({ alertGroupId: "g1" }))).toBe(true);
  });
});

describe("ruleWantsAssetDetail / groupWantsAssetDetail", () => {
  it("is false for a rule with nothing that could quote the device", () => {
    expect(ruleWantsAssetDetail(rule())).toBe(false);
    expect(ruleWantsAssetDetail(rule({ actions: [{ type: "event" }] as never }))).toBe(false);
    expect(groupWantsAssetDetail(rule())).toBe(false);
  });

  it("is true for any notify action (the default email quotes the device)", () => {
    expect(ruleWantsAssetDetail(rule({ actions: [{ type: "notify", channelId: "c" }] as never }))).toBe(true);
  });

  it("is true for an {asset.*} token in the message or a script / api_call template", () => {
    expect(ruleWantsAssetDetail(rule({ messageTemplate: "{asset.ip} down" }))).toBe(true);
    expect(ruleWantsAssetDetail(rule({ actions: [{ type: "script", scriptId: "s", runOn: "server", argsTemplate: "{asset.hostname}" }] as never }))).toBe(true);
    expect(ruleWantsAssetDetail(rule({ actions: [{ type: "api_call", method: "POST", url: "https://x.example", bodyTemplate: "{asset.location}" }] as never }))).toBe(true);
    expect(ruleWantsAssetDetail(rule({ actions: [{ type: "script", scriptId: "s", runOn: "server", argsTemplate: "{asset}" }] as never }))).toBe(false);
  });

  it("is true whenever the rule wants the context snapshot", () => {
    expect(ruleWantsAssetDetail(rule({ emailComposition: { subjectTemplate: "{asset}" } }))).toBe(true);
  });

  it("is true for any alert-group member", () => {
    expect(groupWantsAssetDetail(rule({ alertGroupId: "g1" }))).toBe(true);
  });
});
