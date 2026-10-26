-- Why a device is being rebooted (business rule 115(d)). Free text, optional
-- unless the install turns on Server Settings -> Customization -> Reboots ->
-- "Require a reboot note" (Setting row `rebootConfig`). A booking carries its
-- note onto the run it fires; existing rows simply have none.
ALTER TABLE "reboot_runs" ADD COLUMN "note" TEXT;
ALTER TABLE "reboot_schedules" ADD COLUMN "note" TEXT;
