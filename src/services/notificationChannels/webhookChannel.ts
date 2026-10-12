/**
 * src/services/notificationChannels/webhookChannel.ts
 *
 * Outbound generic webhook delivery. `kind` shapes the POST body:
 *   - slack   → { text }
 *   - teams   → an Office 365 connector MessageCard
 *   - generic → the full notification JSON
 *
 * SSRF guard: the URL host is checked against netGuard's blocked-range list
 * (loopback / link-local / metadata) before any request. Throws on a non-2xx
 * response so the delivery job records `failed` + retries.
 */

import { AppError } from "../../utils/errors.js";
import { assertOutboundHostAllowed, resolveAllowedHost } from "../../utils/netGuard.js";
import { severityHex } from "../../utils/severityStyle.js";

export type WebhookKind = "generic" | "slack" | "teams";

export interface WebhookPayload {
  title: string;
  message: string;
  severity: string; // info | warning | error
  assetHostname: string | null;
  url: string | null; // deep link to the notification, when POLARIS_PUBLIC_URL is set
  triggeredAt: string;
}

// Severity → colour moved to utils/severityStyle.ts when the alert email and
// the public acknowledge page needed the same map.

/**
 * Slack mrkdwn: `&`, `<` and `>` are the control characters of its markup, and
 * Slack's own formatting rules say to escape exactly those in text you did not
 * write. Without it a hostname or event message containing `<!channel>`,
 * `<@U123>` or `<https://evil|Click here>` becomes a mass mention or a link with
 * a label of the attacker's choosing (scan finding F248; business rule 109).
 * The server-built `<url|View>` link is added AFTER escaping and stays literal.
 */
export function escapeSlackText(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Teams MessageCard `text` and `title` render markdown (and a little HTML), so a
 * device-reported string can inject links, images and emphasis. Backslash-escape
 * the characters that introduce them, and a list or heading marker at the start
 * of a line. Backslash escapes render as the literal character.
 */
export function escapeTeamsText(s: string): string {
  return String(s ?? "")
    .replace(/[\\`*_{}\[\]()#+!|<>~&]/g, (c) => "\\" + c)
    .replace(/^(\s*)(-|\d+\.)(?=\s)/gm, (_m, lead: string, mark: string) => lead + mark.replace(/(-|\.)/, "\\$1"));
}

export function formatBody(kind: WebhookKind, p: WebhookPayload): unknown {
  if (kind === "slack") {
    const link = p.url ? ` <${p.url}|View>` : "";
    return { text: `*${escapeSlackText(p.title)}*\n${escapeSlackText(p.message)}${link}` };
  }
  if (kind === "teams") {
    return {
      "@type": "MessageCard",
      "@context": "https://schema.org/extensions",
      themeColor: severityHex(p.severity),
      summary: p.title,
      title: escapeTeamsText(p.title),
      text: escapeTeamsText(p.message),
      potentialAction: p.url
        ? [{ "@type": "OpenUri", name: "View in Polaris", targets: [{ os: "default", uri: p.url }] }]
        : undefined,
    };
  }
  // generic
  return {
    source: "polaris",
    title: p.title,
    message: p.message,
    severity: p.severity,
    asset: p.assetHostname,
    url: p.url,
    triggeredAt: p.triggeredAt,
  };
}

export async function sendWebhook(rawUrl: string, kind: WebhookKind, payload: WebhookPayload): Promise<void> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    throw new AppError(400, `Invalid webhook URL: ${rawUrl}`);
  }
  assertOutboundHostAllowed(host); // throws BLOCKED_HOST for internal/metadata ranges
  await resolveAllowedHost(host); // ...and for a name that resolves into one (rule 110)

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(rawUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(formatBody(kind, payload)),
      // A redirect would carry the POST to a host the guard never saw.
      redirect: "manual",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new AppError(502, `Webhook POST failed: HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
