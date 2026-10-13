/**
 * src/services/notificationChannelService.ts
 *
 * CRUD + secret handling for the NotificationChannel registry — the operator-
 * managed list of outbound delivery integrations (Notifications → Delivery tab).
 * Mirrors credentialService's masking discipline: secrets (per the channel
 * type's field defs) are masked on read and preserved on write when the client
 * echoes the mask back.
 *
 * Senders call getChannelRaw() (secrets intact). The Delivery tab + rule builder
 * call the masked list/get. web_push is a singleton (one server VAPID keypair);
 * create enforces it, and generateWebPushKeys() mints the keypair.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import { CHANNEL_TYPE_META, CHANNEL_TRANSPORT, type ChannelType } from "./notificationTypes.js";
import { generateVapidKeys, sendWebPush } from "./notificationChannels/webPushChannel.js";
import { pushDeepLinkUrl } from "../utils/notificationTemplate.js";
import { SECRET_MASK, isMaskedSecret } from "../utils/secretMask.js";
import { restoreStoredSecrets } from "../utils/secretDestination.js";
import { asObject } from "../utils/object.js";

export const MASK = SECRET_MASK;

type ChannelRow = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  config: unknown;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function isChannelType(t: string): t is ChannelType {
  return Object.prototype.hasOwnProperty.call(CHANNEL_TYPE_META, t);
}

function secretKeys(type: ChannelType): string[] {
  return CHANNEL_TYPE_META[type].fields.filter((f) => f.secret).map((f) => f.key);
}


/** Mask every secret field that has a value; report which are set. */
function maskConfig(type: ChannelType, config: unknown): Record<string, unknown> {
  const c = asObject(config);
  for (const key of secretKeys(type)) {
    const present = typeof c[key] === "string" && (c[key] as string).length > 0;
    c[key] = present ? MASK : "";
    c[`${key}Set`] = present;
  }
  // web_push: never return the private key; expose only whether it's set.
  if (type === "web_push") {
    const present = typeof c.privateKey === "string" && (c.privateKey as string).length > 0;
    delete c.privateKey;
    c.privateKeySet = present;
  }
  return c;
}

/** Merge an incoming config onto the stored one, preserving masked secrets. */
function mergeConfig(type: ChannelType, incoming: unknown, current: unknown): Record<string, unknown> {
  const inc = asObject(incoming);
  const cur = asObject(current);
  const out: Record<string, unknown> = { ...inc };
  // A stored secret is reused only while the destination (host / port /
  // security) is unchanged — an SMTP channel re-pointed at another server must
  // have its password typed again (rule 111).
  restoreStoredSecrets(out, cur, secretKeys(type), inc);
  for (const key of secretKeys(type)) {
    const v = inc[key];
    if (typeof v !== "string" || isMaskedSecret(v) || v.trim() === "") {
      out[key] = cur[key] ?? ""; // keep the stored secret
    }
  }
  // Strip UI-only marker fields + never let the client set web_push keys directly.
  for (const k of Object.keys(out)) if (k.endsWith("Set")) delete out[k];
  if (type === "web_push") {
    out.publicKey = cur.publicKey ?? "";
    out.privateKey = cur.privateKey ?? "";
  }
  return out;
}

function maskRow(row: ChannelRow) {
  const type = row.type as ChannelType;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    transport: isChannelType(row.type) ? CHANNEL_TRANSPORT[type] : "unknown",
    enabled: row.enabled,
    config: isChannelType(row.type) ? maskConfig(type, row.config) : {},
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listChannels() {
  const rows = (await prisma.notificationChannel.findMany({ orderBy: { createdAt: "asc" } })) as ChannelRow[];
  return rows.map(maskRow);
}

/** Lightweight {id,name,type,enabled} list for the rule-builder channel picker. */
export async function listChannelsForBuilder() {
  const rows = await prisma.notificationChannel.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, type: true, enabled: true },
  });
  return rows.map((r) => ({ ...r, transport: isChannelType(r.type) ? CHANNEL_TRANSPORT[r.type as ChannelType] : "unknown" }));
}

export async function getChannel(id: string) {
  const row = (await prisma.notificationChannel.findUnique({ where: { id } })) as ChannelRow | null;
  if (!row) throw new AppError(404, "Notification channel not found");
  return maskRow(row);
}

/** Internal: full config WITH secrets, for the senders. */
export async function getChannelRaw(id: string): Promise<ChannelRow | null> {
  return (await prisma.notificationChannel.findUnique({ where: { id } })) as ChannelRow | null;
}

export interface ChannelInput {
  name: string;
  type: string;
  enabled?: boolean;
  config?: unknown;
}

export async function createChannel(input: ChannelInput, actor?: string) {
  if (!isChannelType(input.type)) throw new AppError(400, `Unknown channel type "${input.type}"`);
  const type = input.type;
  if (CHANNEL_TYPE_META[type].singleton) {
    const existing = await prisma.notificationChannel.count({ where: { type } });
    if (existing > 0) throw new AppError(409, `Only one ${CHANNEL_TYPE_META[type].label} channel can be configured`);
  }
  const config = mergeConfig(type, input.config, {});
  const row = await prisma.notificationChannel.create({
    data: { name: input.name.trim(), type, enabled: input.enabled ?? true, config: config as any, createdBy: actor ?? null },
  });
  await logEvent({
    action: "notification_channel.created", resourceType: "notification-channel",
    resourceId: row.id, resourceName: row.name, actor,
    message: `Notification channel "${row.name}" created (${type})`, details: { type },
  });
  return maskRow(row as ChannelRow);
}

export async function updateChannel(id: string, input: ChannelInput, actor?: string) {
  const current = (await prisma.notificationChannel.findUnique({ where: { id } })) as ChannelRow | null;
  if (!current) throw new AppError(404, "Notification channel not found");
  const type = current.type as ChannelType; // type is immutable after create
  if (!isChannelType(type)) throw new AppError(400, "Channel has an unknown type");
  const config = mergeConfig(type, input.config, current.config);
  const row = await prisma.notificationChannel.update({
    where: { id },
    data: { name: (input.name ?? current.name).trim(), enabled: input.enabled ?? current.enabled, config: config as any },
  });
  await logEvent({
    action: "notification_channel.updated", resourceType: "notification-channel",
    resourceId: id, resourceName: row.name, actor,
    message: `Notification channel "${row.name}" updated`, details: { enabled: row.enabled },
  });
  return maskRow(row as ChannelRow);
}

export async function deleteChannel(id: string, actor?: string) {
  const row = await prisma.notificationChannel.findUnique({ where: { id } });
  if (!row) throw new AppError(404, "Notification channel not found");
  // Pending deliveries through this channel get channelId=NULL (SetNull) and
  // the drain marks them failed (channel gone) — no orphaned history.
  await prisma.notificationChannel.delete({ where: { id } });
  await logEvent({
    action: "notification_channel.deleted", resourceType: "notification-channel",
    resourceId: id, resourceName: row.name, actor, message: `Notification channel "${row.name}" deleted`,
  });
}

/** Generate + store a VAPID keypair on the (singleton) web_push channel. */
export async function generateWebPushKeys(id: string, actor?: string) {
  const row = (await prisma.notificationChannel.findUnique({ where: { id } })) as ChannelRow | null;
  if (!row) throw new AppError(404, "Notification channel not found");
  if (row.type !== "web_push") throw new AppError(400, "VAPID keys only apply to a Web Push channel");
  const keys = generateVapidKeys();
  const config = { ...asObject(row.config), publicKey: keys.publicKey, privateKey: keys.privateKey };
  await prisma.notificationChannel.update({ where: { id }, data: { config: config as any } });
  await logEvent({
    action: "notification_channel.vapid_generated", resourceType: "notification-channel",
    resourceId: id, resourceName: row.name, actor, message: "Generated a new Web Push VAPID keypair",
  });
  return { publicKey: keys.publicKey, privateKeySet: true };
}

/** The singleton web_push channel (enabled + keyed), or null. Used by the
 *  /push-subscriptions key handoff and the web_push sender. */
export async function getWebPushChannel(): Promise<ChannelRow | null> {
  return (await prisma.notificationChannel.findFirst({ where: { type: "web_push" } })) as ChannelRow | null;
}

// ─── Web Push: a server capability, not a destination ────────────────────
//
// Every other channel type names somewhere to send TO (an SMTP host, a webhook
// URL, a Pushbullet account), so it earns a configure-me form. Web Push names
// nothing: the VAPID keypair is generated, the destination is whichever devices
// users have enrolled, and WHO gets a given alert is chosen per notify action
// when an automation is built. So it's modeled as a single on/off capability
// rather than a channel an operator has to assemble.

const WEB_PUSH_CHANNEL_NAME = "Web Push";

/** VAPID requires a mailto:/https: contact URI. Derive one; the sender also
 *  has its own fallback, so this is never load-bearing. */
function defaultVapidSubject(): string {
  const base = process.env.POLARIS_PUBLIC_URL;
  if (base && /^https:/i.test(base)) return base.replace(/\/$/, "");
  return "mailto:polaris@localhost";
}

export interface WebPushState {
  /** Turned on AND usable (keys present) — what the UI toggle reflects. */
  enabled: boolean;
  /** A channel row exists (may be disabled). */
  configured: boolean;
  /** Devices currently enrolled, so the toggle isn't feedback-free. */
  subscriberCount: number;
  channelId: string | null;
}

export async function getWebPushState(): Promise<WebPushState> {
  const [ch, subscriberCount] = await Promise.all([
    getWebPushChannel(),
    prisma.pushSubscription.count(),
  ]);
  const cfg = asObject(ch?.config);
  return {
    enabled: !!ch?.enabled && !!cfg.publicKey,
    configured: !!ch,
    subscriberCount,
    channelId: ch?.id ?? null,
  };
}

/**
 * Turn Web Push on or off in one call — create the singleton and generate the
 * keypair on first enable, so the operator never sees channel plumbing.
 *
 * Disabling NEVER deletes the row or the keys. Every PushSubscription is signed
 * against this keypair; dropping it would silently invalidate every enrolled
 * device and force the whole fleet to re-enroll. Disabled + keys intact means
 * flipping it back on just works.
 */
export async function setWebPushEnabled(enabled: boolean, actor?: string): Promise<WebPushState> {
  const existing = await getWebPushChannel();

  if (!enabled) {
    if (existing?.enabled) {
      await prisma.notificationChannel.update({ where: { id: existing.id }, data: { enabled: false } });
      await logEvent({
        action: "notification_channel.updated", resourceType: "notification-channel",
        resourceId: existing.id, resourceName: existing.name, actor,
        message: "Web Push disabled (VAPID keypair retained so enrolled devices survive a re-enable)",
      });
    }
    return getWebPushState();
  }

  let id = existing?.id;
  if (!existing) {
    const created = await prisma.notificationChannel.create({
      data: {
        name: WEB_PUSH_CHANNEL_NAME,
        type: "web_push",
        enabled: true,
        config: { subject: defaultVapidSubject() } as any,
        createdBy: actor ?? null,
      },
    });
    id = created.id;
    await logEvent({
      action: "notification_channel.created", resourceType: "notification-channel",
      resourceId: id, resourceName: WEB_PUSH_CHANNEL_NAME, actor, message: "Web Push enabled",
    });
  } else if (!existing.enabled) {
    await prisma.notificationChannel.update({ where: { id: existing.id }, data: { enabled: true } });
    await logEvent({
      action: "notification_channel.updated", resourceType: "notification-channel",
      resourceId: existing.id, resourceName: existing.name, actor, message: "Web Push enabled",
    });
  }

  // Generate on first enable, or heal a row that somehow lost its keypair.
  const cfg = asObject((await getWebPushChannel())?.config);
  if (!cfg.publicKey || !cfg.privateKey) await generateWebPushKeys(id!, actor);

  return getWebPushState();
}

/**
 * Send a test push to ONE user's own enrolled devices.
 *
 * Scoped to the caller's own subscriptions on purpose — a "test" that could
 * notify arbitrary other people is a nuisance vector, not a diagnostic.
 *
 * Sends directly rather than queueing a NotificationDelivery, so the operator
 * gets the real per-device result (including a dead endpoint) instead of a
 * "queued" shrug. It still uses `pushDeepLinkUrl(surface)` so what lands on the
 * device is shaped exactly like a production alert. A 404/410 prunes the row,
 * mirroring what the delivery drain does.
 */
export async function sendWebPushTest(userId: string, actor?: string): Promise<{
  ok: boolean; sent: number; failed: number; pruned: number; message: string;
}> {
  const ch = await getWebPushChannel();
  const cfg = asObject(ch?.config);
  if (!ch || !ch.enabled || !cfg.publicKey || !cfg.privateKey) {
    throw new AppError(400, "Web Push is turned off — enable it first.");
  }

  const subs = await prisma.pushSubscription.findMany({
    where: { userId },
    select: { endpoint: true, p256dh: true, auth: true, surface: true },
  });
  if (subs.length === 0) {
    throw new AppError(
      400,
      "No push-enabled devices on your account. Turn on push from the sidebar (desktop) or More → Push notifications (mobile), then test again.",
    );
  }

  const vapid = {
    publicKey: String(cfg.publicKey),
    privateKey: String(cfg.privateKey),
    subject: typeof cfg.subject === "string" ? cfg.subject : "",
  };

  let sent = 0, failed = 0, pruned = 0;
  const errors: string[] = [];
  for (const s of subs) {
    try {
      await sendWebPush(
        vapid,
        { endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
        {
          title: "Polaris test",
          body: "Push notifications are working. This is a test.",
          severity: "info",
          url: pushDeepLinkUrl(s.surface),
          notificationId: `test-${Date.now()}`,
        },
      );
      sent++;
    } catch (err) {
      const e = err as { message?: string; gone?: boolean };
      failed++;
      if (e.gone) {
        await prisma.pushSubscription.deleteMany({ where: { endpoint: s.endpoint, userId } });
        pruned++;
      } else if (e.message) {
        errors.push(e.message);
      }
    }
  }

  await logEvent({
    action: "notification_channel.test", resourceType: "notification-channel",
    resourceId: ch.id, resourceName: ch.name, actor,
    level: sent > 0 ? "info" : "warning",
    message: `Web Push test: ${sent} sent, ${failed} failed${pruned ? `, ${pruned} dead subscription(s) pruned` : ""}`,
  });

  const message = sent > 0
    ? `Test push sent to ${sent} device${sent === 1 ? "" : "s"}${pruned ? ` (${pruned} dead subscription${pruned === 1 ? "" : "s"} removed)` : ""}.`
    : `Could not deliver to any device${pruned ? ` — ${pruned} dead subscription${pruned === 1 ? "" : "s"} removed; re-enable push on that device` : ""}.${errors.length ? ` ${errors[0]}` : ""}`;

  return { ok: sent > 0, sent, failed, pruned, message };
}
