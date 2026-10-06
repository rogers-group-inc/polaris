-- Scheduled firmware upgrades (business rule 93), 2026-10-06.
--
--   firmware_upgrade_schedules  a flash booked for a date and time, with the
--                               image approved by name when it was booked and
--                               the addresses that hear the outcome.
--
-- The scheduler job hands a due booking to startFirmwareUpgrade, so every
-- rule-87 gate is re-taken when it fires; a refusal or a late start is
-- recorded on the booking and emailed, never retried.

CREATE TABLE "firmware_upgrade_schedules" (
    "id"           TEXT NOT NULL,
    "assetId"      TEXT NOT NULL,
    "imageId"      TEXT,
    "toVersion"    TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "notifyEmails" TEXT[],
    "status"       TEXT NOT NULL DEFAULT 'pending',
    "runId"        TEXT,
    "error"        TEXT,
    "createdBy"    TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy"    TEXT,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "cancelledBy"  TEXT,
    "cancelledAt"  TIMESTAMP(3),
    "firedAt"      TIMESTAMP(3),
    "notifiedAt"   TIMESTAMP(3),
    "notifyError"  TEXT,

    CONSTRAINT "firmware_upgrade_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "firmware_upgrade_schedules_runId_key" ON "firmware_upgrade_schedules"("runId");
CREATE INDEX "firmware_upgrade_schedules_status_scheduledFor_idx" ON "firmware_upgrade_schedules"("status", "scheduledFor");
CREATE INDEX "firmware_upgrade_schedules_assetId_createdAt_idx" ON "firmware_upgrade_schedules"("assetId", "createdAt");

ALTER TABLE "firmware_upgrade_schedules"
    ADD CONSTRAINT "firmware_upgrade_schedules_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "firmware_upgrade_schedules"
    ADD CONSTRAINT "firmware_upgrade_schedules_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "firmware_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "firmware_upgrade_schedules"
    ADD CONSTRAINT "firmware_upgrade_schedules_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "firmware_upgrade_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "firmware_upgrade_schedules"
    ADD CONSTRAINT "firmware_upgrade_schedules_status_check"
    CHECK ("status" IN ('pending', 'started', 'cancelled', 'refused', 'missed'));
-- Someone always hears the outcome.
ALTER TABLE "firmware_upgrade_schedules"
    ADD CONSTRAINT "firmware_upgrade_schedules_recipients_check"
    CHECK (cardinality("notifyEmails") >= 1);

-- One pending booking per asset. The service checks first and answers 409;
-- this is what makes two bookings a second apart still produce one.
CREATE UNIQUE INDEX "firmware_upgrade_schedules_pending_key"
    ON "firmware_upgrade_schedules"("assetId") WHERE "status" = 'pending';
