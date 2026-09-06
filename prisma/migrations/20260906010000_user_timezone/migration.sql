-- Per-user display timezone.
--
-- "auto" (the default, and what every existing row backfills to) means "resolve
-- it at render time". In the browser that is the browser's own zone; on a
-- surface with no browser (an alert email) it is `detected_timezone` if this
-- account has ever signed in on one, and the server's zone otherwise. The
-- pre-column behaviour was the server's zone unconditionally, so an install
-- upgrades to strictly better answers and never a worse one.
--
-- TEXT rather than an enum on purpose: the IANA tz database adds and retires
-- zone names independently of this schema, and a name this build's ICU cannot
-- resolve is normalized back to "auto" on read (normalizeUserTimezone) instead
-- of failing a page render or an outbound send.
ALTER TABLE "users" ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'auto';

-- The zone this account's browser last reported. Client-reported on boot, never
-- operator-set, never offered as a choice — it is what lets "auto" mean the
-- OPERATOR's wall clock in an email instead of the server's. Nullable because
-- an account that has never signed in on a browser (a service account on a
-- distribution list) has no browser to have reported one.
ALTER TABLE "users" ADD COLUMN "detected_timezone" TEXT;
