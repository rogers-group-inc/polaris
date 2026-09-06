/**
 * src/services/userTimezoneService.ts
 *
 * Per-user display timezone — the IANA zone an account wants its times
 * rendered in, or the literal "auto".
 *
 * Two halves, deliberately kept apart (the notificationPreferenceService
 * shape, for the same reason):
 *
 *   The STORED value (User.timezone) is the account's answer, and it lives
 *   server-side rather than per browser because it has to reach a surface that
 *   HAS no browser. An alert email is composed on the server and handed to
 *   SMTP; before this column the only zone it could name was the server's,
 *   which on a UTC-clocked host reads hours off to every operator.
 *
 *   The RESOLUTION half is `resolveTimeZone` — pure, and deliberately
 *   permissive. It is asked once per render and once per recipient per send,
 *   and anything it cannot resolve falls back rather than throwing: a timezone
 *   column holding a zone this build's ICU has never heard of must cost an
 *   alert its precise wall clock, never its delivery.
 *
 * "auto" is not a zone and never resolves to one on the CLIENT: the browser
 * formats in its own zone (which is what `toLocaleString(undefined, …)` in
 * public/js/api.js already did before this existed), so an account that never
 * touches the setting sees the UI it always saw.
 *
 * SERVER-side there is no browser to ask, so "auto" falls to
 * User.detectedTimezone — the zone the account's browser reported on its last
 * boot — and only then to the server's zone. That middle step is the point of
 * the whole feature: almost nobody will open the picker, because their laptop
 * is already in their zone and the UI therefore looks right, and without it
 * every one of those accounts would keep receiving email on the SERVER's
 * clock. See resolveTimeZone.
 *
 * A write bumps the recipient index (notificationRecipientService caches user
 * rows for 30s and now carries the zone alongside the preference), so a new
 * choice applies to the next alert rather than up to half a minute later.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { bumpRecipientIndex } from "./notificationRecipientService.js";
import { logEvent } from "./eventLogService.js";

/** The "let the render decide" marker. Not a zone — see the header. */
export const AUTO_TIMEZONE = "auto";

/**
 * The server's own zone, for resolving "auto" on a surface with no browser.
 *
 * Computed per call rather than cached at module load: a long-lived process
 * that crosses a DST boundary keeps the same IANA name (the offset moves, the
 * name does not), but a host whose TZ is changed under a running Polaris would
 * otherwise serve the old zone until restart. The call is cheap and off every
 * hot path — it happens once per email compose, not once per asset.
 */
export function serverTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // Intl is always present on supported Node, but a resolved zone is not
    // guaranteed on a stripped container image with no ICU data.
    return "UTC";
  }
}

/**
 * Can this build's ICU actually format in `tz`?
 *
 * The only honest test is to try it: `Intl.supportedValuesOf("timeZone")` is
 * unavailable on some builds, and a small-ICU Node accepts the *name* of a
 * zone it cannot apply. Throwing here is the expected failure, not an error.
 */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a stored / submitted value to "auto" or a zone this build can
 * format in. Unknown input resolves to "auto" rather than throwing: this is
 * read on the alerting path from a plain TEXT column, and a row holding
 * something unexpected must degrade to the server's zone (which reaches
 * everyone, legibly, with a zone label attached) rather than fail a send.
 *
 * Note this is the READ-side normalizer and is intentionally lenient. The
 * route's Zod schema is the strict half: an operator PUTting a bogus zone gets
 * a 400 instead of a silent downgrade to "auto".
 */
export function normalizeUserTimezone(v: unknown): string {
  if (typeof v !== "string") return AUTO_TIMEZONE;
  const t = v.trim();
  if (!t || t === AUTO_TIMEZONE) return AUTO_TIMEZONE;
  return isValidTimeZone(t) ? t : AUTO_TIMEZONE;
}

/**
 * The concrete IANA zone to format a SERVER-side render in.
 *
 * Resolution order, most specific first:
 *   1. the account's EXPLICIT choice, when it set one;
 *   2. the zone its BROWSER last reported (User.detectedTimezone);
 *   3. the server's own zone.
 *
 * Step 2 is what makes the default worth having. Almost nobody will open the
 * picker — their laptop is already in their zone, so the UI looks right — and
 * without it "auto" would resolve to the server's zone in an alert email,
 * which on a UTC-clocked host is exactly the misreading this column set exists
 * to stop. Step 3 only survives for an account that has never signed in on a
 * browser, and is the pre-column behaviour.
 *
 * Never call this to decide what the BROWSER renders in: there, "auto" means
 * "pass no timeZone option and let the platform use its own", which is not the
 * same answer and must not be flattened to a resolved name.
 */
export function resolveTimeZone(stored: unknown, detected?: unknown): string {
  const norm = normalizeUserTimezone(stored);
  if (norm !== AUTO_TIMEZONE) return norm;
  const det = normalizeUserTimezone(detected);
  return det === AUTO_TIMEZONE ? serverTimeZone() : det;
}

/**
 * The zone list the picker offers. `supportedValuesOf` is the real tz database
 * as this build knows it; the fallback is a short, deliberately boring list
 * covering the zones a US infrastructure team actually sits in, so a small-ICU
 * container still renders a usable picker instead of an empty one.
 */
export function listTimeZones(): string[] {
  try {
    const anyIntl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const zones = anyIntl.supportedValuesOf?.("timeZone");
    if (Array.isArray(zones) && zones.length > 0) return zones;
  } catch {
    // fall through to the static list
  }
  return [
    "UTC",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
  ].filter(isValidTimeZone);
}

export async function getUserTimezone(userId: string): Promise<string> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  if (!row) throw new AppError(404, "User not found");
  return normalizeUserTimezone(row.timezone);
}

/**
 * Record the zone this account's browser just reported.
 *
 * Called on boot by every client, so the ONLY write is the one that changes
 * something: a no-op read on every page load is far cheaper than a write, and
 * an operator who never travels writes this exactly once ever. Deliberately
 * NOT audited and NOT a bump of the recipient index — it is a detected fact,
 * not a decision, and the next index refresh (30s) picks it up on its own.
 *
 * Best-effort by contract: a failure here must never cost the caller its page
 * load, so it swallows and reports whether it stuck.
 *
 * An unrecognized zone is dropped rather than stored — a client sending
 * garbage must not be able to move where this account's alerts read from.
 */
export async function recordDetectedTimezone(userId: string, tz: unknown): Promise<boolean> {
  const next = normalizeUserTimezone(tz);
  if (next === AUTO_TIMEZONE) return false; // not a zone; nothing to record
  try {
    const row = await prisma.user.findUnique({
      where: { id: userId },
      select: { detectedTimezone: true },
    });
    if (!row || row.detectedTimezone === next) return false;
    await prisma.user.update({ where: { id: userId }, data: { detectedTimezone: next } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Set the caller's own zone. Audited for the same reason the notification
 * preference is: it changes what an operator SEES on a timestamp, so "the
 * email said 03:00 but the chart said 21:00" has to be answerable from the
 * Events tab. Actor is the username — this is always a self-service write.
 */
export async function setUserTimezone(
  userId: string,
  username: string,
  timezone: string,
): Promise<string> {
  const before = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  if (!before) throw new AppError(404, "User not found");
  const previous = normalizeUserTimezone(before.timezone);
  const next = normalizeUserTimezone(timezone);
  if (previous === next) return next;

  await prisma.user.update({ where: { id: userId }, data: { timezone: next } });
  // The recipient index caches the zone alongside each user's tag scope and
  // notification preference; without this the change takes up to the 30s TTL
  // to reach the engine, and the next alert mails the old zone.
  bumpRecipientIndex();

  await logEvent({
    action: "user.timezone.changed",
    resourceType: "user",
    resourceId: userId,
    resourceName: username,
    actor: username,
    level: "info",
    message: `Display timezone changed from ${previous} to ${next}`,
    details: { from: previous, to: next },
  }).catch(() => {});

  return next;
}
