/**
 * tests/unit/alertActions.test.ts — running an alert's actions and deciding
 * whose actions they are (CQ-T010; notifications/alertActions.ts).
 *
 * executeActions (automationActionService) is the boundary and is mocked; the
 * region helpers (scopeRegionTagsOf, regionSnapshot) and alertOwnerOf run for
 * real, so the exec context and the group-ownership answer (business rule 75:
 * a group owns delivery, a disabled group owns nothing) are checked end to end.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { executeActions } = vi.hoisted(() => ({ executeActions: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/automationActionService.js", () => ({ executeActions }));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  executeActionsSafe,
  enqueueAlertActions,
  groupOwnersOf,
  groupOwnerOf,
  ownerActions,
} from "../../src/services/notifications/alertActions.js";
import type { DbRule, Reading } from "../../src/services/notifications/ruleModel.js";
import type { AutomationAction, DeliveryOwner } from "../../src/services/notificationTypes.js";

const actions = [{ type: "notify", channelId: "c1" }] as unknown as AutomationAction[];

const rule = (over: Partial<DbRule> = {}): DbRule =>
  ({
    id: "r1",
    name: "Switch down",
    scope: { tags: ["region:East", "site:a"] },
    emailComposition: { mode: "rule" },
    alertGroupId: null,
    ...over,
  }) as unknown as DbRule;

const reading = (over: Partial<Reading> = {}): Reading =>
  ({ assetId: "a1", hostname: "sw-01", tags: ["Region:West", "role:core", "region:"], dimKey: "", dimLabel: "", value: 0, ...over }) as Reading;

const owner = (over: Partial<DeliveryOwner> = {}): DeliveryOwner => ({
  kind: "group",
  id: "g1",
  name: "Core switches",
  severity: "critical",
  severityBands: null,
  requireAckNote: false,
  actions: null,
  escalation: null,
  repeat: null,
  emailComposition: { mode: "group" } as never,
  resetActions: null,
  messageTemplate: null,
  ...over,
});

const groupRow = (over: Record<string, unknown> = {}) => ({
  id: "g1",
  name: "Core switches",
  enabled: true,
  requireAckNote: true,
  actions: actions,
  escalation: null,
  repeat: null,
  emailComposition: null,
  resetActions: null,
  messageTemplate: "tpl",
  ...over,
});

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  executeActions.mockReset();
  executeActions.mockResolvedValue(undefined);
});

describe("executeActionsSafe", () => {
  it("does nothing for an empty or missing action list", async () => {
    await executeActionsSafe("n1", [], {}, {});
    await executeActionsSafe("n1", undefined as unknown as AutomationAction[], {}, {});
    expect(executeActions).not.toHaveBeenCalled();
  });

  it("passes everything through to executeActions", async () => {
    const ctx = { "asset.hostname": "sw-01" };
    const exec = { ruleId: "r1" };
    await executeActionsSafe("n1", actions, ctx, exec);
    expect(executeActions).toHaveBeenCalledWith("n1", actions, ctx, exec);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a thrown fan-out never escapes: it is audited as a warning", async () => {
    executeActions.mockRejectedValue(new Error("pool exhausted"));
    await expect(executeActionsSafe("n1", actions, {}, {})).resolves.toBeUndefined();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({
      action: "notification.delivery_expand_error",
      resourceType: "notification",
      resourceId: "n1",
      actor: "system:notification-engine",
      level: "warning",
      details: { err: "pool exhausted" },
    });
  });

  it("a failing audit write is swallowed too", async () => {
    executeActions.mockRejectedValue(new Error("x"));
    eventLog.logEvent.mockRejectedValue(new Error("db down"));
    await expect(executeActionsSafe("n1", actions, {}, {})).resolves.toBeUndefined();
  });

  it("a non-Error rejection still audits (err undefined)", async () => {
    executeActions.mockRejectedValue("string reason");
    await executeActionsSafe("n1", actions, {}, {});
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ details: { err: undefined } });
  });
});

describe("enqueueAlertActions", () => {
  const exec = () => executeActions.mock.calls[0]![3] as Record<string, unknown>;

  it("builds the exec context from the rule and the reading", async () => {
    const ctx = { k: "v" };
    await enqueueAlertActions("n1", actions, ctx, rule(), reading());
    expect(executeActions).toHaveBeenCalledWith("n1", actions, ctx, expect.any(Object));
    expect(exec()).toEqual({
      scopeRegionTags: ["region:East"],
      // stripped of the prefix, case-insensitive prefix, empty names dropped
      assetRegionTags: ["West"],
      assetId: "a1",
      ruleId: "r1",
      ruleName: "Switch down",
      ruleEmailComposition: { mode: "rule" },
      actor: "system:notification-engine",
    });
  });

  it("an empty assetId becomes null", async () => {
    await enqueueAlertActions("n1", actions, {}, rule(), reading({ assetId: "" }));
    expect(exec().assetId).toBeNull();
  });

  it("growth (rule 75) carries count and change, and omits an empty change", async () => {
    await enqueueAlertActions("n1", actions, {}, rule(), reading(), { growth: true, count: 3, change: "port5 faulted" });
    expect(exec().growth).toEqual({ count: 3, change: "port5 faulted" });
    executeActions.mockClear();
    await enqueueAlertActions("n1", actions, {}, rule(), reading(), { growth: true, count: 2, change: "" });
    expect(exec().growth).toEqual({ count: 2 });
    executeActions.mockClear();
    await enqueueAlertActions("n1", actions, {}, rule(), reading());
    expect(exec()).not.toHaveProperty("growth");
  });

  it("an owning group supplies the email layout; provenance stays the automation's", async () => {
    await enqueueAlertActions("n1", actions, {}, rule(), reading(), undefined, owner());
    expect(exec()).toMatchObject({ ruleEmailComposition: { mode: "group" }, ruleId: "r1", ruleName: "Switch down" });
  });

  it("an owner with no layout of its own yields null, not the rule's", async () => {
    await enqueueAlertActions("n1", actions, {}, rule(), reading(), undefined, owner({ emailComposition: null }));
    expect(exec().ruleEmailComposition).toBeNull();
  });

  it("a null owner falls back to the rule's layout", async () => {
    await enqueueAlertActions("n1", actions, {}, rule(), reading(), undefined, null);
    expect(exec().ruleEmailComposition).toEqual({ mode: "rule" });
  });

  it("no actions → nothing runs", async () => {
    await enqueueAlertActions("n1", [], {}, rule(), reading());
    expect(executeActions).not.toHaveBeenCalled();
  });
});

describe("groupOwnersOf", () => {
  it("asks nothing for an empty id list", async () => {
    expect((await groupOwnersOf([])).size).toBe(0);
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it("one query over the ids, only grouped alerts", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([] as never);
    await groupOwnersOf(["n1", "n2"]);
    expect(prisma.notification.findMany).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(prisma.notification.findMany).mock.calls[0]![0] as Record<string, any>;
    expect(arg.where).toEqual({ id: { in: ["n1", "n2"] }, alertGroupId: { not: null } });
    expect(arg.select.alertGroup.select).toMatchObject({ id: true, enabled: true, actions: true, emailComposition: true, resetActions: true });
  });

  it("maps each grouped alert to its group owner at the alert's severity", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      { id: "n1", severity: "critical", alertGroup: groupRow() },
      { id: "n2", severity: "warning", alertGroup: groupRow({ id: "g2", name: "Edge" }) },
    ] as never);
    const out = await groupOwnersOf(["n1", "n2"]);
    expect(out.get("n1")).toMatchObject({ kind: "group", id: "g1", severity: "critical", requireAckNote: true, messageTemplate: "tpl" });
    expect(out.get("n2")).toMatchObject({ kind: "group", id: "g2", name: "Edge", severity: "warning" });
  });

  it("a disabled group owns nothing", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([
      { id: "n1", severity: "critical", alertGroup: groupRow({ enabled: false }) },
    ] as never);
    expect((await groupOwnersOf(["n1"])).has("n1")).toBe(false);
  });

  it("a row whose group join came back null owns nothing", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([{ id: "n1", severity: "critical", alertGroup: null }] as never);
    expect((await groupOwnersOf(["n1"])).size).toBe(0);
  });
});

describe("groupOwnerOf", () => {
  it("an automation in no group answers null with zero queries", async () => {
    expect(await groupOwnerOf(rule({ alertGroupId: null }), "n1")).toBeNull();
    expect(prisma.notification.findMany).not.toHaveBeenCalled();
  });

  it("asks about the ALERT, not the automation", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([{ id: "n1", severity: "critical", alertGroup: groupRow() }] as never);
    expect(await groupOwnerOf(rule({ alertGroupId: "g1" }), "n1")).toMatchObject({ kind: "group", id: "g1" });
    expect((vi.mocked(prisma.notification.findMany).mock.calls[0]![0] as Record<string, any>).where.id).toEqual({ in: ["n1"] });
  });

  it("a member firing outside the group's scope (alert not stamped) delivers on its own", async () => {
    vi.mocked(prisma.notification.findMany).mockResolvedValue([] as never);
    expect(await groupOwnerOf(rule({ alertGroupId: "g1" }), "n1")).toBeNull();
  });
});

describe("ownerActions", () => {
  it("returns the owner's actions, or [] when it has none", () => {
    expect(ownerActions(owner({ actions: actions as never }))).toBe(actions);
    expect(ownerActions(owner({ actions: null }))).toEqual([]);
  });
});
