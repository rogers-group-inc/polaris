/**
 * src/services/alertPushRecipientsService.ts — who else already knows.
 *
 * An alert that routes to both email and web push reaches two audiences that
 * cannot see each other. The person reading the email has no way of telling
 * whether the on-call phone buzzed thirty seconds ago or whether they are the
 * only one who has heard about this, and that question decides whether they
 * pick the device up or leave it to whoever is already on it. This puts the
 * answer in the email's footer: the accounts this alert was pushed to, and
 * — since the same question has a second half — the people it was mailed to.
 *
 * A composed send no longer splits at all (business rule 25 — one message, one
 * To line, whatever the reader's zone or role), so the To header now IS the
 * audience of that copy. The line still earns its place, because a SEND is
 * wider than any one copy of it: a fire with two notify actions mails two
 * lists, a Cc rider is a reader the To line does not name, and the push half
 * names people the email never reached at all. What it no longer claims is
 * the part that was being misread — recipients of a DIFFERENT message about
 * the same alert.
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
 * Scope is the SEND, not the alert (changed 2026-09-16; business rule 60).
 * Both lines name the audience of ONE fan-out — one `executeActions` call,
 * identified by the `meta.dispatch` stamp `expandDeliveries` writes — so an
 * alert's four kinds of message each footnote themselves: the fire names the
 * fire's recipients, a reminder names that reminder's, an escalation tier
 * names the tier's.
 *
 * It was alert-scoped until an operator read a reminder whose footer said
 * "Email sent to <the escalation manager>" and concluded their reminders were
 * going over their head. They were not — the manager was on the T+30 tier and
 * on no reminder at all — but the footer of a message cannot describe an
 * audience that message does not have, however carefully the header comment
 * says otherwise. "Who else knows about this alert" was the honest question;
 * it was not the question a line at the bottom of one email gets read as.
 *
 * The FAN-OUT is the grain, not the delivery row, and that is what keeps the
 * feature alive: an automation that mails the NOC and pushes the on-call does
 * both in one fire, so the NOC's copy still says the phone buzzed. Scoped any
 * tighter, the cross-transport line this service exists for would never render
 * again.
 *
 * A row carrying no `dispatch` stamp — one queued before this shipped and
 * still draining — falls back to the old alert-wide read rather than losing
 * its footer.
 *
 * The PUSH list names accounts, not addresses — a push endpoint has no address
 * behind it, and an email recipient may be an address-book contact with no
 * Polaris account at all.
 *
 * The EMAIL list is addresses by nature, so it names the account where one
 * owns the address and prints the address itself otherwise. It never names a
 * Bcc: a blind copy that appears in a footer everyone can read has stopped
 * being blind, and this footnote is not worth that (business rule 60 — and
 * note the invariant lives in `expandDeliveries`, which is what guarantees
 * `target` is the To line, not in the parsing here).
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { escapeHtml } from "../utils/notificationTemplate.js";

/** The push-recipient tokens, resolved at delivery like `{chart.*}`. */
export const PUSH_RECIPIENT_TOKENS = ["push.recipients"] as const;
export type PushRecipientToken = (typeof PUSH_RECIPIENT_TOKENS)[number];

/**
 * The email-recipient token — the same question as `{push.recipients}`, asked
 * about the other transport, and deferred for the same reason: the email rows
 * it counts are created by `expandDeliveries` after the body was composed.
 *
 * Deferred separately rather than folded into `{push.recipients}` because an
 * operator template may want one and not the other, and because a send that
 * reaches nobody by push must still be able to name who it reached by mail.
 */
export const EMAIL_RECIPIENT_TOKENS = ["email.recipients"] as const;
export type EmailRecipientToken = (typeof EMAIL_RECIPIENT_TOKENS)[number];

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

/** Do any of these templates reference an `{email.recipients}` token? */
export function emailRecipientTokensIn(...templates: Array<string | null | undefined>): Set<EmailRecipientToken> {
  const found = new Set<EmailRecipientToken>();
  for (const t of templates) {
    if (!t) continue;
    for (const token of EMAIL_RECIPIENT_TOKENS) {
      if (t.includes(`{${token}}`)) found.add(token);
    }
  }
  return found;
}

const EMAIL_RECIPIENT_TOKEN_RE = /\{email\.recipients\}/g;

/** The `substitutePushRecipientTokens` sibling, same empty-block contract. */
export function substituteEmailRecipientTokens(body: string, block: string): string {
  if (!body) return body;
  return body.replace(EMAIL_RECIPIENT_TOKEN_RE, block);
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

/**
 * The email half of the same footnote. Pure, for the same reason its push
 * sibling is.
 *
 * Wording is deliberately parallel ("Email sent to …" beside "Web push sent to
 * …") so the two lines read as one audience list rather than as two unrelated
 * footnotes, and it carries no colon for the same `pruneEmptyTextLines` reason.
 *
 * `names` here may be an account name OR a bare address — unlike push, where a
 * recipient is always an account. That asymmetry is the honest one: an
 * address-book contact or a typed address has no account to name, and the
 * address is the only identity the alert ever had for them.
 */
export function renderEmailRecipients(names: string[], opts: { html: boolean }): string {
  if (names.length === 0) return "";
  const named = names.slice(0, MAX_NAMED_RECIPIENTS);
  const overflow = names.length - named.length;
  const list = named.join(", ") + (overflow > 0 ? `, and ${overflow} more` : "");
  const line = `Email sent to ${list}`;
  return opts.html
    ? `<div style="margin-bottom:2px">${escapeHtml(line)}</div>`
    : line;
}

/**
 * The To addresses on one delivery row.
 *
 * Both email paths put To — and only To — in `target`: the composed path joins
 * the whole To line into one row (`to.join(", ")`), the plain per-address
 * path writes one address. So parsing `target` can never leak a Bcc, which is
 * the one thing this footer must not do: naming a blind recipient to the To
 * line would unblind them, and a footnote about who else knows is not worth
 * breaking that promise for. Business rule 60 — the guarantee is upstream, so
 * a change to what `expandDeliveries` writes into `target` breaks this with
 * nothing failing near it.
 */
export function toAddressesOf(target: string | null | undefined): string[] {
  return String(target ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.includes("@"));
}

/**
 * The Cc addresses a composed row carries. Included because a Cc reader is a
 * reader — they can act on the alert, and "who else knows" is exactly the
 * question — and because Cc is already visible to everyone on that copy. Bcc
 * is read by nothing here, deliberately; see `toAddressesOf`.
 */
export function ccAddressesOf(meta: unknown): string[] {
  if (!meta || typeof meta !== "object") return [];
  const cc = (meta as { cc?: unknown }).cc;
  if (!Array.isArray(cc)) return [];
  return cc.filter((a): a is string => typeof a === "string" && a.includes("@")).map((a) => a.trim());
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

/** One delivery row, as much of it as either half of the footer reads. */
interface RecipientRow {
  transport: string;
  target: string;
  meta: unknown;
}

/**
 * The whole delivery-time step: who else this SEND reached, as both rendered
 * bodies, for BOTH transports.
 *
 * One read of the send's delivery rows (indexed on notificationId, narrowed by
 * the `meta.dispatch` stamp) feeds both halves, because a rule that both mails
 * and pushes would otherwise ask the same indexed question twice per drained
 * email.
 *
 * `dispatchId` is the fan-out the calling row belongs to, read off its own
 * `meta.dispatch`. Omitted — a row queued before the stamp existed and still
 * draining — the read widens to the whole alert, which is exactly what this
 * function used to do unconditionally. Degrading that way rather than to an
 * empty footer is the same posture the `meta.userId` stamp takes below: a
 * slightly-too-wide answer beats no answer while old rows drain out.
 *
 * Never throws. A footer is not worth failing an alert over — and it fails as
 * a PAIR, because a half-built footer that named the push audience and silently
 * dropped the email one would read as "nobody else was mailed", which is a
 * worse answer than saying nothing.
 */
export async function buildRecipientBlocks(
  notificationId: string,
  dispatchId?: string | null,
): Promise<{ push: PushRecipientBlock; email: PushRecipientBlock }> {
  try {
    const rows = await prisma.notificationDelivery.findMany({
      where: {
        notificationId,
        transport: { in: ["web_push", "email"] },
        // Narrowed in the DATABASE, not after the read: a weekend-long outage
        // reminding every five minutes leaves hundreds of rows on one alert,
        // and pulling all of them back to keep one send's worth is the shape
        // of query the scale-check convention exists to catch.
        ...(dispatchId ? { meta: { path: ["dispatch"], equals: dispatchId } } : {}),
      },
      select: { transport: true, target: true, meta: true },
    });
    if (rows.length === 0) return { push: EMPTY, email: EMPTY };
    const [push, email] = await Promise.all([
      buildPushBlock(rows.filter((r) => r.transport === "web_push")),
      buildEmailBlock(rows.filter((r) => r.transport === "email")),
    ]);
    return { push, email };
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message, notificationId },
      "alertPushRecipients: could not resolve the alert's recipients, sending without the footer lines",
    );
    return { push: EMPTY, email: EMPTY };
  }
}

/**
 * Which accounts this alert was pushed to.
 *
 * One further read at most, and only for rows old enough to predate the
 * `meta.userId` stamp. Rows are deduped by USER — an operator with a laptop, a
 * desktop and a phone is one name, not three.
 */
async function buildPushBlock(rows: RecipientRow[]): Promise<PushRecipientBlock> {
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
}

/**
 * Who this alert was mailed to.
 *
 * Deduped by ADDRESS, not by account: the delivery rows are addresses, one
 * account may hold only one, and a contact holds no account at all. An address
 * that matches an account prints as that account's name so the line reads the
 * way the push line does; everything else prints as itself, which is the only
 * identity the alert ever had for a typed address or an address-book contact.
 *
 * The account lookup asks for the addresses as written AND lower-cased, rather
 * than reading the whole user table: `User.email` has no citext on it, so an
 * account stored with different capitalisation than the delivery row would
 * otherwise miss and print as a bare address. Two spellings cover every case
 * that occurs — an address that matches neither was not going to match a third.
 */
async function buildEmailBlock(rows: RecipientRow[]): Promise<PushRecipientBlock> {
  if (rows.length === 0) return EMPTY;

  // lower(address) → the address as the delivery row spelled it.
  const byLower = new Map<string, string>();
  for (const r of rows) {
    for (const a of [...toAddressesOf(r.target), ...ccAddressesOf(r.meta)]) {
      const k = a.toLowerCase();
      if (!byLower.has(k)) byLower.set(k, a);
    }
  }
  if (byLower.size === 0) return EMPTY;

  const spellings = new Set<string>();
  for (const [lower, written] of byLower) {
    spellings.add(written);
    spellings.add(lower);
  }
  const accounts = await prisma.user.findMany({
    where: { email: { in: Array.from(spellings) } },
    select: { email: true, displayName: true, username: true },
  });
  const nameByLower = new Map<string, string>();
  for (const a of accounts) {
    if (a.email) nameByLower.set(a.email.trim().toLowerCase(), recipientName(a));
  }

  // Alphabetical, for the reason the push half is: row order is an artifact of
  // which action fanned out first, so the same audience would read differently
  // on every alert.
  const names = Array.from(byLower.entries())
    .map(([lower, written]) => nameByLower.get(lower) ?? written)
    .sort((a, b) => a.localeCompare(b));
  if (names.length === 0) return EMPTY;

  return {
    html: renderEmailRecipients(names, { html: true }),
    text: renderEmailRecipients(names, { html: false }),
  };
}
