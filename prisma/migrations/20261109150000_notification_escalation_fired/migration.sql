-- Business rule 145: which escalation tiers have sent for an alert (survives
-- band changes and re-opens), and the highest tier + first-escalation time
-- behind the ESCALATED pill.
ALTER TABLE "notifications" ADD COLUMN "escalationFired" JSONB;
ALTER TABLE "notifications" ADD COLUMN "escalationTier" INTEGER;
ALTER TABLE "notifications" ADD COLUMN "escalatedAt" TIMESTAMP(3);
