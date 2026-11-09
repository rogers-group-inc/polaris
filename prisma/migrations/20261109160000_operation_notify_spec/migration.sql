-- Upgrade / reboot notifications built with the automations' To / Cc / Bcc
-- picker and sent on chosen email channels (business rules 93 / 115(e)),
-- 2026-11-09.
--
--   notifyRecipients  the picker's spec (users, addresses, roles, regions,
--                     tags, the device's dynamic recipients; Cc / Bcc),
--                     resolved at each send. NULL = only notifyEmails.
--   notifyChannelIds  the email channels it goes out on; empty = the oldest
--                     enabled email channel (the behaviour before this).
--
-- On the four tables that send these emails. notifyEmails stays: it is the To
-- as resolved when the spec was saved, what the booking CHECK counts and what
-- a send falls back to.
--
-- users.last_*_notify replaces the plain address lists added earlier today
-- (20261109140000_user_last_notify_emails); an existing list is carried over
-- as typed addresses on the default channel.

ALTER TABLE "firmware_upgrade_schedules"
    ADD COLUMN "notifyRecipients" JSONB,
    ADD COLUMN "notifyChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "firmware_upgrade_runs"
    ADD COLUMN "notifyRecipients" JSONB,
    ADD COLUMN "notifyChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "reboot_schedules"
    ADD COLUMN "notifyRecipients" JSONB,
    ADD COLUMN "notifyChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "reboot_runs"
    ADD COLUMN "notifyRecipients" JSONB,
    ADD COLUMN "notifyChannelIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "users"
    ADD COLUMN "last_firmware_notify" JSONB,
    ADD COLUMN "last_reboot_notify"   JSONB;

UPDATE "users"
   SET "last_firmware_notify" = jsonb_build_object('to', jsonb_build_object('addresses', to_jsonb("last_firmware_notify_emails")), 'channelIds', '[]'::jsonb)
 WHERE cardinality("last_firmware_notify_emails") > 0;

UPDATE "users"
   SET "last_reboot_notify" = jsonb_build_object('to', jsonb_build_object('addresses', to_jsonb("last_reboot_notify_emails")), 'channelIds', '[]'::jsonb)
 WHERE cardinality("last_reboot_notify_emails") > 0;

ALTER TABLE "users"
    DROP COLUMN "last_firmware_notify_emails",
    DROP COLUMN "last_reboot_notify_emails";
