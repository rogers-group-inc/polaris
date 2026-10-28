-- Business rule 136(e): an automation whose severity follows the Priority tag
-- of the device (monitor status down) or the port (interface oper status down).
-- Off for every existing automation.
ALTER TABLE "notification_rules" ADD COLUMN "severityFromPriorityTag" BOOLEAN NOT NULL DEFAULT false;
