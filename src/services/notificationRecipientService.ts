/**
 * src/services/notificationRecipientService.ts
 *
 * Routing layer between a fired notification and the concrete recipients of
 * its outbound delivery. Two responsibilities:
 *
 *   resolveRecipientUsers(tags) — which users a set of recipient tags routes
 *     to. A user matches when their effective region/other tag scope
 *     (union(role, user, group) via regionScopeService) intersects the tags.
 *     Region tags compare on their stripped, lower-cased form so a target tag
 *     "region:Atlanta" matches a user whose regionTags include "Atlanta".
 *
 *   expandDeliveries(notificationId, targets) — turn a rule's `targets[]` into
 *     concrete NotificationDelivery rows (one per channel per recipient),
 *     snapshotting recipients at fire time. The deliverNotifications job drains
 *     them. In-app delivery is NOT represented here — it's the Notification row
 *     itself.
 *
 * Recipients are looked up against a short-TTL in-memory index of all users'
 * tag scopes so a tick that fires many notifications resolves once, not
 * per-notification.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import type { Prisma } from "../generated/prisma/client.js";
import { resolveTagScopesForUser } from "./regionScopeService.js";
import { createTtlCache } from "../utils/ttlCache.js";
import { stripRegionPrefix } from "./notificationService.js";
import {
  deviceRegionsAtLevels,
  regionLevelIndex,
  type RegionLevelIndex,
} from "./regionHierarchyService.js";
import {
  renderNotificationTemplate,
  substituteAckToken,
  ackUrlForEmail,
} from "../utils/notificationTemplate.js";
import { defaultAlertEmailTemplate, pruneDeadLinks, pruneEmptyDivs, pruneEmptyRows, pruneEmptyTextLines } from "../utils/alertEmailTemplate.js";
import {
  normalizePermissions,
  permissionOf,
  rankMeets,
} from "../api/middleware/permissions.js";
import {
  normalizeNotificationPreference,
  preferenceAllowsTransport,
  type NotificationPreference,
} from "./notificationPreferenceService.js";
// Cyclic with userTimezoneService (it imports bumpRecipientIndex from here) —
// the SAME cycle notificationPreferenceService above already forms, and safe
// for the same reason: nothing here is called at module-evaluation time, only
// from inside functions, so both modules finish initializing before either
// reaches across.
import { resolveTimeZone, serverTimeZone } from "./userTimezoneService.js";
import {
  type DeliveryTarget,
  type ChannelType,
  type EmailRecipients,
  type EmailComposition,
  CHANNEL_TYPES,
  CHANNEL_TRANSPORT,
} from "./notificationTypes.js";

/**
 * A pre-rendered outbound email (subject/text/html built by the engine at fire
 * time; escalation renders its own at sweep time). cc/bcc arrive UNresolved —
 * this service resolves them to addresses, since recipients are its job.
 * Presence of a ComposedEmail switches email targets to the one-email-per-
 * target model (single delivery row carrying the full To list + Cc + Bcc).
 */
export interface ComposedEmail {
  subject: string;
  text: string;
  html?: string;
  cc?: EmailRecipients | null;
  bcc?: EmailRecipients | null;
}

/**
 * Render the composed outbound email for a composition config from a built
 * context. Any piece the operator left blank falls back to the shared DEFAULT
 * alert template (alertEmailTemplate.ts) — the same strings the automation
 * wizard prefills into a new Notify action, so what Polaris sends and what the
 * operator can edit are one text. cc/bcc pass through unresolved (resolved at
 * expansion time). Lives here (not the engine) so the action-execution layer
 * can compose without a circular import; the engine re-exports it.
 *
 * Empty rows are pruned AFTER rendering: every {asset.*} token renders "" when
 * the field is unset, so a device with no AP and no model would otherwise mail
 * a table of blank cells.
 */
export function buildComposedEmail(comp: EmailComposition, ctx: Record<string, string>): ComposedEmail {
  const def = defaultAlertEmailTemplate();
  const own = (tpl: string | null | undefined) => !!tpl?.trim();
  // Our own default renders unknown tokens blank; an operator's template keeps
  // them literal, so their typo stays visible instead of vanishing.
  const optsFor = (operatorAuthored: boolean, html?: boolean) =>
    ({ ...(html ? { html: true } : {}), ...(operatorAuthored ? {} : { unknown: "blank" as const }) });

  const subject = renderNotificationTemplate(
    own(comp.subjectTemplate) ? comp.subjectTemplate! : def.subjectTemplate,
    ctx,
    optsFor(own(comp.subjectTemplate)),
  );
  const text = renderNotificationTemplate(
    own(comp.bodyTextTemplate) ? comp.bodyTextTemplate! : def.bodyTextTemplate,
    ctx,
    optsFor(own(comp.bodyTextTemplate)),
  );
  const html = renderNotificationTemplate(
    own(comp.bodyHtmlTemplate) ? comp.bodyHtmlTemplate! : def.bodyHtmlTemplate,
    ctx,
    optsFor(own(comp.bodyHtmlTemplate), true),
  );
  return {
    // A blank token can leave a dangling separator ("host — "); tidy the tail
    // rather than making the subject template conditional.
    subject: subject.replace(/[\s—\-–:|]+$/u, "").trim(),
    text: pruneEmptyTextLines(text),
    // Dead links are pruned again after the per-recipient {ack} fill, since
    // that is when a recipient without a link gets an empty href.
    html: pruneDeadLinks(pruneEmptyDivs(pruneEmptyRows(html))),
    cc: comp.cc ?? undefined,
    bcc: comp.bcc ?? undefined,
  };
}

export interface RecipientUser {
  id: string;
  email: string | null;
  displayName: string | null;
  /**
   * May this account acknowledge an alert (`alerts` >= write)? Decided from
   * the role matrix, away from any request, via the shared rankMeets ladder —
   * never re-derived here. A recipient who cannot acknowledge is mailed the
   * SAME alert with the Acknowledge button omitted, and gets no Acknowledge
   * action on a push (business rule 25). Unknown = true: an account whose role
   * we could not read keeps the button, and the page refuses if it must.
   */
  canAcknowledge: boolean;
  /**
   * How this account wants to be alerted — "email" | "push" | "any". Read on
   * every recipient resolution but consulted ONLY by a notify action that
   * opted in (`respectUserPreference`) inside an action group offering both
   * methods; see business rule 39. Unknown / unset normalizes to "email",
   * which is the pre-feature behaviour for every account.
   */
  notificationPreference: NotificationPreference;
  /**
   * The CONCRETE IANA zone this account should be mailed in — already resolved
   * (explicit choice → last-reported browser zone → server zone), never the
   * literal "auto". Carried alongside the preference, and cached on the same
   * index, because the email path groups a To list by it and rebuilds the body
   * once per group; see the timezone grouping in expandDeliveries.
   */
  timezone: string;
}

interface IndexedUser extends RecipientUser {
  /** Lower-cased, region-prefix-stripped union of effective region+other tags. */
  matchSet: Set<string>;
  /**
   * Effective REGION tags only, lower-cased. Separate from matchSet because
   * that one flattens region ∪ other into one namespace — tolerable for the
   * legacy free-form `recipientTags`, but wrong once an operator explicitly
   * picks a *region*: a user whose unrelated "other" tag happened to read
   * "Atlanta" would receive Atlanta's alerts. recipientRegions /
   * recipientAllRegions match on this; recipientTags keeps matchSet.
   */
  regionSet: Set<string>;
  /** The user's Role id — recipientRoles routes by it. */
  roleId: string;
}

/** Project an indexed user down to the recipient shape callers see. */
function toRecipient(u: IndexedUser): RecipientUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    canAcknowledge: u.canAcknowledge,
    notificationPreference: u.notificationPreference,
    timezone: u.timezone,
  };
}

// ─── User tag index (short-TTL cache) ───────────────────────────────────────
// createTtlCache (2026-08 audit) — the hand-rolled value+timestamp pair it
// replaces had no in-flight coalescing, so a cold cache could stampede one
// findMany per concurrent delivery expansion.
/**
 * The zone lookup a send that CANNOT rebuild its body per zone uses. Every
 * address misses, so splitTimeZoneGroups falls all of them back to the server
 * zone and returns one group — the single row the composed path always
 * produced. Shared and never written, so it costs nothing per send.
 */
const EMPTY_ZONE_MAP: ReadonlyMap<string, string> = new Map<string, string>();

const USER_INDEX_TTL_MS = 30_000;
const _userIndexCache = createTtlCache<IndexedUser[]>({ ttlMs: USER_INDEX_TTL_MS, maxEntries: 1 });

/** Drop the cached user→tags index (call after a user/role/group-mapping write). */
export function bumpRecipientIndex(): void {
  _userIndexCache.invalidate();
}

function normalizeNeedle(tag: string): string {
  return stripRegionPrefix(tag).toLowerCase();
}

function loadUserIndex(): Promise<IndexedUser[]> {
  return _userIndexCache.getOrCompute("", async () => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      displayName: true,
      regionTags: true,
      otherTags: true,
      ssoGroups: true,
      authProvider: true,
      roleId: true,
      notificationPreference: true,
      timezone: true,
      detectedTimezone: true,
      role: { select: { regionTags: true, otherTags: true, permissions: true } },
    },
  });

  const index: IndexedUser[] = [];
  for (const u of users) {
    const scopes = await resolveTagScopesForUser(u);
    const matchSet = new Set<string>();
    const regionSet = new Set<string>();
    for (const t of scopes.regionTags.effective) {
      const n = normalizeNeedle(t);
      matchSet.add(n);
      regionSet.add(n);
    }
    for (const t of scopes.otherTags.effective) matchSet.add(normalizeNeedle(t));
    index.push({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      matchSet,
      regionSet,
      roleId: u.roleId,
      // Unknown role => keep the button. Every real row joins a Role (roleId
      // is required), so this only covers a read that came back without one.
      canAcknowledge: u.role
        ? rankMeets(permissionOf(normalizePermissions(u.role.permissions), "alerts"), "write")
        : true,
      notificationPreference: normalizeNotificationPreference(u.notificationPreference),
      // Resolved to a CONCRETE zone here, not stored as "auto": an email has
      // no browser, so the account's own last-reported browser zone is the
      // best answer available and the server's is the last resort.
      timezone: resolveTimeZone(u.timezone, u.detectedTimezone),
    });
  }
  return index;
  });
}

/**
 * Users whose effective tag scope intersects `recipientTags`. Empty
 * recipientTags routes to NO users (an empty target is explicit, not
 * "everyone" — use explicit addresses for broadcast).
 */
export async function resolveRecipientUsers(recipientTags: string[] | undefined): Promise<RecipientUser[]> {
  if (!recipientTags || recipientTags.length === 0) return [];
  const needles = recipientTags.map(normalizeNeedle).filter(Boolean);
  if (needles.length === 0) return [];
  const index = await loadUserIndex();
  return index
    .filter((u) => needles.some((n) => u.matchSet.has(n)))
    .map(toRecipient);
}

/**
 * Users in the NAMED regions — matched against region tags ONLY, unlike
 * resolveRecipientUsers, which searches the flattened region ∪ other set. Once
 * an operator picks a region by name from the map-region catalogue, matching a
 * same-named "other" tag would deliver to the wrong people.
 *
 * Names are compared bare + lower-cased, so a caller may pass either
 * "Atlanta" (how User.regionTags stores it) or "region:Atlanta" (how ASSET tags
 * store it) — normalizeNeedle strips the prefix either way.
 */
export async function resolveUsersByRegions(regions: string[] | undefined): Promise<RecipientUser[]> {
  if (!regions || regions.length === 0) return [];
  const needles = regions.map(normalizeNeedle).filter(Boolean);
  if (needles.length === 0) return [];
  const index = await loadUserIndex();
  return index
    .filter((u) => needles.some((n) => u.regionSet.has(n)))
    .map(toRecipient);
}

/**
 * Every user carrying at least one region tag ("all user regions"). A user with
 * no region at all is deliberately NOT included — they belong to no region, so
 * a region-wide broadcast doesn't cover them; recipientAllUsers is the control
 * for "literally everyone".
 */
export async function resolveUsersInAnyRegion(): Promise<RecipientUser[]> {
  const index = await loadUserIndex();
  return index
    .filter((u) => u.regionSet.size > 0)
    .map(toRecipient);
}

/**
 * Users holding one of the given ROLES. Matched on role ID, not name: a role
 * can be renamed, and User.roleId / ApiToken / GroupMapping already key on the
 * id — so a rename never silently reroutes an automation's recipients.
 *
 * Resolves to users, so this works on email AND web_push alike, unlike
 * recipientAssetContacts (an address with no account behind it).
 */
export async function resolveUsersByRoles(roleIds: string[] | undefined): Promise<RecipientUser[]> {
  if (!roleIds || roleIds.length === 0) return [];
  const want = new Set(roleIds.filter(Boolean));
  if (want.size === 0) return [];
  const index = await loadUserIndex();
  return index
    .filter((u) => want.has(u.roleId))
    .map(toRecipient);
}

/** Every user account — the explicit broadcast opt-in (recipientAllUsers). */
export async function resolveAllUsers(): Promise<RecipientUser[]> {
  const index = await loadUserIndex();
  return index.map(toRecipient);
}

/** Specific users by id (the rule's "individual user accounts" recipients). */
export async function resolveRecipientUsersByIds(ids: string[] | undefined): Promise<RecipientUser[]> {
  if (!ids || ids.length === 0) return [];
  const want = new Set(ids);
  const index = await loadUserIndex();
  return index.filter((u) => want.has(u.id)).map(toRecipient);
}

/** All users for the rule-builder recipient picker (id + name + email). */
export async function listRecipientUsers(): Promise<{ id: string; username: string; displayName: string | null; email: string | null; pushDevices: number }[]> {
  // `pushDevices` lets the automation builder warn that a selected recipient
  // has no push-enabled device. Push is opt-in PER BROWSER, so picking a user
  // is not the same as being able to reach them — without this the operator
  // configures a push action that silently delivers nothing.
  const [users, grouped] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, username: true, displayName: true, email: true },
      orderBy: { username: "asc" },
    }),
    prisma.pushSubscription.groupBy({ by: ["userId"], _count: { _all: true } }),
  ]);
  const counts = new Map(grouped.map((g) => [g.userId, g._count._all]));
  return users.map((u) => ({ ...u, pushDevices: counts.get(u.id) ?? 0 }));
}

/**
 * Resolve an EmailRecipients config (user ids + custom addresses) to a
 * deduped, lower-cased address list. Shared by the rule-level cc/bcc and the
 * escalation sweep's tier recipients.
 */
export async function resolveEmailRecipients(r: EmailRecipients | null | undefined): Promise<string[]> {
  if (!r) return [];
  const out = new Set<string>();
  for (const a of r.addresses ?? []) if (a.trim()) out.add(a.trim().toLowerCase());
  for (const u of await resolveRecipientUsersByIds(r.recipientUserIds)) {
    if (u.email) out.add(u.email.trim().toLowerCase());
  }
  // Roles are resolvable in Cc/Bcc too — the token fields treat a role pill the
  // same wherever it's dropped, so the wire shape has to as well. Region pills
  // are the same story: a region resolves to users, and users have addresses.
  for (const u of await resolveUsersByRoles(r.recipientRoles)) {
    if (u.email) out.add(u.email.trim().toLowerCase());
  }
  if (r.recipientRegions?.length) {
    for (const u of await resolveUsersByRegions(r.recipientRegions)) {
      if (u.email) out.add(u.email.trim().toLowerCase());
    }
  }
  // Registry tags resolve through the FLATTENED scope, matching what
  // usersForTarget does with the same field on the action — a Cc pill and a To
  // pill for one tag must reach the same people.
  if (r.recipientTags?.length) {
    for (const u of await resolveRecipientUsers(r.recipientTags)) {
      if (u.email) out.add(u.email.trim().toLowerCase());
    }
  }
  return Array.from(out);
}

/**
 * Drop cross-list duplicates from a composed email's recipient lists:
 * To wins over Cc; Bcc drops anything already visible in To or Cc.
 * Case-insensitive. Pure — exported for unit tests.
 */
export function dedupeEmailRecipients(to: string[], cc: string[], bcc: string[]): { cc: string[]; bcc: string[] } {
  const toSet = new Set(to.map((a) => a.toLowerCase()));
  const ccOut = cc.filter((a) => !toSet.has(a.toLowerCase()));
  const visible = new Set([...toSet, ...ccOut.map((a) => a.toLowerCase())]);
  const bccOut = bcc.filter((a) => !visible.has(a.toLowerCase()));
  return { cc: ccOut, bcc: bccOut };
}

/**
 * Expand a fired notification's rule targets into concrete delivery rows. Each
 * target references a configured NotificationChannel by id; the channel's type
 * decides the transport + how the target fans out:
 *   - email (smtp/oauth_m365), no composedEmail: one row per resolved
 *     recipient address (tag-matched users' emails + explicit addresses).
 *   - email WITH composedEmail: ONE row whose `target` is the joined To list.
 *     meta snapshots { composed, to, cc, bcc, subject, text, html? } for the
 *     drain (never channel secrets). Empty To skips the target.
 *   - web_push: one row per recipient user's push subscription (keys snapshotted).
 *   - webhook (slack/teams) / pushbullet: one row; the destination (URL/token)
 *     lives on the channel and is read at send time, NOT duplicated here.
 * Disabled or missing channels are skipped. Best-effort: returns the number of
 * rows created.
 */
/**
 * Merge the three address sources into ONE ordered map of address → the
 * Polaris user who owns it (null for an address nobody signs in with).
 *
 * The map is what dedupes the To line across the three sources; the ownership
 * VALUES are informational since the acknowledge link stopped being
 * per-recipient (business rule 25) — the same URL now goes to everyone and the
 * page behind it decides who may act. They are kept because a user-sourced
 * entry WINS over a typed/contact entry for the same address, and two users
 * sharing an address (User.email is nullable and NOT unique) tie-break on the
 * lowest id, so the resolved To line is stable across sends.
 *
 * Insertion order reproduces the pre-feature Set: typed addresses, then users,
 * then contacts. Re-setting an existing key keeps its original position, so a
 * composed email's To line reads exactly as it did before.
 */
export function buildAddressOwnerMap(
  users: RecipientUser[],
  typed: string[] | undefined,
  contacts: string[] | undefined,
): Map<string, RecipientUser | null> {
  const norm = (a: string) => a.trim().toLowerCase();
  const out = new Map<string, RecipientUser | null>();
  for (const a of typed ?? []) if (a.trim()) out.set(norm(a), null);
  for (const u of users) {
    if (!u.email) continue;
    const key = norm(u.email);
    const held = out.get(key);
    // Lowest id wins so repeated sends pick the same person.
    if (held && held.id <= u.id) continue;
    out.set(key, u);
  }
  for (const a of contacts ?? []) {
    const key = norm(a);
    if (a.trim() && !out.has(key)) out.set(key, null);
  }
  return out;
}

/**
 * Resolve the deferred `{ack}` token in an already-rendered composed body.
 *
 * ONE substitution per notification, not per recipient. The acknowledge URL
 * names the alert and nothing else, so every reader of a shared body gets the
 * same working link — which is why a composed email is a single message again
 * (business rule 25). This used to be `applyAckToRows`, fanning the To line out
 * into one delivery row per person so each could carry a token of their own.
 *
 * Re-prunes after filling: substituting a URL OR blanking it (no
 * POLARIS_PUBLIC_URL) can leave an "Acknowledge:" line, or an href="" button,
 * with nothing behind it.
 *
 * Pure — exported for the tests, because the blank half is the half that breaks
 * quietly: it only runs on installs with no public URL, which are exactly the
 * installs least likely to notice a literal "{ack}" in their mail.
 */
export function fillComposedAckUrl(composed: ComposedEmail, url: string | null): ComposedEmail {
  return {
    ...composed,
    subject: substituteAckToken(composed.subject, url),
    text: pruneEmptyTextLines(substituteAckToken(composed.text, url)),
    ...(composed.html
      ? { html: pruneDeadLinks(pruneEmptyRows(substituteAckToken(composed.html, url, { html: true }))) }
      : {}),
  };
}

/**
 * Address -> may the Polaris account behind it acknowledge an alert?
 *
 * Addresses with no account are ABSENT from the map rather than false: an
 * address-book contact or an operator-typed address belongs to someone Polaris
 * knows nothing about, and business rule 25 keeps their button — the page
 * decides. When two accounts share an address (User.email is nullable and NOT
 * unique), "can" wins: withholding the button from someone who may act is the
 * worse error, since the page refuses the one who may not.
 */
export async function ackCapabilityByAddress(): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const u of await loadUserIndex()) {
    if (!u.email?.trim()) continue;
    const key = u.email.trim().toLowerCase();
    out.set(key, (out.get(key) ?? false) || u.canAcknowledge);
  }
  return out;
}

/**
 * Every signed-in address → the IANA zone that account reads times in.
 *
 * The ackCapabilityByAddress sibling, built off the same cached index and for
 * the same reason: the composed-email path holds ADDRESSES (the To line merges
 * users, typed addresses and address-book contacts) but needs a per-account
 * fact about them. Resolved to a concrete zone here rather than left as
 * "auto" — an email has no browser, so "auto" can only mean the server's zone,
 * and resolving once here keeps that decision out of the grouping loop.
 *
 * An address no account owns is simply absent; the caller falls back to the
 * server zone, which is what a typed address or a contact always got.
 *
 * When two accounts share an address (User.email is nullable and NOT unique)
 * the LOWEST user id wins — the same tie-break buildAddressOwnerMap uses, so
 * the zone a shared address is mailed in is stable across sends instead of
 * flipping with row order.
 */
export async function timeZoneByAddress(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const winner = new Map<string, string>();
  for (const u of await loadUserIndex()) {
    if (!u.email?.trim()) continue;
    const key = u.email.trim().toLowerCase();
    const held = winner.get(key);
    if (held !== undefined && held <= u.id) continue;
    winner.set(key, u.id);
    out.set(key, u.timezone);
  }
  return out;
}

/** One outbound copy of a composed alert email, addressed to one zone's readers. */
export interface TimeZoneGroup {
  /** Concrete IANA zone this copy's times are rendered in. */
  timeZone: string;
  to: string[];
  cc: string[];
  bcc: string[];
}

/**
 * Split a composed email's recipient lists by the zone each address reads in.
 *
 * Composed alerts are ONE message to a shared To line (business rule 25), and
 * that stays true per zone: this splits a send into one copy per DISTINCT zone
 * among its recipients, not one per person. In practice a fleet whose
 * operators all sit in one zone produces exactly one group and the identical
 * single row it always did — the split only costs a message when the readers
 * genuinely disagree about what time it is.
 *
 * It composes with splitAckVariants rather than replacing it: the caller runs
 * this first, then splits each group by acknowledge capability, so the worst
 * case is (distinct zones x 2) rows.
 *
 * Cc and Bcc are grouped on the same key as To — an address is mailed in its
 * OWNER's zone whichever line it sits on — so nobody receives two copies and
 * a Cc'd reader gets the same wall clock they would as a direct recipient.
 * Insertion order follows first appearance across to, then cc, then bcc, so
 * the primary recipients' zone leads.
 *
 * Pure — exported for the tests.
 */
export function splitTimeZoneGroups(
  to: string[],
  cc: string[],
  bcc: string[],
  zoneOf: ReadonlyMap<string, string>,
  fallbackZone: string,
): TimeZoneGroup[] {
  const groups = new Map<string, TimeZoneGroup>();
  const zoneFor = (a: string) => zoneOf.get(a.trim().toLowerCase()) ?? fallbackZone;
  const push = (line: "to" | "cc" | "bcc", a: string) => {
    const tz = zoneFor(a);
    let g = groups.get(tz);
    if (!g) {
      g = { timeZone: tz, to: [], cc: [], bcc: [] };
      groups.set(tz, g);
    }
    g[line].push(a);
  };
  for (const a of to) push("to", a);
  for (const a of cc) push("cc", a);
  for (const a of bcc) push("bcc", a);
  return Array.from(groups.values());
}

/** One outbound variant of a composed alert email. */
export interface AckVariant {
  /** Does this copy carry the Acknowledge button? */
  ack: boolean;
  to: string[];
  cc: string[];
  bcc: string[];
}

/**
 * Split a composed email's recipient lists into the copy that carries the
 * Acknowledge button and the copy that doesn't.
 *
 * A recipient whose Polaris role cannot acknowledge is mailed a button they
 * can only be refused by, so the body goes out twice at most — never once per
 * person (the per-recipient fan-out business rule 25 retired). An address the
 * capability map doesn't know is treated as capable, so contacts and typed
 * addresses keep the button exactly as before, and a message with no
 * read-only recipient on it produces the SAME single row it always did.
 *
 * Two shape rules keep both copies deliverable:
 *   - a variant that lost its whole To line still owes its Cc'd readers a
 *     copy, so Cc is promoted into To (a Cc address is visible to everyone on
 *     the message anyway) rather than dying on the empty-To guard;
 *   - a variant left with only Bcc goes out as one message per address, so the
 *     blind list stays blind.
 *
 * Pure — exported for the tests.
 */
export function splitAckVariants(
  to: string[],
  cc: string[],
  bcc: string[],
  capable: Map<string, boolean>,
): AckVariant[] {
  const canAck = (a: string) => capable.get(a.trim().toLowerCase()) !== false;
  const part = (list: string[], want: boolean) => list.filter((a) => canAck(a) === want);
  const out: AckVariant[] = [];
  for (const ack of [true, false]) {
    let vTo = part(to, ack);
    let vCc = part(cc, ack);
    const vBcc = part(bcc, ack);
    if (vTo.length === 0 && vCc.length === 0 && vBcc.length === 0) continue;
    if (vTo.length === 0) {
      vTo = vCc;
      vCc = [];
    }
    if (vTo.length === 0) {
      for (const b of vBcc) out.push({ ack, to: [b], cc: [], bcc: [] });
      continue;
    }
    out.push({ ack, to: vTo, cc: vCc, bcc: vBcc });
  }
  return out;
}

/**
 * Would honouring this recipient's preference withhold the alert from them
 * ENTIRELY, rather than merely route it?
 *
 * A preference chooses between channels; it never means "don't tell me". So a
 * push-preferring account with no enrolled device still gets the email, and an
 * email-preferring account with no address still gets the push. Without this
 * the two halves cancel out: the preference filter drops them from the channel
 * they didn't pick, and the channel they DID pick has nowhere to send — and
 * nothing anywhere reports a recipient who simply wasn't on the alert.
 *
 * This is the only thing Polaris can honestly check. A subscription EXISTS or
 * it does not; whether the phone is on, online, or looked at is NOT knowable —
 * a 201 from a push service means it accepted the message for later delivery,
 * not that it arrived. A dead endpoint is discovered later still, at send time,
 * when it answers 404/410 and the drain prunes it.
 *
 * Pure — exported for the tests, because the failure mode is silent in exactly
 * the direction that matters.
 */
export function preferenceWithholds(
  pref: unknown,
  transport: string,
  reach: { hasPushDevice: boolean; hasEmail: boolean },
): boolean {
  if (preferenceAllowsTransport(pref, transport)) return false;
  // They refuse THIS transport — honour that only if the one they asked for
  // can actually reach them.
  return transport === "email" ? reach.hasPushDevice : reach.hasEmail;
}

export interface ExpandDeliveriesOptions {
  /** `region:` tags mined from the RULE's scope (recipientScopeRegion routing). */
  scopeRegionTags?: string[];
  /** The TRIGGERING asset's region tags — stripped snapshot (regionSnapshot /
   *  Notification.regionTags) — for recipientDeviceRegion routing. */
  assetRegionTags?: string[];
  /** Addresses of the address-book contacts RESPONSIBLE for the triggering
   *  asset, for recipientAssetContacts routing. Resolved by the CALLER
   *  (automationActionService → contactService.resolveContactEmailsForAsset)
   *  and passed in, exactly like the region tags above — contactService already
   *  imports this module for listRecipientUsers, so resolving it here would
   *  close an import cycle. */
  assetContactEmails?: string[];
  composedEmail?: ComposedEmail;
  /**
   * Rebuild `composedEmail` with its times rendered in `timeZone`.
   *
   * Supplying this opts the send into per-recipient timezones: the To/Cc/Bcc
   * lines are grouped by the zone each address's account reads in, and each
   * group is mailed a body rebuilt through this closure. OMITTING it keeps the
   * pre-column behaviour exactly — one body in the server's zone for everyone —
   * which is what a caller with no (composition, context) pair in hand can
   * honestly offer.
   *
   * A closure rather than a (comp, ctx) pair because the two live in different
   * layers: the action layer merges per-action overrides into the composition
   * before rendering, and this service must not learn that merge.
   *
   * Called at most once per distinct zone per send, and memoized by the caller
   * loop — so the common all-one-zone fleet pays for exactly one rebuild.
   */
  composedEmailForTimeZone?: (timeZone: string) => ComposedEmail;
  /**
   * "Reminders every 15 minutes until acknowledged. Escalates in 30 minutes…"
   * — the follow-up policy as one line, appended to the WEB PUSH body.
   *
   * Stamped onto the delivery row's meta here rather than read from
   * Notification.templateCtx at drain time, because the drain's select is
   * shared by every transport: pulling a JSON blob onto 200 rows every 15
   * seconds to serve one transport is the wrong trade. Email needs nothing —
   * its body is already composed, with these tokens substituted, by the time
   * it reaches this function.
   */
  followUp?: string;
  /** Escalation provenance (tier/attempt) — stamped into every row's meta so
   *  the View tab's "Escalated" marker and audits can attribute the send. */
  escalation?: { tier: number; attempt: number };
  /** Repeat provenance (attempt) — a SEPARATE meta key from `escalation`, so a
   *  reminder is never mistaken for an escalation by anything reading the
   *  delivery history. */
  repeat?: { attempt: number; elapsed?: string; quietResumed?: boolean };
  /**
   * May a target's `respectUserPreference` flag actually filter recipients?
   *
   * Set by the CALLER (automationActionService), because the question it
   * answers — does this action group carry both an email and a push channel? —
   * is about the actions[] list being executed, which no single target can
   * see. Business rule 39: in a single-method group the preference is ignored
   * outright, since honouring it there would delete the alert for anyone who
   * prefers the method on offer instead of routing it.
   *
   * Default false, so a caller that never opts in behaves exactly as it did
   * before the feature even if a stored target carries the flag.
   */
  enforceUserPreference?: boolean;
}

export async function expandDeliveries(
  notificationId: string,
  targets: DeliveryTarget[] | undefined,
  opts: ExpandDeliveriesOptions = {},
): Promise<number> {
  const { scopeRegionTags, assetRegionTags, assetContactEmails, composedEmail, composedEmailForTimeZone, escalation, repeat, enforceUserPreference, followUp } = opts;
  if (!targets || targets.length === 0) return 0;

  // Resolve the referenced channels once (type + enabled).
  const ids = Array.from(new Set(targets.map((t) => t.channelId).filter(Boolean)));
  if (ids.length === 0) return 0;
  const channels = await prisma.notificationChannel.findMany({
    where: { id: { in: ids } },
    select: { id: true, type: true, enabled: true },
  });
  const byId = new Map(channels.map((c) => [c.id, c]));

  const rows: Prisma.NotificationDeliveryCreateManyInput[] = [];
  const seen = new Set<string>(); // dedupe channelId|transport|target within one notification

  const add = (
    channelId: string,
    transport: string,
    target: string,
    meta?: Prisma.InputJsonValue,
  ) => {
    const key = `${channelId}|${transport}|${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Fold in whichever provenance is present, and keep meta strictly
    // undefined when neither is — so every pre-feature path still writes a
    // byte-identical row.
    const provenance = escalation || repeat
      ? ({
          ...(meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}),
          ...(escalation ? { escalation } : {}),
          ...(repeat ? { repeat } : {}),
        } as Prisma.InputJsonValue)
      : meta;
    rows.push({ notificationId, channelId, transport, target, meta: provenance ?? undefined });
  };

  // Recipient users for a target = union of: specific user ids + (if opted in)
  // users in the TRIGGERING asset's region(s) + (if opted in) users in the
  // rule's scope region(s) + legacy tag-routing. Deduped by id.
  // Resolved AT MOST ONCE per notification, and only when an action actually
  // asks for level routing — the same posture as assetContactEmails() in
  // automationActionService. A rule with three notify actions shares one
  // lookup; a rule that never opts in pays nothing.
  let _regionLevels: RegionLevelIndex | null = null;
  const regionLevels = async (): Promise<RegionLevelIndex> => {
    if (!_regionLevels) _regionLevels = await regionLevelIndex();
    return _regionLevels;
  };

  // userId -> how many browsers that account has enrolled. Read ONLY when a
  // preference filter is about to drop someone, so a send that never opts in
  // issues no extra query; memoized per notification like the region index
  // above. Same groupBy listRecipientUsers runs for the builder's "no push
  // device" warning — the two ask the same question at different times, one
  // to warn the author and one to protect the recipient.
  let _pushCounts: Map<string, number> | null = null;
  const pushDeviceCounts = async (): Promise<Map<string, number>> => {
    if (!_pushCounts) {
      const grouped = await prisma.pushSubscription.groupBy({ by: ["userId"], _count: { _all: true } });
      _pushCounts = new Map(grouped.map((g) => [g.userId, g._count._all]));
    }
    return _pushCounts;
  };

  const usersForTarget = async (t: DeliveryTarget, transport: string): Promise<RecipientUser[]> => {
    const map = new Map<string, RecipientUser>();
    const addUsers = (us: RecipientUser[]) => us.forEach((u) => map.set(u.id, u));
    // Drop recipients whose own preference refuses this transport — but ONLY
    // when the action asked for it AND the caller confirmed the action group
    // offers both methods (business rule 39). Applied to USERS alone: a typed
    // address or an address-book contact has no account and therefore no
    // preference, and withholding their copy on a preference they never
    // expressed would be inventing one for them.
    //
    // And never to the point of delivering NOTHING: preferenceWithholds keeps
    // anyone whose preferred channel cannot reach them (no enrolled device, or
    // no address), so the preference routes the alert instead of deleting it.
    const keep = async (us: RecipientUser[]): Promise<RecipientUser[]> => {
      if (!enforceUserPreference || !t.respectUserPreference) return us;
      const refusing = us.filter((u) => !preferenceAllowsTransport(u.notificationPreference, transport));
      if (refusing.length === 0) return us;
      // Only now is the device lookup worth paying for.
      const counts = transport === "email" ? await pushDeviceCounts() : null;
      const drop = new Set(
        refusing
          .filter((u) => preferenceWithholds(u.notificationPreference, transport, {
            hasPushDevice: (counts?.get(u.id) ?? 0) > 0,
            hasEmail: !!u.email?.trim(),
          }))
          .map((u) => u.id),
      );
      return us.filter((u) => !drop.has(u.id));
    };
    // Broadcast modes first — recipientAllUsers subsumes every other source, so
    // resolving it short-circuits the rest rather than unioning redundantly.
    //
    // Both are WEB PUSH modes, and stay so on a multi-channel action: the
    // toggles live in the builder's push block and read as "tell every device",
    // so letting them widen the email half of the same action would mail the
    // whole roster off a control that never said so. Save-time validation
    // already refuses them on a single-channel email action; this keeps the
    // runtime honest for the mixed one it now permits.
    if (transport === "web_push") {
      if (t.recipientAllUsers) return await keep(await resolveAllUsers());
      if (t.recipientAllRegions) addUsers(await resolveUsersInAnyRegion());
    }
    if (t.recipientRegions?.length) addUsers(await resolveUsersByRegions(t.recipientRegions));
    if (t.recipientRoles?.length) addUsers(await resolveUsersByRoles(t.recipientRoles));
    if (t.recipientUserIds?.length) addUsers(await resolveRecipientUsersByIds(t.recipientUserIds));
    if (t.recipientDeviceRegion && assetRegionTags?.length) addUsers(await resolveRecipientUsers(assetRegionTags));
    // Asset-RELATIVE level routing: level 1 = the device's own innermost
    // region, 2 = the division containing it, walked outward along the
    // containment edges (regionHierarchyService). Matches `regionSet`
    // (region tags only) via resolveUsersByRegions rather than the flattened
    // `matchSet` recipientDeviceRegion uses, because these names come from the
    // region catalogue by construction — the same reasoning recipientRegions
    // already carries. The asymmetry with recipientDeviceRegion is deliberate
    // and documented in polaris-change-impact (services/alerting-delivery.md); do NOT "unify" them, that changes who
    // existing rules deliver to.
    if (t.recipientDeviceRegionLevels?.length && assetRegionTags?.length) {
      const names = deviceRegionsAtLevels(assetRegionTags, t.recipientDeviceRegionLevels, await regionLevels());
      if (names.length) addUsers(await resolveUsersByRegions(names));
    }
    if (t.recipientScopeRegion && scopeRegionTags?.length) addUsers(await resolveRecipientUsers(scopeRegionTags));
    // Registry tags. Matches the FLATTENED region-plus-other scope, not
    // regionSet: a tag is a tag whichever dimension a user carries it in, which
    // is exactly the asymmetry with recipientRegions above — that one is a name
    // taken from the region catalogue, so matching a same-named "other" tag
    // would deliver to the wrong people.
    if (t.recipientTags?.length) addUsers(await resolveRecipientUsers(t.recipientTags));
    return await keep(Array.from(map.values()));
  };

  // The email channel a FAILED web push can fall back to.
  //
  // expandDeliveries is called with ONE action's targets (automationActionService
  // passes actionsToTargets([action])), so "an email channel among these targets"
  // is exactly "an email channel on this action" — which is the only fallback
  // that needs no operator decision. A push-ONLY action has nowhere to fall back
  // to and keeps the existing warning; picking some other channel's SMTP config
  // would be Polaris inventing a destination nobody configured for this alert.
  const fallbackChannelId = targets
    .map((t) => byId.get(t.channelId))
    .find((ch) => ch && ch.enabled && isChannelType(ch.type) && CHANNEL_TRANSPORT[ch.type as ChannelType] === "email")?.id
    ?? null;

  // Rule-level Cc/Bcc resolve once per notification, then apply per email target.
  const ccResolved = composedEmail ? await resolveEmailRecipients(composedEmail.cc) : [];
  const bccResolved = composedEmail ? await resolveEmailRecipients(composedEmail.bcc) : [];

  // The acknowledge link is one URL per ALERT, so `{ack}` resolves ONCE here
  // rather than per recipient — the body was rendered before the Notification
  // row existed, so the token is still sitting in it literally. Null on an
  // install with no POLARIS_PUBLIC_URL, where the substitution blanks the
  // button away instead of mailing a link that resolves against nothing.
  const composedBody = composedEmail
    ? fillComposedAckUrl(composedEmail, ackUrlForEmail(notificationId))
    : null;

  // The same body with the button taken out, for recipients whose role can't
  // acknowledge — the identical substitution an install with no
  // POLARIS_PUBLIC_URL already gets. Both this and the capability lookup are
  // lazy: a send with no read-only recipient pays for neither.
  let _composedBodyNoAck: ComposedEmail | null = null;
  const composedBodyNoAck = (): ComposedEmail => {
    if (!_composedBodyNoAck) _composedBodyNoAck = fillComposedAckUrl(composedEmail as ComposedEmail, null);
    return _composedBodyNoAck;
  };
  let _ackCapable: Map<string, boolean> | null = null;
  const ackCapable = async (): Promise<Map<string, boolean>> => {
    if (!_ackCapable) _ackCapable = await ackCapabilityByAddress();
    return _ackCapable;
  };

  // ── Per-recipient timezone ────────────────────────────────────────────────
  // All four of these no-op unless the caller supplied composedEmailForTimeZone
  // — a send that can't rebuild its body per zone must not be split into
  // groups that would all read identically, so it stays the ONE row it was.
  const perZone = !!composedEmailForTimeZone;
  const serverZone = serverTimeZone();

  let _zoneMap: Map<string, string> | null = null;
  const zoneMap = async (): Promise<ReadonlyMap<string, string>> => {
    if (!perZone) return EMPTY_ZONE_MAP;
    if (!_zoneMap) _zoneMap = await timeZoneByAddress();
    return _zoneMap;
  };

  // Every address falls back to the server zone, so with an empty map above
  // this collapses to exactly one group — the pre-column single send.
  const timeZoneGroups = (to: string[], cc: string[], bcc: string[], zones: ReadonlyMap<string, string>) =>
    splitTimeZoneGroups(to, cc, bcc, zones, serverZone);

  // Rebuilt bodies, memoized per zone — the closure re-renders the whole
  // template, so an all-one-zone fleet pays for exactly one rebuild and the
  // ack/no-ack pair below share it. The server-zone group reuses the body the
  // caller already built rather than rebuilding an identical one.
  const _byZone = new Map<string, ComposedEmail>();
  const rawBodyForZone = (tz: string): ComposedEmail => {
    if (!perZone || tz === serverZone) return composedEmail as ComposedEmail;
    let b = _byZone.get(tz);
    if (!b) {
      b = composedEmailForTimeZone!(tz);
      _byZone.set(tz, b);
    }
    return b;
  };
  const _ackByZone = new Map<string, ComposedEmail>();
  const bodyForZone = (tz: string): ComposedEmail => {
    if (!perZone || tz === serverZone) return composedBody as ComposedEmail;
    let b = _ackByZone.get(tz);
    if (!b) {
      b = fillComposedAckUrl(rawBodyForZone(tz), ackUrlForEmail(notificationId));
      _ackByZone.set(tz, b);
    }
    return b;
  };
  const _noAckByZone = new Map<string, ComposedEmail>();
  const bodyForZoneNoAck = (tz: string): ComposedEmail => {
    if (!perZone || tz === serverZone) return composedBodyNoAck();
    let b = _noAckByZone.get(tz);
    if (!b) {
      b = fillComposedAckUrl(rawBodyForZone(tz), null);
      _noAckByZone.set(tz, b);
    }
    return b;
  };

  for (const t of targets) {
    const channel = byId.get(t.channelId);
    if (!channel || !channel.enabled || !isChannelType(channel.type)) continue;
    const transport = CHANNEL_TRANSPORT[channel.type as ChannelType];

    if (transport === "email") {
      // Address-book contacts owning the triggering asset. Email-only: a
      // contact is an address, not an account, so there's no push endpoint to
      // reach — the web_push branch below deliberately ignores this flag.
      const contactAddrs = t.recipientAssetContacts ? assetContactEmails ?? [] : [];
      const targetUsers = await usersForTarget(t, "email");
      const owners = buildAddressOwnerMap(targetUsers, t.addresses, contactAddrs);

      if (composedBody) {
        const to = Array.from(owners.keys());
        if (to.length === 0) continue; // no recipients = no send (Graph rejects empty To)
        // ONE row per (timezone, acknowledge-capability) pair — never one per
        // person (the per-recipient fan-out business rule 25 retired).
        //
        // The body carries an acknowledge link that works for whoever reads
        // it, so nothing about the LINK splits a send any more. Two things
        // about the READER still do: a role that can't acknowledge is mailed
        // the same alert without the button, and an account that reads times
        // in a different zone is mailed the same alert on its own wall clock.
        // A fleet in one zone whose readers can all acknowledge — the ordinary
        // case — still produces the single row it always did.
        for (const zg of timeZoneGroups(to, ccResolved, bccResolved, await zoneMap())) {
          for (const v of splitAckVariants(zg.to, zg.cc, zg.bcc, await ackCapable())) {
            const body = v.ack ? bodyForZone(zg.timeZone) : bodyForZoneNoAck(zg.timeZone);
            const { cc, bcc } = dedupeEmailRecipients(v.to, v.cc, v.bcc);
            add(channel.id, "email", v.to.join(", "), {
              composed: true,
              to: v.to,
              cc,
              bcc,
              subject: body.subject,
              text: body.text,
              ...(body.html ? { html: body.html } : {}),
              // The zone this copy's body was rendered in, for the blocks the
              // DRAIN stitches in later (the LLDP "Last advertised" row). Those
              // are built after this function has returned and would otherwise
              // fall back to the server's zone, leaving one email disagreeing
              // with itself about what time it is. Only stamped when the send
              // actually split by zone — a plain send carries no key and the
              // drain keeps its server-zone default.
              ...(perZone ? { timeZone: zg.timeZone } : {}),
            });
          }
        }
      } else {
        // Plain (uncomposed) email is already one row per address, so the
        // button is decided per row: `noAck` tells the drain to leave the
        // acknowledge line off this copy.
        const capable = await ackCapable();
        for (const addr of owners.keys()) {
          const denied = capable.get(addr.trim().toLowerCase()) === false;
          add(channel.id, "email", addr, denied ? { noAck: true } : undefined);
        }
      }
    } else if (transport === "web_push") {
      const users = await usersForTarget(t, "web_push");
      const subs = users.length
        ? await prisma.pushSubscription.findMany({
            where: { userId: { in: users.map((u) => u.id) } },
            // `surface` rides along so the drain can pick the right deep link
            // (mobile SPA vs desktop Automations page) without a second query.
            // `userId` rides along for the same reason `noAck` does below: a
            // push is always addressed to a known account, so the tray action
            // can be withheld from a role that can't use it.
            select: { userId: true, endpoint: true, p256dh: true, auth: true, surface: true },
          })
        : [];
      const cannotAck = new Set(users.filter((u) => !u.canAcknowledge).map((u) => u.id));
      const byUserEmail = new Map(
        users.filter((u) => u.email?.trim()).map((u) => [u.id, u.email!.trim().toLowerCase()] as const),
      );
      for (const s of subs) {
        add(channel.id, "web_push", s.endpoint, {
          p256dh: s.p256dh,
          auth: s.auth,
          surface: s.surface,
          // Everything the drain needs to email this person instead if the
          // endpoint turns out to be dead (404/410). Stamped HERE because by
          // the time the drain finds out, the subscription row has been pruned
          // and there is nothing left saying whose it was. Absent when the
          // action carries no email channel, or the account has no address.
          ...(fallbackChannelId && byUserEmail.get(s.userId)
            ? { fallback: { userId: s.userId, channelId: fallbackChannelId, address: byUserEmail.get(s.userId) } }
            : {}),
          ...(cannotAck.has(s.userId) ? { noAck: true } : {}),
          ...(followUp ? { followUp } : {}),
        });
      }
      if (subs.length === 0) {
        // Push is opt-in per browser, so a perfectly valid-looking automation
        // can resolve to zero devices and deliver nothing at all. Say so.
        // logger, not an Event: this runs per notification on the alerting hot
        // path, and a fleet-wide rule would otherwise flood the audit log.
        logger.warn(
          { channelId: channel.id, notificationId, matchedUsers: users.length },
          users.length === 0
            ? "web_push target matched no users — nothing delivered"
            : "web_push target matched users but none have a push-enabled device — nothing delivered",
        );
      }
    } else {
      // webhook (slack/teams) + pushbullet: one row, fixed destination on the channel.
      add(channel.id, transport, "");
    }
  }

  if (rows.length === 0) return 0;
  await prisma.notificationDelivery.createMany({ data: rows });
  return rows.length;
}

/** Extract the `region:`-prefixed tags from a rule's scope (for
 *  recipientScopeRegion) — from the flat `tags` dimension AND from positive
 *  tag rules inside a condition tree (field "tag", operator "has"). */
export function scopeRegionTagsOf(
  scope: { tags?: string[]; condition?: { op: string; children: unknown[] } | null } | null | undefined,
): string[] {
  const out = new Set<string>();
  const tags = scope && Array.isArray(scope.tags) ? scope.tags : [];
  for (const t of tags) {
    if (typeof t === "string" && t.toLowerCase().startsWith("region:")) out.add(t);
  }
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const g = node as { op?: string; children?: unknown[]; field?: string; operator?: string; value?: string };
    if (Array.isArray(g.children)) { g.children.forEach(walk); return; }
    if (g.field === "tag" && g.operator === "has" && typeof g.value === "string" && g.value.toLowerCase().startsWith("region:")) {
      out.add(g.value);
    }
  };
  if (scope?.condition) walk(scope.condition);
  return Array.from(out);
}

function isChannelType(t: string): t is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(t);
}
