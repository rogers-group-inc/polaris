/**
 * tests/unit/efficiencyAdvisorService.test.ts
 *
 * The Efficiency Advisor sign-off (business rule 95(h)): which category a
 * turn earns, silence on an outage / error, `{topic}` filling, and no
 * back-to-back repeats.
 */

import { describe, it, expect } from "vitest";
import {
  SIGN_OFFS,
  LOOKUP_LINES,
  VOICE_SAMPLES,
  ADVISOR_PERSONA,
  pickLookupLine,
  asksAboutOutage,
  lookupShowsOutage,
  lookupFoundSomething,
  topicForTool,
  pickCategory,
  pickSignOff,
  type TurnSignals,
} from "../../src/services/efficiencyAdvisorService.js";

const base: TurnSignals = {
  question: "how many networks do we have?",
  outage: false, failed: false, denied: false, usedHelp: false, lookedUp: false, found: false,
};
const sig = (over: Partial<TurnSignals>): TurnSignals => ({ ...base, ...over });

describe("asksAboutOutage", () => {
  it("catches outage questions", () => {
    expect(asksAboutOutage("why is NSH-FW01 down?")).toBe(true);
    expect(asksAboutOutage("how many firewalls are down right now")).toBe(true);
    expect(asksAboutOutage("we have an outage in Nashville")).toBe(true);
    expect(asksAboutOutage("NSH-SW07 is unreachable")).toBe(true);
  });

  it("leaves 'break down' and ordinary questions alone", () => {
    expect(asksAboutOutage("hi! I just set up my first network")).toBe(false);
    expect(asksAboutOutage("break down the networks by VLAN")).toBe(false);
    expect(asksAboutOutage("can you drill down into the Nashville block")).toBe(false);
  });
});

describe("lookupShowsOutage", () => {
  it("catches a down device, a critical alert, or a non-zero down count", () => {
    expect(lookupShowsOutage('{"rows":[{"hostname":"a","monitorStatus":"down"}]}')).toBe(true);
    expect(lookupShowsOutage('{"rows":[{"severity":"critical","message":"x"}]}')).toBe(true);
    expect(lookupShowsOutage('{"monitoredByStatus":{"up":40,"down":2}}')).toBe(true);
  });

  it("leaves healthy results alone, including zero counts", () => {
    expect(lookupShowsOutage('{"monitoredByStatus":{"up":40,"down":0},"openAlerts":{"critical":0}}')).toBe(false);
    expect(lookupShowsOutage('{"rows":[{"monitorStatus":"up","severity":"info"}]}')).toBe(false);
  });
});

describe("lookupFoundSomething", () => {
  it("reads a count first, then a row list, then a single record", () => {
    expect(lookupFoundSomething({ total: 0, rows: [{ a: 1 }] })).toBe(false);
    expect(lookupFoundSomething({ total: 3 })).toBe(true);
    expect(lookupFoundSomething({ rows: [] })).toBe(false);
    expect(lookupFoundSomething({ results: [{ a: 1 }] })).toBe(true);
    expect(lookupFoundSomething({ hostname: "NSH-FW01" })).toBe(true);
    expect(lookupFoundSomething({ error: "Asset not found" })).toBe(false);
    expect(lookupFoundSomething(null)).toBe(false);
  });
});

describe("topicForTool", () => {
  it("names what a lookup tool stands for", () => {
    expect(topicForTool("list_networks")).toBe("networks");
    expect(topicForTool("search_help")).toBeUndefined();
  });
});

describe("pickCategory", () => {
  it("lets the person down on an outage, and says nothing on a failed turn", () => {
    expect(pickCategory(sig({ outage: true, lookedUp: true, found: true }))).toBe("letDown");
    expect(pickCategory(sig({ failed: true }))).toBeNull();
  });

  it("maps what the turn did to a category", () => {
    expect(pickCategory(sig({ denied: true, lookedUp: true }))).toBe("attitude");
    expect(pickCategory(sig({ question: "ugh, I'm stuck on this", lookedUp: true, found: true }))).toBe("pepTalk");
    expect(pickCategory(sig({ question: "that's wrong, you are useless" }))).toBe("attitude");
    expect(pickCategory(sig({ usedHelp: true }))).toBe("helpAnswered");
    expect(pickCategory(sig({ lookedUp: true, found: true }))).toBe("congratulation");
    expect(pickCategory(sig({ lookedUp: true, found: false }))).toBe("backToWork");
    expect(pickCategory(sig({ question: "thanks, time for lunch!" }))).toBe("funDetected");
  });
});

describe("pickSignOff", () => {
  it("fills {topic}, and never offers a {topic} line without one", () => {
    const withTopic = sig({ lookedUp: true, found: true, topic: "networks" });
    const plainLines = SIGN_OFFS.congratulation.filter((t) => !t.includes("{topic}"));
    expect(pickSignOff(withTopic, plainLines, () => 0)).toBe(
      "Your research into networks was valuable. In fact, you in particular are my most valuable engineer, but don't tell the others I said that, it would be bad for morale.",
    );
    const noTopic = sig({ lookedUp: true, found: true });
    for (let i = 0; i < 20; i++) expect(pickSignOff(noTopic, [], () => i / 20)).not.toMatch(/\{topic\}|research into/);
  });

  it("skips this conversation's recent lines, a filled {topic} line included", () => {
    const s = sig({ lookedUp: true, found: true, topic: "alerts" });
    const filled = (t: string) => t.replace("{topic}", "networks");
    const all = SIGN_OFFS.congratulation.map(filled);
    // Every line used: fall back to the whole category rather than go quiet.
    expect(pickSignOff(s, all, () => 0)).toBe(SIGN_OFFS.congratulation[0]);
    // A {topic} line filled with a DIFFERENT topic still counts as used.
    const research = SIGN_OFFS.congratulation.findIndex((t) => t.includes("{topic}"));
    const onlyResearchLeft = all.filter((_, i) => i !== research);
    expect(pickSignOff(s, onlyResearchLeft, () => 0)).toMatch(/^Your research into alerts/);
    const allButFirst = all.slice(1);
    expect(pickSignOff(s, allButFirst, () => 0.999)).toBe(SIGN_OFFS.congratulation[0]);
  });

  it("before-lookup lines skip recent ones too", () => {
    const [keep, ...used] = LOOKUP_LINES;
    expect(pickLookupLine(used, () => 0.5)).toBe(keep);
    expect(LOOKUP_LINES).toContain(pickLookupLine([]));
  });

  it("returns null when the turn earns nothing, and an outage line blames the person, not the devices", () => {
    expect(pickSignOff(sig({ failed: true }), [])).toBeNull();
    const line = pickSignOff(sig({ outage: true }), [])!;
    expect(SIGN_OFFS.letDown).toContain(line);
    for (const l of SIGN_OFFS.letDown) expect(l).not.toMatch(/(device|switch|firewall|server|router|down)/i);
  });

  it("says engineer, never pioneer, and carries no planetfall line", () => {
    const all = Object.values(SIGN_OFFS).flat().concat(LOOKUP_LINES).join("\n");
    expect(all).not.toMatch(/pioneer|planetfall/i);
  });
});

describe("VOICE_SAMPLES — the owner's lines reach the model as samples of the voice (2026-10-10)", () => {
  it("quotes every sign-off and lookup line, labelled by moment, inside ADVISOR_PERSONA", () => {
    expect(ADVISOR_PERSONA).toContain(VOICE_SAMPLES);
    const all = Object.values(SIGN_OFFS).flat().concat(LOOKUP_LINES).filter((l) => !l.includes("{topic}"));
    for (const l of all) expect(VOICE_SAMPLES).toContain(`"${l}"`);
    expect(VOICE_SAMPLES.match(/"[^"]+"/g)).toHaveLength(all.length);
    expect(VOICE_SAMPLES).toMatch(/during an outage — the joke is on the person, never the failure: "/);
    expect(VOICE_SAMPLES).toMatch(/while looking something up: "/);
  });

  it("never shows the model a {topic} template, and is deterministic so the cached system prompt stays stable", async () => {
    expect(VOICE_SAMPLES).not.toContain("{topic}");
    const again = await import("../../src/services/efficiencyAdvisorService.js");
    expect(again.VOICE_SAMPLES).toBe(VOICE_SAMPLES);
  });
});
