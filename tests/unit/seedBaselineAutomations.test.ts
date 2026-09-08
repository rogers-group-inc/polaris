/**
 * tests/unit/seedBaselineAutomations.test.ts — the baseline-automation seed:
 * every seed body parses through the real ruleInputSchema, the V2 event set is
 * gated by its OWN run-once marker (so pre-V2 installs pick it up without
 * duplicating the original widget set), every event rule is storm-proofed
 * (timed reset + cooldown), and each actionPattern glob is pinned against the
 * verified logEvent action strings it must (and must not) match.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const settings = new Map<string, { key: string; value: unknown }>();
const createdRules: string[] = [];
const createdBodies: any[] = [];
const deletedRuleIds: string[] = [];
const loggedEvents: any[] = [];
/** Monitored fleet the V3 pass reads. Each test sets this before seeding. */
let fleetAssets: any[] = [];
/** The pre-cutover "Asset down" row V3 looks for, or null. */
let existingAssetDownRule: any = null;
/** Effective failureThreshold per assetType, as the settings tiers resolve it. */
let thresholdByType: Record<string, number> = {};
/** Rules already in the DB, as the V4 counterpart-reset pass sees them. */
let existingRules: any[] = [];
const ruleUpdates: { id: string; data: any }[] = [];

vi.mock("../../src/db.js", () => ({
  prisma: {
    setting: {
      findUnique: vi.fn(async ({ where }: any) => settings.get(where.key) ?? null),
      upsert: vi.fn(async ({ where, create }: any) => {
        settings.set(where.key, { key: where.key, value: create.value });
        return create;
      }),
    },
    asset: { findMany: vi.fn(async () => fleetAssets) },
    notificationRule: {
      findFirst: vi.fn(async () => existingAssetDownRule),
      // The V4 pass reads every rule and repoints the ones still on a timer.
      findMany: vi.fn(async () => existingRules),
      update: vi.fn(async ({ where, data }: any) => {
        ruleUpdates.push({ id: where.id, data });
        return { id: where.id, ...data };
      }),
    },
  },
}));

vi.mock("../../src/services/eventLogService.js", () => ({
  logEvent: vi.fn(async (e: any) => { loggedEvents.push(e); }),
}));

// The V3 pass reads each asset's EFFECTIVE threshold through the real resolver;
// stub it to the per-type fixture so these tests drive the mirroring logic
// rather than the settings hierarchy, which has its own suite.
vi.mock("../../src/services/monitoringService.js", () => ({
  resolveMonitorSettings: vi.fn(async (a: any) => ({
    failureThreshold: thresholdByType[a.assetType] ?? 3,
  })),
}));

vi.mock("../../src/services/downDetectionService.js", () => ({
  invalidateDownDetectionCache: vi.fn(),
}));

vi.mock("../../src/services/notificationRuleService.js", () => ({
  createRule: vi.fn(async (input: { name: string }) => {
    createdRules.push(input.name);
    createdBodies.push(input);
    return { id: `r-${createdRules.length}`, ...input };
  }),
  // V3 retires the old row through the SERVICE, not prisma.delete, so the
  // rule's active notifications get soft-cleared first.
  deleteRule: vi.fn(async (id: string) => { deletedRuleIds.push(id); }),
}));

// The module runs itself as a startup task at import time — neuter the
// instrumented wrapper so the import is inert and each test drives the seed.
vi.mock("../../src/jobs/_metrics.js", () => ({ runInstrumentedJob: vi.fn(async () => {}) }));

import {
  seedBaselineAutomations,
  BASELINE_RULES,
  EVENT_BASELINE_RULES,
  PLATFORM_LIFECYCLE_RULES,
} from "../../src/jobs/seedBaselineAutomations.js";
import { ruleInputSchema } from "../../src/services/notificationTypes.js";
import { globToRegExp } from "../../src/services/notificationEngine.js";

beforeEach(() => {
  settings.clear();
  createdRules.length = 0;
  createdBodies.length = 0;
  deletedRuleIds.length = 0;
  loggedEvents.length = 0;
  fleetAssets = [];
  existingAssetDownRule = null;
  thresholdByType = {};
  existingRules = [];
  ruleUpdates.length = 0;
});

describe("seed bodies", () => {
  it("every baseline rule (all sets) parses through the real ruleInputSchema", () => {
    for (const raw of [...BASELINE_RULES, ...EVENT_BASELINE_RULES, ...PLATFORM_LIFECYCLE_RULES]) {
      expect(() => ruleInputSchema.parse(raw), `rule "${(raw as { name?: string }).name}"`).not.toThrow();
    }
  });

  it("every event rule is storm-proofed: a real reset + cooldown + a message template", () => {
    for (const raw of [...EVENT_BASELINE_RULES, ...PLATFORM_LIFECYCLE_RULES]) {
      const rule = ruleInputSchema.parse(raw);
      expect(rule.trigger.type, rule.name).toBe("event");
      // Either a clock or — better, where Polaris writes a counterpart event —
      // the event that says the thing came back. Never "manual": an unattended
      // event alert that only a human can clear is how the Alerts tab silts up.
      expect(["timed", "event"], rule.name).toContain(rule.reset.mode);
      if (rule.reset.mode === "event") {
        expect(rule.reset.resetEvent?.actionPattern, rule.name).toBeTruthy();
      } else {
        expect(rule.reset.afterSec, rule.name).toBeGreaterThan(0);
      }
      expect(rule.cooldownSec ?? 0, rule.name).toBeGreaterThan(0);
      expect(rule.messageTemplate, rule.name).toBeTruthy();
      expect(rule.actions, rule.name).toEqual([]); // in-app only out of the box
      expect(rule.enabled, rule.name).toBe(true);
    }
  });
});

describe("marker gating (V2 reaches existing installs)", () => {
  it("fresh install: seeds every set and stamps every marker", async () => {
    const res = await seedBaselineAutomations();
    expect(res.skipped).toBe(false);
    // +1 for the V3 down-detection rule, which is computed rather than
    // listed in a static set.
    expect(res.created).toBe(
      BASELINE_RULES.length + EVENT_BASELINE_RULES.length + PLATFORM_LIFECYCLE_RULES.length + 1,
    );
    expect(settings.has("seedBaselineAutomationsSeededAt")).toBe(true);
    expect(settings.has("seedBaselineAutomationsV2SeededAt")).toBe(true);
    expect(settings.has("seedBaselineAutomationsV3SeededAt")).toBe(true);
    expect(settings.has("seedBaselineAutomationsV6PlatformLifecycleSeededAt")).toBe(true);
  });

  it("pre-V2 install (v1 marker stamped): seeds the later sets only", async () => {
    settings.set("seedBaselineAutomationsSeededAt", { key: "seedBaselineAutomationsSeededAt", value: {} });
    const res = await seedBaselineAutomations();
    expect(res.skipped).toBe(false);
    expect(res.created).toBe(EVENT_BASELINE_RULES.length + PLATFORM_LIFECYCLE_RULES.length + 1);
    expect(createdRules).toEqual([
      ...EVENT_BASELINE_RULES.map((r) => (r as { name: string }).name),
      "Asset down", // the V3 down-detection rule
      ...PLATFORM_LIFECYCLE_RULES.map((r) => (r as { name: string }).name),
    ]);
  });

  // The whole point of a separate V6 marker: an install that stamped V2 long
  // before this rule existed must still receive it. An entry appended to
  // EVENT_BASELINE_RULES would reach brand-new installs only.
  it("install seeded before V6: still receives the platform lifecycle rule", async () => {
    settings.set("seedBaselineAutomationsSeededAt", { key: "x", value: {} });
    settings.set("seedBaselineAutomationsV2SeededAt", { key: "y", value: {} });
    settings.set("seedBaselineAutomationsV3SeededAt", { key: "z", value: {} });
    settings.set("seedBaselineAutomationsV4ResetEventSeededAt", { key: "w", value: {} });
    settings.set("seedBaselineAutomationsV5LossCeilingSeededAt", { key: "v", value: {} });
    const res = await seedBaselineAutomations();
    expect(res.skipped).toBe(false);
    expect(res.created).toBe(PLATFORM_LIFECYCLE_RULES.length);
    expect(createdRules).toEqual(PLATFORM_LIFECYCLE_RULES.map((r) => (r as { name: string }).name));
  });

  it("fully seeded install: no-op", async () => {
    settings.set("seedBaselineAutomationsSeededAt", { key: "x", value: {} });
    settings.set("seedBaselineAutomationsV2SeededAt", { key: "y", value: {} });
    settings.set("seedBaselineAutomationsV3SeededAt", { key: "z", value: {} });
    settings.set("seedBaselineAutomationsV4ResetEventSeededAt", { key: "w", value: {} });
    settings.set("seedBaselineAutomationsV5LossCeilingSeededAt", { key: "v", value: {} });
    settings.set("seedBaselineAutomationsV6PlatformLifecycleSeededAt", { key: "u", value: {} });
    const res = await seedBaselineAutomations();
    expect(res).toEqual({ created: 0, skipped: true });
    expect(createdRules).toEqual([]);
  });
});

/**
 * V4 — the counterpart-Event repoint for installs that seeded their event rules
 * before an event automation could reset on anything but a clock.
 */
describe("V4 counterpart-event repoint", () => {
  const seededMarkers = (): void => {
    settings.set("seedBaselineAutomationsSeededAt", { key: "x", value: {} });
    settings.set("seedBaselineAutomationsV2SeededAt", { key: "y", value: {} });
    settings.set("seedBaselineAutomationsV3SeededAt", { key: "z", value: {} });
  };
  const t = new Date("2026-01-01T00:00:00Z");
  const untouched = (over: Record<string, unknown>): any => ({
    id: "r1", name: "Agent disconnected",
    trigger: { type: "event", actionPattern: "agent.disconnected" },
    reset: { mode: "timed", afterSec: 14400 }, clearBehavior: "timed",
    createdAt: t, updatedAt: t, ...over,
  });

  it("repoints an untouched timed rule onto its counterpart and mirrors the legacy column", async () => {
    seededMarkers();
    existingRules = [untouched({})];
    await seedBaselineAutomations();
    expect(ruleUpdates).toHaveLength(1);
    expect(ruleUpdates[0].data.reset).toEqual({ mode: "event", resetEvent: { actionPattern: "agent.connected", resourceType: null } });
    // "event" has no legacy spelling — legacyMirrorOfV2 calls it "auto".
    expect(ruleUpdates[0].data.clearBehavior).toBe("auto");
    expect(ruleUpdates[0].data.clearAfterSec).toBeNull();
    expect(loggedEvents.some((e) => e.action === "automation.seed.v4_reset_event")).toBe(true);
  });

  it("leaves an EDITED rule alone — its timer is the operator's decision", async () => {
    seededMarkers();
    existingRules = [untouched({ updatedAt: new Date("2026-03-01T00:00:00Z") })];
    await seedBaselineAutomations();
    expect(ruleUpdates).toEqual([]);
  });

  it("leaves a manual or already-event reset alone, and skips unknown patterns", async () => {
    seededMarkers();
    existingRules = [
      untouched({ id: "m", reset: { mode: "manual" }, clearBehavior: "manual" }),
      untouched({ id: "e", reset: { mode: "event", resetEvent: { actionPattern: "agent.connected" } }, clearBehavior: "auto" }),
      untouched({ id: "u", trigger: { type: "event", actionPattern: "some.custom.thing" } }),
      untouched({ id: "c", trigger: { type: "change", changeType: "firmware" } }),
    ];
    await seedBaselineAutomations();
    expect(ruleUpdates).toEqual([]);
  });

  it("is seed-once: a stamped marker skips the pass entirely", async () => {
    seededMarkers();
    settings.set("seedBaselineAutomationsV4ResetEventSeededAt", { key: "w", value: {} });
    existingRules = [untouched({})];
    await seedBaselineAutomations();
    expect(ruleUpdates).toEqual([]);
  });
});

describe("actionPattern globs vs the real logEvent action strings", () => {
  const patternOf = (name: string): string => {
    const rule = EVENT_BASELINE_RULES.find((r) => (r as { name: string }).name === name) as { trigger: { actionPattern: string } };
    expect(rule, name).toBeTruthy();
    return rule.trigger.actionPattern;
  };

  it("discovery aborted matches both abort flavors but not the skip breadcrumb or errors", () => {
    const re = globToRegExp(patternOf("Integration discovery aborted"));
    expect(re.test("integration.discover.aborted")).toBe(true);
    expect(re.test("integration.discover.auto_aborted")).toBe(true);
    expect(re.test("integration.discover.auto_abort_skipped")).toBe(false);
    expect(re.test("integration.discover.error")).toBe(false);
    expect(re.test("integration.discover.completed")).toBe(false);
  });

  it("quarantine failures match push + unpush failures but not success/partial/release", () => {
    const re = globToRegExp(patternOf("Quarantine push failed"));
    expect(re.test("asset.quarantine.failed")).toBe(true);
    expect(re.test("asset.quarantine.unpush.failed")).toBe(true);
    expect(re.test("asset.quarantine.succeeded")).toBe(false);
    expect(re.test("asset.quarantine.partial")).toBe(false);
    expect(re.test("asset.quarantine.released")).toBe(false);
    expect(re.test("asset.quarantine.drift_detected")).toBe(false);
  });

  it("reservation push failed is exact — retry/update/permanent flavors have their own handling", () => {
    const re = globToRegExp(patternOf("Reservation push failed"));
    expect(re.test("reservation.push.failed")).toBe(true);
    expect(re.test("reservation.push.update_failed")).toBe(false);
    expect(re.test("reservation.push.queued.failed_permanent")).toBe(false);
    expect(re.test("reservation.push.queued.retry_failed")).toBe(false);
  });

  it("exact-match patterns hit their verified writer action strings", () => {
    const exact: Record<string, string> = {
      "Integration discovery failed": "integration.discover.error",
      "Reservation push permanently failed": "reservation.push.queued.failed_permanent",
      "Agent disconnected": "agent.disconnected",
      "Agent upgrade failed": "agent.upgrade_failed",
      "Capacity severity escalated": "capacity.severity_changed",
      "IP conflict detected": "conflict.detected",
      "Asset auto-decommissioned": "asset.auto_decommissioned",
      "HA standby down": "asset.ha.standby_down",
      "Login lockout engaged": "auth.login.lockout",
    };
    for (const [name, action] of Object.entries(exact)) {
      expect(globToRegExp(patternOf(name)).test(action), `${name} vs ${action}`).toBe(true);
    }
    // lockout ≠ the per-attempt "locked" breadcrumb (which fires on every try
    // against a locked account and would be noisy).
    expect(globToRegExp(patternOf("Login lockout engaged")).test("auth.login.locked")).toBe(false);
  });

  it("capacity escalations alert; recoveries are filtered by detailsMatch", () => {
    const rule = EVENT_BASELINE_RULES.find((r) => (r as { name: string }).name === "Capacity severity escalated") as {
      trigger: { detailsMatch?: Record<string, unknown> };
    };
    expect(rule.trigger.detailsMatch).toEqual({ direction: "escalated" });
  });
});

describe("V3 down-detection seed", () => {
  const asset = (id: string, assetType: string, integrationId: string | null = null) =>
    ({ id, assetType, discoveredByIntegrationId: integrationId, discoveredByIntegration: { type: "fortimanager" } });

  /** Skip V1/V2 so each test sees only what V3 created. */
  function onlyV3() {
    settings.set("seedBaselineAutomationsSeededAt", { key: "a", value: {} });
    settings.set("seedBaselineAutomationsV2SeededAt", { key: "b", value: {} });
  }
  const downRules = () => createdBodies.filter((b) => b.trigger?.field === "monitorStatus");

  it("an install with no monitored assets still gets a working rule at the default", async () => {
    onlyV3();
    await seedBaselineAutomations();
    const rules = downRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: "Asset down" });
    expect(rules[0].trigger.missedPolls).toBe(3);
    expect(rules[0].scope).toEqual({ allAssets: true });
  });

  it("a uniformly-tuned fleet becomes ONE all-assets rule at that value", async () => {
    onlyV3();
    fleetAssets = [asset("a", "switch"), asset("b", "firewall"), asset("c", "server")];
    thresholdByType = { switch: 5, firewall: 5, server: 5 };
    await seedBaselineAutomations();
    const rules = downRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].trigger.missedPolls).toBe(5);
  });

  it("a class tuned away from the rest gets its OWN narrower rule", async () => {
    // This is the whole point of V3: without it, that class silently changes
    // its time-to-down on upgrade.
    onlyV3();
    fleetAssets = [
      asset("a", "server"), asset("b", "server"), asset("c", "server"),
      asset("d", "firewall"),
    ];
    thresholdByType = { server: 3, firewall: 2 };
    await seedBaselineAutomations();
    const rules = downRules();
    expect(rules).toHaveLength(2);
    const all = rules.find((r) => r.scope.allAssets);
    const fw  = rules.find((r) => !r.scope.allAssets);
    expect(all.trigger.missedPolls).toBe(3);           // the dominant value
    expect(fw.scope.assetTypes).toEqual(["firewall"]); // rank 1, so it wins for firewalls
    expect(fw.trigger.missedPolls).toBe(2);
  });

  it("takes the MORE SENSITIVE value when one class disagrees across integrations, and says so", async () => {
    // scopeRank does not rank integrationIds, so this genuinely cannot be
    // expressed as two rules — the seed must not pretend otherwise.
    onlyV3();
    // Three servers make 3 the unambiguous dominant value, so the switch class
    // is the one that gets its own rule and the assertion below is unambiguous.
    fleetAssets = [
      asset("a", "switch", "int-1"), asset("b", "switch", "int-2"),
      asset("c", "server"), asset("d", "server"), asset("e", "server"),
    ];
    let call = 0;
    thresholdByType = { server: 3 };
    const mod = await import("../../src/services/monitoringService.js");
    (mod.resolveMonitorSettings as any).mockImplementation(async (a: any) => {
      if (a.assetType !== "switch") return { failureThreshold: 3 };
      call += 1;
      return { failureThreshold: call === 1 ? 10 : 2 };
    });
    await seedBaselineAutomations();
    const sw = downRules().find((r) => !r.scope.allAssets);
    expect(sw.trigger.missedPolls).toBe(2);
    const conflictEvent = loggedEvents.find((e) => e.action === "automation.seed.threshold_conflict");
    expect(conflictEvent).toBeTruthy();
    expect(conflictEvent.level).toBe("warning");
    expect(conflictEvent.details.chosen).toBe(2);
    (mod.resolveMonitorSettings as any).mockImplementation(async (a: any) => ({
      failureThreshold: thresholdByType[a.assetType] ?? 3,
    }));
  });

  it("retires a PRISTINE Asset down row through deleteRule, after creating the replacement", async () => {
    onlyV3();
    const t = new Date("2026-01-01T00:00:00Z");
    existingAssetDownRule = { id: "old-1", createdAt: t, updatedAt: t };
    await seedBaselineAutomations();
    expect(deletedRuleIds).toEqual(["old-1"]);
    // Create-then-retire: the replacement must exist before the old row goes,
    // or the fleet is momentarily left with no down detection at all.
    expect(createdRules).toContain("Asset down");
  });

  it("KEEPS an operator-edited Asset down row and tells them the count is now theirs", async () => {
    onlyV3();
    existingAssetDownRule = {
      id: "old-2",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-02-01T00:00:00Z"), // any save bumps this
    };
    await seedBaselineAutomations();
    expect(deletedRuleIds).toEqual([]);
    const kept = loggedEvents.find((e) => e.action === "automation.seed.v3_retained");
    expect(kept).toBeTruthy();
    expect(kept.level).toBe("warning");
    expect(kept.message).toMatch(/default of 3/);
  });

  it("does NOT retire the old row when the replacement failed to save", async () => {
    onlyV3();
    const t = new Date("2026-01-01T00:00:00Z");
    existingAssetDownRule = { id: "old-3", createdAt: t, updatedAt: t };
    const svc = await import("../../src/services/notificationRuleService.js");
    (svc.createRule as any).mockImplementationOnce(async () => { throw new Error("db down"); });
    await seedBaselineAutomations();
    // Retiring here would leave the fleet with no down detection at all.
    expect(deletedRuleIds).toEqual([]);
  });

  it("every generated body passes the real ruleInputSchema", async () => {
    onlyV3();
    fleetAssets = [asset("a", "switch"), asset("b", "server"), asset("c", "server")];
    thresholdByType = { switch: 7, server: 3 };
    await seedBaselineAutomations();
    for (const body of downRules()) {
      expect(() => ruleInputSchema.parse(body), body.name).not.toThrow();
    }
  });
});

/**
 * V5 — the saturation ceiling for installs whose packet-loss rule predates it.
 *
 * This one repairs a regression THIS change introduced: removing the loss
 * anchor (business rule 29) means a device back from a 55-minute outage really
 * does read ~92% for the rest of a 60-minute window. The baseline loss rule is
 * scoped to ALL ASSETS, so without a ceiling every outage on every device would
 * trail a second alert behind it as it ages out of the window.
 */
describe("V5 packet-loss saturation ceiling", () => {
  const seededMarkers = (): void => {
    settings.set("seedBaselineAutomationsSeededAt", { key: "x", value: {} });
    settings.set("seedBaselineAutomationsV2SeededAt", { key: "y", value: {} });
    settings.set("seedBaselineAutomationsV3SeededAt", { key: "z", value: {} });
    settings.set("seedBaselineAutomationsV4ResetEventSeededAt", { key: "w", value: {} });
  };
  const t = new Date("2026-01-01T00:00:00Z");
  const lossRule = (over: Record<string, unknown> = {}): any => ({
    id: "L1", name: "High packet loss",
    trigger: { type: "asset_metric", metric: "probeLossPct", windowSec: 900, operator: ">", threshold: 10 },
    reset: { mode: "auto" }, clearBehavior: "auto",
    createdAt: t, updatedAt: t, ...over,
  });

  it("gives an untouched loss rule the ceiling, preserving the rest of the trigger", async () => {
    seededMarkers();
    existingRules = [lossRule()];
    await seedBaselineAutomations();
    expect(ruleUpdates).toHaveLength(1);
    expect(ruleUpdates[0].data.trigger).toEqual({
      type: "asset_metric", metric: "probeLossPct", windowSec: 900,
      operator: ">", threshold: 10, ignoreAtOrAbove: 90,
    });
    expect(loggedEvents.some((e) => e.action === "automation.seed.v5_loss_ceiling")).toBe(true);
  });

  it("leaves an EDITED rule alone but NAMES it in a warning", async () => {
    // Silently narrowing a rule someone tuned is worse than leaving it noisy —
    // but they have to be told it will now alert after outages.
    seededMarkers();
    existingRules = [lossRule({ updatedAt: new Date("2026-03-01T00:00:00Z") })];
    await seedBaselineAutomations();
    expect(ruleUpdates).toEqual([]);
    const ev = loggedEvents.find((e) => e.action === "automation.seed.v5_loss_ceiling");
    expect(ev?.level).toBe("warning");
    expect(ev?.message).toContain("High packet loss");
  });

  it("leaves a rule that already states a ceiling alone", async () => {
    // The operator has already answered this question — including with 100.
    seededMarkers();
    existingRules = [
      lossRule({ id: "a", trigger: { type: "asset_metric", metric: "probeLossPct", threshold: 10, ignoreAtOrAbove: 100 } }),
      lossRule({ id: "b", trigger: { type: "asset_metric", metric: "probeLossPct", threshold: 10, ignoreAtOrAbove: 50 } }),
    ];
    await seedBaselineAutomations();
    expect(ruleUpdates).toEqual([]);
  });

  it("touches no other metric", async () => {
    seededMarkers();
    existingRules = [
      lossRule({ id: "cpu", trigger: { type: "asset_metric", metric: "cpuPct", threshold: 90 } }),
      lossRule({ id: "st", trigger: { type: "asset_state", field: "monitorStatus", value: "down" } }),
      lossRule({ id: "ev", trigger: { type: "event", actionPattern: "x.y" } }),
    ];
    await seedBaselineAutomations();
    expect(ruleUpdates).toEqual([]);
  });

  it("is seed-once: a stamped marker skips the pass entirely", async () => {
    seededMarkers();
    settings.set("seedBaselineAutomationsV5LossCeilingSeededAt", { key: "v", value: {} });
    existingRules = [lossRule()];
    await seedBaselineAutomations();
    expect(ruleUpdates).toEqual([]);
  });

  it("logs nothing when there is no loss rule to consider", async () => {
    seededMarkers();
    existingRules = [];
    await seedBaselineAutomations();
    expect(loggedEvents.some((e) => e.action === "automation.seed.v5_loss_ceiling")).toBe(false);
  });
});
