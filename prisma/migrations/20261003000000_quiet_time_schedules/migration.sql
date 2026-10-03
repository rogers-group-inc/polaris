-- Quiet time that HOLDS alerts and reports them (business rule 92).
--
-- Until now quiet time lived inside a notify action's `repeat` config and only
-- paused REMINDERS (business rule 44): the first alert, the escalation tiers
-- and the all-clears paged whatever the hour. From here a quiet window — a
-- global QuietTimeSchedule row, or an automation's own `quietTime` — withholds
-- every people-facing send of an alert that fires inside it, and a summary
-- email of what is still outstanding goes out when the window ends.
--
-- Every default below means "no quiet time": an install with no schedule and
-- no automation-level config reads byte-identically after this migration. The
-- one behavioural change is carried by the migrateRepeatQuietToQuietTime
-- one-shot job, which promotes existing per-action `repeat.quiet` windows into
-- `notification_rules.quietTime` (so they now hold sends, not just reminders) —
-- the operator asked for exactly that, and the job writes an Event per
-- automation it converts.

-- A global quiet-time schedule. Automations → Settings → Global Quiet Times.
CREATE TABLE IF NOT EXISTS "quiet_time_schedules" (
  "id"        TEXT         NOT NULL,
  "name"      TEXT         NOT NULL,
  "enabled"   BOOLEAN      NOT NULL DEFAULT true,
  "scope"     JSONB        NOT NULL DEFAULT '{}',
  "quiet"     JSONB        NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "quiet_time_schedules_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "quiet_time_schedules_enabled_idx" ON "quiet_time_schedules" ("enabled");

-- One summary run: the alerts one source's window held, and the per-recipient
-- sends that reported them. Not NotificationDelivery rows — a summary has no
-- notification behind it for the drain to render.
CREATE TABLE IF NOT EXISTS "quiet_time_summaries" (
  "id"              TEXT         NOT NULL,
  "sourceKind"      TEXT         NOT NULL,
  "sourceId"        TEXT         NOT NULL,
  "sourceName"      TEXT         NOT NULL,
  "coveredFrom"     TIMESTAMP(3) NOT NULL,
  "coveredTo"       TIMESTAMP(3) NOT NULL,
  "notificationIds" TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
  "listedCount"     INTEGER      NOT NULL DEFAULT 0,
  "recurringCount"  INTEGER      NOT NULL DEFAULT 0,
  "details"         JSONB        NOT NULL DEFAULT '{}',
  "recipients"      JSONB        NOT NULL DEFAULT '[]',
  "channelId"       TEXT,
  "status"          TEXT         NOT NULL DEFAULT 'pending',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt"          TIMESTAMP(3),
  CONSTRAINT "quiet_time_summaries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "quiet_time_summaries_status_idx" ON "quiet_time_summaries" ("status");
CREATE INDEX IF NOT EXISTS "quiet_time_summaries_createdAt_idx" ON "quiet_time_summaries" ("createdAt");

-- An automation's own quiet time. NULL = the global schedules apply.
ALTER TABLE "notification_rules"
  ADD COLUMN IF NOT EXISTS "quietTime" JSONB;

-- What held an alert, and whether its summary has gone out.
ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "quietHeldAt"       TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "quietSummarizedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "quietSource"       JSONB;

-- The summary job's one query per tick: "which held alerts still owe a
-- summary?". PARTIAL on purpose — the set is tiny (one quiet night's worth)
-- against a table that keeps every alert ever raised, and an alert whose
-- summary went out leaves it. Prisma cannot express a partial index, so this
-- lives in the migration SQL alone and a schema diff reports it as drift
-- forever; that is expected (same posture as notifications_group_key_live).
CREATE INDEX IF NOT EXISTS "notifications_quiet_pending"
  ON "notifications" ("quietHeldAt")
  WHERE "quietHeldAt" IS NOT NULL AND "quietSummarizedAt" IS NULL;
