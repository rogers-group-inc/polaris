-- Firmware upgrade emails for a flash started now (business rule 93), 2026-11-09.
--
--   notifyEmails  who hears that the run started and how it ended; empty = no
--                 email. A booked run carries its booking's recipients (the
--                 started notice); its outcome is the booking's results email.
--   notifiedAt    a click-to-run run's results email, claimed before sending so
--                 the runner and the boot sweep cannot both send it.
--   notifyError   why that email could not be sent.
--
-- Additive; existing runs get an empty list and send nothing.

ALTER TABLE "firmware_upgrade_runs"
    ADD COLUMN "notifyEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "notifiedAt"   TIMESTAMP(3),
    ADD COLUMN "notifyError"  TEXT;
