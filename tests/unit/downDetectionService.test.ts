/**
 * tests/unit/downDetectionService.test.ts — CQ-T010: the parts of
 * downDetectionService the narrower suites leave open.
 *
 * downDetectionResolver.test.ts pins `pickDownWinner`'s ladder and
 * downDetectionCache.test.ts the hot-path / TTL contract. This file pins the
 * rest of business rule 36 as the service implements it:
 *
 *   - how a stored rule row is DIGESTED (missedPolls default, severity
 *     normalization, the reset → recovery hold, the device filter),
 *   - what one index build queries, decorates and reports (metrics, the
 *     conflict warn and its cap),
 *   - the `monitor.down_detection_absent` / `_restored` audit Events, which
 *     must fire on the TRANSITION and never on every rebuild,
 *   - the degraded paths (crash mat kept across invalidate, EMPTY snapshot),
 *   - `recoveryPollsFor`'s count-first / floor / cap arithmetic, and
 *   - `previewDownDetectionRemoval`, the blind-fleet guard behind the
 *     delete-confirm dialog.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  decorate: vi.fn(async (_rows: unknown[], _trees: unknown[]) => undefined),
  recordBuild: vi.fn(),
  setAssets: vi.fn(),
  unavailable: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/utils/logger.js", () => {
  const logger: any = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
  logger.child = () => logger;
  return { logger };
});
vi.mock("../../src/services/scopeRelationIndex.js", async (orig) => ({
  ...(await orig<object>()),
  decorateRelationLeafHits: h.decorate,
}));
vi.mock("../../src/metrics.js", async (orig) => ({
  ...(await orig<object>()),
  recordDownDetectionBuild: h.recordBuild,
  setDownDetectionAssets: h.setAssets,
  recordDownDetectionUnavailable: h.unavailable,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { logger } from "../../src/utils/logger.js";
import { relationLeafKey, type ScopeConditionRule } from "../../src/services/notificationTypes.js";
import {
  resolveDownDetection,
  resolveDownThreshold,
  recoveryPollsFor,
  describeDownDetectionFor,
  previewDownDetectionRemoval,
  invalidateDownDetectionCache,
  resetDownDetectionStateForTests,
  DEFAULT_MISSED_POLLS,
  DOWN_DETECTION_TTL_MS,
  type DownDetectionVerdict,
} from "../../src/services/downDetectionService.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const T0 = new Date("2026-01-01T00:00:00Z");
const T1 = new Date("2026-02-01T00:00:00Z");

interface RuleRow {
  id: string;
  name: string;
  createdAt: Date;
  trigger: unknown;
  scope: unknown;
  reset?: unknown;
  severity?: unknown;
}

const downTrigger = (missedPolls?: unknown, extra: Record<string, unknown> = {}) => ({
  type: "asset_state", field: "monitorStatus", operator: "==", value: "down",
  forDurationSec: 0,
  ...(missedPolls !== undefined ? { missedPolls } : {}),
  ...extra,
});

function rule(id: string, over: Partial<RuleRow> = {}): RuleRow {
  return {
    id,
    name: `rule ${id}`,
    createdAt: T0,
    trigger: downTrigger(3),
    scope: { allAssets: true },
    reset: null,
    severity: "critical",
    ...over,
  };
}

function asset(id: string, over: Record<string, unknown> = {}) {
  return {
    id, hostname: `host-${id}`, assetType: "switch", tags: [] as string[], discoveredByIntegrationId: null,
    manufacturer: null, model: null, os: null, ipAddress: null, macAddress: null, status: "active",
    ...over,
  };
}

let ruleRows: RuleRow[] = [];
let assetRows: ReturnType<typeof asset>[] = [];

const ruleFind = () => stubbed(prisma.notificationRule.findMany);
const assetFind = () => stubbed(prisma.asset.findMany);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  resetDownDetectionStateForTests();
  ruleRows = [];
  assetRows = [];
  ruleFind().mockImplementation(async () => ruleRows);
  // Fresh row objects per query, like a real client: decoration stamps
  // `relationLeafHits` onto the rows it is handed, and a shared object would
  // leak one build's stamps into the next query's result.
  assetFind().mockImplementation(async () => assetRows.map((a) => ({ ...a })));
  h.decorate.mockReset();
  h.decorate.mockImplementation(async () => undefined);
  h.recordBuild.mockReset();
  h.setAssets.mockReset();
  h.unavailable.mockReset();
  vi.mocked(logger.warn).mockClear();
});

/** One rule, one asset, resolve the asset. */
async function verdictFor(r: RuleRow, a = asset("a1")): Promise<DownDetectionVerdict | null> {
  ruleRows = [r];
  assetRows = [a];
  return resolveDownDetection(a.id);
}

// ─── Rule digestion ─────────────────────────────────────────────────────────

describe("rule digestion — the missed-poll count", () => {
  it("uses the automation's own missedPolls", async () => {
    expect((await verdictFor(rule("r", { trigger: downTrigger(7) })))?.threshold).toBe(7);
  });

  it("a rule with no count governs at DEFAULT_MISSED_POLLS (the pre-cutover number)", async () => {
    expect(DEFAULT_MISSED_POLLS).toBe(3);
    expect((await verdictFor(rule("r", { trigger: downTrigger() })))?.threshold).toBe(DEFAULT_MISSED_POLLS);
  });

  it.each([0, -2])("a non-positive count (%s) falls back to the default rather than meaning 'immediately'", async (n) => {
    expect((await verdictFor(rule("r", { trigger: downTrigger(n) })))?.threshold).toBe(DEFAULT_MISSED_POLLS);
  });

  it("a non-numeric count falls back to the default", async () => {
    expect((await verdictFor(rule("r", { trigger: downTrigger("5") })))?.threshold).toBe(DEFAULT_MISSED_POLLS);
  });
});

describe("rule digestion — which rules define down", () => {
  it("a monitorStatus == down trigger matches the value case-insensitively", async () => {
    const t = { ...downTrigger(4), value: "DOWN" };
    expect((await verdictFor(rule("r", { trigger: t })))?.threshold).toBe(4);
  });

  it("an automation on any other trigger never defines down — the asset is passive", async () => {
    const cpu = { type: "metric", metric: "cpuPct", operator: ">", value: 90 };
    expect(await verdictFor(rule("r", { trigger: cpu }))).toBeNull();
  });

  it("monitorStatus != down is not a down definition", async () => {
    expect(await verdictFor(rule("r", { trigger: { ...downTrigger(2), operator: "!=" } }))).toBeNull();
  });

  it("monitorStatus == warning is not a down definition", async () => {
    expect(await verdictFor(rule("r", { trigger: { ...downTrigger(2), value: "warning" } }))).toBeNull();
  });

  it("a row with no trigger at all is skipped, not thrown on", async () => {
    expect(await verdictFor(rule("r", { trigger: null }))).toBeNull();
  });

  it("a null scope reads as an empty scope, which covers nothing (no fallback, no match)", async () => {
    expect(await verdictFor(rule("r", { scope: null }))).toBeNull();
  });

  it("the trigger's device filter bounds coverage", async () => {
    // A substring match, not a wildcard.
    const r = rule("r", { trigger: downTrigger(2, { dimensionFilter: { hostnamePattern: "core-" } }) });
    ruleRows = [r];
    assetRows = [asset("in", { hostname: "core-sw-1" }), asset("out", { hostname: "desk-1" })];
    expect(await resolveDownThreshold("in")).toBe(2);
    expect(await resolveDownThreshold("out")).toBeNull();
  });

  it("a filtered all-assets rule is not a fallback for an asset discovered since the build", async () => {
    ruleRows = [rule("r", { trigger: downTrigger(2, { dimensionFilter: { hostnamePattern: "core-" } }) })];
    assetRows = [];
    expect(await resolveDownThreshold("brand-new")).toBeNull();
  });

  it("an empty device filter constrains nothing — the rule is still the fallback", async () => {
    ruleRows = [rule("r", { trigger: downTrigger(2, { dimensionFilter: {} }) })];
    assetRows = [];
    expect(await resolveDownThreshold("brand-new")).toBe(2);
  });
});

describe("rule digestion — severity (the colour Down is drawn in)", () => {
  it.each(["notice", "informational", "warning", "serious", "critical"])("keeps a recognized severity: %s", async (sev) => {
    expect((await verdictFor(rule("r", { severity: sev })))?.severity).toBe(sev);
  });

  it("normalizes an unknown severity to critical", async () => {
    expect((await verdictFor(rule("r", { severity: "urgent" })))?.severity).toBe("critical");
  });

  it("normalizes an absent or non-string severity to critical", async () => {
    expect((await verdictFor(rule("r", { severity: undefined })))?.severity).toBe("critical");
    resetDownDetectionStateForTests();
    expect((await verdictFor(rule("r", { severity: 3 })))?.severity).toBe("critical");
  });
});

describe("rule digestion — the reset owns the way back up", () => {
  it("an auto reset with a seconds hold carries the seconds and no count", async () => {
    const v = await verdictFor(rule("r", { reset: { mode: "auto", sustainSec: 300 } }));
    expect(v).toMatchObject({ recoverySustainSec: 300, recoverySustainPolls: null });
  });

  it("an auto reset stating a COUNT carries it, rounded", async () => {
    const v = await verdictFor(rule("r", { reset: { mode: "auto", sustainSec: 240, sustainPolls: 4.4 } }));
    expect(v).toMatchObject({ recoverySustainSec: 240, recoverySustainPolls: 4 });
  });

  it("only mode 'auto' counts — a manual or condition reset carries no hold", async () => {
    expect(await verdictFor(rule("r", { reset: { mode: "manual", sustainSec: 300, sustainPolls: 5 } })))
      .toMatchObject({ recoverySustainSec: null, recoverySustainPolls: null });
    resetDownDetectionStateForTests();
    expect(await verdictFor(rule("r", { reset: { mode: "condition", sustainSec: 300 } })))
      .toMatchObject({ recoverySustainSec: null, recoverySustainPolls: null });
  });

  it("no reset at all carries no hold", async () => {
    expect(await verdictFor(rule("r", { reset: null })))
      .toMatchObject({ threshold: 3, recoverySustainSec: null, recoverySustainPolls: null });
  });

  it("a zero hold is no hold", async () => {
    expect(await verdictFor(rule("r", { reset: { mode: "auto", sustainSec: 0, sustainPolls: 0 } })))
      .toMatchObject({ recoverySustainSec: null, recoverySustainPolls: null });
  });
});

// ─── One index build ────────────────────────────────────────────────────────

describe("index build — queries, decoration, metrics", () => {
  it("reads ENABLED rules with reset + severity, and MONITORED assets without the interfaces relation", async () => {
    await verdictFor(rule("r"));
    const rArgs = ruleFind().mock.calls[0][0];
    expect(rArgs.where).toEqual({ enabled: true });
    expect(rArgs.select).toMatchObject({ trigger: true, scope: true, reset: true, severity: true });
    const aArgs = assetFind().mock.calls[0][0];
    expect(aArgs.where).toEqual({ monitored: true });
    expect(aArgs.select.interfaces).toBeUndefined();
    expect(aArgs.select).toMatchObject({ id: true, hostname: true, assetType: true, tags: true });
  });

  it("hands every down rule's condition tree to decorateRelationLeafHits with the asset rows", async () => {
    const cond = { op: "and", children: [{ field: "interfaceName", operator: "equals", value: "port9" }] };
    ruleRows = [rule("a"), rule("b", { scope: { condition: cond } })];
    assetRows = [asset("x")];
    await resolveDownDetection("x");
    expect(h.decorate).toHaveBeenCalledTimes(1);
    const [rows, trees] = h.decorate.mock.calls[0];
    expect(rows).toEqual(assetRows);
    expect(trees).toEqual([undefined, cond]);
  });

  it("an interface-scoped rule covers exactly the assets the decoration says hold the port", async () => {
    const leaf: ScopeConditionRule = { field: "interfaceName", operator: "equals", value: "port9" } as ScopeConditionRule;
    ruleRows = [rule("iface", { scope: { condition: { op: "and", children: [leaf] } }, trigger: downTrigger(2) })];
    assetRows = [asset("has"), asset("hasnt")];
    h.decorate.mockImplementation(async (rows: any[]) => {
      for (const r of rows) r.relationLeafHits = new Map([[relationLeafKey(leaf), r.id === "has"]]);
      return undefined;
    });
    expect(await resolveDownThreshold("has")).toBe(2);
    expect(await resolveDownThreshold("hasnt")).toBeNull();
  });

  it("records the build duration and the covered / passive split", async () => {
    ruleRows = [rule("sw", { scope: { assetTypes: ["switch"] } })];
    assetRows = [asset("s1"), asset("s2"), asset("w1", { assetType: "workstation" })];
    await resolveDownDetection("s1");
    expect(h.recordBuild).toHaveBeenCalledTimes(1);
    expect(h.recordBuild.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
    expect(h.setAssets).toHaveBeenCalledWith(2, 1);
  });

  it("with no down rules every monitored asset counts as passive", async () => {
    assetRows = [asset("a"), asset("b")];
    await resolveDownDetection("a");
    expect(h.setAssets).toHaveBeenCalledWith(0, 2);
  });

  it("keeps the TTL inside the documented 30s–120s band", () => {
    expect(DOWN_DETECTION_TTL_MS).toBeGreaterThanOrEqual(30_000);
    expect(DOWN_DETECTION_TTL_MS).toBeLessThanOrEqual(120_000);
  });
});

describe("index build — the fallback answers for a brand-new asset", () => {
  it("picks the smallest count among several all-assets rules", async () => {
    ruleRows = [rule("big", { trigger: downTrigger(10) }), rule("small", { trigger: downTrigger(2) })];
    assetRows = [];
    expect(await resolveDownThreshold("new")).toBe(2);
  });

  it("an equal-count tie resolves to the OLDER rule, so the diagnostic names a stable winner", async () => {
    ruleRows = [
      rule("newer", { createdAt: T1, severity: "warning" }),
      rule("older", { createdAt: T0, severity: "serious" }),
    ];
    assetRows = [];
    const d = await describeDownDetectionFor("new");
    expect(d?.winner?.ruleId).toBe("older");
    expect((await resolveDownDetection("new"))?.severity).toBe("serious");
  });

  it("a narrower rule does not act as the fallback", async () => {
    ruleRows = [rule("sw", { scope: { assetTypes: ["switch"] } })];
    assetRows = [];
    expect(await resolveDownThreshold("new")).toBeNull();
  });
});

// ─── Diagnostics + conflicts ────────────────────────────────────────────────

describe("describeDownDetectionFor", () => {
  it("names the governing rule for a covered asset — not via the fallback", async () => {
    ruleRows = [rule("base", { trigger: downTrigger(9) }), rule("sw", { scope: { assetTypes: ["switch"] }, trigger: downTrigger(2) })];
    assetRows = [asset("s1")];
    const d = await describeDownDetectionFor("s1");
    expect(d).toMatchObject({ passive: false, viaFallback: false, conflict: null });
    expect(d?.winner).toMatchObject({ ruleId: "sw", ruleName: "rule sw", threshold: 2 });
  });

  it("reports passive with no winner when nothing covers the asset", async () => {
    ruleRows = [rule("sw", { scope: { assetTypes: ["firewall"] } })];
    assetRows = [asset("s1")];
    expect(await describeDownDetectionFor("s1")).toEqual({ passive: true, winner: null, viaFallback: false, conflict: null });
  });

  it("surfaces an equally-specific disagreement on that asset, with the smaller count chosen", async () => {
    ruleRows = [
      rule("ten", { scope: { assetTypes: ["switch"] }, trigger: downTrigger(10) }),
      rule("two", { scope: { assetTypes: ["switch"] }, trigger: downTrigger(2) }),
    ];
    assetRows = [asset("s1")];
    const d = await describeDownDetectionFor("s1");
    expect(d?.conflict).toEqual({ assetId: "s1", hostname: "host-s1", ruleIds: ["two", "ten"], counts: [2, 10], chosen: 2 });
  });
});

describe("conflict reporting", () => {
  const tied = () => [
    rule("ten", { scope: { assetTypes: ["switch"] }, trigger: downTrigger(10) }),
    rule("two", { scope: { assetTypes: ["switch"] }, trigger: downTrigger(2) }),
  ];

  it("warns ONCE per rebuild, summarizing the distinct rule pair and how many assets it hit", async () => {
    ruleRows = tied();
    assetRows = [asset("s1"), asset("s2"), asset("s3")];
    await resolveDownDetection("s1");
    const conflictWarns = vi.mocked(logger.warn).mock.calls.filter((c) => String(c[1]).includes("disagree"));
    expect(conflictWarns).toHaveLength(1);
    const payload = conflictWarns[0][0] as { pairs: Array<{ assets: number; chosen: number }>; truncated: boolean };
    expect(payload.pairs).toHaveLength(1);
    expect(payload.pairs[0]).toMatchObject({ assets: 3, chosen: 2 });
    expect(payload.truncated).toBe(false);
  });

  it("caps the carried conflicts at 50 and flags the summary as truncated", async () => {
    ruleRows = tied();
    assetRows = Array.from({ length: 60 }, (_, i) => asset(`s${i}`));
    await resolveDownDetection("s0");
    const warn = vi.mocked(logger.warn).mock.calls.find((c) => String(c[1]).includes("disagree"));
    const payload = warn?.[0] as { pairs: Array<{ assets: number }>; truncated: boolean };
    expect(payload.truncated).toBe(true);
    expect(payload.pairs[0].assets).toBe(50);
    expect((await describeDownDetectionFor("s49"))?.conflict).not.toBeNull();
    expect((await describeDownDetectionFor("s55"))?.conflict).toBeNull();
    // The cap bounds the diagnostic only — the verdict is still resolved.
    expect(await resolveDownThreshold("s55")).toBe(2);
  });

  it("equal counts at the same rank are not a conflict", async () => {
    ruleRows = [
      rule("a", { scope: { assetTypes: ["switch"] }, trigger: downTrigger(4) }),
      rule("b", { scope: { assetTypes: ["switch"] }, trigger: downTrigger(4) }),
    ];
    assetRows = [asset("s1")];
    await resolveDownDetection("s1");
    expect(vi.mocked(logger.warn).mock.calls.some((c) => String(c[1]).includes("disagree"))).toBe(false);
    expect((await describeDownDetectionFor("s1"))?.conflict).toBeNull();
  });
});

// ─── Audit Events (rule 36: a zero-rule fleet stamps the event once) ────────

describe("audit — down detection absent / restored", () => {
  const actions = () => eventLog.logEvent.mock.calls.map((c) => c[0].action);

  it("stamps monitor.down_detection_absent when monitored assets exist and no rule defines down", async () => {
    assetRows = [asset("a"), asset("b")];
    await resolveDownDetection("a");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "monitor.down_detection_absent",
      level: "warning",
      resourceType: "monitor_settings",
      resourceName: "Down detection",
      actor: "system:down-detection",
      details: { monitoredAssets: 2 },
    });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("all 2 monitored device(s) are Passive");
  });

  it("does not stamp it again on later rebuilds while the fleet stays blind", async () => {
    assetRows = [asset("a")];
    await resolveDownDetection("a");
    invalidateDownDetectionCache();
    await resolveDownDetection("a");
    invalidateDownDetectionCache();
    await resolveDownDetection("a");
    expect(actions()).toEqual(["monitor.down_detection_absent"]);
  });

  it("stamps monitor.down_detection_restored when a rule appears after a blind spell", async () => {
    assetRows = [asset("a")];
    await resolveDownDetection("a");
    ruleRows = [rule("r1"), rule("r2", { trigger: downTrigger(5) })];
    invalidateDownDetectionCache();
    await resolveDownDetection("a");
    expect(actions()).toEqual(["monitor.down_detection_absent", "monitor.down_detection_restored"]);
    expect(eventLog.logEvent.mock.calls[1][0]).toMatchObject({
      level: "info", actor: "system:down-detection", details: { ruleCount: 2 },
    });
  });

  it("a first build that already has rules writes no Event at all", async () => {
    ruleRows = [rule("r")];
    assetRows = [asset("a")];
    await resolveDownDetection("a");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("each transition is stamped: blind → judged → blind gives absent, restored, absent", async () => {
    assetRows = [asset("a")];
    await resolveDownDetection("a");
    ruleRows = [rule("r")];
    invalidateDownDetectionCache();
    await resolveDownDetection("a");
    ruleRows = [];
    invalidateDownDetectionCache();
    await resolveDownDetection("a");
    expect(actions()).toEqual([
      "monitor.down_detection_absent",
      "monitor.down_detection_restored",
      "monitor.down_detection_absent",
    ]);
  });

  it("an empty fleet with no rules is not worth an Event", async () => {
    await resolveDownDetection("a");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  // BUG: reportBuild records `lastRuleCountWasZero = true` even when it skipped
  // the Event because the fleet was EMPTY (isZero && assetCount === 0). A fresh
  // install boots with no monitored assets and no down automation; discovery
  // then adds monitored devices, every one reads Passive, and the next rebuild
  // sees isZero === lastRuleCountWasZero, so monitor.down_detection_absent is
  // never written — rule 36 says a zero-rule fleet stamps it once.
  it.fails("stamps the absent Event once monitored assets ARRIVE in a fleet that has never had a down rule", async () => {
    assetRows = [];
    await resolveDownDetection("nothing-yet");
    assetRows = [asset("a"), asset("b")];
    invalidateDownDetectionCache();
    await resolveDownDetection("a");
    expect(actions()).toEqual(["monitor.down_detection_absent"]);
  });
});

// ─── Degraded paths ─────────────────────────────────────────────────────────

describe("degraded paths", () => {
  it("a failed rebuild serves the last good snapshot and warns, without counting an outage", async () => {
    ruleRows = [rule("r", { trigger: downTrigger(6) })];
    assetRows = [asset("a")];
    expect(await resolveDownThreshold("a")).toBe(6);
    invalidateDownDetectionCache();
    ruleFind().mockRejectedValueOnce(new Error("db down"));
    expect(await resolveDownThreshold("a")).toBe(6);
    expect(vi.mocked(logger.warn).mock.calls.some((c) => String(c[1]).includes("serving the last good snapshot"))).toBe(true);
    expect(h.unavailable).not.toHaveBeenCalled();
  });

  it("an asset query failure is degraded the same way as a rule query failure", async () => {
    ruleRows = [rule("r", { trigger: downTrigger(6) })];
    assetRows = [asset("a")];
    await resolveDownThreshold("a");
    invalidateDownDetectionCache();
    assetFind().mockRejectedValueOnce(new Error("timeout"));
    expect(await resolveDownThreshold("a")).toBe(6);
  });

  it("with no snapshot at all every asset is passive and the outage is counted", async () => {
    ruleRows = [rule("r")];
    ruleFind().mockRejectedValueOnce(new Error("db down"));
    expect(await resolveDownDetection("a")).toBeNull();
    expect(h.unavailable).toHaveBeenCalledTimes(1);
  });

  it("describeDownDetectionFor reads passive from the EMPTY snapshot too", async () => {
    ruleFind().mockRejectedValueOnce(new Error("db down"));
    expect(await describeDownDetectionFor("a")).toEqual({ passive: true, winner: null, viaFallback: false, conflict: null });
  });

  it("the test seam forgets the crash mat, so a failure after it is passive", async () => {
    ruleRows = [rule("r")];
    assetRows = [asset("a")];
    await resolveDownThreshold("a");
    resetDownDetectionStateForTests();
    ruleFind().mockRejectedValueOnce(new Error("db down"));
    expect(await resolveDownThreshold("a")).toBeNull();
  });

  it("a failed build writes no audit Event", async () => {
    assetRows = [asset("a")];
    ruleFind().mockRejectedValueOnce(new Error("db down"));
    await resolveDownDetection("a");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

// ─── recoveryPollsFor ───────────────────────────────────────────────────────

describe("recoveryPollsFor — count first, floor at the threshold, cap at 100", () => {
  const v = (threshold: number, sec: number | null, polls: number | null): DownDetectionVerdict =>
    ({ threshold, recoverySustainSec: sec, recoverySustainPolls: polls, severity: "critical" });

  it("a stated count wins over the seconds mirror, whatever the cadence", () => {
    expect(recoveryPollsFor(v(3, 300, 5), 60)).toBe(5);
    expect(recoveryPollsFor(v(3, 300, 5), 17)).toBe(5);
  });

  it("a stated count never drops below the missed-poll floor", () => {
    expect(recoveryPollsFor(v(6, null, 2), 60)).toBe(6);
  });

  it("a stated count is capped at 100", () => {
    expect(recoveryPollsFor(v(3, null, 250), 60)).toBe(100);
  });

  it("a fractional stated count is rounded", () => {
    expect(recoveryPollsFor(v(3, null, 4.6), 60)).toBe(5);
  });

  it("a zero stated count falls through to the seconds", () => {
    expect(recoveryPollsFor(v(3, 600, 0), 60)).toBe(10);
  });

  it.each([0, -30, Number.NaN, Number.POSITIVE_INFINITY])("an unusable cadence (%s) answers the threshold", (interval) => {
    expect(recoveryPollsFor(v(4, 600, null), interval)).toBe(4);
  });

  it("seconds convert at the asset's cadence and are capped at 100", () => {
    expect(recoveryPollsFor(v(3, 86_400, null), 30)).toBe(100);
  });

  it("no hold at all is the plain threshold", () => {
    expect(recoveryPollsFor(v(5, null, null), 60)).toBe(5);
  });
});

// ─── previewDownDetectionRemoval ───────────────────────────────────────────

describe("previewDownDetectionRemoval — the blind-fleet guard", () => {
  it("answers 'not a down automation' for an id that is not an enabled down rule, without loading the fleet", async () => {
    ruleRows = [rule("r")];
    const out = await previewDownDetectionRemoval("missing");
    expect(out).toEqual({ isDownDetection: false, governs: 0, wouldFallBackToAnother: 0, wouldBecomePassive: 0, sampleHostnames: [] });
    expect(assetFind()).not.toHaveBeenCalled();
  });

  it("answers 'not a down automation' for a CPU automation", async () => {
    ruleRows = [rule("cpu", { trigger: { type: "metric", metric: "cpuPct", operator: ">", value: 90 } })];
    expect((await previewDownDetectionRemoval("cpu")).isDownDetection).toBe(false);
  });

  it("counts only the assets the rule currently WINS, not every asset it covers", async () => {
    ruleRows = [rule("base"), rule("sw", { scope: { assetTypes: ["switch"] }, trigger: downTrigger(2) })];
    assetRows = [asset("s1"), asset("s2"), asset("w1", { assetType: "workstation" })];
    const out = await previewDownDetectionRemoval("base");
    expect(out).toMatchObject({ isDownDetection: true, governs: 1, wouldFallBackToAnother: 0, wouldBecomePassive: 1 });
    expect(out.sampleHostnames).toEqual(["host-w1"]);
  });

  it("a non-down rule covering everything is NOT a survivor that catches the devices", async () => {
    ruleRows = [rule("down"), rule("cpu", { trigger: { type: "metric", metric: "cpuPct", operator: ">", value: 90 } })];
    assetRows = [asset("a")];
    expect(await previewDownDetectionRemoval("down")).toMatchObject({ governs: 1, wouldBecomePassive: 1, wouldFallBackToAnother: 0 });
  });

  it("caps the sample at five hostnames and falls back to the id when a hostname is null", async () => {
    ruleRows = [rule("only")];
    assetRows = [asset("a0", { hostname: null }), ...Array.from({ length: 7 }, (_, i) => asset(`a${i + 1}`))];
    const out = await previewDownDetectionRemoval("only");
    expect(out.governs).toBe(8);
    expect(out.wouldBecomePassive).toBe(8);
    expect(out.sampleHostnames).toEqual(["a0", "host-a1", "host-a2", "host-a3", "host-a4"]);
  });

  it("queries enabled rules and monitored assets fresh — it does not read the cached snapshot", async () => {
    ruleRows = [rule("only")];
    assetRows = [asset("a")];
    await resolveDownDetection("a");
    ruleFind().mockClear();
    assetFind().mockClear();
    await previewDownDetectionRemoval("only");
    expect(ruleFind()).toHaveBeenCalledWith(expect.objectContaining({ where: { enabled: true } }));
    expect(assetFind()).toHaveBeenCalledWith(expect.objectContaining({ where: { monitored: true } }));
  });

  // BUG: previewDownDetectionRemoval never calls decorateRelationLeafHits, so a
  // down automation scoped by a relation-backed condition (interfaceName,
  // nativeVlan, ssid, agentInstalled, subnet-by-name) matches NO asset in the
  // preview — the undecorated row falls through to `asset.interfaces`, which
  // DOWN_SCOPE_SELECT does not select. The live index (which does decorate)
  // says the rule governs the device; the delete-confirm dialog says it governs
  // 0 and would leave 0 passive, so deleting it silently blinds those devices.
  // Fix: `await decorateRelationLeafHits(assets, rules.map((r) => r.scope?.condition))`
  // after the asset query, exactly as buildDownDetectionIndex does.
  it.fails("counts devices governed through an interface-scoped condition (relation leaves are decorated)", async () => {
    const leaf: ScopeConditionRule = { field: "interfaceName", operator: "equals", value: "port9" } as ScopeConditionRule;
    ruleRows = [rule("iface", { scope: { condition: { op: "and", children: [leaf] } } })];
    assetRows = [asset("has")];
    h.decorate.mockImplementation(async (rows: any[]) => {
      for (const r of rows) r.relationLeafHits = new Map([[relationLeafKey(leaf), true]]);
      return undefined;
    });
    // The live index agrees the rule governs the device...
    expect(await resolveDownThreshold("has")).toBe(3);
    // ...so the removal preview must count it.
    expect(await previewDownDetectionRemoval("iface")).toMatchObject({ governs: 1, wouldBecomePassive: 1 });
  });
});
