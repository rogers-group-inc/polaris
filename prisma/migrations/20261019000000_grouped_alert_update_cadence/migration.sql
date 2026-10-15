-- A grouped alert's updates go at most once per polling interval (business rule 75).
ALTER TABLE "notifications" ADD COLUMN "sendIntervalSec" INTEGER;
ALTER TABLE "notifications" ADD COLUMN "pendingChanges" JSONB;
ALTER TABLE "notifications" ADD COLUMN "nextUpdateDueAt" TIMESTAMP(3);

-- The release pass asks for live alerts with changes waiting to be sent.
CREATE INDEX "notifications_group_update_due" ON "notifications" ("nextUpdateDueAt") WHERE "pendingChanges" IS NOT NULL AND "cleared" = false;
