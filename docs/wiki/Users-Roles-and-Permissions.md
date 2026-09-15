# Users, roles and permissions

**Users** in the sidebar (admin only). Four sections: **Users**, **Manage
Roles**, **Group Mappings**, **Authentication**.

---

## The model

Every route declares a **function key** plus a required **level**. A role is a
matrix over the 33 keys:

```
none  <  read  <  write  <  fullwrite
```

A user has one role. A bearer token is bound to one role at mint time and passes
the same gates a session does.

### Ownership

Five keys carry an **ownership dimension**: `subnets`, `reservations`,
`contacts`, `credentials`, `networkScan`.

| Level | Reaches |
|---|---|
| `write` | rows **you** created |
| `fullwrite` | anyone's |

**A row with no creator is unowned and therefore `fullwrite`-only.** Discovered
networks have no creator, which is why archiving one is `fullwrite` — retiring a
site's address space is not an own-rows action.

### Short ladders

A key may declare **fewer than four levels**. `assetsProbe` holds
`none | read` only: a probe dials the device and writes nothing in Polaris, so
Read *is* the whole grant, and the two cells above it were radio buttons no route
ever asked for.

The UI renders a dash instead of a radio for an unsupported cell. Stored values
**clamp down, never up** — a `fullwrite` on a read-only key means "as much as
possible", so rounding up would silently grant and resolving to `none` would
silently revoke.

---

## The 33 function keys

### Address space

| Key | |
|---|---|
| `ipBlocks` | top-level CIDR blocks |
| `subnets` | networks — **ownership**; `fullwrite` also covers exclusions and archive |
| `reservations` | including DHCP push — **ownership** |
| `allocationTemplates` | saved multi-network allocation templates |
| `staleReservations` | snooze / ignore stale DHCP reservation alerts + the threshold |

### Devices

| Key | |
|---|---|
| `assets` | inventory CRUD and export. **`fullwrite` = deploy the agent** |
| `assetsQuarantine` | push MAC quarantine to FortiGates, release, verify |
| `assetsProbe` | probe-now, SNMP walk, DNS lookup. **`none \| read` only** |
| `assetMonitorSettings` | monitor cadence and retention overrides at every tier. **`fullwrite` also gates the outage simulation** |
| `networkScan` | [active-scan Discoveries](Network-Discovery) — **ownership** |
| `processControl` | **vestigial** — process control was removed; the key remains for matrix compatibility and gates nothing |

### Monitoring configuration

| Key | |
|---|---|
| `mibDatabase` | upload / browse / walk SNMP MIBs |
| `manufacturerProfiles` | per-vendor telemetry profiles — CPU/memory/temperature OIDs, custom widgets |
| `manufacturerAliases` | vendor-name normalisation |
| `credentials` | stored SNMP / WinRM / SSH / REST / HTTP credentials — **ownership** |
| `deviceIcons` | operator-uploaded topology icons |

### Discovery

| Key | |
|---|---|
| `integrations` | integration CRUD + discovery |
| `discoveryConflicts` | accept / reject / merge conflicts |

### Maps

| Key | |
|---|---|
| `deviceMap` | the geographic map and topology graphs |
| `applicationMap` | the connectivity graph; `write` saves the shared layout |
| `mapRegions` | draw / edit / delete region polygons |

### Alerting

| Key | |
|---|---|
| `events` | audit log + archival settings + event retention |
| `alerts` | **read** = view · **write** = acknowledge · **fullwrite** = clear |
| `automationManagement` | automations and delivery channels |
| `automationScripts` | **RCE-equivalent** — see [Automation scripts](Automation-Scripts) |
| `maintenanceManagement` | maintenance windows. `write` grants nothing beyond `read`; CRUD is `fullwrite` |
| `contacts` | the address book — **ownership** |

### Platform

| Key | |
|---|---|
| `apiTokens` | long-lived bearer tokens |
| `users` | user CRUD, role assignment, TOTP reset |
| `roles` | **the matrix itself** — granting `fullwrite` is effectively granting admin |
| `savedDashboards` | named layouts; `write` **publishes** |
| `serverSettingsSystem` | HTTPS, branding, DNS, NTP, certificates, capacity, tags, HA |
| `serverSettingsData` | backup / restore, queue mode, security tokens, in-app updates |

---

## The five built-in roles

| Role | Editable? | Grants |
|---|---|---|
| **`admin`** | **protected** — cannot be edited or deleted, and is hidden from the list | every key `fullwrite` |
| **`readonly`** | protected | `read` on everything non-admin, `none` on admin-only keys |
| **`networkadmin`** | editable, not deletable | IP space / integrations / map regions / conflicts at write; `subnets` + `reservations` at **fullwrite** |
| **`assetsadmin`** | editable, not deletable | assets / quarantine / monitor settings at write; own-row write on networks and reservations |
| **`user`** | editable, not deletable | own-network / own-reservation write; read elsewhere |

Every built-in role sits at `credentials: read`, so the ownership dimension there
only starts mattering once an admin grants `write`.

Create custom roles under **Users → Manage Roles**. A role bound to any API
token refuses deletion.

---

## Two guards that cannot be talked around

### The last-admin guard

Nothing may leave Polaris with **zero** users holding `users:fullwrite` **and**
`roles:fullwrite`. Enforced on role change and on user delete.

### No escalation

**Nobody hands out authority they do not hold** ([rule 48](Business-Rules#rule-48)).

A caller whose own permissions are not admin-equivalent is refused **403** at
the four places the grant could be minted:

- `POST /roles` and `PUT /roles/:id` — writing the two `fullwrite` grants onto a
  new role, or onto the role you already hold
- `POST /users` — creating an account on an admin-equivalent role **with a
  password you choose**
- `PUT /users/:id/role` — promoting an existing account into it

Before this, both `users:write` and `roles:write` were a **one-step path to full
control of the install**, and the shortest one needed no existing account at
all.

> It is **not four-eyes.** A caller who already holds admin-equivalence is
> unaffected, and the check is skipped entirely when the target permission set is
> not admin-equivalent — so every ordinary role edit is untouched.
>
> It is the **mirror** of the last-admin guard, and neither replaces the other:
> that one refuses to **demote** the last admin, this one refuses to **promote**
> into the tier. The old "you cannot change your own role" checks were never
> escalation guards — the escalation runs through somebody else's row.

A request with **no role snapshot resolved counts as not admin**. It fails
closed.

---

## Tags and region scope

`Role`, `User` and `GroupMapping` each carry two operator-typed tag dimensions:
**region tags** and **other tags**. Empty means **unrestricted**.

A session's effective scope is the **union** of role, user and group-derived
tags, per dimension. Group-derived tags are re-resolved live on every
`/auth/me`, never persisted onto the user's own columns — so operator-set tags
survive a re-login.

**Assign Tags edits both dimensions through one picker.** A map region already
*is* a registry tag (`region:<name>` in a locked category), so a separate region
control listed the same names twice in the same dialog. The prefix carries the
split instead.

Two behaviours that exist because the columns hold **bare names with no foreign
key**:

- **A region rename carries these columns with it.** A rename that left them
  behind revoked every scoped operator's region **in silence** — the tag still
  present, matching no region, and every name-resolving consumer quietly reaching
  nobody.
- **A region delete never strips them.** There is no new name to move an
  assignment to, so the assignment survives and a **warning Event names who now
  holds a dangling one**.

> That second case is why [rule 58](Business-Rules#rule-58) exists: an orphaned
> region tag makes an automation's level-scoped routing **abstain entirely**
> rather than promote the container region — because dropping the leaf would page
> the division while the site's own people hear nothing.

The Users list draws **both** dimensions under the username — regions in their
map colour, then tags in their registry colour.

---

## Authentication

**Users → Authentication.** Five providers; every one must keep working.

| Provider | Notes |
|---|---|
| **Local** | optional TOTP and/or passkeys |
| **Azure SAML** | the callback is a **cross-site POST** |
| **OIDC** | authorization-code + PKCE. Requires `POLARIS_PUBLIC_URL` to derive the redirect URI. Its callback is a **same-site GET** |
| **LDAP / AD bind** | routes through the ordinary login form |
| **Entra App Proxy header SSO** | see below |

> **Never fix a login-adjacent bug for the provider you happen to run.** The
> five have different transport semantics, and the SAML/OIDC difference above is
> the one that bites.

### Sessions

PostgreSQL-backed, **8-hour** max age, HttpOnly, `SameSite=Lax`.

`Secure` is **not unconditional** — it is set only when the request is HTTPS,
including behind a proxy **but only when `TRUST_PROXY` is set** so
`X-Forwarded-Proto` is believed. A plain-HTTP lab install is a supported shape,
so nothing may hard-require a `Secure` cookie.

### Entra App Proxy header SSO

For installs published through Entra Application Proxy with pre-authentication.
App Proxy authenticates in the cloud and forwards claims as **plain HTTP
headers**.

> **The headers are unsigned. The entire security model is source-IP trust.**
> Polaris honours them **only** from operator-allowlisted connector IPs — an
> empty allowlist means header login is **disabled, failing closed** — and a
> middleware strips those headers from every untrusted request as defence in
> depth.

The **Test** button reports the request's source IP **as Polaris sees it**,
which is the value to put in the allowlist.

Note: Entra silently omits the groups header past roughly 150 groups unless the
App Proxy app uses "groups assigned to the application".

### Group mappings

**Users → Group Mappings**, gated `users:fullwrite`.

IdP group → role + tags. **Highest-privilege role wins**; tags from all matched
groups union. No match keeps an existing user's role; a new user gets `readonly`
and a review flag.

> **Security caveat, and Polaris says so with a warning Event when you create
> one:** a mapping to an admin-equivalent role makes IdP group membership a path
> to Polaris admin, **outside the last-admin guard**.

Azure AD emits group **object IDs** in the `groups` claim, so map those GUIDs
unless the IdP is configured to emit names.

### Restricting the login page by source IP

Off by default ([rule 31](Business-Rules#rule-31)). It gates **both halves or
neither** — the page *and* the login API — because the form is a plain POST to a
JSON API.

| | |
|---|---|
| The page | **dropped** — socket destroyed, stealth posture |
| The API | the **same generic 401** a wrong password gets, plus an audit Event |
| **SSO** | **never gated** — that is what makes this survivable |
| **LDAP** | **is** gated, sharing the login route |
| On a settings read error | **fails open** |
| The save | **refuses a scope excluding your own IP** |

The GET returns `callerIp` as Polaris resolves it, precisely because this is only
as true as that value.

### Password policy

**Users → Authentication → Settings** ([rule 63](Business-Rules#rule-63)).

Minimum length (clamped to **8–128**, NIST SP 800-63B's floor) and four
character-class toggles. **Turning every class off is a legitimate posture**, not
a misconfiguration.

The service **fails to the defaults, never to "no policy"** — the opposite of
the login-restriction fail-open, because there failing safe means letting people
in and here it means keeping the bar up.

**Force change on login** is answered against the **plaintext**, at the one
moment Polaris can judge an existing password: the login where its owner types
it.

> And the demand is made **on the far side of the second factor**. A
> password-change token minted at the password step would let someone holding a
> stolen password set a new one — and collect the withheld session — **without
> ever facing TOTP or a passkey**. That is an MFA bypass wearing a policy's
> clothes. The token that is finally issued buys exactly one thing, is
> single-use, and is consumed only **after** the write lands.

### Passkeys

Local accounts only, enforced at the route **and re-checked at verification**:
an SSO account's credentials belong to its identity provider, and a
Polaris-owned second way in would be invisible to whoever thinks they control it
centrally.

Modes: `off` / `login` / `second-factor` / **`both`** (default — enabling
passkeys refuses nothing).

**`requireUserVerification`** (default on) is what licenses a passkey to be the
whole login: UV is two factors in one gesture.

**The relying party is derived from the request, not configured** — TLS
terminates anywhere, `POLARIS_PUBLIC_URL` may be unset, and one install is
legitimately reached by several names. That is safe only because the browser
refuses any ceremony whose relying-party id is not a registrable suffix of the
page's own origin, so a forged `Host` can make a ceremony **fail** and nothing
else. The id and origin are then **pinned into the ceremony at issue time** and
replayed at verify.

Two shapes cannot host passkeys at all, and both return a **reason** rather than
an opaque browser error: **plain HTTP off localhost**, and an **IP-address
install**. Two more are misconfigured proxies wearing those refusals — see
[Troubleshooting](Troubleshooting#passkeys).

The passwordless options endpoint **names no credentials**, so it cannot answer
*"does alice exist, and how many keys has she?"* — which is why registration
demands a resident key. Every refusal returns the **same message**. And unlike
every other credential path in Polaris, **it never provisions**: a credential
resolving to no account is an authentication failure, not a signup.

---

## API tokens

**Server Settings → API Tokens**, gated `apiTokens`.

Each token is **bound to a role at mint time** and passes the same
`requirePermission` gates a session does — so it reaches exactly what its role
grants, filter-don't-403 surfaces included.

- A token granting quarantine at `write` or above **must** name the
  integrations it is scoped to.
- Binding a token to an admin-equivalent role logs a **warning Event**.
- **CSRF is skipped** for bearer requests — cross-site attackers cannot attach
  custom headers — while authentication is fully enforced downstream.
- Writes are attributed in the audit log as `api:<token name>`.

---

## Rate limits

| Surface | Limit |
|---|---|
| Login | 10 / 15 min per IP |
| TOTP confirm / disable | 10 / 15 min |
| Self-service password change | 10 / 15 min |
| OIDC kick-off | 30 / 15 min |
| Entra App Proxy header login | 60 / 5 min — deliberately generous, since all App Proxy users share the connector IP and there is no guessable credential |
| IdP callbacks | 300 / 5 min — a signature-validated assertion is not a guessable credential, so this bounds flood volume, not guessing. Note one NAT egress address can carry a whole site's shift-start logins |
| Admin maintenance / backup routes | 120 / 5 min |
| Agent bearer router | 1200 / 5 min |
| Agent binary downloads | 60 / 5 min |
| First-run setup | 600 / 5 min, and 30 / 15 min on database routes |
