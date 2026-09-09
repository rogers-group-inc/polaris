# Polaris — Install Guide

This guide covers fresh installs on **RHEL / Rocky / AlmaLinux 9**, **Ubuntu / Debian**, and **Windows Server**. The runtime itself is platform-portable; the only differences between platforms are package names, service managers, and where PostgreSQL puts its data directory.

If you're upgrading an existing install rather than installing fresh, use the in-app updater under **Server Settings → Maintenance → Updates**. Don't follow this document for upgrades.

> **Update source repo.** By default both the in-app updater and the `deploy/update-{linux.sh,windows.ps1}` fallback scripts update from the install's existing `origin` git remote — i.e. whatever it was cloned from. To force a different source (a fork or an internal mirror), set `POLARIS_UPDATE_REPO=<git-url>` in `/opt/polaris/.env` (Linux) or `C:\polaris\.env` (Windows); it's applied to the `origin` remote before every fetch/pull. Leave it unset to keep using the cloned-from origin. The active repo and its source are shown on the Application Updates card (Server Settings → Maintenance).

---

## Supported platform versions

The canonical list. Every per-platform section below installs these versions; where a section
states a floor, it states the same one as this table.

| Component | Minimum | Polaris targets | Upstream end of life | Notes |
|---|---|---|---|---|
| **Node.js** | 22 | **24** | 22 → 2027-04-30 · 24 → 2028-04-30 | LTS lines only. The minimum is the dependency tree's floor (`engines.node` is `>=22.12.0`); every install script provisions **24**. `engines.node` is advisory — npm warns and installs anyway — so the scripts' accept-checks are the real gate. A host left on 22 has under a year of runway. |
| **PostgreSQL** | 15 | **17** | 15 → 2027-11-11 · 16 → 2028-11-09 · 17 → 2029-11-08 | Five-year policy; a major dies each November. Target is 17 because TimescaleDB 2.29 dropped 15. |
| **TimescaleDB** | 2.x | current | no published date | Lifecycle is a PostgreSQL-compatibility horizon, not a date: **2.28.x is the last line supporting PostgreSQL 15**, and 2.29+ supports only 16/17/18. |
| **Go** (agent build only) | 1.22 | **1.26** | 1.22 → 2025-02-11 · 1.25 → 2026-08-19 | Go supports only the two most recent majors, so this ages faster than anything else here. Needed only to build agent binaries in-app. |
| **nginx** | 1.25 | **1.30** | 1.25 → 2024-05-29 · 1.29 → 2026-05-13 | The 1.25 floor is the HTTP/3 requirement, not a support statement. The setup scripts install from the nginx.org **mainline** repo, so a scripted install lands on a current branch. |
| **Java** (agent signing only) | 17 | 17 | 17 → 2027-09-30 · 21 → 2028-09-30 | Microsoft Build of OpenJDK dates. Optional: without it, agent code signing is unavailable and nothing else changes. Target is deliberately the same as the minimum — nothing here needs 21, and naming it would report a behind-target JDK on every healthy install. Move to 21 when 17 nears its date, not before. |
| **RHEL / Rocky / AlmaLinux** | 9 | 9 | 9 → 2032-05-31 (full support ends 2027-05-31) | |
| **Ubuntu** | 22.04 LTS | **24.04 LTS** | 22.04 → 2027-06-01 · 24.04 → 2029-05-31 | LTS only. Extended dates require Ubuntu Pro; don't treat them as free runway. |
| **Windows Server** | 2019 | 2022 | see Microsoft's product lifecycle | |
| **PgBouncer** (optional) | 1.21 | 1.21 | no published date | Polaris cannot read its version — confirm the floor by hand. |

**Polaris warns you about this itself.** Server Settings → **Maintenance → Platform Lifecycle**
shows what this host is actually running, grades it against these dates, and links the upgrade
steps for anything past or approaching end of life. A component below the minimum above is
flagged critical; an upstream end-of-life is flagged and emailed but deliberately does not hold
a permanent banner open, since it clears only in a maintenance window.

> Dates last reviewed 2026-09-08 against upstream sources. They live in
> `src/data/platformEol.json`, which is what the in-app card reads; `npm run check:versions`
> asserts the version pins across the repo agree with each other.

---

## Networks that inspect TLS

Skip this unless your network re-signs HTTPS with an internal CA (Zscaler, Palo Alto,
Netskope and similar). If it does, read it before installing or updating — it is the one
environment problem that can leave an install unable to update.

**Why it bites Polaris specifically.** Node ships its *own* bundled CA store and ignores the
operating system's. So a root certificate the entire host trusts — one you added with
`update-ca-trust` and that `curl` and the browser accept — is still rejected inside Polaris
and inside `npm`.

**The fingerprint.** `npm` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` while the code-pull
step in the very same update succeeds. That asymmetry is the tell: the pull goes through
OpenSSL, which reads the system store; `npm` is Node, which does not.

It usually surfaces at the **Install dependencies** step of an update rather than at install
time, and often long after the network changed. `npm ci` only needs the registry for packages
that are not already in the local cache, so an install whose cache was warmed by an earlier
successful run keeps working until one dependency version changes. The first package that
misses the cache is the first to fail.

The same trust gap affects the app's own outbound calls once it is running: Entra/Graph and
Azure Arc discovery, the weekly IEEE OUI refresh, weather and map tiles, and webhook delivery.

### Fix

1. Add your internal root to the **operating system** trust store, if it is not already there:

   ```bash
   # RHEL / Rocky / AlmaLinux
   sudo cp internal-root.crt /etc/pki/ca-trust/source/anchors/
   sudo update-ca-trust

   # Ubuntu / Debian
   sudo cp internal-root.crt /usr/local/share/ca-certificates/internal-root.crt
   sudo update-ca-certificates
   ```

2. Point Node at that bundle in `/opt/polaris/.env`:

   ```bash
   # RHEL / Rocky / AlmaLinux
   NODE_EXTRA_CA_CERTS=/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem

   # Ubuntu / Debian
   NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
   ```

   `NODE_EXTRA_CA_CERTS` **extends** Node's built-in roots rather than replacing them, so it is
   safe to leave set even if the network stops intercepting. Fresh installs from
   `deploy/setup-*.sh` detect the bundle and write this line for you.

3. Restart so the units pick it up:

   ```bash
   sudo systemctl restart polaris.target
   ```

   The value has to be a real environment variable, not just a line the app parses — Node reads
   it before any JavaScript runs. It works from `.env` because the shipped units load that file
   with systemd's `EnvironmentFile=`, which exports it before `node` starts.

4. Confirm the toolchain can reach the registry as the app user:

   ```bash
   sudo -u polaris env NODE_EXTRA_CA_CERTS=/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \
     npm ping
   ```

**Do not** use `npm config set strict-ssl false`. It clears the error by disabling verification
of every package download on a host that installs 600+ packages — a supply-chain hole in place
of a configuration gap.

### Recovering an install whose update already failed here

`npm ci` deletes `node_modules` **before** it installs, so an update that failed at Install
dependencies leaves the on-disk dependency tree incomplete. The service keeps running from
modules already loaded in memory, so the app looks healthy — but **it will not survive a
restart or a reboot until an install succeeds.** Treat it as urgent, and do not restart it
first to "see if it's fine".

Apply the fix above, then re-run the update (Server Settings → Maintenance → Updates, or
`sudo bash deploy/update-linux.sh`). If you need to repair the dependency tree without a full
update:

```bash
cd /opt/polaris
sudo -u polaris env NODE_EXTRA_CA_CERTS=/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \
  npm ci --production=false
sudo -u polaris npm run build
sudo systemctl restart polaris.target
```

`deploy/update-linux.sh` reads `NODE_EXTRA_CA_CERTS` out of `.env` and re-supplies it to every
`npm` call itself, because `sudo` scrubs the environment — which is why the manual commands
above pass it explicitly too.

### Windows

Windows has no PEM bundle: the internal root lives in the certificate store, so export it to a
file and point `NODE_EXTRA_CA_CERTS` at that file in `C:\polaris\.env`.

```powershell
# Export the internal root (adjust the thumbprint / subject to match yours)
Get-ChildItem Cert:\LocalMachine\Root |
  Where-Object { $_.Subject -like "*YourInternalCA*" } |
  ForEach-Object { [IO.File]::WriteAllText("C:\polaris\internal-root.pem",
    "-----BEGIN CERTIFICATE-----`n" +
    [Convert]::ToBase64String($_.RawData, 'InsertLineBreaks') +
    "`n-----END CERTIFICATE-----`n") }
```

Then set `NODE_EXTRA_CA_CERTS=C:\polaris\internal-root.pem` and restart the Polaris service.
The Windows setup scripts do not detect this automatically — there is no single system PEM to
point at.

---

## Disk sizing — read this first

The single most common operational footgun on a fresh Polaris install is undersized `/var` (Linux) or undersized `C:` (Windows) — both are where PostgreSQL stores its data by default. Sample tables grow with monitored asset count × probe cadence × retention, so a deployment that's small at week 1 can hit 100% in month 6.

**Budget more than your retention window.** When TimescaleDB is installed, sample data is reclaimed a whole *chunk* at a time — a chunk can only be dropped once all of it is past the cutoff, and the prune runs once every 24 h. Each tier therefore keeps its configured window **plus one chunk interval plus one prune cycle**. Most sample tables use TimescaleDB's default 7-day chunk interval (only the interface, storage and IPsec detail tables are narrowed to 1 day), so a 7-day detail retention holds up to ~15 days on disk and a 3-day retention holds up to ~11. Size for that, not for the number in the retention setting.

The largest single driver is usually **how many interfaces operators pin** for fast-cadence polling (the System tab's *Poll 1m* column, and the per-integration interface auto-monitor selection). Polaris records interface *current state* for every port on every device at negligible cost, but keeps a time-series only for pinned interfaces — so a broad auto-monitor pattern across a fleet of 48-port switches is the difference between a few gigabytes and a few hundred. Server Settings → Maintenance → Capacity Advisor projects the steady-state size from your actual pinned count; if the forecast looks wrong, narrow the auto-monitor selection before buying disk.

| Volume | Minimum | Recommended | What lives here |
|---|---|---|---|
| **DB data volume** | 50 GB | 100 GB+ | PostgreSQL `data_directory`. On RHEL: `/var/lib/pgsql/data`. On Ubuntu: `/var/lib/postgresql/<ver>/main`. On Windows: `C:\Program Files\PostgreSQL\<ver>\data`. |
| **App / state volume** | 5 GB | 20 GB | Polaris install dir, encrypted DB backups (`data/backups/`), uploaded device icons, update staging (one extra copy of the bundle per update). |
| **`/var/log` (Linux only, if separate)** | 5 GB | 10 GB | systemd journal, audit logs, syslog forwarding spool. |
| **`/var/log/audit` (RHEL STIG only, if separate)** | 5 GB | 10 GB | auditd events. Fills faster than expected on busy hosts. |

The **DB volume number is the one that matters most.** Aim high; Postgres degrades hard when its volume hits 100% (postmaster will crash on WAL writes during recovery, see *Recovery* below).

The setup wizard runs a preflight check that statfs's the conventional PGDATA paths after you click **Test Connection** and surfaces a warning if free space is below the recommended minimum. The runtime check (Server Settings → Maintenance) then watches the actual `SHOW data_directory` value across all volumes.

---

## Upgrading Node on an existing install

**The in-app updater cannot do this, by design.** It runs as the unprivileged
`polaris` user, whose only root grant is the nginx apply wrapper
(`deploy/sudoers.d/polaris-nginx`) — installing a system package is not something
the web application is allowed to do, and giving it that power to save a
once-every-two-years operation would be a poor trade. Node upgrades are an
operator (or configuration-management) task.

Order matters. Native modules are compiled against the Node headers present at
install time, so **`node_modules` must be rebuilt after the runtime changes** —
and `npm ci` deletes `node_modules` before it installs, so the service must be
down for the whole window rather than restarted at the end.

### The scripted path

`deploy/upgrade-node.sh` performs the whole sequence with preflight checks, a
pre-migration `pg_dump`, and a fail-safe: if `npm ci` fails it leaves the service
stopped rather than starting a host with no dependencies.

```bash
cd /opt/polaris

# See exactly what it would do; changes nothing.
sudo bash deploy/upgrade-node.sh --dry-run

# Do it.
sudo bash deploy/upgrade-node.sh
```

Useful flags: `--target 22` (Node 22 LTS instead of 24), `--skip-backup` (no
`pg_dump` first), `--pull` (fast-forward the checkout before rebuilding).
`POLARIS_APP_DIR` and `POLARIS_APP_USER` override the `/opt/polaris` + `polaris`
defaults, and `POLARIS_UPGRADE_BACKUP_DIR` moves the `pg_dump` off `/var/tmp`.
All three are read from the invoking environment, not from `.env` — they are
script arguments, not Polaris runtime settings.

The script is idempotent: on a host that already meets the floor with a current
build it reports that and exits without stopping anything.

### The manual path

Equivalent to the above, if you would rather run each step yourself:

```bash
# 1. Stop Polaris (all roles).
sudo systemctl stop polaris.target

# 2. Replace the runtime. RHEL 9 AppStream carries a nodejs:24 stream; the reset
#    is required because a host pinned to nodejs:20 refuses a second stream.
sudo dnf module reset nodejs -y
sudo dnf module enable nodejs:24 -y
sudo dnf install -y nodejs
node -v        # expect v24.x

#    Ubuntu/Debian instead:
#    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
#    sudo apt install -y nodejs

# 3. Rebuild dependencies against the new ABI, then rebuild the app.
cd /opt/polaris
sudo -u polaris npm ci --include=dev
sudo -u polaris npm run build

# 4. Start, then confirm.
sudo systemctl start polaris.target
systemctl status 'polaris-*' --no-pager
journalctl -u polaris-web -n 50 --no-pager
```

Two things to check afterwards. `npm ci` should no longer print `EBADENGINE`
warnings for `pg-boss` or `@prisma/streams-local` — those warnings were the
symptom of running below the floor. And if the install uses pg-boss queue mode,
confirm it still comes up (Server Settings → Maintenance → Database → *Monitor
queue*), since pg-boss was the package demanding `>=22.12` in the first place.

If step 3 fails, **do not start the service** — `npm ci` will have left
`node_modules` empty and the process cannot boot. Fix the install error and re-run
step 3; nothing else in the sequence needs repeating.

---

## RHEL / Rocky / AlmaLinux 9

> **Note:** This walkthrough installs PostgreSQL from PGDG (the official PostgreSQL Global Development Group repo), not the RHEL AppStream module. PGDG matches upstream within days, supports the full Postgres extension ecosystem (TimescaleDB, PostGIS, etc.), and supports side-by-side major versions. AppStream's module ships a curated subset and lags upstream; in particular, **the TimescaleDB package targets PGDG only** — the AppStream `postgresql:15` module's package names (`postgresql-server`) don't satisfy `timescaledb-2-postgresql-15`'s requirement on `postgresql15-server`. If you have an existing AppStream install you want to migrate from, see *Migrating from AppStream to PGDG* below.

### 1. PostgreSQL (PGDG)

```bash
# Install the PGDG repo
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm

# Disable RHEL's AppStream postgresql module so PGDG's packages aren't shadowed
sudo dnf -qy module disable postgresql

# Install Postgres 15 + contrib (needed for various Polaris features)
sudo dnf install -y postgresql15 postgresql15-server postgresql15-contrib

# Initialize PGDATA and start the service
sudo /usr/pgsql-15/bin/postgresql-15-setup initdb
sudo systemctl enable --now postgresql-15
```

PGDATA lands at `/var/lib/pgsql/15/data`. Verify the disk holding `/var/lib/pgsql` has at least 50 GB free:

```bash
df -h /var/lib/pgsql
```

If `/var` is on its own LV (the typical STIG-hardened layout) and has less than 50 GB, **stop here and grow it** before continuing. See *Growing /var on RHEL* below.

### 2. Database + user

```bash
sudo -u postgres psql <<'SQL'
CREATE USER polaris WITH PASSWORD 'change-me';
CREATE DATABASE polaris OWNER polaris;
GRANT pg_read_all_settings TO polaris;

-- pg-boss (queue runtime for monitor cadences at scale) lives in its
-- own `pgboss` schema. The polaris role needs to own it so pg-boss can
-- create its tables on first boot. Pre-creating with the right owner
-- here prevents the schema from being created later by a different role
-- (which would lock polaris out and force a fallback to cursor mode).
\c polaris
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO polaris;
GRANT ALL ON SCHEMA pgboss TO polaris;
GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO polaris;
SQL
```

The `pg_read_all_settings` grant lets Polaris read `SHOW data_directory` so the Maintenance tab can measure the `/var` filesystem and alert before it fills.

The `pgboss` schema grants are required for pg-boss queue mode (operators with thousands of monitored assets). Without them, "permission denied for schema pgboss" appears in `journalctl -u polaris` and Polaris falls back to in-process cursor mode — fine for small/medium fleets, won't keep up at thousands. The scripted installs (`deploy/setup-rhel.sh`, `deploy/setup-ubuntu.sh`) run these grants for you; manual or remote-DB installs need to run them once. **Remote/managed PostgreSQL (RDS, Cloud SQL, Neon, etc.):** hand the `\c polaris ... ALTER DEFAULT PRIVILEGES ...` block to your DBA to run on the polaris database.

Allow the postgres directory to be traversed by the polaris OS user (needed for the same disk-space check — `statfs` on `/var/lib/pgsql/15/data` requires search permission on every ancestor directory). The PostgreSQL startup scripts reset these directories to `700` on every restart, so persist via a systemd override rather than a one-off chmod:

```bash
sudo systemctl edit postgresql-15
```

Add the following and save:

```ini
[Service]
ExecStartPost=/bin/chmod o+x /var/lib/pgsql
ExecStartPost=/bin/chmod o+x /var/lib/pgsql/15
```

Then reload and apply immediately:

```bash
sudo systemctl daemon-reload
sudo chmod o+x /var/lib/pgsql /var/lib/pgsql/15
```

Edit `/var/lib/pgsql/15/data/pg_hba.conf` and add a line for the polaris user (typically `host polaris polaris 127.0.0.1/32 scram-sha-256`), then `sudo systemctl reload postgresql-15`.

### 3. Node.js 24 (LTS)

```bash
sudo dnf module reset nodejs -y
sudo dnf module enable nodejs:24 -y
sudo dnf install -y nodejs
```

Node **22.12 is the hard floor** — `pg-boss` declares `>=22.12.0` and
`@prisma/streams-local` declares `>=22`. Node 20 reached end-of-life in April 2026
and is below that floor; installs still on it should follow *Upgrading Node on an
existing install* below. Node 22 is also supported (to ~April 2027) if you are
already on it.

### 4. Polaris

```bash
# Polaris install lives at /opt/polaris by convention
sudo mkdir -p /opt/polaris
sudo chown polaris:polaris /opt/polaris
# … extract release tarball into /opt/polaris …

cd /opt/polaris
npm ci --omit=dev
```

### 5. Run the install script

Since Phase 3, fresh installs land the split-role systemd layout
(`polaris.target` + `polaris-web` + `polaris-monitor@1..@N` + `polaris-discovery`
+ `polaris-migrate`) + nginx-fronted HTTPS in one command. The legacy
single-process `polaris.service` is no longer shipped.

```bash
sudo bash deploy/setup-rhel.sh --public-url https://polaris.example.com
```

What the script does, in order: installs Node + Postgres + Go + nginx
(mainline from nginx.org for HTTP/3 ≥ 1.25), creates the `polaris` system
user + DB + role, clones the repo, builds, runs migrations, generates a
self-signed cert for the supplied hostname under `/etc/polaris-nginx/`,
installs the split-role systemd units + a `Wants=nginx` drop-in on
`polaris-web`, sets `POLARIS_PROXY_CERT_PATH` + `POLARIS_PUBLIC_URL` in
`.env`, opens TCP+UDP/443 in firewalld, and starts `polaris.target` (which
brings up nginx first via the drop-in, then `polaris-web` in HTTP-only
proxy mode on `127.0.0.1:3000`).

Options:
- `--public-url <https://hostname>` — REQUIRED (well, defaulted to
  `https://$(hostname -f)` if you skip it). The cert + nginx `server_name`
  use whatever hostname is in this URL.
- `--monitor-replicas N` — number of `polaris-monitor@N` instances to
  enable. Default 2.
- `--prometheus-ip <IP>` — the IP the nginx `/metrics-*` locations allow.
  Default `127.0.0.1`. Update later with a drop-in if Prometheus is
  off-host.

Browse to `https://<your-hostname>/` to run the first-run setup wizard.
Self-signed cert in use; replace `/etc/polaris-nginx/{cert,key}.pem` with
your real cert + `systemctl reload nginx` whenever you're ready.

### Growing `/var` on RHEL

If the install template gave `/var` a small LV (8 GB is common), grow it before continuing:

```bash
# Check current sizing + free LVM space
vgs vg1
pvs
lsblk

# If `vgs` shows VFree near zero AND `lsblk` shows free space at the
# end of /dev/sda, grow the partition first
sudo parted -s /dev/sda resizepart 3 100%
sudo partprobe /dev/sda
sudo pvresize /dev/sda3

# Now grow /var (XFS or ext4 — the -r flag handles both)
sudo lvextend -r -L +20G /dev/vg1/var
df -h /var
```

If you can't grow `/var`, the alternative is to relocate PGDATA to `/opt` (which usually has ample space): stop postgres, `rsync -aHAX /var/lib/pgsql/15/ /opt/pgsql/`, set `Environment=PGDATA=/opt/pgsql/data` via a systemd drop-in, fix SELinux contexts with `sudo semanage fcontext -a -e /var/lib/pgsql /opt/pgsql && sudo restorecon -R /opt/pgsql`, then daemon-reload and start postgres.

### Migrating from AppStream Postgres to PGDG

If you already have a working Polaris install on AppStream Postgres and want to switch to PGDG (typically because you want TimescaleDB), the migration is a dump → install PGDG → restore cycle. Plan ~15-30 min of downtime; the dump itself is the bottleneck and scales with your fleet's data volume.

> **Check which major you are actually on first — `psql --version`.** RHEL 9's AppStream
> `postgresql` module sets no default stream, so its non-modular default is **PostgreSQL 13**.
> Installs made by `deploy/setup-rhel.sh` before 2026-09-09 took that path and are on 13, not
> 15 — below the minimum in *Supported platform versions*, and one reason to do this migration
> rather than leave it. The dump → restore below handles 13 → 15 fine (forwards is supported;
> the reverse is not), so nothing extra is needed, but know what you are starting from.

```bash
# 1. Dump the existing database (run as postgres OS user — peer auth)
sudo systemctl stop polaris
sudo -u postgres pg_dump polaris --clean --if-exists --no-owner --no-acl > /tmp/polaris.sql
sudo systemctl stop postgresql

# 2. Install PGDG, disable the AppStream module
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql15 postgresql15-server postgresql15-contrib
sudo /usr/pgsql-15/bin/postgresql-15-setup initdb

# 3. Verify pg_hba.conf uses scram-sha-256 (default on PGDG; check anyway)
sudo grep -E '^(local|host)' /var/lib/pgsql/15/data/pg_hba.conf | head -5
# If you see ident/md5 on the 127.0.0.1 lines, edit to scram-sha-256

# 4. Apply the chmod-traversable override (see step 2 above) BEFORE starting,
#    then start the new instance
sudo systemctl edit postgresql-15  # add the [Service] block from above
sudo systemctl daemon-reload
sudo chmod o+x /var/lib/pgsql /var/lib/pgsql/15
sudo systemctl disable postgresql
sudo systemctl enable --now postgresql-15

# 5. Recreate the polaris role + database
PWORD=$(sudo grep -oP 'polaris:\K[^@]+' /opt/polaris/.env)
sudo -u postgres psql <<EOF
CREATE USER polaris WITH PASSWORD '$PWORD';
CREATE DATABASE polaris OWNER polaris;
GRANT pg_read_all_settings TO polaris;
EOF

# 6. Restore the dump (as postgres, since the dump used --no-owner)
sudo -u postgres psql -d polaris < /tmp/polaris.sql

# 7. Reassign ownership of all polaris-database objects to the polaris role
#    (--no-owner restored everything as postgres; polaris needs ownership
#    to ALTER its tables, including the create_hypertable conversion that
#    runs at Polaris boot once TimescaleDB is installed)
sudo -u postgres psql -d polaris <<'SQL'
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO polaris', r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public' LOOP
    EXECUTE format('ALTER SEQUENCE public.%I OWNER TO polaris', r.sequence_name);
  END LOOP;
  FOR r IN SELECT viewname FROM pg_views WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER VIEW public.%I OWNER TO polaris', r.viewname);
  END LOOP;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO polaris;
SQL

# 8. Re-run the install script — it'll re-stage the split-role units against
#    postgresql-15.service and bring polaris.target back up against the
#    migrated DB.
sudo bash deploy/setup-rhel.sh --public-url https://polaris.example.com

# 9. Optionally remove the abandoned AppStream PGDATA
sudo test -f /var/lib/pgsql/data/PG_VERSION && echo "OLD DATA STILL EXISTS — DO NOT DELETE" || sudo rm -rf /var/lib/pgsql/data

# 10. Start Polaris and watch the boot
sudo systemctl start polaris
sudo journalctl -u polaris -f --no-pager
```

After step 10 succeeds, follow *Recommended: TimescaleDB* below to install the extension. On the first restart afterward, Polaris detects the extension and converts the twenty-eight monitoring sample tables to hypertables — eight source tables, sixteen `*_hourly` / `*_daily` rollup tables produced by the tiered-retention rollup job, and four detail-only standalone tables (~5-15 min for a fleet that's been running for weeks; no operator action required, just patience as conversions log in the journal).

### Recovery: postgres crashes on a full /var

If `/var` filled and postgres is now crash-looping with `PANIC: could not write to file "pg_wal/xlogtemp.NNNN": No space left on device`, **don't touch pg_wal/ manually** — that corrupts the database. Recovery only needs ~50 MB free to complete:

```bash
# Free space safely first
sudo rm /var/lib/pgsql/15/data/log/postgresql-Wed.log    # rotator overwrites next week
sudo dnf clean all
sudo journalctl --vacuum-size=50M

# Then start postgres
sudo systemctl start postgresql-15
```

Watch for `database system is ready to accept connections`. Once recovery completes, `pg_wal` segments get recycled and free a few hundred MB. Then start polaris.

---

## Ubuntu / Debian

### 1. PostgreSQL

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

PGDATA on Ubuntu is **`/var/lib/postgresql/<version>/main`** — note the version-suffix. The systemd unit name is also versioned (e.g. `postgresql@15-main.service`). Verify free space:

```bash
df -h /var/lib/postgresql
```

### 2. Database + user

```bash
sudo -u postgres psql <<'SQL'
CREATE USER polaris WITH PASSWORD 'change-me';
CREATE DATABASE polaris OWNER polaris;
GRANT pg_read_all_settings TO polaris;

-- pg-boss (queue runtime for monitor cadences at scale) lives in its
-- own `pgboss` schema. The polaris role needs to own it so pg-boss can
-- create its tables on first boot. Pre-creating with the right owner
-- here prevents the schema from being created later by a different role
-- (which would lock polaris out and force a fallback to cursor mode).
\c polaris
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO polaris;
GRANT ALL ON SCHEMA pgboss TO polaris;
GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO polaris;
SQL
```

The `pg_read_all_settings` grant lets Polaris read `SHOW data_directory` so the Maintenance tab can measure the `/var` filesystem and alert before it fills.

The `pgboss` schema grants are required for pg-boss queue mode (operators with thousands of monitored assets). Without them, "permission denied for schema pgboss" appears in `journalctl -u polaris` and Polaris falls back to in-process cursor mode — fine for small/medium fleets, won't keep up at thousands. The scripted installs (`deploy/setup-rhel.sh`, `deploy/setup-ubuntu.sh`) run these grants for you; manual or remote-DB installs need to run them once. **Remote/managed PostgreSQL (RDS, Cloud SQL, Neon, etc.):** hand the `\c polaris ... ALTER DEFAULT PRIVILEGES ...` block to your DBA to run on the polaris database.

Allow the postgres directory to be traversed by the polaris OS user. Persist it via a systemd override so it survives PostgreSQL restarts (replace `<version>` with your installed version, e.g. `15`):

```bash
sudo systemctl edit postgresql@<version>-main
```

Add the following and save:

```ini
[Service]
ExecStartPost=/bin/chmod o+x /var/lib/postgresql
```

Then reload and apply immediately:

```bash
sudo systemctl daemon-reload
sudo chmod o+x /var/lib/postgresql
```

Edit `/etc/postgresql/<version>/main/pg_hba.conf` to add the polaris user, then `sudo systemctl reload postgresql`.

### 3. Node.js 24 (LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
```

Node **22.12 is the hard floor** (`pg-boss` requires `>=22.12.0`). Node 20 is
end-of-life as of April 2026 — see *Upgrading Node on an existing install* below.

### 4. Polaris

Same as RHEL — install to `/opt/polaris`, run `npm ci --omit=dev`.

### 5. Run the install script

Since Phase 3, the Ubuntu/Debian install script lands the split-role
systemd layout + nginx-fronted HTTPS in one command (same as RHEL):

```bash
sudo bash deploy/setup-ubuntu.sh --public-url https://polaris.example.com
```

The script installs nginx mainline from nginx.org's Debian/Ubuntu repo
(distro nginx is too old for HTTP/3), generates a self-signed cert, drops
the split-role units (rewritten to depend on Ubuntu/Debian's
`postgresql.service` meta-service instead of RHEL's `postgresql-15.service`),
opens TCP+UDP/443 in ufw, and starts `polaris.target`. Browse to
`https://<your-hostname>/` to run the first-run setup wizard.

The same `--public-url` / `--monitor-replicas` / `--prometheus-ip` flags
documented above for setup-rhel.sh apply here too.

---

## Windows Server

### 1. PostgreSQL

Download the EnterpriseDB installer from <https://www.postgresql.org/download/windows/> and run it. Default install path is `C:\Program Files\PostgreSQL\<version>\` with PGDATA at `C:\Program Files\PostgreSQL\<version>\data`.

The installer registers PostgreSQL as a Windows service. Verify free space on the drive holding PGDATA (usually `C:`):

```powershell
Get-PSDrive -Name C
```

If `C:` has less than 50 GB free, **install PGDATA on a different drive** during the EnterpriseDB installer flow (the installer prompts for the data directory location). Don't try to expand `C:` after the fact.

### 2. Database + user

```powershell
# Replace <version> with your installed major version (15 or newer)
& "C:\Program Files\PostgreSQL\<version>\bin\psql.exe" -U postgres
```

```sql
CREATE USER polaris WITH PASSWORD 'change-me';
CREATE DATABASE polaris OWNER polaris;
\c polaris
CREATE SCHEMA IF NOT EXISTS pgboss;
ALTER SCHEMA pgboss OWNER TO polaris;
GRANT ALL ON SCHEMA pgboss TO polaris;
GRANT ALL ON ALL TABLES    IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO polaris;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA pgboss TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES    TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO polaris;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON FUNCTIONS TO polaris;
\q
```

Edit `pg_hba.conf` (in the data directory) to add a line for the polaris user, then restart the PostgreSQL service from `services.msc`.

The `pgboss` schema grants are required for pg-boss queue mode (operators with thousands of monitored assets). Without them Polaris falls back to in-process cursor mode — fine for small/medium fleets, won't keep up at thousands.

### 3. Node.js 24 (LTS)

Download the **24.x LTS** installer from <https://nodejs.org/> and run it. Node
**22.12 is the hard floor** (`pg-boss` requires `>=22.12.0`); Node 20 is
end-of-life as of April 2026.

### 4. Polaris

Extract the release zip to a directory of your choice (e.g. `C:\Polaris`). From an admin PowerShell:

```powershell
cd C:\Polaris
npm ci --omit=dev
```

### 5. NSSM service wrapper

Polaris on Windows runs under [NSSM](https://nssm.cc/) (Non-Sucking Service Manager). Download nssm.exe and register the service:

```powershell
nssm install Polaris "C:\Program Files\nodejs\node.exe" "C:\Polaris\dist\index.js"
nssm set Polaris AppDirectory "C:\Polaris"
nssm set Polaris DependOnService postgresql-x64-<version>
nssm set Polaris Start SERVICE_AUTO_START
nssm start Polaris
```

`DependOnService` is the Windows equivalent of systemd's `Requires=` — Polaris won't try to start until PostgreSQL is up. Adjust the version suffix to match your install (`postgresql-x64-15` etc.).

Browse to `http://<host>:3000` to run the setup wizard.

> **The wizard is unauthenticated, by construction** — it exists to create the
> first account, so there is nobody to authenticate yet. Until you finish it,
> whoever reaches that port first chooses the admin password, the database and
> the secrets. On a server reachable by anyone but you, set
> `POLARIS_SETUP_BIND=127.0.0.1` in the environment before the first start and
> complete the wizard over an RDP session or an SSH tunnel
> (`ssh -L 3000:127.0.0.1:3000 you@host`); the boot banner states which
> interface it bound to. Unset, it binds all interfaces — the default, because
> a container can only reach the wizard through a published port. Once
> `DATABASE_URL` is set the wizard never runs again and the variable is inert.

Windows runs single-process (`POLARIS_ROLE` unset = `all`), so the Dash
wallboard listener boots in-process and serves `http://<host>:3001/dash`
once enabled under Server Settings → Web Server → Dash Wallboard (no
separate service; open TCP/3001 in Windows Firewall if wallboard viewers
are remote).

---

## Optional: fping (ICMP batching)

Polaris uses `fping` for two things, and does both without it:

1. **The packet-loss sweep** — a short burst of ICMP echoes to every monitored
   asset each cycle, counting what comes back.
2. **The ICMP status probe** — the poll that decides whether a device is down,
   for assets whose Response Time method is ICMP.

Both work on any install with no configuration. `fping` only changes **how**
they are sent: one process per batch instead of one process per host.

| | With fping | Without it |
|---|---|---|
| Loss sweep, 2000 assets | ~4 spawns | ~2000 spawns |
| ICMP status probe, 2000 assets | one per distinct timeout (usually 2-3) | one per host |
| Sustainable sweep cadence | 60s at any fleet size | widens with the fleet |
| Loss figures and up/down verdicts | identical | identical |

The fallback is **correct, not degraded** — the numbers and the verdicts are the
same, and the status probe still sends exactly one echo per asset per cycle
either way, so down detection is unaffected. It simply
forks per host, so on a large fleet Polaris widens the sweep interval to
whatever the host can actually finish (`resolveSweepIntervalSec`) rather than
publishing sweeps faster than they drain. You get loss on a 2–3 minute cadence
instead of 60s. Nothing breaks and nothing needs configuring either way.

The setup scripts install it best-effort and never fail on it. To add it later:

```bash
# RHEL / Rocky / AlmaLinux 9 — fping lives in EPEL
sudo dnf install -y epel-release
sudo dnf install -y fping

# Ubuntu / Debian — in the standard archive
sudo apt install -y fping
```

**If your estate cannot publish EPEL**, raise the sweep interval instead of
chasing the package. `POLARIS_LOSS_SWEEP_INTERVAL_SEC=300` cuts the sweep's
process count fivefold, and the reading itself is unchanged — the ratio still
sums packets over each automation's own History window, so only how quickly it
reacts moves. fping is not in RHEL BaseOS or AppStream, so on a Satellite-managed
host with no EPEL content view this is the practical answer rather than a
workaround.

**Windows Server has no fping build**, so those installs always use the per-host
fallback. It is slower there than on Linux for a reason worth knowing: Windows
`ping` paces at a fixed ~1s per echo and has no interval flag, where POSIX
`ping -i 0.2` completes the same burst in ~0.8s. A 2000-asset Windows install
therefore lands nearer a 2–3 minute loss cadence. Response-time polling and down
detection are unaffected — they are a different measurement on a different
clock (business rule 30).

**Permissions.** The packaged binary ships with the `cap_net_raw` file
capability, so the unprivileged `polaris` service user runs it with no sudo
wiring and no setuid. If you build fping yourself, grant it that capability or
the sweep silently falls back to per-host pings:

```bash
sudo setcap cap_net_raw+ep "$(command -v fping)"
getcap "$(command -v fping)"      # → /usr/sbin/fping cap_net_raw=ep
```

**Verifying which backend is live.** Polaris probes for fping once per process
at startup and caches the answer. When it runs fping but cannot parse the
output — an old build, a refused capability — it logs
`fping produced no parseable summaries — falling back to per-host ping for this
chunk` and keeps measuring. A quiet log means the batched path is working.

---

## The split-role deployment (web / monitor / discovery)

Since Phase 3 this is the **default and only supported production layout**
on Linux. `deploy/setup-rhel.sh` and `deploy/setup-ubuntu.sh` install it
automatically; the legacy single-process `polaris.service` unit is no
longer shipped. This section documents what the install scripts actually
do, for operators who want to understand the layout or customize it
post-install.

Polaris's workload splits across processes so discovery's CPU/DB-heavy
phases can't starve the monitor workers (they don't share one Node event
loop). The split coordinates through the **pg-boss queue** (enabled at
boot via `Setting.monitor.queueMode = "pgboss"`).

The roles (chosen per-process via `POLARIS_ROLE`):

- **web** — HTTP-only on `127.0.0.1:3000` (nginx terminates TLS) + all singleton schedulers + one-shot migrations. Single instance (control plane). Owns the in-app updater.
- **monitor** — pg-boss monitor-queue consumers. Run **N replicas**; pg-boss gives each job to exactly one worker.
- **discovery** — pg-boss discovery-queue consumer.
- **dash** — the Dash wallboard listener on `127.0.0.1:3001` (`POLARIS_DASH_PORT`):
  an **unauthenticated, read-only** duplicate of the Dashboard at
  `https://<host>/dash` for NOC wallboards/kiosks, isolated in its own process
  so a bug in the unauthenticated surface can't touch sessions or write paths.
  The surface ships **disabled** — an admin enables it (and picks the
  source-IP scope: RFC1918 + loopback only, all IPs, or a custom IPv4-CIDR
  allow-list) under Server Settings → Web Server → Dash Wallboard; changes
  reach the dash process within ~10s. Requests from disallowed source IPs are
  **silently dropped** (the connection is reset, no response). It answers with
  the built-in `readonly` role's permissions; each viewer's widget layout is
  saved in their own browser (localStorage). nginx's `/dash` location proxies
  to it unconditionally, so keep the unit running even while the surface is
  disabled (disabled = the process answers 403).
- **migrate** — oneshot `prisma migrate deploy` at boot; the app services gate on its completion.

The `all` role still exists in `src/utils/role.ts` (one process runs every
capability) and is the default when `POLARIS_ROLE` is unset — that's what
`npm run dev` uses. **Production never ships `all` mode**: no `polaris.service`
unit is shipped, no `--without-split` flag exists on the setup scripts.

### systemd (RHEL/Ubuntu)

`deploy/setup-rhel.sh` + `deploy/setup-ubuntu.sh` install the units below
automatically. This is the manual equivalent for operators who want to
re-deploy from a fresh checkout:

```bash
# Copy the role units + the migrate one-shot + the grouping target.
sudo cp deploy/polaris-migrate.service deploy/polaris-web.service \
        deploy/polaris-monitor@.service deploy/polaris-discovery.service \
        deploy/polaris-dash.service \
        deploy/polaris.target /etc/systemd/system/

# Ubuntu/Debian: rewrite postgresql-15.service → postgresql.service
# (the meta-service that resolves to the version-specific cluster unit).
# RHEL/Rocky/Alma: leave as-is.
# sudo sed -i 's/postgresql-15\.service/postgresql.service/g' /etc/systemd/system/polaris-*.service

sudo systemctl daemon-reload

# Enable the group + the monitor replicas you want (here: 2).
sudo systemctl enable polaris-monitor@1 polaris-monitor@2
sudo systemctl enable polaris-web polaris-discovery polaris-dash polaris-migrate
sudo systemctl enable --now polaris.target     # "Start Everything"
```

`systemctl start polaris.target` brings up migrate → web → monitor@1..N →
discovery; `systemctl stop polaris.target` stops the group.

### Upgrading a legacy single-process install

Installs provisioned before the Phase 3 cutover ran a single
`polaris.service` unit (one process, every subsystem). Those are no longer
shipped, so the one-time move to the split-role layout is operator-driven:

1. **Take the in-app update first** (Server Settings → Maintenance → Updates),
   or pull the new code manually. The in-app updater syncs the shipped
   `deploy/polaris-*.service` + `polaris.target` files into
   `/etc/systemd/system/` and runs `daemon-reload` on every restart — but it
   restarts `polaris.target`, which a legacy install hasn't enabled yet, so
   the unit files land but the group isn't brought up automatically.
2. **Stop and disable the old unit**, then enable the new role units +
   target (mirrors the manual systemd block above):

   ```bash
   sudo systemctl disable --now polaris.service
   sudo systemctl enable polaris-web polaris-discovery polaris-dash polaris-migrate
   sudo systemctl enable polaris-monitor@1 polaris-monitor@2
   sudo systemctl enable --now polaris.target
   ```

3. **Set `POLARIS_MONITOR_REPLICAS`** in `/opt/polaris/.env` to match the
   number of `polaris-monitor@N` instances you enabled, so the Capacity
   Advisor sizes pools + `max_connections` correctly (the web role warns at
   boot when it's unset in split-role mode), then `sudo systemctl restart
   polaris.target`.
4. **Then move to nginx** (TLS termination) with
   `deploy/migrate-to-nginx.sh` — see the [nginx front-end](#nginx-front-end-tls-termination)
   section below. That script requires the split-role layout to already be
   enabled, which steps 1–3 establish.

Once on the split-role + nginx layout, all future updates flow through the
in-app updater with no further manual unit work — it keeps the unit files and
nginx config in sync on every restart.

**Per-role `/metrics` listeners.** prom-client registries are per-process. The
web role serves `/metrics` on the main HTTPS port; monitor and discovery boot a
standalone `/metrics` listener via `src/utils/metricsServer.ts` on
`POLARIS_METRICS_PORT`. The shipped units default to:

| Role | Default port (bind 127.0.0.1) |
|---|---|
| `polaris-monitor@N` | `910N` (instance `1` → 9101, `2` → 9102, … `9` → 9109) |
| `polaris-discovery` | `9110` |

Prometheus must scrape **every** endpoint or any panel that depends on metrics
stamped from inside a monitor worker (`polaris_probe_*`, `polaris_monitor_work_duration_seconds`,
`polaris_sample_write_duration_seconds`) or discovery consumer
(`polaris_discovery_*`, FMG proxy lane) will silently show "no data" on the
Grafana dashboard. See [docs/grafana/README.md](grafana/README.md#multi-process-split-role-deployments)
for the matching scrape job. Override with a systemd drop-in if you run more
than 9 monitor replicas or need to reach Prometheus from a different host
(`POLARIS_METRICS_BIND=0.0.0.0`).

**Updater group-restart grant.** The in-app updater (Server Settings →
Maintenance) restarts the whole group via `systemd-run … systemctl restart
polaris.target`, which needs a polkit grant for the `polaris` user.
`deploy/setup-rhel.sh` and `deploy/ha/setup-rhel-ha.sh` install it from
`deploy/polkit/49-polaris.rules`; an install that predates that gets it on the
next run of either script, or you can drop the file in by hand. Without the
grant the updater silently falls back to restarting only the web process, so
the monitor and discovery roles keep running the previous release against the
freshly migrated schema. What it grants (`/etc/polkit-1/rules.d/49-polaris.rules`):

```javascript
polkit.addRule(function(action, subject) {
  if (action.id == "org.freedesktop.systemd1.manage-units" &&
      subject.user == "polaris") {
    return polkit.Result.YES;
  }
});
```

**Auto-sync of unit files.** Before restarting `polaris.target` the updater
also syncs `/opt/polaris/deploy/polaris-*.service` and `polaris.target` into
`/etc/systemd/system/`, then runs `systemctl daemon-reload`. Files are
overwritten only when their content differs from what's currently installed,
so this is a no-op on updates that don't touch unit files. **Customize via
drop-ins, not direct edits**: put per-host changes in
`/etc/systemd/system/polaris-monitor@.service.d/local.conf` (or the matching
unit's `.d/` directory) so they survive every update. The transient unit
that runs the sync runs as root via the polkit grant above; no extra sudo /
NOPASSWD entry is required.

### Windows (NSSM)

Register one service per role with the same `AppDirectory`, role via
`AppEnvironmentExtra`, and a migrate step before the app services start
(`npx --no-install prisma migrate deploy`). NSSM's `DependOnService` only orders
start, it doesn't wait for a one-shot to finish — run migrate as a script step,
not a service. Example:

```powershell
nssm install PolarisWeb       "C:\Program Files\nodejs\node.exe" "dist\index.js"
nssm set     PolarisWeb       AppEnvironmentExtra "NODE_ENV=production" "POLARIS_ROLE=web"
nssm install PolarisMonitor1  "C:\Program Files\nodejs\node.exe" "dist\index.js"
nssm set     PolarisMonitor1  AppEnvironmentExtra "NODE_ENV=production" "POLARIS_ROLE=monitor" "POLARIS_METRICS_PORT=9101"
nssm install PolarisDiscovery "C:\Program Files\nodejs\node.exe" "dist\index.js"
nssm set     PolarisDiscovery AppEnvironmentExtra "NODE_ENV=production" "POLARIS_ROLE=discovery" "POLARIS_METRICS_PORT=9110"
```

Add `POLARIS_METRICS_PORT` to each non-web role so Prometheus can scrape its
in-process metrics; see the systemd section above for the role → port mapping
and [docs/grafana/README.md](grafana/README.md#multi-process-split-role-deployments)
for the scrape job.

### Docker

Use the shipped `docker-compose.yml` — one image, per-service `POLARIS_ROLE`, a
one-shot `migrate` service the app services gate on
(`service_completed_successfully`), and `monitor` with `deploy.replicas`.

**Secrets are not auto-generated for the compose stack.** The `deploy/setup-*`
scripts and the first-run wizard mint `SESSION_SECRET` and `POLARIS_SECRET_KEY`
for you, but neither runs here: this stack supplies `DATABASE_URL` up front, and
a set `DATABASE_URL` is exactly what tells Polaris to boot normally instead of
starting the wizard. (A single-container deployment that *does* let the wizard
run — the Unraid path in the README — gets both values written into
`/app/state/.env` for free.) For compose, write them into `./state/.env` before
the first `compose up`:

```bash
mkdir -p ./state
{
  echo "DATABASE_URL=postgresql://polaris:<password>@<host>:5432/polaris"
  echo "SESSION_SECRET=$(openssl rand -base64 32)"
  echo "POLARIS_SECRET_KEY=$(openssl rand -hex 32)"
} >> ./state/.env
chmod 600 ./state/.env
```

`POLARIS_SECRET_KEY` encrypts the credentials Polaris uses to reach your
infrastructure — see [Secrets at rest](#secrets-at-rest) for the full list and
for what to do if you skipped it and the values are already in the clear.

**The container runs Polaris as the unprivileged `node` user (uid 1000), and
takes ownership of the state directory to do it.** `./state` is a bind mount, so
its ownership comes from your host directory rather than from the image — on the
first start after upgrading to this image the entrypoint runs
`chown -R node:node` over it (announced in the container log) and then drops
privileges for everything else, including the migration. Two consequences worth
knowing:

- Files you place in `./state` before the first start — the `.env` above, an
  `internal-root.pem`, a mounted `codesign.pfx` — end up owned by uid 1000. That
  is correct and intended; `chmod 600 ./state/.env` still applies.
- Editing `./state/.env` afterwards from your host account needs `sudo` (or add
  yourself to a group with access), because the file is no longer owned by you.

The chown only runs when the directory is not already node-owned, so it is a
first-boot cost rather than a per-restart walk of your backups. `/app` itself
stays root-owned and read-only to the process.
Without it they are stored as **plaintext**, which means plaintext in every
`pg_dump` and in any snapshot of the database volume.

Two container-specific cautions:

- **`./state/.env` is on a bind mount, not in the image.** A `docker compose
  down -v` or a rebuilt host loses it. Back the key up somewhere else *before*
  you take the first backup — a dump you cannot decrypt is worth less than you
  think.
- **Prefer your orchestrator's secret store.** In Kubernetes or Swarm, deliver
  both values as secrets rather than a file on disk; in a managed deployment
  inject them from Azure Key Vault. Do not inline them into
  `docker-compose.yml` — it is committed, `./state/.env` is gitignored.

### Sizing — connections multiply

Each process opens its own Prisma + pg-boss pool, so the group needs roughly
`(monitor replicas + 2) × (DATABASE_POOL_SIZE + POLARIS_PGBOSS_POOL_SIZE)`
connections. Keep that under Postgres `max_connections` (minus headroom for
`pg_dump`, admin sessions). Lower the per-replica `DATABASE_POOL_SIZE` (10–15)
and `POLARIS_PGBOSS_POOL_SIZE` (~10) and set `POLARIS_MONITOR_REPLICAS` on the
web node so the Capacity Advisor sizes `max_connections` correctly. The
shipped setup scripts (`deploy/setup-{rhel,ubuntu}{,-nodb}.sh`) now persist
`POLARIS_MONITOR_REPLICAS` from `--monitor-replicas` into `/opt/polaris/.env`
automatically; if you later scale by `systemctl enable --now polaris-monitor@N`
or pre-fix installs are missing the var, update it by hand and restart
`polaris.target`. The web role logs a warning at boot when the var is unset
in split-role mode.
**PgBouncer** absorbs the Prisma pools (recommended for multi-monitor) but
pg-boss pools always connect to Postgres directly — budget those against the
raw `max_connections`. Per-role footprint is exposed at
`/metrics` as `polaris_db_pool_role_capacity{role}`.

---

## nginx front-end (TLS termination)

nginx terminates TLS for every Polaris install. Fresh installs land this
layout via the setup scripts; existing pre-nginx installs migrate via
`deploy/migrate-to-nginx.sh`. Polaris itself listens HTTP-only on
`127.0.0.1:3000` and exposes the cert nginx serves through the Identification
tab so Polaris Agents can pin against the same leaf nginx presents.

Why nginx fronts the app:

- One external URL for the main app **and** all the role-specific `/metrics`
  endpoints (path-routed: `/metrics`, `/metrics-monitor-1`, `/metrics-monitor-2`,
  `/metrics-discovery`) — no firewall changes per worker port, no
  bearer-in-clear on the worker ports.
- One place to manage cert rotation (a single file nginx reads, plus
  `systemctl reload nginx`).
- HTTP/3 over QUIC out-of-the-box for browser traffic.

### Migrating an existing install

Run `deploy/migrate-to-nginx.sh` on installs that were provisioned before the
nginx-front cutover. The script only supports the split-role layout
(`polaris.target` enabled with the four role units).

### Prerequisites

- The split-role layout (above) must be enabled.
- nginx ≥ 1.25 (HTTP/3 stable). The migration script installs from
  `nginx.org`'s mainline repo if your system nginx is older or missing.
- A working server cert + key already loaded in Polaris's `Setting.certificates`
  (the script extracts the active leaf pair from the DB and hands it to nginx).
- UDP/443 reachable from clients you want to serve HTTP/3 to. The script opens
  TCP+UDP/443 in `firewalld` on the local host; any upstream firewalls /
  load balancers also need UDP/443 open. Clients fall back to TCP transparently
  if UDP is blocked anywhere along the path.
- A decision on which IP is allowed to scrape `/metrics-*` (your Prometheus
  host). The script writes an `allow <PROMETHEUS_IP>; deny all;` block on
  those four nginx locations as the first defense layer; bearer auth via
  `METRICS_TOKEN` is the second layer.

### Migration

```bash
sudo bash /opt/polaris/deploy/migrate-to-nginx.sh \
  --public-url https://polaris.example.com \
  --prometheus-ip 10.0.0.42
```

The script is transactional — it backs up `/opt/polaris/.env` first, stages
nginx config + cert files in `/tmp/`, validates with `nginx -t` before
committing, and rolls back automatically on failure at any gate. It's also
idempotent: re-running detects the migrated state and exits cleanly.

What it does in order:

1. Confirms `polaris.target` is enabled.
2. Ensures nginx ≥ 1.25 is installed (replaces older RHEL AppStream nginx
   with `nginx.org`'s mainline if needed).
3. Extracts the active `category="server"` cert + key from
   `Setting.certificates` via Prisma and writes
   `/etc/polaris-nginx/{cert,key}.pem` with `0640 root:nginx` permissions
   and SELinux `httpd_sys_content_t` context (persistent via `semanage
   fcontext` + `restorecon`).
4. Installs `deploy/nginx/polaris.conf` into `/etc/nginx/conf.d/polaris.conf`
   with `<PROMETHEUS_IP>` substituted. Validates with `nginx -t`.
5. Installs a systemd drop-in at `/etc/systemd/system/polaris-web.service.d/`
   that makes polaris-web `Wants=` nginx — nginx starts first, but a failed
   nginx doesn't block polaris-web (so you can SSH in and fix nginx without
   a separate broken-Polaris problem).
6. Installs the in-app nginx GUI helpers:
   `/usr/local/sbin/polaris-nginx-apply` (the privileged wrapper for the
   Server Settings → Web Server GUI), `/etc/sudoers.d/polaris-nginx`
   (narrow NOPASSWD grant on the one binary), `/etc/tmpfiles.d/polaris-nginx.conf`
   (staging dir entry), and adds the `polaris` user to the `nginx` group
   so the existing fingerprint pane can read the `0640 root:nginx` cert
   file directly. Existing installs picking this up via in-app update get
   the same wiring through `restartService()`'s sync block.
7. Appends `POLARIS_PROXY_CERT_PATH` + `POLARIS_PUBLIC_URL` to `/opt/polaris/.env`.
8. Opens TCP+UDP/443 in `firewalld`.
9. `systemctl daemon-reload`, `systemctl enable --now nginx`,
   `systemctl reload nginx`, `systemctl restart polaris.target`.
10. Smoke tests: TCP + UDP listeners on 443, `Alt-Svc: h3` header, Polaris
    bound to `127.0.0.1:3000`, `/metrics-monitor-1` returns 200 or 401 (not 5xx).

### After migration: the in-app nginx GUI

Server Settings → Web Server now shows the in-app nginx GUI: the
**HTTPS Certificate** card (read-only metadata + a **Rotate certificate**
button), an **nginx Proxy** card with the six controls (HTTPS port, HTTP/3
toggle, TLS protocols, HSTS, Prometheus allow-list), the **Dash Wallboard**
card (enable toggle + source-IP scope for the unauthenticated read-only
`/dash` surface), the **Local Login Access** card (optional source-IP
restriction on the local login form and password endpoints — off by default;
SSO sign-in is never restricted), and the **Trusted Certificate Authorities**
card (unchanged).

> **Upgrade note (Dash wallboard release):** the shipped nginx config gained
> two `/dash` location blocks (5 → 7 locations). Installs in managed mode
> pick them up automatically on the next in-app update; installs that
> hand-edited the config will (correctly) see the drift banner and need to
> re-adopt managed mode for `/dash` to route. The wallboard itself stays
> dark either way until you enable it on the Dash Wallboard card.
> **Upgrade note (request-body limits):** the shipped nginx config gained a
> server-level `client_max_body_size 8m` plus one `location` that lifts the
> limit for the database-restore upload (7 → 8 locations). Before this, nginx
> enforced its 1 MB default on every request — **below** what Polaris's own
> handlers accept — so a branding logo over 1 MB and *any* database restore
> through the UI were rejected at the edge with a 413 whose HTML error page the
> browser surfaced as an `Unexpected token '<'` JSON error. Managed-mode
> installs pick this up on the next in-app update; installs that have **not**
> adopted managed mode do not — the in-app updater skips the render entirely in
> that case, so either adopt managed mode or add the two directives to
> `/etc/nginx/conf.d/polaris.conf` by hand. The manual `deploy/update-linux.sh`
> path syncs the shipped config regardless of managed mode, so it applies the
> change either way.
> **Upgrade note (API documentation page):** the shipped nginx config gained a
> `location = /api` block (8 → 9 locations) carrying an IP allow-list for the
> unauthenticated developer-docs page served at `/api`. Same managed-mode
> mechanics as above. The allow-list renders from the **API Documentation
> Access** card on Server Settings → API Tokens (loopback / RFC1918 /
> custom private subnets — public networks are refused), NOT from the nginx
> Proxy card, and it is defense in depth only: Polaris enforces the same
> source-IP scope itself, on every install type. Windows/NSSM installs, dev
> boxes, and the Docker stack have no managed nginx and rely on that app-level
> gate alone — which is the authoritative layer everywhere, so nothing extra
> is needed there.

A yellow drift banner reads "nginx config not Polaris-managed yet" until
you click **Adopt managed mode**. Until then the controls are read-only and
Polaris will not touch your nginx config on in-app updates. If you've
hand-edited `/etc/nginx/conf.d/polaris.conf` beyond the six controls (extra
location blocks, custom headers, custom timeouts), the banner lists what
it detected — adopting will overwrite those hand-edits on the next Apply.

Click **Adopt managed mode** to unlock. From there:

- **Save & Apply** stages a rendered config to `/run/polaris-nginx-stage/`,
  validates via `nginx -t`, atomic-renames into place, and `systemctl reload
  nginx`s. The wrapper rolls back to the most recent `.bak` if `nginx -t`
  fails.
- **Rotate certificate** orchestrates the dual-pin workflow: upload cert+key
  → stage the new pin on every active agent via `/agents/cert-pins/bulk-add`
  (so they accept both old + new) → swap the cert file + reload nginx →
  retire the old pin via `/agents/cert-pins/bulk-remove`. Zero-downtime if
  all agents are online during the staging step.

**Firewall reminder.** Changing the HTTPS port via the GUI requires you to
manually open `<new>/tcp` + `<new>/udp` in firewalld — Polaris will not
modify firewall rules from the UI (lockout footgun). The GUI banner after
Apply reminds you to do this.

### Verifying

```bash
ss -ltnp | grep ':443'       # nginx TCP listener
ss -lunp | grep ':443'       # nginx UDP listener (HTTP/3)
ss -ltnp | grep ':3000'      # Polaris bound to 127.0.0.1 only

curl -sI https://polaris.example.com/ | grep -i alt-svc
# expects: alt-svc: h3=":443"; ma=86400

METRICS_TOKEN=$(grep ^METRICS_TOKEN /opt/polaris/.env | cut -d= -f2-)
curl -sH "Authorization: Bearer $METRICS_TOKEN" https://polaris.example.com/metrics-monitor-1 \
  | grep -c '^polaris_monitor_work_total'
# expects a positive count
```

### Operational notes

- **Cert rotation requires the dual-pin window.** Existing agents pin the
  current leaf cert's SHA-256. Before rolling nginx's cert, stage the new
  leaf's fingerprint via Server Settings → Maintenance → "Cert pin rotation"
  → bulk-add. Once every agent has applied the staged pin (visible in the
  Agents tab), roll the cert in nginx, then bulk-remove the old pin.
- **Operator customization belongs in drop-ins, not the main config files.**
  The in-app updater (Server Settings → Maintenance → Apply Update) syncs
  `deploy/nginx/polaris.conf` into `/etc/nginx/conf.d/polaris.conf` on every
  update (cmp-only, no-op when unchanged) — direct edits there get clobbered.
  Use `/etc/nginx/conf.d/polaris-local.conf` or a per-server-block drop-in.
  Same convention for systemd: edit `<unit>.service.d/*.conf`, not the unit file itself.
- **HTTP/3 / QUIC may be blocked by corporate firewalls or IDS**. Clients
  transparently fall back to TCP/HTTP-2 in that case (worst case: no HTTP/3
  benefit, not a broken site). Confirm with network ops that UDP/443 isn't
  blocked between your operator workstations and the prod box.
- **The Polaris Agent stays on TCP/HTTP-2.** Go's stdlib `net/http` doesn't
  speak HTTP/3 — agent traffic (heartbeat, samples, enroll, config) uses
  the TCP listener, which carries the same cert and same auth. HTTP/3
  benefits only browser traffic.

---

## Recommended: TimescaleDB

Polaris's monitoring data lives in twenty-eight sample tables: eight source tables (`asset_monitor_samples`, `asset_telemetry_samples`, `asset_hardware_sensor_samples`, `asset_interface_samples`, `asset_storage_samples`, `asset_ipsec_tunnel_samples`, `asset_perf_sla_samples`, `asset_process_samples`) that hold raw per-cadence samples, sixteen `*_hourly` / `*_daily` rollup tables produced by the tiered-retention rollup job (one hourly + one daily companion per source), and four detail-only standalone tables with no rollups (`asset_custom_widget_samples`, `asset_state_samples`, `asset_process_log_samples`, `asset_service_log_samples`). All are append-only / upsert-only time-series. Plain Postgres handles them fine at small scale, but once the combined size crosses ~1 GB the daily retention prune starts seq-scanning hundreds of millions of rows, contending with normal write load. **TimescaleDB** (an official Postgres extension) converts all of them to hypertables with chunk-based partitioning and native compression:

- Daily prune becomes `DROP CHUNK` (instant, no seq-scan, no lock contention)
- Compressed chunks (default: anything older than 7 days) take ~10–30× less disk
- Read queries are unchanged — Polaris uses ordinary SQL, Timescale handles transparency

Polaris **detects the extension at boot**. If present, the boot-time migration converts all eighteen tables to hypertables on the next startup (source tables partitioned by `timestamp`; rollup tables by `bucketStart`) and adds the compression policy. If absent, Polaris stays on plain-Postgres prune and surfaces a `timescale_recommended` alert in the Maintenance tab once sample tables grow past 1 GB.

If you're standing up a new install on RHEL/Rocky/AlmaLinux 9, Ubuntu/Debian, or Docker, install Timescale **before** the first run so all sample tables become hypertables from the start with no conversion downtime.

### RHEL / Rocky / AlmaLinux 9

```bash
sudo tee /etc/yum.repos.d/timescale_timescaledb.repo <<'EOF'
[timescale_timescaledb]
name=timescale_timescaledb
baseurl=https://packagecloud.io/timescale/timescaledb/el/9/$basearch
repo_gpgcheck=1
gpgcheck=0
enabled=1
gpgkey=https://packagecloud.io/timescale/timescaledb/gpgkey
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
metadata_expire=300
EOF

sudo dnf install -y timescaledb-2-postgresql-15
sudo timescaledb-tune --pg-config=/usr/pgsql-15/bin/pg_config --quiet --yes
sudo systemctl restart postgresql-15
sudo -u postgres psql -d polaris -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

`timescaledb-tune` updates `shared_preload_libraries` in `postgresql.conf` along with a few memory parameters. The Postgres restart picks the change up. Re-running it is safe.

### Ubuntu / Debian

```bash
sudo apt install -y postgresql-common
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh
echo "deb https://packagecloud.io/timescale/timescaledb/ubuntu/ $(lsb_release -c -s) main" \
  | sudo tee /etc/apt/sources.list.d/timescaledb.list
wget --quiet -O - https://packagecloud.io/timescale/timescaledb/gpgkey | sudo apt-key add -
sudo apt update
sudo apt install -y timescaledb-2-postgresql-15
sudo timescaledb-tune --quiet --yes
sudo systemctl restart postgresql
sudo -u postgres psql -d polaris -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

### Docker / docker-compose

Use the official Timescale image instead of vanilla Postgres in your compose file:

```yaml
services:
  postgres:
    image: timescale/timescaledb:latest-pg15   # was: postgres:15
    # REQUIRED when swapping the image on an EXISTING volume. The TimescaleDB
    # entrypoint only writes shared_preload_libraries into postgresql.conf
    # during initdb, and initdb does not re-run on an already-initialized data
    # directory. Without this the container starts and CREATE EXTENSION appears
    # to succeed, then everything touching a hypertable fails with
    # `could not access file "$libdir/timescaledb"`. As a server flag it applies
    # to fresh and existing volumes alike.
    command:
      - postgres
      - -c
      - shared_preload_libraries=timescaledb
      - -c
      - timescaledb.telemetry_level=off
    volumes:
      - polaris-pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: polaris
      POSTGRES_PASSWORD: change-me
      POSTGRES_DB: polaris
```

Match the PostgreSQL major version your volume already holds (`latest-pg15` for a PG 15 data directory). Existing data is preserved across the image swap. After bringing the new container up, confirm the library actually loaded, then enable the extension once:

```bash
docker exec -it <postgres-container> psql -U polaris -d polaris \
  -c "SHOW shared_preload_libraries;"            # must list timescaledb
docker exec -it <postgres-container> psql -U polaris -d polaris \
  -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
```

Polaris converts its own sample and rollup tables to hypertables on the next boot (`create_hypertable(..., migrate_data => TRUE)`, so existing rows carry over) and attaches the compression policies. Verify:

```bash
docker exec -it <postgres-container> psql -U polaris -d polaris \
  -c "SELECT count(*) FROM timescaledb_information.hypertables;"
```

### Windows Server

The official Timescale Windows installer is bundled with the EnterpriseDB Postgres installer. Run the EDB installer with the timescaledb extension checked, or download `timescaledb_x.y.z_pg15_windows_amd64.zip` from packagecloud, copy `timescaledb*.dll` into `C:\Program Files\PostgreSQL\15\lib`, copy `timescaledb*.sql` and the control file into `C:\Program Files\PostgreSQL\15\share\extension`, then add `timescaledb` to `shared_preload_libraries` in `postgresql.conf`, restart the Windows service, and run `CREATE EXTENSION timescaledb` against the polaris database.

### Managed / remote Postgres

If your Postgres is on a hosted service (RDS, Aurora, Cloud SQL, Azure Postgres, Crunchy, etc.), TimescaleDB availability varies:

| Service | TimescaleDB |
|---|---|
| AWS RDS for Postgres | **No** |
| AWS Aurora | **No** |
| Azure Postgres Flexible Server | Yes (opt-in) |
| Google Cloud SQL | **No** |
| Crunchy Bridge | Yes |
| Timescale Cloud | Yes (native) |
| Self-managed cloud (EC2 / Compute Engine / etc.) | Yes — install via the OS-native steps above |

If your service doesn't support TimescaleDB, Polaris stays on plain-Postgres prune and the Maintenance tab will continue to surface the recommendation as the sample tables grow. At that point, the right answers are: tighten retention, reduce monitored asset count, or migrate to a Postgres host that supports the extension.

---

## What the runtime does to keep this working

After install, Polaris monitors disk space on every filesystem it (and PostgreSQL, when co-located) writes to:

- **At boot**: `runStartupDiskCheck` logs a clear "X volume has Y MB free" line at info/warn/error per volume. Catches the "polaris flapping because /var is full" case before the operator has to dig through Prisma errors.
- **Every 10 minutes**: the `capacityWatch` job re-runs the snapshot and emits a `capacity.severity_changed` Event whenever severity transitions (ok ↔ watch ↔ amber ↔ red). Events flow through the configured syslog/SFTP archival pipeline so you get the alert even when the UI is unreachable.
- **Server Settings → Maintenance**: live volume bars + per-reason advisory cards. Severity tiering is **watch** at 20–30% free, **amber** at 10–20%, **red** below 10%.

The watch tier is the new "you have weeks, not minutes" warning. Don't ignore it.

---

## Backups — set this up on day one

Polaris can take a full logical backup of its own database, but **nothing takes one for you until you say so.** Decide which of these two you are doing before you go live:

**Option A — an existing enterprise backup product already covers this PostgreSQL instance.** Nothing to configure in Polaris. Confirm with whoever owns that product that this database is in scope, and read the *Restoring* section below anyway: a Polaris database with TimescaleDB installed needs a specific restore procedure, and a generic `psql < dump.sql` will not do it correctly.

**Option B — let Polaris schedule its own backups.** Open **Server Settings → Maintenance → Scheduled Backups**:

| Field | What it does |
| --- | --- |
| **Enable scheduled backups** | Off by default. Nothing runs until you tick this. |
| **Every (hours)** | 1 to 168. The first backup runs immediately when you enable it, not one interval later. |
| **At UTC hour** | Optional. Pins runs to a maintenance window. If the host is down through that hour, the backup runs at the next opportunity rather than skipping the day. |
| **Keep last** | How many *scheduled* backups to retain on disk. Manual and pre-update backups are never pruned by this. |
| **Encryption passphrase** | Optional but recommended — see the warning below. Same strength floor as a manual backup (12+ characters, 4+ distinct). |
| **Off-host copy directory** | An absolute path to a mounted share. Each finished backup is copied there. **Set this.** Without it, every backup lives on the same host as the database it protects, and one host loss takes both. |

Failures are visible three ways: a red `lastError` on the card, a `server.backup.scheduled_failed` Event (which rides your syslog/SFTP archival), and a `journalctl -t polaris` line. A failed off-host copy is reported separately as a warning and does not fail the backup itself.

### Encrypt your backups

A backup is a complete copy of the database. If `POLARIS_SECRET_KEY` is set (see *Secrets at rest* below), device and integration credentials inside it are already encrypted — but everything else, including password hashes and your whole IP-space inventory, is not. Use a passphrase, and store it somewhere other than the Polaris host.

**If you enable address-book directory sync** (Integrations → an Entra ID or Active Directory integration → **Directory**), this matters more than it otherwise would: that feature writes every matching person in your directory into the Polaris database — name, email address, job title, department and phone number — so each backup, and each off-host copy of one, then contains a copy of your employee roster. It is off by default. Treat enabling it as a decision for whoever owns your directory and your data-retention policy, not just for whoever administers Polaris.

### Restoring

Restore through **Server Settings → Maintenance → Restore** rather than by hand. On a TimescaleDB install, Polaris wraps the restore in the procedure Timescale requires:

```
SELECT timescaledb_pre_restore();   -- separate session
<the dump>
SELECT timescaledb_post_restore();  -- separate session, always runs
```

Skipping that pair restores hypertable metadata in the wrong order, and the restore either aborts or leaves you with hypertables whose chunks are invisible. If you must restore outside the app, run those two statements yourself, in their own `psql` invocations, on either side of the dump.

Two more things worth knowing before you need them:

- **Version match.** Restore a backup into the same Polaris version that produced it where possible. The Restore card reads the version out of the filename and warns on a mismatch; a schema that has moved on since the dump can fail the restore.
- **Practise it.** Restore a backup into a scratch database at least once, before you are doing it under pressure. `tests/integration/backupRestore.test.ts` does exactly this round trip and runs anywhere `pg_dump` and `psql` are on `PATH`.

---

## Secrets at rest

Polaris stores the credentials it uses to reach your infrastructure in its own database: SNMP communities, WinRM and SSH passwords and private keys, the bearer token, or the username and password, on an HTTP credential, FortiManager and FortiGate API tokens, the Entra and Azure Arc client secrets, the AD bind password, vCenter credentials, and delivery-channel secrets (SMTP password, M365 client secret, Slack/Teams webhook URLs, the Web Push private key).

`POLARIS_SECRET_KEY` in `/opt/polaris/.env` encrypts those values (AES-256-GCM, per-value). The first-run wizard and every `deploy/setup-*` script generate one automatically, so a fresh install is already covered — and re-running a setup script over an existing `.env` appends a key if one is missing. The exception is **Docker**, where no wizard or setup script runs: you supply the key yourself (see [Docker](#docker)). Verify with:

```bash
grep -c '^POLARIS_SECRET_KEY=' /opt/polaris/.env    # expect 1
```

**If it is missing** — an install that predates this feature, or a hand-written `.env` — those values are stored as **plaintext**, which means plaintext in every `pg_dump`, volume snapshot and read replica. Server Settings → Maintenance shows a watch-severity `secrets_key_unset` advisory while that is the case. To fix it:

```bash
printf '\nPOLARIS_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" >> /opt/polaris/.env
sudo systemctl restart polaris.target
```

On the next boot Polaris encrypts the existing rows in place (the `backfillSecretEncryption` job) and writes one `server.secrets.encrypted_at_rest` Event with the counts. No downtime beyond the restart, and nothing needs re-entering.

> **Back the key up somewhere other than this host.** Sealed secrets cannot be recovered without it. If you restore a Polaris backup onto a host with a *different* key, the app works and your users can still log in — but every device credential, integration secret and delivery-channel secret has to be re-entered, because Polaris cannot decrypt them. Keep the key with your other break-glass material, alongside the backup passphrase.
>
> In a managed deployment, inject the key from Azure Key Vault the same way you deliver `SESSION_SECRET`, rather than leaving it in a file on the host.

Rotating the key is not a supported in-place operation: there is no re-encrypt-with-new-key pass, so a rotation means re-entering the secrets. Treat it as a one-time value.

---

## Capacity tuning — use the Capacity Advisor

After Polaris has been running long enough to populate the monitor-work duration histogram (~5–15 minutes on a populated fleet, up to 24 hours on a fresh install), open **Server Settings → Maintenance → Capacity Advisor**. The card derives recommended values for connection pool sizes, monitor worker counts, queue mode (cursor ↔ pg-boss), and PostgreSQL `max_connections` / tuning settings from your observed workload (monitored asset count, monitored interface count, per-class FortiGate count, per-cadence p90 pass duration, observed peak connection count, host RAM).

How it works in practice:

1. Tick the rows you want to apply. Each row shows current vs recommended; rows already at-or-above recommendation render with an OK pill and a disabled checkbox.
2. Click **Stage selected**. Polaris writes the chosen env-driven values to `.env` and (for the queue-mode lever) updates `Setting.monitor.queueMode`. **Restart Polaris** to pick up the changes.
3. Advisory-only rows (PostgreSQL `max_connections`, `shared_buffers`, `effective_cache_size`, `work_mem`, `random_page_cost`) are display-only because Polaris can't edit `postgresql.conf`. Edit it and restart PostgreSQL to apply.

Separately, the **Database card** shows a `track_io_timing_off` watch when the database is larger than host RAM and PostgreSQL's `track_io_timing` is off. Enabling `track_io_timing = on` (a **reload** — `SELECT pg_reload_conf();` or `systemctl reload postgresql`, no restart) is what lets Polaris measure real disk-read wait and decide whether more RAM would actually help (the `db_io_pressure` reason); overhead is negligible on modern hardware (verify with `pg_test_timing`).

The env vars surfaced by the advisor have safe defaults out of the box, so a fresh install starts at sensible values:

```
DATABASE_POOL_SIZE=25
POLARIS_PGBOSS_POOL_SIZE=20
POLARIS_MONITOR_PROBE_WORKERS=24
POLARIS_MONITOR_FAST_WORKERS=24
POLARIS_MONITOR_HEAVY_WORKERS=24
POLARIS_MONITOR_FLOATING_WORKERS=32
POLARIS_PROBE_CONCURRENCY=16   # cursor mode only
POLARIS_HEAVY_CONCURRENCY=8    # cursor mode only
```

For headless installs (no UI access) the same env vars can be set by hand. The defaults above cover up to ~500 monitored assets in cursor mode; past that, flip to pg-boss (`Setting.monitor.queueMode = "pgboss"`) and let the advisor scale worker counts as the fleet grows.

`max_connections` on the PostgreSQL side should sit at roughly `(prismaPool + pgbossPool) / 0.65` rounded up to a multiple of 50, leaving ~35% headroom for non-Polaris consumers (psql sessions, backups, replication, monitoring agents). The advisor surfaces the exact recommendation alongside the pool sizes.

---

## Optional: High availability (active/standby, two datacenters)

A second host in another datacenter that takes over automatically when the
first is lost, behind one public name. PostgreSQL is managed by **Patroni**
with a three-member **etcd** (the two database nodes plus a small witness);
replication is asynchronous streaming, so the recovery point is the
replication lag and the recovery time is roughly 1.5 to 3 minutes.

The application follows its database: `polaris-ha-role` starts
`polaris.target` only where the local PostgreSQL is the Patroni primary, and
stops it everywhere else. That is not a preference — Polaris has no leader
election, so two live web roles would poll every device twice and duplicate
every alert. Four independent layers make a second instance impossible, and
`GET /health/ready` (200 only on a writable primary) is what takes a demoted
node out of your load balancer.

Two things about this deployment surprise people, so they are worth knowing
before you plan it:

- **The standby must serve the identical nginx certificate.** Every enrolled
  agent pins that exact leaf by SHA-256 and does not validate a chain, so a
  different certificate — even a valid one from the same CA — is refused by the
  whole fleet. The file sync copies it for exactly this reason.
- **`.env` must be identical too.** `POLARIS_SECRET_KEY` decrypts every stored
  credential and `SESSION_SECRET` signs every cookie; a mismatch blanks the
  first and invalidates the second, silently.

Tooling lives in `deploy/ha/` (etcd and Patroni templates, the certificate
authority, the reconciler, the systemd drop-ins, `setup-rhel-ha.sh`).

**Read [docs/HA.md](HA.md) before starting.** It covers the witness-placement
trade-off, the network and hardware requirements, exactly what a failover
loses, the split-brain proof, the build walkthrough, the update procedure, the
rollback out of Patroni, and the drills.

---

## Optional: Prometheus + Grafana

Polaris exposes a Prometheus scrape endpoint at `GET /metrics` covering every `polaris_*` metric defined in `src/metrics.ts` — monitor pass and per-cadence work duration, probe latency by transport, FMG dual-lane worker saturation, DB pool / capacity severity / dead-tuple ratios, discovery duration and per-phase histograms, sample-write and rollup durations, HTTP request latency, and per-job durations. Default Node.js process metrics (event-loop lag, RSS, heap, CPU) are also emitted unprefixed so the standard Node.js Grafana dashboards work without modification.

**Bearer token.** The first-run setup wizard auto-generates a `METRICS_TOKEN` and writes it to `.env`. Clearing it surfaces a `metrics_token_unset` watch reason on the Maintenance tab (the endpoint leaks fleet recon data if unauthenticated). Prometheus needs a matching `Authorization: Bearer <token>` header; a minimal scrape config:

```yaml
scrape_configs:
  - job_name: polaris
    metrics_path: /metrics
    static_configs:
      - targets: ['polaris.example.com:3000']
    bearer_token: '<value of METRICS_TOKEN from .env>'
```

**Grafana dashboard.** A pre-built dashboard lives at `docs/grafana/polaris-monitoring-dashboard.json` with the import flow + per-row reading guide in `docs/grafana/README.md`. In Grafana → **Dashboards → New → Import** → upload the JSON → pick your Prometheus datasource for the `DS_PROMETHEUS` variable.

**Postgres-side visibility (separate).** The Polaris dashboard is the *app's* view of the database (pool in-use, dead-tuple ratio on sample tables, projected steady-state size). For true Postgres internals (connections, locks, WAL, replication lag, slow queries, per-table bloat across the whole DB) deploy [`postgres_exporter`](https://github.com/prometheus-community/postgres_exporter) on the prod box and import a community Grafana dashboard like ID 9628 or 12485 alongside.

---

## Optional: Polaris Agent

The Polaris Agent is a small Go binary you can install on Linux / macOS / Windows hosts that pushes monitoring samples back to Polaris over HTTPS. Useful for hosts behind NAT, hosts without a working SNMP/WinRM probe surface, and Windows / Linux endpoints generally. The feature is **optional** — Polaris monitors plenty of devices without it via the existing REST API / SNMP / WinRM / SSH / ICMP transports.

### Build the binaries

**The default path:** the install scripts in this guide (`deploy/setup-{rhel,ubuntu,windows}.{sh,ps1}` and their `-nodb` variants) provision Go 1.22+ alongside Node 24, so a freshly-installed Polaris server is ready to produce agent binaries on demand. From the web UI:

1. Sign in as admin
2. Integrations → **Polaris Agents** tab → **Polaris Agent** card → **Build agent binaries (vX.Y.Z)**
3. Watch the progress strip; all six platforms reach ✓ within ~90 s on a 2-vCPU host

The button is hidden + replaced by a yellow notice ("install Go 1.22+ and reload") when Go isn't on the server's PATH. The card also shows a per-platform inventory grid and surfaces a drift hint when `agent/VERSION` has moved past `manifest.json` (the auto-build job fires this build for you on the next boot if you don't click it sooner).

**Build queueing + cancellation:** A second click while a build is running enqueues (FIFO depth 3); the 4th simultaneous click gets a "queue full" 409. Each build's row carries a × button that cancels (SIGTERM with SIGKILL 5s grace for the active build; splice-from-queue for queued ones). The on-disk manifest only updates after all six platforms succeed, so a cancelled build leaves no operator-visible artifact.

**Auto-build:** Polaris fires Build automatically 60 s after every boot when `agent/VERSION` has moved past the on-disk manifest. Disable via the toggle on the same card when shop policy requires human-initiated builds. The auto-build is gated on Go being installed (logs a warning Event if not), an existing manifest (operator must have built at least once — fresh installs don't get surprised), and the kill-switch Setting.

**Per-version cleanup:** After every successful build Polaris auto-prunes old version directories. The prune helper NEVER removes the manifest's currentVersion, NEVER removes versions in use by a live agent (so rollback works), and ALWAYS keeps the most recent N (env `POLARIS_AGENT_KEEP_VERSIONS`, default 3). The "Clean up old binaries" button on the card fires the same helper manually.

### Build the binaries (fallback: build on a separate host)

When Polaris itself runs on a host that can't have Go installed (strict supply chain, air-gapped CI, etc.), build on a separate host and copy the artifacts in:

```sh
# On any host with Go 1.22+ installed
cd /path/to/polaris/agent
go mod tidy
make all                        # → dist/<version>/polaris-agent-*
```

```sh
# On the Polaris host
sudo mkdir -p /opt/polaris/data/agents/<version>
sudo cp dist/<version>/* /opt/polaris/data/agents/<version>/
sudo tee /opt/polaris/data/agents/manifest.json <<'EOF'
{
  "currentVersion": "<version>",
  "minimumCompatible": "<version>",
  "binaries": {
    "linux-amd64":   "polaris-agent-linux-amd64",
    "linux-arm64":   "polaris-agent-linux-arm64",
    "darwin-amd64":  "polaris-agent-darwin-amd64",
    "darwin-arm64":  "polaris-agent-darwin-arm64",
    "windows-amd64": "polaris-agent-windows-amd64.exe",
    "windows-arm64": "polaris-agent-windows-arm64.exe"
  }
}
EOF
sudo chown -R polaris:polaris /opt/polaris/data/agents
```

Docker / Unraid users: the container's state directory is `/app/state`. Bind-mount or `docker cp` the same layout into `/app/state/data/agents/`.

When `manifest.json` is missing, the install flow surfaces a clear error: *"No agent binaries available — drop a manifest.json + binaries under `<state>/data/agents/<version>/` and retry"*. So you can deploy Polaris first and add the binaries later when you actually want to use the feature.

### Set POLARIS_PUBLIC_URL

The agent.conf file written to each installed agent embeds the URL the agent will call back to. For any single-box install where Polaris is reachable from the agent host at its public DNS name, set this in `.env`:

```ini
POLARIS_PUBLIC_URL=https://polaris.example.com:3000
```

Without it the agent receives `https://localhost:<PORT>` which only works for testing on the same host.

For reverse-proxy / TLS-termination-upstream topologies (nginx, Caddy, ALB), `POLARIS_PUBLIC_URL` must be the **proxy's** public URL — the agent's pinned cert is the proxy's cert, not the upstream's.

It also decides whether **alert emails carry a one-click Acknowledge link** and an Open-device button: both are absolute URLs, so without it the email is delivered without them (web push still acknowledges — it falls back to a relative URL the service worker resolves against its own origin).

`POLARIS_PUBLIC_URL` is **also required for OIDC SSO** — Polaris derives the OIDC redirect URI from it (`${POLARIS_PUBLIC_URL}/api/v1/auth/oidc/callback`). OIDC login refuses with a clear error if it's unset.

## Optional: Code signing for agent Windows binaries (internal CA)

Freshly compiled, unsigned Go executables are a textbook match for Microsoft Defender's ML heuristics — and because every in-app agent build produces a new file hash, per-file reputation resets on every rebuild. Signing the two Windows agent binaries (`polaris-agent-windows-{amd64,arm64}.exe`) with your **organization's internal CA** lets you allow them by *publisher* once, instead of re-earning trust per hash. When configured, signing runs automatically as a post-build step of every in-app agent build.

**What this does and doesn't buy you.** An internal CA is unknown to Microsoft, so it contributes nothing to SmartScreen reputation. What it gives you is a *deterministic* allow on machines you manage — via a Defender for Endpoint certificate indicator or an App Control for Business publisher rule — rather than waiting on a cloud reputation service. On any host that does **not** trust your internal root (non-domain-joined, contractor, DMZ, not-yet-onboarded), the signature reads as **untrusted**, which can present worse than an unsigned binary. If you need public trust instead, that requires a publicly trusted CA (Azure Artifact Signing, or an OV certificate from a commercial CA) and a different keystore backend than the one documented here.

SmartScreen is usually not the constraint in the first place: it only fires on files carrying the Mark of the Web, which browsers and mail clients stamp. The agent installer fetches binaries server-side over the SSH/WinRM install path, so they never acquire MOTW.

**Fail-open semantics:** a signing failure never blocks the build. The build completes, the binaries ship **unsigned**, a warning Event (`agent.build.sign_failed`) is written, and a dismissable sidebar alert appears for every user whose role can deploy agents (`assets` ≥ write). The alert clears on the next fully-signed build (or when signing is disabled). If you need signed-or-nothing, treat the alert as your gate before running agent installs.

### PKI-side setup (one-time)

1. **Issue a code-signing certificate** from your internal CA. On AD CS this is the **Code Signing** template (or a duplicate of it with a longer validity). The subject CN is what Defender and App Control rules will match on, so name it for the publisher rather than the host — e.g. `CN=Rogers Group Polaris Agent`.
2. **Export it as a PKCS#12 file** (`.pfx` / `.p12`) *with* its private key, protected by a strong password. Include the issuing chain in the export if your CA offers the option — it makes the signature verifiable without a separate chain fetch.
3. **Distribute trust to the fleet** — the internal root (and any intermediates) into **Trusted Root Certification Authorities**, via GPO or Intune. This has to land on a host *before* an agent installs there, or the signature will read as untrusted.
4. **Add the allow rule.** In Defender → **Settings → Endpoints → Indicators**, add the **leaf** signing certificate (`.cer`/`.pem`) with action **Allow**. Two caveats: only leaf certificates are supported, so a certificate renewal needs a new indicator; and indicator changes take up to **3 hours** to propagate. If you run App Control for Business, a publisher rule is the stronger equivalent.

> **Track the certificate's expiry.** When the signing certificate expires, builds start shipping unsigned — quietly, via the fail-open path — and the Defender indicator for the old leaf stops matching the new one. Put the expiry along with whatever your PKI team already uses for certificate renewals.

### Polaris host prerequisites

The install scripts in this guide (and the Docker image) provision the toolchain automatically: a headless **Java 17** runtime and the **jsign** jar (v7.4, SHA-256-pinned) at `<app dir>/tools/jsign.jar` (`/opt/polaris/tools/jsign.jar` on Linux, `C:\polaris\tools\jsign.jar` on Windows). Existing installs that predate this feature add them manually:

```sh
# RHEL/Rocky/Alma
sudo dnf install -y java-17-openjdk-headless
# Ubuntu/Debian
sudo apt-get install -y default-jre-headless
# Both:
sudo mkdir -p /opt/polaris/tools
sudo curl -fsSL -o /opt/polaris/tools/jsign.jar \
  https://github.com/ebourg/jsign/releases/download/7.4/jsign-7.4.jar
echo "2abf2ade9ea322acc2d60c24794eadc465ff9380938fca4c932d09e0b25f1c28  /opt/polaris/tools/jsign.jar" | sha256sum -c -
```

On Windows Server: `winget install Microsoft.OpenJDK.17` (or the MSI from https://aka.ms/download-jdk) and drop `jsign-7.4.jar` at `C:\polaris\tools\jsign.jar`. No Polaris restart needed — the availability probe re-checks on every page load.

**Then install the keystore.** Either upload it through the UI, or place it on the host by hand.

**Upload (no shell access needed).** On the Code signing card, pick the `.pfx` under **Upload keystore**, enter the password protecting it, and press **Upload**. Polaris validates the file *before* replacing anything — wrong password, a PEM export, or a keystore with no private key are all refused with the reason, leaving whatever was installed untouched. On success it stores the file at `<state dir>/data/signing/codesign.pfx` (mode `0400`, owned by the service user, in a directory no static handler serves), sets the keystore path for you, and shows the certificate's subject, issuer, SHA-256 fingerprint and **expiry with a day countdown** — which is also where you get the fingerprint to paste into a Defender indicator. This is the path to use on renewal: upload the new `.pfx` over the old one. **Delete keystore** removes it (and clears the stored password); builds then keep succeeding but ship unsigned.

**By hand.** Copy the `.pfx` onto the Polaris host and lock it down to the service account — it is a fleet-trusted signing key:

```sh
sudo install -o polaris -g polaris -m 0400 codesign.pfx /opt/polaris/tools/codesign.pfx
```

On RHEL with SELinux enforcing, `sudo restorecon -v /opt/polaris/tools/codesign.pfx`. The path must be **absolute** (the API rejects a relative one): the signing child inherits whatever working directory the build process has, which differs between the single-process and split-role layouts.

**On Docker/Podman**, put the keystore under the persistent state dir instead — `./state/tools/codesign.pfx` on the host, which the container sees at `/app/state/tools/codesign.pfx` (that is also one of jsign's default jar probe locations, so the convention already exists). Set the keystore path to the in-container path, not the host one. Do **not** bake the keystore into a derived image: it is a fleet-trusted private key, and an image layer follows the image into every registry and cache it touches.

### Configure in Polaris

Integrations → **Polaris Agents** → **Code signing (internal CA)**:

1. Tick **Sign Windows agent binaries on build** and fill in the **keystore path**, **keystore password**, and **timestamp URL**. Leave **key alias** blank unless the keystore holds more than one entry, and leave **jsign jar path** blank for auto-detection. Saving requires `serverSettingsSystem = fullwrite` (admin).
2. Click **Test** — it checks Java and the jar, then opens the keystore with the stored password via `keytool` and lists the aliases it found. That proves the path/password pair and catches a mistyped alias, which otherwise only surfaces as a jsign error mid-build. It makes **no network call**, so it does not prove the timestamp authority is reachable.

   `keytool` ships inside `java-17-openjdk-headless`, but beside the JVM rather than necessarily symlinked onto `PATH`. Polaris tries the bare name first and then the JVM's own reported `java.home` (and `JAVA_HOME` if you set one), so it normally finds it either way. If it genuinely can't, Test reports *"password NOT verified"* and everything else still passes — signing itself never uses keytool, only `java -jar jsign.jar`, so this is a diagnostic downgrade rather than a functional one.
3. Run a build. The progress strip gains `sign-windows-amd64` / `sign-windows-arm64` rows after the six platform rows; the completed Event carries `signed: true`.

Verify a signed binary with `osslsigncode verify` (Linux) or `Get-AuthenticodeSignature` (Windows) — run the latter on a machine that trusts your internal root, or it will correctly report an untrusted chain. Explorer → Properties → Details also shows the embedded VERSIONINFO metadata (product name, version) that the agent binaries carry regardless of signing.

**Timestamping is required, not optional.** Unlike a hosted signing service, a PKCS#12 keystore gets no automatic countersignature, so Polaris always passes an explicit RFC3161 timestamp URL (default `http://timestamp.digicert.com`). A public TSA is correct even with an internal-CA certificate — a TSA attests to *when*, not *who* — and `http` is normal here because the timestamp token is itself signed. Without a countersignature, every signature in the fleet becomes invalid the moment the signing certificate expires, all at once. Clearing the field falls back to the default rather than silently disabling timestamping; on a closed network, point it at your own AD CS timestamping endpoint.

**Secret handling:** the keystore password is stored in the `agent.codeSigning` Setting row, encrypted at rest when `POLARIS_SECRET_KEY` is set (the field name is registered in `src/utils/configSecretFields.ts`), masked on read (the UI shows `••••••••`; leaving the field untouched on Save keeps the stored password), and never written to the audit Event. It reaches jsign and keytool through an environment variable, never on a command line. The private key itself sits on disk, so its custody is the host's file permissions — treat the Polaris server as a signing system for access-review purposes.

## Authentication providers (OIDC / LDAP / SAML / App Proxy)

Beyond local accounts, Polaris authenticates against Azure SAML, **OIDC** (OpenID Connect Authorization-Code + PKCE), **LDAP / Active Directory** (bind), or **Entra Application Proxy header SSO**. Configure under **Users → Authentication** (admin only); each tab has a **Test** button.

- **OIDC:** fill in the Discovery URL, Client ID/Secret, and scopes. Copy the **Redirect URI** shown on the tab and register it in your IdP app registration. **Azure AD note:** by default Azure emits group **object IDs (GUIDs)** in the `groups` claim, not names — map those object IDs in Group Mappings, or configure Azure to emit group names. Azure also drops the claim above ~200 groups (the user then resolves to `readonly` until a smaller group set or a groups-assignment filter is configured).
- **LDAP/AD:** set the server URL (`ldaps://…`), bind DN + password, search base/filter, and (for group mapping) the User ID Attribute (`objectGUID` on AD) + Group Attribute (`memberOf`). LDAP users sign in through the normal username/password form.
- **Group → role + tags:** under **Users → Group Mappings**, map an IdP group to a role plus region/other tags. A user in several mapped groups gets the **highest-privilege** role; tags from all matched groups combine. **A mapping to an admin-equivalent role makes IdP group membership a path to Polaris admin** — restrict who can edit those groups in your directory accordingly.

### Entra Application Proxy (header-based SSO)

For deployments published to the internet through **Microsoft Entra Application Proxy** (Entra ID pre-authentication) instead of exposing Polaris directly. App Proxy authenticates each user against Entra in the cloud — including MFA and Conditional Access — then forwards their claims to Polaris as HTTP headers. Users are logged in automatically with no second sign-in.

> **Security model — read this.** The identity headers App Proxy injects are **plain and unsigned**; there is no token for Polaris to cryptographically verify. Microsoft's documented protection is purely network-level: *only accept those headers from the connector.* Polaris enforces this with a **source-IP allowlist** — it honors the identity headers only when the request arrives from an allowlisted App Proxy connector address (and strips them from every other request). **The backend must be reachable only through App Proxy + your nginx**; if an attacker can reach Polaris directly from an allowlisted-looking source, they can forge identities. An empty allowlist disables header login entirely (fail closed).

**On the Entra side:**

1. Publish Polaris as an Application Proxy app with **Pre-authentication = Microsoft Entra ID**.
2. Under the app's **Single sign-on → Header-based**, map claims to headers. At minimum map the user **object ID** and **UPN**; optionally email, display name, and a **groups** header. Use header names that match the Polaris config below (defaults: `x-entra-object-id`, `x-entra-upn`, `x-entra-email`, `x-entra-display-name`, `x-entra-groups`).
3. Groups arrive as Entra group **object IDs (GUIDs)**. To avoid the **group-overage** limit (Entra silently omits the groups header when a user is in more than ~150 groups), set the app to emit only **"Groups assigned to the application."**

**On the Polaris side (Users → Authentication → App Proxy):**

1. Enable App Proxy header authentication.
2. Enter the **trusted source IPs / CIDRs** — the connector host(s) *as Polaris sees them* (behind nginx, the address nginx forwards; direct-to-Polaris, the socket peer). Run **Test** to see the current request's source IP.
3. Confirm the header names match what you configured in Entra.
4. Map the Entra **group object IDs** to roles + tags under **Users → Group Mappings** with provider **App Proxy** (GUIDs, matched case-insensitively).

Header auth **coexists** with your other login methods — internal users hitting nginx directly (not through the connector) never see the App Proxy headers and fall through to the normal login page. A user who has also signed in via Azure SAML converges onto the same Polaris account (both key on the Entra object ID).

**Optional nginx hardening (defense in depth).** Polaris already ignores + strips the identity headers from non-allowlisted sources, but you can also strip them at the edge for any request that didn't come from the connector. In a hand-managed `polaris.conf` (note: editing a Polaris-managed nginx config triggers the drift banner — see the nginx section), add a `geo` block keyed on the connector IP and clear the headers when untrusted:

```nginx
geo $entra_untrusted {
    default 1;
    10.20.30.40 0;      # App Proxy connector host(s)
}
# inside the Polaris location {}:
if ($entra_untrusted) {
    set $strip_entra 1;
}
proxy_set_header x-entra-object-id    "";   # when $strip_entra — use a map for conditional set
```

Widening `TRUST_PROXY` beyond the default first-hop weakens the source-IP check (Polaris would trust a client-supplied `X-Forwarded-For`) — leave it at the default when using header auth.

### Install on a remote host

From the Polaris UI:

1. Open the asset's details modal → **Monitoring** tab
2. Flip any stream to **Polaris Agent**
3. Save
4. Reopen the asset details modal → **System** tab → **Install Agent…**
5. Confirm the OS + arch picker (defaults from `Asset.os`)
6. Pick the **Install method** — a curated, OS-locked service-install script (currently one vetted method per OS: systemd on Linux, launchd on macOS, a native Windows Service). The picker only lists methods valid for the selected OS; the choice is re-validated server-side.
7. On **Windows** assets, pick the transport (WinRM or SSH); on Linux/macOS SSH is the only option
8. Pick a stored credential of the matching type (SSH or WinRM)
9. Click **Install**

The install status pill flips `pending → uploading → enrolling → active` over ~30 seconds. The host's systemd / launchd / Windows Service is registered as `polaris-agent`. Uninstall + Force Remove buttons appear once the agent is active. The chosen transport is persisted on the agent row; retry, uninstall, and upgrade reuse it.

### Required on the target host

- **Linux / macOS:** SSH reachable from Polaris on port 22 (or whatever the credential's port field specifies); the credential's user must be able to `sudo -n` (passwordless sudo) — the installer creates a systemd unit / launchd plist. **The SSH Deployment card sets this up for you on Linux** (key + sudoers drop-in) — see below.
- **Windows (WinRM):** WinRM enabled on port 5986 (HTTPS) or 5985 (HTTP). Run `Enable-PSRemoting -Force` on a fresh host. The credential must have local admin rights — the installer creates a Windows Service under `%ProgramFiles%\Polaris\Agent\`.
- **Windows (SSH):** OpenSSH Server installed and enabled (`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0; Start-Service sshd; Set-Service -Name sshd -StartupType Automatic`) and reachable on port 22 (or the credential's port). The credential must have local admin rights. Polaris runs the same PowerShell installer used by the WinRM path — the Windows host pulls the agent binary back from Polaris over HTTPS with cert-pin validation, so outbound HTTPS from the host to Polaris must work during the install. **Use the Windows SSH Deployment card to set this up rather than doing it by hand** (see below) — it generates the keypair and the script for you, and gets the two silently-failing details right.

### SSH deployment with key auth (Windows and Linux)

Installing the agent over SSH with a key takes a reusable administrator password off the wire entirely. **Integrations → Polaris Agents → Windows SSH Deployment** automates the setup:

1. **Generate keypair.** Polaris creates an ed25519 pair, keeps the private half sealed in a credential named *Windows SSH (Polaris-managed)*, and shows only the public half + fingerprint. The private key is never displayed or downloadable, and there is **no escrow** — if it is lost (e.g. a backup restored onto a host with a different `POLARIS_SECRET_KEY`), regenerate and re-run the script.
2. **Set the account, per platform.** Pick the Windows or Linux tab, then either name an existing account or have the script create a dedicated one (Windows: random password; Linux: password locked — either way authentication is by key only). Optionally give the Polaris server's address to scope inbound TCP/22 to it. Polaris keeps one managed credential per platform, both holding the same key: a credential carries a single username, and a Windows `DOMAIN\user` is meaningless on Linux.
3. **Download the script** and push it to your fleet. It contains no machine-specific values, so the same file runs unchanged everywhere. Windows: run **as SYSTEM with the 64-bit PowerShell host**. Linux: run **as root**. Both are idempotent and safe to re-run.
4. **Install as normal.** Asset details → Install Agent → choose the **SSH** transport and the managed credential. For bulk deploys, leave the WinRM credential empty — when both are configured, Windows prefers WinRM.

**Why not do this by hand:** every one of these fails *silently* — authentication just stops working, with nothing useful on the client.

- **Windows** OpenSSH ignores `%USERPROFILE%\.ssh\authorized_keys` for anyone in the Administrators group and reads only `%ProgramData%\ssh\administrators_authorized_keys`; and it refuses that file unless it is owned by Administrators/SYSTEM with inheritance disabled.
- **Linux** sshd refuses a group- or world-writable `~/.ssh`, or an `authorized_keys` owned by the wrong user; and on RHEL-family hosts a hand-created `~/.ssh` carries the wrong SELinux context.
- **Linux also needs passwordless sudo.** The agent installer runs `sudo -n bash /tmp/polaris-agent-install.sh`, so an SSH key on its own will not install an agent. The generated script writes `/etc/sudoers.d/polaris-agent` and validates it with `visudo -cf` *before* installing it — a malformed drop-in locks sudo out for every user on the host.

The Linux script does **not** install `openssh-server`: that needs distro-specific package management, and a host you cannot already reach over SSH is not one the script was delivered to. It reports and exits instead.

**Deploying it across a fleet:**

| Estate / tooling | Vehicle | Notes |
|---|---|---|
| Intune-enrolled Windows 10/11 | **Remediation** (detection + remediation pair) | Preferred. Re-checks on a schedule so reimaged / previously-offline devices self-heal. Devices → Scripts works but runs once per device and never retries. |
| Domain-joined, no Intune | **GPO startup script** | Computer Config → Policies → Windows Settings → Scripts → Startup. Runs as SYSTEM at boot; re-running every boot is harmless. Reaches servers too. |
| Configuration Manager | **Configuration Baseline** | Same detection + remediation pair, same self-healing behaviour. |
| Windows Server | GPO, Configuration Manager, or **Azure Arc** | Intune does not manage traditional Windows Server. The script body is identical — only the delivery differs. |
| Third-party RMM | Script job | Ordinary PowerShell run as SYSTEM; no adaptation needed. |
| No management tooling | `Invoke-Command -ComputerName (Get-ADComputer -Filter ...).Name -FilePath .\polaris-ssh-onboarding.ps1` | Uses WinRM once to bootstrap SSH, after which Polaris no longer needs a password on the wire. |

For **Linux**, the equivalents are Ansible (`ansible all -b -m script -a polaris-ssh-onboarding.sh`), any run-as-root script resource in Salt/Chef/Puppet, `cloud-init` `runcmd` so new instances onboard at first boot, or `scp` + `sudo bash polaris-ssh-onboarding.sh` by hand. The detection script gives every one of those a check/apply guard.

Pre-1809 / pre-Server 2019 hosts have no OpenSSH Server capability; both scripts report `unsupported:` and exit 0 there rather than failing forever.

**Rotating the key** invalidates every endpoint at once — Polaris cannot install, upgrade or remove agents until the script has re-run everywhere. Already-installed agents keep reporting normally (they authenticate with their own bearer, not this key).

> The generated scripts create privileged accounts, grant passwordless sudo on Linux, and modify firewall rules across your fleet. Have someone review them before they go into Intune/GPO/Ansible — "Polaris generated it" is not a substitute for that review.

### Optional: let Polaris publish the script for you

Downloading the script and pushing it yourself works fine and needs no extra permissions. If you'd rather skip that step, Polaris can deliver it through the two Azure vehicles it already holds credentials for. Both are **off by default**, enabled per integration on its **Script Publishing** tab, because each needs a vendor-side grant that the read-only discovery credential deliberately lacks.

#### Intune (Windows)

Uploads the remediation + detection pair as an Intune **Remediation**.

1. Open the app registration behind your Entra ID integration → **API permissions**.
2. Add the Microsoft Graph **application** permission `DeviceManagementScripts.ReadWrite.All`.
3. **Grant admin consent** — application permissions do nothing without it.
4. Tick *Allow Polaris to publish scripts to Intune* on the integration's Script Publishing tab.
5. Integrations → Polaris Agent → SSH Deployment → **Publish to Intune**.

> **If publishing returns a 403 naming a different scope**, grant that one. Graph serves Remediations (`deviceHealthScripts`) from both `/v1.0` and `/beta`, Polaris uses whichever your tenant answers on, and the two do not enforce the same scope — some tenants want `DeviceManagementConfiguration.ReadWrite.All` instead. The error text names the scope your tenant is asking for; that is the authority, not this page.
>
> **A 403 immediately after fixing the grant is expected once.** Polaris authenticates with an app-only token whose permissions are frozen when the token is issued, and it caches that token for up to an hour, so the first attempt after a grant can still be carrying the pre-grant token. Polaris now discards a cached token and retries once when Graph returns 403, so pressing the button again is enough; you no longer need to restart the service or wait the token out.

**Polaris never assigns the policy.** It arrives targeting nothing; you review the script and choose device groups in the Intune console. Re-publishing updates the same policy rather than creating a second one.

Note the permission grade: this takes the credential from "reads your device inventory" to "creates device-management policy across the tenant", and an application permission carries no user context.

#### Azure Arc (Windows **and** Linux)

Runs the script directly on Arc-connected machines via **Run Command**. This is how Linux and Windows Server get onboarded — Intune deploys scripts to neither.

1. Discovery needs only **Reader**. Running scripts additionally needs **all three** of these actions:

   | Action | Why |
   |---|---|
   | `Microsoft.HybridCompute/machines/read` | lists the machines in the target picker |
   | `Microsoft.HybridCompute/machines/runCommands/write` | dispatches the run command |
   | `Microsoft.HybridCompute/machines/runCommands/read` | reads back exit code, stdout and stderr |

   The third is the one people miss, and its absence is invisible until after a dispatch: the script runs, and no result ever comes back.

   A **custom role** with exactly those three is the least-privilege option:

   ```json
   {
     "Name": "Polaris Arc Run Command",
     "Description": "Dispatch and read Polaris onboarding run commands on Arc machines.",
     "IsCustom": true,
     "Actions": [
       "Microsoft.HybridCompute/machines/read",
       "Microsoft.HybridCompute/machines/runCommands/read",
       "Microsoft.HybridCompute/machines/runCommands/write"
     ],
     "NotActions": [],
     "AssignableScopes": ["/subscriptions/<SUBSCRIPTION_ID>"]
   }
   ```

   ```bash
   az role definition create --role-definition polaris-arc-run-command.json
   ```

   The built-in **Azure Connected Machine Resource Administrator** also covers all three, but it can additionally modify and delete Arc machine resources.

2. Assign it to the service principal at the **subscription or resource-group scope** covering the machines you intend to onboard. This is an **Azure RBAC role assignment**, not a Graph API permission — a different mechanism from the Intune side, and a common point of confusion. Two practical notes: the service principal is the app's entry under **Entra ID → Enterprise applications** (search by **Application (client) ID**, not display name), and **keep the existing Reader assignment** — Azure roles are additive and discovery still needs it. Allow a few minutes for propagation; a 403 straight after assigning usually means "not yet" rather than "wrong role".
3. Tick *Allow Polaris to run deployment scripts* on the Arc integration's Script Publishing tab.
4. Integrations → Polaris Agent → SSH Deployment → Azure Arc → **Choose machines…**, tick the targets, confirm.

> **A run command executes immediately.** Unlike an Intune Remediation there is no unassigned state to review first — creating one runs the script as root/SYSTEM on that machine. Polaris only ever targets machines you explicitly tick, caps a run at 200, preselects nothing, and disables any machine whose OS Arc doesn't report rather than guessing which script to send. **Your selection is the review step.** Run against one machine first and confirm the outcome before doing a batch.

Each machine gets the script matching its OS. Results appear in the dispatch dialog; Polaris reports *dispatch*, and the script then runs asynchronously on the machine, so outcomes appear a few moments later.

### Upgrade agents on already-installed hosts

When `agent/VERSION` advances and you build (or auto-build fires), existing installed agents stay on their old binaries until you push the upgrade.

**Per-asset:** Asset details modal → System tab → Polaris Agent panel → **Upgrade…** button. Confirm and watch the install-state pill flip `active → upgrading → active` within ~10 s. The agent's bearer + cert pin survive the swap — no re-enrollment, no need to repick a credential (the install credential stored on the row is reused).

**Fleet-wide:** Integrations → Polaris Agents tab → Polaris Agent card. When any installed agents lag the current build, the card shows an "N of M installed agents running an older version" line with an **Upgrade all** button. Click → confirm → Polaris fans out to every out-of-date host with a Promise pool of 4 (the SSH/WinRM connections are the bottleneck; higher parallelism risks tripping per-host concurrent-connection limits — Windows WinRM caps at ~5 by default).

Failures land per-row as `installStatus="upgrade_failed"` with the error captured in `installError`; an audit Event (`agent.upgrade_failed`) goes out per failed host. A failed row is still upgradeable — the old binary is what's still running — so it keeps its out-of-date badge and stays in the eligibility filter: retry an individual host with the Retry Upgrade button on its asset details panel, click Upgrade-all again, or simply leave it, since the next build's auto-upgrade fan-out (when enabled) picks it up along with everything else. Already-current hosts are silently skipped. That matters most for laptops: a machine asleep or off-VPN during a fan-out fails, then catches up on its own once it's reachable at the next attempt.

---

## Optional: PgBouncer in front of PostgreSQL

When Polaris's `DATABASE_POOL_SIZE + POLARIS_PGBOSS_POOL_SIZE` keeps climbing past what's comfortable to provision on PostgreSQL directly (each backend connection costs ~10 MB of RSS plus a process slot), put **PgBouncer** in front of PostgreSQL. PgBouncer holds a small pool of real Postgres backends and multiplexes Polaris's many connection slots onto them. The Maintenance tab's "Peak observed" can grow well past PG's `max_connections` without any of those connections actually reaching PostgreSQL.

Polaris is PgBouncer-aware: application queries (Prisma) go through PgBouncer, but pg-boss queue ops, `pg_dump` backup/restore, and `pg_stat_activity` reads still need a direct Postgres connection (LISTEN/NOTIFY, prepared-statement cache, and the COPY-heavy dump protocol all break under PgBouncer transaction-pool mode). The two-URL setup keeps both paths working.

### When to deploy PgBouncer

- Capacity Advisor's `DATABASE_POOL_SIZE` recommendation has crept past ~300, AND
- You'd rather not raise PostgreSQL `max_connections` past ~600–800 (memory budget, replication slot accounting, or just shop policy).

If neither bullet applies, skip it. The single-URL setup is simpler to operate and the Capacity Advisor's recommendations are correct without it.

### RHEL / Rocky / AlmaLinux 9

```bash
sudo dnf install -y pgbouncer
```

Edit `/etc/pgbouncer/pgbouncer.ini`:

```ini
[databases]
polaris = host=127.0.0.1 port=5432 dbname=polaris

[pgbouncer]
listen_addr = 127.0.0.1
listen_port = 6432
auth_type = scram-sha-256
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 500
default_pool_size = 40
reserve_pool_size = 10
reserve_pool_timeout = 5
server_idle_timeout = 600
# Required for Prisma's prepared-statement use under transaction pooling.
# Requires PgBouncer 1.21+ (RHEL 9 EPEL ships 1.21+).
max_prepared_statements = 200
```

Generate `userlist.txt` by copying PostgreSQL's existing SCRAM hash:

```bash
sudo -u postgres psql -tAc \
  "SELECT '\"polaris\" \"' || rolpassword || '\"' FROM pg_authid WHERE rolname = 'polaris'" \
  | sudo tee /etc/pgbouncer/userlist.txt
sudo chown pgbouncer:pgbouncer /etc/pgbouncer/userlist.txt
sudo chmod 600 /etc/pgbouncer/userlist.txt
```

Enable + start:

```bash
sudo systemctl enable --now pgbouncer
sudo ss -tnlp 'sport = :6432'   # confirm it's listening
```

### Wire Polaris into PgBouncer

In `/opt/polaris/.env`:

```
DATABASE_URL=postgresql://polaris:PASSWORD@127.0.0.1:6432/polaris?pgbouncer=true
POLARIS_DB_DIRECT_URL=postgresql://polaris:PASSWORD@127.0.0.1:5432/polaris
```

Restart Polaris (`sudo systemctl restart polaris`). Verify in the journal:

```bash
sudo journalctl -u polaris -n 50 --no-pager | grep "DB connection mode"
```

You should see `DB connection mode: PgBouncer detected. ...`. On the Maintenance tab → Capacity Advisor card, a "PgBouncer detected" hint will appear above the recommendations.

### Ubuntu / Debian

```bash
sudo apt install -y pgbouncer
```

Same `pgbouncer.ini` shape; on Debian/Ubuntu it lives at `/etc/pgbouncer/pgbouncer.ini`. Same userlist + service enable pattern. Same Polaris `.env` lines.

### Windows Server

PgBouncer isn't officially packaged for Windows. If you've crossed the threshold where you need it, the practical path is to move PostgreSQL + Polaris to Linux. (The Windows install path is documented but is a smaller-fleet target.)

### After enabling PgBouncer

- **`max_connections`** on PostgreSQL can drop materially. PgBouncer's `default_pool_size` × pool count is what hits Postgres now, not Polaris's pool. The Capacity Advisor's `max_connections` recommendation becomes an upper bound rather than a strict requirement; size PG to comfortably exceed `(default_pool_size + reserve_pool_size + admin/autovacuum)` × number of DBs.
- **`pg_dump` backups** (manual, scheduled, and pre-update) automatically use `POLARIS_DB_DIRECT_URL`. The connection is passed to `pg_dump`/`psql` through libpq `PG*` environment variables, never on the command line, so the database password does not appear in `ps` output. If you script backups outside the app, target port 5432 directly — not 6432.
- **Prisma migrations** (when you upgrade Polaris and the in-app updater runs `prisma migrate`) need the direct URL too. CLI migrations require `DATABASE_URL=<direct URL> npx prisma migrate deploy`.
