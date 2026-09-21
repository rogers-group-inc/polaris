# Getting around

## The shell

Every page shares one layout: a sidebar on the left, a page header with a
search box and your user badge on the right, and the page's own content below.

### Sidebar

| Entry | Needs |
|---|---|
| **Dashboard** | nothing — everyone sees it, widgets gate themselves |
| **Device Map** | `deviceMap:read` |
| **Application Map** | `applicationMap:read` |
| **IPAM** | `ipBlocks:read` **or** `subnets:read` |
| **Assets** | `assets:read` |
| **Events** | `events:read` |
| **Automations** | `automationManagement:read` |
| **Integrations** | `integrations:read` |
| **Users** | admin only |
| **Server Settings** (bottom) | `serverSettingsSystem:read`, or `credentials` for the Credentials tab alone |

**A nav entry you cannot see is a page you cannot open.** The sidebar gate and
the server-side page gate are kept in lockstep, so a typed URL for a page your
role lacks bounces rather than loading an empty list.

Below Server Settings sits the **theme band** and the version line.

### Global search

The search box searches everything at once and groups hits by kind: IPs,
Blocks, Networks, Reservations, Assets, Device Map sites. Prefixes narrow it:

| Prefix | Short | Searches |
|---|---|---|
| `block:` | `b:` | IP blocks only |
| `network:` | `n:` | networks (subnets) only |
| `asset:` | `a:` | assets only |
| `reservation:` | `r:` | reservations only |
| `map:` | `m:` | pinned firewalls (Device Map) only |
| `tag:` | `t:` | tag substrings across networks **and** assets |

An asset hit carries a **coloured dot** when it has a live alert, before the
monitor pill — the alert is the reason to look, the monitor state is the
detail, and a device can carry both since an alerting device is often up.

### The theme band

Three selectable themes in two families: **Morning** and **Noon** (light),
**Nightfall** (dark). The control is a band, not a menu — one click steps to the
next theme and slides a 24-hour clockface along to bring that theme's hour to
the centre of the band. It is the same control the phone app carries on its **More**
tab, so the two screens read alike.

The band travels one way only — forward through the day, never back — and the
palette **crossfades through a fourth, unselectable waypoint**: Noon → Nightfall
passes through *Afternoon*, so the room goes near-white → golden hour → indigo in
one gesture. The transit palette is applied but never saved, so a reload
mid-sweep lands on a real theme.

`prefers-reduced-motion` is honoured throughout the app: the alert strobe drops
to a steady rendering, and the title text always carries the whole message —
colour and motion never carry information on their own.

---

## The account menu

Click your username, top right. What appears depends on your account:

| Entry | Shown when |
|---|---|
| **Notifications: …** | always — names your current delivery preference and opens the three-way chooser |
| **Timezone: …** | always |
| **Change password** | local accounts only |
| **Set up two-factor auth** | local accounts only |
| **Passkeys** | local accounts, where the install allows them and the browser can host one |
| **Help** | always — opens this wiki in a new tab |
| **Logout** | always |

### Notification preference

`Email`, `Push`, or `Email and push`. This is an **account setting, not a
browser switch** ([rule 39](Business-Rules#rule-39)): there is no "enable push"
toggle anywhere in Polaris. Every client instead reconciles *its own*
subscription to your stored preference at boot, which is what makes "prefer
push" mean push on every device you use.

Three things follow from that:

- The boot-time reconcile **never prompts** — a page load has no user
  activation — so a browser that has never been asked stays un-enrolled until
  you pick the preference *on that browser*.
- The preference is **saved even if this browser refuses**, because it belongs
  to the account. Your phone may honour what this laptop cannot.
- A preference **never deletes an alert**. If you prefer push but have no
  enrolled device, you still get the email.

An automation only consults your preference when its action group offers
*both* methods. In a single-method group the preference would delete the alert
rather than route it, so it is ignored.

### Timezone

Sets the zone every timestamp in the Polaris **UI** is drawn in, for you. The
default is `auto`, which the browser reports. This is the one `/me/*` route with
no permission gate at all: what zone a timestamp renders in changes nothing
about which data you can reach.

**Alert emails are not affected.** An alert is one message to everyone the
automation names ([rule 25](Business-Rules#rule-25)), so it is written on the
Polaris server's clock and names that zone in its footer — "Times shown in CDT
(America/Chicago)". Rendering per reader would mean a separate copy per zone,
and a copy per zone is a To line that no longer shows you who else is on the
alert.

### Change password

Local accounts only — every other provider's credential belongs to its
directory, and the endpoint refuses with that reason.

Two things happen that are worth knowing ([rule 61](Business-Rules#rule-61)):

- **Every other session on your account is ended.** A new password is worthless
  while whoever learned the old one still holds a live cookie. Your own session
  is rotated but kept, so you are not logged out of the page you are on.
- It is rate-limited at the login ceiling (10 attempts / 15 min), because a body
  carrying your current password is the login surface again.

### Two-factor (TOTP)

Local accounts only. Enroll, scan, confirm, and save the backup codes. The row
relabels itself — *Set up* / *Finish setup* (a minted but unconfirmed secret) /
*Disable*.

An admin can reset someone else's TOTP from the Users page; nobody can read it.

### Passkeys

WebAuthn credentials, local accounts only. What a passkey is *for* is decided
by the install, at Users → Authentication:

| Mode | Means |
|---|---|
| `off` | no passkeys |
| `login` | passwordless sign-in |
| `second-factor` | a passkey replaces TOTP as the second step |
| `both` | **default** — enabling passkeys refuses nothing; passwords keep working and registration is opt-in per user |

Under any mode including `second-factor`, registering a passkey makes your
login two-step, exactly as enrolling TOTP does.

**Two deployment shapes cannot host passkeys at all** and say so rather than
throwing a browser error: plain HTTP off localhost, and an install reached by IP
address. Two more are misconfigured proxies wearing those refusals — TLS
terminated at a proxy with `TRUST_PROXY` unset, and a proxy that rewrites the
`Host` header. See [rule 64](Business-Rules#rule-64) and
[Troubleshooting](Troubleshooting#passkeys).

### Help

Opens this wiki on GitHub, in a new tab. It is a link out, not a page Polaris
serves, so it needs internet access — an air-gapped install will not reach it.
Nothing in Polaris depends on it.

---

## Modals, slide-overs and the lock

Most detail in Polaris opens in a **slide-over** (a panel from the right) or a
**modal**. Two conventions:

- Every one carries a **lock toggle**. Locked means a backdrop click will not
  dismiss it — useful when you are reading an asset panel and clicking around.
  A locked slide-over also survives an affordance that would otherwise close it:
  the asset panel's Edit button keeps the panel pinned and stacks the edit modal
  over it.
- The asset slide-over has **back / forward history** (‹ / › in the header, or
  Alt+Left / Alt+Right). A dependency-tree row, an HA peer, an LLDP neighbour, a
  MAC-table match and the Application Map rail all pivot the *open* panel to
  another asset in place, and the arrows walk you back.

---

## Saved views

Several list pages remember how you had them set up, per user and per browser
or per account depending on the thing:

| Thing | Scope | Where |
|---|---|---|
| Column order | per **view tab** | Assets and other list pages |
| Column widths and visibility | per **screen** | same |
| Sort and inline filters | per view tab | same |
| **Saved filters** | server-side, private or shared | Assets → Filters ▾ |
| **View tabs** | server-side, follow you across browsers | Assets, above the bulk bar |
| **Saved dashboards** | server-side, private or public | Dashboard |

Publishing a saved filter needs `assets:write`; deleting someone else's needs
`assets:fullwrite`.
