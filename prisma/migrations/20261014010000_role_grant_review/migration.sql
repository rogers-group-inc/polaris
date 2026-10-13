-- Business rule 114(i): list the roles the September RBAC migrations may have
-- silently strengthened, for an administrator to review. Nothing is demoted.
--
-- WHAT HAPPENED. `20260922000000_rbac_catalogue_hygiene` and
-- `20260923000000_authentication_function_key` moved routes from `fullwrite`
-- down to `write` on five keys and folded stored `fullwrite` cells down to
-- `write`. Neither touched a cell already stored as `write`, and on those keys
-- that cell's meaning changed underneath it:
--   * serverSettingsSystem — `write` used to gate only the twelve identity-
--     provider routes; it now gates the ~54 routes `fullwrite` used to (HA,
--     agent build / signing / upgrade-all, certificates, proxy, login access).
--   * automationScripts, automationManagement, maintenanceManagement — `write`
--     was a dead rung that granted only read; it is now the key's full grant.
--   * serverSettingsData — `write` granted nothing at all; it is now restore /
--     update / restart.
--
-- WHY NOT DEMOTE. Every install has long since run those migrations, and a
-- role at `write` today is either one of those silent promotions or a grant an
-- administrator made deliberately since. Nothing in the database tells them
-- apart (every later RBAC migration bumped "updatedAt" on every row it
-- touched, and the dead rungs left no fingerprint). Demoting would remove
-- deliberate access; doing nothing would leave the promotions unseen. So each
-- candidate is FLAGGED (grant_review_needed) and logged: the capacity card
-- shows a watch-severity reason naming them until an administrator saves the
-- role's permissions or marks it reviewed.
--
-- Built-in roles are excluded (their matrices are shipped and reviewed in
-- code), and so are admin-equivalent roles (users = roles = fullwrite), which
-- already reach everything these keys gate.
ALTER TABLE "roles" ADD COLUMN "grant_review_needed" BOOLEAN NOT NULL DEFAULT false;

UPDATE "roles"
   SET "grant_review_needed" = true
 WHERE NOT "is_built_in"
   AND NOT (COALESCE("permissions" ->> 'users', '') = 'fullwrite' AND COALESCE("permissions" ->> 'roles', '') = 'fullwrite')
   AND (   "permissions" ->> 'serverSettingsSystem'  = 'write'
        OR "permissions" ->> 'automationScripts'     = 'write'
        OR "permissions" ->> 'serverSettingsData'    = 'write'
        OR "permissions" ->> 'automationManagement'  = 'write'
        OR "permissions" ->> 'maintenanceManagement' = 'write');

-- One warning Event per flagged role, naming the keys that need a look.
INSERT INTO "events" ("id", "timestamp", "level", "levelRank", "action", "resourceType", "resourceId", "resourceName", "actor", "message", "details")
SELECT gen_random_uuid()::text,
       CURRENT_TIMESTAMP,
       'warning',
       1,
       'role.grant_review_needed',
       'role',
       r."id",
       r."name",
       'system:migration',
       'Role "' || r."name" || '" holds Read-Write on ' ||
         array_to_string(ARRAY(
           SELECT k FROM unnest(ARRAY['serverSettingsSystem', 'automationScripts', 'serverSettingsData', 'automationManagement', 'maintenanceManagement']) AS k
            WHERE r."permissions" ->> k = 'write'), ', ') ||
         ', which the September 2026 permission update made a stronger grant than it used to be. Review the role and save it (or mark it reviewed) to confirm the access is intended.',
       jsonb_build_object('keys', to_jsonb(ARRAY(
           SELECT k FROM unnest(ARRAY['serverSettingsSystem', 'automationScripts', 'serverSettingsData', 'automationManagement', 'maintenanceManagement']) AS k
            WHERE r."permissions" ->> k = 'write')))
  FROM "roles" r
 WHERE r."grant_review_needed";
