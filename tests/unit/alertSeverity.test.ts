/**
 * tests/unit/alertSeverity.test.ts
 *
 * The one alert-severity ladder: notice < informational(=info) < warning <
 * serious < critical(=error); unrecognized ranks 0; ties keep the incumbent.
 */

import { describe, it, expect } from "vitest";
import { ALERT_SEVERITY_RANK, alertSeverityRank, higherAlertSeverity } from "../../src/utils/alertSeverity.js";

describe("alertSeverityRank", () => {
  it("orders the automation ladder", () => {
    const ladder = ["notice", "informational", "warning", "serious", "critical"].map(alertSeverityRank);
    expect(ladder).toEqual([1, 2, 3, 4, 5]);
  });

  it("ranks the legacy levels with their modern equivalents", () => {
    expect(alertSeverityRank("info")).toBe(alertSeverityRank("informational"));
    expect(alertSeverityRank("error")).toBe(alertSeverityRank("critical"));
  });

  it("ranks absent or unknown values 0 instead of throwing", () => {
    expect(alertSeverityRank(null)).toBe(0);
    expect(alertSeverityRank(undefined)).toBe(0);
    expect(alertSeverityRank("")).toBe(0);
    expect(alertSeverityRank("apocalyptic")).toBe(0);
  });

  // Was a bug until 2026-11-12 (CQ-T012): the plain-object lookup answered inherited members.
  it("ranks Object.prototype member names 0 (they are unrecognized severities)", () => {
    expect(alertSeverityRank("toString")).toBe(0);
    expect(alertSeverityRank("constructor")).toBe(0);
  });

  it("is case-sensitive (the stored vocabulary is lower-case)", () => {
    expect(alertSeverityRank("CRITICAL")).toBe(0);
  });

  it("exposes the same map it ranks with", () => {
    expect(ALERT_SEVERITY_RANK.serious).toBe(4);
  });
});

describe("higherAlertSeverity", () => {
  it("returns the more severe", () => {
    expect(higherAlertSeverity("warning", "critical")).toBe("critical");
    expect(higherAlertSeverity("serious", "notice")).toBe("serious");
  });

  it("keeps the incumbent on a tie", () => {
    expect(higherAlertSeverity("error", "critical")).toBe("error");
    expect(higherAlertSeverity("info", "informational")).toBe("info");
  });

  it("falls back to whichever side is present", () => {
    expect(higherAlertSeverity(null, "warning")).toBe("warning");
    expect(higherAlertSeverity("warning", undefined)).toBe("warning");
    expect(higherAlertSeverity(null, null)).toBeNull();
    expect(higherAlertSeverity("", undefined)).toBeNull();
  });

  it("an unknown severity never out-ranks a known one", () => {
    expect(higherAlertSeverity("notice", "mystery")).toBe("notice");
    expect(higherAlertSeverity("mystery", "notice")).toBe("notice");
  });
});
