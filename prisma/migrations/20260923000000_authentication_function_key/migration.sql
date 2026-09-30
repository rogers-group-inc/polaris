-- New function key `authentication`, split out of `serverSettingsSystem`.
-- 2026-09-23. Finishes the job business rule 43(d) started: the catalogue
-- hygiene sweep recorded `serverSettingsSystem` as knowingly divided in the
-- wrong place and left it alone, because moving it is this change.
--
-- WHAT WAS WRONG. `serverSettingsSystem` had two rungs in use. Its `write`
-- rung gated exactly twelve routes, ALL of them identity-provider
-- configuration — the SAML, OIDC, LDAP and Entra App Proxy settings and their
-- test buttons. Its `fullwrite` rung gated the other ~54: TLS, HA, tags, DNS,
-- NTP, branding, capacity, the whole agent fleet. So repointing every login in
-- the install at an identity provider of your choosing was a LESSER grant than
-- changing the logo, and the two could not be separated at all: you could not
-- delegate branding without also delegating the login path, or delegate the
-- login path without the ability to read every other server setting.
--
-- WHAT CHANGES.
--   1. `authentication` is added: none | read | write. It gates the four
--      providers' settings + test routes, the passkey policy and the password
--      policy. Read views them; Read-Write changes them and dials the IdP.
--   2. Those routes move off `serverSettingsSystem`, which leaves that key with
--      no `write` routes at all — so its ~54 `fullwrite` gates move DOWN to
--      `write` and its ladder shortens to none | read | write, exactly as the
--      fourteen keys in `20260922000000_rbac_catalogue_hygiene` did. It stops
--      being the named exception in the "no dead top rung" test.
--
-- SEEDING, and the one place access changes. The rule is "nobody gains anything
-- they could not already do":
--   * A role at serverSettingsSystem=fullwrite could reach ALL of it, providers
--     and policies alike -> authentication=write. Access-neutral. This is every
--     admin-equivalent role, and the built-in `admin` is the only built-in
--     affected: all four other built-ins sit at serverSettingsSystem=none and
--     therefore get authentication=none.
--   * A role at serverSettingsSystem=read could read the passkey settings and
--     nothing else here -> authentication=read. Access-neutral.
--   * A role at serverSettingsSystem=WRITE is the one case that TIGHTENS. It
--     could previously edit every identity provider (but not the password or
--     passkey policy, which were fullwrite). It gets authentication=READ: it
--     keeps sight of the configuration and loses the ability to repoint the
--     install's logins. That is the whole finding — that rung should never have
--     carried IdP control, and it is the rung an operator would have granted
--     believing they were delegating "some server settings". No built-in role
--     holds it; only a custom role an operator set deliberately. An admin who
--     wants that role to keep the capability grants it authentication=write,
--     which is now a decision rather than a side effect.
--
-- `updatedAt` is bumped on every touched row so the in-process role-version
-- cache (bumpRoleVersion / permissions.ts) refetches and live sessions pick the
-- change up on their next request rather than at next login.
--
-- Statement shape: one correlated subquery per row, never
-- `UPDATE ... FROM (VALUES …)` — that join applies exactly ONE matching VALUES
-- row per target row and discards the rest. See the same note in
-- 20260922000000_rbac_catalogue_hygiene.

-- ─── 1. Seed `authentication` from the OLD serverSettingsSystem level ───
-- MUST run before step 2, which rewrites the value this reads.
UPDATE "roles"
   SET "permissions" = jsonb_set(
         "permissions",
         '{authentication}',
         CASE "permissions" ->> 'serverSettingsSystem'
           WHEN 'fullwrite' THEN '"write"'::jsonb
           WHEN 'write'     THEN '"read"'::jsonb
           WHEN 'read'      THEN '"read"'::jsonb
           ELSE '"none"'::jsonb
         END,
         true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE NOT ("permissions" ? 'authentication');

-- ─── 2. serverSettingsSystem loses its now-empty top rung ──────────────
-- Every route that asked for `fullwrite` now asks for `write`, and nothing
-- asks for `write`'s old meaning any more because those routes left in (1).
UPDATE "roles"
   SET "permissions" = jsonb_set("permissions", '{serverSettingsSystem}', '"write"', true),
       "updatedAt" = CURRENT_TIMESTAMP
 WHERE "permissions" ->> 'serverSettingsSystem' = 'fullwrite';
