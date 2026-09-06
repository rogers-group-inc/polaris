/**
 * src/api/routes/userTimezone.ts
 *
 * The caller's OWN display timezone — the zone this account wants times
 * rendered in, across the UI and its own alert emails.
 *
 *   GET /me/timezone → { timezone, serverTimezone, options }
 *   PUT /me/timezone → { timezone }
 *
 * A `/me/*` route, sibling to /me/dashboard, /me/table-tabs and
 * /me/notification-preference: strictly per-caller, never addressable for
 * another user, no admin surface.
 *
 * NO `requirePermission` gate, unlike /me/notification-preference — the
 * table-tabs precedent rather than the alerts one. Choosing what zone a
 * timestamp is drawn in changes nothing about WHICH data an account can reach;
 * it is the operator's own view of rows they can already see, so gating it on
 * any function key would leave some legitimate signed-in user unable to fix
 * their own clock. The global requireAuth in router.ts is the whole gate.
 *
 * `serverTimezone` rides the GET so the picker can label the "auto" option
 * with what it will actually mean in an email ("Automatic — browser; emails
 * use America/Chicago") instead of describing it abstractly. `options` rides
 * it for the same reason the preference route sends its labels: the desktop
 * and mobile clients render one server-supplied vocabulary rather than each
 * shipping a divergent zone list.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../utils/errors.js";
import {
  AUTO_TIMEZONE,
  getUserTimezone,
  isValidTimeZone,
  listTimeZones,
  recordDetectedTimezone,
  serverTimeZone,
  setUserTimezone,
} from "../../services/userTimezoneService.js";

const router = Router();

// Strict, unlike the service's lenient read-side normalizer: a client PUTting
// a zone this build cannot format in gets a 400 telling it so, rather than a
// 200 that silently stored "auto" and left the operator wondering why their
// choice didn't stick.
const bodySchema = z.object({
  timezone: z
    .string()
    .trim()
    .refine((t) => t === AUTO_TIMEZONE || isValidTimeZone(t), {
      message: "Unrecognized IANA timezone",
    }),
});

router.get("/", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    res.json({
      timezone: await getUserTimezone(userId),
      serverTimezone: serverTimeZone(),
      options: listTimeZones(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /me/timezone/detected — the caller's BROWSER zone, reported on boot.
 *
 * Not a preference and never shown as one: it is what lets the "auto" default
 * mean the operator's own wall clock in an alert email, which has no browser to
 * ask. Separate from the PUT so the two can never be confused — a client
 * reporting where it is must not be able to overwrite a choice the operator
 * made deliberately.
 *
 * Always 200, even when nothing was stored: this fires on every page load and
 * a failure here must never surface as a broken boot. `recorded` says whether
 * the value actually changed anything, which is the only thing a caller could
 * act on and is mostly useful in tests.
 */
router.post("/detected", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    const { timezone } = z.object({ timezone: z.string().trim() }).parse(req.body);
    res.json({ recorded: await recordDetectedTimezone(userId, timezone) });
  } catch (err) {
    next(err);
  }
});

router.put("/", async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) throw new AppError(401, "Not authenticated");
    const { timezone } = bodySchema.parse(req.body);
    res.json({
      timezone: await setUserTimezone(userId, req.session?.username ?? "unknown", timezone),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
