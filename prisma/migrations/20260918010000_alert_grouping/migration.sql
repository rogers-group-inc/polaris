-- Grouped alerts (business rule 75): one alert may name many parts of one
-- device, and it ends only when the last of them does.
--
-- A CONTRIBUTION is (automation, component) on an asset. The per-(rule, asset,
-- dimension) state machine is UNCHANGED -- every hold, band, hysteresis, poll
-- count and pin gate still runs per contribution. Only the notification row is
-- shared: many firing `notification_rule_states` rows point at one of them.
--
-- Every default below means "a row that never grouped", so every existing rule
-- and every existing alert reads byte-identically after this migration. Nothing
-- is backfilled and nothing changes behaviour until an operator ticks the box.
ALTER TABLE "notification_rules"
  ADD COLUMN IF NOT EXISTS "groupByAsset" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "groupKey" TEXT,
  ADD COLUMN IF NOT EXISTS "members" JSONB,
  ADD COLUMN IF NOT EXISTS "dimensionCount" INTEGER;

-- One LIVE alert per group key. PARTIAL on purpose: a cleared alert must
-- release the key so the next episode can open its own row, and an alert that
-- never grouped carries a NULL key and is not constrained at all.
--
-- Prisma cannot express a partial unique index, so this lives in the migration
-- SQL alone and a schema diff will report it as drift forever. That is
-- expected -- do NOT "resolve" the drift by dropping it. It is the correctness
-- boundary behind the engine's P2002-catch-and-join: whatever races (an
-- overlapping tick, a retried job), the database refuses the second live row
-- and the loser joins the winner instead of opening a duplicate alert.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_group_key_live"
  ON "notifications" ("groupKey")
  WHERE "groupKey" IS NOT NULL AND "cleared" = false;

-- Every recovery on a grouped alert asks "is any OTHER state row still firing
-- against this notification?" before it may end the alert. Recovery is a
-- transition, so this is not a per-tick cost -- but it is per transition, and
-- at 2000 assets a sequential scan of the state table would not do.
CREATE INDEX IF NOT EXISTS "notification_rule_states_notificationId_idx"
  ON "notification_rule_states" ("notificationId");
