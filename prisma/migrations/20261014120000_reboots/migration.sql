-- Reboots (business rule 115), 2026-10-13.
--
--   reboot_runs       one reboot of one asset — a FortiGate, a FortiSwitch /
--                     FortiAP (through its controlling FortiGate), or a host
--                     running the Polaris Agent.
--   reboot_schedules  a reboot booked for later (the rule-93 shape).
--   managed_agents    the agent-host opt-in (`rebootEnabled`), what the host
--                     reports it can do (`rebootCapable`), and its boot time.
--
-- The opt-in on stored credentials and on the FortiManager / FortiGate
-- integrations is an `allowReboot` boolean inside their config JSON — no
-- column.

ALTER TABLE "managed_agents" ADD COLUMN "rebootEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "managed_agents" ADD COLUMN "rebootCapable" BOOLEAN;
ALTER TABLE "managed_agents" ADD COLUMN "bootTime" TIMESTAMP(3);

CREATE TABLE "reboot_runs" (
    "id"             TEXT NOT NULL,
    "assetId"        TEXT NOT NULL,
    "method"         TEXT NOT NULL,
    "viaAssetId"     TEXT,
    "credentialId"   TEXT,
    "authority"      TEXT NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'queued',
    "stage"          TEXT,
    "log"            JSONB NOT NULL DEFAULT '[]',
    "error"          TEXT,
    "bootTimeBefore" TIMESTAMP(3),
    "startedBy"      TEXT NOT NULL,
    "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeatAt"    TIMESTAMP(3),
    "finishedAt"     TIMESTAMP(3),

    CONSTRAINT "reboot_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "reboot_runs_assetId_startedAt_idx" ON "reboot_runs"("assetId", "startedAt");
CREATE INDEX "reboot_runs_status_idx" ON "reboot_runs"("status");

ALTER TABLE "reboot_runs"
    ADD CONSTRAINT "reboot_runs_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "reboot_runs"
    ADD CONSTRAINT "reboot_runs_status_check"
    CHECK ("status" IN ('queued', 'sending', 'rebooting', 'succeeded', 'failed', 'unverified'));

-- One live reboot per asset. The service checks first and answers 409; this
-- is what makes two clicks a second apart still produce one reboot.
CREATE UNIQUE INDEX "reboot_runs_active_key"
    ON "reboot_runs"("assetId") WHERE "status" IN ('queued', 'sending', 'rebooting');

CREATE TABLE "reboot_schedules" (
    "id"           TEXT NOT NULL,
    "assetId"      TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "notifyEmails" TEXT[],
    "status"       TEXT NOT NULL DEFAULT 'pending',
    "runId"        TEXT,
    "error"        TEXT,
    "createdBy"    TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy"    TEXT,
    "updatedAt"    TIMESTAMP(3) NOT NULL,
    "cancelledBy"  TEXT,
    "cancelledAt"  TIMESTAMP(3),
    "firedAt"      TIMESTAMP(3),
    "notifiedAt"   TIMESTAMP(3),
    "notifyError"  TEXT,

    CONSTRAINT "reboot_schedules_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "reboot_schedules_runId_key" ON "reboot_schedules"("runId");
CREATE INDEX "reboot_schedules_status_scheduledFor_idx" ON "reboot_schedules"("status", "scheduledFor");
CREATE INDEX "reboot_schedules_assetId_createdAt_idx" ON "reboot_schedules"("assetId", "createdAt");

ALTER TABLE "reboot_schedules"
    ADD CONSTRAINT "reboot_schedules_assetId_fkey"
    FOREIGN KEY ("assetId") REFERENCES "assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "reboot_schedules"
    ADD CONSTRAINT "reboot_schedules_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "reboot_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "reboot_schedules"
    ADD CONSTRAINT "reboot_schedules_status_check"
    CHECK ("status" IN ('pending', 'started', 'cancelled', 'refused', 'missed'));
-- Someone always hears the outcome.
ALTER TABLE "reboot_schedules"
    ADD CONSTRAINT "reboot_schedules_recipients_check"
    CHECK (cardinality("notifyEmails") >= 1);

-- One pending booking per asset.
CREATE UNIQUE INDEX "reboot_schedules_pending_key"
    ON "reboot_schedules"("assetId") WHERE "status" = 'pending';
