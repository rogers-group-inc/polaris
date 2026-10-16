-- Group firmware upgrades (business rule 122), 2026-10-16.
--
--   firmware_group_schedules  one booking that flashes a controlling FortiGate
--                             and the FortiSwitches / FortiAPs behind it in
--                             dependency order (deepest first).
--   firmware_group_members    one row per selected device — the ones that will
--                             be flashed and the ones dropped at booking, each
--                             with its topology snapshot and its outcome.
--
-- Each member's flash is an ordinary firmware_upgrade_runs row (rule 87); the
-- group executor in services/firmwareGroupService.ts starts them.

CREATE TABLE "firmware_group_schedules" (
    "id"            TEXT NOT NULL,
    "gateAssetId"   TEXT NOT NULL,
    "integrationId" TEXT,
    "scheduledFor"  TIMESTAMP(3) NOT NULL,
    "concurrency"   INTEGER NOT NULL DEFAULT 1,
    "notifyEmails"  TEXT[],
    "status"        TEXT NOT NULL DEFAULT 'pending',
    "error"         TEXT,
    "createdBy"     TEXT NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy"     TEXT,
    "updatedAt"     TIMESTAMP(3) NOT NULL,
    "cancelledBy"   TEXT,
    "cancelledAt"   TIMESTAMP(3),
    "firedAt"       TIMESTAMP(3),
    "finishedAt"    TIMESTAMP(3),
    "notifiedAt"    TIMESTAMP(3),
    "notifyError"   TEXT,

    CONSTRAINT "firmware_group_schedules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "firmware_group_schedules_status_scheduledFor_idx" ON "firmware_group_schedules"("status", "scheduledFor");
CREATE INDEX "firmware_group_schedules_gateAssetId_createdAt_idx" ON "firmware_group_schedules"("gateAssetId", "createdAt");
CREATE INDEX "firmware_group_schedules_scheduledFor_idx" ON "firmware_group_schedules"("scheduledFor");

ALTER TABLE "firmware_group_schedules"
    ADD CONSTRAINT "firmware_group_schedules_gateAssetId_fkey"
    FOREIGN KEY ("gateAssetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "firmware_group_schedules"
    ADD CONSTRAINT "firmware_group_schedules_status_check"
    CHECK ("status" IN ('pending', 'running', 'completed', 'cancelled', 'missed', 'refused'));
ALTER TABLE "firmware_group_schedules"
    ADD CONSTRAINT "firmware_group_schedules_concurrency_check"
    CHECK ("concurrency" BETWEEN 1 AND 10);
-- Someone always hears the outcome.
ALTER TABLE "firmware_group_schedules"
    ADD CONSTRAINT "firmware_group_schedules_recipients_check"
    CHECK (cardinality("notifyEmails") >= 1);

-- One pending or running group per controlling FortiGate. The service checks
-- first and answers 409; this is what makes two bookings a second apart still
-- produce one.
CREATE UNIQUE INDEX "firmware_group_schedules_active_key"
    ON "firmware_group_schedules"("gateAssetId") WHERE "status" IN ('pending', 'running');

CREATE TABLE "firmware_group_members" (
    "id"           TEXT NOT NULL,
    "groupId"      TEXT NOT NULL,
    "assetId"      TEXT NOT NULL,
    "imageId"      TEXT,
    "fromVersion"  TEXT,
    "toVersion"    TEXT,
    "depth"        INTEGER NOT NULL DEFAULT 1,
    "ancestorIds"  TEXT[],
    "mclagPeerIds" TEXT[],
    "state"        TEXT NOT NULL DEFAULT 'planned',
    "skipKind"     TEXT,
    "detail"       TEXT,
    "runId"        TEXT,
    "eligibleAt"   TIMESTAMP(3),
    "startedAt"    TIMESTAMP(3),
    "finishedAt"   TIMESTAMP(3),

    CONSTRAINT "firmware_group_members_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "firmware_group_members_runId_key" ON "firmware_group_members"("runId");
CREATE UNIQUE INDEX "firmware_group_members_groupId_assetId_key" ON "firmware_group_members"("groupId", "assetId");
CREATE INDEX "firmware_group_members_assetId_state_idx" ON "firmware_group_members"("assetId", "state");

ALTER TABLE "firmware_group_members"
    ADD CONSTRAINT "firmware_group_members_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "firmware_group_schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "firmware_group_members"
    ADD CONSTRAINT "firmware_group_members_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "firmware_group_members"
    ADD CONSTRAINT "firmware_group_members_imageId_fkey"
    FOREIGN KEY ("imageId") REFERENCES "firmware_images"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "firmware_group_members"
    ADD CONSTRAINT "firmware_group_members_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "firmware_upgrade_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "firmware_group_members"
    ADD CONSTRAINT "firmware_group_members_state_check"
    CHECK ("state" IN ('planned', 'waiting', 'running', 'upgraded', 'already-current', 'failed', 'unverified', 'skipped', 'dropped'));
ALTER TABLE "firmware_group_members"
    ADD CONSTRAINT "firmware_group_members_skip_kind_check"
    CHECK (("state" = 'skipped') = ("skipKind" IS NOT NULL)
       AND ("skipKind" IS NULL OR "skipKind" IN ('health', 'subtree', 'cancelled', 'timeout')));
