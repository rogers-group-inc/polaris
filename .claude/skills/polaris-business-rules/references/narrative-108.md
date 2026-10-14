# Business rule 108 — full narrative

> Written 2026-10-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 108](#rule-108) — A way into the install is checked against the account and the host behind it, not a spelling, a cookie that has outlived its owner, or a code already used

<a id="rule-108"></a>

## Rule 108 — A way into the install is checked against the account and the host behind it, not a spelling, a cookie that has outlived its owner, or a code already used

### Where it came from

The second phase of the follow-up to the 2026-10-11 whole-repository security scan: ten findings about the doors into Polaris rather than what is behind them. Each was a check that was true of the common request and false of a slightly different one.

### The ten, and the decisions taken

**The first-run wizard (F178).** It serves before any account exists, listens on every interface by default, and will connect to a database of the caller's choosing, create the administrator and write `.env`. Loopback-by-default was rejected: in a container the wizard is reachable only through a published port, so it would make a fresh `docker compose up` unusable. A one-time setup token was chosen instead — printed to the console and saved 0600 in the state directory, so reading it proves access to the host rather than the network, the same posture Jenkins and others take. It is deleted when setup finishes and can be pre-set for unattended provisioning. The wizard also now refuses values that would add a line to `.env`: the session secret reached the file unchecked, so a line break could add a variable such as `NODE_OPTIONS`.

**Spellings (F166, F234).** Express routes case-insensitively and ignores a trailing slash, so a gate that looks `req.path` up in a Set of exact lowercase strings is skipped by `POST /API/V1/AUTH/LOGIN/`. The login source-IP gate and the API docs gate now compare a canonical form. `/metrics` is different in kind: the shipped nginx restricts it with `location = /metrics`, an exact case-sensitive match, so `/Metrics` fell through to the app, which answered it. The app now answers any other spelling as an unknown path, which also protects direct installs. The installers were not changed to generate `METRICS_TOKEN` and `HEALTH_TOKEN`: the wizard that every script install ends in already writes both.

**A password step that forgave (F192).** The password step cleared the per-account failure counter before the second factor, so anyone who knew the password could submit four wrong codes, repeat the password, and guess codes indefinitely. The counter now survives the password step for an account that owes a second factor.

**A code used twice (F237).** `verifyCode` was stateless and accepted three adjacent 30-second steps, so a code that had logged someone in verified again for about 90 seconds (RFC 6238 section 5.2). Each account now records the last step it used, with one conditional UPDATE so two concurrent submissions cannot both win. Backup codes were already single-use.

**Sessions that outlived their account (F188).** A session carries its own role snapshot and `userId`, and nothing tied it back to the account. Deleting a user, changing their role, or resetting their password, second factor or passkeys left every session they held working. The routes now revoke the target's sessions, keeping the actor's own when they act on themselves, and a middleware re-checks the user row once a minute per session as a backstop for everything that does not go through those routes (a direct database change, an SSO group-mapping change, a restore).

**Passkey registration (F244).** Everywhere else a stolen session is treated as a threat — a password change needs the old password, disabling TOTP needs a code — but registering a passkey needed nothing, so a hijacked session could add an authenticator that signs in without a password or a second factor. It now needs the current password, chosen over "password or a fresh TOTP code" because every local account has a password.

**Tokens on self-service routes (F229).** `requireAuth` admits a bearer-token caller, who has no session and so no `userId`; Prisma reads `where: { userId: undefined }` as no filter, so a token could delete or rename any user's passkey by its id. The self-service routes need a user session, and the services refuse an empty userId.

**Conflicts (F239).** The routes called the synchronous `hasPermission` without anything having refreshed the role snapshot, so a role edit never reached a session that used only these routes and a token caller resolved no role at all. They now refresh it first. The handlers keep their filter-don't-403 behaviour deliberately: the nav badge polls the count, and a 403 there would be an error for every role without the key.

**SAML (F242).** The client was built with request binding off and no replay protection. Request binding is now on whenever a response carries an InResponseTo, and an assertion ID cache refuses a repeat.

### What it leaves open, on purpose

- **IdP-initiated sign-in is still accepted**, because Azure "My Apps" launches use it, so an attacker holding a validly signed response of their own could still sign a victim into the attacker's account (login CSRF). Closing it would break those launches.
- **The login lockout and the SAML replay cache are process-local**, like the existing lockout: the web role is one process and a restart or failover empties them.
- **A bad passkey password counts against the login failure budget**, so someone holding a session can lock the account out by guessing; that is the cost of not letting the session grind the password.

### 108(h)-(j) — the path the file handler resolves, the redirect the browser resolves, and login timing (2026-10-14, re-scan phase 13)

**F87.** `canonicalRoutePath` lowercased and trimmed `req.path`, but `req.path` is raw — not percent-decoded, repeated slashes and dot segments intact — while express.static decodes and normalizes before reading a file. `/%61pi.html`, `//api.html` and `/./api.html` missed the API-docs source gate and were served `public/api.html`; `/%6Cogin.html` missed the login-page drop. Two halves: `canonicalRoutePath` now resolves the way the static handler will (decode, collapse slashes, resolve dots), and an early middleware refuses (404) any request whose path is not already in that form — so a gate and the file served can never disagree, whatever the next normalization difference turns out to be. Under `/api/` percent-encoding stays allowed (the router does not decode while matching and parameters legitimately carry it); repeated slashes and dot segments are refused there too. Trailing slashes are left alone: the router ignores them and every gate compares the trimmed form. supertest resolves `/./` and `%2e` client-side, so those spellings are pinned in the unit test only.

**F11.** login.js checked the first two characters of the `polaris_next` cookie; the browser's URL parser strips ASCII tab / CR / LF before resolving, so `/\t/evil.example` passed and navigated off-origin. `safeLoginTarget` refuses control characters, then resolves with `new URL(raw, location.origin)` and requires the same origin and a single leading slash — the server's `safeNextPath` rule, now on both sides.

**F77.** With LDAP on, an unknown username skipped argon2 (the local path's cost) and took one LDAP connection, a directory user took two (search, then bind as the user). Both directions were an enumeration oracle. The LDAP branch now runs the dummy argon2 verify, and a name the directory does not find pays a second bind against `cn=polaris-no-such-user-<uuid>,<searchBase>` with a random password — a DN that cannot exist, so no real account's lockout counter moves and the user's typed password is not sent twice. A local account still skips the directory round-trip; padding to a fixed time was rejected as latency on every login for a residual of one LAN round-trip.
