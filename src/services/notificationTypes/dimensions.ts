/**
 * src/services/notificationTypes/dimensions.ts — the alertable dimensions (CQ-B063, moved verbatim from notificationTypes.ts): which
 * metrics and state fields alert per interface / storage / sensor / tunnel / SD-WAN member,
 * the SD-WAN member-IP and interface-tag targets, and triggerIsPerDimension.
 */

import { type Trigger } from "./triggers.js";

export const METRIC_DIMENSIONS: Record<string, string[]> = {
  hwSensorValue: ["sensorClass", "sensorNamePattern"],
  hwSensorAlarm: ["sensorClass", "sensorNamePattern"],
  storageUsedPct: ["mountPathPattern"],
  storageUsedBytes: ["mountPathPattern"],
  storageDaysUntilFull: ["mountPathPattern"],
  ifInErrorRate: ["ifNamePattern"],
  ifOutErrorRate: ["ifNamePattern"],
  ifInBps: ["ifNamePattern"],
  ifOutBps: ["ifNamePattern"],
  sdwanLatencyMs: ["healthCheck", "link"],
  sdwanJitterMs: ["healthCheck", "link"],
  sdwanPacketLoss: ["healthCheck", "link"],
  ipsecThroughputBps: ["tunnelName"],
  customWidgetValue: ["widgetId"],
  customStateValue: ["stateProbeId", "stateRowPattern"],
  pathLatencyMs: ["checkId"],
  pathHttpStatus: ["checkId"],
  pathOk: ["checkId"],
  pathFailurePct: ["checkId"],
  pathHopCount: ["checkId"],
  pathTlsDaysLeft: ["checkId"],
};

// Which dimensionFilter inputs apply per asset_state FIELD — the state twin of
// METRIC_DIMENSIONS. The engine has honored ifNamePattern on the interface
// state trio and tunnelName on ipsecStatus since the pin-gate work, but the
// builder never rendered an input for them, so "Interface oper status is down
// on interfaces matching wan" was expressible only through the raw API. The
// SD-WAN rule pair carries no name filter because the engine has none for it
// (rules alert per ruleName dimension already), while sdwanMemberState takes
// the same health-check + member pair the SD-WAN METRICS take, from the same
// sample table. Device-identifier dimensions are NOT
// listed per metric/field — DEVICE_FILTER_DIMENSIONS below applies to every
// asset leaf uniformly.
export const FIELD_DIMENSIONS: Record<string, string[]> = {
  ifOperStatus: ["ifNamePattern"],
  ifAdminStatus: ["ifNamePattern"],
  ifIpAddress: ["ifNamePattern"],
  poeStatus: ["ifNamePattern"],
  ipsecStatus: ["tunnelName"],
  sdwanRuleStatus: ["sdwanRulePattern"],
  sdwanSelectedMember: ["sdwanRulePattern"],
  sdwanMemberState: ["healthCheck", "link"],
};

// ── SD-WAN member IP address (business rule 98) ─────────────────────────────
// A filter on the conditions that read one SD-WAN MEMBER per reading, by that
// member's current interface address: `dimensionFilter.sdwanMemberIp` =
// "!= 0.0.0.0" keeps a WAN with no address out of every one of them.
//
// Deliberately NOT in METRIC_DIMENSIONS / FIELD_DIMENSIONS: those lists are the
// reading-KEY space (dimensionSpaceOf), and this narrows readings without
// keying them — listing it there would split the SD-WAN metrics' space from
// member state's and break a mixed reset tree. And a filter on the condition,
// not a second condition: a separate "interface IP" leaf in a multi-condition
// automation folds per DEVICE, so it could never say which member it meant.
export const SDWAN_MEMBER_IP_TARGETS: ReadonlySet<string> = new Set([
  "sdwanMemberState", "sdwanLatencyMs", "sdwanJitterMs", "sdwanPacketLoss",
]);

// ── Interface tag (business rule 133(g)) ────────────────────────────────────
// A filter on the conditions that read one INTERFACE per reading, by the tags
// on that port (AssetInterfaceTag, manual and auto alike): "interface down on
// ports tagged priority-critical". Derived from the interface-name dimension so
// the two can't disagree about which conditions are about an interface. Kept
// out of METRIC_DIMENSIONS / FIELD_DIMENSIONS for the reason sdwanMemberIp is:
// it narrows readings, it does not key them.
export const INTERFACE_TAG_TARGETS: ReadonlySet<string> = new Set(
  [...Object.entries(METRIC_DIMENSIONS), ...Object.entries(FIELD_DIMENSIONS)]
    .filter(([, dims]) => dims.includes("ifNamePattern"))
    .map(([key]) => key),
);

/**
 * Which asset-STATE fields the engine reports per dimension rather than once
 * per device — the state-side counterpart of METRIC_DIMENSIONS. Derived from the
 * resolvers in notificationEngine: the interface trio walks AssetInterface rows,
 * ipsecStatus the tunnels, the SD-WAN pair the rules, and everything else
 * (monitorStatus, status, quarantined …) is one reading for the whole asset.
 *
 * The builder renders no dimensionFilter inputs for a state leaf, so unlike
 * METRIC_DIMENSIONS this isn't a form-field list — it exists so a surface can
 * ask "does this trigger raise one alert per interface?", which is what decides
 * whether a custom reset condition clears one alert or all of them.
 */
export const STATE_FIELD_DIMENSIONS: Record<string, string[]> = {
  ifOperStatus: ["ifNamePattern"],
  ifAdminStatus: ["ifNamePattern"],
  ifIpAddress: ["ifNamePattern"],
  poeStatus: ["ifNamePattern"],
  ipsecStatus: ["tunnelName"],
  sdwanRuleStatus: ["healthCheck"],
  sdwanSelectedMember: ["healthCheck"],
  // One reading per (health check, WAN member) — so a reset condition on this
  // field clears the one member's alert, not every member on the gate.
  sdwanMemberState: ["healthCheck", "link"],
};

/** Does this trigger report one reading PER COMPONENT (rather than one per
 *  device)?
 *
 *  The server-side twin of the wizard's `triggerDimensions(tr)`, which until now
 *  existed only in automations-wizard.js. One predicate, read by the validator,
 *  the engine and the schema catalog — the same argument the codebase makes for
 *  keeping `hwSensorFilterMatches` single. */
export function triggerIsPerDimension(trigger: Trigger | null | undefined): boolean {
  if (!trigger) return false;
  if (trigger.type === "asset_metric") return (METRIC_DIMENSIONS[trigger.metric] ?? []).length > 0;
  if (trigger.type === "asset_state") return (STATE_FIELD_DIMENSIONS[trigger.field] ?? []).length > 0;
  // A composite already fires once per device (dimensionKey ""), host metrics
  // have no device to fold onto, and event/change write no state row at all.
  return false;
}
