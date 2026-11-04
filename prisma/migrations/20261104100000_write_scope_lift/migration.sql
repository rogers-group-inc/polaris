-- Write scope, release 2 (business rule 141 (e)): Read-Write on the asset-side
-- keys now reaches only the records the caller OWNS (`createdBy` = the actor)
-- or that CARRY one of the caller's tags; Full Read-Write reaches every record.
-- 2026-11-04.
--
-- That changes what a stored `write` means on seven keys. A role that held
-- `write` yesterday could edit, quarantine, acknowledge, schedule, resolve,
-- snooze or lay out ANY record; under the new rule the same stored level
-- would reach only owned or tagged rows — on most installs, where no one has
-- tags and integration discovery owns nothing, that is nothing at all. So
-- every stored `write` on these keys is LIFTED to `fullwrite`: nobody narrows
-- on update day, and an administrator opts a role into the own-or-tags model
-- by lowering it to Read-Write and assigning tags. Lift only — a `read`,
-- `none` or already-`fullwrite` row is untouched.
--
-- Safe on old code: the dangerous acts that used to ride these keys' Full
-- Read-Write rung (merge, agent deploy, clear) moved to their own keys in
-- release 1 (20261103170000_dangerous_act_keys, rule 141 (a)), so a process
-- still running release 1 reads a lifted `fullwrite` as nothing more than
-- "every record" — which is what `write` meant to it already. The one thing
-- it gains is ownerless saved-filter housekeeping (rule 140), accepted.
--
-- `subnets` and `reservations` are NOT lifted: their Read-Write already meant
-- own rows, and release 2 only widens it with the tag extension.
--
-- The catalogue widens the five UP_TO_WRITE ladders (assetsQuarantine,
-- maintenanceManagement, discoveryConflicts, staleReservations, deviceMap) to
-- all four rungs in the same commit; without that `normalizePermissions`
-- would clamp the lifted value back to `write` on the next role save.
--
-- Idiom: ONE correlated jsonb_object_agg over the key list per row (never
-- `UPDATE … FROM (VALUES …)`, which applies one matching row and silently
-- drops the rest); `updatedAt` bumped so the role-version cache refetches
-- after the restart the updater performs.

UPDATE "roles" r
   SET "permissions" = r."permissions" || (
         SELECT COALESCE(jsonb_object_agg(k, '"fullwrite"'::jsonb), '{}'::jsonb)
           FROM unnest(ARRAY[
                  'assets', 'assetsQuarantine', 'alerts', 'maintenanceManagement',
                  'discoveryConflicts', 'staleReservations', 'deviceMap'
                ]) AS k
          WHERE r."permissions" ->> k = 'write'
       ),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
                  'assets', 'assetsQuarantine', 'alerts', 'maintenanceManagement',
                  'discoveryConflicts', 'staleReservations', 'deviceMap'
                ]) AS k
          WHERE r."permissions" ->> k = 'write'
       );
