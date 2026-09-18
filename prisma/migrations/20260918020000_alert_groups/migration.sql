-- Alert groups (business rule 75, second half): a named set of automations
-- whose alerts about ONE device fold into a single alert.
--
-- A group owns DELIVERY -- one set of notify actions, one escalation chain, one
-- reminder cadence, one acknowledge-note policy -- while its member automations
-- own DETECTION and stop delivering on their own while grouped. That split is
-- the only one with a coherent answer: escalation tiers and reminder cadence are
-- per-automation, so an alert raised by three of them otherwise has three
-- answers to "when does this page someone?" and no way to choose.
--
-- Nothing is created here and no automation joins anything, so an install that
-- upgrades has no groups and every alert keeps delivering exactly as it did.
CREATE TABLE IF NOT EXISTS "alert_groups" (
  "id"               TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "description"      TEXT,
  "enabled"          BOOLEAN NOT NULL DEFAULT true,
  "messageTemplate"  TEXT,
  "requireAckNote"   BOOLEAN NOT NULL DEFAULT false,
  "emailComposition" JSONB,
  "actions"          JSONB,
  "resetActions"     JSONB,
  "escalation"       JSONB,
  "repeat"           JSONB,
  "createdBy"        TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "alert_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "alert_groups_name_key" ON "alert_groups" ("name");
CREATE INDEX IF NOT EXISTS "alert_groups_enabled_idx" ON "alert_groups" ("enabled");

-- At most ONE group per automation: a fire has to have a single alert to join.
ALTER TABLE "notification_rules"
  ADD COLUMN IF NOT EXISTS "alertGroupId" TEXT;

-- The group that owns THIS alert's delivery. `ruleId` stays set to the primary
-- contributing rule alongside it -- a null ruleId alert cannot escalate, is
-- invisible to the NOC's relevance-filtered pills and has no name.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "alertGroupId" TEXT;

-- SetNull on both, never Cascade. Deleting a group must not delete the
-- automations (they keep detecting and go back to delivering on their own), and
-- must not delete the alert history it presided over.
DO $$ BEGIN
  ALTER TABLE "notification_rules"
    ADD CONSTRAINT "notification_rules_alertGroupId_fkey"
    FOREIGN KEY ("alertGroupId") REFERENCES "alert_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_alertGroupId_fkey"
    FOREIGN KEY ("alertGroupId") REFERENCES "alert_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The escalation sweep's candidate set widens to "has a rule OR has a group",
-- and the engine resolves a member's alerts through the group; both read these.
CREATE INDEX IF NOT EXISTS "notification_rules_alertGroupId_idx" ON "notification_rules" ("alertGroupId");
CREATE INDEX IF NOT EXISTS "notifications_alertGroupId_idx" ON "notifications" ("alertGroupId");
