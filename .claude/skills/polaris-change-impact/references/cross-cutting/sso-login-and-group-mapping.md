## cross-cutting/sso-login-and-group-mapping

**What it is:** OIDC + LDAP user login and the IdP-group → role+tags mapping layer. `authProvider ∈ {local, azure, oidc, ldap, entra-proxy}`. Local accounts additionally carry TOTP and passkey credentials of their own — see business rules 63 and 64.

**Login entry points:**
- `POST /auth/login` (auth.ts) — local password OR LDAP branch (when the account is `authProvider="ldap"` OR the username is unknown and LDAP is enabled). Shared lockout counter applies to both.
- `GET /auth/oidc/login` + `GET /auth/oidc/callback` (auth.ts) — OIDC Authorization-Code + PKCE; state/nonce/codeVerifier stashed in the (PG) session between the two.
- `POST /auth/azure/callback` — SAML (unchanged; no group reading yet).
- `POST /auth/passkeys/login[/options]` (auth.ts) — passwordless WebAuthn, LOCAL accounts only, and the one entry point that is not gated by a username: the assertion names the account, so no `allowCredentials` is issued and the endpoint cannot be used to probe for users. It issues the session outright, which is why it is in `LOGIN_CREDENTIAL_PATHS` (app.ts) and in the CSRF exemptions. Business rule 64; it NEVER provisions.
- `POST /auth/login/passkey[/options]` and `POST /auth/login/totp` — the second-factor steps behind the password, both spending the same pending token. Which are on offer is `methods: { totp, passkey }` in the password step's response.
- `POST /auth/login/password-change` — the forced-change step (business rule 63). Not an entry point of its own: it is only reachable with a token minted after EVERY factor has passed, and it is the last thing between an authenticated caller and their session.

**How a login ENDS — three shapes, and every step can answer any of them:** `{ ok }` (session issued), `{ mfaRequired, pendingToken, methods }` (a second factor is owed), `{ passwordChangeRequired, pendingToken, policy }`. A second factor can be followed by a forced change, so a client that only checks for `mfaRequired` after the password will silently treat a withheld session as a success — which is what `loginOutcome` in `public/js/auth-flow.js` exists to stop, shared by the desktop page and the phone SPA.

**Services:** `oidcAuthService.ts` (openid-client v6), `ldapAuthService.ts` + shared `ldapClient.ts` (ldapts; also used by `activeDirectoryService.ts` for computer discovery), `ssoProvisioning.ts` (shared provision/role-assign), `groupMappingService.ts` (CRUD + `resolveGroupsToAccess`).

**Settings** (Setting rows, admin-only via `serverSettingsSystem:write`): `oidc` (secret masked) + `ldap` (bindPassword masked). Each has a `POST /auth/{oidc,ldap}/test`.

**Invariants / gotchas:**
- LDAP: reject empty passwords before binding (unauthenticated-bind trap); RFC-4515-escape the username (`escapeLdapFilterValue`); fail closed on 0/>1 search hits.
- OIDC: requires `POLARIS_PUBLIC_URL` (redirect URI derivation); Azure `groups` claim emits GUIDs + drops past ~200 groups.
- Highest-privilege role wins on multi-group match; tags union; provider isolation via `@@unique([provider, groupKey])`.
- A GroupMapping → admin-equivalent role is a privilege-escalation surface (logged at warning level).

**When adding a sample/login provider field:** update the service's settings shape (mask secrets, preserve-on-unchanged), the matching tab in `public/js/users.js` (`buildOidcTab`/`buildLdapTab` + `getOidcFormData`/`getLdapFormData`), and `public/js/api.js`.

---
