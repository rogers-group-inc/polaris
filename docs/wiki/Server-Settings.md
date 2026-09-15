# Server Settings

Nine tabs at the bottom of the sidebar. Most of it is gated on
`serverSettingsSystem` or `serverSettingsData`; the **Credentials** tab has its
own key, so a role holding only `credentials` sees that tab and nothing else.

| Tab | Gate | Holds |
|---|---|---|
| **Identification** | `serverSettingsSystem` | what this install calls itself |
| **Credentials** | `credentials` | stored SNMP / SSH / WinRM / REST / HTTP secrets |
| **Customization** | `serverSettingsSystem` | branding, logo, units |
| **Time & NTP** | `serverSettingsSystem` | server clock and timezone |
| **Web Server** | `serverSettingsSystem` | HTTPS, nginx, Dash wallboard |
| **Maintenance** | `serverSettingsData` | backup, restore, updates, capacity, lifecycle |
| **Retention** | `serverSettingsData` | sample and event retention |
| **API Tokens** | `apiTokens` | bearer tokens + the API-docs IP scope |
| **High Availability** | `serverSettingsSystem` | the active/standby pair |

---

## Identification

The install's name and subtitle. These appear in the browser title, the sidebar,
alert emails and the mobile app's install identity.

---

## Credentials

Stored secrets used by monitoring probes, agent deployment and integrations.

| Type | Used by |
|---|---|
| `snmp` | SNMP polling (v2c / v3) |
| `ssh` | SSH polling, agent install on Linux |
| `winrm` | WinRM polling, agent install on Windows |
| `restapi` | FortiOS REST, per-asset or per-stream |
| `http` | manufacturer HTTP-check widgets |

**Ownership applies** ([rule 43c](Business-Rules#rule-43)): at `write` you reach
only rows you created; `fullwrite` reaches any. A row with no creator — every row
predating the column, deliberately not backfilled — is **unowned and
`fullwrite`-only**.

**Testing a stored credential is scoped the same way**, because that path merges
the row's **real secrets** into the probe: testing a peer's credential is
borrowing their password, not reading anything. Testing an *unsaved* form needs
only `write`.

The **list** stays readable at `read`, because the asset monitoring credential
picker needs the names.

### SSH host-key verification

Per credential, default **off** (**on** for newly created ones), and it **fails
closed**. See [Polaris Agent](Polaris-Agent#ssh-host-key-verification).

### Secrets at rest

Every secret leaf is **sealed** by the database layer
([rule 20b](Business-Rules#rule-20)). Sealing is per model; **opening is
all-models**, because relation reads never fire per-model hooks. **Raw SQL
bypasses the extension entirely.**

The key is `POLARIS_SECRET_KEY` in `.env`. **Losing it loses every stored
secret.**

---

## Customization

Branding: application name, subtitle, logo, and where each appears
(`logoOnLogin` / `logoOnSidebar`). Plus the hardware-sensor display unit, which
rides the branding payload.

**The logo is picked by theme *family*, never by id** ([rule 27](Business-Rules#rule-27)).
The shipped art is theme-paired, so painting the wrong variant makes the logo
*disappear* rather than look off. One module decides for all four surfaces —
desktop login, mobile login, sidebar, and the preview on this tab — and the two
variants of a pair are normalised to one geometry, so a theme flip moves nothing.

**The Application Name is a caption for a custom logo only.** Where the shipped
wordmark is in play the name is hidden, so `appName` may legitimately be stored
empty.

The **favicon follows an operator upload only**. The shipped default is the
light-inked symbol (for the PWA icon's dark canvas), so swapping it in
unconditionally would force light ink onto light browser chrome and make the icon
vanish.

---

## Time & NTP

The server's NTP servers, its timezone, and an override.

**This is the clock every maintenance window and every automation quiet-time
window is expressed in.** Both are **server-local wall clock with no offset** —
see [Maintenance windows](Maintenance-Windows#everything-is-server-local-wall-clock).

Individual users set their own **display** timezone from the
[account menu](Navigation-and-Account#timezone); that changes rendering only.

---

## Web Server

A reflowing three-column deck of cards.

### HTTPS

Certificate and key, the listen port (**TCP and UDP** — HTTP/3), and hot
rotation. Polaris can hold the certificate directly.

### nginx Proxy

The in-app nginx GUI: managed configuration, certificate preflight and
rotation, and a `nginx -t` check before anything is applied. A configuration
Polaris does not manage yet is detected and said so rather than overwritten.

Two things the shipped config does that matter
([rule 50](Business-Rules#rule-50)):

- It **emits HSTS itself and hides the upstream's copy**. Two
  `Strict-Transport-Security` headers is non-compliant — a user agent processes
  only the first, so "browsers take the strongest seen" was never true.
- `server_tokens off`.

> **A reverse proxy in front of Polaris must not add its own
> `Referrer-Policy`.** OpenStreetMap blocks referer-less tile requests, so a
> stripped `Referer` turns every map tile into "Access blocked".

### Dash Wallboard

Off by default. Enable toggle plus a source-IP scope: `rfc1918` (RFC1918 +
loopback, the default), `all`, or `custom` CIDRs.

**Unauthorised source IPs are silently dropped** — socket destroyed, no HTTP
response — rather than 403'd, so a scanner cannot confirm the surface exists.
Behind nginx that manifests to the remote client as a 502.

See [Mobile and Dash](Mobile-and-Dash#dash-wallboard).

### Login restriction

Restrict local login by source IP. Off by default, fails open on a read error,
and **refuses a scope that excludes your own IP**. See
[Users](Users-Roles-and-Permissions#restricting-the-login-page-by-source-ip).

---

## Maintenance

### Backup

Manual backup, a **backup schedule**, and backup history. Filenames embed the
Polaris version, so a backup always names the build that produced it.

Backup and restore are **streamed end to end**, and restore is wrapped in
TimescaleDB's pre- and post-restore calls. **A failed pre-update backup aborts
the update by default.**

See [Backup and restore](Backup-and-Restore) — including the two failure modes
that hide behind one generic error message.

### Updates

The in-app updater. **This is how a production Polaris is updated** — it also
syncs the shipped systemd units and nginx config, which a `git pull` does not.

It shows the update train, the resolved source repository and where that came
from. See [Updates](Updates).

### Capacity Advisor

A capacity snapshot, a steady-state size projection and a disk forecast, all
**measured on this install** rather than assumed.

Its `timescale_recommended` reason carries **no size gate** — it fires at zero
bytes, because TimescaleDB's absence is a broken install from the first byte,
not a problem that begins at a threshold ([rule 52](Business-Rules#rule-52)).
The old 1 GB threshold now only chooses *watch* vs *warning*.

### Platform Lifecycle

Grades what this host is actually running — Node, PostgreSQL, TimescaleDB, Go,
nginx, Java, the OS — against committed end-of-life dates, and links the upgrade
steps.

A component **below the minimum** is flagged critical. An upstream end-of-life
is flagged and emailed but deliberately does **not** hold a permanent banner
open, since it clears only in a maintenance window.

### Database tools

Reports the **resolved** `pg_dump` and `psql` and their compatibility with the
server ([rule 47](Business-Rules#rule-47)). Presence is not compatibility, and
`alternatives --display` reports its own bookkeeping rather than the file on
disk — neither of which this card relies on.

### Polaris Agent

The agent binary build and **[certificate pin rotation](Polaris-Agent#rotating-the-certificate-without-breaking-the-fleet)**.

---

## Retention

Per-stream sample retention, rollup retention, compression, and event retention.

Events older than **7 days** are pruned by default
([rule 8](Business-Rules#rule-8)). Syslog (CEF) and SFTP/SCP archival are
configurable — and note that **anything archived leaves the host**, which is why
directory sync writes counts rather than names into Events.

Retention changes are applied by a background job, not instantly.

Pruning is by `drop_chunks`, never by row delete.

---

## API Tokens

[Bearer tokens](Users-Roles-and-Permissions#api-tokens) bound to roles, and the
**API-docs source-IP scope**.

That scope gates the unauthenticated developer-docs page at `/api`:

| Value | |
|---|---|
| `loopback` | |
| **`rfc1918`** | the default |
| `custom` | entries must sit **inside RFC1918**, and are re-filtered on read |

There is deliberately **no "all"**. Loopback is always allowed while the page is
enabled.

The gate **drops the socket and fails closed** — the opposite of login
restriction's fail-open — because this fronts an unauthenticated disclosure
surface. Being outside the scope yourself **warns, never refuses**, and the save
reports a best-effort re-render of the managed nginx allow block.

---

## High Availability

See [High availability](High-Availability). The tab is a **procedure**: five
cards in build order, each returning nothing until its step applies.

Reads are `serverSettingsSystem:read`; everything that hands over or revokes the
keys to the install is **`fullwrite`**.

---

## Tags

Managed under Server Settings, gated `serverSettingsSystem` with mutations at
**`fullwrite`**.

The registry holds every tag, its category and colour, and optionally a
**device filter that auto-assigns it**. A preview reports the match count, a
sample, and the `+add` / `-remove` delta against the tag's current assignments.

Two locked behaviours:

- Writes **refuse the Device-Map-owned "Map Regions" category** — those rows
  belong to the map.
- The registry **refuses the `region:` prefix by name in every category**, and
  asset writes refuse a newly *added* `region:` tag that names no region. Neither
  guard is retroactive — see [rule 54](Business-Rules#rule-54).

The picker-shaped read is deliberately **auth-only**, not gated on
`serverSettingsSystem`: the shared tag picker renders on asset, block and network
forms, and none of those roles hold that key.
