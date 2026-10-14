-- Business rule 118: a heavy stream's "last polled" stamp is split into the
-- last ATTEMPT (the scheduler's due anchor) and the last SUCCESS (what the UI
-- reads), plus the start and the message of the current failure run.
--
-- Until now lastTelemetryAt advanced on every attempt, failures included, so a
-- device whose CPU / memory pull failed every time still read "updated 1m ago"
-- over an empty chart and its stale banner never fired; lastSystemInfoAt
-- advanced only on success, so the banner worked but a failing device was
-- re-polled on every heavy tick instead of once per cadence.
--
-- Nullable adds on a plain table: no rewrite. The attempt stamps are seeded
-- from the existing anchors so nothing becomes due all at once on upgrade.

ALTER TABLE "assets"
  ADD COLUMN "lastTelemetryAttemptAt"  TIMESTAMP(3),
  ADD COLUMN "telemetryFailingSince"   TIMESTAMP(3),
  ADD COLUMN "telemetryLastError"      TEXT,
  ADD COLUMN "lastSystemInfoAttemptAt" TIMESTAMP(3),
  ADD COLUMN "systemInfoFailingSince"  TIMESTAMP(3),
  ADD COLUMN "systemInfoLastError"     TEXT;

UPDATE "assets"
   SET "lastTelemetryAttemptAt"  = "lastTelemetryAt",
       "lastSystemInfoAttemptAt" = "lastSystemInfoAt"
 WHERE "lastTelemetryAt" IS NOT NULL OR "lastSystemInfoAt" IS NOT NULL;
