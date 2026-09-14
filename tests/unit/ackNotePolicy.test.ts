/**
 * tests/unit/ackNotePolicy.test.ts — the per-automation "acknowledging this
 * needs a note" policy (NotificationRule.requireAckNote).
 *
 * The flag is only worth anything if it is enforced where the WRITE happens:
 * three surfaces acknowledge (the Alerts tab, the mobile list, and the
 * acknowledge page an emailed or pushed Acknowledge button opens), and each
 * asks for the note in its own markup. So every required field is a courtesy
 * and acknowledgeNotifications' refusal is the control — which is what these
 * two pure helpers behind it pin down.
 */

import { describe, it, expect } from "vitest";
import { ackNoteProblem, withAckPolicy } from "../../src/services/notificationService.js";

describe("ackNoteProblem", () => {
  it("passes when nothing in the batch demands a note", () => {
    expect(ackNoteProblem(0, 5, "")).toBeNull();
  });

  it("passes when a note was supplied", () => {
    expect(ackNoteProblem(3, 5, "switch stack rebooted, replaced the SFP")).toBeNull();
  });

  it("treats a whitespace-only note as no note at all", () => {
    // The note is stored trimmed, so "   " would persist as NULL — accepting it
    // would satisfy the policy with nothing written.
    expect(ackNoteProblem(1, 1, "   \n\t ")).not.toBeNull();
  });

  it("names the single-alert case in the singular", () => {
    const msg = ackNoteProblem(1, 1, "");
    expect(msg).toMatch(/requires a note/);
    expect(msg).not.toMatch(/\d+ of these/);
  });

  it("reports how many of a batch demand one, not the batch size", () => {
    // The operator selected twelve rows; two of them come from an automation
    // that wants a note. Saying "12 alerts require a note" would be a lie they
    // can't act on.
    expect(ackNoteProblem(2, 12, "")).toMatch(/^2 of these alerts/);
  });

  it("refuses the whole batch rather than part of it", () => {
    // One shared note applies to every id in the request, so there is no
    // partial-success shape to report — and quietly acknowledging the
    // note-free half would leave the alerts that mattered open under a
    // success toast.
    expect(ackNoteProblem(1, 12, "")).not.toBeNull();
  });
});

describe("withAckPolicy", () => {
  const baseRule = { requireAckNote: true, severity: "warning", severityBands: null };

  it("flattens the joined rule into a plain boolean and drops the join", () => {
    const row = withAckPolicy({ id: "n1", message: "down", severity: "warning", rule: baseRule });
    expect(row.requireAckNote).toBe(true);
    expect("rule" in row).toBe(false);
    expect(row.id).toBe("n1");
  });

  it("reads false for a rule-less alert", () => {
    // A test fire (ruleId is always null) or an alert whose automation was
    // deleted (SetNull). There is no policy left to enforce, and refusing to
    // let anyone close those out would be worse than a missing note.
    expect(withAckPolicy({ id: "n2", severity: "warning", rule: null }).requireAckNote).toBe(false);
    expect(withAckPolicy({ id: "n3", severity: "warning" }).requireAckNote).toBe(false);
  });

  it("reads false for a rule that doesn't require one", () => {
    expect(withAckPolicy({ id: "n4", severity: "warning", rule: { ...baseRule, requireAckNote: false } }).requireAckNote).toBe(false);
  });

  it("answers for the severity the alert is SITTING at, not the rule's base", () => {
    // The point of the per-severity pair: a warning may close out with a click
    // while the same automation's critical demands the operator say what they
    // did. Reading the rule-level flag would let the critical through silently.
    const rule = {
      requireAckNote: false,
      severity: "warning",
      severityBands: [{ threshold: 95, severity: "critical", actions: [], followUp: { requireAckNote: true } }],
    };
    expect(withAckPolicy({ id: "n5", severity: "warning", rule }).requireAckNote).toBe(false);
    expect(withAckPolicy({ id: "n6", severity: "critical", rule }).requireAckNote).toBe(true);
  });

  it("a band that states nothing inherits the rule's answer", () => {
    // Every pre-feature banded automation is this row: bands exist, none of
    // them carries a followUp, and the rule's flag has to keep governing every
    // severity — otherwise the feature silently switched note-requiring
    // automations off at their higher tiers.
    const rule = {
      requireAckNote: true,
      severity: "warning",
      severityBands: [{ threshold: 95, severity: "critical", actions: [] }],
    };
    expect(withAckPolicy({ id: "n7", severity: "critical", rule }).requireAckNote).toBe(true);
  });

  it("a band CAN turn the requirement off where the rule turns it on", () => {
    const rule = {
      requireAckNote: true,
      severity: "warning",
      severityBands: [{ threshold: 95, severity: "critical", actions: [], followUp: { requireAckNote: false } }],
    };
    expect(withAckPolicy({ id: "n8", severity: "critical", rule }).requireAckNote).toBe(false);
    expect(withAckPolicy({ id: "n9", severity: "warning", rule }).requireAckNote).toBe(true);
  });

  it("survives a severityBands column it cannot parse", () => {
    // parseSeverityBands drops what a schema change has outgrown rather than
    // throwing — an alert must stay acknowledgeable when its automation's JSON
    // is from a newer shape.
    const rule = { requireAckNote: true, severity: "warning", severityBands: "not-an-array" };
    expect(withAckPolicy({ id: "n10", severity: "critical", rule }).requireAckNote).toBe(true);
  });
});
