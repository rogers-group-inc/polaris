-- Business rule 170: the NTP settings are retired. Nothing ever applied the
-- server list, mode or enable flag to the host (its own time service keeps the
-- clock), so they are dropped. The one field kept is the timezone override,
-- which moves to its own "timezone" setting and is now applied to Polaris's
-- server-local clock in every role.
INSERT INTO "settings" ("key", "value", "updatedAt")
SELECT 'timezone',
       jsonb_build_object('override', NULLIF(btrim("value"->>'timezoneOverride'), '')),
       now()
  FROM "settings"
 WHERE "key" = 'ntp'
   AND NULLIF(btrim("value"->>'timezoneOverride'), '') IS NOT NULL
ON CONFLICT ("key") DO NOTHING;

DELETE FROM "settings" WHERE "key" = 'ntp';
