# Polaris — Upgrade Guide

Everything here is for an install that **already exists**. Fresh installs are
[docs/INSTALL.md](INSTALL.md); day-to-day application updates are the in-app
updater (Server Settings → **Maintenance → Updates**), which needs none of this.

What lands here instead: the one-time moves the updater deliberately cannot make
for you, because they replace a runtime, a database major or the service layout
underneath the app rather than the app itself.

| If you need to… | Read |
|---|---|
| move a host to Node 24 | *Upgrading Node on an existing install* |
| move a host to the Java 25 signing JDK | *Upgrading the signing JDK to Java 25* |
| leave PostgreSQL 15 (or 13) for 17 | *Moving an existing install to PostgreSQL 17* |
| leave RHEL AppStream's Postgres for PGDG | *Migrating from AppStream Postgres to PGDG* |
| leave the pre-Phase-3 single `polaris.service` for the split-role units | *Upgrading a legacy single-process install* |
| put nginx in front of a pre-nginx install | *Migrating an existing install to the nginx front end* |
| restart an update that died on a TLS-intercepting network | *Recovering an install whose update already failed on TLS interception* |

Each one stops the service, so each one wants a maintenance window. None of them
is on a schedule — do them when the Platform Lifecycle card (Server Settings →
Maintenance) says the component is past, or approaching, its end of life.

---

## Upgrading Node on an existing install

**The in-app updater does not do this, by design.** No path through it calls a
package manager — not `src/services/updateService.ts`, not
`deploy/update-linux.sh`. Read that as a policy rather than a wall, because the
updater is not as unprivileged as it looks: besides the nginx apply wrapper it
reaches through sudo (`deploy/sudoers.d/polaris-nginx`), its final step runs a
transient systemd unit **as root** under the `manage-units` polkit grant in
`deploy/polkit/49-polaris.rules`, which is how it syncs unit files,
`/etc/sudoers.d/polaris-nginx` and the nginx config before restarting the group.
It *could* install a package. It deliberately never has: handing the web
application a package manager to save a once-every-two-years operation is a poor
trade. Node upgrades are an operator (or configuration-management) task.

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

## Upgrading the signing JDK to Java 25

**Who needs this.** Any host installed before 2026-09-09. Until then the scripts
provisioned Java 17 — and the Ubuntu ones installed `default-jre-headless`, which
is 17 on 22.04 and 21 on 24.04 — while [docs/INSTALL.md](INSTALL.md#supported-platform-versions)
→ *Supported platform versions*, every current install path and the running app
all state **25**. Two places say so, and neither is an outage:
Server Settings → Maintenance → **Platform Lifecycle** grades the Java row *below
Polaris's minimum*, which is critical and reaches the sidebar alert, and the **Code
signing** card says it requires Java 25+.

**Nothing is broken while you wait.** jsign 7.5 is Java 8 bytecode, so signing keeps
working on 17 or 21 — an old JDK costs runway (17 dies 2027-09-30; 25 runs to
2030-09-30) and a fleet that signs with a different major per host, not capability.
Polaris never refuses an older JVM: `signingAvailability` checks only that `java`
*runs*, so the Code signing card reads **Ready** on 17 and the Platform Lifecycle
card is the only thing that objects. This is a maintenance-slot task.

**Nothing does it for you.** The in-app updater installs no system packages —
deliberately, and the Node section above says what it can and cannot reach —
`deploy/update-linux.sh` never mentions Java, and
re-running a setup script will not help either: both scripts skip the JDK entirely
when `command -v java` already succeeds. They are written for a fresh host, where
"some Java" means done.

**Where it has to land.** On the host running the **web** role — that is the process
that shells out to jsign after an in-app agent build, and the one that probes
`java -version` for the lifecycle card. A monitor-, discovery- or dash-only host
needs no JDK at all. On an HA pair, do both nodes, since either can be the web host.

**No downtime, and no restart** in the normal case: Polaris execs `java` per
operation and caches nothing about it, so installing the package *is* the change.
The exception is a JDK that lands outside the service's `PATH` (a tarball under
`/opt`, say) — that needs `JAVA_HOME`/`PATH` in a unit drop-in and a restart of
`polaris.target`.

### RHEL / Rocky / AlmaLinux 9

```bash
sudo dnf install -y java-25-openjdk-headless
java -version                      # expect: openjdk version "25.0.x"
```

If it still reports 17, both JDKs are installed and `alternatives` still prefers the
old one — pick the `java-25` entry, then re-check:

```bash
sudo alternatives --config java
java -version
```

Remove the old JDK only **after** the verification below passes, and check first that
nothing else on the host wants it:

```bash
dnf repoquery --installed --whatrequires java-17-openjdk-headless
sudo dnf remove java-17-openjdk-headless
```

### Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y openjdk-25-jre-headless
java -version                      # expect: openjdk version "25.0.x"
sudo update-alternatives --config java   # only if the old JDK still wins
```

On a host installed by an older `setup-ubuntu.sh` the JVM you are replacing came in
as `default-jre-headless`, so purge the versioned package behind it —
`openjdk-17-jre-headless` on 22.04, `openjdk-21-jre-headless` on 24.04 — not the
metapackage alone. Simulate first; `-s` changes nothing and prints what would go:

```bash
sudo apt-get -s purge default-jre-headless openjdk-17-jre-headless
sudo apt-get purge -y default-jre-headless openjdk-17-jre-headless
sudo apt-get autoremove -y
java -version
```

### Docker / Podman

No host-side JDK work: the image has carried `openjdk-25-jre-headless` and the
SHA-256-pinned jsign jar since 2026-09-09. Pull the current image and recreate:

```bash
docker compose pull                # podman compose pull
docker compose up -d
docker compose exec web java -version
```

The signing keystore is deliberately not in the image — it lives under the mounted
state dir (`./state/tools/codesign.pfx`) — so recreating the containers leaves it
alone.

### Verify

1. **As the service account**, since that is the process that execs it:
   `sudo -u polaris java -version`.
2. Integrations → **Polaris Agents** → **Code signing (internal CA)** → **Test**.
   It checks Java, the jsign jar and the keystore password (no TSA call) and reports
   `Ready: openjdk version "25.0.x" … + /opt/polaris/tools/jsign.jar, keystore
   readable`. Read the version it prints rather than the word *Ready* — Ready is
   what it said on Java 17 too.
3. Build the agents — Integrations → **Polaris Agents** tab → **Polaris Agent** card
   → **Build agent binaries** — and confirm no `agent.build.sign_failed` Event and no
   signing warning in the sidebar. Signing is fail-open: a build that ships unsigned
   still reports success.
4. Maintenance → **Platform Lifecycle**: the Java row should read 25 and grade clean.
   **It can lag up to 6 hours** — the card serves a memoised observation and has no
   refresh button. Restart `polaris-web` to clear it, or request
   `GET /api/v1/server-settings/platform-lifecycle?refresh=1`. The alert the baseline
   lifecycle automation raised clears on the daily watch, which re-observes at most
   once in 20 hours.

**If the card shows a version but no certificate subject / issuer / expiry**,
`keytool` was not found. These packages ship it beside the JVM rather than on `PATH`;
Polaris looks on `PATH`, then `JAVA_HOME`, then the running JVM's own `java.home`.
Set `JAVA_HOME` in the service environment if your JDK landed somewhere unusual.

**Rollback** is `alternatives --config java` (`update-alternatives` on Debian/Ubuntu)
back to the old entry — which is why removing the old JDK is the last step, not part
of the install. Polaris stores nothing about which JDK it used.

---

## Moving an existing install to PostgreSQL 17

Installs provisioned before 2026-09-09 are on **PostgreSQL 15** (RHEL), or on whatever major
the distro froze on (**14** on Ubuntu 22.04, **16** on 24.04 — the old script installed the
unversioned metapackage). None of them stop working, and **nothing in Polaris forces this
move**: the backup path resolves `pg_dump`/`psql` from the *server's* reported version, and the
unit dependency is a per-host drop-in. What you get by moving is TimescaleDB past the 2.28.x
line — 2.29 dropped PostgreSQL 15 — and a major with four more years of upstream support.

This is an operator task in a maintenance window, not something the in-app updater can do: it
runs as the unprivileged app user and cannot install packages.

**Before anything else,** confirm the extension exists for the target major on your platform.
`timescaledb-2-postgresql-17` is published for EL 9 and for Debian/Ubuntu; if it were not, the
rest of this is moot.

```bash
# 1. Back up, and REHEARSE THE RESTORE into a scratch database. The restore path
#    is the only code that calls timescaledb_pre_restore()/post_restore(), so it
#    is the step most likely to surprise you. Do not skip the rehearsal.
sudo systemctl stop polaris.target

# 2. Install 17 SIDE BY SIDE. Do not remove 15 — it is the rollback.
sudo dnf install -y postgresql17 postgresql17-server postgresql17-contrib
sudo dnf install -y timescaledb-2-postgresql-17
sudo /usr/pgsql-17/bin/postgresql-17-setup initdb

# 3. Match the extension version across the two clusters first. pg_upgrade
#    refuses to carry a library the new cluster does not have, and TimescaleDB
#    must be in shared_preload_libraries on BOTH.
sudo timescaledb-tune --pg-config=/usr/pgsql-17/bin/pg_config --quiet --yes

# 4. Upgrade. --check first; it changes nothing and reports what would fail.
sudo -u postgres /usr/pgsql-17/bin/pg_upgrade \
  --old-bindir=/usr/pgsql-15/bin --new-bindir=/usr/pgsql-17/bin \
  --old-datadir=/var/lib/pgsql/15/data --new-datadir=/var/lib/pgsql/17/data --check
# then re-run without --check

# 5. Point the units at the new service. This is the drop-in, NOT the unit file.
for u in polaris-web polaris-monitor@ polaris-discovery polaris-dash polaris-migrate; do
  printf '[Unit]\nAfter=postgresql-17.service\nRequires=postgresql-17.service\n' \
    | sudo tee "/etc/systemd/system/$u.service.d/20-postgres.conf" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl disable --now postgresql-15
sudo systemctl enable --now postgresql-17
sudo systemctl start polaris.target
```

Then, in order:

1. **Update the extension** — `ALTER EXTENSION timescaledb UPDATE;` against the polaris
   database, then restart PostgreSQL so the new library is the one loaded.
2. **Count what survived.** Hypertables, chunks, chunk intervals and retention policies, before
   and after. Server Settings → **Maintenance** shows the capacity snapshot; compare it against
   the figure you wrote down before the window. CI cannot help here — its Postgres has no
   TimescaleDB, so a green test suite proves nothing about this step.
3. **Take a real backup through Polaris** and restore it into a scratch database. That exercises
   the version-sensitive restore gates against the new major, which is the part no dry run covers.
4. **Only then remove the old major's packages** (`postgresql15*`) and the old data directory.
   Until you do, `/usr/bin/pg_dump` may still be the 15 binary — `pg_dump --version` is the
   check, and `alternatives --display` will not tell you the truth. See
   [docs/INSTALL.md](INSTALL.md#pg_dump-server-version-mismatch) → *`pg_dump`: server version
   mismatch*.

**Rollback** is "point the drop-ins back at `postgresql-15.service`, re-enable it, restart the
target" — which works for exactly as long as you keep the old cluster and its packages. Keep
both until the new major has run a full retention cycle.

On **Ubuntu/Debian**, the same shape with `pg_upgradecluster 15 main` after installing
`postgresql-17` from PGDG, and the drop-in stays `postgresql.service` throughout — Debian's
wrapper follows whichever cluster is configured.

### On Docker / Unraid, where PostgreSQL is its own container

None of the above applies: there are no packages to install side by side and no `pg_upgrade` to
run, because the official image ships exactly one major's binaries. The move is a **dump and
restore into a new container with a new data directory**, and the old container is the rollback.

**A tag swap is not an upgrade.** Point a `postgres:17` image at a data directory `initdb`
created under 15 and it exits immediately with `database files are incompatible with server` —
the entrypoint deliberately refuses to convert it. Nothing is destroyed and flipping the tag
back brings 15 up again, but the upgrade never happens on its own. For the same reason, a copy
of the old appdata directory is a **rollback artifact, not a migration artifact**: it can only
ever be restored back into 15.

Polaris is down from step 3 to step 8. The dump and the restore are the clock, and they scale
with sample volume rather than asset count.

1. **Take stock.** `docker exec -it <pg15> psql -U polaris -d polaris -c '\dx'` — note whether
   `timescaledb` is present, and if so its exact `extversion`. Record `POSTGRES_USER` /
   `POSTGRES_PASSWORD` / `POSTGRES_DB`, the network and port, any tuning you applied, and the
   row counts on `assets` and `asset_monitor_samples` as your before-figure for step 7.

2. **Back up.** Server Settings → **Maintenance** writes to `data/backups/` on the bind mount.
   Two things about that file: it is named by backup **id** (`bk-<epoch-ms>`), not by the
   `polaris-backup-<version>-<timestamp>.gz` name shown in the UI, and it is gzipped plain SQL
   (or AES-256-GCM behind a `POLARIS\0` header if you set a passphrase, in which case only the
   in-app Restore card can read it). Take it immediately before step 3 — Polaris keeps
   collecting until it stops, and anything written after the backup does not make the trip.
   Copy `/mnt/user/appdata/polaris` off the host too: it holds `.env`, and `.env` holds
   `POLARIS_SECRET_KEY`, without which every stored credential in the restored database is
   undecryptable.

3. **Stop the Polaris container.** Leave PostgreSQL 15 running — you still have to read from it.

4. **Create the 17 container against a NEW appdata path**, with the same `POSTGRES_USER` /
   `POSTGRES_PASSWORD` / `POSTGRES_DB` and on the same network. Give it a temporary host port so
   it cannot collide with 15. Use `timescale/timescaledb:<ver>-pg17` — the extension is required,
   so this is the image even if the old container was plain `postgres` (match the version from
   step 1 and `ALTER EXTENSION timescaledb UPDATE;` afterwards — 2.28.x was the last line
   supporting PostgreSQL 15 and 2.29 dropped it, so check the overlap before you pick a tag).
   Start it with `-c shared_preload_libraries=timescaledb`: the image only writes that into
   `postgresql.conf` during `initdb`.

5. **Restore.** With no TimescaleDB in the *source*, the dump contains no hypertable metadata
   and needs no `timescaledb_pre_restore()` / `post_restore()` bracketing:

   ```bash
   # gzipped plain SQL, from an unencrypted in-app backup
   gunzip -c /mnt/user/appdata/polaris/data/backups/bk-<id> \
     | docker exec -i <pg17> psql -U polaris -d polaris \
         --no-psqlrc --quiet --single-transaction -v ON_ERROR_STOP=1

   # custom-format dump taken with an external `pg_dump -Fc`
   docker run --rm -it --network <net> -v /mnt/user/backups:/out \
     postgres:17 pg_restore -h <pg17> -U polaris -d polaris \
     --no-owner --no-privileges /out/polaris-pg15.dump
   ```

   Those psql flags are the ones `backupService` uses: `--single-transaction` with
   `ON_ERROR_STOP=1` means the restore commits or rolls back as one unit, so a failure leaves an
   empty database to retry into rather than a half-populated one. Early
   `NOTICE: ... does not exist, skipping` lines are the dump's `DROP ... IF EXISTS` statements
   meeting an empty database. If the source *did* have TimescaleDB, bracket the restore per
   [docs/INSTALL.md](INSTALL.md#restoring) → *Restoring* — that pair is not optional and
   skipping it leaves hypertables whose chunks
   are invisible.

6. **Adopting TimescaleDB during the move** (source had none) is the cheapest it will ever be,
   because the hard part — matching extension versions across the restore — only exists when the
   source already has it. Restore the plain dump first, then
   `CREATE EXTENSION IF NOT EXISTS timescaledb;`, and let Polaris convert the sample tables to
   hypertables on its first boot in step 8. `\dx` afterwards shows `plpgsql`, `pg_trgm` and
   `timescaledb`.

7. **Verify against the still-running 15, then ANALYZE.** Compare the step-1 counts:

   ```bash
   docker exec -it <pg17> psql -U polaris -d polaris \
     -c "SELECT (SELECT count(*) FROM assets) AS assets,
                (SELECT count(*) FROM asset_monitor_samples) AS samples;"
   docker exec -it <pg17> psql -U polaris -d polaris -c 'ANALYZE;'
   ```

   `assets` must match exactly; `asset_monitor_samples` may be slightly higher on 15 if anything
   was collected between the backup and the stop. The `ANALYZE` is not housekeeping — a restored
   database has no planner statistics, and without it the first hours on 17 look like a
   performance regression that is not real.

8. **Cut over.** Stop the 15 container, then edit `DATABASE_URL` in
   `/mnt/user/appdata/polaris/.env` (owned by uid 1000 after the entrypoint's first-boot
   `chown`, so `sudo`) to name the new host — see *What the new container does not inherit*
   below before you decide what to do with `sslmode`. Start Polaris and watch the container log
   for `[entrypoint] Applying Prisma migrations`, which should be a no-op; a container that
   stays up means it passed, because the entrypoint exits fatally rather than run against a
   stale schema. If you adopted TimescaleDB in step 6, the hypertable conversion runs on this
   boot and takes 5–15 minutes on a database that has been collecting for weeks. Then log in,
   open an asset with monitoring history (proves the samples arrived and, with Timescale, that
   the chunks are visible), and hit **Test** on one integration (proves `POLARIS_SECRET_KEY`
   still decrypts).

9. **Keep the 15 container and its appdata** until 17 has run a full retention cycle. Rollback
   is "stop 17, start 15, point `DATABASE_URL` back", and it works for exactly as long as you
   keep them.

#### What the new container does not inherit

A new data directory means a brand-new `postgresql.conf`. Everything you tuned on the old
container is gone, and two of those defaults will bite you rather than merely under-perform.

**TLS.** If the old container had `ssl = on` and the new one does not, the `DATABASE_URL` that
worked yesterday fails at step 8 with `The server does not support SSL connections` —
node-postgres asks for TLS, the server refuses, and there is no fallback. Check
`SHOW ssl;` on the new container. Either drop the `sslmode` parameter from the URL (the
connection then runs in the clear, which on a single host over a private bridge network is a
defensible posture — but it *is* a change, so make it deliberately), or enable TLS:

```bash
# 1. A self-signed cert in the data directory. PostgreSQL resolves the default
#    ssl_cert_file / ssl_key_file relative to PGDATA, so this needs no path config
#    and persists, because that directory is the appdata bind mount.
cd /mnt/user/appdata/<pg17-appdata>
openssl req -new -x509 -days 3650 -nodes -text \
  -out server.crt -keyout server.key -subj "/CN=polaris-db"

# 2. Ownership, from inside the container. Unraid's appdata defaults to nobody:users,
#    and PostgreSQL refuses to start on "private key file has group or world access".
docker exec -u root <pg17> sh -c \
  'chown postgres:postgres /var/lib/postgresql/data/server.crt /var/lib/postgresql/data/server.key \
   && chmod 600 /var/lib/postgresql/data/server.key'

# 3. Turn it on — Unraid: the container's "Post Arguments" field.
-c ssl=on
```

A self-signed certificate is what the first-run wizard's **Allow self-signed certificate**
toggle is for, and `sslmode=no-verify` in the URL is the correct value to keep. It reaches
`pg_dump` and `psql` correctly — see [docs/INSTALL.md](INSTALL.md#pg_dump-invalid-sslmode-value-no-verify)
→ *`pg_dump`: invalid sslmode value "no-verify"* and business rule 51.

**`max_connections`.** The image default is 100, and Polaris needs roughly
`(prismaPool + pgbossPool) / 0.65`. Server Settings → Maintenance → **Capacity Advisor** shows
the recommendation but marks the row *manual*, because Polaris cannot edit `postgresql.conf`.
On Docker, set it the same way as TLS — append to the container's arguments and restart:

```
-c ssl=on -c max_connections=150
```

Confirm with `SHOW max_connections;`; the Advisor row flips to an OK pill once it agrees.

---

## Migrating from AppStream Postgres to PGDG (RHEL)

If you already have a working Polaris install on AppStream Postgres and want to switch to PGDG (typically because you want TimescaleDB), the migration is a dump → install PGDG → restore cycle. Plan ~15-30 min of downtime; the dump itself is the bottleneck and scales with your fleet's data volume.

> **Check which major you are actually on first — `psql --version`.** RHEL 9's AppStream
> `postgresql` module sets no default stream, so its non-modular default is **PostgreSQL 13**.
> Installs made by `deploy/setup-rhel.sh` before 2026-09-09 took that path and are on 13, not
> 15 — below the minimum in [docs/INSTALL.md](INSTALL.md#supported-platform-versions) →
> *Supported platform versions*, and one reason to do this migration
> rather than leave it. The dump → restore below handles 13 → 15 fine (forwards is supported;
> the reverse is not), so nothing extra is needed, but know what you are starting from.

```bash
# 1. Dump the existing database (run as postgres OS user — peer auth).
#    polaris.target is the process group on every split-role install; only a
#    legacy single-process install still has a bare polaris.service.
sudo systemctl stop polaris.target 2>/dev/null || sudo systemctl stop polaris
sudo -u postgres pg_dump polaris --clean --if-exists --no-owner --no-acl > /tmp/polaris.sql
sudo systemctl stop postgresql

# 2. Install PGDG, disable the AppStream module
sudo dnf install -y https://download.postgresql.org/pub/repos/yum/reporpms/EL-9-x86_64/pgdg-redhat-repo-latest.noarch.rpm
sudo dnf -qy module disable postgresql
sudo dnf install -y postgresql17 postgresql17-server postgresql17-contrib
sudo /usr/pgsql-17/bin/postgresql-17-setup initdb

# 3. Verify pg_hba.conf uses scram-sha-256 (default on PGDG; check anyway)
sudo grep -E '^(local|host)' /var/lib/pgsql/17/data/pg_hba.conf | head -5
# If you see ident/md5 on the 127.0.0.1 lines, edit to scram-sha-256

# 4. Apply the chmod-traversable override (see step 2 above) BEFORE starting,
#    then start the new instance
sudo systemctl edit postgresql-17  # add the [Service] block from above
sudo systemctl daemon-reload
sudo chmod o+x /var/lib/pgsql /var/lib/pgsql/17
sudo systemctl disable postgresql
sudo systemctl enable --now postgresql-17

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
#    postgresql-17.service and bring polaris.target back up against the
#    migrated DB.
sudo bash deploy/setup-rhel.sh --public-url https://polaris.example.com

# 9. Remove the AppStream PACKAGES, not just the data directory. This step is
#    not optional. Disabling the module (step 2) and the service (step 4) leaves
#    the 13 client installed, and its /usr/bin/pg_dump is a regular file that
#    overwrote the alternatives symlink PGDG registered — `alternatives --display`
#    keeps saying 15 while pg_dump is 13, and pg_dump refuses a newer server, so
#    every Polaris backup fails from here on. That is how prod ended up in the
#    state described under "pg_dump: server version mismatch" (2026-09-09).
sudo test -f /var/lib/pgsql/data/PG_VERSION && echo "OLD DATA STILL EXISTS — DO NOT DELETE" || sudo rm -rf /var/lib/pgsql/data
sudo dnf remove --assumeno postgresql postgresql-server   # dry run: abort if any postgresql15-* is listed
sudo dnf remove -y postgresql postgresql-server
sudo alternatives --auto pgsql-pg_dump; sudo alternatives --auto pgsql-psql
pg_dump --version && psql --version                     # both MUST report 15.x before you continue

# 10. Start Polaris and watch the boot (polaris-web is the HTTP face of the group)
sudo systemctl start polaris.target 2>/dev/null || sudo systemctl start polaris
sudo journalctl -u polaris-web -f --no-pager
```

After step 10 succeeds, follow [docs/INSTALL.md](INSTALL.md#required-timescaledb) → *Required: TimescaleDB* to install the extension. On the first restart afterward, Polaris detects the extension and converts the twenty-eight monitoring sample tables to hypertables — eight source tables, sixteen `*_hourly` / `*_daily` rollup tables produced by the tiered-retention rollup job, and four detail-only standalone tables (~5-15 min for a fleet that's been running for weeks; no operator action required, just patience as conversions log in the journal).

---

## Upgrading a legacy single-process install

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
   target (mirrors the manual systemd block in [docs/INSTALL.md](INSTALL.md#systemd-rhelubuntu)):

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
   `deploy/migrate-to-nginx.sh` — see *Migrating an existing install to the
   nginx front end* below. That script requires the split-role layout to already
   be enabled, which steps 1–3 establish.

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

On a high-availability node — one carrying `/etc/polaris/ha-node`, so a
primary or a standby, never the witness — the same step then refreshes the HA
files, which live outside `/opt/polaris` once installed and so could not
previously be updated at all: `/usr/local/sbin/polaris-ha-role`,
`polaris-ha-role.service` and `.timer`, `patroni.service.d/10-polaris.conf`,
and the `10-ha.conf` drop-ins. Only files that are **already present** are
refreshed, never created, because `deploy/ha/setup-rhel-ha.sh` is what decides
which of them a node's role gets. So if a release adds a NEW HA file, re-run
that script on each node to install it — the release notes will say when that
applies.

---

## Migrating an existing install to the nginx front end

Run `deploy/migrate-to-nginx.sh` on installs that were provisioned before the
nginx-front cutover. The script only supports the split-role layout
(`polaris.target` enabled with the four role units).

### Prerequisites

- The split-role layout ([docs/INSTALL.md](INSTALL.md#the-split-role-deployment-web--monitor--discovery))
  must be enabled.
- nginx ≥ 1.30 (HTTP/3 stable). The migration script installs from
  `nginx.org`'s stable repo if your system nginx is older or missing.
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
2. Ensures nginx ≥ 1.30 is installed (replaces older RHEL AppStream nginx
   with `nginx.org`'s stable branch if needed).
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

---

## Recovering an install whose update already failed on TLS interception

This picks up where [docs/INSTALL.md](INSTALL.md#networks-that-inspect-tls) →
*Networks that inspect TLS* leaves off: the interception problem has already
taken an update down, and the host needs repairing as well as configuring.

`npm ci` deletes `node_modules` **before** it installs, so an update that failed at Install
dependencies leaves the on-disk dependency tree incomplete. The service keeps running from
modules already loaded in memory, so the app looks healthy — but **it will not survive a
restart or a reboot until an install succeeds.** Treat it as urgent, and do not restart it
first to "see if it's fine".

Apply the fix from that section, then re-run the update (Server Settings → Maintenance → Updates, or
`sudo bash deploy/update-linux.sh`). If the in-app updater already pulled the new code before
it failed, the checkout is ahead of the process that is still serving. The in-app card measures
against the **running** build, so Check for Updates still offers Apply Update — with a note that
the code is already on disk — and Apply finishes the install, build, migration and restart. The
script's `git pull` is a no-op in that state and it will report "Already up to date" — pass
`--force` so it finishes the install, build and migration steps anyway.
If you need to repair the dependency tree without a full update:

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

**"Your local changes to the following files would be overwritten by merge."** If the in-app
pull step fails with this, a `deploy/update-linux.sh` run from before 2026-09-10 rolled back
by restoring the previous commit's files by path, which leaves HEAD at the newer commit and
every changed file looking locally modified. Nothing in the checkout is edited in place
(`.env` and `data/` are untracked), so the in-app updater now discards such changes before it
pulls and records the discarded paths in the `server.update.*` Event; the scripts roll back
with `git reset --hard` so it no longer happens. On an install still running older code, clear
it by hand and re-run the update:

```bash
sudo -u polaris git -C /opt/polaris status --short    # expect only staged "M" rows
sudo -u polaris git -C /opt/polaris reset --hard HEAD
```
