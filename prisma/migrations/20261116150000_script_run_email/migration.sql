-- Business rule 190: a server automation script may send email through the action's own
-- Polaris channel to the addresses snapshot here, using a single-use pass held as a hash.
ALTER TABLE "automation_script_runs" ADD COLUMN "emailChannelId" TEXT;
ALTER TABLE "automation_script_runs" ADD COLUMN "emailTo" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "automation_script_runs" ADD COLUMN "emailTokenHash" TEXT;
ALTER TABLE "automation_script_runs" ADD COLUMN "emailTokenIssuedAt" TIMESTAMP(3);
ALTER TABLE "automation_script_runs" ADD COLUMN "emailsSent" INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX "automation_script_runs_emailTokenHash_key" ON "automation_script_runs"("emailTokenHash");
