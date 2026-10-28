/**
 * tests/unit/priorityTags.test.ts — business rule 136's shared vocabulary.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

import {
  PRIORITY_TAGS,
  PRIORITY_TAG_CATEGORY,
  priorityTagColor,
  builtInPriorityTag,
  prioritySeverityOf,
} from "../../src/utils/priorityTags.js";
import {
  SEVERITIES,
  priorityTagSubjectOf,
  ruleInputSchema,
  buildSchemaCatalog,
} from "../../src/services/notificationTypes.js";

describe("PRIORITY_TAGS", () => {
  it("is one tag per severity, in SEVERITIES order", () => {
    expect(PRIORITY_TAGS.map((p) => p.severity)).toEqual([...SEVERITIES]);
  });

  it("names the seeded tags in the Priority category", () => {
    expect(PRIORITY_TAGS.map((p) => p.name)).toEqual(["Notice", "Informational", "Warning", "Serious", "Critical"]);
    expect(PRIORITY_TAG_CATEGORY).toBe("Priority");
    expect(priorityTagColor("critical")).toBe("severity:critical");
  });

  it("recognises a built-in name only in its seeded spelling", () => {
    expect(builtInPriorityTag("Critical")?.severity).toBe("critical");
    expect(builtInPriorityTag("critical")).toBeNull();
    expect(builtInPriorityTag("P1")).toBeNull();
  });
});

describe("severityFromPriorityTag on a rule (rule 136(e))", () => {
  const rule = (trigger: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ruleInputSchema.safeParse({ name: "r", trigger, severityFromPriorityTag: true, ...extra });

  it("names the subject whose tag decides", () => {
    expect(priorityTagSubjectOf({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down" })).toBe("device");
    expect(priorityTagSubjectOf({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" })).toBe("interface");
    expect(priorityTagSubjectOf({ type: "asset_state", field: "monitorStatus", operator: "!=", value: "down" })).toBeNull();
    expect(priorityTagSubjectOf({ type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 })).toBeNull();
    expect(priorityTagSubjectOf({ type: "composite", op: "or", children: [] })).toBeNull();
  });

  it("saves on monitor status is down and interface oper status is down", () => {
    expect(rule({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down" }).success).toBe(true);
    expect(rule({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" }).success).toBe(true);
  });

  it("is refused on any other trigger", () => {
    const bad = rule({ type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/Priority tag/);
  });

  it("is refused beside severity bands", () => {
    const bad = rule(
      { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 80 },
      { severityBands: [{ threshold: 90, severity: "critical", actions: [] }] },
    );
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toMatch(/not both/);
  });

  it("is published to the wizard with the tag ladder", () => {
    const meta = buildSchemaCatalog().prioritySeverity;
    expect(meta.triggers.map((t) => t.subject)).toEqual(["device", "interface"]);
    expect(meta.tags.map((t) => t.name)).toEqual(PRIORITY_TAGS.map((p) => p.name));
  });
});

describe("prioritySeverityOf", () => {
  it("is null with no Priority tag", () => {
    expect(prioritySeverityOf([])).toBeNull();
    expect(prioritySeverityOf(null)).toBeNull();
    expect(prioritySeverityOf(["prod", "uplink"])).toBeNull();
  });

  it("reads one Priority tag, case-insensitively", () => {
    expect(prioritySeverityOf(["prod", "Warning"])).toBe("warning");
    expect(prioritySeverityOf(["critical"])).toBe("critical");
  });

  it("takes the HIGHEST when a device carries several", () => {
    expect(prioritySeverityOf(["Warning", "Critical", "Notice"])).toBe("critical");
    expect(prioritySeverityOf(["Informational", "Serious"])).toBe("serious");
  });
});
