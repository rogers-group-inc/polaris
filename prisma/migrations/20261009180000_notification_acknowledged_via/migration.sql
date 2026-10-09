-- Business rule 78a, 2026-10-09: a dependency-down alert inherits the
-- acknowledgement of its root cause's own down alert.
--
--   notifications."acknowledgedVia"   { notificationId, assetId, hostname } of the
--                                     root-cause alert whose acknowledgement this
--                                     one inherited; NULL on a direct acknowledge.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "acknowledgedVia" JSONB;
