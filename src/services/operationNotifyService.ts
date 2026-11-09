/**
 * src/services/operationNotifyService.ts — who hears about a firmware upgrade
 * or a reboot, and through which email channel (business rules 93 / 115(e),
 * 2026-11-09).
 *
 * The upgrade and reboot dialogs build recipients with the automations' own
 * To / Cc / Bcc picker (public/js/recipient-picker.js), so the stored shape is
 * the automations' too — a `NotifySpec`:
 *   to   — users, addresses, roles, regions, tags, and the three DYNAMIC kinds
 *          resolved against the device (its region's users, its L<n> region's
 *          users, its responsible contacts) — the reboot action's To.
 *   cc / bcc — EmailRecipients (no dynamic kinds; they are fixed lists).
 *   channelIds — the EMAIL channels (SMTP / Microsoft 365) it goes out on.
 *          Empty = the install's oldest enabled email channel, as before.
 *          Push, Pushbullet, Teams and Slack are refused: these are emails.
 *
 * The spec is stored on the booking / run (`notifyRecipients`,
 * `notifyChannelIds`) and RESOLVED AT EACH SEND (`targetFor`), so a role or a
 * region reaches whoever holds it when the email goes. `notifyEmails` keeps the
 * To as resolved when the spec was saved — what the booking's CHECK counts and
 * what a send falls back to when the To resolves to nobody by then.
 *
 * `deliverOperationEmail` is the one sender: per chosen channel, one message
 * per To address in that reader's zone — or, with a Cc or Bcc, ONE message to
 * the whole To line in the install's zone (the automations' contract for the
 * same fields, rule 25).
 *
 * Each user's last spec per kind is remembered on the User
 * (`lastFirmwareNotify` / `lastRebootNotify`) and pre-fills the next dialog.
 */

import { z } from "zod";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { REGION_TAG_PREFIX } from "../utils/tagNormalize.js";
import { emailRecipientsSchema, MAX_DEVICE_REGION_LEVELS } from "./notificationTypes.js";
import { listRecipientUsers, resolveRebootActionRecipients } from "./notificationRecipientService.js";
import { listRecipientCatalog } from "./notificationRuleService.js";
import { applyBrandLetterhead, sendEmailThroughChannel } from "./notificationDeliveryService.js";
import { resolveSummaryChannel } from "./quietTimeSummaryService.js";
import { resolveTimeZone, serverTimeZone } from "./userTimezoneService.js";

/** The channel types an upgrade / reboot email may go out on. */
const EMAIL_CHANNEL_TYPES = ["smtp", "oauth_m365"] as const;
const MAX_NOTIFY_CHANNELS = 5;
/** A resolved list's cap — a role or region can be large, nobody typed it. */
const MAX_RESOLVED = 200;

const notifyToSchema = emailRecipientsSchema.extend({
  recipientDeviceRegion: z.boolean().optional(),
  recipientDeviceRegionLevels: z.array(z.number().int().min(1).max(MAX_DEVICE_REGION_LEVELS)).max(MAX_DEVICE_REGION_LEVELS).optional(),
  recipientAssetContacts: z.boolean().optional(),
}).strict();

export const notifySpecSchema = z.object({
  to: notifyToSchema,
  cc: emailRecipientsSchema.optional().nullable(),
  bcc: emailRecipientsSchema.optional().nullable(),
  channelIds: z.array(z.string().max(100)).max(MAX_NOTIFY_CHANNELS).default([]),
}).strict();

export type NotifySpec = z.infer<typeof notifySpecSchema>;
/** The recipients half, as stored in `notifyRecipients` (channels live in their own column). */
export type NotifyRecipients = Omit<NotifySpec, "channelIds">;
export type NotifyKind = "firmware" | "reboot";

export interface NotifyTarget {
  to: string[];
  cc: string[];
  bcc: string[];
  channelIds: string[];
}

// ─── Channels ─────────────────────────────────────────────────────────────────

/** Enabled email channels, oldest first — the first is the default. */
async function listNotifyChannels(): Promise<Array<{ id: string; name: string; type: string }>> {
  return prisma.notificationChannel.findMany({
    where: { enabled: true, type: { in: [...EMAIL_CHANNEL_TYPES] } },
    select: { id: true, name: true, type: true },
    orderBy: { createdAt: "asc" },
  });
}

/** Every chosen id must be an enabled email channel. 400 naming the first that is not. */
export async function assertNotifyChannels(ids: readonly string[]): Promise<string[]> {
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return [];
  const rows = await prisma.notificationChannel.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, type: true, enabled: true } });
  for (const id of unique) {
    const ch = rows.find((r) => r.id === id);
    if (!ch) throw new AppError(400, "A chosen delivery channel no longer exists");
    if (!(EMAIL_CHANNEL_TYPES as readonly string[]).includes(ch.type)) throw new AppError(400, `"${ch.name}" is not an email channel — upgrade and reboot notifications go out by email only`);
    if (!ch.enabled) throw new AppError(400, `"${ch.name}" is disabled`);
  }
  return unique;
}

// ─── Recipients ───────────────────────────────────────────────────────────────

function regionSnapshot(tags: string[]): string[] {
  return tags
    .filter((t) => t.toLowerCase().startsWith(REGION_TAG_PREFIX))
    .map((t) => t.slice(REGION_TAG_PREFIX.length))
    .filter(Boolean);
}

/** Resolve a spec's To / Cc / Bcc against the device, now. */
async function resolveNotifyRecipients(spec: NotifyRecipients, assetId: string): Promise<{ to: string[]; cc: string[]; bcc: string[] }> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { tags: true } });
  let contacts: string[] = [];
  if (spec.to.recipientAssetContacts) {
    // Lazy: contactService is heavy and nothing else here needs it.
    const { resolveContactEmailsForAsset } = await import("./contactService.js");
    contacts = await resolveContactEmailsForAsset(assetId);
  }
  const r = await resolveRebootActionRecipients(
    { ...spec.to, cc: spec.cc ?? null, bcc: spec.bcc ?? null },
    { assetRegionTags: regionSnapshot(asset?.tags ?? []), assetContactEmails: contacts, logCtx: { assetId, purpose: "operation-notify" } },
  );
  return { to: r.to.slice(0, MAX_RESOLVED), cc: r.cc.slice(0, MAX_RESOLVED), bcc: r.bcc.slice(0, MAX_RESOLVED) };
}

/** Typed addresses lower-cased and de-duplicated, as every other recipient list stores them. Pure. */
function lowerAddresses<T extends { addresses?: string[] }>(r: T): T {
  if (!r.addresses) return r;
  return { ...r, addresses: Array.from(new Set(r.addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))) };
}

/**
 * Validate a spec from a dialog for this device: its channels, and that its To
 * reaches at least one address right now. Answers what the booking / run
 * stores. 400 when the To resolves to nobody — a notification nobody receives
 * is the thing the box exists to prevent.
 */
export async function prepareNotify(assetId: string, spec: NotifySpec): Promise<{ notifyEmails: string[]; notifyRecipients: NotifyRecipients; notifyChannelIds: string[] }> {
  const notifyChannelIds = await assertNotifyChannels(spec.channelIds);
  const recipients: NotifyRecipients = { to: lowerAddresses(spec.to), cc: spec.cc ? lowerAddresses(spec.cc) : null, bcc: spec.bcc ? lowerAddresses(spec.bcc) : null };
  const resolved = await resolveNotifyRecipients(recipients, assetId);
  if (resolved.to.length === 0) {
    throw new AppError(400, "The To recipients reach nobody with an email address — add a person or an address");
  }
  return { notifyEmails: resolved.to, notifyRecipients: recipients, notifyChannelIds };
}

/**
 * Who a stored booking / run emails NOW. A stored spec is resolved afresh; if
 * it reaches nobody by then (a role emptied, a region redrawn) the To saved
 * with it is used, so someone still hears. No spec = the stored addresses
 * (plus an automation booking's Cc / Bcc). Never throws.
 */
export async function targetFor(row: {
  assetId: string;
  notifyEmails: string[];
  notifyRecipients?: unknown;
  notifyChannelIds?: string[] | null;
  notifyCc?: string[] | null;
  notifyBcc?: string[] | null;
}): Promise<NotifyTarget> {
  const channelIds = row.notifyChannelIds ?? [];
  const fallback: NotifyTarget = { to: row.notifyEmails, cc: row.notifyCc ?? [], bcc: row.notifyBcc ?? [], channelIds };
  if (!row.notifyRecipients) return fallback;
  const parsed = notifySpecSchema.omit({ channelIds: true }).safeParse(row.notifyRecipients);
  if (!parsed.success) return fallback;
  try {
    const r = await resolveNotifyRecipients(parsed.data, row.assetId);
    return { to: r.to.length > 0 ? r.to : row.notifyEmails, cc: r.cc, bcc: r.bcc, channelIds };
  } catch (err) {
    logger.warn({ err, assetId: row.assetId }, "operation notify: recipients could not be resolved — using the addresses saved with the booking");
    return fallback;
  }
}

// ─── Sending ──────────────────────────────────────────────────────────────────

type Render = (zone: string) => { subject: string; text: string; html: string };

/**
 * Send one email (rendered per reader zone) to a target through its channels.
 * Answers null when every message went, else why not. Never throws.
 */
export async function deliverOperationEmail(target: NotifyTarget, render: Render): Promise<string | null> {
  if (target.to.length === 0) return null;
  let channels: Array<{ id: string; name: string; type: string; config: unknown }>;
  if (target.channelIds.length === 0) {
    const ch = await resolveSummaryChannel(null, []);
    if (!ch) return "no enabled email channel (SMTP or Microsoft 365) is configured";
    channels = [{ id: ch.id, name: "email", type: ch.type, config: ch.config }];
  } else {
    channels = await prisma.notificationChannel.findMany({
      where: { id: { in: target.channelIds }, enabled: true, type: { in: [...EMAIL_CHANNEL_TYPES] } },
      select: { id: true, name: true, type: true, config: true },
    });
    if (channels.length === 0) return "none of the chosen email channels is enabled any more";
  }

  const zoneOf = new Map<string, string>();
  if (!(target.cc.length || target.bcc.length)) {
    const users = await prisma.user.findMany({ where: { email: { in: target.to, mode: "insensitive" } }, select: { email: true, timezone: true, detectedTimezone: true } });
    for (const u of users) if (u.email) zoneOf.set(u.email.toLowerCase(), resolveTimeZone(u.timezone, u.detectedTimezone));
  }

  const failures: string[] = [];
  const many = channels.length > 1;
  for (const ch of channels) {
    const via = many ? `${ch.name}: ` : "";
    const send = async (to: string[], cc: string[], bcc: string[], zone: string) => {
      const r = render(zone);
      const msg = await applyBrandLetterhead({ to, ...(cc.length ? { cc } : {}), ...(bcc.length ? { bcc } : {}), subject: r.subject, text: r.text, html: r.html });
      await sendEmailThroughChannel({ type: ch.type, config: ch.config as Record<string, unknown> }, msg);
    };
    if (target.cc.length || target.bcc.length) {
      try { await send(target.to, target.cc, target.bcc, serverTimeZone()); }
      catch (err) { failures.push(`${via}${String((err as Error)?.message ?? err).slice(0, 200)}`); }
    } else {
      for (const address of target.to) {
        try { await send([address], [], [], zoneOf.get(address) ?? serverTimeZone()); }
        catch (err) { failures.push(`${via}${address}: ${String((err as Error)?.message ?? err).slice(0, 200)}`); }
      }
    }
  }
  return failures.length > 0 ? failures.join("; ") : null;
}

// ─── What the dialog pre-fills ────────────────────────────────────────────────

const KIND_FIELD = { firmware: "lastFirmwareNotify", reboot: "lastRebootNotify" } as const;

/** The addresses a spec names without a device: typed ones and users' own. */
async function staticAddresses(spec: NotifyRecipients): Promise<string[]> {
  const out = new Set<string>((spec.to.addresses ?? []).map((a) => a.toLowerCase()));
  if (spec.to.recipientUserIds?.length) {
    const users = await prisma.user.findMany({ where: { id: { in: spec.to.recipientUserIds } }, select: { email: true } });
    for (const u of users) if (u.email) out.add(u.email.trim().toLowerCase());
  }
  return Array.from(out);
}

/**
 * The spec this user last used for this kind, else themselves (as a user pill,
 * when they have an email address) on the default channel. `notifyEmails` is
 * its device-free addresses — what the group upgrade dialog, which has no
 * picker, pre-fills.
 */
export async function defaultNotifyFor(userId: string | null, kind: NotifyKind): Promise<{ notify: NotifySpec | null; notifyEmails: string[] }> {
  if (!userId) return { notify: null, notifyEmails: [] };
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { email: true, lastFirmwareNotify: true, lastRebootNotify: true } });
  if (!u) return { notify: null, notifyEmails: [] };
  const parsed = notifySpecSchema.safeParse(u[KIND_FIELD[kind]]);
  if (parsed.success) return { notify: parsed.data, notifyEmails: await staticAddresses(parsed.data) };
  const email = u.email?.trim().toLowerCase();
  if (!email) return { notify: null, notifyEmails: [] };
  return { notify: { to: { recipientUserIds: [userId] }, cc: null, bcc: null, channelIds: [] }, notifyEmails: [email] };
}

/**
 * Remember what this user just sent, for their next dialog. Best-effort: a
 * failed write never fails the upgrade / reboot / booking that called it.
 */
export async function rememberNotifyFor(userId: string | null | undefined, kind: NotifyKind, spec: NotifySpec): Promise<void> {
  if (!userId) return;
  const stored: NotifySpec = { ...spec, to: lowerAddresses(spec.to), cc: spec.cc ? lowerAddresses(spec.cc) : null, bcc: spec.bcc ? lowerAddresses(spec.bcc) : null };
  await prisma.user.update({ where: { id: userId }, data: { [KIND_FIELD[kind]]: stored as object }, select: { id: true } })
    .catch((err) => logger.warn({ err, userId, kind }, "could not remember the notification recipients"));
}

/**
 * What the dialog's picker needs, at `assets:write`: the region / role / tag
 * catalogue, the users (for pill labels and the typeahead's people), and the
 * email channels. The same lists the automations wizard reads behind
 * `automationManagement:read` — names only, no secrets; the users are what
 * `/contacts/search` already offers at `contacts:read`.
 */
export async function notifyPickerCatalog(): Promise<{
  catalog: Awaited<ReturnType<typeof listRecipientCatalog>>;
  users: Array<{ id: string; username: string; displayName: string | null; email: string | null }>;
  channels: Array<{ id: string; name: string; type: string }>;
}> {
  const [catalog, users, channels] = await Promise.all([listRecipientCatalog(), listRecipientUsers(), listNotifyChannels()]);
  return { catalog, users: users.map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, email: u.email })), channels };
}

/**
 * Everything the upgrade / reboot dialog opens with: what to pre-fill (this
 * user's last spec for the kind, else themselves), its device-free addresses
 * (`notifyEmails`, for a surface with no picker), and the picker's catalogue.
 */
export async function notifyDialogDefaults(userId: string | null, kind: NotifyKind): Promise<Awaited<ReturnType<typeof defaultNotifyFor>> & Awaited<ReturnType<typeof notifyPickerCatalog>>> {
  const [defaults, catalog] = await Promise.all([defaultNotifyFor(userId, kind), notifyPickerCatalog()]);
  return { ...defaults, ...catalog };
}
