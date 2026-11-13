/**
 * tests/unit/quietTimeSummaryService.test.ts — quietTimeSummaryService's own
 * suite (CQ-T010).
 *
 * Complements, rather than repeats:
 *   - quietTimeSummary.test.ts — the big in-memory walkthrough of rule 92:
 *     summaryDue, buildSummaryDetails, recipientsFromHeldRows,
 *     detailsForRecipient, the create → drain → resend journey, the all-quiet
 *     email, the live rows of rule 92(f), per-reader filtering;
 *   - quietTimeRecipientExceptions.test.ts — releaseHeldFollowUps' newest-copy
 *     release and cleared / acknowledged supersede (rule 120);
 *   - the firmware / reboot suites, which only MOCK resolveSummaryChannel.
 *
 * What this adds, on the shared db stub with fixed instants: resolveSummaryChannel's
 * own fallback order (preferred → held rows' channels → the first enabled email
 * channel; a disabled or chat channel is skipped); createDueSummaries' two
 * edges — a held alert whose quiet-source stamp cannot be read is marked
 * summarised on its own rather than owing a summary forever, and a hold
 * stamped after `now` is left for the next summary — plus the
 * push-only-reader-without-an-address warning; drainPendingSummaries' missing
 * channel (every pending reader fails for good at once), the status roll-up
 * (sent / partial / partial-failed), the error clip and the per-reader zone;
 * resendSummary's four refusals; renderSentSummaryEmail's 404s, its zone
 * fallback and the inline logo turned into a data URI; releaseHeldFollowUps
 * with an unreadable or still-future window end; and a failing release not
 * stopping the tick.
 *
 * Nothing is sent: sendEmailThroughChannel is a spy. Instants are built with
 * the local-time constructor on a non-DST date (2026-10-03), as the walkthrough
 * suite does; no TZ is pinned.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const h = vi.hoisted(() => ({
  sendEmailThroughChannel: vi.fn(),
  applyBrandLetterhead: vi.fn(),
  quietSourceConfig: vi.fn(),
  serverTimeZone: vi.fn(() => "UTC"),
}));

vi.mock("../../src/services/notificationDeliveryService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendEmailThroughChannel: h.sendEmailThroughChannel,
  applyBrandLetterhead: h.applyBrandLetterhead,
}));
vi.mock("../../src/services/quietTimeHoldService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  quietSourceConfig: h.quietSourceConfig,
}));
vi.mock("../../src/services/userTimezoneService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  serverTimeZone: h.serverTimeZone,
}));
vi.mock("../../src/services/notificationEngine.js", () => ({ loadScopeRegionSnapshots: vi.fn(async () => []) }));

import {
  resolveSummaryChannel,
  createDueSummaries,
  drainPendingSummaries,
  resendSummary,
  renderSentSummaryEmail,
  releaseHeldFollowUps,
  runQuietTimeSummaries,
  SUMMARY_MAX_ATTEMPTS,
} from "../../src/services/quietTimeSummaryService.js";
import { quietTimeConfigSchema } from "../../src/utils/quietTime.js";

const at = (y: number, m: number, d: number, hh = 0, mm = 0) => new Date(y, m - 1, d, hh, mm, 0, 0);
const NIGHTLY = { version: 1, kind: "recurring", freq: "daily", hours: [{ startTime: "22:00", endTime: "06:00" }] };
const HELD_AT = at(2026, 10, 3, 2, 0);
const MORNING = at(2026, 10, 3, 7, 0);

const SMTP = { id: "c-mail", type: "smtp", enabled: true, config: { host: "mx" } };

const summaryRow = (over: Record<string, unknown> = {}) => ({
  id: "q1", sourceKind: "global", sourceId: "g1", sourceName: "Nights",
  coveredFrom: HELD_AT, coveredTo: at(2026, 10, 3, 6, 0),
  details: { outstanding: [], recurring: [], recurrenceThreshold: null, allQuiet: true, heldCount: 0 },
  recipients: [], channelId: "c-mail", createdAt: MORNING, sentAt: null,
  ...over,
});

const recipient = (address: string, over: Record<string, unknown> = {}) => ({ address, status: "pending", attempts: 0, ...over });

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  for (const f of [h.sendEmailThroughChannel, h.applyBrandLetterhead, h.quietSourceConfig]) f.mockReset();
  h.sendEmailThroughChannel.mockResolvedValue(undefined);
  h.applyBrandLetterhead.mockImplementation(async (msg: unknown) => msg);
  h.quietSourceConfig.mockResolvedValue(null);
  h.serverTimeZone.mockReset();
  h.serverTimeZone.mockReturnValue("UTC");
  stubbed(prisma.notification.findMany).mockResolvedValue([]);
  stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([]);
  stubbed(prisma.notificationChannel.findMany).mockResolvedValue([]);
  stubbed(prisma.quietTimeSchedule.findMany).mockResolvedValue([]);
  stubbed(prisma.notificationRule.findMany).mockResolvedValue([]);
  stubbed(prisma.quietTimeSummary.findMany).mockResolvedValue([]);
  stubbed(prisma.quietTimeSummary.update).mockResolvedValue({});
  stubbed(prisma.quietTimeSummary.create).mockResolvedValue({ id: "new" });
  stubbed(prisma.user.findMany).mockResolvedValue([]);
});

// ─── resolveSummaryChannel ──────────────────────────────────────────────────

describe("resolveSummaryChannel", () => {
  it("takes the policy's own channel first", async () => {
    stubbed(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      { id: "held", type: "smtp", enabled: true, config: {} },
      { id: "pref", type: "oauth_m365", enabled: true, config: {} },
    ]);
    expect((await resolveSummaryChannel("pref", ["held"]))?.id).toBe("pref");
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledTimes(1);
  });

  it("skips a disabled or non-email preferred channel for the held rows' first email channel", async () => {
    stubbed(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      { id: "pref", type: "smtp", enabled: false, config: {} },
      { id: "chat", type: "slack", enabled: true, config: {} },
      { id: "held", type: "smtp", enabled: true, config: {} },
    ]);
    expect((await resolveSummaryChannel("pref", ["chat", null, "held", "held"]))?.id).toBe("held");
    expect(stubbed(prisma.notificationChannel.findMany).mock.calls[0][0].where.id.in).toEqual(["pref", "chat", "held"]);
  });

  it("falls back to the oldest enabled email channel, and to null with none", async () => {
    stubbed(prisma.notificationChannel.findMany).mockResolvedValueOnce([SMTP]);
    expect((await resolveSummaryChannel(null, [null]))?.id).toBe("c-mail");
    // No candidates at all: only the fallback query ran.
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.notificationChannel.findMany).mock.calls[0][0]).toMatchObject({
      where: { enabled: true, type: { in: ["smtp", "oauth_m365"] } }, orderBy: { createdAt: "asc" }, take: 1,
    });
    expect(await resolveSummaryChannel(undefined, [])).toBeNull();
  });
});

// ─── createDueSummaries edges ───────────────────────────────────────────────

const held = (over: Record<string, unknown> = {}) => ({
  id: "n1", ruleId: "r1", assetId: "a1", assetHostname: "SW-1", severity: "warning", message: "Port down",
  dimension: "port1", metric: "ifOperStatus", triggeredAt: HELD_AT, cleared: false, quietHeldAt: HELD_AT,
  quietSource: { kind: "global", id: "g1", name: "Nights" }, rule: { name: "Port down" }, ...over,
});

describe("createDueSummaries — edges", () => {
  it("marks an alert whose quiet-source stamp cannot be read summarised, on its own", async () => {
    stubbed(prisma.notification.findMany).mockResolvedValueOnce([held({ id: "bad", quietSource: { kind: "nonsense", id: "x" } }), held({ id: "bad2", quietSource: null })]);
    expect(await createDueSummaries(MORNING)).toBe(0);
    expect(stubbed(prisma.notification.update).mock.calls.map((c) => c[0])).toEqual([
      { where: { id: "bad" }, data: { quietSummarizedAt: MORNING } },
      { where: { id: "bad2" }, data: { quietSummarizedAt: MORNING } },
    ]);
    expect(prisma.quietTimeSummary.create).not.toHaveBeenCalled();
  });

  it("leaves a hold stamped after `now` for the next summary", async () => {
    // A deleted source is due at once — but the only hold is in the future.
    stubbed(prisma.notification.findMany).mockResolvedValueOnce([held({ quietHeldAt: at(2026, 10, 3, 7, 5) })]);
    expect(await createDueSummaries(MORNING)).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("warns once about a push-only reader with no address, and writes an EMPTY row when nobody is left", async () => {
    h.quietSourceConfig.mockResolvedValue({ name: "Nights", exists: true, config: quietTimeConfigSchema.parse({ windows: [NIGHTLY] }) });
    stubbed(prisma.notification.findMany).mockImplementation(async (args: { where: Record<string, unknown> }) =>
      ("quietHeldAt" in args.where ? [held()] : []));
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([
      { notificationId: "n1", transport: "web_push", target: "https://push.example/1", meta: { userId: "u1" }, channelId: "c-push" },
    ]);
    stubbed(prisma.notificationChannel.findMany).mockResolvedValue([SMTP]);
    stubbed(prisma.user.findMany).mockResolvedValue([{ id: "u1", email: "  ", username: "bob" }]);

    expect(await createDueSummaries(MORNING)).toBe(1);
    const skipped = eventLog.logEvent.mock.calls.map((c) => c[0]).find((e) => e.action === "quiet_time.summary_recipient_skipped");
    expect(skipped).toMatchObject({ level: "warning", details: { usernames: ["bob"] } });
    const data = stubbed(prisma.quietTimeSummary.create).mock.calls[0][0].data;
    expect(data).toMatchObject({ sourceKind: "global", sourceId: "g1", status: "empty", sentAt: MORNING, recipients: [], listedCount: 1, notificationIds: ["n1"] });
    // Covered whether or not anyone was mailed.
    expect(stubbed(prisma.notification.updateMany).mock.calls[0][0]).toEqual({
      where: { id: { in: ["n1"] }, quietSummarizedAt: null }, data: { quietSummarizedAt: MORNING },
    });
  });
});

// ─── drainPendingSummaries ──────────────────────────────────────────────────

describe("drainPendingSummaries", () => {
  it("fails every pending reader for good at once when the channel is gone or disabled", async () => {
    stubbed(prisma.quietTimeSummary.findMany).mockResolvedValue([
      summaryRow({ recipients: [recipient("a@x.com"), recipient("b@x.com", { status: "sent", attempts: 1 })] }),
    ]);
    stubbed(prisma.notificationChannel.findUnique).mockResolvedValue({ ...SMTP, enabled: false });
    expect(await drainPendingSummaries(MORNING)).toEqual({ sent: 0, failed: 1 });
    expect(h.sendEmailThroughChannel).not.toHaveBeenCalled();
    const upd = stubbed(prisma.quietTimeSummary.update).mock.calls[0][0];
    expect(upd.data.status).toBe("partial-failed");
    expect(upd.data.recipients[0]).toMatchObject({ status: "failed", attempts: SUMMARY_MAX_ATTEMPTS, error: "summary email channel is missing or disabled" });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "quiet_time.summary_failed", level: "warning" });
  });

  it("finalizes a row with nobody left to try without reading its channel", async () => {
    stubbed(prisma.quietTimeSummary.findMany).mockResolvedValue([summaryRow({ recipients: [recipient("a@x.com", { status: "sent", attempts: 1 })] })]);
    await drainPendingSummaries(MORNING);
    expect(prisma.notificationChannel.findUnique).not.toHaveBeenCalled();
    expect(stubbed(prisma.quietTimeSummary.update).mock.calls[0][0].data).toMatchObject({ status: "sent", sentAt: MORNING });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "quiet_time.summary_sent", message: 'Quiet-time summary for "Nights": 1 of 1 recipient(s) emailed' });
  });

  it("sends in each reader's own zone, records it, and keeps a failing reader retrying as partial", async () => {
    stubbed(prisma.quietTimeSummary.findMany).mockResolvedValue([
      summaryRow({ recipients: [recipient("a@x.com", { userId: "u1" }), recipient("b@x.com")] }),
    ]);
    stubbed(prisma.notificationChannel.findUnique).mockResolvedValue(SMTP);
    stubbed(prisma.user.findMany).mockResolvedValue([{ id: "u1", timezone: "Europe/London", detectedTimezone: null }]);
    h.sendEmailThroughChannel.mockImplementation(async (_c: unknown, msg: { to: string[] }) => {
      if (msg.to[0] === "b@x.com") throw new Error("y".repeat(800));
    });

    expect(await drainPendingSummaries(MORNING)).toEqual({ sent: 1, failed: 0 });
    const [channelArg] = h.sendEmailThroughChannel.mock.calls[0];
    expect(channelArg).toEqual({ type: "smtp", config: { host: "mx" } });
    const upd = stubbed(prisma.quietTimeSummary.update).mock.calls[0][0];
    expect(upd.data.status).toBe("partial");
    expect(upd.data).not.toHaveProperty("sentAt");
    const [a, b] = upd.data.recipients;
    expect(a).toMatchObject({ status: "sent", attempts: 1, zone: "Europe/London", sentAt: MORNING.toISOString() });
    expect(b).toMatchObject({ status: "failed", attempts: 1 });
    expect(b.error).toHaveLength(500);
    // Not terminal yet: no Event until the roll-up settles.
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a reader with no account reads in the install's zone", async () => {
    h.serverTimeZone.mockReturnValue("America/Chicago");
    stubbed(prisma.quietTimeSummary.findMany).mockResolvedValue([summaryRow({ recipients: [recipient("c@x.com")] })]);
    stubbed(prisma.notificationChannel.findUnique).mockResolvedValue(SMTP);
    await drainPendingSummaries(MORNING);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(stubbed(prisma.quietTimeSummary.update).mock.calls[0][0].data.recipients[0].zone).toBe("America/Chicago");
  });
});

// ─── resendSummary ──────────────────────────────────────────────────────────

describe("resendSummary", () => {
  it("refuses a missing summary (404), one with no recipients, no channel, or nobody left to reach (400)", async () => {
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValueOnce(null);
    await expect(resendSummary("x")).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValueOnce(summaryRow({ recipients: [] }));
    await expect(resendSummary("q1")).rejects.toMatchObject({ httpStatus: 400, message: "This summary has no recipients to send to" });
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValueOnce(summaryRow({ recipients: [recipient("a@x.com")], channelId: null }));
    await expect(resendSummary("q1")).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining("no email channel") });
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValueOnce(summaryRow({ recipients: [recipient("a@x.com", { status: "sent" })] }));
    await expect(resendSummary("q1")).rejects.toMatchObject({ httpStatus: 400, message: "Every recipient of this summary has already been reached" });
    expect(prisma.quietTimeSummary.update).not.toHaveBeenCalled();
  });

  it("re-queues only the readers it missed, with a fresh budget, audits, then drains", async () => {
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValue(summaryRow({
      recipients: [recipient("a@x.com", { status: "sent", attempts: 1 }), recipient("b@x.com", { status: "failed", attempts: 10, error: "smtp" })],
    }));
    await resendSummary("q1", "dmoore");
    const upd = stubbed(prisma.quietTimeSummary.update).mock.calls[0][0];
    expect(upd).toEqual({
      where: { id: "q1" },
      data: { status: "pending", recipients: [recipient("a@x.com", { status: "sent", attempts: 1 }), recipient("b@x.com")] },
    });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "quiet_time.summary_resent", actor: "dmoore", details: { recipients: 1 } });
    expect(prisma.quietTimeSummary.findMany).toHaveBeenCalledTimes(1);
  });
});

// ─── renderSentSummaryEmail ─────────────────────────────────────────────────

describe("renderSentSummaryEmail", () => {
  it("is a 404 for a missing summary and for an address that was not a recipient", async () => {
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValueOnce(null);
    await expect(renderSentSummaryEmail("x", "a@x.com")).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValueOnce(summaryRow({ recipients: [recipient("a@x.com")] }));
    await expect(renderSentSummaryEmail("q1", "z@x.com")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("matches the address case-blind, takes the zone from the account when none was stored, and inlines the logo", async () => {
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValue(summaryRow({
      recipients: [recipient("a@x.com", { userId: "u1", alertIds: [] })],
    }));
    stubbed(prisma.user.findUnique).mockResolvedValue({ timezone: "Asia/Tokyo", detectedTimezone: null });
    h.applyBrandLetterhead.mockImplementation(async (msg: { html?: string }) => ({
      ...msg, html: `<img src="cid:logo">${msg.html ?? ""}`,
      attachments: [{ cid: "logo", contentType: "image/png", content: Buffer.from("PNG") }],
    }));
    const out = await renderSentSummaryEmail("q1", "  A@X.com ");
    expect(out).toMatchObject({ address: "a@x.com", status: "pending", zone: "Asia/Tokyo", sentAt: null, filtered: true });
    expect(out.html).toContain(`data:image/png;base64,${Buffer.from("PNG").toString("base64")}`);
    expect(out.html).not.toContain("cid:logo");
  });

  it("an address with no account reads in the install's zone, and a sent copy reports when", async () => {
    h.serverTimeZone.mockReturnValue("UTC");
    stubbed(prisma.quietTimeSummary.findUnique).mockResolvedValue(summaryRow({
      recipients: [recipient("a@x.com", { status: "sent", sentAt: "2026-10-03T12:00:00.000Z" })],
    }));
    const out = await renderSentSummaryEmail("q1", "a@x.com");
    expect(out).toMatchObject({ zone: "UTC", sentAt: "2026-10-03T12:00:00.000Z", filtered: false });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

// ─── releaseHeldFollowUps / runQuietTimeSummaries ───────────────────────────

describe("releaseHeldFollowUps — window ends", () => {
  const deferred = (id: string, meta: unknown) => ({
    id, notificationId: "n1", channelId: "c", transport: "email", target: "a@x.com", meta, createdAt: HELD_AT,
    notification: { cleared: false, acknowledged: false },
  });

  it("holds a copy whose window has not ended yet", async () => {
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([deferred("d1", { quietHold: { windowEnd: at(2026, 10, 3, 8, 0).toISOString() } })]);
    expect(await releaseHeldFollowUps(MORNING)).toEqual({ released: 0, superseded: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("releases a copy with no readable window end now rather than holding it forever", async () => {
    stubbed(prisma.notificationDelivery.findMany).mockResolvedValue([deferred("d1", { quietHold: { windowEnd: "not a date" } }), deferred("d2", null)].map((r, i) => ({ ...r, target: `r${i}@x.com` })));
    stubbed(prisma.notificationDelivery.updateMany).mockResolvedValue({ count: 2 });
    expect(await releaseHeldFollowUps(MORNING)).toEqual({ released: 2, superseded: 0 });
    expect(stubbed(prisma.notificationDelivery.updateMany).mock.calls[0][0]).toEqual({
      where: { id: { in: ["d1", "d2"] }, status: "deferred" }, data: { status: "pending" },
    });
  });
});

describe("runQuietTimeSummaries", () => {
  it("a failing release does not stop the tick from creating and sending", async () => {
    stubbed(prisma.notificationDelivery.findMany).mockRejectedValue(new Error("db"));
    expect(await runQuietTimeSummaries(MORNING)).toEqual({ created: 0, sent: 0, failed: 0 });
    expect(prisma.notification.findMany).toHaveBeenCalled();
    expect(prisma.quietTimeSummary.findMany).toHaveBeenCalled();
  });
});
