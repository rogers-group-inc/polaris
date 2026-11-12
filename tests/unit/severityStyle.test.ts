/**
 * tests/unit/severityStyle.test.ts
 *
 * Off-browser severity colours (Teams cards, alert emails) and the separate
 * "down drawn in its severity" palette. downSeverityColor.test.ts covers the
 * down palette's parity with public/js/chart-severity.js; this pins the alert
 * palette and the fallbacks.
 */

import { describe, it, expect } from "vitest";
import { severityHex, severityCss, downSeverityHex, downSeverityCss } from "../../src/utils/severityStyle.js";

describe("severityHex / severityCss", () => {
  it("colours every notification severity and the recovery pseudo-severity", () => {
    expect(severityHex("notice")).toBe("6b7280");
    expect(severityHex("informational")).toBe("2563eb");
    expect(severityHex("warning")).toBe("d97706");
    expect(severityHex("serious")).toBe("ea580c");
    expect(severityHex("critical")).toBe("dc2626");
    expect(severityHex("resolved")).toBe("16a34a");
  });

  it("paints the legacy levels like their modern equivalents", () => {
    expect(severityHex("info")).toBe(severityHex("informational"));
    expect(severityHex("error")).toBe(severityHex("critical"));
  });

  it("falls back to grey for absent or unknown severities, without a '#'", () => {
    expect(severityHex(null)).toBe("808080");
    expect(severityHex(undefined)).toBe("808080");
    expect(severityHex("bogus")).toBe("808080");
    expect(severityHex("critical")).not.toMatch(/^#/);
  });

  it("severityCss adds the '#'", () => {
    expect(severityCss("critical")).toBe("#dc2626");
    expect(severityCss(null)).toBe("#808080");
  });

  // Was a bug until 2026-11-12 (CQ-T012): the plain-object lookup answered inherited members.
  it("falls back for Object.prototype member names too", () => {
    expect(severityHex("constructor")).toBe("808080");
    expect(downSeverityHex("toString")).toBe(downSeverityHex("critical"));
  });
});

describe("downSeverityHex / downSeverityCss", () => {
  it("is deliberately a different palette from the alert colours", () => {
    for (const s of ["notice", "informational", "warning", "serious", "critical"]) {
      expect(downSeverityHex(s)).not.toBe(severityHex(s));
    }
  });

  it("falls back to the critical red (what Down has always been)", () => {
    expect(downSeverityHex(null)).toBe("d32f2f");
    expect(downSeverityHex("resolved")).toBe("d32f2f");
    expect(downSeverityCss("unknown")).toBe("#d32f2f");
    expect(downSeverityCss("warning")).toBe("#f9a825");
  });
});
