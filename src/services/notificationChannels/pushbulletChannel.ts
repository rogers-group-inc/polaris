/**
 * src/services/notificationChannels/pushbulletChannel.ts
 *
 * Pushbullet delivery — POSTs a "note" push to the Pushbullet API with the
 * channel's access token. Fans out to all the token owner's devices (no device
 * targeting). Throws on a non-2xx so the delivery drain records `failed` +
 * retries.
 */

import { AppError } from "../../utils/errors.js";
import { fetchOr502 } from "../../utils/fetchOr502.js";

export interface PushbulletConfig {
  accessToken: string;
}

export interface PushbulletPayload {
  title: string;
  body: string;
}

export async function sendPushbullet(cfg: PushbulletConfig, payload: PushbulletPayload): Promise<void> {
  if (!cfg.accessToken) throw new AppError(400, "Pushbullet channel is missing an access token");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    // A network failure is a 502 with its reason, not a bare 500 (2026-11-14).
    const res = await fetchOr502("Pushbullet push", "https://api.pushbullet.com/v2/pushes", {
      method: "POST",
      headers: { "Access-Token": cfg.accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "note", title: payload.title, body: payload.body }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = `HTTP ${res.status}`;
      try {
        const p = JSON.parse(text);
        if (p?.error?.message) detail = String(p.error.message).split(/\r?\n/)[0];
      } catch { /* ignore */ }
      throw new AppError(502, `Pushbullet push failed: ${detail}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
