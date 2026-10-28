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

import { METRIC_META, FIELD_META, CHANGE_TYPE_META, WINDOWED_RATIO_METRICS, FORECAST_HORIZON_METRICS, forecastDaysOf, probeLossWindowSec, isPathMetric } from "../services/notificationTypes.js";
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

/** The stream each failing-minutes state field names (business rule 118). */
const STREAM_FAILING_SUBJECT: Record<string, string> = {
  telemetryFailingMinutes: "CPU & memory",
  systemInfoFailingMinutes: "Interface",
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
  /** A forecast metric's horizon in days (FORECAST_HORIZON_METRICS). */
  forecastDays?: number;
}

/** Is this a forecast-over-a-horizon metric (memory forecast)? */
function isForecastHorizon(trigger: SummarizableTrigger): boolean {
  return !!trigger.metric && (FORECAST_HORIZON_METRICS as readonly string[]).includes(trigger.metric);
}

/** "14 days" / "1 day" — a forecast horizon. */
function daysPhrase(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
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
  // A forecast names its horizon instead of an aggregation (it has none):
  // "Memory forecast (14 days out)".
  const agg = isForecastHorizon(trigger)
    ? ` (${daysPhrase(forecastDaysOf(trigger))} out)`
    : trigger.metric && (WINDOWED_RATIO_METRICS as readonly string[]).includes(trigger.metric)
      ? ` (over the last ${humanDuration(probeLossWindowSec(trigger.windowSec))} of ${trigger.metric === "pathFailurePct" ? "check" : "probe"} history)`
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
    // A tag reading is the tag when the device carries it and blank when not,
    // so "Asset tag is prod" would read wrongly for the absent case.
    if (trigger.field === "tag") {
      const name = formatValue(trigger.value ?? null) ?? "";
      return `Asset ${formatValue(parts.value) ? "has" : "does not have"} the tag "${name}"`;
    }
    // Business rule 118: a duration, so "… is 62" would drop the unit the label
    // carries in brackets. The reading is whole minutes of failed polls.
    const failingStream = STREAM_FAILING_SUBJECT[trigger.field ?? ""];
    if (failingStream) {
      const mins = formatValue(parts.value) ?? formatValue(trigger.value ?? null);
      return mins === null || mins === "0"
        ? `${failingStream} polls are succeeding`
        : `${failingStream} polls have been failing for ${mins} min`;
    }
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
  // A path check's result is a 0/1 flag too — "Path check result on ERP HTTPS
  // is 0" told the reader nothing. The check is the subject: "ERP HTTPS is
  // down". From the reading when there is one, else from the condition.
  if (trigger.metric === "pathOk") {
    const check = parts.dimensionLabel || "The path check";
    const r = parts.value;
    if (r === null || r === undefined) return `${check} ${pathConditionPhrase(trigger)}`;
    return `${check} is ${r === 0 || r === false || r === "0" ? "down" : "up"}`;
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
  // "Memory is projected to reach 86 % within 14 days" — the level is the
  // reading, the horizon the trigger's; the severity says which target it met.
  if (isForecastHorizon(trigger)) {
    const on = parts.dimensionLabel ? ` on ${parts.dimensionLabel}` : "";
    return `Memory${on} is projected to reach ${v}${unit ? ` ${unit}` : ""} within ${daysPhrase(forecastDaysOf(trigger))}`;
  }
  return `${subject} is ${v}${unit ? ` ${unit}` : ""}`;
}

/**
 * What a Path Monitor automation's condition says about the CHECK, as the
 * default message of a grouped path alert words it — the check is the subject
 * and this is its verb: "Salesforce HTTPS is down from 3 devices".
 *
 *   pathOk firing on Unreachable   "is down"   (Reachable: "is up")
 *   pathFailurePct                 "is failing (path failure rate above 20 %)"
 *   any other path metric          "has path latency above 200 ms"
 *
 * `plural` is for a count of checks: "3 path checks are down". Null for a
 * trigger that is not a path metric — the caller keeps its own wording.
 */
export function pathConditionPhrase(trigger: SummarizableTrigger, plural = false): string | null {
  if (trigger.type !== "asset_metric" || !isPathMetric(trigger.metric)) return null;
  const is = plural ? "are" : "is";
  if (trigger.metric === "pathOk") return `${is} ${pathOkFiresOnFailure(trigger) ? "down" : "up"}`;
  const { metricLabel, thresholdDisplay } = triggerTokenParts(trigger);
  const condition = `${metricLabel.charAt(0).toLowerCase()}${metricLabel.slice(1)}${thresholdDisplay ? ` ${thresholdDisplay}` : ""}`;
  if (trigger.metric === "pathFailurePct") return `${is} failing (${condition})`;
  return `${plural ? "have" : "has"} ${condition}`;
}

/**
 * The all-clear's form of a `{condition.suffix}`, so a Resolved subject keeps
 * the fire's shape without repeating its problem: " is down" → " is up",
 * " are down" → " are up", anything else (" has path latency above 200 ms",
 * " is failing (…)") → " recovered". Blank stays blank. Pure.
 */
export function recoveredConditionSuffix(suffix: string | null | undefined): string {
  if (!suffix) return "";
  const m = /^ (is|are) down$/.exec(suffix);
  if (m) return ` ${m[1]} up`;
  return " recovered";
}

/** Does a pathOk condition match a failed run (0)? The builder writes "== 0";
 *  the other spellings of the same thing are read the same way. */
function pathOkFiresOnFailure(trigger: SummarizableTrigger): boolean {
  const t = Number(trigger.threshold === true ? 1 : trigger.threshold === false ? 0 : trigger.threshold);
  if (!Number.isFinite(t)) return true;
  switch (trigger.operator) {
    case "==": return t === 0;
    case "!=": return t !== 0;
    case "<": return 0 < t;
    case "<=": return 0 <= t;
    case ">": return 0 > t;
    case ">=": return 0 >= t;
    default: return true;
  }
}

/**
 * The readable halves of `{metric} = {value} (threshold {threshold})`:
 *   metricLabel      "CPU utilization"   (not "cpuPct")
 *   valueDisplay     "97 %"              (unit included; "in ALARM" for a sensor alarm)
 *   thresholdDisplay "above 90 %"        (the comparison included)
 * Each is "" where the trigger has nothing to say — a composite has no single
 * metric, an event has no threshold — so a template using them never prints
 * a dangling unit.
 */
export function triggerTokenParts(
  trigger: SummarizableTrigger,
  value?: number | string | boolean | null,
): { metricLabel: string; valueDisplay: string; thresholdDisplay: string } {
  const cmp = (op: string | undefined): string => (CMP_PHRASE[op ?? ""] ?? op ?? "").replace(/^is /, "");
  if (trigger.type === "asset_metric" || trigger.type === "host_metric") {
    const metricLabel = (trigger.metric ? METRIC_META[trigger.metric]?.label : null) ?? trigger.metric ?? "";
    const unit = triggerUnit(trigger);
    const withUnit = (v: string | null): string => (v === null ? "" : `${v}${unit ? ` ${unit}` : ""}`);
    if (trigger.metric === "hwSensorAlarm") {
      const flag = value;
      const valueDisplay = value === null || value === undefined ? "" : flag === 1 || flag === true || flag === "1" ? "in ALARM" : "OK";
      return { metricLabel, valueDisplay, thresholdDisplay: "" };
    }
    const thr = formatValue(trigger.threshold ?? null);
    return {
      metricLabel,
      valueDisplay: withUnit(formatValue(value)),
      thresholdDisplay: thr === null ? "" : `${cmp(trigger.operator)} ${withUnit(thr)}`,
    };
  }
  if (trigger.type === "asset_state") {
    const metricLabel = (trigger.field ? FIELD_META[trigger.field]?.label : null) ?? trigger.field ?? "";
    const state = (v: number | string | boolean | null | undefined): string => {
      const raw = formatValue(v);
      if (raw === null) return "";
      return trigger.field === "monitorStatus" ? monitorStatusLabel(raw).toLowerCase() : raw;
    };
    const target = state(trigger.value ?? null);
    // A state reads "is down" / "is not up", never "equals down".
    const op = trigger.operator === "==" ? "is" : trigger.operator === "!=" ? "is not" : cmp(trigger.operator);
    return { metricLabel, valueDisplay: state(value), thresholdDisplay: target ? `${op} ${target}` : "" };
  }
  if (trigger.type === "change") {
    return { metricLabel: (trigger.changeType ? CHANGE_TYPE_META[trigger.changeType] : null) ?? trigger.changeType ?? "", valueDisplay: "", thresholdDisplay: "" };
  }
  return { metricLabel: "", valueDisplay: "", thresholdDisplay: "" };
}
