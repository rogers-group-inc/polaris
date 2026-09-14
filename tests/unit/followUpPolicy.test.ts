/**
 * tests/unit/followUpPolicy.test.ts
 *
 * followUpPolicy turns an automation's repeat + escalation config into the two
 * sentences an ALERT carries — the "what happens if you do nothing" line in the
 * email's facts table and at the foot of the push body.
 *
 * It is pure and severity-resolved, and both of those matter: a banded alert
 * must advertise its OWN band's escalation, and the strings are snapshotted
 * into Notification.templateCtx at fire time so a reminder of the same alert
 * cannot describe it differently from the original.
 */

import { describe, it, expect } from "vitest";
import { followUpPolicy } from "../../src/services/notificationTypes.js";
import { followUpLine } from "../../src/utils/notificationTemplate.js";

const notify = (channelId = "c1") => ({ type: "notify" as const, channelId, addresses: ["noc@example.com"] });

/** Minimal carrier — the shape the engine's DbRule satisfies. */
function rule(over: Record<string, unknown> = {}): never {
  return {
    severity: "warning",
    actions: [notify()],
    escalation: null,
    severityBands: null,
    bandNotify: null,
    resetActions: null,
    repeat: null,
    ...over,
  } as never;
}

describe("followUpPolicy — repeat", () => {
  it("says nothing at all when the automation neither repeats nor escalates", () => {
    // "" rather than "none": the default email prunes an empty row away, so a
    // one-shot alert stays exactly the email it always was. Saying "Reminders:
    // none" would add a line to every alert to convey the absence of a feature.
    expect(followUpPolicy(rule(), "warning")).toEqual({ repeat: "", escalation: "" });
  });

  it("states the interval and what stops it", () => {
    const p = followUpPolicy(rule({ repeat: { everyMin: 15, stopOn: "acknowledge" } }), "warning");
    expect(p.repeat).toBe("Reminders every 15 minutes until acknowledged.");
  });

  it("uses the operator's own word when only a clear stops it", () => {
    // stopOn "clear" ignores acknowledgement entirely — telling the reader
    // "until acknowledged" would be a promise the sweep does not keep.
    const p = followUpPolicy(rule({ repeat: { everyMin: 30, stopOn: "clear" } }), "warning");
    expect(p.repeat).toBe("Reminders every 30 minutes until cleared.");
  });

  it("states the give-up cut-off, which is the difference between chased and not", () => {
    const p = followUpPolicy(
      rule({ repeat: { everyMin: 60, stopOn: "acknowledge", stopAfterHours: 8 } }),
      "warning",
    );
    expect(p.repeat).toBe("Reminders every 1 hour until acknowledged, for up to 8 hours.");
  });

  it("reads whole hours as hours, because that is how they were configured", () => {
    const p = followUpPolicy(rule({ repeat: { everyMin: 120, stopOn: "acknowledge" } }), "warning");
    expect(p.repeat).toContain("every 2 hours");
  });

  it("singularizes one minute and one hour", () => {
    expect(followUpPolicy(rule({ repeat: { everyMin: 1, stopOn: "clear" } }), "warning").repeat)
      .toContain("every 1 minute ");
    expect(followUpPolicy(rule({ repeat: { everyMin: 5, stopOn: "clear", stopAfterHours: 1 } }), "warning").repeat)
      .toContain("for up to 1 hour.");
  });

  it("advertises the BAND's cadence, not the rule's, once a band states one", () => {
    // Same reason the escalation half is severity-resolved: the sentence is
    // read by whoever is holding the phone for THIS alert, and a critical that
    // promised the warning tier's hourly reminder would be describing a chase
    // that isn't coming.
    const banded = rule({
      repeat: { everyMin: 60, stopOn: "acknowledge" },
      severityBands: [{
        threshold: 95, severity: "critical", actions: [],
        followUp: { requireAckNote: false, repeat: { everyMin: 5, stopOn: "clear" } },
      }],
    });
    expect(followUpPolicy(banded, "warning").repeat).toBe("Reminders every 1 hour until acknowledged.");
    expect(followUpPolicy(banded, "critical").repeat).toBe("Reminders every 5 minutes until cleared.");
  });

  it("a band that repeats where the rule does not says so only at that severity", () => {
    const banded = rule({
      repeat: null,
      severityBands: [{
        threshold: 95, severity: "critical", actions: [],
        followUp: { requireAckNote: false, repeat: { everyMin: 10, stopOn: "acknowledge" } },
      }],
    });
    expect(followUpPolicy(banded, "warning").repeat).toBe("");
    expect(followUpPolicy(banded, "critical").repeat).toBe("Reminders every 10 minutes until acknowledged.");
  });

  it("a band that declares NO reminders silences the rule's at that severity", () => {
    // `repeat: null` inside a followUp is an answer, not an absence — that is
    // the distinction the followUp wrapper exists to carry.
    const banded = rule({
      repeat: { everyMin: 15, stopOn: "acknowledge" },
      severityBands: [{
        threshold: 95, severity: "critical", actions: [],
        followUp: { requireAckNote: true, repeat: null },
      }],
    });
    expect(followUpPolicy(banded, "warning").repeat).toContain("every 15 minutes");
    expect(followUpPolicy(banded, "critical").repeat).toBe("");
  });

  it("a band with no followUp keeps inheriting the rule's reminders", () => {
    const banded = rule({
      repeat: { everyMin: 15, stopOn: "acknowledge" },
      severityBands: [{ threshold: 95, severity: "critical", actions: [] }],
    });
    expect(followUpPolicy(banded, "critical").repeat).toContain("every 15 minutes");
  });
});

describe("followUpPolicy — escalation", () => {
  const chain = (afterMin: number, stopOn = "acknowledge") => ({
    stopOn,
    tiers: [{ afterMin, actions: [notify()] }],
  });

  it("states when the alert goes over the reader's head", () => {
    const p = followUpPolicy(rule({ escalation: chain(30) }), "warning");
    expect(p.escalation).toBe("Escalates in 30 minutes if not acknowledged.");
  });

  it("counts the remaining steps when a chain has more than one tier", () => {
    const p = followUpPolicy(
      rule({ escalation: { stopOn: "acknowledge", tiers: [
        { afterMin: 15, actions: [notify()] },
        { afterMin: 60, actions: [notify()] },
        { afterMin: 240, actions: [notify()] },
      ] } }),
      "warning",
    );
    expect(p.escalation).toBe("Escalates in 15 minutes if not acknowledged, then through 2 more steps.");
  });

  it("reports the EARLIEST tier across every chain that applies", () => {
    // Rule-level and per-action chains run independently, so the honest answer
    // to "when does this leave my hands" is whichever fires first — not the
    // rule-level one just because it is listed first.
    const p = followUpPolicy(
      rule({
        escalation: chain(60),
        actions: [{ ...notify(), escalation: chain(10) }],
      }),
      "warning",
    );
    expect(p.escalation).toBe("Escalates in 10 minutes if not acknowledged, then through 1 more step.");
  });

  it("resolves the BAND's chain, not the rule's, for a banded alert", () => {
    // A critical alert advertising the warning tier's escalation would be
    // describing a chain that is not the one about to run.
    const banded = rule({
      severity: "warning",
      escalation: chain(60),
      severityBands: [
        { threshold: 90, severity: "critical", actions: [notify()], escalation: chain(5) },
      ],
    });
    expect(followUpPolicy(banded, "critical").escalation).toContain("in 5 minutes");
    expect(followUpPolicy(banded, "warning").escalation).toContain("in 1 hour");
  });

  it("is empty when the automation has no escalation at all", () => {
    expect(followUpPolicy(rule({ repeat: { everyMin: 15, stopOn: "acknowledge" } }), "warning").escalation).toBe("");
  });
});

describe("followUpLine", () => {
  it("joins both sentences for surfaces with no facts table", () => {
    const ctx = {
      "repeat.policy": "Reminders every 15 minutes until acknowledged.",
      "escalation.policy": "Escalates in 30 minutes if not acknowledged.",
    };
    expect(followUpLine(ctx)).toBe(
      "Reminders every 15 minutes until acknowledged. Escalates in 30 minutes if not acknowledged.",
    );
  });

  it("carries whichever half exists, with no stray separator", () => {
    expect(followUpLine({ "repeat.policy": "A.", "escalation.policy": "" })).toBe("A.");
    expect(followUpLine({ "repeat.policy": "", "escalation.policy": "B." })).toBe("B.");
  });

  it("is empty when neither applies, which is what leaves a push body untouched", () => {
    expect(followUpLine({ "repeat.policy": "", "escalation.policy": "" })).toBe("");
    expect(followUpLine({})).toBe("");
  });
});
