-- RBAC catalogue hygiene, 2026-09-22. Four independent changes to the stored
-- role matrix. None of them grants anybody anything they could not already do;
-- the first three take away rungs that never meant anything, and the fourth
-- closes gaps where a built-in role could not do the job its own description
-- claims for it.
--
--   1. `processControl` is DROPPED from the catalogue. Process/service control
--      was removed in the Satellite-posture change and the key has gated
--      nothing since; it survived only for matrix compatibility. Stored
--      matrices are stripped so the data matches the catalogue.
--      (`normalizePermissions` already drops unknown keys on any subsequent
--      role write, so this statement is tidiness, not correctness.)
--
--   2. FOURTEEN keys lose their dead FOURTH rung. No route and no frontend
--      check ever asked for `fullwrite` on ipBlocks, allocationTemplates,
--      assetsQuarantine, mibDatabase, manufacturerProfiles,
--      manufacturerAliases, discoveryConflicts, deviceMap, applicationMap,
--      mapRegions, deviceIcons, events, staleReservations or apiTokens — so
--      granting Full Read-Write and granting Read-Write were the same grant
--      under two names. Stored `fullwrite` folds to `write`.
--
--   3. FOUR keys lose their dead SECOND rung instead. serverSettingsData,
--      maintenanceManagement, automationManagement and automationScripts
--      jumped from `read` straight to `fullwrite`, so `write` was the dead
--      cell (maintenanceManagement's own catalogue description apologised for
--      it in prose). Their routes now ask for `write`, so stored `fullwrite`
--      folds DOWN to `write` — the level that now carries the grant.
--      serverSettingsData additionally loses its `read` rung: its only
--      read-level route was the backup DOWNLOAD, which hands over the entire
--      database and has moved up to `write`; every other read on that tab
--      rides the serverSettings mount's serverSettingsSystem=read floor.
--      A stored `read` there would grant nothing, so it folds to `none`.
--
--   4. The BUILT-IN roles are corrected where they contradicted their own
--      descriptions or dead-ended a workflow. Only the four editable
--      built-ins are touched, and only UPWARD — every statement below is
--      guarded so it can never lower a level an operator raised by hand.
--      Custom roles are untouched apart from (1)-(3), which are level FOLDS
--      rather than grants.
--
-- Every fold here is also enforced at runtime: `normalizePermissions` clamps a
-- stored or incoming value DOWN into the key's ladder on every role write, and
-- `permissionOf` clamps on READ so a session snapshot stamped before this
-- deploy still resolves. This migration keeps the stored data honest; it is not
-- what makes the change safe.
--
-- `updatedAt` is bumped on every touched row so the in-process role-version
-- cache (bumpRoleVersion / permissions.ts) refetches and live sessions pick the
-- change up on their next request rather than at next login.
--
-- NOTE ON SHAPE: every statement folds ALL of its keys in one correlated
-- subquery rather than joining `UPDATE ... FROM (VALUES …)`. That join looks
-- natural and is silently wrong here — when several VALUES rows match one role,
-- PostgreSQL applies exactly ONE of them and discards the rest, so a role
-- holding `fullwrite` on nine of the fourteen keys would have had one folded.

-- Access-level rank, so the guards below can say "only raise". pg_temp is
-- dropped when the migration's session ends, so this leaves nothing behind.
CREATE FUNCTION pg_temp.perm_rank(level text) RETURNS int
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE COALESCE(level, 'none')
             WHEN 'fullwrite' THEN 3
             WHEN 'write'     THEN 2
             WHEN 'read'      THEN 1
             ELSE 0
           END;
  $$;

-- ─── 1. Drop the vestigial processControl key ──────────────────────────
UPDATE "roles"
   SET "permissions" = "permissions" - 'processControl',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "permissions" ? 'processControl';

-- ─── 2 + 3a. Eighteen keys: fold a stored fullwrite down to write ──────
-- Fourteen of them never routed `fullwrite`; the other four have just moved
-- their routes onto `write`. Either way `write` is now the key's top rung and
-- is what the stored matrix should say.
UPDATE "roles" r
   SET "permissions" = r."permissions" || (
         SELECT COALESCE(jsonb_object_agg(k, '"write"'::jsonb), '{}'::jsonb)
           FROM unnest(ARRAY[
                  'ipBlocks', 'allocationTemplates', 'assetsQuarantine', 'mibDatabase',
                  'manufacturerProfiles', 'manufacturerAliases', 'discoveryConflicts', 'deviceMap', 'applicationMap',
                  'mapRegions', 'deviceIcons', 'events', 'staleReservations', 'apiTokens',
                  'serverSettingsData', 'maintenanceManagement',
                  'automationManagement', 'automationScripts'
                ]) AS k
          WHERE r."permissions" ->> k = 'fullwrite'
       ),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
                  'ipBlocks', 'allocationTemplates', 'assetsQuarantine', 'mibDatabase',
                  'manufacturerProfiles', 'manufacturerAliases', 'discoveryConflicts', 'deviceMap', 'applicationMap',
                  'mapRegions', 'deviceIcons', 'events', 'staleReservations', 'apiTokens',
                  'serverSettingsData', 'maintenanceManagement',
                  'automationManagement', 'automationScripts'
                ]) AS k
          WHERE r."permissions" ->> k = 'fullwrite'
       );

-- ─── 3b. serverSettingsData also loses its read rung ───────────────────
-- Its one read-level route (backup download) moved up to `write`, so a stored
-- `read` now grants nothing at all. Folding to `none` states that, rather than
-- leaving a level that looks like partial access and is not.
UPDATE "roles"
   SET "permissions" = jsonb_set("permissions", '{serverSettingsData}', '"none"', true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "permissions" ->> 'serverSettingsData' = 'read';

-- ─── 4a. The reads every built-in role's description already promises ───
-- `readonly` is documented as "read on every function that allows non-admin
-- reads" and `user` as "read on everything authorized for non-admins", but both
-- sat at `none` on six keys that have a perfectly ordinary read. The mapRegions
-- gap was visible in the UI: region pills fall back to neutral grey because the
-- colour lookup 403s. Read on these grants no mutation anywhere.
--
-- This runs over ALL FOUR editable built-ins, not just those two, because
-- `readonly` is by construction the FLOOR for a non-admin role: a role that
-- exists to do more than look at Polaris should never reach less of it than
-- the look-only role does. networkadmin and assetsadmin were both below that
-- floor on three of these six keys — assetsadmin could manage the asset fleet
-- but not see a region polygon or a topology icon, and neither could see the
-- automations that page them. The guard is "only raise", so networkadmin's
-- mapRegions=write and assetsadmin's discoveryConflicts=write are untouched.
--
-- Deliberately NOT included: `integrations`. Its list exposes hostnames, ADOM
-- names and per-integration config, and a strictly read-only or self-service
-- account has no operational need for it — assetsadmin gets it explicitly in
-- (4c) because its inventory comes from there.
--
-- ONE built-in stays below the readonly floor after this migration, and it is
-- meant to: `user` holds networkScan=none where readonly holds read. That was
-- the explicit call in migration 20260825040000_network_scan ("`user` stays
-- none: that role exists for IP-space self-service"), and an active sweep is
-- IDS-visible, so it is not a gap to be tidied away. Anything else showing up
-- below readonly IS a gap.
UPDATE "roles" r
   SET "permissions" = r."permissions" || (
         SELECT COALESCE(jsonb_object_agg(k, '"read"'::jsonb), '{}'::jsonb)
           FROM unnest(ARRAY[
                  'mapRegions', 'discoveryConflicts', 'maintenanceManagement',
                  'automationManagement', 'manufacturerAliases', 'deviceIcons'
                ]) AS k
          WHERE pg_temp.perm_rank(r."permissions" ->> k) < pg_temp.perm_rank('read')
       ),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE r."name" IN ('readonly', 'user', 'networkadmin', 'assetsadmin')
   AND EXISTS (
         SELECT 1
           FROM unnest(ARRAY[
                  'mapRegions', 'discoveryConflicts', 'maintenanceManagement',
                  'automationManagement', 'manufacturerAliases', 'deviceIcons'
                ]) AS k
          WHERE pg_temp.perm_rank(r."permissions" ->> k) < pg_temp.perm_rank('read')
       );

-- ─── 4b. networkadmin: finish the Discovery workflow ───────────────────
-- Adopting what a Discovery finds chains `networkScan:write` AND `assets:write`
-- at the route, and this role held assets=read — so it could run a sweep and
-- then do nothing with the result. Same shape for the other two: it may edit
-- region polygons but could not save a topology layout (deviceMap:write), and
-- may reboot a FortiGate through an integration but could not schedule the
-- maintenance window around it.
UPDATE "roles" r
   SET "permissions" = r."permissions" || (
         SELECT COALESCE(jsonb_object_agg(k, '"write"'::jsonb), '{}'::jsonb)
           FROM unnest(ARRAY['assets', 'deviceMap', 'maintenanceManagement']) AS k
          WHERE pg_temp.perm_rank(r."permissions" ->> k) < pg_temp.perm_rank('write')
       ),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE r."name" = 'networkadmin'
   AND EXISTS (
         SELECT 1
           FROM unnest(ARRAY['assets', 'deviceMap', 'maintenanceManagement']) AS k
          WHERE pg_temp.perm_rank(r."permissions" ->> k) < pg_temp.perm_rank('write')
       );

-- ─── 4c. assetsadmin: the credentials its monitoring needs ─────────────
-- The role may turn on SNMP/WinRM/SSH monitoring for an asset but sat at
-- credentials=read, so it could not create the credential that monitoring
-- needs — someone else had to. `write` is the OWN-ROWS level (createdBy), so
-- this reaches nobody else's stored secrets. integrations=read is the other
-- half: integrations produce most of its inventory and it could not see them.
UPDATE "roles" r
   SET "permissions" = r."permissions"
         || CASE WHEN pg_temp.perm_rank(r."permissions" ->> 'credentials') < pg_temp.perm_rank('write')
                 THEN '{"credentials":"write"}'::jsonb ELSE '{}'::jsonb END
         || CASE WHEN pg_temp.perm_rank(r."permissions" ->> 'integrations') < pg_temp.perm_rank('read')
                 THEN '{"integrations":"read"}'::jsonb ELSE '{}'::jsonb END,
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE r."name" = 'assetsadmin'
   AND (pg_temp.perm_rank(r."permissions" ->> 'credentials') < pg_temp.perm_rank('write')
        OR pg_temp.perm_rank(r."permissions" ->> 'integrations') < pg_temp.perm_rank('read'));

-- ─── 4d. Refresh the built-in role DESCRIPTIONS ────────────────────────
-- Operators may edit these rows, so each update matches on the exact seed text
-- and leaves an operator-edited description alone.
UPDATE "roles"
   SET "description" = 'Full CRUD on IP space, integrations, map regions and discovery conflicts. Manages assets, maintenance windows, alerts, contacts and shared dashboards. Read elsewhere.',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "name" = 'networkadmin'
   AND "description" = 'Full CRUD on IP space + integrations + map regions. Read elsewhere.';

UPDATE "roles"
   SET "description" = 'Full asset management: inventory, quarantine, monitor settings, own monitoring credentials, maintenance windows and automations. Own-network / own-reservation writes.',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "name" = 'assetsadmin'
   AND "description" = 'Full asset management + own-subnet/own-reservation writes.';

UPDATE "roles"
   SET "description" = 'Own-network / own-reservation writes, own address-book entries, acknowledge alerts. Read on everything authorized for non-admins.',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "name" = 'user'
   AND "description" = 'Own-subnet / own-reservation writes; read on everything authorized for non-admins.';
