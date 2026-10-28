/**
 * tests/unit/priorityTags.test.ts — business rule 136's shared vocabulary.
 */

import { describe, it, expect } from "vitest";
import {
  PRIORITY_TAGS,
  PRIORITY_TAG_CATEGORY,
  priorityTagColor,
  builtInPriorityTag,
  prioritySeverityOf,
} from "../../src/utils/priorityTags.js";
import { SEVERITIES } from "../../src/services/notificationTypes.js";

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
