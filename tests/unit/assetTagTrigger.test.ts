/**
 * tests/unit/assetTagTrigger.test.ts
 *
 * The `tag` asset-state field: "is / is not tagged X" as an automation trigger
 * condition. The reading itself (which assets carry the tag) is the engine's;
 * what is pinned here is the contract around it — the vocabulary, what the
 * schema refuses, the carve-out signature and the sentence.
 */

import { describe, it, expect } from "vitest";
import {
  ruleInputSchema,
  ASSET_STATE_FIELDS,
  FIELD_META,
  triggerSignature,
  type Trigger,
} from "../../src/services/notificationTypes.js";
import { compareValue, triggerHandsOffWhenDeviceDown } from "../../src/services/notificationEngine.js";
import { streamForMetric } from "../../src/services/notificationCadenceService.js";
import { triggerSummary } from "../../src/utils/triggerSummary.js";

const rule = (trigger: unknown) => ({ name: "r", scope: { allAssets: true }, trigger });
const issuePaths = (r: ReturnType<typeof ruleInputSchema.safeParse>) =>
  r.success ? [] : r.error.issues.map((i) => i.path.join("."));

describe("asset tag trigger condition", () => {
  it("is a state field with a wizard label and an equality-only text box", () => {
    expect(ASSET_STATE_FIELDS).toContain("tag");
    expect(FIELD_META.tag).toMatchObject({ kind: "text", equalityOnly: true });
  });

  it("accepts is / is-not on a named tag, alone or inside a composite", () => {
    const single = { type: "asset_state", field: "tag", operator: "==", value: "prod" };
    expect(ruleInputSchema.safeParse(rule(single)).success).toBe(true);
    expect(ruleInputSchema.safeParse(rule({ ...single, operator: "!=" })).success).toBe(true);
    const composite = {
      type: "composite", kind: "asset", op: "and",
      children: [single, { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" }],
    };
    expect(ruleInputSchema.safeParse(rule(composite)).success).toBe(true);
  });

  it("refuses a blank tag name and an ordered comparator", () => {
    const blank = ruleInputSchema.safeParse(rule({ type: "asset_state", field: "tag", operator: "==", value: "  " }));
    expect(issuePaths(blank)).toContain("trigger.value");
    const ordered = ruleInputSchema.safeParse(rule({ type: "asset_state", field: "tag", operator: ">=", value: "prod" }));
    expect(issuePaths(ordered)).toContain("trigger.value");
  });

  it("reads as 'the tag, or blank', so the ordinary comparator answers both forms", () => {
    // The engine's reading for a tagged asset is the tag; for an untagged one, "".
    expect(compareValue("prod", "==", "prod")).toBe(true);
    expect(compareValue("", "==", "prod")).toBe(false);
    expect(compareValue("", "!=", "prod")).toBe(true);
    expect(compareValue("prod", "!=", "prod")).toBe(false);
  });

  it("keeps two tags apart in the carve-out signature", () => {
    const t = (value: string): Trigger => ({ type: "asset_state", field: "tag", operator: "==", value } as Trigger);
    expect(triggerSignature(t("prod"))).not.toBe(triggerSignature(t("dev")));
    expect(triggerSignature(t("PROD"))).toBe(triggerSignature(t("prod")));
  });

  it("is a held fact: it neither hands off to asset-down nor rides a collector cadence", () => {
    const t = { type: "asset_state", field: "tag", operator: "==", value: "prod" } as Trigger;
    expect(triggerHandsOffWhenDeviceDown(t)).toBe(false);
    expect(streamForMetric("tag")).toBe("responseTime");
  });

  it("states presence and absence in words", () => {
    const trigger = { type: "asset_state", field: "tag", operator: "==", value: "prod" };
    expect(triggerSummary({ trigger, value: "prod" })).toBe('Asset has the tag "prod"');
    expect(triggerSummary({ trigger, value: "" })).toBe('Asset does not have the tag "prod"');
  });
});
