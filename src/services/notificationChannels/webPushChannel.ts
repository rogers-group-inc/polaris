/**
 * src/services/notificationChannels/webPushChannel.ts
 *
 * Browser / PWA Web Push delivery via the `web-push` library, signed with a
 * VAPID keypair passed in by the caller (the web_push NotificationChannel's
 * config). The service worker (public/sw.js) receives the push and calls
 * showNotification.
 *
 * A 404/410 from the push service means the subscription is dead — sendWebPush
 * throws an error carrying `gone: true` so the delivery job prunes the
 * PushSubscription row.
 */

import webpush from "web-push";
import { AppError } from "../../utils/errors.js";
import { resolveAllowedHost } from "../../utils/netGuard.js";

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string; // mailto: or https: contact, per the VAPID spec
}

export interface WebPushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface WebPushPayload {
  title: string;
  body: string;
  severity: string;
  url: string | null;
  notificationId: string;
  /**
   * One-click acknowledge URL for THIS recipient, or null/absent when they
   * can't acknowledge. sw.js renders the "Acknowledge" action button only when
   * it arrives, so an unentitled recipient simply gets the plain notification.
   */
  ackUrl?: string | null;
  /**
   * This alert's DEVICE page, or null/absent when the alert has no asset
   * behind it (a capacity warning, a discovery failure, an alert about Polaris
   * itself). sw.js renders an "Open device" action only when it arrives.
   *
   * Distinct from `url`, which is the SERVER-chosen deep link the body tap
   * follows — the alerts list on the surface that enrolled the subscription.
   */
  assetUrl?: string | null;
}

export interface WebPushError extends Error {
  gone?: boolean;
  statusCode?: number;
}

export async function sendWebPush(vapid: VapidConfig, target: WebPushTarget, payload: WebPushPayload): Promise<void> {
  if (!vapid.publicKey || !vapid.privateKey) {
    throw new AppError(400, "Web Push channel has no VAPID keypair (generate one)");
  }
  // subject must be a mailto:/https: URI per the VAPID spec; fall back so a
  // missing subject doesn't hard-fail every send.
  const subject = vapid.subject && /^(mailto:|https:)/.test(vapid.subject) ? vapid.subject : "mailto:polaris@localhost";
  webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
  // The endpoint is a URL a signed-in user chose; refuse one that points at this host
  // or a metadata address, by literal or by what its name resolves to (rule 110).
  try {
    await resolveAllowedHost(new URL(target.endpoint).hostname);
  } catch (err: any) {
    const e: WebPushError = new Error(`Web push endpoint refused: ${err?.message || "invalid endpoint"}`);
    e.statusCode = 400;
    throw e;
  }
  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload),
    );
  } catch (err: any) {
    const statusCode = err?.statusCode as number | undefined;
    const e: WebPushError = new Error(`Web push failed${statusCode ? ` (HTTP ${statusCode})` : ""}: ${err?.body || err?.message || "unknown"}`);
    e.statusCode = statusCode;
    e.gone = statusCode === 404 || statusCode === 410;
    throw e;
  }
}

/** Generate a fresh VAPID keypair (Delivery tab → Web Push channel). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
