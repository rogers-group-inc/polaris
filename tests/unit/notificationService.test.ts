/**
 * tests/unit/notificationService.test.ts — notificationService's own suite
 * (CQ-T010).
 *
 * Complements, rather than repeats:
 *   - ackNotePolicy.test.ts            (ackNoteProblem, withAckPolicy per severity)
 *   - dependencyDownAckInherit.test.ts (rule 78a cascade, inheritableRootCauseId, inheritedAckData)
 *   - notificationClearReleasesState.test.ts (clear releases the rule-state row)
 *   - notificationSuppressionSweep.test.ts   (clearSuppressedAlerts, rules 16 / 16(a) / 78)
 *   - notificationTestAlertExpiry.test.ts    (clearExpiredTestAlerts)
 *   - assetAlertIndicator.test.ts            (activeAlertSummaryByAsset)
 *   - clearedSubjectParts.test.ts, tests/integration/resetMatchEscalation + allClearSubject
 *
 * What this adds: listNotifications' where/sort/paging construction and the
 * region scope (unscoped alerts stay visible); getNotificationForViewer
 * (region gate, owner naming, contributing automations, null on a miss);
 * acknowledgeNotifications' input refusal, the server-side note enforcement
 * (rule 25) and the audit provenance; rule 78b's sameAssetDownAckFor and the
 * never-throws contract of both fire-time lookups; the OPERATOR clear's reset
 * actions (owner resolution, held first sends skipped, the "cleared by"
 * recovery sentence, a failing action not stopping the batch) — previously
 * only reached by integration tests; and getAssetNotifications' rule-114(b)
 * summary branch plus the maintenance-hold pill.
 *
 * Nothing is sent: automationActionService.executeActions is a spy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const h = vi.hoisted(() => ({
  executeActions: vi.fn(),
  findRulesMatchingAsset: vi.fn(),
  resolveDependencyBlameMany: vi.fn(),
}));

vi.mock("../../src/services/automationActionService.js", () => ({ executeActions: h.executeActions }));
vi.mock("../../src/services/notificationRuleService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findRulesMatchingAsset: h.findRulesMatchingAsset,
}));
vi.mock("../../src/services/dependencyTreeService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveDependencyBlameMany: h.resolveDependencyBlameMany,
}));

import {
  listNotifications,
  getNotificationForViewer,
  acknowledgeNotifications,
  rootCauseAckFor,
  sameAssetDownAckFor,
  clearNotifications,
  getAssetNotifications,
  summarizeMatchingRule,
  maintenanceHoldsByAsset,
} from "../../src/services/notificationService.js";

const DOWN_TRIGGER = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down" };
const CPU_TRIGGER = { type: "threshold", metric: "cpu", operator: ">", value: 90 };

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.executeActions.mockReset();
  h.executeActions.mockResolvedValue(undefined);
  h.findRulesMatchingAsset.mockReset();
  h.findRulesMatchingAsset.mockResolvedValue([]);
  h.resolveDependencyBlameMany.mockReset();
  h.resolveDependencyBlameMany.mockResolvedValue(new Map());
  stubbed(prisma.notification.findMany).mockResolvedValue([]);
  stubbed(prisma.notification.count).mockResolvedValue(0);
  stubbed(prisma.notification.updateMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.notificationRuleState.updateMany).mockResolvedValue({ count: 0 });
  stubbed(prisma.asset.findMany).mockResolvedValue([]);
});

// ─── listNotifications ──────────────────────────────────────────────────────

describe("listNotifications", () => {
  it("hides cleared alerts by default, sorts newest first and pages 50", async () => {
    stubbed(prisma.notification.count).mockResolvedValue(7);
    const out = await listNotifications({ viewerRegionTags: [] });
    const args = stubbed(prisma.notification.findMany).mock.calls[0][0];
    expect(args.where).toEqual({ AND: [{ cleared: false }] });
    expect(args.orderBy).toEqual({ triggeredAt: "desc" });
    expect(args.take).toBe(50);
    expect(args.skip).toBe(0);
    expect(out).toMatchObject({ notifications: [], total: 7, limit: 50, offset: 0 });
    // The count reads the same filter as the page.
    expect(stubbed(prisma.notification.count).mock.calls[0][0]).toEqual({ where: args.where });
  });

  it("an unscoped viewer with includeCleared and no filters sends an empty where", async () => {
    await listNotifications({ viewerRegionTags: [], filters: { includeCleared: true } });
    expect(stubbed(prisma.notification.findMany).mock.calls[0][0].where).toEqual({});
  });

  it("clamps the page size to 1..500 and a negative offset to 0", async () => {
    await listNotifications({ viewerRegionTags: [], limit: 9999, offset: -5 });
    await listNotifications({ viewerRegionTags: [], limit: 0 });
    const [first, second] = stubbed(prisma.notification.findMany).mock.calls.map((c) => c[0]);
    expect(first.take).toBe(500);
    expect(first.skip).toBe(0);
    expect(second.take).toBe(1);
  });

  it("falls back to triggeredAt for a sort column outside the whitelist", async () => {
    await listNotifications({ viewerRegionTags: [], sortBy: "acknowledgeNote; DROP", sortDir: "asc" });
    await listNotifications({ viewerRegionTags: [], sortBy: "severity", sortDir: "asc" });
    const [bad, good] = stubbed(prisma.notification.findMany).mock.calls.map((c) => c[0]);
    expect(bad.orderBy).toEqual({ triggeredAt: "asc" });
    expect(good.orderBy).toEqual({ severity: "asc" });
  });

  it("builds every filter into the AND list", async () => {
    const from = new Date("2026-11-01T02:00:00Z");
    await listNotifications({
      viewerRegionTags: [],
      filters: { severity: ["critical"], acknowledged: false, assetId: "a1", region: ["region:east"], search: "fw", triggeredFrom: from },
    });
    const and = stubbed(prisma.notification.findMany).mock.calls[0][0].where.AND;
    expect(and).toEqual([
      { cleared: false },
      { severity: { in: ["critical"] } },
      { acknowledged: false },
      { assetId: "a1" },
      { regionTags: { hasSome: ["region:east"] } },
      // Only the bound that was given.
      { triggeredAt: { gte: from } },
      { OR: [
        { message: { contains: "fw", mode: "insensitive" } },
        { assetHostname: { contains: "fw", mode: "insensitive" } },
      ] },
    ]);
  });

  it("a region-scoped viewer still sees UNSCOPED (system) alerts", async () => {
    await listNotifications({ viewerRegionTags: ["region:east"] });
    const and = stubbed(prisma.notification.findMany).mock.calls[0][0].where.AND;
    expect(and).toContainEqual({ OR: [{ regionTags: { isEmpty: true } }, { regionTags: { hasSome: ["region:east"] } }] });
  });

  it("flattens each row's note policy and drops the joined owner", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValue([
      { id: "n1", severity: "critical", rule: { id: "r", name: "R", requireAckNote: true, severity: "critical", severityBands: null }, alertGroup: null },
      { id: "n2", severity: "warning", rule: null, alertGroup: null },
    ]);
    const out = await listNotifications({ viewerRegionTags: [] });
    expect(out.notifications).toEqual([
      { id: "n1", severity: "critical", requireAckNote: true },
      { id: "n2", severity: "warning", requireAckNote: false },
    ]);
  });
});

// ─── getNotificationForViewer ───────────────────────────────────────────────

describe("getNotificationForViewer", () => {
  it("returns null rather than throwing when the alert is not reachable", async () => {
    stubbed(prisma.notification.findFirst).mockResolvedValue(null);
    expect(await getNotificationForViewer("nope", [])).toBeNull();
  });

  it("puts the region predicate beside the id for a scoped viewer (no reaching an alert by its id)", async () => {
    stubbed(prisma.notification.findFirst).mockResolvedValue(null);
    await getNotificationForViewer("n1", ["region:west"]);
    await getNotificationForViewer("n1", []);
    const [scoped, open] = stubbed(prisma.notification.findFirst).mock.calls.map((c) => c[0].where);
    expect(scoped).toEqual({ AND: [{ id: "n1" }, { OR: [{ regionTags: { isEmpty: true } }, { regionTags: { hasSome: ["region:west"] } }] }] });
    expect(open).toEqual({ id: "n1" });
  });

  it("names a grouped alert by its group and lists each contributing automation once", async () => {
    stubbed(prisma.notification.findFirst).mockResolvedValue({
      id: "n1", severity: "critical", members: [{ ruleName: "Path A" }, { ruleName: "Path B" }, { ruleName: "Path A" }, { ruleName: "" }, {}],
      rule: { id: "r1", name: "Path A", requireAckNote: false, severity: "critical", severityBands: null },
      alertGroup: { id: "g1", name: "WAN health", enabled: true, requireAckNote: true },
    });
    const out = await getNotificationForViewer("n1", []);
    expect(out).toMatchObject({
      ruleName: "WAN health", ownerKind: "group", groupName: "WAN health",
      contributingRules: ["Path A", "Path B"],
      // Rule 75: the GROUP's note policy, not the automation's.
      requireAckNote: true,
    });
    expect(out).not.toHaveProperty("rule");
    expect(out).not.toHaveProperty("alertGroup");
  });

  it("a DISABLED group owns nothing — the automation names it and sets the policy", async () => {
    stubbed(prisma.notification.findFirst).mockResolvedValue({
      id: "n1", severity: "warning", members: null,
      rule: { id: "r1", name: "CPU high", requireAckNote: false, severity: "warning", severityBands: null },
      alertGroup: { id: "g1", name: "Old group", enabled: false, requireAckNote: true },
    });
    const out = await getNotificationForViewer("n1", []);
    expect(out).toMatchObject({ ruleName: "CPU high", ownerKind: "rule", groupName: "Old group", contributingRules: [], requireAckNote: false });
  });

  it("a rule-less alert (test fire / deleted automation) has no name and no policy", async () => {
    stubbed(prisma.notification.findFirst).mockResolvedValue({ id: "n1", severity: "info", rule: null, alertGroup: null, members: [] });
    expect(await getNotificationForViewer("n1", [])).toMatchObject({ ruleName: null, ownerKind: null, groupName: null, requireAckNote: false });
  });
});

// ─── acknowledgeNotifications ───────────────────────────────────────────────

describe("acknowledgeNotifications", () => {
  it("refuses an empty or non-array id list with a 400", async () => {
    await expect(acknowledgeNotifications([], "op")).rejects.toMatchObject({ httpStatus: 400 });
    await expect(acknowledgeNotifications(undefined as never, "op")).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("enforces the automation's note policy server-side when no note is given (rule 25)", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValueOnce([
      { severity: "critical", rule: { requireAckNote: true, severity: "critical", severityBands: null } },
    ]);
    await expect(acknowledgeNotifications(["n1"], "op", "   ")).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("does not ask the policy when a note was supplied, and stores it trimmed", async () => {
    stubbed(prisma.notification.updateMany).mockResolvedValue({ count: 1 });
    // The only findMany is the root-cause read (rule 78a); it finds nothing.
    const n = await acknowledgeNotifications(["n1"], "op", "  replaced PSU  ");
    expect(n).toBe(1);
    expect(stubbed(prisma.notification.findMany)).toHaveBeenCalledTimes(1);
    const upd = stubbed(prisma.notification.updateMany).mock.calls[0][0];
    expect(upd.where).toEqual({ id: { in: ["n1"] }, acknowledged: false });
    expect(upd.data).toMatchObject({ acknowledged: true, acknowledgedBy: "op", acknowledgeNote: "replaced PSU" });
    expect(upd.data.acknowledgedAt).toBeInstanceOf(Date);
  });

  it("stores a null note when none was given and nothing demanded one", async () => {
    stubbed(prisma.notification.updateMany).mockResolvedValue({ count: 2 });
    await acknowledgeNotifications(["n1", "n2"], "op");
    expect(stubbed(prisma.notification.updateMany).mock.calls[0][0].data.acknowledgeNote).toBeNull();
  });

  it("audits one Event carrying the provenance (ui by default, else the source given)", async () => {
    stubbed(prisma.notification.updateMany).mockResolvedValue({ count: 1 });
    await acknowledgeNotifications(["n1"], "op", "x");
    await acknowledgeNotifications(["n2", "n3"], "op", "x", { source: "ack_page" });
    const [one, two] = eventLog.logEvent.mock.calls.map((c) => c[0]);
    expect(one).toMatchObject({ action: "notification.acknowledged", message: "Acknowledged 1 notification", details: { ids: ["n1"], count: 1, hasNote: true, source: "ui" } });
    expect(two).toMatchObject({ details: { source: "ack_page" } });
  });
});

// ─── Fire-time inherited acknowledgements (rules 78a / 78b) ─────────────────

describe("rootCauseAckFor", () => {
  it("returns the newest acknowledged live down alert on the root cause", async () => {
    stubbed(prisma.notification.findFirst).mockResolvedValue({ id: "n9", assetId: "gw", assetHostname: "GW-1", acknowledgedBy: "op", acknowledgeNote: null });
    expect(await rootCauseAckFor("gw")).toEqual({ notificationId: "n9", assetId: "gw", hostname: "GW-1", acknowledgedBy: "op", acknowledgeNote: null });
    const q = stubbed(prisma.notification.findFirst).mock.calls[0][0];
    expect(q.where).toMatchObject({ assetId: "gw", acknowledged: true, cleared: false, dependencyDown: false, testRun: false, metric: "monitorStatus" });
    expect(q.orderBy).toEqual({ acknowledgedAt: "desc" });
  });

  it("is null on a failed read rather than throwing", async () => {
    stubbed(prisma.notification.findFirst).mockRejectedValue(new Error("db gone"));
    expect(await rootCauseAckFor("gw")).toBeNull();
  });
});

describe("sameAssetDownAckFor (rule 78b)", () => {
  it("inherits only from ANOTHER down-detection automation's acknowledged alert on the same asset", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValue([
      // Newest first: a monitorStatus == warning automation's alert is not the outage.
      { id: "w", assetId: "a1", assetHostname: "SW", acknowledgedBy: "x", acknowledgeNote: null, rule: { trigger: { ...DOWN_TRIGGER, value: "warning" } } },
      { id: "d", assetId: "a1", assetHostname: "SW", acknowledgedBy: "op", acknowledgeNote: "known", rule: { trigger: DOWN_TRIGGER } },
    ]);
    expect(await sameAssetDownAckFor("a1", "r-self")).toEqual({ notificationId: "d", assetId: "a1", hostname: "SW", acknowledgedBy: "op", acknowledgeNote: "known" });
    const where = stubbed(prisma.notification.findMany).mock.calls[0][0].where;
    expect(where).toMatchObject({ assetId: "a1", acknowledged: true, ruleId: { not: "r-self" } });
  });

  it("skips a rule-less row and answers null when no down automation qualifies", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValue([
      { id: "t", assetId: "a1", assetHostname: null, acknowledgedBy: "op", acknowledgeNote: null, rule: null },
      { id: "c", assetId: "a1", assetHostname: null, acknowledgedBy: "op", acknowledgeNote: null, rule: { trigger: CPU_TRIGGER } },
    ]);
    expect(await sameAssetDownAckFor("a1", "r")).toBeNull();
  });

  it("never throws", async () => {
    stubbed(prisma.notification.findMany).mockRejectedValue(new Error("boom"));
    expect(await sameAssetDownAckFor("a1", "r")).toBeNull();
  });
});

// ─── clearNotifications — the operator clear runs reset actions ────────────

const resetRow = (over: Record<string, unknown> = {}) => ({
  id: "n1", message: "CPU high", severity: "critical", assetId: "a1", assetHostname: "SRV-1", dimension: null,
  templateCtx: null, escalationFired: null,
  rule: {
    id: "r1", name: "CPU high", scope: { tags: [] }, emailComposition: null, severity: "critical", actions: [], severityBands: null, escalation: null,
    resetActions: [{ type: "notify", channelIds: ["c1"] }],
  },
  alertGroup: null,
  ...over,
});

describe("clearNotifications", () => {
  it("refuses an empty id list with a 400 and runs nothing", async () => {
    await expect(clearNotifications([], "op")).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it("reads only open, owned alerts whose first send is not still held (rule 75)", async () => {
    await clearNotifications(["n1"], "op");
    const where = stubbed(prisma.notification.findMany).mock.calls[0][0].where;
    expect(where).toEqual({
      id: { in: ["n1"] }, cleared: false,
      OR: [{ ruleId: { not: null } }, { alertGroupId: { not: null } }],
      NOT: { firstSendDueAt: { not: null }, firstSentAt: null },
    });
  });

  it("runs the automation's reset actions BEFORE the clear, naming who ended it", async () => {
    const order: string[] = [];
    stubbed(prisma.notification.findMany).mockResolvedValue([resetRow()]);
    h.executeActions.mockImplementation(async () => { order.push("actions"); });
    stubbed(prisma.notification.updateMany).mockImplementation(async () => { order.push("clear"); return { count: 1 }; });
    await clearNotifications(["n1"], "dmoore");

    expect(order).toEqual(["actions", "clear"]);
    const [id, actions, ctx, opts] = h.executeActions.mock.calls[0];
    expect(id).toBe("n1");
    expect(actions).toEqual([{ type: "notify", channelIds: ["c1"] }]);
    expect(ctx.severity).toBe("resolved");
    expect(ctx.message).toBe("Resolved: CPU high — SRV-1 cleared by dmoore");
    expect(ctx["trigger.summary"]).toBe(ctx.message);
    expect(opts).toMatchObject({ assetId: "a1", ruleId: "r1", ruleName: "CPU high", actor: "dmoore" });
  });

  it("names the alert the way its fire did, from the templateCtx snapshot", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValue([
      resetRow({ templateCtx: { asset: "RGILink Auth · 3 devices", rule: "Path Monitor", "condition.suffix": " is down" } }),
    ]);
    await clearNotifications(["n1"], "op");
    const ctx = h.executeActions.mock.calls[0][2];
    expect(ctx.asset).toBe("RGILink Auth · 3 devices");
    expect(ctx.message).toBe("Resolved: Path Monitor — RGILink Auth · 3 devices cleared by op");
  });

  it("takes reset actions from an enabled GROUP while provenance stays the automation's", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValue([
      resetRow({
        rule: { ...resetRow().rule, resetActions: [] },
        alertGroup: { id: "g1", name: "WAN health", enabled: true, emailComposition: null, actions: [], escalation: null, resetActions: [{ type: "notify", channelIds: ["grp"] }] },
      }),
    ]);
    await clearNotifications(["n1"], "op");
    const [, actions, , opts] = h.executeActions.mock.calls[0];
    expect(actions).toEqual([{ type: "notify", channelIds: ["grp"] }]);
    expect(opts).toMatchObject({ ruleId: "r1", ruleName: "WAN health" });
  });

  it("skips owners with no reset actions, and one failing alert does not stop the rest or the clear", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValue([
      resetRow({ id: "bad" }),
      resetRow({ id: "none", rule: { ...resetRow().rule, resetActions: [] } }),
      resetRow({ id: "ok" }),
    ]);
    h.executeActions.mockImplementation(async (id: string) => { if (id === "bad") throw new Error("smtp down"); });
    stubbed(prisma.notification.updateMany).mockResolvedValue({ count: 3 });
    const n = await clearNotifications(["bad", "none", "ok"], "op");
    expect(h.executeActions.mock.calls.map((c) => c[0])).toEqual(["bad", "ok"]);
    expect(n).toBe(3);
  });

  it("still clears when the reset read itself fails", async () => {
    stubbed(prisma.notification.findMany).mockRejectedValue(new Error("db"));
    stubbed(prisma.notification.updateMany).mockResolvedValue({ count: 1 });
    expect(await clearNotifications(["n1"], "op")).toBe(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "notification.cleared", message: "Cleared 1 notification" });
  });
});

// ─── maintenanceHoldsByAsset / getAssetNotifications ────────────────────────

describe("maintenanceHoldsByAsset", () => {
  it("de-duplicates and drops empty ids, and asks nothing for none", async () => {
    expect((await maintenanceHoldsByAsset(["", ""])).size).toBe(0);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    await maintenanceHoldsByAsset(["a", "a", "b"]);
    expect(stubbed(prisma.asset.findMany).mock.calls[0][0].where.id).toEqual({ in: ["a", "b"] });
  });
});

describe("getAssetNotifications", () => {
  const rule = {
    id: "r1", name: "CPU", description: undefined, enabled: true, severity: "warning", trigger: CPU_TRIGGER, scope: { tags: [] },
    actions: [{ type: "api_call", url: "https://hook.example/secret", headers: { Authorization: "x" } }],
    escalation: { tiers: [] }, emailComposition: {},
    severityBands: [{ threshold: 95, severity: "critical", operator: ">", notify: { channelIds: ["c"] } }],
  };

  it("asks the carve-out-aware matcher and returns full rules by default", async () => {
    h.findRulesMatchingAsset.mockResolvedValue([rule]);
    const out = await getAssetNotifications("a1");
    expect(h.findRulesMatchingAsset).toHaveBeenCalledWith("a1", { carveOut: true });
    expect(out.matchingRules).toEqual([rule]);
  });

  it("summarizes the rules for a caller without Automations read (rule 114(b))", async () => {
    h.findRulesMatchingAsset.mockResolvedValue([rule]);
    const out = await getAssetNotifications("a1", { fullRules: false });
    expect(out.matchingRules).toEqual([{
      id: "r1", name: "CPU", description: null, enabled: true, severity: "warning", trigger: CPU_TRIGGER, scope: { tags: [] },
      severityBands: [{ threshold: 95, severity: "critical", operator: ">" }],
    }]);
  });

  it("stamps every live alert with the asset's maintenance hold and its owner names", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValue([
      { id: "n1", severity: "warning", rule: { id: "r1", name: "CPU", requireAckNote: false, severity: "warning", severityBands: null }, alertGroup: { id: "g", name: "Servers", enabled: true, requireAckNote: false } },
    ]);
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a1", status: "maintenance" }]);
    const out = await getAssetNotifications("a1");
    expect(out.active).toEqual([{ id: "n1", severity: "warning", requireAckNote: false, ruleName: "CPU", groupName: "Servers", maintenanceHold: "self" }]);
  });
});

describe("summarizeMatchingRule", () => {
  it("drops every delivery field and keeps bands as comparison fields only", () => {
    const s = summarizeMatchingRule({ id: "r", name: "n", enabled: false, severity: "info", trigger: {}, scope: {}, severityBands: "garbage", actions: [1] });
    expect(s).toEqual({ id: "r", name: "n", description: null, enabled: false, severity: "info", trigger: {}, scope: {}, severityBands: null });
    expect(summarizeMatchingRule({ severityBands: [{ threshold: 1, severity: "x", forDurationSec: 30, recipients: ["a"] }] }).severityBands)
      .toEqual([{ threshold: 1, severity: "x", forDurationSec: 30 }]);
  });
});
