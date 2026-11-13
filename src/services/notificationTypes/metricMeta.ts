/**
 * src/services/notificationTypes/metricMeta.ts — per-metric metadata and dimension matchers (CQ-B063, moved verbatim from
 * notificationTypes.ts): METRIC_META / FIELD_META / CHANGE_TYPE_META the builder reads,
 * forecast levels and their linked sources, the probe-loss window (business rule 29),
 * saturation ceilings, and the interface / sensor / path-check / interface-tag / member-IP
 * matchers a trigger dimension filter applies.
 */

import { bareInterfaceIp, interfaceIpIsUnaddressed } from "../../utils/cidr.js";
import { POE_STATUS_VALUES } from "../../utils/poePorts.js";
import { sdwanDimensionTerms } from "../../utils/sdwanDimensions.js";
import { ASSET_METRICS, ASSET_STATE_FIELDS, type MemberIpFilter } from "./triggers.js";
import { type SeverityBand } from "./actions.js";
import { dimensionSubstringMatch, DEVICE_FILTER_DIMENSIONS } from "./specificity.js";
import { METRIC_DIMENSIONS, FIELD_DIMENSIONS, INTERFACE_TAG_TARGETS } from "./dimensions.js";

// ─── Display metadata (builder UI only; engine validates via the Zod schemas) ──
// Human label + unit per metric, for both asset_metric and host_metric.
/**
 * Metrics that are a RATIO OVER A WINDOW rather than a reading with an optional
 * aggregation — the window is the measurement itself. The builder uses this to
 * relabel its base time field as "History", hide the (ignored) aggregation
 * control, and offer a SEPARATE optional "Sustained for" hold (2026-08-20 —
 * History and sustain are two axes: how long each reading measures over, and
 * how long readings must stay over the threshold; severity tiers keep their own
 * holds per rule 19). The engine uses the window exactly instead of applying
 * its `latest`-sample lookback floor. Exposed on /automations/schema as
 * `windowedRatioMetrics`.
 */
export const WINDOWED_RATIO_METRICS = ["probeLossPct", "pathFailurePct"] as const;

/**
 * The windowed-ratio metrics the SATURATION CEILING (`ignoreAtOrAbove`) applies
 * to — a narrower list than WINDOWED_RATIO_METRICS, on purpose. The ceiling
 * exists because 100% packet loss is an OUTAGE, which the down automation
 * already owns (business rule 29). A path check's failure rate has no such
 * owner: the host is up and is the one reporting, so 100% is the headline case
 * ("the ERP is unreachable from this site") and must fire (business rule 85).
 * Exposed on /automations/schema as `saturationCeilingMetrics`.
 */
export const SATURATION_CEILING_METRICS = ["probeLossPct"] as const;

/**
 * Metrics read as a PROJECTION over the trigger's `forecastDays` horizon:
 * "memory is projected to reach X% within N days". The reading is the level
 * the 30-day trend reaches N days out, so a severity tier's threshold IS a
 * target level (warning at 80%, critical at 95%) and every tier shares the one
 * horizon — "within 14 days memory reaches 80%" and "the projection 14 days
 * out is at or above 80%" are the same statement for a growing host. That is
 * what lets one reading drive the ordinary tier ladder (business rule 19)
 * instead of each tier needing a value of its own. Exposed on
 * /automations/schema as `forecastHorizonMetrics`.
 */
export const FORECAST_HORIZON_METRICS = ["memForecastPct"] as const;

/** The horizon a forecast trigger uses when it states none (days). */
export const FORECAST_DAYS_DEFAULT = 14;

/** The forecast horizon a trigger asks for, in whole days (1–365). */
export function forecastDaysOf(trigger: unknown): number {
  const n = (trigger as { forecastDays?: unknown } | null)?.forecastDays;
  return typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.min(365, Math.round(n)) : FORECAST_DAYS_DEFAULT;
}

/**
 * The automations a forecast may take its levels from, by metric: a memory
 * forecast follows a memory-utilization automation's percentages. Exposed on
 * /automations/schema as `forecastLevelSources`.
 */
export const FORECAST_LEVEL_SOURCE_METRICS: Record<string, string> = { memForecastPct: "memPct" };

/** One level a forecast counts down to: a tier's threshold, its severity, and
 *  whether its comparison is strict (`>`) or not (`>=`). */
export interface ForecastLevel {
  threshold: number;
  severity: string;
  strict: boolean;
}

/**
 * A forecast rule's levels, lowest first: the base tier (trigger threshold at
 * the rule's severity) and every band, each with its own comparison (falling
 * back to the trigger's). Only upward comparisons count — a forecast projects
 * growth. Pure.
 */
export function forecastLevelsOf(trigger: unknown, severity: string, severityBands: SeverityBand[] | null | undefined): ForecastLevel[] {
  const t = trigger as { operator?: string; threshold?: unknown } | null;
  if (!t) return [];
  const out: ForecastLevel[] = [];
  const push = (threshold: unknown, sev: string, op: string | undefined) => {
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) return;
    if (op !== ">" && op !== ">=") return;
    out.push({ threshold, severity: sev, strict: op === ">" });
  };
  push(t.threshold, severity, t.operator);
  for (const b of severityBands ?? []) push(b.threshold, b.severity, b.operator ?? t.operator);
  return out.sort((a, b) => a.threshold - b.threshold);
}

/** The levels part of a rule — what `linkForecastLevels` reads and writes. */
export interface LevelsPart {
  trigger: unknown;
  severity: string;
  severityBands: SeverityBand[] | null | undefined;
}

/** The linked automation id a forecast trigger names, when it may name one. */
export function forecastLevelsSourceId(trigger: unknown): string | null {
  const t = trigger as { type?: unknown; metric?: unknown; levelsFromRuleId?: unknown } | null;
  if (!t || t.type !== "asset_metric" || typeof t.metric !== "string") return null;
  if (!FORECAST_LEVEL_SOURCE_METRICS[t.metric]) return null;
  return typeof t.levelsFromRuleId === "string" && t.levelsFromRuleId ? t.levelsFromRuleId : null;
}

/** Can this trigger lend its levels to a forecast on `forecastMetric`? A
 *  single condition on the source metric, compared upward. */
export function isForecastLevelSource(trigger: unknown, forecastMetric: string): boolean {
  const t = trigger as { type?: unknown; metric?: unknown; operator?: unknown; threshold?: unknown } | null;
  return !!t && t.type === "asset_metric" && t.metric === FORECAST_LEVEL_SOURCE_METRICS[forecastMetric] &&
    (t.operator === ">" || t.operator === ">=") && typeof t.threshold === "number";
}

/**
 * A forecast's levels, taken from the automation it links to: the linked
 * trigger's operator + threshold and its base severity become the forecast's
 * base tier, and each linked band becomes a forecast band at the same
 * threshold + severity. What stays the FORECAST's own is everything that is
 * not a level — its actions, escalation and follow-up — so a forecast band
 * keeps the actions it already had for that severity (none = the forecast's
 * base actions). The linked band's own hold is dropped: the forecast has one
 * hold, its own. Pure; returns `forecast` unchanged when `linked` cannot lend
 * levels, so a deleted or retargeted source falls back to the levels stored
 * on the forecast (the last ones copied).
 */
export function linkForecastLevels<T extends LevelsPart>(forecast: T, linked: LevelsPart | null | undefined): T {
  const ft = forecast.trigger as { metric?: string } & Record<string, unknown>;
  if (!linked || !ft || typeof ft.metric !== "string" || !isForecastLevelSource(linked.trigger, ft.metric)) return forecast;
  const lt = linked.trigger as { operator: string; threshold: number };
  const own = new Map((forecast.severityBands ?? []).map((b) => [b.severity, b]));
  const bands: SeverityBand[] = (linked.severityBands ?? []).map((b) => {
    const mine = own.get(b.severity);
    const band: SeverityBand = { threshold: b.threshold, severity: b.severity, actions: mine?.actions ?? [] };
    if (b.operator) band.operator = b.operator;
    if (mine?.escalation) band.escalation = mine.escalation;
    if (mine?.followUp) band.followUp = mine.followUp;
    return band;
  });
  return {
    ...forecast,
    trigger: { ...ft, operator: lt.operator, threshold: lt.threshold },
    severity: linked.severity,
    severityBands: bands.length ? bands : null,
  };
}

/**
 * The probe-loss measurement window, resolved exactly the way the engine
 * measures it: the configured `windowSec` floored at the 5-minute minimum (a
 * ratio always needs a few probes behind it), defaulted to 15 minutes when the
 * trigger carries none — pre-History rules, where the minutes went to
 * `forDurationSec` instead, and hand-written ones. Shared by the engine's
 * `probeLossPct` resolver and the alert-email loss chart, so the chart's window
 * can never disagree with the window the alert was measured over.
 */
export const PROBE_LOSS_DEFAULT_WINDOW_SEC = 15 * 60;

export const PROBE_LOSS_MIN_WINDOW_SEC = 5 * 60;

/**
 * The saturation ceiling a trigger uses when it states none. 100 means only a
 * TOTAL outage is suppressed, so a rule authored before the control existed
 * behaves exactly as it did.
 */
export const DEFAULT_READING_CEILING_PCT = 100;

/**
 * Is this reading at or above the trigger's saturation ceiling, i.e. should it
 * be treated as no reading at all?
 *
 * ">= " rather than "> " on purpose: the operator-facing control reads "ignore
 * at or above", and a ceiling of 100 has to suppress a reading of exactly 100 —
 * suppressing only what EXCEEDS 100 would make the default do nothing.
 *
 * Only continuous asset-metric triggers have one. A non-numeric reading is not
 * saturated, it is unmeasurable, and the caller decides what that means.
 */
export function readingAtOrAboveCeiling(trigger: unknown, value: number | null): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const t = trigger as { type?: string; metric?: unknown; ignoreAtOrAbove?: unknown } | null;
  if (!t || t.type !== "asset_metric") return false;
  // Only the metrics whose top of scale IS someone else's alert. A stored
  // ceiling on any other metric (an API write, or a rule saved before this
  // list existed) is inert rather than silencing readings.
  if (!(SATURATION_CEILING_METRICS as readonly string[]).includes(String(t.metric))) return false;
  const ceiling = typeof t.ignoreAtOrAbove === "number" && Number.isFinite(t.ignoreAtOrAbove)
    ? t.ignoreAtOrAbove
    : DEFAULT_READING_CEILING_PCT;
  return value >= ceiling;
}

export function probeLossWindowSec(windowSec: number | null | undefined): number {
  return typeof windowSec === "number" && windowSec > 0
    ? Math.max(windowSec, PROBE_LOSS_MIN_WINDOW_SEC)
    : PROBE_LOSS_DEFAULT_WINDOW_SEC;
}

/**
 * The History window of a stored rule's probe-loss condition, in seconds — or
 * null when the trigger has no such condition (then a loss chart in its email,
 * if any, keeps the default last-hour window). Walks the raw stored `trigger`
 * JSON tolerantly: a flat `asset_metric` trigger or any `probeLossPct` leaf of
 * a composite tree (the widest window wins when a tree improbably carries two).
 * Never throws — this runs on the delivery drain, best-effort by contract.
 */
export function probeLossWindowSecFromTrigger(trigger: unknown): number | null {
  let found: number | null = null;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "asset_metric" && n.metric === "probeLossPct") {
      const w = probeLossWindowSec(typeof n.windowSec === "number" ? n.windowSec : null);
      found = found === null ? w : Math.max(found, w);
    } else if (n.type === "composite" && Array.isArray(n.children)) {
      for (const c of n.children) visit(c);
    } else if (Array.isArray(n.children)) {
      // A nested group inside a composite tree has no `type` of its own.
      for (const c of n.children) visit(c);
    }
  };
  visit(trigger);
  return found;
}

export const METRIC_META: Record<string, { label: string; unit: string }> = {
  // asset_metric
  cpuPct: { label: "CPU utilization", unit: "%" },
  // Any ONE logical core, its hold counted per core — agent and vCenter hosts only.
  cpuCorePct: { label: "CPU core utilization", unit: "%" },
  memPct: { label: "Memory utilization", unit: "%" },
  memUsedBytes: { label: "Memory used", unit: "bytes" },
  // Forecast metric: projected days until memory in use reaches 100% (30-day
  // trend of the daily average, ≥7 daily points; an asset whose memory is not
  // growing produces no reading — see memoryForecastService). The memory twin
  // of storageDaysUntilFull. Alert with "<=", e.g. ≤ 14 days.
  memDaysUntilFull: { label: "Days until memory full", unit: "days" },
  // Forecast metric: the memory in use (%) the 30-day trend reaches
  // `forecastDays` out (FORECAST_HORIZON_METRICS), so each severity level's
  // threshold is the level it warns about — "reaches 80% within 14 days" is
  // warning, "reaches 95%" critical. Growing hosts only; a flat or shrinking
  // host reads null (no projection), which also ends a live alert.
  memForecastPct: { label: "Memory forecast", unit: "%" },
  sessionCount: { label: "Active sessions", unit: "" },
  responseTimeMs: { label: "Response time", unit: "ms" },
  uptimeSec: { label: "Uptime", unit: "sec" },
  // Probe-failure ratio over the trigger window (failed probes / total probes),
  // the same computation as the dashboard Packet Loss widget — works for ANY
  // monitored asset (switch/AP/server), not just SD-WAN. Windowed ratio: the
  // window is the measurement interval, so aggregation doesn't apply. Alert
  // with ">", e.g. > 25%. This metric reports ONLY on a device that is
  // currently answering (monitorStatus up/warning), and only from its first
  // successful probe inside the window — an outage is the asset-down condition,
  // not packet loss, so one outage raises one alert (business rule 29).
  probeLossPct: { label: "Packet loss (probe)", unit: "%" },
  hwSensorValue: { label: "Hardware sensor value", unit: "(sensor unit)" },
  // The device's OWN alarm bit for the sensor, not a threshold Polaris
  // invents — `AssetHardwareSensorSample.alarmStatus`, already collected by the
  // FortiOS REST sensor-info and SNMP fgHwSensorTable paths and shown as the
  // System tab's STATUS column. Alerting on it beats a threshold on the reading:
  // the device knows its own per-model limits, and for a fan tray or a PSU the
  // health is IN this bit rather than in any comparable number.
  hwSensorAlarm: { label: "Hardware sensor alarm", unit: "" },
  storageUsedPct: { label: "Storage used", unit: "%" },
  storageUsedBytes: { label: "Storage used", unit: "bytes" },
  // Forecast metric: projected days until each growing filesystem fills
  // (30-day trend, ≥7 daily points; non-growing mounts produce no reading —
  // see storageForecastService). Alert with "<=", e.g. ≤ 14 days.
  storageDaysUntilFull: { label: "Days until storage full", unit: "days" },
  ifInErrorRate: { label: "Interface in-error rate", unit: "errors/s" },
  ifOutErrorRate: { label: "Interface out-error rate", unit: "errors/s" },
  ifInBps: { label: "Interface inbound", unit: "bps" },
  ifOutBps: { label: "Interface outbound", unit: "bps" },
  // Fibre-channel port counters (business rule 159a), per MINUTE: a failing
  // optic moves them a handful at a time, so a per-second figure is unreadable.
  fcCrcErrorRate: { label: "FC port CRC error rate", unit: "errors/min" },
  fcLinkFailureRate: { label: "FC port link failure rate", unit: "failures/min" },
  fcSyncLossRate: { label: "FC port loss-of-sync rate", unit: "events/min" },
  fcSignalLossRate: { label: "FC port loss-of-signal rate", unit: "events/min" },
  fcInvalidTxWordRate: { label: "FC port invalid transmission word rate", unit: "words/min" },
  sdwanLatencyMs: { label: "SD-WAN latency", unit: "ms" },
  sdwanJitterMs: { label: "SD-WAN jitter", unit: "ms" },
  sdwanPacketLoss: { label: "SD-WAN packet loss", unit: "%" },
  ipsecThroughputBps: { label: "IPsec throughput", unit: "bps" },
  customWidgetValue: { label: "Custom widget value", unit: "" },
  // Business rule 181: 0 normal, 1 warning, 2 critical — the levels the widget
  // itself defines. "at or above 1" alerts on warning; a severity band at 2
  // raises it to critical.
  customWidgetLevel: { label: "Custom widget level (1 = warning, 2 = critical)", unit: "" },
  // 0/1 reading from an operator-defined state probe (Manufacturer Profile →
  // state widget). Compared with "==" against 1 (the probe's true state) or 0;
  // the builder renders the probe's own labels ("Alarm" / "OK") instead of the
  // numbers, and there's no unit because there's no magnitude.
  customStateValue: { label: "Device state flag (0/1)", unit: "" },
  // Agent-run path checks (asset = the agent host, dimension = check).
  pathLatencyMs: { label: "Path latency", unit: "ms" },
  pathHttpStatus: { label: "Path HTTP status", unit: "" },
  pathOk: { label: "Path check result", unit: "" },
  // Failed runs / runs over the History window, like probeLossPct.
  pathFailurePct: { label: "Path failure rate", unit: "%" },
  pathHopCount: { label: "Traceroute hop count", unit: "hops" },
  // Days until the target's TLS certificate expires. Alert with "<", e.g. < 14.
  pathTlsDaysLeft: { label: "TLS certificate days remaining", unit: "days" },
  // host_metric
  memUsedPct: { label: "Memory utilization", unit: "%" },
  loadAvg1: { label: "Load average (1m)", unit: "" },
  loadAvg5: { label: "Load average (5m)", unit: "" },
  loadAvg15: { label: "Load average (15m)", unit: "" },
  procRssBytes: { label: "Process RSS", unit: "bytes" },
};

// Asset-state field metadata: label + input kind + (for enum/bool) valid values.
//
// `placeholder` is the hint the builder's free-text value box shows; it exists
// because the default ("e.g. up / down") is a lie on a field whose values are
// not statuses. `equalityOnly` withholds the ordered comparators from the
// operator select: the engine's compareValue can only answer == / != about a
// non-numeric string, so offering ">=" there builds a rule that is silently
// false forever.
//
// `integralDimension` names the dimension a reading of this field IS ABOUT,
// as opposed to one that narrows a set of them: the builder keeps that
// dimension's picker on the condition row itself (and never lifts it out into
// a group filter row), so the operator can say WHICH component the comparison
// names. Everything else in FIELD_DIMENSIONS is offered as a filter row —
// which is the right shape for "narrow every condition in this group", and the
// wrong one for a field whose reading is meaningless until one component is
// named.
//
// Every per-component state field now carries one. The earlier line — that a
// port is typeable from memory ("wan1", "port3") where a phase-1 tunnel name is
// not, so the interface trio could be left to filter rows — did not survive
// contact with the builder: an operator reading "Interface oper status == down"
// asks which interface ON THAT ROW, and the answer being two menu levels away
// under "+ Condition → Component name" is the gap, not the typing. Blank still
// means every monitored component on every scoped device, for all of them.
export const FIELD_META: Record<string, { label: string; kind: "enum" | "bool" | "number" | "text" | "dynamic"; values?: string[]; placeholder?: string; equalityOnly?: boolean; integralDimension?: string }> = {
  // "passive" = no down-detection automation covers the device, so Polaris
  // renders no verdict for it. It is still polled and still charted — the
  // counters keep advancing, they are simply never compared to a threshold.
  monitorStatus: { label: "Monitor status", kind: "enum", values: ["up", "warning", "recovering", "down", "passive", "unknown"] },
  status: { label: "Lifecycle status", kind: "enum", values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"] },
  // Not a run length since the leaky-bucket change (business rule 30): a miss
  // adds one, an answer takes one back. The KEY is unchanged because stored
  // automations reference it, but the label had to stop saying "consecutive" —
  // a rule reading `>= 5` now fires on five misses outstanding, which a flapping
  // device can reach without ever missing five in a row.
  consecutiveFailures: { label: "Missed polls outstanding", kind: "number" },
  dependencySuppressed: { label: "Dependency-suppressed", kind: "bool", values: ["true", "false"] },
  quarantined: { label: "Quarantined", kind: "bool", values: ["true", "false"] },
  // Business rule 59. Closed enum, same reasoning as poeStatus: the sweep
  // normalizes every controller word into exactly three values, so the wizard
  // offers a picker rather than a free-text box that can hold "Disconnected"
  // — the raw FortiOS word, which is stored for display and is NOT what this
  // field compares against.
  //
  // "unknown" is offered deliberately, not hidden as an internal state: it is
  // the reading for a device the controller answered about but did not list,
  // which on a FortiSwitch usually means the switch has been unplugged long
  // enough to age out of the managed-switch table entirely. An operator who
  // wants "tell me when the gate stops seeing this switch at all" writes
  // `!= up` rather than `== down`.
  fortilinkStatus: { label: "Controller link (FortiLink / CAPWAP)", kind: "enum", values: ["up", "down", "unknown"] },
  // Business rule 87. Closed enum: the comparison is made by Polaris from the
  // parsed versions, so the three words are the only readings that exist.
  // The operator's usual rule is `!= current`; `== newer` names the fleet
  // that is AHEAD of the image someone selected as primary.
  firmwareVsPrimary: { label: "Firmware vs Repository primary", kind: "enum", values: ["current", "older", "newer"] },
  // Business rule 118. Whole minutes the stream's polls have been failing; the
  // label carries the unit because FIELD_META has no unit slot.
  telemetryFailingMinutes:  { label: "CPU & memory polls failing (minutes)", kind: "number", placeholder: "e.g. 60" },
  systemInfoFailingMinutes: { label: "Interface polls failing (minutes)", kind: "number", placeholder: "e.g. 60" },
  // Free text (tags are operator-typed), matched whole and case-insensitively
  // like the scope condition's `tag` field. Equality only: "is tagged" / "is
  // not tagged" are the only questions a tag can answer.
  tag: { label: "Asset tag", kind: "text", equalityOnly: true, placeholder: "tag name" },
  // The interface is INTEGRAL on all three port-state fields (see the header):
  // the row says which port it is about, and blank keeps meaning "every
  // monitored interface", one alert each — the engine folds per dimension
  // either way, so naming a port narrows the rule rather than changing its
  // shape.
  ifOperStatus: { label: "Interface oper status", kind: "dynamic", integralDimension: "ifNamePattern" },
  ifAdminStatus: { label: "Interface admin status", kind: "dynamic", integralDimension: "ifNamePattern" },
  // The port's CURRENT L3 address, compared as a string. Its reason for
  // existing is the negative form: `!= 0.0.0.0` is how an operator says "this
  // interface actually has an address", which is the gate a rule about
  // something riding that interface needs — an SD-WAN overlay's health check
  // reports total packet loss whenever its underlay WAN port is unaddressed,
  // and that is the underlay's outage to alert about, not the overlay's. The
  // engine normalizes both sides through `bareInterfaceIp`, so the mask-
  // carrying shapes ("0.0.0.0 0.0.0.0") compare equal to the bare address.
  //
  // The interface is INTEGRAL here (see the header): a comparison against an
  // address is about one port, and with no port named the leaf reads "any
  // monitored interface" — which a composite folds per device through the
  // engine's ANY fold (leafTruthByAsset), so `!= 0.0.0.0` would be true of
  // every addressed device and the gate this field exists to be would gate
  // nothing.
  ifIpAddress: { label: "Interface IP address", kind: "dynamic", placeholder: "e.g. 0.0.0.0", equalityOnly: true, integralDimension: "ifNamePattern" },
  // Closed enum rather than "dynamic" (which ifOperStatus uses): every value
  // POWER-ETHERNET-MIB can report is known up front, so the wizard offers a
  // picker and a typo cannot silently produce a rule that never matches.
  poeStatus: { label: "Interface PoE status", kind: "enum", values: [...POE_STATUS_VALUES], integralDimension: "ifNamePattern" },
  // The tunnel is INTEGRAL (see the header) with the sharpest case for it: a
  // tunnel name is a phase-1 name an operator cannot type from memory, so
  // "IPsec tunnel status is down" with no tunnel named is a rule about every
  // pinned tunnel on every scoped gate — a much noisier statement than the one
  // an operator building it almost always means. Blank still means exactly
  // that, and the engine still folds one alert per tunnel; what the inline
  // picker adds is the chance to SAY which tunnel, from the names the scoped
  // devices actually pin (notificationDimensionService's tunnelName source), on
  // the row where the comparison lives instead of only through
  // "+ Condition → Component name".
  ipsecStatus: { label: "IPsec tunnel status", kind: "dynamic", integralDimension: "tunnelName" },
  sdwanRuleStatus: { label: "SD-WAN rule status", kind: "dynamic" },
  sdwanSelectedMember: { label: "SD-WAN selected member", kind: "dynamic" },
  // Closed enum for poeStatus's reason: the collector normalizes every shape
  // FortiOS reports (status / state / alive, string or number) down to exactly
  // "up" | "down" in `normalizeSdwanState`, so both values are known up front
  // and a typed "dead" would build a rule that reads false forever.
  sdwanMemberState: { label: "SD-WAN member state", kind: "enum", values: ["up", "down"] },
};

export const CHANGE_TYPE_META: Record<string, string> = {
  lldp_neighbor_added: "LLDP neighbor appeared",
  lldp_neighbor_removed: "LLDP neighbor disappeared",
  process_started: "Process started",
  process_stopped: "Process stopped",
  sdwan_failover: "SD-WAN failover (member changed)",
  mclag_peer_lost: "MCLAG peer lost",
  wireless_station_connected: "Wireless station connected",
  firmware_changed: "Firmware / OS version changed",
  switch_port_changed: "Switch port changed",
  wireless_ap_changed: "Wireless AP changed (roam)",
  gateway_firewall_changed: "Gateway FortiGate changed",
  fortilink_changed: "Controller link changed (FortiLink / CAPWAP)",
  path_check_path_changed: "Path changed (traceroute)",
};

/**
 * Business rule 124. Does an `ifNamePattern` select this interface? The pattern is an any-of list
 * joined by "|" (the SD-WAN pair's shape, utils/sdwanDimensions), and each term
 * is a case-insensitive substring of the interface's system name OR its
 * description. The description counts because that is where operators name a
 * circuit: one FortiGate carries "ATT EPLS" as a VLAN interface's NAME while
 * another carries it as port25's DESCRIPTION, and the Interfaces tab shows the
 * same words for both. A single term with no "|" reads exactly as the old
 * name-only substring did, plus the description. Interface names don't carry
 * "|" (FortiOS forbids it; ifName/ifDescr never use it), so the separator can't
 * split a real name. No terms = match. MIRRORED client-side by the wizard's
 * awSdwanDimensionMatch over the picker's names and descriptions.
 */
export function interfacePatternMatch(
  ifName: string | null | undefined,
  alias: string | null | undefined,
  pattern?: string | null,
): boolean {
  const terms = sdwanDimensionTerms(pattern);
  if (terms.length === 0) return true;
  return terms.some((t) => dimensionSubstringMatch(ifName, t) || dimensionSubstringMatch(alias, t));
}

/**
 * Does a hwSensorValue dimension filter select this sensor? Shared by the
 * engine's reading resolver AND the asset chart's severity-tier lookup — the
 * chart colors a line by the thresholds that would actually fire on it, so a
 * second, subtly different copy of this predicate would paint a sensor with
 * bands belonging to some other sensor.
 */
export function hwSensorFilterMatches(
  df: { sensorClass?: string; sensorNamePattern?: string } | null | undefined,
  sensor: { sensorName?: string | null; sensorClass?: string | null },
): boolean {
  if (!df) return true;
  if (df.sensorClass && df.sensorClass !== (sensor.sensorClass ?? "")) return false;
  return dimensionSubstringMatch(sensor.sensorName, df.sensorNamePattern);
}

/** Does a path* dimension filter select this check? Shared by the engine's
 *  resolvers (applied in SQL there) and getMetricSeverityTiers, so a chart is
 *  never shaded with another check's thresholds. */
export function pathCheckFilterMatches(
  df: { checkId?: string } | null | undefined,
  check: { checkId?: string | null },
): boolean {
  if (!df?.checkId) return true;
  return df.checkId === (check.checkId ?? "");
}

/**
 * Does a port carrying `tags` pass an `ifTag` filter? Pure. Each "|" term is a
 * whole tag name, compared case-insensitively — the same matching the device
 * `tag` condition uses, so "critical" never selects "priority-critical". No
 * terms = match; a port with no tags fails any non-empty filter.
 */
export function interfaceTagMatch(tags: readonly string[] | null | undefined, pattern?: string | null): boolean {
  const terms = sdwanDimensionTerms(pattern).map((t) => t.toLowerCase());
  if (terms.length === 0) return true;
  return (tags ?? []).some((t) => terms.includes(t.toLowerCase()));
}

/**
 * Does a member whose interface reports `reported` pass the filter? Pure.
 *
 * null when the address is UNKNOWN — no interface row, or a scrape that
 * collected no address field — and the caller KEEPS such a reading: the
 * filter removes members it has evidence about, never ones it could not read.
 * "0.0.0.0" in the filter matches every unaddressed shape the transports
 * report ("0.0.0.0", "0.0.0.0 0.0.0.0", blank) — utils/cidr.interfaceIpIsUnaddressed.
 */
export function memberIpPasses(filter: MemberIpFilter, reported: string | null | undefined): boolean | null {
  if (reported == null) return null;
  const equal = filter.ip === "0.0.0.0"
    ? interfaceIpIsUnaddressed(reported)
    : bareInterfaceIp(reported).toLowerCase() === filter.ip.toLowerCase();
  return filter.operator === "==" ? equal : !equal;
}

/**
 * Is `dimension` a valid dimensionFilter input for `metricOrField` (an
 * ASSET_METRICS name, an ASSET_STATE_FIELDS name — the two share no name)?
 * The dimension-values endpoint validates through this so a stale client gets
 * a 400 rather than an empty list that reads as "these devices report none".
 */
export function triggerDimensionApplicable(metricOrField: string, dimension: string): boolean {
  if (METRIC_DIMENSIONS[metricOrField]?.includes(dimension)) return true;
  if (FIELD_DIMENSIONS[metricOrField]?.includes(dimension)) return true;
  if (dimension === "ifTag") return INTERFACE_TAG_TARGETS.has(metricOrField);
  return (
    (DEVICE_FILTER_DIMENSIONS as readonly string[]).includes(dimension) &&
    ((ASSET_METRICS as readonly string[]).includes(metricOrField) ||
      (ASSET_STATE_FIELDS as readonly string[]).includes(metricOrField))
  );
}
