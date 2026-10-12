/**
 * src/api/routes/pushSubscriptions.ts
 *
 * Per-user Web Push subscription management + VAPID public-key handoff.
 *   GET    /push-subscriptions/key   — the server VAPID public key (for PushManager.subscribe)
 *   POST   /push-subscriptions       — store/refresh the caller's subscription
 *   DELETE /push-subscriptions       — remove a subscription by endpoint
 *
 * Gated by notifications=read (any viewer may opt into push). A subscription is
 * owned by the session user; the deliverNotifications web_push channel routes
 * to a user's endpoints when a rule's recipientTags match that user.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import { requirePermission } from "../middleware/permissions.js";
import { getWebPushChannel } from "../../services/notificationChannelService.js";
import { savePushSubscription, deletePushSubscription } from "../../services/pushSubscriptionService.js";
import { isBlockedOutboundHost } from "../../utils/netGuard.js";

const router = Router();

// A push endpoint is always an https URL on a push service (FCM, Mozilla, Apple, WNS).
// It is a caller-chosen URL the server later POSTs to, so one that names this host, a
// link-local or metadata address is refused (rule 110); a name is judged again at send.
const PushEndpointSchema = z.string().url().max(2000).refine((u) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" && !isBlockedOutboundHost(url.hostname);
  } catch {
    return false;
  }
}, "Push endpoint must be an https URL that is not a loopback / link-local / metadata address");

const subscribeSchema = z.object({
  endpoint: PushEndpointSchema,
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
  // Which surface enrolled: decides the push deep link (mobile SPA vs the
  // desktop Automations page). Optional so pre-upgrade clients still work.
  surface: z.enum(["desktop", "mobile"]).optional(),
  // Sent by sw.js's pushsubscriptionchange handler so the retiring row's
  // surface carries forward onto the new endpoint. Only honored for rows the
  // caller already owns.
  oldEndpoint: z.string().url().max(2000).optional(),
});

router.get("/key", requirePermission("alerts", "read"), async (_req, res, next) => {
  try {
    const ch = await getWebPushChannel();
    const cfg = (ch?.config && typeof ch.config === "object" ? ch.config : {}) as Record<string, unknown>;
    const publicKey = typeof cfg.publicKey === "string" ? cfg.publicKey : "";
    const ready = !!ch && ch.enabled && !!publicKey;
    res.json({ enabled: ready, publicKey: ready ? publicKey : "" });
  } catch (err) {
    next(err);
  }
});

router.post("/", requirePermission("alerts", "read"), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    const { endpoint, keys, surface, oldEndpoint } = subscribeSchema.parse(req.body);
    const userAgent = (req.get("user-agent") ?? "").slice(0, 500) || null;
    await savePushSubscription({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent, surface, oldEndpoint });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete("/", requirePermission("alerts", "read"), async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    const endpoint = z.string().url().max(2000).parse(req.body?.endpoint);
    await deletePushSubscription(userId, endpoint);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
