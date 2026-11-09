-- Reboot emails for a reboot started now (business rule 115, the rule-93 shape), 2026-11-09.
--
--   notifyEmails  who hears that the reboot was sent and how it ended; empty =
--                 no email. Always empty on a booked run — the booking holds
--                 its recipients.
--   notifiedAt    the results email, claimed before sending so the runner and
--                 the boot sweep cannot both send it.
--   notifyError   why that email could not be sent.
--
-- Additive; existing runs get an empty list and send nothing.

ALTER TABLE "reboot_runs"
    ADD COLUMN "notifyEmails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "notifiedAt"   TIMESTAMP(3),
    ADD COLUMN "notifyError"  TEXT;
