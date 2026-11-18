-- Business rule 193: an alert group may require a percent of its fold to be failing
-- before an alert opens. NULL = off. Range (1-100) is enforced by the API.
ALTER TABLE "alert_groups" ADD COLUMN "minFailingPercent" INTEGER;
