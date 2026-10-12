/**
 * src/services/notificationChannels/emailChannel.ts
 *
 * Outbound email senders, parameterized by an explicit channel config (the
 * NotificationChannel registry passes the resolved config in — no global
 * Setting reads). Two transports behind the `email` family:
 *   - SMTP via nodemailer (smtp channel type)
 *   - Microsoft 365 / Graph sendMail via OAuth client-credentials (oauth_m365;
 *     needs the Mail.Send application permission)
 *
 * Throws on failure so the delivery drain records `failed` + retries.
 */

import net from "node:net";
import nodemailer from "nodemailer";
import { AppError } from "../../utils/errors.js";
import { resolveAllowedHost } from "../../utils/netGuard.js";

/**
 * An image referenced from the HTML body as `cid:<cid>` — the last-hour charts
 * in an alert email. Inline attachment rather than a hosted URL because a
 * hosted image would need an unauthenticated endpoint, and rather than a
 * data: URI because Gmail and Outlook both drop those.
 */
export interface InlineAttachment {
  cid: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface EmailMessage {
  /** Single address (legacy per-address fan-out) or full To list (composed sends). */
  to: string | string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: InlineAttachment[];
}

export interface SmtpConfig {
  host: string;
  port: number;
  security: "none" | "starttls" | "ssl";
  username: string;
  password: string;
  from: string;
}

export interface M365Config {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  fromUserId: string;
}

export async function sendSmtpEmail(cfg: SmtpConfig, msg: EmailMessage): Promise<void> {
  if (!cfg.host) throw new AppError(400, "SMTP channel is missing a host");
  // Link-local / metadata / multicast are never a mail relay (rule 110). Loopback IS
  // allowed: a postfix or exim relay on the Polaris host is an ordinary setup.
  const allowLoopback = { allowLoopback: true };
  const pinned = await resolveAllowedHost(cfg.host, allowLoopback).catch((err: any) => {
    if (err?.code === "BLOCKED_HOST") throw new AppError(400, err.message);
    throw err;
  });
  const namedHost = !net.isIP(cfg.host.replace(/^\[|\]$/g, ""));
  const transport = nodemailer.createTransport({
    // Connect to the address that was checked; TLS still verifies the typed name.
    host: namedHost && pinned ? pinned : cfg.host,
    ...(namedHost && pinned ? { tls: { servername: cfg.host } } : {}),
    port: Number(cfg.port) || 587,
    secure: cfg.security === "ssl", // 465 implicit TLS; 587 upgrades via STARTTLS
    requireTLS: cfg.security === "starttls",
    auth: cfg.username ? { user: cfg.username, pass: cfg.password } : undefined,
  });
  try {
    await transport.sendMail({
      from: cfg.from || cfg.username,
      to: msg.to, // nodemailer accepts string | string[]
      cc: msg.cc?.length ? msg.cc : undefined,
      bcc: msg.bcc?.length ? msg.bcc : undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      // `cid` makes nodemailer emit Content-ID + inline disposition, which is
      // what lets the HTML body reference it as src="cid:…".
      attachments: msg.attachments?.length
        ? msg.attachments.map((a) => ({ filename: a.filename, cid: a.cid, contentType: a.contentType, content: a.content }))
        : undefined,
    });
  } catch (err: any) {
    // Surface the real reason (connection refused, auth failed, TLS, timeout)
    // as a 502 with detail instead of letting the raw nodemailer error fall
    // through to the catch-all 500 "Internal server error".
    const detail = String(err?.response || err?.message || err?.code || "unknown error").split(/\r?\n/)[0];
    throw new AppError(502, `SMTP send failed: ${detail}`);
  }
}

// Minimal Graph client-credentials token fetch (self-contained so the channel
// config stays independent of entraIdService's EntraIdConfig type).
async function m365Token(cfg: M365Config): Promise<string> {
  const url = `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    scope: "https://graph.microsoft.com/.default",
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const p = JSON.parse(text);
        msg = String(p.error_description || p.error || msg).split(/\r?\n/)[0];
      } catch { /* ignore */ }
      throw new AppError(502, `Microsoft 365 token request failed: ${msg}`);
    }
    const parsed = JSON.parse(text) as { access_token?: string };
    if (!parsed.access_token) throw new AppError(502, "Microsoft 365 token response missing access_token");
    return parsed.access_token;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build the Graph sendMail `message` object. Graph carries a single body —
 * HTML wins when present (SMTP sends multipart; M365 recipients get HTML
 * only). Pure — exported for unit tests.
 */
export function buildGraphMessage(msg: EmailMessage): Record<string, unknown> {
  const rcpt = (a: string) => ({ emailAddress: { address: a } });
  const toList = Array.isArray(msg.to) ? msg.to : [msg.to];
  return {
    subject: msg.subject,
    body: { contentType: msg.html ? "HTML" : "Text", content: msg.html ?? msg.text },
    toRecipients: toList.map(rcpt),
    ...(msg.cc?.length ? { ccRecipients: msg.cc.map(rcpt) } : {}),
    ...(msg.bcc?.length ? { bccRecipients: msg.bcc.map(rcpt) } : {}),
    // Graph's inline images: isInline + contentId, referenced from the HTML
    // body as cid:<contentId>. Only attached alongside an HTML body — a
    // text-only Graph message would deliver them as visible file attachments.
    ...(msg.attachments?.length && msg.html
      ? {
          attachments: msg.attachments.map((a) => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: a.filename,
            contentType: a.contentType,
            contentBytes: a.content.toString("base64"),
            isInline: true,
            contentId: a.cid,
          })),
        }
      : {}),
  };
}

export async function sendM365Email(cfg: M365Config, msg: EmailMessage): Promise<void> {
  if (!cfg.tenantId || !cfg.clientId || !cfg.fromUserId) throw new AppError(400, "Microsoft 365 channel is missing tenant/client/from");
  const token = await m365Token(cfg);
  const url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cfg.fromUserId)}/sendMail`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: buildGraphMessage(msg),
        saveToSentItems: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = `HTTP ${res.status}`;
      try {
        const p = JSON.parse(text);
        if (p?.error?.message) detail = String(p.error.message).split(/\r?\n/)[0];
      } catch { /* ignore */ }
      throw new AppError(502, `Microsoft 365 sendMail failed: ${detail}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
