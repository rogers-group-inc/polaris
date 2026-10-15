-- A grouped alert holds its first send for one polling interval (business rule 75).
ALTER TABLE "notifications" ADD COLUMN "firstSendDueAt" TIMESTAMP(3);
ALTER TABLE "notifications" ADD COLUMN "firstSentAt" TIMESTAMP(3);

-- The release pass asks for live alerts still owed their first send.
CREATE INDEX "notifications_first_send_held" ON "notifications" ("firstSendDueAt") WHERE "firstSentAt" IS NULL AND "cleared" = false AND "firstSendDueAt" IS NOT NULL;
