-- Business rule 75: an AlertGroup's `deviceAutomation` fold is redefined from
-- "one alert per device per automation" to BOTH folds at once — one alert for
-- the whole group. Alerts raised under the old meaning (groupKey
-- "grp:<id>|<assetId>/auto:<ruleId>") cannot become members of the new one in
-- place, so they are retired exactly as alertGroupService.retireGroupAlerts
-- does on any refold, and the next engine tick re-raises them in the new shape.
-- Nothing else changes: foldBy keeps its stored value.

UPDATE "notification_rule_states" s
SET "state" = 'clear', "conditionMetSince" = NULL, "recoveredSince" = NULL,
    "notificationId" = NULL, "bandMetSince" = NULL
FROM "notifications" n
JOIN "alert_groups" g ON g."id" = n."alertGroupId"
WHERE s."notificationId" = n."id"
  AND n."cleared" = false
  AND g."foldBy" = 'deviceAutomation';

UPDATE "notifications" n
SET "cleared" = true, "clearedBy" = 'system:group-refolded', "clearedAt" = CURRENT_TIMESTAMP
FROM "alert_groups" g
WHERE g."id" = n."alertGroupId"
  AND n."cleared" = false
  AND g."foldBy" = 'deviceAutomation';
