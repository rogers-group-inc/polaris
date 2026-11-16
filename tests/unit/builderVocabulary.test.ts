/**
 * tests/unit/builderVocabulary.test.ts — the condition-tree builder catalog
 * published to the UI (CQ-T010). One catalog feeds the automations scope
 * (SCOPE_FIELD_OPS) and the device-filter builders (DEVICE_FILTER_FIELD_OPS);
 * every operator a field offers must have a label, every group op a label, and
 * `specificity` rides only the automations vocabulary.
 */

import { describe, it, expect } from "vitest";
import { scopeConditionMeta } from "../../src/services/notificationTypes/builderVocabulary.js";
import {
  SCOPE_FIELD_OPS,
  DEVICE_FILTER_FIELD_OPS,
  SCOPE_GROUP_OPS,
  WILDCARD_OP,
  SCOPE_CONDITION_MAX_DEPTH,
  SCOPE_CONDITION_MAX_RULES,
} from "../../src/services/notificationTypes/scopeConditions.js";
import { SCOPE_RANK_LADDER } from "../../src/services/notificationTypes/specificity.js";

describe("scopeConditionMeta — automations vocabulary", () => {
  const meta = scopeConditionMeta(SCOPE_FIELD_OPS);

  it("publishes every SCOPE_FIELD_OPS field except assetId, in declaration order", () => {
    expect(meta.fields.map((f) => f.field)).toEqual(Object.keys(SCOPE_FIELD_OPS).filter((f) => f !== "assetId"));
  });

  it("deliberately omits assetId even though saved rules may use it", () => {
    expect(meta.fields.some((f) => f.field === "assetId")).toBe(false);
  });

  it("each field carries the vocabulary's own ops array", () => {
    for (const f of meta.fields) expect(f.ops).toBe(SCOPE_FIELD_OPS[f.field]);
  });

  it("carries the specificity ladder", () => {
    expect(meta.specificity).toBe(SCOPE_RANK_LADDER);
  });

  it("publishes the limits and group ops", () => {
    expect(meta.groupOps).toBe(SCOPE_GROUP_OPS);
    expect(meta.maxDepth).toBe(SCOPE_CONDITION_MAX_DEPTH);
    expect(meta.maxRules).toBe(SCOPE_CONDITION_MAX_RULES);
  });
});

describe("scopeConditionMeta — device-filter vocabulary", () => {
  const meta = scopeConditionMeta(DEVICE_FILTER_FIELD_OPS);

  it("includes the device-filter-only fields with their labels", () => {
    const byField = Object.fromEntries(meta.fields.map((f) => [f.field, f]));
    expect(byField.fortigate).toMatchObject({ label: "Behind FortiGate", optionsFrom: null });
    expect(byField.nativeVlan).toMatchObject({ label: "Native VLAN", optionsFrom: "nativeVlans" });
    expect(byField.osVersion?.label).toBe("OS version");
    expect(byField.department?.label).toBe("Department");
    expect(byField.location?.label).toBe("Location");
  });

  it("omits specificity (only automations have a precedence model)", () => {
    expect(meta).not.toHaveProperty("specificity");
  });

  it("an equal-but-different map object also gets no specificity (identity, not shape)", () => {
    expect(scopeConditionMeta({ ...SCOPE_FIELD_OPS })).not.toHaveProperty("specificity");
  });
});

describe("scopeConditionMeta — label coverage", () => {
  it.each([
    ["SCOPE_FIELD_OPS", SCOPE_FIELD_OPS],
    ["DEVICE_FILTER_FIELD_OPS", DEVICE_FILTER_FIELD_OPS],
  ] as const)("every operator %s offers has a label", (_name, ops) => {
    const meta = scopeConditionMeta(ops);
    const labels = meta.operatorLabels as Record<string, string>;
    for (const f of meta.fields) for (const op of f.ops) expect(labels[op], `${f.field}.${op}`).toEqual(expect.any(String));
  });

  it("every group op has a label", () => {
    const meta = scopeConditionMeta(SCOPE_FIELD_OPS);
    for (const g of SCOPE_GROUP_OPS) expect((meta.groupOpLabels as Record<string, string>)[g]).toEqual(expect.any(String));
  });

  it("labels the wildcard under its op name", () => {
    expect((scopeConditionMeta(DEVICE_FILTER_FIELD_OPS).operatorLabels as Record<string, string>)[WILDCARD_OP]).toBe("matches (wildcard *)");
  });

  it("every operatorValueKinds key is a labelled operator", () => {
    const meta = scopeConditionMeta(SCOPE_FIELD_OPS);
    for (const op of Object.keys(meta.operatorValueKinds)) expect(Object.keys(meta.operatorLabels)).toContain(op);
    expect(meta.operatorValueKinds).toEqual({
      inCidr: "cidr",
      notInCidr: "cidr",
      inRange: "ipRange",
      notInRange: "ipRange",
      inSubnetNamed: "subnetName",
      notInSubnetNamed: "subnetName",
    });
  });
});

describe("scopeConditionMeta — field presentation", () => {
  it("closed yes/no and lifecycle fields publish `values`; others do not carry the key", () => {
    const meta = scopeConditionMeta(DEVICE_FILTER_FIELD_OPS);
    const byField = Object.fromEntries(meta.fields.map((f) => [f.field, f as Record<string, unknown>]));
    expect(byField.agentInstalled?.values).toEqual(["yes", "no"]);
    expect(byField.status?.values).toEqual(["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"]);
    expect(byField.hostname).not.toHaveProperty("values");
    expect(byField.tag).toMatchObject({ label: "Tag", optionsFrom: "tags" });
    expect(byField.subnet).toMatchObject({ label: "Subnet / IP", optionsFrom: "subnets" });
  });

  it("a field with no catalog entry is dropped rather than published unlabelled", () => {
    const meta = scopeConditionMeta({ hostname: ["equals"], madeUp: ["equals"] });
    expect(meta.fields).toEqual([{ field: "hostname", label: "Hostname", ops: ["equals"], optionsFrom: null }]);
  });

  it("an empty vocabulary publishes no fields", () => {
    expect(scopeConditionMeta({}).fields).toEqual([]);
  });

  it("returns a fresh object each call (callers can't corrupt the next response)", () => {
    const a = scopeConditionMeta(SCOPE_FIELD_OPS);
    const b = scopeConditionMeta(SCOPE_FIELD_OPS);
    expect(a).not.toBe(b);
    expect(a.operatorLabels).not.toBe(b.operatorLabels);
    expect(a).toEqual(b);
  });
});
