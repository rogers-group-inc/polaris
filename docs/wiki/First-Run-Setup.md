# First-run setup

The first time you browse to a freshly installed Polaris, it serves a four-step
setup wizard instead of the login page. The wizard writes `.env`, provisions the
database schema, and creates the first administrator.

It runs on its own small HTTP server with its own rate limits (600 requests /
5 min for the server, 30 / 15 min for the routes that touch the database). Once
setup completes, the main application takes over and the wizard is gone.

---

## Step 1 — Database

| Field | Default | Notes |
|---|---|---|
| Host | `localhost` | or a managed-service hostname |
| Port | `5432` | |
| Username | `polaris` | |
| Password | — | the role's password |
| Database name | `polaris` | **created automatically if absent** |
| Use SSL | off | tick for a remote or managed database |
| Allow self-signed certificate | hidden until SSL is ticked | |

### The one thing to get right here

"Allow self-signed certificate" writes `sslmode=no-verify` into `DATABASE_URL`.
That is **correct** — `DATABASE_URL` is a driver URL and node-postgres accepts
that value. But `pg_dump` and `psql` read `PGSSLMODE`, which is libpq's
vocabulary, and libpq exits 1 on `no-verify`.

Polaris translates between the two (`no-verify` → `require`, the same posture
since only `verify-ca` and `verify-full` validate the chain). It did not always,
and the symptom was that **every backup path failed on every install created
this way** — manual, scheduled and pre-update — behind the message *"Database
backup failed — see the server log"*. This is [rule 51](Business-Rules#rule-51).
It matters here because a scripted RHEL install never sees it (those dump over a
unix socket and build no URL at all), so a green scripted install proves nothing
about a container or remote-database one.

If you are on a build that predates the fix, take a backup by hand after setup
and confirm it works, rather than discovering it during an upgrade.

---

## Step 2 — Admin account

Username (defaults to `admin`), password, confirm password.

The password must satisfy the **password policy**. Out of the box that is the
shipped default — minimum 8 characters and four character classes — but the
policy is a Setting, so on a re-run or a restored install it may already be
stricter. The wizard reads the live policy: `GET /auth/password-policy` is
deliberately public, because both the wizard and the forced-change login step
need the rules with no session.

This account is created on the built-in `admin` role, which holds `fullwrite`
on every function key. You cannot delete or edit the `admin` role.

---

## Step 3 — Application settings

| Field | Notes |
|---|---|
| HTTP port | the port Polaris listens on after setup |
| Session secret | **auto-generated**; read-only in the form |

The session secret signs session cookies and is written to `.env` as
`POLARIS_SECRET_KEY`. It also keys the encryption of secrets at rest —
integration tokens, credentials, channel secrets. **Losing it means losing every
stored secret**, so it belongs in your backup and your password manager, not
only on the host.

---

## Step 4 — Review

Confirm, then **Complete Setup**. Polaris writes `.env`, runs the migrations,
seeds the built-in roles and asset types, creates the admin account, and
restarts into the normal application.

A progress panel reports each step. If it stops, the message names the step —
almost always the database connection or a missing TimescaleDB extension.

---

## What Polaris seeds for you

Setup is not a blank slate. It creates:

- **Five built-in roles** — `admin`, `readonly`, `networkadmin`, `assetsadmin`,
  `user`. See [Users, roles and permissions](Users-Roles-and-Permissions).
- **The asset-type registry** — the eight historical built-ins (`server`,
  `switch`, `router`, `firewall`, `workstation`, `printer`, `access_point`,
  `other`) plus `hypervisor` and `kubernetes_cluster`.
- **Baseline automations** — including a fleet-wide down-detection automation
  and an "IP conflict detected" automation. The down one matters more than it
  looks: **a device no down automation covers reads `passive` and is never
  judged** ([rule 36](Business-Rules#rule-36)), so deleting the baseline rule
  without replacing it silently stops Polaris deciding anything is down. The
  delete/disable confirmation warns you with the count of devices that would be
  left unjudged.

---

## Immediately after setup

A sensible order:

1. **Server Settings → Identification** — name the install; it appears in
   emails and the browser title.
2. **Server Settings → Credentials** — add the SNMP / SSH / WinRM / REST
   credentials your devices need, before you add integrations that reference
   them.
3. **Integrations** — add your first source of truth. See
   [Integrations](Integrations).
4. **Users → Authentication** — wire SSO if you use it, and set the
   [password policy](Users-Roles-and-Permissions#password-policy) you actually
   want.
5. **Automations** — review the baseline rules and point them at real
   recipients. A shipped automation with nobody on it delivers nothing.
6. **Server Settings → Maintenance** — set the automatic backup cadence, and
   take one manual backup to prove the path works end to end.

Step 6 is not optional advice. **A backup you cannot restore is not a backup**
([rule 20c](Business-Rules#rule-20)) — and the two failure modes that hide
there, a `pg_dump` older than the server and an untranslated `sslmode`, both
present as one generic sentence until you actually try.
