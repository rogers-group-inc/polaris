/**
 * src/services/scriptRunEmailService.ts — business rule 190: a server-run
 * automation script sends email through the Polaris channel its action names.
 *
 * THE PASS
 *  A run whose action carries `email` gets a random pass in its environment
 *  (POLARIS_RUN_TOKEN) the moment it starts. Only its sha256 is stored, on the
 *  run row; it answers only while that run is `running` and inside its own
 *  timeout, and the runner clears it when the run ends. So nothing is stored
 *  on the host, the script body never holds a secret, and a copied pass dies
 *  with its run.
 *
 * WHAT THE SCRIPT MAY SAY, AND WHAT IT MAY NOT
 *  Subject, text and file attachments — never a recipient. The addresses were
 *  snapshot on the run at fire time from the action the operator saved
 *  (AutomationScriptRun.emailTo), so a script cannot turn Polaris's mail relay
 *  on anyone else. At most MAX_EMAILS_PER_RUN sends per run, attachments capped
 *  and executable types refused, a footer naming the script and run on every
 *  message, and an audit Event per attempt.
 *
 * WHO MAY CALL
 *  Only a loopback caller (the script runs on the Polaris host and is handed a
 *  127.0.0.1 URL). The route mounts above requireAuth; the pass is the
 *  authentication, the Bearer header the CSRF exemption.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { sendEmailThroughChannel } from "./notificationDeliveryService.js";
import { derivePolarisPort } from "../utils/publicUrl.js";
import type { FileAttachment } from "./notificationChannels/emailChannel.js";

const RUN_PASS_PREFIX = "prun_";
export const MAX_EMAILS_PER_RUN = 3;
export const MAX_EMAIL_FILES = 5;
export const MAX_EMAIL_FILES_BYTES = 512 * 1024;
export const MAX_EMAIL_TEXT_CHARS = 32 * 1024;
/** Slack past the run's own timeout before a pass stops answering. */
export const PASS_GRACE_MS = 30_000;

/** Types a mail gateway would quarantine anyway — refused at the door. */
const REFUSED_EXTENSIONS = new Set([
  "exe", "com", "bat", "cmd", "scr", "pif", "msi", "msp", "dll", "cpl", "jar", "js", "jse",
  "vbs", "vbe", "wsf", "wsh", "hta", "ps1", "psm1", "lnk", "reg", "sh", "iso", "img",
]);

export function hashRunPass(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** The address a server script reaches the Polaris API on: the web process's
 *  own HTTP listener on loopback (it binds 127.0.0.1 behind nginx). */
export function scriptApiUrl(): string {
  return `http://127.0.0.1:${derivePolarisPort()}/api/v1`;
}

/** Issue the run's pass (just before its process starts). Returns the raw value. */
export async function issueRunEmailPass(runId: string): Promise<string> {
  const raw = RUN_PASS_PREFIX + randomBytes(32).toString("base64url");
  await prisma.automationScriptRun.update({
    where: { id: runId },
    data: { emailTokenHash: hashRunPass(raw), emailTokenIssuedAt: new Date() },
  });
  return raw;
}

/**
 * A Scripts-tab test run's email target: the chosen channel, sending ONLY to
 * the signed-in tester's own address — a test reaches nobody else. Throws 400
 * when the caller has no session or no email address, or the channel is not
 * an email channel.
 */
export async function testRunEmailTarget(channelId: string, userId: string | null): Promise<{ channelId: string; addresses: string[] }> {
  if (!userId) throw new AppError(400, "An email test run sends to the signed-in user, so it needs a browser session");
  const [user, channel] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
    prisma.notificationChannel.findUnique({ where: { id: channelId }, select: { type: true, name: true } }),
  ]);
  if (!channel) throw new AppError(400, "That email channel no longer exists");
  if (channel.type !== "smtp" && channel.type !== "oauth_m365") throw new AppError(400, `"${channel.name}" is not an email channel`);
  const email = user?.email?.trim();
  if (!email) throw new AppError(400, "Your account has no email address, so the test has nowhere to send");
  return { channelId, addresses: [email] };
}

export interface RunEmailFileInput {
  filename: string;
  contentType?: string | null;
  contentBase64: string;
}

export interface RunEmailInput {
  subject: string;
  text: string;
  files?: RunEmailFileInput[];
}

/** A filename safe for a mail header and a reader's download folder. Pure. */
export function safeAttachmentName(name: string): string {
  const base = String(name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ]/g, "_").replace(/^[.\s]+/, "").slice(0, 100).trim();
  return cleaned || "attachment";
}

/** Refuse what a gateway would quarantine; null = fine. Pure. */
export function refusedAttachmentReason(filename: string): string | null {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  return REFUSED_EXTENSIONS.has(ext) ? `"${filename}": .${ext} files cannot be sent` : null;
}

/** Decode and vet the attachments. Pure (throws AppError 400). */
export function buildFiles(files: readonly RunEmailFileInput[]): FileAttachment[] {
  if (files.length > MAX_EMAIL_FILES) throw new AppError(400, `at most ${MAX_EMAIL_FILES} attachments per email`);
  let total = 0;
  return files.map((f) => {
    const filename = safeAttachmentName(f.filename);
    const refused = refusedAttachmentReason(filename);
    if (refused) throw new AppError(400, refused);
    if (!/^[A-Za-z0-9+/=_-]*$/.test(f.contentBase64)) throw new AppError(400, `"${filename}": contentBase64 is not base64`);
    const content = Buffer.from(f.contentBase64, "base64");
    total += content.length;
    if (total > MAX_EMAIL_FILES_BYTES) throw new AppError(400, `attachments exceed ${MAX_EMAIL_FILES_BYTES / 1024} KB in total`);
    const ct = String(f.contentType ?? "").trim().toLowerCase();
    return {
      filename,
      contentType: /^[a-z]+\/[a-z0-9.+-]{1,80}$/.test(ct) ? ct : "application/octet-stream",
      content,
    };
  });
}

/**
 * Send one email for the run holding `rawPass`. Throws AppError: 401 for a
 * pass that is unknown, finished or expired (one message for all three — no
 * oracle), 429 past the per-run cap, 409 for a channel that is gone or off,
 * 400 for bad input, 502 when the channel's transport fails.
 */
export async function sendRunEmail(rawPass: string, input: RunEmailInput, now = new Date()): Promise<{ sent: number; remaining: number }> {
  const denied = new AppError(401, "This run's email pass is not valid (the run has ended, timed out, or the pass is wrong)");
  if (!rawPass.startsWith(RUN_PASS_PREFIX)) throw denied;
  const run = await prisma.automationScriptRun.findUnique({
    where: { emailTokenHash: hashRunPass(rawPass) },
    select: {
      id: true, scriptId: true, scriptName: true, ruleId: true, notificationId: true, status: true, timeoutSec: true,
      emailChannelId: true, emailTo: true, emailTokenIssuedAt: true, emailsSent: true,
    },
  });
  if (!run || run.status !== "running" || !run.emailTokenIssuedAt || !run.emailChannelId) throw denied;
  if (now.getTime() > run.emailTokenIssuedAt.getTime() + run.timeoutSec * 1000 + PASS_GRACE_MS) throw denied;
  if (run.emailTo.length === 0) throw new AppError(409, "This run has no recipients to email");

  const subject = input.subject.replace(/[\r\n]+/g, " ").trim();
  if (!subject) throw new AppError(400, "subject is required");
  const files = buildFiles(input.files ?? []);

  // Count the attempt atomically — two concurrent sends cannot both take the last slot.
  const claimed = await prisma.automationScriptRun.updateMany({
    where: { id: run.id, status: "running", emailsSent: { lt: MAX_EMAILS_PER_RUN } },
    data: { emailsSent: { increment: 1 } },
  });
  if (claimed.count === 0) throw new AppError(429, `A run may send at most ${MAX_EMAILS_PER_RUN} emails`);

  const channel = await prisma.notificationChannel.findUnique({ where: { id: run.emailChannelId } });
  if (!channel) throw new AppError(409, "The email channel this automation names no longer exists");
  if (!channel.enabled) throw new AppError(409, `The email channel "${channel.name}" is disabled`);

  const text = `${input.text.slice(0, MAX_EMAIL_TEXT_CHARS)}\n\n--\nSent by the Polaris automation script "${run.scriptName}" (run ${run.id}).\n`;
  const details = {
    runId: run.id, scriptId: run.scriptId, ruleId: run.ruleId, notificationId: run.notificationId,
    channelId: channel.id, channelName: channel.name, to: run.emailTo, subject,
    files: files.map((f) => ({ filename: f.filename, bytes: f.content.length })),
  };
  try {
    await sendEmailThroughChannel(
      { type: channel.type, config: channel.config as Record<string, unknown> },
      { to: run.emailTo, subject, text, files },
    );
  } catch (err) {
    const reason = (err as Error).message?.slice(0, 500) || "send failed";
    await logEvent({
      action: "automation.script.email_failed",
      resourceType: "automation-script", resourceId: run.scriptId ?? undefined, resourceName: run.scriptName,
      actor: "system:automation", level: "warning",
      message: `Automation script "${run.scriptName}" could not send "${subject}" through "${channel.name}": ${reason}`,
      details: { ...details, error: reason },
    }).catch(() => {});
    throw new AppError(502, `The email channel "${channel.name}" could not send: ${reason}`);
  }
  await logEvent({
    action: "automation.script.email_sent",
    resourceType: "automation-script", resourceId: run.scriptId ?? undefined, resourceName: run.scriptName,
    actor: "system:automation", level: "info",
    message: `Automation script "${run.scriptName}" emailed "${subject}" to ${run.emailTo.length} recipient${run.emailTo.length === 1 ? "" : "s"} through "${channel.name}"`,
    details,
  }).catch(() => {});
  const sent = run.emailsSent + 1;
  return { sent: run.emailTo.length, remaining: Math.max(0, MAX_EMAILS_PER_RUN - sent) };
}
