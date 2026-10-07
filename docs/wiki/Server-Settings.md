# Server Settings

Ten tabs at the bottom of the sidebar. Most of it is gated on
`serverSettingsSystem` or `serverSettingsData`; the **Credentials** and
**Repository** tabs have their own keys, so a role holding only `credentials`
or only `firmware` sees that tab and nothing else. Every other tab is shown
only to an administrator.

| Tab | Gate | Holds |
|---|---|---|
| **Identification** | `serverSettingsSystem` | DNS, MAC & vendor identification, device icons, device types, tags |
| **Credentials** | `credentials` | stored SNMP / SSH / WinRM / REST / HTTP secrets, plus the MIB Database (`mibDatabase`) and Manufacturer Profiles (`manufacturerProfiles`) cards |
| **Repository** | `firmware` | firmware images for switches, access points and FortiGates, and the device logins or API tokens that apply them |
| **Customization** | `serverSettingsSystem` | application name and subtitle, logo, display units |
| **Time & NTP** | `serverSettingsSystem` | NTP servers and the timezone override |
| **Web Server** | `serverSettingsSystem` | HTTPS certificate, nginx, Dash wallboard, trusted CAs |
| **Maintenance** | `serverSettingsSystem` to look; `serverSettingsData` for backup, restore, download, updates and restart | database and capacity, updates, lifecycle, backups |
| **Retention** | `serverSettingsSystem` | sample retention and agent OS event-log collection |
| **API Tokens** | `apiTokens` | bearer tokens + the API-docs IP scope |
| **High Availability** | `serverSettingsSystem` | the active/standby pair |

---

## Identification

Five cards about what Polaris calls things it finds:

- **DNS Configuration** — the resolvers Polaris uses for reverse lookups, with a
  **Test DNS Lookup** card beside it.
- **MAC & Vendor Identification** — a three-layer pipeline: **Prefix
  Overrides** win, then **Manufacturer Aliases** normalise the vendor name, then
  the IEEE **OUI database** supplies the base lookup. The **Placeholder MAC
  Prefix** (default `02:0F:5E`) lives here too: it is what the IP panel's
  **Generate** button builds a MAC from when you reserve an address for a device
  that is not racked yet, and the only thing that marks such a MAC as a
  placeholder.
- **Device Icons** — PNG / JPEG / WebP (256 KB) or SVG (32 KB, strictly
  validated) icons overlaid on the topology graphs, keyed to a manufacturer
  plus a type or a model. Gated `deviceIcons`.
- **Device Types** — the asset-type registry and the matching rules that file a
  newly discovered device. Built-in types cannot be renamed or removed, but
  their rules are editable; **Apply rules to existing "Other" assets…** re-files
  what was left unclassified.
- **[Tags](#tags)** — the tag registry.

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

### Device admin logins

An HTTP credential in **Device admin login (form)** mode is the username and
password a switch, access point or FortiGate's *own* web UI takes. It is not an HTTP
authentication scheme: an HTTP-check widget will not accept it, and nothing
ever turns it into a header. Its one consumer is the [Repository](#repository),
which posts it to the device's login page when it upgrades firmware. Test
Connection on one of these says so instead of probing — the upgrade engine
signing in is what proves it.

---

## Repository

Firmware images for the **switches, access points and FortiGate firewalls** in
the inventory ([rule 87](Business-Rules#rule-87)). Gated on the `firmware` key:
**Read** sees the tab and which devices have an upgrade waiting, **Read-Write**
manages the repository. Starting an upgrade is **Read-Write on Assets**, from
the device itself — never here.

### The tree

Manufacturer › device type (Switch, Access Point, Firewall) › model, built from the
assets Polaris has. It is not a list you maintain: a model appears because a
device carries it. Each node shows how many assets sit under it, which device
login applies and where that login is inherited from.

**Only Fortinet devices can be upgraded, over HTTPS straight to the device.**
FortiSwitches and FortiAPs through their own web UI; standalone FortiGates
through the FortiOS REST API. A device-type node for another manufacturer says
*No upgrade engine*; you may still store images under it, and its assets show
no upgrade action. A FortiGate-managed FortiAP usually has its local web UI
disabled, and an upgrade attempt will report the device as unreachable — that
is the AP, not the repository.

**FortiGates — read this first.** FortiGate upgrades are new. They have been
run on two lab FortiGate 61F gates (FortiOS 7.6.7 → 8.0.1, once with an API
token and once with an admin login), but not yet on older FortiOS builds or
on any other model; try one on a lab or spare gate before a production one,
and have console access ready. A gate in an **HA
cluster is not upgraded** — its Firmware card says so. FortiGate-VM is not
offered images (its serial does not name a hardware platform). Polaris checks
that an image is newer and fits the gate's platform; it does **not** check
Fortinet's supported upgrade path, so pick an image that is a supported step
from the running version. A FortiGate image goes straight to the gate, never
through FortiManager.

### Images

Expand a model and upload its `.out` file. Polaris reads the image's own
header — the **platform** (which is the first six characters of the serial
numbers it fits, e.g. `S108FF`), the version and the build — and files the
image under the model you chose. If no asset under that model carries the
image's platform, the upload is accepted with a warning that says which
platforms those assets do carry: the model is where you filed it, the platform
is what a device is actually matched on. An image whose header cannot be read
(only the file name says `v7-build1164`) is stored but never offered to any
device.

**A model keeps two images.** Uploading a new one makes it the **primary**;
the current primary becomes the **backup**; the previous backup is removed.
**Make primary** swaps the two: the rows keep their order (newest version on top),
so the Primary pill and the button jump rows, the promoted row highlights for a moment,
and the toast names the new backup. Deleting the
primary promotes the backup. The
same bytes cannot be filed twice, and an image a device is flashing right now
cannot be removed by anything.

**Which devices differ from the primary** is also an automation field:
`firmwareVsPrimary` reads `current`, `older` or `newer` for every switch,
access point and FortiGate the Repository can place, and the baseline
automation **Firmware differs from repository primary** (informational) raises
one in-app alert per device that is not on the primary, clearing on its own
once it is upgraded or the primary is changed. The baseline is scoped to
switches and access points; add **Firewall** to its scope to hear about gates. See
[Automation triggers](Automation-Triggers#firmwarevsprimary--what-the-repository-would-push).

A model with images but **no assets carrying it any more** is flagged amber
and opened for you, with **Delete firmware for this model** — the images are
still on disk, and the flag is the only thing telling you so.

Switch and access-point images are up to 100 MiB, FortiGate images up to
300 MiB, and they live on the host under `data/firmware` (outside the database
backup, like the agent binaries; a Docker install keeps them in the state
volume). An nginx-fronted install needs the shipped config's firmware location
block, or the upload is rejected at the edge with a 413. An update installs it
only on an install whose nginx is managed from the **Web Server** tab and has
not been edited by hand since. That block said `100m` until FortiGate support
arrived and says `300m` now: an install still carrying `100m` takes switch and
AP images but refuses a FortiGate image over 100 MB at nginx, and the upload's
error message says so — re-apply the **Web Server** tab, or change the number
by hand as below.

**Known problem on systemd installs (the split-role layout):** neither the
update nor the Web Server tab's **Save & Apply** can currently rewrite nginx
there, and Save & Apply shows *Internal server error*. Until that is fixed, add
the location by hand as root: back up `/etc/nginx/conf.d/polaris.conf`, paste
this inside the `server { }` block after `location / { … }`, then run
`nginx -t && systemctl reload nginx`.

```
  location = /api/v1/server-settings/firmware/images {
    client_max_body_size 300m;
    proxy_request_buffering off;
    proxy_pass http://127.0.0.1:3000;
  }
```

Use the same address and port as your file's own `location /` block. A load
balancer in front of nginx has its own request-body limit, which must allow
300 MiB as well (100 MiB if you never upload FortiGate images).

### Device logins

**Set login…** on a manufacturer, a device type or a model binds an HTTP
credential in *Device admin login (form)* mode there. The most specific level
wins: a model's own login beats the device type's, which beats the
manufacturer's, and every node says which one applies to it and where it came
from. A binding whose credential has since been deleted is skipped, not
inherited — the next level up applies.

On a **Firewall** device type or model the picker is labelled **Sign in with**
and offers three kinds of thing:

- **Integration API token** — the REST API token of the FortiGate or
  FortiManager integration that discovered each gate (a FortiManager's
  *FortiGate API token* from its Monitoring tab). Nothing is copied: the token
  is read from the integration when the upgrade runs, so rotating it there is
  enough. A gate that no FortiGate / FortiManager integration discovered, or
  whose integration holds no token, skips this binding and uses the next level
  up.
- **Device admin logins** — the same *Device admin login (form)* credentials
  switches use. An admin with two-factor authentication, a pre-login
  disclaimer or a forced password change cannot sign in this way; the upgrade
  stops after one attempt rather than count toward the admin lockout.
- **REST API tokens** — a stored *REST API* credential.

The token's admin profile needs **System: Read-Write** on the gate (firmware
upgrade is a system write). A token or a REST API credential is offered only
on Firewall nodes and never applies to a switch or access point — bound
anywhere a switch would inherit it, it is skipped for the switch. Upgrades are never automatic: an
operator with the permission starts each one from the device's Firmware card,
either now or booked for a chosen time
([Assets → Firmware](Assets#firmware), [rule 93](Business-Rules#rule-93)).
A device with no login at any level cannot be upgraded until one is bound, and
its card says *No login bound*; the tree marks such a node *No device login*.

A manufacturer with no login of its own warns only about what is actually
uncovered: *No device login for Access Point* names each
device type that has at least one model no login reaches. When every device
type is covered — by its own login or by each of its models — the manufacturer
shows no warning at all.

### The devices behind a node

The **asset count** on a manufacturer, device type or model is a link. Click it
to open a panel listing those devices: hostname, address, model, serial, the
version each one runs, and whether that is **Current**, **Behind primary** or
**Ahead of primary** against its platform's primary image. Filter by any of
those, and click a device to open its details over the list. The list counts
exactly what the tree counts, so *(no model)* lists the devices with a blank
model. On a very large node it shows the first 2000 by hostname and says so;
filter to find the rest. The count is a link only for a role that can see
assets.

### Recent upgrade runs

Every flash, fleet-wide, with its result and a **View log** that shows the
run's transcript — sign-in, upload, the switch's erase / write / verify
progress, reboot, verification. That transcript is what to read when a run
ends *unverified* or *failed*.

**Before the first fleet use, bench-test one switch and one access point on
hardware you can afford to lose, with a console cable attached.** The upgrade
procedure was transcribed from a tool whose own author had not yet validated
it on real devices. A flash that fails partway can leave a device unbootable.

---

## Customization

Three cards: **Application Name** (name and subtitle — the name shows in browser
tabs and PDF exports), **Logo** (upload, where it appears — `logoOnLogin` /
`logoOnSidebar` — and an optional Polaris-star accent on its corner), and
**Display Units** (Celsius or Fahrenheit for hardware-sensor temperatures;
display only — samples and automation thresholds stay in °C). The unit rides
the branding payload and applies to every operator and the wallboard.

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

Two cards: **Time Synchronization** (the server's NTP servers) and **Timezone
Override**.

**This is the clock every maintenance window and every automation quiet-time
window is expressed in.** Both are **server-local wall clock with no offset** —
see [Maintenance windows](Maintenance-Windows#everything-is-server-local-wall-clock).

Individual users set their own **display** timezone from the
[account menu](Navigation-and-Account#timezone); that changes rendering only.

---

## Web Server

A reflowing three-column deck of cards.

### HTTPS Certificate

The certificate nginx terminates TLS with — path, common name, SANs and expiry
(amber under 30 days, red under 7). **Rotate certificate** walks the dual-pin
**stage → swap → retire** workflow, which is zero-downtime as long as every
agent is online to receive the new pin; see
[certificate pin rotation](Polaris-Agent#rotating-the-certificate-without-breaking-the-fleet).

### nginx Proxy

The in-app nginx GUI: six operator-settable directives — among them the HTTPS
listen port (**TCP and UDP** — HTTP/3), TLS protocols, HSTS and the Prometheus
allow-list. **Save & Apply** renders the config, runs `nginx -t`, and reloads.
A configuration Polaris does not manage yet is detected and said so rather
than overwritten: the controls are read-only until you click **Adopt managed
mode**, and adopting overwrites hand edits beyond those six on the next apply.

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

### Trusted Certificate Authorities

Upload `.pem` / `.crt` / `.cer` / `.der` CA certificates Polaris uses to verify
remote servers — integrations, syslog and archive targets. With none uploaded
it uses the system trust store.

### Local Login Access

A **read-only summary** of the local-login source-IP restriction. The setting
is edited on **Users → Authentication → Settings**, beside the password and
passkey policies — see
[Users](Users-Roles-and-Permissions#restricting-the-login-page-by-source-ip).

---

## Maintenance

Cards in this order: **Database** (the capacity snapshot), **Capacity Advisor**
and **Application Updates** side by side, **Platform Lifecycle**, then
**Backup**, **Restore** and **Backup History** in one row, and **Scheduled
Backups**.

### Backup

**Backup** (with an optional encryption password), **Restore** (drop a `.gz` or
`.enc.gz` file), **Backup History**, and **Scheduled Backups**. Filenames embed
the Polaris version, so a backup always names the build that produced it.

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

The **Database** card at the top of the tab carries a capacity snapshot — storage
volumes, the application host, the database, and the monitoring workload — a
steady-state size projection and a disk forecast, all **measured on this
install** rather than assumed.

The **Capacity Advisor** card beside Updates appears only when it has something
to recommend: the queue mode, the connection-pool and worker-count variables,
and PostgreSQL tuning (`max_connections`, `shared_buffers` and friends). Tick
the rows you want, **Stage** them, and **Restart Polaris to apply**. The
PostgreSQL rows are advisory only — they have no Stage button, and a value you
set yourself with `ALTER SYSTEM` is honoured.

Its `timescale_recommended` reason carries **no size gate** — it fires at zero
bytes, because TimescaleDB's absence is a broken install from the first byte,
not a problem that begins at a threshold ([rule 52](Business-Rules#rule-52)).
The old 1 GB threshold now only chooses *watch* vs *warning*.

The **Monitoring workload** card lists how much Polaris is polling:
**Assets** (monitored assets), **Interfaces** (pinned interfaces
and IPsec tunnels), **Storage mounts** (pinned mounts) and **Agents** (every
installed Polaris agent, whether or not its asset is monitored), followed by
the cadences and retention windows in force.

Every change of overall severity writes an Event, whether or not anyone has this
tab open: `capacity.severity_changed` on the way up (and on a partial recovery
that is still degraded), `capacity.severity_recovered` on a landing back at OK.
The built-in **Capacity severity escalated** automation alerts on the first and
clears on the second, so a capacity alert retires when capacity is actually
healthy rather than on a timer. Add a **When it clears** action to that
automation if you want the all-clear delivered as well — see
[Automation-Triggers](Automation-Triggers).

### Where the database size figures come from

**Current size** is every relation in the database: Polaris's own tables with
their indexes, TOAST and TimescaleDB chunks, plus the pg-boss job queue's schema
and PostgreSQL's own catalog. The table list under it accounts for all of it —
Polaris's tables as rows, then an italic line each for the pg-boss queue, the
PostgreSQL catalog, anything in another schema, and a **Total** that matches the
figure above. If a number looks wrong, the row that explains it is in that list.

Sizes are read from PostgreSQL's catalog rather than by measuring the data
directory, which keeps the tab instant on a large install. The trade-off is
freshness: a figure is accurate as of the last `VACUUM`/`ANALYZE`. Two
conditions are called out in place rather than left to guess at:

- **Relations that have never been analyzed** report zero pages whatever they
  hold, so the sizes leave them out. Autovacuum only analyzes a relation after
  enough writes, so one nothing writes to — an old compressed TimescaleDB
  chunk after a PostgreSQL major-version upgrade, say — stays that way until
  you run `vacuumdb --analyze-only` against the database. The card says how
  much is missing and how loudly according to how much it is:
  - **"N relation(s) that have never been analyzed hold about X"** (a
    warning) — more than 64 MB, or 1% of the database, is left out. Run the
    `vacuumdb` above and reload.
  - **"N small relation(s), about X, are not yet analyzed"** (a plain note) —
    normal on any TimescaleDB install, since every chunk compression leaves a
    small one behind. Nothing to do.
  - **"N relations have never been vacuumed or analyzed — too many to size
    individually"** — the state right after a restore or a major-version
    upgrade, which does not carry statistics across. Every size may be well
    short; run the `vacuumdb` above.

  Empty tables are not counted: zero pages is the truth for them.
- **"Hypertable sizing is degraded"** — Polaris could not read TimescaleDB's
  chunk catalog, so every sample table is listed at its parent size, which is
  near zero, and its real bytes show up under *Unattributed*. The sizes are
  wrong until it is fixed; the total is not. This is the shape a TimescaleDB
  major upgrade can break, so it is worth a look after one.

**Steady-state at current settings** is a projection, not a measurement: the
peak size the database reaches if monitoring settings stay as they are. It
legitimately sits ABOVE the current size while sample tables are still filling.
Old samples are removed a whole chunk (usually a week) at a time, so each table
grows and drops in a regular cycle — and tables with different retention peak on
different days. The figure is the largest size they reach *together*, which is
what the disk actually has to hold.

### Platform Lifecycle

Grades what this host is actually running — Node, PostgreSQL, TimescaleDB, Go,
nginx, Java, the OS — against committed end-of-life dates, and links the upgrade
steps.

A component **below the minimum** is flagged critical. An upstream end-of-life
is flagged and emailed but deliberately does **not** hold a permanent banner
open, since it clears only in a maintenance window.

### Database tools

Polaris checks the **resolved** `pg_dump` and `psql` for compatibility with the
server ([rule 47](Business-Rules#rule-47)). Presence is not compatibility, and
`alternatives --display` reports its own bookkeeping rather than the file on
disk — neither of which this check relies on. When both are fine nothing is
shown; when either is not, a **"Backups cannot run on this host"** banner
above the backup history names the versions, the path and the fix.

> The agent binary build lives on **Integrations → Polaris Agents**, and
> certificate pin rotation on the **Web Server** tab's
> [HTTPS Certificate](#https-certificate) card.

---

## Retention

Two cards.

**Sample Retention** — how long each kind of sample is kept at each tier:
detail, then hourly rollups, then daily rollups. Per cell, **N** keeps N days,
**0** drops that tier and **−1** keeps it forever; the defaults are 7 days
detail / 30 days hourly / 365 days daily, and **Restore defaults** puts them
back. Interface, storage and IPsec-tunnel rows apply only to the ones you
selected for monitoring — unselected ones are kept 24 hours and not rolled up.
Changes take effect on the next nightly prune and the next chart request.
Pruning is by `drop_chunks`, never by row delete.

**Agent OS Event Log** — off by default. When on, Polaris Agents ship matching
Windows Event Log / Linux journald entries into the audit log, filtered by a
minimum severity, a journald priority and a list of Windows channels, and
bounded per push and per asset per hour (overflow is summarised into one
event). Event messages can carry hostnames or sensitive text, so keep the
filter tight.

Audit-event retention (7 days by default, [rule 8](Business-Rules#rule-8)) and
syslog / SFTP archival are set on the [Events](Events#retention-and-archival)
page, not here — and note that **anything archived leaves the host**.

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
keys to the install is `serverSettingsSystem:write` — the key's top rung.

---

## Tags

The last card on the **Identification** tab, gated `serverSettingsSystem` with
mutations at `write`.

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
