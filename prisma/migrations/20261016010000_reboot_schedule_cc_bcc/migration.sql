-- Cc / Bcc on a booked reboot's results email (business rule 115(c)): an
-- automation's reboot action now names its results recipients with the notify
-- action's To / Cc / Bcc vocabulary, resolved to addresses when it fires.
-- Operator bookings leave both empty and keep the per-recipient fan-out.
ALTER TABLE "reboot_schedules"
    ADD COLUMN "notifyCc" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "notifyBcc" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
