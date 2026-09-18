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
| a request the token's role does not permit | `403` — except on filter-don't-403 surfaces, which narrow instead |
| **any** unknown path under `/api/v1` to an anonymous caller | **`401`, not `404`** — the API does not tell an anonymous caller which endpoints exist |

There is **no token-introspection endpoint**. `GET /auth/me` answers
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
| `403` | authenticated, but the role lacks the permission |
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
POST   /assets                              create a device
PUT    /assets/:id                          update + the monitoring surface
POST   /assets/bulk-monitor                 flip monitoring on many at once
DELETE /assets/:id
GET    /credentials                         stored credentials, secrets masked
```

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

### Search

```
GET    /search?q=
```

Supports the same [prefixes](Navigation-and-Account#global-search) the UI does
(`block:`, `network:`, `asset:`, `reservation:`, `map:`, `tag:`).

### IPAM — blocks

```
GET    /blocks              GET /blocks/:id
POST   /blocks              PUT /blocks/:id      DELETE /blocks/:id
```

### IPAM — networks

```
GET    /subnets                    GET /subnets/:id
GET    /subnets/:id/ips
POST   /subnets
POST   /subnets/next-available     allocate the next free /N
POST   /subnets/bulk-allocate      anchor-aligned, all-or-nothing
PUT    /subnets/:id                DELETE /subnets/:id
POST   /subnets/:id/refresh
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

Two behaviours to code against:

- **Creating over a `dhcp_lease` is a create, not a release.** The lease is
  observed presence; Polaris supersedes it server-side. Creating over a
  `manual`, `dhcp_reservation`, `vip` or `interface_ip` row returns **409**.
- **On a push-enabled network the push is verified by read-back, and any failure
  aborts the create entirely.** You never end up with a Polaris row the gate has
  never heard of — so a 5xx here means *nothing was written*, not *partially
  written*.

### Events

```
GET    /events
```

The audit tail. Events older than 7 days are pruned by default.

---

## Endpoints outside `/api/v1`

Three, declared on the app itself, outside the permission model and gated only
by optional tokens from `.env`:

| Endpoint | |
|---|---|
| **`GET /health`** | liveness. 200 whenever the process is up, and **checks nothing at all** — the setup wizard polls it before a database exists. Gated by `HEALTH_TOKEN` when set |
| **`GET /health/ready`** | readiness. 200 only when the local PostgreSQL is a **writable primary**; else 503 with a reason (`in-recovery` / `db-error` / `timeout`). **This is the one a load balancer should monitor** |
| **`GET /metrics`** | Prometheus. Gated by `METRICS_TOKEN` when set, and by an nginx `allow` block in production |

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

## The client conventions plugin

A generated client guide to this API lives in a separate repository,
**`polaris-api-conventions`**, produced from the in-app `/api` page. It is
regenerated when that page changes.
