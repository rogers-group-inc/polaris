/**
 * tests/unit/streamFailingField.test.ts
 *
 * Business rule 118 — the two "polls failing (minutes)" asset-state fields and
 * the pure helpers behind them. The stamps themselves are written against a
 * real database (tests/integration/pollAttemptStamps.test.ts); what is pinned
 * here is the contract around the reading: the vocabulary, the arithmetic that
 * freezes when attempts stop, the hand-off to asset-down, the cadence it is
 * counted in and the sentence an alert reads.
 */

import { describe, it, expect } from "vitest";
import {
  ruleInputSchema,
  ASSET_STATE_FIELDS,
  FIELD_META,
  type Trigger,
} from "../../src/services/notificationTypes.js";
import { streamFailingMinutes, triggerHandsOffWhenDeviceDown } from "../../src/services/notificationEngine.js";
import { streamForMetric } from "../../src/services/notificationCadenceService.js";
import { pollFailureText, POLL_ERROR_MAX_LEN } from "../../src/services/monitoringService.js";
import { triggerSummary } from "../../src/utils/triggerSummary.js";
import { chartTokenForMetric } from "../../src/services/alertChartService.js";

const FIELDS = ["telemetryFailingMinutes", "systemInfoFailingMinutes"] as const;
const rule = (trigger: unknown) => ({ name: "r", scope: { allAssets: true }, trigger });
const at = (min: number) => new Date(Date.UTC(2026, 9, 14, 12, 0, 0) + min * 60_000);

describe("stream-failing state fields (rule 118)", () => {
  it("are numeric state fields the wizard renders", () => {
    for (const f of FIELDS) {
      expect(ASSET_STATE_FIELDS).toContain(f);
      expect(FIELD_META[f]).toMatchObject({ kind: "number" });
    }
  });

  it("accept an ordered comparison, alone and beside monitor status", () => {
    const single = { type: "asset_state", field: "telemetryFailingMinutes", operator: ">=", value: 60 };
    expect(ruleInputSchema.safeParse(rule(single)).success).toBe(true);
    const composite = {
      type: "composite", kind: "asset", op: "and",
      children: [single, { type: "asset_state", field: "monitorStatus", operator: "==", value: "up" }],
    };
    expect(ruleInputSchema.safeParse(rule(composite)).success).toBe(true);
  });

  it("count holds in their own stream's attempts", () => {
    expect(streamForMetric("telemetryFailingMinutes")).toBe("cpuMemory");
    expect(streamForMetric("systemInfoFailingMinutes")).toBe("systemInfo");
  });

  it("draw the CPU chart for CPU / memory, and the device default for interfaces", () => {
    expect(chartTokenForMetric("telemetryFailingMinutes")).toBe("chart.cpu");
    expect(chartTokenForMetric("systemInfoFailingMinutes")).toBeNull();
  });

  it("hand off to asset-down: a dark device is the outage, not a poll failure", () => {
    for (const field of FIELDS) {
      const t = { type: "asset_state", field, operator: ">=", value: 60 } as Trigger;
      expect(triggerHandsOffWhenDeviceDown(t)).toBe(true);
    }
  });

  it("read the stated sentence", () => {
    const trigger = { type: "asset_state", field: "telemetryFailingMinutes", operator: ">=", value: 60 };
    expect(triggerSummary({ trigger, value: 62 })).toBe("CPU & memory polls have been failing for 62 min");
    expect(triggerSummary({ trigger: { ...trigger, field: "systemInfoFailingMinutes" }, value: 75 }))
      .toBe("Interface polls have been failing for 75 min");
    expect(triggerSummary({ trigger, value: 0 })).toBe("CPU & memory polls are succeeding");
  });
});

describe("streamFailingMinutes", () => {
  it("has no reading for a stream never attempted", () => {
    expect(streamFailingMinutes(null, null)).toBeNull();
    expect(streamFailingMinutes(null, at(0))).toBeNull();
  });

  it("reads 0 while the stream is healthy", () => {
    expect(streamFailingMinutes(at(30), null)).toBe(0);
  });

  it("measures the run to the LATEST ATTEMPT, in whole minutes", () => {
    expect(streamFailingMinutes(at(0), at(0))).toBe(0);
    expect(streamFailingMinutes(at(59.9), at(0))).toBe(59);
    expect(streamFailingMinutes(at(60), at(0))).toBe(60);
  });

  it("freezes when attempts stop instead of climbing with the clock", () => {
    // Attempts last ran at minute 10; whatever "now" is, the reading is 10.
    expect(streamFailingMinutes(at(10), at(0))).toBe(10);
  });

  it("never reads negative on a clock that stepped backwards", () => {
    expect(streamFailingMinutes(at(0), at(5))).toBe(0);
  });
});

describe("pollFailureText", () => {
  it("keeps the collector's message, trimmed", () => {
    expect(pollFailureText("  connection refused (ECONNREFUSED) ", "x")).toBe("connection refused (ECONNREFUSED)");
  });

  it("falls back when the collector said nothing", () => {
    expect(pollFailureText(undefined, "The device returned no CPU / memory data")).toBe("The device returned no CPU / memory data");
    expect(pollFailureText("   ", "fallback")).toBe("fallback");
  });

  it("caps a long message so a thrown body cannot land in the column whole", () => {
    const out = pollFailureText("x".repeat(5000), "f");
    expect(out.length).toBe(POLL_ERROR_MAX_LEN);
    expect(out.endsWith("…")).toBe(true);
  });
});
