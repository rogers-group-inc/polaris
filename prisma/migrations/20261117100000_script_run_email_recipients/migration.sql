-- Business rule 190(a): a script action's email block uses the notify action's channel
-- checklist and To / Cc / Bcc. The run snapshots every channel and all three resolved lists.
ALTER TABLE "automation_script_runs" ADD COLUMN "emailChannelIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "automation_script_runs" SET "emailChannelIds" = ARRAY["emailChannelId"] WHERE "emailChannelId" IS NOT NULL;
ALTER TABLE "automation_script_runs" DROP COLUMN "emailChannelId";
ALTER TABLE "automation_script_runs" ADD COLUMN "emailCc" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "automation_script_runs" ADD COLUMN "emailBcc" TEXT[] DEFAULT ARRAY[]::TEXT[];
