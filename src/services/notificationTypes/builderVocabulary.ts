/**
 * src/services/notificationTypes/builderVocabulary.ts — the condition-tree builder vocabulary published to the UI (CQ-B063, moved verbatim
 * from notificationTypes.ts): SCOPE_FIELD_META and scopeConditionMeta — the fields, labels
 * and operators the device-filter builder offers.
 */

import { SCOPE_GROUP_OPS, SCOPE_FIELD_OPS, WILDCARD_OP, SCOPE_CONDITION_MAX_DEPTH, SCOPE_CONDITION_MAX_RULES } from "./scopeConditions.js";
import { SCOPE_RANK_LADDER } from "./specificity.js";

// ─── Condition-tree builder vocabulary (published to the UI) ────────────────

/**
 * Per-field presentation: the label the builder shows and which option list
 * feeds its value suggestions ("assetTypes" | "manufacturers" | "models" |
 * "tags" | "subnets" from /scope-options + the registry; null = free text).
 *
 * One catalog for both vocabularies so "Behind FortiGate" can't come out named
 * one thing in the address book and another in the wizard.
 */
const SCOPE_FIELD_META: Record<string, { label: string; optionsFrom: string | null; values?: string[] }> = {
  assetType: { label: "Device type", optionsFrom: "assetTypes" },
  manufacturer: { label: "Manufacturer", optionsFrom: "manufacturers" },
  model: { label: "Model", optionsFrom: "models" },
  hostname: { label: "Hostname", optionsFrom: null },
  os: { label: "Operating system", optionsFrom: null },
  tag: { label: "Tag", optionsFrom: "tags" },
  subnet: { label: "Subnet / IP", optionsFrom: "subnets" },
  ipBlock: { label: "IP block", optionsFrom: "ipBlocks" },
  interfaceName: { label: "Device interface", optionsFrom: "interfaceNames" },
  ssid: { label: "Broadcast SSID", optionsFrom: "ssids" },
  // `values` rather than `optionsFrom`: every client valueOptions switch
  // returns a field's `values` before consulting optionsFrom, so a closed
  // yes/no field needs no case in any of them.
  agentInstalled: { label: "Polaris Agent installed", optionsFrom: null, values: ["yes", "no"] },
  status: {
    label: "Lifecycle status",
    optionsFrom: null,
    values: ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"],
  },
  osVersion: { label: "OS version", optionsFrom: null },
  department: { label: "Department", optionsFrom: null },
  location: { label: "Location", optionsFrom: null },
  fortigate: { label: "Behind FortiGate", optionsFrom: null },
  // Options are { value: id, label: "30 · Users_VL30" } — the VLAN names the
  // fleet's VLAN interfaces carry — from listScopeOptions' `nativeVlans`.
  nativeVlan: { label: "Native VLAN", optionsFrom: "nativeVlans" },
  // NOTE: `assetId` remains a valid field for saved rules (SCOPE_FIELD_OPS +
  // matchScopeRule still handle it) but is deliberately absent here, so it is
  // not offered as a new builder choice — a raw id targets one device with no
  // precedence meaning; use hostname instead.
};

/**
 * The builder catalog for one field vocabulary. `specificity` is meaningful only
 * for automations (it drives the carve-out ladder), so it rides the caller's
 * choice of field set rather than being unconditional.
 */
export function scopeConditionMeta(fieldOps: Record<string, readonly string[]>) {
  return {
    groupOps: SCOPE_GROUP_OPS,
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    operatorLabels: {
      equals: "is equal to",
      notEquals: "is not equal to",
      contains: "contains",
      notContains: "does not contain",
      startsWith: "starts with",
      endsWith: "ends with",
      has: "is applied",
      notHas: "is not applied",
      // Deliberately not "is in subnet": the same operator now carries the
      // `ipBlock` field, and the label is what both the operator dropdown and
      // the automations-list prose summary render.
      // Named by HOW the addresses are given, since `subnet` offers three ways
      // (CIDR / Range / Name) and the dropdown is where the choice is made.
      inCidr: "is within CIDR",
      notInCidr: "is not within CIDR",
      inRange: "is within range",
      notInRange: "is not within range",
      inSubnetNamed: "is in subnet named",
      notInSubnetNamed: "is not in subnet named",
      [WILDCARD_OP]: "matches (wildcard *)",
    },
    // What the value box holds for an operator whose value is not the field's
    // usual kind. The builder reads it for the placeholder, the suggestion
    // list (subnet NAMES rather than CIDRs, none for a range) and its own
    // pre-save check; an operator absent here takes the field's defaults.
    operatorValueKinds: {
      inCidr: "cidr",
      notInCidr: "cidr",
      inRange: "ipRange",
      notInRange: "ipRange",
      inSubnetNamed: "subnetName",
      notInSubnetNamed: "subnetName",
    },
    fields: Object.keys(fieldOps)
      .filter((field) => SCOPE_FIELD_META[field])
      .map((field) => ({
        field,
        label: SCOPE_FIELD_META[field]!.label,
        ops: fieldOps[field],
        optionsFrom: SCOPE_FIELD_META[field]!.optionsFrom,
        ...(SCOPE_FIELD_META[field]!.values ? { values: SCOPE_FIELD_META[field]!.values } : {}),
      })),
    maxDepth: SCOPE_CONDITION_MAX_DEPTH,
    maxRules: SCOPE_CONDITION_MAX_RULES,
    // Precedence ladder (least → most specific). Drives the wizard's
    // "Specificity" indicator; the carve-out engine ranks scopes by it. Only
    // automations have a precedence model, so it's omitted elsewhere.
    ...(fieldOps === SCOPE_FIELD_OPS ? { specificity: SCOPE_RANK_LADDER } : {}),
  };
}
