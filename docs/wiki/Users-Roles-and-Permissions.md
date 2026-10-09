# Users, roles and permissions

**Users** in the sidebar (admin only). Three sections: **Users**, **Roles**
and **Group Mappings**, plus an **Authentication** button in the page header
that opens the sign-in configuration (tabs **SAML**, **OIDC**, **LDAP**,
**App Proxy** and **Settings**).

---

## The model

Every route declares a **function key** plus a required **level**. A role is a
matrix over the 35 keys:

```
none  <  read  <  write  <  fullwrite
```

**Most keys do not offer all four.** See [Short ladders](#short-ladders) below:
a rung only exists where it grants something the rung beneath it does not.

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

A key declares **only the levels it can actually hold**, and most hold fewer
than four. The rule is that a rung has to grant something the rung below it does
not — otherwise it is a radio button that changes nothing, and picking it is a
decision the operator did not really make.

| Ladder | Keys | Why |
|---|---|---|
| `none \| read` | `assetsProbe` | A probe dials the device and writes nothing in Polaris, so Read *is* the whole grant |
| `none \| read \| write` | 20 keys — see the tables below | No route asks for Full Read-Write on them. It means something only where it lifts an ownership filter or reserves a more dangerous act |
| `none \| write` | `serverSettingsData` | Nothing on the key is merely viewable. Its reads sit on the System key's floor, and everything it gates changes the database or hands over a copy of it |
| all four | the 5 ownership keys and 7 named exceptions | Marked in the tables below |

The UI renders a dash instead of a radio for an unsupported cell. Stored values
**clamp down, never up** — a `fullwrite` on a read-only key means "as much as
possible", so rounding up would silently grant and resolving to `none` would
silently revoke.

---

## The 35 function keys

**Top rung** names the highest level the key offers. Where that is Full
Read-Write, the last column says what it buys over Read-Write — because that is
the only thing that justifies the rung existing.

### Address space

| Key | Top rung | |
|---|---|---|
| `ipBlocks` | Read-Write | top-level CIDR blocks |
| `subnets` | Full RW | networks — **ownership**; Full RW also covers exclusions and archive |
| `reservations` | Full RW | including DHCP push — **ownership** |
| `allocationTemplates` | Read-Write | saved multi-network allocation templates |
| `staleReservations` | Read-Write | snooze / ignore stale DHCP reservation alerts + the threshold |

### Devices

| Key | Top rung | |
|---|---|---|
| `assets` | Full RW | inventory CRUD and export. **Read-Write also starts a firmware upgrade** on a switch, access point or FortiGate, or schedules, changes and cancels one for later. **Full RW = deploy the agent, and merge assets** (a merge edits one record and deletes another) |
| `assetsQuarantine` | Read-Write | push MAC quarantine to FortiGates, release, verify |
| `assetsProbe` | **Read-Only** | probe-now, SNMP walk, DNS lookup — a probe writes nothing here |
| `assetMonitorSettings` | Full RW | monitor cadence and retention overrides at every tier, plus the auto-decommission thresholds. **Full RW = the outage simulation** |
| `networkScan` | Full RW | [active-scan Discoveries](Network-Discovery) — **ownership** |

### Monitoring configuration

| Key | Top rung | |
|---|---|---|
| `mibDatabase` | Read-Write | upload / browse / walk SNMP MIBs |
| `manufacturerProfiles` | Read-Write | per-vendor telemetry profiles — CPU/memory/temperature OIDs, custom widgets — **and the manufacturer alias map**, which decides which profile a device gets |
| `credentials` | Full RW | stored SNMP / WinRM / SSH / REST / HTTP credentials — **ownership** |
| `firmware` | RW | the firmware repository for switches, access points and FortiGates. Read = see the Repository tab; Read-Write = upload / delete images, choose the primary and bind device logins (or, for FortiGates, an API token — including the discovering integration's). **Starting an upgrade is not on this key** — it needs Read-Write on **Assets** ([rule 87](Business-Rules#rule-87)) |
| `deviceIcons` | Read-Write | operator-uploaded topology icons |

> The manufacturer alias map sits on **`manufacturerProfiles`**, not a key of
> its own. An alias rewrites the manufacturer on every matching asset, and that
> is what picks the device's profile — so editing aliases is editing which
> profile applies. See [Rule 43](Business-Rules#rule-43).

### Discovery

| Key | Top rung | |
|---|---|---|
| `integrations` | Full RW | integration CRUD + discovery. **Full RW = abort a discovery in flight** |
| `discoveryConflicts` | Read-Write | accept / reject / merge conflicts |

### Maps

| Key | Top rung | |
|---|---|---|
| `deviceMap` | Read-Write | the geographic map and topology graphs; Read-Write saves a site's layout |
| `applicationMap` | Read-Write | the connectivity graph; Read-Write saves the shared layout |
| `mapRegions` | Read-Write | draw / edit / delete region polygons |

### Alerting

| Key | Top rung | |
|---|---|---|
| `events` | Read-Write | the audit log, its retention, and syslog / SFTP archival |
| `alerts` | Full RW | **Read** = view · **Read-Write** = acknowledge · **Full RW** = clear |
| `automationManagement` | Read-Write | automations and delivery channels |
| `automationScripts` | Read-Write | **RCE-equivalent** — see [Automation scripts](Automation-Scripts) |
| `pathChecks` | Read-Write | [path checks](Path-Monitor). Read-Write tells every matching Polaris Agent to send traffic to a destination on a schedule. Running a check **from the Polaris server** also needs Read-Write on `networkScan` (Network Discovery), because the server probes from its own network. Gates the **Path Monitor** page (sidebar, under Application Map). Starts at each role's **Application Map** level, so the built-in roles read the same on both |
| `maintenanceManagement` | Read-Write | maintenance windows; Read-Write is schedule CRUD |
| `contacts` | Full RW | the address book — **ownership** |

### Platform

| Key | Top rung | |
|---|---|---|
| `apiTokens` | Read-Write | long-lived bearer tokens |
| `users` | Full RW | user CRUD, role assignment, TOTP and passkey reset. **Full RW = IdP group mappings** |
| `roles` | Full RW | **the matrix itself** — Full RW here plus Full RW on Users is admin-equivalent |
| `authentication` | Read-Write | how operators sign in: the SAML / OIDC / LDAP / App Proxy providers, the passkey policy and the password policy |
| `assistant` | Read | the [AI assistant](AI-Assistant) chat button. It cannot widen a role — every lookup it makes uses **your own** permissions — so every built-in role has it, `readonly` included |
| `savedDashboards` | Full RW | named layouts; Read-Write **publishes**, Full RW deletes anyone's |
| `serverSettingsSystem` | Read-Write | HTTPS, branding, DNS, NTP, certificates, capacity, tags, HA, the agent fleet |
| `serverSettingsData` | **Read-Write** (no Read) | backup, restore, **download**, queue mode, security tokens, restart, in-app updates |

> `serverSettingsData` has no Read rung because **downloading a backup is not a
> read** — the archive is the entire database. A Read rung would make "may look
> at the Data tab" and "may walk off with the database" the same grant. Every
> other read on that tab rides the System key's floor.

### Who may change how people log in

`authentication` is **its own key, separate from `serverSettingsSystem`**, and
it is worth knowing why if you maintain custom roles.

Identity-provider configuration repoints every login in the install at an
identity provider of your choosing. That is not a lesser grant than changing
the logo, and an admin delegating "some server settings" is almost never
delegating the install's login path. Keeping the two apart lets you hand out
TLS, HA, tags, DNS, NTP, branding, capacity and the agent fleet
(`serverSettingsSystem`, which tops out at Read-Write like most keys) without
handing out the login path. A role can see the sign-in configuration with
`authentication` Read-Only; repointing it takes `authentication` Read-Write,
which is a decision rather than a side effect.

Two neighbours deliberately sit elsewhere. **IdP group mappings** remain on
`users` Full Read-Write: a mapping decides which *role* an IdP group receives,
which is granting authority rather than configuring authentication, and it is
already the documented path to admin outside the last-admin guard. And the
**login-page source-IP restriction** remains on `serverSettingsSystem`: it
governs who can reach a page over the network, not how Polaris decides who you
are.

---

## The five built-in roles

| Role | Editable? | Grants |
|---|---|---|
| **`admin`** | **protected** — cannot be edited or deleted, and is hidden from the list | every key at its **top rung** |
| **`readonly`** | protected — like `admin`, hidden from the Roles list | `read` on everything non-admin, `none` on admin-only keys |
| **`networkadmin`** | editable, not deletable | IP space / integrations / map regions / conflicts at write; `subnets` + `reservations` at **Full RW**; assets, topology layouts and maintenance windows at write |
| **`assetsadmin`** | editable, not deletable | assets / quarantine / monitor settings / maintenance / automations at write; own-row write on networks, reservations and **credentials**; integrations readable |
| **`user`** | editable, not deletable | own-network / own-reservation write; read elsewhere |

**`readonly` is the floor.** No built-in role reaches *less* of Polaris than the
look-only role does — a role that exists to do more than look should never see
less. There is exactly one deliberate exception: `user` holds `networkScan: none`
where `readonly` holds `read`, because that role exists for address-space
self-service and an active sweep is IDS-visible.

Create custom roles with **+ Add Role** in the **Roles** section. A role bound
to any API token refuses deletion.

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

Without it, both `users:write` and `roles:write` would be a **one-step path to
full control of the install**, and the shortest one needs no existing account at
all.

> It is **not four-eyes.** A caller who already holds admin-equivalence is
> unaffected, and the check is skipped entirely when the target permission set is
> not admin-equivalent — so every ordinary role edit is untouched.
>
> It is the **mirror** of the last-admin guard, and neither replaces the other:
> that one refuses to **demote** the last admin, this one refuses to **promote**
> into the tier. A "you cannot change your own role" check is not an escalation
> guard — the escalation runs through somebody else's row.

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
  behind would revoke every scoped operator's region **in silence** — the tag still
  present, matching no region, and every name-resolving consumer quietly reaching
  nobody.
- **A region delete never strips them.** There is no new name to move an
  assignment to, so the assignment survives and a **warning Event names who now
  holds a dangling one**.

> That second case is why [rule 58](Business-Rules#rule-58) exists: an orphaned
> region tag makes an automation's level-scoped routing **abstain entirely**
> rather than promote the container region — because dropping the leaf would page
> the division while the site's own people hear nothing.

**Region scope never narrows an administrator's alerts.** An admin-equivalent
role (Full Read-Write on both `users` and `roles`) sees and can acknowledge
every alert, whatever region tags its user, role or SSO group carry. An admin
in a regional IdP group picks up that group's tags without anyone meaning to
narrow them, and the Active Alerts widget and the device's Alerts tab are not
region-scoped — so a scoped admin would see an alert there and then be told it
was "not here any more" by its acknowledge card. Every other role is
narrowed by its regions on the Alerts list and the acknowledge page.

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

- The value (`polaris_` plus a 32-character tail) is shown **once**, at
  creation; afterwards the list shows only its prefix, with the role, scoped
  integrations, trusted hosts, creator, **last used** time and **expiry**. An
  expiry is optional — blank means never. **Revoke** stops a token
  immediately; an expired or revoked token gets the same `401` as no token.
- A token granting quarantine at `write` or above **must** name the
  integrations it is scoped to.
- Binding a token to an admin-equivalent role logs a **warning Event**.
- **Trusted hosts** (optional) limit the source addresses a token is accepted
  from. Set them at creation or change them later with **Edit Hosts** on the
  token's row; the token value stays the same and the change applies to the
  next request. Clearing a restricted token's list logs a warning Event.
  Entries are one IP address or CIDR per line, IPv4 or IPv6. Blank means any
  source. A valid token from any other address is refused with a
  `403` naming the address Polaris saw, and an `api_token.untrusted_host`
  warning Event is written — at most once per token and address every
  15 minutes. The address is the one Polaris resolves through `TRUST_PROXY`, so
  behind a reverse proxy that does not forward the client address every caller
  looks like the proxy.
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
| Passkey ceremonies (login, second-factor step, registration) | 60 / 15 min |
| SSO kick-off (OIDC and SAML login redirects) | 120 / 5 min — sized against the callback ceiling, since one sign-in is one kick-off plus one callback. Never shares the login limiter's budget |
| Entra App Proxy header login | 60 / 5 min — deliberately generous, since all App Proxy users share the connector IP and there is no guessable credential |
| IdP callbacks | 300 / 5 min — a signature-validated assertion is not a guessable credential, so this bounds flood volume, not guessing. Note one NAT egress address can carry a whole site's shift-start logins |
| Admin maintenance / backup routes | 120 / 5 min |
| Agent bearer router | 1200 / 5 min |
| Agent binary downloads | 60 / 5 min |
| First-run setup | 600 / 5 min, and 30 / 15 min on database routes |
