/**
 * tests/unit/operationResultEmailLayout.test.ts — the shared layout of the
 * firmware (rule 93) and reboot (rule 115) operation emails. The byte-for-byte
 * pin of both templates is operationResultEmailGolden.test.ts; this covers the
 * layout's own helpers.
 */

import { describe, it, expect } from "vitest";
import {
  OPERATION_LOG_TAIL, OPERATION_SUBJECT_VERB, bookingWarnLine, operationDuration, renderOperationEmailLayout,
} from "../../src/utils/operationResultEmailLayout.js";

describe("operationDuration", () => {
  it("formats finished − started", () => {
    expect(operationDuration("2026-11-09T10:00:00Z", "2026-11-09T10:06:00Z")).toBe("6m");
  });
  it("is null when either end is missing or the span is negative", () => {
    expect(operationDuration(null, "2026-11-09T10:06:00Z")).toBeNull();
    expect(operationDuration("2026-11-09T10:00:00Z", null)).toBeNull();
    expect(operationDuration("2026-11-09T10:06:00Z", "2026-11-09T10:00:00Z")).toBeNull();
  });
});

describe("bookingWarnLine", () => {
  it("names the blockers on a scheduled / rescheduled notice, with the noun", () => {
    expect(bookingWarnLine("scheduled", ["a", "b"], "reboot")).toBe(
      "Right now a; b. That is checked again when the reboot is due; if it still holds then, the reboot is not started and you are told why.",
    );
    expect(bookingWarnLine("rescheduled", ["a"], "upgrade")).toContain("when the upgrade is due");
  });
  it("is null for any other outcome, or with no warnings", () => {
    expect(bookingWarnLine("started", ["a"], "reboot")).toBeNull();
    expect(bookingWarnLine("scheduled", [], "reboot")).toBeNull();
    expect(bookingWarnLine("scheduled", undefined, "reboot")).toBeNull();
  });
});

describe("renderOperationEmailLayout", () => {
  const base = {
    label: "Scheduled reboot",
    headline: { label: "Reboot failed", color: "#b91c1c" },
    summary: "It <failed>.",
    warnLine: null,
    facts: [["Device", "sw<1>"], ["Started by", "a@b"]] as Array<[string, string]>,
    url: "https://p.example/assets/x",
    log: Array.from({ length: OPERATION_LOG_TAIL + 3 }, (_, i) => ({ t: "2026-11-09T10:00:00Z", level: "info", msg: `m${i}` })),
    zone: "UTC",
  };

  it("links the first fact to the device and escapes HTML", () => {
    const { text, html } = renderOperationEmailLayout(base);
    expect(html).toContain('<a href="https://p.example/assets/x" style="color:#1d4ed8;text-decoration:none">sw&lt;1&gt;</a>');
    expect(html).toContain("It &lt;failed&gt;.");
    expect(text).toContain("Open the device: https://p.example/assets/x");
    expect(text.endsWith("Sent by Polaris · scheduled reboot")).toBe(true);
  });

  it("names the device without a link when there is no public URL", () => {
    const { text, html } = renderOperationEmailLayout({ ...base, url: null });
    expect(html).not.toContain("<a href");
    expect(text).not.toContain("Open the device");
  });

  it("carries only the last OPERATION_LOG_TAIL log lines, and no log section when empty", () => {
    const { text } = renderOperationEmailLayout(base);
    expect(text).toContain(`RUN LOG (last ${OPERATION_LOG_TAIL} lines)`);
    expect(text).not.toContain("m2\n");
    expect(text).toContain(`m${OPERATION_LOG_TAIL + 2}`);
    expect(renderOperationEmailLayout({ ...base, log: [] }).text).not.toContain("RUN LOG");
  });

  it("has one subject verb per outcome", () => {
    expect(OPERATION_SUBJECT_VERB.failed).toBe("FAILED");
    expect(Object.keys(OPERATION_SUBJECT_VERB).sort()).toEqual(["failed", "missed", "refused", "started", "succeeded", "unverified"]);
  });
});
