-- Tags leave roles. 2026-11-03, release 1 of the write-scope change.
--
-- A role used to carry two tag-scope columns, inherited by every user holding
-- it, and a session's effective scope was union(role, user, group-derived).
-- The role slide-over therefore showed a Region Scope picker AND a Tags picker
-- that listed the same regions again — and with tags becoming write reach
-- (business rule 141), a role is the wrong place for them: a role says what a
-- person MAY DO, a tag says WHICH records. The operator's decision: tags live
-- on assets, users and IdP group mappings; a role is the permission matrix
-- alone.
--
-- The columns are DROPPED and their contents are NOT carried onto users (the
-- operator chose that over a migration unioning each role's tags onto its
-- holders): a user whose scope came only through a role is unrestricted for
-- routing and, after release 2, reaches only what they own, until an
-- administrator assigns tags on the account or its group mapping. The
-- protected `readonly` role's tags also scoped the Dash wallboard; nobody
-- could set them through the UI, so the wallboard's scope was always empty in
-- practice and stays unrestricted.

ALTER TABLE "roles" DROP COLUMN IF EXISTS "region_tags";
ALTER TABLE "roles" DROP COLUMN IF EXISTS "other_tags";
