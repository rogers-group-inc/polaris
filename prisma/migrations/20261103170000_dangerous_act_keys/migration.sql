-- Four function keys split out of the Full Read-Write rung of `assets`, of
-- `alerts`, and of `serverSettingsSystem`'s write rung. 2026-11-03, release 1
-- of the write-scope change (business rule 141 lands in release 2).
--
-- WHY. Release 2 makes Read-Write on the asset-side keys reach only the rows
-- you own or that carry one of your tags, and Full Read-Write reach every row.
-- Today Full Read-Write on `assets` ALSO means "may merge any two assets and
-- may deploy the agent", and on `alerts` "may clear". Release 2 lifts every
-- stored `write` on those keys to `fullwrite` so nobody narrows on update day
-- — which would hand merge / deploy / clear to every role that held write.
-- So the dangerous acts become their own keys FIRST, in this release, copied
-- only to the roles that hold the rung they lived on. On the code this
-- release ships with, that is access-neutral: a role that held
-- assets=fullwrite still merges and deploys (through the new keys); one that
-- held write still cannot. Old code that reads a matrix carrying these keys
-- drops them (`normalizePermissions` discards unknown keys), so the update
-- window is safe in both directions.
--
-- `tags` is the fourth: the tag registry leaves `serverSettingsSystem`, and
-- from this release ASSIGNING a tag to any record rides it too. That one is a
-- deliberate narrowing — a tag will be write reach for everyone holding it, so
-- putting one on a device is handing out access, and the operator decided it
-- is an administrator's act. `assetsadmin` / `networkadmin`, who tag devices
-- at assets=write today, lose that until given Tags. Every built-in gets
-- `read` as the floor (the pickers need the registry's names and colours).
--
-- Seeding idiom: the `20260923030000_path_checks` shape — one jsonb_set per
-- key, clamped into the key's ladder, guarded by `NOT (perms ? key)` so the
-- statement is idempotent. No key here has a read rung except `tags`, so a
-- source level below the one that carried the act folds to none.
-- `updatedAt` is bumped so the role-version cache refetches after the restart
-- the updater performs (the migration cannot call bumpRoleVersion itself).

-- ─── 1. assetMerge / agentDeploy ← assets=fullwrite ───────────────────────
UPDATE "roles"
   SET "permissions" = jsonb_set(
         jsonb_set(
           "permissions",
           '{assetMerge}',
           CASE "permissions" ->> 'assets'
             WHEN 'fullwrite' THEN '"write"'::jsonb
             ELSE '"none"'::jsonb
           END,
           true),
         '{agentDeploy}',
         CASE "permissions" ->> 'assets'
           WHEN 'fullwrite' THEN '"write"'::jsonb
           ELSE '"none"'::jsonb
         END,
         true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT ("permissions" ? 'assetMerge') OR NOT ("permissions" ? 'agentDeploy');

-- ─── 2. alertClear ← alerts=fullwrite ────────────────────────────────────
UPDATE "roles"
   SET "permissions" = jsonb_set(
         "permissions",
         '{alertClear}',
         CASE "permissions" ->> 'alerts'
           WHEN 'fullwrite' THEN '"write"'::jsonb
           ELSE '"none"'::jsonb
         END,
         true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT ("permissions" ? 'alertClear');

-- ─── 3. tags ← serverSettingsSystem (write stays write; read is the floor) ─
-- A role below `read` on serverSettingsSystem still gets `read`: the registry
-- list is what every tag picker in the app draws its colours from, and a
-- role that may look at an asset may look at its tags' colours.
UPDATE "roles"
   SET "permissions" = jsonb_set(
         "permissions",
         '{tags}',
         CASE "permissions" ->> 'serverSettingsSystem'
           WHEN 'fullwrite' THEN '"write"'::jsonb
           WHEN 'write'     THEN '"write"'::jsonb
           ELSE '"read"'::jsonb
         END,
         true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT ("permissions" ? 'tags');
