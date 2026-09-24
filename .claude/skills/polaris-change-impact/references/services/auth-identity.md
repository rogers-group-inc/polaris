# Services — auth providers, roles, tokens, credentials, SSH onboarding, access scopes

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/apiTokenService.ts

**What it owns:** Long-lived bearer-token CRUD for external API access; argon2id hash + tokenPrefix-based lookup; role binding (each token carries a roleId whose matrix requirePermission resolves like a session snapshot); integrationIds enforcement when the bound role grants assetsQuarantine >= write; api_token.admin_equivalent warning Event on admin-equivalent bindings.

**Public API:** ApiTokenSummary, AuthenticatedToken, CreateTokenInput, CreateTokenResult, createToken, listTokens, revokeToken, deleteToken, verifyToken.

**Cross-service deps:** permissions.ts (normalizePermissions, isAdminEquivalentPermissions), eventLogService (logEvent via routes/events re-export).

**Used by:**
- src/api/routes/apiTokens.ts — GET /api-tokens, list all tokens
- src/api/routes/apiTokens.ts — POST /api-tokens, create new token (show raw once)
- src/api/routes/apiTokens.ts — POST /api-tokens/:id/revoke, revoke by ID
- src/api/routes/apiTokens.ts — DELETE /api-tokens/:id, delete by ID
- src/api/middleware/auth.ts — attachApiToken middleware, verify bearer token on every request
- ...and N other call sites (quarantine/release endpoints use verifyToken indirectly via middleware)

**Invariants:**
- Wire format: `Authorization: Bearer polaris_<32-char-base64url-tail>` (prefix stored separately for fast candidate lookup via index).
- tokenHash is argon2id; never returned; rawToken shown ONCE at creation (POST response).
- A bound role granting assetsQuarantine ≥ write requires integrationIds (≥1 FortiManager/FortiGate id); other roles may have empty integrationIds.
- Roles bound to tokens can't be deleted (roleService counts apiTokens and 409s); role edits propagate to live tokens via the bumpRoleVersion cache on the next request.
- verifyToken() is best-effort on lastUsedAt/lastUsedIp updates; missed bumps don't fail auth.
- Expired tokens (expiresAt in past) and revoked tokens (revokedAt set) are silently excluded from lookup; no 401 distinction.

**When changing this:**
- Audit validateIntegrationIds if adding new integration types to quarantine support.
- Test wire format edge cases (malformed prefix, truncated token, null bearer header).
- Verify tokenPrefix index is used in verifyToken candidate fetch to keep lookup O(indexed).
- Check that expiresAt comparison handles null and timezone offsets correctly.
- Review quarantine endpoints (assets routes) to confirm they call attachApiToken middleware before verifyToken.

---

## services/azureAuthService.ts

**What it owns:** Azure AD (Entra) SAML 2.0 SSO configuration, SAML response validation, user provisioning on first login.

**Public API:** getSsoSettings, updateSsoSettings, isAzureSsoConfigured, isAzureSsoConfiguredAsync, getSamlLoginUrl, validateSamlResponse, getSamlLogoutUrl, findOrProvisionSamlUser, SsoSettings.

**Cross-service deps:** None (SAML + database; no service-to-service calls).

**Used by:** src/app.ts — check SSO configured on startup to conditionally skip login page, src/api/routes/auth.ts — SAML login/logout flow (getSamlLoginUrl, validateSamlResponse, getSamlLogoutUrl, findOrProvisionSamlUser).

**Invariants:**
- SSO settings stored in Setting table (key="sso"); 30-second in-memory cache with expiry.
- SAML IdP config (Entity ID, Login/Logout URLs, certificate) configured via Users page Settings modal.
- **Relay state is NOT this service's** (moved 2026-09-15): `generateRelayState` / `relayStateTarget` live in `utils/loginRedirect.ts`, beside the `polaris_next` cookie, because the two carry the same thing — where this login lands. RelayState is `<nonce>` or `<nonce>.<path>`, the nonce base64url and short enough to keep the whole value inside the SAML binding spec's 80-byte ceiling. It is still the CSRF binding on the redirect (the equality check in `/azure/callback` compares the whole string, path included), and it is still only checked when a session survived — which on a cross-site POST it usually has not.
- SAML response validation uses @node-saml/node-saml library; wantResponseSigned flag controls signature check.
- User provisioning on first login: extract nameID/email from validated Profile, upsert User row with default role, auto-enable if disabled.
- skipLoginPage flag bounces unauthenticated visitors straight to SSO (bypass Polaris login page) — from protected pages AND, since 2026-09-06, from `/login.html` itself (`skipLoginSsoTarget` in app.ts is the one decider for both). Two query keys draw the form anyway: `?error=` (every SSO failure landing — anti-loop) and `?local=1` (the anti-lockout path the Settings tab's hint names; deliberately guessable — the source-IP gate is what restricts WHO reaches the form, and it is mounted above the redirect). A logout lands on `/signed-out.html` instead (`public/signed-out.html` + `public/js/signed-out.js`: no form, a `?reason=inactivity` sentence from a closed set, and one Sign in button that opens the BARE `/login.html` so this redirect decides SSO-or-form) — every desktop logout landing (account menu, inactivity timer, server-side idle check in app.ts) goes there, which is what keeps a silent `prompt=none` provider from signing the operator straight back in. Change the landing in all three places together; tests/unit/loginPageSkipLandings.test.ts pins them. app.ts honors SAML first, then OIDC. Turning it ON is lockout-gated in PUT /auth/azure/settings: requires (a) a SAML or OIDC provider configured AND (b) the enabling admin's session authProvider is "azure"/"oidc" (SSO round-trip proven). Turning it OFF is unrestricted (recovery). users.js mirrors the gate by disabling the checkbox for local/LDAP sessions when it's currently off.
- **The flag has TWO enforcement points, and the phone is the second.** app.ts's protected-page and login-page redirects cover the desktop; `/mobile.html` is deliberately NOT a protected page (the phone SPA draws its OWN login screen, so an unauthenticated visitor must be allowed to load it), which left the phone offering the very password form the setting hides. `public/js/mobile/auth.js:renderLogin` is the mirror — the single choke point every local login goes through (boot, the api.js 401 hook, Cancel out of the TOTP step) — and it reads the flag off `GET /auth/azure/config`, which returns `skipLoginPage` regardless of whether SAML itself is enabled, so an OIDC-only install gets it too. Same provider precedence as app.ts, same fall-through to the form when neither provider resolves (the flag can outlive the SSO config it was set under, and a phone with no way in is worse than one showing a form). One carve-out the desktop doesn't need: an explicit Sign out sets a one-shot sessionStorage marker (`PolarisAuth.markSignedOut`, called from more-tab.js) that buys one render of the form — desktop logout lands on the unprotected /login.html and stays there, whereas the phone would be signed straight back in by a silent `prompt=none` provider. Pinned by tests/unit/mobileLoginSkip.test.ts.
- autoLogoutMinutes triggers silent logout after inactivity (0 = disabled).

**When changing this:**
- Test SSO cache expiry (30s) on getSsoSettings; verify updateSsoSettings invalidates _samlClient.
- Check SAML validation still rejects unsigned responses when wantResponseSigned=true.
- Confirm user provisioning correctly maps SAML Profile fields (nameID, email, groups) to User rows.
- Validate skipLoginPage redirect flow doesn't expose relay state leaks; confirm OIDC fallback fires when only OIDC is configured and the lockout guard rejects a local/LDAP admin enabling it.
- Test logout URL generation with correct nameID/sessionIndex from validated response.

---

## services/groupMappingService.ts

**What it owns:** CRUD over the `GroupMapping` table + the login-time resolver that turns IdP group claims into a role + region/other tags. Highest-privilege role wins across matched groups; tags union. Enabled-mappings are cached per provider.

**Public API:** `resolveGroupsToAccess`, `normalizeGroupKey`, `listGroupMappings`, `getGroupMapping`, `createGroupMapping`, `updateGroupMapping`, `deleteGroupMapping`, `GROUP_MAPPING_PROVIDERS`

**Cross-service deps:** permissions helpers (`normalizePermissions`, admin-equivalent check, highest-privilege picker), `logEvent`, `tagNormalize` (normalize + union).

**Used by:** `src/services/ssoProvisioning.ts` + `src/api/routes/auth.ts` (`resolveGroupsToAccess` at login), `src/api/routes/groupMappings.ts` (CRUD, gated on `users=fullwrite`), `src/services/regionScopeService.ts` (live `/auth/me` re-resolution keyed on `User.authProvider`).

**Invariants:**
- `normalizeGroupKey` is applied identically on write (stored key) and read (incoming claim) so matching never diverges; LDAP + entra-proxy keys lowercase for case-insensitive match (entra-proxy = Entra group object-ID GUIDs), OIDC/SAML trim-only.
- Enabled-mappings cache invalidates on every write; highest-privilege role chosen when matched groups disagree.
- A mapping pointing at an admin-equivalent role emits a warning Event (the audit trail for IdP→admin paths); a `roleId=null` tag-only mapping contributes tags without a role.
- `GROUP_MAPPING_PROVIDERS` (`oidc`/`ldap`/`saml`/`entra-proxy`) is the single source of truth — `groupMappings.ts`'s `ProviderSchema` and `regionScopeService`'s lookup both key off `User.authProvider`, so a login provider's stored `authProvider` string MUST equal its `GROUP_MAPPING_PROVIDERS` entry or group tags silently never resolve.

**When changing this:**
- Adding to `GROUP_MAPPING_PROVIDERS` is code-only (no `GroupMapping` schema migration — `provider` is a free-form string); ensure the new provider's login path stores a matching `authProvider`. `normalizeGroupKey` changes risk breaking already-stored keys.

---

## services/ldapAuthService.ts

**What it owns:** LDAP/AD bind-as-user authentication + group lookup; provisions the Polaris user with group-derived role/tags via `ssoProvisioning`. Settings live in a Setting row with `bindPassword` masked on read.

**Public API:** `getLdapSettings`, `getLdapSettingsMasked`, `updateLdapSettings`, `isLdapEnabled`, `authenticateLdapUser`, `findOrProvisionLdapUser`, `testLdapConnection`

**Cross-service deps:** `ldapClient` (bound-client + escape + GUID decode + error format), `ssoProvisioning.provisionExternalUser`.

**Used by:** `src/api/routes/auth.ts` (LDAP login via `POST /auth/login`, LDAP test + settings endpoints).

**Invariants:**
- Empty password is rejected BEFORE any bind (unauthenticated-bind trap); username is RFC-4515-escaped before filter substitution.
- Two-phase: service-account bind locates the user, then a rebind AS the user verifies credentials; optional reverse group search catches groups missing from `memberOf`.
- Stable user id is objectGUID (hex) or entryUUID, falling back to DN; settings cache has a short TTL and preserves the bindPassword mask on write unless changed.

**When changing this:**
- Keep the empty-password check first, before any network I/O.

---

## services/oidcAuthService.ts

**What it owns:** OpenID Connect (Authorization Code + PKCE/S256) login via `openid-client` v6 — discovery, JWKS, ID-token signature/iss/aud/exp/nonce validation, config storage, redirect-URI derivation, and group-to-role provisioning.

**Public API:** `getOidcSettings`, `getOidcSettingsForUi`, `updateOidcSettings`, `isOidcEnabled`, `getRedirectUri`, `buildAuthorizationUrl`, `handleCallback`, `findOrProvisionOidcUser`, `testOidcConnection`

**Cross-service deps:** `ssoProvisioning.provisionExternalUser`.

**Used by:** `src/api/routes/auth.ts` (OIDC login kick-off, callback, settings, test endpoints).

**Invariants:**
- `state` (CSRF) / `nonce` (replay) / `codeVerifier` (PKCE) live in the PG-backed session between login and callback; the callback is a top-level GET so SameSite=Lax cookies are sent.
- Callback never honors a caller-supplied return path — always redirects to `/`; `clientSecret` masked on read, preserved-on-unchanged on write.
- Redirect URI is derived from `POLARIS_PUBLIC_URL` (missing → throws with a clear message); userinfo claims merge into ID-token claims when present.

**When changing this:**
- Never add a caller-supplied return_uri / open-redirect surface to the callback.

---

## services/ssoProvisioning.ts

**What it owns:** Shared find-or-provision for OIDC, LDAP, and Entra App Proxy users — resolves IdP groups to role + tags, matches or creates the Polaris user, applies the highest-privilege role, records normalized groups in `User.ssoGroups`, and stamps `authProvider` to the current provider on every login.

**Public API:** `provisionExternalUser`, `ExternalUserProfile`

**Cross-service deps:** `groupMappingService` (`resolveGroupsToAccess`, `normalizeGroupKey`).

**Used by:** `src/services/ldapAuthService.ts`, `src/services/oidcAuthService.ts`, and `src/services/entraProxyAuthService.ts` (find-or-provision).

**Invariants:**
- `ssoGroups` capped (anti-bloat) and normalized per provider; they do NOT write to the user's own `regionTags`/`otherTags` (those stay operator-owned and union at read time).
- Existing user: role overridden only when groups resolve a role (a manual admin assignment survives a no-match login); new user: group-resolved role else built-in `readonly`, always flagged `needsRoleReview`.
- Existing-user update stamps `authProvider = provider` — a no-op for oidc/ldap (matched by their own id column) but the mechanism that converges an `azureOid` row between `entra-proxy` and `azure` (SAML): since the 2026-08 fold the SAML path delegates here too, so the LAST login path owns `authProvider`+`ssoGroups`, and tag re-resolution translates `authProvider="azure"` to the `"saml"` mapping provider via `mappingProviderForAuthProvider`.
- Username collisions resolve via base → base-provider → provider-externalId; SSO/LDAP users get a random placeholder password hash that is never checked at login.

**When changing this:**
- Don't change the role-override rule — a no-match login must never demote an existing admin.
- `externalIdField` is a narrow union (`oidcSubject`/`ldapUid`/`azureOid`) — entra-proxy deliberately shares `azureOid` with SAML; keep the convergence behavior intentional.

---

## services/entraProxyAuthService.ts

**What it owns:** Entra Application Proxy header-based SSO — settings (Setting key `entraProxy`, no secrets), the fail-closed source-IP trust gate, identity-header extraction, and find-or-provision (via `ssoProvisioning`, keyed on `azureOid`). The identity headers are UNSIGNED; the source-IP allowlist is the entire security boundary.

**Public API:** `getEntraProxySettings`, `updateEntraProxySettings`, `clearEntraProxySettingsCache`, `isEntraProxyEnabled`, `isTrustedEntraProxySource`, `isEntraProxyLoginAvailable`, `identityHeaderNames`, `defaultIdentityHeaderNames`, `extractEntraProxyIdentity`, `findOrProvisionEntraProxyUser`, `testEntraProxyRequest`, `EntraProxySettings`

**Cross-service deps:** `ssoProvisioning.provisionExternalUser`, `utils/ipAllowlist` (`ipMatchesAllowlist`, `isValidAllowlistEntry`).

**Used by:** `src/api/routes/auth.ts` (`/auth/entra-proxy/*` config, login, settings, test), `src/api/middleware/entraProxyHeaders.ts` (strip decision), `src/app.ts` (silent auto-login availability check).

**Invariants:**
- Fail closed everywhere: empty allowlist ⇒ `isEntraProxyEnabled` false, `ipMatchesAllowlist` false; trust is checked against `req.ip` (trust-proxy resolved), NEVER the raw socket (always 127.0.0.1 behind nginx).
- Header names are lowercased + charset-validated + denylisted (never `authorization`/`cookie`/`x-forwarded-*`/`host` — so the strip middleware can't delete infra headers); object-ID is lowercased + strict-GUID-validated; array-valued identity headers are rejected; identity comes from headers only (never query/body).
- `authProvider` stored as `"entra-proxy"` must equal the `GROUP_MAPPING_PROVIDERS` entry (group-tag re-resolution) — `azureOid` is shared with `azureAuthService` (SAML) by design.
- The login route re-validates trust independently; the strip middleware is defense-in-depth, not the gate. All login failures redirect to `/login.html` (unprotected) so the app.ts auto-login can't loop.

**When changing this:**
- Never accept identity from an unauthenticated/untrusted path; keep the empty-allowlist and denylist checks. If you change header defaults, update `defaultIdentityHeaderNames` (the fail-closed strip set) in lockstep.

---

## services/credentialService.ts

**What it owns:** Named-credential store for monitoring probes (SNMP v2c/v3, WinRM, SSH, REST API, HTTP); type-specific config validation; secret masking on GET; merge-and-preserve logic for PUT to retain secrets when client resubmits mask. Also the credential-usage resolver (where is a credential wired across the monitor-settings tiers).

**Ownership (2026-09-04, business rule 43):** `credentials` is the fourth key to carry the ownership dimension. `write` = create + edit / delete / **test-with** own rows only; `fullwrite` = any row. `createdBy` is stamped by `POST /credentials` from the session username and `updateCredential` takes no `createdBy` at all, so an edit cannot adopt a row; `null` is UNOWNED (pre-column rows, and any bearer-token create — a token has no username) and reachable only at fullwrite. The route layer owns the check (`requireOwnership("credentials")` + `assertOwnership` on the loaded row) — the SERVICE is deliberately ownership-blind, because discovery-side and onboarding callers (`windowsSshOnboardingService` rotating the Polaris-managed deployment key) must keep reaching every row.

**Public API:** CredentialType, SnmpV2cConfig, SnmpV3Config, SnmpConfig, WinRmConfig, SshConfig, RestApiConfig, HttpCheckConfig (re-exported from utils/httpCheck.ts), CredentialConfig, CredentialRecord, SaveCredentialInput, UpdateCredentialInput, CredentialUsage(+ CredentialUsageAsset / CredentialUsageClassGroup / CredentialUsageIntegrationGroup), stripSecrets, validateConfig, mergeConfigPreservingSecrets, listCredentials, getCredential, createCredential, updateCredential, deleteCredential, getCredentialUsageCounts, getCredentialUsage.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/credentials.ts — GET /credentials, list (secrets masked)
- src/api/routes/credentials.ts — GET /credentials/usage, effective-usage asset count per credential (table column)
- src/api/routes/credentials.ts — GET /credentials/:id, fetch one
- src/api/routes/credentials.ts — GET /credentials/:id/usage, full usage breakdown grouped by tier (usage slide-in)
- src/api/routes/credentials.ts — POST /credentials, create
- src/api/routes/credentials.ts — PUT /credentials/:id, update (merge w/ secret preservation)
- src/api/routes/credentials.ts — DELETE /credentials/:id, revoke (fails 409 if effectively used or still referenced)
- src/api/routes/assets.ts — GET /assets/:id/resolve-monitor-setting, fetch credential for asset monitoring setup

**Invariants:**
- Secret fields (community, authKey, privKey, password, privateKey, passphrase, apiToken) are masked to "••••••••" on every GET; empty string and mask are treated as "preserve from stored value" on PUT. `publicKey` is deliberately NOT in that list — see services/windowsSshOnboardingService.ts.
- SNMP v2c requires community; v3 requires username + security level + auth/priv keys per level.
- SSH requires username + (password OR privateKey); WinRM requires both username + password. An SSH `passphrase` is rejected without a `privateKey` — it unlocks a key and means nothing alone, and catching it at save time beats a connect-time ssh2 parse error the operator has to decode. Both `ssh2.connect` sites attach it ONLY on the key path and only when non-empty.
- REST API requires baseUrl (http/https only, no trailing slash stored) + apiToken; verifyTls defaults false.
- **The `http` credential is AUTHENTICATION ONLY** (2026-08). `validateHttpConfig` requires an `authMode` of `bearer` | `basic` | `digest` — there is deliberately no `none`, because a credential that authenticates nothing is an empty row that still reads as configuration, and an unauthenticated check is already expressible as a widget with no credential attached. It also STRIPS, on the merged config, both the carriers the chosen mode does not send and every leftover check-definition field from the pre-split shape (`useHttps`/`port`/`path`/`expectStatus`/`expectBody`/`matchMode`/`caseSensitive`/`failOnMismatch`/`verifyTls`). That placement is load-bearing: validation runs AFTER `mergeConfigPreservingSecrets` on both create and update, which is the only point at which a stored secret can actually be removed — blanking a secret in the request body means "keep the stored value" to the merge, so a client-side clear would preserve the very token it appears to delete. Those stripped values are NOT migrated into a widget: a credential names no manufacturer or model, so attributing one would invent configuration nobody wrote. The check half is validated by the exported **`validateHttpCheckDefinition`**, shared by the manufacturer widget (where it is stored) and `POST /credentials/test` (where it is supplied ad hoc), so a check cannot pass a live test and then be rejected on save. It ALSO strips `failOnMismatch`, retired in the same change: a widget records an outcome and an automation decides what "down" means, so a mismatch stored as a pass would make `expectBody` decorative — a laxer rule is expressed by leaving `expectBody` empty. Dropped rather than rejected so a widget saved while the toggle existed re-saves cleanly. It it compiles a `regex` at save for the usual reason (an invalid one otherwise fails once per asset per interval forever, discovered from an error column rather than the form). Secret fields remain `apiToken` + `password`. See business rule 33.

- **`POST /credentials/test` is ownership-scoped whenever the body names a stored `id`** (2026-09-04), checked BEFORE target resolution and any device I/O. That path merges the row's real secrets in via `mergeConfigPreservingSecrets`, so an ungated test would let a `write`-level caller aim a peer's password at any host in inventory — a read-shaped route that lends out a secret. Testing an unsaved form (no `id`) stays at plain `write`: the secret in that body is one the caller typed. If a new field ever lets the route reach a stored row WITHOUT `id`, it needs the same check.
- **`POST /credentials/test` returns `httpDiagnostics` for the `http` type only** — request line as dialed, status, content-type, bytes read, cap flag, match verdict, 4 KB body excerpt — because an HTTP check's expectation is a string picked OUT of the response and pass/fail gives an operator nothing to pick from. Filled by `probeHttp` via an out-param, so nothing is built on the monitor hot path. Two things must NOT leak into it: the response body is kept out of the `credential.tested` Event details (only httpStatus / httpUrl / httpMatched are audited — the body is arbitrary device output that would ride every pg_dump and syslog forward), and response headers other than `content-type` are never returned (a full dump would surface a live `Set-Cookie`). If you add a field here, re-check both.
- **`POST /credentials/test` takes EITHER an `assetId` or a typed `host`** (2026-08). `assetId` wins when both arrive, so a stale host in a body can't redirect a probe aimed at an asset; a typed host is validated by `normalizeProbeTarget` (utils/probeTarget.ts) and its refusal comes back as a test RESULT rather than a 4xx, matching how config-validation failures are already surfaced. Three things to keep in step when touching this: the schema `refine` exempts `restapi` (it carries its own `baseUrl` and needs no target of either kind); the `credential.tested` Event's `label` falls back to the host when there is no asset to name, and its `details.hostSource` records which way the target was chosen; and the modal's Run Test button is enabled by `syncRunEnabled()` off the ACTIVE mode only, so flipping modes can't leave it armed on the other half's input. This grants no reach a `credentials:write` caller lacked — testing a `restapi` credential has always dialed an arbitrary operator-supplied `baseUrl` — which is why `netGuard` still isn't applied here (business rule 33(g); a guard rejecting RFC1918 would reject the entire feature, loopback stubs included).
- Delete fails with 409 when the credential is effectively used or still referenced, via `getCredentialUsage` (NOT a hand-maintained column list). Effective usage covers all 8 per-stream Asset credential slots + the `monitorCredentialId` default, plus class-override and integration-default inheritance; a class/integration reference with no matching asset also 409s (deleting would silently SET NULL it). The FK columns themselves are ON DELETE SET NULL, so this guard is the only thing preventing silent unwiring.
- Credential-usage resolution is by FK wiring (asset stream → asset default → class-override stream → integration `config.monitorCredentialId`), NOT polling-method type-match — it answers "where is this configured." This is not contradicted by the WRITE-time guard added to the asset PUT in 2026-09 (`assertCredentialAssignments` in `api/routes/assets.ts`, using `utils/pollingCompatibility.ts → credentialTypeForPollingMethod()`): that guard refuses a PER-STREAM slot whose credential type cannot serve the stream's transport, and deliberately never type-checks `monitorCredentialId` for exactly the reason stated here — the asset default serves all eight streams at once and they may poll over different transports. A credential of the wrong type was previously accepted and then dropped at COLLECT time by `loadClassOverrideStreamCredential` / `resolveSnmpConfigForStream`, so the asset saved clean and silently collected nothing. The eight stream slots (`CREDENTIAL_STREAMS`) are responseTime / cpuMemory / temperature / interfaces / lldp / customWidget / processes / eventLog; storage rides `interfaces`. The manual tier (Setting "manualMonitorSettings") carries no default credential, so manual assets resolve through asset + class tiers only.
- **Stamped-default reclassification:** discovery stamps the integration's credential onto each discovered asset's `monitorCredentialId` (buildClassMonitorStamp in discoveryEngine.ts), so by raw FK every discovered asset would read as "asset level." The usage resolver reclassifies a default whose value is a member of the asset's integration's credential set (`intCredSets` — every `*CredentialId` value in the integration config, collected by `collectCredentialIds`) as **integration level**. A per-stream slot match, or a default pointing at a credential the integration doesn't provide (or a manual asset), stays asset level. Counts are unaffected by the relabeling — only the slide-in grouping.
- validateConfig is called on CREATE and on PUT (after merge), catching type/field mismatches early.

**When changing this:**
- Test secret masking round-trip (GET → masked, PUT w/ mask → original preserved).
- A new mutating route on this store needs `requireOwnership("credentials")` + `assertOwnership`, not `requirePermission("credentials","write")` — and if it can act on a stored row, ask first whether it hands that row's SECRET to the caller's chosen target (the `/test` question). Coverage: tests/integration/credentialOwnership.test.ts.
- Add new credential types: extend CredentialType union, add SECRET_FIELDS_BY_TYPE entry, add validateXxxConfig branch.
- Test all SNMP v3 security-level combos (noAuthNoPriv, authNoPriv, authPriv); validate protocol enums.
- Add a new per-stream credential slot: add it to `CREDENTIAL_STREAMS` so usage + the delete guard cover it (and to the schema on both Asset and MonitorClassOverride). Tests live in tests/unit/credentialUsage.test.ts.
- Verify REST API baseUrl normalization (trim, remove trailing slash, require http/https scheme).
- `SshConfig.publicKey` is NOT a secret and must stay out of `SECRET_FIELDS_BY_TYPE.ssh` — see services/windowsSshOnboardingService.ts.

---

## services/sshHostKeyService.ts

**What it owns:** Trust-on-first-use pinning for SSH SERVER host keys — the `SshHostKey` table, the verify/pin decision, the fingerprint + key-type parsers, and the operator list/delete.

**Public API:** `SshHostKeyRecord`, `HostKeyVerdict`, `fingerprintKeyBlob`, `keyTypeFromBlob`, `verifyOrPin`, `listHostKeys`, `deleteHostKey`, `_resetCaches`.

**Cross-service deps:** `db` (prisma), `eventLogService`, `utils/errors`, `utils/logger`.

**Used by:**
- src/utils/remoteExec.ts — `buildHostVerifier` (dynamic import), which feeds BOTH `ssh2.connect` sites: `withSshClient` (agent install/upgrade/uninstall, agentless process collection) and `monitoringService.probeSsh`
- src/api/routes/serverSettings.ts — `GET /agents/ssh-host-keys`, `DELETE /agents/ssh-host-keys/:id`
- public/js/agent-ssh-onboarding.js — the pinned-keys pane

**Invariants:**
- **Opt-in per credential** (`SshConfig.verifyHostKey`), default OFF. Absent the flag, `buildHostVerifier` returns null and ssh2 behaves exactly as it did pre-2026-08 (accepts any host key). This is the compatibility guarantee that lets the feature ship without breaking installs whose hosts were never pinned — do not flip the default without a fleet-wide pinning plan.
- **Fails closed.** A verification error rejects the connection. An operator who ticked the box must never get a silently-unverified connection.
- **A mismatch never overwrites the pin.** Overwriting would defeat the entire mechanism; the operator deletes the pin deliberately.
- Fingerprints are `SHA256:<base64, unpadded>` — byte-identical to `ssh-keygen -lf` so they can be compared by eye during an incident. Do not add padding or switch to hex.
- Pins are keyed `(host, port)` and live in their own table, NOT on `Credential.config`: host keys are per-host, one credential spans a fleet.
- **Hot path.** `withSshClient` runs on the per-minute agentless-processes cadence, so lookups are served from a module-level Map and `lastSeen` writes are throttled hourly. A cache hit that disagrees still re-reads the DB before rejecting — otherwise a just-deleted pin would be a permanent rejection on that process.
- `keyTypeFromBlob` is display-only and bounds the declared length before slicing; a malformed blob degrades to `"unknown"` rather than failing an otherwise-valid connection.
- Deleting a pin is audited at **warning** level — it re-opens first-use trust for that host.

**When changing this:**
- Mock-only tests cannot cover the handshake. Verify against a real `ssh2.Server`: pin → match → swap the server's host key → confirm refusal → delete the pin → confirm re-pin. (Attach an `error` handler to the SERVER-side connection in any such harness; the client drops mid-KEX when it refuses, and the resulting server-side event is otherwise unhandled and crashes the script.)
- Tests: `tests/unit/sshHostKey.test.ts` (18 cases, incl. the opt-in gate and fail-closed).
- Any new `ssh2.connect` call site MUST route through `buildHostVerifier`; there are deliberately only two.

---

## services/sshOnboardingScript.ts

**What it owns:** Pure generation of the SSH onboarding scripts an operator pushes to their fleet before Polaris can install the agent over SSH — a remediation + detection pair PER PLATFORM (Windows PowerShell, Linux bash) — plus the strict input validators that guard them. No I/O.

**Public API:** `SshOnboardingAccountMode`, `WindowsOnboardingScriptOptions`, `LinuxOnboardingScriptOptions`, `buildWindowsOnboardingScript`, `buildWindowsOnboardingDetectionScript` (takes `publicKey` + `username` + `accountMode` — every builder on both platforms names the account now), `buildLinuxOnboardingScript`, `buildLinuxOnboardingDetectionScript`, `assertValidPublicKey`, `assertValidUsername`, `assertValidLinuxUsername`, `assertValidServerIp`, `WINDOWS_ACCOUNT_DESCRIPTION`, `WINDOWS_DESCRIPTION_MAX`.

**Cross-service deps:** `utils/errors` (AppError), `utils/cidr` (isValidIpv4 / isValidCidr).

**Used by:**
- src/services/windowsSshOnboardingService.ts — renders both scripts for `GET /server-settings/agents/windows-ssh/script`, and reuses the validators at config-save time so a bad value is rejected on save rather than on download.

**Invariants:**
- **Operator input is REJECTED, never escaped.** `username` / `polarisServerIp` / `publicKey` are interpolated into PowerShell an admin then runs FLEET-WIDE as SYSTEM — that is effectively RCE on every Windows endpoint, so the validators are allowlists (`/^[A-Za-z0-9._-]{1,64}$/`, optionally `DOMAIN\user`; a key-type + base64 + conservative-comment regex; an IPv4 address or CIDR). `psLiteral` doubling of `'` is belt-and-braces behind that, not the primary defense.
- The shared predicates (`POLARIS_PS_HELPERS` for PowerShell, `POLARIS_SH_HELPERS` for bash) are emitted into BOTH of a platform's scripts from ONE constant — key presence, and on Windows the Administrators-membership test. Detection must never drift from what remediation writes, or the pair oscillates. `tests/unit/sshOnboardingScript.test.ts` asserts the emitted function bodies are character-identical across the pair, per predicate.
- That predicate matches on the key BODY (algorithm + base64) and ignores the trailing comment, so a comment change does not append a duplicate line.
- The emitted script APPENDS to `administrators_authorized_keys` and never overwrites it — other keys in that file belong to someone else.
- ACLs and group lookups use well-known SIDs (`S-1-5-32-544`, `S-1-5-18`), never the localized names "Administrators"/"SYSTEM".
- `accountMode:"create"` + a `DOMAIN\user` name is a hard error: `New-LocalUser` cannot do it, and emitting a script that fails on every endpoint is worse than refusing at authoring time.
- **`New-LocalUser`'s PARAMETER-VALUE limits are part of the contract, and they are not syntax.** `-Description` is capped at 48 characters and `-Name` at 20 (the SAM limit); exceeding either throws `ParameterArgumentValidationError` on the endpoint while the script still parses perfectly. Both are enforced here: the description is the `WINDOWS_ACCOUNT_DESCRIPTION` constant, asserted by a unit test against the EMITTED script rather than left to whoever next edits the wording; and a create-mode name over 20 characters is a hard reject, the same refuse-don't-emit reasoning as the domain-account case above. Only create mode gets the name cap — an existing account demonstrably exists, so a length rule there could only refuse something that already works. Found 2026-09-17, the first time create mode was run on a real Windows host: the description had shipped at 68 characters, so that mode had never once succeeded.
- An unsupported Windows build exits **0** (with an `unsupported:` marker) from both scripts. Non-zero would loop a detection/remediation pair forever against a device remediation cannot fix.
- Emitted PowerShell must stay idempotent — it runs on every boot under GPO and every cycle under a Remediation. The same applies to the bash: it runs on every config-management pass.
- **Linux specifics that are load-bearing, not decoration:** `~/.ssh` 700 + `authorized_keys` 600 + correct ownership (sshd silently refuses otherwise); `restorecon` for the SELinux context on RHEL-family (same silent failure); and the NOPASSWD sudoers drop-in, because the agent installer runs `sudo -n` — key auth alone cannot install an agent, so omitting it would just relocate the manual step.
- **The sudoers drop-in is validated with `visudo -cf` BEFORE `install`.** A malformed drop-in locks sudo out for EVERY user on the host, which is far worse than a failed onboarding. Never reorder those two steps.
- The Linux script deliberately does NOT install `openssh-server`: distro-specific package management, and a host you cannot already reach over SSH is not one this script was delivered to.
- **Both platforms' detection checks the account as well as the key (business rule 72).** Linux checks the account and the sudoers drop-in; Windows checks that the account exists, is enabled and is in local Administrators. These are prerequisites the install genuinely fails without, so omitting them reports an unusable endpoint compliant — which is exactly what Windows did until 2026-09-18, when a fleet was found reporting `ok: Polaris SSH onboarding present` on machines where the account had never been created. **Windows detection also checks the FIREWALL, as remediation settles it for the same `polarisServerIp`.** `buildWindowsOnboardingDetectionScript` takes `polarisServerIp`, and `getOnboardingScript` passes the one saved value to BOTH builders; passing different values makes the pair disagree. With an address (`DETECT_FIREWALL_PS`): `Polaris SSH (TCP 22)` exists exactly once, is enabled, has profile `Any`, and allows that address compared as a NETWORK by `ConvertTo-PolarisNetwork` (`CONVERT_NETWORK_PS`, emitted only in this mode), because Windows may store a CIDR in mask form and a text comparison would loop forever; and no `OpenSSH-Server-In-*` rule is enabled. Without one (`DETECT_NO_FIREWALL_PS`): every built-in rule's profile is `Any` or matches `Domain`, which is the same predicate text as `NO_FIREWALL_PS`, and Enabled is NOT judged, because remediation never re-enables a rule an operator disabled. Both blocks are inserted with FUNCTION replacers: `CONVERT_NETWORK_PS` contains `'^\d+$'`, whose `$'` a string replacement would expand. Linux detection still judges no firewall, since its remediation only ADDS a firewalld/ufw allow and never settles a blocking rule. Found 2026-09-24: an endpoint onboarded before the remediation reached it passed detection with Windows' rule Private-only on a DomainAuthenticated network, so it was never remediated and the agent install timed out on the SSH handshake. Business rules 72 and 76 were amended.
- **The Windows firewall rule Polaris writes is not the only one on the endpoint, and the other one is Private-only (business rule 76).** `Add-WindowsCapability` makes Windows create `OpenSSH-Server-In-TCP`, which allows TCP/22 from ANY source on the **Private profile alone** — so a domain-joined endpoint (Domain profile) runs sshd that nothing can reach, and a Private-network one has port 22 open to every host on it no matter how tightly `Polaris SSH (TCP 22)` is scoped, because firewall rules are additive ALLOWS. The Polaris rule was always `-Profile Any` and never the blocked one. Remediation now settles Windows' rule both ways: **with** a `polarisServerIp` it disables it (the scoped Polaris rule becomes the only inbound path, which is what makes the "scopes inbound TCP/22 to …" claim in the script header, the card and the wiki true); **without** one it widens it from `Private` to `Domain, Private`. Public is never added — reachable-from-Domain is the defect, an any-source TCP/22 rule on an airport Wi-Fi profile is not. The lookup is by NAME and wildcarded (`OPENSSH_BUILTIN_RULE_NAME` = `OpenSSH-Server-In-*`): the DisplayName is localized and the suffix is build-dependent, and `-ErrorAction SilentlyContinue` keeps a no-match from throwing under the script's `$ErrorActionPreference = 'Stop'`.
- **`accountMode:"existing"` VERIFIES and REFUSES; it never mutates.** The emitted block checks the named account exists, is enabled and is an administrator, and exits 1 with `error: account ... does not exist on this host` otherwise — matching `LINUX_ACCOUNT_EXISTING_SH`, which always did. It must not "helpfully" `Add-LocalGroupMember`: an operator who chose an existing account did not ask Polaris to promote it. Before this, the block printed `Using existing account` and continued, so the script appended the key, applied the ACL and exited 0 for an account that was not there — a fleet reporting fully onboarded that could never accept a logon.
- **Windows group membership is resolved three ways because one is not enough.** By SID (`S-1-5-32-544`), because the name is localized; via `Get-LocalGroupMember` with a WinNT-provider fallback, because on an Entra-joined endpoint that cmdlet either returns unresolvable members as raw `S-1-12-1-…` strings or throws outright and yields nothing; and compared on the LEAF name, because the same member reads `DOMAIN\user` from one path and bare `user` from the other. The leaf comparison cannot distinguish a local `svc` from a domain `CORP\svc` — accepted, because the alternative answers "no" depending on which path the endpoint happened to take.
- **An sshd that will not start is reported with its binary and its SCM event, never bare.** The capability check only asks whether `OpenSSH.Server` reads `Installed`; it never checks the version or whether sshd can run, and it never removes and reinstalls. Found 2026-09-24 on a Windows 10 Enterprise LTSC 2021 (19044) fleet: the capability read `Installed` while `sshd.exe` was a years-stale `OpenSSH_7.7p1` (a healthy peer on the same build had 9.5p2). The service timed out on start (SCM 7009/7000, error 1053), and Intune showed only `remediate: sshd not running` and `Start-Service : … cannot be started`. The fix on the endpoint was `Remove-WindowsCapability` then `Add-WindowsCapability`. The shared helper `Get-PolarisSshdDiagnostics` (in `POLARIS_PS_HELPERS`, so it is character-identical in both halves) returns one line: the `ProductVersion` of the exe the `sshd` service's `PathName` points at, and the newest Service Control Manager error (7000/7009/7011/7023/7024/7031/7034, last 7 days) whose message names sshd/OpenSSH, flattened and capped at 300 chars. Remediation wraps `Start-Service` and on failure prints `error: sshd failed to start - …` plus that line, then exits 1. Detection appends it to `remediate: sshd not running (…)`. The helper must never throw, since it only decorates a failure already being reported: every probe is in try/catch, and `Get-WinEvent` throws on an empty result. Self-repair (remove + reinstall the capability from remediation) was deliberately NOT added, because a fleet-wide SYSTEM script removing Windows features, possibly leaving a pending reboot, is a bigger change than this script makes anywhere else.
- Because Windows detection names the account, it can no longer render without one: `getOnboardingScript`'s "enter the existing account first" refusal used to carve Windows detection out, and no longer does.
- `assertValidLinuxUsername` is STRICTER than the Windows one: POSIX charset, lowercase-leading, ≤32 chars, and an explicit rejection of `DOMAIN\user` with a message saying why. Sharing one validator would either admit a value Linux cannot use or reject a valid Windows one.

**When changing this:**
- Re-run `tests/unit/sshOnboardingScript.test.ts` (82 cases; injection attempts, both account modes, firewall on/off, the profile the rule lands on and what happens to Windows' own rule, predicate sharing, the `New-LocalUser` parameter limits, the account + Administrators checks in both halves, the sshd start-failure diagnostics, the detection firewall check in both server-address modes).
- **Parsing is necessary and NOT sufficient.** A cmdlet parameter-VALUE limit (see the `New-LocalUser` invariant) yields a script that parses clean and then fails on every endpoint, so a parser check proves syntax alone — assert the emitted values too. Validate any change to the emitted script with the real parser, not by eye: `[System.Management.Automation.Language.Parser]::ParseFile(...)` for PowerShell, `bash -n` for the shell. TS template literals collide with BOTH — `${` is interpolation and bash uses `${VAR}` constantly, PowerShell uses `$` and backtick — so escaping mistakes are easy and silent.
- Better still, RUN the Linux script: `podman run --rm -v <dir>:/scripts:ro debian:bookworm-slim bash -c 'apt-get install -y sudo passwd && bash /scripts/polaris-ssh-onboarding.sh'`, twice, and confirm one key line, 700/600/440 modes, a locked password, and that `su - <user> -c "sudo -n id -u"` returns 0.
- Loosening a validator regex is a security change — re-check `psLiteral` still holds.
- Avoid `${` in emitted PowerShell (TS template-literal interpolation) and escape any literal backtick.

---

## services/windowsSshOnboardingService.ts

**What it owns:** The "Windows SSH Deployment" workflow on Integrations → Polaris Agent — generating/rotating the ed25519 deployment keypair, owning the Polaris-managed `ssh` Credential that stores it, and the non-secret card config in the `windowsSshOnboarding` Setting.

**Public API:** `WindowsSshOnboardingConfig`, `WindowsSshOnboardingState`, `SaveOnboardingConfigInput`, `OnboardingScriptKind`, `OnboardingScriptResult`, `MANAGED_CREDENTIAL_NAME`, `getOnboardingState`, `saveOnboardingConfig`, `generateKeypair`, `getOnboardingScript`, `sshPublicKeyFingerprint`, `_invalidateCache`.

**Cross-service deps:** `credentialService` (createCredential / getCredential / validateConfig), `sshOnboardingScript`, `settingsStore`, `eventLogService`, `db` (prisma), `ssh2` utils.

**Used by:**
- src/api/routes/serverSettings.ts — `GET|PUT /server-settings/agents/windows-ssh`, `POST /agents/windows-ssh/generate`, `GET /agents/windows-ssh/script`
- public/js/agent-ssh-onboarding.js — the card, via `api.serverSettings.agentWindowsSsh*`

**Invariants:**
- **The private key is never returned by any read path.** Only the public half + `SHA256:` fingerprint leave the service (the Web Push VAPID posture). There is deliberately NO escrow: losing `POLARIS_SECRET_KEY` means regenerate + re-run the script, which is why the generated script is idempotent.
- `SshConfig.publicKey` must stay OUT of `SECRET_FIELDS_BY_TYPE.ssh`. If it were masked, the onboarding script could not be re-rendered without rotating the key and re-touching every endpoint.
- Rotation **replaces** the credential config via `validateConfig` + a direct `prisma.credential.update`, NOT `updateCredential`. `mergeConfigPreservingSecrets` reads an empty string for a secret field as "keep the stored value" (that is what lets the edit modal round-trip a mask), so it cannot clear a stale `password` — and `remoteExec` silently prefers `privateKey`, making a leftover password dead config that still reads as a live secret in the UI.
- The key must be generated BEFORE `createCredential`: `validateSshConfig` requires a password or a private key, so an empty `ssh` credential cannot be created and keyed afterwards.
- `credential.ssh_keypair_generated` is stamped at **warning** level — rotating locks Polaris out of every endpoint until the script re-runs fleet-wide.
- **`getOnboardingScript` refuses ALL FOUR scripts until the account is named.** An existing account has no default name (`defaultUsernameFor` returns `""`; only create mode prefills `polaris-agent`), and every builder on both platforms now interpolates the username — Windows detection was the last carve-out and lost it with business rule 72. The refusal carries its own message rather than the validator's bare "username is required", because it also surfaces in the Intune and Arc publishing paths.
- A `credentialId` pointing at a row an admin deleted reads as "no keypair yet" (offer Generate), never a 500.
- Config is validated with the SAME validators the script generator uses, so bad input fails at save time rather than at download time.
- **Only a created account has a default username** (`polaris-agent`, via `defaultUsernameFor`). An existing-mode account defaults to `""`: save refuses it blank, and `getOnboardingScript` refuses ALL FOUR scripts until one is entered (every builder on both platforms names the account since business rule 72; Windows detection was the last that did not). Defaulting existing mode to `polaris-agent` let the card publish an Intune remediation whose credential logged in as an account nothing had created. `generateKeypair` still writes `polaris-agent` onto the credential when the account is unnamed, because `validateSshConfig` requires a username; the first save replaces it.
- The card's Username input reads `state[platform].username`, never a top-level `username` (there is none — reading it rendered the box permanently blank, so a saved account never showed and a blank Save was refused). Its placeholder follows the mode radio: `<domain>\<username>` (Windows) / `<username>` (Linux) for an existing account, `polaris-agent` for a created one.

**When changing this:**
- `POST /agents/windows-ssh/generate` must keep BOTH gates: `serverSettingsSystem:write` (that key's top rung since the 2026-09-23 split) AND `credentials:write`. It mints a fleet-wide admin credential; the second gate is not redundant.
- Import ssh2's `utils` off the DEFAULT export. It is CommonJS and cjs-module-lexer surfaces `Client` but not `utils`, so a named import throws at module load under Node's ESM loader even though Vitest interops it fine.
- Tests: `tests/unit/windowsSshOnboarding.test.ts` (in-memory prisma double so credentialService's real validation/masking runs).

---

## services/loginAccessService.ts

**What it owns:** Persistence + the decision for the optional source-IP restriction on LOCAL LOGIN — the `loginAccessConfig` Setting row `{ enabled (default false), ipScope ("rfc1918"|"all"|"custom", default "rfc1918"), allowedCidrs }` — with a ~10s TTL in-process cache. Shape mirrors `dashConfig`, but the **polarity is inverted**: `enabled` false means NO restriction.

**Why it exists:** With "Skip login page" on, unauthenticated visitors — to a protected page and, since 2026-09-06, to `/login.html` itself — are redirected straight to SSO, but the form stays reachable as `/login.html?local=1` (the anti-lockout path during an IdP outage, and deliberately guessable), so the password form stays reachable to anyone who types that URL and the password endpoints to anyone who can POST. That is the right default; this setting is for installs that want the recovery path to exist only from inside the network.

**Public API:** `getLoginAccessSettings`, `saveLoginAccessSettings`, `invalidateLoginAccessCache`, `defaultLoginAccessSettings`, `loginSourceAllowed` (pure), `isLoginSourceAllowed` (request path, fail-open), `LOGIN_ACCESS_SETTING_KEY`, `LoginAccessSettings`

**Cross-service deps:** `src/utils/ipScope.ts` (`ipInScope`, shared with the dash gate), `src/utils/cidr.ts` (`normalizeAllowlistCidr`), `AppError` (prisma otherwise).

**Used by:** `src/app.ts` (the gate middleware over `/login.html` + every path in `LOGIN_CREDENTIAL_PATHS` — the password POST, the TOTP step, both passkey pairs and the forced password-change step), `src/api/routes/serverSettings.ts` (`GET/PUT /server-settings/login-access`, incl. the anti-lockout guard's use of the pure `loginSourceAllowed`).

**Where it is edited (2026-09):** Users → Authentication → **Settings**, as the "Trusted Networks for Login" section, beside the password policy and the passkey policy — `public/js/users.js` → `buildLoginAccessSection()` / `getLoginAccessFormData()`. Server Settings → Web Server keeps a read-only status card that names the current scope and points here; it no longer edits the row. Two screens writing one Setting is how the two drift into disagreeing about what is configured. The ROUTES did not move — both surfaces call `GET/PUT /server-settings/login-access`.

**Invariants:**
- `enabled` defaults FALSE. Enabling REFUSES logins, so an upgrade must never start doing it on its own — the opposite reason to `dashConfig`'s safe-off default, same result.
- `isLoginSourceAllowed` **FAILS OPEN**: a settings read that throws admits the request. A DB blip must not become the lockout this feature exists to prevent, and an attacker cannot induce one. (`loginSourceAllowed` is the pure form and does NOT swallow anything — the route's guard needs a real answer.)
- The gate covers the local password path AND the **LDAP** path — both authenticate through `POST /auth/login`. Every SSO entry point (SAML / OIDC / App Proxy) is deliberately NOT gated: SSO is what must keep working from anywhere, which is what makes restricting this one safe.
- `saveLoginAccessSettings` rejects an enabled+custom+EMPTY list (would block local login everywhere). Disabling is how you turn the restriction off.
- The setting restricts new LOGINS, not existing sessions — which is how an operator who narrows the scope too far can still undo it.
- Only as trustworthy as `req.ip`: behind two proxies with a one-hop `TRUST_PROXY`, `req.ip` is the INNER proxy's (RFC1918) address, so an "rfc1918" scope would admit the entire internet while reading as enforced. `GET /server-settings/login-access` returns `callerIp` and the card prints it for exactly this reason.

**When changing this:**
- New fields need a default + tolerant parse + merge handling, AND the Settings-tab section (`public/js/users.js` `buildLoginAccessSection`/`getLoginAccessFormData`) + the read-only summary on Server Settings → Web Server (`public/js/server-settings.js` `loginCardHtml`) + the `PUT /server-settings/login-access` Zod schema + the route's anti-lockout guard updated in lockstep.
- If you add another credential endpoint, add it to `LOGIN_CREDENTIAL_PATHS` in `src/app.ts` — the gate is an explicit path set, not a prefix, so a new one is unguarded by default. The passkey login pair is the case that proves it: `POST /auth/passkeys/login` issues a session outright with no password step in front of it, so a miss there leaves a restricted install reachable from anywhere with nothing in the UI to show it.
- Keep the two refusal shapes: the PAGE is dropped (socket destroy, no response — the dashServer stealth posture), the API returns the SAME generic 401 a wrong password gets. Neither may confirm "wrong network".
- Coverage: `tests/unit/loginAccessService.test.ts`, `tests/integration/loginAccessGate.test.ts` (both halves + SSO-never-gated), `tests/integration/loginAccessRoutes.test.ts` (anti-lockout guard + audit).

---

## services/apiDocsAccessService.ts

**What it owns:** Persistence + the decision for the source-IP scope over the unauthenticated `/api` developer-docs page — the `apiDocsConfig` Setting row `{ enabled (default TRUE), ipScope ("loopback"|"rfc1918"|"custom", default "rfc1918" — deliberately NO "all"), allowedCidrs }` — with a ~10s TTL in-process cache (loginAccessService pattern), plus the nginx allow-line derivation for the managed proxy config's `location = /api` block.

**Why it exists:** The docs page enumerates the external API surface and requires no login, so which networks can reach it IS the access control. The scope therefore never offers "all", and a custom entry outside RFC1918 space is refused at save AND filtered out on read.

**Public API:** `getApiDocsSettings`, `saveApiDocsSettings`, `invalidateApiDocsSettingsCache`, `defaultApiDocsSettings`, `docsSourceAllowed` (pure), `isApiDocsSourceAllowed` (request path, FAIL-CLOSED), `deriveApiDocsNginxAllow` (pure — the nginx allow lines), `API_DOCS_SETTING_KEY`, `ApiDocsSettings`, `ApiDocsIpScope`

**Cross-service deps:** `src/utils/ipScope.ts` (`ipInScope` — shared with the dash + login gates), `src/utils/cidr.ts` (`isLoopbackIp`, `isRfc1918Cidr`, `normalizeAllowlistCidr`, `RFC1918_RANGES`), `settingsStore`, `AppError`.

**Used by:** `src/app.ts` (the gate middleware over `/api` + `/api/` + `/api.html`, and the `GET /api` handler), `src/api/routes/serverSettings.ts` (`GET/PUT /server-settings/api-docs`), `src/services/nginxApplyService.ts` + `src/services/updateService.ts` (both render call sites thread `deriveApiDocsNginxAllow(...)` into `RenderInput.apiDocsAllow`).

**Invariants:**
- `enabled` defaults TRUE with the rfc1918 scope — unlike dash/login-access this surface ships on, because RFC1918+loopback is already private-network-only and the docs are the feature.
- `isApiDocsSourceAllowed` **FAILS CLOSED** — the deliberate opposite of `isLoginSourceAllowed`: this fronts an unauthenticated disclosure surface, so a settings-read blip hides the docs briefly rather than exposing them. (`docsSourceAllowed` is the pure form and swallows nothing.)
- Loopback is ALWAYS allowed while enabled (`isLoopbackIp` short-circuit — a scope that locks the host out of its own docs serves nobody); disabled denies everyone, loopback included — off means off, so the toggle can fully retire the surface.
- Custom entries must pass `normalizeAllowlistCidr` AND `isRfc1918Cidr` — enforced at save (400 naming the entry) and re-applied on read, so a hand-edited Setting row cannot smuggle a public CIDR. The parse also uses a LOCAL scope guard, never `isIpScope` (which would admit "all").
- `deriveApiDocsNginxAllow` is pure and deterministic (loopback pair first) — it feeds the sha256-deterministic renderer. nginx is defense in depth only; the app gate is authoritative on every install type (dev and Docker have no managed nginx at all).
- The gate DROPS unauthorized sources (socket destroy — dash/login stealth posture) and covers `/api.html` explicitly, because `express.static` would otherwise serve `public/api.html` around the gate.

**When changing this:**
- New fields need a default + tolerant parse + merge handling, AND the API-Tokens-tab card (`public/js/server-settings.js` `_apiDocsCardHtml`/`saveApiDocsAccess`) + the `PUT /server-settings/api-docs` Zod schema updated in lockstep.
- The docs CONTENT lives inline in `public/api.html` (the gated artifact); `public/js/api-docs.js` must stay generic — it is served ungated by static, so nothing endpoint-enumerating may move into it.
- Coverage: `tests/unit/apiDocsAccessService.test.ts` (RFC1918 rejection, loopback-always, fail-closed, derive arrays, read-side re-filter), `tests/integration/apiDocsGate.test.ts` (three gated paths, off-means-off drop, /api/v1 untouched, route pair).

---

## services/roleService.ts

**What it owns:** CRUD over the `Role` table for the dynamic-role RBAC model — enforces protected/built-in/custom invariants, normalizes the permission matrix + tags, emits `role.*` Events, and bumps the role-version cache so live sessions refresh.

**Public API:** `RoleSummary`, `CreateRoleInput`, `UpdateRoleInput`, `listRoles`, `getRole`, `getRoleByName`, `createRole`, `updateRole`, `deleteRole`, `countAdminEquivalentUsers`, `isAdminEquivalentRole`

**Cross-service deps:** `prisma`, `AppError`, `logEvent`, `tagNormalize`, `bumpRoleVersion` + `normalizePermissions` + `FUNCTION_KEYS` (permissions middleware).

**Used by:** `src/api/routes/roles.ts` (CRUD + `GET /roles/functions`), `src/api/routes/users.ts` (role assignment + admin-equivalent checks).

**Invariants:**
- Protected roles (`admin`, `readonly`) can't be edited/renamed/deleted; built-in roles (`networkadmin`, `assetsadmin`, `user`) can be edited but not deleted; reserved names are case-insensitively protected even for new custom roles.
- Delete refuses with 409 when any user holds the role; `regionTags`/`otherTags` are normalized (trim/dedupe/cap); badge color is `#rrggbb` or null.
- Every write bumps the role-version cache via `bumpRoleVersion` (live sessions refresh on next request) and emits a per-field diff Event.

**When changing this:**
- `countAdminEquivalentUsers` filters in JS (role counts are tiny) and backs the last-admin invariant alongside `userService`.

---

## services/totpService.ts

**What it owns:** RFC 6238 TOTP secret generation, enrollment QR codes, time-windowed code verification (±30s), and argon2id-hashed backup code generation and consumption.

**Public API:** generateSecret, buildEnrollment, verifyCode, generateBackupCodes, consumeBackupCode.

**Cross-service deps:** none.

**Used by:**
- src/api/routes/auth.ts — POST /totp/enroll, QR code + secret generation
- src/api/routes/auth.ts — POST /totp/enroll, render QR SVG
- src/api/routes/auth.ts — POST /login/totp, verify TOTP code during login
- src/api/routes/auth.ts — POST /totp/confirm, validate code at enrollment finish
- src/api/routes/auth.ts — POST /login/totp, consume backup code on fallback
- src/api/routes/auth.ts — POST /totp/confirm, generate backup codes on enable
- src/api/routes/auth.ts — DELETE /totp, consume backup code on disable
- src/api/routes/auth.ts — DELETE /totp, verify code before disabling

**Frontend surfaces** (the self-service flow — enroll QR + confirm, one-time backup codes, disable):
- `public/js/totp-self.js` — `window.PolarisTotpSelf`, the ONLY copy of those modals. `open()` routes off `GET /auth/totp/status`; a non-`local` `authProvider` is refused client-side too, because `POST /totp/enroll` rejects it and a QR code that can never be confirmed is worse than the reason.
- `public/js/app.js` — the page-header account menu’s two-factor row (`wireTotpState` / `_totpMenuItem` / `_openTotpSelf`, plus the shared `refreshTotpState` users.js calls after its own enroll/disable), offered on every page for `local` accounts. This is the reachability fix: /users.html is admin-gated, so before it a local user without `users` could not configure their own second factor at all.
- `public/js/users.js` — the Users-table row menu (own row → `openTotpSelfModal`, which now delegates to the shared module and passes `onChange: loadUsers`; another user’s row → the admin `DELETE /users/:id/totp` reset).
- Every page that loads `app.js` must also load `totp-self.js` AND `password-self.js` (each row omits itself when its module is absent, so a missed script tag fails quiet). The two ship together because they are gated on the same thing: `_changePasswordMenuItem` reads `authProvider` off the SAME cached `/auth/totp/status` payload rather than firing a second request to ask whether the account is `local`. A change to `wireTotpState` therefore silently decides whether the password row appears at all.
- `public/js/password-self.js` — `window.PolarisPasswordSelf`: the Change Password modal (`PUT /auth/password`) and the password-complexity checklist, which users.js's six same-named helpers now forward to. Client-side it mirrors `passwordPolicySchema` (`src/utils/password.ts`); that schema is the gate, this is the hint, and the reason the checklist moved out of users.js is that a second copy of the five regexes is how the two drift.

**Invariants:**
- TOTP secret must be base32-encoded; verify operations accept ±1 step (30s drift tolerance) to absorb client/server clock skew.
- Backup codes are 10 hex pairs (XXXX-XXXX format), argon2id-hashed on generation, never returned in plaintext after enrollment.
- Backup code consumption is stateless (caller must persist the returned array). Login-time code attempts are protected by the login lockout gate (5 failures, 15 min); the enrollment-confirm and self-disable routes (`POST /totp/confirm`, `DELETE /totp`) are additionally rate-limited by `totpCodeLimiter` (10 / 15 min per IP, `src/api/middleware/rateLimits.ts`).
- Two-phase login flow: password success → pendingToken issued; TOTP/backup-code step consumes pendingToken and upgrades to full session.

**When changing this:**
- Test both TOTP verification (standard code + ±1 step boundary) and backup code round-trips (generation, hashing, consumption, array mutation).
- Audit all call sites in auth.ts for pendingToken lifecycle (issue, consume at 195/226/233).
- If adjusting RFC 6238 params (SHA1, 6 digits, 30s step): users must re-enroll; plan migration messaging.
- Verify no secrets leak into logs (codes are transient; hashes are stored on User rows — check password.ts utility).

---

## services/passwordPolicyService.ts

**What it owns:** Persistence + enforcement of the operator-configurable password complexity bar — the `passwordPolicyConfig` Setting row `{ minLength (8–128, default 8), requireLowercase, requireUppercase, requireNumber, requireSpecial (all default true), forceChangeOnLogin (default false) }` — with a ~10s TTL in-process cache (the `loginAccessService` / `dashSettingsService` pattern). The RULES themselves are pure and live in `src/utils/passwordPolicy.ts`.

**Why it exists:** The bar used to be five hard-coded Zod refinements in `src/utils/password.ts`, which three surfaces shared so they could not drift. A Zod object is built at import time and cannot express a value read from a Setting row, so the schema became a SHAPE check (non-empty, ≤1024 chars) and the bar became one call every password-writing route makes after `.parse()`.

**Public API:** `getPasswordPolicy`, `savePasswordPolicy`, `invalidatePasswordPolicyCache`, `assertPasswordMeetsPolicy` (throws a 400 naming every unmet rule), `passwordNeedsPolicyChange` (the login-time question), `PASSWORD_POLICY_SETTING_KEY`

**Cross-service deps:** `src/utils/passwordPolicy.ts` (`parsePasswordPolicy`, `passwordPolicyError`, `clampMinLength`, `defaultPasswordPolicy`), `settingsStore`, `AppError`.

**Used by:**
- `src/api/routes/users.ts` — `POST /users` (admin create) and `PUT /users/:id/password` (admin reset)
- `src/api/routes/auth.ts` — `PUT /auth/password` (self-service change), `POST /auth/login/password-change` (the forced change), `POST /auth/login` (the `passwordNeedsPolicyChange` probe), `GET/PUT /auth/password-policy`
- `src/setup/setupRoutes.ts` — the first admin the wizard mints, asserted BEFORE any provisioning so a rejected password leaves no half-created database
- `public/js/password-self.js` — fetches `GET /auth/password-policy` once per page and repaints every rendered checklist

**Invariants:**
- **Fails to the DEFAULTS, never to "no policy".** A read that throws resolves to `defaultPasswordPolicy()` — the five rules this product shipped with. This is the OPPOSITE posture to `loginAccessService`'s fail-open, and for the same reason: there, failing safe means letting people IN (a lockout is the hazard); here, failing safe means keeping the bar UP while a Setting row is unreadable.
- The defaults ARE the pre-2026-09 behaviour. An install that never opens the tab is gated exactly as it was — a drift here silently moves the bar for every such install on upgrade.
- `minLength` clamps to **[8, 128]** at parse AND at save. 8 is NIST SP 800-63B's memorized-secret minimum and is not configurable below.
- Turning every character class off is a legitimate posture (NIST discourages mandatory composition rules), not a misconfiguration to correct.
- `passwordNeedsPolicyChange` is asked of the PLAINTEXT at login — the only moment a stored hash can be judged, a hash being one-way. The alternative (a "changed before the policy" timestamp) would interrupt users whose password already complies.
- It returns false whenever `forceChangeOnLogin` is off, and never throws: a login must not 500 because a Setting row is unreadable.

**When changing this:**
- A new rule needs: the knob in `PasswordPolicy`, a `passwordRules()` entry (server), a `TESTS` entry (client, `public/js/password-self.js`), a control in `buildPasswordPolicySection()` + `getPasswordPolicyFormData()` (`public/js/users.js`), and the `PUT /auth/password-policy` Zod schema. The client checklist fetches the LABELS but ships the PREDICATES, so both halves move together.
- `GET /auth/password-policy` is deliberately UNAUTHENTICATED — the setup wizard, the forced-change step at login and the login page all need the rules before there is a session. It discloses a minimum length and which classes are required, which any caller also learns by submitting one bad password.
- Coverage: `tests/unit/passwordPolicy.test.ts` (the pure rules + the defaults), `tests/unit/passwordPolicyService.test.ts` (persistence + the failure posture), `tests/unit/passwordSelfModule.test.ts` (the client repaint), `tests/integration/forcedPasswordChange.test.ts` (the login flow, including the MFA-ordering invariant).

---

## services/passkeyService.ts

**What it owns:** WebAuthn passkeys for LOCAL accounts, end to end — the `passkeyConfig` Setting row `{ mode ("off"|"login"|"second-factor"|"both", default "both"), rpId ("" = derive from the request), requireUserVerification (default true) }` with a ~10s TTL cache; the four ceremonies (register, passwordless login, second-factor step, verification); and CRUD over `UserPasskey` rows.

**Why it exists:** A passkey is the one credential that is both unphishable and nothing to type, and it is the only stronger login path Polaris can offer that does not depend on an identity provider existing. `mode` is what makes it deployable into a FOSS fleet that disagrees about how much to trust it.

**Public API:** `getPasskeySettings`, `savePasskeySettings`, `invalidatePasskeyCache`, `defaultPasskeySettings`, `normalizeRpId`, `passkeyLoginEnabled`, `passkeySecondFactorEnabled`, `getPasskeyAvailability`, `requireRelyingParty`, `startRegistration`, `finishRegistration`, `startLogin`, `startSecondFactor`, `finishAuthentication`, `listPasskeys`, `countPasskeysByUser`, `renamePasskey`, `deletePasskey`, `deleteAllPasskeys`, `userHasPasskey`, `PASSKEY_SETTING_KEY`

**Cross-service deps:** `@simplewebauthn/server` (the only verification), `src/utils/webauthnRp.ts` (`resolveRelyingParty`, `forwardedProtoClaim`), `src/utils/webauthnChallenge.ts` (the in-flight ceremony store), `settingsStore`, `AppError`.

**Used by:**
- `src/api/routes/auth.ts` — `GET /auth/passkeys/config`, `POST /auth/passkeys/login/options`, `POST /auth/passkeys/login`, `POST /auth/login/passkey/options`, `POST /auth/login/passkey`, the self-service CRUD at `/auth/passkeys*`, and `GET/PUT /auth/passkey-settings`
- `src/api/routes/users.ts` — the passkey count on `GET /users` and the admin revoke at `GET|DELETE /users/:id/passkeys`
- `public/js/passkeys-self.js` (the account-menu modal), `public/js/webauthn.js` (the browser ceremony), `public/js/login.js` + `public/js/mobile/auth.js` (the login pages), `public/js/users.js` (the Settings tab policy + the row menu)

**Invariants:**
- **Local accounts only**, enforced at the route and re-checked at verification. A passkey on an SSO account would be a second, Polaris-owned way into an account the operator believes is centrally controlled.
- **Fails to `mode: "off"`** when the settings read throws — the opposite of `passwordPolicyService` and deliberate: this setting decides whether a credential may sign someone in, and passwords still work, so failing closed costs a fallback rather than access.
- It **never provisions a user.** Every other credential path in Polaris can mint an account; a discoverable-credential login that resolves to no row is an authentication failure, not a signup.
- `startLogin` issues **no `allowCredentials`** — naming a user's credentials before they authenticate would make the endpoint an account-enumeration oracle. That is why registration demands `residentKey: "required"`. `startSecondFactor` DOES name them: the caller already proved the password.
- The RP ID and origin are pinned into the ceremony at issue time and replayed at verify (`webauthnChallenge`). Re-deriving at verify would check the assertion against whatever the SECOND request claimed to be.
- Availability answers the request that ARRIVED, which behind a reverse proxy is not the page the browser is on. `requireRelyingParty` / `getPasskeyAvailability` pass `forwardedProtoClaim(req.headers)` down so a TLS-terminating proxy with `TRUST_PROXY` unset is told to set it rather than told to install TLS — the claim never grants the secure context, it only picks the sentence. The complementary half is client-side: `PolarisWebAuthn.unavailableHere(rpId)` catches a proxy that rewrote Host, which no server-side check can see.
- `requireUserVerification` (default true) is what makes a passkey acceptable as a whole login — UV is two factors in one gesture — and `POST /auth/passkeys/login` mirrors the flag into `session.mfaVerified` rather than asserting verification that did not happen.
- A signature counter that **decreases from a non-zero value** refuses the login (the one clone signal WebAuthn gives). Most platform authenticators pin it at 0 forever, so 0 → 0 is normal and not evidence of anything.
- Every "not recognized" refusal is the SAME message — unknown credential, bad signature, SSO-managed account, rolled-back counter. "That credential is not registered here" is a fact worth learning to someone probing with a key they control.
- No "last credential" guard on delete: a local account always has a password (a NOT NULL column, and there is no passkey-only signup), so removing every passkey cannot lock anyone out.

**When changing this:**
- A new ceremony endpoint needs four things in lockstep: the route, a `LOGIN_CREDENTIAL_PATHS` entry in `src/app.ts` if it can end in a session, a CSRF exemption in `src/api/middleware/csrf.ts` if it is pre-session (`/api/v1/auth/passkeys/login` is exempt and the segment-boundary match is what keeps `/passkeys/register` and `/passkeys/:id` protected), and a `passkeyCeremonyLimiter` mount.
- Registering a passkey under a mode that includes `second-factor` makes that account's login two-step, exactly as enrolling TOTP does. The admin path back from a lost authenticator is `DELETE /users/:id/passkeys` — the counterpart of the TOTP reset, and it must stay reachable.
- Coverage: `tests/unit/passkeyService.test.ts` (mode gates, ceremony guards, the failure posture), `tests/unit/webauthnRp.test.ts`, `tests/unit/webauthnChallenge.test.ts`, `tests/unit/webauthnBrowser.test.ts`, `tests/integration/passkeyRoutes.test.ts` (the gates, the CSRF boundary, the source-IP gate). A completed ceremony is NOT covered end to end — verifying an assertion needs an authenticator holding a private key, and a fixture signed against a fixed challenge would only pin the fixture.

---
