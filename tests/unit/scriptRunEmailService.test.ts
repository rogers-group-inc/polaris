/**
 * tests/unit/scriptRunEmailService.test.ts — business rule 190: a running
 * server script emails through its action's channel with a single-use pass.
 * Pins: the pass answers only for a running run inside its timeout; recipients
 * come from the run row, never the request; the per-run cap is atomic; the
 * attachment vetting; the footer; one audit Event per attempt; the test-run
 * target is the tester alone. Rule 190(a): Cc / Bcc ride along, every ticked
 * channel sends, a partial send succeeds and only an all-fail is a 502.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({ send: vi.fn(async () => undefined) }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/notificationDeliveryService.js", () => ({ sendEmailThroughChannel: mocks.send }));

import {
  sendRunEmail, buildFiles, safeAttachmentName, refusedAttachmentReason, hashRunPass, testRunEmailTarget,
  MAX_EMAILS_PER_RUN, MAX_EMAIL_FILES_BYTES, PASS_GRACE_MS,
} from "../../src/services/scriptRunEmailService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const PASS = "prun_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
const now = new Date("2026-11-16T12:00:00Z");
const run = (extra: Record<string, unknown> = {}) => ({
  id: "run1", scriptId: "s1", scriptName: "cert-mail", ruleId: "r1", notificationId: "n1",
  status: "running", timeoutSec: 30, emailChannelIds: ["ch1"], emailTo: ["certs@example.com"], emailCc: [], emailBcc: [],
  emailTokenIssuedAt: new Date(now.getTime() - 5_000), emailsSent: 0, ...extra,
});
const b64 = (s: string) => Buffer.from(s).toString("base64");

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  mocks.send.mockReset().mockResolvedValue(undefined);
  stubbed(prisma.automationScriptRun.findUnique).mockResolvedValue(run() as never);
  stubbed(prisma.automationScriptRun.updateMany).mockResolvedValue({ count: 1 } as never);
  stubbed(prisma.notificationChannel.findMany).mockResolvedValue([{ id: "ch1", name: "Corp relay", type: "smtp", enabled: true, config: { host: "relay" } }] as never);
});

describe("attachment vetting (pure)", () => {
  it("keeps a filename to a safe last segment", () => {
    expect(safeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(safeAttachmentName("C:\\x\\intranet.pem")).toBe("intranet.pem");
    expect(safeAttachmentName(".hidden\r\nBcc: x")).toBe("hidden__Bcc_ x");
    expect(safeAttachmentName("")).toBe("attachment");
  });
  it("refuses executable types", () => {
    expect(refusedAttachmentReason("run.EXE")).toMatch(/\.exe/);
    expect(refusedAttachmentReason("cert.pem")).toBeNull();
  });
  it("decodes, types and caps the files", () => {
    const [f] = buildFiles([{ filename: "a.pem", contentType: "application/x-pem-file", contentBase64: b64("-----BEGIN") }]);
    expect(f).toMatchObject({ filename: "a.pem", contentType: "application/x-pem-file" });
    expect(f!.content.toString()).toBe("-----BEGIN");
    expect(buildFiles([{ filename: "a.bin", contentType: "text/html; x", contentBase64: "" }])[0]!.contentType).toBe("application/octet-stream");
    expect(() => buildFiles([{ filename: "big.bin", contentBase64: Buffer.alloc(MAX_EMAIL_FILES_BYTES + 1).toString("base64") }])).toThrow(/KB in total/);
    expect(() => buildFiles([{ filename: "x.pem", contentBase64: "not base64!" }])).toThrow(/not base64/);
    expect(() => buildFiles(Array.from({ length: 6 }, () => ({ filename: "a.pem", contentBase64: "" })))).toThrow(/at most 5/);
  });
});

describe("sendRunEmail", () => {
  it("sends to the run's recipients only, with a footer, and audits it", async () => {
    const out = await sendRunEmail(PASS, { subject: "Cert\r\nBcc: evil@x", text: "hello", files: [{ filename: "intranet.pem", contentBase64: b64("PEM") }] }, now);
    expect(stubbed(prisma.automationScriptRun.findUnique).mock.calls[0]![0].where).toEqual({ emailTokenHash: hashRunPass(PASS) });
    const [channel, msg] = mocks.send.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, any>];
    expect(channel).toEqual({ type: "smtp", config: { host: "relay" } });
    expect(msg.to).toEqual(["certs@example.com"]);
    expect(msg.subject).toBe("Cert Bcc: evil@x"); // no header injection
    expect(msg.text).toMatch(/^hello\n\n--\nSent by the Polaris automation script "cert-mail" \(run run1\)/);
    expect(msg.files[0].filename).toBe("intranet.pem");
    expect(msg.cc).toBeUndefined();
    expect(msg.bcc).toBeUndefined();
    expect(out).toEqual({ sent: 1, remaining: MAX_EMAILS_PER_RUN - 1 });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({
      action: "automation.script.email_sent", level: "info",
      details: { runId: "run1", channelId: "ch1", to: ["certs@example.com"], files: [{ filename: "intranet.pem", bytes: 3 }] },
    });
  });

  it("answers 401 for a wrong prefix, an unknown pass, a finished run or an expired pass", async () => {
    await expect(sendRunEmail("polaris_xyz", { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 401 });
    stubbed(prisma.automationScriptRun.findUnique).mockResolvedValueOnce(null as never);
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 401 });
    stubbed(prisma.automationScriptRun.findUnique).mockResolvedValueOnce(run({ status: "succeeded" }) as never);
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 401 });
    const late = new Date(now.getTime() - 30_000 - PASS_GRACE_MS - 1);
    stubbed(prisma.automationScriptRun.findUnique).mockResolvedValueOnce(run({ emailTokenIssuedAt: late }) as never);
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 401 });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses past the per-run cap, counted atomically", async () => {
    stubbed(prisma.automationScriptRun.updateMany).mockResolvedValueOnce({ count: 0 } as never);
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 429 });
    const where = stubbed(prisma.automationScriptRun.updateMany).mock.calls[0]![0].where;
    expect(where).toEqual({ id: "run1", status: "running", emailsSent: { lt: MAX_EMAILS_PER_RUN } });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses a disabled or deleted channel", async () => {
    stubbed(prisma.notificationChannel.findMany).mockResolvedValueOnce([{ id: "ch1", name: "Corp relay", type: "smtp", enabled: false, config: {} }] as never);
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 409 });
    stubbed(prisma.notificationChannel.findMany).mockResolvedValueOnce([] as never);
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("carries the run's Cc and Bcc, and sends one message through every ticked channel (rule 190(a))", async () => {
    stubbed(prisma.automationScriptRun.findUnique).mockResolvedValueOnce(run({
      emailChannelIds: ["ch1", "ch2", "gone"], emailCc: ["audit@example.com"], emailBcc: ["hidden@example.com"],
    }) as never);
    stubbed(prisma.notificationChannel.findMany).mockResolvedValueOnce([
      { id: "ch2", name: "M365", type: "oauth_m365", enabled: true, config: {} },
      { id: "ch1", name: "Corp relay", type: "smtp", enabled: true, config: { host: "relay" } },
    ] as never);
    const out = await sendRunEmail(PASS, { subject: "s", text: "" }, now);
    expect((mocks.send.mock.calls as unknown as Array<[{ type: string }]>).map((c) => c[0].type)).toEqual(["smtp", "oauth_m365"]); // the action's order
    const msg = (mocks.send.mock.calls as unknown as Array<[unknown, Record<string, unknown>]>)[0]![1];
    expect(msg).toMatchObject({ to: ["certs@example.com"], cc: ["audit@example.com"], bcc: ["hidden@example.com"] });
    expect(out.sent).toBe(3);
    expect(eventLog.logEvent.mock.calls.map((c) => c[0].action)).toEqual(["automation.script.email_sent", "automation.script.email_sent"]);
  });

  it("succeeds when one channel of two fails, auditing the failure; 502 only when all fail", async () => {
    stubbed(prisma.automationScriptRun.findUnique).mockResolvedValue(run({ emailChannelIds: ["ch1", "ch2"] }) as never);
    stubbed(prisma.notificationChannel.findMany).mockResolvedValue([
      { id: "ch1", name: "Corp relay", type: "smtp", enabled: true, config: {} },
      { id: "ch2", name: "M365", type: "oauth_m365", enabled: true, config: {} },
    ] as never);
    mocks.send.mockRejectedValueOnce(new Error("relay down"));
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).resolves.toMatchObject({ sent: 1 });
    expect(eventLog.logEvent.mock.calls.map((c) => c[0].action)).toEqual(["automation.script.email_failed", "automation.script.email_sent"]);
    mocks.send.mockRejectedValueOnce(new Error("relay down")).mockRejectedValueOnce(new Error("graph 403"));
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 502, message: expect.stringMatching(/relay down.*graph 403/) });
  });

  it("reports a transport failure as 502 and audits it as a warning", async () => {
    mocks.send.mockRejectedValueOnce(new Error("connection refused"));
    await expect(sendRunEmail(PASS, { subject: "s", text: "" }, now)).rejects.toMatchObject({ httpStatus: 502 });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ action: "automation.script.email_failed", level: "warning" });
  });
});

describe("testRunEmailTarget", () => {
  it("sends a test only to the signed-in tester, through an email channel", async () => {
    stubbed(prisma.user.findUnique).mockResolvedValue({ email: " me@example.com " } as never);
    stubbed(prisma.notificationChannel.findUnique).mockResolvedValue({ type: "oauth_m365", name: "M365" } as never);
    expect(await testRunEmailTarget("ch1", "u1")).toEqual({ channelIds: ["ch1"], to: ["me@example.com"] });
  });
  it("refuses no session, no address, or a non-email channel", async () => {
    await expect(testRunEmailTarget("ch1", null)).rejects.toMatchObject({ httpStatus: 400 });
    stubbed(prisma.user.findUnique).mockResolvedValue({ email: null } as never);
    stubbed(prisma.notificationChannel.findUnique).mockResolvedValue({ type: "smtp", name: "Relay" } as never);
    await expect(testRunEmailTarget("ch1", "u1")).rejects.toThrow(/no email address/);
    stubbed(prisma.user.findUnique).mockResolvedValue({ email: "me@example.com" } as never);
    stubbed(prisma.notificationChannel.findUnique).mockResolvedValue({ type: "slack", name: "Chat" } as never);
    await expect(testRunEmailTarget("ch1", "u1")).rejects.toThrow(/not an email channel/);
  });
});
