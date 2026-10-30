# REST API

Polaris exposes a REST API at **`/api/v1/`** for external callers — SIEM
integrations, scripts, CMDB syncs, dashboards.

> **The canonical, always-current reference is the in-app page at `/api`**,
> served by your own install. It is generated from the code and cannot drift.
> This page is the same material for readers who do not have an install in front
> of them, plus the parts that are easier to explain in prose.
>
> `/api` is **unauthenticated but source-IP-gated** — default RFC1918 + loopback,
> configurable at [Server Settings → API Tokens](Server-Settings#api-tokens).
> The gate **drops the socket and fails closed**.

---

## Authentication

A **bearer token**, minted at Server Settings → API Tokens and bound to a
**role** at mint time.

```bash
curl -H "Authorization: Bearer $POLARIS_TOKEN" \
     https://polaris.example.com/api/v1/assets?limit=1
```

Tokens look like `polaris_<32-character-tail>`.

| Situation | Answer |
|---|---|
| missing, revoked, expired or malformed token | the **same `401`** as no token at all |
| a valid token sent from outside its **trusted hosts** | `403`, naming the source address Polaris saw |
| a request the token's role does not permit | `403` — except on filter-don't-403 surfaces, which narrow instead |
| **any** unknown path under `/api/v1` to an anonymous caller | **`401`, not `404`** — the API does not tell an anonymous caller which endpoints exist |

`GET /auth/me` answers
`{"authenticated": false}` for bearer callers. To smoke-test a token, call a
cheap read and check for 200.

Writes are attributed in the audit log as `api:<token name>`.

**CSRF is skipped for bearer requests** — a cross-site attacker cannot attach a
custom header — while authentication is fully enforced downstream.

### The ownership trap

Networks, reservations, contacts, credentials and Discoveries carry an
[ownership dimension](Users-Roles-and-Permissions#ownership): `write` reaches
only rows whose creator matches the caller.

**A token has no username.** So a token bound to a role with plain `write` on
those keys can **create** rows but gets `403` on every edit or delete of an
existing one.

**Bind integration tokens to a role holding `fullwrite`** on the keys they need
to modify.

---

## Errors

Every error is JSON with a single `error` string:

```json
{ "error": "Reservation not found" }
```

| Code | Means |
|---|---|
| `400` | validation failure — the message **names the offending field** |
| `401` | missing or unusable credentials |
| `403` | authenticated, but the role lacks the permission — or the token came from outside its trusted hosts |
| `404` | no such resource, **or one outside the caller's visibility scope** |
| `409` | conflicts with current state — an overlapping network, a duplicate reservation, a referenced row |
| `429` | rate-limited; back off and retry |
| `5xx` | server-side failure; the body still carries `{ "error": ... }` where possible |

**`404` rather than `403` for an invisible row is deliberate** and applies to
alerts, saved dashboards and Discoveries: a 403 would confirm the id exists.

Aggregate feeds under `/dashboard/*` are cached server-side for about 10 seconds.

---

## Deprecated path aliases

Three renames are dual-mounted:

| Old | New |
|---|---|
| `/notifications` | **`/alerts`** |
| `/notification-rules` | **`/automations`** |
| `/notification-channels` | **`/delivery-channels`** |

Responses on the old paths carry `Deprecation: true` plus a `Link` header naming
the successor. Move to the new paths.

---

## Documented endpoints

### Assets and inventory

```
GET    /assets                              list + filter
GET    /assets?search=<mac|ip|hostname>     the SIEM lookup
GET    /assets/:id
GET    /assets/:id/sources                  every source's answer
GET    /assets/:id/sightings                FortiGate sightings
GET    /assets/:id/dependencies             the dependency tree
GET    /assets/ip-check?ip=…                is this address already in use?
POST   /assets                              create a device
PUT    /assets/:id                          update + the monitoring surface
POST   /assets/bulk-monitor                 flip monitoring on many at once
POST   /assets/bulk-tags                    add / remove / replace tags on many at once
DELETE /assets/:id
PUT    /assets/:id/primary-address          pin the (MAC, IP) the device is monitored on
DELETE /assets/:id/primary-address          release that pin
PUT    /assets/:id/primary-ipv6             pin the device's primary IPv6 address
DELETE /assets/:id/primary-ipv6             release that pin
POST   /assets/:id/address-check            score an address before pinning or typing it
GET    /credentials                         stored credentials, secrets masked
```

`azure:` tags belong to the Azure Arc integration. `POST /assets`, `PUT
/assets/:id` and `POST /assets/bulk-tags` ignore any `azure:` tag in the body
and always keep the ones a device already has.

`PUT /assets/:id/primary-ipv6` takes `{ ip }` and sets `ipv6Address`, the
primary IPv6 shown beside `ipAddress` and never in it; a device with no
`ipAddress` is monitored on it. It is a `409` while IPv6 is off for the install,
and a `400` for an address that is not IPv6 or is loopback, link-local or
multicast. `DELETE` goes back to the automatic choice. An IPv6 address sent to
`PUT /assets/:id/primary-address` is a `400`.

`PUT /assets/:id/primary-address` takes `{ mac, ip }` — one of the device's own
addresses, as listed in `associatedIps` on `GET /assets/:id` (each entry names
its `mac`, the reporting gate `device`, and `medium`). Reading `GET /assets/:id`
first checks the device's DHCP lease and reservation entries against IPAM, and
drops one IPAM has released or holds for a different MAC. A pair not on that list,
or a FortiGate / FortiSwitch / FortiAP managed by a Fortinet integration, is a
`409`. While pinned, discovery does not change `ipAddress`, except to follow a
renumber: when the pinned IP has gone unseen for 24 hours and the same MAC has
exactly one recently seen address, the pin moves to it. Typing or clearing the
IP through `PUT /assets/:id` releases the pin, as does `DELETE`, which moves the
device to the address on its own list with the highest `evidenceScore` (network
evidence including polling, no operator weight; a tie keeps the current
address). Only when the list is empty does `DELETE` fall back to what discovery
reports. See [rule 102](Business-Rules#rule-102) and
[rule 103](Business-Rules#rule-103).

`GET /assets/:id` carries `addressConfidence`, a score for every address on
the device keyed by IP: `{ score, evidenceScore, discoveryScore, band,
evidenceBand, parts, penalties, sustained }`. `score` runs 0–100 and counts an operator's
pin or typed address; `evidenceScore` is the network evidence alone;
`discoveryScore` (0–100) is discovery's evidence alone — no operator, no
polling — and is what the automatic pin release compares. `band` is `high` (80 and up),
`medium` (50), `low` (20) or `very-low`. Each `parts` entry is one kind of
evidence (`{ kind, label, device, seenAt, hours, value }`); a gate's sighting
has the kind `detected-ambiguous`, and counts for far less, when that gate's ARP
table shows the network card with several addresses. Each `penalties` entry is
`{ kind, factor, detail }`, a multiplier on the score: `alive-elsewhere`,
`claimed-elsewhere`, or `arp-elsewhere` — the address rests on what a gate
detected, no ARP entry backs it, and a gate's ARP table has that MAC at a
different address. `sustained` is true while Polaris's own polling is answering
on the address: its evidence is then not aged in `score` and `evidenceScore`,
while `discoveryScore` still ages it. The list returns the compact form,
`{ score, band }` per address. Nothing alerts on the score; it only picks the
address an unpinned device moves to and when a pin is released.

`POST /assets/:id/address-check` (`assets:write`) takes `{ ip, probe? }` and
returns the same fields for that address plus `warn` (true when
`evidenceScore` is below `warnBelow`, 50) and `probe` — `{ answered, error }`
from one ping sent by the server when `probe` is true, else `null`. An address
the device has never been seen on scores 0. Nothing is written, and the pin and
`PUT /assets/:id` never refuse a low score. An invalid IP is a `400`, an
unknown device a `404`. See [rule 103](Business-Rules#rule-103).

### Onboarding a device over the API

Creating a device and putting it under monitoring is **two calls**. `POST
/assets` carries inventory fields only — `monitored` and every `*CredentialId`
are rejected there and belong to the `PUT`.

Credentials are **not** created over the API in the normal flow: an operator
saves them once under Server Settings → Credentials, and the integration
references the stored row by id (resolve it by name through `GET /credentials`,
or paste the id into the client's config). This also sidesteps [the ownership
trap](#the-ownership-trap) — a token that never writes a credential never needs
`credentials:fullwrite`. `assets:write` alone covers both calls; add
`credentials:read` only if the client resolves ids by name.

**Duplicate addresses are checked as you write.** Both calls return an
`ipConflict` field — `null`, or `{ conflictId, ip, qualifiedBy, members[] }` when
the address you just set is already recorded by another network-present asset.
Polaris raises the Duplicate IP conflict on the spot rather than on its
ten-minute sweep, and a `PUT` that moves a device *off* a contested address
closes that conflict in the same call. Ask before writing with
`GET /assets/ip-check?ip=&excludeAssetId=&assetType=&macAddress=`
(`assets:read`): it returns every current holder (`holders[]`, each with
`claimCurrent` — a stale record is listed but does not collide),
`wouldConflict`, and `canMerge` (whether the caller holds `assets:fullwrite`,
which merging requires). The answer uses the same rules the write applies, so a
`wouldConflict: true` is a conflict the save will raise. See
[Conflict Resolution](Conflict-Resolution#checked-when-you-save-not-just-every-ten-minutes).

A device created this way is a **manual-source** asset, and only response time
gets a source default (ICMP). Every other stream stays dark until a polling
method is chosen for it, so `monitored: true` on its own buys you ping and
nothing else.

Two refusals to code against, both `400`:

- **`Credential <id> not found`** — the id is well-formed but names no stored
  row. Usually a credential deleted and recreated in the UI, which issues a new
  id.
- **A credential type the stream's transport cannot use** — the pairing is
  `snmp→snmp`, `winrm→winrm`, `ssh→ssh`, `rest_api→restapi`. ICMP, Disabled,
  Agent, vCenter and FortiManager take no per-asset credential, and a credential
  left beside one of those is accepted as staged config. `monitorCredentialId`
  is never type-checked — it is the fallback for every stream at once, and those
  streams may legitimately poll over different transports.

`monitored: true` on a decommissioned, disposed, lost or disabled device is a
`409` ([rule 10](Business-Rules#rule-10)) — change the status first.
`POST /assets/bulk-monitor` is the exception to that shape: per-id problems come
back in `errors[]` with HTTP 200 while the rest of the batch applies, because a
mixed selection is the normal case. An unknown `monitorCredentialId` still fails
the whole call, since it applies to every id in the batch.

### Quarantine (the SIEM flow)

```
GET    /assets/quarantine-availability      is push enabled anywhere?
POST   /assets/:id/quarantine
POST   /assets/:id/quarantine/verify
GET    /assets/:id/quarantine-status
DELETE /assets/:id/quarantine
POST   /assets/bulk-quarantine
GET    /assets/sighting-settings            PUT to change
```

**Check availability first.** Quarantine push skips push-disabled integrations,
so on an install with none enabled the push returns *"0/0 FortiGate(s) accepted
the push"*. Every UI surface that offers quarantine reads that endpoint and
withholds the verb when it is false. **Release is never gated on it.**

A token granting quarantine at `write` or above **must** name its scoped
integrations.

Note that quarantining a device also makes it **unmonitorable**
([rule 10](Business-Rules#rule-10)) — every probe would fail by design, since
the device is isolated at the gate. The monitored flag is **parked** and restored
on release.

### Dashboard and NOC feeds

```
GET    /dashboard/noc-summary
GET    /dashboard/summary
GET    /dashboard/filter-options
```

These are **filter-don't-403** surfaces: a token whose role cannot read
something gets a narrower payload, not an error.

`/dashboard/filter-options` returns the vocabularies the widget filters accept:
`assetTypes`, `regions`, `fortigates` (`{ id, name, regions }` per gate — `id`
is the firewall's asset id), `automations` (every automation as
`{ id, name, enabled, triggerType }`, returned only to a role with
`alerts:read`) and `tags` (the fleet's asset tags, with
`region:` tags left out — they are `regions`).

`/dashboard/noc-summary` takes `?feeds=` to select the subset a caller renders.
Each feed is gated on the key that owns its data — `assets:read` for most of
them, `events:read` for `recentReboots`, `alerts:read` for `activeAlerts`, and
`maintenanceManagement:read` for `maintenanceSchedules`, the feed behind the
Active Maintenance widget. A kiosk token therefore reads the maintenance feed
only if its role was granted that key.

The maintenance rows state their window times in the **Polaris server's** local
wall clock (`startedAt` / `endsAt`, no offset — the recurrence engine is
evaluated against that clock) and repeat the end as a true instant
(`endsAtUtc`) for a countdown. Unlike every other feed, the asset filter does
not narrow them: a schedule is returned when any of its devices is in scope,
whole, with `matchedCount` giving the in-scope share.

Seven `sdwan*` feeds back the SD-WAN widgets and are empty on an install with
no SD-WAN collection: `sdwanRuleFailovers` (rules down or off their preferred
member), `sdwanSingleLink` (gates with two or more WAN paths left with one or
none), `sdwanSlaHeadroom` (% of the SLA target each live member uses, 100 being
the target), `sdwanFlaps1h` / `sdwanFlaps24h` (up → down drops per member) and
`sdwanCompliance1h` / `sdwanCompliance24h` (% of the window OUT of SLA per
health check and member — compliance is 100 minus it). The four windowed feeds
share one computation that is cached for about two minutes, so they lag by up
to that much.

### Path Monitor

```
GET    /path-checks
GET    /path-checks/:id
GET    /path-checks/:id/results
POST   /path-checks
PUT    /path-checks/:id
POST   /path-checks/:id/enabled
DELETE /path-checks/:id
POST   /path-checks/preview-sources
POST   /path-checks/test
GET    /path-checks/filter-schema
GET    /path-checks/:id/server
GET    /path-checks/:id/server/history
GET    /path-checks/:id/server/traceroutes
GET    /assets/:id/path-checks
GET    /assets/:id/path-check-history?checkId=
GET    /assets/:id/path-check-traceroutes?checkId=
```

A [path check](Path-Monitor) is an HTTP / HTTPS request, a TCP connect or a
ping that the Polaris Agent (0.21.0 or later) runs from each of its hosts, with
an optional traceroute. The `/path-checks` endpoints gate on the `pathChecks`
key; the three `/assets/:id/…` readings gate on `assets:read`, because they
describe that asset.

- **Hosts** are the check's `scope` (the automation device-filter tree,
  `{ "allAssets": true }` for every agent host) plus pinned `assetIds`, limited
  to hosts running an active agent. `preview-sources` dry-runs that selection
  without saving; its `ids` lists every selected host (up to 2000), past the
  100 rows it describes. `sourceFilter` (`{ condition }` or `null`) is the
  filter the UI used to find hosts before ticking them into `assetIds`; it is
  stored for display only and never decides who runs the check.
- **The Polaris server** runs the check too when `runOnServer` is `true`. One
  of `scope`, `assetIds` and `runOnServer` must select something. Setting it,
  changing what a server-run check sends, or re-enabling one also needs
  `networkScan:write` (`403` otherwise). The server is not an asset: it is the
  first `/results` row (`server: true`, `assetId: null`), its readings are the
  three `/path-checks/:id/server…` endpoints (on `pathChecks:read`), and its
  results raise an automation alert only when the trigger carries
  `"includeServer": true` (below).
- **Targets** are a full URL for HTTP / HTTPS, `host:port` for TCP and a bare
  host for ICMP, IPv4 only. Loopback, link-local, cloud-metadata and multicast
  addresses, and the Polaris server itself, are refused with `400`.
- **Limits:** `intervalSec` is whole minutes (60–3600); `timeoutMs` is
  500–30000 and at most half the interval; a body-match regex must be
  RE2-compatible. At most 50 checks can be enabled (`409` past that), and a
  host runs at most 20 — the oldest win, and the rest raise a
  `path_check.agent_over_cap` event.
- `PUT` replaces the whole definition; it is not a patch.
- `http` also takes `method` (`GET` | `HEAD`, nothing else), `hostHeader`,
  `followRedirects` and `bodyMatch.negate`; a check using any of them needs
  agent 0.23.0. `credentialId` (an HTTP credential, Bearer / Basic / Digest)
  makes the check server-only: agent `scope` / `assetIds` are refused with
  `400`, and using the credential needs at least `credentials:read`
  (`403` otherwise).
- `test` runs a draft once from the Polaris server and returns the verdict,
  timings and, for HTTP / HTTPS, the headers (cookie values redacted) and the
  first 64 KB of the body. Nothing is saved but an audit event. Same
  `networkScan:write` requirement as running from the server; 10 a minute per
  caller (`429` past that).
- A check has no threshold and never changes a host's Up / Down status. To be
  alerted, build an automation on the `path*` metrics or the
  `path_check_path_changed` change type — the wizard's **Path Monitor** trigger.
  Its devices are always the rule's `scope` ANDed with *Polaris Agent
  installed*, and a composite may not mix `path*` conditions with any other.
  `"includeServer": true` on a single `path*` condition (or on the change
  trigger) adds the Polaris server as a source; it is refused beside a
  `reset.mode` of `condition`, and its alerts carry `assetId: null` and
  `assetHostname: "Polaris server"`.

`path-check-history` takes the same `range=` presets and `from` / `to` as the
other history endpoints and returns per-run samples on the detail tier, or
per-bucket averages with `okCount` / `failCount` on the hourly and daily tiers.
`path-check-traceroutes` returns the newest traces first (`limit` ≤ 50). Each
hop carries the asset, interface and subnet Polaris matched its address to at
the time of the trace.

Each `/path-checks` row also carries `maintenance: { inMaintenance, windows[] }`
— whether a maintenance schedule has the check paused right now (below).

### Maintenance schedules

```
GET    /maintenance-schedules?target=assets|pathChecks
POST   /maintenance-schedules
PUT    /maintenance-schedules/:id
DELETE /maintenance-schedules/:id
GET    /maintenance-schedules/server-time
GET    /maintenance-schedules/occurrences?from=YYYY-MM-DD&to=YYYY-MM-DD
GET    /maintenance-schedules/path-checks/:checkId
POST   /maintenance-schedules/path-checks/:checkId/release
```

A [maintenance schedule](Maintenance-Windows) pauses either **assets** or
**path checks**, never both in one schedule. Every route gates on
`maintenanceManagement` (read to list, write to change), and a write takes
effect before the call returns.

- **Assets:** `criteria` (an asset filter, never on status) and / or
  `assetIds`; only monitored assets enter. `suppressChildren` (default `true`)
  marks devices behind them as down for dependency suppression.
- **Path checks:** `pathCheckIds` in place of both. A paused check stops
  running on every agent host and on the server, and its `path*` automations
  neither fire nor send reminders or escalations. A body carrying both kinds,
  or naming an unknown check, is a `400`.
- **Times** are the Polaris server's wall clock, `"YYYY-MM-DDTHH:MM"` with no
  offset — read `server-time` first. A one-time `schedule` may say
  `"startNow": true` in place of `startAt`. A one-time schedule naming a single
  asset or path check, with no criteria, removes itself when its window ends.
- `PUT` replaces the whole schedule; a field left out returns to its default.
- `path-checks/:checkId` reports whether a check is paused, by which windows
  (each with its end as `until`) and which schedules name it.
  `path-checks/:checkId/release` ends its maintenance now (`{ released }`); a
  recurring schedule takes it again at its next occurrence.

```
curl -X POST -H "Authorization: Bearer $POLARIS_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"ERP upgrade","pathCheckIds":["<check id>"],"schedule":{"version":1,"kind":"oneshot","startNow":true,"endAt":"2026-11-01T06:00"}}' \
  https://polaris.example.com/api/v1/maintenance-schedules
```

### Search

```
GET    /search?q=
```

Seven groups in one response — `blocks`, `subnets`, `reservations`, `assets`, `ips`,
`sites`, `ipsec` — each gated on its own read key and empty when the caller may not
read it. `ipsec` hits are a firewall's IPsec tunnels and the peers or VPN users
connected through them (`id` is `<gateAssetId>|tunnel|<name>` or
`<gateAssetId>|conn|<name>`; `context.assetId` is the gate, `context.peerAssetId`
the far-end device when known). Supports the same
[prefixes](Navigation-and-Account#global-search) the UI does
(`block:`, `network:`, `asset:`, `reservation:`, `map:`, `tag:`, `ipsec:` / `vpn:`).
A query that reads as a TLS or SSH thumbprint (8+ characters) also returns the
asset that pin belongs to, archived pins included, first in `assets` with
`context.pinMatch` — for a caller with `serverSettingsSystem` read.

### IPAM — blocks

```
GET    /blocks              GET /blocks/:id
POST   /blocks              PUT /blocks/:id      DELETE /blocks/:id
```

Each `GET /blocks` row carries `utilizationPercent` (0–100): the share of the
block's address space carved into non-deprecated networks.

### IPAM — networks

```
GET    /subnets                    GET /subnets/:id
GET    /subnets/:id/ips
POST   /subnets                    blockId optional — omitted = most specific containing block
GET    /subnets/resolve-block?cidr= which block that would be
POST   /subnets/next-available     allocate the next free /N
POST   /subnets/bulk-allocate      anchor-aligned, all-or-nothing
PUT    /subnets/:id                DELETE /subnets/:id
POST   /subnets/:id/refresh        the Discover button: DHCP + firewall VIPs
GET    /subnets/:id/move-targets   blocks that can hold it, overlaps flagged
POST   /subnets/:id/move           { blockId } — re-parent onto another block
POST   /subnets/:id/archive        fullwrite
GET    /subnets/archived           GET /subnets/archived/:id
GET    /subnets/exclusions
POST   /subnets/exclusions         fullwrite
PUT    /subnets/exclusions/:id     fullwrite — name and notes only
DELETE /subnets/exclusions/:id     fullwrite
```

Each row from `GET /subnets` carries its address usage:
`_count.reservations` (reservations holding an address right now — active, with
an `ipAddress`; released and expired rows and whole-network reservations are
not counted), `usableHosts` (what the CIDR can hand out, `null` for IPv6),
`utilizationPercent` (the first over the second, to one decimal, `null`
wherever `usableHosts` is) and `totalReservations` (every reservation row
whatever its status — what a delete removes).

An **exclusion's CIDR is its identity** and is frozen after create — the PUT
accepts name and notes only ([rule 42](Business-Rules#rule-42)). Changing the
range is a delete plus an add.

### IPAM — reservations

```
GET    /reservations
POST   /reservations
POST   /reservations/next-available
PUT    /reservations/:id           DELETE /reservations/:id
GET    /reservations/push-queue
```

Behaviours to code against:

- **Creating over a `dhcp_lease` is a create, not a release.** The lease is
  observed presence; Polaris supersedes it server-side. The same goes for an
  `observed` row, an IPv6 address a FortiGate saw a client using without
  assigning it, which carries an `expiresAt` a day past its last sighting
  ([rule 125](Business-Rules#rule-125)). Creating over a `manual`,
  `dhcp_reservation`, `vip` or `interface_ip` row returns **409**.
- **An IPv6 `ipAddress` is stored in compressed lower-case form** (RFC 5952),
  whatever spelling you send, and an IPv6 reservation is never pushed to a
  FortiGate, even on a push-enabled network.
- **On a push-enabled network the push is verified by read-back, and any failure
  aborts the create entirely.** You never end up with a Polaris row the gate has
  never heard of — so a 5xx here means *nothing was written*, not *partially
  written*.
- **On a push-enabled network `notes` is length-budgeted, and over-length is a
  400.** The notes become the FortiGate entry's description, which the device
  holds 255 characters of — including the `Polaris/<user>: … [<hostname>]`
  wrapper Polaris writes around them, so the usable length depends on the
  creator's username and the hostname. The error names the budget and the
  overage. Nothing is truncated, and nothing is judged on a network with no DHCP
  Push ([rule 74](Business-Rules#rule-74)).
- **The all-zero MAC is a 400.** `00:00:00:00:00:00` (any separators) names no
  device, so a create with it, or an update that changes the MAC to it, is
  refused. Omit `macAddress` instead. An update that sends back a zero the row
  already holds is accepted. On assets the same value is stored as no MAC
  rather than refused ([rule 97](Business-Rules#rule-97)).

### Automations

```
GET    /automations                GET /automations/schema
POST   /automations                PUT /automations/:id        DELETE /automations/:id
GET    /automations/:id/removal-impact
POST   /automations/preview
POST   /automations/dimension-values      POST /automations/poll-cadence
GET    /automations/scope-options         GET  /automations/recipient-users
```

Gated on `automationManagement`. Behaviours to code against:

- **Build against `GET /automations/schema`, not a hardcoded list.** It returns
  every metric, state field, comparator, action type and severity the server
  accepts, plus the names behind ids a condition can carry (state probes, path
  checks, custom widgets).
- **Preview before you create.** `POST /automations/preview` takes a partial
  draft (a scope alone, or a trigger and scope), reports which devices it covers
  and how many readings meet it right now, and writes nothing.
- **PUT is a full replace.** Fields you leave out take their defaults, so read
  the rule, change it and send it all back.
- **An empty scope selects no devices.** For a metric, state or composite
  trigger, `"scope": {}` covers nothing. Every device is
  `{"allAssets": true}`; otherwise name the filter. Only an `event` trigger reads
  `{}` as any device.
- **No `reset` means manual.** A rule saved without one never clears by itself;
  send `{"mode": "auto"}` to clear when the condition stops holding. A PUT that
  leaves `reset` out turns an auto-clearing rule into a manual one.
- **An `api_call` action's headers come back masked.** Sending the mask back
  keeps the stored value, but only while that action's URL is unchanged. A
  masked header on a changed URL is a 400, so a stored token never follows a new
  destination ([rule 114](Business-Rules#rule-114)).
- **Two action types need a second permission to save:** a `script` action needs
  `automationScripts:write`, a `reboot` action needs `assets:write`.
- **A `monitorStatus == down` automation defines down detection** for its
  devices. Check `GET /automations/:id/removal-impact` before deleting or
  disabling one: devices it reports as `wouldBecomePassive` stop being declared
  down.
- `POST /automations/test-delivery` needs a signed-in user and answers 401 to a
  bearer token.

### MIB Database

```
GET    /server-settings/mibs              POST /server-settings/mibs   (multipart upload)
GET    /server-settings/mibs/:id          GET  /server-settings/mibs/:id/download
GET    /server-settings/mibs/:id/structure      POST /server-settings/mibs/:id/walk
GET    /server-settings/mibs/std          GET  /server-settings/mibs/std/:key/structure
POST   /server-settings/mibs/std/:key/walk      GET  /server-settings/mibs/facets
DELETE /server-settings/mibs/:id
```

Gated on `mibDatabase`. A vendor's objects resolve only from a module you upload
under that vendor's manufacturer name; Polaris bundles the standard MIBs and no
vendor's. The upload response's `unresolvedRoots` names any module the file
imports that is still missing: upload a vendor's core module before its leaf
modules. A module is unique per manufacturer, model and module name (a second
copy is a 409). `/structure` lists every symbol with its resolved OID, type and
enum values, which is what to read when choosing a profile row's symbol.

### Manufacturer profiles

```
GET    /server-settings/manufacturer-profiles          POST /server-settings/manufacturer-profiles
GET    /server-settings/manufacturer-profiles/suggestions
GET    /server-settings/manufacturer-profiles/:id      PUT  /server-settings/manufacturer-profiles/:id
DELETE /server-settings/manufacturer-profiles/:id
PUT    /server-settings/manufacturer-profiles/:id/metrics/:metricKey
POST   /server-settings/manufacturer-profiles/:id/metrics/:metricKey/overrides
PUT    …/overrides/:overrideId                          DELETE …/overrides/:overrideId
POST   /server-settings/manufacturer-profiles/:id/widgets
PUT    …/widgets/:widgetId                              DELETE …/widgets/:widgetId
GET    …/widgets/:widgetId/assets                       PUT  …/widgets/:widgetId/assets
GET    /server-settings/manufacturer-profiles/:id/export
GET    /server-settings/manufacturer-profiles/:id/code  PUT  /server-settings/manufacturer-profiles/:id/code
POST   /server-settings/manufacturer-profiles/import/preview
POST   /server-settings/manufacturer-profiles/import
GET    /manufacturer-aliases       POST /manufacturer-aliases     PUT|DELETE /manufacturer-aliases/:id
```

Gated on `manufacturerProfiles`; the widget device list and switch also need
`assets:read` / `assets:write`. Behaviours to code against:

- **Create a profile under a name the devices already carry.**
  `/suggestions` lists them. A profile governs devices with its manufacturer
  name, and its "also applies when" `matchPattern` reaches others only when no
  profile has their own name ([rule 131](Business-Rules#rule-131)).
- **A row that saves can still collect nothing.** Every row-level write returns
  `warnings` naming symbols that don't resolve, and `GET /:id` stamps every row
  with `readiness`. Upload the MIB those name.
- **A Hardware Sensors table row** names the table's value column as its symbol
  and the other columns in `defaultSensorColumns`
  ([rule 132](Business-Rules#rule-132)).
- **A new custom widget polls no device** until it is switched on with
  `PUT …/widgets/:widgetId/assets` ([rule 130](Business-Rules#rule-130)).
- **Export and import carry no ids or secrets.** MIBs travel by module name and
  are not included. Import is two calls: preview, then import only the items you
  choose. `PUT /:id/code` is a full replace: rows left out of the file are
  removed.
- Every pattern is RE2, so look-around and back-references are a 400.

### Events

```
GET    /events
```

The audit tail. Events older than 7 days are pruned by default. Text filters
(`action`, `resourceName`, `actor`, `message`, `device`) each take an optional
`<field>Op` of `contains` (default), `not_contains`, `empty` or `is_not_empty`;
`assetId` returns every event about one asset. Each event carries `assetId` and
`assetName`, that asset's current hostname (else its IP; `null` when the asset
is gone), and `device` filters on that name.

---

## Endpoints outside `/api/v1`

Three, declared on the app itself, outside the permission model and gated only
by optional tokens from `.env`:

| Endpoint | |
|---|---|
| **`GET /health`** | liveness. 200 whenever the process is up, and **checks nothing at all** — the setup wizard polls it before a database exists. Gated by `HEALTH_TOKEN` when set |
| **`GET /health/ready`** | readiness. 200 only when the local PostgreSQL is a **writable primary**; else 503 with a reason (`in-recovery` / `db-error` / `timeout`). Never cached. Gated by `HEALTH_TOKEN` too. **This is the one a load balancer should monitor** |
| **`GET /metrics`** | Prometheus. Gated by `METRICS_TOKEN` when set, and by an nginx `allow` block (the Web Server tab's Prometheus allow-list) in production |

The [setup wizard](First-Run-Setup#step-3--application-settings) generates both
tokens, so on a wizard-built install all three answer `401` until the caller
sends `Authorization: Bearer <token>`. Clearing a token opens its endpoint, and
the Maintenance tab warns while it is unset.

None carries a session or a role snapshot, and all three are served only by the
`web` and `all` process roles.

---

## Response headers

Every response — **including a 404** — carries the app's security headers
([rule 50](Business-Rules#rule-50)). An unmatched route is *answered* by the
app, never dropped to the framework's default handler, which would replace the
Content Security Policy with one that drops `frame-ancestors` and `form-action`
and echo the request path back in an HTML body.

The 404 message is a **constant**. Nothing you send is reflected.

---

## Client conventions

- **Paginate.** List endpoints take `limit` and `offset`, and return an
  **unpaged total**. Read the total; do not infer truncation from a full-looking
  array.
- **Expect `dhcpBinding` and `sourceType` to disagree** — they answer different
  questions ([rule 23](Business-Rules#rule-23)).
- **Do not assume `Asset.ipAddress` is unique.** Two rows on one address is a
  state Polaris must be able to represent in order to report it
  ([rule 40](Business-Rules#rule-40)).
- **Treat `passive` as a real monitor status**, not as an error. Anything
  testing `!== "up"` as a proxy for unreachable must exempt it
  ([rule 36](Business-Rules#rule-36)).
- **Back off on 429.**

---

## The Polaris toolbox plugin

A Claude Code plugin, **`polaris-toolbox`**
(https://github.com/rogers-group-inc/polaris-toolbox), carries a client guide
to this API generated from the in-app `/api` page and regenerated whenever that
page changes, plus skills for building manufacturer profiles, configuring
automations and writing automation scripts, and scripts that apply and export
profiles and automations over this API. It replaced the separate
`polaris-api-conventions` and `polaris-automation` plugins.
