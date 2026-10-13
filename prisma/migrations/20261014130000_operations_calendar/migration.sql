-- The Events page's Calendar tab (operationsCalendarService) reads reboot and
-- firmware bookings by scheduledFor and runs by startedAt across the whole
-- fleet. The existing indexes lead with status or assetId, so a date-range
-- read over every asset had none to use.
CREATE INDEX "reboot_schedules_scheduledFor_idx" ON "reboot_schedules"("scheduledFor");
CREATE INDEX "reboot_runs_startedAt_idx" ON "reboot_runs"("startedAt");
CREATE INDEX "firmware_upgrade_schedules_scheduledFor_idx" ON "firmware_upgrade_schedules"("scheduledFor");
CREATE INDEX "firmware_upgrade_runs_startedAt_idx" ON "firmware_upgrade_runs"("startedAt");
