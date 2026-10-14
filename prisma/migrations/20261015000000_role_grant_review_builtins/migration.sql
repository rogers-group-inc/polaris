-- Business rule 114(i), extended (2026-10-13 re-scan F71): the EDITABLE
-- built-in roles get the same review flag custom roles got in
-- 20261014010000_role_grant_review. Nothing is demoted.
--
-- That migration skipped every built-in role on the grounds that their
-- matrices are "shipped and reviewed in code". The protected two (admin,
-- readonly) are; networkadmin, assetsadmin and user are editable, so an
-- administrator could have set one of the five keys to `write` back when that
-- rung was dead (read-only, or nothing) and had it silently turn into the
-- key's full grant by the September permission update — Automation Scripts is
-- remote code execution, Server Settings → Data is restore.
--
-- A cell is flagged only where it is `write` AND differs from what that
-- built-in ships with today, so an untouched built-in is never flagged. The
-- shipped values (read off a freshly migrated database, 2026-10-13):
--
--                 serverSettingsSystem automationScripts serverSettingsData automationManagement maintenanceManagement
--   networkadmin  none                 none              none               read                 write
--   assetsadmin   none                 none              none               write                write
--   user          none                 none              none               read                 read
--
-- Same mechanism as before: grant_review_needed, a warning Event per role,
-- the capacity card's watch reason, cleared by saving the role's permissions
-- or POST /roles/:id/grant-review. Admin-equivalent roles stay excluded.

WITH shipped(name, k, v) AS (
  VALUES
    ('networkadmin', 'serverSettingsSystem', 'none'), ('networkadmin', 'automationScripts', 'none'),
    ('networkadmin', 'serverSettingsData', 'none'),   ('networkadmin', 'automationManagement', 'read'),
    ('networkadmin', 'maintenanceManagement', 'write'),
    ('assetsadmin', 'serverSettingsSystem', 'none'),  ('assetsadmin', 'automationScripts', 'none'),
    ('assetsadmin', 'serverSettingsData', 'none'),    ('assetsadmin', 'automationManagement', 'write'),
    ('assetsadmin', 'maintenanceManagement', 'write'),
    ('user', 'serverSettingsSystem', 'none'),         ('user', 'automationScripts', 'none'),
    ('user', 'serverSettingsData', 'none'),           ('user', 'automationManagement', 'read'),
    ('user', 'maintenanceManagement', 'read')
),
drifted AS (
  SELECT r."id", array_agg(s.k ORDER BY s.k) AS keys
    FROM "roles" r
    JOIN shipped s ON s.name = r."name"
   WHERE r."is_built_in"
     AND NOT r."is_protected"
     AND NOT (COALESCE(r."permissions" ->> 'users', '') = 'fullwrite' AND COALESCE(r."permissions" ->> 'roles', '') = 'fullwrite')
     AND r."permissions" ->> s.k = 'write'
     AND s.v <> 'write'
   GROUP BY r."id"
),
flagged AS (
  UPDATE "roles" r
     SET "grant_review_needed" = true
    FROM drifted d
   WHERE r."id" = d."id"
     AND NOT r."grant_review_needed"
  RETURNING r."id", r."name", d.keys
)
INSERT INTO "events" ("id", "timestamp", "level", "levelRank", "action", "resourceType", "resourceId", "resourceName", "actor", "message", "details")
SELECT gen_random_uuid()::text,
       CURRENT_TIMESTAMP,
       'warning',
       1,
       'role.grant_review_needed',
       'role',
       f."id",
       f."name",
       'system:migration',
       'Built-in role "' || f."name" || '" holds Read-Write on ' || array_to_string(f.keys, ', ') ||
         ', which it does not ship with and which the September 2026 permission update made a stronger grant than it used to be. Review the role and save it (or mark it reviewed) to confirm the access is intended.',
       jsonb_build_object('keys', to_jsonb(f.keys), 'builtIn', true)
  FROM flagged f;
