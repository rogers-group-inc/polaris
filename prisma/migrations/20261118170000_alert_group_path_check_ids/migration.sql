-- Business rule 194: an alert group may govern only some path checks.
ALTER TABLE "alert_groups" ADD COLUMN "pathCheckIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
