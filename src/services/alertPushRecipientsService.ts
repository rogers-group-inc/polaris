/**
 * src/services/alertPushRecipientsService.ts — who else already knows.
 *
 * An alert that routes to both email and web push reaches two audiences that
 * cannot see each other. The person reading the email has no way of telling
 * whether the on-call phone buzzed thirty seconds ago or whether they are the
 * only one who has heard about this, and that question decides whether they
 * pick the device up or leave it to whoever is already on it. This puts the
 * answer in the email's footer: the accounts this alert was pushed to.
 *
 * It is a DEFERRED token (`{push.recipients}` — see notificationTemplate's
 * isDeferredToken), filled at delivery like the charts, the LLDP block and the
 * letterhead. Deferral is not an optimization here, it is the only order that
 * works: the body is composed BEFORE the Notification row exists, and the push
 * delivery rows this reads are created after that, by `expandDeliveries`. A
 * context key would render the token to "" before the recipients were known.
 *
 * What it counts is the rows, not their outcome. A web_push delivery row means
 * Polaris addressed that account's browser; whether the push service then
 * accepted it is a different fact, and one the email cannot wait on — the
 * email and the push drain in the same pass, sometimes in the same chunk. A
 * push service's 202 was never proof of delivery either (the same reasoning
 * `preferenceWithholds` uses for reachability), so "sent to" is the honest
 * verb for both.
 *
 * Scope is the ALERT, not the send: a reminder at T+45min lists everyone this
 * alert has been pushed to, including the original fire's recipients, because
 * "who else knows about THIS" does not reset when the reminder does.
 *
 * The list names accounts, not addresses — an email recipient may be an
 * address-book contact with no Polaris account, and mailing them somebody
 * else's endpoint would be worse than telling them nothing.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { escapeHtml } from "../utils/notificationTemplate.js";

/** The push-recipient tokens, resolved at delivery like `{chart.*}`. */
export const PUSH_RECIPIENT_TOKENS = ["push.recipients"] as const;
export type PushRecipientToken = (typeof PUSH_RECIPIENT_TOKENS)[number];

/**
 * How many names print before the line turns into a count.
 *
 * A broadcast push target (`recipientAllUsers`) resolves to every account with
 * an enrolled browser, which on a large install is a roster, not a list — and
 * a footer that runs longer than the alert it footnotes has stopped being a
 * footnote. Past this, the overflow is counted instead of named.
 */
export const MAX_NAMED_RECIPIENTS = 12;

export interface PushRecipientBlock {
  /** The footer line as HTML, or "" when this alert pushed to nobody. */
  html: string;
  /** The plain-text alternative's form of the same line, or "". */
  text: string;
}

const EMPTY: PushRecipientBlock = { html: "", text: "" };

/** Do any of these templates reference a `{push.*}` token? */
export function pushRecipientTokensIn(...templates: Array<string | null | undefined>): Set<PushRecipientToken> {
  const found = new Set<PushRecipientToken>();
  for (const t of templates) {
    if (!t) continue;
    for (const token of PUSH_RECIPIENT_TOKENS) {
      if (t.includes(`{${token}}`)) found.add(token);
    }
  }
  return found;
}

const PUSH_RECIPIENT_TOKEN_RE = /\{push\.recipients\}/g;

/**
 * Fill `{push.recipients}` with the rendered line. An empty block removes the
 * token outright — the same contract the chart, interface and brand tokens
 * use, so an alert that pushed to nobody leaves no empty footer line behind.
 *
 * Nothing to escape here: `renderPushRecipients` has already escaped the names
 * it puts in its HTML form.
 */
export function substitutePushRecipientTokens(body: string, block: string): string {
  if (!body) return body;
  return body.replace(PUSH_RECIPIENT_TOKEN_RE, block);
}

/**
 * The displayable name of one recipient. `displayName` is nullable on every
 * auth provider (a local account created without one, an SSO login whose IdP
 * sent no name claim), and `username` is the identifier the operator reading
 * the footer would recognize from the Users page anyway.
 */
export function recipientName(u: { displayName: string | null; username: string }): string {
  return u.displayName?.trim() || u.username;
}

/**
 * Render the line for one body. Pure — the caller supplies the resolved names,
 * so the wording and the overflow rule are testable without a database.
 *
 * The HTML form is a bare `<div>` with no font declaration of its own: it is
 * emitted INSIDE the default body's footer block, which sets the 11px grey the
 * "Sent by Polaris" line already uses, so the two lines cannot drift apart. An
 * operator template that puts the token somewhere else inherits whatever that
 * context is, which is the right answer for a token they placed themselves.
 *
 * The text form carries NO COLON, deliberately: `pruneEmptyTextLines` deletes
 * any "Label:" line with nothing after it, so a heading like "Web push:" would
 * delete itself on the very alert it is meant to describe.
 */
export function renderPushRecipients(names: string[], opts: { html: boolean }): string {
  if (names.length === 0) return "";
  const named = names.slice(0, MAX_NAMED_RECIPIENTS);
  const overflow = names.length - named.length;
  const list = named.join(", ") + (overflow > 0 ? `, and ${overflow} more` : "");
  const line = `Web push sent to ${list}`;
  return opts.html
    ? `<div style="margin-bottom:2px">${escapeHtml(line)}</div>`
    : line;
}

/** The user ids a web_push delivery row's meta names, if any. */
function userIdFromMeta(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as { userId?: unknown; fallback?: { userId?: unknown } | null };
  if (typeof m.userId === "string" && m.userId) return m.userId;
  // Pre-upgrade rows carry the owner only inside the email-fallback stamp, and
  // only when the action had an email channel to fall back to. Better than
  // nothing while such rows are still draining.
  const f = m.fallback;
  if (f && typeof f === "object" && typeof f.userId === "string" && f.userId) return f.userId;
  return null;
}

/**
 * The whole delivery-time step: which accounts this alert was pushed to, as
 * both rendered bodies.
 *
 * Two reads at most, and the second only for rows old enough to predate the
 * `meta.userId` stamp: the delivery rows of this alert (indexed on
 * notificationId), then the accounts behind them. Rows are deduped by USER —
 * an operator with a laptop, a desktop and a phone is one name, not three.
 *
 * Never throws. A footer is not worth failing an alert over.
 */
export async function buildPushRecipientBlock(notificationId: string): Promise<PushRecipientBlock> {
  try {
    const rows = await prisma.notificationDelivery.findMany({
      where: { notificationId, transport: "web_push" },
      select: { target: true, meta: true },
    });
    if (rows.length === 0) return EMPTY;

    const userIds = new Set<string>();
    const unstamped: string[] = [];
    for (const r of rows) {
      const id = userIdFromMeta(r.meta);
      if (id) userIds.add(id);
      else if (r.target) unstamped.push(r.target);
    }
    if (unstamped.length > 0) {
      // The endpoint is the PushSubscription business key. A row whose
      // subscription has since been pruned (410/404) simply drops out — the
      // account was still pushed, but nothing is left saying whose browser it
      // was, and guessing would be worse than omitting.
      const subs = await prisma.pushSubscription.findMany({
        where: { endpoint: { in: unstamped } },
        select: { userId: true },
      });
      for (const s of subs) userIds.add(s.userId);
    }
    if (userIds.size === 0) return EMPTY;

    const users = await prisma.user.findMany({
      where: { id: { in: Array.from(userIds) } },
      select: { displayName: true, username: true },
    });
    // Alphabetical rather than delivery order: the row order is an artifact of
    // which browser enrolled first, which means the same set of people reads
    // differently on every alert.
    const names = users.map(recipientName).sort((a, b) => a.localeCompare(b));
    if (names.length === 0) return EMPTY;

    return {
      html: renderPushRecipients(names, { html: true }),
      text: renderPushRecipients(names, { html: false }),
    };
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message, notificationId },
      "alertPushRecipients: could not resolve the push recipients, sending without the footer line",
    );
    return EMPTY;
  }
}
