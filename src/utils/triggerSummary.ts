/**
 * src/utils/triggerSummary.ts — "what fired, and what the reading was", in the
 * same words the automation wizard uses.
 *
 * The alert email used to state the metric only through the default message
 * ("Slow response time: sw-1 — responseTimeMs = 760 (threshold 500)"), which
 * reads like a log line and never says what the number MEANS. The wizard's
 * "When should it fire?" step already phrases this well —
 *
 *     When Response time (median over 5 minutes) is above 500 ms — warning.
 *
 * — so the email now leads with the same subject, the same aggregation
 * wording, and the observed value:
 *
 *     Response time (median over 5 minutes) is 760 ms
 *
 * Pure, and deliberately mirroring `triggerSentence` / `humanDuration` /
 * `AGG_PHRASE` in public/js/automations-wizard.js. The two must agree: an
 * operator who reads "median over 5 minutes" while building the automation
 * should read the same phrase in the email it sends.
 */

import { METRIC_META, FIELD_META, CHANGE_TYPE_META, WINDOWED_RATIO_METRICS, probeLossWindowSec } from "../services/notificationTypes.js";
import { monitorStatusLabel } from "./monitorStatus.js";

/** "5 minutes" / "1 hour" / "45 seconds" — mirrors the wizard's humanDuration. */
export function humanDuration(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "";
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  if (sec % 60 === 0) {
    const m = sec / 60;
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  return `${sec} seconds`;
}

/** Mirrors `comparatorPhrases` in buildSchemaCatalog + CMP_PHRASE in the wizard. */
const CMP_PHRASE: Record<string, string> = {
  ">": "is above",
  ">=": "is at or above",
  "<": "is below",
  "<=": "is at or below",
  "==": "equals",
  "!=": "is not",
};

const AGG_PHRASE: Record<string, string> = {
  latest: "",
  avg: "avg over",
  median: "median over",
  min: "min over",
  max: "max over",
};

export interface SummarizableTrigger {
  type: string;
  metric?: string;
  field?: string;
  aggregation?: string;
  windowSec?: number;
  /** A COUNT window (business rule 66) — the last N readings that produced a
   *  value. Wins over `windowSec`, which is only its wall-clock mirror here. */
  windowPolls?: number | null;
  operator?: string;
  threshold?: number | string | boolean | null;
  /** asset_state triggers compare against `value`, not `threshold`. */
  value?: number | string | boolean | null;
  dimensionFilter?: Record<string, string | undefined> | null;
  changeType?: string;
  actionPattern?: string;
}

/**
 * The metric's subject phrase, aggregation included:
 *   "Response time (median over 5 minutes)"
 *   "the Polaris host's CPU utilization"
 *   "Hardware sensor value on TMP1"
 *
 * `dimensionLabel` is the sub-asset the reading belongs to (a sensor, an
 * interface, a mount) — the engine's dimLabel, which already reads
 * "CPU ON-DIE Temperature (temperature)".
 */
export function triggerSubject(trigger: SummarizableTrigger, dimensionLabel?: string | null): string {
  const meta = trigger.metric ? METRIC_META[trigger.metric] : undefined;
  const base = meta?.label ?? trigger.metric ?? "The condition";
  const subject = trigger.type === "host_metric" ? `The Polaris host's ${base.toLowerCase()}` : base;
  // A windowed ratio (packet loss) states its History window — the window IS
  // the measurement, and its aggregation is "latest", so the ordinary clause
  // below would silently drop it. Mirrors the wizard's tgLeafPhrase, including
  // the default when a pre-History rule carries no window.
  // A COUNT window is named as READINGS, never as the seconds it also carries:
  // `windowSec` is only the mirror that sizes the engine's fetch, so printing
  // it here would put a clock in the alert's own subject line that the rule
  // does not keep — "avg 20 minutes" for a rule that averages ten responses,
  // and a different 20 minutes on every device (business rule 66).
  const countWindow =
    trigger.aggregation && trigger.aggregation !== "latest" &&
    typeof trigger.windowPolls === "number" && trigger.windowPolls > 0 &&
    !(trigger.metric && (WINDOWED_RATIO_METRICS as readonly string[]).includes(trigger.metric))
      ? Math.round(trigger.windowPolls)
      : 0;
  const agg =
    trigger.metric && (WINDOWED_RATIO_METRICS as readonly string[]).includes(trigger.metric)
      ? ` (over the last ${humanDuration(probeLossWindowSec(trigger.windowSec))} of ${trigger.metric === "connFailurePct" ? "check" : "probe"} history)`
      : countWindow
        ? ` (${AGG_PHRASE[trigger.aggregation!] ?? trigger.aggregation} the last ${countWindow} readings)`
      : trigger.aggregation && trigger.aggregation !== "latest" && trigger.windowSec
        ? ` (${AGG_PHRASE[trigger.aggregation] ?? trigger.aggregation} ${humanDuration(trigger.windowSec)})`
        : "";
  const on = dimensionLabel ? ` on ${dimensionLabel}` : "";
  return `${subject}${agg}${on}`;
}

/** The unit to print after a value — the sensor's own unit when we know it. */
export function triggerUnit(trigger: SummarizableTrigger, sensorUnit?: string | null): string {
  if (trigger.metric === "hwSensorValue") return sensorUnit ?? "";
  if (trigger.metric === "hwSensorAlarm") return "";
  const unit = trigger.metric ? METRIC_META[trigger.metric]?.unit ?? "" : "";
  // "(sensor unit)" is a builder placeholder, never something to print.
  return unit.startsWith("(") ? "" : unit;
}

/** Round for reading, not for precision: "760 ms", "93.8 %", "61 °C". */
function formatValue(value: number | string | boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export interface TriggerSummaryParts {
  trigger: SummarizableTrigger;
  value?: number | string | boolean | null;
  /** The engine's dimLabel for this reading (sensor / interface / mount). */
  dimensionLabel?: string | null;
  /** A hardware sensor's own unit, when the reading came from one. */
  sensorUnit?: string | null;
  /** Event path: the action that actually fired, not the rule's glob. */
  eventAction?: string | null;
  /** Event path: what it happened TO (resource name, else its type). */
  eventResource?: string | null;
}

/**
 * "Response time (median over 5 minutes) is 760 ms".
 *
 * Falls back to just the subject when there's no value to state (an event
 * rule, or a test with nothing currently reported) rather than printing
 * "is —", which reads like a broken template.
 */
export function triggerSummary(parts: TriggerSummaryParts): string {
  const { trigger } = parts;
  if (trigger.type === "event") {
    // Name what actually happened, not the rule's glob: "integration.discover
    // .error on FMG-PROD" beats "An audit event matching
    // integration.discover.* occurred", which is a restatement of the
    // automation rather than of the event.
    const action = parts.eventAction ?? trigger.actionPattern ?? "an audit event";
    const on = parts.eventResource ? ` on ${parts.eventResource}` : "";
    return `${action}${on}`;
  }
  if (trigger.type === "change") {
    const label = (trigger.changeType ? CHANGE_TYPE_META[trigger.changeType] : null) ?? trigger.changeType ?? "A change";
    return `${label} was detected`;
  }
  if (trigger.type === "composite") {
    return "Several conditions were met together";
  }
  if (trigger.type === "asset_state") {
    // The builder's own label, not the column name: "Monitor status is down",
    // never "monitorStatus is down". FIELD_META is what the wizard renders
    // from, so the two read alike.
    const label = (trigger.field ? FIELD_META[trigger.field]?.label : null) ?? trigger.field ?? "State";
    const on = parts.dimensionLabel ? ` on ${parts.dimensionLabel}` : "";
    // The READING when we have one; the configured value otherwise (a test on
    // a device with nothing reported still reads as a sentence).
    const raw = formatValue(parts.value) ?? formatValue(trigger.value ?? null);
    // Monitor status is the one state field whose stored values are not what
    // operators are shown anywhere else — `warning` reads "Missed" on every
    // pill — so the email must not be the single surface quoting the enum.
    const v = raw !== null && trigger.field === "monitorStatus" ? monitorStatusLabel(raw).toLowerCase() : raw;
    return v ? `${label}${on} is ${v}` : `${label}${on} changed`;
  }

  const subject = triggerSubject(trigger, parts.dimensionLabel);
  // The alarm metric is a 0/1 flag — "is 1" would be nonsense to a reader.
  if (trigger.metric === "hwSensorAlarm") {
    const flag = parts.value;
    const state = flag === 1 || flag === true || flag === "1" ? "in ALARM" : "OK";
    return `${subject} is ${state}`;
  }
  const unit = triggerUnit(trigger, parts.sensorUnit);
  const v = formatValue(parts.value);
  if (v === null) {
    // No reading to quote — a test on a device that hasn't reported inside the
    // trigger's window, or an alert whose value didn't survive. State the
    // CONDITION instead, which is what the builder shows: a bare subject
    // ("Hardware sensor value") is a sentence fragment.
    const thr = formatValue(trigger.threshold ?? null);
    if (thr === null) return subject;
    const cmp = CMP_PHRASE[trigger.operator ?? ""] ?? trigger.operator ?? "meets";
    return `${subject} ${cmp} ${thr}${unit ? ` ${unit}` : ""}`;
  }
  return `${subject} is ${v}${unit ? ` ${unit}` : ""}`;
}
