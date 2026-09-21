/**
 * tests/unit/downDetectionTriggerSchema.test.ts
 *
 * `missedPolls` is down-detection AUTHORITY, so the schema's job is to keep it
 * where the probe loop will actually read it. Everything here is about a number
 * that would otherwise look configured and silently govern nothing.
 *
 * Plus the one property that protects operators from a nasty surprise while
 * tuning: changing the count must NOT count as a trigger-identity change, or
 * updateRule wipes every NotificationRuleState row and re-arms every debounce
 * across the fleet.
 */

import { describe, it, expect } from "vitest";
import { ruleInputSchema, isDownDetectionTrigger, ruleAlertsWhenDependencyDown, DEFAULT_MISSED_POLLS, buildSchemaCatalog } from "../../src/services/notificationTypes.js";
import { triggerIdentityOf } from "../../src/services/notificationRuleService.js";

const base = { name: "Asset down", severity: "critical", scope: { allAssets: true }, reset: { mode: "auto" } };
const downTrigger = (extra: Record<string, unknown> = {}) =>
  ({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down", ...extra });

describe("isDownDetectionTrigger", () => {
  it("recognises the bare `monitorStatus == down` trigger", () => {
    expect(isDownDetectionTrigger(downTrigger() as any)).toBe(true);
    expect(isDownDetectionTrigger(downTrigger({ value: "Down" }) as any)).toBe(true);
  });

  it("rejects every near-miss", () => {
    expect(isDownDetectionTrigger(downTrigger({ value: "warning" }) as any)).toBe(false);
    expect(isDownDetectionTrigger(downTrigger({ operator: "!=" }) as any)).toBe(false);
    expect(isDownDetectionTrigger({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" } as any)).toBe(false);
    expect(isDownDetectionTrigger({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90 } as any)).toBe(false);
  });
});

describe("ruleInputSchema — where missedPolls may live", () => {
  it("accepts a count on a down trigger", () => {
    const r = ruleInputSchema.parse({ ...base, trigger: downTrigger({ missedPolls: 5 }) });
    expect((r.trigger as any).missedPolls).toBe(5);
  });

  it("accepts a down trigger with NO count — it governs at the default", () => {
    const r = ruleInputSchema.parse({ ...base, trigger: downTrigger() });
    expect((r.trigger as any).missedPolls).toBeUndefined();
    expect(DEFAULT_MISSED_POLLS).toBe(3);
  });

  it("enforces the 1..100 range", () => {
    expect(() => ruleInputSchema.parse({ ...base, trigger: downTrigger({ missedPolls: 0 }) })).toThrow();
    expect(() => ruleInputSchema.parse({ ...base, trigger: downTrigger({ missedPolls: 101 }) })).toThrow();
    expect(() => ruleInputSchema.parse({ ...base, trigger: downTrigger({ missedPolls: 2.5 }) })).toThrow();
  });

  it("refuses a count on a state field the probe loop never consults", () => {
    expect(() =>
      ruleInputSchema.parse({ ...base, trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", missedPolls: 3 } }),
    ).toThrow(/missed-poll count only applies/);
  });

  it("refuses a count on `monitorStatus == warning`", () => {
    expect(() =>
      ruleInputSchema.parse({ ...base, trigger: downTrigger({ value: "warning", missedPolls: 3 }) }),
    ).toThrow(/missed-poll count only applies/);
  });

  it("refuses a count inside a MULTI-leaf composite", () => {
    // Down is decided by the probe loop, which can only see whether the device
    // answered — it cannot evaluate a CPU reading on the way to that verdict.
    expect(() =>
      ruleInputSchema.parse({
        ...base,
        trigger: {
          type: "composite", kind: "asset", op: "and",
          children: [
            downTrigger({ missedPolls: 2 }),
            { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "avg", windowSec: 300 },
          ],
        },
      }),
    ).toThrow(/cannot sit inside a multi-condition trigger/);
  });

  it("ACCEPTS a single-leaf composite — it has already collapsed to a bare trigger", () => {
    // This is the shape the wizard submits, so the count must survive the
    // collapse rather than being rejected or silently stripped.
    const r = ruleInputSchema.parse({
      ...base,
      trigger: { type: "composite", kind: "asset", op: "and", children: [downTrigger({ missedPolls: 7 })] },
    });
    expect(r.trigger.type).toBe("asset_state");
    expect((r.trigger as any).missedPolls).toBe(7);
  });
});

describe("ruleInputSchema — where alertWhenDependencyDown may live (business rule 78)", () => {
  it("accepts the toggle on a down trigger, and the read helper honours it", () => {
    const r = ruleInputSchema.parse({ ...base, trigger: downTrigger({ missedPolls: 3, alertWhenDependencyDown: true }) });
    expect((r.trigger as any).alertWhenDependencyDown).toBe(true);
    expect(ruleAlertsWhenDependencyDown(r.trigger as any)).toBe(true);
  });

  it("absent = off, which is every automation authored before the key existed", () => {
    const r = ruleInputSchema.parse({ ...base, trigger: downTrigger() });
    expect((r.trigger as any).alertWhenDependencyDown).toBeUndefined();
    expect(ruleAlertsWhenDependencyDown(r.trigger as any)).toBe(false);
    expect(ruleAlertsWhenDependencyDown(downTrigger({ alertWhenDependencyDown: false }) as any)).toBe(false);
  });

  it("the read helper ignores the key on anything but a down trigger", () => {
    expect(ruleAlertsWhenDependencyDown(downTrigger({ value: "warning", alertWhenDependencyDown: true }) as any)).toBe(false);
    expect(ruleAlertsWhenDependencyDown({ type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, alertWhenDependencyDown: true } as any)).toBe(false);
  });

  it("refuses the toggle on a state field that is not the down verdict", () => {
    expect(() =>
      ruleInputSchema.parse({ ...base, trigger: downTrigger({ value: "warning", alertWhenDependencyDown: true }) }),
    ).toThrow(/dependency-down only applies/);
    expect(() =>
      ruleInputSchema.parse({ ...base, trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", alertWhenDependencyDown: true } }),
    ).toThrow(/dependency-down only applies/);
  });

  it("refuses the toggle inside a MULTI-leaf composite", () => {
    expect(() =>
      ruleInputSchema.parse({
        ...base,
        trigger: {
          type: "composite", kind: "asset", op: "and",
          children: [
            downTrigger({ alertWhenDependencyDown: true }),
            { type: "asset_metric", metric: "cpuPct", operator: ">", threshold: 90, aggregation: "avg", windowSec: 300 },
          ],
        },
      }),
    ).toThrow(/dependency-down cannot sit inside a multi-condition trigger/);
  });

  it("survives the single-leaf composite collapse the wizard submits", () => {
    const r = ruleInputSchema.parse({
      ...base,
      trigger: { type: "composite", kind: "asset", op: "and", children: [downTrigger({ missedPolls: 7, alertWhenDependencyDown: true })] },
    });
    expect(r.trigger.type).toBe("asset_state");
    expect((r.trigger as any).alertWhenDependencyDown).toBe(true);
  });

  it("the catalog names the key, so the wizard renders the control only against a server that has it", () => {
    const dd = buildSchemaCatalog().downDetection as Record<string, unknown>;
    expect(dd.dependencyDownKey).toBe("alertWhenDependencyDown");
    expect(String(dd.dependencyDownLabel)).toMatch(/dependency-down/);
    expect(String(dd.dependencyDownHelp)).toMatch(/upstream device/);
  });
});

describe("tuning the count is not an identity change", () => {
  it("triggerIdentityOf ignores alertWhenDependencyDown too", () => {
    const a = triggerIdentityOf(downTrigger({ missedPolls: 3 }) as any);
    const b = triggerIdentityOf(downTrigger({ missedPolls: 3, alertWhenDependencyDown: true }) as any);
    expect(a).toBe(b);
  });

  it("triggerIdentityOf ignores missedPolls", () => {
    // If this ever changes, updateRule will purge NotificationRuleState on
    // every count edit — clearing active alerts and re-arming every debounce
    // across the whole fleet, just because someone tuned 3 to 4.
    const a = triggerIdentityOf(downTrigger({ missedPolls: 3 }) as any);
    const b = triggerIdentityOf(downTrigger({ missedPolls: 10 }) as any);
    expect(a).toBe(b);
  });

  it("but changing the watched VALUE still is one", () => {
    expect(triggerIdentityOf(downTrigger() as any)).not.toBe(
      triggerIdentityOf({ type: "asset_state", field: "consecutiveFailures", operator: ">=", value: 3 } as any),
    );
  });
});
