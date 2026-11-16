/**
 * tests/unit/automationTestService.test.ts — own unit suite for
 * src/services/automationTestService.ts (CQ-T010).
 *
 * selectTestActions' recipient rewrite is pinned in
 * automationTestDelivery.test.ts; this suite adds its remaining branches
 * (reboot, event, channel choice) and covers runTestDelivery end to end with
 * the action executor, the delivery drain and the template builder mocked:
 * the invented device (business rule 65), ruleId null + testRun (never enters
 * the escalation sweep), the dependency-down flavour (rule 78), the Event
 * target, the 20 s dispatch budget, the result summary and the audit Event.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  executeActions: vi.fn(async () => {}),
  drainPendingDeliveries: vi.fn(async () => {}),
  scopeRegionTagsOf: vi.fn(() => ["region:Atlanta"]),
  publicBaseUrl: vi.fn((): string | null => "https://polaris.example.com"),
  buildTemplateContext: vi.fn((parts: Record<string, unknown>) => ({ __parts: parts })),
  withTimeout: vi.fn(async <T>(p: Promise<T>, _ms?: number, _what?: string) => p),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/automationActionService.js", () => ({ executeActions: mocks.executeActions }));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({ drainPendingDeliveries: mocks.drainPendingDeliveries }));
vi.mock("../../src/services/notificationRecipientService.js", () => ({ scopeRegionTagsOf: mocks.scopeRegionTagsOf }));
vi.mock("../../src/utils/publicUrl.js", () => ({ publicBaseUrl: mocks.publicBaseUrl }));
vi.mock("../../src/utils/notificationTemplate.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  buildTemplateContext: mocks.buildTemplateContext,
}));
vi.mock("../../src/utils/timeout.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  withTimeout: mocks.withTimeout,
}));

import { runTestDelivery, selectTestActions } from "../../src/services/automationTestService.js";
import { TimeoutError } from "../../src/utils/timeout.js";
import { AppError } from "../../src/utils/errors.js";
import { SAMPLE_ALERT_DEVICE, SAMPLE_ALERT_HOSTNAME, SAMPLE_UPSTREAM_HOSTNAME } from "../../src/utils/sampleAlertDevice.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const CALLER = "user-me";

const draft = (actions: unknown[], extra: Record<string, unknown> = {}) =>
  ({ actions, severityBands: null, bandNotify: null, resetActions: null, escalation: null, ...extra }) as never;

const baseRule = (extra: Record<string, unknown> = {}) => ({
  name: "High CPU",
  description: "CPU over 90",
  severity: "warning",
  trigger: { type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 },
  scope: { tags: ["region:Atlanta"] },
  actions: [{ type: "notify", channelId: "ch-mail", recipientAllUsers: true }],
  severityBands: null, bandNotify: null, resetActions: null, escalation: null,
  ...extra,
}) as never;

const run = (extra: Record<string, unknown> = {}) =>
  runTestDelivery({ rule: baseRule(), path: { index: 0 }, target: "delivery", actorUserId: CALLER, actorUsername: "dave", ...extra } as never);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  mocks.executeActions.mockReset().mockResolvedValue(undefined);
  mocks.drainPendingDeliveries.mockReset().mockResolvedValue(undefined);
  mocks.scopeRegionTagsOf.mockReset().mockReturnValue(["region:Atlanta"]);
  mocks.publicBaseUrl.mockReset().mockReturnValue("https://polaris.example.com");
  mocks.buildTemplateContext.mockReset().mockImplementation((parts: Record<string, unknown>) => ({ __parts: parts }));
  mocks.withTimeout.mockReset().mockImplementation(async (p: Promise<unknown>) => p);
  stubbed(prisma.notification.create).mockResolvedValue({ id: "n-test" });
  stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([
    { transport: "email", target: "me@example.com", status: "sent", error: null, meta: null },
  ]);
});

describe("selectTestActions — remaining branches", () => {
  it("never books a reboot (rule 115(c))", () => {
    const { actions, skipped } = selectTestActions(draft([{ type: "reboot" }]), { index: 0 }, CALLER);
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ type: "reboot", reason: "a test never reboots a device" }]);
  });

  it("has nothing to deliver for an event action", () => {
    const { actions, skipped } = selectTestActions(draft([{ type: "event" }]), { index: 0 }, CALLER);
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ type: "event", reason: "nothing to deliver" }]);
  });

  it("tests the primary channel of a multi-channel action by default, or the one named", () => {
    const d = draft([{ type: "notify", channelId: "ch-a", channelIds: ["ch-a", "ch-b"] }]);
    expect(selectTestActions(d, { index: 0 }, CALLER).actions[0]).toMatchObject({ channelId: "ch-a" });
    const named = selectTestActions(d, { index: 0, channelId: "ch-b" }, CALLER).actions[0]!;
    expect(named).toEqual({ type: "notify", channelId: "ch-b", recipientUserIds: [CALLER] });
  });

  it("refuses a channel the action does not carry with a 400", () => {
    const d = draft([{ type: "notify", channelId: "ch-a" }]);
    let err: unknown;
    try { selectTestActions(d, { index: 0, channelId: "ch-zzz" }, CALLER); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).httpStatus).toBe(400);
  });

  it("refuses a missing index with a 400", () => {
    expect(() => selectTestActions(draft([]), { index: 0 }, CALLER)).toThrow(AppError);
    try { selectTestActions(draft([]), { index: -1 }, CALLER); } catch (e) { expect((e as AppError).httpStatus).toBe(400); }
  });
});

describe("runTestDelivery — the test alert row", () => {
  it("creates a TEST alert with ruleId null, testRun, no device id and the invented hostname", async () => {
    await run();
    const data = stubbed(prisma.notification.create).mock.calls[0]![0].data;
    expect(data).toMatchObject({
      ruleId: null, testRun: true, assetId: null, assetHostname: SAMPLE_ALERT_HOSTNAME,
      severity: "warning", metric: "cpuPct", regionTags: [], dimension: null,
    });
    expect(data.message).toBe(`[TEST] High CPU — delivery test for ${SAMPLE_ALERT_HOSTNAME}`);
    expect(data).not.toHaveProperty("dependencyDown");
  });

  it("defaults the severity to warning and the name to Automation", async () => {
    await runTestDelivery({ rule: baseRule({ severity: undefined, name: "" }), path: { index: 0 }, target: "delivery", actorUserId: CALLER, actorUsername: "dave" });
    const data = stubbed(prisma.notification.create).mock.calls[0]![0].data;
    expect(data.severity).toBe("warning");
    expect(data.message).toMatch(/^\[TEST\] Automation — delivery test/);
  });

  it("takes the metric from a state trigger's field, and none from a change trigger", async () => {
    await runTestDelivery({ rule: baseRule({ trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" } }), path: { index: 0 }, target: "delivery", actorUserId: CALLER, actorUsername: "d" });
    expect(stubbed(prisma.notification.create).mock.calls[0]![0].data.metric).toBe("ifOperStatus");
    await runTestDelivery({ rule: baseRule({ trigger: { type: "change", changeType: "firmware_changed" } }), path: { index: 0 }, target: "delivery", actorUserId: CALLER, actorUsername: "d" });
    expect(stubbed(prisma.notification.create).mock.calls[1]![0].data.metric).toBeNull();
  });

  it("names an invented component for a sensor metric", async () => {
    await runTestDelivery({ rule: baseRule({ trigger: { type: "asset_metric", metric: "hwSensorValue", operator: ">", threshold: 70 } }), path: { index: 0 }, target: "delivery", actorUserId: CALLER, actorUsername: "d" });
    const data = stubbed(prisma.notification.create).mock.calls[0]![0].data;
    expect(typeof data.dimension).toBe("string");
    expect(data.dimension.length).toBeGreaterThan(0);
  });

  it("carries the dependency-down flavour, blaming an invented upstream (rule 78)", async () => {
    const trigger = { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", alertWhenDependencyDown: true };
    await runTestDelivery({ rule: baseRule({ trigger }), path: { index: 0 }, target: "delivery", actorUserId: CALLER, actorUsername: "d" });
    const data = stubbed(prisma.notification.create).mock.calls[0]![0].data;
    expect(data.dependencyDown).toBe(true);
    expect(data.dependencyBlame.upstream).toEqual({ id: null, hostname: SAMPLE_UPSTREAM_HOSTNAME });
    expect(data.dependencyBlame.chain).toHaveLength(1);
    const parts = mocks.buildTemplateContext.mock.calls[0]![0] as Record<string, unknown>;
    expect(parts.dependency).toEqual({ upstream: SAMPLE_UPSTREAM_HOSTNAME, rootCause: null, reason: "down" });
    expect(typeof parts.triggerSummary).toBe("string");
  });
});

describe("runTestDelivery — the Event target", () => {
  it("writes only the audit Event, never runs an action", async () => {
    const out = await run({ target: "event" });
    expect(out).toEqual({
      ok: true, notificationId: "n-test",
      message: "Test Event written — look for notification.triggered in the Events tab.",
      deliveries: [], skipped: [],
      ackLinks: { enabled: false, reason: "an Event carries no acknowledge link" },
    });
    expect(mocks.executeActions).not.toHaveBeenCalled();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({
      action: "notification.triggered", resourceType: "notification", resourceId: "n-test",
      actor: "dave", level: "warning", details: { test: true, ruleId: null, assetId: null, severity: "warning" },
    });
  });

  it("maps severity to the Event level", async () => {
    for (const [severity, level] of [["critical", "error"], ["serious", "error"], ["warning", "warning"], ["info", "info"]] as const) {
      resetEventLogStub();
      await runTestDelivery({ rule: baseRule({ severity }), path: { index: 0 }, target: "event", actorUserId: CALLER, actorUsername: "d" });
      expect(eventLog.logEvent.mock.calls[0]![0].level).toBe(level);
    }
  });
});

describe("runTestDelivery — the delivery target", () => {
  it("runs the rewritten notify action against the test alert, with the invented device as context", async () => {
    await run();
    expect(mocks.executeActions).toHaveBeenCalledTimes(1);
    const [notifId, actions, ctx, opts] = mocks.executeActions.mock.calls[0]! as unknown as [string, unknown[], { __parts: Record<string, unknown> }, Record<string, unknown>];
    expect(notifId).toBe("n-test");
    expect(actions).toEqual([{ type: "notify", channelId: "ch-mail", recipientUserIds: [CALLER] }]);
    expect(ctx.__parts).toMatchObject({ asset: SAMPLE_ALERT_HOSTNAME, severity: "warning", ruleName: "High CPU", ruleDescription: "CPU over 90", value: "", metric: "cpuPct" });
    expect(ctx.__parts.assetDetail).toBe(SAMPLE_ALERT_DEVICE);
    expect(opts).toMatchObject({ scopeRegionTags: ["region:Atlanta"], assetRegionTags: [], assetId: null, ruleName: "High CPU", ruleEmailComposition: null, actor: "dave" });
    expect(mocks.drainPendingDeliveries).toHaveBeenCalledWith({ notificationId: "n-test" });
    expect(mocks.withTimeout.mock.calls[0]![1]).toBe(20_000);
  });

  it("reports the sent targets and writes an info audit Event", async () => {
    const out = await run();
    expect(out).toEqual({
      ok: true, notificationId: "n-test",
      message: "Sent to me@example.com",
      deliveries: [{ transport: "email", target: "me@example.com", status: "sent", error: null }],
      skipped: [], ackLinks: { enabled: true },
    });
    const ev = eventLog.logEvent.mock.calls[0]![0];
    expect(ev).toMatchObject({ action: "automation.test_delivery", level: "info", resourceId: "n-test", actor: "dave" });
    expect(ev.message).toBe('Delivery test for "High CPU": 1 sent, 0 failed (sender only)');
    expect(ev.details).toMatchObject({ rows: 1, sent: 1, failed: 0, ackLinks: true });
  });

  it("is not ok when any delivery failed, and quotes the first error", async () => {
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([
      { transport: "email", target: "me@example.com", status: "sent", error: null, meta: null },
      { transport: "web_push", target: "", status: "failed", error: "subscription gone", meta: null },
    ]);
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.message).toBe("Sent to me@example.com — subscription gone");
  });

  it("says nothing was delivered when no row was sent", async () => {
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([]);
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.message).toBe("Nothing was delivered — the action resolved to no recipients");
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([
      { transport: "email", target: "me@example.com", status: "failed", error: null, meta: null },
    ]);
    expect((await run()).message).toBe("Nothing was delivered — delivery failed");
  });

  it("falls back to a destination count when the sent rows carry no target", async () => {
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([
      { transport: "web_push", target: "", status: "sent", error: null, meta: null },
    ]);
    expect((await run()).message).toBe("Sent to 1 destination(s)");
  });

  it("says the acknowledge link is off without a public URL", async () => {
    mocks.publicBaseUrl.mockReturnValue(null);
    const out = await run();
    expect(out.ackLinks).toEqual({ enabled: false, reason: "POLARIS_PUBLIC_URL is not set, so no acknowledge link can be built" });
  });

  it("reports still-sending when the dispatch budget runs out", async () => {
    mocks.withTimeout.mockRejectedValue(new TimeoutError("test delivery dispatch", 20_000));
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([]);
    const out = await run();
    expect(out.timedOut).toBe(true);
    expect(out.message).toBe("Still sending — check the alert's deliveries in a moment.");
  });

  it("carries on and reports when the drain throws something else", async () => {
    mocks.withTimeout.mockRejectedValue(new Error("smtp down"));
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([]);
    const out = await run();
    expect(out).not.toHaveProperty("timedOut");
    expect(out.message).toBe("Nothing was delivered — the action resolved to no recipients");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
  });

  it("returns the skip reason without running anything for a script action", async () => {
    const rule = baseRule({ actions: [{ type: "script", scriptId: "s1", runOn: "server" }] });
    const out = await runTestDelivery({ rule, path: { index: 0 }, target: "delivery", actorUserId: CALLER, actorUsername: "d" });
    // Was a bug until 2026-11-16: the test Notification was created before the skip, leaving an orphan alert row, and no Event was written.
    expect(out).toEqual({
      ok: false, notificationId: null, message: "scripts are never run by a test button",
      deliveries: [], skipped: [{ type: "script", reason: "scripts are never run by a test button" }], ackLinks: { enabled: false },
    });
    expect(prisma.notification.create).not.toHaveBeenCalled();
    expect(mocks.executeActions).not.toHaveBeenCalled();
    expect(mocks.drainPendingDeliveries).not.toHaveBeenCalled();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({
      action: "automation.test_delivery", actor: "d", level: "info",
      details: { sent: 0, skipped: [{ type: "script", reason: "scripts are never run by a test button" }] },
    });
  });

  it("creates no test alert when the addressed action no longer exists (400)", async () => {
    // Was a bug until 2026-11-16: the Notification was created before selectTestActions refused.
    const rule = baseRule({ actions: [] });
    await expect(runTestDelivery({ rule, path: { index: 3 }, target: "delivery", actorUserId: CALLER, actorUsername: "d" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.notification.create).not.toHaveBeenCalled();
  });

  it("passes the rule-level email composition through to the executor", async () => {
    const rule = baseRule({ emailComposition: { subjectTemplate: "[{severity}] {asset}" } });
    await runTestDelivery({ rule, path: { index: 0 }, target: "delivery", actorUserId: CALLER, actorUsername: "d" });
    expect((mocks.executeActions.mock.calls[0]! as unknown[])[3]).toMatchObject({ ruleEmailComposition: { subjectTemplate: "[{severity}] {asset}" } });
  });
});
