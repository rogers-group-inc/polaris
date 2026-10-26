-- Release rule-state rows stranded behind an alert an operator cleared by hand.
--
-- Until this release, clearNotifications soft-cleared the alert but left its
-- NotificationRuleState row `firing`. The engine reads a firing row whose
-- condition still holds as "already raised", so a device cleared by hand while
-- still down never alerted again until it recovered on its own. The service now
-- releases the row on every clear; this frees the rows already stuck, so a
-- condition that still holds re-earns its debounce and raises a NEW alert on
-- the next tick.
--
-- A firing row pointing at a CLEARED notification is never a legitimate state:
-- every engine path that ends an alert releases (or deletes) its rows in the
-- same pass. Same reset as notificationService's RELEASED_RULE_STATE.
UPDATE "notification_rule_states" s
SET "state" = 'clear',
    "conditionMetSince" = NULL,
    "recoveredSince" = NULL,
    "notificationId" = NULL,
    "bandMetSince" = NULL,
    "metRun" = 0,
    "clearRun" = 0,
    "lastReadingAt" = NULL
FROM "notifications" n
WHERE s."notificationId" = n."id"
  AND s."state" = 'firing'
  AND n."cleared" = true;
