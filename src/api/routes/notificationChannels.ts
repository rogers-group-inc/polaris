/**
 * src/api/routes/notificationChannels.ts
 *
 * CRUD for the NotificationChannel registry (Notifications → Delivery tab) +
 * per-channel Test send + VAPID keypair generation for the web_push channel.
 * Gated `automationManagement` (same as rule CRUD). Secrets are masked on
 * read and preserved on write by notificationChannelService.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";
import {
  listChannels, getChannel, getChannelRaw, createChannel, updateChannel, deleteChannel, generateWebPushKeys,
  getWebPushState, setWebPushEnabled, sendWebPushTest,
} from "../../services/notificationChannelService.js";
import { CHANNEL_TYPES, type ChannelType } from "../../services/notificationTypes.js";
import { sendSmtpEmail, sendM365Email } from "../../services/notificationChannels/emailChannel.js";
import { sendWebhook } from "../../services/notificationChannels/webhookChannel.js";
import { sendPushbullet } from "../../services/notificationChannels/pushbulletChannel.js";

const router = Router();

const channelInputSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(CHANNEL_TYPES),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
const channelUpdateSchema = channelInputSchema.partial({ type: true });

router.get("/", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try { res.json({ channels: await listChannels() }); } catch (err) { next(err); }
});

// Web Push is a server capability, not a destination — one on/off switch
// instead of a channel form (see the block comment in notificationChannelService).
// MUST be declared before "/:id" or the literal path is captured as an id.
router.get("/web-push", requirePermission("automationManagement", "read"), async (_req, res, next) => {
  try { res.json(await getWebPushState()); } catch (err) { next(err); }
});

router.put("/web-push", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(await setWebPushEnabled(enabled, req.session?.username));
  } catch (err) { next(err); }
});

// Send a real push to the CALLER's own enrolled devices. Every other channel
// has a Test button; web_push had none, so the only way to check it worked was
// to build an automation and provoke a trigger. Scoped to the caller's own
// subscriptions — this must never be a way to notify other people.
// Declared before "/:id/test" or the literal path is captured as an id.
router.post("/web-push/test", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    res.json(await sendWebPushTest(userId, req.session?.username));
  } catch (err) { next(err); }
});

router.get("/:id", requirePermission("automationManagement", "read"), async (req, res, next) => {
  try { res.json(await getChannel(req.params.id as string)); } catch (err) { next(err); }
});

router.post("/", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    const input = channelInputSchema.parse(req.body);
    res.status(201).json(await createChannel(input, req.session?.username));
  } catch (err) { next(err); }
});

router.put("/:id", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    const input = channelUpdateSchema.parse(req.body);
    res.json(await updateChannel(req.params.id as string, input as any, req.session?.username));
  } catch (err) { next(err); }
});

router.delete("/:id", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    await deleteChannel(req.params.id as string, req.session?.username);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Generate + store a VAPID keypair on a web_push channel.
router.post("/:id/generate-vapid", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try { res.json(await generateWebPushKeys(req.params.id as string, req.session?.username)); } catch (err) { next(err); }
});

// Send a test through a channel. Email channels take a `to` address; chat /
// pushbullet post to the channel's own destination. Uses the STORED config
// (secrets intact) — save before testing.
router.post("/:id/test", requirePermission("automationManagement", "write"), async (req, res, next) => {
  try {
    const ch = await getChannelRaw(req.params.id as string);
    if (!ch) throw new AppError(404, "Notification channel not found");
    const cfg = (ch.config && typeof ch.config === "object" ? ch.config : {}) as Record<string, unknown>;
    const str = (k: string) => (typeof cfg[k] === "string" ? (cfg[k] as string) : "");
    const type = ch.type as ChannelType;
    const subject = "Polaris notification test";
    const text = `This is a test notification from Polaris channel "${ch.name}".`;

    if (type === "smtp") {
      const to = z.string().email().parse(req.body?.to);
      await sendSmtpEmail({ host: str("host"), port: Number(cfg.port) || 587, security: (str("security") as any) || "starttls", username: str("username"), password: str("password"), from: str("from") }, { to, subject, text });
      res.json({ ok: true, message: `Test email sent to ${to}` });
    } else if (type === "oauth_m365") {
      const to = req.body?.to ? z.string().email().parse(req.body.to) : str("fromUserId");
      if (!to) throw new AppError(400, "No recipient — set a send-as user or provide a test address");
      await sendM365Email({ tenantId: str("tenantId"), clientId: str("clientId"), clientSecret: str("clientSecret"), fromUserId: str("fromUserId") }, { to, subject, text });
      res.json({ ok: true, message: `Test email sent to ${to}` });
    } else if (type === "slack" || type === "teams") {
      await sendWebhook(str("webhookUrl"), type, { title: subject, message: text, severity: "info", assetHostname: null, url: null, triggeredAt: new Date().toISOString() });
      res.json({ ok: true, message: "Test message posted to the webhook" });
    } else if (type === "pushbullet") {
      await sendPushbullet({ accessToken: str("accessToken") }, { title: subject, body: text });
      res.json({ ok: true, message: "Test push sent to Pushbullet" });
    } else {
      throw new AppError(400, "Web Push is tested by enabling it on a device, not from here");
    }
  } catch (err) { next(err); }
});

export default router;
