-- Fold function key `manufacturerAliases` into `manufacturerProfiles`.
-- 2026-09-23. The last item of the RBAC catalogue review (business rule 43(f)).
--
-- WHY THEY ARE ONE GRANT. An alias ("Fortinet, Inc." -> "Fortinet") rewrites
-- Asset.manufacturer across the whole fleet on save, and Asset.manufacturer is
-- what selects a device's manufacturer profile. So editing an alias IS editing
-- which telemetry profile — which CPU / memory / temperature OIDs and widgets —
-- applies to every device of that vendor. A role allowed one and not the other
-- could reach the other anyway, just indirectly. The two keys also drifted
-- apart for no reason anyone could name: until 20260922000000 every non-admin
-- built-in held manufacturerProfiles=read but manufacturerAliases=none.
--
-- The routes keep their URL (`/api/v1/manufacturer-aliases`); only the key
-- that gates them changes — read to list, write to change, exactly as before.
--
-- SEEDING. Two keys become one, so it cannot be access-neutral for a role that
-- held them at different levels. The rule is the same as
-- 20260923000000_authentication_function_key: nobody gains anything they could
-- not already do. The folded level is therefore the LOWER of the two:
--   * equal levels (every built-in role: admin write/write, the other four
--     read/read) -> unchanged.
--   * profiles=write, aliases=read  -> read. Loses profile editing.
--   * profiles=read,  aliases=write -> read. Loses alias editing.
--   * either at none                -> none.
-- Only a custom role an operator deliberately set apart can land in the middle
-- two, and granting manufacturerProfiles=write restores it as a decision.
-- Taking the HIGHER instead would hand some roles a capability nobody granted.
--
-- A role with no stored `manufacturerAliases` (none written since the cutover
-- seeded every role, but imported JSON can omit it) keeps its profiles level:
-- an absent key is not a statement that the role holds `none`.
--
-- `updatedAt` is bumped so the role-version cache refetches and live sessions
-- pick the change up on their next request. `normalizePermissions` would drop
-- the stale key on the role's next save anyway; stripping it here keeps the
-- stored matrix matching the catalogue.

-- OR REPLACE is load-bearing: `prisma migrate deploy` applies every pending
-- migration in ONE session, and pg_temp lives for the session, so on any
-- install that reaches this migration in the same update as
-- 20260922000000_rbac_catalogue_hygiene (which creates the same function) a
-- plain CREATE fails with 42723 and the update stops here.
CREATE OR REPLACE FUNCTION pg_temp.perm_rank(level text) RETURNS int
  LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE COALESCE(level, 'none')
             WHEN 'fullwrite' THEN 3
             WHEN 'write'     THEN 2
             WHEN 'read'      THEN 1
             ELSE 0
           END;
  $$;

-- ─── 1. Fold to the lower of the two, then drop the old key ─────────────
-- One statement, so the read of both keys and the removal cannot be split.
UPDATE "roles"
   SET "permissions" = jsonb_set(
         "permissions",
         '{manufacturerProfiles}',
         to_jsonb(
           CASE WHEN pg_temp.perm_rank("permissions" ->> 'manufacturerAliases')
                     < pg_temp.perm_rank("permissions" ->> 'manufacturerProfiles')
                THEN COALESCE("permissions" ->> 'manufacturerAliases', 'none')
                ELSE COALESCE("permissions" ->> 'manufacturerProfiles', 'none')
           END),
         true) - 'manufacturerAliases',
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "permissions" ? 'manufacturerAliases';
