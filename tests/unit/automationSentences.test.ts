/**
 * tests/unit/automationSentences.test.ts — the automation wizard's sentence
 * builder, the live English rendering of a draft rule's trigger + reset that
 * operators read on steps 3/4/6. Extracted from openAutomationWizard as a
 * pure factory over the /automations/schema payload (2026-08); evaluated here
 * in a Node vm with a stub window — same idiom as appmapFilter.test.ts.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import vm from "node:vm";

interface Ladder { severity?: string; severityBands?: Array<Record<string, unknown>> | null }

let make: (s: Record<string, unknown>) => {
  triggerSentence: (tr: Record<string, unknown> | null, opts?: Ladder) => string;
  triggerFormula: (tr: Record<string, unknown> | null, opts?: Ladder) => { lines: string[]; note: string };
  resetSentence: (reset: Record<string, unknown> | null, tr: Record<string, unknown> | null) => string;
  humanDuration: (sec: number) => string;
  compactDuration: (sec: number) => string;
  leafUnit: (metric: string, df?: Record<string, string>) => string;
  isTriggerScoped: (tr: Record<string, unknown> | null) => boolean;
  invertedLeaf: (tr: Record<string, unknown> | null, reset?: Record<string, unknown>) => Record<string, unknown> | null;
  invertedTree: (node: Record<string, unknown> | null) => Record<string, unknown> | null;
};

beforeAll(() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../public/js/automations-wizard.js");
  const code = readFileSync(file, "utf8");
  const sandbox: Record<string, any> = {
    window: {},
    document: { addEventListener() {}, getElementById: () => null },
    // Globals the wizard file references at call time; the sentence factory
    // itself needs only escapeHtml.
    escapeHtml: (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    api: {},
    permAtLeast: () => true,
    showToast: () => {},
  };
  sandbox.window.document = sandbox.document;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  make = sandbox.window.PolarisAutomationSentences.make;
});

// Minimal schema slice — the factory falls back to built-in phrase tables for
// everything the schema doesn't supply, which is also worth pinning.
const SCHEMA = {
  triggerTypes: [
    { type: "asset_metric", label: "Device metric", scoped: true },
    { type: "host_metric", label: "Host metric", scoped: false },
    { type: "asset_state", label: "Device state", scoped: true },
    { type: "event", label: "Audit event match", scoped: true },
    { type: "change", label: "Change detection", scoped: false },
    { type: "composite", label: "Multiple conditions", scoped: true },
  ],
  metricMeta: {
    cpuPct: { label: "CPU usage", unit: "%" },
    hwSensorValue: { label: "Hardware sensor", unit: "(sensor unit)" },
  },
  sensorClassUnits: { temperature: "°C", fan: "RPM" },
  fieldMeta: { monitorStatus: { label: "Monitor status", kind: "enum", values: ["up", "warning", "recovering", "down", "passive", "unknown"] } },
  downDetection: { field: "monitorStatus", operator: "==", value: "down", countKey: "missedPolls", min: 1, max: 100, default: 3, passiveStatus: "passive" },
  changeTypeMeta: { new_asset: "a new device" },
};

describe("makeAutomationSentences", () => {
  it("renders a metric trigger with aggregation window, unit, dimension filter, and sustain", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence({
      type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90,
      aggregation: "avg", windowSec: 300,
      dimensionFilter: { ifNamePattern: "wan" },
      forDurationSec: 120,
    });
    expect(out).toContain("CPU usage (avg over 5 minutes) is above 90 %");
    expect(out).toContain("on interfaces matching wan");
    expect(out).toContain("sustained for <strong>2 minutes</strong>");
  });

  it("resolves the hardware-sensor unit from the dimension filter's sensor class", () => {
    const s = make(SCHEMA as never);
    expect(s.leafUnit("hwSensorValue", { sensorClass: "temperature" })).toBe("°C");
    expect(s.leafUnit("hwSensorValue", { sensorClass: "fan" })).toBe("RPM");
    expect(s.leafUnit("hwSensorValue", {})).toBe("");
    expect(s.leafUnit("cpuPct", {})).toBe("%");
  });

  // ── State (0/1) probes ────────────────────────────────────────────────
  // A state metric's threshold is 0 or 1, which is unreadable as a sentence.
  // These pin that every surface says "is Alarm" using the probe's own labels.
  const STATE_SCHEMA = {
    ...SCHEMA,
    metricMeta: { ...SCHEMA.metricMeta, customStateValue: { label: "Device state flag (0/1)", unit: "" } },
    booleanMetrics: ["customStateValue"],
    stateProbes: [{
      id: "p1", name: "Hardware sensor alarm", manufacturer: "Fortinet", type: "table",
      stateMap: { mode: "nonzero", values: [], trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true },
    }, {
      id: "p2", name: "PSU present", manufacturer: "Fortinet", type: "table",
      stateMap: { mode: "nonzero", values: [], trueLabel: "Present", falseLabel: "Missing", trueIsProblem: false },
    }],
  };

  it("renders a state trigger with the probe's name and its own state label", () => {
    const s = make(STATE_SCHEMA as never);
    const out = s.triggerSentence({
      type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
      aggregation: "latest", windowSec: 0,
      dimensionFilter: { stateProbeId: "p1", stateRowPattern: "TMP1" },
      forDurationSec: 300,
    }, { severity: "critical" });
    expect(out).toContain("Hardware sensor alarm is Alarm");
    expect(out).toContain("on rows matching TMP1");
    expect(out).toContain("sustained for <strong>5 minutes</strong>");
    expect(out).toContain("critical");
    // The raw 1 never appears, and the probe id is the subject rather than a
    // "for probe <uuid>" dimension clause.
    expect(out).not.toContain("equals 1");
    expect(out).not.toContain("p1");
  });

  it("uses the second label for a threshold of 0, and 'is not' for !=", () => {
    const s = make(STATE_SCHEMA as never);
    const df = { stateProbeId: "p2" };
    expect(s.triggerSentence({
      type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 0,
      aggregation: "latest", windowSec: 0, dimensionFilter: df,
    })).toContain("PSU present is Missing");
    expect(s.triggerSentence({
      type: "asset_metric", metric: "customStateValue", operator: "!=", threshold: 1,
      aggregation: "latest", windowSec: 0, dimensionFilter: df,
    })).toContain("PSU present is not Present");
  });

  it("words a windowed aggregation as what it asks of the window", () => {
    const s = make(STATE_SCHEMA as never);
    const base = {
      type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
      dimensionFilter: { stateProbeId: "p1" }, windowSec: 900,
    };
    expect(s.triggerSentence({ ...base, aggregation: "max" })).toContain("at any point in the last 15 minutes");
    expect(s.triggerSentence({ ...base, aggregation: "min" })).toContain("throughout the last 15 minutes");
  });

  it("falls back to generic wording when the probe can't be resolved", () => {
    // A probe deleted (or a schema fetched before it was defined) must still
    // render a readable sentence rather than blowing up or printing a UUID.
    const s = make(STATE_SCHEMA as never);
    const out = s.triggerSentence({
      type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
      aggregation: "latest", windowSec: 0, dimensionFilter: { stateProbeId: "gone" },
    });
    expect(out).toContain("Device state flag (0/1) is true");
  });

  it("ignores severity bands on a state metric — a ladder over two values is meaningless", () => {
    const s = make(STATE_SCHEMA as never);
    const out = s.triggerSentence({
      type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
      aggregation: "latest", windowSec: 0, dimensionFilter: { stateProbeId: "p1" },
    }, { severity: "warning", severityBands: [{ threshold: 1, severity: "critical" }] });
    expect(out).toContain("warning");
    expect(out).not.toContain("critical");
  });

  it("offers no clear threshold on a state metric's reset sentence", () => {
    const s = make(STATE_SCHEMA as never);
    const tr = {
      type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
      dimensionFilter: { stateProbeId: "p1" },
    };
    // clearThreshold rides along (a hand-written rule could carry one); the
    // sentence must not claim a dead band a flag can't have — it names the OTHER
    // state instead, which is what a flag recovering actually looks like.
    const out = s.resetSentence({ mode: "auto", clearThreshold: 0 }, tr);
    expect(out).toContain("Hardware sensor alarm is OK");
    expect(out).not.toContain("0</strong>");
    // "is OK" rather than "is not Alarm": a state to look for, not a double negative.
    expect(out).not.toContain("is not");
  });

  it("says what an auto reset actually waits for instead of 'the condition is no longer met'", () => {
    const s = make(SCHEMA as never);
    const out = s.resetSentence(
      { mode: "auto" },
      { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "avg", windowSec: 300 },
    );
    // The trigger's own clause, inverted — same renderer as the trigger sentence.
    expect(out).toContain("CPU usage (avg over 5 minutes) is at or below 90 %");
    // With no dead band it resets at the value that raised it, which is worth
    // saying out loud because the reading can sit on the line and re-alert.
    expect(out).toMatch(/same value that raised it/i);
    expect(out).toMatch(/clear threshold/i);
  });

  it("names the recovering state a monitor-status alert really clears at", () => {
    const s = make(SCHEMA as never);
    const out = s.resetSentence(
      { mode: "auto" },
      { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
    );
    // Recovery from an outage is an EVENT — the device answered — not a status
    // value to compare against, so the inverted clause says so rather than
    // reading back "monitor status is not down".
    expect(out).toContain("the device answers a poll again");
    // The gap that matters: the alert clears when the device answers ONCE, not
    // when it is healthy again.
    expect(out).toMatch(/first successful poll/i);
    expect(out).toContain("recovering");
    // And the count is the automation's own, so the caveat can name it.
    expect(out).toMatch(/3 consecutive successes/);
  });

  it("keeps the caveat off a state trigger that isn't about being down", () => {
    const s = make(SCHEMA as never);
    const out = s.resetSentence(
      { mode: "auto" },
      { type: "asset_state", field: "monitorStatus", operator: "==", value: "warning" },
    );
    // "not warning" can mean up OR down, so the recovering story doesn't apply.
    expect(out).not.toMatch(/first successful probe/i);
  });

  it("falls back to a generic clause for a composite trigger", () => {
    const s = make(SCHEMA as never);
    const out = s.resetSentence({ mode: "auto" }, {
      type: "composite", kind: "asset", op: "and",
      children: [
        { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 },
        { type: "asset_metric", metric: "memPct", operator: ">", threshold: 80 },
      ],
    });
    // A tree stops being satisfied in as many ways as it has branches, so there
    // is no single clause to invert.
    expect(out).toContain("the trigger conditions are no longer met");
  });

  it("invertedLeaf leaves the trigger untouched", () => {
    const s = make(SCHEMA as never);
    const tr = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 };
    s.invertedLeaf(tr, { mode: "auto", clearThreshold: 75 });
    expect(tr).toEqual({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 });
  });

  // ── invertedTree: the seed for a custom reset condition ──────────────────
  describe("invertedTree", () => {
    const leaf = (metric: string, operator: string, threshold: number) => ({
      type: "asset_metric", metric, operator, threshold, aggregation: "latest", windowSec: 0,
    });

    it("flips a single leaf's comparator and keeps how it is measured", () => {
      const s = make(SCHEMA as never);
      const out = s.invertedTree({ op: "and", children: [{ ...leaf("cpuPct", ">=", 90), aggregation: "avg", windowSec: 300 }] });
      expect(out).toEqual({
        op: "or",
        children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 90, aggregation: "avg", windowSec: 300 }],
      });
    });

    it("applies De Morgan: AND of two becomes OR of the two inverted", () => {
      const s = make(SCHEMA as never);
      const out = s.invertedTree({ op: "and", children: [leaf("cpuPct", ">=", 90), leaf("memPct", ">", 80)] }) as any;
      expect(out.op).toBe("or");
      expect(out.children.map((c: any) => [c.metric, c.operator, c.threshold])).toEqual([
        ["cpuPct", "<", 90],
        ["memPct", "<=", 80],
      ]);
    });

    it("recurses into nested groups, flipping each level", () => {
      const s = make(SCHEMA as never);
      const out = s.invertedTree({
        op: "or",
        children: [leaf("cpuPct", ">=", 90), { op: "and", children: [leaf("memPct", ">", 80)] }],
      }) as any;
      expect(out.op).toBe("and");
      expect(out.children[1].op).toBe("or");
      expect(out.children[1].children[0].operator).toBe("<=");
    });

    it("flips a 0/1 flag's VALUE rather than its comparator", () => {
      // Same rule invertedLeaf follows for the reset sentence: "is OK" reads as a
      // state to look for, "is not Alarm" as a double negative.
      const s = make(STATE_SCHEMA as never);
      const out = s.invertedTree({
        op: "and",
        children: [{ type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1, aggregation: "latest", windowSec: 0 }],
      }) as any;
      expect(out.children[0].operator).toBe("==");
      expect(out.children[0].threshold).toBe(0);
    });

    it("does not mutate the tree it was handed", () => {
      const s = make(SCHEMA as never);
      const tree = { op: "and", children: [leaf("cpuPct", ">=", 90)] };
      s.invertedTree(tree);
      expect(tree).toEqual({ op: "and", children: [leaf("cpuPct", ">=", 90)] });
    });

    it("copies a leaf it cannot invert through instead of dropping it", () => {
      // Leaving a visible condition the operator can fix beats silently
      // narrowing the tree they asked to have seeded.
      const s = make(SCHEMA as never);
      const odd = { type: "mystery", foo: 1 };
      const out = s.invertedTree({ op: "and", children: [odd] }) as any;
      expect(out.children[0]).toEqual(odd);
    });
  });

  it("names a probeless boolean metric's states from the metric-wide labels", () => {
    // hwSensorAlarm has no probe behind it — its labels come from the server's
    // booleanMetricLabels, and its dimensions render like any numeric metric's.
    const s = make({
      ...STATE_SCHEMA,
      metricMeta: { ...STATE_SCHEMA.metricMeta, hwSensorAlarm: { label: "Hardware sensor alarm", unit: "" } },
      booleanMetrics: ["customStateValue", "hwSensorAlarm"],
      booleanMetricLabels: { hwSensorAlarm: { trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true } },
    } as never);
    const out = s.triggerSentence({
      type: "asset_metric", metric: "hwSensorAlarm", operator: "==", threshold: 1,
      aggregation: "latest", windowSec: 0,
      dimensionFilter: { sensorClass: "temperature", sensorNamePattern: "CPU ON-DIE" },
      forDurationSec: 600,
    }, { severity: "critical" });
    expect(out).toContain("Hardware sensor alarm is Alarm");
    expect(out).toContain("for sensors of class temperature");
    expect(out).toContain("on sensors matching CPU ON-DIE");
    expect(out).toContain("sustained for <strong>10 minutes</strong>");
    expect(out).not.toContain("equals 1");
  });

  it("uses the false label for a 0 threshold on a probeless boolean metric", () => {
    const s = make({
      ...STATE_SCHEMA,
      metricMeta: { ...STATE_SCHEMA.metricMeta, hwSensorAlarm: { label: "Hardware sensor alarm", unit: "" } },
      booleanMetrics: ["customStateValue", "hwSensorAlarm"],
      booleanMetricLabels: { hwSensorAlarm: { trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true } },
    } as never);
    expect(s.triggerSentence({
      type: "asset_metric", metric: "hwSensorAlarm", operator: "==", threshold: 0,
      aggregation: "latest", windowSec: 0,
    })).toContain("Hardware sensor alarm is OK");
  });

  it("falls back to true/false when a boolean metric has no declared labels", () => {
    const s = make({
      ...STATE_SCHEMA,
      metricMeta: { ...STATE_SCHEMA.metricMeta, hwSensorAlarm: { label: "Hardware sensor alarm", unit: "" } },
      booleanMetrics: ["customStateValue", "hwSensorAlarm"],
      // booleanMetricLabels deliberately absent — an older /schema payload.
    } as never);
    expect(s.triggerSentence({
      type: "asset_metric", metric: "hwSensorAlarm", operator: "==", threshold: 1,
      aggregation: "latest", windowSec: 0,
    })).toContain("Hardware sensor alarm is true");
  });

  it("still renders an unresolved state probe's filter as a clause, not silently", () => {
    // The probe id can't be resolved to a name, so it must appear as a dimension
    // clause rather than vanishing — an invisible filter is worse than an ugly one.
    const s = make(STATE_SCHEMA as never);
    const out = s.triggerSentence({
      type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
      aggregation: "latest", windowSec: 0, dimensionFilter: { stateProbeId: "gone" },
    });
    expect(out).toContain("for probe gone");
  });

  it("renders composite trees with AND/OR joins and parenthesized sub-groups", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence({
      type: "composite", kind: "asset", op: "or",
      children: [
        { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 },
        { op: "and", children: [
          { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
          { type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 5 },
        ] },
      ],
    });
    expect(out).toContain("CPU usage is above 90 % OR (Monitor status equals down AND CPU usage is below 5 %)");
  });

  it("auto reset inverts the trigger comparator for the hysteresis clear line", () => {
    const s = make(SCHEMA as never);
    const tr = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 };
    const out = s.resetSentence({ mode: "auto", clearThreshold: 80, sustainSec: 60 }, tr);
    expect(out).toContain("is at or below 80 %");
    expect(out).toContain("stays there for <strong>1 minute</strong>");
  });

  it("says nothing about a re-notify cooldown, retired from the builder", () => {
    // The sentence is the ONE phrasing the list and the editor share, so a
    // leftover clause here would re-advertise a control that no longer exists
    // on either surface. A stored value (an API caller may still set one) is
    // deliberately not described: nothing can edit it from the UI.
    const s = make(SCHEMA as never);
    const tr = { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 };
    const out = s.resetSentence({ mode: "auto", clearThreshold: 80 }, tr);
    expect(out).not.toMatch(/re-fire|cooldown/i);
  });

  it("an event reset says which event clears it, and that it is the same subject", () => {
    const s = make(SCHEMA as never);
    const out = s.resetSentence(
      { mode: "event", resetEvent: { actionPattern: "agent.connected" } },
      { type: "event", actionPattern: "agent.disconnected" },
    );
    expect(out).toContain("<strong>agent.connected</strong>");
    expect(out).toContain("same device or resource");
    // A resource-type narrowing shows up in the prose rather than staying silent.
    const narrowed = s.resetSentence(
      { mode: "event", resetEvent: { actionPattern: "integration.discover.completed", resourceType: "integration" } },
      { type: "event", actionPattern: "integration.discover.error" },
    );
    expect(narrowed).toContain("<strong>integration</strong> resources");
  });

  it("manual / timed / condition reset modes each phrase distinctly", () => {
    const s = make(SCHEMA as never);
    expect(s.resetSentence({ mode: "manual" }, null)).toContain("someone clears it manually");
    expect(s.resetSentence({ mode: "timed", afterSec: 3600 }, null)).toContain("after <strong>1 hour</strong>");
    const cond = s.resetSentence(
      { mode: "condition", condition: { op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 10 }] } },
      { type: "composite" },
    );
    expect(cond).toContain("Resets when <strong>CPU usage is below 10 %</strong>");
  });

  it("scoping: composites depend on kind, flat triggers on the schema's scoped flag", () => {
    const s = make(SCHEMA as never);
    expect(s.isTriggerScoped({ type: "composite", kind: "asset" })).toBe(true);
    expect(s.isTriggerScoped({ type: "composite", kind: "host" })).toBe(false);
    expect(s.isTriggerScoped({ type: "host_metric" })).toBe(false);
    // Business rule 46: an audit-event automation can name devices now.
    expect(s.isTriggerScoped({ type: "event" })).toBe(true);
    expect(s.isTriggerScoped({ type: "asset_metric" })).toBe(true);
  });

  it("names the severity when one is passed, and nothing when it isn't", () => {
    const s = make(SCHEMA as never);
    const tr = { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 80 };
    // Callers that only want the condition (the pre-bands rendering) are unchanged.
    expect(s.triggerSentence(tr)).toBe("When <strong>CPU usage is at or above 80 %</strong>.");
    expect(s.triggerSentence(tr, { severity: "warning" }))
      .toBe("When <strong>CPU usage is at or above 80 %</strong> — <strong>warning</strong>.");
  });

  it("spells out every severity band, not just the base tier", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence(
      { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 80, forDurationSec: 1800 },
      {
        severity: "warning",
        severityBands: [
          { severity: "serious", threshold: 90 },
          { severity: "critical", threshold: 95, forDurationSec: 300 },
        ],
      },
    );
    expect(out).toContain("sustained for <strong>30 minutes</strong>");
    expect(out).toContain("<strong>warning</strong> at this level");
    // A band inheriting the base sustain says nothing about duration…
    expect(out).toContain("<strong>serious</strong> at or above 90 %,");
    // …one that overrides it spells its own out.
    expect(out).toContain("<strong>critical</strong> at or above 95 % for 5 minutes");
  });

  it("a band may override the comparator, and a 0-second band reads as immediate", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence(
      { type: "asset_metric", metric: "hwSensorValue", operator: ">", threshold: 65, forDurationSec: 600, dimensionFilter: { sensorClass: "temperature" } },
      { severity: "notice", severityBands: [{ severity: "critical", operator: ">=", threshold: 90, forDurationSec: 0 }] },
    );
    expect(out).toContain("<strong>critical</strong> at or above 90 °C immediately");
  });

  it("ignores bands on a trigger type that can't carry them", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence(
      { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
      { severity: "critical", severityBands: [{ severity: "serious", threshold: 5 }] },
    );
    expect(out).toBe("When <strong>Monitor status equals down</strong> — <strong>critical</strong>.");
  });

  it("appends the ladder to a composite trigger too", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence(
      { type: "composite", kind: "asset", op: "and", children: [{ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 }] },
      { severity: "serious" },
    );
    expect(out.endsWith("— <strong>serious</strong>.")).toBe(true);
  });

  it("escapes operator-controlled strings in the HTML sentence", () => {
    const s = make(SCHEMA as never);
    const out = s.triggerSentence({ type: "event", actionPattern: "<img src=x>" });
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img src=x&gt;");
  });

  // ── Formula view ────────────────────────────────────────────────────────
  // The point of the formula is that the wizard's one "Sustained for (minutes)"
  // field means two different things: a MEASUREMENT WINDOW under an aggregation
  // (inside the term) versus a HOLD CLOCK under `latest` (outside it). These pin
  // that distinction, since a formula that blurred it would be worse than none.
  describe("triggerFormula", () => {
    it("puts a `latest` trigger's minutes outside the term, as a hold", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({
        type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90,
        aggregation: "latest", windowSec: 0, forDurationSec: 600,
      }, { severity: "warning" });
      expect(f.lines).toEqual(["latest(CPU usage) > 90 %  held 10m  ⇒ warning"]);
      // `latest` reads one sample, so it takes no window argument and the
      // sampling floor is irrelevant to it.
      expect(f.note).toBe("");
    });

    it("puts an aggregated trigger's minutes inside the term, as a window", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({
        type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 80,
        aggregation: "avg", windowSec: 900, forDurationSec: 0,
      }, { severity: "warning" });
      expect(f.lines).toEqual(["avg(CPU usage, 15m) >= 80 %  ⇒ warning"]);
      expect(f.note).toBe("");
    });

    it("flags a window under the engine's 15-minute sampling floor", () => {
      const s = make(SCHEMA as never);
      const short = s.triggerFormula({
        type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 80,
        aggregation: "median", windowSec: 300,
      });
      // The window the operator configured is what prints — the note carries the
      // truth rather than silently substituting 15m for the typed 5m.
      expect(short.lines[0]).toContain("median(CPU usage, 5m)");
      expect(short.note).toContain("15m floor");
      // An aggregated trigger with no window at all falls back to the floor.
      const none = s.triggerFormula({
        type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 80, aggregation: "avg", windowSec: 0,
      });
      expect(none.lines[0]).toContain("avg(CPU usage, 15m)");
      expect(none.note).toContain("15m floor");
    });

    it("renders dimension filters as subscripts and resolves the sensor unit", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({
        type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 65,
        aggregation: "median", windowSec: 900,
        dimensionFilter: { sensorClass: "temperature", sensorNamePattern: "CPU ON-DIE" },
      });
      expect(f.lines[0]).toBe('median(Hardware sensor[class="temperature", name~"CPU ON-DIE"], 15m) >= 65 °C');
    });

    it("prefixes a host metric so it can't be read as a device's", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({
        type: "host_metric", metric: "cpuPct", operator: ">", threshold: 95, aggregation: "latest",
      });
      expect(f.lines[0]).toBe("latest(host CPU usage) > 95 %");
    });

    it("stacks severity bands as aligned lines under the shared term", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula(
        {
          type: "asset_metric", metric: "hwSensorValue", operator: ">=", threshold: 65,
          aggregation: "median", windowSec: 900, forDurationSec: 900,
          dimensionFilter: { sensorClass: "temperature" },
        },
        {
          severity: "warning",
          severityBands: [
            { severity: "serious", threshold: 80 },                                  // inherits the base hold
            { severity: "critical", threshold: 90, operator: ">", forDurationSec: 300 }, // own operator + hold
          ],
        },
      );
      expect(f.lines).toHaveLength(3);
      const term = 'median(Hardware sensor[class="temperature"], 15m)';
      expect(f.lines[0]).toBe(term + " >= 65 °C  held 15m  ⇒ warning");
      // Continuation lines are blank-padded to the term's width so the tiers
      // line up in the monospace block.
      expect(f.lines[1]).toBe(" ".repeat(term.length) + " >= 80 °C  held 15m  ⇒ serious");
      expect(f.lines[2]).toBe(" ".repeat(term.length) + " > 90 °C  held 5m  ⇒ critical");
    });

    it("a 0-second band drops the hold clause entirely", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula(
        { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 80, aggregation: "latest", forDurationSec: 600 },
        { severity: "warning", severityBands: [{ severity: "critical", threshold: 95, forDurationSec: 0 }] },
      );
      expect(f.lines[1]).toContain("> 95 %  ⇒ critical");
      expect(f.lines[1]).not.toContain("held");
    });

    it("omits the severity arrow when the caller passes no ladder", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "latest" });
      expect(f.lines).toEqual(["latest(CPU usage) > 90 %"]);
    });

    it("renders a composite as one line per condition with the hold on its own line", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({
        type: "composite", kind: "asset", op: "and", forDurationSec: 300,
        children: [
          { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
          { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 20, aggregation: "avg", windowSec: 900 },
        ],
      }, { severity: "critical" });
      expect(f.lines).toEqual([
        '    Monitor status == "down"',
        "AND avg(CPU usage, 15m) > 20 %",
        "    held 5m  ⇒ critical",
      ]);
    });

    it("keeps a nested sub-group inline rather than indenting a second level", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({
        type: "composite", kind: "asset", op: "or",
        children: [
          { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "latest" },
          { op: "and", children: [
            { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" },
            { type: "asset_metric", metric: "cpuPct", operator: "<", threshold: 5, aggregation: "latest" },
          ] },
        ],
      });
      expect(f.lines[1]).toBe('OR (Monitor status == "down" AND latest(CPU usage) < 5 %)');
    });

    it("a composite's short window is flagged from inside a nested group too", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({
        type: "composite", kind: "asset", op: "and",
        children: [
          { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "latest" },
          { op: "or", children: [{ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 50, aggregation: "avg", windowSec: 60 }] },
        ],
      });
      expect(f.note).toContain("15m floor");
    });

    it("renders a state metric with the probe's name and its own state label", () => {
      const s = make(STATE_SCHEMA as never);
      const f = s.triggerFormula({
        type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
        aggregation: "latest", windowSec: 0, forDurationSec: 300,
        dimensionFilter: { stateProbeId: "p1", stateRowPattern: "TMP1" },
      }, { severity: "critical" });
      expect(f.lines[0]).toBe('latest(Hardware sensor alarm[row~"TMP1"]) == "Alarm"  held 5m  ⇒ critical');
      // The bare 1 and the probe id never surface — same contract as the sentence.
      expect(f.lines[0]).not.toContain("== 1");
      expect(f.lines[0]).not.toContain("p1");
    });

    it("reads min/max over a flag as all/any rather than min()/max() of a boolean", () => {
      const s = make(STATE_SCHEMA as never);
      const base = {
        type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
        dimensionFilter: { stateProbeId: "p1" }, windowSec: 900,
      };
      expect(s.triggerFormula({ ...base, aggregation: "max" }).lines[0]).toBe('any(Hardware sensor alarm, 15m) == "Alarm"');
      expect(s.triggerFormula({ ...base, aggregation: "min" }).lines[0]).toBe('all(Hardware sensor alarm, 15m) == "Alarm"');
    });

    it("ignores bands on a state metric — a threshold ladder over two values is meaningless", () => {
      const s = make(STATE_SCHEMA as never);
      const f = s.triggerFormula(
        { type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1, aggregation: "latest", dimensionFilter: { stateProbeId: "p1" } },
        { severity: "warning", severityBands: [{ severity: "critical", threshold: 1 }] },
      );
      expect(f.lines).toHaveLength(1);
      expect(f.lines[0]).not.toContain("critical");
    });

    it("keeps an unresolved probe visible as a filter rather than dropping it", () => {
      const s = make(STATE_SCHEMA as never);
      const f = s.triggerFormula({
        type: "asset_metric", metric: "customStateValue", operator: "==", threshold: 1,
        aggregation: "latest", dimensionFilter: { stateProbeId: "gone" },
      });
      expect(f.lines[0]).toContain('probe="gone"');
    });

    it("returns no lines for the trigger types that compute no value", () => {
      const s = make(SCHEMA as never);
      // event / change carry no aggregation and no window, so their English
      // sentence is already exact — a formula would add syntax and no meaning.
      expect(s.triggerFormula({ type: "event", actionPattern: "integration.*" }).lines).toEqual([]);
      expect(s.triggerFormula({ type: "change", changeType: "new_asset" }).lines).toEqual([]);
      expect(s.triggerFormula(null).lines).toEqual([]);
      expect(s.triggerFormula({}).lines).toEqual([]);
    });

    it("renders a missing threshold as an ellipsis rather than NaN", () => {
      const s = make(SCHEMA as never);
      const f = s.triggerFormula({ type: "asset_metric", metric: "cpuPct", operator: ">", aggregation: "latest" });
      expect(f.lines[0]).toBe("latest(CPU usage) > … %");
    });

    it("compactDuration abbreviates hours, minutes and seconds", () => {
      const s = make(SCHEMA as never);
      expect(s.compactDuration(7200)).toBe("2h");
      expect(s.compactDuration(900)).toBe("15m");
      expect(s.compactDuration(45)).toBe("45s");
      expect(s.compactDuration(0)).toBe("");
    });
  });
});

// ── State-leaf dimension filters + hostnamePattern (2026-08) ────────────────
// State fields (ifOperStatus …) always accepted a dimensionFilter at the API,
// but the sentence never rendered it — a hand-written "interface down on wan"
// rule read as plain "interface down". And hostnamePattern is the universal
// device dimension every asset leaf now takes. Pin both surfaces.
describe("state-leaf dimensions + hostnamePattern", () => {
  const S = {
    ...JSON.parse(JSON.stringify({
      triggerTypes: [
        { type: "asset_metric", label: "Device metric", scoped: true },
        { type: "asset_state", label: "Device state", scoped: true },
        { type: "composite", label: "Multiple conditions", scoped: true },
      ],
      metricMeta: { cpuPct: { label: "CPU usage", unit: "%" } },
      fieldMeta: { ifOperStatus: { label: "Interface oper status" }, ipsecStatus: { label: "IPsec tunnel status" } },
    })),
  };

  it("renders a state trigger's interface + hostname filters in the sentence", () => {
    const s = make(S as never);
    const out = s.triggerSentence({
      type: "asset_state", field: "ifOperStatus", operator: "==", value: "down",
      dimensionFilter: { ifNamePattern: "wan", hostnamePattern: "CORE-SW" },
    });
    expect(out).toContain("Interface oper status equals down");
    expect(out).toContain("on interfaces matching wan");
    expect(out).toContain("on devices whose hostname matches CORE-SW");
  });

  it("renders hostnamePattern on a metric trigger", () => {
    const s = make(S as never);
    const out = s.triggerSentence({
      type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90,
      aggregation: "latest", dimensionFilter: { hostnamePattern: "db-" },
    });
    expect(out).toContain("CPU usage is at or above 90 %");
    expect(out).toContain("on devices whose hostname matches db-");
  });

  it("renders state-leaf dimensions inside a composite tree phrase", () => {
    const s = make(S as never);
    const out = s.triggerSentence({
      type: "composite", op: "or", children: [
        { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", dimensionFilter: { ifNamePattern: "port1", hostnamePattern: "SW-A" } },
        { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 95, aggregation: "latest", dimensionFilter: { hostnamePattern: "SW-B" } },
      ],
    });
    expect(out).toContain("on interfaces matching port1 on devices whose hostname matches SW-A");
    expect(out).toContain("on devices whose hostname matches SW-B");
    expect(out).toContain(" OR ");
  });

  it("puts a state leaf's filters inside the formula term", () => {
    const s = make(S as never);
    const f = s.triggerFormula({
      type: "asset_state", field: "ifOperStatus", operator: "==", value: "down",
      dimensionFilter: { ifNamePattern: "wan", hostnamePattern: "CORE" },
    });
    expect(f.lines[0]).toBe('Interface oper status[if~"wan", host~"CORE"] == "down"');
  });

  it("a state leaf with no filter keeps its bare term", () => {
    const s = make(S as never);
    const f = s.triggerFormula({ type: "asset_state", field: "ipsecStatus", operator: "!=", value: "up" });
    expect(f.lines[0]).toBe('IPsec tunnel status != "up"');
  });
});
