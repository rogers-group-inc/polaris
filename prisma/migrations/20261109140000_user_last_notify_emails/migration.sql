-- The email list each user last sent a firmware upgrade's or a reboot's
-- notifications to (business rules 93 / 115(e)), 2026-11-09 — what their next
-- upgrade or reboot dialog pre-fills, ahead of their own profile address.
--
-- Additive; existing users get empty lists and keep the old pre-fill.

ALTER TABLE "users"
    ADD COLUMN "last_firmware_notify_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "last_reboot_notify_emails"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
