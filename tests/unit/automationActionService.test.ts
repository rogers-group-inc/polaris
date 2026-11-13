/**
 * tests/unit/automationActionService.test.ts — the own suite for
 * src/services/automationActionService.ts (CQ-T010).
 *
 * Complements automationActions.test.ts (notify composition basics, api_call
 * body rendering, the warning Event on a failing script). Adds what it does not
 * reach: the per-call dispatchId, contact resolution (once, only when asked,
 * failure-tolerant), rule 39's both-methods gate, the escalation / reminder /
 * growth subject prefixes and the escalation per-field merge, quiet time
 * (rules 92 + 120: held fire, stamp, live-source stamp, deferred split stamp,
 * the all-clear drop and the per-reader split), the reboot action (rule
 * 115(c)), the script action, the event no-op, and the api_call row's meta.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  expand: vi.fn(),
  rebootRecips: vi.fn(),
  compose: vi.fn(),
  scriptRun: vi.fn(),
  contacts: vi.fn(),
  quietHold: vi.fn(),
  quietWindow: vi.fn(),
  bookReboot: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/notificationRecipientService.js", () => ({
  expandDeliveries: h.expand,
  resolveRebootActionRecipients: h.rebootRecips,
  buildComposedEmail: h.compose,
}));
vi.mock("../../src/services/automationScriptService.js", () => ({ requestScriptRun: h.scriptRun }));
vi.mock("../../src/services/contactService.js", () => ({ resolveContactEmailsForAsset: h.contacts }));
vi.mock("../../src/services/quietTimeHoldService.js", () => ({
  resolveQuietHold: h.quietHold,
  resolveQuietWindow: h.quietWindow,
}));
vi.mock("../../src/services/rebootScheduleService.js", () => ({ bookRebootFromAutomation: h.bookReboot }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { executeActions } from "../../src/services/automationActionService.js";
import type { AutomationAction } from "../../src/services/notificationTypes.js";

const CTX = { asset: "sw1", severity: "warning", message: "hot" };
const notify = (extra: Record<string, unknown> = {}): AutomationAction => ({ type: "notify", channelId: "c1", ...extra }) as AutomationAction;
const opts = (i = 0) => h.expand.mock.calls[i][2];
const events = () => eventLog.logEvent.mock.calls.map((c) => c[0]);
const SRC = { kind: "global" as const, id: "q1", name: "Nights" };
const holdOf = (extra: Record<string, unknown> = {}) => ({
  source: SRC,
  config: {},
  windowEnd: new Date(2026, 10, 14, 7, 30),
  split: false,
  isHeldFor: () => true,
  ...extra,
});

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of Object.values(h)) f.mockReset();
  h.expand.mockResolvedValue(1);
  h.compose.mockImplementation((comp: any) => ({ subject: comp.subjectTemplate ?? "Default subject", text: comp.bodyTextTemplate ?? "t", html: "h" }));
  h.contacts.mockResolvedValue(["owner@example.com"]);
  h.quietHold.mockResolvedValue(null);
  h.quietWindow.mockResolvedValue(null);
  h.scriptRun.mockResolvedValue(undefined);
  h.rebootRecips.mockResolvedValue({ to: ["ops@example.com"], cc: [], bcc: [] });
  h.bookReboot.mockResolvedValue({ booked: true });
  stubbed(prisma.notification.findUnique).mockResolvedValue({
    ruleId: "r1", assetId: "a1", metric: "cpu", severity: "warning", testRun: false, quietHeldAt: null, quietSummarizedAt: null, quietSource: null,
  });
  stubbed(prisma.notification.update).mockResolvedValue({});
  stubbed(prisma.notification.updateMany).mockResolvedValue({ count: 1 });
  stubbed(prisma.notificationDelivery.create).mockResolvedValue({});
  stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([]);
  stubbed(prisma.notificationChannel.findMany).mockResolvedValue([]);
});

// ─── fan-out basics ─────────────────────────────────────────────────────────

describe("executeActions — fan-out", () => {
  it("returns zero counts for an empty action list without reading the alert", async () => {
    expect(await executeActions("n1", [], CTX, {})).toEqual({ executed: 0, failed: 0 });
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
  });

  it("every notify row of one call shares one dispatchId; a second call mints another", async () => {
    await executeActions("n1", [notify(), notify({ channelId: "c2" })], CTX, {});
    await executeActions("n1", [notify()], CTX, {});
    const ids = h.expand.mock.calls.map((c) => c[2].dispatchId);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("a notify that produced no rows is not counted as executed", async () => {
    h.expand.mockResolvedValue(0);
    expect(await executeActions("n1", [notify()], CTX, {})).toEqual({ executed: 0, failed: 0 });
  });

  it("an event action is a no-op and never counts as executed", async () => {
    expect(await executeActions("n1", [{ type: "event" } as AutomationAction], CTX, {})).toEqual({ executed: 0, failed: 0 });
    expect(prisma.notification.findUnique).not.toHaveBeenCalled(); // not people-facing
  });

  it("a failing action writes automation.action_error and the next action still runs", async () => {
    h.expand.mockRejectedValueOnce(new Error("smtp gone"));
    const res = await executeActions("n1", [notify(), notify({ channelId: "c2" })], CTX, {
      ruleId: "r1", ruleName: "CPU", assetId: "a1", escalation: { tier: 2, attempt: 1 },
    });
    expect(res).toEqual({ executed: 1, failed: 1 });
    expect(events()[0]).toMatchObject({
      action: "automation.action_error",
      resourceType: "notification",
      resourceId: "n1",
      resourceName: "CPU",
      actor: "system:automation",
      level: "warning",
      message: "Automation action 1 (notify) failed: smtp gone",
      details: { actionIndex: 0, actionType: "notify", ruleId: "r1", assetId: "a1", escalation: { tier: 2, attempt: 1 }, err: "smtp gone" },
    });
  });

  it("the failure Event uses the exec actor and omits escalation when absent", async () => {
    h.expand.mockRejectedValue(new Error("x"));
    await executeActions("n1", [notify()], CTX, { actor: "alice" });
    expect(events()[0].actor).toBe("alice");
    expect("escalation" in (events()[0].details as object)).toBe(false);
  });

  it("a rejecting logEvent on the failure path does not escape", async () => {
    h.expand.mockRejectedValue(new Error("x"));
    eventLog.logEvent.mockRejectedValue(new Error("log down"));
    await expect(executeActions("n1", [notify()], CTX, {})).resolves.toEqual({ executed: 0, failed: 1 });
  });

  it("passes the region tags, escalation and repeat through to expandDeliveries", async () => {
    await executeActions("n1", [notify()], CTX, { scopeRegionTags: ["region:E"], assetRegionTags: ["ATL"], escalation: { tier: 1, attempt: 2 } });
    expect(opts()).toMatchObject({ scopeRegionTags: ["region:E"], assetRegionTags: ["ATL"], escalation: { tier: 1, attempt: 2 } });
    expect(h.expand.mock.calls[0][1]).toEqual([{ channelId: "c1" }]);
  });

  it("followUp rides only when the context carries a policy sentence", async () => {
    await executeActions("n1", [notify()], CTX, {});
    expect("followUp" in opts(0)).toBe(false);
    await executeActions("n1", [notify()], { ...CTX, "repeat.policy": "Repeats hourly.", "escalation.policy": "Escalates in 1h." }, {});
    expect(opts(1).followUp).toBe("Repeats hourly. Escalates in 1h.");
  });

  it("an all-clear asks for no ack and carries the recovery message", async () => {
    await executeActions("n1", [notify()], { ...CTX, severity: "resolved", message: "back to normal" }, {});
    expect(opts()).toMatchObject({ noAck: true, allClearMessage: "back to normal" });
  });
});

// ─── contacts + rule 39 ─────────────────────────────────────────────────────

describe("executeActions — asset contacts", () => {
  it("resolves contacts only for actions that opt in, and once per call", async () => {
    await executeActions("n1", [notify({ recipientAssetContacts: true }), notify({ recipientAssetContacts: true }), notify()], CTX, { assetId: "a1" });
    expect(h.contacts).toHaveBeenCalledTimes(1);
    expect(h.contacts).toHaveBeenCalledWith("a1");
    expect(opts(0).assetContactEmails).toEqual(["owner@example.com"]);
    expect(opts(1).assetContactEmails).toEqual(["owner@example.com"]);
    expect("assetContactEmails" in opts(2)).toBe(false);
  });

  it("no asset → an empty list without a lookup", async () => {
    await executeActions("n1", [notify({ recipientAssetContacts: true })], CTX, {});
    expect(h.contacts).not.toHaveBeenCalled();
    expect(opts().assetContactEmails).toEqual([]);
  });

  it("a failing lookup yields an empty list and the notify still runs", async () => {
    h.contacts.mockRejectedValue(new Error("db"));
    const res = await executeActions("n1", [notify({ recipientAssetContacts: true })], CTX, { assetId: "a1" });
    expect(opts().assetContactEmails).toEqual([]);
    expect(res.executed).toBe(1);
  });
});

describe("executeActions — respectUserPreference (rule 39)", () => {
  it("is absent when the action does not ask", async () => {
    await executeActions("n1", [notify()], CTX, {});
    expect("enforceUserPreference" in opts()).toBe(false);
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
  });

  it("one channel can never be both methods — false with no query", async () => {
    await executeActions("n1", [notify({ respectUserPreference: true })], CTX, {});
    expect(opts().enforceUserPreference).toBe(false);
    expect(prisma.notificationChannel.findMany).not.toHaveBeenCalled();
  });

  it("an email + web push group enforces the preference", async () => {
    stubbed(prisma.notificationChannel.findMany).mockResolvedValue([{ type: "smtp" }, { type: "web_push" }]);
    await executeActions("n1", [notify({ respectUserPreference: true, channelIds: ["c1", "c2"] })], CTX, {});
    expect(opts().enforceUserPreference).toBe(true);
    expect(stubbed(prisma.notificationChannel.findMany).mock.calls[0][0].where.id.in.sort()).toEqual(["c1", "c2"]);
  });

  it("chat channels do not count as a method", async () => {
    stubbed(prisma.notificationChannel.findMany).mockResolvedValue([{ type: "smtp" }, { type: "slack" }, { type: "oauth_m365" }]);
    await executeActions("n1", [notify({ respectUserPreference: true }), notify({ channelId: "c2" }), notify({ channelId: "c3" })], CTX, {});
    expect(opts().enforceUserPreference).toBe(false);
  });

  it("the answer is read once per group across several asking actions", async () => {
    stubbed(prisma.notificationChannel.findMany).mockResolvedValue([{ type: "smtp" }, { type: "web_push" }]);
    await executeActions("n1", [notify({ respectUserPreference: true }), notify({ channelId: "c2", respectUserPreference: true })], CTX, {});
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledTimes(1);
    expect(opts(1).enforceUserPreference).toBe(true);
  });
});

// ─── composition ────────────────────────────────────────────────────────────

describe("executeActions — composition", () => {
  it("escalation: per-field tier → rule merge; cc/bcc only from the tier; [ESCALATION n] prefix", async () => {
    await executeActions("n1", [notify({ emailComposition: { bodyTextTemplate: "tier body", cc: { addresses: ["c@x.com"] } } })], CTX, {
      escalation: { tier: 3, attempt: 1 },
      ruleEmailComposition: { subjectTemplate: null, bodyTextTemplate: "rule body", bodyHtmlTemplate: "rule html", bcc: { addresses: ["b@x.com"] } },
    });
    expect(h.compose.mock.calls[0][0]).toEqual({
      subjectTemplate: null,
      bodyTextTemplate: "tier body",
      bodyHtmlTemplate: "rule html",
      cc: { addresses: ["c@x.com"] },
      bcc: null,
    });
    expect(opts().composedEmail.subject).toBe("[ESCALATION 3] Default subject");
  });

  it("escalation keeps an operator subject verbatim", async () => {
    await executeActions("n1", [notify()], CTX, { escalation: { tier: 1, attempt: 1 }, ruleEmailComposition: { subjectTemplate: "Mine {asset}" } });
    expect(opts().composedEmail.subject).toBe("Mine {asset}");
  });

  it("reminder: [REMINDER n] prefix, with the age only on the quiet-resumed one", async () => {
    await executeActions("n1", [notify()], CTX, { repeat: { attempt: 4 } });
    await executeActions("n1", [notify()], CTX, { repeat: { attempt: 5, elapsed: "9h 12m" } });
    await executeActions("n1", [notify()], CTX, { repeat: { attempt: 6, elapsed: "9h 12m", quietResumed: true } });
    expect(h.expand.mock.calls.map((c) => c[2].composedEmail.subject)).toEqual([
      "[REMINDER 4] Default subject",
      "[REMINDER 5] Default subject",
      "[REMINDER 6 · ACTIVE 9h 12m] Default subject",
    ]);
  });

  it("reminder uses the action composition wholesale and keeps an operator subject", async () => {
    await executeActions("n1", [notify({ emailComposition: { subjectTemplate: "Act" } })], CTX, { repeat: { attempt: 2 }, ruleEmailComposition: { subjectTemplate: "Rule" } });
    expect(opts().composedEmail.subject).toBe("Act");
  });

  it("growth: [UPDATED · n · change] prefix; bare count without a change", async () => {
    await executeActions("n1", [notify()], CTX, { growth: { count: 9, change: "port7 back" } });
    await executeActions("n1", [notify()], CTX, { growth: { count: 2 } });
    expect(h.expand.mock.calls.map((c) => c[2].composedEmail.subject)).toEqual([
      "[UPDATED · 9 · port7 back] Default subject",
      "[UPDATED · 2] Default subject",
    ]);
  });

  it("escalation wins over repeat / growth when both are set", async () => {
    await executeActions("n1", [notify()], CTX, { escalation: { tier: 2, attempt: 1 }, repeat: { attempt: 3 }, growth: { count: 4 } });
    expect(opts().composedEmail.subject).toBe("[ESCALATION 2] Default subject");
  });

  it("a plain fire with no composition anywhere still composes from {}", async () => {
    await executeActions("n1", [notify()], CTX, {});
    expect(h.compose.mock.calls[0][0]).toEqual({});
    expect(opts().composedEmail.subject).toBe("Default subject");
  });
});

// ─── api_call / script / reboot ─────────────────────────────────────────────

describe("executeActions — api_call", () => {
  const api = (extra: Record<string, unknown> = {}) => ({ type: "api_call", method: "POST", url: "https://hook.example.com/x", timeoutSec: 10, ...extra }) as AutomationAction;

  it("writes one NULL-channel api_call delivery and counts it", async () => {
    const res = await executeActions("n1", [api({ headers: { Authorization: "sealed" }, bodyTemplate: "host={asset}" })], CTX, {});
    expect(res).toEqual({ executed: 1, failed: 0 });
    expect(stubbed(prisma.notificationDelivery.create).mock.calls[0][0].data).toEqual({
      notificationId: "n1",
      channelId: null,
      transport: "api_call",
      target: "https://hook.example.com/x",
      meta: { apiCall: true, method: "POST", url: "https://hook.example.com/x", headers: { Authorization: "sealed" }, body: "host=sw1", timeoutSec: 10 },
    });
  });

  it("omits empty headers and a blank body; stamps escalation", async () => {
    await executeActions("n1", [api({ headers: {}, bodyTemplate: "   " })], CTX, { escalation: { tier: 1, attempt: 2 } });
    const meta = stubbed(prisma.notificationDelivery.create).mock.calls[0][0].data.meta;
    expect(meta).toEqual({ apiCall: true, method: "POST", url: "https://hook.example.com/x", timeoutSec: 10, escalation: { tier: 1, attempt: 2 } });
  });

  it("is not people-facing: alone it never reads the alert for quiet time", async () => {
    await executeActions("n1", [api()], CTX, {});
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
  });
});

describe("executeActions — script", () => {
  it("renders the args at fire time and enqueues a run", async () => {
    const res = await executeActions("n1", [{ type: "script", scriptId: "s1", runOn: "server", argsTemplate: "--host {asset}", timeoutSec: 30 } as AutomationAction], CTX, { ruleId: "r1", assetId: "a1" });
    expect(res.executed).toBe(1);
    expect(h.scriptRun).toHaveBeenCalledWith({
      scriptId: "s1", runOn: "server", args: "--host sw1", timeoutSec: 30, notificationId: "n1", ruleId: "r1", assetId: "a1", requestedBy: "system:automation",
    });
  });

  it("a blank args template is null; missing ids are null; actor rides as requestedBy", async () => {
    await executeActions("n1", [{ type: "script", scriptId: "s1", runOn: "server", argsTemplate: "  " } as AutomationAction], CTX, { actor: "bob" });
    expect(h.scriptRun.mock.calls[0][0]).toMatchObject({ args: null, timeoutSec: null, ruleId: null, assetId: null, requestedBy: "bob" });
  });

  it("a refused script is a failed action", async () => {
    h.scriptRun.mockRejectedValue(new Error("script disabled"));
    expect(await executeActions("n1", [{ type: "script", scriptId: "s1", runOn: "server" } as AutomationAction], CTX, {})).toEqual({ executed: 0, failed: 1 });
    expect(events()[0].message).toBe("Automation action 1 (script) failed: script disabled");
  });
});

describe("executeActions — reboot (rule 115(c))", () => {
  const reboot = (extra: Record<string, unknown> = {}) => ({ type: "reboot", when: "now", minGapHours: 6, ...extra }) as unknown as AutomationAction;

  it("books through the scheduler with the resolved recipients", async () => {
    h.rebootRecips.mockResolvedValue({ to: ["a@x.com"], cc: ["c@x.com"], bcc: ["b@x.com"] });
    const res = await executeActions("n1", [reboot()], CTX, { assetId: "a1", ruleId: "r1", ruleName: "Hung", assetRegionTags: ["ATL"] });
    expect(res).toEqual({ executed: 1, failed: 0 });
    expect(h.rebootRecips.mock.calls[0][1]).toMatchObject({ assetRegionTags: ["ATL"], logCtx: { notificationId: "n1", assetId: "a1", action: "reboot" } });
    expect(h.bookReboot).toHaveBeenCalledWith({
      assetId: "a1", when: "now", at: undefined, notifyEmails: ["a@x.com"], notifyCc: ["c@x.com"], notifyBcc: ["b@x.com"], minGapHours: 6, ruleId: "r1", ruleName: "Hung", notificationId: "n1",
    });
  });

  it("no triggering device → a failed action, nothing booked", async () => {
    const res = await executeActions("n1", [reboot()], CTX, {});
    expect(res).toEqual({ executed: 0, failed: 1 });
    expect(h.bookReboot).not.toHaveBeenCalled();
    expect(events()[0].message).toContain("the alert has no device to reboot");
  });

  it("a To that resolved to nobody is a failed action", async () => {
    h.rebootRecips.mockResolvedValue({ to: [], cc: ["c@x.com"], bcc: [] });
    const res = await executeActions("n1", [reboot()], CTX, { assetId: "a1" });
    expect(res.failed).toBe(1);
    expect(h.bookReboot).not.toHaveBeenCalled();
  });

  it("a skip (not booked) is neither executed nor failed", async () => {
    h.bookReboot.mockResolvedValue({ booked: false });
    expect(await executeActions("n1", [reboot()], CTX, { assetId: "a1" })).toEqual({ executed: 0, failed: 0 });
  });

  it("asks for the asset's contacts only when the action opts in", async () => {
    await executeActions("n1", [reboot({ recipientAssetContacts: true })], CTX, { assetId: "a1" });
    expect(h.rebootRecips.mock.calls[0][1].assetContactEmails).toEqual(["owner@example.com"]);
  });
});

// ─── quiet time (rules 92 + 120) ────────────────────────────────────────────

describe("executeActions — quiet time", () => {
  it("a fire inside a quiet window writes held rows, stamps the alert and logs notification.quiet_held", async () => {
    h.quietHold.mockResolvedValue(holdOf());
    await executeActions("n1", [notify()], CTX, { ruleId: "r1", ruleName: "CPU", assetId: "a1" });
    expect(h.quietHold).toHaveBeenCalledWith({ ruleId: "r1", severity: "warning", metric: "cpu", assetId: "a1" });
    expect(opts().hold).toEqual({ kind: "global", id: "q1", windowEnd: holdOf().windowEnd });
    const upd = stubbed(prisma.notification.update).mock.calls[0][0];
    expect(upd.where).toEqual({ id: "n1" });
    expect(upd.data.quietSource).toEqual(SRC);
    expect(upd.data.quietHeldAt).toBeInstanceOf(Date);
    const ev = events().find((e) => e.action === "notification.quiet_held")!;
    expect(ev.message).toBe('Held for quiet time (global quiet time "Nights") — a summary of outstanding alerts goes out after 2026-11-14T07:30');
    expect(ev.details).toEqual({ ruleId: "r1", assetId: "a1", source: SRC, windowEnd: "2026-11-14T07:30" });
  });

  it("an automation's own quiet time is named as such", async () => {
    h.quietHold.mockResolvedValue(holdOf({ source: { kind: "automation", id: "r1", name: "CPU" } }));
    await executeActions("n1", [notify()], CTX, {});
    expect(events()[0].message).toContain('(automation quiet time "CPU")');
  });

  it("an alert already held is not re-stamped", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue({ ruleId: "r1", severity: "warning", testRun: false, quietHeldAt: new Date(), quietSource: SRC });
    h.quietHold.mockResolvedValue(holdOf());
    await executeActions("n1", [notify()], CTX, {});
    expect(prisma.notification.update).not.toHaveBeenCalled();
    expect(opts().hold).toBeDefined();
  });

  it("the context severity wins over the row's; the rule id falls back to exec", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue({ ruleId: null, assetId: null, metric: null, severity: "notice", testRun: false, quietHeldAt: null, quietSource: null });
    await executeActions("n1", [notify()], { ...CTX, severity: "critical" }, { ruleId: "rX" });
    expect(h.quietHold.mock.calls[0][0]).toMatchObject({ ruleId: "rX", severity: "critical" });
  });

  it("a test fire is never held", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue({ testRun: true });
    h.quietHold.mockResolvedValue(holdOf());
    await executeActions("n1", [notify()], CTX, {});
    expect(h.quietHold).not.toHaveBeenCalled();
    expect("hold" in opts()).toBe(false);
  });

  it("escalation and repeat passes are left to the sweep (no alert read)", async () => {
    await executeActions("n1", [notify()], CTX, { escalation: { tier: 1, attempt: 1 } });
    await executeActions("n1", [notify()], CTX, { repeat: { attempt: 1 } });
    expect(prisma.notification.findUnique).not.toHaveBeenCalled();
  });

  it("the sweep's own split hold is passed through with isHeldFor", async () => {
    const isHeldFor = () => false;
    await executeActions("n1", [notify()], CTX, { repeat: { attempt: 1 }, quietHold: holdOf({ split: true, isHeldFor }) as never });
    expect(opts().hold).toEqual({ kind: "global", id: "q1", windowEnd: holdOf().windowEnd, isHeldFor });
  });

  it("a read failure delivers as usual", async () => {
    stubbed(prisma.notification.findUnique).mockRejectedValue(new Error("db"));
    const res = await executeActions("n1", [notify()], CTX, {});
    expect(res.executed).toBe(1);
    expect("hold" in opts()).toBe(false);
  });

  it("a live fire inside an open window gets its quiet source stamped (rule 92(f))", async () => {
    h.quietWindow.mockResolvedValue(SRC);
    await executeActions("n1", [notify()], CTX, {});
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({ where: { id: "n1", quietHeldAt: null }, data: { quietSource: SRC } });
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it("the live-source lookup is skipped when the row already has a source; its failure is swallowed", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue({ severity: "warning", testRun: false, quietHeldAt: null, quietSource: SRC });
    await executeActions("n1", [notify()], CTX, {});
    expect(h.quietWindow).not.toHaveBeenCalled();
    h.quietWindow.mockRejectedValue(new Error("x"));
    stubbed(prisma.notification.findUnique).mockResolvedValue({ severity: "warning", testRun: false, quietHeldAt: null, quietSource: null });
    await expect(executeActions("n1", [notify()], CTX, {})).resolves.toEqual({ executed: 1, failed: 0 });
    expect(prisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it("split hold (rule 120): stamped AFTER the fan-out, with live/held counts, when someone was held", async () => {
    h.quietHold.mockResolvedValue(holdOf({ split: true }));
    h.expand.mockImplementation(async (_n: string, _t: unknown, o: any) => {
      o.stats.live += 1;
      o.stats.held += 2;
      return 3;
    });
    await executeActions("n1", [notify()], CTX, {});
    expect(prisma.notification.update).toHaveBeenCalledTimes(1);
    const ev = events().find((e) => e.action === "notification.quiet_held")!;
    expect(ev.message).toContain("(sent live to 1 excepted recipient copy)");
    expect(ev.details).toMatchObject({ liveRows: 1, heldRows: 2 });
  });

  it("split hold that reached everyone live is not stamped held, only given its source", async () => {
    h.quietHold.mockResolvedValue(holdOf({ split: true }));
    h.expand.mockImplementation(async (_n: string, _t: unknown, o: any) => {
      o.stats.live += 2;
      return 2;
    });
    await executeActions("n1", [notify()], CTX, {});
    expect(prisma.notification.update).not.toHaveBeenCalled();
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({ where: { id: "n1", quietHeldAt: null }, data: { quietSource: SRC } });
    expect(events().some((e) => e.action === "notification.quiet_held")).toBe(false);
  });

  it("an automation with no notify action is never held or stamped", async () => {
    h.quietHold.mockResolvedValue(holdOf());
    await executeActions("n1", [{ type: "script", scriptId: "s1", runOn: "server" } as AutomationAction], CTX, {});
    expect(h.quietHold).not.toHaveBeenCalled();
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });
});

describe("executeActions — quiet all-clear", () => {
  const RESOLVED = { ...CTX, severity: "resolved", message: "ok" };
  const heldRow = { ruleId: "r1", severity: "warning", testRun: false, quietHeldAt: new Date(), quietSummarizedAt: null, quietSource: SRC };

  it("an all-clear of a held, unsummarised fire nobody was told about is dropped", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue(heldRow);
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([{ transport: "email", target: "a@x.com", status: "held", meta: null }]);
    const res = await executeActions("n1", [notify(), { type: "script", scriptId: "s1", runOn: "server" } as AutomationAction], RESOLVED, { ruleId: "r1", assetId: "a1", ruleName: "CPU" });
    expect(h.expand).not.toHaveBeenCalled();
    expect(h.scriptRun).toHaveBeenCalled(); // not people-facing — runs regardless
    expect(res).toEqual({ executed: 1, failed: 0 });
    expect(events()[0]).toMatchObject({
      action: "notification.quiet_allclear_dropped",
      resourceId: "n1",
      resourceName: "CPU",
      details: { ruleId: "r1", assetId: "a1" },
    });
    expect(h.quietHold).not.toHaveBeenCalled();
  });

  it("once a summary named the alert, its all-clear goes out", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue({ ...heldRow, quietSummarizedAt: new Date() });
    await executeActions("n1", [notify()], RESOLVED, {});
    expect(h.expand).toHaveBeenCalledTimes(1);
    expect("excludeRecipients" in opts()).toBe(false);
  });

  it("an all-clear of a fire that was never held goes out", async () => {
    await executeActions("n1", [notify()], RESOLVED, {});
    expect(h.expand).toHaveBeenCalledTimes(1);
    expect(prisma.notificationDelivery.findMany).not.toHaveBeenCalled();
  });

  it("rule 120: some readers were told live → send, skipping only the held-and-untold", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue(heldRow);
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([
      { transport: "email", target: "Held@x.com, live@x.com", status: "held", meta: { cc: ["cc@x.com"], bcc: [" BCC@x.com "] } },
      { transport: "email", target: "live@x.com", status: "sent", meta: null },
      { transport: "web_push", target: "u", status: "held", meta: { userId: "u1" } },
      { transport: "web_push", target: "u", status: "sent", meta: { userId: "u2" } },
      { transport: "webhook", target: "slack", status: "held", meta: null },
    ]);
    await executeActions("n1", [notify()], RESOLVED, {});
    expect(h.expand).toHaveBeenCalledTimes(1);
    const ex = opts().excludeRecipients;
    expect(Array.from(ex.addresses).sort()).toEqual(["bcc@x.com", "cc@x.com", "held@x.com"]);
    expect(Array.from(ex.userIds)).toEqual(["u1"]);
    expect(ex.chat).toBe(true);
    expect(events().some((e) => e.action === "notification.quiet_allclear_dropped")).toBe(false);
  });

  it("rule 120: a chat send that went live is not excluded", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue(heldRow);
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([
      { transport: "webhook", target: "slack", status: "held", meta: null },
      { transport: "webhook", target: "slack", status: "pending", meta: null },
    ]);
    await executeActions("n1", [notify()], RESOLVED, {});
    expect(opts().excludeRecipients.chat).toBe(false);
  });

  it("the delivery read failing falls back to the whole drop", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue(heldRow);
    stubbed(prisma.notificationDelivery.findMany).mockRejectedValue(new Error("db"));
    await executeActions("n1", [notify()], RESOLVED, {});
    expect(h.expand).not.toHaveBeenCalled();
    expect(events()[0].action).toBe("notification.quiet_allclear_dropped");
  });

  // BUG: heldFireAudience treats every non-held delivery row as "someone was
  // told", including the fire's own api_call row (transport "api_call", which
  // collect() files under `chat`). Scenario: an automation with a notify + an
  // api_call action fires inside a quiet window — the notify rows are written
  // `held`, the api_call row `pending`/`sent`. On the all-clear, live.length is
  // 1 (the webhook call), so the drop is cancelled, told.chat is true, and the
  // held Slack row is NOT excluded: Slack is sent "resolved" for a fire it was
  // never told about, and no notification.quiet_allclear_dropped Event is
  // written. An api_call reaches no reader, so rule 92's drop should stand.
  it.fails("an api_call row is not a reader: the all-clear of an otherwise fully held fire is still dropped", async () => {
    stubbed(prisma.notification.findUnique).mockResolvedValue(heldRow);
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([
      { transport: "email", target: "a@x.com", status: "held", meta: null },
      { transport: "webhook", target: "slack", status: "held", meta: null },
      { transport: "api_call", target: "https://hook.example.com/x", status: "sent", meta: { apiCall: true } },
    ]);
    await executeActions("n1", [notify()], RESOLVED, {});
    expect(h.expand).not.toHaveBeenCalled();
    expect(events().some((e) => e.action === "notification.quiet_allclear_dropped")).toBe(true);
  });
});
